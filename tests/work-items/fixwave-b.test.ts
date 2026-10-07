import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { workItemRowSchema, WORK_ITEM_STATUS, WORK_ITEM_TOOL } from '@/lib/router/ports/work-items';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { applyWorkItemOp, getWorkItemDetail, listManagedWorkItemsPage, workItemStateRowId, type WorkItemLifecycleDeps } from '@/lib/work-items/lifecycle';
import { actors, createWorkspaceFixture, FIXED_NOW } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const deps = (): WorkItemLifecycleDeps => ({ store: fixture.store, now: () => new Date(FIXED_NOW), recipientAllowed: createRecipientPolicy(fixture.store) });
const owner: Actor = actors.executive;

const taskRow = (id: string, over: Partial<Record<string, unknown>> = {}, createdAt = FIXED_NOW.toISOString()) => workItemRowSchema.parse({ id, name: WORK_ITEM_TOOL, status: WORK_ITEM_STATUS,
  actorId: 'executive', assigneeId: 'executive', proposalId: 'p', operationKey: `k-${id}`, title: `Task ${id}`, priority: 'normal', dueDate: null, grouping: 'single', checklist: [], branchIds: [],
  note: null, state: 'open', createdAt, digest: 'd', ...over });
const put = (...rows: { id: string }[]) => fixture.store.transaction(async tx => { for (const row of rows) await tx.put('tool_executions', row); });
const profile = async (id: string) => (await fixture.store.get<Profile>('profiles', id))!;
const setProfile = (next: Profile) => fixture.store.transaction(tx => tx.put('profiles', next));
const op = (id: string, input: Parameters<typeof applyWorkItemOp>[3], actor: Actor = owner) => applyWorkItemOp(deps(), actor, id, input);

beforeEach(async () => {
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(tx => tx.put('branches', { id: 'S01', name: 'South One', region: 'south' }));
});
afterEach(async () => { await fixture.dispose(); });


describe('FW-B: assignee permission recheck, unknown branch, reassignment confirmation, history window', { timeout: 60_000 }, () => {
  const assignedPage = (actor: Actor = actors.east) => listManagedWorkItemsPage(fixture.store, actor, { scope: 'assigned' });

  it('an assignee who lost sales.read (region kept) no longer lists, reads or mutates the item', async () => {
    await put(taskRow('t-perm', { assigneeId: 'east', branchIds: ['E02'] }));
    expect((await assignedPage()).items).toHaveLength(1);
    const east = await profile('east');
    await setProfile({ ...east, permissions: east.permissions.filter(p => p !== 'sales.read') });
    expect((await assignedPage()).items).toHaveLength(0);
    await expect(getWorkItemDetail(fixture.store, actors.east, 't-perm')).rejects.toMatchObject({ status: 404 });
    await expect(op('t-perm', { op: 'complete', baseRevision: 0 }, actors.east)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await fixture.store.get('tool_executions', workItemStateRowId('t-perm'))).toBeUndefined();
  });

  it('a task whose branch cannot be resolved fails closed for its assignee (list, detail and mutation)', async () => {
    await put(taskRow('t-ghost', { assigneeId: 'east', branchIds: ['ZZ99'] }));
    expect((await assignedPage()).items).toHaveLength(0);
    await expect(getWorkItemDetail(fixture.store, actors.east, 't-ghost')).rejects.toMatchObject({ status: 404 });
    await expect(op('t-ghost', { op: 'complete', baseRevision: 0 }, actors.east)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('reassigning to the creator needs the same explicit confirmation as any other assignee change', async () => {
    await put(taskRow('t-back', { assigneeId: 'east', branchIds: ['E02'] }));
    await expect(op('t-back', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'executive' } })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 409 });
    expect(await fixture.store.get('tool_executions', workItemStateRowId('t-back'))).toBeUndefined();
    expect(await op('t-back', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'executive' }, confirmAssigneeChange: true })).toMatchObject({ mine: true, revision: 1 });
  });

  it('detail history is the LATEST window with a truncation marker once revisions exceed the window', async () => {
    await put(taskRow('t-long', { assigneeId: 'east', branchIds: ['E02'] }));
    for (let revision = 0; revision < 104; revision += 2) {
      await op('t-long', { op: 'complete', baseRevision: revision }, actors.east);
      await op('t-long', { op: 'reopen', baseRevision: revision + 1 }, actors.east);
    }
    const detail = await getWorkItemDetail(fixture.store, owner, 't-long');
    expect(detail.item.revision).toBe(104);
    expect(detail.history).toHaveLength(100);
    expect(detail.history[0]!.revision).toBe(5);
    expect(detail.history.at(-1)!.revision).toBe(104);
    expect(detail).toMatchObject({ historyTruncated: true, historyFromRevision: 5 });
    await put(taskRow('t-short', { branchIds: [] }));
    expect(await getWorkItemDetail(fixture.store, owner, 't-short')).toMatchObject({ historyTruncated: false, historyFromRevision: 1 });
  });
});
