'use client';

import { useEffect, useState } from 'react';
import type { ArtifactRendererSpec } from '@/lib/visualization/contracts';
import RouterReceipts from './router-receipts';
import { ArtifactPreview } from './artifact-preview';
import styles from './inbox-panel.module.css';
import { displayPerson } from './product-labels';

interface InboxMessage {
  id: string; title: string; content: string; createdAt: string; readAt: string | null; senderName: string; source: 'communication' | 'monitor_alert' | 'artifact_share' | 'task_assigned';
  artifact?: { revision: number; kind: string }; boundArtifact?: { revision: number; title: string }; workItemId?: string;
}
interface InboxPage { items: InboxMessage[]; total: number; nextCursor: string | null }
type State = { status: 'loading' | 'ready' | 'error'; items: InboxMessage[]; total: number; nextCursor: string | null };
const EMPTY: State = { status: 'loading', items: [], total: 0, nextCursor: null };

function parse(value: unknown): InboxPage | null {
  const body = value as { messages?: unknown; total?: unknown; nextCursor?: unknown } | null;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  const ok = messages.filter((m): m is InboxMessage => !!m && typeof m === 'object' && typeof (m as InboxMessage).id === 'string' &&
    typeof (m as InboxMessage).title === 'string' && typeof (m as InboxMessage).content === 'string' && typeof (m as InboxMessage).createdAt === 'string');
  if (ok.length !== messages.length) return null;
  return { items: ok, total: typeof body?.total === 'number' ? body.total : ok.length, nextCursor: typeof body?.nextCursor === 'string' ? body.nextCursor : null };
}
/** Acknowledge exactly the messages that were displayed; the badge is reconciled ONLY from the server's successful answer (a failure leaves it unchanged and is retried on the next display). */
async function acknowledge(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const session = await fetch('/api/session', { cache: 'no-store' });
    const csrf = session.ok ? (await session.json() as { csrfToken?: string }).csrfToken : undefined;
    if (!csrf) return;
    const response = await fetch('/api/inbox/read', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ ids: ids.slice(0, 200) }) });
    const body = response.ok ? await response.json() as { unreadTotal?: unknown } : null;
    if (typeof body?.unreadTotal === 'number') window.dispatchEvent(new CustomEvent('biztania:inbox-unread', { detail: body.unreadTotal }));
  } catch { /* badge stays as the server last reported it */ }
}
function openWorkItem(id: string) {
  window.history.pushState(null, '', `/?section=actions&workItem=${encodeURIComponent(id)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
const formatDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); };
const SOURCE_LABEL = (item: InboxMessage) => item.source === 'monitor_alert' ? 'แจ้งเตือนอัตโนมัติ' : item.source === 'artifact_share' ? `แชร์ผลลัพธ์จาก ${displayPerson(item.senderName)}` : item.source === 'task_assigned' ? `มอบหมายงานโดย ${displayPerson(item.senderName)}` : `จาก ${displayPerson(item.senderName)}`;

type Shared = { status: 'loading'; id: string } | { status: 'error'; id: string; message: string } | { status: 'ready'; id: string; spec: ArtifactRendererSpec; artifactId: string; revision: number };

/** A shared or attached artifact opens only through the recipient's own message; the server reauthorizes them for its whole scope on every open. */
function SharedArtifact({ item }: { item: InboxMessage }) {
  const [state, setState] = useState<Shared | null>(null);
  const open = async () => {
    setState({ status: 'loading', id: item.id });
    try {
      const response = await fetch(`/api/artifacts/shared/${encodeURIComponent(item.id)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { spec?: ArtifactRendererSpec; artifact?: { id: string; revision: number }; error?: { message?: string } } | null;
      if (!response.ok || !body?.spec || !body.artifact) throw new Error(body?.error?.message ?? 'เปิดผลลัพธ์ที่แชร์ไม่สำเร็จ');
      setState({ status: 'ready', id: item.id, spec: body.spec, artifactId: body.artifact.id, revision: body.artifact.revision });
    } catch (error) { setState({ status: 'error', id: item.id, message: error instanceof Error ? error.message : 'เปิดผลลัพธ์ที่แชร์ไม่สำเร็จ' }); }
  };
  return <div className={styles.shared}>
    <button type="button" className="btn btn-small" data-open-shared-artifact={item.id} disabled={state?.status === 'loading'} onClick={() => void open()}>
      {state?.status === 'ready' ? 'โหลดผลลัพธ์ใหม่' : state?.status === 'loading' ? 'กำลังเปิด…' : item.source === 'communication' ? 'เปิดดูผลลัพธ์ที่แนบ' : 'เปิดดูผลลัพธ์ที่แชร์'}</button>
    {state?.status === 'error' && <p className={styles.error} role="alert" data-shared-artifact-error>{state.message}</p>}
    {state?.status === 'ready' && <ArtifactPreview spec={state.spec} drillUrl={(field, value) =>
      `/api/artifacts/${encodeURIComponent(state.artifactId)}/drilldown?revision=${state.revision}&message=${encodeURIComponent(item.id)}&field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`} />}
  </div>;
}

/** Simulated inbox of the signed-in user (messages, monitor alerts and shared artifacts addressed to them). Newest page first with an explicit way to older messages; only displayed messages are marked read. Text is rendered as plain text. */
export default function InboxPanel() {
  const [state, setState] = useState<State>(EMPTY);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/inbox', { cache: 'no-store', signal: controller.signal });
        const page = response.ok ? parse(await response.json()) : null;
        if (controller.signal.aborted) return;
        if (!page) { setState({ ...EMPTY, status: 'error' }); return; }
        setState({ status: 'ready', ...page });
        void acknowledge(page.items.filter(item => !item.readAt).map(item => item.id));
      } catch { if (!controller.signal.aborted) setState({ ...EMPTY, status: 'error' }); }
    })();
    return () => controller.abort();
  }, [attempt]);
  const loadMore = async () => {
    if (!state.nextCursor) return;
    setMore('loading');
    try {
      const response = await fetch(`/api/inbox?cursor=${encodeURIComponent(state.nextCursor)}`, { cache: 'no-store' });
      const page = response.ok ? parse(await response.json()) : null;
      if (!page) { setMore('error'); return; }
      setState(current => ({ ...current, items: [...current.items, ...page.items.filter(item => !current.items.some(known => known.id === item.id))], total: page.total, nextCursor: page.nextCursor }));
      setMore('idle');
      void acknowledge(page.items.filter(item => !item.readAt).map(item => item.id));
    } catch { setMore('error'); }
  };

  return <>
    {state.status === 'loading' && <p className={styles.state} role="status">กำลังโหลดกล่องข้อความ…</p>}
    {state.status === 'error' && <div className={styles.error} role="alert">โหลดกล่องข้อความไม่สำเร็จ <button type="button" className="btn btn-small" onClick={() => { setState(EMPTY); setAttempt(n => n + 1); }}>ลองอีกครั้ง</button></div>}
    {state.status === 'ready' && !state.items.length && <p className={styles.state}>ยังไม่มีข้อความ — ข้อความจากเพื่อนร่วมงาน ผลลัพธ์ที่แชร์ และการแจ้งเตือนจาก Monitor จะแสดงที่นี่</p>}
    {state.status === 'ready' && state.items.length > 0 && <section aria-label="กล่องข้อความ">
      <p className={styles.note}>กล่องข้อความจำลองสำหรับเดโม — ไม่มีการส่งอีเมลหรือข้อความออกภายนอก</p>
      <p className={styles.meta} data-inbox-count>แสดง {state.items.length} จาก {state.total} ข้อความ</p>
      <div className={styles.list}>{state.items.map(item => <article key={item.id} className={`${styles.item} ${item.readAt ? '' : styles.unread}`} data-inbox-message={item.id} data-inbox-source={item.source}>
        <div className={styles.head}><span className={styles.title}>{item.title}</span><span className={styles.meta}>{SOURCE_LABEL(item)} · {formatDate(item.createdAt)}</span></div>
        <p className={styles.body}>{item.content}</p>
        {item.boundArtifact && <p className={styles.meta} data-message-bound-artifact>แนบผลลัพธ์: {item.boundArtifact.title} · ฉบับที่ {item.boundArtifact.revision}</p>}
        {item.artifact && <SharedArtifact item={item} />}
        {item.workItemId && <button type="button" className="btn btn-small" data-open-work-item={item.workItemId} onClick={() => openWorkItem(item.workItemId!)}>เปิดงานที่มอบหมาย</button>}
      </article>)}</div>
      {state.nextCursor && <button type="button" className="btn btn-small" data-inbox-more disabled={more === 'loading'} onClick={() => void loadMore()}>{more === 'loading' ? 'กำลังโหลด…' : 'โหลดข้อความที่เก่ากว่า'}</button>}
      {more === 'error' && <p className={styles.error} role="alert">โหลดข้อความที่เก่ากว่าไม่สำเร็จ โปรดลองอีกครั้ง</p>}
    </section>}
    <h2 className={styles.sectionHeading}>ผลการดำเนินการของฉัน</h2>
    <RouterReceipts />
  </>;
}
