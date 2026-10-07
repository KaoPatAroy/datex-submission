import type { Branch, BranchMetric, Evidence, SourceRef } from '../../lib/contracts';
import { createSemanticCatalog } from '../../lib/dynamic/catalog/semantic';
import type { QueryPlan, Span } from '../../lib/dynamic/plan/schemas';
import type { PlannerModel } from '../../lib/dynamic/planner/planner';
import { validateQueryPlan, type AcceptedPlan, type ActorAuthority, type Availability } from '../../lib/dynamic/validate/query-plan';
import { dateList } from '../../lib/dynamic/plan/time';
import type { EvidenceReader } from '../../lib/dynamic/compile/reader';

export const branches: Branch[] = [
  { id: 'E01', name: 'First branch', region: 'east' }, { id: 'E02', name: 'Second branch', region: 'east' },
  { id: 'S01', name: 'Third branch', region: 'south' }, { id: 'C01', name: 'Fourth branch', region: 'central' },
];
export const catalog = createSemanticCatalog(branches);
export const executive: ActorAuthority = { id: 'exec', active: true, regions: ['*'], permissions: ['sales.read', 'operations.read'], revision: 1 };
export const manager: ActorAuthority = { ...executive, id: 'manager', regions: ['east'] };
export const readAt = '2026-10-02T00:00:00Z';
export function span(text: string, part = text): Span {
  const start = text.indexOf(part);
  if (start < 0) throw new Error('Missing test span.');
  return { start, end: start + part.length, text: part };
}
export function proposal(text = 'Show sales'): QueryPlan {
  const measureText = text.match(/\b(?:stock issues|incident count|staffing actual|staffing planned|achievement|gap|target|sales)\b/i)?.[0] ?? text.slice(0, 20);
  return {
    planVersion: 1, planId: 'plan:1', datasetId: 'branch_performance',
    measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'explicit', sourceText: span(text, measureText), confidence: 1 } }],
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    filters: [], scope: null, time: null, grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null,
    group: { fieldIds: ['branch'] }, compare: null, sort: [], topN: null,
    completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
    clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
  };
}
export function filter(plan: QueryPlan, text: string, fieldId: string, value: string | number | null, part = text): QueryPlan {
  return { ...plan, filters: [...plan.filters, { fieldId, value, op: 'eq', sourceText: span(text, part), confidence: 1 }] };
}
export function ranking(text = 'Top sales', fieldId = 'net_sales', direction: 'highest' | 'lowest' = 'highest'): QueryPlan {
  const plan = proposal(text);
  plan.measures[0] = { ...plan.measures[0], fieldId, aggregation: fieldId === 'gap' ? 'gap' : 'sum',
    interpretation: { ...plan.measures[0].interpretation, value: fieldId } };
  plan.sort = [{ fieldId, direction: direction === 'highest' ? 'desc' : 'asc' }];
  plan.topN = { count: 2, direction, completeScopeRequired: true };
  plan.completeness.expectation = 'complete_authorized_population';
  return plan;
}
export function available(text = 'Show sales'): Availability {
  return { sourceText: text, businessDate: '2026-10-01', dates: dateList('2026-01-01', '2026-12-31', 366),
    branchIds: branches.map(b => b.id), sourceSystems: ['sales', 'targets', 'inventory', 'incidents', 'staffing'] };
}
export function accept(plan = proposal(), text = 'Show sales', authority = executive, availability = available(text)): AcceptedPlan {
  const result = validateQueryPlan(plan, catalog, authority, availability);
  if (result.outcome !== 'accepted') throw new Error(`Fixture failed: ${result.outcome}/${result.code}`);
  return result;
}
export function fakePlanner(plans: ReadonlyMap<string, QueryPlan>): PlannerModel {
  return async input => {
    const plan = plans.get(input.sourceText);
    if (!plan) throw new Error('No fixed model fixture.');
    return JSON.stringify({ ...plan, intentKind: input.previousState ? 'follow_up' : 'query', parentState: input.previousStateRef ?? null });
  };
}
export function metric(branch: Branch, date: string): BranchMetric {
  const netSales = { E01: 200, E02: 80, S01: 300, C01: 100 }[branch.id as 'E01'] ?? 50;
  const target = branch.id === 'E02' ? 200 : 100;
  return { branchId: branch.id, branchName: branch.name, region: branch.region, netSales, target, gap: netSales - target,
    achievement: Math.round(netSales / target * 10000) / 100, stockIssues: 2, incidentCount: 1,
    staffingActual: 4, staffingPlanned: 5, incidents: [],
    sourceIds: ['sales', 'targets', 'inventory', 'incidents', 'staffing'].map(system => `${system}:${branch.id}:${date}`) };
}
export function fakeEvidence(scope: Parameters<EvidenceReader>[0], registry = branches): Evidence {
  const rows = registry.filter(b => b.region === scope.region && (!scope.branchIds || scope.branchIds.includes(b.id))).map(b => metric(b, scope.date));
  const sources: SourceRef[] = rows.flatMap(row => row.sourceIds.map(id => ({ id, system: id.split(':')[0], observedAt: `${scope.date}T12:00:00+07:00`,
    retrievedAt: readAt, freshness: 'fresh', detail: 'Fixture source' })));
  return { scope, asOf: new Date(`${scope.date}T23:59:59+07:00`).toISOString(), version: `fixture:${scope.date}`,
    branches: rows, sources, warnings: [], totals: { netSales: 0, target: 0, gap: 0, achievement: null } };
}
