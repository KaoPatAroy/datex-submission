import { isRevisionConflict } from './supabase';
import { waitForRevisionRetry } from './retry-backoff';

/**
 * Service-level retry for revision conflicts on the PostgreSQL adapter.
 *
 * The adapter itself never replays: a commit that loses the global-revision check is rolled back (40001) and surfaced as
 * a definite CONFLICT. Every transaction callback in this codebase is a pure function of its reads plus its own writes,
 * so re-running it against fresh state yields the serial outcome SQLite gives for free. This wrapper does exactly that,
 * bounded, and only for definite revision conflicts: unknown-outcome errors, business conflicts (stale CAS, unique key
 * conflicts) and every other error pass through untouched, and a committed transaction is never run twice.
 */
export const COMMIT_CONFLICT_MAX_ATTEMPTS = 8;

async function retrying<T>(run: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRevisionConflict(error) || attempt >= attempts - 1) throw error;
      await waitForRevisionRetry(attempt);
    }
  }
  throw new Error('Commit conflict retry exhausted without a result');
}

export function withCommitConflictRetry<S extends object>(store: S, attempts = COMMIT_CONFLICT_MAX_ATTEMPTS): S {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > COMMIT_CONFLICT_MAX_ATTEMPTS) {
    throw new RangeError(`Commit conflict attempts must be an integer between 1 and ${COMMIT_CONFLICT_MAX_ATTEMPTS}`);
  }
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if ((property === 'transaction' || property === 'workflowTransaction') && typeof value === 'function') {
        return (work: unknown) => retrying(() => (value as (work: unknown) => Promise<unknown>).call(target, work), attempts);
      }
      return value;
    },
  });
}
