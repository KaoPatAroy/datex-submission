import { describe, expect, it } from 'vitest';
import { authorizeArtifactShare, type ArtifactSharePolicy, type ShareAuthority } from '../../lib/artifacts';
import { actor, artifactFixture } from './fixtures';

const sender: ShareAuthority = { ...actor, role: 'east_manager' };
const recipient: ShareAuthority = { ...actor, id: 'east_team_lead', role: 'east_manager', permissions: ['sales.read', 'operations.read'] };
const policy: ArtifactSharePolicy = { senderId: sender.id, recipientIds: [recipient.id], permittedRolePairs: [{ sender: 'east_manager', recipient: 'east_manager' }] };
async function shareInput() {
  const { artifact } = await artifactFixture();
  return { record: artifact, sender, recipient, policy, proposal: { version: 1, artifact: artifact.ref, recipientId: recipient.id, channelId: 'in_app' } };
}

describe('exact artifact share authorization without effect execution', () => {
  it('authorizes the exact role, recipient and full scope and requires Wave4 confirmation', async () => {
    const input = await shareInput(), now = () => new Date('2026-10-06T00:00:00.000Z'), result = authorizeArtifactShare({ ...input, now });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.preview.scope).toEqual(input.record.bundle.scope); expect(result.preview.recipient.id).toBe(recipient.id);
      expect(result.preview).toMatchObject({ confirmationRequired: true, executionAvailable: false });
      expect(result.preview.createdAt).toBe('2026-10-06T00:00:00.000Z');
      expect(result.preview.expiresAt).toBe('2026-10-06T00:10:00.000Z');
      expect(Object.isFrozen(result.preview.scope.branchIds)).toBe(true);
    }
  });
  it('rejects an expired preview using the injectable clock', async () => {
    const input = await shareInput(), created = authorizeArtifactShare({ ...input, now: () => new Date('2026-10-06T00:00:00.000Z') });
    if (created.outcome !== 'accepted') throw new Error('Expected preview');
    expect(authorizeArtifactShare({ ...input, preview: created.preview, now: () => new Date(created.preview.expiresAt) }))
      .toMatchObject({ outcome: 'semantic_uncertainty', code: 'artifact_share_preview_expired' });
  });
  it('recipient scope guard denies a South recipient without any protected output', async () => {
    const input = await shareInput();
    const result = authorizeArtifactShare({ ...input, recipient: { ...recipient, regions: ['south'] } });
    expect(result.outcome).toBe('permission_denied');
    if (result.outcome !== 'accepted') expect(result.code).toBe('artifact_recipient_scope');
    expect('preview' in result).toBe(false); expect(JSON.stringify(result)).not.toContain('E01');
  });
  it.each([{ active: false }, { regions: [] }, { permissions: ['sales.read'] }, { permissions: ['dashboard.share'] }, { catalogDigest: '0'.repeat(64) }])('intersects recipient read policy %j', async change => {
    const result = authorizeArtifactShare({ ...await shareInput(), recipient: { ...recipient, ...change } });
    expect(result).toMatchObject({ outcome: 'permission_denied', code: 'artifact_recipient_scope' });
  });
  it.each([{ active: false }, { id: 'other_actor' }, { regions: ['south'] }, { permissions: ['sales.read', 'operations.read'] }])('intersects fresh sender policy %j', async change => {
    expect(authorizeArtifactShare({ ...await shareInput(), sender: { ...sender, ...change } }).outcome).toBe('permission_denied');
  });
  it('cannot retarget recipient identifiers or roles even with valid recipient region permissions', async () => {
    const input = await shareInput();
    expect(authorizeArtifactShare({ ...input, proposal: { ...input.proposal, recipientId: 'not_approved' } })).toMatchObject({ code: 'artifact_share_authority' });
    expect(authorizeArtifactShare({ ...input, recipient: { ...recipient, role: 'hr_admin' } }).outcome).toBe('permission_denied');
    expect(authorizeArtifactShare({ ...input, policy: { ...policy, recipientIds: [] } }).outcome).toBe('permission_denied');
    expect(authorizeArtifactShare({ ...input, policy: { ...policy, senderId: 'other_actor' } }).outcome).toBe('permission_denied');
  });
  it('denies altered exact versions, unknown channels, URLs, partial-scope and effect payloads', async () => {
    const input = await shareInput();
    expect(authorizeArtifactShare({ ...input, proposal: { ...input.proposal, artifact: { ...input.record.ref, version: 2 } } })).toMatchObject({ code: 'artifact_share_reference' });
    for (const proposal of [{ ...input.proposal, channelId: 'email' }, { ...input.proposal, url: 'javascript:alert(1)' },
      { ...input.proposal, branchIds: ['E01'] }, { ...input.proposal, effect: { send: true } }]) {
      expect(authorizeArtifactShare({ ...input, proposal }).outcome).toBe('unsupported_concept');
    }
  });
});
