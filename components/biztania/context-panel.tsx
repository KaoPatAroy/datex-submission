'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PendingAction, ReceiptView, SourceRef, Workspace } from '@/lib/contracts';
import ActionSummary from '@/components/action-summary';
import { Icon } from '@/components/icons';
import { evidenceWarningText, freshnessText, sourceDisplayName } from '@/lib/presentation/source-names';
import { limitRetailClaims, usableBranchSource } from '@/lib/packs/retail/coverage';
import { displaySyntheticNames, sourceDisplayDetail, type LocalMessage, type TurnRecovery } from './chat-thread';
import { actionName, actionState, conciseTitle, scopeName } from './product-labels';
import styles from './workspace.module.css';

export type DetailSelection = { kind: 'message' | 'action' | 'receipt'; id: string };
const time = (value: string) => new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const freshness = freshnessText;
const receiptLabels = { verified_success: 'สำเร็จแล้ว', pending: 'รอตรวจผล', failed: 'ไม่สำเร็จ', denied: 'ไม่อนุญาต' };

function SourceGroups({ sources, message }: { sources: SourceRef[]; message: LocalMessage }) {
  const evidence = message.evidence;
  const systems = [...new Set(sources.map(source => source.system))];
  return <div className={styles.sourceGroups}>{systems.map(system => {
    const rows = sources.filter(source => source.system === system);
    const linked = evidence?.branches.filter(branch => usableBranchSource(evidence, branch, system));
    const valid = linked?.length ?? rows.filter(source => source.freshness !== 'missing' && source.freshness !== 'misaligned').length;
    const count = evidence ? `${valid}/${evidence.branches.length} สาขา` : `${rows.length} รายการ`;
    const limited = rows.some(source => source.freshness !== 'fresh') || Boolean(evidence && valid < evidence.branches.length);
    return <details key={system} className={styles.sourceGroup}><summary><strong>{sourceDisplayName(system)}</strong><span>{count} · {limited ? 'มีข้อจำกัด' : 'อยู่ในช่วงเวลาที่กำหนด'}</span></summary>{rows.map((source, index) => <details id={`source-${encodeURIComponent(source.id)}`} key={source.id} className={styles.sourceRow}><summary>{sourceDisplayName(system)} · รายการ {index + 1} · {freshness[source.freshness]}</summary><p>{sourceDisplayDetail(source)}</p><p>ข้อมูล ณ {time(source.observedAt)}<br />ดึงข้อมูล {time(source.retrievedAt)}</p><details><summary>รายละเอียดทางเทคนิค</summary><code>{source.id}</code></details></details>)}</details>;
  })}</div>;
}

function DetailClaims({ label, claims, sources }: { label: string; claims: NonNullable<LocalMessage['analysis']>['facts']; sources: SourceRef[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? claims : claims.slice(0, 3);
  return <details className={styles.detailClaims}><summary>{label} · {claims.length}</summary>{visible.map((claim, index) => <div key={index} data-detail-claim><p>{displaySyntheticNames(claim.text)}</p><small>อ้างอิง: {[...new Set(claim.sourceIds.map(id => sources.find(source => source.id === id)?.system).filter((system): system is string => Boolean(system)))].map(sourceDisplayName).join(' · ') || 'ยังไม่มีแหล่งข้อมูลที่อ่านได้'}</small></div>)}{claims.length > 3 && <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'แสดงน้อยลง' : `ดูทั้งหมด ${claims.length} ข้อ`}</button>}</details>;
}

function MessageDetail({ message, recovery }: { message: LocalMessage; recovery: TurnRecovery | null }) {
  const evidence = message.evidence;
  const rawAnalysis = message.responseAnalysis ?? message.analysis;
  const analysis = evidence && rawAnalysis ? limitRetailClaims(evidence, rawAnalysis) : rawAnalysis;
  const sources = evidence?.sources ?? message.sources ?? [];
  if (message.delivery) {
    const recovering = recovery && (recovery.turnId === message.turnId || recovery.requestKey === message.requestKey);
    return <><h3>คำตอบที่ยังไม่สมบูรณ์</h3><p>{message.delivery === 'stopped' ? 'หยุดการตอบแล้ว' : message.delivery === 'rejected' ? 'คำขอถูกปฏิเสธก่อนรับผล' : message.delivery === 'streaming' || message.delivery === 'waiting' ? 'กำลังรับคำตอบ' : 'การเชื่อมต่อถูกขัดจังหวะ'}</p><dl className={styles.detailFacts}><div><dt>ผลที่ยืนยันได้</dt><dd>ยังไม่มีผลสำเร็จที่ยืนยันได้จากคำตอบนี้</dd></div><div><dt>รายการที่เตรียม</dt><dd>ตรวจสถานะคำขอเดิมก่อนสรุปว่ามีรายการเกิดขึ้นหรือไม่</dd></div>{recovering && <div><dt>ผลตรวจสถานะล่าสุด</dt><dd>{recovery.statusChecked ? recovery.recoveryStatus === 'failed' ? 'คำขอเดิมไม่สำเร็จ' : recovery.recoveryStatus === 'in_progress' ? 'ยังดำเนินการอยู่' : 'ยังตรวจผลไม่ได้' : 'ยังไม่ได้ตรวจสถานะ'}<br />{recovery.errorMessage}</dd></div>}</dl><p>ใช้ “ตรวจสถานะคำขอเดิม” ในบทสนทนาเพื่ออ่านผลก่อนเริ่มใหม่</p><details><summary>รายละเอียดทางเทคนิค</summary><code>{message.turnId ?? 'ยังไม่มีรหัสคำขอ'}</code><p>{message.progress}</p></details></>;
  }
  if (message.clarification) return <><h3>ประเภทคำตอบ: ขอข้อมูลเพิ่มเติม</h3><p>ข้อมูลที่ยังต้องการ</p><div className={styles.detailText}>{displaySyntheticNames(message.text)}</div><p>ตอบคำถามในบทสนทนาเพื่อให้ผู้ช่วยตรวจข้อมูลต่อ</p></>;
  return <>
    <h3>{evidence ? 'ขอบเขตและเวลาของข้อมูล' : sources.length ? 'ข้อมูลประกอบคำตอบ' : 'ข้อความจากผู้ช่วย'}</h3>
    {evidence ? <p>{scopeName(evidence.scope)}<br />ข้อมูล ณ {time(evidence.asOf)}</p> : <p>{sources.length ? 'แหล่งข้อมูลที่แนบมากับคำตอบนี้' : 'คำตอบนี้ไม่มีหลักฐานแนบมา จึงไม่แสดงหลักฐานจากคำตอบอื่น'}</p>}
    {!sources.length && <div className={styles.detailText}>{displaySyntheticNames(message.text)}</div>}
    {sources.length > 0 && <section><h3>ความครอบคลุมของแหล่งข้อมูล</h3><SourceGroups sources={sources} message={message} /></section>}
    {((analysis?.missingEvidence.length ?? 0) > 0 || (evidence?.warnings.length ?? 0) > 0) && <section className={styles.sourceLimits}><h3>ข้อจำกัดของหลักฐาน</h3><p>มีประเด็นที่ยังยืนยันสาเหตุไม่ได้ โปรดตรวจข้อจำกัดก่อนนำข้อสรุปไปใช้</p><details><summary>ดูหลักฐานที่ยังขาด · {(analysis?.missingEvidence.length ?? 0) + (evidence?.warnings.length ?? 0)} รายการ</summary><ul>{analysis?.missingEvidence.map((claim, i) => <li key={`claim-${i}`}>{displaySyntheticNames(claim.text)}</li>)}{evidence?.warnings.map((warning, i) => <li key={`warning-${i}`}>{displaySyntheticNames(evidenceWarningText(warning))}</li>)}</ul></details></section>}
    {analysis && <section><h3>ทบทวนข้อสรุป</h3>{[{ label: 'ข้อเท็จจริง', claims: analysis.facts }, { label: 'ความเชื่อมโยง', claims: analysis.relationships }, { label: 'ข้อสันนิษฐาน', claims: analysis.hypotheses }].filter(group => group.claims.length).map(group => <DetailClaims key={group.label} label={group.label} claims={group.claims} sources={sources} />)}</section>}
    <details><summary>รายละเอียดทางเทคนิค</summary><dl><dt>รหัสคำตอบ</dt><dd>{message.id}</dd><dt>รหัสคำขอ</dt><dd>{message.turnId ?? 'ไม่มีข้อมูล'}</dd>{evidence && <><dt>รุ่นหลักฐาน</dt><dd>{evidence.version}</dd></>}</dl></details>
  </>;
}

export default function ContextPanel({ selection, message, action, receipt, recovery, profiles, now, confirmable, sourceTarget, conversationTitle, onClose, children }: { selection: DetailSelection; message?: LocalMessage; action?: PendingAction; receipt?: ReceiptView; recovery: TurnRecovery | null; profiles: Workspace['profiles']; now: number; confirmable: boolean; sourceTarget?: string | null; conversationTitle?: string; onClose: () => void; children?: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const change = () => setMobile(media.matches);
    change(); media.addEventListener('change', change);
    return () => { media.removeEventListener('change', change); if (triggerRef.current?.isConnected) triggerRef.current.focus(); };
  }, []);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !bodyRef.current?.contains(active)) triggerRef.current = active;
  }, [selection.kind, selection.id]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (mobile && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [mobile]);
  useEffect(() => {
    if (!sourceTarget) return;
    const target = document.getElementById(sourceTarget);
    if (!target || !bodyRef.current?.contains(target)) return;
    let node: HTMLElement | null = target;
    while (node && node !== bodyRef.current) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement; }
    target.scrollIntoView({ block: 'nearest' });
    target.querySelector('summary')?.focus();
  }, [sourceTarget, selection.id, mobile]);
  const title = message ? `${message.clarification ? 'ขอข้อมูลเพิ่มเติม' : message.delivery ? 'คำตอบไม่สมบูรณ์' : 'คำตอบที่เลือก'} · ${time(message.createdAt)}` : action ? actionName(action.payload.kind) : receipt ? 'ผลการดำเนินการที่เลือก' : 'รายการที่เลือก';
  const contents = <><header className={styles.drawerHead}><div><h2 id="workspace-details-title">{title}</h2>{message && <p className={styles.detailSubtitle}>{conversationTitle || conciseTitle(message.text)}</p>}</div><button className="icon-button" type="button" aria-label="ปิดรายละเอียด" onClick={onClose}><Icon name="close" /></button></header><div className={styles.drawerBody} ref={bodyRef}>
    {message ? <MessageDetail key={message.id} message={message} recovery={recovery} /> : action ? <><p><span className={`badge ${actionState(action, now).tone}`}>{actionState(action, now).label}</span></p><ActionSummary action={action} profiles={profiles} /><dl className={styles.detailFacts}><div><dt>เตรียมเมื่อ</dt><dd>{time(action.createdAt)}</dd></div><div><dt>หมดอายุ</dt><dd>{time(action.expiresAt)}</dd></div><div><dt>การยืนยัน</dt><dd>{confirmable ? 'ตรวจรายการนี้และยืนยันได้' : 'ยังยืนยันรายการนี้ไม่ได้ ตรวจสถานะหรือเตรียมข้อเสนอใหม่'}</dd></div><div><dt>หลักฐานประกอบ</dt><dd>{action.evidenceVersion ? 'รายการนี้ผูกกับหลักฐานที่ใช้เตรียมข้อเสนอ' : 'รายการนี้ไม่มีหลักฐานการวิเคราะห์แนบ'}</dd></div></dl>{children}<details><summary>รายละเอียดทางเทคนิค</summary><pre>{JSON.stringify({ id: action.id, turnId: action.turnId, payload: action.payload, evidenceVersion: action.evidenceVersion }, null, 2)}</pre></details></> : receipt ? <><h3>{receipt.visibility === 'restricted' ? 'จำกัดสิทธิ์อ่านผล' : actionName(receipt.kind)}</h3><p>{receiptLabels[receipt.status]}</p><p>บันทึก {time(receipt.createdAt)}{receipt.verifiedAt && <><br />ตรวจผล {time(receipt.verifiedAt)}</>}</p>{receipt.visibility === 'restricted' ? <p>โปรไฟล์นี้ไม่มีสิทธิ์อ่านรายละเอียดผลเดิม</p> : <p>{receipt.results.length} เป้าหมาย · สำเร็จ {receipt.results.filter(result => result.status === 'verified_success').length} · รอตรวจ {receipt.results.filter(result => result.status === 'pending').length} · ไม่สำเร็จหรือไม่อนุญาต {receipt.results.filter(result => result.status === 'failed' || result.status === 'denied').length}</p>}<details><summary>รายละเอียดทางเทคนิค</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details></> : <p>รายการที่เลือกไม่อยู่ในข้อมูลปัจจุบัน กรุณาเลือกรายการอีกครั้ง</p>}
  </div></>;
  return mobile ? <dialog ref={dialogRef} className={`${styles.contextDialog} ${styles.selectedDetail}`} aria-labelledby="workspace-details-title" onCancel={event => { event.preventDefault(); onClose(); }}>{contents}</dialog> : <aside className={styles.detailPanel} aria-labelledby="workspace-details-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>{contents}</aside>;
}
