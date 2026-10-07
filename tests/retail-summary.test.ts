import { describe, expect, it } from 'vitest';
import type { Evidence, SourceRef } from '../lib/contracts';
import { summarizeRetailEvidence } from '../lib/packs/retail/summary';

const DATE = '2026-10-01';

function source(system: 'sales' | 'targets', branchId: string, branchName: string, freshness: SourceRef['freshness'] = 'fresh', date = DATE): SourceRef {
  return {
    id: `${system}:${branchId}:${date}`,
    system,
    observedAt: '2026-10-01T16:59:55.000Z',
    retrievedAt: '2026-10-02T05:00:00.000Z',
    freshness,
    detail: `${branchName} · ${date} · ${system === 'sales' ? '2 sales records' : '1 target record'}`,
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    scope: { region: 'east', date: DATE, branchIds: ['E02'] },
    asOf: '2026-10-01T16:59:59.000Z',
    version: 'fixture-version',
    // Deliberately disagree with totals: the summary contract is totals-based.
    branches: [{
      branchId: 'E02', branchName: 'East Two', region: 'east',
      netSales: 999_999, target: 999_999, gap: 0, achievement: 100,
      stockIssues: 0, incidentCount: 0, staffingPlanned: 0, staffingActual: 0,
      incidents: [], sourceIds: [`sales:E02:${DATE}`, `targets:E02:${DATE}`],
    }],
    totals: { netSales: 1_500, target: 2_000, gap: -500, achievement: 75 },
    sources: [source('sales', 'E02', 'East Two'), source('targets', 'E02', 'East Two')],
    warnings: [],
    ...overrides,
  };
}

function summaryOf(value: Evidence): string {
  const summary = summarizeRetailEvidence(value);
  if (!summary) throw new Error('The test evidence should produce a retail sales summary.');
  return summary;
}

describe('server-owned retail sales summary', () => {
  it('uses the scoped totals and source names to produce different Thai answers for different evidence', () => {
    const first = summaryOf(evidence());
    const second = summaryOf(evidence({
      scope: { region: 'south', date: '2026-10-02', branchIds: ['S07'] },
      totals: { netSales: 87_654.25, target: 80_000, gap: 7_654.25, achievement: 109.57 },
      branches: [{
        branchId: 'S07', branchName: 'South Seven', region: 'south',
        netSales: 1, target: 2, gap: -1, achievement: 50,
        stockIssues: 0, incidentCount: 0, staffingPlanned: 0, staffingActual: 0,
        incidents: [], sourceIds: ['sales:S07:2026-10-02', 'targets:S07:2026-10-02'],
      }],
      sources: [
        source('sales', 'S07', 'South Seven', 'fresh', '2026-10-02'),
        source('targets', 'S07', 'South Seven', 'fresh', '2026-10-02'),
      ],
    }));

    expect(first).toContain('East Two');
    expect(first).toContain('ยอดขายจริง');
    expect(first).toContain('เป้าหมายยอดขาย');
    expect(first).toContain('ภาคตะวันออก');
    expect(first).toContain('1 ตุลาคม 2569');
    expect(first).toMatch(/1,500(?:\.00)?/);
    expect(first).toMatch(/2,000(?:\.00)?/);
    expect(first).toContain('ต่ำกว่าเป้า');
    expect(first).not.toContain('999,999');

    expect(second).toContain('South Seven');
    expect(second).toContain('ยอดขายจริง');
    expect(second).toContain('เป้าหมายยอดขาย');
    expect(second).toContain('ภาคใต้');
    expect(second).toContain('2 ตุลาคม 2569');
    expect(second).toContain('87,654.25');
    expect(second).toContain('80,000');
    expect(second).toContain('สูงกว่าเป้า');
    expect(second).not.toBe(first);
  });

  it.each([
    { label: 'positive gap', netSales: 1_200, target: 1_000, gap: 200, wording: 'สูงกว่าเป้า' },
    { label: 'negative gap', netSales: 800, target: 1_000, gap: -200, wording: 'ต่ำกว่าเป้า' },
    { label: 'zero gap', netSales: 1_000, target: 1_000, gap: 0, wording: 'ตรงเป้า' },
  ])('describes the $label based on the signed total gap', ({ netSales, target, gap, wording }) => {
    const text = summaryOf(evidence({
      totals: { netSales, target, gap, achievement: target ? netSales / target * 100 : null },
    }));

    expect(text).toContain(wording);
  });

  it('does not invent a sales figure when the sales source is missing', () => {
    const text = summarizeRetailEvidence(evidence({ sources: [source('targets', 'E02', 'East Two')] }));

    expect(text).toMatch(/ยอดขาย.*(?:ยืนยัน|ตรวจสอบ)|(?:ยืนยัน|ตรวจสอบ).*ยอดขาย/);
    expect(text).not.toMatch(/[\d,]+(?:\.\d+)?\s*บาท/);
    expect(text).not.toContain('1,500');
    expect(text).not.toContain('999,999');
  });

  it('reports an unavailable target comparison when the target source is missing', () => {
    const text = summaryOf(evidence({ sources: [source('sales', 'E02', 'East Two')] }));

    expect(text).toContain('East Two');
    expect(text).toContain('ยอดขายจริง');
    expect(text).toContain('1,500');
    expect(text).not.toContain('2,000');
    expect(text).not.toMatch(/สูงกว่าเป้า|ต่ำกว่าเป้า|ตรงเป้า/);
    expect(text).toMatch(/เป้าหมาย.*(?:ไม่ได้|ไม่ครบ|ไม่พบ|ไม่มี)/);
  });

  it('surfaces stale warnings and excludes source names outside the restricted scope', () => {
    const text = summaryOf(evidence({
      scope: { region: 'east', date: DATE, branchIds: ['E02'] },
      sources: [
        source('sales', 'E02', 'East Two', 'stale'),
        source('targets', 'E02', 'East Two'),
        source('sales', 'C01', 'Central Confidential Branch'),
        source('targets', 'C01', 'Central Confidential Branch'),
      ],
      warnings: ['East Two: sales stale'],
    }));

    expect(text).toContain('East Two');
    expect(text).toContain('ยอดขายจริง');
    expect(text).toContain('ภาคตะวันออก');
    expect(text).toMatch(/ไม่เป็นปัจจุบัน|ไม่ครบ/);
    expect(text).not.toContain('Central Confidential Branch');
    expect(text).not.toContain('C01');
  });
});
