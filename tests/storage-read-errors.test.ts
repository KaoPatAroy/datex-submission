import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import { StorageReadUnavailableError } from '../lib/storage/read-error';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

type ReadResult = { data: unknown; error: unknown };
type SupabaseTestClient = { client: SupabaseClient; rpcCalls: string[] };

function supabaseReadClient(result: ReadResult, rpcResult: ReadResult = { data: null, error: null }): SupabaseTestClient {
  const query = {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    is() { return this; },
    gt() { return this; },
    gte() { return this; },
    lte() { return this; },
    order() { return this; },
    range() { return this; },
    maybeSingle() { return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    then<TResult1 = ReadResult, TResult2 = never>(
      onfulfilled?: ((value: ReadResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  const rpcCalls: string[] = [];
  const client = {
    from: () => query,
    async rpc(name: string) {
      rpcCalls.push(name);
      return rpcResult;
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

async function supabaseListError(result: ReadResult): Promise<unknown> {
  const store = createSupabaseStoreFromClient(supabaseReadClient(result).client);
  try {
    await store.list('profiles');
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Supabase read to fail.');
}

async function supabaseGetError(result: ReadResult): Promise<unknown> {
  const store = createSupabaseStoreFromClient(supabaseReadClient(result).client);
  try {
    await store.get('profiles', 'profile-1');
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Supabase read to fail.');
}

describe('storage read availability errors', () => {
  it.each([
    { code: 'PGRST000', reason: 'connection_unavailable' },
    { code: 'PGRST001', reason: 'connection_unavailable' },
    { code: 'PGRST002', reason: 'connection_unavailable' },
    { code: 'PGRST003', reason: 'pool_timeout' },
    { code: '08006', reason: 'connection_unavailable' },
    { code: '53300', reason: 'capacity_exhausted' },
    { code: '57P01', reason: 'database_unavailable' },
  ] as const)('maps Supabase read code $code to a safe availability error', async ({ code, reason }) => {
    const error = await supabaseListError({ data: null, error: { code, message: 'sensitive SQL, filter, and URL details' } });

    expect(error).toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ adapter: 'supabase', operation: 'list', reason });
    expect((error as Error).message).toBe(`Storage read unavailable (supabase/list/${reason})`);
    expect((error as Error).message).not.toContain('sensitive');
    expect(Object.keys(error as object).sort()).toEqual(['adapter', 'operation', 'reason']);
  });

  it('reports the public Supabase get operation for an unavailable row read', async () => {
    const error = await supabaseGetError({ data: null, error: { code: '08006', message: 'sensitive database detail' } });

    expect(error).toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ adapter: 'supabase', operation: 'get', reason: 'connection_unavailable' });
  });

  it.each([
    { code: '42501', label: 'permission denial' },
    { code: '42P01', label: 'schema error' },
    { code: 'PGRST205', label: 'schema cache error' },
    { code: 'PGRST200', label: 'schema relationship error' },
    { code: 'XX000', label: 'generic database error' },
    { code: '57014', label: 'generic query cancellation' },
  ])('keeps Supabase $label ($code) distinct from read unavailability', async ({ code }) => {
    const error = await supabaseListError({ data: null, error: { code, message: 'database detail' } });

    expect(error).not.toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ name: 'SupabaseStoreError', code: 'STORAGE' });
  });

  it('keeps Supabase serialization conflicts distinct from read unavailability', async () => {
    const error = await supabaseListError({ data: null, error: { code: '40001', message: 'serialization failure' } });

    expect(error).not.toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ name: 'SupabaseStoreError', code: 'CONFLICT' });
  });

  it('does not classify malformed Supabase rows as read unavailability', async () => {
    const error = await supabaseListError({
      data: [{ id: 'stored-id', payload: { id: 'different-id', name: 'branch' } }],
      error: null,
    });

    expect(error).not.toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ name: 'SupabaseStoreError', code: 'STORAGE' });
  });

  it('preserves definite-no-commit for an unavailable Store.transaction preflight read', async () => {
    const { client, rpcCalls } = supabaseReadClient({ data: null, error: { code: 'PGRST003', message: 'pool details' } });
    const store = createSupabaseStoreFromClient(client);
    const work = vi.fn(async () => undefined);

    let error: unknown;
    try {
      await store.transaction(work);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(Object.keys(error as object).sort()).toEqual(['adapter', 'operation', 'reason']);
    expect(work).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('preserves definite-no-commit for an unavailable workflowTransaction preflight read', async () => {
    const { client, rpcCalls } = supabaseReadClient({ data: null, error: { code: '08006', message: 'connection detail' } });
    const store = createSupabaseStoreFromClient(client);
    const work = vi.fn(async () => undefined);

    let error: unknown;
    try {
      await store.workflowTransaction(work);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(Object.keys(error as object).sort()).toEqual(['adapter', 'operation', 'reason']);
    expect(work).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('keeps commit failures after RPC dispatch as outcome-unknown', async () => {
    const { client, rpcCalls } = supabaseReadClient(
      { data: { revision: 7 }, error: null },
      { data: null, error: { code: 'PGRST000', message: 'commit connection detail' } },
    );
    const store = createSupabaseStoreFromClient(client);

    let error: unknown;
    try {
      await store.transaction(async (tx) => {
        await tx.put('profiles', { id: 'profile-1', name: 'Ari' });
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeInstanceOf(StorageReadUnavailableError);
    expect(error).toMatchObject({ name: 'SupabaseStoreError', code: 'STORAGE', definitelyNotCommitted: false });
    expect(rpcCalls).toEqual(['nexus_commit']);
  });

  itSqliteBound('maps a real SQLite legacy list lock failure without exposing the driver message', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const blocker = fixture.openDatabase();
    try {
      blocker.exec('BEGIN EXCLUSIVE');

      let error: unknown;
      try {
        await fixture.store.list('profiles');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(StorageReadUnavailableError);
      expect(error).toMatchObject({ adapter: 'sqlite', operation: 'list', reason: 'database_busy' });
      expect((error as Error).message).toBe('Storage read unavailable (sqlite/list/database_busy)');
      expect(Object.keys(error as object).sort()).toEqual(['adapter', 'operation', 'reason']);
    } finally {
      try { blocker.exec('ROLLBACK'); } catch { /* The blocker may already have left its transaction. */ }
      blocker.close();
      await fixture.dispose();
    }
  }, 60_000);

  itSqliteBound('keeps a SQLite missing-table read error distinct from availability failures', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const database = fixture.openDatabase();
    try {
      database.exec('DROP TABLE profiles');

      let error: unknown;
      try {
        await fixture.store.list('profiles');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(StorageReadUnavailableError);
      expect(error).toMatchObject({ code: 'SQLITE_ERROR' });
    } finally {
      database.close();
      await fixture.dispose();
    }
  });
});
