import { z } from 'zod';
import { businessDateSchema } from '../contracts';
import { idSchema } from '../dynamic/plan/schemas';
import type { ActorActionDescriptor, PlannerContext } from './planner-context';
import { contextIdSchema, paramEnvelope, type ParamSource, type ParamValue } from './turn-plan';
import { getWorkflowActionAuthority } from '../workflows/action-authority';

export type ContextKind = 'dashboard' | 'monitor' | 'recipient' | 'pending_action' | 'accepted_state' | 'artifact' | 'measure' | 'widget_index' | 'policy' | 'policy_version' | 'archived_artifact'
  | 'review_queue' | 'onboarding_request' | 'onboarding_approval';
export type RiskTier = 'direct' | 'confirm';

export interface ParamSpec {
  value: z.ZodTypeAny;
  required: boolean;
  sources: readonly [ParamSource, ...ParamSource[]];
  /** user_quoted value must equal the located evidence span (audit-significant assertions). */
  verbatim?: boolean;
  /** Ids of this kind must exist in the planner context (checked for every source except default/generated). */
  contextKind?: ContextKind;
  /** Values are authorized region/branch ids; checked against the actor's scope, failure is `denied`. */
  scope?: 'region' | 'branch';
  /** Registry default, pure over the planner context. Absent params with a default are filled (labeled). */
  default?: (context: PlannerContext) => ParamValue;
  /**
   * G6: generated text that fails the model-text gate is dropped even though the param is required, because the executor writes its own
   * server copy when the param is absent (Email subject/body template). Without it a blocked REQUIRED value is asked again.
   */
  serverCopyWhenUnsafe?: boolean;
}

export interface ActionDefinition {
  actionId: string;
  description: string;
  riskTier: RiskTier;
  requiredPermissions: readonly string[];
  /** At least ONE of these must also be held (e.g. a policy library readable through different permissions per owner). */
  anyPermissions?: readonly string[];
  params: Readonly<Record<string, ParamSpec>>;
}

/** Handler contract. Implementations are injected later (U4/U9); U1 only defines the interface. */
export interface ActionHandlerInput {
  actionId: string;
  actorId: string;
  /** Validated, grounded param values by name. */
  params: Readonly<Record<string, ParamValue>>;
  stepIndex: number;
  signal?: AbortSignal;
}
export type ActionHandlerResult =
  | { outcome: 'prepared'; pendingActionId: string; text: string; labels: string[] }
  | { outcome: 'executed'; text: string; labels: string[] }
  | { outcome: 'clarify' | 'denied' | 'failed'; code: string; text: string };
export interface ActionHandler { actionId: string; run(input: ActionHandlerInput): Promise<ActionHandlerResult> }
export type ActionHandlerMap = ReadonlyMap<string, ActionHandler>;

const text = (max: number) => z.string().trim().min(1).max(max);
const ids = (max: number) => z.array(idSchema).min(1).max(max);
const FROM_USER_OR_CONTEXT = ['user_quoted', 'context_id', 'inherited'] as const;
const SCOPE_SOURCES = ['user_quoted', 'inherited', 'default'] as const;

const scopeParams = {
  regionIds: { value: ids(20), required: false, sources: SCOPE_SOURCES, scope: 'region', default: c => c.scope.regionIds },
  date: { value: businessDateSchema, required: false, sources: SCOPE_SOURCES, default: c => c.business.date },
} as const satisfies Record<string, ParamSpec>;

const MONITOR_PERMISSIONS = ['sales.read', 'dashboard.create'] as const;
/** HR Director decisions: the exact permission names the Workflow V2 closed action policy declares (never a second matrix). */
const v2Permissions = (kind: 'onboarding_director_approve' | 'onboarding_return'): string[] => {
  const authority = getWorkflowActionAuthority(kind);
  return [...authority.readPermissions, authority.permission];
};

/** Every required permission is held, and (when declared) at least one of the any-of permissions. */
export function holdsActionPermissions(definition: Pick<ActionDefinition, 'requiredPermissions' | 'anyPermissions'>, permissions: readonly string[]): boolean {
  return definition.requiredPermissions.every(p => permissions.includes(p))
    && (!definition.anyPermissions?.length || definition.anyPermissions.some(p => permissions.includes(p)));
}

export const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  // Tiers mirror lib/core/runtime-contracts.ts: private_reversible -> direct, everything else -> confirm.
  { actionId: 'dashboard.create', description: 'Create a private dashboard for the requested scope (owner-only, reversible)', riskTier: 'direct',
    requiredPermissions: ['dashboard.create'],
    params: { ...scopeParams,
      title: { value: text(120), required: false, sources: ['user_quoted', 'generated'] },
      measureIds: { value: ids(8), required: false, sources: ['user_quoted', 'context_id'], contextKind: 'measure' },
      // Evidence for a visualization plan: an accepted answer id from ACCEPTED_STATES, or '$step0' in a two-step plan.
      source: { value: contextIdSchema, required: false, sources: ['context_id', 'inherited'], contextKind: 'accepted_state' } } },
  { actionId: 'dashboard.share', description: 'Prepare sharing one of the actor-owned dashboards with one recipient', riskTier: 'confirm',
    requiredPermissions: ['dashboard.share'],
    params: {
      dashboard: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'dashboard' },
      recipientId: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'recipient' } } },
  { actionId: 'dashboard.revoke_share', description: 'Prepare revoking one active share of an owned dashboard', riskTier: 'confirm',
    requiredPermissions: ['sales.read'],
    params: {
      dashboard: { value: idSchema, required: true, sources: ['context_id'], contextKind: 'dashboard' },
      shareId: { value: idSchema, required: true, sources: ['context_id'] } } },
  { actionId: 'ticket.create', description: 'Prepare operations tickets for named branches, or for branches derived from an accepted answer (branchesFrom + branchesRule below_target|positive_value); optional priority, dueDate, grouping, checklist, note', riskTier: 'confirm',
    requiredPermissions: ['ticket.create'],
    params: { ...scopeParams,
      // Named branches, OR a derived set: branchesFrom = an accepted answer (ACCEPTED_STATES id or '$step0'); the server expands it to exact branch ids from that evidence.
      branchIds: { value: ids(12), required: false, sources: FROM_USER_OR_CONTEXT, scope: 'branch' },
      branchesFrom: { value: contextIdSchema, required: false, sources: ['context_id', 'inherited'], contextKind: 'accepted_state' },
      branchesRule: { value: z.enum(['below_target', 'positive_value']), required: false, sources: ['generated'] },
      priority: { value: z.enum(['low', 'normal', 'high', 'urgent']), required: false, sources: ['user_quoted', 'generated', 'default'], default: () => 'normal' },
      dueDate: { value: businessDateSchema, required: false, sources: ['user_quoted'] },
      grouping: { value: z.enum(['single', 'per_branch']), required: false, sources: ['user_quoted', 'generated', 'default'], default: () => 'per_branch' },
      checklist: { value: z.array(text(120)).min(1).max(8), required: false, sources: ['user_quoted', 'generated'] },
      note: { value: text(300), required: false, sources: ['user_quoted', 'generated'] } } },
  { actionId: 'badge.revoke', description: 'Prepare revoking one employee badge with the user stated reason', riskTier: 'confirm',
    requiredPermissions: ['badge.revoke'],
    params: {
      badgeId: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT },
      employeeId: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT },
      reason: { value: text(500), required: true, sources: ['user_quoted'], verbatim: true } } },
  // communication.send / monitor.* are enabled on existing profile permissions (no profile migration): messaging follows the
  // dashboard-share grant; monitors need the sales read + own-artifact creation grants. lib/router/ports maps them to the
  // capability names the Wave 4 modules check.
  { actionId: 'communication.send', description: 'Prepare a simulated inbox message carrying an accepted answer', riskTier: 'confirm',
    requiredPermissions: ['dashboard.share'],
    params: {
      channelId: { value: z.literal('simulated_inbox'), required: false, sources: ['default'], default: () => 'simulated_inbox' },
      recipientIds: { value: ids(20), required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'recipient' },
      content: { value: contextIdSchema, required: true, sources: ['context_id', 'inherited'], contextKind: 'accepted_state' },
      // Optional: bind the message to one exact artifact version from ARTIFACTS (every recipient must be authorized for its whole scope).
      artifact: { value: idSchema, required: false, sources: FROM_USER_OR_CONTEXT, contextKind: 'artifact' } } },
  // recipientIds is optional: the owner ALWAYS receives the alert of their own monitor (monitor-runner audienceOf), so an omitted list is an
  // owner-only monitor ("notify me") and listed recipients are additional people. Still confirm-tier (a standing, recurring effect).
  { actionId: 'monitor.create', description: 'Prepare a daily monitor on an accepted branch performance answer; the owner always gets the alert, recipientIds = OPTIONAL extra people (omit for "notify me")', riskTier: 'confirm',
    requiredPermissions: MONITOR_PERMISSIONS,
    params: {
      query: { value: contextIdSchema, required: true, sources: ['context_id', 'inherited'], contextKind: 'accepted_state' },
      conditionId: { value: z.literal('sales_below_target'), required: false, sources: ['default'], default: () => 'sales_below_target' },
      threshold: { value: z.number().finite().gt(0).max(1), required: true, sources: ['user_quoted'] },
      cadenceId: { value: z.literal('daily'), required: false, sources: ['default'], default: () => 'daily' },
      recipientIds: { value: ids(20), required: false, sources: FROM_USER_OR_CONTEXT, contextKind: 'recipient' } } },
  // Owner-private monitor lifecycle (pause / resume / rename / delete): applied directly, no recipients are involved. Rename changes the display
  // title only (the condition, recipients and cadence need a new, re-approved Monitor), with the same owner + row-version CAS as the UI route.
  { actionId: 'monitor.manage', description: 'Pause/resume/rename (params.title = new display title only) an owned MONITORS entry; delete is staged for the owner confirmation', riskTier: 'direct',
    requiredPermissions: MONITOR_PERMISSIONS,
    params: {
      monitor: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'monitor' },
      operation: { value: z.enum(['pause', 'resume', 'delete', 'rename']), required: true, sources: ['generated'] },
      title: { value: text(120), required: false, sources: ['user_quoted', 'generated'] } } },
  // Results library (owner-private, reversible => direct): the SAME lib/artifacts/library.ts operations as the Results page. The Result is addressed by an
  // ARTIFACTS id (never an archived one); unarchive addresses an ARCHIVED_ARTIFACTS id. Rename changes the display title only (evidence is never touched).
  { actionId: 'result.manage', description: 'Rename the display title of / pin / unpin / archive / save one actor-owned ARTIFACTS Result (library metadata only)', riskTier: 'direct',
    requiredPermissions: ['dashboard.create'],
    params: {
      artifact: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'artifact' },
      operation: { value: z.enum(['rename', 'pin', 'unpin', 'archive', 'save']), required: true, sources: ['generated'] },
      title: { value: text(140), required: false, sources: ['user_quoted', 'generated'] } } },
  { actionId: 'result.unarchive', description: 'Restore one ARCHIVED_ARTIFACTS Result to the active library', riskTier: 'direct',
    requiredPermissions: ['dashboard.create'],
    params: { artifact: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'archived_artifact' } } },
  { actionId: 'dashboard.rename', description: 'Rename one saved actor-owned dashboard (private label edit)', riskTier: 'direct',
    requiredPermissions: ['sales.read'],
    params: {
      dashboard: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'dashboard' },
      title: { value: text(120), required: true, sources: ['user_quoted', 'generated'] } } },
  { actionId: 'dashboard.delete', description: 'Prepare deleting one saved, unshared actor-owned dashboard', riskTier: 'confirm',
    requiredPermissions: ['dashboard.create'],
    params: { dashboard: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'dashboard' } } },
  // Artifact sharing (Wave 3 module wired): confirm-tier, staged in router_proposals. Sender AND every recipient are reauthorized for
  // the artifact's WHOLE stored scope at prepare, at confirm and inside the delivery transaction; recipients get a read-only link.
  { actionId: 'artifact.share', description: 'Prepare sharing one of the actor-owned artifacts (chart/table/brief/CSV version from ARTIFACTS) read-only with listed recipients', riskTier: 'confirm',
    requiredPermissions: ['dashboard.share', 'dashboard.create'],
    params: {
      artifact: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'artifact' },
      recipientIds: { value: ids(20), required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'recipient' } } },
  // ActionPlan with flexible, schema-validated fields: priority, due date, grouping (one item or one per branch), checklist, note and an
  // optional assignee (never defaulted to someone else). Confirm-tier; fresh authorization at prepare, confirm and inside the effect transaction.
  { actionId: 'task.create', description: 'Prepare a task preview; title required, other fields optional; named assignee from RECIPIENTS', riskTier: 'confirm',
    requiredPermissions: ['ticket.create'],
    params: {
      title: { value: text(120), required: true, sources: ['user_quoted', 'generated'] },
      priority: { value: z.enum(['low', 'normal', 'high', 'urgent']), required: false, sources: ['user_quoted', 'generated', 'default'], default: () => 'normal' },
      dueDate: { value: businessDateSchema, required: false, sources: ['user_quoted'] },
      grouping: { value: z.enum(['single', 'per_branch']), required: false, sources: ['user_quoted', 'generated', 'default'], default: () => 'single' },
      checklist: { value: z.array(text(120)).min(1).max(8), required: false, sources: ['user_quoted', 'generated'] },
      branchIds: { value: ids(12), required: false, sources: FROM_USER_OR_CONTEXT, scope: 'branch' },
      branchesFrom: { value: contextIdSchema, required: false, sources: ['context_id', 'inherited'], contextKind: 'accepted_state' },
      branchesRule: { value: z.enum(['below_target', 'positive_value']), required: false, sources: ['generated'] },
      assigneeId: { value: idSchema, required: false, sources: FROM_USER_OR_CONTEXT, contextKind: 'recipient' },
      note: { value: text(300), required: false, sources: ['user_quoted', 'generated'] } } },
  // POLICY-001: acknowledging ONE exact policy id + version (both copied from POLICIES). Confirm-tier, staged in router_proposals; the actor is
  // reauthorized against the document and its current version at prepare, at confirm and inside the effect transaction; idempotent per actor+policy+version.
  { actionId: 'policy.acknowledge', description: 'Prepare acknowledging one POLICIES document (exact id and version)', riskTier: 'confirm',
    requiredPermissions: [], anyPermissions: ['operations.read', 'hr.read'],
    params: {
      policy: { value: idSchema, required: true, sources: ['context_id'], contextKind: 'policy' },
      version: { value: idSchema, required: true, sources: ['context_id'], contextKind: 'policy_version' } } },
  // HR Director (Workflow V2 bridge): confirm-tier, staged in router_proposals; confirm delegates to the V2 prepare/confirm/execute/verify
  // runtime. Offered only while the V2 capability projection grants the decision to this actor AND a reviewed queue is in WORKFLOW.
  { actionId: 'onboarding.director_approve', description: 'Prepare Director approval of onboarding requests from one WORKFLOW.reviewedQueues entry: selection all_reviewed = exactly that queue, subset = requestIds from it', riskTier: 'confirm',
    requiredPermissions: v2Permissions('onboarding_director_approve'),
    params: {
      queue: { value: contextIdSchema, required: true, sources: ['context_id'], contextKind: 'review_queue' },
      selection: { value: z.enum(['all_reviewed', 'subset']), required: true, sources: ['user_quoted', 'generated'] },
      requestIds: { value: z.array(contextIdSchema).min(1).max(20), required: false, sources: ['context_id'], contextKind: 'onboarding_request' } } },
  { actionId: 'onboarding.return', description: 'Prepare returning onboarding requests (requestIds from one WORKFLOW.reviewedQueues entry) for revision with the user stated reason', riskTier: 'confirm',
    requiredPermissions: v2Permissions('onboarding_return'),
    params: {
      queue: { value: contextIdSchema, required: true, sources: ['context_id'], contextKind: 'review_queue' },
      requestIds: { value: z.array(contextIdSchema).min(1).max(20), required: true, sources: ['context_id'], contextKind: 'onboarding_request' },
      reason: { value: text(500), required: true, sources: ['user_quoted'], verbatim: true } } },
  { actionId: 'onboarding.notify_email', description: 'Prepare a simulated Email about one WORKFLOW.verifiedApprovals entry to the requesting managers (server-chosen recipients); subject/body generated Thai without numbers', riskTier: 'confirm',
    requiredPermissions: v2Permissions('onboarding_director_approve'),
    params: {
      approval: { value: contextIdSchema, required: true, sources: ['context_id'], contextKind: 'onboarding_approval' },
      subject: { value: text(160), required: true, sources: ['generated', 'user_quoted'], serverCopyWhenUnsafe: true },
      body: { value: text(500), required: true, sources: ['generated', 'user_quoted'], serverCopyWhenUnsafe: true } } },
  // Dashboard library organization (owner-private, reversible => direct, also for a shared Dashboard: only the owner's own library view changes):
  // the SAME ConciergeService.organizeDashboard rules as the Dashboard page. Duplicate makes a new private copy (needs dashboard.create).
  { actionId: 'dashboard.manage', description: 'Pin/unpin/archive/restore/duplicate one actor-owned DASHBOARDS entry (owner library organization)', riskTier: 'direct',
    requiredPermissions: ['sales.read'],
    params: {
      dashboard: { value: idSchema, required: true, sources: FROM_USER_OR_CONTEXT, contextKind: 'dashboard' },
      operation: { value: z.enum(['pin', 'unpin', 'archive', 'restore', 'duplicate']), required: true, sources: ['generated'] } } },
];

/** Specs for non-action steps, so the validator grounds them with the same provenance rules. */
export const REFINE_PARAM_SPECS: Readonly<Record<'title' | 'removeWidgetIndexes', ParamSpec>> = {
  title: { value: text(120), required: false, sources: ['user_quoted', 'generated', 'inherited'] },
  removeWidgetIndexes: { value: z.array(z.number().int().min(0).max(11)).min(1).max(12), required: false, sources: ['context_id'], contextKind: 'widget_index' },
};
export const ARTIFACT_TITLE_SPEC: ParamSpec = { value: text(140), required: true, sources: ['user_quoted', 'generated'], serverCopyWhenUnsafe: true };
const ARTIFACT_TYPE_TITLE: Readonly<Record<string, string>> = {
  table: 'ตาราง', ranking: 'การจัดอันดับ', chart: 'กราฟ', executive_brief: 'สรุปผู้บริหาร', csv_export: 'ไฟล์ CSV',
};
/** G6: server title for a Result whose generated title failed the model-text gate (type + the server label of its source dataset). */
export function serverArtifactTitle(artifactTypeId: string, datasetLabel?: string): string {
  const type = ARTIFACT_TYPE_TITLE[artifactTypeId] ?? 'Result';
  return [...(datasetLabel ? `${type} — ${datasetLabel}` : type)].slice(0, 140).join('');
}

export interface ActionRegistry {
  readonly definitions: readonly ActionDefinition[];
  get(actionId: string): ActionDefinition | undefined;
  ids(): string[];
  /** Definitions whose required permissions are all held. */
  availableFor(actor: { permissions: readonly string[] }): ActionDefinition[];
  /** Planner-facing descriptors (ids, sources, param JSON types) for the actions the actor may use. */
  describeFor(actor: { permissions: readonly string[] }): ActorActionDescriptor[];
}

export function createActionRegistry(definitions: readonly ActionDefinition[] = ACTION_DEFINITIONS): ActionRegistry {
  const byId = new Map<string, ActionDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.actionId)) throw new Error(`Duplicate action id ${definition.actionId}`);
    byId.set(definition.actionId, definition);
  }
  const availableFor = (actor: { permissions: readonly string[] }) =>
    definitions.filter(d => holdsActionPermissions(d, actor.permissions));
  return {
    definitions, get: id => byId.get(id), ids: () => [...byId.keys()], availableFor,
    describeFor: actor => availableFor(actor).map(d => ({
      actionId: d.actionId, description: d.description, riskTier: d.riskTier, requiresConfirm: d.riskTier === 'confirm',
      params: Object.entries(d.params).map(([name, spec]) => ({
        name, required: spec.required && !spec.default, sources: [...spec.sources], verbatim: spec.verbatim === true,
        contextKind: spec.contextKind ?? null, scope: spec.scope ?? null, hasDefault: spec.default !== undefined,
        jsonType: z.toJSONSchema(spec.value, { target: 'draft-7' }),
      })),
    })),
  };
}
export const actionRegistry: ActionRegistry = createActionRegistry();

/** Typed params schema for one action: narrowed value types and allowed provenance per param. */
export function actionParamsSchema(definition: ActionDefinition) {
  return z.object(Object.fromEntries(Object.entries(definition.params).map(([name, spec]) => {
    const envelope = paramEnvelope(spec.value, spec.sources);
    return [name, spec.required && !spec.default ? envelope : envelope.optional()];
  }))).strict();
}

/** Fails closed if a registered action has no injected handler (or a handler has no action). */
export function bindHandlers(registry: ActionRegistry, handlers: readonly ActionHandler[]): ActionHandlerMap {
  const map = new Map(handlers.map(h => [h.actionId, h]));
  if (map.size !== handlers.length) throw new Error('Duplicate action handler');
  for (const id of map.keys()) if (!registry.get(id)) throw new Error(`Handler for unregistered action ${id}`);
  for (const id of registry.ids()) if (!map.has(id)) throw new Error(`Missing handler for action ${id}`);
  return map;
}
