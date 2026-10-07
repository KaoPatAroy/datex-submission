import type { ActorActionDescriptor, PlannerContext } from '../planner-context';
import { ACTION_COPY, GENERIC_ACTION_CAPABILITY } from '../action-copy';
import type { GroundedStep } from '../validate';
import { isSafeClarificationText, isSafeConversationProse, modelTextSafe } from './safety';
import { dashboardChoiceLabels } from '../dashboard-target';
import { type ProductConceptId, accountCapability, accountConceptLines, productConceptText, productOverviewText } from '../product-model';

export interface ClarifyChoice { id: string; label: string }
export interface RenderedClarify { kind: 'clarify'; text: string; choices: ClarifyChoice[]; clarification: true; fromPlanner: boolean }
export interface RenderedConversation { kind: 'conversation'; text: string; topic: string; fromPlanner: boolean }
/** Typed planner failure consumed by the UI (shows the switch-to-demo hint). */
export interface PlannerFailureResult {
  kind: 'planner_failure'; reason: 'outage' | 'invalid_plan' | 'slow'; text: string; hint: 'switch_to_demo'; retryable: boolean;
}

const SLOT_LABELS: Readonly<Record<string, string>> = {
  recipientId: 'ผู้รับ', recipientIds: 'ผู้รับ', assigneeId: 'ผู้รับผิดชอบ', dueDate: 'วันครบกำหนด', dashboard: 'Dashboard', branchIds: 'สาขา', regionIds: 'ภูมิภาค', date: 'วันที่',
  title: 'ชื่อเรื่อง', measureIds: 'ตัวชี้วัด', reason: 'เหตุผล', badgeId: 'บัตร', employeeId: 'พนักงาน', threshold: 'เกณฑ์',
  pendingActionId: 'รายการที่รอยืนยัน', sourceStateId: 'Result ที่ต้องการใช้', artifactTypeId: 'รูปแบบ Result',
  queue: 'คิวที่ตรวจแล้ว', selection: 'รายการที่ต้องการอนุมัติ', requestIds: 'คำขอ Onboarding', approval: 'ผลการอนุมัติที่ต้องการแจ้ง',
  subject: 'หัวเรื่อง', body: 'ข้อความ', snapshotId: 'คิวที่ตรวจแล้ว', requestId: 'คำขอ Onboarding',
  content: 'คำตอบที่ต้องการส่ง', query: 'คำตอบที่ต้องการติดตาม', source: 'คำตอบที่ใช้สร้าง Dashboard', monitor: 'Monitor',
  operation: 'สิ่งที่ต้องการทำ', channelId: 'ช่องทาง', conditionId: 'เงื่อนไข', cadenceId: 'ความถี่', visualization: 'รูปแบบกราฟ',
  baseArtifactId: 'Result เดิม', visual: 'รูปแบบกราฟ', time: 'ช่วงเวลา', interpretation: 'รายละเอียดของคำถาม',
};
/** Thai name of a slot; never the raw slot path (internal names are not user text). */
export function slotLabel(slot: string): string {
  const name = slot.replace(/^params\./, '');
  return SLOT_LABELS[name] ?? (name.startsWith('filters') ? 'ขอบเขตข้อมูล' : name.startsWith('measures') ? 'ตัวชี้วัด'
    : name.startsWith('dimensions') ? 'มุมมองข้อมูล' : 'รายละเอียดที่ต้องการ');
}

/**
 * Server-owned next-step suggestions for a turn that ended without a usable result (refusal, unusable plan, a clarify with
 * nothing to pick). Derived only from the actor's authorized datasets and registered actions; plain Thai, no data.
 */
export function serverSuggestions(context: PlannerContext, max = 3): string[] {
  const out: string[] = [];
  const datasets = context.catalog.datasets;
  // Derived at request time from the actor's own catalog entries and the actions the actor holds (registered data only).
  for (const dataset of datasets) out.push(dataset.suggestions?.[0] ?? '');
  for (const action of context.actions) out.push(ACTION_COPY[action.actionId]?.suggestion ?? '');
  if (context.workflow?.reads.some(read => read.readId === 'director_queue')) out.push(DIRECTOR_QUEUE_SUGGESTION);
  for (const dataset of datasets) out.push(...(dataset.suggestions?.slice(1) ?? []));
  return [...new Set(out.filter(Boolean))].slice(0, max);
}

export function actionLabel(actionId: string): string | undefined { return ACTION_COPY[actionId]?.intent; }
/** HR Director read capability (Workflow V2 projection) as server-owned copy. */
export const DIRECTOR_QUEUE_SUGGESTION = 'มีคำขอ Onboarding ใดรอฉันอนุมัติบ้าง';
const DIRECTOR_READ_CAPABILITY = 'การดูคิวคำขอ Onboarding ที่รอคุณอนุมัติ วันเริ่มงาน และเอกสารประกอบ';

export interface RenderEnv {
  /** Labels the model must not cite in prose, beyond those derivable from the context. */
  extraEntityLabels?: readonly string[];
}

/** Entity labels/ids that ungrounded prose may not mention. Built from server context only. */
export function entityLabelsOf(context: PlannerContext, extra: readonly string[] = []): string[] {
  return [...new Set([
    // Region display names stay usable in prose (as before Thai display names existed); region ids, branch ids/names,
    // people, dashboards and dataset labels remain blocked.
    ...context.catalog.choices.flatMap(c => context.scope.regionIds.includes(c.id) ? [c.id] : [c.id, c.label]),
    ...context.scope.regionIds, ...context.scope.branchIds,
    ...context.recipients.map(r => r.name), ...context.dashboards.map(d => d.title),
    ...context.catalog.datasets.map(d => d.label), ...extra,
  ].map(s => s.trim()).filter(Boolean))];
}

function labelIndex(context: PlannerContext): Map<string, string> {
  const labels = new Map<string, string>();
  context.catalog.choices.forEach(c => labels.set(c.id, c.label));
  context.recipients.forEach(r => labels.set(r.id, r.name));
  dashboardChoiceLabels(context.dashboards).forEach((label, id) => labels.set(id, label));
  context.pendingActions.forEach(p => labels.set(p.id, p.title));
  context.artifacts.forEach(a => labels.set(a.id, a.title));
  (context.monitors ?? []).forEach(m => labels.set(m.id, m.title));
  context.acceptedStates.forEach(s => { if (s.label) labels.set(s.stateId, s.label); });
  context.workflow?.reviewedQueues.forEach(q => { labels.set(q.id, `คิวที่ตรวจแล้ว (${q.requests.length} รายการ)`); q.requests.forEach(r => labels.set(r.id, r.label)); });
  context.workflow?.verifiedApprovals.forEach(a => labels.set(a.id, a.label));
  return labels;
}

function thaiList(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} และ ${items[items.length - 1]}`;
}

/**
 * clarify: the AI-written question when it passes the output-safety gate, else a server template over slot labels.
 * Choices are server-validated (ids from context, labels replaced by server labels) and rendered as chips data.
 */
export function renderClarify(grounded: GroundedStep, context: PlannerContext, env: RenderEnv = {}): RenderedClarify {
  const step = grounded.step;
  if (step.kind !== 'clarify') throw new Error('renderClarify requires a clarify step');
  const labels = labelIndex(context);
  const choices: ClarifyChoice[] = [];
  for (const choice of step.choices) {
    const label = labels.get(choice.id);
    if (label !== undefined && !choices.some(c => c.id === choice.id)) choices.push({ id: choice.id, label });
  }
  const candidate = grounded.safeText ?? null;
  const safe = candidate !== null && isSafeClarificationText(
    candidate, choices.map(c => c.id), choices.map(c => c.label), entityLabelsOf(context, env.extraEntityLabels));
  if (safe) return { kind: 'clarify', text: candidate.trim(), choices, clarification: true, fromPlanner: true };
  const slots = [...new Set(step.missing.map(m => slotLabel(m.slot)))];
  const text = choices.length
    ? `ขอข้อมูลเพิ่มเติมเกี่ยวกับ ${thaiList(slots)} ก่อนดำเนินการต่อ เลือกจากตัวเลือกด้านล่างหรือพิมพ์ตอบได้เลยครับ`
    : `ขอข้อมูลเพิ่มเติมเกี่ยวกับ ${thaiList(slots)} ก่อนดำเนินการต่อครับ`;
  return { kind: 'clarify', text, choices, clarification: true, fromPlanner: false };
}

/** Limits paragraph that reflects the registry riskTier of the actions this actor can use. */
export function limitsParagraph(actions: readonly ActorActionDescriptor[]): string {
  const lines = ['ขอบเขตการทำงาน:', '• อ่านได้เฉพาะข้อมูลธุรกิจตัวอย่างภายในสิทธิ์ของบัญชีนี้'];
  const direct = actions.some(a => a.riskTier === 'direct' && !a.requiresConfirm);
  const confirm = actions.some(a => a.riskTier === 'confirm' || a.requiresConfirm);
  if (direct) lines.push('• งานร่างส่วนตัวที่ย้อนกลับได้จะถูกสร้างให้ทันที และยกเลิกได้ภายหลัง');
  if (confirm) lines.push('• การดำเนินการที่แชร์ถึงผู้อื่นหรือย้อนกลับไม่ได้จะถูกเตรียมให้ตรวจ และต้องได้รับการยืนยันจากคุณอย่างชัดเจนก่อนเสมอ');
  lines.push('• ใช้ได้เฉพาะข้อมูลและงานที่ระบบนี้รองรับ ไม่สามารถเข้าถึงระบบภายนอกหรืออินเทอร์เน็ต หรือส่ง Email จริงได้');
  lines.push('• คำตอบอ้างอิงแหล่งข้อมูลที่ตรวจสอบได้');
  return lines.join('\n');
}

/** Server-owned capability text derived from the actor's usable actions and datasets (never from user text). */
export function capabilityText(context: PlannerContext, options: { greeting: boolean }): string {
  const areas: string[] = [];
  if (context.catalog.datasets.length) areas.push(`การดูและวิเคราะห์ข้อมูล (${thaiList(context.catalog.datasets.map(d => d.label))})`);
  if (context.workflow?.reads.length) areas.push(DIRECTOR_READ_CAPABILITY);
  areas.push(...new Set(context.actions.map(a => ACTION_COPY[a.actionId]?.capability ?? GENERIC_ACTION_CAPABILITY)));
  const greeting = options.greeting ? 'สวัสดีครับ ' : '';
  if (!areas.length) return `${greeting}ตอนนี้บัญชีนี้ยังไม่มีสิทธิ์ใช้ความสามารถที่เปิดให้บริการ โปรดติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เพิ่มเติม`;
  return `${greeting}บัญชีนี้ให้ผมช่วยได้ในเรื่อง ${thaiList(areas)} — บอกได้เลยว่าต้องการดูหรือทำอะไร\n\n${limitsParagraph(context.actions)}`;
}

/**
 * conversation: AI prose only when it passes the output-safety gate (no digits/number words/entity labels) and the
 * topic is not `capability` (server-owned truth). Otherwise capability text. Greeting only on a conversation's first turn.
 */
export function renderConversation(grounded: GroundedStep, context: PlannerContext, env: RenderEnv = {}): RenderedConversation {
  const step = grounded.step;
  if (step.kind !== 'conversation') throw new Error('renderConversation requires a conversation step');
  const firstTurn = context.conversation.length === 0;
  const prose = grounded.safeText ?? null;
  const dates = [context.business.date, context.business.availability?.from, context.business.availability?.to].filter((d): d is string => !!d);
  const usable = step.topic !== 'capability' && prose !== null
    && isSafeConversationProse(prose, entityLabelsOf(context, env.extraEntityLabels), dates)
    // A conversation step never comes with a validated action step, so prose may not claim an effect happened / will happen.
    && (step.topic === 'product_help' ? modelTextSafe('product_help', prose) : modelTextSafe('conversation', prose));
  if (step.topic === 'product_help') return renderProductHelp(step.concepts ?? [], usable ? prose.trim() : null, context);
  if (usable) return { kind: 'conversation', text: prose.trim(), topic: step.topic, fromPlanner: true };
  if (step.topic === 'acknowledgement') return { kind: 'conversation', text: ACKNOWLEDGEMENT_TEXT, topic: step.topic, fromPlanner: false };
  const prefix = step.topic === 'out_of_scope' ? `${OUT_OF_SCOPE_TEXT}\n\n` : '';
  return { kind: 'conversation', text: `${prefix}${capabilityText(context, { greeting: firstTurn && !prefix })}`, topic: step.topic, fromPlanner: false };
}

/**
 * product_help: the model's explanation of the PRODUCT_MODEL (when it passed the same output-safety gate) or the server's own
 * static product copy, followed by the server-owned account part derived from the runtime context (never from the prose):
 * availability of the concepts the plan named, or for a general introduction this account's capability text.
 */
function renderProductHelp(concepts: readonly ProductConceptId[], proseIn: string | null, context: PlannerContext): RenderedConversation {
  let prose = proseIn;
  const capability = accountCapability(context);
  // Structural gate (G2): the model's free prose is shown only when this account can use EVERY product concept. Lexical matching cannot catch a
  // paraphrase ("automatic low-sales alerts" without Monitor), so any restricted account gets the server-owned copy, which names only usable concepts.
  if (capability.unavailable.length > 0) prose = null;
  const explanation = prose ?? (concepts.length
    ? [...new Set(concepts)].map(concept => productConceptText(concept, capability)).join('\n')
    : productOverviewText(capability));
  const account = concepts.length ? accountConceptLines(capability, concepts) : capabilityText(context, { greeting: false });
  return { kind: 'conversation', text: [explanation, account].filter(Boolean).join('\n\n'), topic: 'product_help', fromPlanner: prose !== null };
}

/** Server-owned fallbacks when model prose fails the output-safety gate. They claim no action and no data. */
export const ACKNOWLEDGEMENT_TEXT = 'รับทราบครับ — ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนแปลงข้อมูลใด ๆ';
export const OUT_OF_SCOPE_TEXT = 'เรื่องนี้อยู่นอกข้อมูลหรือการดำเนินการที่บัญชีนี้ใช้ได้ จึงยังไม่ได้ดำเนินการใด ๆ';

/** Truthful Thai failure text for a planner outage or a plan that stayed invalid after the one repair. */
export function renderPlannerFailure(reason: 'outage' | 'invalid_plan' | 'slow'): PlannerFailureResult {
  const text = reason === 'outage'
    ? 'Live AI ยังไม่พร้อมใช้งาน ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล ลองอีกครั้งภายหลัง หรือสลับเป็นโหมดสาธิต'
    : reason === 'slow'
      ? 'Live AI ใช้เวลาตอบนานเกินไป ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล ลองอีกครั้งภายหลัง หรือสลับเป็นโหมดสาธิต'
      : 'ยังประมวลผลคำขอนี้ไม่สำเร็จ ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล ลองระบุข้อมูลหรือสิ่งที่ต้องการให้ชัดเจนขึ้น เลือกคำแนะนำด้านล่าง หรือสลับเป็นโหมดสาธิต';
  return { kind: 'planner_failure', reason, text, hint: 'switch_to_demo', retryable: true };
}
