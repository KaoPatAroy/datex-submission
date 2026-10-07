import type { Analysis, BranchMetric, Evidence, SourceRef } from '../../contracts';

const coverageNotice = 'ข้อมูลยอดขายหรือเป้าหมายไม่ครบในขอบเขตนี้ จึงยังไม่แสดงข้อเท็จจริงหรือข้อสรุปที่อาศัยตัวเลขเหล่านั้น';

type RetailEvidenceCoverage = {
  salesComplete: boolean;
  targetComplete: boolean;
  display: {
    sales: boolean;
    target: boolean;
    gap: boolean;
    achievement: boolean;
  };
  salesStale: boolean;
  targetStale: boolean;
  salesPartial: boolean;
  targetPartial: boolean;
  stale: boolean;
  partial: boolean;
  limited: boolean;
};

export function usableBranchSource(evidence: Evidence, branch: BranchMetric, system: string): SourceRef | undefined {
  const matches = evidence.sources.filter(source => branch.sourceIds.includes(source.id) && source.system === system);
  if (matches.length !== 1) return undefined;

  const [source] = matches;
  if (source.id !== `${system}:${branch.branchId}:${evidence.scope.date}`) return undefined;
  const matchingIds = branch.sourceIds.filter(id => id === source.id);
  const returnedRefs = evidence.sources.filter(ref => ref.id === source.id);
  if (matchingIds.length !== 1 || returnedRefs.length !== 1) return undefined;
  if (source.freshness !== 'fresh' && source.freshness !== 'stale') return undefined;
  return source;
}

function linkedSources(evidence: Evidence, system: string): (SourceRef | undefined)[] {
  return evidence.branches.map(branch => usableBranchSource(evidence, branch, system));
}

function coverageFor(evidence: Evidence, system: string) {
  const sourcesByBranch = linkedSources(evidence, system);
  const complete = evidence.branches.length > 0 && sourcesByBranch.every(source => source !== undefined);
  const stale = sourcesByBranch.some(source => source?.freshness === 'stale');
  return { complete, stale };
}

export function retailEvidenceCoverage(evidence: Evidence): RetailEvidenceCoverage {
  const sales = coverageFor(evidence, 'sales');
  const target = coverageFor(evidence, 'targets');
  const salesPartial = !sales.complete;
  const targetPartial = !target.complete;
  const display = {
    sales: sales.complete && Number.isFinite(evidence.totals.netSales),
    target: target.complete && Number.isFinite(evidence.totals.target),
    gap: sales.complete && target.complete && Number.isFinite(evidence.totals.gap),
    achievement: sales.complete && target.complete && evidence.totals.achievement !== null && Number.isFinite(evidence.totals.achievement),
  };
  const stale = sales.stale || target.stale;
  const partial = salesPartial || targetPartial;

  return {
    salesComplete: sales.complete,
    targetComplete: target.complete,
    display,
    salesStale: sales.stale,
    targetStale: target.stale,
    salesPartial,
    targetPartial,
    stale,
    partial,
    limited: stale || partial,
  };
}

export function limitRetailClaims(evidence: Evidence, analysis: Analysis): Analysis {
  const coverage = retailEvidenceCoverage(evidence);
  if (coverage.salesComplete && coverage.targetComplete) return analysis;

  const missingEvidence = analysis.missingEvidence.some(claim => claim.text === coverageNotice)
    ? analysis.missingEvidence
    : [...analysis.missingEvidence, { text: coverageNotice, sourceIds: [] }];

  return {
    ...analysis,
    facts: [],
    relationships: [],
    hypotheses: [],
    missingEvidence,
  };
}
