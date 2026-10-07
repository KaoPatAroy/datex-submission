import { z } from 'zod';
import type { DashboardSpec } from '../contracts';
import { DomainError } from '../core/errors';

/**
 * Direct (UI) edits of a saved Dashboard's widget list. Pure spec transforms: authorization, ownership, share state and the
 * revision CAS are enforced by the SAME service write path the router's dashboard.refine uses (updateDashboardSpec), so there
 * is one rule set. A widget is only ever re-ordered, re-titled or removed here; its evidence/query binding is never edited.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export const dashboardWidgetOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reorder'), order: z.array(z.number().int().min(0).max(11)).min(1).max(12) }).strict(),
  z.object({ op: z.literal('remove'), index: z.number().int().min(0).max(11) }).strict(),
  z.object({ op: z.literal('retitle'), index: z.number().int().min(0).max(11),
    title: z.string().trim().min(1, 'โปรดระบุชื่อ Widget').max(100, 'ชื่อ Widget ยาวเกิน 100 ตัวอักษร').refine(t => !CONTROL_CHARS.test(t), 'ชื่อมีอักขระที่ไม่รองรับ') }).strict(),
]);
export type DashboardWidgetOp = z.infer<typeof dashboardWidgetOpSchema>;

const bad = (text: string): never => { throw new DomainError('INVALID_INPUT', text, 400); };

export function applyWidgetOp(spec: DashboardSpec, input: unknown): DashboardSpec {
  const op = dashboardWidgetOpSchema.parse(input);
  const widgets = [...spec.widgets];
  switch (op.op) {
    case 'reorder': {
      const valid = op.order.length === widgets.length && new Set(op.order).size === widgets.length && op.order.every(i => i < widgets.length);
      if (!valid) bad('ลำดับ Widget ไม่ถูกต้อง');
      return { ...spec, widgets: op.order.map(i => widgets[i]) };
    }
    case 'remove': {
      if (op.index >= widgets.length) bad('ไม่พบ Widget ที่ระบุ');
      if (widgets.length === 1) bad('Dashboard ต้องมี Widget อย่างน้อย 1 รายการ — ลบทั้ง Dashboard แทนได้');
      widgets.splice(op.index, 1);
      return { ...spec, widgets };
    }
    case 'retitle': {
      if (op.index >= widgets.length) bad('ไม่พบ Widget ที่ระบุ');
      widgets[op.index] = { ...widgets[op.index], title: op.title } as DashboardSpec['widgets'][number];
      return { ...spec, widgets };
    }
  }
}
