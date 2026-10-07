import type { Evidence, Scope } from '../../contracts';
import { scopeSchema } from '../../contracts';
import { createEvidenceBundle, type EvidenceBundle, type EvidenceRow, type BundleSource } from '../evidence/bundle';
import { acceptedContext, fieldById, rejected, revalidate, type AcceptedPlan, type ActorAuthority, type RejectedPlan } from '../validate/query-plan';
import { freeze, unique } from '../shared';

export interface ReadRequest {
  readonly readerId: 'branch_evidence'; readonly datasetId: string;
  readonly dates: readonly string[]; readonly dateRange: { start: string; end: string };
  readonly regions: readonly string[]; readonly scopes: readonly Scope[];
  readonly expectedBranchIds: readonly string[];
}
const requests = new WeakMap<ReadRequest, AcceptedPlan>();
export type EvidenceReader = (scope: Scope) => Promise<Evidence>;
export type AuthorityLoader = () => Promise<ActorAuthority>;
export type ExecutionOutcome = { outcome: 'accepted'; bundle: EvidenceBundle } | RejectedPlan;

/** Compile solely to the registered reader's Scope contract; split its 12-ID limit explicitly. */
export function compileQueryPlan(accepted: AcceptedPlan): ReadRequest {
  const context = acceptedContext(accepted);
  const dates = unique([...accepted.dates, ...accepted.baselineDates]).sort();
  const availableBranchDates = context.available.branchDates ? new Set(context.available.branchDates.map(pair => `${pair.branchId}\u0000${pair.date}`)) : null;
  const scopes: Scope[] = [];
  for (const date of dates) for (const region of accepted.scope.regions) {
    const ids = context.branches.filter(b => b.region === region && context.available.branchIds.includes(b.id) &&
      context.available.dates.includes(date) && (availableBranchDates === null || availableBranchDates.has(`${b.id}\u0000${date}`))).map(b => b.id).sort();
    for (let offset = 0; offset < ids.length; offset += 12) scopes.push(scopeSchema.parse({ region, date, branchIds: ids.slice(offset, offset + 12) }));
  }
  const request = freeze({ readerId: 'branch_evidence' as const, datasetId: context.dataset.id, dates,
    dateRange: { start: dates[0], end: dates[dates.length - 1] },
    regions: accepted.scope.regions, scopes, expectedBranchIds: accepted.scope.branchIds });
  requests.set(request, accepted);
  return request;
}

export async function executeReadRequest(request: ReadRequest, reader: EvidenceReader, freshAuthority: ActorAuthority | AuthorityLoader, readAt: string): Promise<ExecutionOutcome> {
  const accepted = requests.get(request);
  if (!accepted) return rejected('execution_failed', 'invalid_read_request');
  const context = acceptedContext(accepted);
  const requireCompleteSources = !!accepted.plan.topN || accepted.plan.completeness.expectation === 'complete_authorized_population' ||
    !!accepted.plan.compare && accepted.plan.compare.kind !== 'vs_target';
  if (!Number.isFinite(Date.parse(readAt))) return rejected('execution_failed', 'invalid_read_timestamp');
  const rows: EvidenceRow[] = [], sources: BundleSource[] = [];
  try {
    for (const scope of request.scopes) {
      const current = revalidate(accepted, typeof freshAuthority === 'function' ? await freshAuthority() : freshAuthority);
      if (current.outcome !== 'accepted') return current;
      const evidence = await reader(structuredClone(scope));
      if (evidence.scope.date !== scope.date || evidence.scope.region !== scope.region) return rejected('incomplete_evidence', 'reader_scope_mismatch');
      const cutoff = Date.parse(`${scope.date}T23:59:59+07:00`);
      if (Date.parse(evidence.asOf) !== cutoff) return rejected('data_unavailable', 'reader_cutoff_mismatch');
      const expectedIds = scope.branchIds!;
      const actualIds = evidence.branches.map(b => b.branchId);
      if (new Set(actualIds).size !== actualIds.length) return rejected('incomplete_evidence', 'duplicate_evidence_row');
      if (evidence.branches.some(b => !context.branches.some(expected => expected.id === b.branchId && expected.region === b.region) ||
        !expectedIds.includes(b.branchId) || b.region !== scope.region)) return rejected('permission_denied', 'unexpected_evidence_scope');
      if (actualIds.length !== expectedIds.length || expectedIds.some(id => !actualIds.includes(id))) return rejected('incomplete_evidence', 'population_incomplete');
      if (evidence.scope.branchIds && (new Set(evidence.scope.branchIds).size !== evidence.scope.branchIds.length ||
        evidence.scope.branchIds.length !== expectedIds.length || evidence.scope.branchIds.some(id => !expectedIds.includes(id)))) return rejected('incomplete_evidence', 'declared_population_mismatch');
      const bySource = new Map(evidence.sources.map(s => [s.id, s]));
      if (bySource.size !== evidence.sources.length) return rejected('incomplete_evidence', 'ambiguous_source_origin');
      for (const metric of evidence.branches) {
        if (new Set(metric.sourceIds).size !== metric.sourceIds.length) return rejected('incomplete_evidence', 'duplicate_row_source');
        const sourceRefs: string[] = [];
        for (const system of context.sourceSystems) {
          const id = `${system}:${metric.branchId}:${scope.date}`;
          const source = bySource.get(id);
          if (source && source.system !== system) return rejected('incomplete_evidence', 'required_source_missing');
          if (!source || source.freshness === 'missing') continue;
          if (!metric.sourceIds.includes(id)) return rejected('incomplete_evidence', 'required_source_missing');
          const observedAt = Date.parse(source.observedAt);
          if (source.freshness !== 'fresh' || !Number.isFinite(observedAt) || observedAt > cutoff || cutoff - observedAt > 86_400_000 ||
            !Number.isFinite(Date.parse(source.retrievedAt)) || Date.parse(source.retrievedAt) < observedAt) return rejected('data_unavailable', 'required_source_not_fresh');
          sourceRefs.push(id);
          sources.push({ id, system, observedAt: source.observedAt, retrievedAt: source.retrievedAt, freshness: source.freshness });
        }
        if (!sourceRefs.length) {
          if (requireCompleteSources) return rejected('incomplete_evidence', 'required_source_missing');
          continue;
        }
        if (requireCompleteSources && sourceRefs.length !== context.sourceSystems.length) return rejected('incomplete_evidence', 'required_source_missing');
        const requestedMeasures = [...accepted.plan.measures.map(m => m.fieldId),
          ...accepted.plan.filters.filter(f => fieldById(context.dataset, f.fieldId).kind === 'measure').map(f => f.fieldId),
          ...(accepted.plan.compare?.kind === 'vs_target' ? accepted.plan.measures.flatMap(m => {
            const id = fieldById(context.dataset, m.fieldId).targetFieldId;
            return id ? [id] : [];
          }) : [])];
        const selectedMeasures = unique([...requestedMeasures, ...(requestedMeasures.some(id => ['gap', 'achievement'].includes(id)) ? ['net_sales', 'target'] : [])]);
        const values: Record<string, string | number | null> = { branch: metric.branchId, region: metric.region, date: scope.date };
        for (const id of selectedMeasures) {
          const field = fieldById(context.dataset, id);
          if (field.sourceSystems.some(system => !sourceRefs.includes(`${system}:${metric.branchId}:${scope.date}`))) {
            values[id] = null;
            continue;
          }
          const value = field.binding ? metric[field.binding] : undefined;
          if (!(typeof value === 'number' && Number.isFinite(value) || id === 'achievement' && value === null)) return rejected('data_unavailable', 'invalid_metric_value');
          values[id] = value as number | null;
        }
        rows.push({ rowId: `row:${metric.branchId}:${scope.date}`, branchId: metric.branchId, region: metric.region, date: scope.date, values, sourceRefs });
      }
    }
    const finalAuthority = revalidate(accepted, typeof freshAuthority === 'function' ? await freshAuthority() : freshAuthority);
    if (finalAuthority.outcome !== 'accepted') return finalAuthority;
    return { outcome: 'accepted', bundle: createEvidenceBundle(accepted, rows, sources, readAt) };
  } catch { return rejected('execution_failed', 'reader_failed'); }
}
