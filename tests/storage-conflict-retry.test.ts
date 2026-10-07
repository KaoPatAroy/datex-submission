import { describe, expect, it } from 'vitest';
import { withCommitConflictRetry } from '../lib/storage/conflict-retry';
import { markRevisionConflict } from '../lib/storage/supabase';

function storeFailing(times: number, makeError: () => Error) {
  const calls = { transaction: 0, workflowTransaction: 0, other: 0 };
  const store = {
    adapter: 'fake',
    workflowContractVersion: 2,
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      calls.transaction += 1;
      if (calls.transaction <= times) throw makeError();
      return work();
    },
    async workflowTransaction<T>(work: () => Promise<T>): Promise<T> {
      calls.workflowTransaction += 1;
      if (calls.workflowTransaction <= times) throw makeError();
      return work();
    },
    async get(): Promise<string> { calls.other += 1; return 'row'; },
  };
  return { store, calls };
}
const revision = () => markRevisionConflict(Object.assign(new Error('Supabase store transaction conflicted with a concurrent write'), { code: 'CONFLICT', definitelyNotCommitted: true }));

describe('commit conflict retry (service-level)', () => {
  it('re-runs a transaction rolled back by a revision conflict and returns the fresh result', async () => {
    const { store, calls } = storeFailing(3, revision);
    const wrapped = withCommitConflictRetry(store);
    expect(await wrapped.transaction(async () => 'ok')).toBe('ok');
    expect(await wrapped.workflowTransaction(async () => 'wf')).toBe('wf');
    expect(calls).toMatchObject({ transaction: 4, workflowTransaction: 4 });
    expect(wrapped.adapter).toBe('fake');
    expect(wrapped.workflowContractVersion).toBe(2);
    expect(await wrapped.get()).toBe('row');
  });

  it('is bounded, and rethrows the conflict when every attempt loses', async () => {
    const { store, calls } = storeFailing(100, revision);
    const error = await withCommitConflictRetry(store, 3).transaction(async () => 'never').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(calls.transaction).toBe(3);
  });

  it('never retries unknown outcomes, business conflicts or other errors', async () => {
    for (const make of [
      () => Object.assign(new Error('unknown'), { code: 'STORAGE', definitelyNotCommitted: false }),
      () => Object.assign(new Error('stale compare-and-swap'), { code: 'CONFLICT', definitelyNotCommitted: true }),
      () => new Error('boom'),
    ]) {
      const { store, calls } = storeFailing(1, make);
      await expect(withCommitConflictRetry(store).transaction(async () => 'x')).rejects.toThrow();
      expect(calls.transaction).toBe(1);
    }
  });
});
