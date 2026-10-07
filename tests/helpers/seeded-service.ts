import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Store, Table } from '../../lib/contracts';
import { ConciergeService } from '../../lib/core/service';
import { createSeedData } from '../../lib/seed/generate';
import { createSqliteStore } from '../../lib/storage/sqlite';

export const SEED_BUSINESS_DATE = '2026-10-01';
export const SEED_NOW = new Date('2026-10-02T05:00:00.000Z');

/** A fully seeded demo workspace (all branches, the served data window) with live_ai sessions for the executive / east / hr profiles. The caller stubs AI_PROVIDER=scripted. */
export async function createSeededService() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-tests-seeded-'));
  const store: Store & { close?: () => void } = createSqliteStore(join(directory, 'seeded.sqlite'));
  const seed = createSeedData(SEED_BUSINESS_DATE);
  const ids = ['executive', 'east', 'hr'];
  const sessions = seed.profiles.filter(p => ids.includes(p.id)).map(p => ({ id: `seeded-session-${p.id}`, profileId: p.id, mode: 'live_ai', modeRevision: 1, csrfToken: 'seeded-csrf', expiresAt: '2099-01-01T00:00:00.000Z' }));
  const rows: Array<[Table, Array<{ id: string }>]> = [
    ['profiles', seed.profiles], ['branches', seed.branches], ['products', seed.products], ['sales_orders', seed.sales_orders],
    ['sales_targets', seed.sales_targets], ['inventory_snapshots', seed.inventory_snapshots], ['incidents', seed.incidents],
    ['staffing_summaries', seed.staffing_summaries], ['employees', seed.employees], ['policy_documents', seed.policy_documents],
    ['mock_badges', seed.mock_badges], ['sessions', sessions],
  ];
  await store.transaction(async tx => { for (const [table, values] of rows) for (const value of values) await tx.put(table, value); });
  const actors = {} as Record<'executive' | 'east' | 'hr', Actor>;
  for (const profile of seed.profiles) {
    if (profile.id === 'executive' || profile.id === 'east' || profile.id === 'hr') actors[profile.id] = { ...profile, sessionId: `seeded-session-${profile.id}`, mode: 'live_ai', modeRevision: 1 };
  }
  let now = new Date(SEED_NOW);
  const service = new ConciergeService(store, { businessDate: SEED_BUSINESS_DATE, now: () => new Date(now) });
  return {
    store, service, actors, directory, setNow(next: Date) { now = new Date(next); },
    async dispose() { try { store.close?.(); } finally { await rm(directory, { recursive: true, force: true }); } },
  };
}
