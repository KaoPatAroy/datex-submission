import { freeze } from '../dynamic/shared';
import type { Ref } from '../dynamic/plan/schemas';

/**
 * Runtime-trusted proof that the owner shared exactly this artifact version with exactly this recipient. Created ONLY by the
 * server after it re-read the stored share row and re-authorized sender and recipient (see lib/artifacts/shared-store.ts);
 * never built from AI or client JSON. The renderer accepts a non-owner viewer only with such a grant.
 */
export interface ArtifactShareGrant { artifact: Ref; senderId: string; recipientId: string }
const trusted = new WeakSet<object>();

export function issueShareGrant(input: ArtifactShareGrant): ArtifactShareGrant {
  const grant = freeze({ artifact: { ...input.artifact }, senderId: input.senderId, recipientId: input.recipientId });
  trusted.add(grant);
  return grant;
}
export function isShareGrant(value: unknown): value is ArtifactShareGrant {
  return value !== null && typeof value === 'object' && trusted.has(value);
}
