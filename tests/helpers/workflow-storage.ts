import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteStore } from '../../lib/storage/sqlite';

const FIXTURE_PREFIX = 'biztania-workflow-storage-v2-';

async function removeFixtureDirectory(directory: string): Promise<void> {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const relativePath = relative(root, target);
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || dirname(target) !== root
    || !basename(target).startsWith(FIXTURE_PREFIX)
  ) {
    throw new Error('Refusing to remove a workflow storage fixture outside its generated temporary directory.');
  }
  await rm(target, { recursive: true, force: true });
}

type SqliteWorkflowStore = ReturnType<typeof createSqliteStore>;

const PG_UNSUPPORTED = 'SQLite-only fixture API is unavailable when BIZTANIA_PG_TESTS=1 (local PostgreSQL mode).';

function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Replaces `?` placeholders (outside quoted strings) with PostgreSQL literals. */
function bindPgParameters(sql: string, values: unknown[]): string {
  let index = 0;
  let quoted = false;
  let out = '';
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === '?' && !quoted) { out += pgLiteral(values[index++]); continue; }
    out += char;
  }
  return out;
}

/**
 * PG-mode stand-in for the raw SQLite handle: ANSI SQL only (counts, simple selects).
 * SQLite dialect (json_extract, payload columns, triggers, pragmas) fails on PostgreSQL;
 * tests that need it are marked itSqliteBound.
 */
function createPgRawDatabase(localPsql: (sql: string) => string) {
  const rows = (sql: string, values: unknown[]): Record<string, unknown>[] => {
    const text = bindPgParameters(sql, values).trim().replace(/;$/, '');
    const parsed = JSON.parse(localPsql(`select coalesce(json_agg(row_to_json(q)), '[]'::json) from (${text}) q`) || '[]') as Record<string, unknown>[];
    // SQLite stores payloads as TEXT; PostgreSQL json/jsonb columns arrive parsed, so re-serialize them.
    return parsed.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, value !== null && typeof value === 'object' ? JSON.stringify(value) : value])));
  };
  return {
    prepare(sql: string) {
      return {
        get: (...values: unknown[]) => rows(sql, values)[0],
        all: (...values: unknown[]) => rows(sql, values),
        run: (...values: unknown[]) => { localPsql(bindPgParameters(sql, values)); },
      };
    },
    exec(sql: string) { localPsql(sql); },
    function() { /* SQLite user functions do not exist on PostgreSQL. */ },
    close() {},
  } as unknown as Database.Database;
}

/**
 * BIZTANIA_PG_TESTS=1: the same fixture surface backed by the local Supabase stack via
 * createSupabaseStore(). Data tables are emptied first; reopen() builds a new adapter
 * over the same database (a process restart). SQLite file/handle APIs throw.
 */
async function createWorkflowLocalPgFixture(options: { initialize?: boolean }) {
  const [{ createSupabaseStore }, { localPgConfig, resetLocalPgData }] = await Promise.all([
    import('../../lib/storage/supabase'),
    import('./local-pg'),
  ]);
  const config = localPgConfig();
  const { localPsql } = await import('../../scripts/local-supabase');
  resetLocalPgData();
  const { withCommitConflictRetry } = await import('../../lib/storage/conflict-retry');
  const open = () => Object.assign(withCommitConflictRetry(createSupabaseStore(config.url, config.serviceRoleKey)), { close() {} }) as unknown as SqliteWorkflowStore;
  let store: SqliteWorkflowStore | undefined = options.initialize === false ? undefined : open();
  return {
    get databasePath(): string { throw new Error(PG_UNSUPPORTED); },
    get store() {
      if (!store) throw new Error('The workflow PostgreSQL fixture has not been initialized.');
      return store;
    },
    openStore() {
      if (store) throw new Error('Close the current workflow store before reopening it.');
      store = open();
      return store;
    },
    reopen() {
      store = open();
      return store;
    },
    openDatabase(): Database.Database { return createPgRawDatabase((sql) => localPsql(sql)); },
    async dispose() { store = undefined; },
  };
}

/** A fresh on-disk SQLite database for one workflow-storage test (local PostgreSQL when opted in). */
export async function createWorkflowSqliteFixture(options: { initialize?: boolean } = {}) {
  if (process.env.BIZTANIA_PG_TESTS === '1') return createWorkflowLocalPgFixture(options);
  const directory = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
  const databasePath = join(directory, 'private.sqlite');
  let store: SqliteWorkflowStore | undefined;

  try {
    if (options.initialize !== false) store = createSqliteStore(databasePath);
    return {
      databasePath,
      get store() {
        if (!store) throw new Error('The workflow SQLite fixture has not been initialized.');
        return store;
      },
      openStore() {
        if (store) throw new Error('Close the current workflow SQLite store before reopening it.');
        store = createSqliteStore(databasePath);
        return store;
      },
      reopen() {
        store?.close?.();
        store = createSqliteStore(databasePath);
        return store;
      },
      openDatabase() {
        const database = new Database(databasePath);
        database.function('workflow_migration_active', () => 0);
        database.function('workflow_utf16_length', (value: unknown) => typeof value === 'string' ? value.length : null);
        return database;
      },
      async dispose() {
        try {
          store?.close?.();
        } finally {
          await removeFixtureDirectory(directory);
        }
      }
    };
  } catch (error) {
    store?.close?.();
    await removeFixtureDirectory(directory);
    throw error;
  }
}
