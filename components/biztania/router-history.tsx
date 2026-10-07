'use client';

import { useEffect, useState } from 'react';
import RouterReceipts from './router-receipts';
import { stagedActionTitle, type RouterProposalView } from './router-ui';
import styles from './router-panels.module.css';

interface ClosedItem { id: string; actionId: RouterProposalView['actionId']; outcome: 'cancelled' | 'expired' | 'not_completed'; closedAt: number; createdAt: number; preview: string | null }
interface Page { items: ClosedItem[]; total: number; nextCursor: string | null }
type Load = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Page);

const OUTCOME: Record<ClosedItem['outcome'], string> = { cancelled: 'ยกเลิกแล้ว', expired: 'หมดอายุ', not_completed: 'ไม่สำเร็จ' };
const OUTCOME_NOTE: Record<ClosedItem['outcome'], string> = {
  cancelled: 'คุณยกเลิกรายการนี้ ไม่มีการดำเนินการใด ๆ',
  expired: 'หมดเวลายืนยันก่อนที่จะมีการยืนยัน ไม่มีการดำเนินการใด ๆ',
  not_completed: 'การยืนยันไม่เสร็จสมบูรณ์ (เช่น การตรวจสอบไม่ผ่าน สิทธิ์เปลี่ยนไป หรือถูกแทนที่) — ตรวจสถานะล่าสุดจากหน้าที่เกี่ยวข้อง ถ้ายังต้องการให้ขอผู้ช่วยทำใหม่',
};
const formatTime = (value: number) => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

function parse(value: unknown): Page | null {
  const body = value as { proposals?: unknown; total?: unknown; nextCursor?: unknown } | null;
  if (!Array.isArray(body?.proposals)) return null;
  const items = body.proposals.filter((item): item is ClosedItem => !!item && typeof item === 'object' && typeof (item as ClosedItem).id === 'string'
    && typeof (item as ClosedItem).actionId === 'string' && ['cancelled', 'expired', 'not_completed'].includes((item as ClosedItem).outcome) && typeof (item as ClosedItem).closedAt === 'number');
  if (items.length !== body.proposals.length) return null;
  return { items, total: typeof body.total === 'number' ? body.total : items.length, nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null };
}

/** Proposals that ended without an effect: cancelled, expired or not completed. Read-only history (nothing here can be confirmed again). */
function ClosedProposals({ outcome }: { outcome?: ClosedItem['outcome'] }) {
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/router-proposals/closed${outcome ? `?outcome=${outcome}` : ''}`, { cache: 'no-store', signal: controller.signal });
        const page = response.ok ? parse(await response.json()) : null;
        if (!controller.signal.aborted) setState(page ? { status: 'ready', ...page } : { status: 'error' });
      } catch { if (!controller.signal.aborted) setState({ status: 'error' }); }
    })();
    return () => controller.abort();
  }, [attempt, outcome]);
  if (state.status === 'loading') return <p className={styles.preview} role="status">กำลังโหลดประวัติ…</p>;
  if (state.status === 'error') return <div className="error-banner" role="alert" data-closed-proposals-error>โหลดประวัติรายการที่ไม่ได้ดำเนินการไม่สำเร็จ <button type="button" className="btn btn-small" onClick={() => { setState({ status: 'loading' }); setAttempt(n => n + 1); }}>ลองอีกครั้ง</button></div>;
  if (!state.items.length) return <p className={styles.preview} data-closed-proposals-empty>ยังไม่มีรายการที่ยกเลิก หมดอายุ หรือไม่สำเร็จ</p>;
  const loadMore = async () => {
    if (!state.nextCursor) return;
    setMore('loading');
    try {
      const response = await fetch(`/api/router-proposals/closed?cursor=${encodeURIComponent(state.nextCursor)}${outcome ? `&outcome=${outcome}` : ''}`, { cache: 'no-store' });
      const page = response.ok ? parse(await response.json()) : null;
      if (!page) { setMore('error'); return; }
      setState(current => current.status === 'ready'
        ? { status: 'ready', items: [...current.items, ...page.items.filter(item => !current.items.some(known => known.id === item.id))], total: page.total, nextCursor: page.nextCursor } : current);
      setMore('idle');
    } catch { setMore('error'); }
  };
  return <section aria-label="รายการที่ยกเลิก หมดอายุ หรือไม่สำเร็จ" data-closed-proposals>
    <p className={styles.receiptLine} data-closed-proposals-count>แสดง {state.items.length} จาก {state.total} รายการ</p>
    <ul className={styles.list}>{state.items.map(item => <li key={item.id} className={styles.receiptCard} data-closed-proposal={item.id} data-closed-outcome={item.outcome}>
      <div className={styles.cardHead}><strong>{stagedActionTitle[item.actionId] ?? 'รายการ'}</strong><span className={styles.pill}>{OUTCOME[item.outcome]}</span></div>
      <p className={styles.preview}>{item.preview ?? 'ไม่แสดงรายละเอียด เพราะสิทธิ์หรือขอบเขตของคุณเปลี่ยนไปแล้ว'}</p>
      <p className={styles.receiptLine}>{OUTCOME_NOTE[item.outcome]}</p>
      <div className={styles.cardFoot}><span>เตรียมไว้ {formatTime(item.createdAt)} · {OUTCOME[item.outcome]}เมื่อ {formatTime(item.closedAt)}</span></div>
    </li>)}</ul>
    {state.nextCursor && <button type="button" className="btn btn-small" data-closed-proposals-more disabled={more === 'loading'} onClick={() => void loadMore()}>{more === 'loading' ? 'กำลังโหลด…' : 'โหลดรายการที่เก่ากว่า'}</button>}
    {more === 'error' && <p className="error-banner" role="alert">โหลดรายการที่เก่ากว่าไม่สำเร็จ โปรดลองอีกครั้ง</p>}
  </section>;
}

/** History additions for the assistant's staged work: verified results of confirmed effects (also reachable from Messages) and proposals that ended without an effect. */
export default function RouterHistory({ receipts = true, closed = true, closedOutcome }: { receipts?: boolean; closed?: boolean; closedOutcome?: ClosedItem['outcome'] } = {}) {
  if (!receipts && !closed) return null;
  return <section aria-label="ประวัติการดำเนินการจากผู้ช่วย" className={styles.historySections} data-router-history>
    {receipts && <><h2 className={styles.sectionHeading}>ผลการดำเนินการที่ตรวจผลแล้ว</h2>
    <RouterReceipts /></>}
    {closed && <><h2 className={styles.sectionHeading}>รายการที่ยกเลิก หมดอายุ หรือไม่สำเร็จ</h2>
    {/* Keyed by outcome: a filter change remounts the list in its loading state, so stale results never show under a new filter. */}
    <ClosedProposals key={closedOutcome ?? 'all'} outcome={closedOutcome} /></>}
  </section>;
}
