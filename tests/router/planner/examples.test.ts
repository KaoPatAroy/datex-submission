import { describe, expect, it } from 'vitest';
import type { Branch } from '@/lib/contracts';
import { actionRegistry } from '@/lib/router/action-registry';
import type { PlannerContext } from '@/lib/router/planner-context';
import { buildTurnPlannerInput } from '@/lib/router/planner/input';
import { EXAMPLE_BUSINESS_DATE, EXAMPLE_WINDOW, PLANNER_EXAMPLES, plannerExamplesText, type PlannerExample } from '@/lib/router/planner/examples';
import { validateTurnPlan } from '@/lib/router/validate';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { canonicalizeHrPlan, createWave2Catalog, validateHrQueryPlan } from '@/lib/dynamic/catalog/hr';
import { canonicalizeQueryPlan } from '@/lib/dynamic/plan/canonical';
import { canonicalizeTablePlan, encodeTableCursor, tableDatasetOf, validateTablePlan } from '@/lib/dynamic/table/engine';
import { normalizeQueryPlan, resolveSpan } from '@/lib/dynamic/plan/normalize';
import { dateList } from '@/lib/dynamic/plan/time';
import { validateQueryPlan, type ActorAuthority } from '@/lib/dynamic/validate/query-plan';
import type { QueryPlan } from '@/lib/dynamic/plan/schemas';

const BRANCHES: Branch[] = [
  { id: 'BR_A', name: 'Demo East Branch 1', region: 'east' }, { id: 'BR_B', name: 'Demo East Branch 2', region: 'east' },
  { id: 'C01', name: 'Demo Central Branch 1', region: 'central' }, { id: 'C02', name: 'Demo Central Branch 2', region: 'central' },
];
const catalog = createSemanticCatalog(BRANCHES);
const EXEC_PERMISSIONS = ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'];
const HR_PERMISSIONS = ['hr.read', 'badge.revoke'];
const HR_EXAMPLES = new Set(['hr_headcount', 'hr_lookup', 'badge_revoke']);
const DIRECTOR_PERMISSIONS = ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'];
const DIRECTOR_EXAMPLES = new Set(['director_queue', 'director_queue_next', 'director_start_dates', 'director_documents', 'director_approve_all', 'director_approve_subset', 'director_return', 'director_email']);

/** HR Director: no datasets; Workflow V2 reads + one reviewed queue and one verified approval (server projection shapes). */
function directorContext(): PlannerContext {
  return {
    business: { date: EXAMPLE_BUSINESS_DATE, weekday: 'Thursday', timezone: 'Asia/Bangkok', availability: null },
    scope: { actorId: 'director', role: 'hr_director', regionIds: ['east'], branchIds: [], permissions: DIRECTOR_PERMISSIONS },
    catalog: { datasets: [], measureIds: [], choices: [] },
    actions: actionRegistry.describeFor({ permissions: DIRECTOR_PERMISSIONS }),
    recipients: [], pendingActions: [], dashboards: [], acceptedStates: [], artifacts: [], pendingClarification: null, conversation: [], previousState: null,
    workflow: {
      reads: ['director_queue', 'director_start_dates', 'director_request_documents', 'director_approvals_today'].map(readId => ({ readId, description: readId })),
      reviewedQueues: [{ id: 'RQ_1', expiresAt: '2030-03-14T10:00:00.000Z', requests: ['REQ_1', 'REQ_2', 'REQ_3'].map(id => ({ id, label: `Employee ${id}`, startDate: '2030-03-28' })) }],
      verifiedApprovals: [{ id: 'APR_1', label: 'อนุมัติแล้ว: Employee REQ_1', requestIds: ['REQ_1'] }],
    },
  };
}
const contextOf = (id: string): PlannerContext => DIRECTOR_EXAMPLES.has(id) ? directorContext() : contextFor(HR_EXAMPLES.has(id));

function contextFor(hr: boolean): PlannerContext {
  const permissions = hr ? HR_PERMISSIONS : EXEC_PERMISSIONS;
  return {
    business: { date: EXAMPLE_BUSINESS_DATE, weekday: 'Thursday', timezone: 'Asia/Bangkok', availability: { ...EXAMPLE_WINDOW } },
    scope: { actorId: hr ? 'hr' : 'executive', role: hr ? 'hr_admin' : 'executive', regionIds: ['central', 'east'], branchIds: BRANCHES.map(b => b.id), permissions },
    catalog: { datasets: hr ? [{ id: 'hr_employees', label: 'รายชื่อพนักงาน' }] : catalog.datasets.map(d => ({ id: d.id, label: d.label ?? d.id })),
      measureIds: ['net_sales', 'target', 'gap'], choices: [{ id: 'east', label: 'ภาคตะวันออก' }, { id: 'central', label: 'ภาคกลาง' }] },
    actions: actionRegistry.describeFor({ permissions }),
    recipients: [{ id: 'east', name: 'ผู้จัดการภาคตะวันออก', role: 'east_manager' }],
    pendingActions: [{ id: 'PEND_1', kind: 'communication.send', title: 'ส่งสรุปยอดขาย', widgetIndexes: [], values: {} }],
    dashboards: [{ id: 'DB_1', title: 'ยอดขายภาคตะวันออก' }, { id: 'DB_2', title: 'ภาพรวมขายตะวันออก' }],
    lookup: hr ? undefined : { resources: ['dashboard', 'result', 'monitor'] },
    monitors: [{ id: 'MON_1', title: 'เฝ้าติดตามยอดขายต่ำกว่าเป้า', status: 'active' }],
    acceptedStates: [{ stateId: 'ACC_1', datasetId: 'branch_performance', label: 'คำตอบยอดขาย ภาคตะวันออก' }, { stateId: 'TAB_1', datasetId: 'inventory_items', label: 'คำตอบรายละเอียดสต็อกสินค้า' }],
    artifacts: [{ id: 'ART_1', typeId: 'chart', title: 'กราฟยอดขายรายสาขา' }], archivedArtifacts: [{ id: 'ART_9', typeId: 'chart', title: 'กราฟที่เก็บไว้' }], pendingClarification: null, conversation: [], ...(hr ? {} : { policies: [{ id: 'POL_1', title: 'Incident handling', version: '1.0' }], shownPolicies: [{ id: 'POL_1', version: '1.0' }] }),
    previousState: { stateId: 'ACC_1', values: { regionIds: ['east'], date: EXAMPLE_BUSINESS_DATE } },
  };
}

const authority: ActorAuthority = { id: 'executive', active: true, permissions: EXEC_PERMISSIONS, regions: ['central', 'east'], revision: 1 };
const windowDates = dateList(EXAMPLE_WINDOW.from, EXAMPLE_WINDOW.to, 62);
const priorPlan = (dates: string[]): QueryPlan => ({
  planVersion: 1, planId: 'prior', datasetId: 'branch_performance',
  measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }],
  dimensions: [], filters: [], scope: null, time: { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'default', dates }, grain: ['branch', 'date'],
  aggregation: 'registered', multiDateGrain: null, group: { fieldIds: [] }, compare: null, sort: [], topN: null,
  completeness: { expectation: 'requested_scope', requireFullPopulation: false, requiredSourceIds: [], minimumCoverage: 0 },
  clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
});

function checkTable(example: PlannerExample, plan: QueryPlan): string | null {
  const dataset = tableDatasetOf(catalog, plan.datasetId);
  const window = { min: EXAMPLE_WINDOW.from, max: EXAMPLE_WINDOW.to };
  const canonical = canonicalizeTablePlan(plan, dataset, { authorizedRegions: ['central', 'east'] });
  const normalized = normalizeQueryPlan(canonical, example.say, EXAMPLE_BUSINESS_DATE, undefined, { availability: window });
  if (normalized.outcome !== 'normalized') return `normalize: ${normalized.code}`;
  const run = (proposal: QueryPlan) => validateTablePlan({ proposal, catalog, authority, sourceText: example.say, businessDate: EXAMPLE_BUSINESS_DATE, availabilityWindow: window, products: [] });
  let result = run(normalized.plan);
  if (normalized.plan.page?.cursor) {
    // The prompt shows a placeholder cursor; a real one is derived from the server binding of the same plan shape.
    const probe = run({ ...normalized.plan, page: { ...normalized.plan.page, cursor: null } });
    if (probe.outcome !== 'accepted') return `validate: ${probe.code}`;
    result = run({ ...normalized.plan, page: { ...normalized.plan.page, cursor: encodeTableCursor(probe.bindingDigest, 10) } });
    if (result.outcome === 'accepted' && result.page.offset !== 10) return 'cursor offset not applied';
  }
  return result.outcome === 'accepted' ? null : `validate: ${result.code}`;
}

function checkQuery(example: PlannerExample, plan: QueryPlan): string | null {
  if (plan.datasetId !== 'branch_performance') return checkTable(example, plan);
  const dataset = catalog.datasets[0];
  const previous = example.priorDates ? priorPlan(example.priorDates) : undefined;
  const canonical = canonicalizeQueryPlan(plan, dataset, { previousPlan: previous, authorizedRegions: ['central', 'east'] });
  const normalized = normalizeQueryPlan(canonical, example.say, EXAMPLE_BUSINESS_DATE, example.priorDates, { availability: { min: EXAMPLE_WINDOW.from, max: EXAMPLE_WINDOW.to } });
  if (normalized.outcome !== 'normalized') return `normalize: ${normalized.code}`;
  const result = validateQueryPlan(normalized.plan, catalog, authority, {
    sourceText: example.say, businessDate: EXAMPLE_BUSINESS_DATE, dates: windowDates, branchIds: BRANCHES.map(b => b.id),
    sourceSystems: ['sales', 'targets', 'inventory', 'incidents', 'staffing'], availabilityWindow: { min: EXAMPLE_WINDOW.from, max: EXAMPLE_WINDOW.to },
    ...(previous ? { previousPlan: previous, previousDates: example.priorDates } : {}),
  });
  return result.outcome === 'accepted' ? null : `validate: ${result.code}`;
}

function checkHr(example: PlannerExample, plan: QueryPlan): string | null {
  // The HR executor grounds every span text first (offsets are server-owned); mirror that here.
  const grounded = canonicalizeHrPlan(plan);
  for (const item of [...grounded.measures, ...grounded.dimensions]) {
    if (item.interpretation.sourceText) item.interpretation.sourceText = resolveSpan(example.say, item.interpretation.sourceText.text);
  }
  const result = validateHrQueryPlan({ proposal: grounded, catalog: createWave2Catalog(BRANCHES), sourceText: example.say,
    actor: { id: 'hr', role: 'hr_admin', active: true, revision: 1, permissions: HR_PERMISSIONS, regions: ['*'], branchIds: null, recipientIds: [] } });
  return result.outcome === 'accepted' ? null : `hr: ${result.code}`;
}

/** Mirrors resolveVizWidgetData: a widget must bind to the step-0 evidence shape (kpi = one total; bar/line/table by a grouped dimension). */
function checkWidgets(query: QueryPlan, visualization: { widgets: { kind: string; measure: string; dimension: string | null }[] }): string | null {
  for (const widget of visualization.widgets) {
    if (!query.measures.some(m => m.fieldId === widget.measure)) return `widget measure ${widget.measure} not in query`;
    if (widget.dimension === null) {
      if (widget.kind !== 'kpi' && widget.kind !== 'table') return `${widget.kind} needs a dimension`;
      if (widget.kind === 'kpi' && query.group.fieldIds.length) return 'kpi_not_single_value';
    } else {
      if (widget.kind === 'kpi') return 'kpi_has_dimension';
      if (!query.dimensions.some(d => d.fieldId === widget.dimension) || !query.group.fieldIds.includes(widget.dimension)) return `dimension ${widget.dimension} not in evidence`;
    }
  }
  return null;
}

describe('planner prompt examples', () => {
  it('are all in the prompt verbatim', () => {
    const sales = buildTurnPlannerInput(contextFor(false), { current: 'x' }).prompt;
    const hr = buildTurnPlannerInput(contextFor(true), { current: 'x' }).prompt;
    const director = buildTurnPlannerInput(directorContext(), { current: 'x' }).prompt;
    for (const example of PLANNER_EXAMPLES) expect(DIRECTOR_EXAMPLES.has(example.id) ? director : HR_EXAMPLES.has(example.id) ? hr : sales).toContain(JSON.stringify(example.plan));
    // Director actions/reads are never advertised to Sales or HR Admin; Sales/HR examples are never shown to the Director.
    expect(sales).not.toContain('onboarding.director_approve');
    expect(hr).not.toContain('workflow_read');
    expect(director).not.toContain('"actionId":"dashboard.create"');
    // Only examples the actor could use: no foreign action ids or datasets are advertised.
    expect(sales).not.toContain('"actionId":"badge.revoke"');
    expect(hr).not.toContain('"actionId":"dashboard.create"');
    expect(plannerExamplesText()).toContain('badge.revoke');
  });

  it.each(PLANNER_EXAMPLES.map(example => [example.id, example] as const))('%s validates end-to-end', (_id, example) => {
    const context = contextOf(example.id);
    const result = validateTurnPlan({ raw: example.plan, messages: { current: example.say }, context, registry: actionRegistry });
    expect(result.outcome, JSON.stringify(result)).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    for (const grounded of result.steps) {
      const step = grounded.step;
      if (step.kind === 'query') expect(checkQuery(example, step.plan)).toBeNull();
      if (step.kind === 'hr_query') expect(checkHr(example, step.plan)).toBeNull();
      if (step.kind === 'action' && step.visualization) {
        const first = result.steps[0]?.step;
        expect(first?.kind).toBe('query');
        if (first?.kind === 'query') expect(checkWidgets(first.plan, step.visualization)).toBeNull();
      }
      if (step.kind === 'clarify') expect(grounded.safeText).toBe(step.question);
      if (step.kind === 'conversation') expect(grounded.safeText).toBe(step.prose ?? null);
    }
  });

  it('the widget check rejects the former KPI-over-grouped-query example', () => {
    const grouped = { ...priorPlan([EXAMPLE_BUSINESS_DATE]), dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default' as const, sourceText: null, confidence: 1 } }], group: { fieldIds: ['branch'] } };
    expect(checkWidgets(grouped, { widgets: [{ kind: 'kpi', measure: 'net_sales', dimension: null }] })).toBe('kpi_not_single_value');
  });
});
