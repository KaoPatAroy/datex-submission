import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ARTIFACT_REGISTRY, ARTIFACT_LIMITS, artifactPlanSchema, prepareArtifact, createArtifactResponse } from '../../lib/artifacts';
import { artifactDigest, validArtifactRecord } from '../../lib/artifacts/prepare';
import { digest } from '../../lib/dynamic/shared';
import { actor, artifactFixture, evidenceFixture } from './fixtures';

describe('strict artifact registry and grounded bindings', () => {
  it.each(['table', 'ranking', 'chart', 'executive_brief', 'csv_export'] as const)('prepares %s from the exact verified evidence and claims', async kind => {
    const { artifact, input } = await artifactFixture(kind);
    expect(artifact.plan.artifactTypeId).toBe(kind);
    expect(artifact.bundle).toEqual(input.bundle); expect(artifact.graph).toEqual(input.graph);
    expect(artifact.response.plan.citations).toEqual(input.graph.claims.map(c => ({ claimId: c.id, sourceRefs: [...c.sourceRefs] })));
    expect(validArtifactRecord(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.bundle.rows[0].values)).toBe(true);
    expect(Object.isFrozen(ARTIFACT_REGISTRY.chart)).toBe(true);
  });
  it.each(['html', 'sql', 'script', 'iframe', 'unknown'])('rejects unregistered artifact kind %s without executable output', async artifactTypeId => {
    const input = await evidenceFixture();
    const result = prepareArtifact({ ...input, proposal: { ...input.proposal, artifactTypeId } });
    expect(result).toMatchObject({ outcome: 'unsupported_concept' }); expect('preview' in result).toBe(false);
  });
  it.each(['sql', 'js', 'html', 'eval', 'url', 'recipientId'])('rejects injected plan key %s', async key => {
    const input = await evidenceFixture();
    expect(prepareArtifact({ ...input, proposal: { ...input.proposal, [key]: 'attack' } }).outcome).toBe('semantic_uncertainty');
  });
  it('rejects unknown nested keys, invalid formats, versions, title bounds, and unresolved bases', async () => {
    const input = await evidenceFixture();
    for (const proposal of [ { ...input.proposal, evidence: { ...input.bundle.ref, sql: 'SELECT *' } },
      { ...input.proposal, version: 2 }, { ...input.proposal, title: '' }, { ...input.proposal, title: 'x'.repeat(141) },
      { ...input.proposal, outputFormat: 'pdf' }, { ...input.proposal, baseRevision: undefined } ]) {
      expect(artifactPlanSchema.safeParse(proposal).success).toBe(false);
      expect(prepareArtifact({ ...input, proposal }).outcome).not.toBe('accepted');
    }
    expect(prepareArtifact({ ...input, proposal: { ...input.proposal, outputFormat: 'csv' } })).toMatchObject({ code: 'artifact_format' });
  });
  it('pins the schema shape and canonical round trip', async () => {
    const input = await evidenceFixture();
    expect(artifactPlanSchema.parse(JSON.parse(JSON.stringify(input.proposal)))).toEqual(input.proposal);
    expect(digest(z.toJSONSchema(artifactPlanSchema))).toBe('15e8b68f9820d264018852d3316721533a9c02e5f9d6f84eb444f9d984722fe4');
  });
  it('exact evidence reference guard rejects a tampered digest', async () => {
    const input = await evidenceFixture();
    const result = prepareArtifact({ ...input, proposal: { ...input.proposal, evidence: { ...input.bundle.ref, digest: '0'.repeat(64) } } });
    expect(result.outcome).toBe('semantic_uncertainty');
    if (result.outcome !== 'accepted') expect(result.code).toBe('artifact_reference_mismatch');
    expect('preview' in result).toBe(false);
  });
  it.each(['queryPlan', 'responsePlan', 'claimGraph', 'evidence'] as const)('requires exact %s identity and version as well as digest', async key => {
    const input = await evidenceFixture();
    for (const change of [{ id: 'wrong' }, { version: 2 }]) expect(prepareArtifact({ ...input,
      proposal: { ...input.proposal, [key]: { ...input.proposal[key], ...change } } })).toMatchObject({ code: 'artifact_reference_mismatch' });
  });
  it('rejects structurally cloned runtime provenance and response tokens', async () => {
    const input = await evidenceFixture();
    for (const change of [{ bundle: structuredClone(input.bundle) }, { graph: structuredClone(input.graph) }, { response: structuredClone(input.response) }]) {
      expect(prepareArtifact({ ...input, ...change })).toMatchObject({ code: 'artifact_provenance' });
    }
    expect(createArtifactResponse(input.graph).ref).toEqual(input.response.ref);
  });
  it.each([{ active: false }, { permissions: ['sales.read', 'operations.read'] }, { regions: ['south'] }, { revision: 2 }, { catalogDigest: '0'.repeat(64) }])('intersects permissions and scope for %j', async change => {
    const input = await evidenceFixture();
    const result = prepareArtifact({ ...input, authority: { ...actor, ...change } });
    expect(result.outcome).toBe('permission_denied'); expect('preview' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('E01');
  });
  it('requires verified completeness and a preexisting registered ranking', async () => {
    const input = await evidenceFixture();
    expect(prepareArtifact({ ...input, proposal: { ...input.proposal, artifactTypeId: 'ranking' } })).toMatchObject({ code: 'ranking_unavailable' });
    expect(prepareArtifact({ ...input, graph: { ...input.graph, claims: [] } }).outcome).not.toBe('accepted');
  });
  it('enforces rows, claims and sources budgets without serializing oversized evidence', async () => {
    const input = await evidenceFixture();
    expect(prepareArtifact({ ...input, bundle: { ...input.bundle, rows: Array(ARTIFACT_LIMITS.rows + 1).fill(input.bundle.rows[0]) } })).toMatchObject({ code: 'artifact_budget' });
    expect(prepareArtifact({ ...input, graph: { ...input.graph, claims: Array(ARTIFACT_LIMITS.claims + 1).fill(input.graph.claims[0]) } })).toMatchObject({ code: 'artifact_budget' });
    expect(prepareArtifact({ ...input, bundle: { ...input.bundle, sources: Array(ARTIFACT_LIMITS.sources + 1).fill(input.bundle.sources[0]) } })).toMatchObject({ code: 'artifact_budget' });
  });
  it('revises immutably with an exact base and preserves source scope/data', async () => {
    const { artifact: base, input } = await artifactFixture();
    const prior = JSON.stringify(base);
    const result = prepareArtifact({ ...input, proposal: { ...input.proposal, operation: 'revise', artifactTypeId: 'chart', baseRevision: base.ref }, latest: { kind: 'version', artifact: base } });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.preview.artifact.revision).toBe(2); expect(result.preview.artifact.ref.digest).not.toBe(base.ref.digest);
      expect(result.preview.artifact.bundle).toEqual(base.bundle); expect(result.preview.artifact.graph).toEqual(base.graph);
    }
    expect(JSON.stringify(base)).toBe(prior);
    expect(() => { base.graph.claims[0].value = 999; }).toThrow();
  });
  it('denies missing lookup, mismatched base, scope replacement, wrong owner and exhausted versions', async () => {
    const { artifact: base, input } = await artifactFixture();
    expect(prepareArtifact({ ...input, latest: undefined! })).toMatchObject({ code: 'artifact_latest_unknown' });
    expect(prepareArtifact({ ...input, latest: { kind: 'version', artifact: base } })).toMatchObject({ code: 'artifact_base_mismatch' });
    const revise = { ...input.proposal, operation: 'revise', baseRevision: { ...base.ref, digest: '0'.repeat(64) } };
    expect(prepareArtifact({ ...input, proposal: revise, latest: { kind: 'version', artifact: base } })).toMatchObject({ code: 'artifact_base_mismatch' });
    const changed = structuredClone(base); changed.ownerId = 'someone_else';
    const body = { ...changed }; Reflect.deleteProperty(body, 'ref'); changed.ref.digest = artifactDigest(body);
    expect(prepareArtifact({ ...input, proposal: revise, latest: { kind: 'version', artifact: changed } })).toMatchObject({ code: 'artifact_base_access' });
    const last = structuredClone(base); last.revision = ARTIFACT_LIMITS.versions; last.ref.version = last.revision;
    const lastBody = { ...last }; Reflect.deleteProperty(lastBody, 'ref'); last.ref.digest = artifactDigest(lastBody);
    expect(prepareArtifact({ ...input, proposal: { ...input.proposal, operation: 'revise', baseRevision: last.ref }, latest: { kind: 'version', artifact: last } })).toMatchObject({ code: 'artifact_version_budget' });
  });
});
