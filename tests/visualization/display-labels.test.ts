import { describe, expect, it } from 'vitest';
import { INTERACTION_IDS } from '@/lib/visualization/contracts';
import { displaySuitability, droppedInteractionsNote, estimateTextWidth, fitLabelLines, INTERACTION_LABELS_TH, placeScatterLabels } from '@/lib/visualization/presentation';
import { routerSectionsFor, showEmptyFilterNote } from '@/components/biztania/history-panel';
import { recipientDisplayName, thaiDateTime } from '@/lib/router/executors/director';

const RAW_ID = /\b(?:inspect_data|inspect_sources|select_point|tooltip|legend_toggle|cross_filter|drilldown|zoom_brush|reset)\b/;

describe('chart notes never show raw interaction ids', () => {
  it('every registered interaction has a Thai label (finite map)', () => {
    for (const id of INTERACTION_IDS) expect(INTERACTION_LABELS_TH[id]).toMatch(/[\u0E00-\u0E7F]/);
  });
  it('the dropped-interaction note is deduplicated Thai labels', () => {
    const note = droppedInteractionsNote(['zoom_brush', 'legend_toggle', 'zoom_brush']);
    expect(note).toBe('ข้อมูลชุดนี้ไม่รองรับ: ซูมช่วงข้อมูล, ซ่อน/แสดงชุดข้อมูล');
    expect(note).not.toMatch(RAW_ID);
  });
  it('a note persisted with raw ids is shown with Thai labels', () => {
    const shown = displaySuitability('กราฟวงกลม (ตัดการโต้ตอบที่ข้อมูลนี้ไม่รองรับ: legend_toggle, zoom_brush)');
    expect(shown).toBe('กราฟวงกลม (ข้อมูลชุดนี้ไม่รองรับ: ซ่อน/แสดงชุดข้อมูล, ซูมช่วงข้อมูล)');
    expect(displaySuitability('กราฟแท่งเหมาะกับการเปรียบเทียบค่าระหว่างกลุ่ม')).toBe('กราฟแท่งเหมาะกับการเปรียบเทียบค่าระหว่างกลุ่ม');
  });
});

describe('heatmap / treemap labels fit their cell', () => {
  it('a long column label wraps to two lines that each fit the cell width', () => {
    const lines = fitLabelLines('Demo East Branch 1', 90);
    expect(lines).toEqual(['Demo East', 'Branch 1']);
    for (const line of lines) expect(estimateTextWidth(line)).toBeLessThanOrEqual(90);
  });
  it('a label that cannot fit is clipped with an ellipsis, never overflowing', () => {
    const [line] = fitLabelLines('Demo East Branch 1 · 23.4%', 80, 1);
    expect(line.endsWith('…')).toBe(true);
    expect(estimateTextWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe('History empty-filter note', () => {
  it('is not shown above assistant results on the "all" filter', () => {
    expect(showEmptyFilterNote('all', 0, true)).toBe(false);
    expect(routerSectionsFor('all')).toEqual({ receipts: true, closed: true });
    expect(routerSectionsFor('failed')).toEqual({ receipts: false, closed: true, closedOutcome: 'not_completed' });
    expect(routerSectionsFor('expired')).toEqual({ receipts: false, closed: true, closedOutcome: 'expired' });
  });
  it('is shown only when the chosen filter has nothing at all', () => {
    expect(showEmptyFilterNote('pending', 0, true)).toBe(true);
    expect(showEmptyFilterNote('success', 0, true)).toBe(false);
    expect(showEmptyFilterNote('all', 0, false)).toBe(true);
    expect(showEmptyFilterNote('all', 2, true)).toBe(false);
  });
});

describe('Director receipts read as product copy', () => {
  it('timestamps are Thai Bangkok date-time, not ISO', () => {
    expect(thaiDateTime('2026-10-06T20:07:15.954Z')).toBe('7 ต.ค. 2569 03:07 น.');
  });
  it('seeded profile anchors show their Thai demo role', () => {
    expect(recipientDisplayName('Demo East Onboarding Manager V2 Profile Anchor')).toBe('ผู้จัดการ Onboarding ภาคตะวันออก (สาธิต)');
    expect(recipientDisplayName('สมชาย')).toBe('สมชาย');
  });
});

describe('scatter label collision avoidance', () => {
  it('skips a label whose box overlaps an already placed label, keeps separated ones', () => {
    const placed = placeScatterLabels([
      { cx: 100, cy: 100, text: 'สาขาบางนา' }, { cx: 100, cy: 100, text: 'สาขาเดียวกัน' }, { cx: 104, cy: 106, text: 'ใกล้มาก' },
      { cx: 100, cy: 160, text: 'ห่างออกไป' }, { cx: 590, cy: 100, text: 'ขอบขวา' },
    ], 640);
    expect(placed.map(p => p.visible)).toEqual([true, false, false, true, true]);
    expect(placed[4]).toMatchObject({ anchor: 'end', dx: -10 });
    expect(placed[0]).toMatchObject({ anchor: 'start', dx: 10 });
  });
});
