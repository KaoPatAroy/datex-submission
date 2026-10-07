import type { Actor, Analysis, SourceRef } from '../../contracts';
import type { DirectorRead, DirectorWorkflowPort, ReviewedQueueView } from '../ports/director-workflow';
import type { TurnStep } from '../turn-plan';
import type { PersistFn } from './shared';

/**
 * HR Director read step: one registered Workflow V2 read (projected for this actor) executed through the trusted V2 read path.
 * Every number and name in the answer comes from that V2 result; the immutable reviewed snapshot id is kept as a citable source
 * and (for a new queue) recorded beside the turn so a later turn can approve exactly that reviewed queue.
 */
export const WORKFLOW_SNAPSHOT_TOOL = 'router.workflow_snapshot' as const;
export const WORKFLOW_SNAPSHOT_STATUS = 'workflow_snapshot' as const;
export const WORKFLOW_READ_PERMISSION = 'hr.onboarding.director_read';
export interface WorkflowSnapshotLink {
  id: string; name: typeof WORKFLOW_SNAPSHOT_TOOL; status: typeof WORKFLOW_SNAPSHOT_STATUS; actorId: string; sessionId: string;
  conversationId: string; turnId: string; snapshotId: string; createdAt: string;
}
export const workflowSnapshotLinkId = (snapshotId: string): string => `wf-snapshot:${snapshotId}`;

export interface WorkflowReadInput {
  port: DirectorWorkflowPort | undefined; actor: Actor; step: Extract<TurnStep, { kind: 'workflow_read' }>;
  conversationId: string; turnId: string; now: () => Date;
}
export type WorkflowReadResult =
  | { outcome: 'accepted'; text: string; sources: SourceRef[]; analysis: Analysis; requiredPermissions: string[]; persist?: PersistFn }
  | { outcome: 'denied'; code: string; text: string };

const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  identity_document: 'เอกสารยืนยันตัวตน', signed_offer: 'Offer ที่ลงนามแล้ว', signed_contract: 'สัญญาจ้างที่ลงนามแล้ว',
};
const REQUIRED_DOCUMENTS = 3;
const TEXT = {
  unavailable: 'บัญชีนี้ยังใช้คิวอนุมัติ onboarding ไม่ได้ในตอนนี้ จึงยังไม่ได้แสดงข้อมูล',
  stale: 'คิวที่ตรวจไว้เปลี่ยนไปแล้วหรือหมดอายุ จึงไม่ได้แสดงข้อมูลเดิม — ขอดูคิวรออนุมัติใหม่อีกครั้งได้เลย',
  failed: 'อ่านคิวอนุมัติ onboarding ไม่สำเร็จ ยังไม่มีการเปลี่ยนแปลงใด ๆ — ลองใหม่อีกครั้ง',
} as const;

/** Bangkok wall-clock time of an instant (HH:MM). */
export function bangkokTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export const documentLabel = (type: string): string => DOCUMENT_LABELS[type] ?? type;
const docsLine = (documents: readonly string[]) => documents.length >= REQUIRED_DOCUMENTS ? `เอกสารครบ ${documents.length}/${REQUIRED_DOCUMENTS}` : `เอกสาร ${documents.length}/${REQUIRED_DOCUMENTS}`;
const sourceId = (snapshotId: string) => `workflow:review_snapshot:${snapshotId}`;

function queueText(queue: ReviewedQueueView, sorted: boolean): string {
  if (!queue.requests.length) return 'ตอนนี้ไม่มีคำขอ Onboarding ที่รอคุณอนุมัติในขั้นผู้อำนวยการ';
  // A fresh page that has more behind it (or continues an earlier one) never claims a total: the count is that reviewed page only.
  const head = sorted
    ? `คำขอ Onboarding ในคิวที่ตรวจแล้ว เรียงตามวันเริ่มงาน (${queue.requests.length} รายการ):`
    : queue.hasMore || queue.continued
      ? `คำขอ Onboarding ที่รอคุณอนุมัติในขั้นผู้อำนวยการ — ${queue.continued ? 'หน้าถัดไป' : 'หน้าแรก'} ${queue.requests.length} รายการ (ตรวจคิวเมื่อ ${bangkokTime(queue.createdAt)} น.):`
      : `คำขอ Onboarding ที่รอคุณอนุมัติในขั้นผู้อำนวยการ มี ${queue.requests.length} รายการ (ตรวจคิวเมื่อ ${bangkokTime(queue.createdAt)} น.):`;
  const lines = queue.requests.map((request, index) => `${index + 1}. ${request.employeeName} — เริ่มงาน ${request.startDate} — ${docsLine(request.documents)}`);
  const more = queue.hasMore && !sorted ? ['ยังมีรายการรออนุมัติอยู่อีกนอกหน้านี้ — ขอดูหน้าถัดไปได้ (จำนวนข้างต้นเป็นเฉพาะหน้านี้ ไม่ใช่ยอดรวม)'] : [];
  return [head, ...lines, ...more, `คิวที่ตรวจแล้วนี้ใช้อนุมัติได้ถึง ${bangkokTime(queue.expiresAt)} น. — การอนุมัติจะอ้างอิงเฉพาะรายการในคิวนี้ ไม่รวมรายการที่เข้ามาภายหลัง`].join('\n');
}

function render(read: DirectorRead, nowIso: string): { text: string; snapshotId?: string; observedAt: string; facts: string[] } {
  switch (read.readId) {
    case 'director_queue': return { text: queueText(read.queue, false), snapshotId: read.queue.snapshotId, observedAt: read.queue.createdAt,
      facts: [read.queue.hasMore || read.queue.continued ? `คำขอ Onboarding รออนุมัติในหน้านี้ ${read.queue.requests.length} รายการ (ไม่ใช่ยอดรวม)` : `คำขอ Onboarding รออนุมัติ ${read.queue.requests.length} รายการ`] };
    case 'director_start_dates': return { text: queueText(read.queue, true), snapshotId: read.queue.snapshotId, observedAt: read.queue.createdAt,
      facts: read.queue.requests.map(request => `${request.employeeName} เริ่มงาน ${request.startDate}`) };
    case 'director_request_documents': {
      const docs = read.request.documents.map(documentLabel);
      return { text: [`เอกสารของคำขอ Onboarding ของ ${read.request.employeeName} (เริ่มงาน ${read.request.startDate}) — ${docsLine(read.request.documents)}:`,
        ...docs.map(doc => `• ${doc} — ตรวจรับแล้ว`)].join('\n'), snapshotId: read.snapshotId, observedAt: nowIso,
      facts: [`${read.request.employeeName}: ${docsLine(read.request.documents)}`] };
    }
    case 'director_approvals_today': return {
      text: read.items.length ? [read.hasMore ? `วันนี้คุณอนุมัติคำขอ Onboarding แล้วมากกว่า ${read.items.length} รายการ — แสดง ${read.items.length} รายการที่ระบบอ่านได้ ไม่ใช่ยอดรวม (ตรวจจากบันทึกที่ยืนยันแล้ว):`
        : `วันนี้คุณอนุมัติคำขอ Onboarding แล้ว ${read.items.length} รายการ (ตรวจจากบันทึกที่ยืนยันแล้ว):`,
        ...read.items.map((item, index) => `${index + 1}. ${item.employeeName} — เริ่มงาน ${item.startDate} — อนุมัติเมื่อ ${bangkokTime(item.approvedAt)} น.`)].join('\n')
        : 'วันนี้ยังไม่มีคำขอ Onboarding ที่คุณอนุมัติ', observedAt: read.asOf,
      facts: [read.hasMore ? `อนุมัติวันนี้อย่างน้อย ${read.items.length} รายการ (แสดงบางส่วน ไม่ใช่ยอดรวม)` : `อนุมัติวันนี้ ${read.items.length} รายการ`] };
  }
}

export async function executeWorkflowReadStep(input: WorkflowReadInput): Promise<WorkflowReadResult> {
  if (!input.port) return { outcome: 'denied', code: 'workflow_unavailable', text: TEXT.unavailable };
  const capabilities = await input.port.capabilities(input.actor);
  if (!capabilities.reads.includes(input.step.readId)) return { outcome: 'denied', code: 'permission_denied', text: TEXT.unavailable };
  const result = await input.port.read(input.actor, { readId: input.step.readId, ...(input.step.snapshotId ? { snapshotId: input.step.snapshotId } : {}),
    ...(input.step.requestId ? { requestId: input.step.requestId } : {}) });
  if (!result.ok) {
    const stale = ['queue_stale', 'WORKFLOW_NOT_FOUND', 'snapshot_required', 'request_required'].includes(result.code);
    const denied = /PERMISSION|ROLE|SCOPE|AUTHORITY|AUTHENTICATION/.test(result.code);
    return { outcome: 'denied', code: result.code, text: stale ? TEXT.stale : denied ? TEXT.unavailable : TEXT.failed };
  }
  const retrievedAt = input.now().toISOString();
  const rendered = render(result.read, retrievedAt);
  const id = rendered.snapshotId ? sourceId(rendered.snapshotId) : `workflow:director_approvals:${retrievedAt.slice(0, 10)}`;
  const sources: SourceRef[] = [{ id, system: 'workflow', observedAt: rendered.observedAt < retrievedAt ? rendered.observedAt : retrievedAt, retrievedAt,
    freshness: 'fresh', detail: rendered.snapshotId ? 'รายการคำขอ Onboarding ที่ตรวจสอบแล้ว' : 'บันทึกการอนุมัติที่ตรวจสอบแล้ว' }];
  const analysis: Analysis = { facts: rendered.facts.slice(0, 20).map(text => ({ text, sourceIds: [id] })), relationships: [], hypotheses: [], missingEvidence: [],
    generatedAt: retrievedAt, evidenceVersion: id };
  const queue = result.read.readId === 'director_queue' ? result.read.queue : undefined;
  // A NEW reviewed queue is linked to this turn inside the final turn transaction (a failed turn links nothing).
  const persist: PersistFn | undefined = queue && queue.requests.length ? async (tx, finalActor, conversationId) => {
    const link: WorkflowSnapshotLink = { id: workflowSnapshotLinkId(queue.snapshotId), name: WORKFLOW_SNAPSHOT_TOOL, status: WORKFLOW_SNAPSHOT_STATUS,
      actorId: finalActor.id, sessionId: finalActor.sessionId, conversationId, turnId: input.turnId, snapshotId: queue.snapshotId, createdAt: retrievedAt };
    await tx.put('tool_executions', link);
  } : undefined;
  return { outcome: 'accepted', text: rendered.text, sources, analysis, requiredPermissions: [WORKFLOW_READ_PERMISSION], ...(persist ? { persist } : {}) };
}

/** Reviewed-queue links of this actor + session + conversation, newest first (the planner may cite only these, and only while V2 validates them). */
export async function listSnapshotLinks(store: { list<T>(table: 'tool_executions', filters?: Record<string, string>): Promise<T[]> }, actor: Actor, conversationId: string): Promise<WorkflowSnapshotLink[]> {
  return (await store.list<WorkflowSnapshotLink>('tool_executions', { actorId: actor.id, status: WORKFLOW_SNAPSHOT_STATUS }))
    .filter(row => row.name === WORKFLOW_SNAPSHOT_TOOL && row.actorId === actor.id && row.sessionId === actor.sessionId && row.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
