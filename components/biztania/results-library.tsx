'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArtifactRendererSpec } from '@/lib/visualization/contracts';
import { dayGroup, RESULT_KIND_LABEL, RESULT_KINDS, resultCardActions, type ResultItem, type ResultKind, type ResultSection, type ResultSort, type ResultsPage } from '@/lib/artifacts/library-view';
import { ArtifactPreview } from './artifact-preview';
import { ShareManager } from './share-manager';
import styles from './results-library.module.css';

interface DashboardChoice { id: string; title: string; shared: boolean }
interface Opened { spec: ArtifactRendererSpec; artifact: { id: string; revision: number; kind: string; title: string }; saved: boolean }
type Notice = { kind: 'ok' | 'error'; text: string };

const formatDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); };
const EXPORTABLE = new Set<ResultKind>(['table', 'ranking', 'csv_export']);
const FAILED = 'ดำเนินการกับผลลัพธ์ไม่สำเร็จ โปรดลองอีกครั้ง';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/session', { cache: 'no-store' });
  const body = response.ok ? await response.json() as { csrfToken?: string } : null;
  if (!body?.csrfToken) throw new Error('session');
  return body.csrfToken;
}
async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; status: number; json: { error?: { message?: string } } & Record<string, unknown> }> {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, json: await response.json().catch(() => ({})) as never };
}

/**
 * The Results library (what the AI made for me): Saved first, Recent from chat grouped by day, Archived collapsed. Every action calls the same server
 * operations the AI uses; rename/pin/archive are display metadata only, and opening a version re-checks the viewer's CURRENT authority on the server.
 */
export interface ResultChatTarget { kind: 'artifact'; id: string; revision: number }
export default function ResultsLibrary({ dashboards = [], onAskInChat, onStaged, onOpenConversation }: { dashboards?: DashboardChoice[]; onAskInChat?: (prompt: string, target?: ResultChatTarget) => void; onStaged?: (proposalId: string) => Promise<void>; onOpenConversation?: (conversationId: string) => void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; items: ResultItem[]; total: number; nextCursor: string | null; truncated: boolean }>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ResultKind | 'all'>('all');
  const [section, setSection] = useState<ResultSection | 'all'>('all');
  const [sort, setSort] = useState<ResultSort>('newest');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<{ id: string; dashboardId: string } | null>(null);
  const [open, setOpen] = useState<{ status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; opened: Opened }>({ status: 'idle' });

  useEffect(() => { const timer = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(timer); }, [query]);
  const params = useCallback((cursor?: string | null) => {
    const search = new URLSearchParams();
    if (debounced.trim()) search.set('q', debounced.trim());
    if (kind !== 'all') search.set('kind', kind);
    if (section !== 'all') search.set('section', section);
    search.set('sort', sort);
    if (cursor) search.set('cursor', cursor);
    return search.toString();
  }, [debounced, kind, section, sort]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/results?${params()}`, { cache: 'no-store', signal: controller.signal });
        const body = response.ok ? await response.json() as Partial<ResultsPage> : null;
        if (!controller.signal.aborted) setState(Array.isArray(body?.items) ? { status: 'ready', items: body.items, total: body.total ?? body.items.length, nextCursor: body.nextCursor ?? null, truncated: body.truncated === true } : { status: 'error' });
      } catch { if (!controller.signal.aborted) setState({ status: 'error' }); }
    })();
    return () => controller.abort();
  }, [attempt, params]);
  const reload = useCallback(() => setAttempt(n => n + 1), []);
  const loadMore = async () => {
    if (state.status !== 'ready' || !state.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/results?${params(state.nextCursor)}`, { cache: 'no-store' });
      const body = response.ok ? await response.json() as Partial<ResultsPage> : null;
      if (!Array.isArray(body?.items)) throw new Error('page');
      const more = body.items;
      setState(current => current.status !== 'ready' ? current : { ...current, items: [...current.items, ...more.filter(item => !current.items.some(known => known.id === item.id))], total: body.total ?? current.total, nextCursor: body.nextCursor ?? null, truncated: body.truncated === true });
    } catch { setNotice({ kind: 'error', text: 'โหลดผลลัพธ์หน้าถัดไปไม่สำเร็จ โปรดลองอีกครั้ง' }); } finally { setLoadingMore(false); }
  };

  const items = useMemo(() => state.status === 'ready' ? state.items : [], [state]);
  const visible = items;
  const saved = visible.filter(item => item.section === 'saved');
  const recent = visible.filter(item => item.section === 'recent');
  const archived = visible.filter(item => item.section === 'archived');
  const now = new Date();
  const filtered = debounced.trim() !== '' || kind !== 'all' || section !== 'all';

  const run = async (item: ResultItem, label: string, work: () => Promise<{ ok: boolean; json: { error?: { message?: string } } & Record<string, unknown> }>, done: string) => {
    setBusy(`${item.id}:${label}`); setNotice(null);
    try {
      const result = await work();
      if (!result.ok) setNotice({ kind: 'error', text: result.json.error?.message ?? FAILED });
      else if (result.json.outcome === 'staged' && typeof result.json.proposalId === 'string') {
        // A shared Dashboard: the same confirm proposal chat creates; the page opens the existing confirm dialog. Nothing changed yet.
        setNotice({ kind: 'ok', text: 'เตรียมรายการแล้ว — Dashboard นี้ถูกแชร์ โปรดตรวจและยืนยันก่อนจึงจะเพิ่ม Widget' });
        if (onStaged) await onStaged(result.json.proposalId).catch(() => undefined);
      } else { setNotice({ kind: 'ok', text: typeof result.json.note === 'string' ? `${done} (${result.json.note})` : done }); reload(); }
      return result.ok;
    } catch { setNotice({ kind: 'error', text: FAILED }); return false; } finally { setBusy(null); }
  };
  const patch = (item: ResultItem, label: string, body: unknown, done: string) => run(item, label, () => send(`/api/results/${encodeURIComponent(item.id)}`, 'PATCH', body), done);

  const load = async (item: ResultItem, revision: number) => {
    setOpen({ status: 'loading' });
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(item.id)}?revision=${revision}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as (Opened & { error?: { message?: string } }) | null;
      if (!response.ok || !body?.spec) throw new Error(body?.error?.message ?? 'เปิดผลลัพธ์ไม่สำเร็จ');
      setOpen({ status: 'ready', opened: body });
    } catch (error) { setOpen({ status: 'error', message: error instanceof Error ? error.message : 'เปิดผลลัพธ์ไม่สำเร็จ' }); }
  };
  const exportCsv = async (item: ResultItem, revision: number) => {
    setBusy(`${item.id}:export`); setNotice(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(item.id)}/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() }, body: JSON.stringify({ revision }) });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; setNotice({ kind: 'error', text: body?.error?.message ?? FAILED }); return; }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `${item.title} ฉบับที่ ${revision}.csv`; link.click(); URL.revokeObjectURL(url);
      setNotice({ kind: 'ok', text: `ส่งออกไฟล์ CSV ของฉบับที่ ${revision} แล้ว` });
    } catch { setNotice({ kind: 'error', text: FAILED }); } finally { setBusy(null); }
  };

  /** The exact version an action applies to: the one the owner opened for this Result, else the latest (always shown on the button). */
  const targetRevision = (item: ResultItem) => open.status === 'ready' && open.opened.artifact.id === item.id ? open.opened.artifact.revision : item.latestRevision;
  const card = (item: ResultItem) => {
    const isBusy = busy?.startsWith(`${item.id}:`) ?? false;
    const revision = targetRevision(item);
    const savedText = item.latestSaved ? 'บันทึกแล้ว' : item.saved ? `บันทึกฉบับที่ ${item.savedRevision} แล้ว · ฉบับที่ ${item.latestRevision} ยังเป็นฉบับร่าง` : 'ฉบับร่างจากแชต';
    return <li key={item.id} className={styles.item} data-result={item.id} data-result-section={item.section} data-result-pinned={item.pinned ? 'true' : 'false'}>
      <div className={styles.head}>
        <span className={styles.title}>{item.pinned && <span className={styles.meta} data-result-pin-badge>[ปักหมุด] </span>}{item.title}</span>
        <span className={styles.meta}>{RESULT_KIND_LABEL[item.kind] ?? item.kind} · {savedText} · อัปเดต {formatDate(item.updatedAt)}</span>
      </div>
      <p className={styles.meta}>ล่าสุด: ฉบับที่ {item.latestRevision}{item.origin ? <> · จาก: {onOpenConversation && item.originConversationId ? <button type="button" className="text-button" data-result-origin-link onClick={() => onOpenConversation(item.originConversationId!)}>{item.origin}</button> : item.origin}</> : null}{item.renamed ? ` · ชื่อเดิม: ${item.originalTitle}` : ''}</p>
      {renaming?.id === item.id
        ? <form className={styles.rename} onSubmit={event => { event.preventDefault(); void patch(item, 'rename', { op: 'rename', title: renaming.value }, 'เปลี่ยนชื่อแล้ว').then(ok => { if (ok) setRenaming(null); }); }}>
          <label>ชื่อที่แสดง <input value={renaming.value} maxLength={140} onChange={event => setRenaming({ id: item.id, value: event.target.value })} data-result-rename-input /></label>
          <button className="btn btn-small btn-primary" type="submit" disabled={isBusy || !renaming.value.trim()}>บันทึกชื่อ</button>
          <button className="btn btn-small" type="button" onClick={() => setRenaming(null)}>ยกเลิก</button>
          <span className={styles.meta}>เปลี่ยนเฉพาะชื่อที่แสดง ข้อมูลและหลักฐานของผลลัพธ์ไม่เปลี่ยน</span>
        </form> : null}
      <div className={styles.actions} role="group" aria-label={`จัดการ ${item.title}`}>
        <button className="btn btn-small" type="button" data-result-action="open" disabled={isBusy || open.status === 'loading'} onClick={() => void load(item, item.latestRevision)}>เปิด</button>
        {!item.latestSaved && !item.archived && <button className="btn btn-small" type="button" data-result-action="save" data-result-save-revision={item.latestRevision} disabled={isBusy} onClick={() => void run(item, 'save', () => send(`/api/artifacts/${encodeURIComponent(item.id)}/save`, 'POST', { revision: item.latestRevision }), `บันทึกผลลัพธ์ฉบับที่ ${item.latestRevision} แล้ว`)}>{item.saved ? `บันทึกฉบับที่ ${item.latestRevision}` : 'บันทึก'}</button>}
        <button className="btn btn-small" type="button" data-result-action="rename" disabled={isBusy} onClick={() => setRenaming({ id: item.id, value: item.title })}>เปลี่ยนชื่อ</button>
        <button className="btn btn-small" type="button" data-result-action={item.pinned ? 'unpin' : 'pin'} aria-pressed={item.pinned} disabled={isBusy} onClick={() => void patch(item, 'pin', { op: item.pinned ? 'unpin' : 'pin' }, item.pinned ? 'เลิกปักหมุดแล้ว' : 'ปักหมุดแล้ว')}>{item.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}</button>
        <button className="btn btn-small" type="button" data-result-action={item.archived ? 'unarchive' : 'archive'} disabled={isBusy} onClick={() => void patch(item, 'archive', { op: item.archived ? 'unarchive' : 'archive' }, item.archived ? 'นำกลับมาแล้ว' : 'เก็บถาวรแล้ว')}>{item.archived ? 'นำกลับมา' : 'เก็บถาวร'}</button>
        {['chart', 'table', 'ranking'].includes(item.kind) && !item.archived && <button className="btn btn-small" type="button" data-result-action="add-to-dashboard" disabled={isBusy || !dashboards.length}
          title={!dashboards.length ? 'ยังไม่มี Dashboard ส่วนตัวที่เพิ่มได้' : undefined} onClick={() => setAdding({ id: item.id, dashboardId: dashboards[0]?.id ?? '' })}>เพิ่มเข้า Dashboard (ฉบับที่ {revision})</button>}
        {EXPORTABLE.has(item.kind) && <button className="btn btn-small" type="button" data-result-action="export" disabled={isBusy} data-result-export-revision={revision} onClick={() => void exportCsv(item, revision)}>ส่งออก CSV (ฉบับที่ {revision})</button>}
        {onAskInChat && ['chart', 'table', 'ranking', 'executive_brief'].includes(item.kind) && !item.archived && <button className="btn btn-small" type="button" data-result-action="share" data-result-share-revision={revision} onClick={() => onAskInChat(`แชร์ผลลัพธ์ “${item.title}” ฉบับที่ ${revision} ให้ `, { kind: 'artifact', id: item.id, revision })}>แชร์ผ่านแชต (ฉบับที่ {revision})</button>}
      </div>
      {adding?.id === item.id && <form className={styles.rename} onSubmit={event => { event.preventDefault(); void run(item, 'add', () => send(`/api/dashboards/${encodeURIComponent(adding.dashboardId)}/results`, 'POST', { artifactId: item.id, revision }), `เพิ่มฉบับที่ ${revision} เข้า Dashboard แล้ว — Widget จะดึงข้อมูลสดตามสิทธิ์ของผู้เปิดทุกครั้ง`).then(ok => { if (ok) setAdding(null); }); }}>
        <label>เลือก Dashboard <select value={adding.dashboardId} onChange={event => setAdding({ id: item.id, dashboardId: event.target.value })} data-result-dashboard-select>
          {dashboards.map(d => <option key={d.id} value={d.id}>{d.title}{d.shared ? ' (แชร์แล้ว)' : ''}</option>)}</select></label>
        <button className="btn btn-small btn-primary" type="submit" disabled={isBusy || !adding.dashboardId}>เพิ่ม</button>
        <button className="btn btn-small" type="button" onClick={() => setAdding(null)}>ยกเลิก</button>
        <span className={styles.meta}>เพิ่มเป็น Widget ที่ดึงข้อมูลสด ไม่ใช่ภาพนิ่ง · Dashboard ที่แชร์แล้วจะเป็นรายการให้ตรวจและยืนยันก่อน</span>
      </form>}
      {resultCardActions(item).manageShares && <ShareManager kind="result" id={item.id} />}
      {item.revisions.length > 1 && <details className={styles.history}><summary>ประวัติฉบับ ({item.revisions.length})</summary>
        <div className={styles.revisions} role="group" aria-label={`ฉบับของ ${item.title}`}>{item.revisions.map(revision =>
          <button key={revision} type="button" className="btn btn-small" data-artifact-revision={revision} aria-pressed={open.status === 'ready' && open.opened.artifact.id === item.id && open.opened.artifact.revision === revision}
            onClick={() => void load(item, revision)}>ฉบับที่ {revision}{item.savedRevision === revision ? ' · บันทึกแล้ว' : ''}{revision === item.latestRevision ? ' · ล่าสุด' : ''}</button>)}</div></details>}
    </li>;
  };
  const list = (rows: ResultItem[], label: string) => <ul className={styles.list} aria-label={label}>{rows.map(card)}</ul>;
  const recentGroups = (['today', 'yesterday', 'older'] as const).map(group => ({ group, rows: recent.filter(item => dayGroup(item.updatedAt, now) === group) })).filter(g => g.rows.length);
  const GROUP_LABEL = { today: 'วันนี้', yesterday: 'เมื่อวาน', older: 'ก่อนหน้านี้' } as const;
  const current = open.status === 'ready' ? open.opened : null;

  return <section aria-label="ผลลัพธ์ของฉัน" data-results-library>
    <div className={styles.controls} role="search">
      <label>ค้นหา <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="ชื่อ ประเภท หรือบทสนทนา" data-results-search /></label>
      <label>ประเภท <select value={kind} onChange={event => setKind(event.target.value as ResultKind | 'all')} data-results-kind>
        <option value="all">ทั้งหมด</option>{RESULT_KINDS.map(k => <option key={k} value={k}>{RESULT_KIND_LABEL[k]}</option>)}</select></label>
      <label>สถานะ <select value={section} onChange={event => setSection(event.target.value as ResultSection | 'all')} data-results-status>
        <option value="all">ทั้งหมด</option><option value="saved">บันทึกแล้ว</option><option value="recent">ล่าสุดจากแชต</option><option value="archived">เก็บถาวร</option></select></label>
      <label>เรียง <select value={sort} onChange={event => setSort(event.target.value as ResultSort)} data-results-sort><option value="newest">ใหม่สุดก่อน</option><option value="oldest">เก่าสุดก่อน</option></select></label>
    </div>
    {notice && <p className={notice.kind === 'error' ? styles.error : styles.ok} role={notice.kind === 'error' ? 'alert' : 'status'} data-results-notice>{notice.text}</p>}
    {state.status === 'loading' && <p className={styles.state} role="status">กำลังโหลดผลลัพธ์ของฉัน…</p>}
    {state.status === 'error' && <div className={styles.error} role="alert">โหลดผลลัพธ์ไม่สำเร็จ <button type="button" className="btn btn-small" onClick={() => { setState({ status: 'loading' }); reload(); }}>ลองอีกครั้ง</button></div>}
    {state.status === 'ready' && !items.length && !filtered && <p className={styles.state} data-results-empty>ยังไม่มีผลลัพธ์ — ขอให้ผู้ช่วยทำตาราง กราฟ สรุปผู้บริหาร หรือไฟล์ CSV จากคำตอบที่ตรวจแล้ว ผลลัพธ์จะมาอยู่ที่นี่</p>}
    {state.status === 'ready' && !items.length && filtered && <p className={styles.state} data-results-no-match>ไม่พบผลลัพธ์ที่ตรงกับตัวกรอง</p>}
    {state.status === 'ready' && items.length > 0 && <p className={styles.meta} role="status" data-results-count>แสดง {items.length} จาก {state.total}{state.truncated ? '+' : ''} รายการ{state.truncated ? ' (มีผลลัพธ์มากกว่าที่ค้นได้ในครั้งเดียว — ใช้ค้นหาเพื่อกรอง)' : ''}</p>}
    {saved.length > 0 && <><h2 className={styles.heading}>บันทึกไว้ · {saved.length}</h2>{list(saved, 'ผลลัพธ์ที่บันทึกไว้')}</>}
    {recentGroups.length > 0 && <><h2 className={styles.heading}>ล่าสุดจากแชต · {recent.length}</h2>{recentGroups.map(g => <div key={g.group}><h3 className={styles.subheading}>{GROUP_LABEL[g.group]}</h3>{list(g.rows, `ผลลัพธ์ล่าสุด ${GROUP_LABEL[g.group]}`)}</div>)}</>}
    {archived.length > 0 && <details className={styles.archived} data-results-archived><summary>เก็บถาวร ({archived.length})</summary>{list(archived, 'ผลลัพธ์ที่เก็บถาวร')}</details>}
    {state.status === 'ready' && state.nextCursor && <p><button type="button" className="btn btn-small" data-results-more disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'กำลังโหลด…' : `โหลดเพิ่ม (เหลือ ${Math.max(state.total - items.length, 0)}${state.truncated ? '+' : ''})`}</button></p>}
    {open.status === 'loading' && <p className={styles.state} role="status">กำลังเปิดผลลัพธ์…</p>}
    {open.status === 'error' && <p className={styles.error} role="alert" data-artifact-open-error>{open.message}</p>}
    {current && <div data-artifact-opened={current.artifact.id} data-artifact-opened-revision={current.artifact.revision}>
      <p className={styles.ok}>เปิดจากฉบับที่ {current.artifact.revision}{current.saved ? ' · บันทึกแล้ว' : ' · ฉบับร่าง'} — ข้อมูลตรวจสิทธิ์ปัจจุบันของคุณใหม่ทุกครั้งที่เปิด</p>
      <ArtifactPreview spec={current.spec} drillUrl={(field, value) => `/api/artifacts/${encodeURIComponent(current.artifact.id)}/drilldown?revision=${current.artifact.revision}&field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`} />
    </div>}
  </section>;
}
