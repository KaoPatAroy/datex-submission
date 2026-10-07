import type { Actor, VizWidget } from '../contracts';
import type { SemanticDataset } from '../dynamic/catalog/semantic';
import type { DashboardWidgetPlan } from './dashboard-data';
import { isFamilyKind, widgetMeasures } from './dashboard-family';

const TRUSTED = ['internal', 'public_business'];

export type BindWidgetResult = { ok: true; widget: VizWidget } | { ok: false; mode: 'skip' | 'reject'; code: string };

/**
 * Validates one AI widget plan against the server catalog + actor authority and the accepted query, and returns the declarative
 * `viz` widget (family configuration only; the evidence/query binding is supplied by the caller). Shared by the branch and table
 * dashboard builders so both enforce one rule set. `skip` = this widget cannot be drawn from the evidence (left out, never faked);
 * `reject` = an authority/trust failure (the whole dashboard is refused).
 */
/** A planned widget, optionally carrying a saved Result's own registered interaction/animation ids (never planner-authored). */
export type BindableWidgetPlan = DashboardWidgetPlan & Partial<Pick<VizWidget, 'interactions' | 'animation'>>;

export function bindWidgetPlan(widget: BindableWidgetPlan, input: {
  dataset: Pick<SemanticDataset, 'fields' | 'budgets'>; query: { measures: readonly { fieldId: string }[]; dimensions: readonly { fieldId: string }[] };
  actor: Pick<Actor, 'permissions'>; binding: VizWidget['binding'];
}): BindWidgetResult {
  const { dataset, query, actor } = input;
  const skip = (code: string): BindWidgetResult => ({ ok: false, mode: 'skip', code });
  // Chart families (and a multi-measure bar/line) carry declarative family configuration.
  const family = isFamilyKind(widget.kind) || ((widget.kind === 'bar' || widget.kind === 'line') && !!widget.measures?.length);
  const yFields = widgetMeasures({ measure: widget.measure, measures: family ? widget.measures ?? undefined : undefined });
  const measureFields = yFields.map(id => dataset.fields.find(f => f.id === id && f.kind === 'measure'));
  if (measureFields.some(f => !f) || yFields.some(id => !query.measures.some(m => m.fieldId === id))) return skip('unknown_measure');
  const dimensionIds = [widget.dimension, family && widget.kind === 'heatmap' ? widget.groupDimension : null].filter((id): id is string => !!id);
  const dimensionFields = dimensionIds.map(id => dataset.fields.find(f => f.id === id && f.kind === 'dimension'));
  if (dimensionFields.some(f => !f) || dimensionIds.some(id => !query.dimensions.some(d => d.fieldId === id))) return skip('unknown_dimension');
  const lines = family && widget.kind === 'combo' ? widget.lineMeasures ?? undefined : undefined;
  if (lines?.some(id => !yFields.includes(id))) return skip('widget_unavailable');
  for (const field of [...measureFields, ...dimensionFields]) {
    if (!field) continue;
    if (!field.requiredPermissions.every(p => actor.permissions.includes(p))) return { ok: false, mode: 'reject', code: 'permission_denied' };
    if (field.trust !== 'certified' || !TRUSTED.includes(field.sensitivity)) return { ok: false, mode: 'reject', code: 'untrusted_field' };
  }
  if (widget.topN && widget.topN > dataset.budgets.maxTopN) return skip('topn_budget');
  const extras = family ? {
    ...(yFields.length > 1 ? { measures: yFields.slice(1) } : {}),
    ...(widget.kind === 'heatmap' && widget.groupDimension ? { groupDimension: widget.groupDimension } : {}),
    ...(lines ? { lineMeasures: lines } : {}),
  } : {};
  // A saved Result's own registered interaction/animation ids also survive on a single-series bar/line (which is not a "family" widget).
  const chartConfig = family || widget.kind === 'bar' || widget.kind === 'line' ? {
    ...(widget.interactions ? { interactions: widget.interactions } : {}), ...(widget.animation ? { animation: widget.animation } : {}),
  } : {};
  return { ok: true, widget: { type: 'viz', title: widget.title, kind: widget.kind, measure: widget.measure,
    ...(widget.dimension ? { dimension: widget.dimension } : {}), ...(widget.sort ? { sort: widget.sort } : {}), ...(widget.topN ? { topN: widget.topN } : {}),
    ...extras, ...chartConfig, binding: input.binding } };
}
