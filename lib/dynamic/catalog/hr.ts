import { z } from 'zod';
import type { Branch } from '../../contracts';
import { queryPlanSchema, refSchema, type QueryPlan, type Ref } from '../plan/schemas';
import { createSemanticCatalog, type SemanticDatasetCatalog } from './semantic';
import { authorizeCatalogField, canCatalogBranch, catalogAuthoritySchema, type CatalogAuthority } from './authority';
import { digest, freeze, unique } from '../shared';
import { regionDefinitions } from './seed';
import { rejected, type RejectedPlan } from '../validate/query-plan';
import { assessSourceCompleteness, sourceCompletenessOutcome, type SourceCompleteness } from '../evidence/completeness';
import { HR_DATASET_METADATA } from './hr-metadata';

export const HR_DATASET = freeze(HR_DATASET_METADATA);
/** The one registered HR measure and its one registered aggregation (calculator hr.active_headcount.v1). */
export const HR_HEADCOUNT_MEASURE = freeze({ fieldId: 'headcount', aggregation: 'count' } as const);

/**
 * Catalog-driven canonical form of a MODEL-authored HR plan (never reads user text): the single registered measure is
 * restated with its single registered aggregation, and a dataset-id entry in requiredSourceIds (the only HR source is 'hr')
 * is dropped. Authority, scope and every other check run unchanged in validateHrQueryPlan.
 */
export function canonicalizeHrPlan(proposal: QueryPlan): QueryPlan {
  const plan = structuredClone(proposal);
  for (const measure of plan.measures) if (measure.fieldId === HR_HEADCOUNT_MEASURE.fieldId) measure.aggregation = HR_HEADCOUNT_MEASURE.aggregation;
  plan.completeness.requiredSourceIds = plan.completeness.requiredSourceIds.filter(id => id !== HR_DATASET.id);
  return plan;
}

export interface Wave2Catalog {
  version: 2; revision: number; ref: Ref; branchCatalog: SemanticDatasetCatalog; hrDataset: typeof HR_DATASET;
}
export function createWave2Catalog(branches: readonly Branch[], revision = 1): Wave2Catalog {
  const branchCatalog = createSemanticCatalog(branches);
  const payload = { version: 2 as const, revision, branchCatalog, hrDataset: HR_DATASET };
  return freeze({ ...payload, ref: refSchema.parse({ id: 'dynamic_catalog', version: revision, digest: digest(payload) }) });
}
export interface AcceptedHrPlan {
  outcome: 'accepted'; plan: QueryPlan; ref: Ref; catalog: Ref; authority: Ref;
  scope: { regions: readonly string[]; branchIds: readonly string[]; includeGlobal: boolean };
  interpretationLabels: readonly string[];
}
interface HrContext { catalog: Wave2Catalog; actor: CatalogAuthority; sourceText: string }
const acceptedPlans = new WeakMap<AcceptedHrPlan, HrContext>();
export function hrPlanContext(plan: AcceptedHrPlan): HrContext {
  const context = acceptedPlans.get(plan);
  if (!context) throw new Error('A server-validated HR plan is required.');
  return context;
}
export function hrSupportedChoices(catalog: Wave2Catalog, actor: CatalogAuthority): { id: string; label: string }[] {
  if (!actor.active || !actor.permissions.includes('hr.read')) return [];
  return [{ id: 'employee_id', label: 'ค้นหาพนักงานด้วยรหัสพนักงาน' }, { id: 'employee_name', label: 'ค้นหาพนักงานด้วยชื่อเต็ม' },
    { id: 'headcount', label: 'นับพนักงานที่มีสถานะใช้งาน แยกตามสาขาที่คุณเข้าถึงได้' },
    ...unique(catalog.branchCatalog.branches.filter(b => canCatalogBranch(actor, b)).map(b => b.region))
      .map(id => ({ id, label: regionDefinitions.find(region => region.id === id)?.labels[0] ?? id }))];
}
const exactRef = (a: Ref, b: Ref) => a.id === b.id && a.version === b.version && a.digest === b.digest;

/** Uses source text only for span equality, never as a server intent parser. */
export function validateHrQueryPlan(input: {
  proposal: unknown; catalog: Wave2Catalog; actor: CatalogAuthority; sourceText: string;
}): AcceptedHrPlan | RejectedPlan {
  const parsed = queryPlanSchema.safeParse(input.proposal), actor = catalogAuthoritySchema.parse(input.actor);
  if (!parsed.success) return rejected('semantic_uncertainty', 'invalid_hr_plan');
  const plan = parsed.data;
  if (!authorizeCatalogField({ trust: 'certified', sensitivity: 'personal', requiredPermissions: ['hr.read'], uses: plan.requestedUses, actor }).allowed) {
    return rejected('permission_denied', 'hr_permission');
  }
  if (plan.datasetId !== HR_DATASET.id) return rejected('unsupported_concept', 'unknown_hr_dataset');
  const validSpans = (value: unknown): boolean => !value || typeof value !== 'object' || Object.entries(value).every(([key, child]) => {
    if (key !== 'sourceText') return validSpans(child);
    if (child === null) return true;
    const span = child as { start: number; end: number; text: string };
    return span.end <= input.sourceText.length && input.sourceText.slice(span.start, span.end) === span.text;
  });
  if (!validSpans(plan) || plan.confidence < 0.5) return rejected('semantic_uncertainty', 'hr_interpretation');
  if (plan.time || plan.compare || plan.multiDateGrain || plan.grain.join(',') !== 'employee_id' || plan.clarificationNeeds.length) {
    return { ...rejected('unsupported_concept', 'hr_snapshot_only'), clarification: { slotId: 'hr_capability', choices: hrSupportedChoices(input.catalog, actor) } };
  }
  const fields = unique([...plan.measures.map(m => m.fieldId), ...plan.dimensions.map(d => d.fieldId),
    ...plan.filters.map(f => f.fieldId), ...plan.group.fieldIds, ...plan.sort.map(s => s.fieldId)]);
  if (fields.some(id => !HR_DATASET.fields.some(f => f === id)) || plan.measures.length !== 1 ||
    plan.measures[0].fieldId !== 'headcount' || plan.measures[0].aggregation !== 'count' ||
    plan.measures[0].interpretation.value !== 'headcount' || plan.dimensions.some(d => d.interpretation.value !== d.fieldId || d.fieldId === 'headcount') ||
    plan.group.fieldIds.some(id => !['branch', 'region'].includes(id)) || plan.sort.some(s => s.fieldId !== 'headcount') ||
    // Row lookups list directory columns, so model-chosen (default) columns are display choices; grouped counts may only
    // default to the registered default grouping. Headcount is the only HR measure, so a default headcount is unambiguous.
    plan.aggregation !== 'rows' && plan.dimensions.some(d => d.interpretation.source === 'default' && d.fieldId !== 'branch')) return rejected('unsupported_concept', 'unregistered_hr_kind');
  // Badge state is a row-level lookup only: never aggregated, grouped, ranked or sorted.
  if (fields.some(isBadgeField) && (plan.aggregation !== 'rows' || plan.group.fieldIds.length || plan.sort.length || plan.topN)) {
    return rejected('unsupported_concept', 'hr_badge_rows_only');
  }
  if (new Set(plan.dimensions.map(d => d.fieldId)).size !== plan.dimensions.length ||
    new Set(plan.group.fieldIds).size !== plan.group.fieldIds.length || plan.sort.length > 1) return rejected('semantic_uncertainty', 'duplicate_hr_field');
  if (plan.aggregation === 'registered' && (plan.dimensions.length !== plan.group.fieldIds.length ||
    plan.dimensions.some(d => !plan.group.fieldIds.includes(d.fieldId)))) return rejected('unsupported_concept', 'hr_group_dimensions');
  if (plan.aggregation === 'rows' && (plan.group.fieldIds.length || plan.sort.length || plan.topN) ||
    plan.topN && plan.sort[0] && plan.sort[0].direction !== (plan.topN.direction === 'highest' ? 'desc' : 'asc')) {
    return rejected('unsupported_concept', 'hr_presentation_kind');
  }
  if ([...plan.measures, ...plan.dimensions].some(f => f.interpretation.source === 'explicit' && !f.interpretation.sourceText)) {
    return rejected('semantic_uncertainty', 'hr_source_span_required');
  }
  if (plan.filters.some(f => !['region', 'branch', 'employee_id', 'employee_name', 'active', 'badge_id', 'badge_status'].includes(f.fieldId) ||
    !['eq', 'in'].includes(f.op) || f.confidence < 0.5 ||
    (f.op === 'eq' ? typeof f.value !== 'string' : !Array.isArray(f.value) || !f.value.every(v => typeof v === 'string')) ||
    f.fieldId === 'active' && ![f.value].flat().every(v => ['true', 'false'].includes(String(v))) ||
    f.fieldId === 'badge_status' && ![f.value].flat().every(v => ['active', 'revoked'].includes(String(v))))) return rejected('unsupported_concept', 'unregistered_hr_filter');
  if (plan.completeness.requiredSourceIds.some(id => id !== 'hr')) return rejected('unsupported_concept', 'unknown_hr_source');
  let branches = input.catalog.branchCatalog.branches.filter(b => canCatalogBranch(actor, b));
  const scopeFilters = plan.filters.filter(f => f.fieldId === 'region' || f.fieldId === 'branch');
  for (const filter of scopeFilters) {
    const requested = [filter.value].flat() as string[];
    const registry = filter.fieldId === 'region' ? unique(input.catalog.branchCatalog.branches.map(b => b.region)) : input.catalog.branchCatalog.branches.map(b => b.id);
    if (requested.some(id => !registry.includes(id))) return rejected('unsupported_concept', 'unknown_hr_scope');
    const permitted = filter.fieldId === 'region' ? unique(branches.map(b => b.region)) : branches.map(b => b.id);
    if (requested.some(id => !permitted.includes(id))) return rejected('permission_denied', 'hr_scope');
    branches = branches.filter(b => requested.includes(filter.fieldId === 'region' ? b.region : b.id));
  }
  const includeGlobal = actor.role === 'hr_admin' && actor.regions.includes('*') && actor.branchIds === null && scopeFilters.length === 0;
  if (!branches.length && !includeGlobal) return rejected('permission_denied', 'empty_hr_scope');
  const labels = [`Authorized HR scope: ${unique(branches.map(b => b.region)).join(', ')}${includeGlobal ? '; global directory records' : ''}.`,
    'Employee directory snapshot; leave schedules and private fields are unavailable.',
    ...(plan.aggregation === 'registered' ? ['Headcount means active employees in the verified directory population.'] : [])];
  const accepted: AcceptedHrPlan = freeze({ outcome: 'accepted', plan, ref: { id: plan.planId, version: 1, digest: digest(plan) },
    catalog: input.catalog.ref, authority: { id: actor.id, version: actor.revision, digest: digest(actor) },
    scope: { regions: unique(branches.map(b => b.region)).sort(), branchIds: branches.map(b => b.id).sort(), includeGlobal }, interpretationLabels: labels });
  acceptedPlans.set(accepted, { catalog: input.catalog, actor: freeze(actor), sourceText: input.sourceText });
  return accepted;
}

export interface HrReadRequest { readerId: 'hr_employee_snapshot'; branchIds: readonly string[]; includeGlobal: boolean;
  maxRows: number; maxTimeMs: number; catalog: Ref; query: Ref;
  /** Exact employee ids named by the plan (pushed into the store read as an id filter); absent = branch-bounded scan. */
  lookupIds?: readonly string[];
  /** Attach badge id/state/type of the authorized employees (row lookups that name a badge field). */
  includeBadges: boolean }
const BADGE_FIELDS = ['badge_id', 'badge_status', 'badge_type'] as const;
export const isBadgeField = (id: string): boolean => (BADGE_FIELDS as readonly string[]).includes(id);
export const HR_NO_BADGE = '__none__';
const requests = new WeakMap<HrReadRequest, AcceptedHrPlan>();
/** employee_id filters (eq/in over strings) become a storage-level id filter; the same filters still run in executeHrRead. */
function hrLookupIds(plan: QueryPlan): { lookupIds: string[] } | Record<string, never> {
  const idFilters = plan.filters.filter(f => f.fieldId === 'employee_id');
  const ids = idFilters.flatMap(f => [f.value].flat().filter((v): v is string => typeof v === 'string'));
  // Several employee_id filters are ANDed by executeHrRead; the pushed id set is their union (a superset), never narrower.
  return ids.length > 0 && ids.length <= 200 && idFilters.every(f => f.op === 'eq' || f.op === 'in') ? { lookupIds: unique(ids) } : {};
}
export function compileHrQuery(plan: AcceptedHrPlan): HrReadRequest {
  hrPlanContext(plan);
  const request = freeze({ readerId: 'hr_employee_snapshot' as const, branchIds: plan.scope.branchIds, includeGlobal: plan.scope.includeGlobal,
    maxRows: HR_DATASET.budgets.maxRows, maxTimeMs: HR_DATASET.budgets.maxTimeMs, catalog: plan.catalog, query: plan.ref,
    ...hrLookupIds(plan.plan),
    includeBadges: [...plan.plan.measures.map(m => m.fieldId), ...plan.plan.dimensions.map(d => d.fieldId), ...plan.plan.filters.map(f => f.fieldId)].some(isBadgeField) });
  requests.set(request, plan);
  return request;
}
/** The only badge facts that ever leave the reader: id, state and type (no version, timestamps or operation keys). */
const badgeSchema = z.object({ id: z.string().min(1).max(80), state: z.enum(['active', 'revoked']), type: z.string().min(1).max(40) }).strict();
const employeeSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(200),
  branchId: z.string().min(1).max(100).nullable(), active: z.boolean(), badges: z.array(badgeSchema).max(20).optional() }).strict();
const populationSchema = z.object({ branchId: z.string().min(1).max(100).nullable(),
  employeeIds: z.array(z.string().min(1).max(80)).max(2000), observedAt: z.string().datetime({ offset: true }).nullable(),
  retrievedAt: z.string().datetime({ offset: true }) }).strict();
export interface HrSnapshot {
  rows: readonly unknown[]; populations: readonly z.infer<typeof populationSchema>[]; elapsedMs: number;
  /** true when the store read hit the row bound: the population is unknown, so no answer may be built from it. */
  truncated?: boolean;
}
export interface HrEvidenceRow { rowId: string; values: Readonly<Record<string, string | number>>; sourceRefs: readonly string[] }
export interface HrEvidenceBundle {
  version: 2; ref: Ref; query: Ref; dataset: Ref; catalog: Ref; authority: Ref; scope: AcceptedHrPlan['scope'];
  grain: readonly string[]; rows: readonly HrEvidenceRow[]; sourceCompleteness: SourceCompleteness;
  coverage: { expected: number; read: number; matched: number; complete: boolean }; createdAt: string;
  limitations: readonly string[]; interpretationLabels: readonly string[];
}
const bundles = new WeakMap<HrEvidenceBundle, AcceptedHrPlan>();
export function hrBundlePlan(bundle: HrEvidenceBundle): AcceptedHrPlan {
  const plan = bundles.get(bundle);
  if (!plan) throw new Error('A verified HR execution bundle is required.');
  return plan;
}

/** Pure adapter over a bounded reader snapshot; projects four safe fields before any output. */
export function executeHrRead(input: {
  request: HrReadRequest; snapshot: HrSnapshot; freshAuthority: CatalogAuthority; currentCatalog: Wave2Catalog; now: string;
}): { outcome: 'accepted'; bundle: HrEvidenceBundle } | RejectedPlan {
  const plan = requests.get(input.request);
  if (!plan) return rejected('execution_failed', 'invalid_hr_request');
  const context = hrPlanContext(plan), fresh = catalogAuthoritySchema.safeParse(input.freshAuthority);
  if (!fresh.success || !exactRef(plan.authority, { id: fresh.data.id, version: fresh.data.revision, digest: digest(fresh.data) })) {
    return rejected('permission_denied', 'hr_authority_changed');
  }
  if (!exactRef(plan.catalog, input.currentCatalog.ref)) return rejected('semantic_uncertainty', 'hr_catalog_changed');
  if (input.snapshot.truncated) return rejected('incomplete_evidence', 'hr_scan_truncated');
  if (!Number.isFinite(input.snapshot.elapsedMs) || input.snapshot.elapsedMs < 0 || input.snapshot.elapsedMs > input.request.maxTimeMs ||
    input.snapshot.rows.length > input.request.maxRows || input.snapshot.populations.length > 2001) return rejected('execution_failed', 'hr_budget');
  try {
    z.string().datetime({ offset: true }).parse(input.now);
    const populations = z.array(populationSchema).max(2001).parse(input.snapshot.populations);
    const requiredBranches: (string | null)[] = [...plan.scope.branchIds, ...(plan.scope.includeGlobal ? [null] : [])];
    const allowedPopulations = populations.filter(p => requiredBranches.includes(p.branchId));
    if (new Set(allowedPopulations.map(p => p.branchId)).size !== allowedPopulations.length) return rejected('incomplete_evidence', 'duplicate_hr_population');
    if (requiredBranches.some(id => !allowedPopulations.some(p => p.branchId === id))) return rejected('incomplete_evidence', 'missing_hr_population');
    const rawRows = input.snapshot.rows.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
    const employees = rawRows.filter(row => requiredBranches.includes(row.branchId as string | null)).map(row =>
      employeeSchema.parse({ id: row.id, name: row.name, branchId: row.branchId, active: row.active,
        ...(input.request.includeBadges && row.badges !== undefined ? { badges: row.badges } : {}) }));
    if (new Set(employees.map(e => e.id)).size !== employees.length) return rejected('incomplete_evidence', 'duplicate_hr_employee');
    const expected = allowedPopulations.flatMap(p => p.employeeIds);
    if (expected.length > input.request.maxRows || new Set(expected).size !== expected.length) return rejected('incomplete_evidence', 'hr_population_budget');
    if (employees.some(e => !allowedPopulations.some(p => p.branchId === e.branchId && p.employeeIds.includes(e.id)))) {
      return rejected('incomplete_evidence', 'unexpected_hr_employee');
    }
    /** Citable by RuntimeCatalog.canCite: `hr:<branchId|__global__>:population` (branch-scoped like the employee sources). */
    const sourceId = (id: string | null) => `hr:${id ?? '__global__'}:population`;
    const rowId = (id: string) => `employee:${digest(id)}`;
    const report = assessSourceCompleteness({ asOf: input.now,
      requirements: allowedPopulations.map(p => ({ id: sourceId(p.branchId), adapterId: 'hr_employee_snapshot',
        expectedRowIds: p.employeeIds.map(rowId), maxAgeMs: 86_400_000 })),
      observations: allowedPopulations.map(p => ({ id: sourceId(p.branchId), adapterId: 'hr_employee_snapshot',
        observedAt: p.observedAt, retrievedAt: p.retrievedAt, coveredRowIds: employees.filter(e => e.branchId === p.branchId).map(e => rowId(e.id)) })) });
    const outcome = sourceCompletenessOutcome(report, { requireFullPopulation: plan.plan.completeness.requireFullPopulation,
      minimumCoverage: plan.plan.completeness.minimumCoverage, topN: plan.plan.topN !== null });
    if (outcome !== 'accepted') return rejected(outcome, 'hr_source_completeness');
    const badgeFilters = plan.plan.filters.filter(f => isBadgeField(f.fieldId));
    const badgeMatches = (badge: { id: string; state: string }) => badgeFilters.every(f => ([f.value].flat() as string[]).includes(f.fieldId === 'badge_id' ? badge.id : badge.state));
    const matches = employees.filter(employee => plan.plan.filters.filter(f => !['region', 'branch'].includes(f.fieldId) && !isBadgeField(f.fieldId)).every(filter => {
      const value = filter.fieldId === 'employee_id' ? employee.id : filter.fieldId === 'employee_name' ? employee.name : String(employee.active);
      return ([filter.value].flat() as string[]).some(v => filter.fieldId === 'employee_name' ? v.normalize('NFKC').toLocaleLowerCase('en') === value.normalize('NFKC').toLocaleLowerCase('en') : v === value);
    }));
    const rows: HrEvidenceRow[] = matches.flatMap(employee => {
      const safeValues = { employee_id: employee.id, employee_name: employee.name, branch: employee.branchId ?? '__global__',
        region: context.catalog.branchCatalog.branches.find(b => b.id === employee.branchId)?.region ?? '__global__',
        active: String(employee.active), headcount: employee.active ? 1 : 0 };
      const values = plan.plan.aggregation === 'rows' ? { employee_id: safeValues.employee_id, employee_name: safeValues.employee_name,
        branch: safeValues.branch, active: safeValues.active } : Object.fromEntries(
        [...plan.plan.group.fieldIds, 'headcount'].map(id => [id, safeValues[id as keyof typeof safeValues]]));
      if (!input.request.includeBadges) return [{ rowId: rowId(employee.id), values, sourceRefs: [sourceId(employee.branchId)] }];
      // Badge lookup: one evidence row per (authorized employee, badge); an employee with no badge on record says so explicitly.
      const badges = (employee.badges ?? []).filter(badgeMatches);
      if (!badges.length) {
        return badgeFilters.length ? [] : [{ rowId: `${rowId(employee.id)}:badge:none`, sourceRefs: [sourceId(employee.branchId)],
          values: { ...values, badge_id: HR_NO_BADGE, badge_status: HR_NO_BADGE, badge_type: HR_NO_BADGE } }];
      }
      return badges.map(badge => ({ rowId: `${rowId(employee.id)}:badge:${digest(badge.id).slice(0, 16)}`, sourceRefs: [sourceId(employee.branchId)],
        values: { ...values, badge_id: badge.id, badge_status: badge.state, badge_type: badge.type } }));
    });
    if (rows.length > HR_DATASET.budgets.maxRows) return rejected('incomplete_evidence', 'hr_badge_row_budget');
    const payload = { version: 2 as const, query: plan.ref, dataset: { id: HR_DATASET.id, version: 1, digest: digest(HR_DATASET) },
      catalog: plan.catalog, authority: plan.authority, scope: plan.scope, grain: HR_DATASET.grain, rows, sourceCompleteness: report,
      coverage: { expected: expected.length, read: employees.length, matched: rows.length, complete: report.complete },
      createdAt: input.now, limitations: report.limitations, interpretationLabels: plan.interpretationLabels };
    const bundle: HrEvidenceBundle = freeze({ ...payload, ref: { id: 'hr_evidence', version: 2, digest: digest(payload) } });
    bundles.set(bundle, plan);
    return { outcome: 'accepted', bundle };
  } catch { return rejected('execution_failed', 'invalid_hr_snapshot'); }
}
