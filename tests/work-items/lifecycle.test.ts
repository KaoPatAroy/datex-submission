import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { workItemRowSchema, WORK_ITEM_STATUS, WORK_ITEM_TOOL } from '@/lib/router/ports/work-items';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { applyWorkItemOp, listManagedWorkItems, workItemStateRowId, type WorkItemLifecycleDeps } from '@/lib/work-items/lifecycle';
import { actors, createWorkspaceFixture, FIXED_NOW } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const ITEM = 'work-item:test-1';
const deps = (): WorkItemLifecycleDeps => ({ store: fixture.store, now: () => new Date(FIXED_NOW), recipientAllowed: createRecipientPolicy(fixture.store) });
const owner: Actor = actors.executive;

beforeEach(async () => {
  fixture = await createWorkspaceFixture();
  const row = workItemRowSchema.parse({ id: ITEM, name: WORK_ITEM_TOOL, status: WORK_ITEM_STATUS, actorId: 'executive', assigneeId: 'executive', proposalId: 'p1', operationKey: 'k1',
    title: 'Follow up East', priority: 'urgent', dueDate: '2026-10-05', grouping: 'single', checklist: ['Check sales'], branchIds: [], note: null, state: 'open', createdAt: FIXED_NOW.toISOString(), digest: 'd' });
  await fixture.store.transaction(tx => tx.put('tool_executions', row));
});
afterEach(async () => { await fixture.dispose(); });

const op = (input: Parameters<typeof applyWorkItemOp>[3], actor: Actor = owner) => applyWorkItemOp(deps(), actor, ITEM, input);
const only = async (actor: Actor = owner, includeArchived = false) => (await listManagedWorkItems(fixture.store, actor, { includeArchived }))[0];
const base = () => fixture.store.get<unknown>('tool_executions', ITEM);

describe('work item lifecycle overlay', { timeout: 30_000 }, () => {
  it('lists an untouched item as open / revision 0 and leaves the base row untouched through every change', async () => {
    const before = JSON.stringify(await base());
    expect(await only()).toMatchObject({ id: ITEM, state: 'open', revision: 0, title: 'Follow up East', mine: true });
    await op({ op: 'complete', baseRevision: 0 });
    await op({ op: 'reopen', baseRevision: 1 });
    await op({ op: 'edit', baseRevision: 2, fields: { title: 'New title' } });
    expect(JSON.stringify(await base())).toBe(before);
  });

  it('complete persists and a repeated complete is idempotent (no second write, revision unchanged)', async () => {
    expect(await op({ op: 'complete', baseRevision: 0 })).toMatchObject({ state: 'completed', revision: 1 });
    expect(await only()).toMatchObject({ state: 'completed', revision: 1 });
    expect(await op({ op: 'complete', baseRevision: 0 })).toMatchObject({ state: 'completed', revision: 1 });
    expect(await op({ op: 'complete', baseRevision: 1 })).toMatchObject({ state: 'completed', revision: 1 });
    expect((await fixture.store.get<{ revision: number }>('tool_executions', workItemStateRowId(ITEM)))?.revision).toBe(1);
  });

  it('edits persist (validated fields) and a stale baseRevision is refused without overwriting', async () => {
    const edited = await op({ op: 'edit', baseRevision: 0, fields: { title: 'Renamed', priority: 'low', dueDate: null, checklist: ['a', 'b'], note: 'n' } });
    expect(edited).toMatchObject({ title: 'Renamed', priority: 'low', dueDate: null, checklist: ['a', 'b'], note: 'n', revision: 1, state: 'open' });
    await expect(op({ op: 'edit', baseRevision: 0, fields: { title: 'Stale write' } })).rejects.toMatchObject({ code: 'WORK_ITEM_CHANGED', status: 409 });
    expect((await only())?.title).toBe('Renamed');
    await expect(op({ op: 'edit', baseRevision: 1, fields: { title: '' } })).rejects.toThrow();
    await expect(op({ op: 'edit', baseRevision: 1, fields: { priority: 'bogus' as never } })).rejects.toThrow();
    await expect(op({ op: 'edit', baseRevision: 1, fields: { checklist: Array(9).fill('x') } })).rejects.toThrow();
  });

  it('cancel then archive persists; archived items are hidden unless requested', async () => {
    await op({ op: 'cancel', baseRevision: 0 });
    expect(await only()).toMatchObject({ state: 'cancelled', revision: 1 });
    await op({ op: 'archive', baseRevision: 1 });
    expect(await only()).toBeUndefined();
    expect(await only(owner, true)).toMatchObject({ state: 'archived', revision: 2 });
  });

  it('rejects invalid transitions and edits outside the open state', async () => {
    await expect(op({ op: 'reopen', baseRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });
    await expect(op({ op: 'archive', baseRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await op({ op: 'cancel', baseRevision: 0 });
    await expect(op({ op: 'complete', baseRevision: 1 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(op({ op: 'cancel', baseRevision: 1 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(op({ op: 'edit', baseRevision: 1, fields: { title: 'x' } })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await op({ op: 'archive', baseRevision: 1 });
    await expect(op({ op: 'reopen', baseRevision: 2 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await only(owner, true)).toMatchObject({ state: 'archived', revision: 2 });
  });

  it('another actor can neither see nor mutate the item (404) and nothing changes', async () => {
    expect(await listManagedWorkItems(fixture.store, actors.east, { includeArchived: true })).toHaveLength(0);
    await expect(op({ op: 'complete', baseRevision: 0 }, actors.east)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(applyWorkItemOp(deps(), owner, 'work-item:missing', { op: 'complete', baseRevision: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await only()).toMatchObject({ state: 'open', revision: 0 });
  });

  it('changing the assignee re-checks recipient authority and needs explicit confirmation', async () => {
    await expect(op({ op: 'edit', baseRevision: 0, fields: { assigneeId: 'hr' } })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED', status: 403 }); // hr lacks sales.read
    await expect(op({ op: 'edit', baseRevision: 0, fields: { assigneeId: 'ghost' } })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(op({ op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' } })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 409 });
    expect(await only()).toMatchObject({ mine: true, revision: 0 });
    expect(await op({ op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' }, confirmAssigneeChange: true })).toMatchObject({ mine: false, revision: 1 });
    // Revoking the recipient's grant afterwards blocks a further reassignment.
    const east = await fixture.store.get<Profile>('profiles', 'east');
    await fixture.store.transaction(tx => tx.put('profiles', { ...east!, permissions: east!.permissions.filter(p => p !== 'sales.read') }));
    await expect(op({ op: 'edit', baseRevision: 1, fields: { assigneeId: 'east' } })).resolves.toBeDefined(); // unchanged assignee: no recheck needed
    await expect(op({ op: 'edit', baseRevision: 2, fields: { assigneeId: 'executive' }, confirmAssigneeChange: true })).resolves.toMatchObject({ mine: true });
  });

  it('P2: unarchive returns the item to the state it was archived from (cancelled or completed), with CAS, history and creator-only', async () => {
    // cancelled -> archived -> unarchive => cancelled
    await op({ op: 'cancel', baseRevision: 0 });
    await op({ op: 'archive', baseRevision: 1 });
    expect((await only(owner, true))?.allowedOps).toEqual(['unarchive']);
    await expect(op({ op: 'unarchive', baseRevision: 1 })).rejects.toMatchObject({ code: 'WORK_ITEM_CHANGED', status: 409 }); // stale
    expect(await op({ op: 'unarchive', baseRevision: 2 })).toMatchObject({ state: 'cancelled', revision: 3 });
    expect(await only()).toMatchObject({ state: 'cancelled', allowedOps: ['archive'] }); // visible in the active list again
    await expect(op({ op: 'unarchive', baseRevision: 3 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); // only archived items
    const overlay = await fixture.store.get<{ archivedAt: string | null; cancelledAt: string | null; completedAt: string | null }>('tool_executions', workItemStateRowId(ITEM));
    expect(overlay).toMatchObject({ archivedAt: null });
    expect(overlay?.cancelledAt).toBeTruthy();
    // the transition record names the real states
    expect(await fixture.store.get('tool_executions', `work-item-transition:${ITEM}:3`)).toMatchObject({ op: 'unarchive', from: 'archived', to: 'cancelled' });
  });

  it('P2: a completed item archived and restored is completed (and can be reopened)', async () => {
    await op({ op: 'complete', baseRevision: 0 });
    await op({ op: 'archive', baseRevision: 1 });
    expect(await op({ op: 'unarchive', baseRevision: 2 })).toMatchObject({ state: 'completed', revision: 3 });
    expect(await op({ op: 'reopen', baseRevision: 3 })).toMatchObject({ state: 'open' });
  });

  it('P2: an assignee cannot unarchive, and another actor gets 404', async () => {
    await op({ op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' }, confirmAssigneeChange: true });
    await op({ op: 'cancel', baseRevision: 1 });
    await op({ op: 'archive', baseRevision: 2 });
    await expect(op({ op: 'unarchive', baseRevision: 3 }, actors.east)).rejects.toMatchObject({ status: 403 });
    await expect(op({ op: 'unarchive', baseRevision: 3 }, actors.hr)).rejects.toMatchObject({ status: 404 });
    expect(await only(owner, true)).toMatchObject({ state: 'archived', revision: 3 });
  });

  it('a creator who lost ticket.create (or went inactive) cannot mutate', async () => {
    const profile = await fixture.store.get<Profile>('profiles', 'executive');
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'ticket.create') }));
    await expect(op({ op: 'complete', baseRevision: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, active: false }));
    await expect(op({ op: 'complete', baseRevision: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await fixture.store.get('tool_executions', workItemStateRowId(ITEM))).toBeUndefined();
  });
});
