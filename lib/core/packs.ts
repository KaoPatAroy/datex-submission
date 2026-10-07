import { z } from 'zod';
import type { DepartmentPack, PackPin } from '../contracts';
import { dashboardSpecSchema } from '../contracts';
import { salesPack } from '../packs/sales';
import { operationsPack } from '../packs/operations';
import { hrPack } from '../packs/hr';
import { digest } from './utils';
import { invariant } from './errors';

export function registerPacks(packs: DepartmentPack[]): DepartmentPack[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  const metrics = new Set<string>();
  const templates = new Set<string>();
  for (const pack of packs) {
    invariant(!ids.has(pack.id) && pack.contractVersion === 1 && pack.approvalMode === 'requester_confirmation', 'INVALID_PACK', 'Invalid or unsupported pack'); ids.add(pack.id);
    for (const tool of pack.tools) {
      invariant(!names.has(tool.name) && !!tool.inputSchema && !!tool.resultSchema && tool.timeoutMs > 0 && ['read','prepare','execute','verify'].includes(tool.audit), 'INVALID_PACK', 'Invalid or duplicate tool');
      names.add(tool.name);
    }
    for (const metric of pack.metrics) { invariant(!metrics.has(metric.id) && !!metric.calculatorId && metric.freshnessMinutes > 0, 'INVALID_PACK', 'Invalid or duplicate metric'); metrics.add(metric.id); }
    for (const template of pack.templates) { invariant(!templates.has(template.id), 'INVALID_PACK', 'Duplicate template'); dashboardSpecSchema.parse(template.spec); templates.add(template.id); }
  }
  for (const pack of packs) for (const dep of pack.dependencies) invariant(packs.some(p => p.id === dep.id && p.version === dep.version), 'INVALID_PACK', 'Missing dependency');
  for (const pack of packs) for (const template of pack.templates) for (const widget of template.spec.widgets) {
    if ('metric' in widget) invariant(metrics.has(widget.metric), 'INVALID_PACK', 'Unknown metric');
    if ('comparisonMetric' in widget && widget.comparisonMetric) invariant(metrics.has(widget.comparisonMetric), 'INVALID_PACK', 'Unknown comparison metric');
  }
  return packs;
}
export const packs = () => registerPacks([salesPack, operationsPack, hrPack]);
export function packPins(ids?: string[]): PackPin[] { return packs().filter(p => !ids || ids.includes(p.id)).map(p => ({ id: p.id, version: p.version, implementationRevision: p.implementationRevision, schemaDigest: digest({ ...p, tools: p.tools.map(t => ({ ...t, inputSchema: z.toJSONSchema(t.inputSchema), resultSchema: z.toJSONSchema(t.resultSchema) })) }) })); }
export function assertPackPins(expected: PackPin[]): void {
  invariant(expected.every(pin => packPins([pin.id]).some(actual => digest(actual) === digest(pin))), 'STALE_ACTION', 'Department Pack เปลี่ยนแปลง กรุณาสร้างตัวอย่างใหม่', 409);
}
