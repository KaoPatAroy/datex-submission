import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/lib/contracts';
import { closedOutcome, listClosedProposalsPage } from '@/app/api/router-proposals/_view';
import { stagedRowSchema, type StagedRow } from '@/lib/router/storage/staged-store';
import { actors, createWorkspaceFixture, FIXED_NOW } from '../../helpers/workspace';

vi.mock('server-only', () => ({}));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
beforeEach(async () => { fixture = await createWorkspaceFixture(); });
afterEach(async () => { await fixture.dispose(); });

const NOW = FIXED_NOW.getTime();
const HOUR = 3_600_000;
const row = (id: string, patch: Partial<StagedRow>, actorId = 'executive'): StagedRow => stagedRowSchema.parse({
  id, schemaVersion: 1, actorId, conversationId: 'c1', turnId: 't1', actionId: 'communication.send', digest: `d-${id}`, status: 'pending', expiresAt: NOW + HOUR,
  createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR, revision: 2, preview: `preview ${id}`, data: { params: {} }, ...patch });
const put = (rows: StagedRow[]) => fixture.store.transaction(async tx => { for (const r of rows) await tx.put('router_proposals', r); });

describe('P2-7: History of proposals that ended without an effect', { timeout: 60_000 }, () => {
  it('classifies cancelled, expired (pending past expiry, or stale after expiry) and not-completed; pending live, completed and claimed-live rows are not closed', () => {
    expect(closedOutcome(row('a', { status: 'cancelled' }), NOW)).toBe('cancelled');
    expect(closedOutcome(row('b', { status: 'pending', expiresAt: NOW - 1 }), NOW)).toBe('expired');
    expect(closedOutcome(row('c', { status: 'stale', expiresAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR }), NOW)).toBe('expired');
    expect(closedOutcome(row('d', { status: 'stale', expiresAt: NOW + HOUR, updatedAt: NOW - HOUR }), NOW)).toBe('not_completed');
    expect(closedOutcome(row('e', { status: 'pending' }), NOW)).toBeNull();
    expect(closedOutcome(row('f', { status: 'completed' }), NOW)).toBeNull();
    expect(closedOutcome(row('g', { status: 'claimed', claimExpiresAt: NOW + 60_000 }), NOW)).toBeNull();
  });

  it('lists only this actor\'s closed proposals, newest first, with exact totals and a cursor to older ones; nothing of other actors', async () => {
    const rows = [
      row('p1', { status: 'cancelled', updatedAt: NOW - 3 * HOUR }), row('p2', { status: 'stale', expiresAt: NOW + HOUR, updatedAt: NOW - 2 * HOUR }),
      row('p3', { status: 'pending', expiresAt: NOW - HOUR }), row('p4', { status: 'pending' }), row('p5', { status: 'completed' }),
      row('other', { status: 'cancelled' }, 'east'),
    ];
    await put(rows);
    const page = await listClosedProposalsPage(fixture.store, actors.executive, { limit: 2 }, NOW);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = await listClosedProposalsPage(fixture.store, actors.executive, { cursor: page.nextCursor }, NOW);
    const all = [...page.items, ...rest.items];
    expect(all.map(i => [i.id, i.outcome]).sort()).toEqual([['p1', 'cancelled'], ['p2', 'not_completed'], ['p3', 'expired']]);
    expect(all.every(i => i.id !== 'other' && i.id !== 'p4' && i.id !== 'p5')).toBe(true);
    expect((await listClosedProposalsPage(fixture.store, actors.east, {}, NOW)).items.map(i => i.id)).toEqual(['other']);
    // History's failed / expired filters narrow to exactly that outcome (cancelled rows are not mixed in).
    const failed = await listClosedProposalsPage(fixture.store, actors.executive, {}, NOW, 'not_completed');
    expect([failed.total, failed.items.map(i => i.id)]).toEqual([1, ['p2']]);
    const expired = await listClosedProposalsPage(fixture.store, actors.executive, {}, NOW, 'expired');
    expect([expired.total, expired.items.map(i => i.id)]).toEqual([1, ['p3']]);
  });

  it('shows the review text only while the viewer is still authorized; a lost permission redacts it', async () => {
    await put([row('r1', { status: 'cancelled', actionId: 'dashboard.refine' })]);
    expect((await listClosedProposalsPage(fixture.store, actors.executive, {}, NOW)).items[0]!.preview).toBe('preview r1');
    const profile = (await fixture.store.get<Profile>('profiles', 'executive'))!;
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile, permissions: profile.permissions.filter(p => p !== 'dashboard.create') }));
    const [item] = (await listClosedProposalsPage(fixture.store, actors.executive, {}, NOW)).items;
    expect(item).toMatchObject({ id: 'r1', outcome: 'cancelled', preview: null });
  });
});
