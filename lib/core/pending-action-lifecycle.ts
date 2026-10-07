import { z } from 'zod';
import { dashboardSpecSchema, scopeSchema, widgetSchema, type DashboardSpec } from '../contracts';

const widgetIndexSchema = z.number().int().nonnegative();
const widgetChangeSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('add'),
    index: widgetIndexSchema,
    widgets: z.array(widgetSchema).min(1),
  }).strict(),
  z.object({
    operation: z.literal('remove'),
    indexes: z.array(widgetIndexSchema).min(1).superRefine((indexes, context) => {
      if (new Set(indexes).size !== indexes.length) {
        context.addIssue({ code: 'custom', message: 'Removal indexes must be unique.' });
      }
    }),
  }).strict(),
  z.object({
    operation: z.literal('replace'),
    replacements: z.array(z.object({
      index: widgetIndexSchema,
      widget: widgetSchema,
    }).strict()).min(1).superRefine((replacements, context) => {
      const indexes = replacements.map((replacement) => replacement.index);
      if (new Set(indexes).size !== indexes.length) {
        context.addIssue({ code: 'custom', message: 'Replacement indexes must be unique.' });
      }
    }),
  }).strict(),
  z.object({
    operation: z.literal('set'),
    widgets: z.array(widgetSchema).min(1),
  }).strict(),
  z.object({
    operation: z.literal('reorder'),
    order: z.array(widgetIndexSchema).min(1),
  }).strict(),
]);

const branchIdsPatchSchema = scopeSchema.shape.branchIds.unwrap().min(1).superRefine((branchIds, context) => {
  if (new Set(branchIds).size !== branchIds.length) {
    context.addIssue({ code: 'custom', message: 'Branch IDs must be unique.' });
  }
  const blankIndex = branchIds.findIndex((branchId) => branchId.trim().length === 0);
  if (blankIndex !== -1) {
    context.addIssue({
      code: 'custom',
      path: [blankIndex],
      message: 'Branch IDs must not be blank.',
    });
  }
});

const scopePatchSchema = scopeSchema.partial().extend({
  branchIds: branchIdsPatchSchema.nullable().optional(),
}).strict().refine(
  (scope) => Object.keys(scope).length > 0,
  'Scope patch must change at least one scope field.',
);

export const dashboardCreatePatchSchema = z.object({
  title: dashboardSpecSchema.shape.title.optional(),
  description: dashboardSpecSchema.shape.description.optional(),
  scope: scopePatchSchema.optional(),
  widgetChange: widgetChangeSchema.optional(),
}).strict().refine(
  (patch) => Object.keys(patch).length > 0,
  'Dashboard patch must contain at least one change.',
);

export type DashboardCreatePatch = z.infer<typeof dashboardCreatePatchSchema>;
export type DashboardWidgetChange = z.infer<typeof widgetChangeSchema>;
export type DashboardPatchErrorCode =
  | 'invalid_base'
  | 'invalid_patch'
  | 'widget_index_out_of_range'
  | 'invalid_widget_permutation'
  | 'widget_limit_exceeded'
  | 'duplicate_widget'
  | 'invalid_result'
  | 'no_effect';

export class DashboardPatchError extends Error {
  constructor(
    readonly code: DashboardPatchErrorCode,
    message: string,
    readonly issues: readonly z.ZodIssue[] = [],
  ) {
    super(message);
    this.name = 'DashboardPatchError';
  }
}

/**
 * Requirements the service must enforce around this pure patch operation.
 * This module performs none of these authorization, evidence, renderer, or
 * lifecycle checks.
 */
export const dashboardPatchServiceValidationHandoff = Object.freeze({
  enforcedByThisModule: false as const,
  requirements: [
    'Select the exact predecessor action and re-read its current stored payload before applying this patch.',
    'Revalidate actor, session, conversation, status, mode revision, expiry, and permission for the predecessor.',
    'Authorize the patched scope for the actor and verify current evidence availability and source coverage.',
    'Verify every resulting widget is supported by the active renderer and its authorized evidence source.',
    'Recheck evidence, mode, expiry, release, and predecessor status when finalizing the replacement.',
    'Atomically create the replacement with a fresh ID, payload hash, evidence version, and expiry while making the predecessor non-confirmable; reject a confirmation-versus-revision race if the predecessor changed.',
    'If the originating turn fails after preparation, durably stale or quarantine only actions created by that exact actor, session, conversation, and turn before reporting cleanup complete.',
  ],
});

function fail(
  code: DashboardPatchErrorCode,
  message: string,
  issues: readonly z.ZodIssue[] = [],
): never {
  throw new DashboardPatchError(code, message, issues);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function widgetDuplicateKey(widget: DashboardSpec['widgets'][number]): string {
  const identity = Object.fromEntries(
    Object.entries(widget).filter(([key]) => key !== 'title'),
  );
  return stableJson(identity);
}

function assertUniqueWidgets(widgets: DashboardSpec['widgets']): void {
  const seen = new Set<string>();
  for (const widget of widgets) {
    const key = widgetDuplicateKey(widget);
    if (seen.has(key)) {
      fail('duplicate_widget', `Dashboard contains duplicate widget configuration: ${widget.title}`);
    }
    seen.add(key);
  }
}

function parsePredecessor(value: DashboardSpec): DashboardSpec {
  const result = dashboardSpecSchema.safeParse(value);
  if (!result.success) {
    fail('invalid_base', 'Predecessor must be a valid DashboardSpec.', result.error.issues);
  }
  assertUniqueWidgets(result.data.widgets);
  return result.data;
}

function parsePatch(value: unknown): DashboardCreatePatch {
  const result = dashboardCreatePatchSchema.safeParse(value);
  if (!result.success) {
    fail('invalid_patch', 'Dashboard patch is invalid or ambiguous.', result.error.issues);
  }
  return result.data;
}

function assertIndexesInRange(indexes: number[], length: number): void {
  if (indexes.some((index) => index >= length)) {
    fail('widget_index_out_of_range', 'Widget index must refer to an item in the predecessor dashboard.');
  }
}

function applyWidgetChange(
  widgets: DashboardSpec['widgets'],
  change: DashboardWidgetChange,
): DashboardSpec['widgets'] {
  switch (change.operation) {
    case 'add': {
      if (change.index > widgets.length) {
        fail('widget_index_out_of_range', 'Add index must be between zero and the predecessor widget count.');
      }
      const result = [...widgets];
      result.splice(change.index, 0, ...change.widgets);
      return result;
    }
    case 'remove': {
      assertIndexesInRange(change.indexes, widgets.length);
      const removed = new Set(change.indexes);
      return widgets.filter((_widget, index) => !removed.has(index));
    }
    case 'replace': {
      const indexes = change.replacements.map(({ index }) => index);
      assertIndexesInRange(indexes, widgets.length);
      const replacements = new Map(change.replacements.map(({ index, widget }) => [index, widget]));
      return widgets.map((widget, index) => replacements.get(index) ?? widget);
    }
    case 'set': return [...change.widgets];
    case 'reorder': {
      if (
        change.order.length !== widgets.length
        || new Set(change.order).size !== widgets.length
        || change.order.some((index) => index >= widgets.length)
      ) {
        fail('invalid_widget_permutation', 'Reorder must contain every predecessor widget index exactly once.');
      }
      return change.order.map((index) => widgets[index]);
    }
  }
}

function sameBranchSelection(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((branchId) => rightSet.has(branchId));
}

function applyScopePatch(
  scope: DashboardSpec['scope'],
  patch: NonNullable<DashboardCreatePatch['scope']>,
): DashboardSpec['scope'] {
  const result = { ...scope };
  if (patch.region !== undefined) result.region = patch.region;
  if (patch.date !== undefined) result.date = patch.date;
  if (patch.branchIds === null) {
    delete result.branchIds;
  } else if (
    patch.branchIds !== undefined
    && !sameBranchSelection(scope.branchIds, patch.branchIds)
  ) {
    result.branchIds = [...patch.branchIds];
  }
  return result;
}

function describeWidget(widget: DashboardSpec['widgets'][number]): string {
  const title = JSON.stringify(widget.title);
  switch (widget.type) {
    case 'metric':
      return `${title} [metric; metric=${widget.metric}]`;
    case 'bar_chart':
    case 'line_chart':
      return `${title} [${widget.type}; metric=${widget.metric}; comparisonMetric=${widget.comparisonMetric ?? 'ไม่ระบุ'}; groupBy=${widget.groupBy}]`;
    case 'table':
      return `${title} [table; dataset=${widget.dataset}]`;
    case 'incident_list':
      return `${title} [incident_list; dataset=${widget.dataset}]`;
    case 'text_summary':
      return `${title} [text_summary]`;
    case 'viz':
      return `${title} [viz; kind=${widget.kind}; measure=${widget.measure}; dimension=${widget.dimension ?? 'ไม่ระบุ'}; sort=${widget.sort ?? 'ไม่ระบุ'}; topN=${widget.topN ?? 'ไม่ระบุ'}; evidence=${widget.binding.evidenceDigest.slice(0, 12)}]`;
  }
}

function describeWidgetOrder(widgets: DashboardSpec['widgets']): string {
  return widgets.map((widget, index) => `${index + 1}. ${describeWidget(widget)}`).join(' | ');
}

function describeScopeValue(value: unknown): string {
  return value === undefined ? '(ไม่ระบุ)' : JSON.stringify(value);
}

function describeBranchSelection(value: string[] | undefined): string {
  return value === undefined ? 'ทุกสาขาในภาค' : JSON.stringify(value);
}

function createDiff(
  before: DashboardSpec,
  after: DashboardSpec,
  change?: DashboardWidgetChange,
): string[] {
  const diff: string[] = [];

  if (before.title !== after.title) {
    diff.push(`เปลี่ยนชื่อ: ${JSON.stringify(before.title)} → ${JSON.stringify(after.title)}`);
  }
  if (before.description !== after.description) {
    diff.push(`เปลี่ยนคำอธิบาย: ${JSON.stringify(before.description)} → ${JSON.stringify(after.description)}`);
  }

  const scopeLabels = {
    region: 'เปลี่ยนภาค',
    date: 'เปลี่ยนวันที่',
  } as const;
  for (const key of ['region', 'date'] as const) {
    if (before.scope[key] !== after.scope[key]) {
      diff.push(`${scopeLabels[key]}: ${describeScopeValue(before.scope[key])} → ${describeScopeValue(after.scope[key])}`);
    }
  }
  if (!sameBranchSelection(before.scope.branchIds, after.scope.branchIds)) {
    diff.push(`เปลี่ยนสาขา: ${describeBranchSelection(before.scope.branchIds)} → ${describeBranchSelection(after.scope.branchIds)}`);
  }

  if (change?.operation === 'add') {
    for (const [offset, widget] of change.widgets.entries()) {
      diff.push(`เพิ่ม: ${describeWidget(widget)} (ลำดับใหม่ ${change.index + offset + 1})`);
    }
  } else if (change?.operation === 'remove') {
    for (const index of [...change.indexes].sort((left, right) => left - right)) {
      diff.push(`ลบ: ${describeWidget(before.widgets[index])} (ตำแหน่งเดิม ${index + 1})`);
    }
  } else if (change?.operation === 'replace') {
    for (const replacement of [...change.replacements].sort((left, right) => left.index - right.index)) {
      diff.push(`แทนที่: ${describeWidget(before.widgets[replacement.index])} → ${describeWidget(replacement.widget)} (ตำแหน่งเดิม ${replacement.index + 1})`);
    }
  } else if (change?.operation === 'set') {
    for (const widget of before.widgets) diff.push(`ลบ: ${describeWidget(widget)}`);
    for (const [offset, widget] of change.widgets.entries()) diff.push(`เพิ่ม: ${describeWidget(widget)} (ลำดับใหม่ ${offset + 1})`);
  } else if (change?.operation === 'reorder') {
    diff.push(`เรียงลำดับมุมมองใหม่: ${describeWidgetOrder(before.widgets)} → ${describeWidgetOrder(after.widgets)}`);
  }

  const afterWidgetCounts = new Map<string, number>();
  for (const widget of after.widgets) {
    const key = stableJson(widget);
    afterWidgetCounts.set(key, (afterWidgetCounts.get(key) ?? 0) + 1);
  }
  let unchangedWidgets = 0;
  for (const widget of before.widgets) {
    const key = stableJson(widget);
    const count = afterWidgetCounts.get(key) ?? 0;
    if (count > 0) {
      unchangedWidgets += 1;
      afterWidgetCounts.set(key, count - 1);
    }
  }
  if (unchangedWidgets > 0) diff.push(`คงเดิม: ${unchangedWidgets} มุมมอง`);

  return diff;
}

/**
 * Applies a strict, pure dashboard_create patch. Widget indices always refer to
 * the immutable predecessor; adds insert at that predecessor position,
 * replacements/removals target predecessor indexes, and reorder is a complete
 * predecessor-index permutation. The returned spec is schema-validated and
 * detached from the predecessor.
 */
export function applyDashboardCreatePatch(
  predecessor: DashboardSpec,
  rawPatch: unknown,
): { spec: DashboardSpec; diff: string[] } {
  const before = parsePredecessor(predecessor);
  const patch = parsePatch(rawPatch);
  const widgets = patch.widgetChange
    ? applyWidgetChange(before.widgets, patch.widgetChange)
    : before.widgets;

  const candidate: DashboardSpec = {
    ...before,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.scope ? { scope: applyScopePatch(before.scope, patch.scope) } : {}),
    widgets,
  };
  const result = dashboardSpecSchema.safeParse(candidate);
  if (!result.success) {
    const widgetPathInvalid = result.error.issues.some((issue) => issue.path[0] === 'widgets');
    if ((patch.widgetChange?.operation === 'add' || patch.widgetChange?.operation === 'set') && widgetPathInvalid) {
      fail('widget_limit_exceeded', 'Dashboard revisions cannot exceed the schema widget limit.', result.error.issues);
    }
    fail('invalid_result', 'The dashboard patch does not produce a valid DashboardSpec.', result.error.issues);
  }

  assertUniqueWidgets(result.data.widgets);
  if (stableJson(before) === stableJson(result.data)) {
    fail('no_effect', 'Dashboard patch does not change the predecessor specification.');
  }

  return {
    spec: result.data,
    diff: createDiff(before, result.data, patch.widgetChange),
  };
}
