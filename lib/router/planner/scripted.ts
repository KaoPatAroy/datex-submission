import 'server-only';

import type { PlannerContext } from '../planner-context';
import type { ParamEnvelope, ParamValue, TurnPlan } from '../turn-plan';
import type { TurnPlannerInput } from './input';

export class ScriptedTurnPlannerFixtureMissing extends Error {
  readonly code = 'scripted_fixture_missing';
  constructor() {
    super('No scripted TurnPlan fixture is registered for this exact prompt.');
    this.name = 'ScriptedTurnPlannerFixtureMissing';
  }
}

type Fixture = (input: TurnPlannerInput) => TurnPlan;
const plan = (...steps: unknown[]): TurnPlan => ({ turnPlanVersion: 1, steps } as TurnPlan);
const param = (value: ParamValue, source: ParamEnvelope['source'], evidenceText?: string): ParamEnvelope => ({
  value, source, ...(evidenceText === undefined ? {} : { evidenceText }),
});

function queryPlan(context: PlannerContext, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planVersion: 1, planId: 'scripted:query', datasetId: 'branch_performance',
    measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [], filters: [], scope: null,
    time: { fieldId: 'date', timezone: context.business.timezone, source: 'default', dates: [context.business.date] },
    grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null, group: { fieldIds: [] }, compare: null,
    sort: [], topN: null,
    completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
    clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
    ...overrides,
  };
}

/** Follow-up fixtures repeat the single date of the previous accepted state (provenance 'inherited'), never the new default. */
function inheritedDate(input: TurnPlannerInput): string | undefined {
  const date = input.context.previousState?.values.date;
  return typeof date === 'string' ? date : undefined;
}

function regionQuery(input: TurnPlannerInput, regionId: string, evidenceText: string, date?: string, dateText?: string, continuation = false, inheritedDate?: string): TurnPlan {
  const query = queryPlan(input.context, {
    dimensions: [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: { text: evidenceText }, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: regionId, source: 'explicit', evidenceText, confidence: 1 }],
    grain: ['region', 'date'], group: { fieldIds: ['region'] },
    ...(date && dateText ? { time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: [date], evidenceText: dateText } } : {}),
    ...(inheritedDate ? { time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'inherited', dates: [inheritedDate] } } : {}),
  });
  return plan({ kind: 'query', continuation, plan: query });
}

function exactDateQuery(input: TurnPlannerInput): TurnPlan {
  const dateText = '2026-10-01';
  const query = queryPlan(input.context, {
    scope: { kind: 'all', sourceText: { text: 'all regions' }, confidence: 1 },
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: [dateText], evidenceText: dateText },
  });
  return plan({ kind: 'query', continuation: false, plan: query });
}

function eastDateQuery(input: TurnPlannerInput): TurnPlan {
  const query = queryPlan(input.context, {
    dimensions: [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: { text: 'East' }, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }],
    grain: ['region', 'date'], group: { fieldIds: ['region'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return plan({ kind: 'query', continuation: false, plan: query });
}

function branchQuery(input: TurnPlannerInput): TurnPlan {
  const query = queryPlan(input.context, {
    filters: [{ fieldId: 'branch', op: 'eq', value: 'E01', source: 'explicit', evidenceText: 'E01', confidence: 1 }],
  });
  return plan({ kind: 'query', continuation: false, plan: query });
}

function may2025Query(input: TurnPlannerInput): TurnPlan {
  const dates = Array.from({ length: 31 }, (_, index) => `2025-05-${String(index + 1).padStart(2, '0')}`);
  const query = queryPlan(input.context, {
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates, evidenceText: 'May 2025' },
  });
  return plan({ kind: 'query', continuation: false, plan: query });
}

function lowestThreeQuery(input: TurnPlannerInput): TurnPlan {
  const query = queryPlan(input.context, {
    measures: [{ fieldId: 'gap', aggregation: 'gap', interpretation: { value: 'gap', source: 'explicit', sourceText: { text: 'target' }, confidence: 1 } }],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] }, sort: [{ fieldId: 'gap', direction: 'asc' }],
    topN: { count: 3, direction: 'lowest', completeScopeRequired: true },
    completeness: { expectation: 'complete_authorized_population', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
  });
  return plan({ kind: 'query', continuation: false, plan: query });
}

function dashboardCreate(title = 'Sales overview'): TurnPlan {
  return plan({ kind: 'action', actionId: 'dashboard.create', params: { title: param(title, 'generated') } });
}

function shareDashboard(context: PlannerContext): TurnPlan {
  const dashboard = context.dashboards[0];
  const recipient = context.recipients.find(item => item.role === 'east_manager');
  if (!dashboard || !recipient) return plan({
    kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
    missing: [{ slot: !dashboard ? 'params.dashboard' : 'params.recipientId', reason: 'needs_target' }],
    question: !dashboard ? 'Which listed dashboard should be shared?' : 'Which listed recipient should receive the dashboard?', choices: [],
  });
  return plan({ kind: 'action', actionId: 'dashboard.share', params: {
    dashboard: param(dashboard.id, 'context_id'), recipientId: param(recipient.id, 'context_id'),
  } });
}

function badgeRevoke(badgeId = 'C102', employeeId = 'E024'): TurnPlan {
  const reason = 'their employment ended';
  return plan({ kind: 'action', actionId: 'badge.revoke', params: {
    badgeId: param(badgeId, 'user_quoted', badgeId), employeeId: param(employeeId, 'user_quoted', employeeId),
    reason: param(reason, 'user_quoted', reason),
  } });
}

export const SCRIPTED_TURN_FIXTURE_PROMPTS = [
  'ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569', 'แล้วภาคกลางล่ะ', 'May I see E01 sales?', 'ยอดขายภาคใต้',
  'แล้วภาคกลางยอดขายล่ะ', 'sales in May 2025', 'bottom 3 vs target',
  'Compare sales across all regions on 2026-10-01.', 'Show East sales totals for 2026-10-01.',
  'Create dashboard.', 'Create a sales dashboard', 'Share dashboard with East manager.',
  'Revoke badge C102 for E024 because their employment ended.',
  'Revoke badge C001 for E001 because their employment ended.', 'Revoke badge C002 for E002 because their employment ended.',
] as const;

// --- Router flow fixtures (E2E-only; kept out of SCRIPTED_TURN_FIXTURE_PROMPTS because they depend on live conversation context) ---

const measure = (fieldId: string, aggregation: string, text: string) => ({
  fieldId, aggregation, interpretation: { value: fieldId, source: 'explicit', sourceText: { text }, confidence: 1 },
});

/** East region, 2026-10-01, net sales and target (both measures cited from the prompt). */
function eastSalesVsTargetStep(input: TurnPlannerInput, withTarget = true): Record<string, unknown> {
  const query = queryPlan(input.context, {
    measures: withTarget ? [measure('net_sales', 'sum', 'sales'), measure('target', 'sum', 'target')]
      : [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: { text: 'East' }, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }],
    grain: ['region', 'date'], group: { fieldIds: ['region'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return { kind: 'query', continuation: false, plan: query };
}

function eastManagerId(context: PlannerContext): string | undefined {
  return context.recipients.find(item => item.role === 'east_manager')?.id;
}

/** Effects bind to the accepted answer of the previous turn (the state id is copied from the planner context). */
function sendThisAnswer(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context), state = input.context.previousState?.stateId;
  if (!recipient || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีคำตอบหรือผู้รับที่ส่งข้อความถึงได้' });
  return plan({ kind: 'action', actionId: 'communication.send', params: {
    recipientIds: param([recipient], 'context_id'), content: param(state, 'context_id'),
  } });
}

function alertEastManager(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context), state = input.context.previousState?.stateId;
  if (!recipient || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีคำตอบหรือผู้รับที่แจ้งเตือนได้' });
  return plan({ kind: 'action', actionId: 'monitor.create', params: {
    query: param(state, 'context_id'), threshold: param(0.9, 'user_quoted', '90%'), recipientIds: param([recipient], 'context_id'),
  } });
}

/** Two steps in ONE turn: answer, then send/alert over that answer (`$step0`); the effect is still staged for confirmation. */
function summarizeAndSend(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context);
  if (!recipient) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผู้รับที่ส่งข้อความถึงได้' });
  return plan(eastSalesVsTargetStep(input), { kind: 'action', actionId: 'communication.send', params: {
    recipientIds: param([recipient], 'context_id'), content: param('$step0', 'context_id'),
  } });
}

function summarizeAndAlert(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context);
  if (!recipient) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผู้รับที่แจ้งเตือนได้' });
  return plan(eastSalesVsTargetStep(input), { kind: 'action', actionId: 'monitor.create', params: {
    query: param('$step0', 'context_id'), threshold: param(0.9, 'user_quoted', '90%'), recipientIds: param([recipient], 'context_id'),
  } });
}

function exportEastCsv(input: TurnPlannerInput): TurnPlan {
  return plan(eastSalesVsTargetStep(input), {
    kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'csv_export', operation: 'create', baseArtifactId: null,
    title: param('East sales', 'generated'), outputFormat: 'csv', visual: null,
  });
}

/** East branches on 2026-10-01 grouped by branch: net sales (and target when asked), the shape every chart family below reads. */
function eastBranchStep(input: TurnPlannerInput, withTarget = false): Record<string, unknown> {
  const query = queryPlan(input.context, {
    measures: withTarget ? [measure('net_sales', 'sum', 'sales'), measure('target', 'sum', 'target')]
      : [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return { kind: 'query', continuation: false, plan: query };
}
const chartStep = (title: string, visual: Record<string, unknown>) => ({ kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'chart', operation: 'create', baseArtifactId: null,
  title: param(title, 'generated'), outputFormat: 'preview', visual });
const FULL_INTERACTIONS = ['inspect_data', 'inspect_sources', 'tooltip', 'select_point', 'cross_filter', 'drilldown', 'reset'];
function donutChart(input: TurnPlannerInput): TurnPlan {
  return plan(allRegionsQueryStep(input), chartStep('Sales share by branch', { primitiveId: 'donut', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data', 'tooltip', 'select_point', 'cross_filter', 'reset'], animation: 'interpolate' }));
}
function drillBar(input: TurnPlannerInput): TurnPlan {
  return plan(eastBranchStep(input), chartStep('East sales by branch', { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: FULL_INTERACTIONS, animation: 'reorder' }));
}
function comboChart(input: TurnPlannerInput): TurnPlan {
  return plan(eastBranchStep(input, true), chartStep('East sales and target', { primitiveId: 'combo', xFieldId: 'branch', yFieldIds: ['net_sales', 'target'], lineFieldIds: ['target'],
    interactionIds: ['inspect_data', 'tooltip', 'legend_toggle', 'select_point', 'reset'], animation: 'fade' }));
}
/** A chart family the data cannot support (a time chart over one date): the server answers with the exact table and says why. */
function unsuitableScatterChart(input: TurnPlannerInput): TurnPlan {
  return plan(eastBranchStep(input), chartStep('East sales scatter', { primitiveId: 'scatter', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data'], animation: 'none' }));
}
function allRegionsQueryStep(input: TurnPlannerInput): Record<string, unknown> {
  const query = queryPlan(input.context, {
    scope: { kind: 'all', sourceText: { text: 'all regions' }, confidence: 1 },
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return { kind: 'query', continuation: false, plan: query };
}
function allRegionsBar(input: TurnPlannerInput): TurnPlan {
  return plan(allRegionsQueryStep(input), chartStep('All region sales', { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data', 'tooltip'], animation: 'none' }));
}
function shareLatestArtifact(input: TurnPlannerInput): TurnPlan {
  const artifact = input.context.artifacts[0], recipient = eastManagerId(input.context);
  if (!artifact || !recipient) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลลัพธ์หรือผู้รับที่แชร์ได้' });
  return plan({ kind: 'action', actionId: 'artifact.share', params: { artifact: param(artifact.id, 'context_id'), recipientIds: param([recipient], 'context_id') } });
}
function sendWithArtifact(input: TurnPlannerInput): TurnPlan {
  const artifact = input.context.artifacts[0], recipient = eastManagerId(input.context), state = input.context.previousState?.stateId;
  if (!artifact || !recipient || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลลัพธ์หรือผู้รับที่ส่งข้อความถึงได้' });
  return plan({ kind: 'action', actionId: 'communication.send', params: { recipientIds: param([recipient], 'context_id'), content: param(state, 'context_id'), artifact: param(artifact.id, 'context_id') } });
}
/** Results library fixtures: the newest ARTIFACTS entry (or ARCHIVED_ARTIFACTS for unarchive) addressed by its server context id. */
function resultOp(operation: 'rename' | 'pin' | 'unpin' | 'archive' | 'save', title?: string) {
  return (input: TurnPlannerInput): TurnPlan => {
    const artifact = input.context.artifacts[0];
    if (!artifact) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลลัพธ์ในบทสนทนานี้ที่จัดการได้' });
    return plan({ kind: 'action', actionId: 'result.manage', params: { artifact: param(artifact.id, 'context_id'), operation: param(operation, 'generated'),
      ...(title ? { title: param(title, 'user_quoted', title) } : {}) } });
  };
}
function unarchiveResult(input: TurnPlannerInput): TurnPlan {
  const artifact = input.context.archivedArtifacts?.[0];
  if (!artifact) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลลัพธ์ที่เก็บถาวรไว้' });
  return plan({ kind: 'action', actionId: 'result.unarchive', params: { artifact: param(artifact.id, 'context_id') } });
}
function createTask(input: TurnPlannerInput): TurnPlan {
  void input;
  return plan({ kind: 'action', actionId: 'task.create', params: {
    title: param('East follow-up', 'generated'), priority: param('urgent', 'user_quoted', 'urgent'), dueDate: param('2026-10-05', 'user_quoted', '2026-10-05'),
    grouping: param('single', 'generated'), checklist: param(['Check sales', 'Check stock'], 'generated'),
  } });
}

/** S2: a derived branch set. Step 0 reads net sales and target per branch; step 1 opens Tickets for the branches below target (the server expands $step0). */
function belowTargetTickets(input: TurnPlannerInput): TurnPlan {
  const query = queryPlan(input.context, {
    scope: { kind: 'all', sourceText: { text: 'all branches' }, confidence: 1 },
    measures: [measure('net_sales', 'sum', 'sales'), measure('target', 'sum', 'target')],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return plan({ kind: 'query', continuation: false, plan: query }, { kind: 'action', actionId: 'ticket.create', params: {
    branchesFrom: param('$step0', 'context_id'), branchesRule: param('below_target', 'generated'), priority: param('high', 'user_quoted', 'high priority'),
    checklist: param(['Check sales', 'Check stock'], 'generated'),
  } });
}

function ticketWithFields(input: TurnPlannerInput): TurnPlan {
  void input;
  return plan({ kind: 'action', actionId: 'ticket.create', params: {
    branchIds: param(['E01', 'E02'], 'user_quoted', 'E01 and E02'), priority: param('urgent', 'user_quoted', 'urgent'),
    grouping: param('single', 'user_quoted', 'single'), dueDate: param('2026-10-05', 'user_quoted', '2026-10-05'),
    checklist: param(['Check sales', 'Check stock'], 'generated'),
  } });
}

/** The newest POLICIES entry (id AND version copied from the planner context) acknowledged as read. */
function acknowledgePolicy(input: TurnPlannerInput): TurnPlan {
  const first = input.context.policies?.[0];
  return first ? plan({ kind: 'action', actionId: 'policy.acknowledge', params: { policy: param(first.id, 'context_id'), version: param(first.version, 'context_id') } })
    : plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีเอกสาร Policy ที่บัญชีนี้รับทราบได้' });
}

function renameDashboard(input: TurnPlannerInput): TurnPlan {
  const dashboard = input.context.dashboards[0];
  if (!dashboard) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.rename' },
    missing: [{ slot: 'params.dashboard', reason: 'needs_target' }], question: 'Which listed dashboard should be renamed?', choices: [] });
  return plan({ kind: 'action', actionId: 'dashboard.rename', params: {
    dashboard: param(dashboard.id, 'context_id'), title: param('Regional pulse', 'user_quoted', 'Regional pulse'),
  } });
}

/** dashboard.manage over the selected (or newest listed) DASHBOARDS id: the server applies the Dashboard page's own organization rules. */
const organizeDashboard = (operation: 'pin' | 'unpin' | 'archive' | 'restore' | 'duplicate') => (input: TurnPlannerInput): TurnPlan => {
  const id = input.context.selectedTargets?.dashboards[0] ?? input.context.dashboards[0]?.id;
  if (!id) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.manage' },
    missing: [{ slot: 'params.dashboard', reason: 'needs_target' }], question: 'ต้องการจัดระเบียบ Dashboard ใดครับ', choices: [] });
  return plan({ kind: 'action', actionId: 'dashboard.manage', params: { dashboard: param(id, 'context_id'), operation: param(operation, 'generated') } });
};

/** monitor.manage rename of the selected (or newest listed) MONITORS id; display title only. */
function renameMonitor(input: TurnPlannerInput): TurnPlan {
  const id = input.context.selectedTargets?.monitors[0] ?? input.context.monitors?.[0]?.id;
  if (!id) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'monitor.manage' },
    missing: [{ slot: 'params.monitor', reason: 'needs_target' }], question: 'ต้องการเปลี่ยนชื่อ Monitor ใดครับ', choices: [] });
  return plan({ kind: 'action', actionId: 'monitor.manage', params: { monitor: param(id, 'context_id'), operation: param('rename', 'generated'),
    title: param('East watch', 'user_quoted', 'East watch') } });
}

function deleteDashboard(input: TurnPlannerInput): TurnPlan {
  const dashboard = input.context.dashboards[0];
  if (!dashboard) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.delete' },
    missing: [{ slot: 'params.dashboard', reason: 'needs_target' }], question: 'Which listed dashboard should be deleted?', choices: [] });
  return plan({ kind: 'action', actionId: 'dashboard.delete', params: { dashboard: param(dashboard.id, 'context_id') } });
}

/** Missing WHO: the AI asks, offering the listed recipients as tap-to-choose chips. */
function shareWithoutRecipient(input: TurnPlannerInput): TurnPlan {
  return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
    missing: [{ slot: 'params.recipientId', reason: 'absent' }], question: 'ต้องการแชร์ Dashboard นี้ให้ใครครับ',
    choices: input.context.recipients.map(item => ({ id: item.id, label: item.name })) });
}

/** A chip tap carries the server-saved choice; the message text is only the label, so the plan keys on the structured selection. */
function clarificationSelectionPlan(input: TurnPlannerInput): TurnPlan | undefined {
  const pending = input.context.pendingClarification;
  const dashboard = input.context.dashboards[0];
  // A tapped resource_lookup choice: the server admitted that exact id into the context; complete the clarified request with it.
  if (pending?.selection && pending.about === 'lookup:dashboard') return plan({ kind: 'action', actionId: 'dashboard.rename', params: { dashboard: param(pending.selection.id, 'context_id'), title: param('Found by lookup', 'generated') } });
  if (pending?.selection && pending.about === 'lookup:result') return plan({ kind: 'action', actionId: 'result.manage', params: { artifact: param(pending.selection.id, 'context_id'), operation: param('pin', 'generated') } });
  if (pending?.selection && pending.about === 'lookup:monitor') return plan({ kind: 'action', actionId: 'monitor.manage', params: { monitor: param(pending.selection.id, 'context_id'), operation: param('pause', 'generated') } });
  if (!pending?.selection || pending.about !== 'action:dashboard.share' || !dashboard) return undefined;
  return plan({ kind: 'action', actionId: 'dashboard.share', params: {
    dashboard: param(dashboard.id, 'context_id'), recipientId: param(pending.selection.id, 'context_id'),
  } });
}

// --- Registered table dataset flows (E2E-only) ---
const tMeasure = (fieldId: string, aggregation: string, text?: string) => ({ fieldId, aggregation,
  interpretation: { value: fieldId, source: text ? 'explicit' : 'default', sourceText: text ? { text } : null, confidence: 1 } });
const tDimension = (fieldId: string, text?: string) => ({ fieldId, interpretation: { value: fieldId, source: text ? 'explicit' : 'default', sourceText: text ? { text } : null, confidence: 1 } });
const tablePlan = (context: PlannerContext, datasetId: string, overrides: Record<string, unknown>) => queryPlan(context, { datasetId, grain: ['branch'], ...overrides });
function lowStockByBranch(input: TurnPlannerInput): TurnPlan {
  return plan({ kind: 'query', continuation: false, plan: { ...tablePlan(input.context, 'inventory_items', {
    measures: [tMeasure('low_stock_items', 'sum', 'low stock')], dimensions: [tDimension('branch', 'by branch')], group: { fieldIds: ['branch'] },
    sort: [{ fieldId: 'low_stock_items', direction: 'desc' }] }), time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'default', dates: [input.context.business.date] } } });
}
/** Low stock by branch restricted to the East region (the answer an East manager is authorized to receive in full). */
function eastLowStock(input: TurnPlannerInput): TurnPlan {
  const step = lowStockByBranch(input).steps[0] as unknown as { plan: Record<string, unknown> };
  return plan({ ...step, plan: { ...step.plan, filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }] } });
}
function incidentPage(input: TurnPlannerInput, more: boolean): TurnPlan {
  const cursor = input.context.references?.pagination?.nextCursor ?? null;
  return plan({ kind: 'query', continuation: more, plan: { ...tablePlan(input.context, 'incident_log', {
    measures: [tMeasure('incident_records', 'count')], dimensions: [tDimension('branch'), tDimension('kind')], aggregation: 'rows', grain: ['incident'],
    sort: [{ fieldId: 'branch', direction: 'asc' }], page: { limit: 2, cursor: more ? cursor : null } }),
  time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'default', dates: [input.context.business.date] } } });
}
function stockVsIncidents(input: TurnPlannerInput): TurnPlan {
  return plan({ kind: 'query', continuation: false, plan: { ...tablePlan(input.context, 'inventory_items', {
    measures: [tMeasure('stock_shortfall', 'sum', 'shortfall'), tMeasure('incident_log.incident_records', 'count', 'incidents')],
    dimensions: [tDimension('branch', 'by branch')], group: { fieldIds: ['branch'] }, joins: [{ datasetId: 'incident_log' }] }),
  time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'default', dates: [input.context.business.date] } } });
}
const stockDimension = (input: TurnPlannerInput) => ({ ...lowStockByBranch(input) });
/** Two steps in ONE turn over a registered table dataset: the low-stock answer, then a Dashboard / table / message bound to it (`$step0`). */
function lowStockStep(input: TurnPlannerInput): Record<string, unknown> { return stockDimension(input).steps[0] as unknown as Record<string, unknown>; }
function stockDashboard(input: TurnPlannerInput): TurnPlan {
  return plan(lowStockStep(input), { kind: 'action', actionId: 'dashboard.create', params: { title: param('Low stock by branch', 'generated'), source: param('$step0', 'context_id') },
    visualization: { version: 1, title: 'Low stock by branch', description: '', widgets: [
      { kind: 'bar', title: 'Low stock items', measure: 'low_stock_items', dimension: 'branch', sort: 'desc', topN: null },
      { kind: 'table', title: 'Low stock table', measure: 'low_stock_items', dimension: 'branch', sort: null, topN: null }] } });
}
function stockTableArtifact(input: TurnPlannerInput): TurnPlan {
  return plan(lowStockStep(input), { kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'table', operation: 'create', baseArtifactId: null,
    title: param('Low stock by branch', 'generated'), outputFormat: 'preview', visual: null });
}
function stockBarChart(input: TurnPlannerInput): TurnPlan {
  return plan(lowStockStep(input), chartStep('Low stock by branch', { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['low_stock_items'], interactionIds: ['inspect_data', 'tooltip'], animation: 'none' }));
}
function sendStockAnswer(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context), state = input.context.acceptedStates.find(s => ['inventory_items', 'incident_log', 'support_tickets'].includes(s.datasetId))?.stateId;
  if (!recipient || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีคำตอบหรือผู้รับที่ส่งข้อความถึงได้' });
  return plan({ kind: 'action', actionId: 'communication.send', params: { recipientIds: param([recipient], 'context_id'), content: param(state, 'context_id') } });
}
function alertStock(input: TurnPlannerInput): TurnPlan {
  const recipient = eastManagerId(input.context), state = input.context.acceptedStates.find(s => ['inventory_items', 'incident_log', 'support_tickets'].includes(s.datasetId))?.stateId;
  if (!recipient || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีคำตอบหรือผู้รับที่แจ้งเตือนได้' });
  return plan({ kind: 'action', actionId: 'monitor.create', params: { query: param(state, 'context_id'), threshold: param(0.9, 'user_quoted', '90%'), recipientIds: param([recipient], 'context_id') } });
}
function readPolicy(input: TurnPlannerInput): TurnPlan {
  const first = input.context.policies?.[0];
  return first ? plan({ kind: 'policy_read', policyIds: [first.id] })
    : plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีเอกสาร Policy ที่บัญชีนี้อ่านได้' });
}
// --- Dashboard chart families (E2E / integration): every widget family from scripted plans, in three turns over three accepted answers ---
const familyWidget = (kind: string, title: string, measure: string, dimension: string | null, extra: Record<string, unknown> = {}) =>
  ({ kind, title, measure, dimension, sort: null, topN: null, ...extra });
/** Turn 1: East branches (sales + target) -> a Dashboard with the branch-shaped families (table, bar, scatter, pie, donut, treemap, combo). */
function familiesDashboard(input: TurnPlannerInput): TurnPlan {
  return plan(eastBranchStep(input, true), { kind: 'action', actionId: 'dashboard.create', params: { title: param('East chart families', 'generated'), source: param('$step0', 'context_id') },
    visualization: { version: 1, title: 'East chart families', description: 'Every chart family drawn from verified East evidence', widgets: [
      familyWidget('table', 'Sales table', 'net_sales', 'branch'), familyWidget('bar', 'Sales by branch', 'net_sales', 'branch', { sort: 'desc' }),
      familyWidget('scatter', 'Sales vs target', 'net_sales', 'branch', { measures: ['target'] }), familyWidget('pie', 'Sales share (pie)', 'net_sales', 'branch'),
      familyWidget('donut', 'Sales share (donut)', 'net_sales', 'branch'), familyWidget('treemap', 'Sales share (treemap)', 'net_sales', 'branch'),
      familyWidget('combo', 'Sales (bars) and target (line)', 'net_sales', 'branch', { measures: ['target'], lineMeasures: ['target'] })] } });
}
/** Turn 2: East sales by branch over three days -> appends the time/matrix families (line, area, heatmap) to the newest Dashboard. */
function familiesTrendRefine(input: TurnPlannerInput): TurnPlan {
  const dashboard = input.context.dashboards[0];
  if (!dashboard) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.rename' }, missing: [{ slot: 'params.dashboard', reason: 'needs_target' }], question: 'Which listed dashboard should change?', choices: [] });
  const query = queryPlan(input.context, {
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } },
      { fieldId: 'date', interpretation: { value: 'date', source: 'explicit', sourceText: { text: 'trend' }, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }],
    aggregation: 'rows', grain: ['branch', 'date'], group: { fieldIds: [] },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-09-29', '2026-09-30', '2026-10-01'], evidenceText: '3-day' },
  });
  return plan({ kind: 'query', continuation: false, plan: query }, { kind: 'refine', pendingActionId: dashboard.id, operation: { op: 'revise_dashboard', sourceStateId: '$step0', visualizationMode: 'append',
    visualization: { version: 1, title: 'East chart families', description: '', widgets: [
      familyWidget('line', 'Sales trend (line)', 'net_sales', 'date'), familyWidget('area', 'Sales trend (area)', 'net_sales', 'date'),
      familyWidget('heatmap', 'Sales by branch and day', 'net_sales', 'branch', { groupDimension: 'date' })] } } });
}
/** Turn 3: one East total -> appends a KPI widget. */
function familiesKpiRefine(input: TurnPlannerInput): TurnPlan {
  const dashboard = input.context.dashboards[0];
  if (!dashboard) return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.rename' }, missing: [{ slot: 'params.dashboard', reason: 'needs_target' }], question: 'Which listed dashboard should change?', choices: [] });
  return plan(eastSalesVsTargetStep(input, false), { kind: 'refine', pendingActionId: dashboard.id, operation: { op: 'revise_dashboard', sourceStateId: '$step0', visualizationMode: 'append',
    visualization: { version: 1, title: 'East chart families', description: '', widgets: [familyWidget('kpi', 'East total sales', 'net_sales', null)] } } });
}
export const SCRIPTED_DASHBOARD_FAMILY_PROMPTS = ['Build a dashboard of East sales and target by branch for 2026-10-01 with every chart family.', 'Add a 3-day East sales trend to my dashboard.', 'Add the East total sales for 2026-10-01 to my dashboard.'] as const;

/** Closure fixtures: a five-measure top-3 ranking Result (Result -> Dashboard fidelity) and a revision (v2) of the newest chart Result. */
export const SCRIPTED_RANKING_FIVE_PROMPT = 'Rank East branches by sales, target, gap, achievement and staffing on 2026-10-01 and keep the top 3.';
export const SCRIPTED_REVISE_CHART_PROMPT = 'Revise my latest chart with a new title.';
function eastRankingFive(input: TurnPlannerInput): TurnPlan {
  const query = queryPlan(input.context, {
    measures: [measure('net_sales', 'sum', 'sales'), measure('target', 'sum', 'target'), measure('gap', 'gap', 'gap'), measure('achievement', 'weighted_ratio', 'achievement'), measure('staffing_actual', 'sum', 'staffing')],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }],
    grain: ['branch', 'date'], group: { fieldIds: ['branch'] }, sort: [{ fieldId: 'net_sales', direction: 'desc' }],
    topN: { count: 3, direction: 'highest', completeScopeRequired: true },
    completeness: { expectation: 'complete_authorized_population', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
    time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  });
  return plan({ kind: 'query', continuation: false, plan: query }, { kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'ranking', operation: 'create', baseArtifactId: null,
    title: param('East top 3 branches', 'generated'), outputFormat: 'preview', visual: null });
}
/** Resource lookup fixtures (older resources outside the bounded context window). The tapped choice completes the request through clarificationSelectionPlan. */
export const SCRIPTED_LOOKUP_PROMPTS = { dashboard: 'Find my older dashboard called Archive Alpha.', result: 'Find my older result called Old East.', monitor: 'Find my older monitor called Legacy.' } as const;
export const SCRIPTED_SHARE_THIS_RESULT_PROMPT = 'Share the result I selected with East manager.';
const lookup = (resource: 'dashboard' | 'result' | 'monitor', query: string) => (): TurnPlan => plan({ kind: 'resource_lookup', resource, query });
function shareSelectedResult(input: TurnPlannerInput): TurnPlan {
  const artifactId = input.context.selectedTargets?.artifacts[0], recipient = eastManagerId(input.context);
  if (!artifactId || !recipient) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลลัพธ์ที่เลือกหรือผู้รับที่แชร์ได้' });
  return plan({ kind: 'action', actionId: 'artifact.share', params: { artifact: param(artifactId, 'context_id'), recipientIds: param([recipient], 'context_id') } });
}
function reviseLatestChart(input: TurnPlannerInput): TurnPlan {
  const artifact = input.context.artifacts[0], state = input.context.previousState?.stateId;
  if (!artifact || !state) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีกราฟในบทสนทนานี้ที่ปรับได้' });
  return plan({ kind: 'artifact', sourceStateId: state, artifactTypeId: 'chart', operation: 'revise', baseArtifactId: artifact.id, title: param('East sales and target (revised)', 'generated'), outputFormat: 'preview',
    visual: { primitiveId: 'combo', xFieldId: 'branch', yFieldIds: ['net_sales', 'target'], lineFieldIds: ['target'], interactionIds: ['inspect_data', 'tooltip', 'legend_toggle', 'select_point', 'reset'], animation: 'fade' } });
}

export const SCRIPTED_POLICY_FLOW_PROMPTS = ['Show the policy.', 'Acknowledge the policy.'] as const;

/** HR Director (Workflow V2) fixtures: ids come only from SERVER_CONTEXT.workflow (newest reviewed queue / verified approval). */
const noWorkflow = () => plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีคิวอนุมัติที่ตรวจแล้วในบทสนทนานี้' });
const newestQueue = (input: TurnPlannerInput) => input.context.workflow?.reviewedQueues[0];
const DIRECTOR_ONLY_PROSE = 'คิวอนุมัติ Onboarding ขั้นผู้อำนวยการใช้ได้เฉพาะบัญชี HR Director — บัญชีนี้ไม่มีสิทธิ์ดูหรืออนุมัติคิวนี้';
function directorQueueRead(input?: TurnPlannerInput): TurnPlan {
  // An account without the Director reads gets a role-specific refusal, never a workflow_read it cannot be offered.
  if (input && !input.context.workflow?.reads.length) return plan({ kind: 'conversation', topic: 'out_of_scope', prose: DIRECTOR_ONLY_PROSE });
  return plan({ kind: 'workflow_read', readId: 'director_queue' });
}
/** The next page of the waiting queue: a new read after the newest reviewed queue (the server derives the cursor). */
function directorQueueNext(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input);
  return queue ? plan({ kind: 'workflow_read', readId: 'director_queue', snapshotId: queue.id }) : directorQueueRead(input);
}
function directorStartDates(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input);
  return queue ? plan({ kind: 'workflow_read', readId: 'director_start_dates', snapshotId: queue.id }) : noWorkflow();
}
function directorDocuments(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input), first = queue?.requests[0];
  return queue && first ? plan({ kind: 'workflow_read', readId: 'director_request_documents', snapshotId: queue.id, requestId: first.id }) : noWorkflow();
}
function directorApproveFirst(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input), first = queue?.requests[0];
  return queue && first ? plan({ kind: 'action', actionId: 'onboarding.director_approve', params: { queue: param(queue.id, 'context_id'),
    selection: param('subset', 'user_quoted', 'the first request'), requestIds: param([first.id], 'context_id') } }) : noWorkflow();
}
function directorApproveAll(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input);
  return queue ? plan({ kind: 'action', actionId: 'onboarding.director_approve', params: { queue: param(queue.id, 'context_id'),
    selection: param('all_reviewed', 'user_quoted', 'all the requests I just reviewed') } }) : noWorkflow();
}
function directorReturnFirst(input: TurnPlannerInput): TurnPlan {
  const queue = newestQueue(input), first = queue?.requests[0];
  return queue && first ? plan({ kind: 'action', actionId: 'onboarding.return', params: { queue: param(queue.id, 'context_id'),
    requestIds: param([first.id], 'context_id'), reason: param('the signed contract is wrong', 'user_quoted', 'the signed contract is wrong') } }) : noWorkflow();
}
function directorEmail(input: TurnPlannerInput): TurnPlan {
  const approval = input.context.workflow?.verifiedApprovals[0];
  return approval ? plan({ kind: 'action', actionId: 'onboarding.notify_email', params: { approval: param(approval.id, 'context_id'),
    subject: param('แจ้งผลการอนุมัติคำขอ Onboarding', 'generated'),
    body: param('เรียนผู้เกี่ยวข้อง ผู้อำนวยการฝ่ายบุคคลได้อนุมัติคำขอ Onboarding ตามรายการด้านล่างแล้ว', 'generated') } })
    : plan({ kind: 'conversation', topic: 'out_of_scope', prose: 'ยังไม่มีผลการอนุมัติที่ตรวจแล้วให้แจ้ง' });
}
export const SCRIPTED_DIRECTOR_FLOW_PROMPTS = ['Show the onboarding requests waiting for my approval.', 'Show the next onboarding requests waiting for my approval.', 'Sort them by start date.',
  'Show the documents of the first request.', 'Approve the first request.', 'Approve all the requests I just reviewed.',
  'Email the related people that these requests were approved.', 'Return the first request because the signed contract is wrong.'] as const;
export const SCRIPTED_TABLE_FLOW_PROMPTS = ['Show low stock by branch.', 'List incidents.', 'Show more incidents.', 'Compare shortfall and incidents by branch.',
  'Build a dashboard of low stock by branch.', 'Make a table of low stock by branch.', 'Make a bar chart of low stock by branch.', 'Send this stock answer to East manager.',
  'Alert East manager when low stock is below 90%.', 'Show East low stock by branch.'] as const;

export const SCRIPTED_ROUTER_FLOW_PROMPTS = [
  'Rename my dashboard to Regional pulse', 'Delete my dashboard', 'Send this answer to East manager.',
  'Show East sales and target for 2026-10-01.', 'Alert East manager when sales fall below 90% of target.', 'Share my dashboard',
  'Export East sales and target for 2026-10-01 as a CSV file.',
  'Make a donut chart of sales across all regions on 2026-10-01.', 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.',
  'Make a combo chart of East sales and target by branch for 2026-10-01.', 'Make a scatter plot of East sales by branch for 2026-10-01.',
  'Make a bar chart of sales across all regions on 2026-10-01.', 'Share my chart with East manager.', 'Send this answer with my chart to East manager.',
  'Create an urgent East follow-up task due 2026-10-05 with a checklist.',
  'Open an urgent single ticket for E01 and E02 due 2026-10-05.',
  'Open a high priority ticket for all branches with sales below target on 2026-10-01.',
  'Summarize East sales and target for 2026-10-01 and send it to East manager.',
  'Summarize East sales and target for 2026-10-01 and alert East manager below 90% of target.',
] as const;

/** Scripted stand-in for the model's optional follow-up proposals (plain Thai, no digits or entity labels; unknown prompts have none). */
const EAST_FOLLOW_UPS = ['เปรียบเทียบกับภูมิภาคอื่นได้ไหม', 'ช่วยสรุปเป็นรายงานสั้น ๆ ให้หน่อย'];
const LOWEST_FOLLOW_UPS = ['ขอดูเฉพาะสาขาที่ต่ำกว่าเป้าหมาย', 'ส่งออกผลลัพธ์นี้เป็นไฟล์ได้ไหม'];
const withFollowUps = (base: TurnPlan, followUps: string[]): TurnPlan => ({ ...base, followUps });
const withTitle = (base: TurnPlan, suggestedConversationTitle: string): TurnPlan => ({ ...base, suggestedConversationTitle });

/** PRODUCT MODEL self-help prompts (exact keys, like every fixture): scripted stand-ins for the model's product_help plans. */
const productHelp = (prose: string, concepts?: string[]): Fixture => () => plan({ kind: 'conversation', topic: 'product_help', prose, ...(concepts ? { concepts } : {}) });
const PRODUCT_OVERVIEW_PROSE = 'DaTex คือผู้ช่วย AI สำหรับข้อมูลธุรกิจภายในสิทธิ์ของคุณ ถามคำถามใน Chat วิเคราะห์ เก็บผลเป็น Results จัดการ Dashboard สื่อสารผ่าน Messages ดำเนินการ Actions ที่ลงทะเบียนไว้ และตรวจสอบย้อนหลังใน History';
export const SCRIPTED_PRODUCT_HELP: Readonly<Record<string, Fixture>> = {
  'แนะนำ DaTex ให้หน่อย': productHelp(PRODUCT_OVERVIEW_PROSE),
  'platform นี้ทำอะไรได้บ้าง': productHelp(PRODUCT_OVERVIEW_PROSE),
  'Dashboard กับ Result ต่างกันยังไง': productHelp('Result คือผลวิเคราะห์จากคำตอบที่ตรวจสอบได้ ข้อมูลเป็น snapshot ที่คงค่าเดิมไว้ ส่วน Dashboard เก็บนิยามคำค้นและดึงข้อมูลตามสิทธิ์ปัจจุบันใหม่ทุกครั้งที่เปิดหรือรีโหลด ไม่ได้อัปเดตแบบเรียลไทม์ ถ้านำ Result ไปใส่ Dashboard ตัว Widget จะใช้นิยามคำค้นของ Result นั้น และ Result เดิมไม่เปลี่ยน', ['result', 'dashboard']),
  'Result คืออะไร': productHelp('Result คือผลวิเคราะห์ เช่น กราฟ ตาราง การจัดอันดับ สรุปผู้บริหาร หรือ CSV จากคำตอบที่ตรวจสอบได้ ข้อมูลเป็น snapshot ที่คงค่าเดิมไว้และไม่อัปเดตเอง การปรับแก้จะได้เวอร์ชันใหม่', ['result']),
  'Monitor คืออะไร': productHelp('Monitor คือเงื่อนไขที่บันทึกไว้เพื่อตรวจข้อมูลตามรอบที่ระบบกำหนด ทุกรอบจะตรวจสิทธิ์และสถานะใหม่ และแจ้งเตือนเข้า Messages เมื่อเข้าเงื่อนไข', ['monitor']),
  'ทำไมบาง Action ต้องยืนยัน': productHelp('Action ที่แชร์ถึงผู้อื่นหรือย้อนกลับไม่ได้ต้องผ่านการเตรียม แสดงตัวอย่าง และให้คุณยืนยันอย่างชัดเจนก่อน จากนั้นระบบจึงดำเนินการ ตรวจผล และออกใบยืนยัน ส่วนงานส่วนตัวที่ย้อนกลับได้อาจทำได้ทันทีตามนโยบาย', ['action']),
  'Dashboard อัปเดตข้อมูลยังไง': productHelp('Dashboard เก็บนิยามคำค้น ขอบเขต และรูปแบบกราฟไว้ แล้วดึงข้อมูลตามสิทธิ์ปัจจุบันใหม่ทุกครั้งที่เปิดหรือรีโหลด ไม่ได้อัปเดตแบบเรียลไทม์หรือส่งข้อมูลเข้ามาเอง', ['dashboard']),
};

const fixtures = new Map<string, Fixture>([
  ...Object.entries(SCRIPTED_PRODUCT_HELP),
  ['Build a dashboard of East sales and target by branch for 2026-10-01 with every chart family.', familiesDashboard],
  ['Add a 3-day East sales trend to my dashboard.', familiesTrendRefine],
  ['Add the East total sales for 2026-10-01 to my dashboard.', familiesKpiRefine],
  ['Show low stock by branch.', lowStockByBranch],
  ['Show the policy.', readPolicy],
  ['Acknowledge the policy.', acknowledgePolicy],
  ['Show the onboarding requests waiting for my approval.', directorQueueRead],
  ['Show the next onboarding requests waiting for my approval.', directorQueueNext],
  ['Sort them by start date.', directorStartDates],
  ['Show the documents of the first request.', directorDocuments],
  ['Approve the first request.', directorApproveFirst],
  ['Approve all the requests I just reviewed.', directorApproveAll],
  ['Email the related people that these requests were approved.', directorEmail],
  ['Return the first request because the signed contract is wrong.', directorReturnFirst],
  ['List incidents.', input => incidentPage(input, false)],
  ['Show more incidents.', input => incidentPage(input, true)],
  ['Show East low stock by branch.', eastLowStock],
  ['Build a dashboard of low stock by branch.', stockDashboard],
  ['Make a table of low stock by branch.', stockTableArtifact],
  ['Make a bar chart of low stock by branch.', stockBarChart],
  ['Send this stock answer to East manager.', sendStockAnswer],
  ['Alert East manager when low stock is below 90%.', alertStock],
  ['Compare shortfall and incidents by branch.', stockVsIncidents],
  ['ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569', input => regionQuery(input, 'east', 'ภาคตะวันออก', '2026-10-01', '1 ตุลาคม 2569')],
  ['แล้วภาคกลางล่ะ', input => regionQuery(input, 'central', 'ภาคกลาง', undefined, undefined, true, inheritedDate(input))],
  ['May I see E01 sales?', branchQuery],
  ['ยอดขายภาคใต้', input => regionQuery(input, 'south', 'ภาคใต้')],
  ['แล้วภาคกลางยอดขายล่ะ', input => regionQuery(input, 'central', 'ภาคกลาง', undefined, undefined, true, inheritedDate(input))],
  ['sales in May 2025', may2025Query],
  ['bottom 3 vs target', input => withFollowUps(lowestThreeQuery(input), LOWEST_FOLLOW_UPS)],
  ['Compare sales across all regions on 2026-10-01.', exactDateQuery],
  ['Show East sales totals for 2026-10-01.', eastDateQuery],
  ['Create dashboard.', () => dashboardCreate()],
  ['Create a sales dashboard', () => dashboardCreate('Sales overview')],
  ['Share dashboard with East manager.', input => shareDashboard(input.context)],
  ['Revoke badge C102 for E024 because their employment ended.', () => badgeRevoke()],
  ['Revoke badge C001 for E001 because their employment ended.', () => badgeRevoke('C001', 'E001')],
  ['Revoke badge C002 for E002 because their employment ended.', () => badgeRevoke('C002', 'E002')],
  ['Rename my dashboard to Regional pulse', renameDashboard],
  ['Delete my dashboard', deleteDashboard],
  ['Pin my dashboard.', organizeDashboard('pin')],
  ['Unpin my dashboard.', organizeDashboard('unpin')],
  ['Archive my dashboard.', organizeDashboard('archive')],
  ['Restore my archived dashboard.', organizeDashboard('restore')],
  ['Duplicate my dashboard.', organizeDashboard('duplicate')],
  ['Rename my monitor to East watch.', renameMonitor],
  ['Send this answer to East manager.', sendThisAnswer],
  ['Show East sales and target for 2026-10-01.', input => withTitle(withFollowUps(plan(eastSalesVsTargetStep(input)), EAST_FOLLOW_UPS), 'ยอดขายเทียบ Target')],
  ['Alert East manager when sales fall below 90% of target.', alertEastManager],
  ['Share my dashboard', shareWithoutRecipient],
  ['Export East sales and target for 2026-10-01 as a CSV file.', exportEastCsv],
  ['Make a donut chart of sales across all regions on 2026-10-01.', donutChart],
  ['Make a bar chart of East sales by branch for 2026-10-01 with drilldown.', drillBar],
  ['Make a combo chart of East sales and target by branch for 2026-10-01.', comboChart],
  ['Make a scatter plot of East sales by branch for 2026-10-01.', unsuitableScatterChart],
  ['Make a bar chart of sales across all regions on 2026-10-01.', allRegionsBar],
  ['Share my chart with East manager.', shareLatestArtifact],
  ['Send this answer with my chart to East manager.', sendWithArtifact],
  ['Create an urgent East follow-up task due 2026-10-05 with a checklist.', createTask],
  ['Open an urgent single ticket for E01 and E02 due 2026-10-05.', ticketWithFields],
  ['Open a high priority ticket for all branches with sales below target on 2026-10-01.', belowTargetTickets],
  ['Summarize East sales and target for 2026-10-01 and send it to East manager.', summarizeAndSend],
  ['Summarize East sales and target for 2026-10-01 and alert East manager below 90% of target.', summarizeAndAlert],
  ['Rename my latest result to East weekly view.', resultOp('rename', 'East weekly view')],
  ['Pin my latest result.', resultOp('pin')],
  ['Unpin my latest result.', resultOp('unpin')],
  ['Archive my latest result.', resultOp('archive')],
  ['Save my latest result.', resultOp('save')],
  ['Restore my archived result.', unarchiveResult],
  [SCRIPTED_RANKING_FIVE_PROMPT, eastRankingFive],
  [SCRIPTED_REVISE_CHART_PROMPT, reviseLatestChart],
  [SCRIPTED_LOOKUP_PROMPTS.dashboard, lookup('dashboard', 'Archive Alpha')],
  [SCRIPTED_LOOKUP_PROMPTS.result, lookup('result', 'Old East')],
  [SCRIPTED_LOOKUP_PROMPTS.monitor, lookup('monitor', 'Legacy')],
  [SCRIPTED_SHARE_THIS_RESULT_PROMPT, shareSelectedResult],
]);

/** Exact-prompt local E2E fixtures. No fallback or language matching is performed. */
export function scriptedTurnPlan(input: TurnPlannerInput): TurnPlan {
  const selected = clarificationSelectionPlan(input);
  if (selected) return selected;
  const fixture = fixtures.get(input.currentMessage);
  if (!fixture) throw new ScriptedTurnPlannerFixtureMissing();
  return fixture(input);
}
