import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionPayload, Actor, Branch, PendingAction, Profile, Store, Table, Transaction } from '../lib/contracts';
import { AIRuntimeError } from '../lib/ai/errors';
import type { TurnPlannerInput } from '../lib/router/planner/input';
import { ConciergeService, type TurnStarted } from '../lib/core/service';
import { DomainError } from '../lib/core/errors';
import { StorageReadUnavailableError } from '../lib/storage/read-error';
import { turnCompletionId } from '../lib/core/turn-completion-gate';
import { formatRetailMoney } from '../lib/packs/retail/summary';
import { createSeedData } from '../lib/seed/generate';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import {
  baseQueryPlan, branchQueryStep, clarifyStep, conversationStep, dashboardCreateStep, defaultQueryStep, fromContext, plan, planner, quoted,
  ticketCreateStep,
} from './helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
type TicketPayload = Extract<ActionPayload, { kind: 'ticket_create' }>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label + '.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function replaceEastDataWithGeneratedFixture(store: Store): Promise<void> {
  const generated = createSeedData(BUSINESS_DATE, 1);
  const eastBranches = generated.branches.filter((branch) => branch.region === 'east');
  const eastBranchIds = eastBranches.map((branch) => branch.id);
  const eastBranchSet = new Set(eastBranchIds);
  const forBusinessDate = <T extends { branchId: string; date: string }>(rows: T[]) =>
    rows.filter((row) => eastBranchSet.has(row.branchId) && row.date === BUSINESS_DATE);

  await store.transaction(async (tx) => {
    for (const table of ['sales_orders', 'sales_targets', 'inventory_snapshots', 'incidents', 'staffing_summaries'] as const) {
      const existing = await tx.list<{ id: string; branchId: string }>(table, { branchId: eastBranchIds });
      for (const row of existing) await tx.remove(table, row.id);
    }
    for (const branch of eastBranches) await tx.put('branches', branch);
    for (const product of generated.products) await tx.put('products', product);
    for (const row of forBusinessDate(generated.sales_orders)) await tx.put('sales_orders', row);
    for (const row of forBusinessDate(generated.sales_targets)) await tx.put('sales_targets', row);
    for (const row of forBusinessDate(generated.inventory_snapshots)) await tx.put('inventory_snapshots', row);
    for (const row of forBusinessDate(generated.incidents)) await tx.put('incidents', row);
    for (const row of forBusinessDate(generated.staffing_summaries)) await tx.put('staffing_summaries', row);
  });
}

function trackWrites(base: Store) {
  let writes = 0;
  const store: Store = {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: Record<string, string | string[]>) => base.list<T>(table, filters),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    transaction<T>(work: (tx: Transaction) => Promise<T>) {
      return base.transaction((tx) => work({
        list: <R>(table: Table, filters?: Record<string, string | string[]>) => tx.list<R>(table, filters),
        get: <R>(table: Table, id: string) => tx.get<R>(table, id),
        async put<R extends { id: string }>(table: Table, row: R) {
          await tx.put(table, row);
          writes += 1;
        },
        async remove(table: Table, id: string) {
          await tx.remove(table, id);
          writes += 1;
        },
      }));
    },
  };
  return { store, writes: () => writes };
}

// ---------------------------------------------------------------------------------------------- plan builders
// The shared `regionQueryStep` helper builds a dimension span without start/end offsets, which the TurnPlan schema
// rejects; this local builder locates the spans in the current message exactly like a real planner would.
function spanOf(message: string, text: string) {
  const start = message.indexOf(text);
  if (start < 0) throw new Error(`The test message does not contain "${text}".`);
  return { start, end: start + text.length, text };
}

function regionRead(input: TurnPlannerInput, regionId: string, regionText: string, dateText = '2026-10-01', measure: 'net_sales' | 'gap' = 'net_sales') {
  const message = input.currentMessage;
  return {
    kind: 'query', continuation: false,
    plan: baseQueryPlan(input.context, {
      dimensions: [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: spanOf(message, regionText), confidence: 1 } }],
      filters: [{ fieldId: 'region', op: 'eq', value: regionId, source: 'explicit', evidenceText: regionText, confidence: 1 }],
      grain: ['region', 'date'], group: { fieldIds: ['region'] },
      ...(measure === 'gap' ? { measures: [{ fieldId: 'gap', aggregation: 'gap', interpretation: { value: 'gap', source: 'default', sourceText: null, confidence: 1 } }] } : {}),
      time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: [dateText], evidenceText: dateText },
    }),
  };
}

const eastRead = (input: TurnPlannerInput) => plan(regionRead(input, 'east', 'East'));
const READ_MESSAGE = 'Show East sales totals for 2026-10-01.';

const reviseStep = (pendingActionId: string, options: { title?: string; remove?: number[] }) => ({
  kind: 'refine', pendingActionId,
  operation: {
    op: 'revise_dashboard',
    ...(options.title === undefined ? {} : { title: quoted(options.title, options.title) }),
    ...(options.remove === undefined ? {} : { removeWidgetIndexes: fromContext(options.remove) }),
  },
});

const REQUEST_IDENTITY = { contractVersion: 2 as const, requestKey: 'chat-stream-service-key-0001' };
const AUTHORIZATION_REDACTION = 'ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน';
const PROTECTED_TABLES = ['pending_actions', 'dashboards', 'dashboard_shares', 'mock_tickets', 'action_executions', 'mock_messages'] as const;
const DASHBOARD_REQUEST = 'Create a dashboard proposal.';
const NEW_TITLE_REQUEST = 'Rename the dashboard title to "Reviewed East summary".';
/** The default dashboard.create proposal has six widgets; index 3 is the stock-and-staffing table. */
const STAFFING_WIDGET_INDEX = 3;

describe('V1 streamed ConciergeService turn persistence', () => {
  let fixture!: WorkspaceFixture;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
    vi.unstubAllEnvs();
  });

  async function liveActor(key: 'executive' | 'east' | 'hr' = 'executive'): Promise<Actor> {
    await fixture.patchSession(actors[key].sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actors[key], mode: 'live_ai' as const, modeRevision: 1 };
  }

  function service(store: Store = fixture.store, now: () => Date = () => new Date(FIXED_NOW)) {
    return new ConciergeService(store, { businessDate: BUSINESS_DATE, reviewPrivateCreations: true, now });
  }

  async function ticketPayload(serviceUnderTest: ConciergeService, actor: Actor): Promise<TicketPayload> {
    const evidence = await serviceUnderTest.queryEvidence(actor, { region: 'east', date: BUSINESS_DATE, branchIds: ['E02'] });
    const branch = evidence.branches.find((candidate) => candidate.branchId === 'E02');
    if (!branch) throw new Error('The East ticket fixture branch is missing.');
    return {
      kind: 'ticket_create',
      scope: evidence.scope,
      targets: [{
        branchId: branch.branchId,
        assigneeId: 'E024',
        title: 'Review the East Two sales gap',
        reason: 'The synthetic evidence does not prove a cause.',
        sourceIds: [...branch.sourceIds],
        unansweredQuestion: 'Check demand and conversion over the affected time window.',
      }],
    };
  }

  async function expectedEastSales(serviceUnderTest: ConciergeService, actor: Actor): Promise<string> {
    const evidence = await serviceUnderTest.queryEvidence(actor, { region: 'east', date: BUSINESS_DATE });
    return formatRetailMoney(evidence.totals.netSales);
  }

  async function effectCounts() {
    return Promise.all(PROTECTED_TABLES.map(async (table) => [table, (await fixture.store.list(table)).length] as const));
  }

  async function completionOf(turn: { conversationId: string; turnId: string }, actor: Actor) {
    return fixture.store.get<Record<string, unknown>>('tool_executions', turnCompletionId({
      actorId: actor.id, sessionId: actor.sessionId, conversationId: turn.conversationId, turnId: turn.turnId,
    }));
  }

  /** Create the first dashboard proposal of a conversation through the planner (review tier: pending, not created). */
  async function createProposal(serviceUnderTest: ConciergeService, actor: Actor, requestKey: string, conversationId?: string) {
    planner.reply(plan(dashboardCreateStep('Dashboard proposal')));
    const response = await serviceUnderTest.turn(actor, DASHBOARD_REQUEST, conversationId, undefined, { contractVersion: 2, requestKey });
    const proposal = response.pendingAction;
    if (!proposal || proposal.payload.kind !== 'dashboard_create') throw new Error('The dashboard proposal is missing.');
    return { response, proposal: proposal as PendingAction & { payload: Extract<ActionPayload, { kind: 'dashboard_create' }> } };
  }

  // ------------------------------------------------------------------------------------- turn admission and completion
  it('keeps a prepared action unconfirmable until the exact streamed turn is durably completed', async () => {
    const actor = await liveActor();
    const preparedAtSaving = deferred<PendingAction>();
    const releaseSaving = deferred<void>();
    const started = deferred<TurnStarted>();
    const serviceUnderTest = service();
    planner.reply(() => plan(ticketCreateStep(['E02'], 'E02')));

    let turnPromise: ReturnType<typeof serviceUnderTest.turn> | undefined;
    try {
      turnPromise = serviceUnderTest.turn(actor, 'Prepare an East review ticket for E02.', undefined, undefined, REQUEST_IDENTITY, {
        onStarted: (event) => started.resolve(event),
        // The executor has already prepared the proposal when the turn reaches `saving`; hold the turn open there.
        onStatus: async (status) => {
          if (status !== 'saving') return;
          const [prepared] = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
          if (prepared) preparedAtSaving.resolve(prepared);
          await releaseSaving.promise;
        },
      });
      const startedEvent = await withDeadline(started.promise, 'turn.started');
      const action = await withDeadline(preparedAtSaving.promise, 'proposal preparation');

      expect(await fixture.store.get<Record<string, unknown>>('conversation_messages', startedEvent.turnId)).toMatchObject({
        id: startedEvent.turnId, actorId: actor.id, sessionId: actor.sessionId, conversationId: startedEvent.conversationId,
        turnId: startedEvent.turnId, role: 'user',
      });

      const completionId = turnCompletionId({
        actorId: actor.id, sessionId: actor.sessionId, conversationId: startedEvent.conversationId, turnId: startedEvent.turnId,
      });
      const startedCompletion = await fixture.store.get<Record<string, unknown>>('tool_executions', completionId);
      expect(startedCompletion).toMatchObject({ id: completionId, name: 'chat.turn_completion', status: 'started', origin: 'chat' });
      const request = (await fixture.store.list<Record<string, unknown> & { id: string; name?: string; turnId?: string; status?: string }>('tool_executions'))
        .find((row) => row.name === 'chat.turn_request' && row.turnId === startedEvent.turnId);
      expect(startedCompletion).toMatchObject({ requestLedgerId: request?.id });
      expect(request).toMatchObject({
        status: 'started', actorId: actor.id, sessionId: actor.sessionId, conversationId: startedEvent.conversationId,
        mode: 'live_ai', modeRevision: 1,
      });

      await expect(serviceUnderTest.confirm(actor, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
      expect(await fixture.store.get('action_executions', 'execution_' + action.id)).toBeUndefined();
      expect(await fixture.store.list('mock_tickets')).toHaveLength(0);

      releaseSaving.resolve();
      const response = await withDeadline(turnPromise, 'turn completion');
      expect(response.pendingActions?.map((item) => item.id)).toEqual([action.id]);

      const assistant = await fixture.store.get<Record<string, unknown> & { id: string }>('conversation_messages', response.assistantMessageId);
      expect(assistant).toMatchObject({
        id: startedEvent.assistantMessageId, conversationId: startedEvent.conversationId, turnId: startedEvent.turnId,
        sessionId: actor.sessionId, role: 'assistant', pendingActionId: action.id, pendingActionIds: [action.id],
      });

      const completedRequest = (await fixture.store.list<Record<string, unknown> & { name?: string; turnId?: string; status?: string; finalActionIds?: string[] }>('tool_executions'))
        .find((row) => row.name === 'chat.turn_request' && row.turnId === startedEvent.turnId);
      expect(completedRequest).toMatchObject({ status: 'completed', finalActionIds: [action.id] });
      expect(await fixture.store.get<Record<string, unknown>>('tool_executions', completionId)).toMatchObject({
        status: 'completed', assistantMessageId: assistant?.id, finalActionIds: [action.id],
      });

      const receipt = await serviceUnderTest.confirm(actor, action.id);
      expect(receipt).toMatchObject({ visibility: 'full', actionId: action.id, status: 'verified_success' });
      expect(await fixture.store.list('mock_tickets')).toHaveLength(1);
    } finally {
      releaseSaving.resolve();
      await turnPromise?.catch(() => undefined);
    }
  });

  it('titles a new conversation from the first user message and never overwrites a renamed title', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    const first = await serviceUnderTest.turn(actor, '  Show   the authorized\nEast inventory.  ', undefined, undefined, REQUEST_IDENTITY);
    const conversationId = first.conversationId;
    expect(await fixture.store.get<{ title: string }>('conversations', conversationId)).toMatchObject({ title: 'Show the authorized East inventory.' });
    const row = await fixture.store.get<Record<string, unknown> & { rowVersion: number }>('conversations', conversationId);
    await fixture.store.transaction(async tx => { await tx.put('conversations', { ...row, title: 'My rename', rowVersion: row!.rowVersion + 1 } as unknown as { id: string }); });
    await serviceUnderTest.turn(actor, 'Another question entirely', conversationId, undefined, { ...REQUEST_IDENTITY, requestKey: 'rename-keep-0000000000000001' } as typeof REQUEST_IDENTITY);
    expect(await fixture.store.get<{ title: string }>('conversations', conversationId)).toMatchObject({ title: 'My rename' });
  });

  it('persists and streams the server-rendered answer, never planner-authored numbers', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(eastRead);
    const expectedAmount = await expectedEastSales(serviceUnderTest, actor);
    const deltas: string[] = [];
    const persistedAtEmission: boolean[] = [];
    let startedAssistantMessageId: string | undefined;

    const response = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: (event) => { startedAssistantMessageId = event.assistantMessageId; },
      onTextDelta: async (text) => {
        deltas.push(text);
        const stored = startedAssistantMessageId
          ? await fixture.store.get<{ text: string }>('conversation_messages', startedAssistantMessageId)
          : undefined;
        persistedAtEmission.push(stored?.text === text);
      },
    });
    const assistant = await fixture.store.get<{ text: string; sources?: unknown; analysis?: unknown }>('conversation_messages', response.assistantMessageId);

    expect(expectedAmount).toBe('1,500.00');
    expect(response.message).toContain(expectedAmount);
    expect(deltas).toEqual([response.message]);
    expect(persistedAtEmission).toEqual([true]);
    expect(assistant?.text).toBe(response.message);
    expect(assistant?.sources).toEqual(response.sources);
    expect(assistant?.analysis).toEqual(response.analysis);
    expect(response.sources?.map((source) => source.id)).toEqual(['sales:E02:2026-10-01']);
    expect(response.clarification).toBeUndefined();
    expect(response.pendingAction).toBeUndefined();
  });

  // ----------------------------------------------------------------------------------------- conversation steps
  it.each([false, true])('returns safe planner greeting prose unchanged (streamed=%s)', async (streamed) => {
    const actor = await liveActor();
    const prose = 'สวัสดีครับ ยินดีช่วยครับ';
    planner.reply(plan(conversationStep('greeting', prose)));
    const deltas: string[] = [];
    const response = await service().turn(actor, 'Hello', undefined, undefined, streamed ? REQUEST_IDENTITY : undefined,
      streamed ? { onTextDelta: text => { deltas.push(text); } } : undefined);
    expect(response.message).toBe(prose);
    expect(response.clarification).toBeUndefined();
    expect(response.sources).toBeUndefined();
    if (streamed) expect(deltas).toEqual([prose]);
  });

  it('returns a server-owned friendly capability reply when planner prose fails the safety gate', async () => {
    const actor = await liveActor();
    // List enumerators ("1) ... 2) ...") are allowed in advice prose; any other digit or number word is a data claim.
    for (const prose of ['There are 2 options.', '1) sales 20 2) stock', 'ยอดขายเพิ่มขึ้นหนึ่งเปอร์เซ็นต์']) {
      planner.reply(plan(conversationStep('advice', prose)));
      for (const identity of [{ ...REQUEST_IDENTITY, requestKey: `unsafe-prose-key-${prose.length}-0001` }, undefined]) {
        const response = await service().turn(actor, 'Hello', undefined, undefined, identity, identity ? {} : undefined);
        expect(response.message).toMatch(/^สวัสดีครับ/u);
        expect(response.message).toContain('ยอดขาย');
        expect(response.message).not.toMatch(/\p{N}/u);
        expect(response.message).not.toContain(prose);
        expect(response.clarification).toBeUndefined();
      }
    }
  });

  it('keeps the capability topic server-owned and greets only the first turn of a conversation', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(plan(conversationStep('capability', 'ผมช่วยได้ทุกอย่างครับ')));
    const first = await serviceUnderTest.turn(actor, 'What can you do?');
    const second = await serviceUnderTest.turn(actor, 'What else can you do?', first.conversationId);
    expect(first.message).toMatch(/^สวัสดีครับ/u);
    expect(first.message).not.toContain('ผมช่วยได้ทุกอย่างครับ');
    expect(second.message).not.toContain('ผมช่วยได้ทุกอย่างครับ');
    expect(second.message).not.toContain('สวัสดีครับ');
    expect(second.message).toContain('บัญชีนี้ให้ผมช่วยได้ในเรื่อง');
    expect(second.message).not.toMatch(/\p{N}/u);
  });

  // -------------------------------------------------------------------------------------------- live preparation
  it('a live dashboard request prepares a pending action through the planner and persists it', async () => {
    const actor = await liveActor();
    planner.reply(plan(dashboardCreateStep('Sales overview')));
    const response = await service().turn(actor, 'Create a sales dashboard', undefined, undefined, REQUEST_IDENTITY, {});
    expect(response.pendingAction?.status).toBe('pending');
    expect(response.message).toMatch(/^เตรียมรายการแล้ว ยังไม่ได้ดำเนินการ — โปรดตรวจตัวอย่างและยืนยัน/u);
    expect(await fixture.store.get('pending_actions', response.pendingAction!.id)).toMatchObject({ status: 'pending' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('the live kill switch completes truthfully without calling the planner or preparing anything', async () => {
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'off');
    const actor = await liveActor();
    planner.reply(plan(dashboardCreateStep('Sales overview')));
    const response = await service().turn(actor, 'Create a sales dashboard', undefined, undefined, REQUEST_IDENTITY, {});
    expect(planner.calls).toHaveLength(0);
    expect(response.hint).toBe('switch_to_demo');
    expect(response.clarification).toBe(true);
    expect(response.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions')).toEqual([]);
  });

  it.each([
    { variant: 'kill switch', plannerCalls: 0 },
    { variant: 'planner outage', plannerCalls: 1 },
    { variant: 'invalid plan', plannerCalls: 1 },
  ])('zero-step live turns never end in a bare refusal or fabricated figures ($variant), stream and non-stream', async ({ variant, plannerCalls }) => {
    const actor = await liveActor();
    if (variant === 'kill switch') vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'off');
    else if (variant === 'planner outage') planner.fail(new AIRuntimeError('provider_unavailable', 'Planner provider is unavailable.'));
    else planner.reply({ turnPlanVersion: 1, steps: [] });
    let n = 0;
    for (const options of [{}, undefined]) {
      const before = planner.calls.length;
      const response = await service().turn(actor, `ช่วยแนะนำแพลตฟอร์มนี้หน่อย ${n}`, undefined, undefined,
        options ? { ...REQUEST_IDENTITY, requestKey: `zero-step-key-${plannerCalls}-${variant.length}-${n++}-0001` } : undefined, options);
      expect(planner.calls.length - before).toBe(plannerCalls);
      expect(response.message).not.toBe('โปรดระบุข้อมูลหรือการดำเนินงานในรายการความสามารถของบัญชีนี้');
      expect(response.message.length).toBeGreaterThan(20);
      expect(response.message).not.toMatch(/\p{N}/u);
      expect(response.hint).toBe('switch_to_demo');
      expect(response.clarification).toBe(true);
      expect(response.sources).toBeUndefined();
      expect(response.pendingAction).toBeUndefined();
    }
    expect(await fixture.store.list('pending_actions')).toEqual([]);
  });

  // ------------------------------------------------------------------------------- answers: persistence and replay
  it('persists, streams by replay, and recovers a sales summary from authorized sales evidence', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(eastRead);
    const expectedAmount = await expectedEastSales(serviceUnderTest, actor);
    const deltas: string[] = [];
    const persistedAtEmission: boolean[] = [];
    let startedAssistantMessageId: string | undefined;
    const original = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: (event) => { startedAssistantMessageId = event.assistantMessageId; },
      onTextDelta: async (text) => {
        deltas.push(text);
        const stored = startedAssistantMessageId
          ? await fixture.store.get<{ text: string }>('conversation_messages', startedAssistantMessageId)
          : undefined;
        persistedAtEmission.push(stored?.text === text);
      },
    });
    const persistedAssistant = await fixture.store.get<{ text: string }>('conversation_messages', original.assistantMessageId);
    const replay = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    const recovered = await serviceUnderTest.recoverTurn(actor, { contractVersion: 2, requestKey: REQUEST_IDENTITY.requestKey, message: READ_MESSAGE });

    expect(expectedAmount).toBe('1,500.00');
    expect(original.message).toContain('ยอดขายสุทธิ');
    expect(original.message).toContain(expectedAmount);
    expect(persistedAssistant?.text).toBe(original.message);
    expect(replay).toMatchObject({ message: original.message, replayed: true, assistantMessageId: original.assistantMessageId });
    expect(recovered).toMatchObject({ status: 'completed', response: { message: original.message, replayed: true } });
    expect(deltas).toEqual([original.message]);
    expect(persistedAtEmission).toEqual([true]);
    expect(planner.calls).toHaveLength(1);
  });

  it('uses and replays the sales summary for nonstream live_ai turns without pending actions', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(eastRead);
    const original = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY);
    const persisted = await fixture.store.get<{ text: string; pendingActionId?: string; pendingActionIds?: string[] }>(
      'conversation_messages', original.assistantMessageId);
    const replay = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY);

    expect(original.message).toContain('1,500.00');
    expect(persisted?.text).toBe(original.message);
    expect(replay).toMatchObject({ message: original.message, assistantMessageId: original.assistantMessageId, replayed: true });
    expect(original.pendingAction).toBeUndefined();
    expect(original.pendingActions).toBeUndefined();
    expect(persisted?.pendingActionId).toBeUndefined();
    expect(persisted?.pendingActionIds).toBeUndefined();
    expect(planner.calls).toHaveLength(1);
  });

  it('feeds proven history to the planner of the next turn, then replays and recovers both turns without it', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const detailMessage = 'And only E02 for 2026-10-01 please.';
    const detailIdentity = { contractVersion: 2 as const, requestKey: 'chat-stream-follow-up-e02-0001' };
    planner.sequence(eastRead, (input: TurnPlannerInput) => plan(branchQueryStep(input, 'E02', 'E02', '2026-10-01', '2026-10-01')));
    const effectsBefore = await effectCounts();

    const first = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    const detail = await serviceUnderTest.turn(actor, detailMessage, first.conversationId, undefined, detailIdentity, {});

    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[1]!.currentMessage).toBe(detailMessage);
    expect(planner.calls[1]!.context.conversation).toContainEqual({ role: 'user', text: READ_MESSAGE });
    expect(planner.calls[1]!.context.conversation).toContainEqual({ role: 'assistant', text: first.message });
    expect(planner.calls[1]!.context.acceptedStates).toHaveLength(1);
    expect(detail.sources?.map((source) => source.id)).toEqual(['sales:E02:2026-10-01']);
    expect(detail.message).toContain('1,500.00');
    expect(detail.clarification).toBeUndefined();

    const firstReplay = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    const detailReplay = await serviceUnderTest.turn(actor, detailMessage, first.conversationId, undefined, detailIdentity, {});
    const detailRecovery = await serviceUnderTest.recoverTurn(actor, {
      contractVersion: 2, requestKey: detailIdentity.requestKey, conversationId: first.conversationId, message: detailMessage,
    });
    expect(firstReplay).toMatchObject({ message: first.message, assistantMessageId: first.assistantMessageId, replayed: true });
    expect(detailReplay).toMatchObject({ message: detail.message, assistantMessageId: detail.assistantMessageId, replayed: true });
    expect(detailRecovery).toMatchObject({ status: 'completed', response: { message: detail.message, replayed: true } });
    expect(planner.calls).toHaveLength(2);
    const assistants = (await fixture.store.list<{ id: string; conversationId: string; role: string }>('conversation_messages'))
      .filter((message) => message.conversationId === first.conversationId && message.role === 'assistant').map((message) => message.id).sort();
    expect(assistants).toEqual([first.assistantMessageId, detail.assistantMessageId].sort());
    expect(await effectCounts()).toEqual(effectsBefore);
  });

  // -------------------------------------------------------------------------------------- read failures and authority
  it.each([
    { label: 'storage read failure', error: new StorageReadUnavailableError('sqlite', 'list', 'database_busy') },
    { label: 'revision conflict 409', error: new DomainError('CONFLICT', 'Evidence revision changed', 409) },
    { label: 'unknown-outcome conflict', error: Object.assign(new Error('Read outcome unknown'), { code: 'CONFLICT', definitelyNotCommitted: false }) },
    { label: 'known-no-commit storage error', error: Object.assign(new Error('Storage unavailable'), { code: 'STORAGE', definitelyNotCommitted: true }) },
    { label: 'unknown error', error: new Error('Unexpected evidence failure') },
    { label: 'expired authorization 401', error: new DomainError('UNAUTHENTICATED', 'Session expired', 401) },
    { label: 'abort', error: new DOMException('Evidence read stopped', 'AbortError') },
  ])('propagates $label during the evidence read without persisted evidence', async ({ error }) => {
    const actor = await liveActor('east');
    const controller = new AbortController();
    const serviceUnderTest = service();
    const guard = vi.spyOn(serviceUnderTest, 'queryEvidence').mockImplementation(async () => {
      if (error.name === 'AbortError') controller.abort(error);
      throw error;
    });
    planner.reply(eastRead);
    let started: TurnStarted | undefined;
    const deltas: string[] = [];
    await expect(serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      signal: controller.signal,
      onStarted: turn => { started = turn; },
      onTextDelta: text => { deltas.push(text); },
    })).rejects.toBe(error);
    if (!started) throw new Error('The failing turn was not admitted.');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual([]);
    expect(await fixture.store.get('conversation_messages', started.assistantMessageId)).toBeUndefined();
    const failureReason = error.name === 'AbortError' ? 'turn_cancelled' : 'turn_failed';
    expect(await completionOf(started, actor)).toMatchObject({ status: 'failed', failureReason });
    expect(await serviceUnderTest.recoverTurn(actor, { ...REQUEST_IDENTITY, message: READ_MESSAGE }))
      .toMatchObject({ status: 'failed', conversationId: started.conversationId, turnId: started.turnId });
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect((await fixture.store.list('tool_executions')).filter((row) => (row as { name?: string }).name === 'retail.dynamic_query')).toEqual([]);
  });

  it.each([403, 404])('propagates a scope-related read error %s without persisting an answer', async (status) => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const error = new DomainError('FORBIDDEN', 'Scope unavailable', status);
    vi.spyOn(serviceUnderTest, 'queryEvidence').mockRejectedValue(error);
    planner.reply(eastRead);
    let started: TurnStarted | undefined;
    await expect(serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: turn => { started = turn; },
    })).rejects.toBe(error);
    if (!started) throw new Error('The failing turn was not admitted.');
    expect(await fixture.store.get('conversation_messages', started.assistantMessageId)).toBeUndefined();
    expect(await completionOf(started, actor)).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
    expect(await fixture.store.list('pending_actions')).toEqual([]);
  });

  it.each(['sales.read', 'operations.read'])('does not answer after %s was revoked while the planner was working', async permission => {
    const actor = await liveActor();
    planner.reply(async (input: TurnPlannerInput) => {
      await fixture.store.transaction(async tx => {
        const profile = await tx.get<Profile>('profiles', actor.id);
        if (!profile) throw new Error('The test profile is missing.');
        await tx.put('profiles', { ...profile, permissions: profile.permissions.filter(value => value !== permission) });
      });
      return eastRead(input);
    });
    const response = await service().turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    expect(response.clarification).toBe(true);
    expect(response.sources).toBeUndefined();
    expect(response.analysis).toBeUndefined();
    expect(response.message).not.toContain('1,500.00');
    expect((await fixture.store.list<{ name?: string }>('tool_executions')).filter(row => row.name === 'retail.dynamic_query')).toEqual([]);
  });

  it('refuses a region the East manager never had without data', async () => {
    const actor = await liveActor('east');
    planner.reply((input: TurnPlannerInput) => plan(regionRead(input, 'south', 'South')));
    const response = await service().turn(actor, 'Show South sales totals for 2026-10-01.');
    expect(response.clarification).toBe(true);
    expect(response.sources).toBeUndefined();
    expect(response.analysis).toBeUndefined();
    expect(response.message).not.toContain('1,500.00');
    expect((await fixture.store.list<{ name?: string }>('tool_executions')).filter(row => row.name === 'retail.dynamic_query')).toEqual([]);
  });

  it.each([
    { label: 'sales permission', shrink: (profile: Profile) => ({ ...profile, permissions: profile.permissions.filter(p => p !== 'sales.read') }) },
    { label: 'operations permission', shrink: (profile: Profile) => ({ ...profile, permissions: profile.permissions.filter(p => p !== 'operations.read') }) },
    { label: 'region scope', shrink: (profile: Profile) => ({ ...profile, regions: ['central'] }) },
    { label: 'branch region', shrink: (profile: Profile) => profile },
  ])('denies revoked $label between the read and persistence without saving a grounded answer', async ({ label, shrink }) => {
    const actor = await liveActor('east');
    const serviceUnderTest = service();
    planner.reply(eastRead);
    let started: TurnStarted | undefined;
    const deltas: string[] = [];
    await expect(serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: turn => { started = turn; },
      onTextDelta: text => { deltas.push(text); },
      onStatus: async status => {
        if (status !== 'saving') return;
        await fixture.store.transaction(async tx => {
          const profile = await tx.get<Profile>('profiles', actor.id);
          if (!profile) throw new Error('The test profile is missing.');
          await tx.put('profiles', shrink(profile));
          if (label === 'branch region') {
            const branch = await tx.get<Branch>('branches', 'E02');
            if (!branch) throw new Error('The test branch is missing.');
            await tx.put('branches', { ...branch, region: 'central' });
          }
        });
      },
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    if (!started) throw new Error('The revoked turn was not admitted.');
    expect(deltas).toEqual([]);
    expect(await fixture.store.get('conversation_messages', started.assistantMessageId)).toBeUndefined();
    expect(await completionOf(started, actor)).toMatchObject({ status: 'failed', failureReason: 'turn_failed' });
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect((await fixture.store.list<{ name?: string }>('tool_executions')).filter(row => row.name === 'retail.dynamic_query')).toEqual([]);
  });

  it('denies an all-region answer when authority over a region it covered is revoked before persistence', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply((input: TurnPlannerInput) => plan(defaultQueryStep(input)));
    let started: TurnStarted | undefined;
    await expect(serviceUnderTest.turn(actor, 'Show sales totals for the default scope.', undefined, undefined, REQUEST_IDENTITY, {
      onStarted: turn => { started = turn; },
      onStatus: async status => {
        if (status !== 'saving') return;
        await fixture.store.transaction(async tx => {
          const profile = await tx.get<Profile>('profiles', actor.id);
          if (!profile) throw new Error('The test profile is missing.');
          await tx.put('profiles', { ...profile, regions: ['east', 'south'] });
        });
      },
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    if (!started) throw new Error('The revoked turn was not admitted.');
    expect(await fixture.store.get('conversation_messages', started.assistantMessageId)).toBeUndefined();
  });

  it.each([false, true])('loads the branch registry once at persistence and denies a missing answer branch (missing=%s)', async missing => {
    const actor = await liveActor('east');
    await replaceEastDataWithGeneratedFixture(fixture.store);
    let saving = false, branchLists = 0, branchGets = 0;
    const base = fixture.store;
    const tracked: Store = {
      adapter: base.adapter,
      get: <T>(table: Table, rowId: string) => base.get<T>(table, rowId),
      list: <T>(table: Table, filters?: Record<string, string | string[]>) => base.list<T>(table, filters),
      transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(tx => work({
        ...tx,
        list: <R>(table: Table, filters?: Record<string, string | string[]>) => {
          if (saving && table === 'branches') branchLists += 1;
          return tx.list<R>(table, filters).then(rows => saving && missing && table === 'branches'
            ? rows.filter(row => (row as Branch).id !== 'E01') : rows);
        },
        get: <R>(table: Table, rowId: string) => {
          if (saving && table === 'branches') branchGets += 1;
          return tx.get<R>(table, rowId);
        },
      })),
    };
    planner.reply(eastRead);
    let started: TurnStarted | undefined;
    const turn = service(tracked).turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: event => { started = event; },
      onStatus: status => { if (status === 'saving') saving = true; },
    });
    if (missing) {
      await expect(turn).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      if (!started) throw new Error('The failing turn was not admitted.');
      expect(await fixture.store.get('conversation_messages', started.assistantMessageId)).toBeUndefined();
    } else {
      expect((await turn).sources?.length).toBeGreaterThan(0);
    }
    // Bounded registry reads (never per-row): one for the answer's persistence gate, plus one catalog-digest read when the
    // router's artifact persistence hook runs in the same transaction.
    expect(branchLists).toBeLessThanOrEqual(missing ? 1 : 2);
    expect(branchLists).toBeGreaterThanOrEqual(1);
    expect(branchGets).toBe(0);
  });

  it('rechecks region authority at confirm for a dashboard proposal prepared before authority shrank mid-turn', async () => {
    // The router persists no planner evidence with a proposal; the guard against a stale authority is the confirm-time
    // revalidation of the proposal itself (the legacy persistence-time evidence-scope check no longer exists).
    const actor = await liveActor();
    await replaceEastDataWithGeneratedFixture(fixture.store);
    const serviceUnderTest = service();
    planner.reply(plan(dashboardCreateStep('All regions dashboard')));
    const response = await serviceUnderTest.turn(actor, 'Create an all-regions dashboard', undefined, undefined, REQUEST_IDENTITY, {
      onStatus: async status => {
        if (status !== 'saving') return;
        await fixture.store.transaction(async tx => {
          const profile = await tx.get<Profile>('profiles', actor.id);
          if (!profile) throw new Error('The test profile is missing.');
          await tx.put('profiles', { ...profile, regions: ['east'] });
        });
      },
    });
    const action = response.pendingAction;
    if (!action) throw new Error('The dashboard proposal is missing.');
    expect(action.status).toBe('pending');
    await expect(serviceUnderTest.confirm({ ...actor, regions: ['east'] }, action.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('refuses an incomplete scope (a branch without a target) instead of answering around it', async () => {
    const actor = await liveActor('east');
    await replaceEastDataWithGeneratedFixture(fixture.store);
    await fixture.store.transaction(async tx => {
      for (const row of await tx.list<{ id: string }>('sales_targets', { branchId: 'E04', date: BUSINESS_DATE })) await tx.remove('sales_targets', row.id);
    });
    planner.reply((input: TurnPlannerInput) => plan(regionRead(input, 'east', 'East', '2026-10-01', 'gap')));
    const response = await service().turn(actor, 'Show East gap to target for 2026-10-01.', undefined, undefined, REQUEST_IDENTITY, {});
    expect(response.clarification).toBe(true);
    expect(response.message).not.toMatch(/[0-9๐-๙]/);
    expect(response.sources).toBeUndefined();
    expect(response.analysis).toBeUndefined();
    const persisted = await fixture.store.get<{ text: string; analysis?: unknown; sources?: unknown }>('conversation_messages', response.assistantMessageId);
    expect(persisted?.text).toBe(response.message);
    expect(persisted?.analysis).toBeUndefined();
    expect(persisted?.sources).toBeUndefined();
  });

  // ------------------------------------------------------------------------------------------------- clarifications
  it('persists a planner clarification for the HR role, replays it without the planner and leaves the next turn usable', async () => {
    const actor = await liveActor('hr');
    const serviceUnderTest = service();
    const request = 'ฉันติดต่อหาผู้เกี่ยวข้องคนไหนได้บ้าง';
    planner.reply(plan(clarifyStep({ kind: 'query' }, 'contactTopic', 'ต้องการติดต่อเรื่องข้อมูลพนักงานหรือสิทธิ์บัตรครับ')));
    const effectsBefore = await effectCounts();

    const original = await serviceUnderTest.turn(actor, request, undefined, undefined, REQUEST_IDENTITY);
    const firstRequest = (await fixture.store.list<Record<string, unknown> & { name?: string; turnId?: string; status?: string }>('tool_executions'))
      .find((row) => row.name === 'chat.turn_request' && row.turnId === original.turnId);
    const reloadedService = service();
    const persistedAssistant = (await reloadedService.getWorkspace(actor)).messages.find((message) => message.id === original.assistantMessageId);
    const replay = await reloadedService.turn(actor, request, undefined, undefined, REQUEST_IDENTITY);
    const recovery = await reloadedService.recoverTurn(actor, { contractVersion: 2, requestKey: REQUEST_IDENTITY.requestKey, message: request });
    const assistantsAfterReplay = (await reloadedService.getWorkspace(actor)).messages
      .filter((message) => message.conversationId === original.conversationId && message.role === 'assistant');

    expect(original).toMatchObject({ mode: 'live_ai', clarification: true });
    expect(original.message).toContain('ต้องการติดต่อ');
    expect(original.pendingAction).toBeUndefined();
    expect(original.pendingActions).toBeUndefined();
    expect(original.receipt).toBeUndefined();
    expect(original.receipts).toBeUndefined();
    expect(original.sources).toBeUndefined();
    expect(original.message).not.toMatch(/@[\w.-]+|\b0\d{8,}\b|\bLINE\b|\bSlack\b/iu);
    expect(persistedAssistant).toMatchObject({ text: original.message, mode: 'live_ai' });
    expect(firstRequest).toMatchObject({ status: 'completed' });
    expect(await completionOf(original, actor)).toMatchObject({ status: 'completed', assistantMessageId: original.assistantMessageId });
    expect(planner.calls).toHaveLength(1);
    expect(replay).toMatchObject({ message: original.message, assistantMessageId: original.assistantMessageId, replayed: true });
    expect(recovery).toMatchObject({ status: 'completed', response: { message: original.message, assistantMessageId: original.assistantMessageId, replayed: true } });
    expect(assistantsAfterReplay).toHaveLength(1);

    planner.reply(plan(conversationStep('capability', 'ได้ครับ')));
    const next = await reloadedService.turn(actor, 'Tell me which capabilities are available to my account.', original.conversationId, undefined,
      { contractVersion: 2, requestKey: 'chat-stream-contact-hr-next-0001' });
    expect(await completionOf(next, actor)).toMatchObject({ status: 'completed' });
    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[1]!.context.pendingClarification).toMatchObject({ about: 'query', missing: ['contactTopic'] });
    expect((await reloadedService.getWorkspace(actor)).messages
      .filter((message) => message.conversationId === original.conversationId && message.role === 'assistant')).toHaveLength(2);
    expect(await effectCounts()).toEqual(effectsBefore);
  });

  it('clarifies an unsupported stakeholder-list request after an East read and leaves the next turn usable', async () => {
    const actor = await liveActor();
    // Turn order is decided by createdAt, so this conversation needs a clock that moves between turns.
    let tick = 0;
    const serviceUnderTest = service(fixture.store, () => new Date(FIXED_NOW.getTime() + 1_000 * tick++));
    const participantRequest = 'เพิ่มรายชื่อผู้เกี่ยวข้องเข้าไปด้วย';
    planner.sequence(
      eastRead,
      // A query clarification carries the question: a dashboard.create title/source question is the Dashboard target offer (G5) by design.
      plan(clarifyStep({ kind: 'query' }, 'participants', 'ต้องการเพิ่มผู้เกี่ยวข้องคนใดครับ')),
      eastRead,
    );
    const first = await withDeadline(
      serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, { contractVersion: 2, requestKey: 'chat-participants-east-read-01' }),
      'grounded East read',
    );
    expect(first.sources?.map(source => source.id)).toEqual(['sales:E02:2026-10-01']);
    const effectsBefore = await effectCounts();

    const deltas: string[] = [];
    const statuses: string[] = [];
    const clarification = await withDeadline(
      serviceUnderTest.turn(actor, participantRequest, first.conversationId, undefined, { contractVersion: 2, requestKey: 'chat-participants-east-clarify-01' }, {
        onTextDelta: (text) => { deltas.push(text); },
        onStatus: (status) => { statuses.push(status); },
      }),
      'participant clarification',
    );
    const persistedAssistant = await fixture.store.get<{ text: string; turnId?: string; pendingActionId?: string; pendingActionIds?: string[] }>(
      'conversation_messages', clarification.assistantMessageId);

    expect(clarification).toMatchObject({ mode: 'live_ai', clarification: true });
    expect(clarification.message).toContain('ต้องการเพิ่มผู้เกี่ยวข้องคนใดครับ');
    expect(clarification.message).not.toMatch(/@|\b0\d{8,}\b|\bE\d{3}\b|คุณสมชาย|คุณสมศรี/iu);
    expect(clarification.pendingAction).toBeUndefined();
    expect(clarification.pendingActions).toBeUndefined();
    expect(clarification.sources).toBeUndefined();
    expect(persistedAssistant).toMatchObject({ text: clarification.message, turnId: clarification.turnId });
    expect(persistedAssistant?.pendingActionId).toBeUndefined();
    expect(persistedAssistant?.pendingActionIds).toBeUndefined();
    expect((await fixture.store.list<Record<string, unknown> & { name?: string; turnId?: string; status?: string }>('tool_executions'))
      .find((row) => row.name === 'chat.turn_request' && row.turnId === clarification.turnId)).toMatchObject({ status: 'completed' });
    expect(await completionOf(clarification, actor)).toMatchObject({ status: 'completed', assistantMessageId: clarification.assistantMessageId });
    expect(deltas).toEqual([clarification.message]);
    expect(statuses).toContain('saving');
    expect(planner.calls).toHaveLength(2);
    expect((await serviceUnderTest.getWorkspace(actor)).messages
      .filter((message) => message.conversationId === first.conversationId && message.role === 'assistant')).toHaveLength(2);

    const next = await withDeadline(
      serviceUnderTest.turn(actor, 'ดำเนินการต่อโดยไม่ใส่รายชื่อ 2026-10-01 East', first.conversationId, undefined, { contractVersion: 2, requestKey: 'chat-participants-east-next-01' }),
      'next chat turn after clarification',
    );
    expect(planner.calls[2]!.context.pendingClarification).toMatchObject({ about: 'query', missing: ['participants'] });
    expect(next.sources?.map(source => source.id)).toEqual(['sales:E02:2026-10-01']);
    expect(next.clarification).toBeUndefined();
    expect(await effectCounts()).toEqual(effectsBefore);
  });

  // ---------------------------------------------------------------------------------------- completion markers
  it('allows a standalone prepared action to confirm through its standalone completion marker', async () => {
    const serviceUnderTest = service();
    const action = await serviceUnderTest.prepare(actors.executive, await ticketPayload(serviceUnderTest, actors.executive));
    const completion = await fixture.store.get<Record<string, unknown>>('tool_executions', turnCompletionId({
      actorId: action.actorId, sessionId: action.sessionId, conversationId: action.conversationId, turnId: action.turnId,
    }));

    expect(completion).toMatchObject({ name: 'chat.turn_completion', origin: 'standalone_prepare', status: 'completed' });
    const receipt = await serviceUnderTest.confirm(actors.executive, action.id);
    expect(receipt).toMatchObject({ visibility: 'full', actionId: action.id, status: 'verified_success' });
    expect(await fixture.store.list('mock_tickets')).toHaveLength(1);
  });

  it('denies confirmation when the action completion marker is missing', async () => {
    const serviceUnderTest = service();
    const action = await serviceUnderTest.prepare(actors.executive, await ticketPayload(serviceUnderTest, actors.executive));
    const completionId = turnCompletionId({
      actorId: action.actorId, sessionId: action.sessionId, conversationId: action.conversationId, turnId: action.turnId,
    });

    expect(await fixture.store.get('tool_executions', completionId)).toBeDefined();
    await fixture.store.transaction((tx) => tx.remove('tool_executions', completionId));

    await expect(serviceUnderTest.confirm(actors.executive, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
    expect(await fixture.store.get('tool_executions', completionId)).toBeUndefined();
    expect(await fixture.store.get('action_executions', 'execution_' + action.id)).toBeUndefined();
    expect(await fixture.store.list('mock_tickets')).toHaveLength(0);
  });

  it('denies confirmation for an action whose chat turn failed after preparation', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(() => plan(ticketCreateStep(['E02'], 'E02')));

    await expect(serviceUnderTest.turn(actor, 'Prepare an East review ticket for E02.', undefined, undefined, REQUEST_IDENTITY, {
      onStatus: (status) => { if (status === 'saving') throw new Error('The deterministic provider failed.'); },
    })).rejects.toThrow('The deterministic provider failed.');
    const [action] = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
    if (!action) throw new Error('The turn did not prepare the test action.');
    expect(await completionOf(action, actor)).toMatchObject({ status: 'failed' });

    await expect(serviceUnderTest.confirm(actor, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
    expect(await fixture.store.get('action_executions', 'execution_' + action.id)).toBeUndefined();
    expect(await fixture.store.list('mock_tickets')).toHaveLength(0);
  });

  it('marks a prepared chat action unconfirmable when its turn is cancelled', async () => {
    const actor = await liveActor();
    const controller = new AbortController();
    const serviceUnderTest = service();
    planner.reply(() => plan(ticketCreateStep(['E02'], 'E02')));

    await expect(withDeadline(serviceUnderTest.turn(actor, 'Prepare an East review ticket for E02.', undefined, undefined, REQUEST_IDENTITY, {
      signal: controller.signal,
      // The proposal exists when the turn reaches `saving`; the caller cancels there.
      onStatus: (status) => { if (status === 'saving') controller.abort(new DOMException('The test cancelled the turn.', 'AbortError')); },
    }), 'cancelled turn')).rejects.toThrow();

    const [action] = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });
    if (!action) throw new Error('The turn did not prepare the test action.');
    expect(await completionOf(action, actor)).toMatchObject({ status: 'failed', failureReason: 'turn_cancelled' });
    await expect(serviceUnderTest.confirm(actor, action.id)).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
    expect(await fixture.store.get('action_executions', 'execution_' + action.id)).toBeUndefined();
    expect(await fixture.store.list('mock_tickets')).toHaveLength(0);
  });

  it('denies appending a prepared action after a chat turn is already completed', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    const response = await serviceUnderTest.turn(actor, 'Please clarify my request.', undefined, undefined, REQUEST_IDENTITY, {});
    const before = await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id });

    await expect(serviceUnderTest.prepare(actor, await ticketPayload(serviceUnderTest, actor), {
      conversationId: response.conversationId, turnId: response.turnId,
    })).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });

    expect(await fixture.store.list('pending_actions', { actorId: actor.id })).toEqual(before);
    expect(await fixture.store.get('conversation_messages', response.assistantMessageId)).toMatchObject({
      id: response.assistantMessageId, turnId: response.turnId,
    });
  });

  it('replays and recovers a keyed completion read-only without rerunning the planner or tools', async () => {
    const actor = await liveActor();
    const tracked = trackWrites(fixture.store);
    const serviceUnderTest = service(tracked.store);
    planner.reply(eastRead);
    const original = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    const persistedAssistant = await fixture.store.get<{ text: string }>('conversation_messages', original.assistantMessageId);
    expect(original.message).toContain('1,500.00');
    expect(persistedAssistant?.text).toBe(original.message);
    const writesAfterCompletion = tracked.writes();
    const reads = vi.spyOn(serviceUnderTest, 'queryEvidence');
    const replayStarts: TurnStarted[] = [];
    const duplicate = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {
      onStarted: (event) => { replayStarts.push(event); },
    });
    const recovered = await serviceUnderTest.recoverTurn(actor, { contractVersion: 2, requestKey: REQUEST_IDENTITY.requestKey, message: READ_MESSAGE });

    expect(duplicate).toMatchObject({
      conversationId: original.conversationId, turnId: original.turnId, assistantMessageId: original.assistantMessageId,
      message: original.message, replayed: true,
    });
    expect(replayStarts).toEqual([{
      conversationId: original.conversationId, turnId: original.turnId, assistantMessageId: original.assistantMessageId,
      mode: 'live_ai', replayed: true,
    }]);
    expect(recovered).toMatchObject({ status: 'completed', response: {
      conversationId: original.conversationId, turnId: original.turnId, assistantMessageId: original.assistantMessageId,
      message: original.message, replayed: true,
    } });
    expect(planner.calls).toHaveLength(1);
    expect(reads).not.toHaveBeenCalled();
    expect(tracked.writes()).toBe(writesAfterCompletion);
  });

  it('rejects a conflicting request key without planner, tool, or store writes', async () => {
    const actor = await liveActor();
    const tracked = trackWrites(fixture.store);
    const serviceUnderTest = service(tracked.store);
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await serviceUnderTest.turn(actor, 'Read the East sales report.', undefined, undefined, REQUEST_IDENTITY, {});
    const writesAfterCompletion = tracked.writes();

    await expect(serviceUnderTest.turn(actor, 'Read a different report.', undefined, undefined, REQUEST_IDENTITY, {}))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(planner.calls).toHaveLength(1);
    expect(tracked.writes()).toBe(writesAfterCompletion);
  });

  // ------------------------------------------------------------------------------------------ source redaction
  it.each([
    {
      label: 'read permission removal',
      shrink: (profile: Profile) => ({ ...profile, permissions: profile.permissions.filter((permission) => permission !== 'sales.read') }),
    },
    {
      label: 'region removal',
      shrink: (profile: Profile) => ({ ...profile, regions: profile.regions.filter((region) => region !== 'east') }),
    },
  ])('redacts completed sources after current authorization shrinks: $label', async ({ shrink }) => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(eastRead);
    const original = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    expect(original.message).toContain('1,500.00');

    await fixture.store.transaction(async (tx) => {
      const current = await tx.get<Profile>('profiles', actor.id);
      if (!current) throw new Error('The test profile is missing.');
      await tx.put('profiles', shrink(current));
    });

    const workspace = await serviceUnderTest.getWorkspace(actor);
    const visible = workspace.messages.find((item) => item.id === original.assistantMessageId);
    expect(visible?.text).toBe(AUTHORIZATION_REDACTION);
    expect(visible?.evidence).toBeUndefined();
    expect(visible?.sources).toBeUndefined();

    const recovered = await serviceUnderTest.recoverTurn(actor, { contractVersion: 2, requestKey: REQUEST_IDENTITY.requestKey, message: READ_MESSAGE });
    expect(recovered).toMatchObject({ status: 'completed', response: { message: AUTHORIZATION_REDACTION } });
  });

  it('redacts a completed answer after operations.read alone is revoked', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    planner.reply(eastRead);
    const original = await serviceUnderTest.turn(actor, READ_MESSAGE, undefined, undefined, REQUEST_IDENTITY, {});
    await fixture.store.transaction(async (tx) => {
      const current = await tx.get<Profile>('profiles', actor.id);
      if (!current) throw new Error('The test profile is missing.');
      await tx.put('profiles', { ...current, permissions: current.permissions.filter((permission) => permission !== 'operations.read') });
    });
    const visible = (await serviceUnderTest.getWorkspace(actor)).messages.find((item) => item.id === original.assistantMessageId);
    expect(visible?.text).toBe(AUTHORIZATION_REDACTION);
    expect(visible?.sources).toBeUndefined();
  });

  it('redacts a completed HR answer and its standalone source references when the HR grant is revoked', async () => {
    const actor = await liveActor();
    await fixture.store.transaction(async (tx) => {
      const current = await tx.get<Profile>('profiles', actor.id);
      if (!current) throw new Error('The test profile is missing.');
      await tx.put('profiles', { ...current, permissions: [...new Set([...current.permissions, 'hr.read'])] });
    });
    const message = 'Find employee E024';
    const { hrPlan } = await import('./dynamic/wave2/fixtures');
    const { filter } = await import('./dynamic/fixtures');
    planner.reply(plan({ kind: 'hr_query', plan: filter(hrPlan(message), message, 'employee_id', 'E024', 'E024') }));
    const serviceUnderTest = service();
    const response = await serviceUnderTest.turn(actor, message, undefined, undefined, REQUEST_IDENTITY, {});
    const stored = await fixture.store.get<{ sources?: { id: string }[] }>('conversation_messages', response.assistantMessageId);
    expect(stored?.sources?.length).toBeGreaterThan(0);
    expect(stored?.sources?.every((source) => source.id.startsWith('hr:'))).toBe(true);
    expect(response.message).toContain('E024');

    await fixture.store.transaction(async (tx) => {
      const current = await tx.get<Profile>('profiles', actor.id);
      if (!current) throw new Error('The test profile is missing.');
      await tx.put('profiles', { ...current, permissions: current.permissions.filter((permission) => permission !== 'hr.read') });
    });

    const visible = (await serviceUnderTest.getWorkspace(actor)).messages.find((item) => item.id === response.assistantMessageId);
    expect(visible?.text).toBe(AUTHORIZATION_REDACTION);
    expect(visible?.evidence).toBeUndefined();
    expect(visible?.sources).toBeUndefined();
    expect(visible?.analysis).toBeUndefined();
    expect(visible?.pendingActionId).toBeUndefined();
    expect(visible?.pendingActionIds).toBeUndefined();
  });

  it('keeps JSON and streamed responses aligned, including exact action references', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const message = 'Open a ticket for E02.';
    planner.reply(() => plan(ticketCreateStep(['E02'], 'E02')));
    const jsonResponse = await serviceUnderTest.turn(actor, message);
    const deltas: string[] = [];
    const streamedResponse = await serviceUnderTest.turn(actor, message, jsonResponse.conversationId, undefined, undefined, {
      onTextDelta: (text) => { deltas.push(text); },
    });

    const jsonAssistant = await fixture.store.get<Record<string, unknown>>('conversation_messages', jsonResponse.assistantMessageId);
    const streamedAssistant = await fixture.store.get<Record<string, unknown>>('conversation_messages', streamedResponse.assistantMessageId);
    expect(streamedResponse.message).toBe(jsonResponse.message);
    expect(deltas).toEqual([streamedResponse.message]);
    expect(streamedResponse.pendingAction?.payload).toEqual(jsonResponse.pendingAction?.payload);
    expect(jsonResponse.pendingAction).toBeDefined();
    expect(streamedResponse.pendingAction).toBeDefined();
    expect(jsonAssistant).toMatchObject({
      pendingActionId: jsonResponse.pendingAction?.id, pendingActionIds: [jsonResponse.pendingAction?.id],
    });
    expect(streamedAssistant).toMatchObject({
      pendingActionId: streamedResponse.pendingAction?.id, pendingActionIds: [streamedResponse.pendingAction?.id],
    });
  });

  // -------------------------------------------------------------------------------------- pending-proposal refinement
  it('revises the exact completed chat proposal in the admitted turn and preserves approval until confirmation', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-refine-create-001');

    const request = 'Please update the dashboard title to "Reviewed East summary" and take out the staffing widget.';
    const identity = { contractVersion: 2 as const, requestKey: 'chat-dashboard-refine-revise-001' };
    const seenPending: string[][] = [];
    planner.reply((input: TurnPlannerInput) => {
      seenPending.push(input.context.pendingActions.map(item => item.id));
      return plan(reviseStep(predecessor.id, { title: 'Reviewed East summary', remove: [STAFFING_WIDGET_INDEX] }));
    });
    const revised = await serviceUnderTest.turn(actor, request, original.conversationId, undefined, identity);
    const replacement = revised.pendingAction;
    if (!replacement || replacement.payload.kind !== 'dashboard_create') throw new Error('The revised dashboard proposal is missing.');

    expect(seenPending).toEqual([[predecessor.id]]);
    expect(revised.message).toContain('ยังไม่ได้สร้าง');
    expect(replacement).toMatchObject({
      status: 'pending',
      predecessorActionId: predecessor.id,
      payload: {
        kind: 'dashboard_create',
        spec: {
          ...predecessor.payload.spec,
          title: 'Reviewed East summary',
          widgets: predecessor.payload.spec.widgets.filter((_, index) => index !== STAFFING_WIDGET_INDEX),
        },
      },
    });
    expect(replacement.revisionDiff).toEqual(expect.arrayContaining([
      expect.stringContaining('Reviewed East summary'),
      expect.stringContaining(predecessor.payload.spec.widgets[STAFFING_WIDGET_INDEX]!.title),
    ]));
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
      status: 'stale', staleReason: 'superseded', supersededByActionId: replacement.id,
    });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    const assistant = await fixture.store.get<{ turnId?: string; pendingActionIds?: string[] }>('conversation_messages', revised.assistantMessageId);
    expect(assistant).toMatchObject({ turnId: revised.turnId, pendingActionIds: [replacement.id] });
    expect(await completionOf(revised, actor)).toMatchObject({ status: 'completed', finalActionIds: [replacement.id] });

    const replay = await serviceUnderTest.turn(actor, request, original.conversationId, undefined, identity);
    expect(replay).toMatchObject({ replayed: true, pendingAction: { id: replacement.id } });
    expect(planner.calls).toHaveLength(2);
    await expect(serviceUnderTest.confirm(actor, predecessor.id)).rejects.toMatchObject({ code: 'STALE_ACTION' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    await serviceUnderTest.confirm(actor, replacement.id);
    expect(await fixture.store.list('dashboards')).toHaveLength(1);
    expect(await fixture.store.list('action_executions')).toHaveLength(1);
  });

  it('clarifies an underspecified participant addition without creating Action C or changing B', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-participants-create-01');
    planner.reply(plan(reviseStep(predecessor.id, { title: 'Reviewed East summary' })));
    const renamed = await serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, original.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-participants-revise-01',
    });
    const actionB = renamed.pendingAction;
    if (!actionB) throw new Error('Action B was not created.');
    const hashBefore = actionB.payloadHash;
    const plannerCallsBefore = planner.calls.length;

    const clarificationMessages: string[] = [];
    for (const [index, followUp] of [
      'เพิ่มรายชื่อผู้เกี่ยวข้องเข้าไปด้วย',
      'ช่วยใส่รายชื่อผู้เกี่ยวข้องเพิ่มด้วย',
      'Please include the stakeholder names too.',
    ].entries()) {
      planner.reply(plan(clarifyStep({ kind: 'refine', pendingActionId: actionB.id }, 'operation', 'โปรดระบุชื่อหรือรหัสพนักงานที่ต้องการเพิ่มครับ')));
      const clarification = await serviceUnderTest.turn(actor, followUp, original.conversationId, undefined, {
        contractVersion: 2, requestKey: `chat-dashboard-participants-clarify-${index + 1}`,
      });
      expect(clarification.clarification).toBe(true);
      expect(clarification.pendingAction).toBeUndefined();
      expect(clarification.message).toContain('โปรดระบุชื่อหรือรหัสพนักงาน');
      expect(clarification.message).not.toMatch(/@|\b0\d{8,}\b|E\d{3}/u);
      clarificationMessages.push(clarification.message);
    }

    expect(new Set(clarificationMessages).size).toBe(1);
    expect(planner.calls.length - plannerCallsBefore).toBe(3);
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(2);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'stale' });
    expect(await fixture.store.get<PendingAction>('pending_actions', actionB.id)).toMatchObject({ status: 'pending', payloadHash: hashBefore });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('clarifies instead of revising when the planner cannot pick one of several matching widgets', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-widget-create-01');
    planner.reply(plan(clarifyStep({ kind: 'refine', pendingActionId: predecessor.id }, 'removeWidgetIndexes', 'มีมุมมองที่ใกล้เคียงกันหลายรายการ ต้องการลบรายการใดครับ')));
    const response = await serviceUnderTest.turn(actor, 'Remove the staffing widget.', original.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-widget-clarify-01',
    });

    expect(response.clarification).toBe(true);
    expect(response.message).toContain('หลายรายการ');
    expect(response.pendingAction).toBeUndefined();
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(1);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'pending', payloadHash: predecessor.payloadHash });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('rejects forged or foreign refinement targets without replacing the pending proposal', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-forged-create-001');
    // A proposal that belongs to another conversation of the same actor is not in this conversation's planner context.
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
    const foreignTurn = await serviceUnderTest.turn(actor, 'Open a ticket for E02.', undefined, undefined, { contractVersion: 2, requestKey: 'chat-dashboard-forged-other-001' });
    const foreign = { response: foreignTurn, proposal: foreignTurn.pendingAction! };
    expect(foreign.proposal.payload.kind).toBe('ticket_create');
    expect(foreign.response.conversationId).not.toBe(original.conversationId);
    for (const [targetId, requestKey] of [
      ['action-from-another-conversation', 'chat-dashboard-forged-id-0001'],
      [foreign.proposal.id, 'chat-dashboard-forged-other-0002'],
    ] as const) {
      planner.reply(plan(reviseStep(targetId, { title: 'Reviewed East summary' })));
      const response = await serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, original.conversationId, undefined, { contractVersion: 2, requestKey });
      expect(response.clarification).toBe(true);
      expect(response.pendingAction).toBeUndefined();
    }
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(2);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'pending', payloadHash: predecessor.payloadHash });
    expect(await fixture.store.get<PendingAction>('pending_actions', foreign.proposal.id)).toMatchObject({ status: 'pending', payloadHash: foreign.proposal.payloadHash });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('leaves a pending proposal untouched when the plan is not a refinement of it', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-negation-create-01');
    const plans: Array<(input: TurnPlannerInput) => unknown> = [
      () => plan(conversationStep('acknowledgement', 'รับทราบครับ')),
      () => plan(clarifyStep({ kind: 'refine', pendingActionId: predecessor.id }, 'operation', 'ต้องการแก้ไขส่วนใดครับ')),
      eastRead,
    ];
    for (const [index, reply] of plans.entries()) {
      planner.reply(reply);
      const response = await serviceUnderTest.turn(actor, index === 2 ? READ_MESSAGE : 'Do not remove the staffing widget.', original.conversationId, undefined, {
        contractVersion: 2, requestKey: `chat-dashboard-negation-${index + 1}`,
      });
      expect(response.pendingAction).toBeUndefined();
      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id))
        .toMatchObject({ status: 'pending', payloadHash: predecessor.payloadHash });
    }
    expect(planner.calls).toHaveLength(4);
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(1);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('keeps a read-only turn from changing the pending proposal and never executes a second proposal', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-continue-create-01');
    planner.reply(eastRead);
    const readResponse = await serviceUnderTest.turn(actor, READ_MESSAGE, original.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-continue-read-01',
    });
    expect(readResponse.sources?.length).toBeGreaterThan(0);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'pending', payloadHash: predecessor.payloadHash });

    // A new write while a proposal is pending is still only a proposal behind confirmation; it never executes.
    planner.reply(plan(dashboardCreateStep('Another dashboard')));
    await serviceUnderTest.turn(actor, 'Create a new dashboard for East sales.', original.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-continue-new-write-01',
    });
    for (const action of await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })) {
      expect(['pending', 'stale']).toContain(action.status);
    }
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('does not let chat revise a standalone proposal that has no completed chat proof', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const predecessor = await serviceUnderTest.prepare(actor, {
      kind: 'dashboard_create',
      spec: { title: 'Standalone', description: 'Standalone proposal', scope: { region: 'east', date: BUSINESS_DATE, branchIds: ['E02'] },
        widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }] },
    });
    planner.reply(plan(reviseStep(predecessor.id, { title: 'Reviewed East summary' })));
    const response = await serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, predecessor.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-unproven-standalone-01',
    });

    expect(response.pendingAction).toBeUndefined();
    expect(response.clarification).toBe(true);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'pending' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('clarifies a revision request for a completed chat proposal instead of treating it as a new write', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: action } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-completed-create-01');
    await serviceUnderTest.confirm(actor, action.id);
    const seenPending: string[][] = [];
    planner.reply((input: TurnPlannerInput) => {
      seenPending.push(input.context.pendingActions.map(item => item.id));
      return plan(reviseStep(action.id, { title: 'Reviewed East summary' }));
    });
    const response = await serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, original.conversationId, undefined, {
      contractVersion: 2, requestKey: 'chat-dashboard-completed-revise-01',
    });

    expect(seenPending).toEqual([[]]);
    expect(response.clarification).toBe(true);
    expect(response.pendingAction).toBeUndefined();
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({ status: 'completed' });
    expect(await fixture.store.list('dashboards')).toHaveLength(1);
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(1);
  });

  it('does not revise expired, out-of-scope, permission-revoked, evidence-stale, or wrong-mode proposals', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-filter-create-01');
    const attempt = async (target: ConciergeService, title: string, requestKey: string) => {
      planner.reply(plan(reviseStep(predecessor.id, { title })));
      const response = await target.turn(actor, `Rename the dashboard title to "${title}".`, original.conversationId, undefined, { contractVersion: 2, requestKey });
      expect(response.clarification).toBe(true);
      expect(response.pendingAction).toBeUndefined();
      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id))
        .toMatchObject({ status: 'pending', payloadHash: predecessor.payloadHash });
    };
    await attempt(service(fixture.store, () => new Date(FIXED_NOW.getTime() + 25 * 3_600_000)), 'After expiry', 'chat-dashboard-filter-expired-01');

    const originalProfile = await fixture.store.get<Profile>('profiles', actor.id);
    if (!originalProfile) throw new Error('The synthetic profile is missing.');
    await fixture.store.transaction(tx => tx.put('profiles', { ...originalProfile, permissions: originalProfile.permissions.filter(permission => permission !== 'dashboard.create') }));
    await attempt(serviceUnderTest, 'Without permission', 'chat-dashboard-filter-permission-01');
    await fixture.store.transaction(tx => tx.put('profiles', originalProfile));

    await fixture.store.transaction(tx => tx.put('profiles', { ...originalProfile, regions: ['central'] }));
    await attempt(serviceUnderTest, 'Outside scope', 'chat-dashboard-filter-scope-01');
    await fixture.store.transaction(tx => tx.put('profiles', originalProfile));

    const originalSale = await fixture.store.get<{ id: string; amountSatang: number }>('sales_orders', 'SO-E02-PAID');
    if (!originalSale) throw new Error('The synthetic sales row is missing.');
    await fixture.store.transaction(tx => tx.put('sales_orders', { ...originalSale, amountSatang: originalSale.amountSatang + 1 }));
    await attempt(serviceUnderTest, 'Stale evidence', 'chat-dashboard-filter-evidence-01');
    await fixture.store.transaction(tx => tx.put('sales_orders', originalSale));

    await fixture.patchSession(actor.sessionId, { mode: 'scripted_demo', modeRevision: 2 });
    await attempt(serviceUnderTest, 'Wrong mode', 'chat-dashboard-filter-mode-01');

    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(1);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  }, 10_000);

  it('lets only one concurrent chat request revise a shared pending predecessor', async () => {
    const actor = await liveActor();
    const serviceUnderTest = service();
    const { response: original, proposal: predecessor } = await createProposal(serviceUnderTest, actor, 'chat-dashboard-race-create-001');
    const bothPlanned = deferred<void>();
    let plannerCalls = 0;
    planner.reply(async () => {
      plannerCalls += 1;
      if (plannerCalls === 2) bothPlanned.resolve();
      await withDeadline(bothPlanned.promise, 'both chat refinement plans');
      return plan(reviseStep(predecessor.id, { title: 'Reviewed East summary' }));
    });
    const [first, second] = await withDeadline(Promise.all([
      serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, original.conversationId, undefined, { contractVersion: 2, requestKey: 'chat-dashboard-race-request-001' }),
      serviceUnderTest.turn(actor, NEW_TITLE_REQUEST, original.conversationId, undefined, { contractVersion: 2, requestKey: 'chat-dashboard-race-request-002' }),
    ]), 'both serialized chat refinements');
    const winners = [first, second].filter(response => response.pendingAction?.id !== undefined);
    const losers = [first, second].filter(response => response.clarification === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.pendingAction).toBeUndefined();
    expect(plannerCalls).toBe(2);
    expect(await fixture.store.list<PendingAction>('pending_actions', { actorId: actor.id })).toHaveLength(2);
    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'stale' });
    expect(await fixture.store.get<PendingAction>('pending_actions', winners[0]?.pendingAction?.id ?? '')).toMatchObject({ status: 'pending' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });
});
