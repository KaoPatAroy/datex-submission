import type { ArtifactAuthority, ArtifactVersion } from '../artifacts/contracts';
import { canReadArtifact, isTrustedArtifact, sameRef } from '../artifacts/prepare';
import { isShareGrant, type ArtifactShareGrant } from '../artifacts/grant';
import { rejected, type RejectedPlan } from '../dynamic/validate/query-plan';
import { freeze, unique } from '../dynamic/shared';
import {
  visualExpressionSchema, VISUAL_LIMITS, STATEFUL_INTERACTIONS,
  type ArtifactFact, type ArtifactLabels, type ArtifactRendererSpec, type InteractionId, type InteractionSpec, type SafeScatterPoint,
  type SafeVisualPoint, type SafeVisualizationSpec,
} from './contracts';
import { droppedInteractionsNote, factsToCSV } from './presentation';

/** Data-shape facts the catalog owns and the compiler cannot derive from the artifact alone. */
export interface VisualTraits {
  /** Measures whose values may be summed into a whole (additive and not a ratio). Part-to-whole families need them. */
  partToWhole?: readonly string[];
}

const TIME_FAMILIES = new Set(['line', 'area']);
const PART_TO_WHOLE = new Set(['pie', 'donut', 'treemap']);
const MIN_SLICES = 2;

function seriesKeyOf(fact: ArtifactFact, skip: readonly string[]): string {
  return JSON.stringify([fact.measure, Object.entries(fact.dimensions).filter(([id]) => !skip.includes(id)).sort(([a], [b]) => a.localeCompare(b))]);
}

/**
 * Keeps only the interactions this exact data shape supports (a legend toggle needs several series, a brush needs an ordered
 * axis, a drilldown needs a selection field). The effective set is part of the compiled spec, so a reload compiles identically.
 */
export function effectiveInteraction(interaction: InteractionSpec, shape: { primitive: string; series: number; ordered: boolean; categories: number }): InteractionSpec {
  const keep = (id: InteractionId): boolean => {
    switch (id) {
      case 'legend_toggle': return shape.series >= 2 && !PART_TO_WHOLE.has(shape.primitive) && shape.primitive !== 'metric';
      case 'zoom_brush': return shape.ordered && shape.categories >= 4 && ['bar', 'line', 'area', 'combo'].includes(shape.primitive);
      case 'drilldown': case 'cross_filter': return interaction.selectionFields.length > 0;
      case 'tooltip': return shape.primitive !== 'metric';
      default: return true;
    }
  };
  let ids = interaction.interactionIds.filter(keep);
  if (!ids.some(id => STATEFUL_INTERACTIONS.includes(id))) ids = ids.filter(id => id !== 'reset');
  else if (!ids.includes('reset')) ids = [...ids, 'reset'];
  if (!ids.includes('select_point')) ids = ids.filter(id => id !== 'cross_filter' && id !== 'drilldown');
  return { ...interaction, interactionIds: ids };
}

/** Registered renderer integration entry. No model markup/options, reader, effect or generated code. */
export function compileArtifactRenderer(input: {
  artifact: unknown; authority: ArtifactAuthority; visualExpression: unknown | null; labels?: ArtifactLabels; traits?: VisualTraits;
  /** Server-created grant for a recipient the owner shared this exact version with (never client supplied). */
  grant?: ArtifactShareGrant;
  /** Versions stored before chart expressions were persisted have none: they render as their exact table (no chart), never a guessed chart. */
  legacyChartWithoutVisual?: boolean;
}): { outcome: 'accepted'; spec: ArtifactRendererSpec } | RejectedPlan {
  if (!isTrustedArtifact(input.artifact)) return rejected('semantic_uncertainty', 'renderer_artifact');
  const artifact = input.artifact;
  const recipientView = input.grant !== undefined;
  if (recipientView) {
    if (!isShareGrant(input.grant) || input.grant.recipientId !== input.authority.id || input.grant.senderId !== artifact.ownerId || !sameRef(input.grant.artifact, artifact.ref)) {
      return rejected('permission_denied', 'renderer_authority');
    }
  } else if (artifact.ownerId !== input.authority.id) return rejected('permission_denied', 'renderer_authority');
  if (!canReadArtifact(artifact, input.authority)) return rejected('permission_denied', 'renderer_authority');
  const facts: ArtifactFact[] = artifact.graph.claims.map(claim => ({ claimId: claim.id, measure: claim.measure, value: claim.value,
    unit: claim.unit, dimensions: { ...claim.dimensions }, rowRefs: [...claim.rowRefs], sourceRefs: [...claim.sourceRefs],
    operation: claim.computation.operation, ...(claim.caveat ? { caveat: claim.caveat } : {}) }));
  let visualization: SafeVisualizationSpec | null = null;
  if (artifact.plan.artifactTypeId === 'chart' && !(input.legacyChartWithoutVisual && input.visualExpression === null)) {
    const compiled = compileChart(artifact, facts, input.visualExpression, input.labels, input.traits);
    if ('outcome' in compiled) return compiled;
    visualization = compiled.spec;
  } else if (input.visualExpression !== null && artifact.plan.artifactTypeId !== 'chart') return rejected('unsupported_concept', 'unexpected_visual_expression');
  return { outcome: 'accepted', spec: freeze({ version: 1, artifact: artifact.ref, kind: artifact.plan.artifactTypeId, title: artifact.plan.title,
    scope: { ...artifact.bundle.scope, dates: artifact.bundle.provenance.dates }, query: artifact.bundle.query, evidence: artifact.bundle.ref,
    claimGraphDigest: artifact.graph.digest, grain: artifact.bundle.grain, facts, limitations: unique([...artifact.bundle.limitations, ...artifact.graph.limitations]),
    interpretationLabels: artifact.bundle.interpretationLabels, coverage: artifact.bundle.coverage,
    ranking: artifact.query.topN ? { count: artifact.query.topN.count, direction: artifact.query.topN.direction } : null,
    sources: artifact.bundle.sources.map(source => ({ id: source.id, observedAt: source.observedAt, retrievedAt: source.retrievedAt, freshness: source.freshness })),
    visualization, csv: artifact.plan.artifactTypeId === 'csv_export' ? factsToCSV(facts) : null,
    ...(input.labels ? { labels: input.labels } : {}) }) };
}

/** What the chart compiler needs from its source: a stored artifact version, or a dashboard widget's re-queried evidence (same rules, one compiler). */
export interface ChartSource {
  ref: ArtifactVersion['ref']; query: Pick<ArtifactVersion['query'], 'dimensions' | 'measures'>; bundle: { provenance: { dates: readonly string[] } };
}
/** Compiles a chart expression over verified facts into the renderer-owned SafeVisualizationSpec (also used by dashboard widgets). */
export function compileChartSpec(source: ChartSource, facts: ArtifactFact[], expression: unknown, labels?: ArtifactLabels, traits?: VisualTraits):
  { spec: SafeVisualizationSpec } | RejectedPlan { return compileChart(source, facts, expression, labels, traits); }

function compileChart(artifact: ChartSource, facts: ArtifactFact[], expression: unknown, labels?: ArtifactLabels, traits?: VisualTraits):
  { spec: SafeVisualizationSpec } | RejectedPlan {
  const parsed = visualExpressionSchema.safeParse(expression);
  if (!parsed.success) return rejected('unsupported_concept', 'invalid_visual_expression');
  const { visualization: plan, interaction, animation } = parsed.data;
  if (!sameRef(plan.artifact, artifact.ref)) return rejected('semantic_uncertainty', 'visual_artifact_reference');
  const dimensions = unique(facts.flatMap(f => Object.keys(f.dimensions)));
  const queryDim = (id: string) => artifact.query.dimensions.some(d => d.fieldId === id);
  if (!dimensions.includes(plan.xFieldId) || !queryDim(plan.xFieldId) ||
    (plan.groupFieldId !== undefined && (plan.groupFieldId === plan.xFieldId || !dimensions.includes(plan.groupFieldId) || !queryDim(plan.groupFieldId))) ||
    interaction.selectionFields.some(id => !dimensions.includes(id))) return rejected('unsupported_concept', 'visual_dimension');
  if (plan.yFieldIds.some(id => !artifact.query.measures.some(m => m.fieldId === id)) ||
    (plan.lineFieldIds?.some(id => !plan.yFieldIds.includes(id)) ?? false)) return rejected('unsupported_concept', 'visual_measure');
  const plotted = facts.filter(f => plan.yFieldIds.includes(f.measure) && f.operation !== 'rank');
  if (!plotted.length || plotted.some(f => !Object.hasOwn(f.dimensions, plan.xFieldId)) ||
    plan.yFieldIds.some(id => !plotted.some(f => f.measure === id))) return rejected('data_unavailable', 'visual_data');
  if (plotted.length > plan.maxMarks) return rejected('unsupported_concept', 'visual_mark_budget');
  const primitive = plan.primitiveId;
  const timeAxis = plan.xFieldId === 'date';
  // G5: a time family over a CATEGORY axis (line of sales by region) is a data-shape mismatch, not a malformed expression: report it as
  // visual_unsuitable_time so the caller can say why (and, for a revise, keep the current chart) instead of a generic denial.
  if (TIME_FAMILIES.has(primitive) && !timeAxis) return rejected('unsupported_concept', 'visual_unsuitable_time');
  if (TIME_FAMILIES.has(primitive) && plan.encodings.x !== 'time' ||
    !TIME_FAMILIES.has(primitive) && plan.encodings.x !== (timeAxis && primitive === 'combo' ? 'time' : 'category') ||
    plan.groupFieldId !== undefined && primitive !== 'heatmap' || plan.lineFieldIds !== undefined && primitive !== 'combo') return rejected('unsupported_concept', 'visual_encoding');
  const units = unique(plotted.map(f => f.unit));
  const skip = primitive === 'heatmap' ? [plan.xFieldId, plan.groupFieldId ?? ''] : [plan.xFieldId];
  const pointOf = (fact: ArtifactFact): SafeVisualPoint => ({ claimId: fact.claimId, category: fact.dimensions[plan.xFieldId],
    series: seriesKeyOf(fact, skip),
    seriesLabel: [labels?.fields[fact.measure] ?? fact.measure, ...Object.entries(fact.dimensions).filter(([id]) => !skip.includes(id))
      .map(([id, value]) => labels?.values[id]?.[value] ?? value)].join(' · '),
    value: fact.value, unit: fact.unit });
  const points = plotted.map(pointOf);
  const seriesIds = unique(points.map(p => p.series));
  if (seriesIds.length > VISUAL_LIMITS.series) return rejected('unsupported_concept', 'visual_series_budget');
  const gridKey = (fact: ArtifactFact, point: SafeVisualPoint) => JSON.stringify([point.category, point.series, plan.groupFieldId ? fact.dimensions[plan.groupFieldId] : null]);
  if (new Set(plotted.map((fact, i) => gridKey(fact, points[i]))).size !== points.length) return rejected('semantic_uncertainty', 'visual_grain_collision');
  const order = (a: SafeVisualPoint, b: SafeVisualPoint) => a.category.localeCompare(b.category) || a.series.localeCompare(b.series);
  const xLabels = labels?.values[plan.xFieldId];
  const labelMap = (field: string | undefined, values: readonly string[]) => {
    const map = field ? labels?.values[field] : undefined;
    return map ? Object.fromEntries(values.filter(value => map[value]).map(value => [value, map[value]])) : undefined;
  };
  const extra: Partial<SafeVisualizationSpec> = {};
  let domain: string[];
  let suitability = '';

  switch (primitive) {
    case 'bar': {
      if (units.length !== 1) return rejected('unsupported_concept', 'visual_mixed_units');
      domain = unique(points.map(p => p.category)).sort();
      suitability = 'กราฟแท่งเหมาะกับการเปรียบเทียบค่าระหว่างกลุ่ม';
      break;
    }
    case 'line': case 'area': {
      if (units.length !== 1) return rejected('unsupported_concept', 'visual_mixed_units');
      domain = [...artifact.bundle.provenance.dates].sort();
      // A time family needs real ordered temporal observations: at least two observed dates in at least one series.
      const perSeries = seriesIds.map(id => points.filter(p => p.series === id && p.value !== null).length);
      if (domain.length < 2 || !perSeries.some(count => count >= 2)) return rejected('unsupported_concept', 'visual_unsuitable_time');
      suitability = primitive === 'area' ? 'กราฟพื้นที่ใช้ได้เพราะข้อมูลเป็นลำดับวันที่จริงอย่างน้อยสองวัน' : 'กราฟเส้นใช้ได้เพราะข้อมูลเป็นลำดับวันที่จริง';
      break;
    }
    case 'scatter': {
      if (plan.yFieldIds.length !== 2 || seriesIds.length !== 2 || timeAxis) return rejected('unsupported_concept', 'visual_unsuitable_scatter');
      const xm = plan.yFieldIds[0];
      const byCategory = new Map<string, { x?: ArtifactFact; y?: ArtifactFact }>();
      for (const fact of plotted) {
        if (Object.keys(fact.dimensions).some(id => id !== plan.xFieldId)) return rejected('unsupported_concept', 'visual_unsuitable_scatter');
        const entry = byCategory.get(fact.dimensions[plan.xFieldId]) ?? {};
        if (fact.measure === xm) entry.x = fact; else entry.y = fact;
        byCategory.set(fact.dimensions[plan.xFieldId], entry);
      }
      const complete = [...byCategory.entries()].filter(([, e]) => e.x && e.y);
      if (complete.length < 3 || complete.length !== byCategory.size) return rejected('data_unavailable', 'visual_unsuitable_scatter');
      if (complete.length > VISUAL_LIMITS.scatterPoints) return rejected('unsupported_concept', 'visual_mark_budget');
      const pairs: SafeScatterPoint[] = complete.sort(([a], [b]) => a.localeCompare(b)).map(([category, e]) => ({ category, xClaimId: e.x!.claimId, yClaimId: e.y!.claimId,
        x: e.x!.value, y: e.y!.value, xUnit: e.x!.unit, yUnit: e.y!.unit }));
      extra.pairs = pairs;
      domain = pairs.map(p => p.category);
      suitability = 'แผนภาพกระจายใช้ได้เพราะแต่ละกลุ่มมีค่าครบทั้งสองตัวชี้วัด';
      break;
    }
    case 'heatmap': {
      const group = plan.groupFieldId;
      if (!group || plan.yFieldIds.length !== 1 || units.length !== 1 || plotted.some(f => !Object.hasOwn(f.dimensions, group)) || seriesIds.length !== 1) {
        return rejected('unsupported_concept', 'visual_unsuitable_heatmap');
      }
      domain = unique(points.map(p => p.category)).sort();
      const rowDomain = unique(plotted.map(f => f.dimensions[group])).sort();
      if (domain.length < 2 || rowDomain.length < 2) return rejected('data_unavailable', 'visual_unsuitable_heatmap');
      if (domain.length * rowDomain.length > VISUAL_LIMITS.heatmapCells) return rejected('unsupported_concept', 'visual_mark_budget');
      extra.groupField = group; extra.rowDomain = rowDomain;
      extra.rows = Object.fromEntries(plotted.map(f => [f.claimId, f.dimensions[group]]));
      const rowLabels = labelMap(group, rowDomain);
      if (rowLabels) extra.rowLabels = rowLabels;
      suitability = 'แผนที่ความร้อนใช้ได้เพราะมีสองมิติและหนึ่งตัวชี้วัด';
      break;
    }
    case 'pie': case 'donut': case 'treemap': {
      if (plan.yFieldIds.length !== 1 || seriesIds.length !== 1 || timeAxis || units.length !== 1) return rejected('unsupported_concept', 'visual_unsuitable_part_to_whole');
      const measure = plan.yFieldIds[0];
      const unit = units[0];
      if (!traits?.partToWhole?.includes(measure) || unit === 'percent') return rejected('unsupported_concept', 'visual_unsuitable_part_to_whole');
      if (plotted.some(f => f.value === null || !Number.isFinite(f.value) || f.value < 0 || !['value', 'sum', 'latest', 'max'].includes(f.operation))) return rejected('unsupported_concept', 'visual_unsuitable_part_to_whole');
      const total = plotted.reduce((sum, f) => sum + (f.value ?? 0), 0);
      const limit = primitive === 'treemap' ? VISUAL_LIMITS.treemapTiles : VISUAL_LIMITS.pieSlices;
      if (total <= 0 || plotted.length < MIN_SLICES) return rejected('data_unavailable', 'visual_unsuitable_part_to_whole');
      if (plotted.length > limit) return rejected('unsupported_concept', 'visual_mark_budget');
      domain = unique(points.map(p => p.category)).sort();
      suitability = 'ใช้สัดส่วนได้เพราะเป็นตัวชี้วัดที่รวมกันได้และค่าไม่ติดลบ';
      break;
    }
    case 'combo': {
      const lines = plan.lineFieldIds;
      if (!lines || plan.yFieldIds.length < 2 || lines.length >= plan.yFieldIds.length || (timeAxis && plan.encodings.x !== 'time')) return rejected('unsupported_concept', 'visual_unsuitable_combo');
      const barUnits = unique(plotted.filter(f => !lines.includes(f.measure)).map(f => f.unit));
      const lineUnits = unique(plotted.filter(f => lines.includes(f.measure)).map(f => f.unit));
      if (barUnits.length !== 1 || lineUnits.length !== 1) return rejected('unsupported_concept', 'visual_mixed_units');
      extra.axisUnits = barUnits[0] === lineUnits[0] ? [barUnits[0]] : [barUnits[0], lineUnits[0]];
      extra.lineSeries = seriesIds.filter(id => lines.includes(JSON.parse(id)[0] as string));
      domain = timeAxis ? [...artifact.bundle.provenance.dates].sort() : unique(points.map(p => p.category)).sort();
      suitability = extra.axisUnits.length === 2 ? 'กราฟผสมใช้สองแกนเพราะหน่วยของแท่งและเส้นต่างกัน' : 'กราฟผสมใช้ได้เพราะหน่วยของแท่งและเส้นเหมือนกัน';
      break;
    }
    case 'metric': {
      if (plotted.length > VISUAL_LIMITS.metricTiles) return rejected('unsupported_concept', 'visual_mark_budget');
      domain = unique(points.map(p => p.category)).sort();
      suitability = 'แสดงค่าเดี่ยวเป็นตัวเลขเด่น';
      break;
    }
    default: return rejected('unsupported_concept', 'invalid_visual_expression');
  }
  points.sort(order);
  const shape = { primitive, series: seriesIds.length, ordered: timeAxis, categories: domain.length };
  const effective = effectiveInteraction(interaction, shape);
  const dropped = interaction.interactionIds.filter(id => !effective.interactionIds.includes(id) && id !== 'reset');
  if (dropped.length) suitability = `${suitability} (${droppedInteractionsNote(dropped)})`;
  const spec: SafeVisualizationSpec = { version: 1, primitive, xField: plan.xFieldId, yFields: plan.yFieldIds, domain, points, interaction: effective, animation,
    ...extra, suitability, ...(xLabels ? { categoryLabels: Object.fromEntries(domain.filter(value => xLabels[value]).map(value => [value, xLabels[value]])) } : {}) };
  return { spec };
}
