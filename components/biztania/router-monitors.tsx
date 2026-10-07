'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY, MONITOR_LOAD_ERROR_COPY, requestMonitorPage } from './monitor-data';
import styles from './router-panels.module.css';

interface Evaluation { at: string; observedAt: string | null; date: string; checked: number; breached: number; outcome: 'ok' | 'breach_cooldown' | 'alerted' | 'held'; notified: number; reason?: string }
interface Monitor { id: string; title: string; status: string; lifecycle: string; cadence: string; recipientCount: number; lastEvaluatedAt: string | null; lastError: string | null; evaluations: Evaluation[]; threshold?: number; cooldown?: 'one_hour' | 'one_day'; expiresAt?: string }
interface Page { monitors: Monitor[]; total: number; nextCursor: string | null }
type Load = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Page);
type Op = 'pause' | 'resume' | 'delete' | 'rename';

const OUTCOME: Record<Evaluation['outcome'], string> = { ok: 'ปกติ ไม่มีสาขาต่ำกว่าเกณฑ์', breach_cooldown: 'มีสาขาต่ำกว่าเกณฑ์ แต่อยู่ในช่วงพักการแจ้งซ้ำ', alerted: 'ต่ำกว่าเกณฑ์ — ส่งการแจ้งเตือนแล้ว', held: 'หยุดการแจ้งเตือนแล้ว กรุณาสร้าง Monitor ใหม่' };
const LIFECYCLE: Record<string, string> = { active: 'ทำงานอยู่', paused: 'หยุดชั่วคราว', needs_renewal: 'ต้องสร้างใหม่' };
/** Finite display map for the stored lastError codes (codes stay unchanged; unknown codes never claim a cause). */
const ERROR_TEXT: Record<string, string> = {
  monitor_expired: 'Monitor หมดอายุแล้ว กรุณาสร้างใหม่',
  owner_inactive: 'บัญชีผู้สร้าง Monitor ไม่พร้อมใช้งาน จึงหยุดการแจ้งเตือนไว้',
  recipient_missing: 'ไม่พบผู้รับที่ระบุ กรุณาตรวจผู้รับและสร้าง Monitor ใหม่',
  authority_changed: 'สิทธิ์หรือขอบเขตข้อมูลเปลี่ยนไป จึงหยุดการแจ้งเตือนไว้ กรุณาสร้าง Monitor ใหม่',
  'incomplete_evidence:monitor_evidence_binding': 'ข้อมูลยอดขายหรือ Target ยังไม่ครบ จึงยังประเมินผลรอบนี้ไม่ได้',
  'incomplete_evidence:observation_clock': 'ยังยืนยันเวลาของข้อมูลไม่ได้ จึงยังประเมินผลรอบนี้ไม่ได้',
};
const ERROR_UNKNOWN = 'ยังตรวจ Monitor รอบล่าสุดไม่สำเร็จ กรุณาตรวจผลอีกครั้งภายหลัง';
const errorText = (code: string) => ERROR_TEXT[code] ?? (/^permission_denied:|:(scope_or_permission|recipient_denied|recipient_scope|consent_denied|claim_use_denied|authorization_changed)$/.test(code) ? ERROR_TEXT.authority_changed : ERROR_UNKNOWN);
const formatTime = (iso: string | null) => { if (!iso) return '-'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); };
const FAILED = 'ดำเนินการกับ Monitor ไม่สำเร็จ โปรดลองอีกครั้ง';
/** Why a Monitor was held (stored reason codes of the server's renewal rules), in plain Thai. */
const HOLD_REASON: Record<string, string> = {
  monitor_expired: 'Monitor นี้หมดอายุตามความยินยอมที่ให้ไว้', owner_inactive: 'บัญชีเจ้าของ Monitor ไม่ได้ใช้งานแล้ว',
  scope_or_permission: 'สิทธิ์หรือขอบเขตข้อมูลของคุณเปลี่ยนไป', authority_changed: 'สิทธิ์หรือขอบเขตข้อมูลของคุณเปลี่ยนไป', authorization_changed: 'สิทธิ์ของคุณเปลี่ยนไป',
  recipient_denied: 'สิทธิ์ของผู้รับแจ้งเตือนเปลี่ยนไป', recipient_scope: 'ขอบเขตข้อมูลของผู้รับแจ้งเตือนเปลี่ยนไป', consent_denied: 'ความยินยอมในการแจ้งเตือนเปลี่ยนไป', claim_use_denied: 'ข้อมูลที่ใช้แจ้งเตือนใช้ไม่ได้แล้ว',
};
const formatDay = (iso: string | undefined) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('th-TH', { dateStyle: 'medium' }); };

/** Condition, cadence, cooldown, expiry and (when held) the reason and the way out; all derived from the server's stored configuration. */
function Explanation({ monitor }: { monitor: Monitor }) {
  const expires = formatDay(monitor.expiresAt);
  return <details data-monitor-explain>
    <summary>เงื่อนไขและอายุของ Monitor</summary>
    <ul className={styles.history}>
      {typeof monitor.threshold === 'number' && <li>เงื่อนไข: แจ้งเตือนเมื่อยอดขายของสาขาต่ำกว่า {Math.round(monitor.threshold * 10000) / 100}% ของเป้า</li>}
      <li>ตรวจวันละครั้ง{monitor.cooldown ? ` · หลังแจ้งแล้วจะไม่แจ้งซ้ำภายใน ${monitor.cooldown === 'one_hour' ? '1 ชั่วโมง' : '1 วัน'}` : ''}</li>
      {expires && <li>ใช้ได้ถึง {expires} — หลังจากนั้นต้องสร้าง Monitor ใหม่</li>}
      {monitor.lifecycle === 'needs_renewal' && <li data-monitor-renewal-reason>หยุดทำงานแล้ว: {(monitor.lastError && HOLD_REASON[monitor.lastError]) ?? 'สิทธิ์ ผู้รับ หรือหลักฐานเปลี่ยนไป'} · ต้องขอให้ผู้ช่วยสร้าง Monitor ใหม่ จะหยุดหรือเริ่มต่อไม่ได้</li>}
      <li>แก้ได้เฉพาะชื่อที่แสดง การเปลี่ยนเงื่อนไข ผู้รับ หรือรอบการตรวจต้องสร้าง Monitor ใหม่และยืนยันอีกครั้ง</li>
    </ul>
  </details>;
}

async function fetchMonitors(opts: { cursor?: string | null; q?: string; deleted?: boolean } = {}, signal?: AbortSignal): Promise<Page | null> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.q) params.set('q', opts.q);
  if (opts.deleted) params.set('deleted', '1');
  return requestMonitorPage<Monitor>(`/api/monitors${params.size ? `?${params}` : ''}`, { signal });
}
async function csrfToken(): Promise<string> {
  const response = await fetch('/api/session', { cache: 'no-store' });
  const body = response.ok ? await response.json() as { csrfToken?: string } : null;
  if (!body?.csrfToken) throw new Error('session');
  return body.csrfToken;
}

function Evaluations({ monitor }: { monitor: Monitor }) {
  return monitor.evaluations.length ? <ol aria-label="ผลการตรวจล่าสุด" className={styles.history}>{monitor.evaluations.map(entry => <li key={entry.at} data-monitor-evaluation>
    <span>{formatTime(entry.at)} · ข้อมูลวันที่ {entry.date}</span> <span>ตรวจ {entry.checked} สาขา · ต่ำกว่าเกณฑ์ {entry.breached} สาขา{entry.notified ? ` · แจ้ง ${entry.notified} คน` : ''}</span> <strong>{OUTCOME[entry.outcome]}</strong>
  </li>)}</ol> : <p className={styles.receiptLine} data-monitor-no-history>ยังไม่มีผลการตรวจ — ระบบตรวจตามรอบรายวัน</p>;
}

/** Deleted Monitors: their retained evaluations stay readable here (read-only; owner-scoped by the server). */
function DeletedMonitors() {
  const [state, setState] = useState<{ open: boolean; load: Load; more: boolean }>({ open: false, load: { status: 'loading' }, more: false });
  const open = async (isOpen: boolean) => {
    setState(current => ({ ...current, open: isOpen }));
    if (!isOpen) return;
    try { const page = await fetchMonitors({ deleted: true }); setState(current => ({ ...current, load: page ? { status: 'ready', ...page } : { status: 'error' } })); }
    catch { setState(current => ({ ...current, load: { status: 'error' } })); }
  };
  const loadMore = async () => {
    if (state.load.status !== 'ready' || !state.load.nextCursor) return;
    setState(current => ({ ...current, more: true }));
    try {
      const page = await fetchMonitors({ deleted: true, cursor: state.load.nextCursor });
      if (page) setState(current => current.load.status === 'ready' ? { ...current, load: { status: 'ready', monitors: [...current.load.monitors, ...page.monitors], total: page.total, nextCursor: page.nextCursor } } : current);
    } catch { /* keep what is shown */ } finally { setState(current => ({ ...current, more: false })); }
  };
  const { load } = state;
  return <details open={state.open} onToggle={event => { const isOpen = event.currentTarget.open; if (isOpen !== state.open) void open(isOpen); }} data-monitors-deleted>
    <summary>Monitor ที่ลบแล้ว (ดูประวัติการตรวจที่เก็บไว้)</summary>
    {state.open && (load.status === 'loading' ? <p className={styles.preview} role="status">กำลังโหลด…</p>
      : load.status === 'error' ? <p className={styles.noticeError} role="alert">โหลดประวัติของ Monitor ที่ลบแล้วไม่สำเร็จ</p>
        : !load.monitors.length ? <p className={styles.preview} data-monitors-deleted-empty>ยังไม่มี Monitor ที่ลบแล้ว</p>
          : <>
            <p className={styles.receiptLine}>แสดง {load.monitors.length} จาก {load.total} รายการ</p>
            <ul className={styles.list} aria-label="Monitor ที่ลบแล้ว">{load.monitors.map(monitor => <li key={monitor.id} className={styles.receiptCard} data-deleted-monitor={monitor.id}>
              <div className={styles.cardHead}><strong>{monitor.title}</strong><span className={styles.pill}>ลบแล้ว</span></div>
              <p className={styles.receiptLine}>ตรวจล่าสุด {formatTime(monitor.lastEvaluatedAt)} · ไม่มีการแจ้งเตือนอีกแล้ว</p>
              <Evaluations monitor={monitor} />
            </li>)}</ul>
            {load.nextCursor && <button type="button" className={styles.chip} disabled={state.more} onClick={() => void loadMore()}>{state.more ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}</button>}
          </>)}
  </details>;
}

/** Monitors with the persisted result of each evaluation, plus direct pause / resume / delete (delete asks an explicit confirmation first). Bounded pages with search. */
export default function RouterMonitors() {
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [afterMutationReadFailure, setAfterMutationReadFailure] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const page = await fetchMonitors({ ...(applied ? { q: applied } : {}) }, controller.signal);
        if (!controller.signal.aborted) {
          setState(page ? { status: 'ready', ...page } : { status: 'error' });
          if (page) setAfterMutationReadFailure(false);
        }
      } catch { if (!controller.signal.aborted) setState({ status: 'error' }); }
    })();
    return () => controller.abort();
  }, [applied, attempt]);
  const run = useCallback(async (monitor: Monitor, op: Op, title?: string) => {
    setBusy(monitor.id); setNotice(null);
    try {
      const response = await fetch(`/api/monitors/${encodeURIComponent(monitor.id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() },
        body: JSON.stringify(op === 'delete' ? { op, confirmDelete: true } : op === 'rename' ? { op, title } : { op }) });
      const body = await response.json().catch(() => null) as { text?: string; error?: { message?: string } } | null;
      if (response.ok) setNotice({ kind: 'ok', text: body?.text ?? 'อัปเดต Monitor แล้ว' }); else setNotice({ kind: 'error', text: body?.error?.message ?? FAILED });
      setConfirming(null);
      if (response.ok) setRenaming(null);
      // The list is re-read from the server. If that read fails the stale list is NOT shown as current: the page says so and offers a retry.
      const page = await fetchMonitors({ ...(applied ? { q: applied } : {}) }).catch(() => null);
      if (page) {
        setState({ status: 'ready', ...page });
        setAfterMutationReadFailure(false);
      } else {
        setState({ status: 'error' });
        setAfterMutationReadFailure(response.ok);
      }
    } catch { setNotice({ kind: 'error', text: FAILED }); } finally { setBusy(null); }
  }, [applied]);
  const loadMore = async () => {
    if (state.status !== 'ready' || !state.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchMonitors({ cursor: state.nextCursor, ...(applied ? { q: applied } : {}) });
      if (page) setState(current => current.status === 'ready' ? { status: 'ready', monitors: [...current.monitors, ...page.monitors.filter(m => !current.monitors.some(known => known.id === m.id))], total: page.total, nextCursor: page.nextCursor } : current);
      else setNotice({ kind: 'error', text: FAILED });
    } catch { setNotice({ kind: 'error', text: FAILED }); } finally { setLoadingMore(false); }
  };
  const search = (event: FormEvent) => { event.preventDefault(); setState({ status: 'loading' }); setApplied(query.trim()); };
  if (state.status === 'loading') return <p className={styles.preview} role="status">กำลังโหลด Monitor…</p>;
  if (state.status === 'error') return <div className="error-banner" role="alert" data-monitors-load-error>{afterMutationReadFailure ? MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY : MONITOR_LOAD_ERROR_COPY} <button type="button" className={styles.chip} onClick={() => { setState({ status: 'loading' }); setAttempt(n => n + 1); }}>ลองอีกครั้ง</button></div>;
  const status = <p className={notice?.kind === 'ok' ? styles.noticeOk : undefined} role="status" aria-live="polite" data-monitor-status>{notice?.kind === 'ok' ? notice.text : ''}</p>;
  const alert = notice?.kind === 'error' ? <p className={styles.noticeError} role="alert" data-monitor-error-notice>{notice.text}</p> : null;
  const searchBox = <form role="search" className={styles.artifactActions} onSubmit={search} data-monitor-search>
    <label>ค้นหา Monitor <input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
    <button type="submit" className={styles.chip}>ค้นหา</button>
    {applied && <button type="button" className={styles.chip} onClick={() => { setQuery(''); setState({ status: 'loading' }); setApplied(''); }}>ล้างการค้นหา</button>}
  </form>;
  if (!state.monitors.length) return <>{status}{alert}{(applied || state.total > 0) && searchBox}<p className={styles.preview} data-monitors-empty>{applied ? 'ไม่พบ Monitor ที่ตรงกับคำค้นหา' : 'ยังไม่มี Monitor — ขอให้ผู้ช่วยแจ้งเตือนเมื่อยอดขายต่ำกว่า Target'}</p><DeletedMonitors /></>;
  return <>{status}{alert}{searchBox}
    <p className={styles.receiptLine} data-monitors-count>แสดง {state.monitors.length} จาก {state.total} Monitor</p>
    <ul className={styles.list} aria-label="Monitor ของฉัน" data-monitors>{state.monitors.map(monitor => <li key={monitor.id} className={styles.receiptCard} data-monitor={monitor.id}>
    <div className={styles.cardHead}><strong>{monitor.title}</strong><span className={styles.pill}>{LIFECYCLE[monitor.lifecycle] ?? monitor.lifecycle}</span></div>
    <p className={styles.receiptLine}>ตรวจ{monitor.cadence === 'daily' ? 'วันละครั้ง' : 'ตามรอบ'} · แจ้งเตือนคุณและผู้รับที่เลือกในกล่องข้อความ · ตรวจล่าสุด {formatTime(monitor.lastEvaluatedAt)}</p>
    {monitor.lastError && monitor.lifecycle !== 'needs_renewal' && <p className={styles.receiptLine} data-monitor-error>สถานะล่าสุด: {errorText(monitor.lastError)}</p>}
    <Explanation monitor={monitor} />
    <Evaluations monitor={monitor} />
    {confirming === monitor.id ? <div role="alertdialog" aria-labelledby={`monitor-confirm-${monitor.id}`} aria-describedby={`monitor-confirm-text-${monitor.id}`} className={styles.receipt} data-monitor-confirm-delete>
      <strong id={`monitor-confirm-${monitor.id}`}>ลบ Monitor “{monitor.title}”?</strong>
      <p id={`monitor-confirm-text-${monitor.id}`}>จะไม่มีการแจ้งเตือนอีก ประวัติการตรวจที่ผ่านมายังดูได้ในหัวข้อ “Monitor ที่ลบแล้ว”</p>
      <div className={styles.artifactActions}>
        <button type="button" className={`${styles.chip} ${styles.chipDanger}`} disabled={busy !== null} onClick={() => void run(monitor, 'delete')}>ยืนยันลบ Monitor</button>
        <button type="button" className={styles.chip} disabled={busy !== null} onClick={() => setConfirming(null)}>ยกเลิก</button>
      </div>
    </div> : <div className={styles.artifactActions}>
      {monitor.lifecycle === 'active' && <button type="button" className={styles.chip} data-monitor-action="pause" disabled={busy !== null} onClick={() => void run(monitor, 'pause')}>หยุดชั่วคราว</button>}
      {monitor.lifecycle === 'paused' && <button type="button" className={styles.chip} data-monitor-action="resume" disabled={busy !== null} onClick={() => void run(monitor, 'resume')}>เริ่มต่อ</button>}
      <button type="button" className={styles.chip} data-monitor-action="rename" disabled={busy !== null} onClick={() => { setNotice(null); setRenaming({ id: monitor.id, value: monitor.title }); }}>เปลี่ยนชื่อ</button>
      <button type="button" className={styles.chip} data-monitor-action="delete" disabled={busy !== null} onClick={() => { setNotice(null); setConfirming(monitor.id); }}>ลบ</button>
    </div>}
    {renaming?.id === monitor.id && confirming !== monitor.id && <form className={styles.receipt} aria-label={`เปลี่ยนชื่อ Monitor ${monitor.title}`} data-monitor-rename-form onSubmit={event => { event.preventDefault(); void run(monitor, 'rename', renaming.value); }}>
      <label>ชื่อที่แสดง <input value={renaming.value} maxLength={120} required onChange={event => setRenaming({ id: monitor.id, value: event.target.value })} /></label>
      <div className={styles.artifactActions}><button type="submit" className={styles.chip} disabled={busy !== null || !renaming.value.trim()}>บันทึกชื่อ</button><button type="button" className={styles.chip} onClick={() => setRenaming(null)}>ยกเลิก</button></div>
    </form>}
  </li>)}</ul>
    {state.nextCursor && <button type="button" className={styles.chip} data-monitors-more disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'กำลังโหลด…' : 'โหลด Monitor เพิ่ม'}</button>}
    <DeletedMonitors />
  </>;
}
