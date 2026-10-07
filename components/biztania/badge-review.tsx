'use client';

import type { BadgeReview, PendingAction } from '@/lib/contracts';
import { displaySyntheticNames } from './chat-thread';

export type BadgeReviewStatus = 'loading' | 'ready' | 'unavailable';

/** A current readback is useful only for this exact immutable proposal. */
export function badgeReviewIsCurrent(action: PendingAction, review?: BadgeReview) {
  if (action.payload.kind !== 'badge_revoke') return true;
  const prepared = action.approvalDisplay?.badge;
  const current = review?.current;
  return Boolean(prepared && review?.status === 'current' && review.payloadHash === action.payloadHash &&
    prepared.employeeId === action.payload.employeeId && prepared.badgeId === action.payload.badgeId &&
    typeof current?.employeeName === 'string' && current.employeeName.trim() && current.employeeName === prepared.employeeName &&
    current.badgeState === 'active' && current.badgeState === prepared.state &&
    current.badgeVersion === prepared.version && current.updatedAt === prepared.updatedAt &&
    Number.isFinite(Date.parse(review.checkedAt)));
}

export default function BadgeCurrentReview({ action, review, status, onRefresh, busy }: {
  action: PendingAction; review?: BadgeReview; status: BadgeReviewStatus; onRefresh: () => void; busy: boolean;
}) {
  if (action.payload.kind !== 'badge_revoke') return null;
  const payload = action.payload;
  const readable = status === 'ready' && review?.payloadHash === action.payloadHash ? review : undefined;
  const current = readable?.status === 'current' || readable?.status === 'stale' ? readable.current : undefined;
  const available = badgeReviewIsCurrent(action, readable);
  const time = (value: string) => new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  return <section aria-label="สถานะบัตรที่ตรวจล่าสุด" data-badge-review-status={status === 'loading' ? 'loading' : available ? 'current' : readable?.status === 'stale' ? 'stale' : 'unavailable'}>
    <h3>ตรวจสถานะบัตรก่อนยืนยัน</h3>
    <p>บัตรจำลองสำหรับสาธิต · ระบบตรวจสิทธิ์และสถานะอีกครั้งเมื่อยืนยัน</p>
    {status === 'loading' ? <p role="status">กำลังอ่านชื่อพนักงานและสถานะบัตรล่าสุด…</p> : !available && <div className="warning-banner" role="alert"><p>{readable?.status === 'stale' ? 'ข้อมูลพนักงานหรือบัตรเปลี่ยนจากข้อเสนอ จึงยังยืนยันไม่ได้ โปรดเตรียมข้อเสนอใหม่จากข้อมูลปัจจุบัน' : 'ยังอ่านสถานะล่าสุดที่ตรงกับข้อเสนอนี้ไม่ได้ จึงยังยืนยันไม่ได้ ลองตรวจสถานะอีกครั้ง'}</p></div>}
    <dl className="detail-grid">
      <div><dt>พนักงาน</dt><dd>{current ? displaySyntheticNames(current.employeeName) : 'ยังไม่มีชื่อที่ตรวจสอบล่าสุด'}<br /><span>{payload.employeeId}</span></dd></div>
      <div><dt>บัตรที่จะเพิกถอน</dt><dd>{payload.badgeId}</dd></div>
      <div><dt>สถานะบัตรที่ตรวจพบ</dt><dd>{current ? current.badgeState === 'active' ? 'ใช้งานอยู่' : 'เพิกถอนแล้ว' : 'ยังตรวจสอบไม่ได้'}</dd></div>
      <div><dt>รุ่นข้อมูลบัตร</dt><dd>{current ? current.badgeVersion : 'ยังตรวจสอบไม่ได้'}</dd></div>
      <div><dt>เหตุผลที่เสนอ</dt><dd>{payload.reason}</dd></div>
    </dl>
    {readable && Number.isFinite(Date.parse(readable.checkedAt)) && <p>ตรวจสถานะเมื่อ {time(readable.checkedAt)}</p>}
    <button className="btn" type="button" disabled={busy || status === 'loading'} onClick={onRefresh}>{status === 'loading' ? 'กำลังตรวจสถานะ…' : 'ตรวจสถานะบัตรอีกครั้ง'}</button>
  </section>;
}
