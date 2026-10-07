import { describe, expect, it, vi } from 'vitest';
import type { Actor, PendingAction } from '@/lib/contracts';
import { createActionPorts, type ActionPortsDeps } from '@/lib/router/ports/service-ports';

const actor = { id: 'a', name: 'a', role: 'executive', active: true, regions: [], permissions: [], sessionId: 's', mode: 'live_ai', modeRevision: 1 } as unknown as Actor;
const pa = (over: Partial<PendingAction> = {}) => ({ id: 'P1', actorId: 'a', conversationId: 'c1', status: 'pending', ...over }) as PendingAction;
function deps(over: Partial<ActionPortsDeps> = {}): ActionPortsDeps {
  return {
    reloadActor: vi.fn(async a => a), prepareTool: vi.fn(async () => pa()), confirmPending: vi.fn(async () => ({ id: 'r' } as never)),
    cancelPending: vi.fn(async () => pa()), revisePending: vi.fn(async () => ({} as never)), listPending: vi.fn(async () => []),
    getDashboard: vi.fn(async () => undefined), renameDashboard: vi.fn(async (_a, id, i) => ({ id, title: i.title })),
    deleteDashboard: vi.fn(async (_a, id) => ({ dashboardId: id, deletedAt: 'x' })), recipientAllowed: vi.fn(async () => true),
    staged: { findPending: vi.fn(), create: vi.fn(), get: vi.fn(), save: vi.fn(), claim: vi.fn() }, ...over,
  };
}
describe('createActionPorts', () => {
  it('delegates and passes staged/effects through', async () => {
    const d = deps(); const p = createActionPorts(d);
    await p.confirmPending(actor, 'P1'); await p.renameDashboard(actor, 'D1', { title: 'T' });
    expect(d.confirmPending).toHaveBeenCalledWith(actor, 'P1');
    expect(d.renameDashboard).toHaveBeenCalledWith(actor, 'D1', { title: 'T' });
    expect(p.staged).toBe(d.staged); expect(p.effects).toBeUndefined(); expect(p.branchesAllowed).toBeUndefined();
  });
  it('rejects a prepared action owned by someone else or another conversation', async () => {
    const ref = { conversationId: 'c1', turnId: 't' };
    await expect(createActionPorts(deps({ prepareTool: async () => pa({ actorId: 'z' }) })).prepareTool(actor, 'dashboard.prepare_create', {}, ref)).rejects.toMatchObject({ code: 'PORT_OWNERSHIP' });
    await expect(createActionPorts(deps({ prepareTool: async () => pa({ conversationId: 'c9' }) })).prepareTool(actor, 'dashboard.prepare_create', {}, ref)).rejects.toMatchObject({ code: 'PORT_OWNERSHIP' });
    expect((await createActionPorts(deps()).prepareTool(actor, 'dashboard.prepare_create', {}, ref)).id).toBe('P1');
  });
  it('filters listPending to own, pending, same-conversation actions', async () => {
    const list = [pa(), pa({ id: 'P2', actorId: 'z' }), pa({ id: 'P3', conversationId: 'c2' }), pa({ id: 'P4', status: 'completed' })];
    const p = createActionPorts(deps({ listPending: async () => list }));
    expect((await p.listPending(actor, 'c1')).map(x => x.id)).toEqual(['P1']);
  });
  it('fails closed on a missing dependency and non-true recipient answers', async () => {
    expect(() => createActionPorts({ ...deps(), deleteDashboard: undefined as never })).toThrow(/deleteDashboard/);
    expect(await createActionPorts(deps({ recipientAllowed: async () => 'yes' as never })).recipientAllowed(actor, 'x')).toBe(false);
  });
});
