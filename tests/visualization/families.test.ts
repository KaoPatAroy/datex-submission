import { describe, expect, it } from 'vitest';
import { compileArtifactRenderer, effectiveInteraction, visualExpressionSchema, type VisualExpression, type VisualPrimitive } from '../../lib/visualization';
import { applyChartView, areaGeometry, comboGeometry, heatmapGeometry, pieGeometry, scatterGeometry, treemapGeometry } from '../../lib/visualization/geometry';
import { createArtifactResponse, prepareArtifact, type ArtifactAuthority, type ArtifactVersion } from '../../lib/artifacts';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import type { QueryPlan } from '../../lib/dynamic/plan/schemas';
import { accept, catalog, executive, fakeEvidence, proposal, readAt, span } from '../dynamic/fixtures';

const authority: ArtifactAuthority = { ...executive, catalogDigest: catalog.digest, permissions: [...executive.permissions, 'dashboard.create', 'dashboard.share'] };
const traits = { partToWhole: ['net_sales', 'target', 'gap'] };

async function chartArtifact(query: QueryPlan): Promise<ArtifactVersion> {
  const accepted = accept(query, 'Show sales', authority);
  const result = await executeReadRequest(compileQueryPlan(accepted), async scope => fakeEvidence(scope), authority, readAt);
  if (result.outcome !== 'accepted') throw new Error(`fixture ${result.code}`);
  const bundle = result.bundle, graph = buildClaimGraph(bundle), response = createArtifactResponse(graph);
  const prepared = prepareArtifact({ proposal: { version: 1, artifactTypeId: 'chart', operation: 'create', title: 'Chart', baseRevision: null, queryPlan: bundle.query,
    responsePlan: response.ref, evidence: bundle.ref, claimGraph: { id: `claims:${graph.digest}`, version: 1, digest: graph.digest }, outputFormat: 'preview' },
  artifactId: 'artifact:viz', bundle, graph, response, authority, latest: { kind: 'absent' }, now: '2026-10-02T00:00:00Z' });
  if (prepared.outcome !== 'accepted') throw new Error(`artifact ${prepared.code}`);
  return prepared.preview.artifact;
}
const measureOf = (fieldId: string, aggregation = 'sum') => ({ fieldId, aggregation, interpretation: { value: fieldId, source: 'explicit' as const, sourceText: span('Show sales', 'sales'), confidence: 1 } });
const aggregationOf = (m: string) => m === 'achievement' ? 'weighted_ratio' : m === 'gap' ? 'gap' : 'sum';
const byBranch = (measures: string[]): QueryPlan => ({ ...proposal(), measures: measures.map(m => measureOf(m, aggregationOf(m))) });
function dated(measures: string[], dimensions: string[]): QueryPlan {
  const query = proposal();
  query.measures = measures.map(m => measureOf(m, aggregationOf(m)));
  query.aggregation = 'rows'; query.group.fieldIds = [];
  query.dimensions = dimensions.map(fieldId => ({ fieldId, interpretation: { value: fieldId, source: 'default' as const, sourceText: span('Show sales', 'sales'), confidence: 1 } }));
  query.time = { fieldId: 'date', dates: ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'], timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'sales' };
  return query;
}
const expression = (artifact: ArtifactVersion, primitiveId: VisualPrimitive, over: { x?: string; y?: string[]; group?: string; lines?: string[]; ids?: VisualExpression['interaction']['interactionIds']; fields?: string[]; mode?: 'none' | 'fade' | 'interpolate' | 'reorder' } = {}): VisualExpression => {
  const x = over.x ?? 'branch';
  return { visualization: { version: 1, artifact: artifact.ref, primitiveId, xFieldId: x, yFieldIds: over.y ?? ['net_sales'],
    ...(over.group ? { groupFieldId: over.group } : {}), ...(over.lines ? { lineFieldIds: over.lines } : {}),
    encodings: { x: primitiveId === 'line' || primitiveId === 'area' || (primitiveId === 'combo' && x === 'date') ? 'time' : 'category', y: 'value' }, maxMarks: 500 },
  interaction: { version: 1, interactionIds: over.ids ?? ['inspect_data'], selectionFields: over.fields ?? [] },
  animation: over.mode && over.mode !== 'none' ? { version: 1, modeId: over.mode, durationMs: 300, reducedMotion: 'respect' } : { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' } };
};
const compile = (artifact: ArtifactVersion, visualExpression: VisualExpression, withTraits = true) =>
  compileArtifactRenderer({ artifact, authority, visualExpression, ...(withTraits ? { traits } : {}) });
function accepted(result: ReturnType<typeof compile>) {
  if (result.outcome !== 'accepted' || !result.spec.visualization) throw new Error(`expected chart, got ${'code' in result ? result.code : result.outcome}`);
  return result.spec.visualization;
}

describe('registered chart families: data-shape suitability', () => {
  it('pie, donut and treemap are part-to-whole only: additive, non-negative, several groups, within slice budgets', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales']));
    for (const family of ['pie', 'donut', 'treemap'] as const) {
      const spec = accepted(compile(artifact, expression(artifact, family)));
      expect(spec.primitive).toBe(family);
      expect(spec.points.map(p => p.value).sort()).toEqual([50, 80, 100, 200, 300].filter(v => spec.points.some(p => p.value === v)).sort());
      expect(spec.suitability).toBeTruthy();
    }
    // The measure must be catalog-additive; a ratio or a snapshot measure never becomes a pie.
    expect(compile(artifact, expression(artifact, 'pie'), false)).toMatchObject({ code: 'visual_unsuitable_part_to_whole' });
    const ratio = await chartArtifact(byBranch(['achievement']));
    expect(compile(ratio, expression(ratio, 'donut', { y: ['achievement'] }), true)).toMatchObject({ code: 'visual_unsuitable_part_to_whole' });
    // Two measures cannot share one whole.
    const two = await chartArtifact(byBranch(['net_sales', 'target']));
    expect(compile(two, expression(two, 'pie', { y: ['net_sales', 'target'] }))).toMatchObject({ code: 'visual_unsuitable_part_to_whole' });
    // A negative part (gap below target) breaks the whole.
    const gap = await chartArtifact(byBranch(['gap']));
    expect(compile(gap, expression(gap, 'treemap', { y: ['gap'] }))).toMatchObject({ code: 'visual_unsuitable_part_to_whole' });
  });

  it('line and area need a real date axis with at least two observed dates; area never fills across a missing day', async () => {
    const series = await chartArtifact(dated(['net_sales'], ['branch', 'date']));
    for (const family of ['line', 'area'] as const) {
      const spec = accepted(compile(series, expression(series, family, { x: 'date' })));
      expect(spec.domain).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    }
    const area = accepted(compile(series, expression(series, 'area', { x: 'date' })));
    expect(areaGeometry(area).runs.every(run => run.path.startsWith('M') && run.path.endsWith('Z'))).toBe(true);
    const category = await chartArtifact(byBranch(['net_sales']));
    expect(compile(category, expression(category, 'area', { x: 'branch' }))).toMatchObject({ code: 'visual_unsuitable_time' });
    const single = await chartArtifact({ ...dated(['net_sales'], ['branch', 'date']), time: { fieldId: 'date', dates: ['2026-09-30'], timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'sales' } });
    expect(compile(single, expression(single, 'area', { x: 'date' }))).toMatchObject({ code: 'visual_unsuitable_time' });
  });

  it('scatter needs exactly two measures present for at least three groups; heatmap needs two dimensions and one measure', async () => {
    const pairs = await chartArtifact(byBranch(['net_sales', 'target']));
    const scatter = accepted(compile(pairs, expression(pairs, 'scatter', { y: ['net_sales', 'target'] })));
    expect(scatter.pairs).toHaveLength(scatter.domain.length);
    expect(scatter.pairs!.every(pair => pair.x !== null && pair.y !== null)).toBe(true);
    const geometry = scatterGeometry(scatter);
    expect(geometry.points.every(p => Number.isFinite(p.cx) && Number.isFinite(p.cy))).toBe(true);
    expect(compile(pairs, expression(pairs, 'scatter', { y: ['net_sales'] }))).toMatchObject({ code: 'visual_unsuitable_scatter' });
    const grid = await chartArtifact(dated(['net_sales'], ['branch', 'date']));
    const heat = accepted(compile(grid, expression(grid, 'heatmap', { x: 'date', group: 'branch' })));
    expect(heat.rowDomain!.length).toBeGreaterThan(1);
    expect(Object.keys(heat.rows!)).toHaveLength(heat.points.length);
    const cells = heatmapGeometry(heat);
    expect(cells.cells).toHaveLength(heat.points.length);
    expect(cells.cells.every(cell => cell.t >= 0 && cell.t <= 1)).toBe(true);
    expect(compile(grid, expression(grid, 'heatmap', { x: 'date' }))).toMatchObject({ code: 'visual_unsuitable_heatmap' });
    expect(compile(grid, expression(grid, 'bar', { x: 'date', group: 'branch' }))).toMatchObject({ code: 'visual_encoding' });
  });

  it('combo needs composable units: one axis for equal units, two axes for exactly two units', async () => {
    const same = await chartArtifact(byBranch(['net_sales', 'target']));
    const single = accepted(compile(same, expression(same, 'combo', { y: ['net_sales', 'target'], lines: ['target'] })));
    expect(single.axisUnits).toEqual(['THB']);
    expect(comboGeometry(single).dual).toBe(false);
    const mixed = await chartArtifact(byBranch(['net_sales', 'achievement']));
    const dual = accepted(compile(mixed, expression(mixed, 'combo', { y: ['net_sales', 'achievement'], lines: ['achievement'] })));
    expect(dual.axisUnits).toEqual(['THB', 'percent']);
    expect(comboGeometry(dual).dual).toBe(true);
    expect(compile(mixed, expression(mixed, 'combo', { y: ['net_sales', 'achievement'] }))).toMatchObject({ code: 'visual_unsuitable_combo' });
    expect(compile(same, expression(same, 'combo', { y: ['net_sales', 'target'], lines: ['net_sales', 'target'] }))).toMatchObject({ code: 'visual_unsuitable_combo' });
    // A bar chart still refuses mixed units (no hidden dual axis outside combo).
    expect(compile(mixed, expression(mixed, 'bar', { y: ['net_sales', 'achievement'] }))).toMatchObject({ code: 'visual_mixed_units' });
  });

  it('metric shows bounded single values', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales']));
    expect(accepted(compile(artifact, expression(artifact, 'metric'))).points.length).toBeLessThanOrEqual(8);
  });

  it('rejects unregistered families and extra options at the schema boundary', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales']));
    for (const primitiveId of ['sankey', 'map', 'html', 'svg']) {
      const base = expression(artifact, 'bar');
      expect(visualExpressionSchema.safeParse({ ...base, visualization: { ...base.visualization, primitiveId } }).success).toBe(false);
    }
    const base = expression(artifact, 'bar');
    expect(visualExpressionSchema.safeParse({ ...base, interaction: { ...base.interaction, interactionIds: ['inspect_data', 'run_script'] } }).success).toBe(false);
    expect(visualExpressionSchema.safeParse({ ...base, animation: { ...base.animation, modeId: 'interpolate', durationMs: 401 } }).success).toBe(false);
  });

  it('geometry stays finite and proportional for pie, donut and treemap', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales']));
    const pie = accepted(compile(artifact, expression(artifact, 'pie')));
    const slices = pieGeometry(pie, false);
    expect(slices.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
    expect(slices.slices.every(s => /^[MLAZ0-9 .,-]+$/.test(s.path))).toBe(true);
    expect(pieGeometry(pie, true).slices.every(s => s.path.includes('A'))).toBe(true);
    const tree = treemapGeometry(pie);
    expect(tree.tiles.reduce((sum, t) => sum + t.w * t.h, 0)).toBeCloseTo(tree.width * tree.height, 0);
    expect(tree.tiles.every(t => t.x >= -0.001 && t.y >= -0.001 && t.x + t.w <= tree.width + 0.001 && t.y + t.h <= tree.height + 0.001)).toBe(true);
  });
});

describe('interaction spec compilation (InteractionSpec / AnimationSpec)', () => {
  it('keeps only the interactions the data shape supports and always adds reset for stateful ones', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales']));
    const spec = accepted(compile(artifact, expression(artifact, 'bar', { ids: ['inspect_data', 'select_point', 'legend_toggle', 'zoom_brush', 'drilldown', 'cross_filter', 'tooltip'], fields: ['branch'] })));
    // One series: no legend toggle; categorical axis: no brush. The rest stays, with an automatic reset.
    expect(spec.interaction.interactionIds).toEqual(expect.arrayContaining(['inspect_data', 'select_point', 'drilldown', 'cross_filter', 'tooltip', 'reset']));
    expect(spec.interaction.interactionIds).not.toContain('legend_toggle');
    expect(spec.interaction.interactionIds).not.toContain('zoom_brush');
    const multi = await chartArtifact(byBranch(['net_sales', 'target']));
    const legend = accepted(compile(multi, expression(multi, 'bar', { y: ['net_sales', 'target'], ids: ['inspect_data', 'legend_toggle'] })));
    expect(legend.interaction.interactionIds).toEqual(expect.arrayContaining(['legend_toggle', 'reset']));
    const series = await chartArtifact(dated(['net_sales'], ['branch', 'date']));
    expect(accepted(compile(series, expression(series, 'line', { x: 'date', ids: ['inspect_data', 'zoom_brush'] }))).interaction.interactionIds).toContain('zoom_brush');
    // Pure inspect: no reset is invented.
    expect(accepted(compile(artifact, expression(artifact, 'bar'))).interaction.interactionIds).toEqual(['inspect_data']);
    expect(effectiveInteraction({ version: 1, interactionIds: ['inspect_data', 'drilldown', 'select_point'], selectionFields: [] }, { primitive: 'bar', series: 1, ordered: false, categories: 3 }).interactionIds).not.toContain('drilldown');
  });

  it('a chart view hides series and ranges without rewriting any claim, and reorder sorts by plotted total', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales', 'target']));
    const spec = accepted(compile(artifact, expression(artifact, 'bar', { y: ['net_sales', 'target'], mode: 'reorder' })));
    expect(spec.animation).toMatchObject({ modeId: 'reorder', reducedMotion: 'respect' });
    const hidden = applyChartView(spec, { hidden: new Set([spec.points[0].series]) });
    expect(hidden.points.length).toBeLessThan(spec.points.length);
    expect(hidden.points.every(p => spec.points.some(q => q.claimId === p.claimId && q.value === p.value))).toBe(true);
    const sorted = applyChartView(spec, { sorted: true });
    const total = (category: string) => sorted.points.filter(p => p.category === category).reduce((s, p) => s + (p.value ?? 0), 0);
    expect(sorted.domain.map(total)).toEqual([...sorted.domain.map(total)].sort((a, b) => b - a));
    expect(applyChartView(spec, { range: [0, 0] }).domain).toHaveLength(1);
  });

  it('preview equals the persisted version: compiling the same expression twice gives an identical frozen spec', async () => {
    const artifact = await chartArtifact(byBranch(['net_sales', 'target']));
    const input = expression(artifact, 'combo', { y: ['net_sales', 'target'], lines: ['target'], ids: ['inspect_data', 'tooltip', 'select_point', 'cross_filter', 'drilldown'], fields: ['branch'], mode: 'interpolate' });
    const first = compile(artifact, input), second = compile(artifact, structuredClone(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    if (first.outcome === 'accepted') expect(Object.isFrozen(first.spec)).toBe(true);
  });
});
