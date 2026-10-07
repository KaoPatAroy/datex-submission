import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, Branch, PendingAction } from '../lib/contracts';
import { readEvidence } from '../lib/packs/retail/evidence';
import { createSeedData } from '../lib/seed/generate';
import { seedStore } from '../lib/storage';
import { createSupabaseStore } from '../lib/storage/supabase';
import { localPgConfig, pgTestsEnabled, resetLocalPgData } from './helpers/local-pg';

/**
 * The Production adapter (createSupabaseStore) against the Production-equivalent schema
 * (`npm run db:local:reset -- --profile hosted-v1`: concierge + standalone V1 guard, no
 * V2 columns). Opt-in and profile-bound: skipped unless BIZTANIA_PG_TESTS=1 and the
 * local stack was last reset to hosted-v1.
 */
const hostedV1 = pgTestsEnabled && (() => { try { return localPgConfig().profile === 'hosted-v1'; } catch { return false; } })();
const BUSINESS_DATE = '2026-10-01';

function store() {
  const config = localPgConfig();
  return createSupabaseStore(config.url, config.serviceRoleKey);
}

function action(id: string, status: PendingAction['status']): PendingAction {
  return {
    id, actorId: 'w5-actor', sessionId: 'w5-session', conversationId: 'w5-conversation', turnId: `turn-${id}`,
    mode: 'live_ai', modeRevision: 0, payload: { kind: 'dashboard_create', spec: {
      title: 'Hosted V1 parity', description: 'Synthetic local action.',
      scope: { region: 'east', date: BUSINESS_DATE }, widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
    } } as PendingAction['payload'],
    payloadHash: `hash-${id}`, evidenceVersion: null, packs: [], actionContractVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', status, preview: 'Synthetic local action',
  };
}

describe.skipIf(!hostedV1)('Production adapter on the hosted-v1 local profile', () => {
  it('seeds the demo data and reads East evidence through the legacy (marker-less) tables', async () => {
    resetLocalPgData();
    const local = store();
    const seed = createSeedData(BUSINESS_DATE);
    await seedStore(local, BUSINESS_DATE, seed);
    expect(await local.list('profiles')).toHaveLength(seed.profiles.length);
    expect((await local.list<Branch>('branches')).length).toBe(seed.branches.length);
    const executive = seed.profiles.find((profile) => profile.role === 'executive')!;
    const actor: Actor = { ...executive, sessionId: 'w5-session', mode: 'scripted_demo', modeRevision: 0 };
    const evidence = await readEvidence(local, actor, { region: 'east', date: BUSINESS_DATE });
    expect(evidence.branches.length).toBeGreaterThan(0);
    expect(evidence.branches.every((branch) => branch.region.toLowerCase() === 'east')).toBe(true);
    expect(evidence.totals.netSales).toBeGreaterThan(0);
  }, 300_000);

  it('enforces the standalone V1 pending-action guard through the adapter', async () => {
    resetLocalPgData();
    const local = store();
    await local.transaction(async (tx) => { await tx.put('pending_actions', action('w5-a', 'pending')); });
    await local.transaction(async (tx) => { await tx.put('pending_actions', action('w5-a', 'claimed')); });
    await local.transaction(async (tx) => { await tx.put('pending_actions', action('w5-a', 'completed')); });
    expect((await local.get<PendingAction>('pending_actions', 'w5-a'))?.status).toBe('completed');
    expect(await local.list<PendingAction>('pending_actions')).toHaveLength(1);

    const rowCount = (await local.list('pending_actions')).length;
    await expect(local.transaction(async (tx) => { await tx.put('pending_actions', action('w5-a', 'pending')); })).rejects.toThrow();
    await expect(local.transaction(async (tx) => { await tx.remove('pending_actions', 'w5-a'); })).rejects.toThrow();
    await expect(local.transaction(async (tx) => { await tx.put('pending_actions', action('w5-b', 'completed')); })).rejects.toThrow();
    expect(await local.list<PendingAction>('pending_actions')).toHaveLength(rowCount);
    expect((await local.get<PendingAction>('pending_actions', 'w5-a'))?.status).toBe('completed');
  }, 120_000);
});
