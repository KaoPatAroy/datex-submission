import type { Ref } from '../dynamic/plan/schemas';
import { bundlePlan } from '../dynamic/evidence/bundle';
import { revalidate, rejected, type RejectedPlan } from '../dynamic/validate/query-plan';
import { digest, freeze } from '../dynamic/shared';
import type { ArtifactAuthority, ArtifactPreview, ArtifactVersion } from './contracts';
import { canReadArtifact, previewBinding, sameRef, validArtifactRecord } from './prepare';

export interface ArtifactWrite { record: ArtifactVersion; expectedLatest: Ref | null }
const writes = new WeakSet<ArtifactWrite>();
const latestMatches = (a: Ref | null, b: Ref | null) => a === null ? b === null : b !== null && sameRef(a, b);

/** Pure confirmation/CAS adapter. latestRef must be loaded authoritatively inside the write transaction. */
export function prepareArtifactWrite(input: {
  preview: ArtifactPreview; confirmedPreview: Ref; latestRef: Ref | null; authority: ArtifactAuthority; now: string;
}): { outcome: 'accepted'; write: ArtifactWrite } | RejectedPlan {
  const binding = previewBinding(input.preview);
  if (!binding || !sameRef(input.confirmedPreview, input.preview.ref)) return rejected('semantic_uncertainty', 'artifact_confirmation');
  if (!Number.isFinite(Date.parse(input.now)) || Date.parse(input.now) < Date.parse(input.preview.artifact.createdAt) ||
    Date.parse(input.now) >= Date.parse(input.preview.expiresAt)) return rejected('permission_denied', 'artifact_preview_expired');
  const checked = binding.revalidate ? binding.revalidate(input.authority) : revalidate(bundlePlan(binding.bundle!), input.authority);
  if (checked.outcome !== 'accepted') return checked as RejectedPlan;
  if (digest(input.authority) !== binding.authorityDigest || !input.authority.permissions.includes('dashboard.create') ||
    input.authority.id !== input.preview.artifact.ownerId || !canReadArtifact(input.preview.artifact, input.authority)) return rejected('permission_denied', 'artifact_authority_changed');
  const expectedLatest = input.preview.artifact.plan.baseRevision;
  if (!latestMatches(expectedLatest, input.latestRef)) return rejected('execution_failed', 'artifact_conflict');
  const write = freeze({ record: input.preview.artifact, expectedLatest });
  writes.add(write);
  return { outcome: 'accepted', write };
}

/** Independent store readback is mandatory; an append acknowledgement is never a verified result. */
export function verifyArtifactWrite(input: {
  write: ArtifactWrite; readback: unknown; authority: ArtifactAuthority;
}): { outcome: 'accepted'; status: 'verified'; ref: Ref } | RejectedPlan {
  if (!writes.has(input.write) || !validArtifactRecord(input.readback) || !sameRef(input.write.record.ref, input.readback.ref)) {
    return rejected('execution_failed', 'artifact_readback_mismatch');
  }
  if (input.authority.id !== input.write.record.ownerId || digest(input.authority) !== input.write.record.authority.digest ||
    !canReadArtifact(input.readback, input.authority)) return rejected('permission_denied', 'artifact_readback_authority');
  return { outcome: 'accepted', status: 'verified', ref: input.readback.ref };
}
