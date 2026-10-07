import { parseArtifactRef } from '../../artifacts/ref';
import type { Actor, DashboardSpec, PendingAction, Scope, Transaction, TurnReceiptCard } from '../../contracts';
import { assertStagedFence, STAGED_MODE_CHANGED_CODE } from '../storage/staged-store';
import type { DashboardVisualizationPlan } from '../../visualization/dashboard-data';
import { communicationRegistry, runCommunicationPlan, authorizationRef, type CommunicationPlan } from '../../communication';
import type { EffectRecord, Outcome, Workflow } from '../../effects/shared';
import { digest } from '../../effects/shared';
import { personLabel } from '../context/display';
import { taskFieldsSchema, type TaskFields } from '../ports/work-items';
import { ticketPlanSchema, type TicketPlan } from '../../contracts';
import { runMonitorPlan, type MonitorPlan, type MonitorState } from '../../monitors';
import { defaultSalesDashboard } from '../../packs/sales-runtime';
import { actionRegistry as defaultRegistry, holdsActionPermissions, type ActionDefinition, type ActionRegistry } from '../action-registry';
import type { ParamValue } from '../turn-plan';
import type { GroundedStep } from '../validate';
import type { AcceptedEvidence } from '../ports/effect-bindings';
import { isTableEvidence, type TableAcceptedEvidence } from '../ports/table-evidence';
import { deriveBranchIds } from '../ports/derived-branches';
import { specRevision, type ArtifactShareBinding, type ActionPorts, type DashboardOrganizeOp, type PrepareToolName, type StagedActionId, type StagedProposal, type TurnRef } from './action-ports';
import { confirmDirectorAction, isDirectorActionId, prepareDirectorAction } from './director';
import { DomainError } from '../../core/errors';

export interface ActionIds { pendingActionId?: string; dashboardId?: string; receiptId?: string; recipientIds?: string[]; branchIds?: string[] }
export type ActionExecResult =
  | { outcome: 'created'; actionId: string; text: string; labels: string[]; ids: ActionIds; undo: { kind: 'delete_dashboard'; dashboardId: string } | null }
  | { outcome: 'proposed'; actionId: string; text: string; labels: string[]; ids: ActionIds; preview: string; deduped: boolean; expiresAt: string | number; direct?: boolean }
  | { outcome: 'updated'; actionId: string; text: string; labels: string[]; ids: ActionIds; undo: { kind: 'rename_dashboard'; dashboardId: string; title: string } | null;
    /** G5: receipt card of a direct Dashboard organization (stamped verified by the service in the write transaction). */
    card?: Omit<TurnReceiptCard, 'verifiedAt'> }
  | { outcome: 'cancelled'; actionId: string; text: string; labels: string[]; ids: ActionIds }
  | { outcome: 'clarify'; actionId: string; code: string; slot: string; text: string; labels: string[] }
  | { outcome: 'denied'; actionId: string; code: string; text: string; labels: string[] }
  | { outcome: 'failed'; actionId: string; code: string; text: string; labels: string[] };

export type VisualizationSpecResult = { outcome: 'accepted'; spec: DashboardSpec; omitted?: string[] } | { outcome: 'rejected'; code: string; text: string };
/** Names the planned widgets that the evidence could not support (left out, never faked). */
export function omittedWidgetsText(omitted: readonly string[] | undefined): string {
  return omitted?.length ? ` — ไม่ได้ใส่ Widget ${omitted.map(t => `“${t}”`).join(', ')} เพราะหลักฐานของคำถามนี้แสดงในรูปแบบนั้นไม่ได้` : '';
}
export interface ActionExecutorInput {
  ports: ActionPorts; actor: Actor; step: GroundedStep; conversationId: string; turnId: string;
  now: () => Date; registry?: ActionRegistry; signal?: AbortSignal;
  /** Every region id in the catalog; lets a wildcard actor's full authorized set map to the 'all' scope. */
  allRegionIds?: readonly string[];
  /**
   * The accepted answer of an earlier step of THIS turn (`$step0`): its in-memory evidence for preview binding, and the id the
   * state will have once the turn persists (proposals store that id, never the turn-local `$step0`).
   */
  stepState?: () => Promise<{ persistedId: string; accepted: AcceptedEvidence | TableAcceptedEvidence } | undefined>;
  /** Server binding of an AI visualization plan to accepted evidence (U7 buildDashboardSpecFromPlan). */
  visualizationSpec?: (input: { visualization: DashboardVisualizationPlan; sourceId: string; title?: string }) => Promise<VisualizationSpecResult>;
  /** G5: how many of the actor's listed Dashboards already carry this exact title (a new one says so instead of silently duplicating). */
  sameTitleDashboards?: (title: string) => number;
  /** Server-owned directory labels, retaining the account distinction the user selected. */
  recipientLabels?: ReadonlyMap<string, string>;
}

const DEFAULT_LABELS: Record<string, string> = { regionIds: 'ภูมิภาคที่คุณมีสิทธิ์', date: 'วันที่ธุรกิจล่าสุด', channelId: 'กล่องข้อความจำลอง', conditionId: 'ยอดขายต่ำกว่าเป้า', cadenceId: 'ตรวจวันละครั้งเวลาประมาณ 08:00 น.' };
const STAGED_TTL_MS = 24 * 3_600_000;

type Thai = { code: string; text: string };
const deniedPermission: Thai = { code: 'permission_denied', text: 'บัญชีนี้ยังไม่มีสิทธิ์ทำรายการนี้ จึงไม่ได้ดำเนินการ' };
const deniedScope: Thai = { code: 'scope_denied', text: 'ขอบเขตที่ขอเกินสิทธิ์ของบัญชีนี้ จึงไม่ได้ดำเนินการ' };
const deniedRecipient: Thai = { code: 'recipient_denied', text: 'ผู้รับรายนี้ไม่อยู่ในรายชื่อที่บัญชีนี้ส่งถึงได้ จึงไม่ได้ดำเนินการ' };

const str = (v: ParamValue | undefined): string => (typeof v === 'string' ? v : '');
const strs = (v: ParamValue | undefined): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

function labelsFor(step: GroundedStep): string[] {
  return Object.values(step.params).filter(p => p.serverDefault).map(p => `default:${p.name}`);
}
function defaultsText(step: GroundedStep): string {
  const names = Object.values(step.params).filter(p => p.serverDefault && DEFAULT_LABELS[p.name]).map(p => DEFAULT_LABELS[p.name]);
  return names.length ? ` (ใช้ค่าเริ่มต้นของระบบ: ${names.join(', ')})` : '';
}
/** Registry-bound region(s) -> one Scope the existing prepare tools accept; null when not representable. */
function toScope(actor: Actor, regionIds: string[], date: string, branchIds?: string[], allRegionIds: readonly string[] = []): Scope | null {
  let region: string | null = null;
  const authorized = actor.regions.includes('*') ? allRegionIds : actor.regions;
  if (regionIds.length === 1) region = regionIds[0];
  else if (regionIds.length > 1 && authorized.length > 0 && authorized.every(r => regionIds.includes(r))) region = 'all';
  if (!region) return null;
  return { region, date, ...(branchIds?.length ? { branchIds } : {}) };
}
const outcomeCode = (o: Exclude<Outcome, 'accepted'>) => o;

function fail(actionId: string, kind: 'denied' | 'failed', t: Thai, labels: string[] = []): ActionExecResult {
  return { outcome: kind, actionId, code: t.code, text: t.text, labels };
}
function clarify(actionId: string, code: string, slot: string, text: string, labels: string[] = []): ActionExecResult {
  return { outcome: 'clarify', actionId, code, slot, text, labels };
}
function mapEffectFailure(actionId: string, outcome: Exclude<Outcome, 'accepted'>, code: string, labels: string[]): ActionExecResult {
  switch (outcome) {
    case 'clarification_required': case 'incomplete_evidence':
      return clarify(actionId, code, 'content', 'ข้อมูลหรือหลักฐานยังไม่ครบสำหรับรายการนี้ จึงยังไม่ได้เตรียม — โปรดเลือกคำตอบที่ตรวจสอบแล้วและระบุผู้รับให้ชัดเจน', labels);
    case 'permission_denied': case 'unsupported_concept':
      return fail(actionId, 'denied', { code: outcomeCode(outcome) + ':' + code, text: 'สิทธิ์ ขอบเขต หรือความยินยอมไม่เพียงพอสำหรับรายการนี้ จึงไม่ได้ดำเนินการ' }, labels);
    default:
      return fail(actionId, 'failed', { code: outcomeCode(outcome) + ':' + code, text: 'ดำเนินการไม่สำเร็จ ยังไม่มีการเปลี่ยนแปลงใด ๆ — ลองใหม่อีกครั้ง' }, labels);
  }
}
const idemKey = (prefix: string, value: unknown) => `${prefix}_${digest(value).slice(0, 40)}`;

/** Dedupe on the prepared payload: an identical pending proposal wins and the fresh duplicate is cancelled. */
async function dedupePrepared(ports: ActionPorts, actor: Actor, created: PendingAction): Promise<{ action: PendingAction; deduped: boolean }> {
  const pending = await ports.listPending(actor, created.conversationId);
  const earlier = pending.filter(p => p.id !== created.id && p.status === 'pending' && p.payloadHash === created.payloadHash && p.actorId === actor.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!earlier) return { action: created, deduped: false };
  await ports.cancelPending(actor, created.id).catch(() => undefined);
  return { action: earlier, deduped: true };
}

function proposedFromPending(def: ActionDefinition, step: GroundedStep, action: PendingAction, deduped: boolean, ids: ActionIds = {}): ActionExecResult {
  const text = deduped
    ? `มีรายการเดียวกันรออยู่แล้ว — ยังไม่ได้ดำเนินการ โปรดตรวจตัวอย่างและยืนยัน${defaultsText(step)}`
    : `เตรียมรายการแล้ว ยังไม่ได้ดำเนินการ — โปรดตรวจตัวอย่างและยืนยัน${defaultsText(step)}`;
  return { outcome: 'proposed', actionId: def.actionId, text, labels: labelsFor(step), preview: action.preview, deduped,
    expiresAt: action.expiresAt, ids: { ...ids, pendingActionId: action.id } };
}

async function runPrepared(input: ActionExecutorInput, def: ActionDefinition, tool: PrepareToolName, args: Record<string, unknown>): Promise<{ action: PendingAction; deduped: boolean }> {
  const ref: TurnRef = { conversationId: input.conversationId, turnId: input.turnId };
  const created = await input.ports.prepareTool(input.actor, tool, args, ref);
  return dedupePrepared(input.ports, input.actor, created);
}

async function stage(input: ActionExecutorInput, def: ActionDefinition, actor: Actor, step: GroundedStep, canonical: unknown, preview: string,
  data: Record<string, unknown>, expiresAt: number, ids: ActionIds, stagedActionId: StagedActionId = def.actionId as StagedActionId): Promise<ActionExecResult> {
  const key = digest({ actionId: stagedActionId, actorId: actor.id, canonical });
  const ref: TurnRef = { conversationId: input.conversationId, turnId: input.turnId };
  let existing: StagedProposal | undefined, proposal: StagedProposal;
  try {
    existing = await input.ports.staged.findPending(actor, input.conversationId, key);
    proposal = existing ?? await input.ports.staged.create(actor, ref, { actionId: stagedActionId, digest: key, preview, data, expiresAt });
  } catch (error) {
    // Stores without the router_proposals table: truthful "not available yet", never a 500.
    if (stagedUnavailable(error)) return fail(def.actionId, 'denied', stagedUnavailableText, labelsFor(step));
    throw error;
  }
  const deduped = !!existing;
  return { outcome: 'proposed', actionId: def.actionId, labels: labelsFor(step), preview: proposal.preview, deduped, expiresAt: proposal.expiresAt,
    ids: { ...ids, pendingActionId: proposal.id },
    text: (deduped ? 'มีรายการเดียวกันรออยู่แล้ว — ' : 'เตรียมรายการแล้ว ') + 'ยังไม่ได้ดำเนินการ โปรดตรวจตัวอย่างและยืนยัน' + defaultsText(step) };
}

export const STAGED_UNAVAILABLE_CODE = 'STAGED_UNAVAILABLE';
const stagedUnavailableText: Thai = { code: 'staged_unavailable', text: 'รายการประเภทนี้ยังไม่เปิดให้ใช้งานในระบบนี้ จึงยังไม่ได้เตรียมรายการ' };
function stagedUnavailable(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === STAGED_UNAVAILABLE_CODE;
}

/**
 * Executes one accepted `action` step. Authorization/scope/recipient checks are re-done here against the reloaded
 * actor and server stores; the validator's grounding is never the only gate. Direct-tier actions run immediately
 * (audited, with undo info); confirm-tier actions only create a deduped proposal.
 */
export async function executeActionStep(input: ActionExecutorInput): Promise<ActionExecResult> {
  input.signal?.throwIfAborted();
  const registry = input.registry ?? defaultRegistry;
  const step = input.step.step;
  if (step.kind !== 'action') return fail('unknown', 'denied', { code: 'wrong_step_kind', text: 'ขั้นตอนนี้ไม่ใช่การดำเนินการ' });
  const def = registry.get(step.actionId);
  if (!def) return fail(step.actionId, 'denied', { code: 'unknown_action', text: 'ไม่พบการดำเนินการที่ร้องขอ' });
  const { ports } = input;
  const actor = await ports.reloadActor(input.actor);
  if (!actor.active || !holdsActionPermissions(def, actor.permissions)) return fail(def.actionId, 'denied', deniedPermission);

  const v = (name: string) => input.step.params[name]?.value;
  const labels = labelsFor(input.step);

  // Region/branch scope (server side, per action param spec).
  const regionIds = strs(v('regionIds'));
  if (!actor.regions.includes('*') && regionIds.some(r => !actor.regions.includes(r))) return fail(def.actionId, 'denied', deniedScope, labels);
  let branchIds = strs(v('branchIds'));
  // S2: a derived set (branchesFrom + registered rule) is expanded by the server from the accepted answer's evidence, then scope-checked like named branches.
  const derivedFrom = str(v('branchesFrom'));
  if (derivedFrom && def.params.branchesFrom) {
    const derived = await deriveBranches(input, actor, def, derivedFrom, str(v('branchesRule')), labels);
    if ('result' in derived) return derived.result;
    branchIds = [...new Set([...branchIds, ...derived.ids])];
  }
  if (branchIds.length && ports.branchesAllowed && !(await ports.branchesAllowed(actor, branchIds))) return fail(def.actionId, 'denied', deniedScope, labels);

  const ctx = { ...input, actor, branchIds };
  switch (def.actionId) {
    case 'dashboard.create': return dashboardCreate(ctx, def);
    case 'dashboard.rename': return dashboardRename(ctx, def);
    case 'dashboard.delete': return dashboardDelete(ctx, def);
    case 'dashboard.revoke_share': return dashboardRevokeShare(ctx, def);
    case 'dashboard.share': return dashboardShare(ctx, def);
    case 'ticket.create': {
      const scope = toScope(actor, regionIds, str(v('date')), branchIds, input.allRegionIds);
      if (!scope) return clarify(def.actionId, 'scope_unrepresentable', 'regionIds', 'โปรดเลือกภูมิภาคเดียว หรือใช้ทุกภูมิภาคที่คุณมีสิทธิ์', labels);
      // ACTIONPLAN-001: flexible fields travel in the ticket payload only when the plan states at least one of them.
      const ticketPlan = ticketPlanOf(input.step);
      if (!ticketPlan.success) return clarify(def.actionId, 'ticket_fields', 'priority', 'ข้อมูล Ticket ยังไม่ถูกต้อง — โปรดตรวจความสำคัญ วันครบกำหนด และรายการตรวจ', labels);
      const { action, deduped } = await runPrepared(ctx, def, 'ticket.prepare_create', { scope: { region: scope.region, date: scope.date }, branchIds, ...(ticketPlan.data ? { plan: ticketPlan.data } : {}) });
      return proposedFromPending(def, input.step, action, deduped, { branchIds });
    }
    case 'badge.revoke': {
      const { action, deduped } = await runPrepared(ctx, def, 'badge.prepare_revoke',
        { badgeId: str(v('badgeId')), employeeId: str(v('employeeId')), reason: str(v('reason')) });
      return proposedFromPending(def, input.step, action, deduped);
    }
    case 'monitor.manage': return monitorLifecycle(ctx, def);
    case 'dashboard.manage': return dashboardOrganize(ctx, def);
    case 'result.manage':
    case 'result.unarchive': return resultLibrary(ctx, def);
    case 'communication.send': return communicationSend(ctx, def);
    case 'monitor.create': return monitorCreate(ctx, def);
    case 'artifact.share': return artifactShare(ctx, def);
    case 'task.create': return taskCreate(ctx, def);
    case 'policy.acknowledge': return policyAcknowledge(ctx, def);
    case 'onboarding.director_approve': case 'onboarding.return': case 'onboarding.notify_email': {
      // HR Director (Workflow V2 bridge): server binding + staged proposal only; the V2 runtime runs at confirm.
      if (!isDirectorActionId(def.actionId)) return fail(def.actionId, 'denied', { code: 'no_handler', text: 'ยังไม่รองรับการดำเนินการนี้' });
      return prepareDirectorAction({ actor, step: input.step, conversationId: input.conversationId, now: input.now, port: ports.effects?.directorWorkflow,
        proposal: id => ports.staged.get(actor, id) }, def.actionId, {
        stage: (canonical, preview, data, expiresAt) => stage(ctx, def, actor, input.step, canonical, preview, data, expiresAt, {}),
        fail: (kind, code, text) => fail(def.actionId, kind, { code, text }, labels),
        clarify: (code, slot, text) => clarify(def.actionId, code, slot, text, labels),
      });
    }
    default: return fail(def.actionId, 'denied', { code: 'no_handler', text: 'ยังไม่รองรับการดำเนินการนี้' });
  }
}

type Ctx = ActionExecutorInput & { actor: Actor; branchIds?: string[] };

async function dashboardCreate(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input;
  const v = (n: string) => step.params[n]?.value;
  const title = str(v('title'));
  const planStep = step.step.kind === 'action' ? step.step : undefined;
  let spec: DashboardSpec;
  let omitted = '';
  if (planStep?.visualization) {
    if (!input.visualizationSpec) return fail(def.actionId, 'denied', { code: 'visualization_unavailable', text: 'ยังสร้าง Dashboard จากแผนภาพข้อมูลไม่ได้ในตอนนี้ จึงไม่ได้เตรียมรายการ' }, labelsFor(step));
    const built = await input.visualizationSpec({ visualization: planStep.visualization, sourceId: str(v('source')), ...(title ? { title } : {}) });
    if (built.outcome !== 'accepted') return fail(def.actionId, 'denied', { code: built.code, text: built.text }, labelsFor(step));
    spec = built.spec;
    omitted = omittedWidgetsText(built.omitted);
  } else {
    const scope = toScope(actor, strs(v('regionIds')), str(v('date')), undefined, input.allRegionIds);
    if (!scope) return clarify(def.actionId, 'scope_unrepresentable', 'regionIds', 'โปรดเลือกภูมิภาคเดียว หรือใช้ทุกภูมิภาคที่คุณมีสิทธิ์', labelsFor(step));
    const base = defaultSalesDashboard(scope);
    spec = title ? { ...base, title } : base;
  }
  const labels = [...labelsFor(step), ...(strs(v('measureIds')).length && !planStep?.visualization ? ['default:widgets'] : [])];
  const twins = input.sameTitleDashboards?.(spec.title) ?? 0;
  const twinText = twins ? ` — มี Dashboard ชื่อ “${spec.title}” อยู่แล้ว ${twins} รายการ อันนี้เป็น Dashboard ใหม่แยกต่างหาก (เปลี่ยนชื่อได้ภายหลัง)` : '';
  const { action, deduped } = await runPrepared(input, def, 'dashboard.prepare_create', { spec });
  if (def.riskTier !== 'direct') return proposedFromPending(def, step, action, deduped);
  if (ports.deferDirectConfirm) {
    return { ...proposedFromPending(def, step, action, deduped), direct: true, labels,
      text: `สร้าง Dashboard ส่วนตัว “${spec.title}” ให้แล้ว — เป็นของคุณคนเดียว เปิดดูหรือลบได้ทุกเมื่อ${defaultsText(step)}${omitted}${twinText}` } as ActionExecResult;
  }
  try {
    const receipt = await ports.confirmPending(actor, action.id);
    if (receipt.status !== 'verified_success' || !('dashboardId' in receipt) || !receipt.dashboardId) {
      return fail(def.actionId, 'failed', { code: 'create_unverified', text: 'ยังไม่สามารถยืนยันได้ว่าสร้าง Dashboard สำเร็จ — ตรวจที่รายการของคุณแล้วลองอีกครั้ง' }, labels);
    }
    await ports.audit?.(actor, { kind: 'router_direct_create', detail: 'สร้าง Dashboard ส่วนตัวโดยตรง', refId: receipt.dashboardId });
    return { outcome: 'created', actionId: def.actionId, labels,
      text: `สร้าง Dashboard “${spec.title}” แล้ว — เป็นแบบส่วนตัว ลบออกได้ทุกเมื่อ${defaultsText(step)}${omitted}${twinText}`,
      ids: { dashboardId: receipt.dashboardId, pendingActionId: action.id, receiptId: receipt.id },
      undo: { kind: 'delete_dashboard', dashboardId: receipt.dashboardId } };
  } catch {
    return fail(def.actionId, 'failed', { code: 'create_failed', text: 'เตรียม Dashboard แล้วแต่ยังสร้างไม่สำเร็จ — โปรดตรวจตัวอย่างและยืนยันอีกครั้ง' }, labels);
  }
}

async function ownedDashboard(input: Ctx, def: ActionDefinition, id: string) {
  const dashboard = await input.ports.getDashboard(input.actor, id);
  if (!dashboard || dashboard.ownerId !== input.actor.id || dashboard.deleted) return null;
  return dashboard;
}

export const AUTHORITY_CHANGED_CODE = 'AUTHORITY_CHANGED';
/**
 * A staged proposal stays confirmable by the same actor in the same mode from any of their sessions. From the creating
 * session the mode revision must also be unchanged (another session's own revision is unrelated; the creating session's
 * revision is checked in the claim and effect transactions).
 */
export function sameModeFence(staged: Pick<StagedProposal, 'mode' | 'modeRevision' | 'sessionId'>, actor: Pick<Actor, 'mode' | 'modeRevision' | 'sessionId'>): boolean {
  if (staged.mode === undefined) return true;
  if (staged.mode !== actor.mode) return false;
  return staged.sessionId === undefined || staged.sessionId !== actor.sessionId || staged.modeRevision === actor.modeRevision;
}
/** Staged actions whose authority is not a planner-facing registry entry. */
const STAGED_PERMISSIONS: Partial<Record<StagedActionId, readonly string[]>> = {
  'dashboard.refine': ['dashboard.create', 'sales.read'],
  'dashboard.revoke_share': ['sales.read'],
  'monitor.delete': defaultRegistry.get('monitor.manage')?.requiredPermissions ?? ['__unregistered__'],
};
export function stagedRequiredPermissions(actionId: StagedActionId): readonly string[] | undefined {
  return STAGED_PERMISSIONS[actionId] ?? defaultRegistry.get(actionId)?.requiredPermissions;
}

async function dashboardRevokeShare(input: ActionExecutorInput, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input;
  if (!ports.dashboardShares || !ports.revokeDashboardShare) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ยังจัดการการแชร์ Dashboard จากแชตไม่ได้ จึงไม่มีการเปลี่ยนแปลง' }, labelsFor(step));
  const dashboardId = str(step.params.dashboard?.value), shareId = str(step.params.shareId?.value);
  const dashboard = await ports.getDashboard(actor, dashboardId);
  if (!dashboard || dashboard.ownerId !== actor.id || dashboard.deleted) return fail(def.actionId, 'denied', { code: 'dashboard_denied', text: 'ไม่พบ Dashboard ของคุณตามที่ระบุ' }, labelsFor(step));
  // A failed projection read rejects the turn. It must never be interpreted as an empty share list.
  const shares = await ports.dashboardShares(actor, dashboardId);
  const share = shares.find(row => row.shareId === shareId);
  if (!share) return fail(def.actionId, 'denied', { code: 'share_not_active', text: 'ไม่พบการแชร์ที่ยังใช้งานอยู่ตามที่ระบุ จึงไม่มีการเปลี่ยนแปลง' }, labelsFor(step));
  const preview = `เพิกถอนการแชร์ Dashboard “${dashboard.title}” ให้ ${share.recipientName}`;
  return stage(input, def, actor, step, { dashboardId, shareId }, preview,
    { params: { dashboardId, shareId, dashboardTitle: dashboard.title, recipientName: share.recipientName } },
    input.now().getTime() + STAGED_TTL_MS, { dashboardId });
}
/** Fresh permission check of a staged action (honours the registry's any-of permissions). */
export function stagedHoldsPermissions(actionId: StagedActionId, permissions: readonly string[]): boolean {
  const own = STAGED_PERMISSIONS[actionId];
  if (own) return own.every(p => permissions.includes(p));
  const def = defaultRegistry.get(actionId);
  return !!def && holdsActionPermissions(def, permissions);
}
const CHANGED_TEXT = 'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่';
export const DASHBOARD_SHARED_CODE = 'DASHBOARD_SHARED';
export const DASHBOARD_CHANGED_CODE = 'DASHBOARD_CHANGED';
const hasCode = (error: unknown, code: string): boolean => !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === code;

async function dashboardRename(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const id = str(input.step.params.dashboard?.value), title = str(input.step.params.title?.value);
  const dashboard = await ownedDashboard(input, def, id);
  if (!dashboard) return fail(def.actionId, 'denied', { code: 'dashboard_denied', text: 'ไม่พบ Dashboard ของคุณตามที่ระบุ จึงไม่ได้เปลี่ยนชื่อ' });
  // A dashboard with ANY active share is never renamed silently: a confirm-tier staged proposal bound to the base revision.
  const stageShared = () => stage(input, def, input.actor, input.step, { dashboardId: id, title, base: dashboard.revision ?? null },
    `เปลี่ยนชื่อ Dashboard ที่แชร์แล้ว “${dashboard.title}” เป็น “${title}” (ผู้ที่ได้รับแชร์จะเห็นชื่อใหม่หลังยืนยัน)`,
    { params: { dashboardId: id, title }, title: dashboard.title, ...(dashboard.revision ? { baseRevision: dashboard.revision } : {}) },
    input.now().getTime() + STAGED_TTL_MS, { dashboardId: id }, 'dashboard.rename');
  if (dashboard.shared) return stageShared();
  let updated: { id: string; title: string };
  try {
    updated = await input.ports.renameDashboard(input.actor, id, { title }, { ...(dashboard.revision ? { expectedRevision: dashboard.revision } : {}) });
  } catch (error) {
    if (hasCode(error, DASHBOARD_SHARED_CODE)) return stageShared(); // a share appeared between the check and the write
    if (hasCode(error, DASHBOARD_CHANGED_CODE)) return clarify(def.actionId, 'dashboard_changed', 'dashboard', CHANGED_TEXT);
    throw error;
  }
  await input.ports.audit?.(input.actor, { kind: 'router_direct_rename', detail: 'เปลี่ยนชื่อ Dashboard ส่วนตัว', refId: id });
  return { outcome: 'updated', actionId: def.actionId, labels: labelsFor(input.step), ids: { dashboardId: id },
    text: `เปลี่ยนชื่อ Dashboard เป็น “${updated.title}” แล้ว`, undo: { kind: 'rename_dashboard', dashboardId: id, title: dashboard.title } };
}

async function dashboardDelete(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const id = str(input.step.params.dashboard?.value);
  const dashboard = await ownedDashboard(input, def, id);
  if (!dashboard) return fail(def.actionId, 'denied', { code: 'dashboard_denied', text: 'ไม่พบ Dashboard ของคุณตามที่ระบุ จึงไม่ได้ลบ' });
  if (dashboard.shared) return fail(def.actionId, 'denied', { code: 'dashboard_shared', text: 'Dashboard นี้ถูกแชร์ให้ผู้อื่นแล้ว ลบไม่ได้จากหน้านี้' });
  const preview = `ลบ Dashboard ส่วนตัว “${dashboard.title}”`;
  return stage(input, def, input.actor, input.step, { dashboardId: id }, preview, { params: { dashboardId: id }, title: dashboard.title },
    input.now().getTime() + STAGED_TTL_MS, { dashboardId: id });
}

async function dashboardShare(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const dashboardId = str(input.step.params.dashboard?.value), recipientId = str(input.step.params.recipientId?.value);
  const dashboard = await ownedDashboard(input, def, dashboardId);
  if (!dashboard) return fail(def.actionId, 'denied', { code: 'dashboard_denied', text: 'ไม่พบ Dashboard ของคุณตามที่ระบุ จึงไม่ได้เตรียมการแชร์' });
  if (!(await input.ports.recipientAllowed(input.actor, recipientId))) return fail(def.actionId, 'denied', deniedRecipient);
  const { action, deduped } = await runPrepared(input, def, 'dashboard.prepare_share', { dashboardId, recipientId });
  return proposedFromPending(def, input.step, action, deduped, { dashboardId, recipientIds: [recipientId] });
}

async function communicationSend(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, effects = ports.effects;
  const recipientIds = strs(step.params.recipientIds?.value);
  let contentStateId = str(step.params.content?.value), inTurn: AcceptedEvidence | TableAcceptedEvidence | undefined;
  const labels = labelsFor(step);
  if (contentStateId === '$step0') {
    const resolved = await input.stepState?.();
    if (!resolved) return clarify(def.actionId, 'content_unbound', 'content', 'ยังผูกข้อความกับคำตอบที่ตรวจสอบแล้วไม่ได้ — โปรดเลือกคำตอบที่ต้องการส่ง', labels);
    contentStateId = resolved.persistedId; inTurn = resolved.accepted;
  }
  for (const id of recipientIds) if (!(await ports.recipientAllowed(actor, id))) return fail(def.actionId, 'denied', deniedRecipient, labels);
  if (!effects) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันส่งข้อความยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ' }, labels);
  if (recipientIds.length > communicationRegistry.maxRecipients) return fail(def.actionId, 'denied', deniedRecipient, labels);
  const artifactId = str(step.params.artifact?.value);
  let artifactBinding: ArtifactShareBinding | undefined;
  if (artifactId) {
    // The message carries one exact artifact version: sender and EVERY recipient must be authorized for its whole stored scope.
    if (!effects.artifactShare) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันแนบผลลัพธ์ยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ' }, labels);
    const ref = parseArtifactRef(artifactId);
    const bind = await effects.artifactShare.bind(actor, { artifactId: ref.artifactId, recipientIds, ...(ref.revision ? { revision: ref.revision } : {}) });
    if (!bind.ok) return fail(def.actionId, 'denied', { code: bind.code, text: bind.text }, labels);
    artifactBinding = bind.binding;
  }
  const bound = await effects.communication(actor, { recipientIds, contentStateId, ...(inTurn ? { inTurn } : {}) });
  if (!bound) return clarify(def.actionId, 'content_unbound', 'content', 'ยังผูกข้อความกับคำตอบที่ตรวจสอบแล้วไม่ได้ — โปรดเลือกคำตอบที่ต้องการส่ง', labels);
  const canonical = { recipientIds: [...recipientIds].sort(), contentClaimIds: [...bound.contentClaimIds].sort(), channelId: 'simulated_inbox', ...(artifactBinding ? { artifact: artifactBinding.artifact.digest } : {}) };
  const plan: CommunicationPlan = { version: 1, channelId: 'simulated_inbox', recipientIds, contentClaimIds: bound.contentClaimIds,
    authorization: authorizationRef(bound.context), consent: bound.consent, approvalRequired: true, idempotencyKey: idemKey('comm', { actor: actor.id, canonical }) };
  const r = runCommunicationPlan({ request: { phase: 'preview', plan }, context: bound.context, inbox: bound.inbox });
  if (r.outcome !== 'accepted') return mapEffectFailure(def.actionId, r.outcome, r.code, labels);
  const workflow = r.value.workflow;
  const names = recipientIds.map(id => bound.context.recipients.find(x => x.ref.id === id)?.name ?? id);
  const attach = artifactBinding ? ` พร้อมแนบผลลัพธ์ “${artifactBinding.artifact.title}” (ฉบับที่ ${artifactBinding.artifact.revision})` : '';
  const preview = `ส่งข้อความถึง ${names.join(', ')}${attach} ผ่านกล่องข้อความจำลอง (ไม่ส่งออกภายนอก)${String.fromCharCode(10)}${workflow.preview.intent.content}`;
  return stage(input, def, actor, step, canonical, preview, { params: { recipientIds, contentStateId, ...(artifactBinding ? { artifactId: artifactBinding.artifact.id, revision: artifactBinding.artifact.revision } : {}) }, workflow,
    ...(artifactBinding ? { artifactBindingDigest: artifactBinding.bindingDigest, artifact: { id: artifactBinding.artifact.id, revision: artifactBinding.artifact.revision, title: artifactBinding.artifact.title } } : {}) },
    input.now().getTime() + STAGED_TTL_MS, { recipientIds });
}

async function artifactShare(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, effects = ports.effects;
  const artifactId = str(step.params.artifact?.value), recipientIds = strs(step.params.recipientIds?.value);
  const labels = labelsFor(step);
  for (const id of recipientIds) if (!(await ports.recipientAllowed(actor, id))) return fail(def.actionId, 'denied', deniedRecipient, labels);
  const share = effects?.artifactShare;
  if (!share) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันแชร์ผลลัพธ์ยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ' }, labels);
  // Fresh authorization of the sender AND every recipient for the whole stored scope of the artifact; nothing is narrowed or truncated.
  const ref = parseArtifactRef(artifactId);
  const bound = await share.bind(actor, { artifactId: ref.artifactId, recipientIds, ...(ref.revision ? { revision: ref.revision } : {}) });
  if (!bound.ok) return fail(def.actionId, 'denied', { code: bound.code, text: bound.text }, labels);
  const b = bound.binding;
  const canonical = { artifact: b.artifact.digest, revision: b.artifact.revision, recipientIds: [...recipientIds].sort() };
  const preview = [
    `แชร์ผลลัพธ์ “${b.artifact.title}” (ฉบับที่ ${b.artifact.revision}) ให้ ${b.recipients.map(r => r.name).join(', ')} แบบอ่านอย่างเดียว`,
    'ผู้รับเปิดดูผ่านกล่องข้อความ และระบบตรวจสิทธิ์ของผู้รับกับขอบเขตข้อมูลทั้งหมดของผลลัพธ์นี้อีกครั้งทุกครั้งที่เปิด (ไม่ส่งออกภายนอก)',
  ].join('\n');
  return stage(input, def, actor, step, canonical, preview, { params: { artifactId: b.artifact.id, revision: b.artifact.revision, recipientIds }, bindingDigest: b.bindingDigest,
    artifact: { id: b.artifact.id, revision: b.artifact.revision, title: b.artifact.title, kind: b.artifact.kind } },
  input.now().getTime() + STAGED_TTL_MS, { recipientIds });
}

const MAX_DERIVED_BRANCHES = 12;
async function deriveBranches(input: ActionExecutorInput, actor: Actor, def: ActionDefinition, stateId: string, rule: string, labels: string[]): Promise<{ ids: string[] } | { result: ActionExecResult }> {
  let found: AcceptedEvidence | TableAcceptedEvidence | undefined;
  if (stateId === '$step0') found = (await input.stepState?.())?.accepted;
  else found = await input.ports.effects?.acceptedEvidence?.(actor, stateId);
  if (!found) return { result: clarify(def.actionId, 'branches_unbound', 'branchesFrom', 'ยังผูกรายชื่อสาขากับคำตอบที่ตรวจสอบแล้วไม่ได้ — โปรดเลือกคำตอบที่ต้องการ', labels) };
  const derived = deriveBranchIds(found, rule === 'below_target' || rule === 'positive_value' ? rule : undefined);
  if (!derived.ok) return { result: clarify(def.actionId, derived.code, 'branchIds', derived.code === 'rule_unsupported'
    ? 'คำตอบนี้ไม่มี Target ให้เทียบ จึงยังเลือกสาขาตามเงื่อนไขนี้ไม่ได้ — โปรดระบุสาขาที่ต้องการ' : 'คำตอบนี้ไม่ได้แยกตามสาขา จึงยังเลือกสาขาให้ไม่ได้ — โปรดระบุสาขาที่ต้องการ', labels) };
  if (!derived.branchIds.length) return { result: fail(def.actionId, 'denied', { code: 'no_branches_derived', text: 'ไม่พบสาขาที่ตรงเงื่อนไขในคำตอบนี้ จึงไม่ได้เตรียมรายการ' }, labels) };
  if (derived.branchIds.length > MAX_DERIVED_BRANCHES) return { result: clarify(def.actionId, 'too_many_branches', 'branchIds', `พบ ${derived.branchIds.length} สาขาที่ตรงเงื่อนไข เกินกว่า ${MAX_DERIVED_BRANCHES} สาขาต่อรายการ — โปรดระบุสาขาหรือภูมิภาคให้แคบลง`, labels) };
  return { ids: derived.branchIds };
}

const PRIORITY_TEXT: Record<string, string> = { low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วน' };
const TICKET_PLAN_PARAMS = ['priority', 'dueDate', 'grouping', 'checklist', 'note'] as const;
/** Ticket plan fields as stated by the validated plan; `data` is undefined when none of them was stated (legacy payload shape). */
function ticketPlanOf(step: GroundedStep): { success: true; data: Omit<TicketPlan, 'coveredBranchIds'> | undefined } | { success: false } {
  if (!TICKET_PLAN_PARAMS.some(name => step.params[name] && !step.params[name]!.serverDefault)) return { success: true, data: undefined };
  const v = (name: string) => step.params[name]?.value;
  const parsed = ticketPlanSchema.omit({ coveredBranchIds: true }).safeParse({ priority: str(v('priority')) || 'normal', dueDate: str(v('dueDate')) || null,
    grouping: str(v('grouping')) || 'per_branch', checklist: strs(v('checklist')), note: str(v('note')).trim() || null });
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}
function taskFieldsOf(step: GroundedStep, actorId: string, branchIds?: string[]) {
  const v = (name: string) => step.params[name]?.value;
  const fields = { title: str(v('title')).trim(), priority: str(v('priority')) || 'normal', dueDate: str(v('dueDate')) || null, grouping: str(v('grouping')) || 'single',
    checklist: strs(v('checklist')), branchIds: branchIds ?? strs(v('branchIds')), assigneeId: str(v('assigneeId')) || actorId, note: str(v('note')).trim() || null };
  return taskFieldsSchema.safeParse(fields);
}
async function taskCreate(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, effects = ports.effects, labels = labelsFor(step);
  const parsed = taskFieldsOf(step, actor.id, input.branchIds);
  if (!parsed.success) return clarify(def.actionId, 'task_fields', parsed.error.issues.some(i => i.path[0] === 'branchIds' || i.message.includes('branches')) ? 'branchIds' : 'title', 'ข้อมูลงานยังไม่ครบหรือไม่ถูกต้อง — โปรดระบุสาขาเมื่อให้แยกเป็นรายสาขา และตรวจชื่อ ความสำคัญ วันครบกำหนด และรายการตรวจ', labels);
  const fields = parsed.data;
  if (fields.assigneeId !== actor.id && !(await ports.recipientAllowed(actor, fields.assigneeId))) return fail(def.actionId, 'denied', deniedRecipient, labels);
  if (!effects?.workItems) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันสร้างงานยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ' }, labels);
  const check = await effects.workItems.authorize(actor, fields.assigneeId, undefined, fields.branchIds);
  if (!check.ok) return fail(def.actionId, 'denied', deniedPermission, labels);
  const assigneeLabel = fields.assigneeId === actor.id ? 'คุณเอง' : input.recipientLabels?.get(fields.assigneeId) ?? personLabel(check.assignee);
  const lines = [`สร้างงาน “${fields.title}” ${fields.grouping === 'per_branch' ? `แยกเป็นรายสาขา (${fields.branchIds.length} รายการ)` : 'เป็นงานเดียว'} ความสำคัญ${PRIORITY_TEXT[fields.priority]}${fields.dueDate ? ` ครบกำหนด ${fields.dueDate}` : ''}`,
    ...(fields.checklist.length ? [`รายการตรวจ ${fields.checklist.length} ข้อ: ${fields.checklist.join(' / ')}`] : []), ...(fields.note ? [`หมายเหตุ: ${fields.note}`] : []),
    fields.assigneeId === actor.id ? 'ผู้รับผิดชอบ: คุณเอง' : `ผู้รับผิดชอบ: ${assigneeLabel} (จะได้รับแจ้งในกล่องข้อความหลังยืนยัน)`];
  return stage(input, def, actor, step, { fields }, lines.join(String.fromCharCode(10)), { params: { ...fields, dueDate: fields.dueDate ?? '', note: fields.note ?? '' }, assigneeLabel },
    input.now().getTime() + STAGED_TTL_MS, { branchIds: fields.branchIds, recipientIds: fields.assigneeId === actor.id ? [] : [fields.assigneeId] });
}

const POLICY_TEXT = {
  unavailable: 'ไม่พบเอกสาร Policy ที่บัญชีนี้มีสิทธิ์อ่าน จึงไม่ได้เตรียมการรับทราบ',
  changed: 'เอกสาร Policy นี้มีเวอร์ชันใหม่แล้ว โปรดอ่านฉบับล่าสุดก่อน แล้วค่อยรับทราบเวอร์ชันนั้น จึงยังไม่ได้เตรียมรายการ',
  disabled: 'ฟังก์ชันรับทราบ Policy ยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ',
} as const;

async function policyAcknowledge(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { actor, step } = input, labels = labelsFor(step), policyAck = input.ports.effects?.policyAck;
  if (!policyAck) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: POLICY_TEXT.disabled }, labels);
  const policyId = str(step.params.policy?.value), version = str(step.params.version?.value);
  const checked = await policyAck.check(actor, { policyId, version });
  if (!checked.ok) {
    if (checked.code === 'policy_changed') return clarify(def.actionId, 'policy_changed', 'version', POLICY_TEXT.changed, labels);
    return fail(def.actionId, 'denied', checked.code === 'permission_denied' ? deniedPermission : { code: 'policy_unavailable', text: POLICY_TEXT.unavailable }, labels);
  }
  const { doc, existing } = checked;
  // Idempotent per actor + policy + version: an existing acknowledgement is reported, never duplicated.
  if (existing) return { outcome: 'updated', actionId: def.actionId, labels, ids: {}, undo: null,
    text: `คุณรับทราบ Policy “${doc.title}” เวอร์ชัน ${doc.version} แล้วเมื่อ ${existing.acknowledgedAt.slice(0, 10)} จึงไม่ต้องทำซ้ำ` };
  const preview = `รับทราบ Policy “${doc.title}” เวอร์ชัน ${doc.version} (อัปเดต ${doc.updatedAt.slice(0, 10)}) — บันทึกว่าคุณอ่านและรับทราบเอกสารฉบับนี้`;
  return stage(input, def, actor, step, { policyId: doc.id, version: doc.version }, preview,
    { params: { policyId: doc.id, version: doc.version }, title: doc.title }, input.now().getTime() + STAGED_TTL_MS, {});
}

async function monitorLifecycle(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, labels = labelsFor(step);
  const manage = ports.effects?.manageMonitor;
  if (!manage) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันเฝ้าติดตามยังไม่เปิดใช้งาน จึงไม่ได้ดำเนินการ' }, labels);
  const op = str(step.params.operation?.value) as 'pause' | 'resume' | 'delete' | 'rename';
  if (!['pause', 'resume', 'delete', 'rename'].includes(op)) return clarify(def.actionId, 'operation_missing', 'operation', 'โปรดระบุว่าต้องการหยุดชั่วคราว เริ่มต่อ เปลี่ยนชื่อ หรือลบ Monitor', labels);
  const monitorId = str(step.params.monitor?.value);
  if (op === 'rename') {
    // Display title only, owner + row-version CAS: the same lib/monitors/direct.ts rule as the Monitor page (written with the turn).
    const title = str(step.params.title?.value);
    if (!title) return clarify(def.actionId, 'missing_param', 'params.title', 'โปรดระบุชื่อใหม่ของ Monitor', labels);
    if (!ports.effects?.renameMonitor) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ยังเปลี่ยนชื่อ Monitor จากแชทไม่ได้ในระบบนี้ จึงไม่ได้ดำเนินการ' }, labels);
    const renamed = await ports.effects.renameMonitor(actor, { monitorId, title });
    if (!renamed.ok) return fail(def.actionId, 'denied', { code: renamed.code, text: renamed.text }, labels);
    return { outcome: 'updated', actionId: def.actionId, labels, ids: {}, text: renamed.text, undo: null };
  }
  if (op === 'delete') {
    // Deleting stops alerts for good: confirm-tier. pause/resume stay direct (owner-private, reversible).
    const mine = ports.effects?.findMonitor ? await ports.effects.findMonitor(actor, monitorId) : (await ports.effects?.listMonitors?.(actor))?.find(m => m.id === monitorId);
    if (!mine) return fail(def.actionId, 'denied', { code: 'monitor_not_found', text: 'ไม่พบ Monitor ของคุณตามที่ระบุ จึงไม่ได้เตรียมการลบ' }, labels);
    return stage(input, def, actor, step, { monitorId, op }, `ลบ Monitor “${mine.title}” (จะไม่มีการแจ้งเตือนอีก)`,
      { params: { monitorId }, title: mine.title }, input.now().getTime() + STAGED_TTL_MS, {}, 'monitor.delete');
  }
  const r = await manage(actor, { monitorId, op });
  if (!r.ok) return fail(def.actionId, 'denied', { code: r.code, text: r.text }, labels);
  return { outcome: 'updated', actionId: def.actionId, labels, ids: {}, text: r.text, undo: null };
}

const DASHBOARD_ORGANIZE_TEXT: Record<DashboardOrganizeOp, (title: string) => string> = {
  pin: title => `ปักหมุด Dashboard “${title}” แล้ว`,
  unpin: title => `เลิกปักหมุด Dashboard “${title}” แล้ว`,
  archive: title => `เก็บ Dashboard “${title}” ถาวรแล้ว — นำกลับมาใช้ได้ทุกเมื่อ`,
  restore: title => `นำ Dashboard “${title}” กลับมาใช้แล้ว`,
  duplicate: title => `ทำสำเนา Dashboard “${title}” เป็น Dashboard ส่วนตัวใหม่แล้ว — ไม่รวมการแชร์ การปักหมุด และการเก็บถาวร`,
};
const DASHBOARD_ORGANIZE_OPS = Object.keys(DASHBOARD_ORGANIZE_TEXT) as DashboardOrganizeOp[];
const DASHBOARD_ORGANIZE_TITLE: Record<DashboardOrganizeOp, string> = {
  pin: 'ปักหมุด Dashboard', unpin: 'เลิกปักหมุด Dashboard', archive: 'เก็บ Dashboard ถาวร', restore: 'นำ Dashboard กลับมาใช้', duplicate: 'ทำสำเนา Dashboard',
};
/** G5: truthful no-change replies (the Dashboard is already in the requested state; nothing was written, so nothing is claimed). */
const DASHBOARD_UNCHANGED_TEXT: Record<Exclude<DashboardOrganizeOp, 'duplicate'>, (title: string) => string> = {
  pin: title => `Dashboard “${title}” ปักหมุดอยู่แล้ว — ไม่ได้เปลี่ยนแปลงอะไร`,
  unpin: title => `Dashboard “${title}” ไม่ได้ปักหมุดอยู่ — ไม่ได้เปลี่ยนแปลงอะไร`,
  archive: title => `Dashboard “${title}” อยู่ในรายการที่เก็บถาวรอยู่แล้ว — ไม่ได้เปลี่ยนแปลงอะไร`,
  restore: title => `Dashboard “${title}” ไม่ได้ถูกเก็บถาวร จึงไม่มีอะไรต้องนำกลับมา — ไม่ได้เปลี่ยนแปลงอะไร`,
};
/**
 * dashboard.manage (direct tier, owner-private): the target is the DASHBOARDS id the plan carries (never user text); the organization rules and
 * write are ConciergeService's own (ports.organizeDashboard), so the chat and the Dashboard page cannot diverge.
 */
async function dashboardOrganize(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, labels = labelsFor(step);
  if (!ports.organizeDashboard) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ยังจัดระเบียบ Dashboard จากแชทไม่ได้ในระบบนี้ จึงไม่ได้ดำเนินการ' }, labels);
  const op = str(step.params.operation?.value) as DashboardOrganizeOp;
  if (!DASHBOARD_ORGANIZE_OPS.includes(op)) return clarify(def.actionId, 'operation_missing', 'operation', 'โปรดระบุว่าต้องการปักหมุด เลิกปักหมุด เก็บถาวร นำกลับมา หรือทำสำเนา Dashboard', labels);
  const id = str(step.params.dashboard?.value);
  try {
    const done = await ports.organizeDashboard(actor, id, op);
    if (done.unchanged && op !== 'duplicate') return fail(def.actionId, 'denied', { code: 'dashboard_unchanged', text: DASHBOARD_UNCHANGED_TEXT[op](done.title) }, labels);
    const text = DASHBOARD_ORGANIZE_TEXT[op](done.title);
    const card: Omit<TurnReceiptCard, 'verifiedAt'> = { kind: 'dashboard_organize', title: DASHBOARD_ORGANIZE_TITLE[op], headline: text,
      fields: [{ label: 'Dashboard', value: done.title }, ...(op === 'duplicate' ? [{ label: 'Dashboard ใหม่', value: [...`สำเนา — ${done.title}`].slice(0, 120).join('') }] : [])] };
    return { outcome: 'updated', actionId: def.actionId, labels, ids: { dashboardId: done.dashboardId }, text, undo: null, card };
  } catch (error) {
    // Rule refusals (not found / not owner / deleted, permission, pin while archived, quota) are truthful no-effect answers.
    if (error instanceof DomainError) return fail(def.actionId, 'denied', { code: error.code.toLowerCase(), text: `ยังไม่ได้ดำเนินการ — ${error.message}` }, labels);
    throw error;
  }
}

const RESULT_OPS = ['rename', 'pin', 'unpin', 'archive', 'unarchive', 'save'] as const;
/** Results library ops (direct tier, owner-private): resolved by server id, executed by the same library functions as the Results page. */
async function resultLibrary(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, labels = labelsFor(step);
  if (!ports.results) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันคลังผลลัพธ์ยังไม่เปิดใช้งาน จึงไม่ได้ดำเนินการ' }, labels);
  const op = def.actionId === 'result.unarchive' ? 'unarchive' : str(step.params.operation?.value) as (typeof RESULT_OPS)[number];
  if (!RESULT_OPS.includes(op)) return clarify(def.actionId, 'operation_missing', 'operation', 'โปรดระบุว่าต้องการเปลี่ยนชื่อ ปักหมุด เก็บถาวร หรือบันทึกผลลัพธ์', labels);
  const title = str(step.params.title?.value);
  if (op === 'rename' && !title) return clarify(def.actionId, 'missing_param', 'params.title', 'โปรดระบุชื่อใหม่ของผลลัพธ์', labels);
  const ref = parseArtifactRef(str(step.params.artifact?.value));
  const r = await ports.results.apply(actor, { artifactId: ref.artifactId, ...(ref.revision ? { revision: ref.revision } : {}), op, ...(op === 'rename' ? { title } : {}), conversationId: input.conversationId });
  if (!r.ok) return fail(def.actionId, 'denied', { code: r.code, text: r.text }, labels);
  return { outcome: 'updated', actionId: def.actionId, labels, ids: {}, text: r.text, undo: null };
}

const TABLE_MONITOR_TEXT = 'Monitor ตั้งได้เฉพาะคำตอบผลงานสาขา (ยอดขายเทียบ Target) เท่านั้น — ข้อมูลสต็อก Incident และ Ticket ยังไม่มีเงื่อนไขแจ้งเตือนที่ลงทะเบียนไว้ จึงยังไม่ได้เตรียม Monitor โปรดเลือกคำตอบผลงานสาขา';

async function monitorCreate(input: Ctx, def: ActionDefinition): Promise<ActionExecResult> {
  const { ports, actor, step } = input, effects = ports.effects;
  const recipientIds = strs(step.params.recipientIds?.value);
  let queryStateId = str(step.params.query?.value), inTurn: AcceptedEvidence | TableAcceptedEvidence | undefined;
  if (queryStateId === '$step0') {
    const resolved = await input.stepState?.();
    if (!resolved) return clarify(def.actionId, 'query_unbound', 'query', 'ยังผูก Monitor กับคำตอบที่ตรวจสอบแล้วไม่ได้ — โปรดเลือกคำตอบผลงานสาขาที่ต้องการ', labelsFor(step));
    queryStateId = resolved.persistedId; inTurn = resolved.accepted;
  }
  const threshold = Number(step.params.threshold?.value);
  const labels = labelsFor(step);
  // The only registered monitor condition is sales below target. A table-dataset answer (stock, Incident, Ticket) has no registered threshold:
  // say so instead of installing something that cannot evaluate.
  if (inTurn ? isTableEvidence(inTurn) : queryStateId.startsWith('table-state:')) return clarify(def.actionId, 'monitor_dataset_unsupported', 'query', TABLE_MONITOR_TEXT, labels);
  for (const id of recipientIds) if (!(await ports.recipientAllowed(actor, id))) return fail(def.actionId, 'denied', deniedRecipient, labels);
  if (!effects) return fail(def.actionId, 'denied', { code: 'effects_disabled', text: 'ฟังก์ชันเฝ้าติดตามยังไม่เปิดใช้งาน จึงไม่ได้เตรียมรายการ' }, labels);
  const bound = await effects.monitor(actor, { queryStateId, recipientIds, ...(inTurn ? { inTurn } : {}) });
  if (!bound) return clarify(def.actionId, 'query_unbound', 'query', 'ยังผูก Monitor กับคำตอบที่ตรวจสอบแล้วไม่ได้ — โปรดเลือกคำตอบผลงานสาขาที่ต้องการ', labels);
  const canonical = { query: bound.query.id, threshold, recipientIds: [...recipientIds].sort(), cadenceId: 'daily', conditionId: 'sales_below_target' };
  const plan: MonitorPlan = { version: 1, queryPlan: bound.query, conditionId: 'sales_below_target', threshold, cadenceId: 'daily', recipientIds,
    cooldownId: 'one_day', dedupeKey: idemKey('mon', { actor: actor.id, canonical }), authorization: authorizationRef(bound.context),
    consent: bound.consent, contentClaimIds: bound.contentClaimIds, approvalRequired: true, lifecycle: 'active' };
  const r = runMonitorPlan({ request: { phase: 'preview', plan }, context: bound.context });
  if (r.outcome !== 'accepted') return mapEffectFailure(def.actionId, r.outcome, r.code, labels);
  const state = r.value.state;
  // Honest delivery statement: the daily check alerts the owner AND the named recipients in their own in-app inbox. Each person's
  // authority is re-read inside the delivery transaction; a change in anyone's authority pauses the monitor instead of alerting.
  const pct = Math.round(threshold * 10000) / 100;
  const others = recipientIds.filter(id => id !== actor.id).map(id => bound.context.recipients.find(x => x.ref.id === id)?.name ?? 'ผู้รับที่ระบุ');
  const preview = [
    `เฝ้าติดตามยอดขายเทียบ Target ของสาขาในคำตอบที่เลือก ตรวจวันละครั้งเวลาประมาณ 08:00 น. และแจ้งเมื่อยอดขายต่ำกว่า ${pct}% ของ Target (แจ้งซ้ำไม่เกินวันละครั้ง)`,
    `การแจ้งเตือนจะเข้ากล่องข้อความในแอปของคุณ${others.length ? ` และของ ${others.join(', ')}` : ''} — ระบบตรวจสิทธิ์ของแต่ละคนใหม่ทุกครั้งก่อนแจ้ง และหยุด Monitor หากสิทธิ์หรือขอบเขตของใครเปลี่ยน`,
  ].join(String.fromCharCode(10));
  return stage(input, def, actor, step, canonical, preview, { params: { recipientIds, queryStateId, threshold }, state },
    input.now().getTime() + STAGED_TTL_MS, { recipientIds });
}

// ---------------------------------------------------------------- confirm path (called by U9 for user confirmation)

export type ConfirmResult =
  | { outcome: 'executed'; actionId: string; text: string; ids: ActionIds; verified: true }
  | { outcome: 'denied' | 'failed'; actionId: string; code: string; text: string };

/**
 * Persisted, user-readable receipt of a verified staged effect (stored beside the proposal result; never carries preview tokens,
 * workflow state or other recipients' details). The sender reads it from the receipts list.
 */
export interface StagedReceipt {
  kind: string; title: string; headline: string; verifiedAt: string;
  recipients?: { name: string; status: 'delivered' }[];
  artifact?: { title: string; revision: number; kind: string };
  lines?: string[]; fields?: { label: string; value: string }[]; content?: string;
}
export function makeReceipt(now: Date, kind: string, title: string, headline: string, extra: Partial<Omit<StagedReceipt, 'kind' | 'title' | 'headline' | 'verifiedAt'>> = {}): StagedReceipt {
  return { kind, title, headline, verifiedAt: now.toISOString(), ...extra };
}

export interface ConfirmInput { ports: ActionPorts; actor: Actor; proposalId: string; now: () => Date }

/** Confirm one proposal (built-in PendingAction or staged effect): preview -> confirm -> execute -> verify. */
export async function confirmProposal(input: ConfirmInput): Promise<ConfirmResult> {
  const { ports } = input;
  const actor = await ports.reloadActor(input.actor);
  if (!actor.active) return { outcome: 'denied', actionId: 'unknown', code: 'permission_denied', text: deniedPermission.text };
  const found = await ports.staged.get(actor, input.proposalId);
  if (!found) {
    const receipt = await ports.confirmPending(actor, input.proposalId);
    return receipt.status === 'verified_success'
      ? { outcome: 'executed', actionId: String(receipt.kind), verified: true, text: 'ดำเนินการและตรวจผลแล้ว', ids: { pendingActionId: input.proposalId, receiptId: receipt.id, ...('dashboardId' in receipt && receipt.dashboardId ? { dashboardId: receipt.dashboardId } : {}) } }
      : { outcome: 'failed', actionId: String(receipt.kind), code: 'unverified', text: 'ยังยืนยันผลการดำเนินการไม่ได้ กรุณาตรวจสถานะในประวัติ' };
  }
  const staged: StagedProposal = found;
  const bad = (code: string, text: string, outcome: 'denied' | 'failed' = 'denied'): ConfirmResult => ({ outcome, actionId: staged.actionId, code, text });
  if (staged.actorId !== actor.id) return bad('not_owner', 'ไม่พบรายการที่ยืนยันได้');
  // A retry of an already-executed proposal returns the stored result (idempotent), never `not_pending`.
  if (staged.status === 'completed') {
    const stored = staged.data.result as { text?: unknown; ids?: ActionIds } | undefined;
    if (typeof stored?.text === 'string') return { outcome: 'executed', actionId: staged.actionId, text: stored.text, ids: { ...(stored.ids ?? {}), pendingActionId: staged.id }, verified: true };
    return bad('not_pending', 'รายการนี้ไม่อยู่ในสถานะรอยืนยันแล้ว');
  }
  const nowMs = input.now().getTime();
  // A claim is a lease: only an EXPIRED lease (crashed confirmer) is reclaimable; the effect steps below are idempotent.
  const reclaimed = staged.status === 'claimed' && (staged.claimExpiresAt ?? 0) <= nowMs;
  if (staged.status !== 'pending' && !reclaimed) return bad('not_pending', 'รายการนี้ไม่อยู่ในสถานะรอยืนยันแล้ว');
  if (staged.expiresAt <= nowMs) { await ports.staged.save(actor, staged.id, { status: 'stale' }).catch(() => undefined); return bad('expired', 'รายการหมดอายุแล้ว — โปรดขอใหม่'); }
  // Mode fence: a proposal made in another mode is never executable. The same actor may confirm from another login (session)
  // in that mode; the CREATING session's mode revision is re-checked in the claim transaction and again inside the effect
  // transaction (assertStagedFence). From the creating session itself the revision must match here too.
  if (staged.mode !== undefined && !sameModeFence(staged, actor)) {
    await ports.staged.save(actor, staged.id, { status: 'stale' }).catch(() => undefined);
    return bad('mode_changed', 'โหมดเปลี่ยนแล้ว รายการนี้ใช้ไม่ได้ — โปรดขอใหม่');
  }
  // Completed-turn proof (same as built-in pending actions): an orphan from a failed/unfinished turn is never executable.
  if (ports.stagedTurnCompleted && !(await ports.stagedTurnCompleted(actor, staged))) return bad('turn_not_completed', 'ไม่พบรายการที่ยืนยันได้');
  // dashboard.refine is a router-internal staged action (not planner-facing): its authority is the dashboard builder + read permissions.
  if (!stagedHoldsPermissions(staged.actionId, actor.permissions)) return bad('permission_denied', deniedPermission.text);
  // Claim (pending -> claimed with a lease + random claim token, CAS on revision): only the claimant executes; a concurrent confirm stops here.
  const claim = await ports.staged.claim(actor, staged.id);
  if (!claim) {
    // The claim transaction stales a proposal whose creating session left its mode (or cannot be verified): say so.
    const after = await ports.staged.get(actor, staged.id).catch(() => undefined);
    if (after?.status === 'stale') return bad('mode_changed', 'โหมดเปลี่ยนแล้วหรือตรวจสอบเซสชันที่สร้างรายการไม่ได้ รายการนี้ใช้ไม่ได้ — โปรดขอใหม่');
    return bad('not_pending', 'รายการนี้กำลังดำเนินการหรือไม่อยู่ในสถานะรอยืนยันแล้ว');
  }
  const claimToken = claim.claimToken;
  const tokenPatch = claimToken ? { claimToken } : {};
  const ids: ActionIds = { pendingActionId: staged.id };
  /** A superseded claimant never overwrites the newer claim: it re-reconciles from the stored row instead. */
  const reconcile = async (): Promise<ConfirmResult> => {
    const row = await ports.staged.get(actor, staged.id);
    const stored = row?.status === 'completed' ? row.data.result as { text?: unknown; ids?: ActionIds } | undefined : undefined;
    if (typeof stored?.text === 'string') return { outcome: 'executed', actionId: staged.actionId, text: stored.text, ids: { ...(stored.ids ?? {}), pendingActionId: staged.id }, verified: true };
    return bad('claim_lost', 'รายการนี้ถูกดำเนินการหรือยกเลิกโดยคำขออื่นแล้ว — โปรดตรวจสถานะแล้วลองใหม่');
  };
  const isClaimLost = (error: unknown) => hasCode(error, 'STAGED_CLAIM_LOST') || hasCode(error, 'STAGED_CONFLICT');
  const done = async (text: string, data?: Record<string, unknown>): Promise<ConfirmResult> => {
    try { await ports.staged.save(actor, staged.id, { status: 'completed', data: { ...(data ?? staged.data), result: { text, ids } }, ...tokenPatch }); }
    catch (error) { if (isClaimLost(error)) return reconcile(); throw error; }
    return { outcome: 'executed', actionId: staged.actionId, text, ids, verified: true };
  };
  const fenced = async (): Promise<ConfirmResult | undefined> => {
    // Just before the effect: the claim must still be ours and the session mode unchanged since the proposal was made.
    const current = await ports.staged.get(actor, staged.id);
    if (!current || current.status !== 'claimed' || (claimToken !== undefined && current.claimToken !== claimToken)) return reconcile();
    const latest = await ports.reloadActor(actor);
    if (!latest.active) { await ports.staged.save(actor, staged.id, { status: 'stale', ...tokenPatch }).catch(() => undefined); return bad('permission_denied', deniedPermission.text); }
    if (staged.mode !== undefined && !sameModeFence(staged, latest)) {
      await ports.staged.save(actor, staged.id, { status: 'stale', ...tokenPatch }).catch(() => undefined);
      return bad('mode_changed', 'โหมดเปลี่ยนแล้ว รายการนี้ใช้ไม่ได้ — โปรดขอใหม่');
    }
    return undefined;
  };
  try {
    const blocked = await fenced();
    if (blocked) return blocked;
    const result = await executeClaimed();
    // A claimed proposal that did not execute is terminal (stale); the user asks again for a fresh preview.
    if (result.outcome !== 'executed') await ports.staged.save(actor, staged.id, { status: 'stale', ...tokenPatch }).catch(() => undefined);
    return result;
  } catch (error) {
    await ports.staged.save(actor, staged.id, { status: 'stale', ...tokenPatch }).catch(() => undefined);
    throw error;
  }

  async function executeClaimed(): Promise<ConfirmResult> {
  const params = (staged.data.params ?? {}) as Record<string, unknown>;
  // Effects bound at preview are session-bound (Wave 4 preview/operation keys, evidence ledger): a confirm from another
  // login of the same actor executes under the creating session's identity; authority/permissions are this actor's fresh ones.
  const effectActor: Actor = staged.sessionId && staged.mode !== undefined && staged.modeRevision !== undefined
    ? { ...actor, sessionId: staged.sessionId, mode: staged.mode, modeRevision: staged.modeRevision } : actor;
  const fence = async (tx: Transaction) => assertStagedFence(tx, { proposalId: staged.id, actorId: actor.id, claimToken, currentSessionId: actor.sessionId });
  const effectFailure = async (error: unknown): Promise<ConfirmResult> => {
    if (isClaimLost(error)) return reconcile();
    if (hasCode(error, STAGED_MODE_CHANGED_CODE)) return bad('mode_changed', 'โหมดเปลี่ยนแล้ว รายการนี้ใช้ไม่ได้ — โปรดขอใหม่');
    if (hasCode(error, AUTHORITY_CHANGED_CODE)) return bad('authority_changed', 'สิทธิ์ ผู้รับ หรือขอบเขตเปลี่ยนไปแล้ว จึงไม่ได้ดำเนินการ — โปรดขอใหม่');
    throw error;
  };
  const baseRevision = typeof staged.data.baseRevision === 'string' ? staged.data.baseRevision : undefined;
  const guard = { allowShared: true, fence, ...(baseRevision ? { expectedRevision: baseRevision } : {}) };

  if (staged.actionId === 'dashboard.delete') {
    const dashboardId = String(params.dashboardId);
    const dashboard = await ports.getDashboard(actor, dashboardId);
    if (reclaimed && dashboard && dashboard.ownerId === actor.id && dashboard.deleted) return done(`ลบ Dashboard “${dashboard.title}” แล้ว`);
    if (!dashboard || dashboard.ownerId !== actor.id || dashboard.deleted) return bad('dashboard_denied', 'ไม่พบ Dashboard ของคุณตามที่ระบุ');
    if (dashboard.shared) return bad('dashboard_shared', 'Dashboard นี้ถูกแชร์ให้ผู้อื่นแล้ว ลบไม่ได้');
    try { await ports.deleteDashboard(actor, dashboardId, { fence }); }
    catch (error) { return effectFailure(error); }
    const after = await ports.getDashboard(actor, dashboardId);
    if (after && !after.deleted) return bad('delete_unverified', 'ยังยืนยันไม่ได้ว่าลบสำเร็จ', 'failed');
    return done(`ลบ Dashboard “${dashboard.title}” แล้ว`);
  }
  if (staged.actionId === 'dashboard.revoke_share') {
    if (!ports.revokeDashboardShare) return bad('effects_disabled', 'ยังจัดการการแชร์ Dashboard จากแชตไม่ได้ จึงไม่มีการเปลี่ยนแปลง');
    const dashboardId = String(params.dashboardId), shareId = String(params.shareId);
    let result: { shareId: string; alreadyRevoked: boolean };
    try { result = await ports.revokeDashboardShare(actor, dashboardId, shareId, { fence }); }
    catch (error) { return effectFailure(error); }
    if (result.shareId !== shareId) return bad('revoke_unverified', 'ยังยืนยันไม่ได้ว่าเพิกถอนการแชร์สำเร็จ', 'failed');
    const title = String(params.dashboardTitle ?? 'Dashboard'), recipient = String(params.recipientName ?? 'ผู้รับ');
    const text = result.alreadyRevoked
      ? `การแชร์ Dashboard “${title}” ให้ ${recipient} ถูกเพิกถอนไปแล้ว`
      : `เพิกถอนการแชร์ Dashboard “${title}” ให้ ${recipient} แล้ว`;
    return done(text, { ...staged.data, revocation: { alreadyRevoked: result.alreadyRevoked } });
  }
  if (staged.actionId === 'dashboard.refine') {
    const dashboardId = String(params.dashboardId);
    const dashboard = await ports.getDashboard(actor, dashboardId);
    if (!dashboard || dashboard.ownerId !== actor.id || dashboard.deleted) return bad('dashboard_denied', 'ไม่พบ Dashboard ของคุณตามที่ระบุ');
    const spec = staged.data.spec as DashboardSpec | undefined;
    if (!spec || !ports.updateDashboardSpec) return bad('refine_unavailable', 'ยังปรับ Dashboard นี้ไม่ได้ในตอนนี้');
    if (reclaimed && dashboard.revision === specRevision(spec)) return done(`ปรับ Dashboard “${dashboard.title}” แล้ว และตรวจผลเรียบร้อย`);
    try { await ports.updateDashboardSpec(actor, dashboardId, spec, guard); }
    catch (error) { if (hasCode(error, DASHBOARD_CHANGED_CODE)) return bad('dashboard_changed', CHANGED_TEXT); return effectFailure(error); }
    const after = await ports.getDashboard(actor, dashboardId);
    if (!after?.spec || after.spec.widgets.length !== spec.widgets.length) return bad('refine_unverified', 'ยังยืนยันไม่ได้ว่าปรับ Dashboard สำเร็จ', 'failed');
    return done(`ปรับ Dashboard “${after.title}” แล้ว และตรวจผลเรียบร้อย`);
  }
  if (staged.actionId === 'dashboard.rename') {
    const dashboardId = String(params.dashboardId), title = String(params.title);
    const dashboard = await ports.getDashboard(actor, dashboardId);
    if (!dashboard || dashboard.ownerId !== actor.id || dashboard.deleted) return bad('dashboard_denied', 'ไม่พบ Dashboard ของคุณตามที่ระบุ');
    if (reclaimed && dashboard.title === title) return done(`เปลี่ยนชื่อ Dashboard เป็น “${title}” แล้ว`);
    try { await ports.renameDashboard(actor, dashboardId, { title }, guard); }
    catch (error) { if (hasCode(error, DASHBOARD_CHANGED_CODE)) return bad('dashboard_changed', CHANGED_TEXT); return effectFailure(error); }
    const after = await ports.getDashboard(actor, dashboardId);
    if (after?.title !== title) return bad('rename_unverified', 'ยังยืนยันไม่ได้ว่าเปลี่ยนชื่อสำเร็จ', 'failed');
    return done(`เปลี่ยนชื่อ Dashboard เป็น “${title}” แล้ว`);
  }
  if (staged.actionId === 'monitor.delete') {
    const manage = ports.effects?.manageMonitor;
    if (!manage) return bad('effects_disabled', 'ฟังก์ชันเฝ้าติดตามยังไม่เปิดใช้งาน');
    let r: Awaited<ReturnType<typeof manage>>;
    try { r = await manage(effectActor, { monitorId: String(params.monitorId), op: 'delete' }, { fence }); }
    catch (error) { return effectFailure(error); }
    if (!r.ok) return reclaimed && r.code === 'monitor_not_found' ? done('ลบ Monitor แล้ว จะไม่มีการแจ้งเตือนอีก') : bad(r.code, r.text);
    return done(r.text);
  }
  const effects = ports.effects;
  if (!effects) return bad('effects_disabled', 'ฟังก์ชันนี้ยังไม่เปิดใช้งาน');
  if (isDirectorActionId(staged.actionId)) {
    // HR Director: fresh V2 re-binding, then the Workflow V2 prepare/confirm/execute/verify runtime, then an independent readback.
    let r: Awaited<ReturnType<typeof confirmDirectorAction>>;
    try { r = await confirmDirectorAction({ port: effects.directorWorkflow, actor: effectActor, staged, reclaimed, fence, now: input.now,
      receipt: (kind, title, headline, extra) => makeReceipt(input.now(), kind, title, headline, extra) }); }
    catch (error) { return effectFailure(error); }
    return r.ok ? done(r.text, r.data) : bad(r.code, r.text, r.outcome);
  }
  const recipientIds = (Array.isArray(params.recipientIds) ? params.recipientIds : []).map(String);
  for (const id of recipientIds) if (!(await ports.recipientAllowed(actor, id))) return bad('recipient_denied', deniedRecipient.text);
  const phases = ['confirm', 'execute', 'verify'] as const;

  if (staged.actionId === 'task.create') {
    const work = effects.workItems;
    if (!work) return bad('effects_disabled', 'ฟังก์ชันสร้างงานยังไม่เปิดใช้งาน');
    const parsedFields = taskFieldsSchema.safeParse({ ...params, dueDate: params.dueDate ? params.dueDate : null, note: params.note ? params.note : null });
    if (!parsedFields.success) return bad('task_fields', 'ข้อมูลงานที่เตรียมไว้ไม่ถูกต้อง — โปรดขอใหม่');
    const fields: TaskFields = parsedFields.data;
    let made: Awaited<ReturnType<typeof work.create>>;
    try { made = await work.create(effectActor, { fields, proposalId: staged.id, fence }); }
    catch (error) { return effectFailure(error); }
    const text = `สร้างงาน “${fields.title}” แล้ว ${made.items.length} รายการ และตรวจผลในรายการงานแล้ว`;
    return done(text, { ...staged.data, receipt: makeReceipt(input.now(), 'task', 'สร้างงานติดตาม', text, { fields: [
      { label: 'ความสำคัญ', value: PRIORITY_TEXT[fields.priority] }, ...(fields.dueDate ? [{ label: 'ครบกำหนด', value: fields.dueDate }] : []),
      { label: 'การจัดกลุ่ม', value: fields.grouping === 'per_branch' ? 'แยกเป็นรายสาขา' : 'งานเดียว' }, ...(fields.checklist.length ? [{ label: 'รายการตรวจ', value: fields.checklist.join(' / ') }] : []),
      { label: 'ผู้รับผิดชอบ', value: made.assigneeName }, ...(fields.note ? [{ label: 'หมายเหตุ', value: fields.note }] : [])],
    lines: made.items.map(item => item.title), ...(made.notified ? { recipients: [{ name: made.assigneeName, status: 'delivered' as const }] } : {}) }) });
  }

  if (staged.actionId === 'policy.acknowledge') {
    const ack = effects.policyAck;
    if (!ack) return bad('effects_disabled', 'ฟังก์ชันรับทราบ Policy ยังไม่เปิดใช้งาน');
    let r: Awaited<ReturnType<typeof ack.acknowledge>>;
    try { r = await ack.acknowledge(effectActor, { policyId: String(params.policyId), version: String(params.version), proposalId: staged.id, fence }); }
    catch (error) {
      if (hasCode(error, 'POLICY_CHANGED')) return bad('policy_changed', 'เอกสาร Policy เปลี่ยนเวอร์ชันแล้ว จึงไม่ได้บันทึกการรับทราบ — โปรดอ่านฉบับล่าสุดแล้วขอใหม่');
      return effectFailure(error);
    }
    const text = r.already ? `คุณรับทราบ Policy “${r.row.policyTitle}” เวอร์ชัน ${r.row.policyVersion} ไว้แล้ว — ตรวจพบบันทึกเดิม ไม่บันทึกซ้ำ`
      : `บันทึกการรับทราบ Policy “${r.row.policyTitle}” เวอร์ชัน ${r.row.policyVersion} แล้ว และตรวจผลที่บันทึกแล้ว`;
    return done(text, { ...staged.data, receipt: makeReceipt(input.now(), 'policy_acknowledgement', 'รับทราบ Policy', text, { fields: [
      { label: 'เอกสาร', value: r.row.policyTitle }, { label: 'รหัสเอกสาร', value: r.row.policyId }, { label: 'เวอร์ชัน', value: r.row.policyVersion },
      { label: 'รับทราบเมื่อ', value: r.row.acknowledgedAt }], lines: ['ตรวจพบบันทึกว่าคุณรับทราบเอกสารฉบับนี้แล้ว โดยไม่บันทึกซ้ำ'] }) });
  }

  if (staged.actionId === 'artifact.share') {
    const share = effects.artifactShare;
    if (!share) return bad('effects_disabled', 'ฟังก์ชันแชร์ผลลัพธ์ยังไม่เปิดใช้งาน');
    let r: Awaited<ReturnType<typeof share.deliver>>;
    try {
      r = await share.deliver(effectActor, { artifactId: String(params.artifactId), revision: Number(params.revision), recipientIds,
        bindingDigest: String(staged.data.bindingDigest), proposalId: staged.id, fence });
    } catch (error) { return effectFailure(error); }
    if (!r.ok) return bad(r.code, r.text);
    const text = `แชร์ผลลัพธ์ “${r.artifact.title}” (ฉบับที่ ${r.artifact.revision}) ให้ผู้รับ ${r.delivered.length} ราย และตรวจผลในกล่องข้อความของผู้รับแล้ว`;
    return done(text, { ...staged.data, receipt: makeReceipt(input.now(), 'artifact_share', 'แชร์ผลลัพธ์', text, { recipients: r.delivered.map(d => ({ name: d.recipientName, status: 'delivered' as const })),
      artifact: { title: r.artifact.title, revision: r.artifact.revision, kind: r.artifact.kind }, lines: ['ผู้รับเปิดดูได้อย่างเดียวและระบบตรวจสิทธิ์ซ้ำทุกครั้งที่เปิด'] }) });
  }

  if (staged.actionId === 'communication.send') {
    const bound = await effects.communication(effectActor, { recipientIds, contentStateId: String(params.contentStateId) });
    if (!bound) return bad('content_unbound', 'ข้อมูลที่ใช้ส่งเปลี่ยนไปแล้ว — โปรดขอใหม่');
    const boundArtifactData = staged.data.artifact as { id: string; revision: number; title: string } | undefined;
    let openArtifact: { digest: string; kind: string; bindingDigest: string } | undefined;
    if (boundArtifactData) {
      // Fresh authorization of sender and every recipient for the attached artifact version at confirm.
      const again = await effects.artifactShare?.bind(effectActor, { artifactId: boundArtifactData.id, recipientIds, revision: boundArtifactData.revision });
      if (!again?.ok || again.binding.bindingDigest !== staged.data.artifactBindingDigest) return bad('authority_changed', 'สิทธิ์ ผู้รับ หรือผลลัพธ์ที่แนบเปลี่ยนไปแล้ว จึงไม่ได้ส่ง — โปรดขอใหม่');
      if (again.binding.artifact.id !== boundArtifactData.id || again.binding.artifact.revision !== boundArtifactData.revision) return bad('authority_changed', 'ผลลัพธ์ที่แนบเปลี่ยนไปแล้ว จึงไม่ได้ส่ง — โปรดขอใหม่');
      openArtifact = { digest: again.binding.artifact.digest, kind: again.binding.artifact.kind, bindingDigest: again.binding.bindingDigest };
    }
    let workflow = staged.data.workflow as Workflow<CommunicationPlan>;
    let inbox: EffectRecord[] = bound.inbox;
    const context = { ...bound.context, now: input.now().getTime() };
    if (context.now >= workflow.preview.expiresAt) {
      // Only the 10 min preview token lapsed; the 24 h proposal is live. Re-preview the stored plan and require identical intent.
      const re = runCommunicationPlan({ request: { phase: 'preview', plan: workflow.preview.plan }, context, inbox });
      if (re.outcome !== 'accepted' || digest(re.value.workflow.preview.intent) !== digest(workflow.preview.intent)) return bad('target_or_content_changed', 'ข้อมูลที่ใช้ส่งเปลี่ยนไปแล้ว — โปรดขอใหม่');
      workflow = re.value.workflow;
    }
    for (const phase of phases) {
      const r = runCommunicationPlan({ request: { phase, workflow, expectedVersion: workflow.version, previewDigest: workflow.preview.digest }, context, inbox });
      if (r.outcome !== 'accepted') return bad(`${r.outcome}:${r.code}`, 'ยืนยันไม่สำเร็จ ยังไม่มีการส่งข้อความ', r.outcome === 'execution_failed' ? 'failed' : 'denied');
      workflow = r.value.workflow; inbox = [...r.value.inbox];
    }
    if (workflow.status !== 'verified') return bad('unverified', 'ยังตรวจไม่พบข้อความในกล่องข้อความของผู้รับ', 'failed');
    try { await effects.commitInbox(effectActor, inbox, { authority: context.authority, recipients: context.recipients, fence, ...(boundArtifactData ? { boundArtifact: boundArtifactData } : {}), ...(openArtifact ? { openArtifact } : {}) }); }
    catch (error) { return effectFailure(error); }
    const sentText = `ส่งข้อความถึงผู้รับ ${recipientIds.length} ราย (กล่องข้อความจำลอง) และตรวจผลแล้ว`;
    // Persisted receipt: only the recipients the sender chose, the delivered content and the bound artifact version (never preview tokens).
    const receipt = makeReceipt(input.now(), 'communication', 'ส่งข้อความ', sentText, { recipients: context.recipients.filter(r => recipientIds.includes(r.ref.id)).map(r => ({ name: r.name, status: 'delivered' as const })),
      content: workflow.preview.intent.content, lines: ['ตรวจพบข้อความในกล่องข้อความของผู้รับแต่ละรายแล้ว', 'คำขอเดิมจะไม่ส่งข้อความซ้ำ'],
      ...(boundArtifactData ? { artifact: { title: boundArtifactData.title, revision: boundArtifactData.revision, kind: 'artifact' } } : {}) });
    return done(sentText, { ...staged.data, workflow, receipt });
  }

  const bound = await effects.monitor(effectActor, { queryStateId: String(params.queryStateId), recipientIds });
  if (!bound) return bad('query_unbound', 'คำตอบที่ใช้เฝ้าติดตามเปลี่ยนไปแล้ว — โปรดขอใหม่');
  let state = staged.data.state as MonitorState;
  const context = { ...bound.context, now: input.now().getTime() };
  if (context.now >= state.workflow.preview.expiresAt) {
    const re = runMonitorPlan({ request: { phase: 'preview', plan: state.workflow.preview.plan }, context });
    if (re.outcome !== 'accepted' || digest(re.value.state.workflow.preview.intent) !== digest(state.workflow.preview.intent)) return bad('target_or_content_changed', 'ข้อมูลที่ใช้เฝ้าติดตามเปลี่ยนไปแล้ว — โปรดขอใหม่');
    state = re.value.state;
  }
  for (const phase of phases) {
    const r = runMonitorPlan({ request: { phase, workflow: state.workflow, expectedVersion: state.workflow.version, previewDigest: state.workflow.preview.digest }, context, state });
    if (r.outcome !== 'accepted') return bad(`${r.outcome}:${r.code}`, 'สร้าง Monitor ไม่สำเร็จ', r.outcome === 'execution_failed' ? 'failed' : 'denied');
    state = r.value.state;
  }
  if (state.workflow.status !== 'verified') return bad('unverified', 'ยังตรวจไม่พบ Monitor ที่สร้าง', 'failed');
  try { await effects.commitMonitor(effectActor, staged.id, state, fence); }
  catch (error) { return effectFailure(error); }
  const installText = 'สร้าง Monitor แล้ว ระบบจะตรวจตามรอบรายวัน';
  return done(installText, { ...staged.data, state, receipt: makeReceipt(input.now(), 'monitor', 'สร้าง Monitor', installText, {
    // Installing a Monitor sends nothing: its alert recipients are listed as future recipients, never as "delivered".
    fields: [{ label: 'เงื่อนไข', value: `ยอดขายต่ำกว่า ${Math.round(state.workflow.preview.plan.threshold * 10000) / 100}% ของ Target` }, { label: 'ความถี่', value: 'ตรวจวันละครั้ง (แจ้งซ้ำไม่เกินวันละครั้ง)' },
      ...(() => { const names = bound.context.recipients.filter(r => recipientIds.includes(r.ref.id)).map(r => r.name); return names.length ? [{ label: 'ผู้รับเมื่อพบเงื่อนไข', value: names.join(', ') }] : []; })(),
      { label: 'การแจ้งเตือนที่ส่งแล้ว', value: 'ยังไม่มี — จะส่งเมื่อการตรวจพบเงื่อนไข' }],
    lines: ['ดูผลการตรวจแต่ละครั้งได้ในรายการ “Monitor ของฉัน”'] }) });
  }
}

export type { StagedProposal };
