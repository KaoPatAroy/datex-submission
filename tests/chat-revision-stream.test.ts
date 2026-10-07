import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getStore: vi.fn(), actorSession: vi.fn(),
  checkCsrf: vi.fn(), rateLimit: vi.fn(), trustedClientIp: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: dependencies.getStore }));
vi.mock('@/lib/server/session', () => ({
  actorSession: dependencies.actorSession, checkCsrf: dependencies.checkCsrf,
  rateLimit: dependencies.rateLimit, trustedClientIp: dependencies.trustedClientIp,
}));
vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

import { NextRequest } from 'next/server';
import type { Actor, PendingAction } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import { canonicalChatStreamResponseSchema, decodeChatStreamFrame, legacyTurnResponseSchema, type ChatStreamEvent } from '@/lib/chat-stream-contracts';
import { POST as streamPOST } from '@/app/api/chat/stream/route';
import { POST as recoveryPOST } from '@/app/api/chat/recovery/route';
import { recoverChatStream, requestChatStream } from '@/components/biztania/stream-client';
import { actors, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { dashboardCreateStep, plan, planner, refineTitleStep } from './helpers/turn-planner';
import type { TurnPlannerInput } from '@/lib/router/planner/input';

const prepareMessage = 'ช่วยเตรียมข้อเสนอสร้าง Dashboard จากข้อมูลล่าสุด';
const reviseMessage = 'แก้ชื่อ Dashboard เป็น ทดสอบชื่อ';
const requestKey = 'chat-dashboard-revision-stream-001';

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost/api/chat/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('chat revision stream and recovery with durable SQLite actions', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
  let actor: Actor;
  let service: ConciergeService;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    fixture = await createWorkspaceFixture();
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
    dependencies.getStore.mockResolvedValue(fixture.store);
    dependencies.actorSession.mockResolvedValue({ actor, session: { id: actor.sessionId } });
    dependencies.trustedClientIp.mockReturnValue('203.0.113.8');
    // Planner: the first (preparation) turn proposes a dashboard; the revision turn revises the one pending candidate.
    planner.reply((input: TurnPlannerInput) => {
      if (input.currentMessage === prepareMessage) return plan(dashboardCreateStep('Revision stream dashboard'));
      const candidates = input.context.pendingActions;
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (!candidate) throw new Error('The pending dashboard revision candidate is missing.');
      return plan(refineTitleStep(candidate.id, 'ทดสอบชื่อ'));
    });
    // A live private dashboard is created directly by default; the review step keeps the draft pending so it can be revised.
    service = new ConciergeService(fixture.store, { reviewPrivateCreations: true });
  });

  afterEach(async () => {
    await fixture.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function prepare() {
    const original = await service.turn(actor, prepareMessage, undefined, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-revision-prepare-001',
    });
    if (!original.pendingAction) throw new Error('The original dashboard proposal is missing.');
    return { original, predecessor: original.pendingAction };
  }

  it('accepts the durable revision response without dropping its revision metadata', async () => {
    const { original, predecessor } = await prepare();
    const revised = await service.turn(actor, reviseMessage, original.conversationId, undefined, {
      contractVersion: 2, requestKey,
    });
    expect(revised.pendingAction).toMatchObject({ predecessorActionId: predecessor.id, status: 'pending' });
    expect(canonicalChatStreamResponseSchema.parse(revised)).toEqual(revised);
  });

  it('completes the revision stream with B, supersedes A, and recovers the same request with B', async () => {
    const { original, predecessor } = await prepare();
    const body = { contractVersion: 2, actionContractVersion: 1, requestKey,
      conversationId: original.conversationId, message: reviseMessage };
    const stream = await streamPOST(request('stream', { ...body, streamVersion: 1 }));
    expect(stream.status).toBe(200);
    const events = (await stream.text()).split('\n\n').filter(frame => frame.trim())
      .map(frame => decodeChatStreamFrame(`${frame}\n\n`));
    const recovery = await recoveryPOST(request('recovery', body));
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed' });
    const terminal = events.at(-1);
    if (terminal?.type !== 'turn.completed') throw new Error('The revision stream did not complete.');
    const completed = legacyTurnResponseSchema.parse(terminal.response);
    const replacement = completed.pendingAction;
    if (!replacement) throw new Error('The streamed replacement is missing.');
    expect(replacement).toMatchObject({
      id: expect.stringMatching(/^action_revision_[a-f0-9]{40}$/),
      // The route's default service creates a live private dashboard directly (risk tier private_reversible).
      status: 'completed', predecessorActionId: predecessor.id,
      payload: { kind: 'dashboard_create', spec: { title: 'ทดสอบชื่อ' } },
      revisionDiff: [expect.stringContaining('ทดสอบชื่อ'), expect.any(String)],
    });
    expect(completed.pendingActions).toEqual([replacement]);
    expect(events.filter(event => event?.type === 'turn.completed')).toHaveLength(1);
    expect(events.some(event => event?.type === 'turn.failed')).toBe(false);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
      status: 'stale', staleReason: 'superseded', supersededByActionId: replacement.id,
    });
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ status: 'completed', response: {
      turnId: terminal.response.turnId, assistantMessageId: terminal.response.assistantMessageId,
      replayed: true, pendingAction: replacement, pendingActions: [replacement],
    } });
    expect(planner.calls).toHaveLength(2);
    // Exactly one dashboard exists: the revised B, owned by the actor. The superseded A never executed.
    expect(await fixture.store.list<{ ownerId: string; spec: { title: string } }>('dashboards'))
      .toMatchObject([{ ownerId: actor.id, spec: { title: 'ทดสอบชื่อ' } }]);
    expect((await fixture.store.list<{ actionId: string }>('action_executions')).map(execution => execution.actionId)).toEqual([replacement.id]);
  });

  it('publishes B through the browser stream client and recovers both B and superseded A', async () => {
    const { original, predecessor } = await prepare();
    const fetchRoute = vi.fn(async (path: string, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (path === '/api/chat/stream') return streamPOST(request('stream', body));
      if (path === '/api/chat/recovery') return recoveryPOST(request('recovery', body));
      throw new Error(`Unexpected browser request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchRoute);
    const events: ChatStreamEvent[] = [];
    const options = { requestKey, message: reviseMessage, conversationId: original.conversationId,
      csrfToken: 'test-csrf-token' };
    const revised = await requestChatStream({ ...options, signal: new AbortController().signal,
      onEvent: event => events.push(event) });
    const replacement = revised.pendingAction;
    if (!replacement) throw new Error('The browser replacement is missing.');
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', response: revised });
    expect(replacement).toMatchObject({ status: 'completed', predecessorActionId: predecessor.id,
      payload: { kind: 'dashboard_create', spec: { title: 'ทดสอบชื่อ' } } });
    expect(await recoverChatStream(options)).toMatchObject({ status: 'completed', response: {
      pendingAction: replacement, pendingActions: [replacement], replayed: true,
    } });
    expect(await recoverChatStream({ ...options, requestKey: 'chat-dashboard-revision-prepare-001',
      message: prepareMessage, conversationId: undefined })).toMatchObject({ status: 'completed', response: {
      pendingAction: { id: predecessor.id, status: 'stale', staleReason: 'superseded',
        supersededByActionId: replacement.id },
    } });
    expect(fetchRoute).toHaveBeenCalledTimes(3);
    expect(planner.calls).toHaveLength(2);
  });
});
