import { describe, expect, it } from 'vitest';
import type { Analysis, BranchMetric, Evidence, Freshness, SourceRef } from '../lib/contracts';
import { deterministicAnalysis } from '../lib/packs/retail/evidence';
import { limitRetailClaims, retailEvidenceCoverage, usableBranchSource } from '../lib/packs/retail/coverage';
import { summarizeRetailEvidence } from '../lib/packs/retail/summary';

const DATE = '2026-10-01';
type RefState = Freshness | 'absent';
type BranchState = { id: string; name: string; sales: RefState; target: RefState };

function branchMetric(id: string, name: string, sourceIds: string[]): BranchMetric {
  return {
    branchId: id,
    branchName: name,
    region: 'east',
    netSales: id === 'E02' ? 400 : 200,
    target: id === 'E02' ? 500 : 100,
    gap: id === 'E02' ? -100 : 100,
    achievement: id === 'E02' ? 80 : 200,
    stockIssues: id === 'E02' ? 1 : 0,
    incidentCount: id === 'E02' ? 1 : 0,
    staffingPlanned: 5,
    staffingActual: 3,
    incidents: [],
    sourceIds,
  };
}

function source(system: 'sales' | 'targets', branchId: string, branchName: string, freshness: Freshness): SourceRef {
  return {
    id: `${system}:${branchId}:${DATE}`,
    system,
    observedAt: '2026-10-01T16:59:55.000Z',
    retrievedAt: '2026-10-02T05:00:00.000Z',
    freshness,
    detail: `${branchName} · ${DATE} · ${system} evidence`,
  };
}

function evidence(states: BranchState[], extraSources: SourceRef[] = [], totals: Evidence['totals'] = {
  netSales: 12_345,
  target: 5_432,
  gap: 6_913,
  achievement: 227.32,
}): Evidence {
  const branches = states.map(({ id, name }) => branchMetric(id, name, [
    `sales:${id}:${DATE}`,
    `targets:${id}:${DATE}`,
  ]));
  const sources = states.flatMap(({ id, name, sales, target }) => [
    ...(sales === 'absent' ? [] : [source('sales', id, name, sales)]),
    ...(target === 'absent' ? [] : [source('targets', id, name, target)]),
  ]);

  return {
    scope: { region: 'east', date: DATE, branchIds: states.map(({ id }) => id) },
    asOf: '2026-10-01T16:59:59.000Z',
    version: 'coverage-fixture-version',
    branches,
    totals,
    sources: [...sources, ...extraSources],
    warnings: [],
  };
}

function analysisFor(value: Evidence): Analysis {
  return deterministicAnalysis(value, new Date('2026-10-02T05:00:00.000Z'));
}

function exposedClaims(analysis: Analysis): string[] {
  return [...analysis.facts, ...analysis.relationships, ...analysis.hypotheses].map(claim => claim.text);
}

describe('usable retail branch sources', () => {
  it('returns the unique fresh source authorized by the selected branch', () => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' }]);
    const expected = value.sources.find(ref => ref.id === 'sales:E02:2026-10-01');

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBe(expected);
  });

  it.each(['fresh', 'stale'] as const)('accepts a correctly linked E01 source with %s freshness', freshness => {
    const value = evidence([{ id: 'E01', name: 'East One', sales: freshness, target: 'fresh' }]);

    expect(usableBranchSource(value, value.branches[0], 'sales')).toMatchObject({
      id: 'sales:E01:2026-10-01',
      freshness,
    });
  });

  it('rejects an E01 branch linked to another branch source ID', () => {
    const value = evidence(
      [{ id: 'E01', name: 'East One', sales: 'absent', target: 'fresh' }],
      [source('sales', 'C01', 'Central One', 'fresh')],
    );
    const salesIdIndex = value.branches[0].sourceIds.indexOf('sales:E01:2026-10-01');
    value.branches[0].sourceIds[salesIdIndex] = 'sales:C01:2026-10-01';

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('rejects an E01 source ID for a different evidence date', () => {
    const wrongDateId = 'sales:E01:2026-09-30';
    const value = evidence(
      [{ id: 'E01', name: 'East One', sales: 'absent', target: 'fresh' }],
      [{ ...source('sales', 'E01', 'East One', 'fresh'), id: wrongDateId }],
    );
    const salesIdIndex = value.branches[0].sourceIds.indexOf('sales:E01:2026-10-01');
    value.branches[0].sourceIds[salesIdIndex] = wrongDateId;

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('does not borrow a source returned for another branch', () => {
    const value = evidence(
      [{ id: 'E02', name: 'East Two', sales: 'absent', target: 'fresh' }],
      [source('sales', 'C01', 'Central One', 'fresh')],
    );

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('fails closed when the branch source reference is missing or unresolved', () => {
    const missing = evidence([{ id: 'E02', name: 'East Two', sales: 'absent', target: 'fresh' }]);
    const unresolved = evidence([{ id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' }]);
    unresolved.sources = unresolved.sources.filter(ref => ref.id !== 'sales:E02:2026-10-01');

    expect(usableBranchSource(missing, missing.branches[0], 'sales')).toBeUndefined();
    expect(usableBranchSource(unresolved, unresolved.branches[0], 'sales')).toBeUndefined();
  });

  it('fails closed when a linked reference belongs to another system', () => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' }]);
    const salesRef = value.sources.find(ref => ref.id === 'sales:E02:2026-10-01')!;
    salesRef.system = 'targets';

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it.each(['misaligned', 'missing'] as const)('fails closed for %s freshness', freshness => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: freshness, target: 'fresh' }]);

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it.each(['sales', 'targets'] as const)('fails closed when a source ID is duplicated across %s references', duplicateSystem => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' }]);
    const original = value.sources.find(ref => ref.id === 'sales:E02:2026-10-01')!;
    value.sources.push({ ...original, system: duplicateSystem });

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('fails closed when a branch links multiple sources for the requested system', () => {
    const value = evidence([
      { id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' },
      { id: 'E03', name: 'East Three', sales: 'fresh', target: 'fresh' },
    ]);
    value.branches[0].sourceIds.push('sales:E03:2026-10-01');

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('fails closed when the branch repeats a source ID', () => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' }]);
    value.branches[0].sourceIds.push('sales:E02:2026-10-01');

    expect(usableBranchSource(value, value.branches[0], 'sales')).toBeUndefined();
  });

  it('returns a stale source so callers can expose its freshness limitation', () => {
    const value = evidence([{ id: 'E02', name: 'East Two', sales: 'stale', target: 'fresh' }]);
    const usable = usableBranchSource(value, value.branches[0], 'sales');

    expect(usable).toMatchObject({ id: 'sales:E02:2026-10-01', freshness: 'stale' });
  });
});

describe('retail evidence coverage gates', () => {
  it.each([
    { label: 'missing sales reference', sales: 'absent' as const },
    { label: 'explicitly missing sales reference', sales: 'missing' as const },
    { label: 'misaligned sales reference', sales: 'misaligned' as const },
  ])('suppresses aggregate sales comparisons and unsupported claims with one $label', ({ sales }) => {
    const value = evidence([
      { id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' },
      { id: 'E03', name: 'East Three', sales, target: 'fresh' },
    ]);
    const coverage = retailEvidenceCoverage(value);
    const limited = limitRetailClaims(value, analysisFor(value));
    const text = summarizeRetailEvidence(value);

    expect(coverage).toMatchObject({
      salesComplete: false,
      targetComplete: true,
      display: { sales: false, target: true, gap: false, achievement: false },
      salesPartial: true,
      targetPartial: false,
      partial: true,
      limited: true,
    });
    expect(limited.facts).toEqual([]);
    expect(limited.relationships).toEqual([]);
    expect(limited.hypotheses).toEqual([]);
    expect(limited.missingEvidence.length).toBeGreaterThan(0);
    expect(exposedClaims(limited).join(' ')).not.toMatch(/12,345|6,913|227\.32/);
    expect(text).not.toContain('12,345');
    expect(text).not.toContain('6,913');
    expect(text).not.toContain('227.32');
  });

  it('keeps verified aggregate sales while hiding comparison when target coverage is incomplete', () => {
    const value = evidence([
      { id: 'E02', name: 'East Two', sales: 'fresh', target: 'fresh' },
      { id: 'E03', name: 'East Three', sales: 'fresh', target: 'misaligned' },
    ]);
    const coverage = retailEvidenceCoverage(value);
    const text = summarizeRetailEvidence(value);
    const limited = limitRetailClaims(value, analysisFor(value));

    expect(coverage).toMatchObject({
      salesComplete: true,
      targetComplete: false,
      display: { sales: true, target: false, gap: false, achievement: false },
      salesPartial: false,
      targetPartial: true,
      partial: true,
      limited: true,
    });
    expect(text).toContain('12,345.00');
    expect(text).not.toContain('5,432.00');
    expect(text).not.toContain('6,913.00');
    expect(text).not.toContain('227.32');
    expect(text).toMatch(/ไม่สามารถเทียบเป้าหมาย|ข้อมูลเป้าหมายไม่ครบ/);
    expect(limited.facts).toEqual([]);
    expect(limited.relationships).toEqual([]);
    expect(limited.hypotheses).toEqual([]);
  });

  it('hides all metrics and claims for empty or wholly missing evidence', () => {
    const empty = evidence([], [], { netSales: 0, target: 0, gap: 0, achievement: null });
    const missing = evidence([
      { id: 'E02', name: 'East Two', sales: 'missing', target: 'missing' },
      { id: 'E03', name: 'East Three', sales: 'absent', target: 'absent' },
    ], [], { netSales: 0, target: 0, gap: 0, achievement: null });

    for (const value of [empty, missing]) {
      const coverage = retailEvidenceCoverage(value);
      const limited = limitRetailClaims(value, analysisFor(value));
      expect(coverage).toMatchObject({
        salesComplete: false,
        targetComplete: false,
        display: { sales: false, target: false, gap: false, achievement: false },
        limited: true,
      });
      expect(limited.facts).toEqual([]);
      expect(limited.relationships).toEqual([]);
      expect(limited.hypotheses).toEqual([]);
      expect(summarizeRetailEvidence(value)).not.toMatch(/0(?:\.00)?\s*บาท/);
    }
  });

  it('keeps stale references usable, reports their freshness limit, and does not require a prefilled warning', () => {
    const value = evidence([
      { id: 'E02', name: 'East Two', sales: 'stale', target: 'fresh' },
      { id: 'E03', name: 'East Three', sales: 'fresh', target: 'stale' },
    ]);
    const coverage = retailEvidenceCoverage(value);
    const text = summarizeRetailEvidence(value);

    expect(coverage).toMatchObject({
      salesComplete: true,
      targetComplete: true,
      display: { sales: true, target: true, gap: true, achievement: true },
      salesStale: true,
      targetStale: true,
      stale: true,
      partial: false,
      limited: true,
    });
    expect(text).toMatch(/ไม่เป็นปัจจุบัน|ล่าช้า|stale/iu);
  });

  it('does not let an out-of-scope source reference repair a missing scoped branch reference', () => {
    const value = evidence(
      [{ id: 'E02', name: 'East Two', sales: 'absent', target: 'fresh' }],
      [source('sales', 'C01', 'Central Confidential Branch', 'fresh')],
    );
    const coverage = retailEvidenceCoverage(value);
    const limited = limitRetailClaims(value, analysisFor(value));

    expect(value.scope.branchIds).toEqual(['E02']);
    expect(coverage.salesComplete).toBe(false);
    expect(coverage.targetComplete).toBe(true);
    expect(coverage.display).toEqual({ sales: false, target: true, gap: false, achievement: false });
    expect(limited.facts).toEqual([]);
    expect(exposedClaims(limited).join(' ')).not.toContain('Central Confidential Branch');
  });
});
