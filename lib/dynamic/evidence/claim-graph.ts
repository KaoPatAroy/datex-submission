import type { Ref } from '../plan/schemas';
import type { SemanticField } from '../catalog/semantic';
import { bundlePlan, type EvidenceBundle, type EvidenceRow } from './bundle';
import { acceptedContext, fieldById, matchesFilter } from '../validate/query-plan';
import { digest, freeze, unique } from '../shared';

export interface NumericClaim {
  id: string; kind: 'fact'; measure: string; value: number | null; unit: string;
  dimensions: Readonly<Record<string, string>>; rowRefs: readonly string[]; sourceRefs: readonly string[];
  computation: { calculatorId: string; operation: 'value' | 'sum' | 'avg' | 'latest' | 'max' | 'gap' | 'weighted_ratio' | 'difference' | 'rank'; inputs: readonly string[] };
  caveat?: string;
}
export interface ClaimGraph {
  version: 1; evidence: Ref; claims: readonly NumericClaim[];
  edges: readonly { from: string; to: string; relation: 'derived_from' }[];
  populationRowRefs: readonly string[]; limitations: readonly string[]; digest: string;
}
const graphs = new WeakMap<ClaimGraph, EvidenceBundle>();
export function isBoundClaimGraph(graph: ClaimGraph, bundle: EvidenceBundle): boolean { return graphs.get(graph) === bundle; }
const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
type DateAggregation = 'sum' | 'avg' | 'latest' | 'max';
function calculate(rows: readonly EvidenceRow[], field: SemanticField, aggregation: DateAggregation): number | null {
  if (field.additivity === 'snapshot') {
    const totalsByDate = new Map<string, number>();
    for (const row of rows) {
      const value = row.values[field.id];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Numeric computation lacks its evidence input.');
      totalsByDate.set(row.date, (totalsByDate.get(row.date) ?? 0) + value);
    }
    const totals = [...totalsByDate.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (!totals.length) return null;
    if (aggregation === 'latest') return round(totals.at(-1)![1]);
    if (aggregation === 'max') return round(Math.max(...totals.map(([, value]) => value)));
    if (aggregation === 'avg') return round(totals.reduce((sum, [, value]) => sum + value, 0) / totals.length);
    return round(totals.reduce((sum, [, value]) => sum + value, 0));
  }
  const sum = (id: string): number => rows.reduce((total, row) => {
    const value = row.values[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Numeric computation lacks its evidence input.');
    return total + value;
  }, 0);
  const divisor = aggregation === 'avg' ? new Set(rows.map(r => r.date)).size : 1;
  if (field.id === 'achievement') { const target = sum('target'); return target > 0 ? round(sum('net_sales') / target * 100) : null; }
  const result = field.id === 'gap' ? sum('net_sales') - sum('target') : sum(field.id);
  if (!Number.isFinite(result)) throw new Error('Numeric range exceeded.');
  return round(result / divisor);
}

function hasMeasureEvidence(rows: readonly EvidenceRow[], field: SemanticField): boolean {
  return rows.length > 0 && rows.every(row => field.sourceSystems.every(system => row.sourceRefs.includes(`${system}:${row.branchId}:${row.date}`)));
}

/** Builds numeric claims only; no wording, rendering, or free-form model calculations. */
export function buildClaimGraph(bundle: EvidenceBundle): ClaimGraph {
  const accepted = bundlePlan(bundle), { dataset } = acceptedContext(accepted), plan = accepted.plan;
  const currentRows = bundle.rows.filter(r => accepted.dates.includes(r.date));
  const baselineRows = bundle.rows.filter(r => accepted.baselineDates.includes(r.date));
  const groupFields = plan.aggregation === 'rows' ? ['branch', 'date'] : plan.group.fieldIds;
  const groups = new Map<string, EvidenceRow[]>();
  for (const row of currentRows) {
    const key = JSON.stringify(groupFields.map(id => row.values[id]));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (groups.size > dataset.budgets.maxGroups) throw new Error('Group budget exceeded.');
  const dateAggregation = (fieldId: string): DateAggregation => {
    const field = fieldById(dataset, fieldId);
    if (field.additivity === 'snapshot') {
      const selected = plan.measures.find(m => m.fieldId === fieldId)?.aggregation;
      return (selected ?? plan.multiDateGrain?.mode ?? 'sum') as DateAggregation;
    }
    return plan.multiDateGrain?.mode ?? 'sum';
  };
  const candidates = [...groups.values()].map(rows => ({ rows,
    dimensions: Object.fromEntries(groupFields.map(id => [id, String(rows[0].values[id])])),
    values: Object.fromEntries(plan.measures.map(m => {
      const field = fieldById(dataset, m.fieldId);
      return [m.fieldId, hasMeasureEvidence(rows, field) ? calculate(rows, field, dateAggregation(m.fieldId)) : null];
    })) }));
  const filtered = candidates.filter(candidate => plan.filters.filter(f => fieldById(dataset, f.fieldId).kind === 'measure')
    .every(f => {
      const field = fieldById(dataset, f.fieldId);
      return hasMeasureEvidence(candidate.rows, field) && matchesFilter(calculate(candidate.rows, field, dateAggregation(f.fieldId)), f);
    }));
  if (plan.topN && filtered.some(candidate => candidate.values[plan.sort[0].fieldId] === null)) throw new Error('Ranking metric unavailable for the complete population.');
  const sort = plan.topN ? [{ fieldId: plan.sort[0].fieldId, direction: plan.topN.direction === 'highest' ? 'desc' : 'asc' }] : plan.sort;
  filtered.sort((a, b) => {
    for (const key of sort) {
      const left = a.values[key.fieldId] ?? a.dimensions[key.fieldId], right = b.values[key.fieldId] ?? b.dimensions[key.fieldId];
      if (left == null || right == null) { if (left !== right) return left == null ? 1 : -1; continue; }
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      if (order) return key.direction === 'desc' ? -order : order;
    }
    return JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions));
  });
  const chosen = plan.topN ? filtered.slice(0, plan.topN.count) : filtered;
  const limitations = [...bundle.limitations];
  if (plan.topN && filtered.length > plan.topN.count) {
    const rankField = sort[0].fieldId;
    const boundaryValue = chosen.at(-1)?.values[rankField];
    const nextValue = filtered[plan.topN.count].values[rankField];
    if (boundaryValue !== null && boundaryValue === nextValue) {
      const tied = filtered.filter(candidate => candidate.values[rankField] === boundaryValue);
      const tiedBranches = unique(tied.flatMap(candidate => candidate.rows.map(row => row.branchId))).sort();
      limitations.push(`อันดับต้นมีสาขาคะแนนเท่ากันที่ขอบเขตการแสดงผล: ${tiedBranches.join(', ')}.`);
    }
  }
  const scopeCaveat = bundle.limitations.find(limitation => limitation.startsWith('จำกัดขอบเขตตามสิทธิ์ของคุณ:'));
  const claims: NumericClaim[] = [];
  function add(field: SemanticField, value: number | null, rows: readonly EvidenceRow[], dimensions: Record<string, string>,
    operation: NumericClaim['computation']['operation'], inputs: string[], calculatorId = field.calculatorId!, allSources = false, caveat?: string) {
    const rowRefs = rows.map(r => r.rowId);
    if (!rowRefs.length) throw new Error('Numeric claims require evidence rows.');
    const sourceRefs = unique(rows.flatMap(r => r.sourceRefs.filter(id => allSources || field.sourceSystems.some(s => id === `${s}:${r.branchId}:${r.date}`))));
    if (!sourceRefs.length || sourceRefs.some(id => !bundle.sources.some(s => s.id === id))) throw new Error('Claim lacks a unique evidence source.');
    if (value !== null && !Number.isFinite(value)) throw new Error('Invalid claim value.');
    claims.push({ id: `claim:${claims.length + 1}`, kind: 'fact', measure: field.id, value, unit: operation === 'rank' ? 'position' : field.unit!,
      dimensions, rowRefs, sourceRefs, computation: { calculatorId, operation, inputs }, ...(caveat ? { caveat } : {}) });
  }
  for (const candidate of chosen) {
    for (const measure of plan.measures) {
      const field = fieldById(dataset, measure.fieldId), value = candidate.values[measure.fieldId];
      if (!hasMeasureEvidence(candidate.rows, field)) continue;
      const inputs = ['gap', 'achievement'].includes(field.id) ? ['net_sales', 'target'] : [field.id];
      const aggregate = dateAggregation(field.id);
      const operation = field.id === 'gap' ? 'gap' : field.id === 'achievement' ? 'weighted_ratio' : aggregate;
      add(field, value, candidate.rows, candidate.dimensions, operation, inputs, field.calculatorId, false, plan.topN ? scopeCaveat : undefined);
      if (plan.compare && (plan.compare.kind !== 'vs_target' || field.targetFieldId)) {
        const baseline = baselineRows.filter(row => Object.entries(candidate.dimensions).every(([id, val]) => String(row.values[id]) === val));
        const targetField = plan.compare.kind === 'vs_target' ? fieldById(dataset, field.targetFieldId!) : null;
        if (targetField ? !hasMeasureEvidence(candidate.rows, targetField) : !hasMeasureEvidence(baseline, field)) continue;
        const previous = targetField ? calculate(candidate.rows, targetField, dateAggregation(targetField.id)) : calculate(baseline, field, aggregate);
        const groupBranches = new Set(candidate.rows.map(row => row.branchId));
        const completeBaseline = baseline.length === groupBranches.size * accepted.baselineDates.length;
        if (plan.compare.kind !== 'vs_target' && !completeBaseline) continue;
        const comparedRows = plan.compare.kind === 'vs_target' ? candidate.rows : [...candidate.rows, ...baseline];
        const baselineField = targetField ?? field;
        const baselineInputs = targetField ? [targetField.id] : inputs;
        const baselineOperation = targetField ? dateAggregation(targetField.id) : operation;
        if (!targetField || !plan.measures.some(measure => measure.fieldId === targetField.id)) {
          add(baselineField, previous, targetField ? candidate.rows : baseline, { ...candidate.dimensions, comparison: 'baseline' }, baselineOperation,
            baselineInputs, baselineField.calculatorId, true, plan.topN ? scopeCaveat : undefined);
        }
        add(field, value === null || previous === null ? null : round(value - previous), comparedRows,
          { ...candidate.dimensions, comparison: 'difference' }, 'difference', [...inputs, ...(targetField ? [targetField.id] : [])], 'comparison.difference.v1', true,
          plan.topN ? scopeCaveat : undefined);
      }
    }
    if (plan.topN) {
      const field = fieldById(dataset, sort[0].fieldId);
      const rank = filtered.filter(other => {
        const left = other.values[field.id]!, right = candidate.values[field.id]!;
        return plan.topN!.direction === 'highest' ? left > right : left < right;
      }).length + 1;
      add(field, rank, currentRows, candidate.dimensions, 'rank', [field.id], 'ranking.complete_population.v1', false, scopeCaveat);
    }
  }
  const payload = { version: 1 as const, evidence: bundle.ref, claims,
    edges: claims.flatMap(claim => claim.rowRefs.map(to => ({ from: claim.id, to, relation: 'derived_from' as const }))),
    populationRowRefs: currentRows.map(r => r.rowId), limitations };
  const graph = freeze({ ...payload, digest: digest(payload) });
  graphs.set(graph, bundle);
  return graph;
}
