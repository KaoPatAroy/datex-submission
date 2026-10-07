'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { TurnArtifact, TurnChoice } from '@/lib/contracts';
import { Icon } from '@/components/icons';
import styles from './router-panels.module.css';
import {
  proposalDetailRows, stagedActionTitle, stagedConfirmLabel,
  type ArtifactOperation, type ProposalConfirmResult, type RouterProposalView,
} from './router-ui';

const formatTime = (value: number) => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** Compact card for a staged proposal, shown in the chat message and in Tasks/Approvals. */
export function StagedProposalCard({ proposal, onReview, disabled }: { proposal: RouterProposalView; onReview: (proposal: RouterProposalView) => void; disabled?: boolean }) {
  return <section className={styles.card} data-staged-proposal-id={proposal.id} aria-label={`รอยืนยัน: ${stagedActionTitle[proposal.actionId]}`}>
    <div className={styles.cardHead}><strong>{stagedActionTitle[proposal.actionId]}</strong><span className={styles.pill}>รอยืนยัน</span></div>
    <p className={styles.preview}>{proposal.preview}</p>
    <div className={styles.cardFoot}><span>ใช้ยืนยันได้ถึง {formatTime(proposal.expiresAt)}</span>
      <button className="btn btn-small btn-primary" type="button" data-staged-review={proposal.id} disabled={disabled} onClick={() => onReview(proposal)}>{proposal.confirmable === false ? 'ตรวจรายการ' : 'ตรวจและยืนยัน'}</button></div>
  </section>;
}

/** Review dialog: the exact data the confirmation acts on, confirm/cancel, then the receipt. */
export function StagedProposalDialog({ proposal, busy, error, receipt, onConfirm, onCancel, onClose }: {
  proposal: RouterProposalView | null; busy: 'confirm' | 'cancel' | null; error?: string | null;
  receipt?: ProposalConfirmResult | { outcome: 'cancelled'; text: string } | null;
  onConfirm: (proposal: RouterProposalView) => void; onCancel: (proposal: RouterProposalView) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = proposal?.id;
  useEffect(() => {
    const dialog = ref.current;
    if (id && dialog && !dialog.open) dialog.showModal();
    if (!id && dialog?.open) dialog.close();
  }, [id]);
  useEffect(() => () => { if (ref.current?.open) ref.current.close(); }, []);
  if (!proposal) return null;
  const rows = proposalDetailRows(proposal);
  const done = Boolean(receipt);
  const succeeded = receipt?.outcome === 'executed';
  return <dialog ref={ref} className={`action-dialog ${styles.dialog}`} aria-labelledby="staged-title" data-staged-dialog={proposal.id} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-header"><div><h2 id="staged-title">ตรวจสอบก่อนยืนยัน: {stagedActionTitle[proposal.actionId]}</h2><p>ตรวจรายละเอียดและขอบเขตของรายการนี้</p></div><button className="icon-button" type="button" aria-label="ปิดหน้าต่าง" disabled={Boolean(busy)} onClick={onClose}><Icon name="close" /></button></div>
    <div className="dialog-body">
      <p className={styles.preview}>{proposal.preview}</p>
      {rows.length > 0 && <dl className={styles.details} aria-label="ข้อมูลที่จะดำเนินการ">{rows.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
      <div className="action-details"><span>เตรียม {formatTime(proposal.createdAt)}</span><span>ใช้ยืนยันได้ถึง {formatTime(proposal.expiresAt)}</span></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {receipt && <section className={succeeded ? styles.receiptOk : styles.receipt} role="status" aria-label="ผลการดำเนินการ"><strong>{succeeded ? 'ดำเนินการและตรวจผลแล้ว' : receipt.outcome === 'cancelled' ? 'ยกเลิกแล้ว' : receipt.outcome === 'denied' ? 'ไม่สามารถดำเนินการได้' : 'ยังยืนยันผลการดำเนินการไม่ได้'}</strong><p>{receipt.text}</p></section>}
    </div>
    <div className="dialog-footer">
      {done ? <button className="btn btn-primary" type="button" onClick={onClose}>ปิด</button> : <>
        <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => onCancel(proposal)}>{busy === 'cancel' ? 'กำลังยกเลิก…' : 'ยกเลิกรายการ'}</button>
        <button className="btn btn-primary" type="button" disabled={Boolean(busy) || proposal.confirmable === false} onClick={() => onConfirm(proposal)}>{busy === 'confirm' ? 'กำลังยืนยัน…' : <><Icon name="check" size={15} /> {stagedConfirmLabel[proposal.actionId]}</>}</button>
      </>}
    </div>
  </dialog>;
}

/** Tasks/Approvals section. Renders nothing when there are no proposals (store without router_proposals). */
export function StagedProposalList({ proposals, onReview, loadError, onRetry }: { proposals: readonly RouterProposalView[]; onReview: (proposal: RouterProposalView) => void; loadError?: string | null; onRetry?: () => void }) {
  const banner = loadError ? <div className="error-banner" role="alert" data-staged-load-error>{loadError}{onRetry && <> <button className="btn btn-small" type="button" onClick={onRetry}>ลองอีกครั้ง</button></>}</div> : null;
  if (!proposals.length) return banner;
  return <section aria-label="รายการรอยืนยันจากผู้ช่วย">{banner}<h2 className="queue-heading">รอตรวจและยืนยัน (ผู้ช่วย) · {proposals.length}</h2><div className={styles.list}>{proposals.map(item => <StagedProposalCard key={item.id} proposal={item} onReview={onReview} />)}</div></section>;
}

/** Clarification chips. A click sends the structured choice id, never text for parsing. */
export function ClarificationChips({ choices, disabled, onChoose }: { choices: readonly TurnChoice[]; disabled?: boolean; onChoose: (choice: TurnChoice) => void }) {
  if (!choices.length) return null;
  return <div className={styles.chips} role="group" aria-label="ตัวเลือกเพื่อตอบคำถามที่ผู้ช่วยถาม">{choices.map(choice =>
    <button key={choice.id} type="button" className={styles.chip} data-choice-id={choice.id} disabled={disabled} onClick={() => onChoose(choice)}>{choice.label}</button>)}</div>;
}

/** Save / export controls under an artifact preview. The server route decides whether a confirmation is required. */
export function ArtifactActions({ artifact, busy, notice, onAction }: {
  artifact: TurnArtifact; busy?: ArtifactOperation | null; notice?: { tone: 'ok' | 'error'; text: string } | null; onAction: (artifact: TurnArtifact, operation: ArtifactOperation) => void;
}): ReactNode {
  const canExport = artifact.kind === 'csv_export' || artifact.spec.csv !== null;
  return <div className={styles.artifactActions} data-artifact-actions={artifact.id}>
    <button className="btn btn-small" type="button" disabled={Boolean(busy)} onClick={() => onAction(artifact, 'save')}>{busy === 'save' ? 'กำลังบันทึก…' : 'บันทึกผลลัพธ์'}</button>
    {canExport && <button className="btn btn-small" type="button" disabled={Boolean(busy)} onClick={() => onAction(artifact, 'export')}>{busy === 'export' ? 'กำลังเตรียมไฟล์…' : 'ส่งออก CSV'}</button>}
    {notice && <span role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? styles.noticeError : styles.noticeOk}>{notice.text}</span>}
  </div>;
}
