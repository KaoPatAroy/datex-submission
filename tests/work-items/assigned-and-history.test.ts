import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Profile, Receipt, Ticket } from '@/lib/contracts';
import { workItemRowSchema, WORK_ITEM_STATUS, WORK_ITEM_TOOL } from '@/lib/router/ports/work-items';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { applyWorkItemOp, getWorkItemDetail, listManagedWorkItemsPage, workItemStateRowId, type WorkItemLifecycleDeps } from '@/lib/work-items/lifecycle';
import { embedTicketPlan } from '@/lib/core/ticket-plan-text';
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

describe('PC-02 reassignment re-authorizes the stored branch scope (same transaction)', { timeout: 30_000 }, () => {
  it('exposes every executed task transition in workspace History exactly once, including assignee actions', async () => {
    await put(taskRow('history-task', { assigneeId: 'east', branchIds: ['E02'] }));
    await op('history-task', { op: 'complete', baseRevision: 0 }, actors.east);
    await op('history-task', { op: 'complete', baseRevision: 1 }, actors.east);
    const audit = (await fixture.service.getWorkspace(actors.east)).audit.filter(e => e.actionId === 'history-task');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: 'east', category: 'update', createdAt: FIXED_NOW.toISOString() });
    expect(audit[0].summary).toContain('เสร็จ');
    expect((await fixture.service.getWorkspace(owner)).audit.filter(e => e.actionId === 'history-task')).toHaveLength(0);
  });
  it('a South-scoped task cannot be reassigned to an East-only assignee, and nothing is written', async () => {
    await put(taskRow('t-south', { branchIds: ['S01'] }));
    await expect(op('t-south', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' }, confirmAssigneeChange: true })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED', status: 403 });
    expect(await fixture.store.get('tool_executions', workItemStateRowId('t-south'))).toBeUndefined();
    expect((await fixture.store.list('tool_executions', { status: 'work_item_transition' }))).toHaveLength(0);
  });

  it('an East-scoped task can be reassigned to the East manager once confirmed', async () => {
    await put(taskRow('t-east', { branchIds: ['E02'] }));
    expect(await op('t-east', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' }, confirmAssigneeChange: true })).toMatchObject({ mine: false, assigneeId: 'east', revision: 1 });
  });

  it('a creator whose regions shrank since creation can no longer reassign a task in the lost region', async () => {
    await put(taskRow('t-shrink', { branchIds: ['E02'] }));
    const executive = await profile('executive');
    await setProfile({ ...executive, regions: ['central'] });
    await expect(op('t-shrink', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'east' }, confirmAssigneeChange: true })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(await fixture.store.get('tool_executions', workItemStateRowId('t-shrink'))).toBeUndefined();
  });
});

describe('PC-07 assigned work', { timeout: 30_000 }, () => {
  beforeEach(async () => { await put(taskRow('t-assigned', { assigneeId: 'east', branchIds: ['E02'], title: 'Check East stock' })); });
  const assignedPage = (actor: Actor = actors.east) => listManagedWorkItemsPage(fixture.store, actor, { scope: 'assigned' });

  it('lists created vs assigned separately with assignee labels, never to a stranger', async () => {
    expect((await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created' })).items[0]).toMatchObject({ id: 't-assigned', createdByMe: true, mine: false, assigneeId: 'east' });
    expect((await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created' })).items[0]!.assigneeLabel).toContain('East');
    expect((await assignedPage()).items[0]).toMatchObject({ id: 't-assigned', createdByMe: false, mine: true, allowedOps: ['complete'] });
    expect((await assignedPage()).items[0]!.creatorLabel).toBeTruthy();
    expect((await listManagedWorkItemsPage(fixture.store, owner, { scope: 'assigned' })).items).toHaveLength(0);
    expect((await assignedPage(actors.hr)).items).toHaveLength(0);
    await expect(getWorkItemDetail(fixture.store, actors.hr, 't-assigned')).rejects.toMatchObject({ status: 404 });
    expect((await getWorkItemDetail(fixture.store, actors.east, 't-assigned')).item).toMatchObject({ id: 't-assigned', title: 'Check East stock' });
  });

  it('the assignee may complete and reopen (audited) but not edit, cancel or archive; the creator keeps those', async () => {
    expect(await op('t-assigned', { op: 'complete', baseRevision: 0 }, actors.east)).toMatchObject({ state: 'completed', revision: 1, allowedOps: ['reopen'] });
    expect(await op('t-assigned', { op: 'reopen', baseRevision: 1 }, actors.east)).toMatchObject({ state: 'open', revision: 2 });
    for (const forbidden of [{ op: 'edit', baseRevision: 2, fields: { title: 'x' } }, { op: 'cancel', baseRevision: 2 }] as const)
      await expect(op('t-assigned', forbidden, actors.east)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await op('t-assigned', { op: 'complete', baseRevision: 2 }, actors.east);
    await expect(op('t-assigned', { op: 'archive', baseRevision: 3 }, actors.east)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await op('t-assigned', { op: 'archive', baseRevision: 3 })).toMatchObject({ state: 'archived', revision: 4 });
  });

  it('a stranger cannot mutate (404) and an assignee who lost the branch region is refused', async () => {
    await expect(op('t-assigned', { op: 'complete', baseRevision: 0 }, actors.hr)).rejects.toMatchObject({ status: 404 });
    const east = await profile('east');
    await setProfile({ ...east, regions: ['central'] });
    await expect(op('t-assigned', { op: 'complete', baseRevision: 0 }, actors.east)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await assignedPage()).items).toHaveLength(0);
    expect(await fixture.store.get('tool_executions', workItemStateRowId('t-assigned'))).toBeUndefined();
  });

  it('reassigning away removes the old assignee\'s access', async () => {
    await op('t-assigned', { op: 'edit', baseRevision: 0, fields: { assigneeId: 'executive' }, confirmAssigneeChange: true });
    expect((await assignedPage()).items).toHaveLength(0);
    await expect(op('t-assigned', { op: 'complete', baseRevision: 1 }, actors.east)).rejects.toMatchObject({ status: 404 });
  });
});

describe('PC-11 task transitions are small immutable attributable records', { timeout: 30_000 }, () => {
  it('complete -> reopen -> cancel reads back as ordered history with actor, operation, old -> new state, revision and time', async () => {
    await put(taskRow('t-hist', { assigneeId: 'east', branchIds: ['E02'] }));
    await op('t-hist', { op: 'complete', baseRevision: 0 }, actors.east);
    await op('t-hist', { op: 'reopen', baseRevision: 1 }, actors.east);
    await op('t-hist', { op: 'edit', baseRevision: 2, fields: { title: 'Renamed', assigneeId: 'executive' }, confirmAssigneeChange: true });
    await op('t-hist', { op: 'cancel', baseRevision: 3 });
    const { item, history } = await getWorkItemDetail(fixture.store, owner, 't-hist');
    expect(item).toMatchObject({ state: 'cancelled', revision: 4, title: 'Renamed' });
    expect(history.map(h => [h.revision, h.op, h.from, h.to, h.role])).toEqual([
      [1, 'complete', 'open', 'completed', 'assignee'], [2, 'reopen', 'completed', 'open', 'assignee'], [3, 'edit', 'open', 'open', 'creator'], [4, 'cancel', 'open', 'cancelled', 'creator']]);
    expect(history[0]).toMatchObject({ actorLabel: expect.stringContaining('East'), at: FIXED_NOW.toISOString() });
    expect(history[2]).toMatchObject({ changed: ['title', 'assigneeId'], assigneeFrom: expect.stringContaining('East') });
    // A refused or idempotent call writes no transition.
    await expect(op('t-hist', { op: 'complete', baseRevision: 4 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await getWorkItemDetail(fixture.store, owner, 't-hist')).history).toHaveLength(4);
  });
});

describe('PC-03 work item pages: archive filter applies BEFORE the page boundary', { timeout: 60_000 }, () => {
  it('51 items: archiving the newest 50 does not hide the oldest open task; total is exact; cursors reach every item', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => taskRow(`w-${String(i).padStart(2, '0')}`, {}, new Date(FIXED_NOW.getTime() - (50 - i) * 60_000).toISOString()));
    await put(...rows); // w-50 is the newest, w-00 the oldest
    const first = await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created' });
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(51);
    expect(first.nextCursor).not.toBeNull();
    const second = await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created', cursor: first.nextCursor });
    expect(second.items.map(i => i.id)).toEqual(['w-00']);
    expect(second.nextCursor).toBeNull();
    // archive the 50 newest (complete -> archive); the oldest open task must still be on the active page 1
    for (let i = 1; i <= 50; i++) {
      const id = `w-${String(i).padStart(2, '0')}`;
      await op(id, { op: 'complete', baseRevision: 0 });
      await op(id, { op: 'archive', baseRevision: 1 });
    }
    const active = await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created' });
    expect(active.items.map(i => i.id)).toEqual(['w-00']);
    expect(active.total).toBe(1);
    const archived = await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created', archivedOnly: true, limit: 20 });
    expect(archived.total).toBe(50);
    expect(archived.items).toHaveLength(20);
    expect(archived.nextCursor).not.toBeNull();
    expect((await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created', needle: 'task w-07', archivedOnly: true })).items.map(i => i.id)).toEqual(['w-07']);
  });
});

describe('PC-07 legacy ticket.create Tickets (mock_tickets) get list/detail + the same lifecycle, never rewritten', { timeout: 30_000 }, () => {
  const TICKET = 'ticket-legacy-1';
  beforeEach(async () => {
    const ticket: Ticket = { id: TICKET, branchId: 'E02', assigneeId: 'E024', title: 'Check payment terminal', reason: 'Incident INC-E02-PAYMENT', sourceIds: [], status: 'open', operationKey: 'tk-1', createdAt: FIXED_NOW.toISOString(),
      unansweredQuestion: embedTicketPlan('Which evidence is missing?', { priority: 'high', dueDate: '2026-10-05', grouping: 'single', checklist: ['Call the branch'], note: 'ด่วน' }) };
    const receipt: Receipt = { id: 'execution_a1', actionId: 'a1', actorId: 'executive', kind: 'ticket_create', status: 'verified_success', createdAt: FIXED_NOW.toISOString(), verifiedAt: FIXED_NOW.toISOString(),
      results: [{ targetId: 'E02', id: TICKET, status: 'verified_success', detail: 'ok' }] };
    await fixture.store.transaction(async tx => { await tx.put('mock_tickets', ticket); await tx.put('action_executions', receipt); });
  });

  it('lists only the creator\'s verified tickets, with detail and allowed lifecycle; the ticket row is never rewritten', async () => {
    const before = JSON.stringify(await fixture.store.get('mock_tickets', TICKET));
    const page = await listManagedWorkItemsPage(fixture.store, owner, { scope: 'tickets' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: TICKET, kind: 'ticket', title: 'Check payment terminal', priority: 'high', dueDate: '2026-10-05', checklist: ['Call the branch'], detail: 'Incident INC-E02-PAYMENT',
      assigneeLabel: 'Synthetic Employee E024', allowedOps: ['complete', 'edit', 'cancel'] });
    expect((await listManagedWorkItemsPage(fixture.store, actors.east, { scope: 'tickets' })).items).toHaveLength(0);
    await expect(getWorkItemDetail(fixture.store, actors.east, TICKET)).rejects.toMatchObject({ status: 404 });
    await expect(op(TICKET, { op: 'complete', baseRevision: 0 }, actors.east)).rejects.toMatchObject({ status: 404 });
    expect(await op(TICKET, { op: 'complete', baseRevision: 0 })).toMatchObject({ state: 'completed', revision: 1 });
    expect(await op(TICKET, { op: 'reopen', baseRevision: 1 })).toMatchObject({ state: 'open', revision: 2 });
    await expect(op(TICKET, { op: 'edit', baseRevision: 2, fields: { assigneeId: 'east' }, confirmAssigneeChange: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await getWorkItemDetail(fixture.store, owner, TICKET)).history.map(h => h.op)).toEqual(['complete', 'reopen']);
    expect(JSON.stringify(await fixture.store.get('mock_tickets', TICKET))).toBe(before);
    // tasks and tickets never mix in the task lists
    expect((await listManagedWorkItemsPage(fixture.store, owner, { scope: 'created' })).items).toHaveLength(0);
  });
});
