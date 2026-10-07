'use client';

import { useState } from 'react';
import type { ActionKind, Workspace } from '@/lib/contracts';
import { Icon } from '@/components/icons';
import styles from './workspace.module.css';

/** Mirrors the agreed server catalog. Missing data offers no speculative actions. */
export type CatalogEntry = { id: string; section: 'ask_analyze' | 'prepare_review'; title: string; description: string; prompt: string; consequence: 'read' | 'analyze' | 'review_required'; actionKind?: ActionKind };
export type CatalogSelection = { message: string; catalogEntryId: string };
export function catalogSelection(entry: Pick<CatalogEntry, 'id' | 'prompt'>): CatalogSelection {
  return { message: entry.prompt, catalogEntryId: entry.id };
}
export type CatalogStatus = 'ready' | 'limited' | 'no_authorized_flows' | 'no_current_targets' | 'data_unavailable';
export type CatalogViewStatus = CatalogStatus | 'not_ready';
type CatalogWorkspace = Workspace & { actionCatalog?: CatalogEntry[]; actionCatalogStatus?: CatalogStatus };
const availability: Record<CatalogViewStatus, { message: string; retry: boolean }> = {
  not_ready: { message: 'รายการงานยังไม่พร้อม กรุณาโหลดสถานะอีกครั้งเพื่อดูคำถามและข้อเสนอที่เลือกได้', retry: true },
  data_unavailable: { message: 'ข้อมูลสำหรับรายการงานไม่พร้อมใช้งานชั่วคราว กรุณาลองโหลดอีกครั้ง', retry: true },
  no_authorized_flows: { message: 'โปรไฟล์นี้ยังไม่มีรายการงานที่ได้รับอนุญาต', retry: false },
  no_current_targets: { message: 'ยังไม่มีข้อมูลหรือรายการเป้าหมายที่ตรงเงื่อนไขของงานในขณะนี้', retry: true },
  limited: { message: 'รายการงานบางส่วนยังไม่พร้อม', retry: true },
  ready: { message: 'ยังไม่มีรายการงานให้เลือกในขณะนี้', retry: false },
};
export function workspaceCatalogStatus(workspace: Workspace): CatalogViewStatus {
  const { actionCatalog, actionCatalogStatus: status } = workspace as CatalogWorkspace;
  if (!status || !Object.hasOwn(availability, status) || status === 'ready' && !Array.isArray(actionCatalog) || status === 'limited' && !Array.isArray(actionCatalog)) return 'not_ready';
  return status;
}
export function catalogStatusMessage(status: CatalogViewStatus) { return availability[status].message; }
export function catalogStatusRetryable(status: CatalogViewStatus) { return availability[status].retry; }
export function workspaceCatalog(workspace: Workspace): CatalogEntry[] {
  const status = workspaceCatalogStatus(workspace);
  const catalog = (workspace as CatalogWorkspace).actionCatalog;
  return (status === 'ready' || status === 'limited') && Array.isArray(catalog) ? catalog : [];
}
export function workspaceCatalogReady(workspace: Workspace) {
  const status = workspaceCatalogStatus(workspace);
  return status === 'ready' || status === 'limited';
}
const labels = { read: 'อ่านข้อมูล', analyze: 'วิเคราะห์', review_required: 'ต้องตรวจและยืนยัน' };
/** Starters per catalog section on the first (empty-chat) screen. */
export const FEATURED_PER_SECTION = 2;

export default function WorkCatalog({ entries, onSelect, status, onRetry, disabled = false, featured = false }: { entries: CatalogEntry[]; status: CatalogViewStatus; onRetry?: () => Promise<unknown>; onSelect: (entry: CatalogEntry) => void; disabled?: boolean; featured?: boolean }) {
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  }
  const limitedMessage = entries.some(entry => entry.actionKind === 'badge_revoke') ? 'แสดงการค้นหาข้อมูลพนักงานและข้อเสนอเพิกถอนบัตรที่พร้อมใช้ งานฝ่ายบุคคลอื่นยังไม่พร้อมในรายการนี้' : catalogStatusMessage(status);
  const notice = <div role="status" className={status === 'limited' ? 'banner-actions' : undefined} data-catalog-status={status}><p className={styles.catalogEmpty}>{status === 'limited' ? limitedMessage : catalogStatusMessage(status)}</p>{onRetry && catalogStatusRetryable(status) && <button className="btn btn-small" type="button" disabled={retrying} aria-busy={retrying} onClick={() => void retry()}>{retrying ? 'กำลังโหลดรายการงาน…' : 'โหลดรายการงานอีกครั้ง'}</button>}</div>;
  if (status !== 'ready' && status !== 'limited' || !entries.length) return notice;
  return <div className={`${styles.workCatalog} ${featured ? styles.featuredCatalog : ''}`} data-catalog-status={status}>{status === 'limited' && notice}{(['ask_analyze', 'prepare_review'] as const).map(section => {
    const available = entries.filter(entry => entry.section === section);
    if (!available.length) return null;
    // First screen: two starters per section from the actor's own catalog (e.g. East: sales overview + gap, dashboard + ticket).
    const visible = featured ? available.slice(0, FEATURED_PER_SECTION) : available;
    return <section className={styles.catalogGroup} key={section} aria-label={section === 'ask_analyze' ? 'ถามและวิเคราะห์' : 'สร้างและจัดการงาน'}><h2>{section === 'ask_analyze' ? 'ถามและวิเคราะห์' : 'สร้างและจัดการงาน'}</h2>{!featured && <p>{section === 'ask_analyze' ? 'ค้นข้อมูลและทำความเข้าใจ โดยไม่สร้างรายการรอยืนยัน' : 'รายการที่เปลี่ยนข้อมูลจะแจ้งให้ตรวจและยืนยันตามประเภทงาน'}</p>}<div className={styles.catalogGrid}>{visible.map(entry => <button key={entry.id} type="button" className={styles.catalogChoice} data-catalog-id={entry.id} data-consequence={entry.consequence} disabled={disabled} onClick={() => onSelect(entry)}><strong>{entry.title}</strong>{!featured && <span className={styles.catalogDescription}>{entry.description}</span>}<span className={styles.catalogChoiceFooter}><small>{entry.actionKind === 'dashboard_create' ? 'สร้าง Dashboard ส่วนตัว' : labels[entry.consequence]}</small><span><Icon name="plus" size={14} />{entry.actionKind === 'dashboard_create' ? 'เริ่มสร้าง Dashboard' : 'เติมคำถาม'}</span></span></button>)}</div></section>;
  })}</div>;
}
