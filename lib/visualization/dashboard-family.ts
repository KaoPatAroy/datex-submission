import type { VizWidget } from '../contracts';
import type { ClaimGraph } from '../dynamic/evidence/claim-graph';
import type { SemanticDataset } from '../dynamic/catalog/semantic';
import { unique } from '../dynamic/shared';
import { compileChartSpec, type VisualTraits } from './compile';
import type { ArtifactFact, ArtifactLabels, InteractionId, VisualExpression, VisualPrimitive } from './contracts';
import { resolveVizWidgetData, type VizPoint, type VizResolution, type VizWidgetData } from './dashboard-data';

/** Families drawn by the shared chart compiler (the legacy kpi/table/bar/line widgets keep their original resolver). */
export const FAMILY_WIDGET_KINDS = ['area', 'scatter', 'heatmap', 'pie', 'donut', 'treemap', 'combo'] as const;
export type FamilyWidgetKind = (typeof FAMILY_WIDGET_KINDS)[number];
export const isFamilyKind = (kind: VizWidget['kind']): kind is FamilyWidgetKind => (FAMILY_WIDGET_KINDS as readonly string[]).includes(kind);

/** What a family widget needs from the query it is bound to (the stored/accepted QueryPlan; never from the client). */
export interface FamilyContext {
  query: { dimensions: readonly { fieldId: string }[]; measures: readonly { fieldId: string }[]; time?: { dates: readonly string[] } | null };
  labels?: ArtifactLabels; traits?: VisualTraits;
}

const DURATION: Record<string, number> = { fade: 150, interpolate: 300, reorder: 300 };
/** Default registered interactions per family (the compiler drops those the data shape cannot support). Drilldown needs a stored Result, so it is never default here. */
const DEFAULT_INTERACTIONS: readonly InteractionId[] = ['inspect_data', 'inspect_sources', 'tooltip', 'select_point', 'legend_toggle', 'zoom_brush'];

/** The yFieldIds of a family widget: the primary measure first, then the declared extras (unique). */
export const widgetMeasures = (widget: Pick<VizWidget, 'measure' | 'measures'>): string[] => unique([widget.measure, ...(widget.measures ?? [])]);

/** Declarative VisualExpression of a family widget. Pure configuration: registered primitive, field ids, interaction ids, animation mode. */
export function widgetExpression(widget: Pick<VizWidget, 'kind' | 'measure' | 'measures' | 'dimension' | 'groupDimension' | 'lineMeasures' | 'interactions' | 'animation'>,
  artifact: { id: string; version: number; digest: string }): VisualExpression | null {
  if (!(isFamilyKind(widget.kind) || widget.kind === 'bar' || widget.kind === 'line') || !widget.dimension) return null;
  const primitive: VisualPrimitive = widget.kind as VisualPrimitive;
  const timeAxis = widget.dimension === 'date';
  const mode = widget.animation ?? 'fade';
  return {
    visualization: { version: 1, artifact, primitiveId: primitive, xFieldId: widget.dimension, yFieldIds: widgetMeasures(widget),
      ...(widget.groupDimension ? { groupFieldId: widget.groupDimension } : {}), ...(widget.lineMeasures ? { lineFieldIds: widget.lineMeasures } : {}),
      encodings: { x: primitive === 'line' || primitive === 'area' || (primitive === 'combo' && timeAxis) ? 'time' : 'category', y: 'value' }, maxMarks: 500 },
    interaction: { version: 1, interactionIds: [...new Set<InteractionId>(['inspect_data', ...(widget.interactions ?? DEFAULT_INTERACTIONS)])], selectionFields: [widget.dimension] },
    animation: mode === 'none' ? { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' } : { version: 1, modeId: mode, durationMs: DURATION[mode], reducedMotion: 'respect' },
  };
}

/**
 * Applies a family widget's sort/top-N to its facts: categories (the widget's dimension) are ranked by the PRIMARY measure and only the first N
 * categories keep all of their facts (every measure/series), in ranked order. No sort/top-N leaves the facts untouched.
 */
function orderedFacts(facts: ArtifactFact[], widget: Pick<VizWidget, 'measure' | 'dimension' | 'sort' | 'topN'>): ArtifactFact[] {
  const dimension = widget.dimension;
  if (!dimension || (!widget.sort && !widget.topN)) return facts;
  const direction = widget.sort ?? 'desc';
  const score = new Map<string, number>();
  for (const fact of facts) {
    if (fact.measure !== widget.measure || fact.operation === 'rank' || !Object.hasOwn(fact.dimensions, dimension)) continue;
    const key = fact.dimensions[dimension];
    score.set(key, (score.get(key) ?? 0) + (typeof fact.value === 'number' ? fact.value : Number.NEGATIVE_INFINITY));
  }
  const order = [...score.keys()].sort((a, b) => (score.get(a)! === score.get(b)! ? 0 : direction === 'asc' ? score.get(a)! - score.get(b)! : score.get(b)! - score.get(a)!) || a.localeCompare(b));
  const kept = new Set(widget.topN ? order.slice(0, widget.topN) : order);
  const rank = new Map(order.map((key, index) => [key, index]));
  const position = (fact: ArtifactFact) => Object.hasOwn(fact.dimensions, dimension) ? rank.get(fact.dimensions[dimension]) ?? order.length : order.length;
  return facts.filter(fact => !Object.hasOwn(fact.dimensions, dimension) || kept.has(fact.dimensions[dimension])).map((fact, index) => ({ fact, index }))
    .sort((a, b) => position(a.fact) - position(b.fact) || a.index - b.index).map(item => item.fact);
}

function resolveFamily(widget: VizWidget, graph: Pick<ClaimGraph, 'claims' | 'limitations'>, dataset: Pick<SemanticDataset, 'fields'>,
  evidence: { id: string; version: number; digest: string }, context: FamilyContext): VizResolution {
  const yFields = widgetMeasures(widget);
  const measureFields = yFields.map(id => dataset.fields.find(f => f.id === id && f.kind === 'measure'));
  if (measureFields.some(f => !f)) return { outcome: 'unavailable', code: 'unknown_measure' };
  if (!widget.dimension) return { outcome: 'unavailable', code: 'dimension_required' };
  const dimensionFields = [widget.dimension, widget.groupDimension].filter((id): id is string => !!id).map(id => dataset.fields.find(f => f.id === id && f.kind === 'dimension'));
  if (dimensionFields.some(f => !f)) return { outcome: 'unavailable', code: 'unknown_dimension' };
  const expression = widgetExpression(widget, evidence);
  if (!expression) return { outcome: 'unavailable', code: 'invalid_visual_expression' };
  const allFacts: ArtifactFact[] = graph.claims.map(claim => ({ claimId: claim.id, measure: claim.measure, value: claim.value, unit: claim.unit, dimensions: { ...claim.dimensions },
    rowRefs: [...claim.rowRefs], sourceRefs: [...claim.sourceRefs], operation: claim.computation.operation, ...(claim.caveat ? { caveat: claim.caveat } : {}) }));
  // PC-06: sort/top-N are applied to the category set BEFORE compiling, so marks, the data table and the facts all show the same ordered, bounded rows.
  const facts = orderedFacts(allFacts, widget);
  const dates = unique([...(context.query.time?.dates ?? []), ...facts.flatMap(f => f.dimensions.date ? [f.dimensions.date] : [])]).sort();
  const compiled = compileChartSpec({ ref: evidence, query: context.query as never, bundle: { provenance: { dates } } }, facts, expression, context.labels, context.traits);
  if ('outcome' in compiled) return { outcome: 'unavailable', code: compiled.code };
  const plotted = facts.filter(f => yFields.includes(f.measure) && f.operation !== 'rank');
  const first = measureFields[0]!;
  const unit = plotted[0]?.unit ?? first.unit ?? '';
  const totalPoints = allFacts.filter(f => yFields.includes(f.measure) && f.operation !== 'rank').length;
  const points: VizPoint[] = plotted.map(fact => ({ claimId: fact.claimId, key: fact.claimId, label: Object.values(fact.dimensions).join(' · ') || fact.measure, value: fact.value }));
  const data: VizWidgetData = {
    kind: widget.kind, title: widget.title, measure: widget.measure, measureLabel: first.displayLabel ?? widget.measure, dimension: widget.dimension,
    dimensionLabel: dimensionFields[0]?.displayLabel ?? widget.dimension, unit, unitLabel: first.displayUnit ?? unit, points, total: totalPoints, shown: points.length,
    sort: widget.sort ?? (widget.topN ? 'desc' : null), topN: widget.topN ?? null, evidence: { ...evidence }, limitations: [...graph.limitations], sources: unique(plotted.flatMap(f => f.sourceRefs)).sort(),
    chart: compiled.spec, facts: plotted, ...(context.labels ? { labels: context.labels } : {}),
  };
  return { outcome: 'ready', data };
}

/**
 * One resolver for every dashboard family. kpi/table/bar/line keep the original resolver (identical output); the other families are compiled by
 * the SAME chart compiler as Results (suitability, mark budgets, interactions, animation), over the verified claims of the widget's own query.
 */
export function resolveVizWidget(widget: VizWidget, graph: Pick<ClaimGraph, 'claims' | 'limitations'>, dataset: Pick<SemanticDataset, 'fields'>,
  evidence: { id: string; version: number; digest: string }, context: FamilyContext): VizResolution {
  if (isFamilyKind(widget.kind) || ((widget.kind === 'bar' || widget.kind === 'line') && widget.measures?.length)) return resolveFamily(widget, graph, dataset, evidence, context);
  const legacy = resolveVizWidgetData(widget, graph, dataset, evidence);
  // A single-series bar/line cannot carry several groups per category (e.g. a date trend over several branches): the shared compiler draws one series per group instead.
  if (legacy.outcome === 'unavailable' && legacy.code === 'grain_collision' && (widget.kind === 'bar' || widget.kind === 'line')) return resolveFamily(widget, graph, dataset, evidence, context);
  return legacy;
}
