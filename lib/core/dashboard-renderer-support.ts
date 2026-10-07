import { z } from 'zod';
import type { AIRunResult, DashboardSpec } from '../contracts';
import { invariant } from './errors';

const unsupportedWidgetMessage = 'Widget table with dataset inventory is not supported by the dashboard renderer. No preview was prepared. Retry with a metric widget using metric stock_issues, or a table using dataset branch_metrics.';
export const unsupportedWidgetResultSchema = z.object({
  error: z.object({ code: z.literal('UNSUPPORTED_WIDGET'), retryable: z.literal(true), message: z.literal(unsupportedWidgetMessage) }).strict(),
}).strict();
export const unsupportedWidgetResult = unsupportedWidgetResultSchema.parse({
  error: { code: 'UNSUPPORTED_WIDGET', retryable: true, message: unsupportedWidgetMessage },
});

export function dashboardPreparationClarification(results: AIRunResult['toolResults']): string | undefined {
  if (!results.some(entry => entry.name === 'dashboard.prepare_create' && unsupportedWidgetResultSchema.safeParse(entry.result).success)) return;
  return 'Dashboard ไม่รองรับตาราง inventory รายสินค้า และยังไม่ได้เตรียมข้อเสนอ — โปรดใช้ตัวชี้วัด stock_issues หรือเลือกตาราง branch_metrics';
}

/** Shared acceptance boundary for dashboard preparation and revision. */
export function assertDashboardRendererSupport(spec: DashboardSpec): void {
  invariant(!spec.widgets.some(widget => widget.type === 'table' && widget.dataset === 'inventory'),
    'UNSUPPORTED_WIDGET', 'Item-level inventory tables are not supported by the current dashboard renderer. The preview was rejected; use a stock-issues metric instead.', 400);
}
