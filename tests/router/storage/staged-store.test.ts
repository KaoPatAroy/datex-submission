import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Store } from '@/lib/contracts';
import { createSqliteStore } from '@/lib/storage/sqlite';
import { createStagedStore, STAGED_PROPOSAL_TTL_MS, stagedRowSchema } from '@/lib/router/storage/staged-store';

const actor = (id: string): Actor => ({ id, name: id, role: 'executive', active: true, regions: ['east'], permissions: [], sessionId: 's', mode: 'live_ai', modeRevision: 1 } as Actor);
const A = actor('a'), B = actor('b');
const stores: Store[] = [];
async function setup(t = { v: 1_000_000 }) {
  const store = createSqliteStore(':memory:'); stores.push(store);
  await store.transaction(tx => tx.put('profiles', { id: 'p', name: 'p', role: 'executive', active: true, regions: ['east'], permissions: [] } as never));
  await store.transaction(tx => tx.put('sessions', { id: 's', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
  let n = 0;
  return { store, t, staged: createStagedStore(store, { now: () => t.v, newId: () => `stg_${++n}` }) };
}
const input = (over: Record<string, unknown> = {}) => ({ actionId: 'dashboard.delete' as const, digest: 'd1', preview: 'delete D1', data: { params: { dashboardId: 'D1' } }, expiresAt: 1_000_000 + 600_000, ...over });
afterEach(() => { while (stores.length) stores.pop()?.close?.(); });

describe('staged proposal store (SQLite)', () => {
  it('creates, dedupes by digest, and scopes to actor + conversation', async () => {
    const { staged } = await setup();
    const p = await staged.create(A, { conversationId: 'c1', turnId: 't1' }, input());
    expect(p.status).toBe('pending');
    expect((await staged.create(A, { conversationId: 'c1', turnId: 't2' }, input())).id).toBe(p.id);
    expect((await staged.findPending(A, 'c1', 'd1'))?.id).toBe(p.id);
    expect(await staged.findPending(A, 'c2', 'd1')).toBeUndefined();
    expect(await staged.findPending(B, 'c1', 'd1')).toBeUndefined();
    expect(await staged.get(B, p.id)).toBeUndefined();
    expect(await staged.getInConversation(A, 'c2', p.id)).toBeUndefined();
    expect(await staged.list(A, 'c1')).toHaveLength(1);
    expect(await staged.list(B, 'c1')).toHaveLength(0);
  });
  it('clamps expiry to 24 h and rejects past expiry', async () => {
    const { staged } = await setup();
    const p = await staged.create(A, { conversationId: 'c1', turnId: 't' }, input({ expiresAt: 1_000_000 + 99 * 3_600_000 }));
    expect(p.expiresAt).toBe(1_000_000 + STAGED_PROPOSAL_TTL_MS);
    await expect(staged.create(A, { conversationId: 'c1', turnId: 't' }, input({ digest: 'x', expiresAt: 5 }))).rejects.toMatchObject({ code: 'STAGED_EXPIRY' });
  });
  it('moves pending to terminal once, with revision CAS and expiry', async () => {
    const { staged, t } = await setup();
    const p = await staged.create(A, { conversationId: 'c1', turnId: 't' }, input());
    await expect(staged.save(A, p.id, { status: 'completed', expectedRevision: 9 })).rejects.toMatchObject({ code: 'STAGED_CONFLICT' });
    await expect(staged.save(B, p.id, { status: 'cancelled' })).rejects.toMatchObject({ code: 'STAGED_NOT_FOUND' });
    const done = await staged.save(A, p.id, { status: 'completed', data: { ok: true }, expectedRevision: 1 });
    expect(done).toMatchObject({ status: 'completed', data: { ok: true } });
    expect(await staged.revisionOf(A, p.id)).toBe(2);
    expect((await staged.save(A, p.id, { status: 'completed' })).status).toBe('completed');
    await expect(staged.save(A, p.id, { status: 'cancelled' })).rejects.toMatchObject({ code: 'STAGED_CONFLICT' });
    expect(await staged.findPending(A, 'c1', 'd1')).toBeUndefined();
    const q = await staged.create(A, { conversationId: 'c1', turnId: 't' }, input({ digest: 'd2' }));
    t.v += 500_000;
    expect((await staged.findPending(A, 'c1', 'd2'))?.id).toBe(q.id);
    t.v += STAGED_PROPOSAL_TTL_MS;
    await expect(staged.save(A, q.id, { status: 'completed' })).rejects.toMatchObject({ code: 'STAGED_EXPIRED' });
    expect((await staged.save(A, q.id, { status: 'stale' })).status).toBe('stale');
  });
  it('validates rows strictly', () => {
    expect(stagedRowSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(stagedRowSchema.safeParse({ id: 'x', schemaVersion: 1, actorId: 'a', conversationId: 'c', turnId: 't', actionId: 'badge.revoke', digest: 'd', status: 'pending',
      expiresAt: 2, createdAt: 1, updatedAt: 1, revision: 1, preview: '', data: {} }).success).toBe(false);
  });
  it('rejects a corrupted stored row', async () => {
    const { staged, store } = await setup();
    await store.transaction(async tx => { await tx.put('router_proposals', { id: 'bad', actorId: 'a', junk: true }); });
    await expect(staged.get(A, 'bad')).rejects.toMatchObject({ code: 'STAGED_INVALID' });
  });
});

describe('staged proposal claim (confirm concurrency)', () => {
  it('lets exactly one confirmer claim a pending proposal; only the claimant finishes it', async () => {
    const { staged } = await setup();
    const p = await staged.create(A, { conversationId: 'c1', turnId: 't' }, input());
    const [first, second] = await Promise.all([staged.claim(A, p.id), staged.claim(A, p.id)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const token = (first ?? second)!.claimToken;
    expect(await staged.claim(B, p.id)).toBeUndefined();
    await expect(staged.save(A, p.id, { status: 'cancelled' })).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    await expect(staged.save(A, p.id, { status: 'cancelled', claimToken: token })).rejects.toMatchObject({ code: 'STAGED_CONFLICT' });
    expect((await staged.save(A, p.id, { status: 'completed', claimToken: token })).status).toBe('completed');
    expect(await staged.claim(A, p.id)).toBeUndefined();
  });
  it('does not claim an expired proposal', async () => {
    const { staged, t } = await setup();
    const p = await staged.create(A, { conversationId: 'c1', turnId: 't' }, input());
    t.v += 700_000;
    expect(await staged.claim(A, p.id)).toBeUndefined();
  });
});
