import { z } from 'zod';
import { idSchema, refSchema } from '../dynamic/plan/schemas';

export const VISUAL_LIMITS = { marks: 500, series: 8, durationMs: 400, pieSlices: 12, treemapTiles: 60, heatmapCells: 400, metricTiles: 8, scatterPoints: 200 } as const;

/** Registered safe chart families. Every family is drawn by renderer-owned code from verified claims only. */
export const VISUAL_PRIMITIVES = ['bar', 'line', 'area', 'scatter', 'heatmap', 'pie', 'donut', 'treemap', 'combo', 'metric'] as const;
export type VisualPrimitive = (typeof VISUAL_PRIMITIVES)[number];
/** Registered interaction ids (InteractionSpec). `inspect_data` is mandatory: the exact table is always the accessible alternative. */
export const INTERACTION_IDS = ['inspect_data', 'inspect_sources', 'select_point', 'tooltip', 'legend_toggle', 'cross_filter', 'drilldown', 'zoom_brush', 'reset'] as const;
export type InteractionId = (typeof INTERACTION_IDS)[number];
/** Interactions that change what is shown and therefore need a reset (the compiler adds `reset` and drops what the data shape cannot support). */
export const STATEFUL_INTERACTIONS: readonly InteractionId[] = ['select_point', 'legend_toggle', 'cross_filter', 'drilldown', 'zoom_brush'];
export const ANIMATION_MODES = ['none', 'fade', 'interpolate', 'reorder'] as const;

export const visualizationPlanSchema = z.object({
  version: z.literal(1), artifact: refSchema, primitiveId: z.enum(VISUAL_PRIMITIVES), xFieldId: idSchema,
  yFieldIds: z.array(idSchema).min(1).max(VISUAL_LIMITS.series).refine(ids => new Set(ids).size === ids.length),
  /** heatmap: the second (row) dimension. */
  groupFieldId: idSchema.optional(),
  /** combo: the measures drawn as lines (the rest of yFieldIds are bars). */
  lineFieldIds: z.array(idSchema).min(1).max(VISUAL_LIMITS.series).refine(ids => new Set(ids).size === ids.length).optional(),
  encodings: z.object({ x: z.enum(['category', 'time']), y: z.literal('value') }).strict(),
  maxMarks: z.number().int().positive().max(VISUAL_LIMITS.marks),
}).strict();
export const interactionSpecSchema = z.object({
  version: z.literal(1), interactionIds: z.array(z.enum(INTERACTION_IDS)).min(1).max(INTERACTION_IDS.length)
    .refine(ids => new Set(ids).size === ids.length && ids.includes('inspect_data'), 'unique ids and inspect_data are required'),
  /** Fields the selection / cross-filter / drilldown act on (the first one is the drill field). */
  selectionFields: z.array(idSchema).max(8).refine(ids => new Set(ids).size === ids.length),
}).strict();
export const animationSpecSchema = z.object({
  version: z.literal(1), modeId: z.enum(ANIMATION_MODES), durationMs: z.number().int().nonnegative().max(VISUAL_LIMITS.durationMs),
  reducedMotion: z.literal('respect'),
}).strict().refine(spec => spec.modeId === 'none' ? spec.durationMs === 0 : spec.durationMs > 0);
export const visualExpressionSchema = z.object({
  visualization: visualizationPlanSchema, interaction: interactionSpecSchema, animation: animationSpecSchema,
}).strict();
export type VisualizationPlan = z.infer<typeof visualizationPlanSchema>;
export type InteractionSpec = z.infer<typeof interactionSpecSchema>;
export type AnimationSpec = z.infer<typeof animationSpecSchema>;
export type VisualExpression = z.infer<typeof visualExpressionSchema>;

export interface ArtifactFact {
  claimId: string; measure: string; value: number | null; unit: string; dimensions: Readonly<Record<string, string>>;
  rowRefs: readonly string[]; sourceRefs: readonly string[]; operation: string; caveat?: string;
}
/** Catalog/presenter display labels (Thai). Display only: ids, values and claims are never rewritten. */
export interface ArtifactLabels {
  fields: Readonly<Record<string, string>>; units: Readonly<Record<string, string>>;
  values: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface SafeVisualPoint { claimId: string; category: string; series: string; seriesLabel: string; value: number | null; unit: string }
/** scatter: one entity measured on two measures (x and y). */
export interface SafeScatterPoint { category: string; xClaimId: string; yClaimId: string; x: number | null; y: number | null; xUnit: string; yUnit: string }
export interface SafeVisualizationSpec {
  version: 1; primitive: VisualPrimitive; xField: string; yFields: readonly string[];
  domain: readonly string[]; categoryLabels?: Readonly<Record<string, string>>;
  points: readonly SafeVisualPoint[];
  interaction: InteractionSpec; animation: AnimationSpec;
  /** heatmap row dimension (domain of the second field) */
  groupField?: string; rowDomain?: readonly string[]; rowLabels?: Readonly<Record<string, string>>;
  /** heatmap: claim id -> row category (points keep `category` as the column) */
  rows?: Readonly<Record<string, string>>;
  /** scatter pairs and the measures plotted on each axis */
  pairs?: readonly SafeScatterPoint[];
  /** combo: series ids drawn as lines; the rest are bars. `axisUnits` are the (<=2) units of the left/right value axes. */
  lineSeries?: readonly string[]; axisUnits?: readonly string[];
  /** Why this family fits the data (server-owned, shown to the reader). */
  suitability?: string;
}
export interface ArtifactRendererSpec {
  version: 1; artifact: { id: string; version: number; digest: string }; kind: 'table' | 'ranking' | 'chart' | 'executive_brief' | 'csv_export';
  title: string; scope: { regions: readonly string[]; branchIds: readonly string[]; dates: readonly string[] };
  query: { id: string; version: number; digest: string }; evidence: { id: string; version: number; digest: string };
  claimGraphDigest: string; grain: readonly string[]; facts: readonly ArtifactFact[]; limitations: readonly string[];
  interpretationLabels: readonly string[]; coverage: { expected: number; read: number; complete: boolean };
  ranking: { count: number; direction: 'highest' | 'lowest' } | null;
  sources: readonly { id: string; observedAt: string; retrievedAt: string; freshness: string }[];
  visualization: SafeVisualizationSpec | null; csv: string | null; labels?: ArtifactLabels;
  /** Set when the artifact is shown to a recipient it was shared with (never to the owner). */
  sharedBy?: string;
}
