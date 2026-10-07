import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, ConversationMessage, Store, Table, Transaction } from '../lib/contracts';
import { ConciergeService, type TurnStarted } from '../lib/core/service';
import { turnCompletionId } from '../lib/core/turn-completion-gate';
import { digest } from '../lib/core/utils';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { conversationStep, plan, planner } from './helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

const STALE_WINDOW_MS = 5 * 60_000;
const identity = { contractVersion: 2 as const, requestKey: 'stale-turn-recovery-request-key-01' };
const message = 'Read a summary without preparing any work.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('stale started turn recovery', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

  async function heldTurn(store: Store = fixture.store) {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const actor = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
    let timestamp = FIXED_NOW.getTime();
    const entered = deferred<void>();
    const release = deferred<void>();
    const started = deferred<TurnStarted>();
    const runPlanner = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return plan(conversationStep('advice', 'Provider-only prose.'));
    });
    planner.reply(runPlanner);
    const service = new ConciergeService(store, {
      businessDate: BUSINESS_DATE, now: () => new Date(timestamp),
    });
    const outcome = service.turn(actor, message, undefined, undefined, identity, {
      onStarted: event => { started.resolve(event); },
    }).then(response => ({ response }), error => ({ error }));
    const event = await started.promise;
    await entered.promise;
    const requestId = 'turnrequest_' + digest({ actorId: actor.id, sessionId: actor.sessionId, key: identity.requestKey });
    const completionId = turnCompletionId({ actorId: actor.id, sessionId: actor.sessionId, ...event });
    const recover = () => service.recoverTurn(actor, { ...identity, actionContractVersion: 1, message });
    return {
      actor, service, event, runPlanner, requestId, completionId, recover,
      age(ms: number) { timestamp = FIXED_NOW.getTime() + ms; },
      async finish() { release.resolve(); return outcome; },
    };
  }

  it.each([STALE_WINDOW_MS - 1, STALE_WINDOW_MS])('keeps a started request aged %i ms in progress without writes', async age => {
    const turn = await heldTurn();
    try {
      turn.age(age);
      const audits = await fixture.store.list('audit_events');
      expect(await turn.recover()).toEqual({ status: 'in_progress', conversationId: turn.event.conversationId, turnId: turn.event.turnId });
      expect(await fixture.store.get('tool_executions', turn.requestId)).toMatchObject({ status: 'started' });
      expect(await fixture.store.list('audit_events')).toEqual(audits);
      await expect(turn.service.turn(turn.actor, message, undefined, undefined, identity)).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
    } finally { await turn.finish(); }
  });

  it('fails an expired started request idempotently without creating an assistant or action', async () => {
    const turn = await heldTurn();
    try {
      turn.age(STALE_WINDOW_MS + 1);
      const expected = { status: 'failed', conversationId: turn.event.conversationId, turnId: turn.event.turnId };
      expect(await turn.recover()).toEqual(expected);
      expect(await fixture.store.get('conversation_messages', turn.event.assistantMessageId)).toBeUndefined();
      expect(await fixture.store.list('pending_actions')).toEqual([]);
      expect(await fixture.store.list<ConversationMessage>('conversation_messages')).toEqual([
        expect.objectContaining({ id: turn.event.turnId, role: 'user' }),
      ]);
      const audits = await fixture.store.list<AuditEvent>('audit_events');
      expect(audits).toContainEqual(expect.objectContaining({ category: 'error', summary: 'turn_timed_out' }));
      expect(await turn.recover()).toEqual(expected);
      expect(await fixture.store.list('audit_events')).toEqual(audits);
      expect(turn.runPlanner).toHaveBeenCalledTimes(1);
      for (const key of [turn.requestId, turn.completionId]) {
        expect(await fixture.store.get('tool_executions', key)).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
      }
    } finally { await turn.finish(); }
  });

  it('reports completion when the original writer completes before the stale compare-and-set', async () => {
    const turn = await heldTurn();
    try {
      turn.age(STALE_WINDOW_MS + 1);
      const transact = fixture.store.transaction.bind(fixture.store);
      vi.spyOn(fixture.store, 'transaction').mockImplementationOnce(async work => {
        expect(await turn.finish()).toHaveProperty('response');
        return transact(work);
      });
      expect(await turn.recover()).toMatchObject({ status: 'completed', response: { turnId: turn.event.turnId, replayed: true } });
      expect(await fixture.store.get('tool_executions', turn.requestId)).toMatchObject({ status: 'completed' });
      expect(await fixture.store.get('tool_executions', turn.completionId)).toMatchObject({ status: 'completed' });
      expect((await fixture.store.list<AuditEvent>('audit_events')).some(event => event.summary === 'turn_timed_out')).toBe(false);
    } finally { vi.restoreAllMocks(); await turn.finish(); }
  });

  it('rejects an expired same-requestKey resend as failed and never reruns the provider', async () => {
    const turn = await heldTurn();
    try {
      turn.age(STALE_WINDOW_MS + 1);
      await expect(turn.service.turn(turn.actor, message, undefined, undefined, identity)).rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
      expect(await turn.recover()).toEqual({ status: 'failed', conversationId: turn.event.conversationId, turnId: turn.event.turnId });
      expect(turn.runPlanner).toHaveBeenCalledTimes(1);
      expect(await fixture.store.get('conversation_messages', turn.event.assistantMessageId)).toBeUndefined();
      expect(await fixture.store.list('pending_actions')).toEqual([]);
      expect(await fixture.store.get('tool_executions', turn.requestId)).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
    } finally { await turn.finish(); }
  });

  it('re-reads a concurrent completion after the hosted revision CAS rejects the failure batch', async () => {
    let armed = false;
    let rejectedBatches = 0;
    let complete!: () => Promise<unknown>;
    const base = fixture.store;
    const store: Store = {
      adapter: 'supabase',
      list: <T>(table: Table, filter?: Record<string, string | string[]>) => base.list<T>(table, filter),
      get: <T>(table: Table, key: string) => base.get<T>(table, key),
      async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        if (!armed) return base.transaction(work);
        armed = false;
        const staged: Array<{ id: string; status?: string }> = [];
        await work({
          list: <R>(table: Table, filter?: Record<string, string | string[]>) => base.list<R>(table, filter),
          get: <R>(table: Table, key: string) => base.get<R>(table, key),
          async put<R extends { id: string }>(_table: Table, row: R) { staged.push(row); },
          async remove() { throw new Error('Recovery must not delete rows.'); },
        });
        expect(staged.filter(row => row.status === 'failed')).toHaveLength(2);
        await complete();
        rejectedBatches += 1;
        throw Object.assign(new Error('Synthetic hosted revision conflict'), { code: 'CONFLICT', definitelyNotCommitted: true });
      },
    };
    const turn = await heldTurn(store);
    try {
      turn.age(STALE_WINDOW_MS + 1);
      complete = turn.finish;
      armed = true;
      expect(await turn.recover()).toMatchObject({ status: 'completed', response: { turnId: turn.event.turnId } });
      expect(rejectedBatches).toBe(1);
      expect(await base.get('tool_executions', turn.requestId)).toMatchObject({ status: 'completed' });
      expect(await base.get('tool_executions', turn.completionId)).toMatchObject({ status: 'completed' });
      expect((await base.list<AuditEvent>('audit_events')).some(event => event.summary === 'turn_timed_out')).toBe(false);
      expect(turn.runPlanner).toHaveBeenCalledTimes(1);
    } finally { armed = false; await turn.finish(); }
  });

  it('expires the legacy recoveryOfTurnId path without resending the original request', async () => {
    const turn = await heldTurn();
    try {
      turn.age(STALE_WINDOW_MS + 1);
      await expect(turn.service.turn(turn.actor, message, turn.event.conversationId, turn.event.turnId))
        .rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
      expect(await turn.recover()).toMatchObject({ status: 'failed', turnId: turn.event.turnId });
      expect(turn.runPlanner).toHaveBeenCalledTimes(1);
    } finally { await turn.finish(); }
  });
});
