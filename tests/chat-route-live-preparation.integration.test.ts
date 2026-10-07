import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Actor } from '../lib/contracts';
import type { SessionRow } from '../lib/core/auth';
import { actors, BUSINESS_DATE, createWorkspaceFixture } from './helpers/workspace';
import { plan, planner, ticketCreateStep } from './helpers/turn-planner';

const routeAuth = vi.hoisted(() => ({
  getStore: vi.fn(),
  actorSession: vi.fn(),
  checkCsrf: vi.fn(),
  rateLimit: vi.fn(),
  trustedClientIp: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: routeAuth.getStore }));
vi.mock('@/lib/server/session', () => ({
  actorSession: routeAuth.actorSession,
  checkCsrf: routeAuth.checkCsrf,
  rateLimit: routeAuth.rateLimit,
  trustedClientIp: routeAuth.trustedClientIp,
}));
vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

import { POST } from '../app/api/chat/route';

const session: SessionRow = {
  id: actors.executive.sessionId,
  profileId: actors.executive.id,
  mode: 'live_ai',
  modeRevision: 1,
  csrfToken: 'route-preparation-csrf',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function request() {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({ message: 'Open a ticket for E02.' }),
  });
}

describe('chat route through live service, TurnPlan planner, and action executor', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>> | undefined;
  let actor: Actor;

  beforeEach(async () => {
    vi.stubEnv('DEMO_BUSINESS_DATE', BUSINESS_DATE);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
    routeAuth.getStore.mockReset().mockResolvedValue(fixture.store);
    routeAuth.actorSession.mockReset().mockResolvedValue({ actor, session });
    routeAuth.checkCsrf.mockReset().mockReturnValue(undefined);
    routeAuth.rateLimit.mockReset().mockResolvedValue(undefined);
    routeAuth.trustedClientIp.mockReset().mockReturnValue('local-test-client');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture?.dispose();
    fixture = undefined;
  });

  it('runs a planner ticket action through the real HTTP route without executing it', async () => {
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));

    const response = await POST(request());
    const result = await response.json() as {
      pendingAction?: { id: string; status: string; payload: { kind: string; targets: Array<{ branchId: string }> } };
      message: string;
      conversationId: string;
      turnId: string;
    };

    expect(response.status).toBe(200);
    expect(result.pendingAction).toMatchObject({ status: 'pending', payload: { kind: 'ticket_create', targets: [{ branchId: 'E02' }] } });
    expect(result.message).toMatch(/ตรวจตัวอย่าง/u);
    expect(planner.calls).toHaveLength(1);
    // Structured policy: every action the actor is authorized for is offered to the planner, which chooses from the conversation.
    const offered = planner.calls[0]?.context.actions.map(action => action.actionId) ?? [];
    expect(offered).toEqual(expect.arrayContaining(['ticket.create', 'dashboard.create']));
    expect(await fixture!.store.get('pending_actions', result.pendingAction!.id)).toMatchObject({ status: 'pending' });
    const pendingForTurn=(await fixture!.store.list<{id:string;status:string;conversationId:string;turnId:string}>('pending_actions',{actorId:actor.id}))
      .filter(action=>action.status==='pending'&&action.conversationId===result.conversationId&&action.turnId===result.turnId);
    expect(pendingForTurn).toHaveLength(1);
    expect(pendingForTurn[0]?.id).toBe(result.pendingAction!.id);
    expect(await fixture!.store.list('mock_tickets')).toEqual([]);
    expect(await fixture!.store.list('action_executions')).toEqual([]);
  });
});
