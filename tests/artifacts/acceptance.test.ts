import { describe, expect, it } from 'vitest';
import fixtures from './acceptance.fixtures.json';
import { loadArtifact, prepareArtifact } from '../../lib/artifacts';
import { compileArtifactRenderer } from '../../lib/visualization';
import { artifactFixture, actor, visual } from './fixtures';

describe('Wave 3 business-user acceptance fixtures', () => {
  // These are fixed AI outputs. Production neither recognizes these phrases nor reparses the prompt.
  it.each(fixtures)('$prompt preserves exact refs, scope, dates, values and sources through chart and reload', async fixture => {
    const { artifact: original, input } = await artifactFixture('table');
    const table = compileArtifactRenderer({ artifact: original, authority: actor, visualExpression: null });
    const prepared = prepareArtifact({ ...input, proposal: { ...input.proposal, operation: 'revise', artifactTypeId: 'chart', baseRevision: original.ref },
      latest: { kind: 'version', artifact: original } });
    if (table.outcome !== 'accepted' || prepared.outcome !== 'accepted') throw new Error('Expected baseline and chart');
    const chart = prepared.preview.artifact, expression = visual(chart);
    const rendered = compileArtifactRenderer({ artifact: chart, authority: actor, visualExpression: expression });
    if (rendered.outcome !== 'accepted') throw new Error('Expected renderer');
    expect(rendered.spec.scope.regions).toEqual(fixture.regions); expect(rendered.spec.scope.branchIds).toEqual(fixture.branches);
    expect(rendered.spec.facts.map(f => f.value)).toEqual(fixture.values);
    for (const key of ['query', 'evidence', 'claimGraphDigest', 'facts', 'scope', 'sources', 'coverage', 'grain', 'limitations', 'interpretationLabels'] as const) {
      expect(rendered.spec[key]).toEqual(table.spec[key]);
    }
    expect(rendered.spec.visualization?.primitive).toBe(fixture.primitive);
    // A server-store JSON round trip must retain the historical, exact snapshot.
    const loaded = loadArtifact({ record: JSON.parse(JSON.stringify(chart)), expectedRef: chart.ref, authority: actor });
    if (loaded.outcome !== 'accepted') throw new Error('Expected reloaded version');
    expect(compileArtifactRenderer({ artifact: loaded.artifact, authority: actor, visualExpression: expression })).toEqual(rendered);
    expect(original.revision).toBe(1); expect(chart.revision).toBe(2);
  });
  it('East manager cannot replace the chart scope or recipients through artifact plan fields', async () => {
    const input = (await artifactFixture()).input;
    for (const extra of [{ regions: ['south'] }, { recipientIds: ['south_team'] }, { filter: 'all' }, { values: [99999] }]) {
      const result = prepareArtifact({ ...input, proposal: { ...input.proposal, artifactTypeId: 'chart', ...extra } });
      expect(result.outcome).not.toBe('accepted'); expect('preview' in result).toBe(false);
    }
  });
  it('a renderer cannot mint grounded output from a JSON-cloned artifact supplied by an AI/client', async () => {
    const { artifact } = await artifactFixture();
    expect(compileArtifactRenderer({ artifact: structuredClone(artifact), authority: actor, visualExpression: null })).toMatchObject({ code: 'renderer_artifact' });
  });
});
