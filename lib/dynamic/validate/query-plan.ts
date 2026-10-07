import { businessDateSchema, type Actor, type Branch } from '../../contracts';
import type { SemanticDataset, SemanticDatasetCatalog, SemanticField } from '../catalog/semantic';
import { trustPolicy } from '../catalog/semantic';
import { queryPlanSchema, type QueryPlan, type Span } from '../plan/schemas';
import { baselineDates, resolveTime } from '../plan/time';
import { resolveSpan } from '../plan/normalize';
import { digest, freeze, unique } from '../shared';

export type Outcome = 'accepted' | 'clarification_required' | 'unsupported_concept' | 'data_unavailable' |
  'permission_denied' | 'incomplete_evidence' | 'semantic_uncertainty' | 'execution_failed';
export type ActorAuthority = Pick<Actor, 'id' | 'active' | 'permissions' | 'regions'> & { revision: number };
export interface Availability {
  sourceText: string; businessDate: string; dates: readonly string[];
  branchIds: readonly string[]; sourceSystems: readonly string[];
  /** When supplied, identifies readable branch/date pairs; omitted means the listed date/branch product is available. */
  availabilityWindow?: { min: string; max: string } | null; previousDates?: readonly string[]; previousPlan?: QueryPlan;
  branchDates?: readonly { branchId: string; date: string }[];
  /** Server-derived limitations when canonical requested dates are clipped to the serving window. */
  dateLimitations?: readonly string[];
}
export interface RejectedPlan {
  outcome: Exclude<Outcome, 'accepted'>; code: string; safeDetail: string;
  clarification?: { slotId: string; choices: { id: string; label: string }[] };
  dateAvailability?: { requestedDates: readonly string[]; availableFrom: string | null; availableTo: string | null };
}
export interface AcceptedPlan {
  readonly outcome: 'accepted'; readonly plan: QueryPlan; readonly planDigest: string;
  readonly catalogDigest: string; readonly authorityDigest: string;
  readonly scope: { regions: readonly string[]; branchIds: readonly string[]; source: 'explicit' | 'default' };
  readonly dates: readonly string[]; readonly baselineDates: readonly string[];
  readonly interpretationLabels: readonly string[];
}
export type ValidationOutcome = AcceptedPlan | RejectedPlan;
export interface AcceptedContext {
  catalog: SemanticDatasetCatalog; dataset: SemanticDataset; authority: ActorAuthority; available: Availability;
  branches: readonly Branch[]; sourceSystems: readonly string[];
}
const acceptedContexts = new WeakMap<AcceptedPlan, AcceptedContext>();
export function rejected(outcome: RejectedPlan['outcome'], code: string): RejectedPlan {
  return { outcome, code, safeDetail: 'This plan cannot be used with the current catalog, authority, or evidence.' };
}
export function acceptedContext(accepted: AcceptedPlan): AcceptedContext {
  const context = acceptedContexts.get(accepted);
  if (!context) throw new Error('A server-validated plan is required.');
  return context;
}
export function authorizedBranches(catalog: SemanticDatasetCatalog, authority: ActorAuthority): Branch[] {
  return catalog.branches.filter(b => authority.active && (authority.regions.includes('*') || authority.regions.includes(b.region)));
}
function validSpan(span: Span | null, text: string): boolean {
  return !!span && span.end <= text.length && text.slice(span.start, span.end) === span.text;
}
function allSpansValid(value: unknown, text: string, path = ''): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => {
    if (key !== 'sourceText') return allSpansValid(child, text, path ? `${path}.${key}` : key);
    if ('source' in value && value.source === 'inherited') return true;
    if (child === null) return true;
    const span = child as Span;
    // A comparison phrase ("X vs the previous X") legitimately spans most of a short request; other spans must be local.
    return validSpan(span, text) && (path === 'compare' || !(text.length > 20 && span.text.length > text.length * 0.8));
  });
}
function values(value: QueryPlan['filters'][number]['value']): (string | number)[] {
  return value === null ? [] : Array.isArray(value) ? value : [value];
}
export function matchesFilter(actual: string | number | null, filter: QueryPlan['filters'][number]): boolean {
  const list = values(filter.value), first = list[0];
  if (actual === null) return false;
  switch (filter.op) {
    case 'eq': return actual === first;
    case 'in': return list.includes(actual);
    case 'gte': return actual >= first;
    case 'gt': return actual > first;
    case 'lte': return actual <= first;
    case 'lt': return actual < first;
    case 'between': return actual >= first && actual <= list[1];
  }
}

/** Authorized regions as server-owned choices (Thai catalog label when the catalog has one). */
function scopeRegionChoices(authorized: readonly Branch[], regionField: SemanticField | undefined): { id: string; label: string }[] {
  return unique(authorized.map(b => b.region)).sort().map(id => ({ id,
    label: regionField?.canonicalValues?.find(value => value.id === id)?.labels?.find(label => label !== id) ?? id }));
}

function clarification(slotId: string, choices: { id: string; label: string }[], code: string): RejectedPlan {
  return { ...rejected('clarification_required', code), clarification: { slotId, choices } };
}

function withTimeAvailability(result: RejectedPlan, dates: readonly string[], window?: Availability['availabilityWindow']): RejectedPlan {
  return { ...result, dateAvailability: { requestedDates: [...dates],
    availableFrom: window?.min ?? null, availableTo: window?.max ?? null } };
}

function inferredPriorPeriod(dates: readonly string[]): 'day' | 'week' | 'month' | null {
  if (dates.length === 1) return 'day';
  if (dates.length === 7 && Date.parse(dates.at(-1)!) - Date.parse(dates[0]) === 6 * 86_400_000) return 'week';
  const first = dates[0], last = dates.at(-1)!;
  const monthDays = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).getUTCDate();
  return first.endsWith('-01') && last.slice(0, 7) === first.slice(0, 7) && dates.length === monthDays ? 'month' : null;
}

/** Raw text is used exclusively to verify immutable source spans. No language interpretation occurs here. */
export function validateQueryPlan(proposal: unknown, catalog: SemanticDatasetCatalog, authority: ActorAuthority, available: Availability): ValidationOutcome {
  const parsed = queryPlanSchema.safeParse(proposal);
  if (!parsed.success) return rejected('semantic_uncertainty', 'invalid_plan');
  const plan = parsed.data;
  const dataset = catalog.datasets.find(d => d.id === plan.datasetId);
  if (!dataset) return rejected('unsupported_concept', 'unknown_dataset');
  if (!authority.active || !dataset.requiredPermissions.every(p => authority.permissions.includes(p))) return rejected('permission_denied', 'dataset_permission');
  if (!allSpansValid(plan, available.sourceText)) return rejected('semantic_uncertainty', 'invalid_source_span');
  if (plan.confidence < 0.5) return rejected('semantic_uncertainty', 'low_confidence');
  if (plan.requestedUses.some(use => !['answer', 'explore'].includes(use))) return rejected('unsupported_concept', 'capability_unavailable');
  const labels: string[] = [];
  labels.push(...(available.dateLimitations ?? []));
  for (const choice of [...plan.measures, ...plan.dimensions]) if (choice.interpretation.source === 'inherited') {
    const priorChoices = [...(available.previousPlan?.measures ?? []), ...(available.previousPlan?.dimensions ?? [])];
    if (!priorChoices.some(prior => prior.fieldId === choice.fieldId &&
      (!('aggregation' in choice) || 'aggregation' in prior && prior.aggregation === choice.aggregation)))
      return rejected('semantic_uncertainty', 'inherited_choice_mismatch');
  }
  const fields = new Map(dataset.fields.map(field => [field.id, field]));
  const selected = [...plan.measures.map(m => m.fieldId), ...plan.dimensions.map(d => d.fieldId)];
  const referenced = unique([...selected, ...plan.filters.map(f => f.fieldId), ...plan.grain, ...plan.group.fieldIds,
    ...plan.sort.map(s => s.fieldId), ...(plan.time ? [plan.time.fieldId] : []), ...(plan.multiDateGrain ? [plan.multiDateGrain.fieldId] : []),
    ...(plan.compare?.kind === 'vs_target' ? plan.measures.map(m => fields.get(m.fieldId)?.targetFieldId).filter((id): id is string => !!id) : [])]);
  if (selected.length !== new Set(selected).size || plan.group.fieldIds.length !== new Set(plan.group.fieldIds).size ||
    plan.grain.length !== new Set(plan.grain).size || plan.sort.length !== new Set(plan.sort.map(s => s.fieldId)).size) return rejected('semantic_uncertainty', 'duplicate_field');
  for (const definition of [dataset, ...referenced.map(id => fields.get(id))]) {
    if (!definition) return rejected('unsupported_concept', 'unknown_field');
    if (!definition.requiredPermissions.every(p => authority.permissions.includes(p))) return rejected('permission_denied', 'field_permission');
    const trust = trustPolicy(definition.trust, definition.sensitivity, plan.requestedUses);
    if (!trust.allowed) return rejected(trust.outcome!, 'trust_policy');
    if (trust.label) labels.push(trust.label);
  }
  for (const measure of plan.measures) {
    const field = fields.get(measure.fieldId)!;
    if (field.kind !== 'measure' || !field.aggregations.includes(measure.aggregation)) return rejected('unsupported_concept', 'unknown_aggregation');
    if (measure.interpretation.value !== measure.fieldId) return rejected('semantic_uncertainty', 'interpretation_mismatch');
    if (measure.interpretation.source === 'explicit' && !measure.interpretation.sourceText) return rejected('semantic_uncertainty', 'missing_source_span');
    if (measure.interpretation.source === 'default') {
      // A registered default measure is labeled as the default; any other catalog measure the model chose without a
      // quoted span is still a certified, permission-checked field and is labeled as the system's selection.
      const registeredDefault = measure.fieldId === dataset.defaultMeasure || Object.values(dataset.defaultViews).some(view => view.includes(measure.fieldId));
      labels.push(registeredDefault ? `ตัวชี้วัดเริ่มต้น: ${field.displayLabel ?? measure.fieldId}` : `ตัวชี้วัดที่ระบบเลือกให้: ${field.displayLabel ?? measure.fieldId}`);
    }
  }
  for (const dimension of plan.dimensions) {
    const field = fields.get(dimension.fieldId);
    if (field?.kind !== 'dimension') return rejected('unsupported_concept', 'unknown_dimension');
    if (dimension.interpretation.value !== dimension.fieldId || dimension.interpretation.source === 'explicit' && !dimension.interpretation.sourceText) return rejected('semantic_uncertainty', 'dimension_interpretation');
    if (dimension.interpretation.source === 'default' && !dataset.defaultDimensions.includes(dimension.fieldId) && !dimension.interpretation.sourceText) {
      return clarification(`dimension.${dimension.fieldId}`, dataset.fields.filter(f => f.kind === 'dimension').map(f => ({ id: f.id, label: f.displayLabel ?? f.id })),
        'unregistered_default_dimension');
    }
  }
  if ([...plan.grain, ...plan.group.fieldIds].some(id => fields.get(id)?.kind !== 'dimension') ||
    plan.group.fieldIds.some(id => !plan.dimensions.some(d => d.fieldId === id)) || plan.sort.some(s => !selected.includes(s.fieldId))) return rejected('unsupported_concept', 'invalid_group_or_sort');
  // Row claims retain branch/date grain; grouped or temporal comparisons need registered aggregation.
  if (plan.aggregation === 'rows' && (plan.grain.length !== dataset.grain.length || plan.grain.some(id => !dataset.grain.includes(id)) ||
    [...plan.dimensions.map(d => d.fieldId), ...plan.group.fieldIds].some(id => !dataset.grain.includes(id)) ||
    plan.compare && plan.compare.kind !== 'vs_target')) return rejected('unsupported_concept', 'row_group_or_comparison');
  const authorized = authorizedBranches(catalog, authority), authorizedIds = new Set(authorized.map(b => b.id));
  for (const filter of plan.filters) {
    const field = fields.get(filter.fieldId)!;
    if (filter.source === 'inherited') {
      // 'in' lists are sets: the same members in another order are the same prior value.
      const sameValue = (prior: QueryPlan['filters'][number]) => digest(prior.value) === digest(filter.value) ||
        filter.op === 'in' && Array.isArray(prior.value) && Array.isArray(filter.value) && digest([...prior.value].sort()) === digest([...filter.value].sort());
      if (!available.previousPlan?.filters.some(prior => prior.fieldId === filter.fieldId && prior.op === filter.op && sameValue(prior)))
        return { ...rejected('clarification_required', 'inherited_filter_mismatch'), clarification: { slotId: `filters.${plan.filters.indexOf(filter)}`,
          choices: filter.fieldId === 'region' ? scopeRegionChoices(authorized, fields.get('region')) : [] } };
    } else if (!resolveSpan(available.sourceText, filter.evidenceText ?? filter.sourceText?.text ?? '')) {
      return clarification(`filters.${plan.filters.indexOf(filter)}`, [], 'unsupported_source_text');
    }
    if (filter.value === null) return { ...rejected('clarification_required', 'unresolved_explicit_scope'), clarification: {
      slotId: filter.fieldId, choices: filter.fieldId === 'region' ? scopeRegionChoices(authorized, fields.get('region')) : [] } };
    const list = values(filter.value);
    if ((filter.op === 'eq' && list.length !== 1) || (filter.op === 'between' && list.length !== 2) ||
      !['in', 'between'].includes(filter.op) && list.length !== 1 || new Set(list).size !== list.length) return rejected('semantic_uncertainty', 'filter_cardinality');
    if (filter.op === 'between' && list[0] > list[1]) return rejected('semantic_uncertainty', 'filter_range');
    if (field.canonicalValues) {
      if (!['eq', 'in'].includes(filter.op)) return rejected('unsupported_concept', 'dimension_operator');
      if (field.id === 'branch' && list.some(value => !authorizedIds.has(String(value))))
        return rejected('permission_denied', 'explicit_scope_denied');
      if (list.some(value => !field.canonicalValues!.some(v => v.id === value))) return rejected('unsupported_concept', 'unknown_value');
      if (field.id === 'region' && list.some(value => !authorized.some(b => b.region === value)) ||
        field.id === 'branch' && list.some(value => !authorizedIds.has(String(value)))) return rejected('permission_denied', 'explicit_scope_denied');
    } else if (field.kind === 'measure' && list.some(value => typeof value !== 'number') ||
      field.id === 'date' && list.some(value => !businessDateSchema.safeParse(value).success)) return rejected('unsupported_concept', 'filter_type');
  }
  if (plan.scope && plan.filters.some(f => ['region', 'branch'].includes(f.fieldId))) return rejected('semantic_uncertainty', 'conflicting_scope');
  if (plan.clarificationNeeds.length) return { ...rejected('clarification_required', 'planner_clarification'),
    // Choices are server-owned; never forward arbitrary model labels or protected IDs.
    clarification: { slotId: plan.clarificationNeeds[0].slotId, choices: [] } };
  const requestedBranches = authorized.filter(b => plan.filters.every(f => f.fieldId === 'region' ? matchesFilter(b.region, f) : f.fieldId === 'branch' ? matchesFilter(b.id, f) : true));
  if (!requestedBranches.length) return rejected('data_unavailable', 'empty_effective_scope');
  let temporal: ReturnType<typeof resolveTime>;
  try {
    temporal = resolveTime(plan.time, available.businessDate, dataset.budgets.maxDays);
    if (temporal.time.fieldId !== 'date' || temporal.time.timezone !== dataset.timezone)
      return withTimeAvailability(rejected('unsupported_concept', 'time_dimension'), temporal.dates, available.availabilityWindow);
    if (temporal.time.source === 'generated') labels.push(`ช่วงวันที่ที่ระบบตีความจากคำขอ: ${temporal.dates[0]}${temporal.dates.length > 1 ? ` ถึง ${temporal.dates.at(-1)}` : ''}`);
    if (temporal.time.source === 'explicit' && (!temporal.time.evidenceText || !resolveSpan(available.sourceText, temporal.time.evidenceText)))
      return withTimeAvailability(clarification('time', [], 'unsupported_time_text'), temporal.dates, available.availabilityWindow);
    if (temporal.time.source === 'inherited' && (!available.previousDates || digest(temporal.dates) !== digest(available.previousDates)))
      return withTimeAvailability(rejected('semantic_uncertainty', 'inherited_time_mismatch'), temporal.dates, available.availabilityWindow);
    const window = available.availabilityWindow === undefined && available.dates.length
      ? { min: [...available.dates].sort()[0], max: [...available.dates].sort().at(-1)! } : available.availabilityWindow;
    if (!window || temporal.dates.some(date => date < window.min || date > window.max)) {
      if (temporal.time.source !== 'explicit' && temporal.time.source !== 'generated')
        return withTimeAvailability(rejected('data_unavailable', 'date_unavailable'), temporal.dates, window);
      return withTimeAvailability(clarification('time', [], 'date_outside_availability'), temporal.dates, window);
    }
    temporal.dates = temporal.dates.filter(date => plan.filters.every(f => f.fieldId !== 'date' || matchesFilter(date, f)));
  } catch { return withTimeAvailability(rejected('semantic_uncertainty', 'time_budget_or_range'), plan.time?.dates ?? [], available.availabilityWindow); }
  if (!temporal.dates.length) return withTimeAvailability(rejected('data_unavailable', 'empty_date_scope'), plan.time?.dates ?? [], available.availabilityWindow);
  const snapshotIds = unique([
    ...plan.measures.filter(m => fields.get(m.fieldId)?.additivity === 'snapshot').map(m => m.fieldId),
    ...plan.filters.filter(f => fields.get(f.fieldId)?.kind === 'measure' && fields.get(f.fieldId)?.additivity === 'snapshot').map(f => f.fieldId),
  ]);
  const snapshotAggregationExplicit = (fieldId: string) => {
    const measure = plan.measures.find(m => m.fieldId === fieldId);
    return measure ? ['avg', 'latest', 'max'].includes(measure.aggregation) :
      ['avg', 'latest', 'max'].includes(plan.multiDateGrain?.mode ?? '');
  };
  if (temporal.dates.length > 1 && snapshotIds.some(fieldId => !snapshotAggregationExplicit(fieldId))) {
    return clarification('snapshot_aggregation', [
      { id: 'avg', label: 'ค่าเฉลี่ยตลอดช่วง' }, { id: 'latest', label: 'ค่าของวันล่าสุด' }, { id: 'max', label: 'ค่าสูงสุดในช่วง' },
    ], 'snapshot_aggregation_required');
  }
  const additiveMeasureIds = unique([
    ...plan.measures.filter(m => fields.get(m.fieldId)?.additivity === 'additive').map(m => m.fieldId),
    ...plan.filters.filter(f => fields.get(f.fieldId)?.kind === 'measure' && fields.get(f.fieldId)?.additivity === 'additive').map(f => f.fieldId),
  ]);
  if (plan.multiDateGrain && ['latest', 'max'].includes(plan.multiDateGrain.mode) && additiveMeasureIds.length > 0) {
    return clarification('multi_date_aggregation', [{ id: 'sum', label: 'ผลรวมตลอดช่วง' }, { id: 'avg', label: 'ค่าเฉลี่ยตลอดช่วง' }],
      'mixed_temporal_aggregation');
  }
  let effectiveCompare = plan.compare;
  let effectiveMultiDateGrain = plan.multiDateGrain;
  if (plan.compare) {
    if (plan.compare.baseline || plan.compare.kind !== 'vs_prior_period' && plan.compare.period) return rejected('unsupported_concept', 'compare_contract');
    if (plan.compare.kind === 'vs_prior_period') {
      const inferred = plan.compare.period ?? inferredPriorPeriod(temporal.dates);
      if (!inferred) return clarification('compare_period', [{ id: 'day', label: 'รายวัน' }, { id: 'week', label: 'รายสัปดาห์' }, { id: 'month', label: 'รายเดือน' }], 'comparison_period_required');
      if (!plan.compare.period || !plan.multiDateGrain) labels.push(`Default comparison grain: ${inferred}`);
      effectiveCompare = { ...plan.compare, period: inferred };
      effectiveMultiDateGrain ??= { fieldId: 'date', mode: 'sum' };
    }
    if (plan.compare.kind === 'vs_prior_day' && temporal.dates.length !== 1) return rejected('semantic_uncertainty', 'prior_day_grain');
    if (plan.compare.kind === 'vs_target') {
      const hasTarget = (m: { fieldId: string }) => {
        const field = fields.get(m.fieldId)!;
        const target = field.targetFieldId ? fields.get(field.targetFieldId) : undefined;
        return field.additivity === 'additive' && !!target && target.kind === 'measure' && !!target.binding;
      };
      // Companions of a selected targetable measure are measures computed only from that measure's and its target's
      // registered source systems (the target itself, the gap, the achievement ratio): catalog data, not names.
      const companion = (m: { fieldId: string }) => {
        const field = fields.get(m.fieldId)!;
        return field.kind === 'measure' && !!field.binding && plan.measures.some(parent => {
          if (parent.fieldId === m.fieldId || !hasTarget(parent)) return false;
          const parentField = fields.get(parent.fieldId)!, target = fields.get(parentField.targetFieldId!)!;
          const systems = new Set([...parentField.sourceSystems, ...target.sourceSystems]);
          return field.sourceSystems.length > 0 && field.sourceSystems.every(system => systems.has(system));
        });
      };
      const targetable = plan.measures.some(hasTarget) && plan.measures.every(m => hasTarget(m) || companion(m));
      if (!targetable) {
        const choices = dataset.fields.filter(f => f.kind === 'measure' && f.additivity === 'additive' && f.targetFieldId)
          .map(f => ({ id: f.id, label: f.displayLabel ?? f.id }));
        return clarification('compare_measure', choices, 'target_comparison_unavailable');
      }
    }
    if (plan.compare.kind === 'vs_prior_period') {
      const first = temporal.dates[0], last = temporal.dates.at(-1)!;
      const isDay = temporal.dates.length === 1;
      const isWeek = temporal.dates.length === 7 && Date.parse(last) - Date.parse(first) === 6 * 86_400_000;
      const monthDays = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).getUTCDate();
      const isMonth = first.endsWith('-01') && last.slice(0, 7) === first.slice(0, 7) && temporal.dates.length === monthDays;
      if (effectiveCompare!.period === 'day' ? !isDay : effectiveCompare!.period === 'week' ? !isWeek : !isMonth) return rejected('semantic_uncertainty', 'comparison_period_alignment');
    }
    if (plan.group.fieldIds.includes('date')) return rejected('unsupported_concept', 'comparison_date_group');
  }
  if (plan.multiDateGrain && plan.multiDateGrain.fieldId !== 'date') return rejected('unsupported_concept', 'multi_date_grain');
  let baseline: string[];
  try { baseline = effectiveCompare ? baselineDates(temporal.dates, effectiveCompare, dataset.budgets.maxDays) : []; }
  catch { return rejected('semantic_uncertainty', 'comparison_period_alignment'); }
  const dates = unique([...temporal.dates, ...baseline]);
  if (dates.length > dataset.budgets.maxDays || dates.length * requestedBranches.length > dataset.budgets.maxRows ||
    requestedBranches.length > dataset.budgets.maxGroups) return rejected('semantic_uncertainty', 'query_budget');
  const availableBranchDates = available.branchDates ? new Set(available.branchDates.map(pair => `${pair.branchId}\u0000${pair.date}`)) : null;
  const pairAvailable = (branchId: string, date: string) => available.branchIds.includes(branchId) && available.dates.includes(date) &&
    (availableBranchDates === null || availableBranchDates.has(`${branchId}\u0000${date}`));
  const expectedPairs = requestedBranches.flatMap(branch => dates.map(date => ({ branchId: branch.id, date })));
  const missingPairs = expectedPairs.filter(pair => !pairAvailable(pair.branchId, pair.date));
  const currentAvailable = requestedBranches.some(branch => temporal.dates.some(date => pairAvailable(branch.id, date)));
  if (!currentAvailable) return rejected('data_unavailable', 'date_unavailable');
  if ((plan.topN || plan.completeness.expectation === 'complete_authorized_population' || effectiveCompare && effectiveCompare.kind !== 'vs_target') && missingPairs.length) {
    const globallyUnavailable = missingPairs.some(pair => !available.dates.includes(pair.date));
    return rejected(globallyUnavailable ? 'data_unavailable' : 'incomplete_evidence', globallyUnavailable ? 'date_unavailable' : 'population_unavailable');
  }
  if (plan.topN && (plan.completeness.expectation !== 'complete_authorized_population' || !plan.completeness.requireFullPopulation ||
    plan.completeness.minimumCoverage !== 1 || !plan.sort.length || !plan.measures.some(m => m.fieldId === plan.sort[0].fieldId) ||
    plan.aggregation !== 'registered' || !plan.group.fieldIds.length)) return rejected('incomplete_evidence', 'ranking_requires_population');
  if (plan.topN && (plan.topN.count > dataset.budgets.maxTopN || plan.sort[0].direction !== (plan.topN.direction === 'highest' ? 'desc' : 'asc'))) return rejected('semantic_uncertainty', 'ranking_budget_or_direction');
  if (plan.completeness.expectation === 'complete_authorized_population' && (!plan.completeness.requireFullPopulation || plan.completeness.minimumCoverage !== 1)) return rejected('semantic_uncertainty', 'inconsistent_completeness');
  const systems = unique([...plan.measures.flatMap(m => fields.get(m.fieldId)!.sourceSystems),
    ...plan.filters.flatMap(f => fields.get(f.fieldId)!.sourceSystems),
    ...(effectiveCompare?.kind === 'vs_target' ? plan.measures.flatMap(m => {
      const id = fields.get(m.fieldId)!.targetFieldId;
      return id ? fields.get(id)!.sourceSystems : [];
    }) : []),
    ...plan.completeness.requiredSourceIds]);
  const registeredSystems = unique(dataset.fields.flatMap(f => f.sourceSystems));
  if (systems.some(s => !registeredSystems.includes(s))) return rejected('unsupported_concept', 'unknown_source');
  if (systems.some(s => !available.sourceSystems.includes(s))) return rejected('data_unavailable', 'source_unavailable');
  if (temporal.time.source === 'default') labels.push(`วันที่ธุรกิจ (ค่าเริ่มต้น): ${available.businessDate}`);
  const explicit = !!plan.scope || plan.filters.some(f => ['region', 'branch'].includes(f.fieldId));
  const scopeRegions = unique(requestedBranches.map(b => b.region)).sort();
  const regionLabel = (id: string) => fields.get('region')?.canonicalValues?.find(value => value.id === id)?.labels?.find(label => label !== id) ?? id;
  if (!explicit) labels.push(`ขอบเขตเริ่มต้น: ภูมิภาคที่ได้รับอนุญาต ${scopeRegions.map(regionLabel).join(', ')}`);
  const requestsFullScope = !!plan.scope || !plan.filters.some(f => ['region', 'branch'].includes(f.fieldId));
  if (requestsFullScope && requestedBranches.length < catalog.branches.length) {
    labels.push(`จำกัดขอบเขตตามสิทธิ์ของคุณ: ${scopeRegions.map(regionLabel).join(', ')}`);
  }
  const normalizedPlan = { ...plan, time: temporal.time, compare: effectiveCompare, multiDateGrain: effectiveMultiDateGrain };
  const accepted: AcceptedPlan = freeze({ outcome: 'accepted', plan: normalizedPlan,
    planDigest: digest(normalizedPlan), catalogDigest: catalog.digest, authorityDigest: digest(authority),
    scope: { regions: scopeRegions, branchIds: requestedBranches.map(b => b.id).sort(), source: explicit ? 'explicit' : 'default' },
    dates: temporal.dates, baselineDates: baseline, interpretationLabels: unique(labels) });
  acceptedContexts.set(accepted, freeze({ catalog: structuredClone(catalog), dataset: structuredClone(dataset),
    authority: structuredClone(authority), available: structuredClone(available), branches: structuredClone(requestedBranches), sourceSystems: systems }));
  return accepted;
}

/** Recheck the exact accepted population before execution or protected persistence. */
export function revalidate(plan: AcceptedPlan, freshAuthority: ActorAuthority): ValidationOutcome {
  const context = acceptedContext(plan);
  if (freshAuthority.id !== context.authority.id || freshAuthority.revision !== context.authority.revision) return rejected('permission_denied', 'authority_changed');
  const result = validateQueryPlan(plan.plan, context.catalog, freshAuthority, context.available);
  if (result.outcome === 'accepted' && digest(result.scope) !== digest(plan.scope)) return rejected('permission_denied', 'scope_revoked');
  return result;
}

export function fieldById(dataset: SemanticDataset, id: string): SemanticField {
  const field = dataset.fields.find(f => f.id === id);
  if (!field) throw new Error('Unregistered field.');
  return field;
}
