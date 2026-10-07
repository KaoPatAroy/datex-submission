import type { Actor, Profile } from '../../contracts';
import { digest, snapshotRef, type Consent, type ContentClaim, type PlanContext, type Recipient } from '../../effects/shared';
import { personLabel } from '../context/display';

const CHANNEL = 'simulated_inbox';

/** Registry permissions -> the capability names the Wave 4 modules check (see action-registry requiredPermissions). */
export function effectPermissions(permissions: readonly string[]): string[] {
  const set = new Set(permissions);
  if (set.has('dashboard.share')) set.add('communication.send');
  if (set.has('sales.read') && set.has('dashboard.create')) set.add('monitor.manage');
  return [...set].sort();
}

export const recipientSnapshot = (profile: Profile): Recipient => ({
  ref: snapshotRef(profile.id, 1, { id: profile.id, name: profile.name, role: profile.role, regions: [...profile.regions].sort(), permissions: [...profile.permissions].sort(), active: profile.active }),
  // Display name (Thai role name for non-Thai fixture names). The snapshot ref above stays bound to the stored profile.
  name: personLabel(profile), regions: [...profile.regions], permissions: [...profile.permissions], active: profile.active,
});

export function authoritySnapshot(actor: Pick<Actor, 'id' | 'role' | 'active' | 'permissions' | 'regions' | 'sessionId' | 'mode' | 'modeRevision'>, recipientIds: readonly string[]): PlanContext['authority'] {
  return { revision: actor.modeRevision + 1, recipientIds: [...recipientIds].sort(),
    actor: { id: actor.id, role: actor.role, active: actor.active, permissions: effectPermissions(actor.permissions),
      regions: [...actor.regions], sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision } };
}

export function consentSnapshot(actorId: string, recipientIds: readonly string[], claims: readonly ContentClaim[], expiresAt: number): Consent {
  const claimRefs = claims.map(c => c.ref);
  const ref = snapshotRef(`consent:${digest({ actorId, recipientIds: [...recipientIds].sort(), claims: claimRefs.map(r => r.id).sort() }).slice(0, 24)}`, 1,
    { actorId, channel: CHANNEL, recipientIds: [...recipientIds].sort(), claims: claimRefs.map(r => [r.id, r.digest]).sort() });
  return { ref, actorId, channelId: CHANNEL, recipientIds: [...recipientIds], contentClaimIds: claims.map(c => c.ref.id), contentClaims: claimRefs, expiresAt, granted: true };
}
