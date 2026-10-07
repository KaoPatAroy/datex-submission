'use client';

import { useEffect, useState } from 'react';
import { parseRouterReceiptPage, type RouterReceiptItem, type RouterReceiptPage } from '@/lib/dashboards/workspace-client-state';
import styles from './router-panels.module.css';

export type ReceiptItem = RouterReceiptItem;
type Page = RouterReceiptPage;
type Load = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Page);

function parse(value: unknown): Page | null {
  return parseRouterReceiptPage(value);
}
/** Older receipts stored raw ISO timestamps as field values; show them as Thai date-time. Other values are shown as stored. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const displayFieldValue = (value: string) => ISO_TIMESTAMP.test(value) ? formatTime(value) || value : value;
const formatTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); };

/** One persisted, verified receipt (inert text only). Shows exactly who the effect reached and what was delivered. */
export function ReceiptCard({ item }: { item: ReceiptItem }) {
  const { receipt } = item;
  return <article className={styles.receiptCard} data-router-receipt={item.id} data-receipt-kind={receipt.kind} aria-label={`ผลการดำเนินการ: ${receipt.title}`}>
    <div className={styles.cardHead}><strong>{receipt.title}</strong><span className={styles.pillOk}>ตรวจผลแล้ว</span></div>
    <p className={styles.preview}>{receipt.headline}</p>
    {receipt.artifact && <p className={styles.receiptLine}>ผลลัพธ์: {receipt.artifact.title} · ฉบับที่ {receipt.artifact.revision}</p>}
    {receipt.recipients && receipt.recipients.length > 0 && <p className={styles.receiptLine} data-receipt-recipients>{receipt.kind === 'monitor'
      // Older Monitor receipts listed alert recipients as delivered; installing a Monitor sends nothing, so say so.
      ? `ผู้รับเมื่อพบเงื่อนไข: ${receipt.recipients.map(r => r.name).join(', ')} · ยังไม่มีการส่งแจ้งเตือน`
      : `ส่งถึงแล้ว ${receipt.recipients.length} ราย: ${receipt.recipients.map(r => r.name).join(', ')}`}</p>}
    {receipt.fields && receipt.fields.length > 0 && <dl className={styles.details}>{receipt.fields.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{displayFieldValue(f.value)}</dd></div>)}</dl>}
    {receipt.lines?.map(line => <p key={line} className={styles.receiptLine}>{line}</p>)}
    {receipt.content && <details><summary>ดูข้อความที่ส่ง</summary><p className={styles.receiptContent}>{receipt.content}</p></details>}
    <div className={styles.cardFoot}><span>ตรวจผลเมื่อ {formatTime(receipt.verifiedAt)}</span></div>
  </article>;
}

/** The sender's receipts of confirmed effects (message sent, artifact shared, monitor installed, work item created ...), newest page first with a way to older ones. */
export default function RouterReceipts() {
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/router-proposals/receipts', { cache: 'no-store', signal: controller.signal });
        const page = response.ok ? parse(await response.json()) : null;
        if (!controller.signal.aborted) setState(page ? { status: 'ready', ...page } : { status: 'error' });
      } catch { if (!controller.signal.aborted) setState({ status: 'error' }); }
    })();
    return () => controller.abort();
  }, [attempt]);
  if (state.status === 'loading') return <p className={styles.preview} role="status">กำลังโหลดผลการดำเนินการ…</p>;
  if (state.status === 'error') return <div className="error-banner" role="alert">โหลดผลการดำเนินการไม่สำเร็จ <button type="button" className="btn btn-small" onClick={() => { setState({ status: 'loading' }); setAttempt(n => n + 1); }}>ลองอีกครั้ง</button></div>;
  if (!state.items.length) return <p className={styles.preview} data-router-receipts-empty>ยังไม่มีผลการดำเนินการ เมื่อคุณยืนยันรายการและระบบตรวจสอบผลแล้ว บันทึกจะแสดงที่นี่</p>;
  const loadMore = async () => {
    if (!state.nextCursor) return;
    setMore('loading');
    try {
      const response = await fetch(`/api/router-proposals/receipts?cursor=${encodeURIComponent(state.nextCursor)}`, { cache: 'no-store' });
      const page = response.ok ? parse(await response.json()) : null;
      if (!page) { setMore('error'); return; }
      setState(current => current.status === 'ready'
        ? { status: 'ready', items: [...current.items, ...page.items.filter(item => !current.items.some(known => known.id === item.id))], total: page.total, nextCursor: page.nextCursor } : current);
      setMore('idle');
    } catch { setMore('error'); }
  };
  return <section aria-label="ผลการดำเนินการที่ตรวจสอบแล้ว" data-router-receipts>
    <p className={styles.receiptLine} data-router-receipts-count>แสดง {state.items.length} จาก {state.total} ผลการดำเนินการ</p>
    <div className={styles.list}>{state.items.map(item => <ReceiptCard key={item.id} item={item} />)}</div>
    {state.nextCursor && <button type="button" className="btn btn-small" data-router-receipts-more disabled={more === 'loading'} onClick={() => void loadMore()}>{more === 'loading' ? 'กำลังโหลด…' : 'โหลดผลการดำเนินการที่เก่ากว่า'}</button>}
    {more === 'error' && <p className="error-banner" role="alert">โหลดผลการดำเนินการที่เก่ากว่าไม่สำเร็จ โปรดลองอีกครั้ง</p>}
  </section>;
}
