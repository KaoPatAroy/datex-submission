import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, AuditEvent, PendingAction, Store, Table, Transaction } from '../lib/contracts';
import type { ChatStreamStatusCode } from '../lib/chat-stream-contracts';
import { ConciergeService } from '../lib/core/service';
import { turnCompletionId } from '../lib/core/turn-completion-gate';
import { digest, id } from '../lib/core/utils';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { conversationStep, plan, planner, ticketCreateStep } from './helpers/turn-planner';
import type { TurnPlannerInput } from '@/lib/router/planner/input';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

const TICKET_MESSAGE = 'Prepare an East review ticket for E02.';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function requestIdentity(requestKey: string) {
  return { contractVersion: 2 as const, requestKey };
}

function rehashPendingAction(action: PendingAction): PendingAction {
  const { actorId, sessionId, mode, modeRevision, payload, evidenceVersion, packs, expiresAt,
    receiptAccess, releaseRevision, actionContractVersion, approvalScope, approvalDisplay } = action;
  return { ...action, payloadHash: digest({ actorId, sessionId, mode, modeRevision, payload, evidenceVersion,
    packs, expiresAt, receiptAccess, releaseRevision, actionContractVersion, approvalScope, approvalDisplay }) };
}

function nearMissAction(base: PendingAction, patch: Partial<Pick<PendingAction,
  'actorId' | 'sessionId' | 'conversationId' | 'turnId' | 'mode' | 'modeRevision'>>): PendingAction {
  return rehashPendingAction({ ...base, id: id('action'), ...patch });
}

function faultInjectingStore(base: Store, adapter: Store['adapter'] = base.adapter) {
  let nextFailure: unknown;
  let nextFailurePhase: 'before' | 'after' = 'before';
  let watching = false;
  let watchedTransactions = 0;
  const store: Store = {
    adapter,
    list: <T>(table: Table, filters?: Record<string, string | string[]>) => base.list<T>(table, filters),
    get: <T>(table: Table, key: string) => base.get<T>(table, key),
    transaction<T>(work: (tx: Transaction) => Promise<T>) {
      if (watching) watchedTransactions += 1;
      if (nextFailure !== undefined) {
        const failure = nextFailure;
        const phase = nextFailurePhase;
        nextFailure = undefined;
        nextFailurePhase = 'before';
        if (phase === 'before') throw failure;
        return base.transaction(work).then(() => { throw failure; });
      }
      return base.transaction(work);
    },
    close: () => base.close?.(),
  };
  return {
    store,
    arm(failure: unknown) { nextFailure = failure; nextFailurePhase = 'before'; watching = true; },
    armAfterCommit(failure: unknown) { nextFailure = failure; nextFailurePhase = 'after'; watching = true; },
    watchedTransactions: () => watchedTransactions,
  };
}

describe('failed-turn pending-action and history integrity', () => {
  let fixture: Fixture;

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

  async function liveActor(): Promise<Actor> {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
  }

  function service(store: Store = fixture.store): ConciergeService {
    return new ConciergeService(store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
  }

  /** The planner prepares a confirm-tier ticket for E02 (the executor stages the pending action before the turn is saved). */
  function plannerPreparesTicket() {
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
  }

  /**
   * Fires once, when the turn reaches its `saving` status: the pending action has been prepared but the final response
   * transaction has not run. This is the structured equivalent of "the provider failed after preparation".
   */
  function afterPrepared(hook: (action: PendingAction) => void | Promise<void>, exclude: readonly string[] = []) {
    const prepared = deferred<PendingAction>();
    const onStatus = async (code: ChatStreamStatusCode) => {
      if (code !== 'saving') return;
      const actions = (await fixture.store.list<PendingAction>('pending_actions', { actorId: actors.executive.id }))
        .filter(item => item.status === 'pending' && !exclude.includes(item.id));
      const action = actions.at(-1);
      if (!action) throw new Error('The turn did not prepare an action before saving.');
      prepared.resolve(action);
      await hook(action);
    };
    return { prepared, onStatus };
  }

  async function ticketPayload(serviceUnderTest: ConciergeService, actor: Actor, title: string) {
    const evidence = await serviceUnderTest.queryEvidence(actor, { region: 'east', date: BUSINESS_DATE, branchIds: ['E02'] });
    const branch = evidence.branches.find(item => item.branchId === 'E02');
    if (!branch) throw new Error('The synthetic East branch is missing.');
    return {
      kind: 'ticket_create' as const,
      scope: evidence.scope,
      targets: [{
        branchId: branch.branchId,
        assigneeId: 'E024',
        title,
        reason: 'Synthetic evidence does not establish a cause.',
        sourceIds: [...branch.sourceIds],
        unansweredQuestion: 'Check demand and conversion over the relevant period.',
      }],
    };
  }

  async function recovery(serviceUnderTest: ConciergeService, actor: Actor, requestKey: string, message: string, conversationId?: string) {
    return serviceUnderTest.recoverTurn(actor, {
      contractVersion: 2,
      actionContractVersion: 1,
      requestKey,
      message,
      ...(conversationId ? { conversationId } : {}),
    });
  }

  async function turnRows(store: Store, actor: Actor, requestKey: string) {
    const requestId = 'turnrequest_' + digest({ actorId: actor.id, sessionId: actor.sessionId, key: requestKey });
    const request = await store.get<Record<string, unknown> & { conversationId: string; turnId: string }>('tool_executions', requestId);
    if (!request) throw new Error('The keyed request ledger is missing.');
    const completionId = turnCompletionId({
      actorId: actor.id,
      sessionId: actor.sessionId,
      conversationId: request.conversationId,
      turnId: request.turnId,
    });
    return { request: await store.get<Record<string, unknown>>('tool_executions', requestId),
      completion: await store.get<Record<string, unknown>>('tool_executions', completionId) };
  }

  it('closes a pre-prepare failure, proves it by readback, and never reruns the planner on replay', async () => {
    const actor = await liveActor();
    const requestKey = 'failed-before-prepare-request-key-01';
    const message = 'Read a summary that will fail before preparation.';
    planner.fail(new Error('Synthetic provider failure before preparation.'));
    const serviceUnderTest = service();

    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey)))
      .rejects.toThrow('Synthetic provider failure before preparation.');

    const rows = await turnRows(fixture.store, actor, requestKey);
    expect(rows.request).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
    expect(rows.completion).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
    expect(await fixture.store.list('pending_actions', { actorId: actor.id })).toEqual([]);
    expect(await recovery(serviceUnderTest, actor, requestKey, message)).toMatchObject({ status: 'failed' });
    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey)))
      .rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
    expect(planner.calls).toHaveLength(1);
  });

  it('stales only actions from the exact failed tuple and preserves one-field tuple near-misses', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const predecessor = await serviceUnderTest.prepare(actor, await ticketPayload(serviceUnderTest, actor, 'Earlier pending action'));
    const completed = await serviceUnderTest.prepare(actor, await ticketPayload(serviceUnderTest, actor, 'Earlier completed action'));
    await serviceUnderTest.confirm(actor, completed.id);

    const alternateSessionId = id('session');
    await fixture.store.transaction(tx => tx.put('sessions', {
      id: alternateSessionId, profileId: actor.id, mode: actor.mode, modeRevision: actor.modeRevision,
      csrfToken: 'synthetic-alternate-session-csrf', expiresAt: '2099-01-01T00:00:00.000Z',
    }));

    plannerPreparesTicket();
    let nearMisses: PendingAction[] = [];
    const hooks = afterPrepared(async failedAction => {
      nearMisses = [
        nearMissAction(failedAction, { actorId: actors.east.id }),
        nearMissAction(failedAction, { sessionId: alternateSessionId }),
        nearMissAction(failedAction, { conversationId: predecessor.conversationId }),
        nearMissAction(failedAction, { turnId: id('turn') }),
        nearMissAction(failedAction, { mode: 'scripted_demo' }),
        nearMissAction(failedAction, { modeRevision: actor.modeRevision + 1 }),
      ];
      await fixture.store.transaction(async tx => {
        for (const nearMiss of nearMisses) await tx.put('pending_actions', nearMiss);
      });
      throw new Error('Synthetic failure after preparation.');
    }, [predecessor.id, completed.id]);
    const requestKey = 'failed-after-prepare-request-key-02';
    const message = TICKET_MESSAGE;
    const failingService = service();
    await expect(failingService.turn(actor, message, undefined, undefined, requestIdentity(requestKey), { onStatus: hooks.onStatus }))
      .rejects.toThrow('Synthetic failure after preparation.');
    const failedAction = await hooks.prepared.promise;
    expect(failedAction.id).not.toBe(predecessor.id);

    const stale = await fixture.store.get<PendingAction>('pending_actions', failedAction.id);
    expect(stale).toMatchObject({ status: 'stale', staleReason: 'source_turn_failed', payloadHash: failedAction.payloadHash });
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
      status: 'pending', payloadHash: predecessor.payloadHash,
    });
    expect(await fixture.store.get<PendingAction>('pending_actions', completed.id)).toMatchObject({
      status: 'completed', payloadHash: completed.payloadHash,
    });
    expect(nearMisses).toHaveLength(6);
    for (const nearMiss of nearMisses) {
      expect(await fixture.store.get<PendingAction>('pending_actions', nearMiss.id)).toMatchObject({
        status: 'pending', payloadHash: nearMiss.payloadHash,
      });
    }
    const cleanupEvents = (await fixture.store.list<AuditEvent>('audit_events', { actorId: actor.id }))
      .filter(event => event.category === 'turn_action_cleanup');
    expect(cleanupEvents).toEqual([expect.objectContaining({
      actionId: failedAction.id,
      summary: 'turn_failed',
    })]);
    expect(await recovery(failingService, actor, requestKey, message)).toMatchObject({ status: 'failed' });
    await expect(failingService.confirm(actor, failedAction.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
    expect(await fixture.store.get('action_executions', 'execution_' + failedAction.id)).toBeUndefined();
    await expect(failingService.turn(actor, message, undefined, undefined, requestIdentity(requestKey)))
      .rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
    expect(planner.calls).toHaveLength(1);
  });

  it('records cancellation separately and stales the action prepared by that cancelled turn', async () => {
    const actor = await liveActor();
    const controller = new AbortController();
    plannerPreparesTicket();
    const hooks = afterPrepared(() => { controller.abort(new DOMException('Synthetic caller cancellation.', 'AbortError')); });
    const serviceUnderTest = service();
    const requestKey = 'cancelled-after-prepare-request-key-03';
    const message = TICKET_MESSAGE;
    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey), {
      signal: controller.signal, onStatus: hooks.onStatus,
    })).rejects.toThrow('Synthetic caller cancellation.');
    const action = await hooks.prepared.promise;

    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({ status: 'stale', staleReason: 'source_turn_cancelled' });
    expect(await turnRows(fixture.store, actor, requestKey)).toMatchObject({
      request: { status: 'failed', failureReason: 'turn_cancelled' },
      completion: { status: 'failed', failureReason: 'turn_cancelled' },
    });
    const events = await fixture.store.list<AuditEvent>('audit_events', { actorId: actor.id });
    expect(events).toContainEqual(expect.objectContaining({
      category: 'turn_action_cleanup', actionId: action.id, summary: 'turn_cancelled',
    }));
    expect(await recovery(serviceUnderTest, actor, requestKey, message)).toMatchObject({ status: 'failed' });
  });

  it('does not claim a failed close when the cleanup transaction outcome is uncertain', async () => {
    const actor = await liveActor();
    const fault = faultInjectingStore(fixture.store, 'supabase');
    plannerPreparesTicket();
    const hooks = afterPrepared(() => {
      fault.arm(Object.assign(new Error('Synthetic commit outcome is unknown.'), {
        code: 'STORAGE', definitelyNotCommitted: false,
      }));
      throw new Error('Synthetic failure after preparation.');
    });
    const serviceUnderTest = service(fault.store);
    const requestKey = 'unknown-failure-close-request-key-04';
    const message = TICKET_MESSAGE;

    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey), { onStatus: hooks.onStatus }))
      .rejects.toThrow('Synthetic commit outcome is unknown.');
    const action = await hooks.prepared.promise;
    expect(fault.watchedTransactions()).toBe(1);
    const rows = await turnRows(fixture.store, actor, requestKey);
    expect(rows.request).toMatchObject({ status: 'started' });
    expect(rows.request).not.toHaveProperty('failureReason');
    expect(rows.completion).toMatchObject({ status: 'started' });
    expect(rows.completion).not.toHaveProperty('failureReason');
    expect(await recovery(serviceUnderTest, actor, requestKey, message)).toMatchObject({ status: 'in_progress' });
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({ status: 'pending' });
    await expect(serviceUnderTest.confirm(actor, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
  });

  it('reads back a committed failed close after its response is lost and never resends preparation', async () => {
    const actor = await liveActor();
    const fault = faultInjectingStore(fixture.store, 'supabase');
    const commitResponseLost = Object.assign(new Error('Synthetic cleanup commit response was lost.'), {
      code: 'STORAGE', definitelyNotCommitted: false,
    });
    plannerPreparesTicket();
    const hooks = afterPrepared(() => {
      fault.armAfterCommit(commitResponseLost);
      throw new Error('Synthetic failure after preparation.');
    });
    const serviceUnderTest = service(fault.store);
    const requestKey = 'post-commit-failed-close-request-key-09';
    const message = TICKET_MESSAGE;

    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey), { onStatus: hooks.onStatus }))
      .rejects.toBe(commitResponseLost);
    const action = await hooks.prepared.promise;
    expect(fault.watchedTransactions()).toBe(1);

    const rows = await turnRows(fixture.store, actor, requestKey);
    expect(rows.request).toMatchObject({
      actorId: actor.id, sessionId: actor.sessionId, conversationId: action.conversationId, turnId: action.turnId,
      mode: actor.mode, modeRevision: actor.modeRevision, status: 'failed', failureReason: 'turn_failed',
    });
    expect(rows.completion).toMatchObject({
      actorId: actor.id, sessionId: actor.sessionId, conversationId: action.conversationId, turnId: action.turnId,
      mode: actor.mode, modeRevision: actor.modeRevision, requestLedgerId: rows.request?.id,
      status: 'failed', failureReason: 'turn_failed',
    });
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({
      id: action.id, actorId: action.actorId, sessionId: action.sessionId,
      conversationId: action.conversationId, turnId: action.turnId, mode: action.mode,
      modeRevision: action.modeRevision, status: 'stale', payloadHash: action.payloadHash,
    });
    const cleanupEvents = (await fixture.store.list<AuditEvent>('audit_events', { actorId: actor.id }))
      .filter(event => event.category === 'turn_action_cleanup');
    expect(cleanupEvents).toEqual([expect.objectContaining({ actionId: action.id, summary: 'turn_failed' })]);
    expect(await recovery(serviceUnderTest, actor, requestKey, message)).toMatchObject({ status: 'failed' });
    await expect(serviceUnderTest.confirm(actor, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
    expect(await fixture.store.get('action_executions', 'execution_' + action.id)).toBeUndefined();
    expect(await fixture.store.list('mock_tickets')).toEqual([]);

    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey)))
      .rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
    expect(await fixture.store.list('pending_actions', { actorId: actor.id })).toHaveLength(1);
    expect(planner.calls).toHaveLength(1);
  });

  it('retries one known-no-commit close conflict but does not rerun the planner', async () => {
    const actor = await liveActor();
    const fault = faultInjectingStore(fixture.store, 'supabase');
    plannerPreparesTicket();
    const hooks = afterPrepared(() => {
      fault.arm(Object.assign(new Error('Synthetic expected-revision conflict.'), {
        code: 'CONFLICT', definitelyNotCommitted: true,
      }));
      throw new Error('Synthetic failure after preparation.');
    });
    const serviceUnderTest = service(fault.store);
    const requestKey = 'conflicted-failure-close-request-key-05';
    const message = TICKET_MESSAGE;

    await expect(serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey), { onStatus: hooks.onStatus }))
      .rejects.toThrow('Synthetic failure after preparation.');
    const action = await hooks.prepared.promise;
    expect(fault.watchedTransactions()).toBe(2);
    expect(planner.calls).toHaveLength(1);
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({ status: 'stale' });
    expect(await recovery(serviceUnderTest, actor, requestKey, message)).toMatchObject({ status: 'failed' });
  });

  it.each([
    { label: 'consumer callback failure', cancelled: false },
    { label: 'consumer cancellation', cancelled: true },
  ])('preserves a completed turn and its action after final onTextDelta $label', async ({ cancelled }) => {
    const actor = await liveActor();
    const controller = new AbortController();
    const deltaFailure = new Error('Synthetic consumer delta failure after completion.');
    const deltaCancellation = new DOMException('Synthetic consumer cancellation after completion.', 'AbortError');
    let deltaText: string | undefined;
    let stateAtDelta: {
      request?: Record<string, unknown>;
      completion?: Record<string, unknown>;
      action?: PendingAction;
    } | undefined;
    plannerPreparesTicket();
    const serviceUnderTest = service();
    const requestKey = cancelled
      ? 'completed-stream-cancel-request-key-11'
      : 'completed-stream-fail-request-key-10';
    const message = TICKET_MESSAGE;
    const turnPromise = serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey), {
      signal: controller.signal,
      onTextDelta: async text => {
        deltaText = text;
        const [action] = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
        const rows = await turnRows(fixture.store, actor, requestKey);
        stateAtDelta = {
          request: rows.request,
          completion: rows.completion,
          action: action ? await fixture.store.get<PendingAction>('pending_actions', action.id) : undefined,
        };
        if (cancelled) {
          controller.abort(deltaCancellation);
          throw deltaCancellation;
        }
        throw deltaFailure;
      },
    });

    await expect(turnPromise).rejects.toBe(cancelled ? deltaCancellation : deltaFailure);
    const [action] = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
    expect(action).toBeDefined();
    expect(deltaText).toBeDefined();
    expect(stateAtDelta?.request).toMatchObject({ status: 'completed' });
    expect(stateAtDelta?.request).not.toHaveProperty('failureReason');
    expect(stateAtDelta?.completion).toMatchObject({
      status: 'completed', assistantMessageId: expect.any(String), finalActionIds: [action!.id],
    });
    expect(stateAtDelta?.completion).not.toHaveProperty('failureReason');
    expect(stateAtDelta?.action).toMatchObject({ id: action!.id, status: 'pending', payloadHash: action!.payloadHash });

    const rows = await turnRows(fixture.store, actor, requestKey);
    const assistantId = (rows.completion as Record<string, unknown> & { assistantMessageId: string }).assistantMessageId;
    const assistant = await fixture.store.get<Record<string, unknown> & { id: string; text: string; pendingActionId?: string; pendingActionIds?: string[] }>(
      'conversation_messages', assistantId,
    );
    expect(rows.request).toMatchObject({ status: 'completed' });
    expect(rows.request).not.toHaveProperty('failureReason');
    expect(rows.completion).toMatchObject({ status: 'completed', finalActionIds: [action!.id] });
    expect(rows.completion).not.toHaveProperty('failureReason');
    expect(assistant).toMatchObject({ id: assistantId, pendingActionId: action!.id, pendingActionIds: [action!.id] });
    expect(await fixture.store.get<PendingAction>('pending_actions', action!.id)).toMatchObject({
      status: 'pending', payloadHash: action!.payloadHash,
    });

    const recovered = await recovery(serviceUnderTest, actor, requestKey, message);
    expect(recovered).toMatchObject({ status: 'completed', response: {
      assistantMessageId: assistantId, message: assistant?.text, replayed: true,
      pendingAction: { id: action!.id }, pendingActions: [{ id: action!.id }],
    } });
    const replay = await serviceUnderTest.turn(actor, message, undefined, undefined, requestIdentity(requestKey));
    expect(replay).toMatchObject({
      assistantMessageId: assistantId, message: assistant?.text, replayed: true,
      pendingAction: { id: action!.id }, pendingActions: [{ id: action!.id }],
    });
    const assistantRows = (await fixture.store.list<Record<string, unknown> & { conversationId?: string; turnId?: string; role?: string }>('conversation_messages'))
      .filter(row => row.conversationId === rows.request?.conversationId && row.turnId === rows.request?.turnId && row.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(await fixture.store.list('pending_actions', { actorId: actor.id })).toHaveLength(1);
    expect(await fixture.store.get('action_executions', 'execution_' + action!.id)).toBeUndefined();
    expect(await fixture.store.list('mock_tickets')).toEqual([]);
    expect(planner.calls).toHaveLength(1);
  });

  it('uses only verified completed user/assistant pairs in future planner history', async () => {
    const actor = await liveActor();
    const firstMessage = 'Completed question to retain in history.';
    const failedMessage = 'Failed user text that must stay out of planner history.';
    const nextMessage = 'Next question after the failure.';
    const serviceUnderTest = service();
    planner.reply((input: TurnPlannerInput) => {
      if (input.currentMessage === failedMessage) throw new Error('Synthetic middle-turn failure.');
      return plan(conversationStep('acknowledgement', 'รับทราบครับ'));
    });
    const first = await serviceUnderTest.turn(actor, firstMessage, undefined, undefined, requestIdentity('history-complete-request-key-06'));
    await expect(serviceUnderTest.turn(actor, failedMessage, first.conversationId, undefined,
      requestIdentity('history-failed-request-key-07'))).rejects.toThrow('Synthetic middle-turn failure.');

    const visible = await serviceUnderTest.getWorkspace(actor);
    expect(visible.messages.some(item => item.role === 'user' && item.text === failedMessage)).toBe(true);
    const next = await serviceUnderTest.turn(actor, nextMessage, first.conversationId, undefined,
      requestIdentity('history-next-request-key-08'));

    const nextInput = planner.calls.find(call => call.currentMessage === nextMessage);
    expect(nextInput?.context.conversation).toEqual([
      { role: 'user', text: firstMessage },
      { role: 'assistant', text: first.message },
    ]);
    expect(nextInput?.context.conversation).not.toContainEqual({ role: 'user', text: failedMessage });
    expect(next.turnId).not.toBe(first.turnId);
    expect(planner.calls).toHaveLength(3);
  });
});
