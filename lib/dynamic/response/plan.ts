import { z } from 'zod';
import { idSchema, refSchema, type Ref } from '../plan/schemas';
import { digest, freeze } from '../shared';
import { presentationEvidence, type PresentationClaims } from './claims';
import { rejected, type RejectedPlan } from '../validate/query-plan';
import { provenanceIdSchema } from '../evidence/completeness';
import { bundlePlan } from '../evidence/bundle';
import { hrBundlePlan } from '../catalog/hr';

export const responsePlanSchema = z.object({
  version: z.literal(1), claimGraph: refSchema,
  sections: z.array(z.object({ kind: z.enum(['facts', 'comparisons', 'missing_evidence', 'caveats']),
    claimIds: z.array(idSchema).max(4000), order: z.number().int().nonnegative().max(10) }).strict()).min(1).max(4),
  wordingStyle: z.enum(['concise', 'explanatory']), interpretationLabels: z.array(z.string().min(1).max(500)).max(100),
  citations: z.array(z.object({ claimId: idSchema, sourceRefs: z.array(provenanceIdSchema).min(1).max(10000) }).strict()).max(4000),
  locale: z.enum(['en', 'th']),
}).strict();
export type ResponsePlan = z.infer<typeof responsePlanSchema>;
export interface AcceptedResponsePlan { outcome: 'accepted'; plan: ResponsePlan; ref: Ref }
const responses = new WeakMap<AcceptedResponsePlan, PresentationClaims>();
export function responseClaims(response: AcceptedResponsePlan): PresentationClaims {
  const claims = responses.get(response);
  if (!claims) throw new Error('A server-validated response is required.');
  return claims;
}
const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length &&
  new Set(a).size === a.length && a.every(id => b.includes(id));

/** The presentation vocabulary intentionally has no free-form factual wording, HTML, or code. */
export function validateResponsePlan(proposal: unknown, claims: PresentationClaims): AcceptedResponsePlan | RejectedPlan {
  presentationEvidence(claims);
  const parsed = responsePlanSchema.safeParse(proposal);
  if (!parsed.success) return rejected('semantic_uncertainty', 'invalid_response_plan');
  const plan = parsed.data;
  if (digest(plan.claimGraph) !== digest(claims.ref)) return rejected('semantic_uncertainty', 'response_graph_mismatch');
  if (new Set(plan.sections.map(s => s.kind)).size !== plan.sections.length || new Set(plan.sections.map(s => s.order)).size !== plan.sections.length) {
    return rejected('semantic_uncertainty', 'response_duplicate_section');
  }
  const referenced = plan.sections.flatMap(s => s.claimIds);
  if (!sameStrings(referenced, claims.claims.map(c => c.id)) || plan.sections.some(s => s.claimIds.some(id => {
    const claim = claims.claims.find(c => c.id === id);
    return !claim || s.kind === 'facts' && claim.kind !== 'fact' || s.kind === 'comparisons' && claim.kind !== 'comparison' ||
      ['missing_evidence', 'caveats'].includes(s.kind);
  }))) return rejected('semantic_uncertainty', 'response_unknown_or_misplaced_claim');
  const evidence = presentationEvidence(claims);
  const queryPlan = 'evidence' in evidence ? bundlePlan(evidence.evidence).plan : hrBundlePlan(evidence).plan;
  if ((queryPlan.sort.length > 0 || queryPlan.topN !== null) && plan.sections.some(section => {
    const positions = section.claimIds.map(id => claims.claims.findIndex(claim => claim.id === id));
    return positions.some((position, index) => index > 0 && position <= positions[index - 1]);
  })) return rejected('semantic_uncertainty', 'response_claim_order_mismatch');
  if (!sameStrings(plan.interpretationLabels, claims.interpretationLabels) ||
    (claims.limitations.length > 0 && !plan.sections.some(s => s.kind === 'missing_evidence')) ||
    (claims.claims.some(c => c.caveat) && !plan.sections.some(s => s.kind === 'caveats'))) return rejected('semantic_uncertainty', 'response_required_caveat');
  if (plan.citations.length !== claims.claims.length || new Set(plan.citations.map(c => c.claimId)).size !== plan.citations.length ||
    plan.citations.some(citation => {
      const claim = claims.claims.find(c => c.id === citation.claimId);
      return !claim || !sameStrings(citation.sourceRefs, claim.sourceRefs);
    })) return rejected('semantic_uncertainty', 'response_citation_mismatch');
  const accepted = freeze({ outcome: 'accepted' as const, plan, ref: { id: 'response_plan', version: 1, digest: digest(plan) } });
  responses.set(accepted, claims);
  return accepted;
}

export function defaultResponsePlan(claims: PresentationClaims): ResponsePlan {
  presentationEvidence(claims);
  return { version: 1, claimGraph: claims.ref,
    sections: [{ kind: 'facts', claimIds: claims.claims.filter(c => c.kind === 'fact').map(c => c.id), order: 0 },
      { kind: 'comparisons', claimIds: claims.claims.filter(c => c.kind === 'comparison').map(c => c.id), order: 1 },
      { kind: 'missing_evidence', claimIds: [], order: 2 }, { kind: 'caveats', claimIds: [], order: 3 }],
    wordingStyle: 'concise', interpretationLabels: [...claims.interpretationLabels],
    citations: claims.claims.map(c => ({ claimId: c.id, sourceRefs: [...c.sourceRefs] })), locale: 'en' };
}

/** Plain text only; all entity values are escaped as JSON literals and remain inert data. */
export function renderResponsePlan(response: AcceptedResponsePlan): string {
  const claims = responseClaims(response);
  const parts: string[] = [...response.plan.interpretationLabels];
  for (const section of [...response.plan.sections].sort((a, b) => a.order - b.order)) {
    for (const id of section.claimIds) {
      const claim = claims.claims.find(c => c.id === id)!;
      parts.push(`${section.kind}: ${claim.fieldId} ${JSON.stringify(claim.dimensions)} ${JSON.stringify(claim.value)}${claim.unit ? ` ${claim.unit}` : ''} [${claim.sourceRefs.join(', ')}]`);
    }
    if (section.kind === 'missing_evidence') parts.push(...claims.limitations);
    if (section.kind === 'caveats') parts.push(...claims.claims.flatMap(c => c.caveat ? [c.caveat] : []));
  }
  return parts.join('\n');
}
