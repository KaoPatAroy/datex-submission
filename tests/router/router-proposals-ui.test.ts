import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, Store, ConversationMessage } from '@/lib/contracts';
import { createSqliteStore } from '@/lib/storage/sqlite';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { cancelProposal, listPendingProposals, NOT_CONFIRMABLE_PREVIEW, proposalDetails } from '@/app/api/router-proposals/_view';
import {
  artifactOperationPath, clarificationChoices, clarificationSelection, fetchPendingProposals, loadPendingProposals, PROPOSALS_LOAD_ERROR, proposalDetailRows, proposalsForTurn,
  requestArtifactWrite, type RouterProposalView,
} from '@/components/biztania/router-ui';
import { chatTurnRequestSchema } from '@/lib/server/chat-request';
import { chatStreamRequestSchema } from '@/lib/chat-stream-contracts';
import { isMissingTableError, missingTableError, StorageMissingTableError, StorageReadUnavailableError, supabaseReadUnavailableError } from '@/lib/storage/read-error';

const actor = (id: string): Actor => ({ id, name: id, role: 'executive', active: true, regions: ['east'], permissions: ['dashboard.create', 'sales.read'], sessionId: 's', mode: 'live_ai', modeRevision: 1 } as Actor);
const A = actor('a'), B = actor('b');
const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()?.close?.(); });
async function setup() {
  const store = createSqliteStore(':memory:'); stores.push(store);
  const staged = createStagedStore(store);
  await store.transaction(tx => tx.put('profiles', { id: 'p', name: 'p', role: 'executive', active: true, regions: ['east'], permissions: [] } as never));
  await store.transaction(tx => tx.put('sessions', { id: 's', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
  for (const who of [A, B, actor('u1'), actor('u2')]) await store.transaction(tx => tx.put('profiles', { id: who.id, name: who.name, role: 'executive', active: true, regions: ['east'], permissions: ['dashboard.create', 'sales.read'] }));
  await store.transaction(tx => tx.put('dashboards', { id: 'D1', ownerId: A.id, packs: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastRefreshAt: '2026-10-01T00:00:00.000Z',
    sourceMetadata: [], analysis: null, evidenceVersion: 'v', spec: { title: 'D1', description: '', scope: { region: 'east', date: '2026-10-01' }, widgets: [] } } as never));
  const data = { params: { dashboardId: 'D1', recipientIds: ['u1', 'u2'], n: 3, flag: true, nested: { x: 1 } }, workflow: { preview: { token: 'SECRET' } } };
  const p = await staged.create(A, { conversationId: 'c1', turnId: 't1' }, { actionId: 'dashboard.delete', digest: 'd1', preview: 'ลบ D1', data, expiresAt: Date.now() + 600_000 });
  return { store, staged, p };
}

describe('router-proposals server view', () => {
  it('lists only this actor pending proposals and never leaks workflow tokens', async () => {
    const { store, p } = await setup();
    const mine = await listPendingProposals(store, A);
    expect(mine.map(item => item.id)).toEqual([p.id]);
    expect(JSON.stringify(mine)).not.toContain('SECRET');
    // Display values only (dashboard title, Thai role names); unknown params and raw ids are not shown.
    expect(mine[0].details).toEqual({ dashboardId: 'D1', recipientIds: ['u1 (ผู้บริหาร)', 'u2 (ผู้บริหาร)'] });
    expect(await listPendingProposals(store, B)).toEqual([]);
    expect(await listPendingProposals(store, A, Date.now() + 99 * 3_600_000)).toEqual([]);
  });
  it('F4: a proposal the current actor is no longer authorized for is redacted and not confirmable', async () => {
    const { store, p } = await setup();
    const fresh = await listPendingProposals(store, A);
    expect(fresh[0]).toMatchObject({ confirmable: true, preview: 'ลบ D1' });
    const profile = (await store.get<Record<string, unknown> & { permissions: string[] }>('profiles', A.id))!;
    await store.transaction(tx => tx.put('profiles', { ...profile, permissions: ['sales.read'] } as never)); // dashboard.create revoked
    const stale = await listPendingProposals(store, A);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ id: p.id, confirmable: false, preview: NOT_CONFIRMABLE_PREVIEW, details: {} });
    expect(JSON.stringify(stale)).not.toContain('D1');
    await store.transaction(tx => tx.remove('dashboards', 'D1')); // the dashboard disappearing also makes it unconfirmable
    await store.transaction(tx => tx.put('profiles', { ...profile } as never));
    expect((await listPendingProposals(store, A))[0].confirmable).toBe(false);
  });
  it('F10: a claimed proposal whose lease expired is listed (reclaimable); a live claim is not', async () => {
    const { store, staged, p } = await setup();
    await staged.claim(A, p.id);
    expect(await listPendingProposals(store, A)).toEqual([]);
    expect((await listPendingProposals(store, A, Date.now() + 3 * 60_000))[0]).toMatchObject({ id: p.id, status: 'pending', confirmable: true });
  });
  it('G5: a transient storage outage is a typed 503, never an empty list', async () => {
    const broken = { list: async () => { throw new StorageReadUnavailableError('supabase', 'list', 'connection_unavailable'); } } as unknown as Store;
    await expect(listPendingProposals(broken, A)).rejects.toMatchObject({ code: 'PROPOSALS_UNAVAILABLE', status: 503 });
  });
  it('G5: a store without the router_proposals table lists nothing (staged actions are gated off), not a retry banner', async () => {
    const noTable = { list: async () => { throw new StorageMissingTableError('supabase', 'list'); } } as unknown as Store;
    expect(await listPendingProposals(noTable, A)).toEqual([]);
  });
  it('F13: an untyped transport failure (or any unclassified error) is a 503, never an empty list', async () => {
    for (const failure of [new TypeError('fetch failed'), new Error('socket hang up'), { message: 'boom' }]) {
      const broken = { list: async () => { throw failure; } } as unknown as Store;
      await expect(listPendingProposals(broken, A)).rejects.toMatchObject({ code: 'PROPOSALS_UNAVAILABLE', status: 503 });
    }
  });
  it('F13: only PGRST205 / 42P01 / sqlite "no such table" classify as a missing table; code-less PostgREST errors are outages', () => {
    expect(missingTableError({ code: 'PGRST205' }, 'supabase', 'list')).toBeInstanceOf(StorageMissingTableError);
    expect(missingTableError({ code: '42P01' }, 'supabase', 'list')).toBeInstanceOf(StorageMissingTableError);
    expect(missingTableError({ message: 'no such table: router_proposals' }, 'sqlite', 'list')).toBeInstanceOf(StorageMissingTableError);
    expect(missingTableError({ code: '' , message: 'TypeError: fetch failed' }, 'supabase', 'list')).toBeUndefined();
    expect(isMissingTableError(Object.assign(new Error('no such table: router_proposals'), { code: 'SQLITE_ERROR' }))).toBe(true);
    expect(isMissingTableError(new Error('no such table: router_proposals'))).toBe(false);
    expect(supabaseReadUnavailableError({ code: '', message: 'TypeError: fetch failed' }, 'list')).toMatchObject({ reason: 'connection_unavailable' });
  });
  it('cancel is actor-scoped, idempotent and does not touch other states', async () => {
    const { store, staged, p } = await setup();
    await expect(cancelProposal(store, B, p.id)).rejects.toMatchObject({ status: 404 });
    expect(await cancelProposal(store, A, p.id)).toMatchObject({ status: 'cancelled' });
    expect((await staged.get(A, p.id))?.status).toBe('cancelled');
    expect(await cancelProposal(store, A, p.id)).toMatchObject({ status: 'cancelled' });
    expect(await listPendingProposals(store, A)).toEqual([]);
    const q = await staged.create(A, { conversationId: 'c1', turnId: 't2' }, { actionId: 'monitor.create', digest: 'd2', preview: 'm', data: {}, expiresAt: Date.now() + 600_000 });
    await staged.claim(A, q.id);
    await expect(cancelProposal(store, A, q.id)).rejects.toMatchObject({ status: 409 });
  });
  it('whitelists detail values', () => {
    expect(proposalDetails({ params: { a: 'x'.repeat(900), b: [1, 2], c: ['ok'] } })).toEqual({ a: 'x'.repeat(500), c: ['ok'] });
    expect(proposalDetails({})).toEqual({});
  });
});

const view = (over: Partial<RouterProposalView> = {}): RouterProposalView => ({ id: 'p1', conversationId: 'c', turnId: 't1', actionId: 'dashboard.delete', status: 'pending', expiresAt: 2000, createdAt: 1, preview: 'x', details: { dashboardId: 'D1', recipientIds: ['u1', 'u2'] }, confirmable: true, ...over });

describe('router UI client logic', () => {
  it('attaches proposals to their turn only while pending and unexpired', () => {
    const items = [view(), view({ id: 'p2', turnId: 't2' }), view({ id: 'p3', status: 'completed' }), view({ id: 'p4', expiresAt: 5 })];
    expect(proposalsForTurn(items, 't1', 1000).map(i => i.id)).toEqual(['p1']);
    expect(proposalsForTurn(items, undefined, 1000)).toEqual([]);
  });
  it('shows the exact details as labelled rows', () => {
    expect(proposalDetailRows(view())).toEqual([
      { key: 'dashboardId', label: 'Dashboard', value: 'D1' }, { key: 'recipientIds', label: 'ผู้รับ', value: 'u1, u2' }]);
  });
  it('fetch failure is an error state, never an empty list (F13)', async () => {
    await expect(fetchPendingProposals((async () => { throw new Error('x'); }) as never)).rejects.toThrow('x');
    expect(await loadPendingProposals((async () => { throw new Error('x'); }) as never)).toEqual({ status: 'error', message: PROPOSALS_LOAD_ERROR });
    expect(await loadPendingProposals((async () => ({ proposals: [] })) as never)).toEqual({ status: 'ready', proposals: [] });
    expect(await fetchPendingProposals((async () => ({ proposals: [view()] })) as never)).toHaveLength(1);
    expect(await fetchPendingProposals((async () => ({})) as never)).toEqual([]);
  });
  it('clarification chips: only on the latest assistant message; selection is structured', () => {
    const message = { role: 'assistant', turnId: 't9', choices: [{ id: 'east', label: 'ภาคตะวันออก' }] } as Pick<ConversationMessage, 'role' | 'turnId' | 'choices'>;
    expect(clarificationChoices(message, true)).toHaveLength(1);
    expect(clarificationChoices(message, false)).toEqual([]);
    expect(clarificationChoices({ ...message, role: 'user' }, true)).toEqual([]);
    expect(clarificationSelection(message, message.choices![0])).toEqual({ message: 'ภาคตะวันออก', clarification: { choiceId: 'east', clarifiedTurnId: 't9' } });
    expect(clarificationSelection({ turnId: undefined }, { id: 'a', label: 'b' })).toBeUndefined();
  });
});

describe('artifact write client (mocked server contract)', () => {
  const artifact = { id: 'art 1', revision: 2 };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('posts to /api/artifacts/{id}/save|export with csrf and revision', async () => {
    const fetcher = vi.fn(async () => json({ outcome: 'proposed', pendingActionId: 'pa1', preview: 'บันทึก' }));
    const result = await requestArtifactWrite(fetcher as never, 'csrf', artifact, 'save', 'c1');
    expect(result).toEqual({ kind: 'proposal', operation: 'save', proposalId: 'pa1', preview: 'บันทึก' });
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(artifactOperationPath('art 1', 'save'));
    expect(path).toBe('/api/artifacts/art%201/save');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf');
    expect(JSON.parse(init.body as string)).toEqual({ revision: 2, conversationId: 'c1' });
  });
  it('handles a CSV file body, a JSON completion and an error', async () => {
    const csv = new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sales.csv"' } });
    expect(await requestArtifactWrite((async () => csv) as never, 'c', artifact, 'export')).toEqual({ kind: 'file', operation: 'export', filename: 'sales.csv', mime: 'text/csv', content: 'a,b\n1,2' });
    expect(await requestArtifactWrite((async () => json({ outcome: 'saved', text: 'บันทึกแล้ว' })) as never, 'c', artifact, 'save')).toEqual({ kind: 'done', operation: 'save', text: 'บันทึกแล้ว' });
    await expect(requestArtifactWrite((async () => json({ error: { message: 'ไม่มีสิทธิ์' } }, 403)) as never, 'c', artifact, 'save')).rejects.toThrow('ไม่มีสิทธิ์');
  });
});

describe('chat request: structured clarification selection', () => {
  const base = { message: 'ภาคตะวันออก', contractVersion: 2, requestKey: 'k'.repeat(20) };
  it('accepts a paired selection with a requestKey and rejects partial or keyless ones', () => {
    expect(chatTurnRequestSchema.safeParse({ ...base, clarificationChoiceId: 'east', clarifiedTurnId: 't1' }).success).toBe(true);
    expect(chatTurnRequestSchema.safeParse({ ...base, clarificationChoiceId: 'east' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ message: 'x', clarificationChoiceId: 'east', clarifiedTurnId: 't1' }).success).toBe(false);
  });
  it('is accepted by the stream request schema', () => {
    const stream = { streamVersion: 1, contractVersion: 2, requestKey: 'k'.repeat(20), message: 'ภาคตะวันออก', clarificationChoiceId: 'east', clarifiedTurnId: 't1' };
    expect(chatStreamRequestSchema.safeParse(stream).success).toBe(true);
    expect(chatStreamRequestSchema.safeParse({ ...stream, clarifiedTurnId: undefined }).success).toBe(false);
  });
});
