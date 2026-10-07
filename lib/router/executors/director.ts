import type { Actor } from '../../contracts';
import type { ParamValue } from '../turn-plan';
import type { GroundedStep } from '../validate';
import type { DecisionReceipt, DirectorDecisionKind, DirectorWorkflowPort } from '../ports/director-workflow';
import type { ActionExecResult } from './action';
import type { EffectFence, StagedProposal } from './action-ports';
import { bangkokTime } from './workflow-read';

/**
 * HR Director actions over the Workflow V2 bridge (onboarding.director_approve / onboarding.return / onboarding.notify_email).
 * Prepare = server binding (exact V2 snapshot, request ids, row versions, Director identity) + a staged router proposal; no V2
 * pending action and no business write happens before the user confirms. Confirm = fresh re-binding, then the V2
 * prepare/confirm/execute/verify runtime, then an independent readback; the persisted receipt holds display data only.
 */
export const DIRECTOR_ACTION_IDS = ['onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email'] as const;
export type DirectorActionId = typeof DIRECTOR_ACTION_IDS[number];
export const isDirectorActionId = (id: string): id is DirectorActionId => (DIRECTOR_ACTION_IDS as readonly string[]).includes(id);

export interface DirectorPrepareHelpers {
  stage(canonical: unknown, preview: string, data: Record<string, unknown>, expiresAt: number): Promise<ActionExecResult>;
  fail(kind: 'denied' | 'failed', code: string, text: string): ActionExecResult;
  clarify(code: string, slot: string, text: string): ActionExecResult;
}
export interface DirectorPrepareInput {
  actor: Actor; step: GroundedStep; conversationId: string; now: () => Date;
  port: DirectorWorkflowPort | undefined;
  /** The actor's own staged proposal by id (verified approvals are completed onboarding.director_approve proposals). */
  proposal: (id: string) => Promise<StagedProposal | undefined>;
}

const STAGED_TTL_MS = 24 * 3_600_000;
const TEXT = {
  unavailable: 'บัญชีนี้ยังใช้การอนุมัติ onboarding ไม่ได้ในตอนนี้ จึงยังไม่ได้เตรียมรายการ',
  stale: 'คิวที่ตรวจไว้หรือรายการในคิวเปลี่ยนไปแล้ว (หรือหมดอายุ) จึงไม่ได้เตรียมรายการใดเลย — ขอดูคิวรออนุมัติใหม่ แล้วค่อยสั่งอีกครั้ง',
  notEligible: 'รายการที่เลือกไม่อยู่ในสถานะที่อนุมัติได้แล้ว (อาจอนุมัติไว้แล้วหรือกำลังดำเนินการ) จึงไม่ได้เตรียมรายการใดเลย',
  approvalChanged: 'ผลการอนุมัติที่อ้างอิงเปลี่ยนไปหรือยังตรวจยืนยันไม่ได้ จึงยังไม่ได้เตรียม Email',
  noRecipient: 'ไม่พบผู้รับ Email จำลองที่ยืนยันแล้วสำหรับรายการเหล่านี้ จึงยังไม่ได้เตรียม Email — ระบบไม่สร้างที่อยู่ผู้รับขึ้นเอง',
} as const;

const str = (value: ParamValue | undefined): string => (typeof value === 'string' ? value : '');
const strs = (value: ParamValue | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);
const PERMISSION_CODES = /PERMISSION|ROLE|SCOPE|AUTHORITY|AUTHENTICATION|not_permitted/;
const STALE_CODES = /STALE|queue_stale|binding_changed|NOT_FOUND|invalid_selection/;

function decisionFailureText(code: string, prepared: boolean): string {
  if (PERMISSION_CODES.test(code)) return prepared ? 'สิทธิ์หรือขอบเขตของคุณเปลี่ยนไปแล้ว จึงไม่ได้ดำเนินการรายการใดเลย — โปรดตรวจสิทธิ์แล้วขอใหม่' : TEXT.unavailable;
  if (code === 'NO_ELIGIBLE_TARGETS' || code === 'in_progress') return prepared ? 'รายการบางรายการไม่อยู่ในสถานะที่ดำเนินการได้แล้ว จึงไม่ได้ดำเนินการรายการใดเลย' : TEXT.notEligible;
  if (STALE_CODES.test(code)) return prepared ? 'คิวที่ตรวจไว้ เอกสาร หรือหลักฐานการอนุมัติของผู้จัดการเปลี่ยนไปก่อนยืนยัน จึงไม่ได้ดำเนินการรายการใดเลย (ไม่มีการอนุมัติบางส่วน) — ขอดูคิวใหม่แล้วสั่งอีกครั้ง' : TEXT.stale;
  return prepared ? 'ยังยืนยันผลการดำเนินการไม่ได้ กรุณาตรวจสถานะรายการก่อนส่งคำขอใหม่' : TEXT.stale;
}

/** Plain AI text for an Email: no control chars, links, markup or digits (numbers and names come from the server's verified section). */
export function isSafeEmailText(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>`{}]/u.test(value) && !/https?:|www\.|sig=|\/shared\//iu.test(value) && !/[0-9๐-๙]/u.test(value);
}
const TEMPLATE_SUBJECT = 'แจ้งผลการอนุมัติคำขอ Onboarding';
const TEMPLATE_BODY = 'ขอแจ้งว่าคำขอ Onboarding ตามรายการด้านล่างได้รับการอนุมัติในขั้นผู้อำนวยการ แล้ว และพร้อมให้ทีมที่เกี่ยวข้องดำเนินการขั้นถัดไป';

function requestLines(requests: readonly { employeeName: string; startDate: string }[]): string[] {
  return requests.map(request => `• ${request.employeeName} — เริ่มงาน ${request.startDate}`);
}

export async function prepareDirectorAction(input: DirectorPrepareInput, actionId: DirectorActionId, h: DirectorPrepareHelpers): Promise<ActionExecResult> {
  const { actor, step, port } = input;
  if (!port) return h.fail('denied', 'workflow_unavailable', TEXT.unavailable);
  const capabilities = await port.capabilities(actor);
  if (actionId === 'onboarding.notify_email') {
    if (!capabilities.decisions.includes('onboarding_director_approve')) return h.fail('denied', 'permission_denied', TEXT.unavailable);
    return prepareEmail(input, h);
  }
  const kind: DirectorDecisionKind = actionId === 'onboarding.director_approve' ? 'onboarding_director_approve' : 'onboarding_return';
  if (!capabilities.decisions.includes(kind)) return h.fail('denied', 'permission_denied', TEXT.unavailable);
  const queueId = str(step.params.queue?.value);
  const queue = await port.reviewedQueue(actor, queueId);
  if (!queue || !queue.requests.length) return h.fail('denied', 'queue_stale', TEXT.stale);
  const reviewedIds = queue.requests.map(request => request.requestId);
  const chosen = strs(step.params.requestIds?.value);
  let requestIds: string[];
  if (kind === 'onboarding_director_approve' && str(step.params.selection?.value) === 'all_reviewed') {
    // "Approve all I reviewed": exactly the stored snapshot's request ids, never a re-query (later arrivals are not in it).
    if (step.params.selection?.source !== 'user_quoted') {
      return h.clarify('selection_unconfirmed', 'selection', `ต้องการอนุมัติทุกรายการในคิวที่ตรวจแล้ว (${reviewedIds.length} รายการ) หรือเฉพาะบางรายการครับ`);
    }
    if (chosen.length && (chosen.length !== reviewedIds.length || chosen.some(id => !reviewedIds.includes(id)))) {
      return h.clarify('selection_conflict', 'requestIds', 'คำขอระบุทั้ง “ทุกรายการ” และบางรายการ — โปรดยืนยันว่าต้องการอนุมัติรายการใด');
    }
    requestIds = reviewedIds;
  } else {
    if (!chosen.length) return h.clarify('missing_requests', 'requestIds', 'ต้องการดำเนินการกับรายการใดในคิวที่ตรวจแล้วครับ');
    if (chosen.some(id => !reviewedIds.includes(id)) || new Set(chosen).size !== chosen.length) return h.clarify('unknown_context_id', 'requestIds', 'รายการที่เลือกไม่อยู่ในคิวที่ตรวจแล้วนี้ — โปรดเลือกจากคิวที่แสดงอยู่');
    requestIds = reviewedIds.filter(id => chosen.includes(id));
  }
  const reason = kind === 'onboarding_return' ? str(step.params.reason?.value) : undefined;
  const bound = await port.bindDecision(actor, { kind, snapshotId: queue.snapshotId, requestIds, ...(reason ? { reason } : {}) });
  if (!bound.ok) return h.fail('denied', bound.code, decisionFailureText(bound.code, false));
  const { binding } = bound;
  const approve = kind === 'onboarding_director_approve';
  const preview = [
    approve ? `อนุมัติคำขอ Onboarding ขั้นผู้อำนวยการ ${binding.requests.length} รายการ — จากคิวที่คุณตรวจเมื่อ ${bangkokTime(queue.createdAt)} น.`
      : `ส่งคำขอ Onboarding กลับไปแก้ไข ${binding.requests.length} รายการ — เหตุผล: “${reason}”`,
    ...requestLines(binding.requests),
    'ขอบเขต: เฉพาะรายการข้างต้นจากคิวที่ตรวจแล้ว ไม่รวมรายการที่เข้ามาภายหลัง',
    `ยืนยันได้ถึง ${bangkokTime(binding.expiresAt)} น. — ระบบตรวจสิทธิ์ สถานะ เอกสาร และหลักฐานการอนุมัติของผู้จัดการซ้ำก่อนดำเนินการ ถ้ามีรายการใดเปลี่ยนจะไม่ดำเนินการทั้งชุด`,
    approve ? 'การอนุมัติไม่ส่ง Email อัตโนมัติ' : 'ระบบจะล้างผลอนุมัติเดิมของรายการเหล่านี้ตามขั้นตอนอนุมัติ',
  ].join('\n');
  const expiresAt = Math.min(Date.parse(binding.expiresAt), input.now().getTime() + STAGED_TTL_MS);
  return h.stage({ kind, snapshotId: binding.snapshotId, requestIds, ...(reason ? { reason } : {}) }, preview,
    { params: { kind, snapshotId: binding.snapshotId, requestIds, requestLabels: binding.requests.map(r => `${r.employeeName} (เริ่มงาน ${r.startDate})`), ...(reason ? { reason } : {}) },
      bindingDigest: bound.bindingDigest }, expiresAt);
}

/** Seeded Workflow V2 profile anchors carry fixture names; show their Thai demo role instead (finite map, unknown names unchanged). */
const RECIPIENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'Demo East Onboarding Manager V2 Profile Anchor': 'ผู้จัดการ Onboarding ภาคตะวันออก (สาธิต)',
  'Demo East Operations Manager V2 Profile Anchor': 'ผู้จัดการปฏิบัติการภาคตะวันออก (สาธิต)',
  'Demo HR Operations V2 Profile Anchor': 'เจ้าหน้าที่ฝ่ายบุคคล (สาธิต)',
  'Demo Sales Operator V2 Profile Anchor': 'เจ้าหน้าที่ฝ่ายขาย (สาธิต)',
};
/** Receipt timestamps for readers: Bangkok date and time in Thai (e.g. "7 ต.ค. 2569 03:07 น."), never a raw ISO string. */
export function thaiDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ไม่ทราบเวลา';
  const day = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  return `${day} ${bangkokTime(iso)} น.`;
}
export function recipientDisplayName(name: string): string { return RECIPIENT_DISPLAY_NAMES[name] ?? name; }

interface ApprovalRecord { requestIds: string[]; executionIds: string[]; labels: string[] }
export function approvalRecordOf(proposal: StagedProposal | undefined, conversationId?: string): ApprovalRecord | undefined {
  if (!proposal || proposal.actionId !== 'onboarding.director_approve' || proposal.status !== 'completed') return undefined;
  if (conversationId !== undefined && proposal.conversationId !== conversationId) return undefined;
  const record = proposal.data.approval as Partial<ApprovalRecord> | undefined;
  if (!record || !Array.isArray(record.requestIds) || !Array.isArray(record.executionIds) || !record.requestIds.length || !record.executionIds.length) return undefined;
  return { requestIds: record.requestIds.map(String), executionIds: record.executionIds.map(String), labels: Array.isArray(record.labels) ? record.labels.map(String) : [] };
}

async function prepareEmail(input: DirectorPrepareInput, h: DirectorPrepareHelpers): Promise<ActionExecResult> {
  const { actor, step, port } = input;
  const approvalId = str(step.params.approval?.value);
  const record = approvalRecordOf(await input.proposal(approvalId), input.conversationId);
  if (!record || !port) return h.fail('denied', 'approval_unavailable', TEXT.approvalChanged);
  const aiSubject = str(step.params.subject?.value).trim(), aiBody = str(step.params.body?.value).trim();
  const templated = !isSafeEmailText(aiSubject) || !isSafeEmailText(aiBody);
  const subject = templated ? TEMPLATE_SUBJECT : aiSubject;
  // Probe binding first (verified approval readback + recipients) so the footer is built from the verified state only.
  const probe = await port.bindEmail(actor, { approvalId, requestIds: record.requestIds, executionIds: record.executionIds, subject, body: '-' });
  if (!probe.ok) return h.fail('denied', probe.code, probe.code === 'no_recipient' ? TEXT.noRecipient : TEXT.approvalChanged);
  const footer = ['รายการที่อนุมัติแล้ว (ตรวจสอบสถานะที่บันทึกไว้แล้ว):', ...requestLines(probe.binding.requests)].join('\n');
  const body = `${templated ? TEMPLATE_BODY : aiBody}\n\n${footer}`;
  const bound = await port.bindEmail(actor, { approvalId, requestIds: record.requestIds, executionIds: record.executionIds, subject, body });
  if (!bound.ok) return h.fail('denied', bound.code, bound.code === 'no_recipient' ? TEXT.noRecipient : TEXT.approvalChanged);
  // Simulated mailbox addresses are internal fixtures: the reader sees the recipient's display name only.
  const to = bound.binding.recipients.map(recipient => recipientDisplayName(recipient.name)).join(', ');
  const preview = [
    'Email จำลอง ยังไม่ได้ส่ง กรุณาตรวจรายละเอียดและยืนยัน',
    `ถึง: ${to}`,
    `หัวเรื่อง: ${subject}`,
    '—', body,
    ...(templated ? ['(ใช้ข้อความมาตรฐานของระบบ เพราะข้อความที่ร่างไม่ผ่านการตรวจความถูกต้องก่อนส่ง)'] : []),
  ].join('\n');
  return h.stage({ approvalId, recipients: bound.binding.recipients.map(r => r.identityId), subject, body }, preview,
    { params: { approvalId, requestIds: record.requestIds, executionIds: record.executionIds, subject, body, recipientLabels: bound.binding.recipients.map(r => recipientDisplayName(r.name)) },
      bindingDigest: bound.bindingDigest }, input.now().getTime() + STAGED_TTL_MS);
}

export type DirectorConfirmResult = { ok: true; text: string; data: Record<string, unknown> } | { ok: false; code: string; text: string; outcome: 'denied' | 'failed' };
export interface DirectorConfirmInput {
  port: DirectorWorkflowPort | undefined; actor: Actor; staged: StagedProposal; reclaimed: boolean; fence: EffectFence; now: () => Date;
  receipt: (kind: string, title: string, headline: string, extra: Record<string, unknown>) => unknown;
}

export async function confirmDirectorAction(input: DirectorConfirmInput): Promise<DirectorConfirmResult> {
  const { staged, port } = input;
  if (!port) return { ok: false, code: 'workflow_unavailable', text: 'ฟังก์ชันอนุมัติ onboarding ยังไม่เปิดใช้งาน จึงไม่ได้ดำเนินการ', outcome: 'denied' };
  const params = (staged.data.params ?? {}) as Record<string, unknown>;
  const bindingDigest = String(staged.data.bindingDigest ?? '');
  const requestIds = Array.isArray(params.requestIds) ? params.requestIds.map(String) : [];
  if (staged.actionId === 'onboarding.notify_email') {
    const executionIds = Array.isArray(params.executionIds) ? params.executionIds.map(String) : [];
    const result = await port.deliverEmail(input.actor, { approvalId: String(params.approvalId), requestIds, executionIds, subject: String(params.subject),
      body: String(params.body), bindingDigest, proposalId: staged.id, fence: input.fence });
    if (!result.ok) {
      const text = result.code === 'delivery_unverified' ? 'ยังยืนยันผลการส่ง Email จำลองไม่ได้ กรุณาตรวจสถานะคำขอเดิมก่อนส่งคำขอใหม่'
        : result.code === 'no_recipient' ? 'ผู้รับไม่อยู่ในสถานะที่รับ Email จำลองได้แล้ว จึงไม่ได้ส่ง'
          : 'ผลการอนุมัติหรือผู้รับเปลี่ยนไปก่อนยืนยัน จึงไม่ได้ส่ง Email — โปรดขอใหม่';
      return { ok: false, code: result.code, text, outcome: result.code === 'delivery_unverified' ? 'failed' : 'denied' };
    }
    const text = result.already ? `ส่ง Email จำลองฉบับนี้ไว้แล้ว ${result.delivered.length} ราย — ตรวจพบรายการเดิม ไม่ส่งซ้ำ`
      : `ส่ง Email จำลองแจ้งผลการอนุมัติถึงผู้รับ ${result.delivered.length} ราย และตรวจผลการส่งที่บันทึกแล้ว`;
    return { ok: true, text, data: { ...staged.data, receipt: input.receipt('onboarding_email', 'Email แจ้งผลการอนุมัติ', text, {
      recipients: result.delivered.map(item => ({ name: recipientDisplayName(item.name), status: 'delivered' as const })),
      fields: [{ label: 'ช่องทาง', value: 'Email จำลอง' }, { label: 'หัวเรื่อง', value: String(params.subject) },
        { label: 'สถานะ', value: 'ส่งแล้ว (ตรวจผลแล้ว)' }, { label: 'ส่งเมื่อ', value: thaiDateTime(result.deliveredAt) }],
      content: String(params.body), lines: ['ตรวจพบบันทึกการส่งถึงผู้รับแล้ว โดยไม่มีการส่ง Email ออกนอกระบบ'] }) } };
  }
  const kind: DirectorDecisionKind = staged.actionId === 'onboarding.director_approve' ? 'onboarding_director_approve' : 'onboarding_return';
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  const result = await port.executeDecision(input.actor, { kind, snapshotId: String(params.snapshotId), requestIds, ...(reason ? { reason } : {}),
    bindingDigest, proposalId: staged.id, reclaimed: input.reclaimed, fence: input.fence });
  if (!result.ok) return { ok: false, code: result.code, text: decisionFailureText(result.code, true), outcome: result.code === 'unverified' ? 'failed' : 'denied' };
  return decisionDone(input, kind, result.receipt);
}

function decisionDone(input: DirectorConfirmInput, kind: DirectorDecisionKind, receipt: DecisionReceipt): DirectorConfirmResult {
  const approve = kind === 'onboarding_director_approve', count = receipt.requests.length;
  const stateLabel = approve ? 'ผู้อำนวยการอนุมัติแล้ว' : 'ส่งกลับไปแก้ไขแล้ว';
  const text = receipt.already
    ? `รายการนี้${approve ? 'อนุมัติ' : 'ส่งกลับ'}ไว้แล้ว ${count} รายการ — ตรวจพบผลเดิม ไม่ดำเนินการซ้ำ`
    : approve ? `อนุมัติคำขอ Onboarding แล้ว ${count} รายการ และตรวจสอบสถานะที่บันทึกไว้แล้ว — ยังไม่ได้ส่ง Email หากต้องการแจ้งผล คุณสามารถขอส่ง Email จำลองได้`
      : `ส่งคำขอ Onboarding กลับไปแก้ไขแล้ว ${count} รายการ และตรวจสอบสถานะที่บันทึกไว้แล้ว`;
  const labels = receipt.requests.map(request => `${request.employeeName} (เริ่มงาน ${request.startDate})`);
  return { ok: true, text, data: { ...input.staged.data,
    ...(approve ? { approval: { requestIds: receipt.requests.map(request => request.requestId), executionIds: receipt.executionIds, labels } } : {}),
    receipt: input.receipt(approve ? 'onboarding_approval' : 'onboarding_return', approve ? 'อนุมัติคำขอ Onboarding' : 'ส่งคำขอ Onboarding กลับไปแก้ไข', text, {
      fields: [{ label: 'การดำเนินการ', value: approve ? 'อนุมัติขั้นผู้อำนวยการ' : 'ส่งกลับไปแก้ไข' }, { label: 'จำนวน', value: `${count} รายการ` },
        { label: 'สถานะที่ตรวจแล้ว', value: stateLabel }, { label: 'ตรวจผลเมื่อ', value: thaiDateTime(receipt.verifiedAt) }],
      lines: labels }) } };
}
