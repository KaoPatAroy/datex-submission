import type { Actor, Analysis, Branch, BranchMetric, Evidence, Incident, Inventory, Reader, SalesOrder, SalesTarget, Scope, SourceRef, Staffing } from '../../contracts';
import { scopeSchema } from '../../contracts';
import { authorizedScope, canRegion, requirePermission } from '../../core/auth';
import { digest } from '../../core/utils';
import {salesPack} from '../sales';
import {operationsPack} from '../operations';

/** Code-point id order: the evidence version must not depend on the storage engine's row order or collation. */
const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function readEvidence(reader: Reader, actor: Actor, input: Scope, now = new Date()): Promise<Evidence> {
  requirePermission(actor,'sales.read');
  requirePermission(actor,'operations.read');
  const parsed=scopeSchema.parse(input),registeredBranches=await reader.list<Branch>('branches');
  const regionIds=[...new Set(registeredBranches.map(branch=>branch.region))];
  const matches=regionIds.filter(region=>region.toLowerCase()===parsed.region.toLowerCase());
  const region=parsed.region.toLowerCase()==='all'?'all':regionIds.includes(parsed.region)?parsed.region:matches.length===1?matches[0]:parsed.region;
  const scope = authorizedScope(actor, {...parsed,region});
  requirePermission(actor, 'operations.read');
  const requestedBranches = registeredBranches.filter(b => (scope.region === 'all' || b.region === scope.region) && (!scope.branchIds || scope.branchIds.includes(b.id)));
  const branches = requestedBranches.filter(b => canRegion(actor, b.region));
  if (scope.branchIds || branches.length !== requestedBranches.length) scope.branchIds = branches.map(branch => branch.id);
  const ids = new Set(branches.map(b => b.id));
  const [sales, targets, inventories, incidents, staffing] = await Promise.all([
    reader.list<SalesOrder>('sales_orders',{date:scope.date,branchId:[...ids]}), reader.list<SalesTarget>('sales_targets',{date:scope.date,branchId:[...ids]}), reader.list<Inventory>('inventory_snapshots',{date:scope.date,branchId:[...ids]}), reader.list<Incident>('incidents',{date:scope.date,branchId:[...ids]}), reader.list<Staffing>('staffing_summaries',{date:scope.date,branchId:[...ids]})
  ]);
  const selected = <T extends { branchId: string; date: string }>(rows: T[]) => rows.filter(row => ids.has(row.branchId) && row.date === scope.date);
  const ss = selected(sales), tt = selected(targets), ii = selected(inventories), nn = selected(incidents), ff = selected(staffing);
  const asOf = new Date(`${scope.date}T23:59:59+07:00`).toISOString();
  const sources: SourceRef[] = [], warnings: string[] = [];
  const freshnessMinutes = Math.min(...[salesPack,operationsPack].flatMap(pack => pack.metrics.map(m => m.freshnessMinutes)), 1440);
  const source = (system: string, branch: Branch, rows: { updatedAt: string; observedAt?: string }[]): string => {
    const id = `${system}:${branch.id}:${scope.date}`;
    const observedAt = rows.map(r => r.observedAt ?? r.updatedAt).sort((a,b) => new Date(a).getTime()-new Date(b).getTime()).at(-1) ?? '';
    const observed = new Date(observedAt).getTime(), cutoff = new Date(asOf).getTime();
    const freshness = !rows.length || !Number.isFinite(observed) ? 'missing' : observed > cutoff ? 'misaligned' : cutoff - observed > freshnessMinutes * 60_000 ? 'stale' : 'fresh';
    sources.push({ id, system, observedAt, retrievedAt: now.toISOString(), freshness, detail: `${branch.name} · ${scope.date} · ${rows.length} records` });
    if (freshness !== 'fresh' && system !== 'incidents') warnings.push(`${branch.name}: ${system} ${freshness}`);
    return id;
  };
  const metrics: BranchMetric[] = branches.map(branch => {
    const orders = ss.filter(r => r.branchId === branch.id), targetRows = tt.filter(r => r.branchId === branch.id), stock = ii.filter(r => r.branchId === branch.id), events = nn.filter(r => r.branchId === branch.id), roster = ff.filter(r => r.branchId === branch.id);
    const paidSatang = orders.filter(r => r.status === 'paid').reduce((sum,r) => sum + r.amountSatang, 0);
    const targetSatang = targetRows.reduce((sum,r) => sum + r.amountSatang, 0);
    const netSales=paidSatang/100,target=targetSatang/100;
    const sourceIds = [source('sales',branch,orders), source('targets',branch,targetRows), source('inventory',branch,stock), source('incidents',branch,events), source('staffing',branch,roster)];
    const compatibleEvents = events.filter(r => new Date(r.startedAt).getTime() <= new Date(asOf).getTime());
    return { branchId: branch.id, branchName: branch.name, region: branch.region, netSales, target, gap: (paidSatang-targetSatang)/100, achievement: target ? Math.round(netSales / target * 10000) / 100 : null, stockIssues: stock.filter(r => r.onHand < r.minimum && new Date(r.observedAt).getTime() <= new Date(asOf).getTime()).length, incidentCount: compatibleEvents.filter(r => r.status === 'open').length, staffingPlanned: roster.reduce((sum,r) => sum+r.planned,0), staffingActual: roster.reduce((sum,r) => sum+r.actual,0), incidents: compatibleEvents, sourceIds };
  });
  const paidTotal=ss.filter(r=>r.status==='paid').reduce((sum,r)=>sum+r.amountSatang,0),targetTotal=tt.reduce((sum,r)=>sum+r.amountSatang,0);
  const netSales=paidTotal/100,target=targetTotal/100;
  return { scope, asOf, version: digest({ scope, branches, asOf, sourceState:sources.map(({ id, system, observedAt, freshness, detail })=>({ id, system, observedAt, freshness, detail })), sales: byId(ss), targets: byId(tt), inventories: byId(ii), incidents: byId(nn), staffing: byId(ff) }), branches: metrics, totals: { netSales, target, gap: (paidTotal-targetTotal)/100, achievement: target ? Math.round(netSales/target*10000)/100 : null }, sources, warnings };
}

export function deterministicAnalysis(evidence: Evidence, now = new Date()): Analysis {
  const money = (n: number) => n.toLocaleString('th-TH',{maximumFractionDigits:2});
  const poor = evidence.branches.filter(b => b.gap < 0), facts = evidence.branches.map(b => ({ text: `${b.branchName}: ยอดขาย ${money(b.netSales)} บาท เป้า ${money(b.target)} บาท ส่วนต่าง ${money(b.gap)} บาท (${b.achievement === null ? 'ไม่มีเป้า' : `${b.achievement}%`})`, sourceIds: b.sourceIds.filter(id => id.startsWith('sales:') || id.startsWith('targets:')) }));
  const relationships: Analysis['relationships'] = [], hypotheses: Analysis['hypotheses'] = [], missingEvidence: Analysis['missingEvidence'] = [];
  for (const b of poor) {
    const compatibleStock = evidence.sources.find(s => s.id === b.sourceIds.find(id => id.startsWith('inventory:')))?.freshness === 'fresh';
    if (b.stockIssues && compatibleStock) { relationships.push({text:`${b.branchName} ต่ำกว่าเป้าพร้อมสต็อกต่ำกว่าเกณฑ์ ${b.stockIssues} รายการ เป็นความสัมพันธ์ ไม่ใช่ข้อพิสูจน์สาเหตุ`,sourceIds:b.sourceIds.filter(id=>id.startsWith('sales:')||id.startsWith('inventory:'))}); hypotheses.push({text:`การขาดสต็อกอาจมีส่วนต่อยอดขายของ ${b.branchName} ต้องตรวจยอดความต้องการที่สูญเสียเพิ่มเติม`,sourceIds:b.sourceIds.filter(id=>id.startsWith('inventory:'))}); }
    if (b.incidentCount) { relationships.push({text:`${b.branchName} มี Incident เปิด ${b.incidentCount} รายการในช่วงข้อมูลเดียวกัน`,sourceIds:b.sourceIds.filter(id=>id.startsWith('sales:')||id.startsWith('incidents:'))}); hypotheses.push({text:`Incident อาจกระทบการดำเนินงานของ ${b.branchName} แต่ยังไม่มีหลักฐานยืนยันมูลค่ายอดขายที่สูญเสีย`,sourceIds:b.sourceIds.filter(id=>id.startsWith('incidents:'))}); }
    missingEvidence.push({text:`${b.branchName}: ยังไม่มีข้อมูล lost demand / conversion เพื่อยืนยันสาเหตุ${!b.stockIssues&&!b.incidentCount?' และยังไม่พบปัจจัยร่วมจากแหล่งข้อมูลที่มี':''}`,sourceIds:b.sourceIds});
  }
  for (const b of evidence.branches.filter(b=>b.gap>=0&&b.incidentCount)) relationships.push({text:`ตัวอย่างโต้แย้ง: ${b.branchName} ถึงเป้าแม้มี Incident จึงสรุปไม่ได้ว่า Incident ทำให้ทุกสาขาต่ำกว่าเป้า`,sourceIds:b.sourceIds.filter(id=>id.startsWith('sales:')||id.startsWith('incidents:'))});
  for (const warning of evidence.warnings) missingEvidence.push({text:warning,sourceIds:[]});
  if (!evidence.branches.length) missingEvidence.push({text:'ไม่พบสาขาในขอบเขตที่ได้รับอนุญาต',sourceIds:[]});
  return { facts, relationships, hypotheses, missingEvidence, generatedAt: now.toISOString(), evidenceVersion: evidence.version };
}
