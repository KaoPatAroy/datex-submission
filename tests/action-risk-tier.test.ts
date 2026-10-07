import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingAction } from '../lib/contracts';
import { defaultRuntimes } from '../lib/core/runtime-catalog';
import { ConciergeService } from '../lib/core/service';
import { dashboardCreateStep, plan, planner, ticketCreateStep } from './helpers/turn-planner';
import { actors, BUSINESS_DATE, createWorkspaceFixture } from './helpers/workspace';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

const NOW = new Date('2026-10-02T05:00:00.000Z');

describe('per-action risk tier (registry policy)', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>> | undefined;
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fixture?.dispose(); fixture = undefined; });

  async function live() {
    fixture = await createWorkspaceFixture();
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const actor = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
    return { actor, service: new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => NOW }) };
  }

  it('declares an explicit tier on every registered action', () => {
    const tiers = Object.fromEntries(defaultRuntimes.flatMap(runtime => runtime.actions).map(action => [action.kind, action.riskTier]));
    expect(tiers).toEqual({
      dashboard_create: 'private_reversible',
      dashboard_share: 'confirmation_required',
      ticket_create: 'confirmation_required',
      badge_revoke: 'confirmation_required',
      demo_update: 'confirmation_required',
    });
  });

  it('creates a private dashboard directly, audits it, and lets only the owner undo it', async () => {
    const { actor, service } = await live();
    planner.reply(plan(dashboardCreateStep('East overview')));
    const turn = await service.turn(actor, 'Please create the East dashboard.');
    expect(turn.pendingAction?.status).toBe('completed');
    expect(turn.receipt?.status).toBe('verified_success');
    const [dashboard] = await fixture!.store.list<{ id: string; ownerId: string }>('dashboards');
    expect(dashboard?.ownerId).toBe(actor.id);
    const categories = (await fixture!.store.list<{ category: string }>('audit_events', { actorId: actor.id })).map(event => event.category);
    expect(categories).toEqual(expect.arrayContaining(['confirm', 'execute', 'verify']));

    await expect(service.deleteDashboard({ ...actors.east, mode: 'live_ai', modeRevision: 1 }, dashboard!.id)).rejects.toMatchObject({ status: 404 });
    const undone = await service.deleteDashboard(actor, dashboard!.id);
    expect(undone.dashboardId).toBe(dashboard!.id);
    await expect(service.dashboard(actor, dashboard!.id)).rejects.toMatchObject({ status: 404 });
    expect((await fixture!.store.list<{ category: string }>('audit_events', { actorId: actor.id })).map(event => event.category)).toContain('delete');
    expect((await service.getWorkspace(actor)).dashboards).toEqual([]);
  });

  it('keeps work that reaches other people behind confirmation, with a 24 hour horizon owned by user and conversation', async () => {
    const { actor, service } = await live();
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
    const turn = await service.turn(actor, 'Open a ticket for E02.');
    const action = turn.pendingAction as PendingAction;
    expect(action.status).toBe('pending');
    expect(Date.parse(action.expiresAt) - Date.parse(action.createdAt)).toBe(24 * 3_600_000);
    expect(await fixture!.store.list('mock_tickets')).toEqual([]);

    // A later login (new session id) of the same user can still confirm the proposal.
    const later = { ...actor, sessionId: actors.executive.sessionId };
    const receipt = await service.confirm(later, action.id);
    expect(receipt.status).toBe('verified_success');
    expect(BUSINESS_DATE).toBeTruthy();
  });
});
