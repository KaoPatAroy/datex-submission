import type { Ref } from '../plan/schemas';
import { digest, freeze, unique } from '../shared';
import { bundlePlan, type EvidenceBundle } from '../evidence/bundle';
import { buildClaimGraph } from '../evidence/claim-graph';
import { hrBundlePlan, type HrEvidenceBundle } from '../catalog/hr';
import { assertCompleteEvidenceBundle, sourceCompletenessOutcome, type CompleteEvidenceBundle } from '../evidence/completeness';
import { rejected, type RejectedPlan } from '../validate/query-plan';

export interface PresentationClaim {
  id: string; kind: 'fact' | 'comparison'; fieldId: string; value: unknown; unit?: string;
  dimensions: Readonly<Record<string, string>>; rowRefs: readonly string[]; sourceRefs: readonly string[];
  calculatorId?: string; caveat?: string;
}
export interface PresentationClaims {
  version: 1; ref: Ref; evidence: Ref; claims: readonly PresentationClaim[];
  limitations: readonly string[]; interpretationLabels: readonly string[];
}
export type PresentationEvidence = CompleteEvidenceBundle | HrEvidenceBundle;
const bindings = new WeakMap<PresentationClaims, PresentationEvidence>();
export function presentationEvidence(claims: PresentationClaims): PresentationEvidence {
  const bundle = bindings.get(claims);
  if (!bundle) throw new Error('An execution-bound claim graph is required.');
  return bundle;
}

/** Server calculators supply facts; a model can arrange these IDs but cannot create values. */
export function createPresentationClaims(bundle: HrEvidenceBundle): PresentationClaims;
export function createPresentationClaims(bundle: CompleteEvidenceBundle): PresentationClaims | RejectedPlan;
export function createPresentationClaims(bundle: PresentationEvidence): PresentationClaims | RejectedPlan {
  let claims: PresentationClaim[], limitations: readonly string[], interpretationLabels: readonly string[];
  if ('evidence' in bundle) {
    assertCompleteEvidenceBundle(bundle);
    const accepted = bundlePlan(bundle.evidence);
    const completeness = sourceCompletenessOutcome(bundle.sourceCompleteness, {
      requireFullPopulation: accepted.plan.completeness.requireFullPopulation,
      minimumCoverage: accepted.plan.completeness.minimumCoverage,
      topN: accepted.plan.topN !== null,
    });
    if (completeness !== 'accepted') return rejected(completeness, `source_completeness_${completeness}`);
    const graph = buildClaimGraph(bundle.evidence);
    claims = graph.claims.map(claim => ({ id: claim.id, kind: claim.computation.operation === 'difference' ? 'comparison' : 'fact',
      fieldId: claim.measure, value: claim.value, unit: claim.unit, dimensions: claim.dimensions, sourceRefs: claim.sourceRefs, rowRefs: claim.rowRefs,
      calculatorId: claim.computation.calculatorId, ...(claim.caveat ? { caveat: claim.caveat } : {}) }));
    limitations = unique([...graph.limitations, ...bundle.sourceCompleteness.limitations]);
    interpretationLabels = bundle.evidence.interpretationLabels;
  } else {
    const plan = hrBundlePlan(bundle);
    if (plan.plan.aggregation === 'rows') {
      claims = bundle.rows.map(row => ({ id: `claim:${digest(row)}`, kind: 'fact', fieldId: 'employee_directory',
        value: { employee_id: row.values.employee_id, employee_name: row.values.employee_name,
          branch: row.values.branch, active: row.values.active,
          ...(row.values.badge_id !== undefined ? { badge_id: row.values.badge_id, badge_status: row.values.badge_status, badge_type: row.values.badge_type } : {}) },
        dimensions: { branch: String(row.values.branch) },
        rowRefs: [row.rowId], sourceRefs: row.sourceRefs }));
    } else {
      const groups = new Map<string, HrEvidenceBundle['rows'][number][]>();
      for (const row of bundle.rows) {
        const key = JSON.stringify(plan.plan.group.fieldIds.map(id => row.values[id]));
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      if (groups.size > 2000) throw new Error('HR group budget exceeded.');
      claims = [...groups.values()].map(rows => ({ id: `claim:${digest({ rows: rows.map(r => r.rowId), group: plan.plan.group })}`,
        kind: 'fact', fieldId: 'headcount', value: rows.reduce((sum, row) => sum + Number(row.values.headcount), 0), unit: 'people',
        calculatorId: 'hr.active_headcount.v1', dimensions: Object.fromEntries(plan.plan.group.fieldIds.map(id => [id, String(rows[0].values[id])])),
        rowRefs: rows.map(row => row.rowId), sourceRefs: unique(rows.flatMap(row => [...row.sourceRefs])) }));
      if (plan.plan.sort[0]) claims.sort((a, b) => (Number(a.value) - Number(b.value)) * (plan.plan.sort[0].direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id));
      if (plan.plan.topN) {
        if (!bundle.coverage.complete) throw new Error('Complete HR ranking population required.');
        if (!plan.plan.sort[0]) claims.sort((a, b) => (Number(a.value) - Number(b.value)) * (plan.plan.topN!.direction === 'lowest' ? 1 : -1) || a.id.localeCompare(b.id));
        claims = claims.slice(0, plan.plan.topN.count);
      }
    }
    limitations = unique([...bundle.limitations, ...(!bundle.rows.length ? ['No matching employee facts in the verified authorized snapshot.'] : [])]);
    interpretationLabels = bundle.interpretationLabels;
  }
  const payload = { version: 1 as const, evidence: bundle.ref, claims, limitations, interpretationLabels };
  const graph = freeze({ ...payload, ref: { id: 'presentation_claims', version: 1, digest: digest(payload) } });
  bindings.set(graph, bundle);
  return graph;
}

export function basePresentationBundle(bundle: PresentationEvidence): EvidenceBundle | HrEvidenceBundle {
  return 'evidence' in bundle ? bundle.evidence : bundle;
}
