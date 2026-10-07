import { describe, expect, it } from 'vitest';
import type { DashboardSpec } from '../lib/contracts';
import {
  applyDashboardCreatePatch,
  DashboardPatchError,
  dashboardPatchServiceValidationHandoff,
} from '../lib/core/pending-action-lifecycle';

const predecessor: DashboardSpec = {
  title: 'ภาพรวมยอดขายและประเด็นติดตาม — 2026-10-01',
  description: 'ภาพรวมรายสาขาสำหรับผู้บริหาร',
  scope: { region: 'east', date: '2026-10-01', branchIds: ['b-east-01', 'b-east-02'] },
  widgets: [
    { type: 'metric', title: 'ยอดขายสุทธิ', metric: 'net_sales' },
    { type: 'metric', title: 'เป้าหมาย', metric: 'target' },
    { type: 'metric', title: 'ส่วนต่าง', metric: 'gap' },
    { type: 'metric', title: 'ผลสำเร็จ', metric: 'achievement' },
    { type: 'metric', title: 'ปัญหาสต็อก', metric: 'stock_issues' },
    { type: 'metric', title: 'เหตุการณ์', metric: 'incident_count' },
    { type: 'metric', title: 'กำลังคนจริง', metric: 'staffing_actual' },
    { type: 'bar_chart', title: 'ยอดขายเทียบเป้าหมาย', metric: 'net_sales', comparisonMetric: 'target', groupBy: 'branch' },
    { type: 'line_chart', title: 'ส่วนต่างรายสาขา', metric: 'gap', groupBy: 'branch' },
    { type: 'table', title: 'รายละเอียดรายสาขา', dataset: 'branch_metrics' },
    { type: 'table', title: 'กำลังคน: แผนเทียบจริง', dataset: 'staffing' },
  ],
};

function expectPatchError(run: () => unknown, code: DashboardPatchError['code']): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(DashboardPatchError);
  expect(caught).toMatchObject({ code });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

describe('applyDashboardCreatePatch', () => {
  it('revises the Thai dashboard title and removes staffing while preserving the other ten widgets', () => {
    const result = applyDashboardCreatePatch(predecessor, {
      title: 'ติดตามยอดขายและสต็อก',
      widgetChange: { operation: 'remove', indexes: [10] },
    });

    expect(result.spec.title).toBe('ติดตามยอดขายและสต็อก');
    expect(result.spec.description).toBe(predecessor.description);
    expect(result.spec.scope).toEqual(predecessor.scope);
    expect(result.spec.widgets).toEqual(predecessor.widgets.slice(0, 10));
    expect(result.diff).toEqual([
      'เปลี่ยนชื่อ: "ภาพรวมยอดขายและประเด็นติดตาม — 2026-10-01" → "ติดตามยอดขายและสต็อก"',
      'ลบ: "กำลังคน: แผนเทียบจริง" [table; dataset=staffing] (ตำแหน่งเดิม 11)',
      'คงเดิม: 10 มุมมอง',
    ]);
    expect(result.spec).not.toBe(predecessor);
    expect(result.spec.scope).not.toBe(predecessor.scope);
    expect(result.spec.widgets).not.toBe(predecessor.widgets);
  });

  it('adds schema-valid widgets at a predecessor position and preserves unspecified scope fields', () => {
    const widget = { type: 'table', title: 'ประเด็นเปิด', dataset: 'open_incidents' } as const;
    const result = applyDashboardCreatePatch(predecessor, {
      description: 'สรุปติดตามประเด็นเปิด',
      scope: { date: '2026-10-02' },
      widgetChange: { operation: 'add', index: 3, widgets: [widget] },
    });

    expect(result.spec.widgets).toEqual([
      ...predecessor.widgets.slice(0, 3),
      widget,
      ...predecessor.widgets.slice(3),
    ]);
    expect(result.spec.scope).toEqual({ ...predecessor.scope, date: '2026-10-02' });
    expect(result.diff).toContain('เปลี่ยนคำอธิบาย: "ภาพรวมรายสาขาสำหรับผู้บริหาร" → "สรุปติดตามประเด็นเปิด"');
    expect(result.diff).toContain('เปลี่ยนวันที่: "2026-10-01" → "2026-10-02"');
    expect(result.diff).toContain('เพิ่ม: "ประเด็นเปิด" [table; dataset=open_incidents] (ลำดับใหม่ 4)');
    expect(result.diff).toContain('คงเดิม: 11 มุมมอง');
  });

  it('clears an explicit branch selection to all branches in the region without mutating the predecessor', () => {
    const original = structuredClone(predecessor);
    const result = applyDashboardCreatePatch(predecessor, { scope: { branchIds: null } });

    expect(result.spec.scope).toEqual({ region: 'east', date: '2026-10-01' });
    expect(Object.hasOwn(result.spec.scope, 'branchIds')).toBe(false);
    expect(predecessor).toEqual(original);
    expect(result.diff).toContain('เปลี่ยนสาขา: ["b-east-01","b-east-02"] → ทุกสาขาในภาค');
  });

  it('treats a branch selection reordered with the same members as a no-op', () => {
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, { scope: { branchIds: ['b-east-02', 'b-east-01'] } }),
      'no_effect',
    );
    expect(predecessor.scope.branchIds).toEqual(['b-east-01', 'b-east-02']);
  });

  it('preserves predecessor branch order and omits a false scope diff when another field changes', () => {
    const result = applyDashboardCreatePatch(predecessor, {
      title: 'ชื่อใหม่',
      scope: { branchIds: ['b-east-02', 'b-east-01'] },
    });

    expect(result.spec.title).toBe('ชื่อใหม่');
    expect(result.spec.scope.branchIds).toEqual(['b-east-01', 'b-east-02']);
    expect(result.diff).toEqual(['เปลี่ยนชื่อ: "ภาพรวมยอดขายและประเด็นติดตาม — 2026-10-01" → "ชื่อใหม่"', 'คงเดิม: 11 มุมมอง']);
  });

  it('replaces predecessor-indexed widgets without shifting later targets', () => {
    const result = applyDashboardCreatePatch(predecessor, {
      widgetChange: {
        operation: 'replace',
        replacements: [
          { index: 1, widget: { type: 'metric', title: 'เป้าหมายสาขา', metric: 'target' } },
          { index: 3, widget: { type: 'metric', title: 'อัตราถึงเป้าหมาย', metric: 'achievement' } },
        ],
      },
    });

    expect(result.spec.widgets[1]).toEqual({ type: 'metric', title: 'เป้าหมายสาขา', metric: 'target' });
    expect(result.spec.widgets[3]).toEqual({ type: 'metric', title: 'อัตราถึงเป้าหมาย', metric: 'achievement' });
    expect(result.spec.widgets[4]).toEqual(predecessor.widgets[4]);
    expect(result.diff).toContain('แทนที่: "เป้าหมาย" [metric; metric=target] → "เป้าหมายสาขา" [metric; metric=target] (ตำแหน่งเดิม 2)');
    expect(result.diff).toContain('คงเดิม: 9 มุมมอง');
  });

  it('reorders only by a full predecessor-index permutation', () => {
    const result = applyDashboardCreatePatch(predecessor, {
      widgetChange: { operation: 'reorder', order: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] },
    });

    expect(result.spec.widgets).toEqual([...predecessor.widgets].reverse());
    expect(result.diff[0]).toMatch(/^เรียงลำดับมุมมองใหม่:/);
    expect(result.diff).toContain('คงเดิม: 11 มุมมอง');
  });

  it('does not mutate or alias the predecessor or patch', () => {
    const base = freezeDeep(structuredClone(predecessor));
    const patch = freezeDeep({
      title: 'ฉบับใหม่',
      scope: { branchIds: ['b-east-01'] },
      widgetChange: { operation: 'remove' as const, indexes: [10] },
    });
    const original = structuredClone(base);

    const result = applyDashboardCreatePatch(base, patch);

    expect(base).toEqual(original);
    expect(result.spec).not.toBe(base);
    expect(result.spec.scope).not.toBe(base.scope);
    expect(result.spec.widgets).not.toBe(base.widgets);
    expect(result.spec.widgets[0]).not.toBe(base.widgets[0]);
  });

  it('rejects unknown fields, empty patches, and combined contradictory widget operation fields', () => {
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { title: 'New', debug: true }), 'invalid_patch');
    expectPatchError(() => applyDashboardCreatePatch(predecessor, {}), 'invalid_patch');
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, {
        widgetChange: { operation: 'remove', indexes: [0], widgets: [{ type: 'text_summary', title: 'เพิ่ม' }] },
      }),
      'invalid_patch',
    );
  });

  it('rejects empty or unknown scope changes and no-op revisions', () => {
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { scope: {} }), 'invalid_patch');
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { scope: { region: 'east', branchId: 'x' } }), 'invalid_patch');
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { scope: { branchIds: [] } }), 'invalid_patch');
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, { scope: { branchIds: ['b-east-01', 'b-east-01'] } }),
      'invalid_patch',
    );
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { scope: { branchIds: [''] } }), 'invalid_patch');
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { scope: { branchIds: ['   '] } }), 'invalid_patch');
    expectPatchError(() => applyDashboardCreatePatch(predecessor, { title: predecessor.title }), 'no_effect');
  });

  it('rejects invalid predecessor indexes and duplicate indexes', () => {
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, { widgetChange: { operation: 'remove', indexes: [2, 2] } }),
      'invalid_patch',
    );
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, { widgetChange: { operation: 'remove', indexes: [11] } }),
      'widget_index_out_of_range',
    );
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, {
        widgetChange: {
          operation: 'replace',
          replacements: [
            { index: 2, widget: { type: 'text_summary', title: 'หนึ่ง' } },
            { index: 2, widget: { type: 'text_summary', title: 'สอง' } },
          ],
        },
      }),
      'invalid_patch',
    );
  });

  it('rejects a reorder that is not a full permutation', () => {
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, {
        widgetChange: { operation: 'reorder', order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9] },
      }),
      'invalid_widget_permutation',
    );
  });

  it('rejects semantic duplicate widgets even when their display titles differ', () => {
    expectPatchError(
      () => applyDashboardCreatePatch(predecessor, {
        widgetChange: {
          operation: 'add',
          index: 0,
          widgets: [{ type: 'metric', title: 'ยอดขายอีกครั้ง', metric: 'net_sales' }],
        },
      }),
      'duplicate_widget',
    );
  });

  it('rejects additions above twelve widgets without truncating the candidate', () => {
    const base = {
      ...predecessor,
      widgets: [
        ...predecessor.widgets,
        { type: 'text_summary' as const, title: 'ข้อเท็จจริงเพิ่มเติม' },
      ],
    };

    expect(base.widgets).toHaveLength(12);
    expectPatchError(
      () => applyDashboardCreatePatch(base, {
        widgetChange: {
          operation: 'add',
          index: 12,
          widgets: [
            { type: 'text_summary', title: 'สรุปใหม่' },
            { type: 'table', title: 'สต็อก', dataset: 'inventory' },
          ],
        },
      }),
      'widget_limit_exceeded',
    );
  });

  it('rejects non-dashboard action payloads instead of providing a generic action patch contract', () => {
    expectPatchError(
      () => applyDashboardCreatePatch(
        { kind: 'ticket_create' } as unknown as DashboardSpec,
        { title: 'แก้ไข' },
      ),
      'invalid_base',
    );
  });

  it('exposes service-layer requirements without claiming that this module enforces them', () => {
    expect(dashboardPatchServiceValidationHandoff.enforcedByThisModule).toBe(false);
    expect(dashboardPatchServiceValidationHandoff.requirements).toContain(
      'Verify every resulting widget is supported by the active renderer and its authorized evidence source.',
    );
    expect(dashboardPatchServiceValidationHandoff.requirements).toContain(
      'Atomically create the replacement with a fresh ID, payload hash, evidence version, and expiry while making the predecessor non-confirmable; reject a confirmation-versus-revision race if the predecessor changed.',
    );
  });
});
