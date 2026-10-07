import { z } from 'zod';
import { idSchema, refSchema, type Ref } from '../plan/schemas';
import { digest, freeze } from '../shared';
import { hrBundlePlan, hrPlanContext, type Wave2Catalog } from '../catalog/hr';
import type { CatalogAuthority } from '../catalog/authority';
import { bundlePlan } from '../evidence/bundle';
import { acceptedContext, rejected, revalidate, type RejectedPlan } from '../validate/query-plan';
import { responseClaims, type AcceptedResponsePlan } from '../response/plan';
import { basePresentationBundle, presentationEvidence } from '../response/claims';

export const exactConversationStateSchema = z.object({
  version: z.literal(2), conversationId: idSchema, turnId: idSchema, revision: z.number().int().positive(), status: z.literal('accepted'),
  sourceText: refSchema, queryPlan: refSchema, validation: refSchema, catalogSnapshot: refSchema, authoritySnapshot: refSchema,
  execution: refSchema, evidenceBundle: refSchema, claimGraph: refSchema, responsePlan: refSchema, sourceCompleteness: refSchema,
  parentState: refSchema.nullable(), createdAt: z.string().datetime({ offset: true }),
}).strict();
export type ExactConversationState = z.infer<typeof exactConversationStateSchema>;
export interface PreparedExactState { outcome: 'accepted'; state: ExactConversationState; ref: Ref; expectedPrevious: Ref | null }
const refEqual = (a: Ref | null, b: Ref | null) => digest(a) === digest(b);
/** Source text is immutable content; v2 persists this canonical ref independently of legacy turn IDs. */
export function exactSourceTextRef(text: string): Ref {
  const fingerprint = digest(text);
  return freeze({ id: `source:${fingerprint}`, version: 1, digest: fingerprint });
}

/** Pure preparation. The lead must reload authority and apply expectedPrevious CAS inside one transaction. */
export function prepareExactConversationState(input: {
  conversationId: string; turnId: string; revision: number; sourceText: Ref; parentState: Ref | null; currentState: Ref | null;
  response: AcceptedResponsePlan; freshAuthority: CatalogAuthority; currentCatalog: Wave2Catalog; now: string;
}): PreparedExactState | RejectedPlan {
  if (!refEqual(input.parentState, input.currentState) || input.revision !== (input.currentState?.version ?? 0) + 1 ||
    input.currentState && input.currentState.id !== `state:${digest(input.conversationId)}`) return rejected('semantic_uncertainty', 'state_cas_mismatch');
  const claims = responseClaims(input.response), evidence = presentationEvidence(claims), bundle = basePresentationBundle(evidence);
  let sourceText: string, query: Ref, authority: Ref, catalog: Ref;
  if ('authorityDigest' in bundle) {
    const fresh = input.freshAuthority;
    const accepted = bundlePlan(bundle), checked = revalidate(accepted, { id: fresh.id, active: fresh.active,
      permissions: fresh.permissions, regions: fresh.regions, revision: fresh.revision }), context = acceptedContext(accepted);
    if (checked.outcome !== 'accepted') return checked;
    // Wave 1 authority omits role/branch restrictions, so explicitly enforce the new scope boundary.
    if (input.freshAuthority.role === 'east_manager' && accepted.scope.regions.some(r => r !== 'east') ||
      input.freshAuthority.branchIds && accepted.scope.branchIds.some(id => !input.freshAuthority.branchIds!.includes(id))) return rejected('permission_denied', 'state_scope_changed');
    sourceText = context.available.sourceText; query = bundle.query;
    authority = { id: fresh.id, version: fresh.revision, digest: digest(fresh) };
    catalog = { id: 'semantic_catalog', version: 1, digest: accepted.catalogDigest };
    if (input.currentCatalog.branchCatalog.digest !== accepted.catalogDigest) return rejected('semantic_uncertainty', 'state_catalog_changed');
  } else {
    const accepted = hrBundlePlan(bundle), context = hrPlanContext(accepted);
    if (digest(input.freshAuthority) !== accepted.authority.digest || !input.freshAuthority.active) return rejected('permission_denied', 'state_authority_changed');
    if (!refEqual(input.currentCatalog.ref, accepted.catalog)) return rejected('semantic_uncertainty', 'state_catalog_changed');
    sourceText = context.sourceText; query = accepted.ref; authority = accepted.authority; catalog = accepted.catalog;
  }
  if (!refEqual(input.sourceText, exactSourceTextRef(sourceText)) || !refEqual(claims.evidence, evidence.ref)) return rejected('semantic_uncertainty', 'state_reference_mismatch');
  const validation: Ref = { id: 'validation', version: 1, digest: digest({ query, authority, catalog, scope: bundle.scope }) };
  const execution: Ref = { id: 'execution', version: 1, digest: digest({ query, evidence: evidence.ref, sources: evidence.sourceCompleteness.ref }) };
  const state = exactConversationStateSchema.parse({ version: 2, conversationId: input.conversationId, turnId: input.turnId,
    revision: input.revision, status: 'accepted', sourceText: input.sourceText, queryPlan: query, validation,
    catalogSnapshot: catalog, authoritySnapshot: authority, execution, evidenceBundle: evidence.ref, claimGraph: claims.ref,
    responsePlan: input.response.ref, sourceCompleteness: evidence.sourceCompleteness.ref, parentState: input.parentState, createdAt: input.now });
  return freeze({ outcome: 'accepted', state, ref: { id: `state:${digest(input.conversationId)}`, version: state.revision, digest: digest(state) }, expectedPrevious: input.currentState });
}
