import { z } from 'zod';
import type { Actor, DashboardSpec, VizWidget } from '../contracts';
import { VIZ_WIDGET_KINDS, vizWidgetSchema } from '../contracts';
import { DomainError } from '../core/errors';
import type { SemanticDataset } from '../dynamic/catalog/semantic';
import { bindWidgetPlan } from '../visualization/dashboard-bind';
import { widgetMeasures } from '../visualization/dashboard-family';

/**
 * Direct (UI) "replace widget" of a saved Dashboard: the SAME evidence/query-bound widget drawn as another registered family (Map and Sankey are not
 * in VIZ_WIDGET_KINDS, so they fail closed at the schema). The candidate keeps the widget's own binding (dataset, digests, stored QueryPlan) and its measure/
 * dimension; only family configuration changes. It is re-validated like any new widget (bindWidgetPlan against the catalog dataset + the widget's bound
 * query + the actor's authority), and the service then draws it from CURRENT evidence (the shared chart compiler's suitability rules) before anything is written.
 */
export const widgetFamilyOpSchema = z.object({ op: z.literal('change_family'), index: z.number().int().min(0).max(11), kind: z.enum(VIZ_WIDGET_KINDS) }).strict();
export type WidgetFamilyOp = z.infer<typeof widgetFamilyOpSchema>;
export const isWidgetFamilyOp = (change: unknown): boolean => !!change && typeof change === 'object' && (change as { op?: unknown }).op === 'change_family';

const unsuitable = (text: string): never => { throw new DomainError('WIDGET_UNSUITABLE', text, 422); };

/** The replacement widget (not yet drawn): validated structure only. Throws a typed 4xx DomainError with a Thai explanation. */
export function candidateFamilyWidget(spec: DashboardSpec, rawOp: unknown, input: { dataset: Pick<SemanticDataset, 'fields' | 'budgets'> | undefined; actor: Pick<Actor, 'permissions'> }): { widget: VizWidget; spec: DashboardSpec } {
  const op = widgetFamilyOpSchema.parse(rawOp);
  const current = spec.widgets[op.index];
  if (!current) throw new DomainError('INVALID_INPUT', 'ไม่พบ Widget ที่ระบุ', 400);
  if (current.type !== 'viz') return unsuitable('Widget แบบเดิมของระบบเปลี่ยนรูปแบบไม่ได้ — ใช้ Widget ที่ดึงข้อมูลสดแทน');
  if (current.kind === op.kind) return { widget: current, spec };
  if (!input.dataset) return unsuitable('แหล่งข้อมูลของ Widget นี้ไม่อยู่ในแคตตาล็อกปัจจุบัน จึงเปลี่ยนรูปแบบไม่ได้');
  const query = current.binding.query as { measures?: { fieldId: string }[]; dimensions?: { fieldId: string }[] };
  const measures = query.measures ?? [], dimensions = query.dimensions ?? [];
  const yFields = widgetMeasures(current);
  const second = dimensions.find(d => d.fieldId !== current.dimension)?.fieldId;
  const groupDimension = op.kind === 'heatmap' ? current.groupDimension ?? second : undefined;
  if (op.kind === 'heatmap' && !groupDimension) return unsuitable('แผนที่ความร้อนต้องมีสองมิติ แต่ Widget นี้มีมิติเดียว');
  const lineMeasures = op.kind === 'combo' ? current.lineMeasures ?? (yFields.length >= 2 ? [yFields[yFields.length - 1]] : undefined) : undefined;
  if (op.kind === 'combo' && !lineMeasures) return unsuitable('กราฟผสมต้องมีตัวชี้วัดอย่างน้อยสองตัว แต่ Widget นี้มีตัวเดียว');
  if (op.kind === 'scatter' && yFields.length !== 2) return unsuitable('แผนภาพกระจายต้องมีตัวชี้วัดสองตัว');
  if (op.kind !== 'kpi' && op.kind !== 'table' && !current.dimension) return unsuitable('รูปแบบนี้ต้องมีมิติสำหรับแบ่งกลุ่ม แต่ Widget นี้ไม่มี');
  const bound = bindWidgetPlan({ title: current.title, kind: op.kind, measure: current.measure, ...(current.dimension ? { dimension: current.dimension } : {}),
    sort: current.sort ?? null, topN: current.topN ?? null,
    ...(current.measures ? { measures: current.measures } : {}), ...(groupDimension ? { groupDimension } : {}), ...(lineMeasures ? { lineMeasures } : {}),
    ...(current.interactions ? { interactions: current.interactions } : {}), ...(current.animation ? { animation: current.animation } : {}) } as never,
  { dataset: input.dataset, query: { measures, dimensions }, actor: input.actor, binding: current.binding });
  if (!bound.ok) throw new DomainError(bound.mode === 'reject' ? 'FORBIDDEN' : 'WIDGET_UNSUITABLE', bound.mode === 'reject' ? 'ไม่มีสิทธิ์ใช้ข้อมูลของ Widget นี้' : 'รูปแบบที่เลือกวาดจากข้อมูลของ Widget นี้ไม่ได้', bound.mode === 'reject' ? 403 : 422);
  const widget = vizWidgetSchema.parse((bound as { widget: VizWidget }).widget);
  const widgets = [...spec.widgets];
  widgets[op.index] = widget;
  return { widget, spec: { ...spec, widgets } };
}
