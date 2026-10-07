import type { Evidence } from '../../contracts';
import { sourceDisplayName } from '../../presentation/source-names';
import { retailEvidenceCoverage, usableBranchSource } from './coverage';

const money = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = new Intl.DateTimeFormat('th-TH', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok'
});

export function formatRetailMoney(value: number): string {
  return money.format(value);
}

export function retailDateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime()) ? thaiDate.format(value) : date;
}

/** A server-owned answer from authorized retail evidence, never from model-supplied figures. */
export function retailScopeLabel(evidence: Evidence): string {
  const regionNames: Record<string, string> = { east: 'ภาคตะวันออก', central: 'ภาคกลาง', south: 'ภาคใต้' };
  const region = evidence.scope.region === 'all'
    ? 'ทุกภูมิภาคที่บัญชีนี้มีสิทธิ์'
    : regionNames[evidence.scope.region.toLowerCase()] ?? `ภูมิภาค ${evidence.scope.region}`;
  const singleBranch = evidence.branches.length === 1 ? ` · ${evidence.branches[0].branchName}` : '';
  return `วันที่ ${retailDateLabel(evidence.scope.date)} (${region}, ${evidence.branches.length} สาขา${singleBranch})`;
}

export function summarizeRetailEvidence(evidence: Evidence): string {
  const scope = retailScopeLabel(evidence);
  const coverage = retailEvidenceCoverage(evidence);
  if (!coverage.display.sales) {
    return `${scope}: ยังไม่มีข้อมูลยอดขายที่ตรวจสอบได้ในขอบเขตนี้ โปรดตรวจรายละเอียดแหล่งข้อมูล`;
  }

  const parts = [`${scope}: ยอดขายสุทธิ ${money.format(evidence.totals.netSales)} บาท`];
  if (coverage.display.gap && coverage.display.target) {
    const comparison = evidence.totals.gap < 0 ? 'ต่ำกว่าเป้า' : evidence.totals.gap > 0 ? 'สูงกว่าเป้า' : 'ตรงเป้า';
    parts.push(`เทียบเป้าหมาย ${money.format(evidence.totals.target)} บาท ${comparison} ${money.format(Math.abs(evidence.totals.gap))} บาท`);
  } else {
    parts.push('ยังไม่สามารถเทียบเป้าหมายได้ เพราะข้อมูลเป้าหมายไม่ครบ');
  }

  const usedSystems = new Set(['sales', ...(coverage.display.gap ? ['targets'] : [])]);
  const names = [...usedSystems]
    .filter(system => evidence.branches.every(branch => usableBranchSource(evidence, branch, system)))
    .map(sourceDisplayName);
  if (names.length) parts.push(`แหล่งข้อมูล: ${names.join(' และ ')}`);
  const limited = evidence.warnings.length > 0 || coverage.limited;
  if (limited) parts.push('ข้อมูลบางแหล่งไม่เป็นปัจจุบันหรือไม่ครบ โปรดตรวจรายละเอียดหลักฐาน');
  return `${parts.join('. ')}.`;
}
