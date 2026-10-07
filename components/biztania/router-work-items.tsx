'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import styles from './router-panels.module.css';

type ItemState = 'open' | 'completed' | 'cancelled' | 'archived';
type Op = 'complete' | 'reopen' | 'cancel' | 'archive' | 'edit' | 'unarchive';
type Scope = 'created' | 'assigned' | 'tickets';
interface Item {
  id: string; kind: 'task' | 'ticket'; title: string; priority: string; dueDate: string | null; grouping: string; checklist: string[]; branchIds: string[]; note: string | null;
  mine: boolean; createdByMe: boolean; assigneeLabel: string; creatorLabel: string; detail: string | null; createdAt: string; state: ItemState; revision: number; allowedOps: Op[];
}
interface HistoryEntry { revision: number; op: Op; from: ItemState; to: ItemState; at: string; actorLabel: string; role: 'creator' | 'assignee'; changed?: string[]; assigneeFrom?: string; assigneeTo?: string }
interface Page { items: Item[]; total: number; nextCursor: string | null }
type Load = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Page);
interface Draft { title: string; priority: string; dueDate: string; checklist: string; note: string }
type Notify = (notice: { kind: 'ok' | 'error'; text: string } | null) => void;

const PRIORITY: Record<string, string> = { low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วน' };
const STATE_LABEL: Record<ItemState, string> = { open: 'ยังเปิดอยู่', completed: 'เสร็จแล้ว', cancelled: 'ยกเลิกแล้ว', archived: 'เก็บแล้ว' };
const OP_LABEL: Record<Op, string> = { complete: 'ทำเครื่องหมายว่าเสร็จ', reopen: 'เปิดงานอีกครั้ง', cancel: 'ยกเลิกงาน', archive: 'เก็บเข้าคลัง', edit: 'แก้ไข', unarchive: 'นำกลับมาจากคลัง' };
const FIELD_LABEL: Record<string, string> = { title: 'ชื่องาน', priority: 'ความสำคัญ', dueDate: 'วันครบกำหนด', checklist: 'รายการตรวจ', note: 'หมายเหตุ', assigneeId: 'ผู้รับงาน' };
const FAILED = 'ดำเนินการกับงานไม่สำเร็จ โปรดลองอีกครั้ง';
const CHANGED = 'งานนี้ถูกแก้ไขไปแล้ว โหลดข้อมูลล่าสุดแล้ว';
const formatTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); };

async function fetchPage(scope: Scope, opts: { cursor?: string | null; q?: string; archivedOnly?: boolean }, signal?: AbortSignal): Promise<Page | null> {
  const params = new URLSearchParams({ scope });
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.q) params.set('q', opts.q);
  if (opts.archivedOnly) params.set('view', 'archived');
  const response = await fetch(`/api/work-items?${params}`, { cache: 'no-store', ...(signal ? { signal } : {}) });
  const body = response.ok ? await response.json() as { items?: Item[]; total?: number; nextCursor?: string | null } : null;
  return Array.isArray(body?.items) ? { items: body.items, total: typeof body.total === 'number' ? body.total : body.items.length, nextCursor: body.nextCursor ?? null } : null;
}
async function csrfToken(): Promise<string> {
  const response = await fetch('/api/session', { cache: 'no-store' });
  const body = response.ok ? await response.json() as { csrfToken?: string } : null;
  if (!body?.csrfToken) throw new Error('session');
  return body.csrfToken;
}

function historyLine(entry: HistoryEntry): string {
  const who = `${entry.actorLabel} (${entry.role === 'creator' ? 'ผู้สร้าง' : 'ผู้รับงาน'})`;
  const change = entry.op === 'edit'
    ? `แก้ไข ${entry.changed?.map(field => FIELD_LABEL[field] ?? field).join(', ') ?? ''}${entry.assigneeTo ? ` · เปลี่ยนผู้รับงาน ${entry.assigneeFrom ?? '-'} → ${entry.assigneeTo}` : ''}`
    : `${OP_LABEL[entry.op]}: ${STATE_LABEL[entry.from]} → ${STATE_LABEL[entry.to]}`;
  return `${formatTime(entry.at)} · ${who} — ${change} (ฉบับที่ ${entry.revision})`;
}

async function fetchHistory(id: string, signal?: AbortSignal): Promise<{ entries: HistoryEntry[]; truncatedBefore: number | null } | null> {
  const response = await fetch(`/api/work-items/${encodeURIComponent(id)}`, { cache: 'no-store', ...(signal ? { signal } : {}) });
  const body = response.ok ? await response.json() as { history?: HistoryEntry[]; historyTruncated?: boolean; historyFromRevision?: number } : null;
  return Array.isArray(body?.history) ? { entries: body.history, truncatedBefore: body.historyTruncated ? body.historyFromRevision ?? null : null } : null;
}

/** Exact detail + the ordered, attributable history of one item (loaded on demand; the server authorizes creator / current assignee only). */
function History({ id, defaultOpen = false }: { id: string; defaultOpen?: boolean }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error' | 'ready'; entries: HistoryEntry[]; truncatedBefore?: number | null }>({ status: defaultOpen ? 'loading' : 'idle', entries: [] });
  useEffect(() => {
    if (!defaultOpen) return;
    const controller = new AbortController();
    void (async () => {
      try { const loaded = await fetchHistory(id, controller.signal); if (!controller.signal.aborted) setState(loaded ? { status: 'ready', ...loaded } : { status: 'error', entries: [] }); }
      catch { if (!controller.signal.aborted) setState({ status: 'error', entries: [] }); }
    })();
    return () => controller.abort();
  }, [defaultOpen, id]);
  const onToggle = async (isOpen: boolean) => {
    if (!isOpen || state.status !== 'idle') return;
    setState({ status: 'loading', entries: [] });
    try { const loaded = await fetchHistory(id); setState(loaded ? { status: 'ready', ...loaded } : { status: 'error', entries: [] }); }
    catch { setState({ status: 'error', entries: [] }); }
  };
  return <details open={defaultOpen || undefined} data-work-item-history onToggle={event => void onToggle(event.currentTarget.open)}>
    <summary>ประวัติการเปลี่ยนแปลง</summary>
    {state.status === 'loading' && <p className={styles.preview} role="status">กำลังโหลด…</p>}
    {state.status === 'error' && <p className={styles.noticeError} role="alert">โหลดประวัติไม่สำเร็จ</p>}
    {state.status === 'ready' && state.truncatedBefore ? <p className={styles.receiptLine} data-work-item-history-truncated>แสดงเฉพาะการเปลี่ยนแปลงล่าสุด (ตั้งแต่ฉบับที่ {state.truncatedBefore}) · รายการก่อนหน้านี้ไม่ได้แสดง</p> : null}
    {state.status === 'ready' && (state.entries.length ? <ol className={styles.history}>{state.entries.map(entry => <li key={entry.revision} data-work-item-transition>{historyLine(entry)}</li>)}</ol>
      : <p className={styles.receiptLine} data-work-item-no-history>ยังไม่มีการเปลี่ยนแปลงหลังสร้างงาน</p>)}
  </details>;
}

interface ListProps { scope: Scope; archivedOnly?: boolean; refreshKey: number; onChanged: () => void; notify: Notify; emptyText: string; label: string; listAttr: Record<string, string>; searchable?: boolean }

/** One bounded, searchable list of work (created by me / assigned to me / legacy Tickets / archived) with the actions the server allows this viewer. */
function WorkList({ scope, archivedOnly, refreshKey, onChanged, notify, emptyText, label, listAttr, searchable = true }: ListProps) {
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const page = await fetchPage(scope, { ...(applied ? { q: applied } : {}), ...(archivedOnly ? { archivedOnly: true } : {}) }, controller.signal);
        if (!controller.signal.aborted) setState(page ? { status: 'ready', ...page } : { status: 'error' });
      } catch { if (!controller.signal.aborted) setState({ status: 'error' }); }
    })();
    return () => controller.abort();
  }, [scope, applied, archivedOnly, refreshKey, attempt]);
  const run = useCallback(async (item: Item, op: Op, fields?: Record<string, unknown>) => {
    setBusy(item.id); notify(null);
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() },
        body: JSON.stringify({ op, baseRevision: item.revision, ...(fields ? { fields } : {}) }) });
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (response.ok) { notify({ kind: 'ok', text: op === 'edit' ? 'บันทึกการแก้ไขงานแล้ว' : `อัปเดตงานแล้ว: ${op === 'complete' ? 'เสร็จแล้ว' : op === 'reopen' ? 'เปิดงานอีกครั้ง' : op === 'cancel' ? 'ยกเลิกแล้ว' : op === 'unarchive' ? 'นำกลับมาจากคลังแล้ว' : 'เก็บเข้าคลังแล้ว'}` }); setEditing(null); }
      else if (body?.error?.code === 'WORK_ITEM_CHANGED') { notify({ kind: 'error', text: CHANGED }); setEditing(null); }
      else notify({ kind: 'error', text: body?.error?.message ?? FAILED });
      setConfirmCancel(null);
      onChanged();
    } catch { notify({ kind: 'error', text: FAILED }); } finally { setBusy(null); }
  }, [notify, onChanged]);
  const loadMore = async () => {
    if (state.status !== 'ready' || !state.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(scope, { cursor: state.nextCursor, ...(applied ? { q: applied } : {}), ...(archivedOnly ? { archivedOnly: true } : {}) });
      if (page) setState(current => current.status === 'ready' ? { status: 'ready', items: [...current.items, ...page.items.filter(item => !current.items.some(known => known.id === item.id))], total: page.total, nextCursor: page.nextCursor } : current);
      else notify({ kind: 'error', text: FAILED });
    } catch { notify({ kind: 'error', text: FAILED }); } finally { setLoadingMore(false); }
  };
  const startEdit = (item: Item) => { notify(null); setConfirmCancel(null);
    setEditing({ id: item.id, draft: { title: item.title, priority: item.priority, dueDate: item.dueDate ?? '', checklist: item.checklist.join('\n'), note: item.note ?? '' } }); };
  const saveEdit = (item: Item, event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { draft } = editing;
    void run(item, 'edit', { title: draft.title, priority: draft.priority, dueDate: draft.dueDate || null,
      checklist: draft.checklist.split('\n').map(line => line.trim()).filter(Boolean), note: draft.note.trim() || null });
  };
  if (state.status === 'loading') return <p className={styles.preview} role="status">กำลังโหลด{label}…</p>;
  if (state.status === 'error') return <div className="error-banner" role="alert" data-work-items-load-error>โหลด{label}ไม่สำเร็จ — การเปลี่ยนแปลงล่าสุดอาจบันทึกแล้ว กดโหลดใหม่เพื่อดูสถานะจริง <button type="button" className={styles.chip} onClick={() => { setState({ status: 'loading' }); setAttempt(n => n + 1); }}>ลองอีกครั้ง</button></div>;
  const patch = (key: keyof Draft, value: string) => setEditing(current => current ? { ...current, draft: { ...current.draft, [key]: value } } : current);
  const actionButton = (item: Item, op: Exclude<Op, 'edit' | 'cancel'>) =>
    item.allowedOps.includes(op) ? <button type="button" className={styles.chip} data-work-item-action={op} disabled={busy !== null} onClick={() => void run(item, op)}>{op === 'complete' ? 'เสร็จแล้ว' : op === 'reopen' ? 'เปิดงานอีกครั้ง' : op === 'unarchive' ? 'นำกลับมา' : 'เก็บเข้าคลัง'}</button> : null;
  const card = (item: Item) => <li key={item.id} className={styles.receiptCard} data-work-item={item.id} data-work-item-state={item.state} data-work-item-kind={item.kind}>
    <div className={styles.cardHead}><strong>{item.title}</strong><span className={styles.pill}>{STATE_LABEL[item.state]} · ความสำคัญ {PRIORITY[item.priority] ?? item.priority}</span></div>
    <p className={styles.receiptLine}>{item.dueDate ? `ครบกำหนด ${item.dueDate}` : 'ไม่กำหนดวันครบ'} · {item.grouping === 'per_branch' ? 'แยกเป็นรายสาขา' : item.kind === 'ticket' ? 'Ticket เดียว' : 'งานเดียว'}{item.branchIds.length ? ` · สาขา ${item.branchIds.join(', ')}` : ''}</p>
    <p className={styles.receiptLine} data-work-item-people>{item.kind === 'ticket' ? `ผู้รับผิดชอบ: ${item.assigneeLabel}` : item.createdByMe ? `ผู้รับงาน: ${item.mine ? 'ตัวคุณเอง' : item.assigneeLabel}` : `มอบหมายโดย: ${item.creatorLabel}`}</p>
    {item.detail && <p className={styles.receiptLine}>เหตุผล: {item.detail}</p>}
    {item.checklist.length > 0 && <ul aria-label="รายการตรวจ">{item.checklist.map(entry => <li key={entry}>{entry}</li>)}</ul>}
    {item.note && <p className={styles.receiptLine}>หมายเหตุ: {item.note}</p>}
    {editing?.id === item.id ? <form className={styles.receipt} aria-label={`แก้ไขงาน ${item.title}`} onSubmit={event => saveEdit(item, event)} data-work-item-edit-form>
      <p><label>ชื่องาน <input value={editing.draft.title} maxLength={120} required onChange={event => patch('title', event.target.value)} /></label></p>
      <p><label>ความสำคัญ <select value={editing.draft.priority} onChange={event => patch('priority', event.target.value)}>{Object.entries(PRIORITY).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label></p>
      <p><label>วันครบกำหนด <input type="date" value={editing.draft.dueDate} onChange={event => patch('dueDate', event.target.value)} /></label></p>
      <p><label>รายการตรวจ (บรรทัดละหนึ่งรายการ) <textarea rows={4} value={editing.draft.checklist} onChange={event => patch('checklist', event.target.value)} /></label></p>
      <p><label>หมายเหตุ <textarea rows={2} maxLength={300} value={editing.draft.note} onChange={event => patch('note', event.target.value)} /></label></p>
      <div className={styles.artifactActions}>
        <button type="submit" className={styles.chip} disabled={busy !== null}>บันทึก</button>
        <button type="button" className={styles.chip} disabled={busy !== null} onClick={() => setEditing(null)}>ยกเลิก</button>
      </div>
    </form> : confirmCancel === item.id ? <div role="alertdialog" aria-labelledby={`work-cancel-${item.id}`} className={styles.receipt} data-work-item-confirm-cancel>
      <strong id={`work-cancel-${item.id}`}>ยกเลิกงาน “{item.title}”?</strong>
      <div className={styles.artifactActions}>
        <button type="button" className={`${styles.chip} ${styles.chipDanger}`} disabled={busy !== null} onClick={() => void run(item, 'cancel')}>ยืนยันยกเลิกงาน</button>
        <button type="button" className={styles.chip} disabled={busy !== null} onClick={() => setConfirmCancel(null)}>ไม่ยกเลิก</button>
      </div>
    </div> : <div className={styles.artifactActions}>
      {actionButton(item, 'complete')}
      {item.allowedOps.includes('edit') && <button type="button" className={styles.chip} data-work-item-action="edit" disabled={busy !== null} onClick={() => startEdit(item)}>แก้ไข</button>}
      {item.allowedOps.includes('cancel') && <button type="button" className={styles.chip} data-work-item-action="cancel" disabled={busy !== null} onClick={() => { notify(null); setConfirmCancel(item.id); }}>ยกเลิกงาน</button>}
      {actionButton(item, 'reopen')}{actionButton(item, 'archive')}{actionButton(item, 'unarchive')}
    </div>}
    <History id={item.id} />
  </li>;
  return <>
    {searchable && (state.total > 0 || applied) && <form role="search" className={styles.artifactActions} onSubmit={event => { event.preventDefault(); setState({ status: 'loading' }); setApplied(query.trim()); }} data-work-search>
      <label>ค้นหา{label} <input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
      <button type="submit" className={styles.chip}>ค้นหา</button>
      {applied && <button type="button" className={styles.chip} onClick={() => { setQuery(''); setState({ status: 'loading' }); setApplied(''); }}>ล้างการค้นหา</button>}
    </form>}
    {state.items.length ? <>
      <p className={styles.receiptLine} data-work-count>แสดง {state.items.length} จาก {state.total} รายการ</p>
      <ul className={styles.list} aria-label={label} {...listAttr}>{state.items.map(card)}</ul>
      {state.nextCursor && <button type="button" className={styles.chip} data-work-more disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'กำลังโหลด…' : 'โหลดรายการเพิ่ม'}</button>}
    </> : <p className={styles.preview} data-work-items-empty={scope === 'created' && !archivedOnly ? '' : undefined}>{applied ? 'ไม่พบรายการที่ตรงกับคำค้นหา' : emptyText}</p>}
  </>;
}

/** An item opened from an assignment notification: exact detail (current state + history) for its creator or current assignee. */
function FocusedItem({ id }: { id: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; item?: Item }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/work-items/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const body = response.ok ? await response.json() as { item?: Item } : null;
        if (!cancelled) setState(body?.item ? { status: 'ready', item: body.item } : { status: 'error' });
      } catch { if (!cancelled) setState({ status: 'error' }); }
    })();
    return () => { cancelled = true; };
  }, [id]);
  if (state.status === 'loading') return <p className={styles.preview} role="status">กำลังเปิดงาน…</p>;
  if (state.status === 'error' || !state.item) return <p className={styles.noticeError} role="alert" data-work-item-focus-error>ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์ดูงานนี้แล้ว</p>;
  const item = state.item;
  return <section className={styles.receiptCard} data-work-item-focus={item.id} aria-label="รายละเอียดงานที่เปิด">
    <div className={styles.cardHead}><strong>{item.title}</strong><span className={styles.pill}>{STATE_LABEL[item.state]} · ความสำคัญ {PRIORITY[item.priority] ?? item.priority}</span></div>
    <p className={styles.receiptLine}>{item.createdByMe ? `ผู้รับงาน: ${item.mine ? 'ตัวคุณเอง' : item.assigneeLabel}` : `มอบหมายโดย: ${item.creatorLabel}`} · {item.dueDate ? `ครบกำหนด ${item.dueDate}` : 'ไม่กำหนดวันครบ'}</p>
    {item.checklist.length > 0 && <ul aria-label="รายการตรวจ">{item.checklist.map(entry => <li key={entry}>{entry}</li>)}</ul>}
    {item.note && <p className={styles.receiptLine}>หมายเหตุ: {item.note}</p>}
    <p className={styles.receiptLine}>ทำเครื่องหมายว่าเสร็จหรือเปิดงานอีกครั้งได้จากรายการด้านล่าง</p>
    <History id={item.id} defaultOpen />
  </section>;
}

/**
 * Work created by confirmed task.create / ticket.create plans: tasks I created, tasks assigned to me (view + complete / reopen),
 * legacy Tickets I created, and archived tasks; each is a bounded, searchable list with the lifecycle actions the server allows.
 */
export default function RouterWorkItems() {
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setFocusId(new URLSearchParams(window.location.search).get('workItem'));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const onChanged = useCallback(() => setRefreshKey(key => key + 1), []);
  const shared = { refreshKey, onChanged, notify: setNotice };
  return <>
    <p className={notice?.kind === 'ok' ? styles.noticeOk : undefined} role="status" aria-live="polite" data-work-item-status>{notice?.kind === 'ok' ? notice.text : ''}</p>
    {notice?.kind === 'error' && <p className={styles.noticeError} role="alert">{notice.text}</p>}
    {focusId && <FocusedItem key={focusId} id={focusId} />}
    <h3 className={styles.subHeading}>งานที่ฉันสร้าง</h3>
    <WorkList {...shared} scope="created" label="งานติดตามของฉัน" emptyText="ยังไม่มีงานติดตามที่สร้างผ่านผู้ช่วย" listAttr={{ 'data-work-items': '' }} />
    <h3 className={styles.subHeading}>งานที่มอบหมายให้ฉัน</h3>
    <WorkList {...shared} scope="assigned" label="งานที่มอบหมายให้ฉัน" emptyText="ยังไม่มีงานที่ผู้อื่นมอบหมายให้คุณ" listAttr={{ 'data-assigned-work-items': '' }} />
    <h3 className={styles.subHeading}>Ticket ที่ฉันสร้าง</h3>
    <WorkList {...shared} scope="tickets" label="Ticket ที่ฉันสร้าง" emptyText="ยังไม่มี Ticket ที่สร้างผ่านผู้ช่วย" listAttr={{ 'data-tickets': '' }} />
    <details open={archivedOpen} onToggle={event => setArchivedOpen(event.currentTarget.open)} data-work-items-archived>
      <summary>งานที่เก็บแล้ว</summary>
      {archivedOpen && <WorkList {...shared} scope="created" archivedOnly label="งานที่เก็บแล้ว" emptyText="ยังไม่มีงานที่เก็บเข้าคลัง" listAttr={{ 'data-work-items-archived-list': '' }} />}
    </details>
  </>;
}
