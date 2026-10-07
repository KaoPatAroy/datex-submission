'use client';

import { useEffect, useRef, useState } from 'react';
import type { BadgeReview, PendingAction, Workspace } from '@/lib/contracts';
import { Icon } from '@/components/icons';
import { actionName, actionState, type LifecycleAction } from '@/components/biztania/product-labels';
import ActionSummary, { hasShareApprovalDetails } from '@/components/action-summary';
import styles from './action-review-dialog.module.css';
import BadgeCurrentReview, { badgeReviewIsCurrent, type BadgeReviewStatus } from './biztania/badge-review';

export type DashboardRevisionPatch = { title?: string; description?: string; widgetChange?: { operation: 'remove'; indexes: number[] } | { operation: 'reorder'; order: number[] } };
export type DashboardRevisionRequest = { requestKey: string; patch: DashboardRevisionPatch };
type RevisionDraft = { actionId: string; title: string; description: string; widgetMode: 'unchanged' | 'remove' | 'reorder'; removed: number[]; order: number[] };
type RevisionAttempt = { actionId: string; fingerprint: string; requestKey: string };
type RevisionMemory = { draft: RevisionDraft; attempt: RevisionAttempt | null };
function revisionStorageKey(action: PendingAction) {
  return `biztania:action-draft:v1:${action.actorId}:${action.sessionId}:${action.id}`;
}
function readRevisionMemory(action: PendingAction | null): RevisionMemory | null {
  if (!action || action.payload.kind !== 'dashboard_create' || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(revisionStorageKey(action));
    if (!raw) return null;
    const value = JSON.parse(raw) as RevisionMemory & { payloadHash?: string };
    const draft = value.draft;
    const count = action.payload.spec.widgets.length;
    const validIndexes = (items: unknown): items is number[] => Array.isArray(items) && items.every(index => Number.isInteger(index) && index >= 0 && index < count) && new Set(items).size === items.length;
    if (value.payloadHash !== action.payloadHash || !draft || draft.actionId !== action.id || typeof draft.title !== 'string' || draft.title.length > 120 || typeof draft.description !== 'string' || draft.description.length > 500 || !['unchanged', 'remove', 'reorder'].includes(draft.widgetMode) || !validIndexes(draft.removed) || !validIndexes(draft.order) || draft.order.length !== count) return null;
    if (value.attempt && (value.attempt.actionId !== action.id || typeof value.attempt.fingerprint !== 'string' || typeof value.attempt.requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(value.attempt.requestKey))) return null;
    return { draft, attempt: value.attempt ?? null };
  } catch { return null; }
}
function writeRevisionMemory(action: PendingAction, draft: RevisionDraft | null, attempt: RevisionAttempt | null) {
  try {
    if (draft) window.sessionStorage.setItem(revisionStorageKey(action), JSON.stringify({ payloadHash: action.payloadHash, draft, attempt }));
    else window.sessionStorage.removeItem(revisionStorageKey(action));
    return true;
  } catch { return false; }
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function confirmLabel(kind: PendingAction['payload']['kind']) {
  return kind === 'dashboard_create' ? 'สร้าง Dashboard' : kind === 'dashboard_share' ? 'แชร์ Dashboard' : kind === 'badge_revoke' ? 'เพิกถอนบัตร' : kind === 'ticket_create' ? 'สร้าง Ticket ติดตามสาขา' : 'ยืนยัน';
}

export default function ActionReviewDialog({ action, currentTime, canConfirm, canRevise, confirmBusy, mutationBusy, mutationUncertain, confirmError, onClose, onConfirm, onRevise, onCancelAction, onRefresh, profiles, badgeReview, badgeReviewStatus = 'unavailable', onRefreshBadge }: {
  action: PendingAction | null; currentTime: number; canConfirm: boolean; canRevise: boolean; confirmBusy: boolean;
  mutationBusy?: 'revise' | 'cancel'; mutationUncertain?: 'revise' | 'cancel'; confirmError?: string | null;
  onClose: () => void; onConfirm: (action: PendingAction) => void;
  onRevise: (action: PendingAction, request: DashboardRevisionRequest) => Promise<void>;
  onCancelAction: (action: PendingAction) => Promise<void>; onRefresh: () => Promise<unknown>; profiles?: Workspace['profiles'];
  badgeReview?: BadgeReview; badgeReviewStatus?: BadgeReviewStatus; onRefreshBadge?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const [restored] = useState(() => readRevisionMemory(action));
  const [draft, setDraft] = useState<RevisionDraft | null>(restored?.draft ?? null);
  const [editingId, setEditingId] = useState<string | null>(restored?.draft.actionId ?? null);
  const [cancelPromptId, setCancelPromptId] = useState<string | null>(null);
  const [error, setError] = useState<{ actionId: string; text: string } | null>(null);
  const attemptRef = useRef<RevisionAttempt | null>(restored?.attempt ?? null);
  const submittingRef = useRef(false);
  const actionId = action?.id;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (actionId && dialog && !dialog.open) { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog.showModal(); }
    if (!actionId && dialog?.open) dialog.close();
    if (actionId) { const body = dialog?.querySelector<HTMLElement>('.dialog-body'); if (body) body.scrollTop = 0; headingRef.current?.focus(); }
  }, [actionId]);
  useEffect(() => () => { if (dialogRef.current?.open) dialogRef.current.close(); }, []);
  useEffect(() => { if (error?.actionId === actionId) errorRef.current?.scrollIntoView({ block: 'nearest' }); }, [error, actionId]);
  if (!action) return null;
  const expiration = Date.parse(action.expiresAt);
  const isExpired = !Number.isFinite(expiration) || currentTime > 0 && expiration <= currentTime;
  const lifecycle = action as LifecycleAction;
  const dashboard = action.payload.kind === 'dashboard_create' ? action.payload.spec : null;
  const editing = Boolean(dashboard && editingId === action.id && draft?.actionId === action.id && actionState(action, currentTime).key === 'pending');
  const pending = actionState(action, currentTime).key === 'pending';
  const busy = confirmBusy || Boolean(mutationBusy);
  const patch: DashboardRevisionPatch = {};
  if (editing && draft && dashboard) {
    if (draft.title !== dashboard.title) patch.title = draft.title;
    if (draft.description !== dashboard.description) patch.description = draft.description;
    if (draft.widgetMode === 'remove' && draft.removed.length) patch.widgetChange = { operation: 'remove', indexes: [...draft.removed].sort((a, b) => a - b) };
    if (draft.widgetMode === 'reorder' && draft.order.some((index, position) => index !== position)) patch.widgetChange = { operation: 'reorder', order: [...draft.order] };
  }
  const changed = Object.keys(patch).length > 0;
  const validDraft = Boolean(draft && draft.title.trim() && draft.title.length <= 120 && draft.description.length <= 500 && (!dashboard || draft.widgetMode !== 'remove' || draft.removed.length < dashboard.widgets.length));
  const badgeReady = action.payload.kind !== 'badge_revoke' || badgeReviewStatus === 'ready' && badgeReviewIsCurrent(action, badgeReview);
  const allowed = canConfirm && pending && !isExpired && hasShareApprovalDetails(action) && badgeReady && !changed && !busy && cancelPromptId !== action.id;
  function closeReview() {
    const id = action?.id;
    dialogRef.current?.close();
    setCancelPromptId(null);
    onClose();
    requestAnimationFrame(() => {
      const currentReview = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-action-review]')).find(button => button.dataset.actionReview === id);
      if (currentReview?.isConnected && !currentReview.disabled) currentReview.focus();
      else if (currentReview?.isConnected) currentReview.closest('[data-action-id]')?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      else {
        const card = Array.from(document.querySelectorAll<HTMLElement>('[data-action-id]')).find(item => item.dataset.actionId === id);
        if (card?.isConnected) card.focus();
        else if (openerRef.current?.isConnected) openerRef.current.focus();
      }
    });
  }
  function startEditing() {
    if (!dashboard || busy || !canRevise) return;
    const next: RevisionDraft = draft?.actionId === action!.id ? draft : { actionId: action!.id, title: dashboard.title, description: dashboard.description, widgetMode: 'unchanged', removed: [], order: dashboard.widgets.map((_, index) => index) };
    setDraft(next);
    writeRevisionMemory(action!, next, attemptRef.current);
    setEditingId(action!.id);
    setCancelPromptId(null);
    requestAnimationFrame(() => { editorHeadingRef.current?.focus(); editorHeadingRef.current?.scrollIntoView({ block: 'nearest' }); });
  }
  function updateDraft(update: Partial<RevisionDraft>) {
    if (busy || mutationUncertain) return;
    const next = draft ? { ...draft, ...update } : null;
    setDraft(next);
    if (action) writeRevisionMemory(action, next, attemptRef.current);
    setError(null);
  }
  async function requestPreview() {
    if (!action || !changed || !validDraft || !canRevise || busy || submittingRef.current) return;
    const fingerprint = JSON.stringify(patch);
    if (attemptRef.current?.actionId !== action.id || attemptRef.current.fingerprint !== fingerprint) attemptRef.current = { actionId: action.id, fingerprint, requestKey: crypto.randomUUID() };
    if (!writeRevisionMemory(action, draft, attemptRef.current)) { setError({ actionId: action.id, text: 'บันทึกฉบับร่างในแท็บไม่ได้ จึงยังไม่ส่งคำขอ กรุณาตรวจการตั้งค่าเบราว์เซอร์' }); return; }
    submittingRef.current = true;
    setError(null);
    try { await onRevise(action, { requestKey: attemptRef.current.requestKey, patch }); }
    catch (failure) { setError({ actionId: action.id, text: failure instanceof Error ? failure.message : 'ปรับข้อเสนอไม่สำเร็จ กรุณาลองอีกครั้ง' }); }
    finally { submittingRef.current = false; }
  }
  async function cancelProposal() {
    if (!action || !canRevise || busy || submittingRef.current || mutationUncertain === 'revise') return;
    submittingRef.current = true;
    setError(null);
    try { await onCancelAction(action); setCancelPromptId(null); }
    catch (failure) { setError({ actionId: action.id, text: failure instanceof Error ? failure.message : 'ยังยืนยันผลการยกเลิกไม่ได้ กรุณาตรวจสถานะ' }); }
    finally { submittingRef.current = false; }
  }
  return <dialog ref={dialogRef} className={`action-dialog ${styles.dialog}`} aria-labelledby="approval-title" data-review-action-id={action.id} onCancel={event => { event.preventDefault(); closeReview(); }} onClick={event => { if (event.target === dialogRef.current) closeReview(); }}>
    <div className="dialog-header"><div><h2 id="approval-title" ref={headingRef} tabIndex={-1}>{lifecycle.predecessorActionId ? 'ตรวจข้อเสนอฉบับใหม่' : 'ตรวจสอบก่อนยืนยัน'}: {actionName(action.payload.kind)}</h2><p>{dashboard ? 'ตรวจขอบเขตข้อมูลและมุมมองด้านล่าง แล้วกดสร้าง Dashboard เมื่อพร้อม — จะยังไม่มีอะไรถูกสร้างจนกว่าคุณจะยืนยัน' : 'ตรวจรายการและขอบเขตก่อนยืนยันดำเนินการ'}</p></div><button className="icon-button" type="button" aria-label="ปิดหน้าต่าง" onClick={closeReview}><Icon name="close" /></button></div>
    <div className="dialog-body">
      {action.payload.kind === 'badge_revoke' ? <BadgeCurrentReview action={action} review={badgeReview} status={badgeReviewStatus} busy={busy} onRefresh={() => onRefreshBadge?.()} /> : <ActionSummary action={action} profiles={profiles} />}
      <div className="action-details"><span>สถานะ {mutationBusy === 'revise' ? 'กำลังตรวจคำขอแก้ไข' : mutationBusy === 'cancel' ? 'กำลังยกเลิกข้อเสนอ' : mutationUncertain ? 'ยังไม่ทราบผลคำขอเดิม' : actionState(action, currentTime).label}</span><span>เตรียม {formatTime(action.createdAt)}</span>{pending && !isExpired && <span>ใช้ยืนยันได้ถึง {formatTime(action.expiresAt)}</span>}</div>
      {mutationUncertain && <div role="status"><p>ยังไม่ทราบผลคำขอเดิม จึงพักการยืนยันไว้ {mutationUncertain === 'revise' ? 'ลองขอตัวอย่างเดิมอีกครั้งหรือโหลดสถานะก่อนดำเนินการต่อ' : 'ลองยกเลิกข้อเสนอเดิมอีกครั้งหรือโหลดสถานะก่อนดำเนินการต่อ'}</p><button className="btn btn-small" type="button" disabled={busy} onClick={() => void onRefresh()}>ตรวจผลคำขอเดิม</button></div>}
      {dashboard && pending && !canRevise && !busy && <p>ยังแก้ไขหรือยกเลิกข้อเสนอนี้ไม่ได้ กรุณาตรวจสถานะคำขอปัจจุบัน</p>}
      {dashboard && !editing && pending && <div className={styles.tools}><button className="btn" type="button" disabled={!canRevise || busy || Boolean(mutationUncertain)} ref={editButtonRef} onClick={startEditing}>แก้ไขข้อเสนอ</button></div>}
      {editing && draft && dashboard && <section className={styles.editor} aria-labelledby="revision-title"><h3 id="revision-title" ref={editorHeadingRef} tabIndex={-1}>ปรับข้อเสนอ</h3><p>ข้อเสนอเดิมยังไม่เปลี่ยนจนกว่าระบบจะตรวจและบันทึกฉบับใหม่สำเร็จ</p><fieldset className={styles.fields} disabled={busy || Boolean(mutationUncertain) || !canRevise}>
        <div className="form-field"><label htmlFor="revision-dashboard-title">ชื่อ Dashboard</label><input id="revision-dashboard-title" value={draft.title} maxLength={120} required aria-invalid={!draft.title.trim()} onChange={event => updateDraft({ title: event.target.value })} /><span className="form-hint">ไม่เกิน 120 ตัวอักษร</span></div>
        <div className="form-field"><label htmlFor="revision-dashboard-description">คำอธิบาย</label><textarea id="revision-dashboard-description" value={draft.description} maxLength={500} rows={3} onChange={event => updateDraft({ description: event.target.value })} /></div>
        <fieldset className={styles.widgetModes}><legend>ปรับมุมมอง</legend><p>เลือกปรับทีละแบบ การเปลี่ยนแบบจะเริ่มจากมุมมองของข้อเสนอเดิม</p>{([{ value: 'unchanged', label: 'คงมุมมองเดิม' }, { value: 'remove', label: 'เอามุมมองออก' }, { value: 'reorder', label: 'จัดลำดับมุมมอง' }] as const).map(option => <label key={option.value}><input type="radio" name="dashboard-widget-change" value={option.value} checked={draft.widgetMode === option.value} onChange={() => updateDraft({ widgetMode: option.value, removed: [], order: dashboard.widgets.map((_, index) => index) })} />{option.label}</label>)}</fieldset>
        {draft.widgetMode === 'remove' && <div className={styles.widgetList}>{dashboard.widgets.map((widget, index) => <label className={styles.removeRow} key={index}><input type="checkbox" checked={draft.removed.includes(index)} onChange={event => updateDraft({ removed: event.target.checked ? [...draft.removed, index] : draft.removed.filter(item => item !== index) })} /><span>เอา “{widget.title}” ออก</span></label>)}{draft.removed.length === dashboard.widgets.length && <p role="alert">ต้องเหลืออย่างน้อย 1 มุมมอง</p>}</div>}
        {draft.widgetMode === 'reorder' && <ol className={styles.widgetList}>{draft.order.map((originalIndex, position) => <li className={styles.widgetRow} key={originalIndex}><span>{position + 1}. {dashboard.widgets[originalIndex].title}</span><div><button className="btn btn-small" type="button" aria-label={`เลื่อน ${dashboard.widgets[originalIndex].title} ขึ้น`} disabled={position === 0} onClick={() => { const order = [...draft.order]; [order[position - 1], order[position]] = [order[position], order[position - 1]]; updateDraft({ order }); }}>ขึ้น</button><button className="btn btn-small" type="button" aria-label={`เลื่อน ${dashboard.widgets[originalIndex].title} ลง`} disabled={position === draft.order.length - 1} onClick={() => { const order = [...draft.order]; [order[position], order[position + 1]] = [order[position + 1], order[position]]; updateDraft({ order }); }}>ลง</button></div></li>)}</ol>}
      </fieldset><div className={styles.tools}><button className="btn btn-primary" type="button" disabled={!canRevise || busy || !changed || !validDraft} onClick={() => void requestPreview()}>{mutationBusy === 'revise' ? 'กำลังปรับข้อเสนอ…' : mutationUncertain ? 'ลองส่งคำขอเดิมอีกครั้ง' : 'ดูตัวอย่างฉบับปรับแก้'}</button><button className="btn" type="button" disabled={busy || Boolean(mutationUncertain)} onClick={() => { setEditingId(null); setDraft(null); setError(null); attemptRef.current = null; writeRevisionMemory(action, null, null); requestAnimationFrame(() => editButtonRef.current?.focus()); }}>เลิกแก้ไข</button></div>{changed && <p>ตรวจตัวอย่างใหม่ก่อนยืนยัน การยืนยันข้อเสนอเดิมถูกพักไว้ระหว่างแก้ไข</p>}</section>}
      {cancelPromptId === action.id && pending && <section className={styles.cancelPrompt} role="alert"><h3>ยกเลิกข้อเสนอนี้หรือไม่?</h3><p>การยกเลิกทำให้ยืนยันข้อเสนอนี้ต่อไม่ได้ ส่วนการปิดหน้าต่างอย่างเดียวจะไม่ยกเลิกข้อเสนอ</p><div className={styles.tools}><button className="btn" type="button" disabled={busy} onClick={() => setCancelPromptId(null)}>เก็บข้อเสนอไว้</button><button className="btn btn-danger" type="button" disabled={!canRevise || busy || mutationUncertain === 'revise'} onClick={() => void cancelProposal()}>ยืนยันยกเลิกข้อเสนอ</button></div></section>}
      {error?.actionId === action.id && <div className="error-banner" role="alert" ref={errorRef}>{error.text}</div>}
      {isExpired && <div className="warning-banner"><p>รายการนี้หมดอายุแล้ว — พิมพ์ขอให้เตรียมใหม่ในแชตเพื่อใช้ข้อมูลล่าสุด</p></div>}
      {!canConfirm && pending && !dashboard && action.payload.kind !== 'badge_revoke' && !busy && !isExpired && !mutationUncertain && <p>สิทธิ์หรือสถานะปัจจุบันยังไม่อนุญาตให้ยืนยันรายการนี้</p>}
      {confirmError && <div className="error-banner" role="alert">{confirmError}</div>}
      <details className="exact-parameters"><summary>รายละเอียดทางเทคนิค</summary><pre className="json-preview">{JSON.stringify({ id: action.id, predecessorActionId: lifecycle.predecessorActionId, supersededByActionId: lifecycle.supersededByActionId, staleReason: lifecycle.staleReason, payload: action.payload, evidenceVersion: action.evidenceVersion, payloadHash: action.payloadHash, mode: action.mode, modeRevision: action.modeRevision }, null, 2)}</pre></details>
    </div>
    <div className="dialog-footer"><button className="btn" type="button" disabled={busy && !pending} onClick={() => { if (pending && canRevise && !busy && mutationUncertain !== 'revise') setCancelPromptId(action.id); else closeReview(); }}>{pending ? (canRevise && !busy && mutationUncertain !== 'revise' ? 'ยกเลิกข้อเสนอ' : 'ปิดหน้าต่าง') : 'ปิด'}</button><button className="btn btn-primary" type="button" disabled={!allowed} onClick={() => onConfirm(action)}>{confirmBusy ? 'กำลังยืนยัน…' : <><Icon name="check" size={15} /> {confirmLabel(action.payload.kind)}</>}</button></div>
  </dialog>;
}
