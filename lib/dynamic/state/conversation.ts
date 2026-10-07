import { z } from 'zod';
import { idSchema, refSchema } from '../plan/schemas';
import type { AcceptedPlan, ActorAuthority, RejectedPlan } from '../validate/query-plan';
import { acceptedContext, revalidate } from '../validate/query-plan';
import { bundlePlan, type EvidenceBundle } from '../evidence/bundle';
import { isBoundClaimGraph, type ClaimGraph } from '../evidence/claim-graph';
import { digest, freeze } from '../shared';

export const conversationStateSchema = z.object({
  version: z.literal(1), conversationId: idSchema, turnId: idSchema, revision: z.number().int().positive(), status: z.literal('accepted'),
  sourceText: refSchema, lastAcceptedPlan: refSchema, dataset: refSchema,
  resolvedScope: z.object({ regions: z.array(z.string().min(1).max(40)).min(1).max(2000), branchIds: z.array(z.string().min(1).max(100)).min(1).max(2000),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(62) }).strict(),
  authoritySnapshot: refSchema, catalogSnapshot: refSchema, evidenceBundle: refSchema, claimGraph: refSchema,
  parentState: refSchema.nullable(),
}).strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;

/** Pure persistence preparation. The integration owner must apply CAS and recheck authority transactionally. */
export function prepareConversationState(input: {
  conversationId: string; turnId: string; revision: number; sourceText: ConversationState['sourceText'];
  parentState: ConversationState['parentState']; plan: AcceptedPlan; bundle: EvidenceBundle; claims: ClaimGraph;
}, freshAuthority: ActorAuthority): { outcome: 'accepted'; state: ConversationState } | RejectedPlan {
  const checked = revalidate(input.plan, freshAuthority);
  if (checked.outcome !== 'accepted') return checked;
  if (bundlePlan(input.bundle) !== input.plan || !isBoundClaimGraph(input.claims, input.bundle) || input.claims.evidence.digest !== input.bundle.ref.digest ||
    input.sourceText.digest !== digest(acceptedContext(input.plan).available.sourceText) ||
    input.claims.claims.some(c => c.rowRefs.some(id => !input.bundle.rows.some(row => row.rowId === id)))) {
    return { outcome: 'semantic_uncertainty', code: 'state_reference_mismatch', safeDetail: 'State must bind the exact accepted plan and evidence.' };
  }
  const state = conversationStateSchema.parse({ version: 1, conversationId: input.conversationId, turnId: input.turnId,
    revision: input.revision, status: 'accepted', sourceText: input.sourceText,
    lastAcceptedPlan: { id: input.plan.plan.planId, version: input.plan.plan.planVersion, digest: input.plan.planDigest },
    dataset: input.bundle.dataset, resolvedScope: { regions: [...input.plan.scope.regions], branchIds: [...input.plan.scope.branchIds], dates: [...input.plan.dates] },
    authoritySnapshot: { id: freshAuthority.id, version: freshAuthority.revision, digest: digest(freshAuthority) },
    catalogSnapshot: { id: 'semantic_catalog', version: 1, digest: input.plan.catalogDigest }, evidenceBundle: input.bundle.ref,
    claimGraph: { id: `claims:${input.claims.digest}`, version: 1, digest: input.claims.digest }, parentState: input.parentState });
  return { outcome: 'accepted', state: freeze(state) };
}
