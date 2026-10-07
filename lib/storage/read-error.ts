export type StorageReadAdapter = 'supabase' | 'sqlite';
export type StorageReadOperation = 'list' | 'get' | 'revision' | 'workflow_query' | 'workflow_guard';
export interface StorageFailureMetadata {
  readonly rpc?: 'nexus_commit' | 'nexus_workflow_commit';
  readonly table?: string;
  readonly databaseCode?: string;
}

const storageFailures = new WeakMap<object, StorageFailureMetadata>();

/** Retain operation names and canonical database codes, never driver messages or row data. */
export function markStorageFailure<T extends object>(error: T, metadata: StorageFailureMetadata): T {
  const { rpc, table, databaseCode } = metadata;
  storageFailures.set(error, {
    ...(rpc === undefined ? {} : { rpc }),
    ...(table === undefined ? {} : { table }),
    ...(typeof databaseCode === 'string' && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(databaseCode) ? { databaseCode } : {}),
  });
  return error;
}

export function getStorageFailureMetadata(error: unknown): StorageFailureMetadata | undefined {
  const metadata = typeof error === 'object' && error !== null ? storageFailures.get(error) : undefined;
  return metadata ? { ...metadata } : undefined;
}
export type StorageReadUnavailableReason =
  | 'connection_unavailable'
  | 'pool_timeout'
  | 'capacity_exhausted'
  | 'database_unavailable'
  | 'database_busy'
  | 'io_unavailable';

/** A sanitized, typed signal for a storage read that failed for an availability reason. */
export class StorageReadUnavailableError extends Error {
  readonly adapter: StorageReadAdapter;
  readonly operation: StorageReadOperation;
  readonly reason: StorageReadUnavailableReason;

  constructor(adapter: StorageReadAdapter, operation: StorageReadOperation, reason: StorageReadUnavailableReason) {
    super(`Storage read unavailable (${adapter}/${operation}/${reason})`);
    Object.defineProperty(this, 'name', { value: 'StorageReadUnavailableError', configurable: true });
    this.adapter = adapter;
    this.operation = operation;
    this.reason = reason;
  }
}

/**
 * A read against a table this store does not have (hosted migration not applied). Narrowly classified: PostgREST
 * PGRST205 (table not in the schema cache), Postgres 42P01 (undefined_table), SQLite "no such table". Callers may treat
 * ONLY this as "feature off"; every other failure is an outage or a bug and must surface (e.g. 503), never an empty list.
 */
export class StorageMissingTableError extends Error {
  readonly adapter: StorageReadAdapter;
  readonly operation: StorageReadOperation;
  constructor(adapter: StorageReadAdapter, operation: StorageReadOperation) {
    super(`Storage table missing (${adapter}/${operation})`);
    Object.defineProperty(this, 'name', { value: 'StorageMissingTableError', configurable: true });
    this.adapter = adapter;
    this.operation = operation;
  }
}

export function missingTableError(error: unknown, adapter: StorageReadAdapter, operation: StorageReadOperation): StorageMissingTableError | undefined {
  const code = errorCode(error);
  if (adapter === 'supabase' && (code === 'PGRST205' || code === '42P01')) return new StorageMissingTableError(adapter, operation);
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
  if (adapter === 'sqlite' && /^no such table/iu.test(message)) return new StorageMissingTableError(adapter, operation);
  return undefined;
}

const MISSING_TABLE = Symbol.for('biztania.storage.missingTable');
/** Marks an adapter error as "this table does not exist" without changing its public shape. */
export function markMissingTable<T extends object>(error: T): T {
  Object.defineProperty(error, MISSING_TABLE, { value: true, enumerable: false });
  return error;
}
/** True only for a positively identified missing table (typed error, adapter marker, or SQLite "no such table"). */
export function isMissingTableError(error: unknown): boolean {
  if (error instanceof StorageMissingTableError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ((error as Record<symbol, unknown>)[MISSING_TABLE] === true) return true;
  return missingTableError(error, 'sqlite', 'list') !== undefined && (error as { code?: unknown }).code === 'SQLITE_ERROR';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function supabaseReadUnavailableError(
  error: unknown,
  operation: StorageReadOperation,
): StorageReadUnavailableError | undefined {
  const code = errorCode(error);
  // A code-less PostgREST/fetch failure (network error, aborted or timed-out request) is a transport outage, not "no rows".
  if (!code) return typeof error === 'object' && error !== null ? new StorageReadUnavailableError('supabase', operation, 'connection_unavailable') : undefined;

  if (['PGRST000', 'PGRST001', 'PGRST002'].includes(code) || (code.length === 5 && code.startsWith('08'))) {
    return new StorageReadUnavailableError('supabase', operation, 'connection_unavailable');
  }
  if (code === 'PGRST003') return new StorageReadUnavailableError('supabase', operation, 'pool_timeout');
  if (code === '53300') return new StorageReadUnavailableError('supabase', operation, 'capacity_exhausted');
  if (['57P01', '57P02', '57P03'].includes(code)) {
    return new StorageReadUnavailableError('supabase', operation, 'database_unavailable');
  }
  return undefined;
}

export function sqliteReadUnavailableError(
  error: unknown,
  operation: StorageReadOperation,
): StorageReadUnavailableError | undefined {
  const code = errorCode(error);
  if (!code) return undefined;

  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_') || code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_LOCKED_')) {
    return new StorageReadUnavailableError('sqlite', operation, 'database_busy');
  }
  if (code === 'SQLITE_IOERR' || code.startsWith('SQLITE_IOERR_') || code === 'SQLITE_CANTOPEN' || code.startsWith('SQLITE_CANTOPEN_')) {
    return new StorageReadUnavailableError('sqlite', operation, 'io_unavailable');
  }
  return undefined;
}
