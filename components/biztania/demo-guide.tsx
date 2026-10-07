'use client';

import { useEffect, useRef } from 'react';
import type { Role } from '@/lib/contracts';
import { roleShowcase, type ShowcaseItem } from '@/lib/demo/showcase';
import styles from './demo-guide.module.css';

export const demoGuidelines = ['ข้อมูลตัวอย่างที่เตรียมไว้', 'คำถามอิสระต้องใช้ Live AI', 'รายการที่เปลี่ยนข้อมูล: ตรวจรายละเอียด → ยืนยัน → ตรวจผลการดำเนินการ'] as const;

export function ShowcaseCards({ role, disabled, onTry }: { role: Role; disabled: boolean; onTry: (item: ShowcaseItem) => void }) {
  return <div className={styles.cards} aria-label="ชุดสาธิตของบัญชีนี้">{roleShowcase(role).map(item => <article className={styles.card} key={item.id} data-showcase-id={item.id}>
    <h3>{item.title}</h3><span className={styles.kind}><span className="sr-only">ประเภท: </span>{({ answer: 'ตอบ', action: 'เตรียมงาน', denial: 'ปฏิเสธ', scenario: 'สถานการณ์' })[item.kind]}</span><p>{item.description}</p>
    <button className="btn btn-small" type="button" data-showcase-id={item.id} disabled={disabled} aria-label={`ลองเลย: ${item.title}`} onClick={() => onTry(item)}>ลองเลย</button>
  </article>)}</div>;
}

export function ShowcaseChips({ role, disabled, onSelect }: { role: Role; disabled: boolean; onSelect: (item: ShowcaseItem) => void }) {
  return <div className={styles.chips} aria-label="คำถามในชุดสาธิต">{roleShowcase(role).map(item => <button className="btn btn-small" type="button" key={item.id} data-showcase-id={item.id} disabled={disabled} onClick={() => onSelect(item)}>{item.title}</button>)}</div>;
}

export default function DemoGuide({ role, disabled, recoveryPending, onTry, onClose, onLive }: { role: Role; disabled: boolean; recoveryPending: boolean; onTry: (item: ShowcaseItem) => void; onClose: () => void; onLive: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return <section className={styles.guide} aria-labelledby="demo-guide-title" data-demo-guide>
    <header><h2 ref={headingRef} id="demo-guide-title" tabIndex={-1}>โหมดสาธิต: สิ่งที่ระบบทำได้</h2><button className="btn btn-small" type="button" aria-label="ปิดคู่มือโหมดสาธิต" onClick={onClose}>ปิดคู่มือ</button></header>
    <ul>{demoGuidelines.map(guideline => <li key={guideline}>{guideline}</li>)}</ul>
    {recoveryPending && <p role="status">ตรวจสถานะคำขอเดิมก่อน แล้วเริ่มคำถามใหม่เพื่อเลือกชุดสาธิต โดยไม่ส่งข้อความที่ล้มเหลวซ้ำ</p>}
    <ShowcaseCards role={role} disabled={disabled} onTry={onTry} />
    <button className={`text-button ${styles.liveLink}`} type="button" disabled={disabled} onClick={onLive}>ใช้ Live AI เพื่อถามคำถามของคุณ</button>
  </section>;
}
