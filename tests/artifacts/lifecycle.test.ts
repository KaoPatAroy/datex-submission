import { describe, expect, it } from 'vitest';
import { digest } from '../../lib/dynamic/shared';
import { prepareArtifactWrite, verifyArtifactWrite, loadArtifact, prepareArtifact, type ArtifactStore, type ArtifactVersion } from '../../lib/artifacts';
import { actor, artifactFixture, now } from './fixtures';

describe('preview -> confirm -> transactional append -> independent verify', () => {
  it('returns an append command only after exact confirmation and verifies an independent store read', async () => {
    const { artifact, preview } = await artifactFixture();
    const result = prepareArtifactWrite({ preview, confirmedPreview: preview.ref, latestRef: null, authority: actor, now });
    expect(result.outcome).toBe('accepted');
    const versions = new Map<string, ArtifactVersion>();
    const store: ArtifactStore = {
      latest: async id => versions.get(id) ?? null,
      read: async ref => { const record = versions.get(ref.id); return record ? structuredClone(record) : null; },
      append: async (record, base) => {
        const current = versions.get(record.artifactId);
        if (current?.ref.digest !== base?.digest) return 'conflict';
        versions.set(record.artifactId, structuredClone(record)); return 'written';
      },
    };
    if (result.outcome !== 'accepted') throw new Error('Expected write');
    expect(await store.append(result.write.record, result.write.expectedLatest)).toBe('written');
    expect(verifyArtifactWrite({ write: result.write, readback: await store.read(artifact.ref), authority: actor })).toEqual({ outcome: 'accepted', status: 'verified', ref: artifact.ref });
    expect(await store.append(result.write.record, result.write.expectedLatest)).toBe('conflict');
    const loaded = loadArtifact({ record: await store.read(artifact.ref), expectedRef: artifact.ref, authority: actor });
    expect(loaded.outcome).toBe('accepted');
    if (loaded.outcome === 'accepted') { expect(loaded.artifact).toEqual(artifact); expect(Object.isFrozen(loaded.artifact.graph.claims[0])).toBe(true); }
  });
  it('rejects a cloned preview, unconfirmed preview, stale base, and expiry at the deadline', async () => {
    const { preview, artifact } = await artifactFixture();
    const input = { preview, confirmedPreview: preview.ref, latestRef: null, authority: actor, now };
    expect(prepareArtifactWrite({ ...input, preview: structuredClone(preview) })).toMatchObject({ code: 'artifact_confirmation' });
    expect(prepareArtifactWrite({ ...input, confirmedPreview: { ...preview.ref, version: 2 } })).toMatchObject({ code: 'artifact_confirmation' });
    expect(prepareArtifactWrite({ ...input, latestRef: artifact.ref })).toMatchObject({ code: 'artifact_conflict' });
    expect(prepareArtifactWrite({ ...input, now: preview.expiresAt })).toMatchObject({ code: 'artifact_preview_expired' });
    expect(prepareArtifactWrite({ ...input, now: 'invalid' })).toMatchObject({ code: 'artifact_preview_expired' });
    expect(prepareArtifactWrite({ ...input, now: '2026-10-01T23:59:59Z' })).toMatchObject({ code: 'artifact_preview_expired' });
  });
  it.each([{ active: false }, { revision: 2 }, { regions: ['south'] }, { id: 'another_actor' }, { permissions: ['sales.read', 'operations.read'] }, { catalogDigest: '0'.repeat(64) }])('blocks a permission race before persistence %j', async change => {
    const { preview } = await artifactFixture();
    const result = prepareArtifactWrite({ preview, confirmedPreview: preview.ref, latestRef: null, authority: { ...actor, ...change }, now });
    expect(result.outcome).toBe('permission_denied'); expect('write' in result).toBe(false);
  });
  it('two simultaneous initial previews cannot both append to the same CAS slot', async () => {
    const { preview, input } = await artifactFixture();
    const second = prepareArtifact({ ...input, proposal: { ...input.proposal, title: 'Different preview' } });
    if (second.outcome !== 'accepted') throw new Error('Expected preview');
    const firstWrite = prepareArtifactWrite({ preview, confirmedPreview: preview.ref, latestRef: null, authority: actor, now });
    expect(firstWrite.outcome).toBe('accepted');
    const secondWrite = prepareArtifactWrite({ preview: second.preview, confirmedPreview: second.preview.ref, latestRef: preview.artifact.ref, authority: actor, now });
    expect(secondWrite).toMatchObject({ code: 'artifact_conflict' });
  });
  it('revision append uses the exact base expectation and verifies old versions independently', async () => {
    const { artifact: base, input } = await artifactFixture();
    const changed = prepareArtifact({ ...input, proposal: { ...input.proposal, operation: 'revise', baseRevision: base.ref, title: 'Revised preview' }, latest: { kind: 'version', artifact: base } });
    if (changed.outcome !== 'accepted') throw new Error('Expected revision');
    expect(prepareArtifactWrite({ preview: changed.preview, confirmedPreview: changed.preview.ref, latestRef: null, authority: actor, now })).toMatchObject({ code: 'artifact_conflict' });
    const write = prepareArtifactWrite({ preview: changed.preview, confirmedPreview: changed.preview.ref, latestRef: base.ref, authority: actor, now });
    expect(write.outcome).toBe('accepted');
    if (write.outcome === 'accepted') expect(write.write.expectedLatest).toEqual(base.ref);
    expect(loadArtifact({ record: JSON.parse(JSON.stringify(base)), expectedRef: base.ref, authority: actor }).outcome).toBe('accepted');
  });
  it('never treats acknowledgement, missing readback, modified numbers or forged write tokens as verified', async () => {
    const { preview, artifact } = await artifactFixture();
    const result = prepareArtifactWrite({ preview, confirmedPreview: preview.ref, latestRef: null, authority: actor, now });
    if (result.outcome !== 'accepted') throw new Error('Expected write');
    const tampered = structuredClone(artifact); tampered.graph.claims[0].value = 99999;
    for (const readback of [null, { status: 'written' }, tampered, { ...artifact, extra: 'untrusted' }]) {
      expect(verifyArtifactWrite({ write: result.write, readback, authority: actor })).toMatchObject({ code: 'artifact_readback_mismatch' });
    }
    expect(verifyArtifactWrite({ write: structuredClone(result.write), readback: artifact, authority: actor })).toMatchObject({ code: 'artifact_readback_mismatch' });
    expect(verifyArtifactWrite({ write: result.write, readback: artifact, authority: { ...actor, active: false } }).outcome).toBe('permission_denied');
  });
  it('reload fails closed on reference mismatch, record corruption and revoked/other-owner authorization', async () => {
    const { artifact } = await artifactFixture();
    expect(loadArtifact({ record: artifact, expectedRef: { ...artifact.ref, digest: '0'.repeat(64) }, authority: actor })).toMatchObject({ code: 'artifact_record_mismatch' });
    for (const authority of [{ ...actor, regions: ['south'] }, { ...actor, id: 'other_owner' }, { ...actor, permissions: [] }]) {
      const denied = loadArtifact({ record: artifact, expectedRef: artifact.ref, authority });
      expect(denied.outcome).toBe('permission_denied'); expect('artifact' in denied).toBe(false);
    }
  });
  it('rejects a self-consistent forged record when its ref differs from protected expectedRef', async () => {
    const { artifact } = await artifactFixture();
    const forged = structuredClone(artifact);
    forged.artifactId = 'forged_artifact';
    const body = structuredClone(forged);
    Reflect.deleteProperty(body, 'ref');
    forged.ref = { id: forged.artifactId, version: forged.revision, digest: digest(body) };
    expect(loadArtifact({ record: forged, expectedRef: artifact.ref, authority: actor }))
      .toMatchObject({ outcome: 'semantic_uncertainty', code: 'artifact_record_mismatch' });
  });
});
