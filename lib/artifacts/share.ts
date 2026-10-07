import { z } from 'zod';
import { idSchema, refSchema } from '../dynamic/plan/schemas';
import { rejected, type RejectedPlan } from '../dynamic/validate/query-plan';
import { digest, freeze } from '../dynamic/shared';
import type { ArtifactAuthority } from './contracts';
import { canReadArtifact, isTrustedArtifact, sameRef } from './prepare';

export const artifactSharePlanSchema = z.object({
  version: z.literal(1), artifact: refSchema, recipientId: idSchema, channelId: z.literal('in_app'),
}).strict();
export interface ArtifactSharePolicy {
  /** Server-owned exact policy, freshly resolved for both identities. */
  senderId: string; recipientIds: readonly string[]; permittedRolePairs: readonly { sender: string; recipient: string }[];
}
export interface ShareAuthority extends ArtifactAuthority { role: 'executive' | 'east_manager' | 'hr_admin' | 'hr_director' }
export interface ArtifactSharePreview {
  version: 1; artifact: z.infer<typeof refSchema>; sender: z.infer<typeof refSchema>; recipient: z.infer<typeof refSchema>;
  channelId: 'in_app'; scope: { regions: readonly string[]; branchIds: readonly string[] }; policyDigest: string;
  createdAt: string; expiresAt: string; confirmationRequired: true; executionAvailable: false;
}
const SHARE_PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Authorization only. Wave 4 must bind this exact preview to consent, confirmation, effect and receipt. */
export function authorizeArtifactShare(input: {
  proposal: unknown; record: unknown; sender: ShareAuthority; recipient: ShareAuthority; policy: ArtifactSharePolicy;
  preview?: ArtifactSharePreview; now?: () => Date;
}): { outcome: 'accepted'; preview: ArtifactSharePreview } | RejectedPlan {
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime()) || (input.preview && Date.parse(input.preview.expiresAt) <= now.getTime())) {
    return rejected('semantic_uncertainty', 'artifact_share_preview_expired');
  }
  const parsed = artifactSharePlanSchema.safeParse(input.proposal);
  if (!parsed.success) return rejected('unsupported_concept', 'invalid_artifact_share');
  if (!isTrustedArtifact(input.record) || !sameRef(parsed.data.artifact, input.record.ref)) return rejected('semantic_uncertainty', 'artifact_share_reference');
  const { sender, recipient, policy, record } = input;
  if (sender.id !== record.ownerId || !sender.permissions.includes('dashboard.share') || !canReadArtifact(record, sender) ||
    policy.senderId !== sender.id || recipient.id !== parsed.data.recipientId || !policy.recipientIds.includes(recipient.id) ||
    !policy.permittedRolePairs.some(pair => pair.sender === sender.role && pair.recipient === recipient.role)) {
    return rejected('permission_denied', 'artifact_share_authority');
  }
  // Recipient-scope guard: sharing never widens, truncates, or retargets the approved artifact.
  if (!canReadArtifact(record, recipient)) return rejected('permission_denied', 'artifact_recipient_scope');
  const authorityRef = (actor: ShareAuthority) => ({ id: actor.id, version: actor.revision, digest: digest(actor) });
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SHARE_PREVIEW_TTL_MS).toISOString();
  return { outcome: 'accepted', preview: freeze({ version: 1, artifact: record.ref, sender: authorityRef(sender), recipient: authorityRef(recipient),
    channelId: 'in_app', scope: structuredClone(record.bundle.scope), policyDigest: digest(policy), createdAt, expiresAt,
    confirmationRequired: true, executionAvailable: false }) };
}
