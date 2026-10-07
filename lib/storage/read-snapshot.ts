import type { Store } from '../contracts';

/** Keep authentication and every dependent read in the same validated revision. */
export function withReadSnapshot<T>(store: Store, work: () => Promise<T>): Promise<T> {
  return store.readSnapshot ? store.readSnapshot(work) : work();
}
