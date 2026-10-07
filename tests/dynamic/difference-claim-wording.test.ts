import { describe, expect, it } from 'vitest';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { renderNumericClaim } from '@/lib/dynamic/runtime';
import type { NumericClaim } from '@/lib/dynamic/evidence/claim-graph';

const claim = (value: number): NumericClaim => ({
  id: 'claim_gap', kind: 'fact', measure: 'net_sales', value, unit: 'THB', dimensions: { comparison: 'difference' },
  rowRefs: [], sourceRefs: ['sales:E01:2026-10-01', 'targets:E01:2026-10-01'],
  computation: { calculatorId: 'difference', operation: 'difference', inputs: [] },
});

describe('difference claim wording (Production hosted acceptance: gap vs target rendered as a period change)', () => {
  const catalog = createSemanticCatalog([]);

  it('without the accepted comparison kind it states a neutral signed difference, never a previous-period change', () => {
    const text = renderNumericClaim(claim(-5310.09), catalog);
    expect(text).not.toContain('ช่วงก่อนหน้า');
    expect(text).toContain('ส่วนต่างเทียบค่าอ้างอิง -');
    expect(renderNumericClaim(claim(120), catalog)).toContain('ส่วนต่างเทียบค่าอ้างอิง +');
  });

  it('keeps the explicit target and period wording when the comparison kind is known', () => {
    expect(renderNumericClaim(claim(-5310.09), catalog, { kind: 'target', percentage: -18.3 })).toContain('ต่ำกว่าเป้าหมาย');
    expect(renderNumericClaim(claim(400), catalog, { kind: 'period', percentage: 40 })).toContain('เพิ่มขึ้นจากช่วงก่อนหน้า');
  });
});
