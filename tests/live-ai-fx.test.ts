import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRuntimeError } from '../lib/ai/errors';
import { boundedActionPreview, ConciergeService } from '../lib/core/service';
import { canonicalChatStreamResponseSchema } from '../lib/chat-stream-contracts';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { TURN_WORK_DEADLINE_MS } from '../lib/ai/provider-options';
import { assertDashboardRendererSupport } from '../lib/core/dashboard-renderer-support';
import { defaultRuntimes } from '../lib/core/runtime-catalog';
import { conversationStep, dashboardCreateStep, param, plan, planner, quoted } from './helpers/turn-planner';
import type { TurnPlannerInput } from '@/lib/router/planner/input';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

// Ported from the legacy provider-transport suite: the AI tool loop (finish_reason truncation, tool-mode retries, final
// synthesis) no longer exists. What stays are the turn-ledger, deadline, abort, persistence-bound and authorization
// assertions, driven by TurnPlans from the single planner call.
describe('Live AI failure regressions through the real service and planner', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await fixture.dispose(); });
  const actor = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
  const identity = { contractVersion: 2 as const, requestKey: 'live-ai-fx-request-0001' };
  const newService = () => new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, reviewPrivateCreations: true, now: () => FIXED_NOW });
  const turnLedgers = async () => (await fixture.store.list<{ name?: string; status?: string; failureReason?: string; id: string }>('tool_executions'))
    .filter(row => row.name === 'chat.turn_request' || row.name === 'chat.turn_completion');

  it.each([false, true])('persists and returns a maximal dashboard proposal without a preview-contract failure (stream=%s)', async streamed => {
    const title = 'T'.repeat(120);
    planner.reply(plan(dashboardCreateStep(title)));
    const response = await newService().turn(actor, 'Create an East dashboard.', undefined, undefined, identity, streamed ? {} : undefined);
    expect(canonicalChatStreamResponseSchema.safeParse(response).success).toBe(true);
    const stored = await fixture.store.list<{ preview: string }>('pending_actions');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.preview.length).toBeLessThanOrEqual(2000);
    expect(response.pendingAction?.payload).toMatchObject({ kind: 'dashboard_create', spec: { title } });
  });

  it.each([false, true])('fails truthfully (typed planner failure, nothing prepared, ledgers completed) when the planner provider is unavailable (stream=%s)', async streamed => {
    planner.fail(new AIRuntimeError('provider_unavailable', 'provider down'));
    const response = await newService().turn(actor, 'Create an East dashboard.', undefined, undefined, identity, streamed ? {} : undefined);
    expect(response).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(response.pendingAction).toBeUndefined();
    expect(response.sources).toBeUndefined();
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    const ledgers = await turnLedgers();
    expect(ledgers).toHaveLength(2);
    expect(ledgers.every(row => row.status === 'completed')).toBe(true);
  });

  it('classifies an unexpected planner crash as a failed turn (both ledgers failed, nothing prepared)', async () => {
    planner.fail(new Error('unexpected planner crash'));
    await expect(newService().turn(actor, 'Create an East dashboard.', undefined, undefined, identity, {})).rejects.toThrow('unexpected planner crash');
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    const ledgers = await turnLedgers();
    expect(ledgers).toHaveLength(2);
    expect(ledgers.every(row => row.status === 'failed')).toBe(true);
  });

  it('propagates a caller abort raised during the planner call and prepares nothing', async () => {
    const controller = new AbortController();
    planner.reply(() => {
      controller.abort(new DOMException('stopped', 'AbortError'));
      throw new AIRuntimeError('provider_unavailable', 'aborted mid-request');
    });
    const outcome = await newService().turn(actor, 'Create an East dashboard.', undefined, undefined, identity,
      { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
    expect(outcome).toHaveProperty('error');
    expect(outcome).not.toHaveProperty('value');
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect((await turnLedgers()).every(row => row.status === 'failed')).toBe(true);
  });

  it('bounds the persisted action preview at exactly 2000 characters and truncates beyond it', () => {
    const pretty = (size: number) => JSON.stringify({ a: 'x'.repeat(size) }, null, 2);
    const size = 2000 - pretty(0).length;
    expect(pretty(size)).toHaveLength(2000);
    expect(boundedActionPreview({ a: 'x'.repeat(size) })).toBe(pretty(size));
    // Pretty form overflows but the compact form fits: compact, no ellipsis.
    const nested = { items: Array.from({ length: 450 }, (_, index) => index) };
    expect(JSON.stringify(nested, null, 2).length).toBeGreaterThan(2000);
    expect(JSON.stringify(nested).length).toBeLessThanOrEqual(2000);
    expect(boundedActionPreview(nested)).toBe(JSON.stringify(nested));
    // Compact itself exceeds the bound: truncated with an ellipsis, length <= 2000.
    const huge = { a: 'y'.repeat(size + 100) };
    const bounded = boundedActionPreview(huge);
    expect(bounded).toHaveLength(2000);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded.slice(0, -1)).toBe(JSON.stringify(huge).slice(0, 1999));
  });

  it('accepts EVERY shipped dashboard template at the renderer support boundary', () => {
    const templates = defaultRuntimes.flatMap(runtime => runtime.manifest.templates);
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) expect(() => assertDashboardRendererSupport(template.spec), template.id).not.toThrow();
  });

  it.each([false, true])('preserves regional authorization: a restricted actor cannot prepare a dashboard for another region (stream=%s)', async streamed => {
    await fixture.patchSession(actors.east.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const restrictedActor = { ...actors.east, mode: 'live_ai' as const, modeRevision: 1 };
    planner.reply(plan({ kind: 'action', actionId: 'dashboard.create', params: {
      title: param('Central overview', 'generated'), regionIds: quoted(['central'], 'Central'), date: param(BUSINESS_DATE, 'default'),
    } }));
    const response = await newService().turn(restrictedActor, 'Create a Central dashboard.', undefined, undefined, identity, streamed ? {} : undefined);
    expect(response.clarification).toBe(true);
    expect(response.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('writes both turn ledgers failed when the deadline aborts an unresponsive planner', async () => {
    const failedPut = vi.fn();
    const transaction = fixture.store.transaction.bind(fixture.store);
    vi.spyOn(fixture.store, 'transaction').mockImplementation(work => transaction(tx => work({ ...tx,
      put: async (table, row) => {
        if (table === 'tool_executions' && 'status' in row && row.status === 'failed') {
          const prior = await tx.get<{ status: string }>(table, row.id);
          failedPut(row.id, prior?.status);
        }
        await tx.put(table, row);
      },
    })));
    let entered!: () => void;
    const plannerEntered = new Promise<void>(resolve => { entered = resolve; });
    // Like the real provider, the planner call is bound to the turn signal: the deadline abort must reject it.
    planner.reply((_input: TurnPlannerInput, runtime: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      entered();
      runtime.signal?.addEventListener('abort', () => reject(runtime.signal?.reason), { once: true });
    }));
    const service = newService();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = service.turn(actor, 'Read East stock.', undefined, undefined, identity, {});
    const rejected = expect(turn).rejects.toMatchObject({ code: 'deadline_exceeded' });
    await plannerEntered;
    await vi.advanceTimersByTimeAsync(TURN_WORK_DEADLINE_MS);
    await rejected;
    const ledgers = await turnLedgers();
    expect(ledgers).toHaveLength(2);
    expect(ledgers.every(row => row.status === 'failed' && row.failureReason === 'turn_failed')).toBe(true);
    expect(failedPut).toHaveBeenCalledTimes(2);
    for (const ledger of ledgers) expect(failedPut.mock.calls.filter(([rowId]) => rowId === ledger.id)).toEqual([[ledger.id, 'started']]);
  });

  it('ends a server-owned demo turn at the internal deadline while a store read remains pending', async () => {
    await fixture.patchSession(actor.sessionId, { mode: 'scripted_demo', modeRevision: 2 });
    const app = newService();
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    // The evidence read stays pending like a slow store; the production read is cancelable by the turn signal.
    vi.spyOn(app, 'queryEvidence').mockImplementation((_actor, _scope, signal) => new Promise((_resolve, reject) => {
      entered();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: unknown;
    const settled = app.turn({ ...actor, mode: 'scripted_demo', modeRevision: 2 }, 'East sales', undefined, undefined, { ...identity, demoShowcaseId: 'executive-overview' })
      .then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await reading;
      await vi.advanceTimersByTimeAsync(TURN_WORK_DEADLINE_MS);
      expect(outcome).toMatchObject({ code: 'deadline_exceeded' });
      const ledgers = await turnLedgers();
      expect(ledgers).toHaveLength(2);
      expect(ledgers.every(row => row.status === 'failed')).toBe(true);
    } finally {
      await settled;
    }
  });

  it('bounds final streaming delivery by the internal turn deadline', async () => {
    planner.reply(plan(conversationStep('greeting', 'สวัสดีครับ มีอะไรให้ช่วยไหมครับ')));
    const app = newService();
    let entered!: () => void, rejectDelivery!: (error: Error) => void;
    const delivering = new Promise<void>(resolve => { entered = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: unknown;
    const settled = app.turn(actor, 'Hello', undefined, undefined, identity, {
      onTextDelta: () => { entered(); return new Promise((_resolve, reject) => { rejectDelivery = reject; }); },
    }).then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await delivering;
      await vi.advanceTimersByTimeAsync(TURN_WORK_DEADLINE_MS);
      expect(outcome).toMatchObject({ code: 'deadline_exceeded' });
      const ledgers = await turnLedgers();
      expect(ledgers).toHaveLength(2);
      expect(ledgers.every(row => row.status === 'completed')).toBe(true);
      expect(await app.recoverTurn(actor, { ...identity, message: 'Hello' })).toMatchObject({ status: 'completed' });
    } finally {
      rejectDelivery(new Error('late delivery rejection'));
      await settled;
    }
  });

  it.each([
    { prose: 'สวัสดีครับ มีอะไรให้ช่วยไหมครับ', safe: true },
    { prose: 'There are 2 options.', safe: false },
  ])('a conversation greeting never yields a no-evidence refusal and streams exactly the persisted text (safe=$safe)', async ({ prose, safe }) => {
    for (const streamed of [true, false]) {
      planner.reply(plan(conversationStep('greeting', prose)));
      const deltas: string[] = [];
      const response = await newService().turn(actor, 'Hello', undefined, undefined,
        { contractVersion: 2 as const, requestKey: `live-ai-fx-greeting-${streamed}-${safe}` },
        streamed ? { onTextDelta: text => { deltas.push(text); } } : undefined);
      expect(response.message).not.toBe('โปรดระบุข้อมูลหรือการดำเนินงานในรายการความสามารถของบัญชีนี้');
      expect(response.message).not.toContain('no tool was invoked');
      // Safe prose is shown; unsafe prose (a number the planner invented) is replaced by the server-owned capability text.
      if (safe) expect(response.message).toBe(prose);
      else { expect(response.message).not.toContain('2 options'); expect(response.message).toMatch(/^สวัสดีครับ.*ให้ผมช่วยได้/su); }
      expect(response.clarification).toBeUndefined();
      if (streamed) expect(deltas.join('')).toBe(response.message);
    }
  });
});
