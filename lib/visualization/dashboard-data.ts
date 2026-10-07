import { z } from 'zod';
import { VIZ_WIDGET_KINDS, type VizWidget } from '../contracts';
import type { ClaimGraph } from '../dynamic/evidence/claim-graph';
import type { SemanticDataset } from '../dynamic/catalog/semantic';
import { type ArtifactFact, type ArtifactLabels, type SafeVisualizationSpec } from './contracts';

/**
 * AI-proposed dashboard visualization plan. Generated text (titles, description) is allowed; every
 * measure/dimension id is validated against the server catalog and bound to evidence by the builder.
 */
const fieldId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/);
export const dashboardWidgetPlanSchema = z.object({
  kind: z.enum(VIZ_WIDGET_KINDS), title: z.string().trim().min(1).max(100),
  measure: fieldId, dimension: fieldId.nullable(), sort: z.enum(['asc', 'desc']).nullable(), topN: z.number().int().min(1).max(50).nullable(),
  // Family configuration (optional, so existing kpi/bar/line/table plans stay valid): extra y measures, heatmap row dimension, combo line measures.
  // Interaction/animation ids are not planner-authored (the server applies registered defaults, or carries a saved Result's own).
  measures: z.array(fieldId).min(1).max(7).nullish(), groupDimension: fieldId.nullish(), lineMeasures: z.array(fieldId).min(1).max(7).nullish(),
}).strict();
export const dashboardVisualizationPlanSchema = z.object({
  version: z.literal(1), title: z.string().trim().min(1).max(120), description: z.string().trim().max(500),
  widgets: z.array(dashboardWidgetPlanSchema).min(1).max(12),
}).strict();
export type DashboardWidgetPlan = z.infer<typeof dashboardWidgetPlanSchema>;
export type DashboardVisualizationPlan = z.infer<typeof dashboardVisualizationPlanSchema>;

export interface VizPoint { claimId: string; key: string; label: string; value: number | null }
/** JSON-safe, evidence-bound render data for one viz widget. Produced per viewer; never persisted in the dashboard. */
export interface VizWidgetData {
  kind: VizWidget['kind']; title: string; measure: string; measureLabel: string; dimension: string | null; dimensionLabel: string | null;
  unit: string; unitLabel: string; points: VizPoint[]; total: number; shown: number;
  sort: 'asc' | 'desc' | null; topN: number | null;
  evidence: { id: string; version: number; digest: string }; limitations: string[]; sources: string[];
  /** Chart families (area, scatter, heatmap, pie, donut, treemap, combo): the compiled renderer spec, display labels and the exact facts for the data table. */
  chart?: SafeVisualizationSpec; labels?: ArtifactLabels; facts?: ArtifactFact[];
  /** A saved Result's registered interaction ids / animation mode, carried through a single-series bar/line (never planner-authored). */
  interactions?: VizWidget['interactions']; animation?: VizWidget['animation'];
}
export type VizWidgetResult =
  | { index: number; status: 'ready'; data: VizWidgetData }
  | { index: number; status: 'denied' | 'unavailable'; text: string; code?: 'scope_ceiling' };

export type VizResolution = { outcome: 'ready'; data: VizWidgetData } | { outcome: 'unavailable'; code: string };

/** Pure projection of verified claims. Numbers come only from the claim graph; ordering/top-N is presentation of the complete claim set. */
export function resolveVizWidgetData(
  widget: Pick<VizWidget, 'title' | 'kind' | 'measure' | 'dimension' | 'sort' | 'topN'> & Partial<Pick<VizWidget, 'interactions' | 'animation'>>,
  graph: Pick<ClaimGraph, 'claims' | 'limitations'>, dataset: Pick<SemanticDataset, 'fields'>,
  evidence: { id: string; version: number; digest: string },
): VizResolution {
  const measureField = dataset.fields.find(f => f.id === widget.measure && f.kind === 'measure');
  if (!measureField) return { outcome: 'unavailable', code: 'unknown_measure' };
  const dimensionField = widget.dimension ? dataset.fields.find(f => f.id === widget.dimension && f.kind === 'dimension') : null;
  if (widget.dimension && !dimensionField) return { outcome: 'unavailable', code: 'unknown_dimension' };
  const claims = graph.claims.filter(c => c.measure === widget.measure && c.computation.operation !== 'rank');
  if (!claims.length) return { outcome: 'unavailable', code: 'measure_not_in_evidence' };
  if (new Set(claims.map(c => c.unit)).size !== 1) return { outcome: 'unavailable', code: 'mixed_units' };
  const labelOf = (value: string) => dimensionField?.canonicalValues?.find(v => v.id === value)?.label ?? value;
  let points: VizPoint[];
  if (!widget.dimension) {
    if (widget.kind !== 'kpi' && widget.kind !== 'table') return { outcome: 'unavailable', code: 'dimension_required' };
    if (widget.kind === 'kpi' && claims.length !== 1) return { outcome: 'unavailable', code: 'kpi_not_single_value' };
    points = claims.map(c => ({ claimId: c.id, key: c.id, label: measureField.displayLabel ?? c.measure, value: c.value }));
  } else {
    if (widget.kind === 'kpi') return { outcome: 'unavailable', code: 'kpi_has_dimension' };
    if (claims.some(c => !Object.hasOwn(c.dimensions, widget.dimension!))) return { outcome: 'unavailable', code: 'dimension_not_in_evidence' };
    if (widget.kind === 'line' && widget.dimension !== 'date') return { outcome: 'unavailable', code: 'line_requires_date' };
    points = claims.map(c => ({ claimId: c.id, key: c.dimensions[widget.dimension!], label: labelOf(c.dimensions[widget.dimension!]), value: c.value }));
    if (new Set(points.map(p => p.key)).size !== points.length) return { outcome: 'unavailable', code: 'grain_collision' };
  }
  const total = points.length;
  const direction = widget.sort ?? null;
  if (direction) points.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : direction === 'asc' ? a.value - b.value : b.value - a.value) || a.key.localeCompare(b.key));
  else points.sort((a, b) => a.key.localeCompare(b.key));
  if (widget.topN) points = points.slice(0, widget.topN);
  const unit = claims[0].unit;
  return { outcome: 'ready', data: {
    kind: widget.kind, title: widget.title, measure: widget.measure, measureLabel: measureField.displayLabel ?? widget.measure,
    dimension: widget.dimension ?? null, dimensionLabel: dimensionField ? dimensionField.displayLabel ?? dimensionField.id : null,
    unit, unitLabel: measureField.displayUnit ?? unit, points, total, shown: points.length, sort: direction, topN: widget.topN ?? null,
    evidence: { ...evidence }, limitations: [...graph.limitations], sources: [...new Set(claims.flatMap(c => c.sourceRefs))].sort(),
    ...(widget.interactions ? { interactions: widget.interactions } : {}), ...(widget.animation ? { animation: widget.animation } : {}),
  } };
}

/** Maps viz data onto the existing safe renderer spec (bar/line only). No markup, options or code cross this boundary. */
export function vizDataToChartSpec(data: VizWidgetData): SafeVisualizationSpec | null {
  if ((data.kind !== 'bar' && data.kind !== 'line') || !data.dimension || !data.points.length) return null;
  const keys = [...new Set(data.points.map(p => p.key))];
  const domain = data.kind === 'line' ? keys.sort() : keys;
  return { version: 1, primitive: data.kind, xField: data.dimension, yFields: [data.measure], domain,
    categoryLabels: Object.fromEntries(data.points.filter(p => p.label !== p.key).map(p => [p.key, p.label])),
    points: data.points.map(p => ({ claimId: p.claimId, category: p.key, series: data.measure, seriesLabel: data.measureLabel, value: p.value, unit: data.unit })),
    interaction: { version: 1, interactionIds: data.interactions?.length ? [...new Set(['inspect_data', ...data.interactions])] as SafeVisualizationSpec['interaction']['interactionIds'] : ['inspect_data', 'select_point'], selectionFields: [data.dimension] },
    animation: !data.animation || data.animation === 'none' ? { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' }
      : { version: 1, modeId: data.animation, durationMs: data.animation === 'fade' ? 150 : 300, reducedMotion: 'respect' } };
}
