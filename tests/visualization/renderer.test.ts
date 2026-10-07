import { describe, expect, it } from 'vitest';
import { prepareArtifact } from '../../lib/artifacts';
import { compileArtifactRenderer, visualExpressionSchema } from '../../lib/visualization';
import { chartGeometry, csvCell, factsToCSV } from '../../lib/visualization/presentation';
import type { SafeVisualizationSpec } from '../../lib/visualization';
import { actor, artifactFixture, datedFixture, visual } from '../artifacts/fixtures';
import { fakeEvidence } from '../dynamic/fixtures';

describe('safe registered visual compilation', () => {
  it('compiles a bar chart with every original fact, scope, source and limitation retained', async () => {
    const { artifact } = await artifactFixture('chart');
    const result = compileArtifactRenderer({ artifact, authority: actor, visualExpression: visual(artifact) });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.spec.facts.map(f => [f.claimId, f.value, f.unit, f.dimensions, f.rowRefs, f.sourceRefs])).toEqual(
        artifact.graph.claims.map(c => [c.id, c.value, c.unit, c.dimensions, c.rowRefs, c.sourceRefs]));
      expect(result.spec.scope).toMatchObject(artifact.bundle.scope); expect(result.spec.evidence).toEqual(artifact.bundle.ref);
      expect(result.spec.visualization?.points.map(p => p.value)).toEqual([200, 80]);
      expect(Object.isFrozen(result.spec.facts[0].dimensions)).toBe(true);
    }
  });
  it('compiles a line only for the evidence date grain and time encoding', async () => {
    const input = await datedFixture();
    const prepared = prepareArtifact({ ...input, proposal: { ...input.proposal, artifactTypeId: 'chart' } });
    if (prepared.outcome !== 'accepted') throw new Error('Expected artifact');
    const expression = visual(prepared.preview.artifact, 'line');
    const result = compileArtifactRenderer({ artifact: prepared.preview.artifact, authority: actor, visualExpression: expression });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') expect(result.spec.visualization?.domain).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });
  it('a compiled filtered-date query keeps the original date domain and never connects the omitted day', async () => {
    const input = await datedFixture(async scope => {
      const evidence = fakeEvidence(scope);
      if (scope.date === '2026-09-29') evidence.branches.forEach(branch => { branch.netSales = 0; });
      return evidence;
    });
    const prepared = prepareArtifact({ ...input, proposal: { ...input.proposal, artifactTypeId: 'chart' } });
    if (prepared.outcome !== 'accepted') throw new Error('Expected artifact');
    const result = compileArtifactRenderer({ artifact: prepared.preview.artifact, authority: actor, visualExpression: visual(prepared.preview.artifact, 'line') });
    if (result.outcome !== 'accepted' || !result.spec.visualization) throw new Error('Expected line');
    expect(result.spec.visualization.points.map(p => p.category)).toEqual(['2026-09-28', '2026-09-30']);
    expect(result.spec.visualization.domain).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(result.spec.coverage).toMatchObject({ complete: true, expected: 6, read: 6 });
    expect(chartGeometry(result.spec.visualization).segments).toEqual([]);
  });
  it.each(['sankey', 'map', 'html', 'svg', 'javascript', 'remote_renderer'])('rejects primitive %s', async primitiveId => {
    const { artifact } = await artifactFixture('chart'), expression = visual(artifact);
    expect(compileArtifactRenderer({ artifact, authority: actor, visualExpression: { ...expression, visualization: { ...expression.visualization, primitiveId } } })).toMatchObject({ code: 'invalid_visual_expression' });
  });
  it.each(['html', 'script', 'style', 'sql', 'formatter', 'url'])('rejects arbitrary renderer option %s at every object boundary', async key => {
    const { artifact } = await artifactFixture('chart'), expression = visual(artifact);
    for (const changed of [{ ...expression, [key]: 'attack' }, { ...expression, visualization: { ...expression.visualization, [key]: 'attack' } },
      { ...expression, interaction: { ...expression.interaction, [key]: 'attack' } }, { ...expression, animation: { ...expression.animation, [key]: 'attack' } },
      { ...expression, visualization: { ...expression.visualization, encodings: { ...expression.visualization.encodings, [key]: 'attack' } } }]) {
      expect(visualExpressionSchema.safeParse(changed).success).toBe(false);
    }
  });
  it('rejects unregistered interaction/animation modes and requires accessible inspection and reduced motion', async () => {
    const { artifact } = await artifactFixture('chart'), expression = visual(artifact);
    for (const changed of [{ ...expression, interaction: { ...expression.interaction, interactionIds: ['execute_js'] } },
      { ...expression, interaction: { ...expression.interaction, interactionIds: ['select_point'] } },
      { ...expression, animation: { ...expression.animation, modeId: 'flash' } },
      { ...expression, animation: { ...expression.animation, reducedMotion: 'ignore' } },
      { ...expression, animation: { ...expression.animation, durationMs: 201 } },
      { ...expression, animation: { ...expression.animation, durationMs: 1 } }]) {
      expect(compileArtifactRenderer({ artifact, authority: actor, visualExpression: changed }).outcome).not.toBe('accepted');
    }
    expect(compileArtifactRenderer({ artifact, authority: actor, visualExpression: { ...expression, animation: { ...expression.animation, modeId: 'fade', durationMs: 200 } } }).outcome).toBe('accepted');
  });
  it('rejects missing fields, duplicate series, mismatched artifact and mark budget overflow', async () => {
    const { artifact } = await artifactFixture('chart'), expression = visual(artifact);
    for (const change of [{ xFieldId: 'coastal' }, { yFieldIds: ['salary'] }, { yFieldIds: ['net_sales', 'net_sales'] },
      { artifact: { ...artifact.ref, digest: '0'.repeat(64) } }, { maxMarks: 1 }, { maxMarks: 501 }, { maxMarks: 0 }]) {
      const result = compileArtifactRenderer({ artifact, authority: actor, visualExpression: { ...expression, visualization: { ...expression.visualization, ...change } } });
      expect(result.outcome).not.toBe('accepted'); expect('spec' in result).toBe(false);
    }
    expect(compileArtifactRenderer({ artifact, authority: actor, visualExpression: { ...expression, interaction: { ...expression.interaction, selectionFields: ['salary'] } } })).toMatchObject({ code: 'visual_dimension' });
  });
  it('never treats category order as a time-series and rejects unexpected visual expressions', async () => {
    const { artifact } = await artifactFixture('chart'), expression = visual(artifact);
    expect(compileArtifactRenderer({ artifact, authority: actor, visualExpression: { ...expression, visualization: { ...expression.visualization, primitiveId: 'line' } } })).toMatchObject({ code: 'visual_unsuitable_time' });
    const table = await artifactFixture('table');
    expect(compileArtifactRenderer({ artifact: table.artifact, authority: actor, visualExpression: visual(table.artifact) })).toMatchObject({ code: 'unexpected_visual_expression' });
  });
  it.each(['table', 'ranking', 'executive_brief', 'csv_export'] as const)('renders %s with original grounded numbers and ranking semantics', async kind => {
    const { artifact } = await artifactFixture(kind);
    const result = compileArtifactRenderer({ artifact, authority: actor, visualExpression: null });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.spec.facts.map(f => f.value)).toEqual(artifact.graph.claims.map(c => c.value));
      expect(result.spec.visualization).toBeNull();
      expect(result.spec.csv !== null).toBe(kind === 'csv_export');
      expect(result.spec.ranking !== null).toBe(kind === 'ranking');
    }
  });
  it('reauthorizes before releasing protected renderer data', async () => {
    const { artifact } = await artifactFixture();
    for (const authority of [{ ...actor, active: false }, { ...actor, regions: ['south'] }, { ...actor, permissions: [] }, { ...actor, catalogDigest: '0'.repeat(64) }]) {
      const result = compileArtifactRenderer({ artifact, authority, visualExpression: null });
      expect(result.outcome).toBe('permission_denied'); expect(JSON.stringify(result)).not.toContain('E01');
    }
  });
  it('does not render an owner artifact to another actor without a Wave4 recipient grant', async () => {
    const { artifact } = await artifactFixture();
    const result = compileArtifactRenderer({ artifact, authority: { ...actor, id: 'another_east_manager' }, visualExpression: null });
    expect(result).toMatchObject({ outcome: 'permission_denied', code: 'renderer_authority' });
    expect('spec' in result).toBe(false);
  });
});

describe('component-free CSV and geometry adapters', () => {
  const lineSpec = (dates: string[], values: (number | null)[], domain: string[] = dates): SafeVisualizationSpec => ({
    version: 1, primitive: 'line', xField: 'date', yFields: ['net_sales'], domain,
    points: dates.map((date, i) => ({ claimId: `claim:${i}`, category: date, series: 'sales', seriesLabel: 'Sales', value: values[i], unit: 'THB' })),
    interaction: { version: 1, interactionIds: ['inspect_data'], selectionFields: [] },
    animation: { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' },
  });
  it('spaces date coordinates by elapsed time rather than the index of plotted dates', () => {
    const geometry = chartGeometry(lineSpec(['2026-10-01', '2026-10-02', '2026-10-04'], [200, 80, 100]));
    const [first, second, fourth] = geometry.bars;
    expect((second.centerX - first.centerX) / (fourth.centerX - first.centerX)).toBeCloseTo(1 / 3);
    expect(geometry.segments.map(s => [s.from.category, s.to.category])).toEqual([['2026-10-01', '2026-10-02']]);
  });
  it('retains full date domain and breaks trends across filtered and unavailable dates', () => {
    const domain = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
    const filtered = chartGeometry(lineSpec(['2026-10-01', '2026-10-04'], [200, 80], domain));
    expect(filtered.ticks.map(t => t.category)).toEqual(domain); expect(filtered.segments).toEqual([]);
    const unavailable = chartGeometry(lineSpec(domain, [200, null, 80, 100]));
    expect(unavailable.segments.map(s => [s.from.category, s.to.category])).toEqual([['2026-10-03', '2026-10-04']]);
  });
  it('keeps readable wide chart dimensions and aligned multi-series time positions', () => {
    const base = lineSpec(['2026-10-01', '2026-10-02'], [200, 80]);
    const multiple = { ...base, points: [...base.points, ...base.points.map(point => ({ ...point, claimId: `${point.claimId}:target`, series: 'targets', seriesLabel: 'Target' }))] };
    const geometry = chartGeometry(multiple);
    expect(geometry.bars[0].centerX).toBe(geometry.bars[2].centerX);
    const wide = { ...base, primitive: 'bar' as const, domain: Array.from({ length: 500 }, (_, i) => `Branch ${i}`) };
    expect(chartGeometry(wide).width).toBeGreaterThanOrEqual(500 * 44);
  });
  it.each(['=SUM(A1:A9)', '+cmd', '-cmd', '@import', ' \t=HYPERLINK("evil")', '\t1+1', '\rformula', '\nformula'])('neutralizes formula-like string %j', value => {
    expect(csvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
  });
  it('escapes quotes/commas/newlines, preserves numeric negatives and exports every claim with its sources', async () => {
    expect(csvCell(-5)).toBe('"-5"'); expect(csvCell('safe,"text"\n')).toBe('"safe,""text""\n"');
    const { artifact } = await artifactFixture();
    const result = compileArtifactRenderer({ artifact, authority: actor, visualExpression: null });
    if (result.outcome !== 'accepted') throw new Error('Expected spec');
    const csv = factsToCSV(result.spec.facts);
    expect(csv.split('\r\n')).toHaveLength(result.spec.facts.length + 1);
    for (const fact of result.spec.facts) { expect(csv).toContain(fact.claimId); expect(csv).toContain(fact.sourceRefs.join(';')); }
  });
  it('keeps finite geometry with zeros, negatives, unavailable values and extreme ranges', async () => {
    const { artifact } = await artifactFixture('chart');
    const result = compileArtifactRenderer({ artifact, authority: actor, visualExpression: visual(artifact) });
    if (result.outcome !== 'accepted' || !result.spec.visualization) throw new Error('Expected chart');
    for (const values of [[0, 0], [-20, 5], [null, null], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
      const spec = { ...result.spec.visualization, points: result.spec.visualization.points.map((p, i) => ({ ...p, value: values[i] })) };
      const geometry = chartGeometry(spec);
      expect(Number.isFinite(geometry.baseline)).toBe(true);
      expect(geometry.bars.every(b => Number.isFinite(b.x) && Number.isFinite(b.width) && (b.y === null || Number.isFinite(b.y)))).toBe(true);
      expect(geometry.bars.map(b => b.value)).toEqual(values);
    }
  });
});
