import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';
import { DomainError } from '../core/errors';
import { tables, type Store, type Table, type Transaction } from '../contracts';
import { getStorageFailureMetadata, markStorageFailure, markMissingTable, missingTableError, StorageReadUnavailableError, supabaseReadUnavailableError, type StorageFailureMetadata, type StorageReadOperation } from './read-error';
import type { CasBody, WorkflowStore } from '../workflows/contracts';
import { hasEmptyFilterValue, matchesValidatedRowFilter, type RowFilter, validateRowFilter } from './filters';
import {
  assertWorkflowUniqueKey,
  getWorkflowProjection,
  isLegacyTable,
  isMarkerlessV2WorkflowBody,
  validateWorkflowProjectionBody,
  validateWorkflowProjectionWriteBody,
  validateWorkflowCasBody,
  workflowQueryFields,
  workflowProjectionManifest,
  workflowRowFilterQuery,
  type ProjectedRow,
  type WorkflowProjectionDefinition,
  type WorkflowProjectionReader,
  type WorkflowStorageQuery,
  type WorkflowStoreCapability,
  type WorkflowTransactionContext,
} from './workflow-projections';

const PAGE_SIZE = 1_000;
const MAX_ROWS = 100_000;
const MAX_TRANSACTION_CHANGES = 50_000;
const MAX_TRANSACTION_BYTES = 20 * 1024 * 1024;
type StoredRecord = { id: string; payload: unknown };
type WorkflowStoredRecord = {
  id: string;
  row_version: unknown;
  payload?: unknown;
  body?: unknown;
  workflow_contract_version?: unknown;
  [column: string]: unknown;
};
type StagedChange = { table: Table; id: string; payload: Record<string, unknown> | null };
type WorkflowIntent =
  | { kind: 'insert_unique'; table: WorkflowStorageQuery['table']; constraint: string; values: Readonly<Record<string, string | number>>; row: ProjectedRow<unknown> }
  | { kind: 'cas'; table: WorkflowStorageQuery['table']; id: string; expected: { rowVersion: number; state: string | null }; next: ProjectedRow<unknown> };
type WorkflowRemoteFilter =
  | { kind: 'eq'; column: string; value: string | number | boolean }
  | { kind: 'is'; column: string; value: null }
  | { kind: 'in'; column: string; values: Array<string | number | boolean> }
  | { kind: 'gt' | 'gte' | 'lte'; column: string; value: string };
type AdapterErrorCode = 'STORAGE' | 'CONFLICT';

class SupabaseStoreError extends Error {
  readonly code: AdapterErrorCode;
  readonly definitelyNotCommitted: boolean;

  constructor(code: AdapterErrorCode, message: string, definitelyNotCommitted = false) {
    super(message);
    this.name = 'SupabaseStoreError';
    this.code = code;
    this.definitelyNotCommitted = definitelyNotCommitted;
  }
}

const revisionConflicts = new WeakSet<object>();
/** True for a definite rollback caused by another writer advancing the global revision (40001 / unstable revision read). */
export function isRevisionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && revisionConflicts.has(error);
}
export function markRevisionConflict<E extends object>(error: E): E {
  revisionConflicts.add(error);
  return error;
}
function revisionConflict(message: string): SupabaseStoreError {
  return markRevisionConflict(new SupabaseStoreError('CONFLICT', message, true));
}

function supabaseErrorBeforeDispatch(error: unknown, commitDispatched: boolean): unknown {
  if (error instanceof SupabaseStoreError) {
    if (commitDispatched || error.definitelyNotCommitted) return error;
    return markStorageFailure(new SupabaseStoreError(error.code, error.message, true), getStorageFailureMetadata(error) ?? {});
  }
  if (error instanceof DomainError) {
    if (commitDispatched || (error as DomainError & { definitelyNotCommitted?: unknown }).definitelyNotCommitted === true) return error;
    return Object.assign(new DomainError(error.code, error.message, error.status), { definitelyNotCommitted: true as const });
  }
  return new SupabaseStoreError(
    'STORAGE',
    commitDispatched ? 'Supabase commit outcome is unknown' : 'Supabase transaction failed',
    !commitDispatched,
  );
}

function requireTable(table: Table): Table {
  if (typeof table !== 'string' || !(tables as readonly string[]).includes(table)) {
    throw new SupabaseStoreError('STORAGE', 'Supabase store received an unsupported table');
  }
  return table;
}

function cloneRow<T>(value: T): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SupabaseStoreError('STORAGE', 'Store row cannot be represented as JSON');
  }
  if (serialized === undefined) throw new SupabaseStoreError('STORAGE', 'Store row cannot be represented as JSON');
  try {
    return JSON.parse(serialized) as T;
  } catch {
    throw new SupabaseStoreError('STORAGE', 'Store row cannot be represented as JSON');
  }
}

function encodeRow(value: unknown): { id: string; payload: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') {
    throw new SupabaseStoreError('STORAGE', 'Store rows must be objects with a string id');
  }
  const payload = cloneRow(value) as unknown;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || typeof (payload as { id?: unknown }).id !== 'string') {
    throw new SupabaseStoreError('STORAGE', 'Store rows must be objects with a string id');
  }
  return { id: (payload as { id: string }).id, payload: payload as Record<string, unknown> };
}

function decodeRow(row: StoredRecord): Record<string, unknown> {
  if (typeof row.id !== 'string' || typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload) || (row.payload as { id?: unknown }).id !== row.id) {
    throw new SupabaseStoreError('STORAGE', 'Supabase store contains an inconsistent row');
  }
  return cloneRow(row.payload) as Record<string, unknown>;
}

function mapDatabaseError(error: unknown, fallback: string, metadata: StorageFailureMetadata = {}): SupabaseStoreError {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    if (code === '40001') {
      return markStorageFailure(revisionConflict('Supabase store transaction conflicted with a concurrent write'), { ...metadata, databaseCode: code });
    }
    if (['22023', '23502', '23503', '23505', '23514'].includes(code)) {
      return markStorageFailure(new SupabaseStoreError('STORAGE', fallback, true), { ...metadata, databaseCode: code });
    }
  }
  return markStorageFailure(new SupabaseStoreError('STORAGE', fallback), {
    ...metadata,
    databaseCode: typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : undefined,
  });
}

function mapReadDatabaseError(error: unknown, fallback: string, operation: StorageReadOperation): Error {
  // A missing table stays a STORAGE error (existing contract) but is MARKED, so a caller can tell "feature not migrated"
  // from an outage without parsing driver text (see isMissingTableError).
  if (missingTableError(error, 'supabase', operation)) return markMissingTable(new SupabaseStoreError('STORAGE', fallback, true));
  const unavailable = supabaseReadUnavailableError(error, operation);
  if (unavailable) return unavailable;
  const mapped = mapDatabaseError(error, fallback);
  if (mapped.code === 'CONFLICT') return mapped;
  return new SupabaseStoreError('STORAGE', fallback, true);
}

function missingLegacyWorkflowMarker(error: unknown): boolean {
  if (process.env.WORKFLOW_V2_ENABLED === 'true' || !error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === '42703' && typeof candidate.message === 'string' && candidate.message.includes('workflow_contract_version');
}

function decodeLegacyRow(table: Table, row: StoredRecord, markerMissing: boolean): Record<string, unknown> {
  const body = decodeRow(row);
  if (markerMissing && isMarkerlessV2WorkflowBody(table, body)) {
    throw new SupabaseStoreError('STORAGE', 'Legacy workflow table contains a V2-shaped row');
  }
  return body;
}

function checkReadLimit(count: number): void {
  if (count > MAX_ROWS) throw new SupabaseStoreError('STORAGE', 'Supabase store result exceeds the row limit');
}

function requireWorkflowId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300) {
    throw new SupabaseStoreError('STORAGE', 'Workflow storage received an invalid row id', true);
  }
}

function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function workflowColumn(definition: WorkflowProjectionDefinition, field: string): string {
  if (field === 'id') return 'id';
  const projected = definition.columns.find((column) => column.bodyField === field);
  if (!projected) throw new SupabaseStoreError('STORAGE', 'Workflow query field is not projected');
  return projected.column;
}

function workflowState(definition: WorkflowProjectionDefinition, body: unknown): string | null {
  if (!definition.stateField) return null;
  const value = pathValue(body, definition.stateField);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'active' : 'inactive';
  return null;
}

function workflowStateDatabaseValue(definition: WorkflowProjectionDefinition, value: string): string | boolean {
  const projected = definition.columns.find((column) => column.bodyField === definition.stateField);
  if (projected?.type === 'boolean') return value === 'active' || value === 'true';
  return value;
}

function workflowProjectedRow<T>(definition: WorkflowProjectionDefinition, stored: WorkflowStoredRecord): ProjectedRow<T> {
  if (typeof stored.id !== 'string' || !Number.isSafeInteger(stored.row_version) || (stored.row_version as number) < 1) {
    throw new SupabaseStoreError('STORAGE', 'Workflow projection contains an invalid storage row');
  }
  if (definition.storage === 'mixed' && stored.workflow_contract_version !== 2) {
    throw new SupabaseStoreError('STORAGE', 'Workflow projection row is not a V2 record');
  }
  if (definition.legacyQuarantineColumn && stored[definition.legacyQuarantineColumn] !== 0) {
    throw new SupabaseStoreError('STORAGE', 'Workflow projection row is not clear of legacy quarantine');
  }
  const body = definition.bodyColumn === 'payload' ? stored.payload : stored.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SupabaseStoreError('STORAGE', 'Workflow projection contains an invalid body');
  }
  try {
    return validateWorkflowProjectionBody<T>(definition.table, stored.id, stored.row_version as number, cloneRow(body));
  } catch {
    throw markStorageFailure(new SupabaseStoreError('STORAGE', 'Workflow projection body failed validation'), { table: definition.table });
  }
}

function workflowEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function workflowQueryLimit(query: WorkflowStorageQuery): number {
  return query.kind === 'scoped' ? query.limit ?? 25 : 100;
}

function workflowMatchesQuery(query: WorkflowStorageQuery, row: ProjectedRow<unknown>, includeCursor = true): boolean {
  if (query.kind === 'ids') return query.ids.includes(row.id);
  if (query.kind === 'unique') {
    return Object.entries(query.values).every(([key, value]) => pathValue(row.body, key) === value || (key === 'id' && row.id === value));
  }
  const body = row.body as Record<string, unknown>;
  const definition = getWorkflowProjection(query.table);
  if (query.ownerId !== undefined && body[definition.ownerField ?? 'ownerId'] !== query.ownerId) return false;
  if (query.orgUnitId !== undefined && body[definition.orgUnitField ?? 'orgUnitId'] !== query.orgUnitId) return false;
  if (query.branchIds !== undefined) {
    const branch = body[definition.branchField ?? 'branchId'];
    const responsibilityBranches = body.branchIds;
    if (typeof branch === 'string' ? !query.branchIds.includes(branch) : !Array.isArray(responsibilityBranches) || !responsibilityBranches.some((id) => query.branchIds?.includes(String(id)))) return false;
  }
  if (query.status !== undefined && workflowState(definition, body) !== query.status) return false;
  const dateField = definition.dateField ?? 'date';
  const date = body[dateField];
  if ((query.fromDate !== undefined || query.throughDate !== undefined) && typeof date !== 'string') return false;
  if (query.fromDate !== undefined && (date as string) < query.fromDate) return false;
  if (query.throughDate !== undefined && (date as string) > query.throughDate) return false;
  if (includeCursor && query.cursor !== undefined && row.id <= query.cursor) return false;
  for (const [field, expected] of Object.entries(query.equals ?? {})) {
    const actual = pathValue(body, field);
    if (expected === null ? actual !== undefined && actual !== null : actual !== expected) return false;
  }
  return true;
}

function changeBytes(change: StagedChange): number {
  return Buffer.byteLength(JSON.stringify(change), 'utf8');
}

function cloneChanges(changes: Map<Table, Map<string, StagedChange>>): StagedChange[] {
  const result: StagedChange[] = [];
  for (const tableChanges of changes.values()) {
    for (const change of tableChanges.values()) result.push(change);
  }
  return result;
}

export function createSupabaseStore(url: string, serviceKey: string): Store & WorkflowStore & WorkflowStoreCapability {
  let client: SupabaseClient;
  try {
    client = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
    });
  } catch {
    throw new SupabaseStoreError('STORAGE', 'Supabase store configuration is invalid');
  }
  return createSupabaseStoreFromClient(client);
}

/** Adapter-only injection seam for deterministic RPC and revision contract tests. */
export function createSupabaseStoreFromClient(client: SupabaseClient): Store & WorkflowStore & WorkflowStoreCapability {

  async function listRows<T>(tableName: Table, dbClient: SupabaseClient, filterInput?: RowFilter, options?: { limit?: number }): Promise<T[]> {
    const table = requireTable(tableName);
    const limit = Number.isSafeInteger(options?.limit) && options!.limit! > 0 ? options!.limit! : undefined;
    const filter = validateRowFilter(filterInput);
    if (hasEmptyFilterValue(filter)) return [];
    const values: T[] = [];
    let markerMissing = false;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const read = (withMarker: boolean) => {
        let query = dbClient.from(table).select('id,payload');
        if (withMarker) query = query.is('workflow_contract_version', null);
        for (const [key, expected] of Object.entries(filter ?? {})) {
          const column = `payload->>${key}`;
          query = Array.isArray(expected) ? query.in(column, expected) : query.eq(column, expected);
        }
        const pageSize = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - offset);
        return query.order('id', { ascending: true }).range(offset, offset + pageSize - 1);
      };
      const mixed = workflowProjectionManifest.get(table)?.storage === 'mixed';
      let { data, error } = await read(mixed && !markerMissing);
      if (mixed && error && missingLegacyWorkflowMarker(error)) {
        markerMissing = true;
        ({ data, error } = await read(false));
      }
      if (error) throw mapReadDatabaseError(error, 'Supabase store list failed', 'list');
      const rows = (data ?? []) as StoredRecord[];
      checkReadLimit(values.length + rows.length);
      for (const row of rows) values.push(decodeLegacyRow(table, row, markerMissing) as T);
      if (limit !== undefined && values.length >= limit) return values.slice(0, limit);
      if (rows.length < PAGE_SIZE) return values;
    }
  }

  async function getRow<T>(tableName: Table, id: string, dbClient: SupabaseClient): Promise<T | undefined> {
    const table = requireTable(tableName);
    const read = (withMarker: boolean) => {
      let query = dbClient.from(table).select('id,payload').eq('id', id);
      if (withMarker) query = query.is('workflow_contract_version', null);
      return query.maybeSingle();
    };
    const mixed = workflowProjectionManifest.get(table)?.storage === 'mixed';
    let { data, error } = await read(mixed);
    const markerMissing = mixed && !!error && missingLegacyWorkflowMarker(error);
    if (markerMissing) ({ data, error } = await read(false));
    if (error) throw mapReadDatabaseError(error, 'Supabase store get failed', 'get');
    return data ? decodeLegacyRow(table, data as StoredRecord, markerMissing) as T : undefined;
  }

  async function assertV1MayMutate(table: Table, id: string, incomingBody?: Record<string, unknown>): Promise<void> {
    if (workflowProjectionManifest.get(table)?.storage !== 'mixed') return;
    let { data, error } = await client.from(table).select('id,payload,workflow_contract_version').eq('id', id).maybeSingle();
    if (error && missingLegacyWorkflowMarker(error)) {
      ({ data, error } = await client.from(table).select('id,payload').eq('id', id).maybeSingle());
    }
    if (error) throw mapReadDatabaseError(error, 'Supabase workflow row guard failed', 'workflow_guard');
    const stored = data as WorkflowStoredRecord | null;
    const existingBody = stored ? decodeRow({ id: stored.id, payload: stored.payload }) : undefined;
    if (
      stored?.workflow_contract_version === 2
      || (existingBody !== undefined && isMarkerlessV2WorkflowBody(table, existingBody))
      || (incomingBody !== undefined && isMarkerlessV2WorkflowBody(table, incomingBody))
    ) {
      throw new SupabaseStoreError('STORAGE', 'V1 writes cannot change a protected V2 row', true);
    }
  }

  async function readRevision(): Promise<string> {
    const { data, error } = await client.from('appmeta').select('revision').eq('singleton', 1).single();
    if (error) throw mapReadDatabaseError(error, 'Supabase store revision read failed', 'revision');
    const revision = (data as { revision?: unknown } | null)?.revision;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) return String(revision);
    if (typeof revision === 'string' && /^\d+$/.test(revision)) return revision;
    throw new SupabaseStoreError('STORAGE', 'Supabase store revision is invalid');
  }

  async function readRevisionForTransactionPreflight(): Promise<string> {
    try {
      return await readRevision();
    } catch (error) {
      if (error instanceof StorageReadUnavailableError) {
        Object.defineProperties(error, {
          code: { value: 'STORAGE', configurable: true },
          definitelyNotCommitted: { value: true, configurable: true },
        });
      }
      throw error;
    }
  }

  async function fetchWorkflowRows<T>(queryInput: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> {
    const definition = getWorkflowProjection(queryInput.table);
    workflowQueryFields(queryInput);
    const bodyColumn = definition.bodyColumn;
    const branchChild = queryInput.kind === 'scoped' && queryInput.branchIds !== undefined
      ? definition.normalizedChildren.find((child) => child.target === 'branches')
      : undefined;
    const selectFields = [
      'id', 'row_version', bodyColumn,
      ...(definition.markerColumn ? [definition.markerColumn] : []),
      ...(definition.legacyQuarantineColumn ? [definition.legacyQuarantineColumn] : []),
      ...(branchChild ? [`${branchChild.table}!inner(${branchChild.childIdColumn})`] : []),
    ].join(',');
    const run = async (filters: WorkflowRemoteFilter[], limit: number): Promise<ProjectedRow<T>[]> => {
      let builder = client.from(definition.table).select(selectFields);
      if (definition.storage === 'mixed') builder = builder.eq('workflow_contract_version', 2);
      for (const filter of filters) {
        switch (filter.kind) {
          case 'eq': builder = builder.eq(filter.column, filter.value); break;
          case 'is': builder = builder.is(filter.column, filter.value); break;
          case 'in': builder = builder.in(filter.column, filter.values); break;
          case 'gt': builder = builder.gt(filter.column, filter.value); break;
          case 'gte': builder = builder.gte(filter.column, filter.value); break;
          case 'lte': builder = builder.lte(filter.column, filter.value); break;
        }
      }
      const { data, error } = await builder.order('id', { ascending: true }).range(0, limit - 1);
      if (error) throw markStorageFailure(mapReadDatabaseError(error, 'Supabase workflow query failed', 'workflow_query'), {
        table: definition.table,
        databaseCode: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined,
      });
      const rows = (data ?? []) as unknown as WorkflowStoredRecord[];
      return rows.map((row) => workflowProjectedRow<T>(definition, row));
    };

    if (queryInput.kind === 'ids') {
      if (queryInput.ids.length > 10_000) throw new SupabaseStoreError('STORAGE', 'Workflow query exceeds the ID limit');
      const ids = Array.from(new Set(queryInput.ids));
      ids.forEach(requireWorkflowId);
      const rows: ProjectedRow<T>[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const chunk = ids.slice(offset, offset + 100);
        const result = await run([chunk.length === 1
          ? { kind: 'eq', column: 'id', value: chunk[0] }
          : { kind: 'in', column: 'id', values: chunk }], 100);
        rows.push(...result);
      }
      return rows;
    }

    if (queryInput.kind === 'unique') {
      const constraint = assertWorkflowUniqueKey(queryInput.table, queryInput.constraint, queryInput.values);
      const filters: WorkflowRemoteFilter[] = constraint.fields.map((field) => ({
        kind: 'eq', column: workflowColumn(definition, field), value: queryInput.values[field],
      }));
      if (constraint.openOnly && definition.stateField && constraint.openStates?.length) {
        const state = definition.columns.find((column) => column.bodyField === definition.stateField);
        if (!state) throw new SupabaseStoreError('STORAGE', 'Workflow state projection is missing');
        filters.push({ kind: 'in', column: state.column, values: constraint.openStates.map((value) => workflowStateDatabaseValue(definition, value)) });
      }
      return run(filters, 2);
    }

    const limit = queryInput.limit ?? 25;
    const filters: WorkflowRemoteFilter[] = [];
    if (queryInput.ownerId !== undefined) filters.push({ kind: 'eq', column: workflowColumn(definition, definition.ownerField ?? 'ownerId'), value: queryInput.ownerId });
    if (queryInput.orgUnitId !== undefined) filters.push({ kind: 'eq', column: workflowColumn(definition, definition.orgUnitField ?? 'orgUnitId'), value: queryInput.orgUnitId });
    if (queryInput.branchIds !== undefined) {
      if (queryInput.branchIds.length === 0) return [];
      if (queryInput.branchIds.length > 100) throw new SupabaseStoreError('STORAGE', 'Workflow branch scope exceeds the ID limit');
      filters.push({
        kind: 'in',
        column: branchChild ? `${branchChild.table}.${branchChild.childIdColumn}` : workflowColumn(definition, definition.branchField ?? 'branchId'),
        values: [...queryInput.branchIds],
      });
    }
    if (queryInput.status !== undefined) {
      if (!definition.stateField) throw new SupabaseStoreError('STORAGE', 'Workflow status query is unsupported');
      const state = definition.columns.find((column) => column.bodyField === definition.stateField);
      if (!state) throw new SupabaseStoreError('STORAGE', 'Workflow state projection is missing');
      filters.push({ kind: 'eq', column: state.column, value: workflowStateDatabaseValue(definition, queryInput.status) });
    }
    const dateField = definition.dateField ?? 'date';
    if (queryInput.fromDate !== undefined) filters.push({ kind: 'gte', column: workflowColumn(definition, dateField), value: queryInput.fromDate });
    if (queryInput.throughDate !== undefined) filters.push({ kind: 'lte', column: workflowColumn(definition, dateField), value: queryInput.throughDate });
    if (queryInput.cursor !== undefined) { requireWorkflowId(queryInput.cursor); filters.push({ kind: 'gt', column: 'id', value: queryInput.cursor }); }
    for (const [field, value] of Object.entries(queryInput.equals ?? {})) {
      const projected = definition.columns.find((column) => column.bodyField === field && !column.legacyOnly && !column.external);
      if (!projected || !definition.queryFields.includes(field) || projected.type === 'json') {
        throw new SupabaseStoreError('STORAGE', 'Workflow equality query is unsupported');
      }
      filters.push(value === null
        ? { kind: 'is', column: projected.column, value: null }
        : { kind: 'eq', column: projected.column, value });
    }
    return run(filters, limit);
  }

  async function readStableWorkflowRows<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await readRevision();
      const rows = await fetchWorkflowRows<T>(query);
      const after = await readRevision();
      if (before === after) return rows;
      if (attempt === 1) throw new SupabaseStoreError('CONFLICT', 'Supabase workflow read observed a revision change', true);
    }
    throw new SupabaseStoreError('CONFLICT', 'Supabase workflow read could not obtain a stable revision', true);
  }

  const workflowProjectionReader: WorkflowProjectionReader = {
    async get<T>(table: WorkflowStorageQuery['table'], id: string): Promise<ProjectedRow<T> | undefined> {
      if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Workflow projection reader requires a projected table');
      requireWorkflowId(id);
      return (await readStableWorkflowRows<T>({ kind: 'ids', table, ids: [id] }))[0];
    },
    async query<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> {
      if (!workflowProjectionManifest.has(query.table)) throw new SupabaseStoreError('STORAGE', 'Workflow projection reader requires a projected table');
      return readStableWorkflowRows<T>(query);
    },
  };

  async function workflowTransaction<T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> {
    for (let retry = 0; retry < 2; retry += 1) {
      const expectedRevision = await readRevisionForTransactionPreflight();
      let active = true;
      let businessIntent = false;
      let commitDispatched = false;
      let transactionFailure: SupabaseStoreError | undefined;
      let stagedBytes = 0;
      const intents: WorkflowIntent[] = [];
      const rowCache = new Map<string, ProjectedRow<unknown> | undefined>();
      const queryCache = new Map<string, ProjectedRow<unknown>[]>();
      const metadataByRow = new Map<string, Readonly<Record<string, string | number>>>();
      const legacyRowCache = new Map<string, Record<string, unknown> | undefined>();
      const legacyListCache = new Map<string, Record<string, unknown>[]>();
      const assertActive = (): void => {
        if (!active) throw new SupabaseStoreError('STORAGE', 'Supabase workflow transaction is no longer active');
        if (transactionFailure) throw transactionFailure;
      };
      const rejectCursorOverlay = (message: string): never => {
        transactionFailure = new SupabaseStoreError('STORAGE', message, true);
        throw transactionFailure;
      };
      const rowKey = (table: WorkflowStorageQuery['table'], id: string): string => JSON.stringify([table, id]);
      const projectedFromCache = async <U>(table: WorkflowStorageQuery['table'], id: string): Promise<ProjectedRow<U> | undefined> => {
        const key = rowKey(table, id);
        if (rowCache.has(key)) {
          const cached = rowCache.get(key);
          return cached === undefined ? undefined : cloneRow(cached) as ProjectedRow<U>;
        }
        const cached = await fetchWorkflowRows<U>({ kind: 'ids', table, ids: [id] });
        const row = cached[0];
        rowCache.set(key, row ? cloneRow(row) : undefined);
        return row ? cloneRow(row) as ProjectedRow<U> : undefined;
      };
      const projectedQuery = async <U>(query: WorkflowStorageQuery): Promise<ProjectedRow<U>[]> => {
        assertActive();
        workflowQueryFields(query);
        const cacheKey = JSON.stringify(query);
        const cached = queryCache.get(cacheKey);
        const base = cached ? cloneRow(cached) as unknown as ProjectedRow<U>[] : await fetchWorkflowRows<U>(query);
        if (!cached) {
          queryCache.set(cacheKey, cloneRow(base) as ProjectedRow<unknown>[]);
          for (const row of base) rowCache.set(rowKey(query.table, row.id), cloneRow(row));
          // An ids query proves absence too; remembering it spares one round trip per later primary-key probe.
          if (query.kind === 'ids') {
            for (const id of query.ids) if (!rowCache.has(rowKey(query.table, id))) rowCache.set(rowKey(query.table, id), undefined);
          }
        }
        if (query.kind === 'unique') {
          const definition = getWorkflowProjection(query.table);
          const externalFields = new Set(definition.columns.filter((column) => column.external).map((column) => column.bodyField));
          for (const row of base) {
            const key = rowKey(query.table, row.id);
            const existingMetadata = metadataByRow.get(key) ?? {};
            const fetchedMetadata = Object.fromEntries(Object.entries(query.values).filter(([field]) => externalFields.has(field)));
            metadataByRow.set(key, { ...existingMetadata, ...fetchedMetadata });
          }
        }
        const byId = new Map(base.map((row) => [row.id, cloneRow(row)]));
        if (query.kind === 'scoped' && query.cursor !== undefined) {
          const baseIds = new Set(base.map((row) => row.id));
          const stagedById = new Map<string, WorkflowIntent>();
          const stagedInsertIds = new Set<string>();
          for (const intent of intents) {
            if (intent.table !== query.table) continue;
            const id = intent.kind === 'insert_unique' ? intent.row.id : intent.id;
            stagedById.set(id, intent);
            if (intent.kind === 'insert_unique') stagedInsertIds.add(id);
          }
          const limit = workflowQueryLimit(query);
          for (const intent of stagedById.values()) {
            const next = intent.kind === 'insert_unique' ? intent.row : intent.next;
            const wasInDatabasePage = baseIds.has(next.id);
            const matchesWithoutCursor = workflowMatchesQuery(query, next, false);
            if (stagedInsertIds.has(next.id) && wasInDatabasePage) {
              rejectCursorOverlay('Supabase workflow cursor page cannot overlay an ID already in its database page');
            }
            if (matchesWithoutCursor && !wasInDatabasePage) {
              rejectCursorOverlay('Supabase workflow cursor page cannot position a staged row without database ordering');
            }
            if (!matchesWithoutCursor && wasInDatabasePage && base.length >= limit) {
              rejectCursorOverlay('Supabase workflow cursor page cannot refill after a staged row leaves the page');
            }
            if (matchesWithoutCursor) byId.set(next.id, cloneRow(next) as ProjectedRow<U>);
            else byId.delete(next.id);
            rowCache.set(rowKey(query.table, next.id), cloneRow(next));
          }
          return Array.from(byId.values()).slice(0, limit);
        }
        for (const intent of intents) {
          if (intent.table !== query.table) continue;
          const next = intent.kind === 'insert_unique' ? intent.row : intent.next;
          let matches = query.kind === 'unique'
            ? Object.entries(query.values).every(([field, value]) => {
              const cachedValue = metadataByRow.get(rowKey(query.table, next.id))?.[field];
              const rowValue = field === 'id' ? next.id : pathValue(next.body, field);
              const intentValue = intent.kind === 'insert_unique' ? intent.values[field] : undefined;
              return (intentValue ?? cachedValue ?? rowValue) === value;
            })
            : workflowMatchesQuery(query, next);
          if (matches && query.kind === 'unique') {
            const constraint = assertWorkflowUniqueKey(query.table, query.constraint, query.values);
            if (constraint.openOnly) {
              const definition = getWorkflowProjection(query.table);
              matches = constraint.openStates?.includes(workflowState(definition, next.body) ?? '') ?? false;
            }
          }
          if (matches) byId.set(next.id, cloneRow(next) as ProjectedRow<U>);
          else byId.delete(next.id);
          rowCache.set(rowKey(query.table, next.id), cloneRow(next));
        }
        return Array.from(byId.values()).slice(0, workflowQueryLimit(query));
      };
      const appendIntent = (intent: WorkflowIntent): void => {
        const nextCount = intents.length + 1;
        if (nextCount > MAX_TRANSACTION_CHANGES) throw new SupabaseStoreError('STORAGE', 'Supabase workflow transaction exceeds the change limit', true);
        const bytes = Buffer.byteLength(JSON.stringify(intent), 'utf8');
        const nextBytes = stagedBytes + bytes;
        const wireBytes = nextBytes + nextCount + 1;
        if (wireBytes > MAX_TRANSACTION_BYTES) throw new SupabaseStoreError('STORAGE', 'Supabase workflow transaction exceeds the payload limit', true);
        intents.push(intent);
        stagedBytes = nextBytes;
        queryCache.clear();
      };
      const internalReader: WorkflowProjectionReader = {
        async get<U>(table: WorkflowStorageQuery['table'], id: string): Promise<ProjectedRow<U> | undefined> {
          assertActive();
          if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Workflow projection reader requires a projected table');
          requireWorkflowId(id);
          return projectedFromCache<U>(table, id);
        },
        async query<U>(query: WorkflowStorageQuery): Promise<ProjectedRow<U>[]> {
          if (!workflowProjectionManifest.has(query.table)) throw new SupabaseStoreError('STORAGE', 'Workflow projection reader requires a projected table');
          return projectedQuery<U>(query);
        },
      };
      const internalTx: WorkflowTransactionContext = {
        workflowProjectionReader: internalReader,
        async list<U>(table: WorkflowStorageQuery['table'], filter?: RowFilter): Promise<U[]> {
          assertActive();
          if (workflowProjectionManifest.has(table)) {
            return (await projectedQuery<U>(workflowRowFilterQuery(table, validateRowFilter(filter)))).map((row) => cloneRow(row.body));
          }
          if (!isLegacyTable(table)) throw new SupabaseStoreError('STORAGE', 'Supabase workflow reader received an unsupported table');
          const validatedFilter = validateRowFilter(filter);
          const cacheKey = JSON.stringify([table, validatedFilter ?? null]);
          let rows = legacyListCache.get(cacheKey);
          if (!rows) {
            rows = await listRows<Record<string, unknown>>(table, client, validatedFilter);
            legacyListCache.set(cacheKey, cloneRow(rows));
          }
          return cloneRow(rows) as U[];
        },
        async get<U>(table: WorkflowStorageQuery['table'], id: string): Promise<U | undefined> {
          assertActive();
          if (workflowProjectionManifest.has(table)) return (await projectedFromCache<U>(table, id))?.body;
          if (!isLegacyTable(table)) throw new SupabaseStoreError('STORAGE', 'Supabase workflow reader received an unsupported table');
          const cacheKey = rowKey(table, id);
          if (legacyRowCache.has(cacheKey)) {
            const cached = legacyRowCache.get(cacheKey);
            return cached === undefined ? undefined : cloneRow(cached) as U;
          }
          const row = await getRow<Record<string, unknown>>(table, id, client);
          legacyRowCache.set(cacheKey, row ? cloneRow(row) : undefined);
          return row === undefined ? undefined : cloneRow(row) as U;
        },
        async insertUnique<U extends { id: string }>(table: WorkflowStorageQuery['table'], row: U, key: { constraint: string; values: Record<string, string | number> }): Promise<{ inserted: true; row: U } | { inserted: false; existing: U }> {
          assertActive();
          businessIntent = true;
          if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Supabase workflow writer received an unsupported table', true);
          const definition = getWorkflowProjection(table);
          let constraint: ReturnType<typeof assertWorkflowUniqueKey>;
          try { constraint = assertWorkflowUniqueKey(table, key.constraint, key.values); }
          catch { throw new SupabaseStoreError('STORAGE', 'Workflow unique constraint is unsupported', true); }
          let encoded: ReturnType<typeof encodeRow>;
          try { encoded = encodeRow(row); }
          catch { throw new SupabaseStoreError('STORAGE', 'Workflow insert body failed validation', true); }
          if (key.values.id !== undefined && key.values.id !== encoded.id) throw new SupabaseStoreError('STORAGE', 'Workflow unique key does not match row id', true);
          let candidate: ProjectedRow<U>;
          try { candidate = validateWorkflowProjectionWriteBody<U>(table, encoded.id, 1, encoded.payload); }
          catch { throw new SupabaseStoreError('STORAGE', 'Workflow insert body failed validation', true); }
          for (const field of constraint.fields) {
            const keyValue = key.values[field];
            if (keyValue === undefined) throw new SupabaseStoreError('STORAGE', 'Workflow unique key is incomplete', true);
            if (field === 'id' && keyValue !== candidate.id) throw new SupabaseStoreError('STORAGE', 'Workflow unique key does not match row id', true);
            if (!definition.columns.some((column) => column.external && column.bodyField === field) && field !== 'id' && pathValue(candidate.body, field) !== keyValue) {
              throw new SupabaseStoreError('STORAGE', 'Workflow unique key does not match the row body', true);
            }
          }
          const primaryKeyProbe = key.constraint === `${table}_primary_key` && Object.keys(key.values).length === 1 && key.values.id === candidate.id
            && rowCache.has(rowKey(table, candidate.id));
          const existing = primaryKeyProbe
            ? (rowCache.get(rowKey(table, candidate.id)) ? [cloneRow(rowCache.get(rowKey(table, candidate.id))!) as ProjectedRow<U>] : [])
            : await projectedQuery<U>({ kind: 'unique', table, constraint: key.constraint, values: key.values });
          if (existing.length) {
            for (const field of definition.immutableFields) {
              if (field === 'id') continue;
              if (!workflowEqual(pathValue(existing[0].body, field), pathValue(candidate.body, field))) {
                throw new SupabaseStoreError('CONFLICT', 'Workflow unique key conflicts with different immutable data', true);
              }
            }
            return { inserted: false, existing: existing[0].body };
          }
          const intent: WorkflowIntent = {
            kind: 'insert_unique',
            table,
            constraint: key.constraint,
            values: { ...key.values },
            row: candidate,
          };
          appendIntent(intent);
          rowCache.set(rowKey(table, candidate.id), cloneRow(candidate));
          metadataByRow.set(rowKey(table, candidate.id), { ...key.values });
          return { inserted: true, row: candidate.body };
        },
        async compareAndSwap<U extends { id: string; rowVersion: number }>(table: WorkflowStorageQuery['table'], id: string, expected: { rowVersion: number; state: string | null }, next: U): Promise<{ updated: true; row: CasBody<U> } | { updated: false; current: CasBody<U> | null }> {
          assertActive();
          businessIntent = true;
          if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Supabase workflow writer received an unsupported table', true);
          requireWorkflowId(id);
          if (!Number.isSafeInteger(expected.rowVersion) || expected.rowVersion < 1 || next.rowVersion !== expected.rowVersion + 1) {
            throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap version is invalid', true);
          }
          const definition = getWorkflowProjection(table);
          const current = await projectedFromCache<CasBody<U>>(table, id);
          const currentState = current ? workflowState(definition, current.body) : null;
          if (!current || current.rowVersion !== expected.rowVersion || currentState !== expected.state) {
            transactionFailure = new SupabaseStoreError('CONFLICT', 'Supabase workflow compare-and-swap is stale', true);
            return { updated: false, current: current?.body ?? null };
          }
          try { validateWorkflowProjectionWriteBody(table, current.id, current.rowVersion, current.body); }
          catch { throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap current row is legacy read-only', true); }
          let candidate: ProjectedRow<CasBody<U>>;
          try { candidate = validateWorkflowCasBody<U>(table, id, expected.rowVersion, next); }
          catch { throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap body failed validation', true); }
          for (const field of definition.immutableFields) {
            if (field === 'id') continue;
            if (!workflowEqual(pathValue(current.body, field), pathValue(candidate.body, field))) {
              throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap changed an immutable field', true);
            }
          }
          const nextState = workflowState(definition, candidate.body);
          for (const field of definition.terminalImmutableFields[currentState ?? ''] ?? []) {
            if (!workflowEqual(pathValue(current.body, field), pathValue(candidate.body, field))) {
              throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap changed terminal proof data', true);
            }
          }
          if (definition.stateField && currentState !== nextState) {
            const allowed = currentState === null ? [] : definition.permittedTransitions[currentState] ?? [];
            if (nextState === null || !allowed.includes(nextState)) throw new SupabaseStoreError('STORAGE', 'Workflow compare-and-swap attempted an invalid state transition', true);
          }
          const intent: WorkflowIntent = { kind: 'cas', table, id, expected: { ...expected }, next: candidate };
          appendIntent(intent);
          rowCache.set(rowKey(table, id), cloneRow(candidate));
          return { updated: true, row: candidate.body };
        },
      };

      try {
        const value = await work(internalTx);
        if (transactionFailure && intents.length > 0) throw transactionFailure;
        active = false;
        if (intents.length > 0) {
          try {
            commitDispatched = true;
            const { error } = await client.rpc('nexus_workflow_commit', {
              expected_revision: expectedRevision,
              operations: intents,
            });
            if (error) throw mapDatabaseError(error, 'Supabase workflow commit outcome is unknown', { rpc: 'nexus_workflow_commit' });
          } catch (error) {
            if (error instanceof SupabaseStoreError) throw error;
            throw markStorageFailure(new SupabaseStoreError('STORAGE', 'Supabase workflow commit outcome is unknown'), { rpc: 'nexus_workflow_commit' });
          }
          return value;
        }
        if (await readRevision() !== expectedRevision) {
          if (!businessIntent && retry === 0) continue;
          throw revisionConflict('Supabase workflow transaction conflicted with a concurrent write');
        }
        return value;
      } catch (error) {
        active = false;
        throw supabaseErrorBeforeDispatch(error, commitDispatched);
      }
    }
    throw new SupabaseStoreError('CONFLICT', 'Supabase workflow read could not obtain a stable revision', true);
  }

  return {
    adapter: 'supabase',
    workflowContractVersion: 2,
    workflowProjectionReader,
    async list<T>(table: WorkflowStorageQuery['table'], filter?: RowFilter, options?: { limit?: number }): Promise<T[]> {
      if (!isLegacyTable(table)) {
        if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Supabase store received an unsupported table');
        return (await readStableWorkflowRows<T>(workflowRowFilterQuery(table, validateRowFilter(filter)))).map((row) => row.body);
      }
      return listRows<T>(table, client, filter, options);
    },
    async get<T>(table: WorkflowStorageQuery['table'], id: string): Promise<T | undefined> {
      if (!isLegacyTable(table)) {
        if (!workflowProjectionManifest.has(table)) throw new SupabaseStoreError('STORAGE', 'Supabase store received an unsupported table');
        requireWorkflowId(id);
        return (await readStableWorkflowRows<T>({ kind: 'ids', table, ids: [id] }))[0]?.body;
      }
      return getRow<T>(table, id, client);
    },
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const expectedRevision = await readRevisionForTransactionPreflight();
      let active = true;
      let commitDispatched = false;
      const changes = new Map<Table, Map<string, StagedChange>>();
      let stagedCount = 0;
      let stagedBytes = 0;
      const assertActive = () => {
        if (!active) throw new SupabaseStoreError('STORAGE', 'Supabase transaction is no longer active');
      };
      const tableChanges = (table: Table): Map<string, StagedChange> => {
        let records = changes.get(table);
        if (!records) {
          records = new Map<string, StagedChange>();
          changes.set(table, records);
        }
        return records;
      };
      const stage = (change: StagedChange): void => {
        const records = tableChanges(change.table);
        const key = change.id;
        const previous = records.get(key);
        const nextCount = stagedCount + (previous ? 0 : 1);
        if (nextCount > MAX_TRANSACTION_CHANGES) throw new SupabaseStoreError('STORAGE', 'Supabase transaction exceeds the change limit');
        const previousBytes = previous ? changeBytes(previous) : 0;
        const nextBytes = stagedBytes - previousBytes + changeBytes(change);
        const wireBytes = nextCount === 0 ? 2 : nextBytes + nextCount + 1;
        if (wireBytes > MAX_TRANSACTION_BYTES) throw new SupabaseStoreError('STORAGE', 'Supabase transaction exceeds the payload limit');
        records.set(key, change);
        if (!previous) stagedCount = nextCount;
        stagedBytes = nextBytes;
      };

      const tx: Transaction = {
        async list<U>(tableName: Table, filterInput?: RowFilter): Promise<U[]> {
          assertActive();
          const table = requireTable(tableName);
          const filter = validateRowFilter(filterInput);
          const base = await listRows<U>(table, client, filter);
          const byId = new Map<string, U>();
          for (const row of base) {
            if (typeof row !== 'object' || row === null || typeof (row as { id?: unknown }).id !== 'string') {
              throw new SupabaseStoreError('STORAGE', 'Supabase store contains an invalid row');
            }
            byId.set((row as unknown as { id: string }).id, row);
          }
          for (const change of changes.get(table)?.values() ?? []) {
            if (change.payload === null || !matchesValidatedRowFilter(change.payload, filter)) byId.delete(change.id);
            else byId.set(change.id, cloneRow(change.payload) as U);
          }
          checkReadLimit(byId.size);
          return Array.from(byId.values(), (row) => cloneRow(row));
        },
        async get<U>(tableName: Table, id: string): Promise<U | undefined> {
          assertActive();
          const table = requireTable(tableName);
          const staged = changes.get(table)?.get(id);
          if (staged) return staged.payload === null ? undefined : cloneRow(staged.payload) as U;
          const row = await getRow<U>(table, id, client);
          return row === undefined ? undefined : cloneRow(row);
        },
        async put<U extends { id: string }>(tableName: Table, value: U): Promise<void> {
          assertActive();
          const table = requireTable(tableName);
          const encoded = encodeRow(value);
          await assertV1MayMutate(table, encoded.id, encoded.payload);
          stage({ table, id: encoded.id, payload: encoded.payload });
        },
        async remove(tableName: Table, id: string): Promise<void> {
          assertActive();
          const table = requireTable(tableName);
          if (typeof id !== 'string') throw new SupabaseStoreError('STORAGE', 'Store ids must be strings');
          await assertV1MayMutate(table, id);
          stage({ table, id, payload: null });
        }
      };

      try {
        const value = await work(tx);
        active = false;
        const staged = cloneChanges(changes);
        if (staged.length > 0) {
          commitDispatched = true;
          const { error } = await client.rpc('nexus_commit', {
            expected_revision: expectedRevision,
            changes: staged
          });
          if (error) throw mapDatabaseError(error, 'Supabase store commit failed', { rpc: 'nexus_commit' });
        } else if (await readRevision() !== expectedRevision) {
          throw revisionConflict('Supabase store transaction conflicted with a concurrent write');
        }
        return value;
      } catch (error) {
        active = false;
        throw supabaseErrorBeforeDispatch(error, commitDispatched);
      }
    },
    workflowTransaction,
  };
}
