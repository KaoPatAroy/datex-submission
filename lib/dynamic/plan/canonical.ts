import type { SemanticDataset } from '../catalog/semantic';
import type { QueryPlan } from './schemas';
import { baselineDates } from './time';

/**
 * Catalog-driven canonical form of a MODEL-authored QueryPlan, applied before span grounding and validation. It reads
 * only the plan, the registered dataset and the previous accepted plan (never user text) and can only remove noise or
 * restate a choice with weaker provenance; every authority, scope, evidence and completeness check still runs after it.
 *
 *  - completeness.requiredSourceIds keeps only registered source systems of the dataset (the model cannot see source
 *    system ids and writes dataset/branch ids there; measure sources are always required by the validator anyway).
 *  - a measure or dimension marked `inherited` that the previous accepted plan does not contain is the model's own choice:
 *    it becomes `default` (labeled in the answer) instead of a refusal.
 *  - grouping by a field the plan also filters on (with located filter evidence) borrows that filter's evidence.
 *  - vs_target with only companion measures (computed purely from a targetable measure and its target, e.g. gap) adds
 *    the targetable parent measure, so the comparison has its subject. Decided from registered source systems.
 *  - a prior-period comparison whose model-written baseline equals the server-computed baseline for the requested dates is
 *    restated as the canonical comparison (baseline null, period inferred from the dates); grouping by date inside such a
 *    comparison is dropped (the comparison is over the whole period). A different baseline is left for the validator.
 *  - a region filter without located evidence (or an unverifiable inherited one) whose values are exactly the actor's whole
 *    authorized region set is the default scope and is dropped (never widens: the default scope is that same set).
 */
export interface CanonicalQueryOptions { previousPlan?: QueryPlan; authorizedRegions?: readonly string[] }

function priorPeriod(dates: readonly string[]): 'day' | 'week' | 'month' | null {
  if (dates.length === 1) return 'day';
  if (dates.length === 7 && Date.parse(dates.at(-1)!) - Date.parse(dates[0]!) === 6 * 86_400_000) return 'week';
  const first = dates[0]!, last = dates.at(-1)!;
  const monthDays = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).getUTCDate();
  return first.endsWith('-01') && last.slice(0, 7) === first.slice(0, 7) && dates.length === monthDays ? 'month' : null;
}
export function canonicalizeQueryPlan(proposal: QueryPlan, dataset: SemanticDataset | undefined, options: CanonicalQueryOptions = {}): QueryPlan {
  const previousPlan = options.previousPlan;
  if (!dataset || proposal.datasetId !== dataset.id) return proposal;
  const plan = structuredClone(proposal);
  const fields = new Map(dataset.fields.map(field => [field.id, field]));
  const registeredSystems = new Set(dataset.fields.flatMap(field => field.sourceSystems));
  plan.completeness.requiredSourceIds = plan.completeness.requiredSourceIds.filter(id => registeredSystems.has(id));

  const prior = new Set([...(previousPlan?.measures ?? []).map(m => `m:${m.fieldId}:${m.aggregation}`), ...(previousPlan?.dimensions ?? []).map(d => `d:${d.fieldId}`)]);
  for (const measure of plan.measures) if (measure.interpretation.source === 'inherited' && !prior.has(`m:${measure.fieldId}:${measure.aggregation}`))
    measure.interpretation = { ...measure.interpretation, source: 'default', sourceText: null };
  for (const dimension of plan.dimensions) {
    if (dimension.interpretation.source === 'inherited' && !prior.has(`d:${dimension.fieldId}`))
      dimension.interpretation = { ...dimension.interpretation, source: 'default', sourceText: null };
    if (dimension.interpretation.source !== 'default' || dataset.defaultDimensions.includes(dimension.fieldId)) continue;
    const filter = plan.filters.find(f => f.fieldId === dimension.fieldId && f.source !== 'inherited' && (f.evidenceText ?? f.sourceText?.text));
    const text = filter ? (filter.evidenceText ?? filter.sourceText?.text)! : null;
    if (text) dimension.interpretation = { ...dimension.interpretation, source: 'explicit', sourceText: { start: 0, end: text.length, text } };
  }

  if (plan.compare?.kind === 'vs_target' && !plan.measures.some(m => fields.get(m.fieldId)?.targetFieldId)) {
    const parent = dataset.fields.find(candidate => {
      if (candidate.kind !== 'measure' || !candidate.targetFieldId || candidate.additivity !== 'additive') return false;
      const target = fields.get(candidate.targetFieldId);
      const systems = new Set([...candidate.sourceSystems, ...(target?.sourceSystems ?? [])]);
      return plan.measures.every(m => {
        const field = fields.get(m.fieldId);
        return !!field?.sourceSystems.length && field.sourceSystems.every(system => systems.has(system));
      });
    });
    if (parent && parent.aggregations[0]) plan.measures.unshift({ fieldId: parent.id, aggregation: parent.aggregations[0],
      interpretation: { value: parent.id, source: 'default', sourceText: null, confidence: 1 } });
  }
  if (plan.compare?.kind === 'vs_prior_period' && plan.compare.baseline && plan.time?.dates.length) {
    const period = priorPeriod(plan.time.dates);
    let expected: string[] = [];
    try { expected = period ? baselineDates([...plan.time.dates], { kind: 'vs_prior_period', period }, dataset.budgets.maxDays) : []; } catch { expected = []; }
    if (period && expected.length && JSON.stringify(expected) === JSON.stringify(plan.compare.baseline.dates))
      plan.compare = { ...plan.compare, baseline: null, period };
  } else if (plan.compare?.kind === 'vs_prior_period' && !plan.compare.baseline && plan.compare.period && plan.time?.dates.length) {
    // The period of a prior-period comparison is a property of the requested dates; a disagreeing label is restated.
    const period = priorPeriod(plan.time.dates);
    if (period && period !== plan.compare.period) plan.compare = { ...plan.compare, period };
  }
  if (plan.compare && plan.compare.kind !== 'vs_target' && plan.group.fieldIds.includes('date')) {
    plan.group.fieldIds = plan.group.fieldIds.filter(id => id !== 'date');
    plan.dimensions = plan.dimensions.filter(d => d.fieldId !== 'date');
    const selected = new Set([...plan.measures.map(m => m.fieldId), ...plan.dimensions.map(d => d.fieldId)]);
    plan.sort = plan.sort.filter(s => selected.has(s.fieldId));
  }

  const authorized = options.authorizedRegions ? [...new Set(options.authorizedRegions)].sort() : null;
  if (authorized?.length) plan.filters = plan.filters.filter(filter => {
    if (filter.fieldId !== 'region' || !['eq', 'in'].includes(filter.op)) return true;
    const located = filter.source !== 'inherited' && !!(filter.evidenceText ?? filter.sourceText?.text);
    const verifiable = filter.source === 'inherited' && !!previousPlan?.filters.some(prior => prior.fieldId === filter.fieldId);
    if (located || verifiable) return true;
    const values = [...new Set([filter.value].flat().map(String))].sort();
    return JSON.stringify(values) !== JSON.stringify(authorized);
  });
  return plan;
}
