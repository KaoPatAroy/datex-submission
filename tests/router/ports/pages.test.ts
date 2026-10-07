import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReceiptsPage } from '@/app/api/router-proposals/_view';
import { inboxRowSchema, INBOX_KIND, listInboxPage, markInboxRead } from '@/lib/router/ports/effect-store';
import { paginate } from '@/lib/pagination';
import { stagedRowSchema } from '@/lib/router/storage/staged-store';
import { actors, createWorkspaceFixture, FIXED_NOW } from '../../helpers/workspace';

vi.mock('server-only', () => ({}));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
beforeEach(async () => { fixture = await createWorkspaceFixture(); });
afterEach(async () => { await fixture.dispose(); });

const at = (minutesAgo: number) => new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();
const inboxRow = (n: number, recipientId = 'east') => inboxRowSchema.parse({ id: `inbox_${String(n).padStart(3, '0')}`, kind: INBOX_KIND, actorId: 'executive', senderName: 'Executive', recipientId,
  source: 'communication', title: `Message ${n}`, content: `body ${n}`, channelId: 'simulated_inbox', operationKey: `op-${n}`, planDigest: `pd-${n}`,
  target: { id: recipientId, version: 1, digest: 'a'.repeat(64) }, createdAt: at(1000 - n), readAt: null });
const putInbox = async (count: number) => fixture.store.transaction(async tx => { for (let n = 1; n <= count; n++) await tx.put('mock_messages', inboxRow(n)); });

describe('pagination helper', () => {
  it('keyset pages are stable, exact in total and reject a malformed cursor', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ k: String(i).padStart(3, '0') }));
    const a = paginate(items, i => i.k, {}, { limit: 10 }), b = paginate(items, i => i.k, { cursor: a.nextCursor }, { limit: 10 }), c = paginate(items, i => i.k, { cursor: b.nextCursor }, { limit: 10 });
    expect([a.items.length, b.items.length, c.items.length, a.total, c.nextCursor]).toEqual([10, 10, 5, 25, null]);
    expect(a.items[0]!.k).toBe('024');
    expect(() => paginate(items, i => i.k, { cursor: '***' }, { limit: 10 })).toThrow();
  });
});

describe('PC-03 Messages: 51 messages', { timeout: 60_000 }, () => {
  it('the 51st (oldest) message is reachable by cursor and counts are exact totals, not the page length', async () => {
    await putInbox(51);
    const first = await listInboxPage(fixture.store, actors.east);
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(51);
    expect(first.unreadTotal).toBe(51);
    expect(first.items[0]!.title).toBe('Message 51');
    const second = await listInboxPage(fixture.store, actors.east, { cursor: first.nextCursor });
    expect(second.items.map(m => m.title)).toEqual(['Message 1']);
    expect(second.nextCursor).toBeNull();
    expect((await listInboxPage(fixture.store, actors.executive)).total).toBe(0); // addressed to east only
  });
});

describe('PC-09 mark-read acknowledges only what was displayed', { timeout: 60_000 }, () => {
  it('60 unread: acknowledging the first page leaves the 10 not shown unread and reachable; retries are idempotent', async () => {
    await putInbox(60);
    const first = await listInboxPage(fixture.store, actors.east);
    expect(first.unreadTotal).toBe(60);
    expect(await markInboxRead(fixture.store, actors.east, FIXED_NOW, { ids: first.items.map(m => m.id) })).toBe(50);
    const after = await listInboxPage(fixture.store, actors.east, { unreadOnly: true });
    expect(after.unreadTotal).toBe(10);
    expect(after.total).toBe(10);
    expect(after.items.map(m => m.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Message ${10 - i}`));
    expect(await markInboxRead(fixture.store, actors.east, FIXED_NOW, { ids: first.items.map(m => m.id) })).toBe(0); // idempotent
    expect((await listInboxPage(fixture.store, actors.east)).unreadTotal).toBe(10);
    // ids of someone else's / unknown messages acknowledge nothing
    expect(await markInboxRead(fixture.store, actors.executive, FIXED_NOW, { ids: after.items.map(m => m.id) })).toBe(0);
    expect(await markInboxRead(fixture.store, actors.east, FIXED_NOW, { ids: ['inbox_nope'] })).toBe(0);
    expect((await listInboxPage(fixture.store, actors.east)).unreadTotal).toBe(10);
    // explicit mark-all remains available
    expect(await markInboxRead(fixture.store, actors.east, FIXED_NOW, { all: true })).toBe(10);
    expect((await listInboxPage(fixture.store, actors.east)).unreadTotal).toBe(0);
  });
});

describe('PC-03 router receipts: 31 receipts', { timeout: 60_000 }, () => {
  it('the oldest verified receipt is reachable by cursor and total is exact', async () => {
    const base = FIXED_NOW.getTime();
    await fixture.store.transaction(async tx => {
      for (let n = 1; n <= 31; n++) await tx.put('router_proposals', stagedRowSchema.parse({ id: `stg_${String(n).padStart(3, '0')}`, schemaVersion: 1, actorId: 'executive', conversationId: 'c1', turnId: 't1',
        actionId: 'task.create', digest: `d${n}`, status: 'completed', expiresAt: base + 86_400_000, createdAt: base - 100_000 + n, updatedAt: base + n * 1000, revision: 2, preview: 'p',
        data: { receipt: { kind: 'task.create', title: `Receipt ${n}`, headline: `done ${n}`, verifiedAt: new Date(base + n * 1000).toISOString() } } }));
    });
    const first = await listReceiptsPage(fixture.store, actors.executive);
    expect(first.items).toHaveLength(30);
    expect(first.total).toBe(31);
    expect(first.items[0]!.receipt.title).toBe('Receipt 31');
    expect(first.items[0]).toMatchObject({ conversationId: 'c1', turnId: 't1' });
    expect((await listReceiptsPage(fixture.store, actors.executive, {}, 'another-conversation')).total).toBe(0);
    const second = await listReceiptsPage(fixture.store, actors.executive, { cursor: first.nextCursor });
    expect(second.items.map(r => r.receipt.title)).toEqual(['Receipt 1']);
    expect(second.nextCursor).toBeNull();
    expect((await listReceiptsPage(fixture.store, actors.east)).total).toBe(0);
  });
});
