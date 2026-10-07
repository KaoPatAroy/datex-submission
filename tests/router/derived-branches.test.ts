import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ActionPayload, Ticket } from '@/lib/contracts';
import { canonicalizeModelPlan } from '@/lib/router/planner/canonicalize';
import { actionRegistry } from '@/lib/router/action-registry';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { contextFor } from './fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => { await tx.put('employees', { id: 'EMP-C01', name: 'Central Staff', branchId: 'C01', active: true }); });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });
async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}

describe('S2: Tickets for a derived branch set (branches below target)', { timeout: 60_000 }, () => {
  it('two-step plan: the server expands $step0 to the exact below-target branch ids from evidence, stages them and confirms', async () => {
    const executive = await live(actors.executive);
    const turn = await fixture.service.turn(executive, 'Open a high priority ticket for all branches with sales below target on 2026-10-01.');
    expect(turn.message, turn.message).not.toBe('');
    expect(turn.clarification, turn.message).toBeUndefined();
    const pending = turn.pendingAction!;
    const payload = pending.payload as Extract<ActionPayload, { kind: 'ticket_create' }>;
    expect(payload.plan).toMatchObject({ priority: 'high' });
    expect(payload.targets.map(t => t.branchId).sort()).toEqual(['C01', 'E02']);
    expect(await fixture.store.list<Ticket>('mock_tickets')).toHaveLength(0);
    expect((await fixture.service.confirm(executive, pending.id)).status).toBe('verified_success');
    expect((await fixture.store.list<Ticket>('mock_tickets')).map(t => t.branchId).sort()).toEqual(['C01', 'E02']);
  });

  it('a branch outside the actor scope is never in the derived set (east manager only sees East)', async () => {
    const east = await live(actors.east);
    const turn = await fixture.service.turn(east, 'Open a high priority ticket for all branches with sales below target on 2026-10-01.');
    expect(turn.clarification, turn.message).toBeUndefined();
    const payload = turn.pendingAction!.payload as Extract<ActionPayload, { kind: 'ticket_create' }>;
    expect(payload.targets.map(t => t.branchId)).toEqual(['E02']);
  });

  it('tolerates the model putting the answer reference into branchIds, quoting it or camel-casing the rule', () => {
    const context = contextFor('executive');
    const raw = { turnPlanVersion: 1, steps: [{ kind: 'query', continuation: false, plan: {} }, { kind: 'action', actionId: 'ticket.create', params: {
      branchIds: { value: '$step0', source: 'user_quoted', evidenceText: 'below target' }, branchesRule: { value: 'belowTarget', source: 'user_quoted', evidenceText: 'x' } } }] };
    const out = canonicalizeModelPlan(raw, { context, registry: actionRegistry }) as { steps: { params?: Record<string, { value: unknown; source: string }> }[] };
    expect(out.steps[1]!.params).toMatchObject({ branchesFrom: { value: '$step0', source: 'context_id' }, branchesRule: { value: 'below_target', source: 'generated' } });
    expect(out.steps[1]!.params!.branchIds).toBeUndefined();
  });
});
