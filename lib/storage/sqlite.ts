import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { DomainError } from '../core/errors';
import { businessDateSchema, tables, type Store, type Table, type Transaction } from '../contracts';
import type { CasBody, WorkflowStore } from '../workflows/contracts';
import { hasEmptyFilterValue, type RowFilter, validateRowFilter } from './filters';
import { applyWorkflowSqliteMigrations } from './workflow-sqlite-migrations';
import { sqliteReadUnavailableError, type StorageReadOperation } from './read-error';
import {
  assertWorkflowUniqueKey,
  getWorkflowProjection,
  isMarkerlessV2WorkflowBody,
  isLegacyTable,
  workflowProjectionManifest,
  validateWorkflowProjectionBody,
  validateWorkflowProjectionWriteBody,
  validateWorkflowCasBody,
  workflowQueryFields,
  workflowRowFilterQuery,
  type ProjectedRow,
  type WorkflowProjectionColumn,
  type WorkflowProjectionDefinition,
  type WorkflowStorageQuery,
  type WorkflowStoreCapability,
  type WorkflowTransactionContext,
} from './workflow-projections';

const MAX_TRANSACTION_CHANGES = 50_000;
const MAX_TRANSACTION_BYTES = 20 * 1024 * 1024;

type StoredRecord = { id: string; payload: string };
type WorkflowStoredRecord = {
  id: string;
  row_version: number | null;
  payload?: string | null;
  body?: string | null;
  workflow_contract_version?: number | null;
  [column: string]: unknown;
};
type ChangeFootprint = { bytes: number };
type SharedQueueHost = { [key: symbol]: unknown };
const queueKey = Symbol.for('biztania-ai-concierge.sqlite-transaction-queues');

function mapSqliteReadError(error: unknown, operation: StorageReadOperation): unknown {
  if (!(error instanceof Database.SqliteError)) return error;
  return sqliteReadUnavailableError(error, operation) ?? error;
}

export class WorkflowStorageError extends Error {
  readonly code: 'STORAGE' | 'CONFLICT';
  readonly definitelyNotCommitted: boolean;

  constructor(code: 'STORAGE' | 'CONFLICT', message: string, definitelyNotCommitted = false) {
    super(message);
    this.name = 'WorkflowStorageError';
    this.code = code;
    this.definitelyNotCommitted = definitelyNotCommitted;
  }
}

function workflowConstraintError(error: unknown, operation: string): WorkflowStorageError | undefined {
  if (!(error instanceof Database.SqliteError)) return undefined;
  const code = error.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new WorkflowStorageError('CONFLICT', `SQLite ${operation} conflicted with an existing unique row`, true);
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new WorkflowStorageError('STORAGE', `SQLite ${operation} violated a storage constraint`, true);
  }
  return undefined;
}

function workflowErrorAfterRollback(error: unknown, operation: string, rollbackConfirmed: boolean): unknown {
  if (error instanceof WorkflowStorageError) {
    if (!rollbackConfirmed || error.definitelyNotCommitted) return error;
    return new WorkflowStorageError(error.code, error.message, true);
  }
  if (error instanceof DomainError) {
    if (!rollbackConfirmed || (error as DomainError & { definitelyNotCommitted?: unknown }).definitelyNotCommitted === true) return error;
    return Object.assign(new DomainError(error.code, error.message, error.status), { definitelyNotCommitted: true as const });
  }
  if (error instanceof Database.SqliteError) {
    return new WorkflowStorageError('STORAGE', `SQLite ${operation} failed`, rollbackConfirmed);
  }
  return new WorkflowStorageError('STORAGE', `SQLite ${operation} failed`, rollbackConfirmed);
}

const MAX_WORKFLOW_QUERY_IDS = 10_000;
const WORKFLOW_ID_CHUNK_SIZE = 100;

function queuesForProcess(): Map<string, Promise<void>> {
  const host = globalThis as unknown as SharedQueueHost;
  let queues = host[queueKey] as Map<string, Promise<void>> | undefined;
  if (!queues) {
    queues = new Map<string, Promise<void>>();
    host[queueKey] = queues;
  }
  return queues;
}

async function withPathQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const queues = queuesForProcess();
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  queues.set(path, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(path) === current) queues.delete(path);
  }
}

function requireTable(table: Table): Table {
  if (typeof table !== 'string' || !(tables as readonly string[]).includes(table)) {
    throw new Error('SQLite store received an unsupported table');
  }
  return table;
}

function encodeRow(value: unknown): { id: string; payload: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('Store rows must be objects with a string id');
  }

  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch {
    throw new Error('Store row cannot be represented as JSON');
  }
  if (payload === undefined) throw new Error('Store row cannot be represented as JSON');

  let cloned: unknown;
  try {
    cloned = JSON.parse(payload);
  } catch {
    throw new Error('Store row cannot be represented as JSON');
  }
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned) || typeof (cloned as { id?: unknown }).id !== 'string') {
    throw new Error('Store rows must be objects with a string id');
  }
  return { id: (cloned as { id: string }).id, payload };
}

function decodeRow(row: StoredRecord): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch {
    throw new Error('SQLite store contains an invalid row');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as { id?: unknown }).id !== row.id) {
    throw new Error('SQLite store contains an inconsistent row');
  }
  return value as Record<string, unknown>;
}

function requireWorkflowId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300) {
    throw new WorkflowStorageError('STORAGE', 'Workflow storage received an invalid row id', true);
  }
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function sqliteValue(column: WorkflowProjectionColumn, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (column.type === 'boolean') return value === true ? 1 : value === false ? 0 : null;
  if (column.type === 'json') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function workflowColumn(definition: WorkflowProjectionDefinition, bodyField: string): string {
  if (bodyField === 'id') return 'id';
  const projected = definition.columns.find((column) => column.bodyField === bodyField);
  if (!projected) throw new WorkflowStorageError('STORAGE', 'Workflow storage query field is not projected');
  return projected.column;
}

function workflowStateValue(definition: WorkflowProjectionDefinition, body: unknown): string | null {
  if (!definition.stateField) return null;
  const value = getPath(body, definition.stateField);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'active' : 'inactive';
  return null;
}

function workflowStateSqlValue(definition: WorkflowProjectionDefinition, state: string): string | number {
  const stateColumn = definition.columns.find((column) => column.bodyField === definition.stateField);
  if (stateColumn?.type === 'boolean') {
    if (state === 'active' || state === 'true') return 1;
    if (state === 'inactive' || state === 'false') return 0;
  }
  return state;
}

function foreignKeyValue(body: unknown, relation: WorkflowProjectionDefinition['foreignKeys'][number]): unknown {
  const bodyField = relation.bodyField ?? relation.column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  if (relation.tagField) {
    const tag = getPath(body, relation.tagField);
    if (tag !== relation.tagValue) return null;
  }
  return getPath(body, bodyField);
}

function workflowProjectionValues(
  definition: WorkflowProjectionDefinition,
  body: unknown,
  uniqueValues: Readonly<Record<string, string | number>> = {},
): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {};
  for (const projected of definition.columns) {
    if (projected.external && uniqueValues[projected.bodyField] === undefined) continue;
    const value = uniqueValues[projected.bodyField] ?? getPath(body, projected.bodyField);
    const bound = sqliteValue(projected, value);
    if (!projected.nullable && bound === null) {
      throw new WorkflowStorageError('STORAGE', 'Workflow storage is missing a required projection');
    }
    result[projected.column] = bound;
  }
  for (const relation of definition.foreignKeys) {
    if (relation.external && uniqueValues[relation.bodyField ?? ''] === undefined) continue;
    const value = relation.external ? uniqueValues[relation.bodyField ?? ''] : foreignKeyValue(body, relation);
    if (!relation.nullable && (typeof value !== 'string' || value.length === 0)) {
      throw new WorkflowStorageError('STORAGE', 'Workflow storage is missing a required reference');
    }
    if (relation.tagField && value !== null && typeof value !== 'string') {
      throw new WorkflowStorageError('STORAGE', 'Workflow storage received an invalid typed reference');
    }
    result[relation.column] = value === undefined || value === null ? null : String(value);
  }
  for (const [field, value] of Object.entries(uniqueValues)) {
    if (field === 'id') continue;
    const projected = definition.columns.find((candidate) => candidate.bodyField === field);
    if (!projected) throw new WorkflowStorageError('STORAGE', 'Workflow unique key is not a projected field');
    const bodyValue = getPath(body, field);
    if (bodyValue !== undefined && bodyValue !== value) {
      throw new WorkflowStorageError('STORAGE', 'Workflow unique key does not match the row body');
    }
    result[projected.column] = sqliteValue(projected, value);
  }
  return result;
}

function decodeWorkflowRow<T>(definition: WorkflowProjectionDefinition, row: WorkflowStoredRecord): ProjectedRow<T> {
  if (definition.storage === 'mixed' && row.workflow_contract_version !== 2) {
    throw new WorkflowStorageError('STORAGE', 'Workflow projection row is not a V2 record');
  }
  if (definition.legacyQuarantineColumn && row[definition.legacyQuarantineColumn] !== 0) {
    throw new WorkflowStorageError('STORAGE', 'Workflow projection row is quarantined');
  }
  const rowVersion = row.row_version;
  const serialized = definition.bodyColumn === 'payload' ? row.payload : row.body;
  if (typeof row.id !== 'string' || !Number.isSafeInteger(rowVersion) || (rowVersion as number) < 1 || typeof serialized !== 'string') {
    throw new WorkflowStorageError('STORAGE', 'Workflow projection contains an invalid storage row');
  }
  let body: unknown;
  try {
    body = JSON.parse(serialized);
  } catch {
    throw new WorkflowStorageError('STORAGE', 'Workflow projection contains invalid JSON');
  }
  try {
    return validateWorkflowProjectionBody<T>(definition.table, row.id, rowVersion as number, body);
  } catch {
    throw new WorkflowStorageError('STORAGE', 'Workflow projection body failed validation');
  }
}

function stableJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined');
    return serialized;
  } catch {
    throw new WorkflowStorageError('STORAGE', 'Workflow row cannot be represented as JSON');
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function changeKey(table: Table, id: string): string {
  return JSON.stringify([table, id]);
}

function quoteSqliteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new WorkflowStorageError('STORAGE', 'Workflow storage rejected an unsafe identifier');
  return `"${value}"`;
}

function readSqliteRevision(db: Database.Database): number {
  const row = db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0) {
    throw new WorkflowStorageError('STORAGE', 'SQLite store revision is invalid');
  }
  return row.revision as number;
}

function validateWorkflowQueryInput(query: WorkflowStorageQuery): void {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new WorkflowStorageError('STORAGE', 'Workflow storage query is invalid');
  }
  if (query.kind !== 'ids' && query.kind !== 'unique' && query.kind !== 'scoped') {
    throw new WorkflowStorageError('STORAGE', 'Workflow storage query kind is invalid');
  }

  workflowQueryFields(query);
  if (query.kind === 'ids') {
    if (!Array.isArray(query.ids) || query.ids.length > MAX_WORKFLOW_QUERY_IDS) {
      throw new WorkflowStorageError('STORAGE', 'Workflow query exceeds the ID limit');
    }
    query.ids.forEach(requireWorkflowId);
    return;
  }
  if (query.kind === 'unique') return;

  const definition = getWorkflowProjection(query.table);
  if (query.ownerId !== undefined) requireWorkflowId(query.ownerId);
  if (query.orgUnitId !== undefined) requireWorkflowId(query.orgUnitId);
  if (query.branchIds !== undefined) {
    if (!Array.isArray(query.branchIds) || query.branchIds.length > WORKFLOW_ID_CHUNK_SIZE) {
      throw new WorkflowStorageError('STORAGE', 'Workflow branch scope exceeds the ID limit');
    }
    query.branchIds.forEach(requireWorkflowId);
  }
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || query.status.length === 0 || !definition.stateField) {
      throw new WorkflowStorageError('STORAGE', 'Workflow status query is invalid');
    }
    const stateColumn = definition.columns.find((column) => column.bodyField === definition.stateField);
    if (!stateColumn) throw new WorkflowStorageError('STORAGE', 'Workflow state projection is missing');
    const knownStatus = stateColumn.type === 'boolean'
      ? ['active', 'inactive', 'true', 'false'].includes(query.status)
      : Object.prototype.hasOwnProperty.call(definition.permittedTransitions, query.status);
    if (!knownStatus) throw new WorkflowStorageError('STORAGE', 'Workflow status query is invalid');
  }
  if (query.fromDate !== undefined && !businessDateSchema.safeParse(query.fromDate).success) {
    throw new WorkflowStorageError('STORAGE', 'Workflow date query is invalid');
  }
  if (query.throughDate !== undefined && !businessDateSchema.safeParse(query.throughDate).success) {
    throw new WorkflowStorageError('STORAGE', 'Workflow date query is invalid');
  }
  if (query.fromDate !== undefined && query.throughDate !== undefined && query.fromDate > query.throughDate) {
    throw new WorkflowStorageError('STORAGE', 'Workflow date range is invalid');
  }
  if (query.cursor !== undefined) requireWorkflowId(query.cursor);

  for (const [field, value] of Object.entries(query.equals ?? {})) {
    const projected = definition.columns.find((column) => column.bodyField === field);
    if (!projected) {
      throw new WorkflowStorageError('STORAGE', 'Workflow equality query value is invalid');
    }
    if (value === null) {
      if (!projected.nullable) throw new WorkflowStorageError('STORAGE', 'Workflow equality query value is invalid');
      continue;
    }
    if (sqliteValue(projected, value) === null) throw new WorkflowStorageError('STORAGE', 'Workflow equality query value is invalid');
  }
}

const MAX_CACHED_STATEMENTS = 256;

export function createSqliteStore(path: string): Store & WorkflowStore & WorkflowStoreCapability {
  const filename = path === ':memory:' ? path : resolve(path);
  const db = new Database(filename);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    for (const table of tables) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
    }
    db.exec('CREATE TABLE IF NOT EXISTS appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO appmeta (singleton, revision) VALUES (1, 0)').run();
    applyWorkflowSqliteMigrations(db);
  } catch (error) {
    try { db.close(); } catch { /* Preserve the initialization or migration error. */ }
    throw error;
  }

  // Statements are cached per connection: the workflow guard triggers make each prepare compile a large
  // program, so preparing per row dominated bulk writes (the demo seed took ~15s). better-sqlite3 re-prepares
  // a cached statement after a schema change, and no statement here uses mutable modes (raw/pluck/iterate).
  const statements = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      // Filtered reads build SQL per filter shape; keep the cache bounded (oldest entry out).
      if (statements.size >= MAX_CACHED_STATEMENTS) statements.delete(statements.keys().next().value!);
      statements.set(sql, statement);
    }
    return statement;
  };

  let closed = false;
  let inTransaction = false;

  function assertOpen(): void {
    if (closed) throw new Error('SQLite store is closed');
  }

  function listRows<T>(tableName: Table, filterInput?: RowFilter, options?: { limit?: number }): T[] {
    const table = requireTable(tableName);
    const filter = validateRowFilter(filterInput);
    if (hasEmptyFilterValue(filter)) return [];
    const conditions: string[] = [];
    if (workflowProjectionManifest.get(table)?.storage === 'mixed') {
      conditions.push('(workflow_contract_version IS NULL OR workflow_contract_version <> 2)');
    }
    const parameters: string[] = [];
    for (const [key, expected] of Object.entries(filter ?? {})) {
      const jsonPath = `$.${key}`;
      if (Array.isArray(expected)) {
        conditions.push(`json_extract(payload, ?) IN (${expected.map(() => '?').join(', ')})`);
        parameters.push(jsonPath, ...expected);
      } else {
        conditions.push('json_extract(payload, ?) = ?');
        parameters.push(jsonPath, expected);
      }
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const limit = Number.isSafeInteger(options?.limit) && options!.limit! > 0 ? ` LIMIT ${options!.limit}` : '';
    const rows = prepare(`SELECT id, payload FROM "${table}"${where} ORDER BY rowid${limit}`).all(...parameters) as StoredRecord[];
    return rows.map((row) => decodeRow(row) as T);
  }

  function getRow<T>(tableName: Table, id: string): T | undefined {
    const table = requireTable(tableName);
    const markerCondition = workflowProjectionManifest.get(table)?.storage === 'mixed'
      ? ' AND (workflow_contract_version IS NULL OR workflow_contract_version <> 2)'
      : '';
    const row = prepare(`SELECT id, payload FROM "${table}" WHERE id = ?${markerCondition}`).get(id) as StoredRecord | undefined;
    return row ? decodeRow(row) as T : undefined;
  }

  function readWorkflowRows<T>(query: WorkflowStorageQuery): ProjectedRow<T>[] {
    const definition = getWorkflowProjection(query.table);
    const tableName = quoteSqliteIdentifier(definition.table);
    const selectedBody = quoteSqliteIdentifier(definition.bodyColumn);
    const markerSelect = definition.markerColumn ? ', workflow_contract_version' : '';
    const quarantineSelect = definition.legacyQuarantineColumn
      ? `, ${quoteSqliteIdentifier(definition.legacyQuarantineColumn)}`
      : '';
    const markerCondition = definition.storage === 'mixed' ? 'workflow_contract_version = 2' : '';
    const baseConditions = markerCondition ? [markerCondition] : [];
    const select = (conditions: string[], parameters: Array<string | number>, limit?: number): ProjectedRow<T>[] => {
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const take = limit === undefined ? '' : ' LIMIT ?';
      const rows = prepare(
        `SELECT id, row_version, ${selectedBody}${markerSelect}${quarantineSelect} FROM ${tableName}${where} ORDER BY id${take}`,
      ).all(...parameters, ...(limit === undefined ? [] : [limit])) as WorkflowStoredRecord[];
      return rows.map((row) => decodeWorkflowRow<T>(definition, row));
    };

    validateWorkflowQueryInput(query);
    if (query.kind === 'ids') {
      const ids = Array.from(new Set(query.ids));
      const result: ProjectedRow<T>[] = [];
      for (let offset = 0; offset < ids.length; offset += WORKFLOW_ID_CHUNK_SIZE) {
        const chunk = ids.slice(offset, offset + WORKFLOW_ID_CHUNK_SIZE);
        if (chunk.length === 0) continue;
        result.push(...select([...baseConditions, `id IN (${chunk.map(() => '?').join(', ')})`], chunk));
      }
      return result;
    }

    if (query.kind === 'unique') {
      const constraint = assertWorkflowUniqueKey(query.table, query.constraint, query.values);
      const conditions = [...baseConditions];
      const parameters: Array<string | number> = [];
      for (const field of constraint.fields) {
        const value = query.values[field];
        if (typeof value !== 'string' && typeof value !== 'number') throw new WorkflowStorageError('STORAGE', 'Workflow unique key value is invalid');
        const name = workflowColumn(definition, field);
        conditions.push(`${quoteSqliteIdentifier(name)} = ?`);
        parameters.push(value);
      }
      if (constraint.openOnly && definition.stateField) {
        const stateColumn = definition.columns.find((candidate) => candidate.bodyField === definition.stateField);
        if (!stateColumn) throw new WorkflowStorageError('STORAGE', 'Workflow state projection is missing');
        const openStates = constraint.openStates ?? [];
        if (!openStates.length) throw new WorkflowStorageError('STORAGE', 'Workflow open unique constraint has no active states');
        conditions.push(`${quoteSqliteIdentifier(stateColumn.column)} IN (${openStates.map(() => '?').join(', ')})`);
        parameters.push(...openStates.map((state) => workflowStateSqlValue(definition, state)));
      }
      return select(conditions, parameters, 2);
    }

    const conditions = [...baseConditions];
    const parameters: Array<string | number> = [];
    const addExact = (field: string, value: string | undefined): void => {
      if (value === undefined) return;
      const name = workflowColumn(definition, field);
      conditions.push(`${quoteSqliteIdentifier(name)} = ?`);
      parameters.push(value);
    };
    addExact(definition.ownerField ?? 'ownerId', query.ownerId);
    addExact(definition.orgUnitField ?? 'orgUnitId', query.orgUnitId);
    if (query.branchIds !== undefined) {
      if (query.branchIds.length === 0) return [];
      if (query.branchIds.length > WORKFLOW_ID_CHUNK_SIZE) throw new WorkflowStorageError('STORAGE', 'Workflow branch scope exceeds the ID limit');
      const childReference = definition.normalizedChildren.find((child) => child.target === 'branches');
      if (childReference) {
        conditions.push(`id IN (SELECT ${quoteSqliteIdentifier(childReference.parentIdColumn)} FROM ${quoteSqliteIdentifier(childReference.table)} WHERE ${quoteSqliteIdentifier(childReference.childIdColumn)} IN (${query.branchIds.map(() => '?').join(', ')}))`);
      } else {
        const branchColumn = quoteSqliteIdentifier(workflowColumn(definition, definition.branchField ?? 'branchId'));
        conditions.push(`${branchColumn} IN (${query.branchIds.map(() => '?').join(', ')})`);
      }
      parameters.push(...query.branchIds);
    }
    if (query.status !== undefined) {
      if (!definition.stateField) throw new WorkflowStorageError('STORAGE', 'Workflow status query is unsupported for this table');
      const stateColumn = definition.columns.find((candidate) => candidate.bodyField === definition.stateField);
      if (!stateColumn) throw new WorkflowStorageError('STORAGE', 'Workflow state projection is missing');
      conditions.push(`${quoteSqliteIdentifier(stateColumn.column)} = ?`);
      parameters.push(workflowStateSqlValue(definition, query.status));
    }
    if (query.fromDate !== undefined || query.throughDate !== undefined) {
      const field = definition.dateField ?? 'date';
      const name = quoteSqliteIdentifier(workflowColumn(definition, field));
      if (query.fromDate !== undefined) { conditions.push(`${name} >= ?`); parameters.push(query.fromDate); }
      if (query.throughDate !== undefined) { conditions.push(`${name} <= ?`); parameters.push(query.throughDate); }
    }
    for (const [field, value] of Object.entries(query.equals ?? {})) {
      const projected = definition.columns.find((column) => column.bodyField === field);
      if (!projected) throw new WorkflowStorageError('STORAGE', 'Workflow equality query field is not projected');
      const name = quoteSqliteIdentifier(projected.column);
      if (value === null) {
        conditions.push(`${name} IS NULL`);
      } else {
        const bound = sqliteValue(projected, value);
        if (bound === null) throw new WorkflowStorageError('STORAGE', 'Workflow equality query value is invalid');
        conditions.push(`${name} = ?`);
        parameters.push(bound);
      }
    }
    if (query.cursor !== undefined) { requireWorkflowId(query.cursor); conditions.push('id > ?'); parameters.push(query.cursor); }
    return select(conditions, parameters, query.limit ?? 25);
  }

  async function readStableWorkflowRows<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> {
    validateWorkflowQueryInput(query);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await withPathQueue(filename, async () => {
        assertOpen();
        db.exec('BEGIN');
        inTransaction = true;
        try {
          const before = readSqliteRevision(db);
          const rows = readWorkflowRows<T>(query);
          const after = readSqliteRevision(db);
          if (before !== after) throw new WorkflowStorageError('CONFLICT', 'SQLite workflow read observed a revision change', true);
          db.exec('COMMIT');
          return rows;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
          throw error;
        } finally {
          inTransaction = false;
        }
      }).catch((error: unknown) => ({ error }));
      if (!('error' in result)) return result;
      const unavailable = mapSqliteReadError(result.error, 'workflow_query');
      if (unavailable !== result.error) throw unavailable;
      if (!(result.error instanceof WorkflowStorageError) || result.error.code !== 'CONFLICT' || attempt === 1) throw result.error;
    }
    throw new WorkflowStorageError('CONFLICT', 'SQLite workflow read could not obtain a stable revision', true);
  }

  const workflowProjectionReader = {
    async get<T>(table: WorkflowStorageQuery['table'], id: string): Promise<ProjectedRow<T> | undefined> {
      if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'Workflow projection reader requires a projected table');
      requireWorkflowId(id);
      return (await readStableWorkflowRows<T>({ kind: 'ids', table, ids: [id] }))[0];
    },
    async query<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> {
      if (!workflowProjectionManifest.has(query.table)) throw new WorkflowStorageError('STORAGE', 'Workflow projection reader requires a projected table');
      return readStableWorkflowRows<T>(query);
    },
  };

  async function workflowTransaction<T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> {
    if (closed) throw new WorkflowStorageError('STORAGE', 'SQLite store is closed');
    return withPathQueue(filename, async () => {
      assertOpen();
      let transactionStarted = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        inTransaction = true;
        prepare('UPDATE appmeta SET workflow_adapter_write = 1 WHERE singleton = 1').run();
      } catch {
        const transactionActive = transactionStarted || db.inTransaction;
        let rollbackConfirmed = !transactionActive;
        if (transactionActive) {
          try { prepare('UPDATE appmeta SET workflow_adapter_write = 0 WHERE singleton = 1').run(); } catch { /* Rollback still restores the flag. */ }
          try { db.exec('ROLLBACK'); rollbackConfirmed = !db.inTransaction; } catch { /* Keep certainty false if rollback fails. */ }
        }
        inTransaction = false;
        throw new WorkflowStorageError('STORAGE', 'SQLite workflow transaction setup failed', rollbackConfirmed);
      }
      let active = true;
      let mutationCount = 0;
      let mutationBytes = 0;
      let commitOutcomeUnknown = false;
      let staleConflict: WorkflowStorageError | undefined;
      const footprints = new Map<string, ChangeFootprint>();
      const assertActive = (): void => {
        if (!active) throw new WorkflowStorageError('STORAGE', 'SQLite workflow transaction is no longer active');
        if (staleConflict) throw staleConflict;
      };
      const currentProjected = <U>(table: WorkflowStorageQuery['table'], id: string): ProjectedRow<U> | undefined => {
        const rows = readWorkflowRows<U>({ kind: 'ids', table, ids: [id] });
        return rows[0];
      };
      const addFootprint = (table: WorkflowStorageQuery['table'], id: string, body: unknown): void => {
        const key = JSON.stringify([table, id]);
        const previous = footprints.get(key);
        const bytes = Buffer.byteLength(JSON.stringify({ table, id, body }), 'utf8');
        const nextCount = footprints.size + (previous ? 0 : 1);
        const nextBytes = mutationBytes - (previous?.bytes ?? 0) + bytes;
        if (nextCount > MAX_TRANSACTION_CHANGES) throw new WorkflowStorageError('STORAGE', 'SQLite workflow transaction exceeds the change limit');
        if (nextBytes > MAX_TRANSACTION_BYTES) throw new WorkflowStorageError('STORAGE', 'SQLite workflow transaction exceeds the payload limit');
        footprints.set(key, { bytes });
        mutationBytes = nextBytes;
        mutationCount += 1;
      };
      const insertProjected = (definition: WorkflowProjectionDefinition, rowVersion: number, body: unknown, uniqueValues: Readonly<Record<string, string | number>>): void => {
        const serialized = stableJson(body);
        if (definition.columns.some((column) => column.external && !column.nullable && uniqueValues[column.bodyField] === undefined)) {
          throw new WorkflowStorageError('STORAGE', 'Workflow insert is missing required storage metadata');
        }
        if (definition.foreignKeys.some((relation) => relation.external && !relation.nullable && uniqueValues[relation.bodyField ?? ''] === undefined)) {
          throw new WorkflowStorageError('STORAGE', 'Workflow insert is missing required reference metadata');
        }
        const projected = workflowProjectionValues(definition, body, uniqueValues);
        const values: Record<string, string | number | null> = {
          id: (body as { id: string }).id,
          row_version: rowVersion,
          [definition.bodyColumn]: serialized,
          ...projected,
        };
        if (definition.markerColumn) values[definition.markerColumn] = 2;
        const names = Object.keys(values);
        const columns = names.map(quoteSqliteIdentifier).join(', ');
        const placeholders = names.map(() => '?').join(', ');
        prepare(`INSERT INTO ${quoteSqliteIdentifier(definition.table)} (${columns}) VALUES (${placeholders})`).run(...names.map((name) => values[name]));
      };
      const updateProjected = (definition: WorkflowProjectionDefinition, rowVersion: number, body: unknown, expected: { rowVersion: number; state: string | null }): number => {
        const serialized = stableJson(body);
        const projected = workflowProjectionValues(definition, body);
        const assignments: string[] = ['row_version = ?', `${quoteSqliteIdentifier(definition.bodyColumn)} = ?`];
        const values: Array<string | number | null> = [rowVersion, serialized];
        for (const [name, value] of Object.entries(projected)) {
          assignments.push(`${quoteSqliteIdentifier(name)} = ?`);
          values.push(value);
        }
        const conditions = ['id = ?', 'row_version = ?'];
        values.push((body as { id: string }).id, expected.rowVersion);
        if (definition.markerColumn) conditions.push('workflow_contract_version = 2');
        if (definition.stateField) {
          const stateColumn = definition.columns.find((candidate) => candidate.bodyField === definition.stateField);
          if (!stateColumn) throw new WorkflowStorageError('STORAGE', 'Workflow state projection is missing');
          if (expected.state === null) conditions.push(`${quoteSqliteIdentifier(stateColumn.column)} IS NULL`);
          else {
            conditions.push(`${quoteSqliteIdentifier(stateColumn.column)} = ?`);
            values.push(workflowStateSqlValue(definition, expected.state));
          }
        }
        return prepare(`UPDATE ${quoteSqliteIdentifier(definition.table)} SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')}`).run(...values).changes;
      };

      const internalTx: WorkflowTransactionContext = {
        workflowProjectionReader: {
          async get<U>(table: WorkflowStorageQuery['table'], id: string): Promise<ProjectedRow<U> | undefined> {
            assertActive();
            if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'Workflow projection reader requires a projected table');
            requireWorkflowId(id);
            return currentProjected<U>(table, id);
          },
          async query<U>(query: WorkflowStorageQuery): Promise<ProjectedRow<U>[]> {
            assertActive();
            if (!workflowProjectionManifest.has(query.table)) throw new WorkflowStorageError('STORAGE', 'Workflow projection reader requires a projected table');
            return readWorkflowRows<U>(query);
          },
        },
        async list<U>(table: WorkflowStorageQuery['table'], filters?: RowFilter): Promise<U[]> {
          assertActive();
          if (workflowProjectionManifest.has(table)) {
            const query = workflowRowFilterQuery(table, validateRowFilter(filters));
            return readWorkflowRows<U>(query).map((row) => row.body);
          }
          if (!isLegacyTable(table)) throw new WorkflowStorageError('STORAGE', 'SQLite workflow reader received an unsupported table');
          return listRows<U>(table, filters);
        },
        async get<U>(table: WorkflowStorageQuery['table'], id: string): Promise<U | undefined> {
          assertActive();
          if (workflowProjectionManifest.has(table)) return currentProjected<U>(table, id)?.body;
          if (!isLegacyTable(table)) throw new WorkflowStorageError('STORAGE', 'SQLite workflow reader received an unsupported table');
          return getRow<U>(table, id);
        },
        async insertUnique<U extends { id: string }>(table: WorkflowStorageQuery['table'], row: U, key: { constraint: string; values: Record<string, string | number> }): Promise<{ inserted: true; row: U } | { inserted: false; existing: U; existingRowVersion?: number }> {
          assertActive();
          if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'SQLite workflow writer received an unsupported table', true);
          const definition = getWorkflowProjection(table);
          let constraint: ReturnType<typeof assertWorkflowUniqueKey>;
          try { constraint = assertWorkflowUniqueKey(table, key.constraint, key.values); }
          catch { throw new WorkflowStorageError('STORAGE', 'SQLite workflow unique constraint is unsupported', true); }
          let encoded: ReturnType<typeof encodeRow>;
          try { encoded = encodeRow(row); }
          catch { throw new WorkflowStorageError('STORAGE', 'SQLite workflow insert body failed validation', true); }
          if (key.values.id !== undefined && key.values.id !== encoded.id) throw new WorkflowStorageError('STORAGE', 'Workflow unique key does not match the row id', true);
          let candidate: ProjectedRow<U>;
          try {
            candidate = validateWorkflowProjectionWriteBody<U>(table, encoded.id, 1, JSON.parse(encoded.payload));
          } catch {
            throw new WorkflowStorageError('STORAGE', 'SQLite workflow insert body failed validation', true);
          }
          for (const field of constraint.fields) {
            const value = key.values[field];
            if (value === undefined) throw new WorkflowStorageError('STORAGE', 'Workflow unique key is incomplete', true);
            if (field === 'id') {
              if (value !== candidate.id) throw new WorkflowStorageError('STORAGE', 'Workflow unique key does not match the row id', true);
              continue;
            }
            const external = definition.columns.some((column) => column.external && column.bodyField === field);
            if (!external && getPath(candidate.body, field) !== value) {
              throw new WorkflowStorageError('STORAGE', 'Workflow unique key does not match the row body', true);
            }
          }
          const conditions: string[] = definition.storage === 'mixed' ? ['workflow_contract_version = 2'] : [];
          const parameters: Array<string | number> = [];
          for (const field of constraint.fields) {
            const value = key.values[field];
            if (value === undefined) throw new WorkflowStorageError('STORAGE', 'Workflow unique key is incomplete', true);
            const name = workflowColumn(definition, field);
            conditions.push(`${quoteSqliteIdentifier(name)} = ?`);
            parameters.push(value);
          }
          if (constraint.openOnly && definition.stateField) {
            const stateColumn = definition.columns.find((entry) => entry.bodyField === definition.stateField);
            if (!stateColumn) throw new WorkflowStorageError('STORAGE', 'Workflow state projection is missing');
            const openStates = constraint.openStates ?? [];
            if (!openStates.length) throw new WorkflowStorageError('STORAGE', 'Workflow open unique constraint has no active states');
            conditions.push(`${quoteSqliteIdentifier(stateColumn.column)} IN (${openStates.map(() => '?').join(', ')})`);
            parameters.push(...openStates.map((state) => workflowStateSqlValue(definition, state)));
          }
          const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
          const selectedBody = quoteSqliteIdentifier(definition.bodyColumn);
          const markerSelect = definition.markerColumn ? ', workflow_contract_version' : '';
          const quarantineSelect = definition.legacyQuarantineColumn
            ? `, ${quoteSqliteIdentifier(definition.legacyQuarantineColumn)}`
            : '';
          const existingRows = prepare(`SELECT id,row_version,${selectedBody}${markerSelect}${quarantineSelect} FROM ${quoteSqliteIdentifier(table)}${where} ORDER BY id LIMIT 1`).all(...parameters) as WorkflowStoredRecord[];
          if (existingRows.length) {
            const existing = decodeWorkflowRow<U>(definition, existingRows[0]);
            for (const field of definition.immutableFields) {
              if (field === 'id') continue;
              if (!sameValue(getPath(candidate.body, field), getPath(existing.body, field))) {
                throw new WorkflowStorageError('CONFLICT', 'Workflow unique key conflicts with different immutable data', true);
              }
            }
            return { inserted: false, existing: existing.body, existingRowVersion: existing.rowVersion };
          }
          try {
            insertProjected(definition, 1, candidate.body, key.values);
          } catch (error) {
            throw workflowConstraintError(error, 'workflow insert') ?? error;
          }
          addFootprint(table, encoded.id, candidate.body);
          return { inserted: true, row: candidate.body };
        },
        async compareAndSwap<U extends { id: string; rowVersion: number }>(table: WorkflowStorageQuery['table'], id: string, expected: { rowVersion: number; state: string | null }, next: U): Promise<{ updated: true; row: CasBody<U> } | { updated: false; current: CasBody<U> | null }> {
          assertActive();
          if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'SQLite workflow writer received an unsupported table', true);
          requireWorkflowId(id);
          const definition = getWorkflowProjection(table);
          if (!Number.isSafeInteger(expected.rowVersion) || expected.rowVersion < 1 || next.rowVersion !== expected.rowVersion + 1) {
            throw new WorkflowStorageError('STORAGE', 'Workflow compare-and-swap version is invalid', true);
          }
          const current = currentProjected<CasBody<U>>(table, id);
          const currentState = current ? workflowStateValue(definition, current.body) : null;
          if (!current || current.rowVersion !== expected.rowVersion || currentState !== expected.state) {
            staleConflict = new WorkflowStorageError('CONFLICT', 'SQLite workflow compare-and-swap is stale', true);
            return { updated: false, current: current?.body ?? null };
          }
          let candidate: ProjectedRow<CasBody<U>>;
          try {
            candidate = validateWorkflowCasBody<U>(table, id, expected.rowVersion, next);
          } catch {
            throw new WorkflowStorageError('STORAGE', 'SQLite workflow compare-and-swap body failed validation', true);
          }
          for (const field of definition.immutableFields) {
            if (field === 'id') continue;
            if (!sameValue(getPath(current.body, field), getPath(candidate.body, field))) {
              throw new WorkflowStorageError('STORAGE', 'Workflow compare-and-swap changed an immutable field', true);
            }
          }
          const nextState = workflowStateValue(definition, candidate.body);
          for (const field of definition.terminalImmutableFields[currentState ?? ''] ?? []) {
            if (!sameValue(getPath(current.body, field), getPath(candidate.body, field))) {
              throw new WorkflowStorageError('STORAGE', 'Workflow compare-and-swap changed terminal proof data', true);
            }
          }
          if (definition.stateField && currentState !== nextState) {
            const allowed = currentState === null ? [] : definition.permittedTransitions[currentState] ?? [];
            if (nextState === null || !allowed.includes(nextState)) {
              throw new WorkflowStorageError('STORAGE', 'Workflow compare-and-swap attempted an invalid state transition', true);
            }
          }
          const changes = updateProjected(definition, next.rowVersion, candidate.body, expected);
          if (changes !== 1) {
            staleConflict = new WorkflowStorageError('CONFLICT', 'SQLite workflow compare-and-swap is stale', true);
            return { updated: false, current: currentProjected<CasBody<U>>(table, id)?.body ?? null };
          }
          addFootprint(table, id, candidate.body);
          return { updated: true, row: candidate.body };
        },
      };

      try {
        const value = await work(internalTx);
        if (staleConflict && mutationCount > 0) throw staleConflict;
        prepare('UPDATE appmeta SET revision = revision + ?, workflow_adapter_write = 0 WHERE singleton = 1').run(mutationCount > 0 ? 1 : 0);
        try {
          db.exec('COMMIT');
        } catch (error) {
          const constraintError = workflowConstraintError(error, 'workflow transaction');
          if (constraintError) throw constraintError;
          commitOutcomeUnknown = true;
          throw new WorkflowStorageError('STORAGE', 'SQLite workflow commit outcome is unknown');
        }
        active = false;
        return value;
      } catch (error) {
        active = false;
        let rollbackConfirmed = false;
        if (db.inTransaction) {
          try { db.exec('UPDATE appmeta SET workflow_adapter_write = 0 WHERE singleton = 1'); } catch { /* Rollback still restores the flag. */ }
          try { db.exec('ROLLBACK'); rollbackConfirmed = !db.inTransaction; } catch { /* Keep certainty false if rollback fails. */ }
        }
        throw workflowErrorAfterRollback(error, 'workflow transaction', rollbackConfirmed && !commitOutcomeUnknown);
      } finally {
        inTransaction = false;
      }
    });
  }

  return {
    adapter: 'sqlite',
    workflowContractVersion: 2,
    workflowProjectionReader,
    async list<T>(table: WorkflowStorageQuery['table'], filter?: RowFilter, options?: { limit?: number }): Promise<T[]> {
      if (!isLegacyTable(table)) {
        if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'SQLite store received an unsupported table');
        return (await readStableWorkflowRows<T>(workflowRowFilterQuery(table, validateRowFilter(filter)))).map((row) => row.body);
      }
      try {
        return await withPathQueue(filename, async () => {
          assertOpen();
          return listRows<T>(table, filter, options);
        });
      } catch (error) {
        throw mapSqliteReadError(error, 'list');
      }
    },
    async get<T>(table: WorkflowStorageQuery['table'], id: string): Promise<T | undefined> {
      if (!isLegacyTable(table)) {
        if (!workflowProjectionManifest.has(table)) throw new WorkflowStorageError('STORAGE', 'SQLite store received an unsupported table');
        requireWorkflowId(id);
        return (await readStableWorkflowRows<T>({ kind: 'ids', table, ids: [id] }))[0]?.body;
      }
      try {
        return await withPathQueue(filename, async () => {
          assertOpen();
          return getRow<T>(table, id);
        });
      } catch (error) {
        throw mapSqliteReadError(error, 'get');
      }
    },
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      if (closed) throw new Error('SQLite store is closed');
      const result = await withPathQueue(filename, async () => {
        if (closed) throw new Error('SQLite store is closed');
        let transactionStarted = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          inTransaction = true;
          prepare('UPDATE appmeta SET workflow_adapter_write = 1 WHERE singleton = 1').run();
        } catch {
          const transactionActive = transactionStarted || db.inTransaction;
          let rollbackConfirmed = !transactionActive;
          if (transactionActive) {
            try { prepare('UPDATE appmeta SET workflow_adapter_write = 0 WHERE singleton = 1').run(); } catch { /* Rollback still restores the flag. */ }
            try { db.exec('ROLLBACK'); rollbackConfirmed = !db.inTransaction; } catch { /* Keep certainty false if rollback fails. */ }
          }
          inTransaction = false;
          throw new WorkflowStorageError('STORAGE', 'SQLite transaction setup failed', rollbackConfirmed);
        }
        let active = true;
        let mutationCount = 0;
        let mutationBytes = 0;
        let commitOutcomeUnknown = false;
        const footprints = new Map<string, ChangeFootprint>();
        const assertActive = () => {
          if (!active) throw new Error('SQLite transaction is no longer active');
        };
        const tx: Transaction = {
          async list<U>(tableName: Table, filter?: RowFilter): Promise<U[]> {
            assertActive();
            return listRows<U>(requireTable(tableName), filter);
          },
          async get<U>(tableName: Table, id: string): Promise<U | undefined> {
            assertActive();
            return getRow<U>(requireTable(tableName), id);
          },
          async put<U extends { id: string }>(tableName: Table, value: U): Promise<void> {
            assertActive();
            const table = requireTable(tableName);
            const encoded = encodeRow(value);
            let existingMixedRecord: WorkflowStoredRecord | undefined;
            if (workflowProjectionManifest.get(table)?.storage === 'mixed') {
              existingMixedRecord = prepare(`SELECT id,payload,workflow_contract_version FROM "${table}" WHERE id = ?`).get(encoded.id) as WorkflowStoredRecord | undefined;
              const existingBody = existingMixedRecord && typeof existingMixedRecord.payload === 'string'
                ? decodeRow({ id: existingMixedRecord.id, payload: existingMixedRecord.payload })
                : undefined;
              if (
                existingMixedRecord?.workflow_contract_version === 2
                || (existingBody !== undefined && isMarkerlessV2WorkflowBody(table, existingBody))
                || isMarkerlessV2WorkflowBody(table, JSON.parse(encoded.payload))
              ) throw new WorkflowStorageError('STORAGE', 'V1 writes cannot change a protected V2 row');
            }
            const key = changeKey(table, encoded.id);
            const previous = footprints.get(key);
            const bytes = Buffer.byteLength(JSON.stringify({ table, id: encoded.id, payload: JSON.parse(encoded.payload) }), 'utf8');
            const nextCount = footprints.size + (previous ? 0 : 1);
            const nextBytes = mutationBytes - (previous?.bytes ?? 0) + bytes;
            if (nextCount > MAX_TRANSACTION_CHANGES) throw new Error('SQLite transaction exceeds the change limit');
            if (nextBytes > MAX_TRANSACTION_BYTES) throw new Error('SQLite transaction exceeds the payload limit');
            const definition = workflowProjectionManifest.get(table);
            const body: unknown = JSON.parse(encoded.payload);
            if (definition?.storage === 'shared' && Object.prototype.hasOwnProperty.call(body, 'rowVersion')) {
              const rowVersion = getPath(body, 'rowVersion');
              if (typeof rowVersion !== 'number' || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
                throw new WorkflowStorageError('STORAGE', 'SQLite shared row version is invalid');
              }
              let candidate: ProjectedRow<unknown>;
              try {
                candidate = validateWorkflowProjectionWriteBody(table, encoded.id, rowVersion, body);
              } catch {
                throw new WorkflowStorageError('STORAGE', 'SQLite shared row body failed validation');
              }
              // Shared versioned V1 writes use the same native materializer as guarded writes.
              // No workflow-contract marker is written by this compatibility path.
              const values: Record<string, string | number | null> = {
                id: encoded.id,
                row_version: rowVersion,
                [definition.bodyColumn]: stableJson(candidate.body),
                ...workflowProjectionValues(definition, candidate.body),
              };
              const names = Object.keys(values);
              const parameters = names.map((name) => values[name]);
              let changes: number;
              if (rowVersion === 1) {
                changes = prepare(`INSERT INTO ${quoteSqliteIdentifier(table)} (${names.map(quoteSqliteIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`).run(...parameters).changes;
              } else {
                const updatedNames = names.filter((name) => name !== 'id');
                changes = prepare(`UPDATE ${quoteSqliteIdentifier(table)} SET ${updatedNames.map((name) => `${quoteSqliteIdentifier(name)}=?`).join(',')} WHERE id=? AND row_version=?`).run(...updatedNames.map((name) => values[name]), encoded.id, rowVersion - 1).changes;
              }
              if (changes !== 1) throw new WorkflowStorageError('CONFLICT', 'SQLite shared row write is stale');
            } else if (table === 'pending_actions' && existingMixedRecord) {
              const changes = prepare(`UPDATE ${quoteSqliteIdentifier(table)} SET payload = ? WHERE id = ?`)
                .run(encoded.payload, encoded.id).changes;
              if (changes !== 1) throw new WorkflowStorageError('CONFLICT', 'SQLite pending action write is stale', true);
            } else if (table === 'pending_actions') {
              prepare(`INSERT INTO ${quoteSqliteIdentifier(table)} (id, payload) VALUES (?, ?)`)
                .run(encoded.id, encoded.payload);
            } else {
              prepare(`INSERT INTO "${table}" (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(encoded.id, encoded.payload);
            }
            footprints.set(key, { bytes });
            mutationBytes = nextBytes;
            mutationCount += 1;
          },
          async remove(tableName: Table, id: string): Promise<void> {
            assertActive();
            const table = requireTable(tableName);
            if (typeof id !== 'string') throw new Error('Store ids must be strings');
            if (table === 'pending_actions') {
              throw new WorkflowStorageError('STORAGE', 'Pending workflow action history cannot be deleted', true);
            }
            if (workflowProjectionManifest.get(table)?.storage === 'mixed') {
              const existing = prepare(`SELECT id,payload,workflow_contract_version FROM "${table}" WHERE id = ?`).get(id) as WorkflowStoredRecord | undefined;
              const existingBody = existing && typeof existing.payload === 'string'
                ? decodeRow({ id: existing.id, payload: existing.payload })
                : undefined;
              if (existing?.workflow_contract_version === 2 || (existingBody !== undefined && isMarkerlessV2WorkflowBody(table, existingBody))) {
                throw new WorkflowStorageError('STORAGE', 'V1 deletes cannot remove a protected V2 row');
              }
            }
            const key = changeKey(table, id);
            const previous = footprints.get(key);
            const bytes = Buffer.byteLength(JSON.stringify({ table, id, payload: null }), 'utf8');
            const nextCount = footprints.size + (previous ? 0 : 1);
            const nextBytes = mutationBytes - (previous?.bytes ?? 0) + bytes;
            if (nextCount > MAX_TRANSACTION_CHANGES) throw new Error('SQLite transaction exceeds the change limit');
            if (nextBytes > MAX_TRANSACTION_BYTES) throw new Error('SQLite transaction exceeds the payload limit');
            prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
            footprints.set(key, { bytes });
            mutationBytes = nextBytes;
            mutationCount += 1;
          }
        };

        try {
          const value = await work(tx);
          prepare('UPDATE appmeta SET revision = revision + ?, workflow_adapter_write = 0 WHERE singleton = 1').run(mutationCount > 0 ? 1 : 0);
          try {
            db.exec('COMMIT');
          } catch (error) {
            const constraintError = workflowConstraintError(error, 'transaction');
            if (constraintError) throw constraintError;
            commitOutcomeUnknown = true;
            throw new WorkflowStorageError('STORAGE', 'SQLite transaction commit outcome is unknown');
          }
          active = false;
          return value;
        } catch (error) {
          active = false;
          let rollbackConfirmed = false;
          if (db.inTransaction) {
            try { db.exec('ROLLBACK'); rollbackConfirmed = !db.inTransaction; } catch { /* Keep certainty false if rollback fails. */ }
          }
          throw workflowErrorAfterRollback(error, 'transaction', rollbackConfirmed && !commitOutcomeUnknown);
        } finally {
          inTransaction = false;
        }
      });
      return result;
    },
    workflowTransaction,
    close(): void {
      if (closed) return;
      if (inTransaction) throw new Error('Cannot close SQLite store during a transaction');
      closed = true;
      db.close();
    }
  };
}
