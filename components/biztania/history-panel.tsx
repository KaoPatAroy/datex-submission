'use client';

import { useState, type ReactNode } from 'react';
import type { AuditEvent, PendingAction, ReceiptView } from '@/lib/contracts';
import { actionName, actionState, regionName } from './product-labels';
import styles from './workspace.module.css';

export type Filter = 'all' | 'pending' | 'success' | 'failed' | 'expired' | 'read';
const filterNames: Record<Filter, string> = { all: 'ทั้งหมด', pending: 'รอยืนยัน', success: 'สำเร็จ', failed: 'ล้มเหลว', expired: 'หมดอายุ', read: 'อ่านข้อมูล' };
const dayKey = (value: string) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const time = (date: string) => new Date(date).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const operationCategories = new Set(['update', 'create', 'delete', 'revoke', 'export', 'monitor_manage']);
const monitorOperationNames: Record<string, string> = { 'monitor.rename': 'เปลี่ยนชื่อ Monitor', 'monitor.pause': 'หยุด Monitor ชั่วคราว', 'monitor.resume': 'เปิด Monitor อีกครั้ง', 'monitor.delete': 'ลบ Monitor' };
export function isStandaloneHistoryEvent(event: AuditEvent) {
  return !event.actionId && !operationCategories.has(event.category) && event.category !== 'prepare';
}

/** Which assistant-history sections a filter shows: verified results are successes; closed proposals are failed/expired outcomes. */
export type ClosedOutcome = 'cancelled' | 'expired' | 'not_completed';
export function routerSectionsFor(filter: Filter): { receipts: boolean; closed: boolean; closedOutcome?: ClosedOutcome } {
  // The failed / expired filters narrow the closed-proposal list to that outcome; 'all' keeps every closed outcome (incl. cancelled).
  const closedOutcome: ClosedOutcome | undefined = filter === 'failed' ? 'not_completed' : filter === 'expired' ? 'expired' : undefined;
  return { receipts: filter === 'all' || filter === 'success', closed: filter === 'all' || filter === 'failed' || filter === 'expired', ...(closedOutcome ? { closedOutcome } : {}) };
}
/** The empty-filter note appears only when the selected filter shows nothing at all (legacy records AND assistant sections). */
export function showEmptyFilterNote(filter: Filter, legacyCount: number, hasRouterHistory: boolean): boolean {
  if (legacyCount > 0) return false;
  if (!hasRouterHistory) return true;
  const sections = routerSectionsFor(filter);
  return !sections.receipts && !sections.closed;
}

export default function HistoryPanel({ actions, receipts, audit, actorName, now, onAction, renderReceipt, routerHistory }: { actions: PendingAction[]; receipts: ReceiptView[]; audit: AuditEvent[]; actorName: string; now: number; onAction: (action: PendingAction) => void; renderReceipt: (receipt: ReceiptView) => ReactNode; routerHistory?: (sections: { receipts: boolean; closed: boolean; closedOutcome?: ClosedOutcome }) => ReactNode }) {
  const [filter, setFilter] = useState<Filter>('all');
  const ids = [...new Set([...actions.map(action => action.id), ...receipts.map(receipt => receipt.actionId), ...audit.flatMap(event => event.actionId ? [event.actionId] : [])])];
  const groups = ids.map(id => {
    const action = actions.find(item => item.id === id);
    const receipt = receipts.find(item => item.actionId === id);
    const events = audit.filter(event => event.actionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const state = action ? actionState(action, now) : undefined;
    const category: Filter = receipt?.status === 'verified_success' ? 'success' : receipt?.status === 'failed' || receipt?.status === 'denied' ? 'failed' : state?.key === 'expired' ? 'expired' : state?.key === 'pending' && !receipt ? 'pending' : 'all';
    const date = receipt?.verifiedAt ?? receipt?.createdAt ?? events.at(-1)?.createdAt ?? action?.createdAt ?? '';
    return { id, action, receipt, events, state, category, date };
  // Audit-only ids (assistant proposals) have no request or receipt here; their verified result / closed outcome is shown once, in the assistant sections below.
  }).filter(group => group.action || group.receipt);
  // Resource operations have no legacy request/receipt. Keep each durable event visible without inferring a verified outcome.
  const requestIds = new Set([...actions.map(action => action.id), ...receipts.map(receipt => receipt.actionId)]);
  const operations = audit.filter(event => operationCategories.has(event.category) && (!event.actionId || !requestIds.has(event.actionId)));
  const visibleOperations = filter === 'all' ? operations.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const unlinked = audit.filter(isStandaloneHistoryEvent);
  const days = [...new Set(unlinked.map(event => dayKey(event.createdAt)))];
  const visible = groups.filter(group => filter === 'all' || group.category === filter).sort((a, b) => b.date.localeCompare(a.date));
  const daily = days.map(day => ({ day, events: unlinked.filter(event => dayKey(event.createdAt) === day).filter(event => filter === 'all' || filter === 'read' && event.category === 'read' || filter === 'failed' && ['error', 'denied'].includes(event.category)) })).filter(group => group.events.length).sort((a, b) => b.day.localeCompare(a.day));
  return <><div className={styles.historyFilters} role="group" aria-label="กรองประวัติ">{(Object.keys(filterNames) as Filter[]).map(key => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{filterNames[key]}</button>)}</div><div className={styles.historyList}>
    {visible.map(group => <article key={group.id} className={styles.historyRecord} data-history-action={group.id}><header><h2>{group.action ? actionName(group.action.payload.kind) : group.receipt?.visibility !== 'restricted' && group.receipt?.kind ? actionName(group.receipt.kind) : 'รายการดำเนินการ'}</h2><span className="badge badge-muted">{group.category === 'all' ? group.receipt?.status === 'pending' ? 'รอตรวจผล' : group.state?.label ?? 'บันทึกแล้ว' : filterNames[group.category]}</span></header><p>{actorName}</p><dl className={styles.historyDates}>{group.action && <div><dt>เตรียม</dt><dd>{time(group.action.createdAt)}</dd></div>}{group.events.find(event => event.category === 'confirm') && <div><dt>ยืนยัน</dt><dd>{time(group.events.find(event => event.category === 'confirm')!.createdAt)}</dd></div>}{group.receipt?.verifiedAt && <div><dt>ตรวจผล</dt><dd>{time(group.receipt.verifiedAt)}</dd></div>}</dl>{group.receipt ? renderReceipt(group.receipt) : group.action && <button className="btn btn-small" type="button" onClick={() => onAction(group.action!)}>รายละเอียดรายการ</button>}<details><summary>รายละเอียดทางเทคนิค · {group.events.length} เหตุการณ์</summary><p>{group.id}</p>{group.events.map(event => <div key={event.id}><strong>{event.category} · {time(event.createdAt)}</strong><p>{event.summary}</p>{event.region && <p>{regionName(event.region)}</p>}<code>{event.id}</code></div>)}</details></article>)}
    {daily.map(group => <article key={group.day} className={styles.historyRecord} data-history-daily={group.day}><header><h2>บันทึกการอ่านและตรวจคำขอ · {group.day}</h2><span>{group.events.length} เหตุการณ์</span></header><p>{actorName} · อ่านข้อมูล {group.events.filter(event => event.category === 'read').length} · ไม่สำเร็จหรือไม่อนุญาต {group.events.filter(event => ['error', 'denied'].includes(event.category)).length}</p><p className={styles.historyNote}>บันทึกชุดนี้ไม่มีข้อมูลผูกกับคำขอ จึงแสดงรวมตามวัน</p><details><summary>รายละเอียดทางเทคนิค</summary>{group.events.map(event => <div key={event.id}><strong>{time(event.createdAt)} · {event.category}</strong><p>{event.summary}</p><code>{event.id}</code></div>)}</details></article>)}
    {visibleOperations.map(event => <article key={event.id} className={styles.historyRecord} data-history-resource={event.actionId ?? event.id}>
      <header><h2>{event.category === 'monitor_manage' ? monitorOperationNames[event.summary] ?? 'จัดการ Monitor' : event.summary}</h2><span className="badge badge-muted">บันทึกการทำงาน</span></header>
      <p>{actorName} · {time(event.createdAt)}</p>
      {event.region && <p>{regionName(event.region)}</p>}
    </article>)}
    {showEmptyFilterNote(filter, visible.length + daily.length + visibleOperations.length, Boolean(routerHistory)) && <p className={styles.catalogEmpty}>ไม่มีรายการในตัวกรองนี้</p>}
  </div>{routerHistory?.(routerSectionsFor(filter))}</>;
}
