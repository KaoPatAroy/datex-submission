import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, AuditEvent, Dashboard } from '@/lib/contracts';
import { LIVE_AI_DISABLED_TEXT } from '@/lib/core/router-turn';
import { listInbox } from '@/lib/router/ports/effect-store';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { changeMode } from '@/lib/server/session';
import { pgTestsEnabled, revokeRawV2Share, seedRawV2ActiveShare } from '../helpers/local-pg';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

const planner = vi.hoisted(() => ({ next: undefined as undefined | ((input: unknown) => unknown) }));
vi.mock('@/lib/router/planner/provider', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/router/planner/provider')>();
  return { ...original, requestTurnPlan: async (input: unknown, runtime: never) => planner.next ? planner.next(input) : original.requestTurnPlan(input as never, runtime as never) };
});

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 2 as const, requestKey: `req_${Math.random().toString(36).slice(2)}_0123456789`, ...extra });
const RENAME = 'Rename my dashboard to Regional pulse';

/** A real, pack-pinned dashboard created through the product path, then retitled. */
async function seedDashboard(actor: Actor, title: string): Promise<string> {
  await fixture.service.turn(actor, 'Create a sales dashboard');
  const row = (await fixture.store.list<Dashboard>('dashboards')).filter(item => item.ownerId === actor.id).at(-1)!;
  await fixture.store.transaction(tx => tx.put('dashboards', { ...row, spec: { ...row.spec, title } }));
  return row.id;
}
let lastRawShareId = '';
const seedShare = async (dashboardId: string, grant: Record<string, unknown>) => {
  if (pgTestsEnabled && grant.status === 'active') { lastRawShareId = `share_${Math.random().toString(36).slice(2)}`; seedRawV2ActiveShare(lastRawShareId, dashboardId); return; }
  await fixture.store.transaction(tx => tx.put('dashboard_shares', {
  id: `share_${Math.random().toString(36).slice(2)}`, dashboardId, recipientId: 'east', actorId: 'executive', operationKey: 'op', createdAt: '2026-10-01T00:00:00.000Z', ...grant } as never));
};
const titleOf = async (id: string) => (await fixture.store.get<Dashboard>('dashboards', id))!.spec.title;
const stagedOf = (actor: Actor, conversationId: string) => createStagedStore(fixture.store).list(actor, conversationId, { includeExpired: true });

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.next = undefined;
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('fix wave: shared dashboards (F1, F7)', { timeout: 60_000 }, () => {
  it.each([['legacy active:true', { active: true }], ['V2 status:active', { status: 'active' }]])('F1: renaming a dashboard with an active share (%s) is staged for confirmation, never direct', async (_name, grant) => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    await seedShare(id, grant);
    const response = await fixture.service.turn(actor, RENAME);
    expect(await titleOf(id)).toBe('Old name');
    const staged = await stagedOf(actor, response.conversationId);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ actionId: 'dashboard.rename', status: 'pending' });
    expect(response.message).toContain('ยังไม่ได้ดำเนินการ');

    const done = await fixture.service.confirmStagedProposal(actor, staged[0].id);
    expect(done).toMatchObject({ outcome: 'executed' });
    expect(await titleOf(id)).toBe('Regional pulse');
    // Retrying the confirmed proposal returns the stored result (F9) and changes nothing more.
    expect(await fixture.service.confirmStagedProposal(actor, staged[0].id)).toMatchObject({ outcome: 'executed', text: (done as { text: string }).text });
  });

  it('F1: an unshared dashboard is still renamed directly (when the turn completes)', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    const response = await fixture.service.turn(actor, RENAME);
    expect(await titleOf(id)).toBe('Regional pulse');
    expect(await stagedOf(actor, response.conversationId)).toHaveLength(0);
  });

  it('F1: the PATCH write path re-checks sharing inside its own transaction (409 DASHBOARD_SHARED)', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    await seedShare(id, { status: 'active' });
    await expect(fixture.service.renameDashboard(actor, id, { title: 'Hijack' })).rejects.toMatchObject({ code: 'DASHBOARD_SHARED', status: 409 });
    const spec = (await fixture.store.get<Dashboard>('dashboards', id))!.spec;
    await expect(fixture.service.updateDashboardSpec(actor, id, { ...spec, title: 'Hijack' })).rejects.toMatchObject({ code: 'DASHBOARD_SHARED' });
    expect(await titleOf(id)).toBe('Old name');
    // A revoked V2 grant does not count as shared.
    if (pgTestsEnabled) revokeRawV2Share(lastRawShareId);
    else {
      const [grant] = await fixture.store.list<Record<string, unknown> & { id: string }>('dashboard_shares');
      await fixture.store.transaction(tx => tx.put('dashboard_shares', { ...grant, status: 'revoked', active: false } as never));
    }
    await expect(fixture.service.renameDashboard(actor, id, { title: 'Fine' })).resolves.toBeTruthy();
  });

  it('F7: direct writes and staged proposals are bound to the base dashboard revision', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    await expect(fixture.service.renameDashboard(actor, id, { title: 'X' }, { expectedRevision: 'stale-revision' })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED', status: 409 });
    expect(await titleOf(id)).toBe('Old name');

    await seedShare(id, { active: true });
    const response = await fixture.service.turn(actor, RENAME);
    const [proposal] = await stagedOf(actor, response.conversationId);
    // Someone else edits the dashboard between the preview and the confirmation.
    const row = (await fixture.store.get<Dashboard>('dashboards', id))!;
    await fixture.store.transaction(tx => tx.put('dashboards', { ...row, spec: { ...row.spec, title: 'Edited meanwhile' } }));
    expect(await fixture.service.confirmStagedProposal(actor, proposal.id)).toMatchObject({ outcome: 'denied', code: 'dashboard_changed', text: 'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่' });
    expect(await titleOf(id)).toBe('Edited meanwhile');
  });
});

describe('fix wave: turn durability and staged lifecycle (F10, F11, F12)', { timeout: 60_000 }, () => {
  const failFinalPersistence = () => {
    (fixture.service as unknown as { linkAssistant: () => Promise<never> }).linkAssistant = async () => { throw new Error('final persistence failed'); };
  };

  it('F11: a direct private write is not left behind when the turn fails', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    failFinalPersistence();
    await expect(fixture.service.turn(actor, RENAME)).rejects.toThrow();
    expect(await titleOf(id)).toBe('Old name');
  });

  it('F10: staged proposals of a failed turn are staled (never confirmable)', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Mine');
    failFinalPersistence();
    await expect(fixture.service.turn(actor, 'Delete my dashboard')).rejects.toThrow();
    const rows = (await fixture.store.list<{ actorId: string; status: string; id: string }>('router_proposals', { actorId: actor.id }));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('stale');
    expect(await fixture.service.confirmStagedProposal(actor, rows[0].id)).toMatchObject({ outcome: 'denied' });
    expect((await fixture.store.get<Dashboard & { deletedAt?: string }>('dashboards', id))?.deletedAt).toBeUndefined();
  });

  it('F10: confirm requires the completed-turn proof of the creating turn', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Mine');
    const orphan = await createStagedStore(fixture.store).create(actor, { conversationId: 'conv_x', turnId: 'turn_never_completed' },
      { actionId: 'dashboard.delete', digest: 'orphan', preview: 'ลบ', data: { params: { dashboardId: id }, title: 'Mine' }, expiresAt: Date.now() + 3_600_000 });
    expect(await fixture.service.confirmStagedProposal(actor, orphan.id)).toMatchObject({ outcome: 'denied', code: 'turn_not_completed' });
    expect((await fixture.store.get<Dashboard & { deletedAt?: string }>('dashboards', id))?.deletedAt).toBeUndefined();
  });

  it('F10: changing mode stales staged proposals and a proposal from another mode is never confirmable', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Mine');
    const response = await fixture.service.turn(actor, 'Delete my dashboard');
    const [proposal] = await stagedOf(actor, response.conversationId);
    expect(proposal.status).toBe('pending');
    const session = (await fixture.store.get<never>('sessions', actor.sessionId))!;
    await changeMode(fixture.store, session, 'scripted_demo');
    const row = await fixture.store.get<{ status: string }>('router_proposals', proposal.id);
    expect(row?.status).toBe('stale');
    const demo: Actor = { ...actor, mode: 'scripted_demo', modeRevision: 2 };
    expect(await fixture.service.confirmStagedProposal(demo, proposal.id)).toMatchObject({ outcome: 'denied' });
    expect((await fixture.store.get<Dashboard & { deletedAt?: string }>('dashboards', id))?.deletedAt).toBeUndefined();
  });

  it('F12: a clarification choice is consumed exactly once, even for concurrent requests', async () => {
    const actor = await live(actors.east);
    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'clarify', about: { kind: 'query' }, missing: [{ slot: 'region', reason: 'ambiguous' }], question: 'Which region?', choices: [{ id: 'east', label: 'East' }] }] });
    const first = await fixture.service.turn(actor, 'sales please');
    let planned = 0;
    planner.next = () => { planned += 1; return { turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'acknowledgement', prose: 'ok' }] }; };
    const pick = () => fixture.service.turn(actor, 'East', first.conversationId, undefined, identity({ clarification: { choiceId: 'east', clarifiedTurnId: first.turnId } }) as never);
    const results = await Promise.all([pick(), pick()]);
    const texts = results.map(result => result.message);
    expect(texts.filter(text => text.includes('ok'))).toHaveLength(1);
    expect(texts.filter(text => text.includes('ตัวเลือกนี้ถูกใช้ไปแล้ว'))).toHaveLength(1);
    expect(planned).toBe(1);
  });

  it('F12: an invalid pick does not consume the clarification; a failed turn gives it back', async () => {
    const actor = await live(actors.east);
    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'clarify', about: { kind: 'query' }, missing: [{ slot: 'region', reason: 'ambiguous' }], question: 'Which region?', choices: [{ id: 'east', label: 'East' }] }] });
    const first = await fixture.service.turn(actor, 'sales please');
    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'acknowledgement', prose: 'ok' }] });
    const bad = await fixture.service.turn(actor, 'West', first.conversationId, undefined, identity({ clarification: { choiceId: 'west', clarifiedTurnId: first.turnId } }) as never);
    expect(bad.message).toContain('ไม่ตรงกับคำถามล่าสุด');
    failFinal();
    await expect(fixture.service.turn(actor, 'East', first.conversationId, undefined, identity({ clarification: { choiceId: 'east', clarifiedTurnId: first.turnId } }) as never)).rejects.toThrow();
    restoreFinal();
    const ok = await fixture.service.turn(actor, 'East', first.conversationId, undefined, identity({ clarification: { choiceId: 'east', clarifiedTurnId: first.turnId } }) as never);
    expect(ok.message).toContain('ok');
  });

  let original: unknown;
  const failFinal = () => { original = (fixture.service as unknown as { linkAssistant: unknown }).linkAssistant; failFinalPersistence(); };
  const restoreFinal = () => { (fixture.service as unknown as { linkAssistant: unknown }).linkAssistant = original; };
});

describe('fix wave: kill switch, deleted dashboards, audit (F6, F8, F14)', { timeout: 60_000 }, () => {
  it('F6: BIZTANIA_DYNAMIC_QUERY=off blocks the server-owned catalog path too (no plan, no execution)', async () => {
    const actor = await live(actors.east);
    const entries = ((await fixture.service.getWorkspace(actor)).actionCatalog ?? []).filter(entry => !entry.actionKind);
    expect(entries.length).toBeGreaterThan(0);
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'off');
    const response = await fixture.service.turn(actor, entries[0].prompt, undefined, undefined, identity({ catalogEntryId: entries[0].id }) as never);
    expect(response.hint).toBe('switch_to_demo');
    expect(response.message).toBe(LIVE_AI_DISABLED_TEXT);
    expect(response.sources).toBeUndefined();
    expect(response.analysis).toBeUndefined();
  });

  it('F8: a pending share of a dashboard deleted in the meantime does not create a grant', async () => {
    const actor = await live(actors.executive);
    await fixture.service.turn(actor, 'Create a sales dashboard');
    const dashboard = (await fixture.store.list<Dashboard>('dashboards')).find(item => item.ownerId === actor.id)!;
    expect(dashboard).toBeTruthy();
    const shareTurn = await fixture.service.turn(actor, 'Share dashboard with East manager.');
    const share = shareTurn.pendingAction!;
    expect(share.payload.kind).toBe('dashboard_share');
    await fixture.service.deleteDashboard(actor, dashboard.id);
    await fixture.service.confirm(actor, share.id).catch(() => undefined);
    expect((await fixture.store.list<{ dashboardId: string }>('dashboard_shares')).filter(grant => grant.dashboardId === dashboard.id)).toHaveLength(0);
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
  });

  it('F14: audit summaries never contain user-provided titles', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'SECRET-OLD-TITLE');
    await fixture.service.turn(actor, RENAME);
    await fixture.service.deleteDashboard(actor, id);
    const events = (await fixture.store.list<AuditEvent>('audit_events')).filter(event => event.actorId === actor.id);
    expect(events.some(event => event.category === 'delete')).toBe(true);
    for (const event of events) {
      expect(event.summary).not.toContain('SECRET');
      expect(event.summary).not.toContain('Regional pulse');
    }
  });
});

describe('fix wave 2: G2 changeMode vs a claimed proposal, G3 revision CAS, G4 replayed creation', { timeout: 60_000 }, () => {
  it('G2: changing mode stales a CLAIMED proposal too, so the claimant can no longer finish it', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Mine');
    const response = await fixture.service.turn(actor, 'Delete my dashboard');
    const [proposal] = await stagedOf(actor, response.conversationId);
    const staged = createStagedStore(fixture.store, { now: () => proposal.expiresAt - 60_000 });
    const claim = (await staged.claim(actor, proposal.id))!;
    expect(claim.status).toBe('claimed');
    await changeMode(fixture.store, (await fixture.store.get<never>('sessions', actor.sessionId))!, 'scripted_demo');
    expect((await fixture.store.get<{ status: string }>('router_proposals', proposal.id))?.status).toBe('stale');
    await expect(staged.save(actor, proposal.id, { status: 'completed', claimToken: claim.claimToken })).rejects.toBeTruthy();
    expect((await fixture.store.get<Dashboard & { deletedAt?: string }>('dashboards', id))?.deletedAt).toBeUndefined();
  });

  it('G3: the dashboard view carries its revision and a stale base revision is a 409 DASHBOARD_CHANGED', async () => {
    const actor = await live(actors.executive);
    const id = await seedDashboard(actor, 'Old name');
    const loaded = await fixture.service.dashboard(actor, id);
    expect(loaded.revision).toBeTruthy();
    const row = (await fixture.store.get<Dashboard>('dashboards', id))!;
    await fixture.store.transaction(tx => tx.put('dashboards', { ...row, spec: { ...row.spec, title: 'Router edit' } })); // a router edit lands after the page loaded
    await expect(fixture.service.renameDashboard(actor, id, { title: 'Stale overwrite' }, { expectedRevision: loaded.revision })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED', status: 409 });
    expect(await titleOf(id)).toBe('Router edit');
    const fresh = await fixture.service.dashboard(actor, id);
    await expect(fixture.service.renameDashboard(actor, id, { title: 'Fresh rename' }, { expectedRevision: fresh.revision })).resolves.toBeTruthy();
    expect(await titleOf(id)).toBe('Fresh rename');
  });

  it('G4: a crash after the completion record but before the private creation is healed by replaying the same request', async () => {
    const actor = await live(actors.executive);
    const body = identity();
    const service = fixture.service as unknown as { confirm: (...args: unknown[]) => Promise<unknown> };
    const realConfirm = service.confirm;
    service.confirm = async () => { throw new Error('process died before the creation'); };
    const before = (await fixture.store.list<Dashboard>('dashboards')).length;
    await expect(fixture.service.turn(actor, 'Create a sales dashboard', undefined, undefined, body as never)).rejects.toThrow('process died');
    expect((await fixture.store.list<Dashboard>('dashboards')).length).toBe(before);
    service.confirm = realConfirm;
    const replay = await fixture.service.turn(actor, 'Create a sales dashboard', undefined, undefined, body as never);
    expect((await fixture.store.list<Dashboard>('dashboards')).length).toBe(before + 1);
    expect(replay.pendingAction?.status).toBe('completed');
    await fixture.service.turn(actor, 'Create a sales dashboard', undefined, undefined, body as never); // a second replay creates nothing more
    expect((await fixture.store.list<Dashboard>('dashboards')).length).toBe(before + 1);
  });
});

describe('fix wave: multi-step $step0 effects (F16)', { timeout: 60_000 }, () => {
  it('F16: "summarize then send" works in ONE turn: the send is staged over the persisted answer and delivers only after confirm', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Summarize East sales and target for 2026-10-01 and send it to East manager.');
    expect(response.sources?.length).toBeGreaterThan(0);
    const staged = await stagedOf(actor, response.conversationId);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ actionId: 'communication.send', status: 'pending' });
    const params = staged[0].data.params as { contentStateId: string; recipientIds: string[] };
    expect(params.contentStateId).toMatch(/^conversation_state:/); // the persisted state id, never the turn-local `$step0`
    expect(params.recipientIds).toEqual(['east']);
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);

    const done = await fixture.service.confirmStagedProposal(actor, staged[0].id);
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].content).toMatch(/\d/);
  });

  it('F16: "summarize then alert" stages a monitor over the same turn answer', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Summarize East sales and target for 2026-10-01 and alert East manager below 90% of target.');
    const staged = await stagedOf(actor, response.conversationId);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ actionId: 'monitor.create' });
    expect((staged[0].data.params as { queryStateId: string }).queryStateId).toMatch(/^conversation_state:/);
    expect(await fixture.service.confirmStagedProposal(actor, staged[0].id)).toMatchObject({ outcome: 'executed' });
  });
});
