import { businessDateSchema, type Product, type Reader } from '../../contracts';
import type { SemanticDataset, SemanticDatasetCatalog, SemanticField } from '../catalog/semantic';
import { trustPolicy } from '../catalog/semantic';
import type { Ref, QueryPlan } from '../plan/schemas';
import { resolveTime } from '../plan/time';
import { assessSourceCompleteness, sourceCompletenessOutcome, type SourceCompleteness, type SourceObservation, type SourceRequirement } from '../evidence/completeness';
import { digest, freeze, unique } from '../shared';
import { authorizedBranches, matchesFilter, rejected, type ActorAuthority, type RejectedPlan } from '../validate/query-plan';
import { DERIVATIONS, type DeriveContext, type StoredRow } from './derive';

/** Default and maximum number of result rows (groups or listed rows) returned per page. */
export const TABLE_DEFAULT_PAGE = 20;
export const TABLE_MAX_PAGE = 100;
const DAY_MS = 86_400_000;
type Scalar = string | number | null;

// ---------------------------------------------------------------------------------------------------------- cursor
/** Opaque server cursor: an offset bound (by digest) to the exact plan shape, actor authority and catalog. Never trusted blindly. */
export function encodeTableCursor(binding: string, offset: number): string {
  const key = digest({ binding, offset }).slice(0, 20);
  return Buffer.from(JSON.stringify({ v: 1, o: offset, k: key })).toString('base64url');
}
export function decodeTableCursor(binding: string, cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; o?: unknown; k?: unknown };
    if (parsed.v !== 1 || typeof parsed.o !== 'number' || !Number.isSafeInteger(parsed.o) || parsed.o < 0 || typeof parsed.k !== 'string') return null;
    return parsed.k === digest({ binding, offset: parsed.o }).slice(0, 20) ? parsed.o : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------- validation
export interface FieldRef { datasetId: string; field: SemanticField; id: string; qualified: boolean }
export interface TableAcceptedPlan {
  readonly outcome: 'accepted'; readonly plan: QueryPlan; readonly planDigest: string; readonly bindingDigest: string;
  readonly catalogDigest: string; readonly authorityDigest: string;
  readonly dataset: SemanticDataset; readonly joined: readonly SemanticDataset[];
  readonly joins: readonly { datasetId: string; keys: readonly string[] }[];
  readonly scope: { regions: readonly string[]; branchIds: readonly string[] };
  readonly dates: readonly string[]; readonly mode: 'groups' | 'rows';
  readonly page: { limit: number; offset: number };
  readonly interpretationLabels: readonly string[]; readonly sourceText: string;
}
export interface TableValidateInput {
  proposal: QueryPlan; catalog: SemanticDatasetCatalog; authority: ActorAuthority; sourceText: string; businessDate: string;
  availabilityWindow: { min: string; max: string } | null; previousPlan?: QueryPlan; products: readonly Product[];
}
const inputs = new WeakMap<TableAcceptedPlan, TableValidateInput>();

const isRejected = (value: unknown): value is RejectedPlan => typeof value === 'object' && value !== null && 'outcome' in value && (value as { outcome: string }).outcome !== 'accepted';
const clarify = (slotId: string, code: string, choices: { id: string; label: string }[] = []): RejectedPlan =>
  ({ ...rejected('clarification_required', code), clarification: { slotId, choices } });
const values = (value: QueryPlan['filters'][number]['value']): (string | number)[] => value === null ? [] : Array.isArray(value) ? value : [value];
const labelOf = (field: SemanticField, value: string): string => field.canonicalValues?.find(v => v.id === value)?.label ?? value;

/** Plan shape that decides a cursor's meaning: the same shape reads the same result order. */
export function tableBindingDigest(plan: QueryPlan, authorityDigest: string, catalogDigest: string): string {
  return digest({ datasetId: plan.datasetId, joins: (plan.joins ?? []).map(j => j.datasetId),
    measures: plan.measures.map(m => [m.fieldId, m.aggregation]), dimensions: plan.dimensions.map(d => d.fieldId), group: plan.group.fieldIds,
    filters: plan.filters.map(f => [f.fieldId, f.op, f.value]), time: plan.time?.dates ?? null, sort: plan.sort, topN: plan.topN,
    aggregation: plan.aggregation, authorityDigest, catalogDigest });
}

export function tableDatasetOf(catalog: SemanticDatasetCatalog, datasetId: string): SemanticDataset | undefined {
  return catalog.datasets.find(d => d.id === datasetId && d.readerId === 'table_rows' && !!d.table);
}

/** Validate a MODEL-authored QueryPlan over a registered table dataset. Reads only the plan, the catalog and server data. */
export function validateTablePlan(input: TableValidateInput): TableAcceptedPlan | RejectedPlan {
  const { proposal: plan, catalog, authority } = input;
  const dataset = tableDatasetOf(catalog, plan.datasetId);
  if (!dataset || !dataset.table) return rejected('unsupported_concept', 'unknown_dataset');
  if (!authority.active || !dataset.requiredPermissions.every(p => authority.permissions.includes(p))) return rejected('permission_denied', 'dataset_permission');
  if (plan.confidence < 0.5) return rejected('semantic_uncertainty', 'low_confidence');
  if (plan.requestedUses.some(use => !['answer', 'explore'].includes(use))) return rejected('unsupported_concept', 'capability_unavailable');
  if (plan.compare || plan.multiDateGrain) return rejected('unsupported_concept', 'table_compare_unsupported');
  if (plan.clarificationNeeds.length) return clarify(plan.clarificationNeeds[0].slotId, 'planner_clarification');
  const labels: string[] = [];

  // Registered joins: only declared targets, only declared keys (the plan never names a key).
  const joined: SemanticDataset[] = [], joins: { datasetId: string; keys: readonly string[] }[] = [];
  for (const join of plan.joins ?? []) {
    const declared = dataset.table.joins.find(item => item.to === join.datasetId);
    const target = tableDatasetOf(catalog, join.datasetId);
    if (!declared || !target || joined.some(d => d.id === target.id)) return rejected('unsupported_concept', 'unregistered_join');
    if (!target.requiredPermissions.every(p => authority.permissions.includes(p))) return rejected('permission_denied', 'dataset_permission');
    joined.push(target); joins.push({ datasetId: target.id, keys: declared.keys });
  }
  const joinKeys = joins.length ? joins.map(j => j.keys).reduce((a, b) => a.filter(key => b.includes(key))) : [];
  if (joins.length && !joinKeys.length) return rejected('unsupported_concept', 'unregistered_join');

  const resolve = (id: string): FieldRef | undefined => {
    const dot = id.indexOf('.');
    if (dot < 0) { const field = dataset.fields.find(f => f.id === id); return field ? { datasetId: dataset.id, field, id, qualified: false } : undefined; }
    const target = joined.find(d => d.id === id.slice(0, dot));
    const field = target?.fields.find(f => f.id === id.slice(dot + 1));
    return target && field ? { datasetId: target.id, field, id, qualified: true } : undefined;
  };
  const referenced = [...plan.measures.map(m => m.fieldId), ...plan.dimensions.map(d => d.fieldId), ...plan.group.fieldIds,
    ...plan.sort.map(s => s.fieldId), ...plan.filters.map(f => f.fieldId)];
  for (const id of unique(referenced)) {
    const ref = resolve(id);
    if (!ref) return rejected('unsupported_concept', 'unknown_field');
    if (!ref.field.requiredPermissions.every(p => authority.permissions.includes(p))) return rejected('permission_denied', 'field_permission');
    const trust = trustPolicy(ref.field.trust, ref.field.sensitivity, plan.requestedUses);
    if (!trust.allowed) return rejected(trust.outcome!, 'trust_policy');
    if (trust.label) labels.push(trust.label);
  }
  const selected = [...plan.measures.map(m => m.fieldId), ...plan.dimensions.map(d => d.fieldId)];
  if (selected.length !== new Set(selected).size || plan.group.fieldIds.length !== new Set(plan.group.fieldIds).size) return rejected('semantic_uncertainty', 'duplicate_field');
  for (const measure of plan.measures) {
    const ref = resolve(measure.fieldId)!;
    if (ref.field.kind !== 'measure' || !ref.field.aggregations.includes(measure.aggregation)) return rejected('unsupported_concept', 'unknown_aggregation');
    if (measure.interpretation.value !== measure.fieldId) return rejected('semantic_uncertainty', 'interpretation_mismatch');
    if (measure.interpretation.source === 'explicit' && !measure.interpretation.sourceText) return rejected('semantic_uncertainty', 'missing_source_span');
    if (measure.interpretation.source === 'default') labels.push(`Metric ที่ระบบเลือกให้: ${ref.field.displayLabel ?? measure.fieldId}`);
  }
  for (const dim of plan.dimensions) {
    const ref = resolve(dim.fieldId)!;
    if (ref.field.kind !== 'dimension' || dim.interpretation.value !== dim.fieldId) return rejected('unsupported_concept', 'unknown_dimension');
    if (dim.interpretation.source === 'explicit' && !dim.interpretation.sourceText) return rejected('semantic_uncertainty', 'dimension_interpretation');
  }
  const mode: 'groups' | 'rows' = plan.aggregation === 'rows' ? 'rows' : 'groups';
  if (mode === 'groups') {
    if (!plan.measures.length || plan.group.fieldIds.some(id => !plan.dimensions.some(d => d.fieldId === id)) ||
      plan.dimensions.some(d => !plan.group.fieldIds.includes(d.fieldId))) return rejected('unsupported_concept', 'invalid_group_or_sort');
    if (plan.group.fieldIds.some(id => resolve(id)!.qualified || (joins.length && !joinKeys.includes(id)))) return rejected('unsupported_concept', 'join_group_not_on_keys');
  } else if (plan.group.fieldIds.length || plan.topN || joins.length) return rejected('unsupported_concept', 'rows_mode_shape');
  if (plan.sort.some(s => !selected.includes(s.fieldId)) || plan.sort.length !== new Set(plan.sort.map(s => s.fieldId)).size) return rejected('unsupported_concept', 'invalid_group_or_sort');
  if (plan.topN) {
    if (!plan.sort.length || plan.measures.every(m => m.fieldId !== plan.sort[0].fieldId) || plan.sort[0].direction !== (plan.topN.direction === 'highest' ? 'desc' : 'asc') ||
      plan.topN.count > dataset.budgets.maxTopN || !plan.group.fieldIds.length) return rejected('semantic_uncertainty', 'ranking_budget_or_direction');
  }

  // Filters: registered dimensions only. Evidence for explicit filters was grounded by normalizeQueryPlan.
  const authorized = authorizedBranches(catalog, authority), authorizedIds = new Set(authorized.map(b => b.id));
  const productNames = new Set(input.products.map(p => p.name)), productIds = new Set(input.products.map(p => p.id)), categories = unique(input.products.map(p => p.category));
  for (const [index, filter] of plan.filters.entries()) {
    const ref = resolve(filter.fieldId)!;
    if (ref.field.kind !== 'dimension') return rejected('unsupported_concept', 'table_filter_unsupported');
    if (filter.source === 'inherited') {
      const sameValue = (prior: QueryPlan['filters'][number]) => digest(prior.value) === digest(filter.value) ||
        filter.op === 'in' && Array.isArray(prior.value) && Array.isArray(filter.value) && digest([...prior.value].sort()) === digest([...filter.value].sort());
      if (!input.previousPlan?.filters.some(prior => prior.fieldId === filter.fieldId && prior.op === filter.op && sameValue(prior))) return clarify(`filters.${index}`, 'inherited_filter_mismatch');
    } else if (!filter.sourceText) return clarify(`filters.${index}`, 'unsupported_source_text');
    if (filter.value === null) return clarify(filter.fieldId, 'unresolved_explicit_scope', ref.field.canonicalValues?.map(v => ({ id: v.id, label: v.label })).slice(0, 8) ?? []);
    const list = values(filter.value);
    if (filter.op === 'eq' && list.length !== 1 || filter.op === 'between' && list.length !== 2 || !['in', 'between'].includes(filter.op) && list.length !== 1 ||
      new Set(list).size !== list.length) return rejected('semantic_uncertainty', 'filter_cardinality');
    if (filter.op === 'between' && list[0] > list[1]) return rejected('semantic_uncertainty', 'filter_range');
    if (ref.field.id === 'date') { if (list.some(v => !businessDateSchema.safeParse(v).success)) return rejected('unsupported_concept', 'filter_type'); continue; }
    if (!['eq', 'in'].includes(filter.op)) return rejected('unsupported_concept', 'dimension_operator');
    if (list.some(v => typeof v !== 'string')) return rejected('unsupported_concept', 'filter_type');
    if (ref.field.canonicalValues) {
      if (ref.field.id === 'branch' && list.some(v => !authorizedIds.has(String(v)) && catalog.branches.some(b => b.id === v))) return rejected('permission_denied', 'explicit_scope_denied');
      if (ref.field.id === 'region' && list.some(v => !authorized.some(b => b.region === v) && catalog.branches.some(b => b.region === v))) return rejected('permission_denied', 'explicit_scope_denied');
      const unknown = list.filter(v => !ref.field.canonicalValues!.some(c => c.id === v));
      if (unknown.length) return clarify(filter.fieldId, 'unknown_value', ref.field.canonicalValues.filter(c => ref.field.id === 'branch' ? authorizedIds.has(c.id) : true).slice(0, 8).map(c => ({ id: c.id, label: c.label })));
    } else if (ref.field.id === 'product' ? list.some(v => !productIds.has(String(v))) : ref.field.id === 'product_name' ? list.some(v => !productNames.has(String(v)))
      : ref.field.id === 'category' ? list.some(v => !categories.includes(String(v))) : false) {
      const registered = ref.field.id === 'category' ? categories : ref.field.id === 'product_name' ? [...productNames] : [...productIds];
      return clarify(filter.fieldId, 'unknown_value', registered.slice(0, 8).map(id => ({ id, label: id })));
    }
  }
  if (plan.scope && plan.filters.some(f => ['region', 'branch'].includes(f.fieldId))) return rejected('semantic_uncertainty', 'conflicting_scope');
  const scopeFilters = plan.filters.filter(f => ['region', 'branch'].includes(f.fieldId));
  const requested = authorized.filter(b => scopeFilters.every(f => matchesFilter(f.fieldId === 'region' ? b.region : b.id, f)));
  if (!requested.length) return rejected('data_unavailable', 'empty_effective_scope');
  if (!scopeFilters.length) labels.push(`ขอบเขตเริ่มต้น: ภูมิภาคที่ได้รับอนุญาต ${unique(requested.map(b => labelOf(dataset.fields.find(f => f.id === 'region')!, b.region))).join(', ')}`);
  if (!scopeFilters.length && requested.length < catalog.branches.length) labels.push('จำกัดขอบเขตตามสิทธิ์ของคุณ');

  // Time. Every registered table dataset has a date axis; snapshots are never summed over several dates.
  const maxDays = Math.min(dataset.budgets.maxDays, ...joined.map(d => d.budgets.maxDays));
  let dates: string[];
  try {
    const resolved = resolveTime(plan.time, input.businessDate, maxDays);
    if (resolved.time.fieldId !== 'date' || resolved.time.timezone !== dataset.timezone) return rejected('unsupported_concept', 'time_dimension');
    dates = resolved.dates.filter(date => plan.filters.every(f => f.fieldId !== 'date' || matchesFilter(date, f)));
    const window = input.availabilityWindow;
    if (!window || dates.some(date => date < window.min || date > window.max)) {
      return { ...clarify('time', 'date_outside_availability'), dateAvailability: { requestedDates: resolved.dates, availableFrom: window?.min ?? null, availableTo: window?.max ?? null } };
    }
    if (resolved.time.source === 'default') labels.push(`วันที่ธุรกิจ (ค่าเริ่มต้น): ${input.businessDate}`);
  } catch { return rejected('semantic_uncertainty', 'time_budget_or_range'); }
  if (!dates.length) return rejected('data_unavailable', 'empty_date_scope');
  const grouped = plan.group.fieldIds.includes('date');
  if (dates.length > 1 && !grouped && [dataset, ...joined].some(d => d.table!.snapshot)) {
    return clarify('snapshot_date', 'snapshot_date_required', dates.slice(-4).map(date => ({ id: date, label: `วันที่ ${date}` })));
  }
  if (dates.length * requested.length > dataset.budgets.maxRows) return rejected('semantic_uncertainty', 'query_budget');

  const authorityDigest = digest(authority);
  const bindingDigest = tableBindingDigest(plan, authorityDigest, catalog.digest);
  const limit = plan.page?.limit ?? (plan.topN ? Math.min(plan.topN.count, TABLE_MAX_PAGE) : TABLE_DEFAULT_PAGE);
  let offset = 0;
  if (plan.page?.cursor) {
    const decoded = decodeTableCursor(bindingDigest, plan.page.cursor);
    if (decoded === null) return clarify('cursor', 'cursor_invalid');
    offset = decoded;
  }
  const normalized: QueryPlan = { ...plan, time: { fieldId: 'date', timezone: dataset.timezone, source: plan.time?.source ?? 'default', dates, ...(plan.time?.evidenceText ? { evidenceText: plan.time.evidenceText } : {}) } };
  const accepted: TableAcceptedPlan = freeze({ outcome: 'accepted', plan: normalized, planDigest: digest(normalized), bindingDigest,
    catalogDigest: catalog.digest, authorityDigest, dataset: structuredClone(dataset), joined: structuredClone(joined), joins,
    scope: { regions: unique(requested.map(b => b.region)).sort(), branchIds: requested.map(b => b.id).sort() }, dates, mode,
    page: { limit, offset }, interpretationLabels: unique(labels), sourceText: input.sourceText });
  inputs.set(accepted, structuredClone(input));
  return accepted;
}

/** Recheck an accepted plan under fresh authority and the current catalog (before persistence or any further release). */
export function revalidateTablePlan(accepted: TableAcceptedPlan, freshAuthority: ActorAuthority, currentCatalog: SemanticDatasetCatalog): TableAcceptedPlan | RejectedPlan {
  const original = inputs.get(accepted);
  if (!original) throw new Error('A server-validated table plan is required.');
  if (freshAuthority.id !== original.authority.id || freshAuthority.revision !== original.authority.revision) return rejected('permission_denied', 'authority_changed');
  if (currentCatalog.digest !== accepted.catalogDigest) return rejected('semantic_uncertainty', 'catalog_changed');
  const again = validateTablePlan({ ...original, catalog: currentCatalog, authority: freshAuthority });
  if (isRejected(again)) return again;
  return digest(again.scope) === digest(accepted.scope) ? again : rejected('permission_denied', 'scope_revoked');
}

// ---------------------------------------------------------------------------------------------------------- read
export interface TableSlice { id: string; branchId: string; date: string; rowIds: string[]; observedAt: string | null }
export interface TableDatasetRead {
  dataset: SemanticDataset; rows: StoredRow[]; truncated: boolean; slices: TableSlice[];
  /** Branch/date pairs of the request with no stored row at all. */
  empty: { branchId: string; date: string }[];
}
const rowDate = (dataset: SemanticDataset, row: StoredRow, context: DeriveContext): string | null => {
  const binding = dataset.table!;
  const value = binding.dateIsDerived ? DERIVATIONS[binding.dateColumn!]?.(row, context) : row[binding.dateColumn!];
  return typeof value === 'string' ? value : null;
};
export function valueOf(field: SemanticField, row: StoredRow, context: DeriveContext): Scalar {
  if (field.column) { const value = row[field.column]; return typeof value === 'string' || typeof value === 'number' ? value : null; }
  return field.derived ? DERIVATIONS[field.derived]?.(row, context) ?? null : null;
}

/** Filters of a plan that apply to one dataset: unqualified ones to every dataset having the field, qualified ones to their own. */
function filtersFor(plan: QueryPlan, dataset: SemanticDataset, isBase: boolean): { field: SemanticField; filter: QueryPlan['filters'][number] }[] {
  return plan.filters.flatMap(filter => {
    const dot = filter.fieldId.indexOf('.');
    const id = dot < 0 ? filter.fieldId : filter.fieldId.slice(dot + 1);
    if (dot >= 0 && filter.fieldId.slice(0, dot) !== dataset.id) return [];
    if (dot < 0 && !isBase && !dataset.fields.some(f => f.id === id && f.kind === 'dimension' && ['branch', 'region', 'date'].includes(id))) return [];
    const field = dataset.fields.find(f => f.id === id);
    return field ? [{ field, filter }] : [];
  });
}

/**
 * Registered reader for one table dataset. Bounded AT THE STORAGE BOUNDARY: the branch set, the dates and any stored-column
 * equality filter are pushed into the store read together with `limit = maxRows + 1`; a read that fills the bound is a refusal
 * (`truncated`), never a partial answer. Rows are never interpreted beyond the registered column/derivation of each field.
 */
export async function readTableDataset(reader: Reader, accepted: TableAcceptedPlan, dataset: SemanticDataset, context: DeriveContext, isBase: boolean): Promise<TableDatasetRead> {
  const binding = dataset.table!;
  const push: Record<string, string | string[]> = { [binding.branchColumn]: [...accepted.scope.branchIds] };
  if (!binding.dateIsDerived && binding.dateColumn) push[binding.dateColumn] = [...accepted.dates];
  const applicable = filtersFor(accepted.plan, dataset, isBase);
  for (const { field, filter } of applicable) {
    if (field.column === 'status' && ['eq', 'in'].includes(filter.op)) push.status = values(filter.value).map(String);
  }
  const read = await reader.list<StoredRow>(binding.table, push, { limit: dataset.budgets.maxRows + 1 });
  const truncated = read.length > dataset.budgets.maxRows;
  const dates = new Set(accepted.dates), branches = new Set(accepted.scope.branchIds);
  const rows = truncated ? [] : read.filter(row => {
    const date = rowDate(dataset, row, context);
    return !!date && dates.has(date) && branches.has(String(row[binding.branchColumn]));
  });
  const slices = new Map<string, TableSlice>();
  for (const row of rows) {
    const branchId = String(row[binding.branchColumn]), date = rowDate(dataset, row, context)!;
    const id = `${binding.sourceSystem}:${branchId}:${date}`;
    const stamp = typeof row[binding.observedColumn] === 'string' ? String(row[binding.observedColumn]) : null;
    const slice = slices.get(id) ?? { id, branchId, date, rowIds: [], observedAt: null };
    slice.rowIds.push(row.id);
    if (stamp && Number.isFinite(Date.parse(stamp)) && (slice.observedAt === null || Date.parse(stamp) > Date.parse(slice.observedAt))) slice.observedAt = stamp;
    else if (!stamp || !Number.isFinite(Date.parse(stamp))) slice.observedAt = slice.observedAt ?? null;
    slices.set(id, slice);
  }
  const empty = accepted.scope.branchIds.flatMap(branchId => accepted.dates.filter(date => !slices.has(`${binding.sourceSystem}:${branchId}:${date}`)).map(date => ({ branchId, date })));
  return { dataset, rows, truncated, slices: [...slices.values()], empty };
}

// ---------------------------------------------------------------------------------------------------------- evidence
export interface TableEvidenceRow { rowId: string; values: Readonly<Record<string, Scalar>>; sourceRefs: readonly string[]; underlying: number }
export interface TableClaim {
  id: string; kind: 'fact'; fieldId: string; value: number | null | Readonly<Record<string, Scalar>>; unit?: string;
  dimensions: Readonly<Record<string, string>>; rowRefs: readonly string[]; sourceRefs: readonly string[]; calculatorId?: string;
}
export interface TableClaims { version: 1; ref: Ref; evidence: Ref; claims: readonly TableClaim[]; limitations: readonly string[]; interpretationLabels: readonly string[] }
export interface TableEvidenceBundle {
  version: 3; kind: 'table'; ref: Ref; query: Ref; dataset: Ref; datasets: readonly string[]; catalog: Ref; authority: Ref;
  scope: { regions: readonly string[]; branchIds: readonly string[]; dates: readonly string[] };
  grain: readonly string[]; mode: 'groups' | 'rows'; rows: readonly TableEvidenceRow[];
  sources: readonly { id: string; system: string; observedAt: string; retrievedAt: string }[];
  sourceCompleteness: SourceCompleteness;
  coverage: { expected: number; read: number; matched: number; complete: boolean; omittedReasons: readonly string[] };
  page: { offset: number; limit: number; total: number; nextCursor: string | null };
  joins: readonly { datasetId: string; keys: readonly string[] }[];
  createdAt: string; limitations: readonly string[]; interpretationLabels: readonly string[];
}
const bundles = new WeakMap<TableEvidenceBundle, TableAcceptedPlan>();
const claimBindings = new WeakMap<TableClaims, TableEvidenceBundle>();
export function tableBundlePlan(bundle: TableEvidenceBundle): TableAcceptedPlan {
  const plan = bundles.get(bundle);
  if (!plan) throw new Error('A verified table execution bundle is required.');
  return plan;
}
export const isBoundTableClaims = (claims: TableClaims, bundle: TableEvidenceBundle): boolean => claimBindings.get(claims) === bundle;

const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
function aggregate(aggregation: string, rows: readonly Scalar[]): number | null {
  const numbers = rows.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  switch (aggregation) {
    case 'count': return rows.length;
    case 'sum': return round(numbers.reduce((sum, value) => sum + value, 0));
    case 'avg': return numbers.length ? round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : null;
    case 'min': return numbers.length ? Math.min(...numbers) : null;
    case 'max': return numbers.length ? Math.max(...numbers) : null;
    default: throw new Error('Unregistered aggregation.');
  }
}

interface ProjectedRow { row: StoredRow; values: Record<string, Scalar>; slice: string }
function project(dataset: SemanticDataset, read: TableDatasetRead, accepted: TableAcceptedPlan, context: DeriveContext, isBase: boolean): ProjectedRow[] {
  const binding = dataset.table!, applicable = filtersFor(accepted.plan, dataset, isBase);
  return read.rows.flatMap(row => {
    const values: Record<string, Scalar> = {};
    for (const field of dataset.fields) values[field.id] = valueOf(field, row, context);
    if (applicable.some(({ field, filter }) => !matchesFilter(values[field.id] as string | number | null, filter))) return [];
    return [{ row, values, slice: `${binding.sourceSystem}:${row[binding.branchColumn]}:${rowDate(dataset, row, context)}` }];
  });
}
const keyOf = (fieldIds: readonly string[], values: Record<string, Scalar>) => JSON.stringify(fieldIds.map(id => values[id]));
interface Group { key: string; dims: Record<string, string>; measures: Record<string, number | null>; rows: number; slices: Set<string> }

/** Attested (read) slice ids per branch: a zero is a claim only where an actual read (rows, or an event table's empty read) backs it. */
function attestedSlices(read: TableDatasetRead): Map<string, Set<string>> {
  const binding = read.dataset.table!, out = new Map<string, Set<string>>();
  const add = (branchId: string, id: string) => out.set(branchId, (out.get(branchId) ?? new Set<string>()).add(id));
  for (const slice of read.slices) add(slice.branchId, slice.id);
  // An event table (incidents, tickets) with no row for a branch/date is a genuine, attested zero; a snapshot table with no row is MISSING, never zero.
  if (!binding.snapshot) for (const pair of read.empty) add(pair.branchId, `${binding.sourceSystem}:${pair.branchId}:${pair.date}`);
  return out;
}

function groupDataset(dataset: SemanticDataset, projected: ProjectedRow[], accepted: TableAcceptedPlan, prefix: string, isBase: boolean, context: DeriveContext, attested: Map<string, Set<string>> = new Map()): Map<string, Group> {
  const groupIds = accepted.plan.group.fieldIds;
  const measures = accepted.plan.measures.filter(m => isBase ? !m.fieldId.includes('.') : m.fieldId.startsWith(`${dataset.id}.`));
  const groups = new Map<string, Group>(), buckets = new Map<string, ProjectedRow[]>();
  for (const item of projected) {
    const key = keyOf(groupIds, item.values);
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const zeroSlices = new Map<string, Set<string>>();
  const zeroFill = isBase && measures.length > 0 && measures.every(m => ['count', 'sum'].includes(m.aggregation));
  if (zeroFill && groupIds.length === 0) {
    // An ungrouped count/sum over a completely read scope is a grounded zero when nothing matches (sources = every attested slice).
    const all = new Set([...attested.values()].flatMap(ids => [...ids]));
    if (!buckets.has('[]') && all.size) { buckets.set('[]', []); zeroSlices.set('[]', all); }
  } else if (zeroFill && groupIds.every(id => id === 'branch' || id === 'region')) {
    for (const branchId of accepted.scope.branchIds) {
      const region = context.branches.get(branchId)?.region ?? null;
      const key = JSON.stringify(groupIds.map(id => id === 'branch' ? branchId : region));
      const ids = attested.get(branchId);
      // No attested read for the branch (e.g. a missing inventory snapshot) -> no group: unknown, never a numeric zero.
      if (!buckets.has(key) && ids?.size) { buckets.set(key, []); zeroSlices.set(key, ids); }
    }
  }
  for (const [key, items] of buckets) {
    const first = items[0];
    const dims = first ? Object.fromEntries(groupIds.map(id => [id, String(first.values[id])]))
      : Object.fromEntries(groupIds.map((id, index) => [id, String(JSON.parse(key)[index])]));
    const measureValues: Record<string, number | null> = {};
    for (const measure of measures) {
      const id = isBase ? measure.fieldId : measure.fieldId.slice(dataset.id.length + 1);
      measureValues[`${prefix}${id}`] = aggregate(measure.aggregation, items.map(item => item.values[id]));
    }
    groups.set(key, { key, dims, measures: measureValues, rows: items.length, slices: new Set(items.map(item => item.slice)) });
    if (!items.length) for (const id of zeroSlices.get(key) ?? []) groups.get(key)!.slices.add(id);
  }
  return groups;
}

export interface TableExecutionInput {
  reader: Reader; accepted: TableAcceptedPlan; context: DeriveContext; readAt: string;
  freshAuthority: () => Promise<ActorAuthority>; currentCatalog: () => Promise<SemanticDatasetCatalog>;
  /** Cap on the sources recorded on one claim (the persisted answer carries a bounded provenance view). */
  maxClaimSources?: number;
}
export type TableExecution = { outcome: 'accepted'; bundle: TableEvidenceBundle; claims: TableClaims } | RejectedPlan;

/** Runs the compiled plan: bounded reads -> projection -> registered aggregation -> page -> evidence bundle + claims. */
export async function executeTablePlan(input: TableExecutionInput): Promise<TableExecution> {
  const { accepted, context, readAt } = input;
  const plan = accepted.plan, dataset = accepted.dataset;
  if (!Number.isFinite(Date.parse(readAt))) return rejected('execution_failed', 'invalid_read_timestamp');
  const original = inputs.get(accepted);
  if (!original) throw new Error('A server-validated table plan is required.');
  const pre = revalidateTablePlan(accepted, await input.freshAuthority(), await input.currentCatalog());
  if (isRejected(pre)) return pre;
  const datasets = [dataset, ...accepted.joined];
  const reads: TableDatasetRead[] = [];
  let budget = dataset.budgets.maxRows;
  for (const [index, ds] of datasets.entries()) {
    const read = await readTableDataset(input.reader, accepted, ds, context, index === 0);
    if (read.truncated) return rejected('semantic_uncertainty', 'query_budget');
    budget -= read.rows.length;
    if (budget < 0) return rejected('semantic_uncertainty', 'query_budget');
    reads.push(read);
  }

  // Source completeness: one source per (system, branch, date) slice. Snapshot slices with no row are missing evidence.
  const requirements: SourceRequirement[] = [], observations: SourceObservation[] = [], sources: TableEvidenceBundle['sources'][number][] = [];
  const omittedReasons: string[] = [];
  let expectedSlices = 0, readSlices = 0;
  for (const read of reads) {
    const binding = read.dataset.table!;
    const cutoff = (date: string) => Math.min(Date.parse(`${date}T23:59:59+07:00`), Date.parse(readAt));
    expectedSlices += accepted.scope.branchIds.length * accepted.dates.length;
    for (const slice of read.slices) {
      readSlices += 1;
      const freshnessAsOf = new Date(cutoff(slice.date)).toISOString();
      requirements.push({ id: slice.id, adapterId: binding.sourceSystem, expectedRowIds: slice.rowIds, maxAgeMs: DAY_MS, freshnessAsOf, coverageBasis: 'record_ids' });
      observations.push({ id: slice.id, adapterId: binding.sourceSystem, observedAt: slice.observedAt, retrievedAt: readAt, coveredRowIds: slice.rowIds });
    }
    for (const pair of read.empty) {
      if (binding.snapshot) { omittedReasons.push(`ไม่พบสแนปชอตสต็อกของสาขา ${pair.branchId} วันที่ ${pair.date}.`); continue; }
      // An event table (incidents, tickets) with no row for a branch/date is a genuine zero, attested by the empty read.
      const id = `${binding.sourceSystem}:${pair.branchId}:${pair.date}`, asOf = new Date(cutoff(pair.date)).toISOString();
      readSlices += 1;
      requirements.push({ id, adapterId: binding.sourceSystem, expectedRowIds: [], maxAgeMs: DAY_MS, freshnessAsOf: asOf, coverageBasis: 'record_ids' });
      observations.push({ id, adapterId: binding.sourceSystem, observedAt: asOf, retrievedAt: readAt, coveredRowIds: [] });
    }
  }
  if (!requirements.length) return rejected('data_unavailable', 'date_unavailable');
  const completeness = assessSourceCompleteness({ requirements, observations, asOf: readAt });
  const strict = plan.completeness.requireFullPopulation || plan.completeness.expectation === 'complete_authorized_population' || !!plan.topN;
  const outcome = sourceCompletenessOutcome(completeness, { requireFullPopulation: strict, minimumCoverage: strict ? plan.completeness.minimumCoverage : 0, topN: !!plan.topN });
  if (outcome !== 'accepted') return rejected(outcome, `source_completeness_${outcome}`);
  if (strict && omittedReasons.length) return rejected('incomplete_evidence', 'population_unavailable');
  for (const requirement of requirements) {
    const observed = observations.find(o => o.id === requirement.id)!;
    sources.push({ id: requirement.id, system: requirement.adapterId, observedAt: observed.observedAt!, retrievedAt: readAt });
  }

  // Projection + registered aggregation.
  const prefixes = datasets.map((ds, index) => index === 0 ? '' : `${ds.id}.`);
  const projected = datasets.map((ds, index) => project(ds, reads[index], accepted, context, index === 0));
  const rowsOut: { rowId: string; dims: Record<string, string>; values: Record<string, Scalar>; slices: Set<string>; underlying: number }[] = [];
  if (accepted.mode === 'groups') {
    const maps = datasets.map((ds, index) => groupDataset(ds, projected[index], accepted, prefixes[index], index === 0, context, index === 0 ? attestedSlices(reads[0]) : undefined));
    if (maps[0].size > dataset.budgets.maxGroups) return rejected('semantic_uncertainty', 'query_budget');
    for (const [key, group] of maps[0]) {
      const values: Record<string, Scalar> = { ...group.dims, ...group.measures };
      const slices = new Set(group.slices);
      let underlying = group.rows;
      for (const map of maps.slice(1)) {
        const other = map.get(key);
        const sample = other?.measures ?? {};
        for (const [id] of Object.entries(sample)) values[id] = sample[id];
        // A joined measure with no matching group is a true zero for count/sum and unknown otherwise (same registered aggregation).
        other?.slices.forEach(slice => slices.add(slice));
        underlying += other?.rows ?? 0;
      }
      for (const measure of plan.measures) if (!(measure.fieldId in values)) values[measure.fieldId] = ['count', 'sum'].includes(measure.aggregation) ? 0 : null;
      rowsOut.push({ rowId: `group:${digest(key).slice(0, 24)}`, dims: group.dims, values, slices, underlying });
    }
  } else {
    for (const item of projected[0]) {
      const values: Record<string, Scalar> = {};
      for (const dimension of plan.dimensions) values[dimension.fieldId] = item.values[dimension.fieldId];
      for (const measure of plan.measures) values[measure.fieldId] = item.values[measure.fieldId];
      rowsOut.push({ rowId: `row:${dataset.id}:${item.row.id}`, dims: Object.fromEntries(plan.dimensions.map(d => [d.fieldId, String(item.values[d.fieldId])])), values, slices: new Set([item.slice]), underlying: 1 });
    }
  }

  // Order (registered sort, then a stable key), rank limit, page.
  const sort = plan.sort.length ? plan.sort : [];
  rowsOut.sort((a, b) => {
    for (const key of sort) {
      const left = a.values[key.fieldId], right = b.values[key.fieldId];
      if (left == null || right == null) { if (left !== right) return left == null ? 1 : -1; continue; }
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      if (order) return key.direction === 'desc' ? -order : order;
    }
    return a.rowId.localeCompare(b.rowId);
  });
  const ranked = plan.topN ? rowsOut.slice(0, plan.topN.count) : rowsOut;
  const total = ranked.length;
  const pageRows = ranked.slice(accepted.page.offset, accepted.page.offset + accepted.page.limit);
  if (accepted.page.offset > 0 && accepted.page.offset >= total) return clarifyEmptyPage();
  const nextOffset = accepted.page.offset + pageRows.length;
  const nextCursor = nextOffset < total ? encodeTableCursor(accepted.bindingDigest, nextOffset) : null;

  const cap = input.maxClaimSources ?? 100;
  const evidenceRows: TableEvidenceRow[] = pageRows.map(item => ({ rowId: item.rowId, values: item.values,
    sourceRefs: [...item.slices].sort().slice(0, cap), underlying: item.underlying }));
  const limitations = unique([...completeness.limitations, ...omittedReasons.slice(0, 5),
    ...(omittedReasons.length > 5 ? [`ไม่พบสแนปชอตอีก ${omittedReasons.length - 5} ช่วง`] : [])]);
  const query: Ref = { id: plan.planId, version: 1, digest: accepted.planDigest };
  const payload = {
    version: 3 as const, kind: 'table' as const, query, dataset: { id: dataset.id, version: 1, digest: digest(dataset) } as Ref, datasets: datasets.map(d => d.id),
    catalog: { id: 'semantic_catalog', version: 1, digest: accepted.catalogDigest } as Ref, authority: { id: original.authority.id, version: original.authority.revision, digest: accepted.authorityDigest } as Ref,
    scope: { regions: accepted.scope.regions, branchIds: accepted.scope.branchIds, dates: accepted.dates }, grain: dataset.grain, mode: accepted.mode, rows: evidenceRows,
    sources, sourceCompleteness: completeness,
    coverage: { expected: expectedSlices, read: readSlices, matched: total, complete: completeness.complete && omittedReasons.length === 0, omittedReasons: omittedReasons.slice(0, 20) },
    page: { offset: accepted.page.offset, limit: accepted.page.limit, total, nextCursor }, joins: accepted.joins,
    createdAt: readAt, limitations, interpretationLabels: accepted.interpretationLabels,
  };
  const fingerprint = digest(payload);
  const bundle: TableEvidenceBundle = freeze({ ...payload, ref: { id: `evidence:${fingerprint}`, version: 1, digest: fingerprint } });
  bundles.set(bundle, accepted);

  // Claims: numbers come only from the registered aggregation above.
  const claims: TableClaim[] = [];
  const unitOf = (id: string): { unit?: string; calculatorId?: string } => {
    const dot = id.indexOf('.');
    const ds = dot < 0 ? dataset : datasets.find(d => d.id === id.slice(0, dot));
    const field = ds?.fields.find(f => f.id === (dot < 0 ? id : id.slice(dot + 1)));
    return { ...(field?.unit ? { unit: field.unit } : {}), ...(field?.calculatorId ? { calculatorId: field.calculatorId } : {}) };
  };
  // A record listing that also asks for a count: the headline count is the evidence total (every matched record on every page),
  // never a per-record or per-branch 1. It is the first claim, over every attested source of the read.
  if (accepted.mode === 'rows') for (const measure of plan.measures.filter(m => m.aggregation === 'count')) {
    claims.push({ id: `claim:${claims.length + 1}`, kind: 'fact', fieldId: measure.fieldId, value: total, ...unitOf(measure.fieldId),
      dimensions: {}, rowRefs: evidenceRows.map(row => row.rowId), sourceRefs: sources.map(source => source.id).sort().slice(0, cap) });
  }
  for (const row of evidenceRows) {
    const dims = Object.fromEntries(plan.dimensions.map(d => [d.fieldId, String(row.values[d.fieldId])]));
    if (accepted.mode === 'rows') {
      claims.push({ id: `claim:${claims.length + 1}`, kind: 'fact', fieldId: dataset.id, value: row.values, dimensions: dims, rowRefs: [row.rowId], sourceRefs: row.sourceRefs });
      continue;
    }
    for (const measure of plan.measures) {
      claims.push({ id: `claim:${claims.length + 1}`, kind: 'fact', fieldId: measure.fieldId, value: row.values[measure.fieldId] as number | null, ...unitOf(measure.fieldId),
        dimensions: dims, rowRefs: [row.rowId], sourceRefs: row.sourceRefs });
    }
  }
  const claimPayload = { version: 1 as const, evidence: bundle.ref, claims, limitations, interpretationLabels: accepted.interpretationLabels };
  const claimGraph: TableClaims = freeze({ ...claimPayload, ref: { id: 'table_claims', version: 1, digest: digest(claimPayload) } as Ref });
  claimBindings.set(claimGraph, bundle);
  const post = revalidateTablePlan(accepted, await input.freshAuthority(), await input.currentCatalog());
  if (isRejected(post)) return post;
  return { outcome: 'accepted', bundle, claims: claimGraph };
}
const clarifyEmptyPage = (): RejectedPlan => clarify('cursor', 'cursor_invalid');
export { type DeriveContext, type StoredRow } from './derive';

/**
 * Catalog-driven canonical form of a MODEL-authored plan over a table dataset (reads only the plan, the registered dataset and the
 * previous accepted plan): the model cannot see source-system ids, so requiredSourceIds is dropped (the reader attests every
 * source itself); a measure/dimension marked `inherited` that the previous plan lacks becomes `default` (labeled); a region
 * filter without located evidence whose values are exactly the actor's authorized set is the default scope and is dropped.
 */
export function canonicalizeTablePlan(proposal: QueryPlan, dataset: SemanticDataset | undefined, options: { previousPlan?: QueryPlan; authorizedRegions?: readonly string[] } = {}): QueryPlan {
  if (!dataset || proposal.datasetId !== dataset.id) return proposal;
  const plan = structuredClone(proposal), previous = options.previousPlan;
  plan.completeness.requiredSourceIds = [];
  // "How many ..." planned as a record listing with only count measures and nothing to list by: an ungrouped count (one total
  // over the evidence), not one "1" per record.
  if (plan.aggregation === 'rows' && !plan.dimensions.length && !plan.group.fieldIds.length && !plan.topN && plan.measures.length
    && plan.measures.every(m => m.aggregation === 'count')) plan.aggregation = 'registered';
  const prior = new Set([...(previous?.measures ?? []).map(m => `m:${m.fieldId}:${m.aggregation}`), ...(previous?.dimensions ?? []).map(d => `d:${d.fieldId}`)]);
  for (const measure of plan.measures) if (measure.interpretation.source === 'inherited' && !prior.has(`m:${measure.fieldId}:${measure.aggregation}`))
    measure.interpretation = { ...measure.interpretation, source: 'default', sourceText: null };
  for (const dimension of plan.dimensions) if (dimension.interpretation.source === 'inherited' && !prior.has(`d:${dimension.fieldId}`))
    dimension.interpretation = { ...dimension.interpretation, source: 'default', sourceText: null };
  const authorized = options.authorizedRegions ? unique(options.authorizedRegions).sort() : null;
  if (authorized?.length) plan.filters = plan.filters.filter(filter => {
    if (filter.fieldId !== 'region' || !['eq', 'in'].includes(filter.op)) return true;
    const located = filter.source !== 'inherited' && !!(filter.evidenceText ?? filter.sourceText?.text);
    const verifiable = filter.source === 'inherited' && !!previous?.filters.some(p => p.fieldId === filter.fieldId);
    if (located || verifiable) return true;
    return JSON.stringify(unique([filter.value].flat().map(String)).sort()) !== JSON.stringify(authorized);
  });
  return plan;
}
