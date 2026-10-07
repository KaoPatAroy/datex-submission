import type { Actor, ConversationMessage, Dashboard, PendingAction, Receipt, Store } from '../../contracts';
import { authority } from '../../dynamic/runtime';
import { HR_DATASET as HR_CATALOG_DATASET } from '../../dynamic/catalog/hr';
import type { SemanticDatasetCatalog } from '../../dynamic/catalog/semantic';
import { conversationStateRef } from '../../dynamic/planner/planner';
import { conversationStateSchema } from '../../dynamic/state/conversation';
import { exactConversationStateSchema } from '../../dynamic/state/exact';
import { digest } from '../../dynamic/shared';
import { authorizedBranches } from '../../dynamic/validate/query-plan';
import type { ActionRegistry } from '../action-registry';
import type { ActorActionDescriptor, ContextLabel, PlannerContext, ReferenceSet } from '../planner-context';
import { loadTableStates, tableStateId } from '../executors/table-query';
import { datasetSuggestions } from '../../dynamic/catalog/suggestions';
import { listReadablePolicies } from '../executors/policy';
import { policySourceId } from '../../dynamic/catalog/policy';
import { queryPlanSchema } from '../../dynamic/plan/schemas';
import { boundedPlannerConversation } from '../planner/input';
import type { ParamValue } from '../turn-plan';
import { createStagedStore } from '../storage/staged-store';
import { branchLabel, regionLabel } from './display';
import { recipientDirectory } from './recipients';

/** Prefix on assistant messages of turns that produced no accepted result (refusal / clarification): never a state to continue. */
export const NO_RESULT_MARK = '[ไม่มีผลลัพธ์ที่ยืนยัน] ';

/**
 * Assembles the planner's inert context from store reads. Pure data plumbing: nothing here reads or interprets
 * user text; the conversation excerpt is copied (and length-bounded by the planner input module) as data only.
 * Every list is restricted to this actor (and this conversation where the data is conversation-scoped).
 */
export const CONTEXT_LIMITS = Object.freeze({ pending: 8, dashboards: 20, recipients: 50, acceptedStates: 3, artifacts: 5, choices: 60, messages: 12 });
const HR_DATASET = { id: HR_CATALOG_DATASET.id, label: HR_CATALOG_DATASET.label } as const;
const RETAIL_TOOL = 'retail.dynamic_query', HR_TOOL = 'hr.dynamic_query';

export interface BuildPlannerContextInput {
  store: Store;
  actor: Actor;
  conversationId: string;
  businessDate: string;
  catalog: SemanticDatasetCatalog;
  registry: ActionRegistry;
  /** Server recipient policy (same function the action ports use). Only allowed recipients are listed. */
  recipientAllowed: (actor: Actor, recipientId: string) => Promise<boolean>;
  /** Current outgoing grants for one relevant owned Dashboard; failures become explicit unavailable context. */
  dashboardShares?: (actor: Actor, dashboardId: string) => Promise<{ shareId: string; recipientId: string; recipientName: string; createdAt: string }[]>;
  /** Production batch reader: one share-table read, grouped over relevant dashboards. */
  dashboardShareGroups?: (actor: Actor, dashboardIds: string[]) => Promise<{ shares: NonNullable<PlannerContext['dashboardShares']>; unavailableDashboardIds: string[] }>;
  /** Wave 3 artifacts of this conversation (artifact persistence is injected by the service). */
  artifacts?: (actor: Actor, conversationId: string) => Promise<{ id: string; typeId: string; title: string; revision?: number }[]>;
  availability?: { from: string; to: string } | null;
  pendingClarification?: PlannerContext['pendingClarification'];
  timezone?: string;
  now?: () => number;
  /**
   * false when the store has no router_proposals table (hosted Supabase before the migration is applied): staged-proposal
   * actions (dashboard.delete, communication.send, monitor.create) are not offered and staged rows are not read.
   */
  stagedAvailable?: boolean;
  /** The actor's own installed monitors (effects layer). Omit when monitors are not enabled. */
  /** Proof that a built-in pending action belongs to a completed chat turn (standalone-prepared proposals are not offered). */
  pendingBound?: (actor: Actor, action: PendingAction) => Promise<boolean>;
  monitors?: (actor: Actor) => Promise<{ id: string; title: string; status: string }[]>;
  /** HR Director Workflow V2 context (server projection: granted reads, still-valid reviewed queues, verified approvals). */
  workflow?: (actor: Actor, conversationId: string) => Promise<PlannerContext['workflow']>;
  /** Server-verified resources the user selected (UI target / tapped lookup choice): admitted to the lists even outside the recent window. */
  selected?: { artifacts?: { id: string; typeId: string; title: string; revision?: number }[]; dashboards?: { id: string; title: string }[]; monitors?: { id: string; title: string; status: string }[] };
  /** The actor's own archived Results (library). Omit when unavailable; listed only for result.unarchive. */
  archivedArtifacts?: (actor: Actor) => Promise<{ id: string; typeId: string; title: string }[]>;
}

/** Actions whose proposals live in router_proposals (fail closed when the table is unavailable). */
export const STAGED_ACTION_IDS: ReadonlySet<string> = new Set(['dashboard.delete', 'dashboard.revoke_share', 'dashboard.refine', 'communication.send', 'monitor.create', 'monitor.manage', 'artifact.share', 'task.create', 'policy.acknowledge',
  'onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email']);

const weekdayOf = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const cap = (text: string, max: number): string => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text; };
const createdMs = (iso: string | undefined): number => { const n = Date.parse(iso ?? ''); return Number.isFinite(n) ? n : 0; };

/**
 * The Dashboard this conversation touched last: created by a verified chat dashboard_create receipt, or organized/duplicated by a completed turn
 * (router turn extras `dashboardIds`). Server-owned records of THIS actor + conversation only; undefined when none.
 */
async function conversationDashboardId(store: Store, actor: Actor, conversationId: string): Promise<string | undefined> {
  const touched: { id: string; at: number }[] = [];
  const created = (await store.list<PendingAction>('pending_actions', { actorId: actor.id }))
    .filter(a => a.actorId === actor.id && a.conversationId === conversationId && (a.payload as { kind?: unknown }).kind === 'dashboard_create');
  if (created.length) {
    const ids = new Set(created.map(a => a.id));
    for (const receipt of await store.list<Receipt>('action_executions')) {
      if (receipt.actorId === actor.id && ids.has(receipt.actionId) && receipt.status === 'verified_success' && receipt.dashboardId) touched.push({ id: receipt.dashboardId, at: createdMs(receipt.verifiedAt ?? receipt.createdAt) });
    }
  }
  const extras = await store.list<{ name?: string; actorId?: string; conversationId?: string; dashboardIds?: unknown; createdAt?: string }>('tool_executions', { actorId: actor.id, status: 'completed' });
  for (const row of extras) {
    if (row.name !== 'router.turn_extras' || row.actorId !== actor.id || row.conversationId !== conversationId || !Array.isArray(row.dashboardIds)) continue;
    for (const id of row.dashboardIds) if (typeof id === 'string') touched.push({ id, at: createdMs(row.createdAt) });
  }
  // Newest first; on a timestamp tie the organize record (pushed later) wins over the creation receipt.
  return touched.map((t, index) => ({ ...t, index })).sort((a, b) => b.at - a.at || b.index - a.index)[0]?.id;
}

function pendingKind(action: PendingAction): { kind: string; title: string; widgetIndexes: number[]; values: Record<string, ParamValue> } {
  const payload = action.payload as unknown as Record<string, unknown>;
  const spec = payload.spec as { title?: unknown; widgets?: unknown } | undefined;
  const title = typeof spec?.title === 'string' ? spec.title : typeof payload.title === 'string' ? payload.title : cap(action.preview ?? '', 80);
  const widgets = Array.isArray(spec?.widgets) ? spec.widgets.map((_, i) => i) : [];
  return { kind: String(payload.kind ?? 'action'), title: cap(title, 140), widgetIndexes: widgets.slice(0, 24), values: title ? { title: cap(title, 140) } : {} };
}

/** Thai label of an accepted answer for clarify chips: its regions and date range (server data only). */
function stateLabel(regions: readonly string[], dates: readonly string[]): string {
  const scope = regions.length ? regions.map(regionLabel).join(', ') : 'ทุกภูมิภาคที่มีสิทธิ์';
  const range = dates.length ? (dates.length === 1 ? dates[0] : `${dates[0]} ถึง ${dates.at(-1)}`) : '';
  return cap(`คำตอบยอดขาย ${scope}${range ? ` · ${range}` : ''}`, 120);
}

export async function buildPlannerContext(input: BuildPlannerContextInput): Promise<PlannerContext> {
  const { store, actor, conversationId, catalog } = input;
  const nowMs = (input.now ?? Date.now)();
  const permitted = (required: readonly string[]) => required.every(p => actor.permissions.includes(p));

  // Scope + catalog: only what this actor may use.
  const branches = authorizedBranches(catalog, authority(actor));
  const regionIds = actor.regions.includes('*') ? [...new Set(catalog.branches.map(b => b.region))].sort() : [...actor.regions].sort();
  const datasets = catalog.datasets.filter(d => permitted(d.requiredPermissions)).map(d => ({ id: d.id, label: d.label ?? d.description, suggestions: datasetSuggestions(d) }));
  if (actor.permissions.includes('hr.read')) datasets.push({ ...HR_DATASET, suggestions: [...HR_CATALOG_DATASET.suggestions] });
  // Action params (contextKind 'measure') bind to the branch evidence contract; table datasets are answered, not bound to effects.
  const measureIds = [...new Set(catalog.datasets.filter(d => d.readerId === 'branch_evidence' && permitted(d.requiredPermissions))
    .flatMap(d => d.fields.filter(f => f.kind === 'measure' && permitted(f.requiredPermissions)).map(f => f.id)))];
  const choices: ContextLabel[] = [
    ...regionIds.map(id => ({ id, label: regionLabel(id) })),
    ...branches.map(b => ({ id: b.id, label: branchLabel(b) })),
  ].slice(0, CONTEXT_LIMITS.choices);

  // Pending actions (built-in + router-staged) of this actor in this conversation.
  const builtIn = (await store.list<PendingAction>('pending_actions', { actorId: actor.id }))
    .filter(a => a.actorId === actor.id && a.conversationId === conversationId && a.status === 'pending' && createdMs(a.expiresAt) > nowMs)
    .sort((a, b) => createdMs(b.createdAt) - createdMs(a.createdAt));
  const bound: PendingAction[] = [];
  // Current permissions, not just ownership: a revoked permission removes the proposal from the planner's world.
  const kindPermission: Record<string, readonly string[]> = { dashboard_create: ['sales.read', 'dashboard.create'], dashboard_share: ['sales.read', 'dashboard.share'],
    ticket_create: ['ticket.create'], badge_revoke: ['hr.read', 'badge.revoke'], demo_update: ['demo.update'] };
  for (const action of builtIn) {
    const required = kindPermission[String((action.payload as { kind?: unknown }).kind)];
    if (!required || !permitted(required)) continue;
    if (!input.pendingBound || await input.pendingBound(actor, action)) bound.push(action);
  }
  const stagedAvailable = input.stagedAvailable !== false;
  const staged = stagedAvailable ? await createStagedStore(store, { now: () => nowMs }).list(actor, conversationId, { status: 'pending' }) : [];
  const pendingActions: PlannerContext['pendingActions'] = [
    ...bound.map(a => ({ id: a.id, ...pendingKind(a) })),
    ...staged.map(p => ({ id: p.id, kind: p.actionId, title: cap(p.preview.split('\n')[0] ?? p.actionId, 140), widgetIndexes: [], values: {} })),
  ].slice(0, CONTEXT_LIMITS.pending);

  // Dashboards owned by this actor (soft-deleted ones are not addressable).
  const dashboards = (!permitted(['sales.read']) ? [] : await store.list<Dashboard & { deletedAt?: unknown }>('dashboards'))
    .filter(d => d.ownerId === actor.id && typeof d.deletedAt !== 'string')
    .sort((a, b) => createdMs(b.updatedAt) - createdMs(a.updatedAt))
    .slice(0, CONTEXT_LIMITS.dashboards).map((d): PlannerContext['dashboards'][number] => ({ id: d.id, title: cap(d.spec.title, 140), updatedAt: d.updatedAt, ...(Array.isArray(d.spec.widgets) ? { widgetCount: d.spec.widgets.length } : {}) }));
  const selectedDashboards = (permitted(['sales.read']) ? input.selected?.dashboards ?? [] : []).map(d => ({ ...dashboards.find(o => o.id === d.id), id: d.id, title: cap(d.title, 140) }));
  dashboards.splice(0, dashboards.length, ...selectedDashboards, ...dashboards.filter(d => !selectedDashboards.some(s => s.id === d.id)));
  // G5: "this Dashboard" = the Dashboard this conversation created (verified receipt) or organized (turn record) last. Server records only.
  const currentId = dashboards.length ? await conversationDashboardId(store, actor, conversationId) : undefined;
  const currentAt = dashboards.findIndex(d => d.id === currentId);
  if (currentAt >= 0) {
    // Listed right after the on-screen selection (which stays first), marked current.
    const [current] = dashboards.splice(currentAt, 1);
    dashboards.splice(Math.min(currentAt, selectedDashboards.length), 0, { ...current!, current: true });
  }

  // No language heuristics: a server-selected or conversation-current dashboard supplies relevance.
  const dashboardSharesFor = [...new Set([...selectedDashboards.map(d => d.id), ...dashboards.filter(d => d.current).map(d => d.id)])];
  let dashboardShares: PlannerContext['dashboardShares'];
  let dashboardSharesUnavailable: string[] = [];
  if (dashboardSharesFor.length && (input.dashboardShareGroups || input.dashboardShares)) {
    if (input.dashboardShareGroups) {
      try {
        const group = await input.dashboardShareGroups(actor, dashboardSharesFor);
        dashboardShares = group.shares;
        dashboardSharesUnavailable = group.unavailableDashboardIds;
      } catch { dashboardShares = []; dashboardSharesUnavailable = dashboardSharesFor; }
    } else {
      const groups = await Promise.all(dashboardSharesFor.map(async dashboardId => {
        try { return (await input.dashboardShares!(actor, dashboardId)).map(grant => ({ dashboardId, ...grant })); }
        catch { dashboardSharesUnavailable.push(dashboardId); return []; }
      }));
      dashboardShares = groups.flat();
    }
  }

  // Recipients: active profiles other than the actor that the server policy lets this actor message.
  const recipients = await recipientDirectory(store, actor, input.recipientAllowed, CONTEXT_LIMITS.recipients);

  // Accepted states (newest first): retail states re-checked against current authority + catalog; HR exact states by actor.
  type StateRow = { revision: number; stateId: string; datasetId: string; regions: string[]; dates: string[]; label: string; family: 'retail' | 'hr'; createdAt: number; plan?: unknown };
  const executions = (await store.list<{ name: string; conversationId: string; actorId: string; sessionId: string; status: string; state: unknown; plan?: unknown; createdAt?: string }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(r => r.actorId === actor.id && r.conversationId === conversationId);
  const permittedBranchIds = new Set(branches.map(b => b.id));
  const currentAuthority = digest(authority(actor));
  const states: StateRow[] = [];
  for (const record of executions) {
    if (record.name === RETAIL_TOOL) {
      const parsed = conversationStateSchema.safeParse(record.state);
      if (!parsed.success) continue;
      const s = parsed.data;
      if (s.conversationId !== conversationId || s.authoritySnapshot.id !== actor.id || s.authoritySnapshot.digest !== currentAuthority
        || s.catalogSnapshot.digest !== catalog.digest || s.resolvedScope.branchIds.some(id => !permittedBranchIds.has(id))) continue;
      states.push({ revision: s.revision, stateId: conversationStateRef(s).id, datasetId: s.dataset.id, regions: s.resolvedScope.regions, dates: s.resolvedScope.dates,
        label: stateLabel(s.resolvedScope.regions, s.resolvedScope.dates), family: 'retail', createdAt: createdMs(record.createdAt), plan: record.plan });
    } else if (record.name === HR_TOOL && actor.permissions.includes('hr.read')) {
      const parsed = exactConversationStateSchema.safeParse(record.state);
      if (!parsed.success || parsed.data.conversationId !== conversationId) continue;
      states.push({ revision: parsed.data.revision, stateId: `state:${digest(conversationId)}`, datasetId: HR_DATASET.id, regions: [], dates: [], label: 'คำตอบข้อมูลพนักงานล่าสุด', family: 'hr', createdAt: createdMs(record.createdAt) });
    }
  }
  states.sort((a, b) => b.revision - a.revision);
  const newest = states.find(s => s.datasetId !== HR_DATASET.id);
  const previousState: PlannerContext['previousState'] = newest
    ? { stateId: newest.stateId, values: { regionIds: newest.regions, ...(newest.dates.length === 1 ? { date: newest.dates[0] } : {}) } as Record<string, ParamValue> }
    : null;

  // Bounded excerpt of this conversation, copied as inert data.
  const noResultTurns = new Set((await store.list<{ name: string; actorId: string; conversationId: string; turnId: string; clarification?: unknown }>('tool_executions', { actorId: actor.id }))
    .filter(r => r.name === 'router.turn_extras' && r.actorId === actor.id && r.conversationId === conversationId && r.clarification === true).map(r => r.turnId));
  const conversationRows = (await store.list<ConversationMessage>('conversation_messages', { actorId: actor.id }))
    .filter(m => m.actorId === actor.id && m.conversationId === conversationId);
  const messages = conversationRows
    .sort((a, b) => createdMs(a.createdAt) - createdMs(b.createdAt)).slice(-CONTEXT_LIMITS.messages)
    .map(m => ({ role: m.role, text: m.role === 'assistant' && m.turnId && noResultTurns.has(m.turnId) ? `${NO_RESULT_MARK}${m.text}` : m.text }));

  const selectedArtifacts = permitted(['dashboard.create']) ? input.selected?.artifacts ?? [] : [];
  const artifacts = [...selectedArtifacts, ...((permitted(['dashboard.create']) ? await input.artifacts?.(actor, conversationId) : undefined) ?? []).filter(a => !selectedArtifacts.some(s => s.id === a.id || s.id.startsWith(`${a.id}:v`))).slice(0, CONTEXT_LIMITS.artifacts)]
    .map(a => ({ id: a.id, typeId: a.typeId, title: cap(a.title, 140), ...(a.revision !== undefined ? { revision: a.revision } : {}) }));
  const archivedArtifacts = permitted(['dashboard.create']) && input.archivedArtifacts ? (await input.archivedArtifacts(actor)).slice(0, 5).map(a => ({ id: a.id, typeId: a.typeId, title: cap(a.title, 140) })) : [];
  const selectedMonitors = stagedAvailable ? input.selected?.monitors ?? [] : [];
  const monitors = stagedAvailable && input.monitors ? [...selectedMonitors, ...(await input.monitors(actor)).filter(m => !selectedMonitors.some(s => s.id === m.id)).slice(0, 10)].map(m => ({ id: m.id, title: cap(m.title, 140), status: m.status })) : [];
  const lookupResources: ('dashboard' | 'result' | 'monitor')[] = [...(permitted(['sales.read']) ? ['dashboard' as const] : []), ...(permitted(['dashboard.create']) ? ['result' as const] : []), ...(stagedAvailable && input.monitors ? ['monitor' as const] : [])];
  const policies = await listReadablePolicies(store, actor.permissions);
  // A policy counts as SHOWN only when an accepted policy_read answer of this conversation cited exactly that id+version (refused turns carry no sources).
  const shownSources = new Set(conversationRows.flatMap(m => m.role === 'assistant' && m.turnId && !noResultTurns.has(m.turnId) ? (m.sources ?? []).map(source => source.id) : []));
  const shownPolicies = policies.filter(p => shownSources.has(policySourceId(p.id, p.version))).map(p => ({ id: p.id, version: p.version }));
  // policy.acknowledge is only offered when the actor can actually read a policy document it could acknowledge.
  const workflow = stagedAvailable && input.workflow ? await input.workflow(actor, conversationId) : undefined;
  // HR Director decisions are offered only with a reviewed queue to decide on; the Email only with a verified approval to report.
  const workflowReady = (actionId: string) => actionId === 'onboarding.notify_email' ? !!workflow?.verifiedApprovals.length
    : actionId === 'onboarding.director_approve' || actionId === 'onboarding.return' ? !!workflow?.reviewedQueues.length : true;
  const actions: ActorActionDescriptor[] = input.registry.describeFor(actor).filter(a => (stagedAvailable || !STAGED_ACTION_IDS.has(a.actionId)) && (a.actionId !== 'policy.acknowledge' || policies.length > 0)
    && workflowReady(a.actionId));

  // CONTEXT-001: one exact reference set (also the accepted answers, table answers included).
  const tableStates = await loadTableStates(store, actor, conversationId, catalog);
  const newestTable = tableStates[0], newestRetail = states.find(state => state.family === 'retail');
  const answers = [
    ...[...new Map(states.map(state => [state.stateId, state])).values()].map(state => ({ stateId: state.stateId, family: state.family, datasetId: state.datasetId, revision: state.revision, label: state.label, at: state.createdAt })),
    ...tableStates.map(({ state, createdAt }) => ({ stateId: tableStateId(state), family: 'table' as const, datasetId: state.datasetId, revision: state.revision, at: createdMs(createdAt),
      label: cap(`คำตอบ${catalog.datasets.find(d => d.id === state.datasetId)?.label ?? state.datasetId}${state.resolvedScope.dates.length ? ` · ${state.resolvedScope.dates.length === 1 ? state.resolvedScope.dates[0] : `${state.resolvedScope.dates[0]} ถึง ${state.resolvedScope.dates.at(-1)}`}` : ''}`, 120) })),
  ].sort((a, b) => b.at - a.at || b.revision - a.revision);
  const queryStates: ReferenceSet['queryStates'] = answers.map(({ stateId, family, datasetId, revision, label }) => ({ stateId, family, datasetId, revision, label }));
  const drillFrom = (plan: { filters: { fieldId: string; value: unknown }[]; group: { fieldIds: string[] } }) => ({
    filters: plan.filters.map(f => ({ fieldId: f.fieldId, values: [f.value].flat().filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String).slice(0, 12) })).slice(0, 8),
    groupBy: plan.group.fieldIds.slice(0, 8) });
  const retailPlan = newestRetail?.plan ? queryPlanSchema.safeParse(newestRetail.plan) : undefined;
  const tableLatest = !!newestTable && (!newestRetail || createdMs(newestTable.createdAt) >= newestRetail.createdAt);
  const referencesBase = {
    version: 1 as const, queryStates,
    continuation: { retail: newestRetail?.stateId ?? null, hr: states.find(state => state.family === 'hr')?.stateId ?? null, table: newestTable ? tableStateId(newestTable.state) : null },
    pagination: newestTable ? { stateId: tableStateId(newestTable.state), datasetId: newestTable.state.datasetId, offset: newestTable.state.page.offset,
      limit: newestTable.state.page.limit, total: newestTable.state.page.total, nextCursor: newestTable.state.page.nextCursor } : null,
    drillPath: tableLatest ? { stateId: tableStateId(newestTable.state), datasetId: newestTable.state.datasetId, ...drillFrom(newestTable.plan) }
      : newestRetail && retailPlan?.success ? { stateId: newestRetail.stateId, datasetId: newestRetail.datasetId, ...drillFrom(retailPlan.data) } : null,
    artifacts: artifacts.map(a => ({ id: a.id, typeId: a.typeId, title: a.title, revision: a.revision ?? null })),
    pendingProposals: pendingActions.map(p => ({ id: p.id, kind: p.kind, title: p.title, revises: bound.find(a => a.id === p.id)?.predecessorActionId ?? null })),
    recipients: recipients.map(r => ({ ...r })),
  };
  const references: ReferenceSet = { ...referencesBase, digest: digest(referencesBase) };

  return {
    business: { date: input.businessDate, weekday: weekdayOf(input.businessDate), timezone: input.timezone ?? 'Asia/Bangkok', availability: input.availability ?? null },
    scope: { actorId: actor.id, role: actor.role, regionIds, branchIds: branches.map(b => b.id), permissions: [...actor.permissions] },
    catalog: { datasets, measureIds, choices },
    actions, recipients, pendingActions, dashboards, ...(dashboardShares !== undefined ? { dashboardShares, dashboardSharesFor, dashboardSharesUnavailable } : {}), ...(monitors.length ? { monitors } : {}), ...(archivedArtifacts.length ? { archivedArtifacts } : {}),
    // Accepted answers a later step may build on (artifact, Dashboard widgets, message): branch/HR answers and answers over registered table datasets.
    acceptedStates: answers.slice(0, CONTEXT_LIMITS.acceptedStates).map(s => ({ stateId: s.stateId, datasetId: s.datasetId, label: s.label })),
    artifacts, references, policies, shownPolicies,
    ...(selectedDashboards.length || selectedArtifacts.length || selectedMonitors.length ? { selectedTargets: { artifacts: selectedArtifacts.map(a => a.id), dashboards: selectedDashboards.map(d => d.id), monitors: selectedMonitors.map(m => m.id) } } : {}),
    ...(lookupResources.length ? { lookup: { resources: lookupResources } } : {}), ...(workflow?.reads.length ? { workflow } : {}), pendingClarification: input.pendingClarification ?? null,
    conversation: boundedPlannerConversation(messages), previousState,
  };
}
