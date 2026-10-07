import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnPlannerInput } from '../../lib/router/planner/input';
import type { Actor, PendingAction } from '../../lib/contracts';
import { turnCompletionId } from '../../lib/core/turn-completion-gate';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import {
  badgeRevokeStep, clarifyStep, dashboardCreateStep, dashboardShareStep, plan, planner, ticketCreateStep,
} from '../helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.reset();
  fixture = await createWorkspaceFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.dispose();
});

// Ported from the deleted live-preparation-policy suite: the authorization/persistence assertions are kept, only the
// way intent is produced changed (a TurnPlan from the planner instead of a model tool loop).
describe('live preparation through TurnPlan action steps', { timeout: 30_000 }, () => {
  it('validates badge and employee ids server-side, supersedes a repeated proposal and never executes', async () => {
    const actor = await live(actors.hr);
    for (const [badgeId, employeeId] of [['C999', 'E024'], ['C104', 'E024'], ['C103', 'E024']] as const) {
      planner.reply(plan(badgeRevokeStep(badgeId, employeeId, 'employment ended')));
      const refused = await fixture.service.turn(actor, `revoke ${badgeId} for ${employeeId} because employment ended`);
      expect(refused.pendingAction).toBeUndefined();
    }
    planner.reply(plan(badgeRevokeStep('C102', 'E024', 'employment ended')));
    const first = await fixture.service.turn(actor, 'revoke C102 for E024 because employment ended');
    expect(first.pendingAction).toMatchObject({ status: 'pending', payload: { kind: 'badge_revoke', badgeId: 'C102', employeeId: 'E024' } });
    const second = await fixture.service.turn(actor, 'revoke C102 for E024 again because employment ended', first.conversationId);
    expect(second.pendingAction?.id).not.toBe(first.pendingAction?.id);
    const stored = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
    expect(stored.filter(action => action.status === 'pending')).toHaveLength(1);
    expect(stored.find(action => action.id === first.pendingAction?.id))
      .toMatchObject({ status: 'stale', staleReason: 'superseded', supersededByActionId: second.pendingAction?.id });
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C102')).toMatchObject({ state: 'active' });
    const cancelled = await fixture.service.cancelPendingAction(actor, second.pendingAction!.id);
    expect(cancelled).toMatchObject({ status: 'stale', staleReason: 'user_cancelled' });
  });

  it('prepares a live ticket from structured branch ids behind confirmation with one preparing status', async () => {
    const actor = await live(actors.executive);
    await fixture.store.transaction(tx => tx.put('employees', { id: 'E031', name: 'Central synthetic employee', branchId: 'C01', active: true }));
    const message = 'Open a ticket for E02 and C01 because both branches are not meeting target.';
    planner.reply(plan(ticketCreateStep(['E02', 'C01'], 'E02 and C01')));
    const statuses: string[] = [];
    const result = await fixture.service.turn(actor, message, undefined, undefined, undefined, { onStatus: status => { statuses.push(status); } });
    expect(result.pendingAction?.payload).toMatchObject({ kind: 'ticket_create', targets: [{ branchId: 'E02' }, { branchId: 'C01' }] });
    expect(result.pendingAction?.status).toBe('pending');
    expect(await fixture.store.list('mock_tickets')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.list<PendingAction>('pending_actions')).toHaveLength(1);
    expect(statuses.filter(status => status === 'preparing')).toHaveLength(1);
  });

  it('rechecks current permission at confirm after a ticket was prepared while authorized', async () => {
    const actor = await live(actors.executive);
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
    const result = await fixture.service.turn(actor, 'Open a ticket for E02.');
    expect(result.pendingAction?.status).toBe('pending');
    const profile = await fixture.store.get<{ id: string; permissions: string[] }>('profiles', actor.id);
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(permission => permission !== 'ticket.create') }));
    await expect(fixture.service.confirm(actor, result.pendingAction!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await fixture.store.list('mock_tickets')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('refuses a ticket action the actor lost permission for before preparing anything', async () => {
    const actor = await live(actors.executive);
    const profile = await fixture.store.get<{ id: string; permissions: string[] }>('profiles', actor.id);
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(permission => permission !== 'ticket.create') }));
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
    const result = await fixture.service.turn(actor, 'Open a ticket for E02.');
    expect(result.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(await fixture.store.list('mock_tickets')).toEqual([]);
  });

  it('prepares a live share for the structured recipient and keeps it behind confirmation', async () => {
    const actor = await live(actors.executive);
    const setup = await fixture.service.prepare(actor, (await import('../helpers/workspace')).dashboardPayload('east'));
    await fixture.service.confirm(actor, setup.id);
    const dashboardId = (await fixture.store.list<{ id: string }>('dashboards'))[0]!.id;
    planner.reply((input: TurnPlannerInput) => {
      const recipient = input.context.recipients.find(item => item.id === 'east');
      return plan(recipient ? dashboardShareStep(dashboardId, recipient.id)
        : clarifyStep({ kind: 'action', actionId: 'dashboard.share' }, 'params.recipientId', 'Which recipient?'));
    });
    const result = await fixture.service.turn(actor, 'Share dashboard with East because HR access is not configured.');
    expect(result.pendingAction?.payload).toMatchObject({ kind: 'dashboard_share', recipientId: 'east' });
    expect(result.pendingAction?.status).toBe('pending');
    expect(await fixture.store.list('dashboard_shares')).toEqual([]);
    expect(await fixture.store.list('mock_messages')).toEqual([]);
  });

  it('creates a private dashboard directly, audited and owner-only, with one preparing status', async () => {
    const actor = await live(actors.executive);
    planner.reply(plan(dashboardCreateStep('East overview')));
    const statuses: string[] = [];
    const result = await fixture.service.turn(actor, 'Create an East dashboard.', undefined, undefined, undefined, { onStatus: status => { statuses.push(status); } });
    expect(result.pendingAction?.payload).toMatchObject({ kind: 'dashboard_create' });
    expect(result.pendingAction?.status).toBe('completed');
    expect(result.receipt?.status).toBe('verified_success');
    const dashboards = await fixture.store.list<{ ownerId: string }>('dashboards');
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]!.ownerId).toBe(actor.id);
    const audit = await fixture.store.list<{ category: string }>('audit_events', { actorId: actor.id });
    expect(audit.map(event => event.category)).toEqual(expect.arrayContaining(['confirm', 'execute', 'verify']));
    expect(statuses.filter(status => status === 'preparing')).toHaveLength(1);
    const completion = await fixture.store.get<{ status?: string }>('tool_executions', turnCompletionId({
      actorId: actor.id, sessionId: actor.sessionId, conversationId: result.conversationId, turnId: result.turnId,
    }));
    expect(completion).toMatchObject({ status: 'completed' });
  });

  it('refuses a dashboard action for a role without that permission and creates nothing', async () => {
    const actor = await live(actors.hr);
    planner.reply(plan(dashboardCreateStep('HR overview')));
    const result = await fixture.service.turn(actor, 'Create a dashboard.');
    expect(result.pendingAction).toBeUndefined();
    expect(result.pendingActions ?? []).toEqual([]);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });
});
