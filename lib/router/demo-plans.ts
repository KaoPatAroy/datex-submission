import type { ActionCatalogEntry } from '../contracts';
import type { QueryPlan } from '../dynamic/plan/schemas';
import { catalogEntryIdPattern } from '../demo/ids';
import { DIRECTOR_APPROVE_REVIEWED_PROMPT, DIRECTOR_CATALOG_ENTRY_IDS } from '../core/action-catalog';
import { resolveSpan } from '../dynamic/plan/normalize';
import { turnPlanSchema, type TurnPlan } from './turn-plan';

type QueryOptions = {
  planId: string;
  measureId?: string;
  aggregation?: string;
  filters?: QueryPlan['filters'];
  topN?: QueryPlan['topN'];
  sort?: QueryPlan['sort'];
  completePopulation?: boolean;
  /** Evidence text (located in the entry's own server-authored prompt) that makes the measure an explicit interpretation. */
  measureEvidence?: ReturnType<typeof resolveSpan>;
  /** Additional measures the entry promises (each with its own located evidence). */
  extraMeasures?: { measureId: string; aggregation: string; evidence: NonNullable<ReturnType<typeof resolveSpan>> }[];
};

/** Locates card evidence with the sanctioned span resolver (server-authored card prompts only). */
function span(prompt: string, text: string) {
  const located = resolveSpan(prompt, text);
  if (!located) throw new Error(`Demo plan evidence is missing from its canonical prompt: ${text}`);
  return located;
}

function branchPerformanceQuery({
  planId,
  measureId = 'net_sales',
  aggregation = 'sum',
  filters = [],
  topN = null,
  sort = [],
  completePopulation = false,
  measureEvidence = null,
  extraMeasures = [],
}: QueryOptions): QueryPlan {
  return {
    planVersion: 1,
    planId,
    datasetId: 'branch_performance',
    measures: [{
      fieldId: measureId,
      aggregation,
      interpretation: measureEvidence
        ? { value: measureId, source: 'explicit', sourceText: measureEvidence, confidence: 1 }
        : { value: measureId, source: 'default', sourceText: null, confidence: 1 },
    }, ...extraMeasures.map(extra => ({ fieldId: extra.measureId, aggregation: extra.aggregation,
      interpretation: { value: extra.measureId, source: 'explicit' as const, sourceText: extra.evidence, confidence: 1 } }))],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    filters,
    scope: null,
    time: { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'default', dates: ['2026-10-01'] },
    grain: ['branch', 'date'],
    aggregation: 'registered',
    multiDateGrain: null,
    group: { fieldIds: ['branch'] },
    compare: null,
    sort,
    topN,
    completeness: {
      expectation: completePopulation ? 'complete_authorized_population' : 'requested_scope',
      requireFullPopulation: true,
      requiredSourceIds: [],
      minimumCoverage: 1,
    },
    clarificationNeeds: [],
    confidence: 1,
    requestedUses: ['answer'],
  };
}

function hrEmployeeQuery(planId: string, prompt: string, employeeId: string): QueryPlan {
  const evidence = span(prompt, employeeId);
  return {
    ...branchPerformanceQuery({ planId }),
    datasetId: 'hr_employees',
    measures: [{ fieldId: 'headcount', aggregation: 'count', interpretation: { value: 'headcount', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [],
    filters: [{ fieldId: 'employee_id', op: 'eq', value: employeeId, source: 'explicit', evidenceText: employeeId, sourceText: evidence, confidence: 1 }],
    time: null,
    grain: ['employee_id'],
    aggregation: 'rows',
    group: { fieldIds: [] },
  };
}

function plan(...steps: unknown[]): TurnPlan {
  return turnPlanSchema.parse({ turnPlanVersion: 1, steps });
}

function salesPlan(id: string, prompt: string): TurnPlan {
  return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({ planId: `demo.${id}`, filters: [
    { fieldId: 'branch', op: 'eq', value: 'E01', source: 'explicit', evidenceText: 'E01', sourceText: span(prompt, 'E01'), confidence: 1 },
  ] }) });
}

function clarifyBadgeReason(): TurnPlan {
  return plan({
    kind: 'clarify',
    about: { kind: 'action', actionId: 'badge.revoke' },
    missing: [{ slot: 'params.reason', reason: 'absent' }],
    question: 'What is the actual reason for removing this badge?',
    choices: [],
  });
}

/** Server selectors resolved by bindServerSelectors from the actor's own planner context (never from user text). */
export const NEWEST_REVIEWED_QUEUE = 'selector:newest_reviewed_queue';
export const LATEST_VERIFIED_APPROVAL = 'selector:latest_verified_approval';

export function demoShowcasePlan(id: string, prompt: string): TurnPlan {
  switch (id) {
    case 'executive-overview':
    case 'stock_recovered':
    case 'east-overview':
      return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({ planId: `demo.${id}` }) });
    case 'executive-e01':
      return salesPlan(id, prompt);
    case 'executive-ranking':
      return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({
        planId: `demo.${id}`,
        measureId: 'gap',
        aggregation: 'gap',
        topN: { count: 3, direction: 'lowest', completeScopeRequired: true },
        sort: [{ fieldId: 'gap', direction: 'asc' }],
        completePopulation: true,
      }) });
    case 'executive-dashboard':
      return plan({ kind: 'action', actionId: 'dashboard.create', params: {} });
    case 'executive-share':
      return plan({
        kind: 'action',
        actionId: 'dashboard.share',
        params: {
          dashboard: { value: '@latest_owned_dashboard', source: 'context_id' },
          recipientId: { value: 'east', source: 'context_id' },
        },
      });
    case 'east-ticket':
      return plan({
        kind: 'action',
        actionId: 'ticket.create',
        params: { branchIds: { value: ['E02'], source: 'user_quoted', evidenceText: 'E02' } },
      });
    case 'east-denial':
      return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({
        planId: `demo.${id}`,
        filters: [{ fieldId: 'region', op: 'eq', value: 'south', source: 'explicit', sourceText: span(prompt, prompt), confidence: 1 }],
      }) });
    case 'hr-employee':
      return plan({ kind: 'hr_query', plan: hrEmployeeQuery(`demo.${id}`, prompt, 'E024') });
    case 'hr-badge': {
      const reason = 'พ้นสภาพพนักงาน';
      return plan({
        kind: 'action',
        actionId: 'badge.revoke',
        params: {
          badgeId: { value: 'C102', source: 'user_quoted', evidenceText: 'C102' },
          employeeId: { value: 'E024', source: 'user_quoted', evidenceText: 'E024' },
          reason: { value: reason, source: 'user_quoted', evidenceText: reason },
        },
      });
    }
    // HR Director (Workflow V2 bridge). The ids come from the server projection of THIS conversation (bindServerSelectors): the
    // newest reviewed queue and the newest verified approval. An unresolved selector stays literal and fails closed in validation.
    case 'director-queue':
      return plan({ kind: 'workflow_read', readId: 'director_queue' });
    case 'director-start-dates':
      return plan({ kind: 'workflow_read', readId: 'director_start_dates', snapshotId: NEWEST_REVIEWED_QUEUE });
    case 'director-approve-reviewed': {
      const quoted = 'อนุมัติทุกรายการที่ฉันเพิ่งตรวจ';
      return plan({ kind: 'action', actionId: 'onboarding.director_approve', params: {
        queue: { value: NEWEST_REVIEWED_QUEUE, source: 'context_id' },
        selection: { value: 'all_reviewed', source: 'user_quoted', evidenceText: quoted },
      } });
    }
    case 'director-email':
      return plan({ kind: 'action', actionId: 'onboarding.notify_email', params: {
        approval: { value: LATEST_VERIFIED_APPROVAL, source: 'context_id' },
        subject: { value: 'แจ้งผลการอนุมัติคำขอ Onboarding', source: 'generated' },
        body: { value: 'เรียนผู้เกี่ยวข้อง ผู้อำนวยการฝ่ายบุคคลได้อนุมัติคำขอ Onboarding ตามรายการที่ระบุแล้ว', source: 'generated' },
      } });

    default:
      throw new Error(`Unknown demo showcase id: ${id}`);
  }
}

export function workCatalogPlan(entry: Pick<ActionCatalogEntry, 'id' | 'prompt'>): TurnPlan | undefined {
  const { id, prompt } = entry;
  if (!catalogEntryIdPattern.test(id)) return undefined;

  if (id === 'retail.sales-analysis') {
    // The entry promises sales AND targets: read both measures (target is cited from the targets source).
    return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({ planId: id,
      extraMeasures: [{ measureId: 'target', aggregation: 'sum', evidence: span(prompt, 'เป้าหมาย') }] }) });
  }
  if (id === 'retail.sales-below-target') {
    // Gap = net sales less target for every authorized branch, lowest first: below-target branches are the negative values.
    // (The catalog has no row-level filter on a computed measure, so the plan never pretends to filter on it.)
    return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({
      planId: id,
      measureId: 'gap',
      aggregation: 'gap',
      sort: [{ fieldId: 'gap', direction: 'asc' }],
      completePopulation: true,
    }) });
  }
  if (id === 'retail.sales-achievement') {
    return plan({ kind: 'query', continuation: false, plan: branchPerformanceQuery({ planId: id, measureId: 'achievement', aggregation: 'weighted_ratio', measureEvidence: span(prompt, 'เปอร์เซ็นต์') }) });
  }
  if (id === 'retail.dashboard-create') return plan({ kind: 'action', actionId: 'dashboard.create', params: {} });
  // The target (WHO / WHICH branches) is never defaulted by the server: these entries ask for it with the actor's own authorized
  // choices (recipients / branches), then the registered action is planned from the tapped choice.
  if (id === 'retail.dashboard-share') return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
    missing: [{ slot: 'params.recipientId', reason: 'absent' }], question: 'ต้องการแชร์ Dashboard ให้ใครครับ', choices: [] });
  if (id === 'ops.ticket-create') return plan({ kind: 'clarify', about: { kind: 'action', actionId: 'ticket.create' },
    missing: [{ slot: 'params.branchIds', reason: 'absent' }], question: 'ต้องการเปิด Ticket ติดตามสาขา ใดครับ', choices: [] });
  if (id === 'catalog.badge_reason_required' || id.startsWith('hr.badge-revoke.')) return clarifyBadgeReason();
  // HR Director entries (offered only from the V2 projection grant): the same registered reads/action as the Director showcase.
  if (id === DIRECTOR_CATALOG_ENTRY_IDS.queue) return plan({ kind: 'workflow_read', readId: 'director_queue' });
  if (id === DIRECTOR_CATALOG_ENTRY_IDS.approvalsToday) return plan({ kind: 'workflow_read', readId: 'director_approvals_today' });
  if (id === DIRECTOR_CATALOG_ENTRY_IDS.approve) return plan({ kind: 'action', actionId: 'onboarding.director_approve', params: {
    queue: { value: NEWEST_REVIEWED_QUEUE, source: 'context_id' },
    selection: { value: 'all_reviewed', source: 'user_quoted', evidenceText: DIRECTOR_APPROVE_REVIEWED_PROMPT },
  } });

  const employeePrefix = 'hr.employee-search.';
  if (id.startsWith(employeePrefix)) {
    const employeeId = id.slice(employeePrefix.length);
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(employeeId)) return undefined;
    return plan({ kind: 'hr_query', plan: hrEmployeeQuery(id, prompt, employeeId) });
  }
  return undefined;
}

export function bindWorkCatalogEntry<T extends Pick<ActionCatalogEntry, 'id' | 'prompt'>>(entry: T): (T & { plan: TurnPlan }) | undefined {
  const resolvedPlan = workCatalogPlan(entry);
  return resolvedPlan ? { ...entry, plan: resolvedPlan } : undefined;
}
