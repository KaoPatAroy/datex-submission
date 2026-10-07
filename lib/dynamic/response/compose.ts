import { z } from 'zod';
import type { PresentationClaims } from './claims';
import { defaultResponsePlan, validateResponsePlan, type AcceptedResponsePlan, type ResponsePlan } from './plan';

/**
 * RESPONSE-001: the model may only ARRANGE grounded sections. Its hint names section kinds and a wording style; the server
 * assigns the claim ids (every id of the evidence-bound claim graph exactly once), validates the resulting ResponsePlan with
 * `validateResponsePlan`, and renders text from the claims themselves. Any rejection falls back to the deterministic default
 * plan (and, for the branch answer, to the legacy claim order). A hint can never add, drop, reword or recompute a claim.
 */
export const SECTION_KINDS = ['facts', 'comparisons', 'missing_evidence', 'caveats'] as const;
export const presentationHintSchema = z.object({
  order: z.array(z.enum(SECTION_KINDS)).min(1).max(4),
  style: z.enum(['concise', 'explanatory']).optional(),
}).strict();
export type PresentationHint = z.infer<typeof presentationHintSchema>;

export interface ComposedResponse {
  /** The accepted plan (the model's arrangement, or the deterministic default). */
  response: AcceptedResponsePlan;
  /** Claim ids in render order (sections by `order`, claims as listed in each section). */
  claimOrder: string[];
  /** true when the model's hint was applied; false = deterministic default. */
  fromHint: boolean;
}

export function claimOrderOf(response: AcceptedResponsePlan): string[] {
  return [...response.plan.sections].sort((a, b) => a.order - b.order).flatMap(section => section.claimIds);
}

/** Section order of a hint applied to the default plan: unlisted kinds keep their default relative order after the listed ones. */
export function arrangeResponsePlan(base: ResponsePlan, hint: PresentationHint): ResponsePlan {
  const listed = [...new Set(hint.order)];
  const rest = [...base.sections].sort((a, b) => a.order - b.order).map(section => section.kind).filter(kind => !listed.includes(kind));
  const kinds = [...listed, ...rest];
  const sections = kinds.map((kind, order) => ({ ...base.sections.find(section => section.kind === kind)!, order }));
  return { ...base, sections, wordingStyle: hint.style ?? base.wordingStyle };
}

export function composeResponse(claims: PresentationClaims, hintInput: unknown): ComposedResponse | null {
  const base = defaultResponsePlan(claims);
  const fallback = validateResponsePlan(base, claims);
  if (fallback.outcome !== 'accepted') return null;
  const hint = presentationHintSchema.safeParse(hintInput);
  if (hint.success) {
    const arranged = validateResponsePlan(arrangeResponsePlan(base, hint.data), claims);
    if (arranged.outcome === 'accepted') return { response: arranged, claimOrder: claimOrderOf(arranged), fromHint: true };
  }
  return { response: fallback, claimOrder: claimOrderOf(fallback), fromHint: false };
}
