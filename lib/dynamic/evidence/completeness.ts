import { z } from 'zod';
import { idSchema, refSchema, type Ref } from '../plan/schemas';
import { digest, freeze } from '../shared';
import { bundlePlan, type EvidenceBundle } from './bundle';

const instant = z.string().datetime({ offset: true });
// Derived provenance identities include source/branch/date prefixes; they are inert refs, not executable catalog IDs.
export const provenanceIdSchema = z.string().min(1).max(300);
export const sourceRequirementSchema = z.object({ id: provenanceIdSchema, adapterId: idSchema,
  expectedRowIds: z.array(provenanceIdSchema).max(12000), maxAgeMs: z.number().int().positive().max(31_536_000_000),
  freshnessAsOf: instant.optional(),
  coverageBasis: z.enum(['record_ids', 'branch_date_evidence']).optional(),
}).strict();
export const sourceObservationSchema = z.object({ id: provenanceIdSchema, adapterId: idSchema,
  observedAt: instant.nullable(), retrievedAt: instant, coveredRowIds: z.array(provenanceIdSchema).max(12000),
}).strict();
export type SourceRequirement = z.infer<typeof sourceRequirementSchema>;
export type SourceObservation = z.infer<typeof sourceObservationSchema>;
export interface SourceCompleteness {
  version: 1; ref: Ref; asOf: string;
  sources: readonly { id: string; adapterId: string; observedAt: string | null; retrievedAt: string | null;
    freshness: 'fresh' | 'stale' | 'misaligned' | 'missing'; expected: number; rowCount: number;
    complete: boolean; digest: string; omittedRowIds: readonly string[];
    coverageBasis: 'record_ids' | 'branch_date_evidence' }[];
  complete: boolean; limitations: readonly string[];
}
const reports = new WeakSet<SourceCompleteness>();
const completeBundles = new WeakSet<CompleteEvidenceBundle>();
export function assertCompleteEvidenceBundle(bundle: CompleteEvidenceBundle): void {
  if (!completeBundles.has(bundle)) throw new Error('A server-enriched evidence bundle is required.');
}

/** Coverage is recomputed from exact population identities; a reader cannot declare completeness. */
export function assessSourceCompleteness(input: {
  requirements: readonly SourceRequirement[]; observations: readonly SourceObservation[]; asOf: string;
}): SourceCompleteness {
  instant.parse(input.asOf);
  const requirements = z.array(sourceRequirementSchema).min(1).max(10000).parse(input.requirements);
  const observations = z.array(sourceObservationSchema).max(10000).parse(input.observations);
  if (requirements.reduce((sum, r) => sum + r.expectedRowIds.length, 0) > 96000 ||
    observations.reduce((sum, r) => sum + r.coveredRowIds.length, 0) > 96000) throw new Error('Source row budget exceeded.');
  const ids = new Set(requirements.map(r => r.id));
  if (ids.size !== requirements.length || new Set(observations.map(s => s.id)).size !== observations.length ||
    observations.some(o => !ids.has(o.id))) throw new Error('Unregistered or duplicate source.');
  const asOf = Date.parse(input.asOf);
  const sources = requirements.map(requirement => {
    if (new Set(requirement.expectedRowIds).size !== requirement.expectedRowIds.length) throw new Error('Duplicate source population.');
    const observation = observations.find(o => o.id === requirement.id);
    if (observation && (observation.adapterId !== requirement.adapterId ||
      new Set(observation.coveredRowIds).size !== observation.coveredRowIds.length ||
      observation.coveredRowIds.some(id => !requirement.expectedRowIds.includes(id)))) throw new Error('Source population mismatch.');
    const omittedRowIds = requirement.expectedRowIds.filter(id => !observation?.coveredRowIds.includes(id));
    const observed = observation?.observedAt ? Date.parse(observation.observedAt) : NaN;
    const retrieved = observation ? Date.parse(observation.retrievedAt) : NaN;
    const freshnessAt = requirement.freshnessAsOf ? Date.parse(requirement.freshnessAsOf) : asOf;
    if (freshnessAt > asOf) throw new Error('Future source cutoff.');
    const freshness = !Number.isFinite(observed) ? 'missing' as const : observed > freshnessAt || retrieved < observed || retrieved > asOf
      ? 'misaligned' as const : freshnessAt - observed > requirement.maxAgeMs ? 'stale' as const : 'fresh' as const;
    return { id: requirement.id, adapterId: requirement.adapterId, observedAt: observation?.observedAt ?? null,
      retrievedAt: observation?.retrievedAt ?? null, freshness, expected: requirement.expectedRowIds.length,
      rowCount: observation?.coveredRowIds.length ?? 0, complete: omittedRowIds.length === 0 && freshness === 'fresh',
      digest: digest({ requirement, observation: observation ?? null }), omittedRowIds,
      coverageBasis: requirement.coverageBasis ?? 'record_ids' as const };
  });
  const payload = { version: 1 as const, asOf: input.asOf, sources, complete: sources.every(s => s.complete),
    limitations: [...sources.filter(s => !s.complete).map(s => `Source ${s.id}: ${s.freshness}; coverage ${s.rowCount}/${s.expected}.`),
      ...(sources.some(s => s.coverageBasis === 'branch_date_evidence')
        ? ['Source coverage is measured at branch/date evidence grain; upstream source record completeness is not attested.'] : [])] };
  const report = freeze({ ...payload, ref: { id: 'source_completeness', version: 1, digest: digest(payload) } });
  reports.add(report);
  return report;
}

export function sourceCompletenessOutcome(report: SourceCompleteness, input: {
  requireFullPopulation: boolean; minimumCoverage: number; topN: boolean;
}): 'accepted' | 'incomplete_evidence' | 'data_unavailable' {
  if (!reports.has(report)) throw new Error('A server-assessed source report is required.');
  z.object({ requireFullPopulation: z.boolean(), minimumCoverage: z.number().min(0).max(1), topN: z.boolean() }).strict().parse(input);
  if (report.sources.some(s => s.freshness !== 'fresh')) return 'data_unavailable';
  if ((input.requireFullPopulation || input.topN) && !report.complete || report.sources.some(s =>
    (s.expected === 0 ? 1 : s.rowCount / s.expected) < input.minimumCoverage)) return 'incomplete_evidence';
  return 'accepted';
}

export interface CompleteEvidenceBundle { version: 2; ref: Ref; evidence: EvidenceBundle; sourceCompleteness: SourceCompleteness }
/** Add source coverage to a genuine Wave 1 execution without changing its stored v1 contract. */
export function enrichEvidenceBundle(bundle: EvidenceBundle): CompleteEvidenceBundle {
  const accepted = bundlePlan(bundle);
  const requirements: SourceRequirement[] = bundle.sources.map(source => {
    const date = bundle.provenance.dates.find(candidate => source.id.endsWith(`:${candidate}`));
    if (!date) throw new Error('Evidence source date is missing from provenance.');
    const branchId = accepted.scope.branchIds.find(candidate => source.id === `${source.system}:${candidate}:${date}`);
    if (!branchId) throw new Error('Evidence source branch is missing from the accepted scope.');
    const expectedRowIds = bundle.rows.filter(row => row.sourceRefs.includes(source.id)).map(row => row.rowId);
    return { id: source.id, adapterId: source.system,
      expectedRowIds: expectedRowIds.length ? expectedRowIds : [`row:${branchId}:${date}`], maxAgeMs: 86_400_000,
      coverageBasis: 'branch_date_evidence', freshnessAsOf: new Date(`${date}T23:59:59+07:00`).toISOString() };
  });
  const observations = bundle.sources.map(source => ({ id: source.id, adapterId: source.system, observedAt: source.observedAt,
    retrievedAt: source.retrievedAt, coveredRowIds: bundle.rows.filter(row => row.sourceRefs.includes(source.id)).map(row => row.rowId) }));
  // Per-pair source requirements include omitted branch/date pairs, not only returned rows.
  const plan = bundlePlan(bundle), systems = bundle.provenance.sourceNames;
  for (const branch of plan.scope.branchIds) for (const date of bundle.provenance.dates) for (const system of systems) {
    const id = `${system}:${branch}:${date}`;
    if (!requirements.some(r => r.id === id)) requirements.push({ id, adapterId: system, expectedRowIds: [`row:${branch}:${date}`], maxAgeMs: 86_400_000,
      coverageBasis: 'branch_date_evidence',
      freshnessAsOf: new Date(`${date}T23:59:59+07:00`).toISOString() });
  }
  const sourceCompleteness = assessSourceCompleteness({ requirements, observations, asOf: bundle.provenance.readAt });
  const payload = { version: 2 as const, evidence: bundle, sourceCompleteness };
  const enriched = freeze({ ...payload, ref: refSchema.parse({ id: 'complete_evidence', version: 2, digest: digest(payload) }) });
  completeBundles.add(enriched);
  return enriched;
}
