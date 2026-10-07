import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionPayload, Actor, StoredRow, Store, Table, Ticket, Transaction } from '../lib/contracts';
import { DomainError } from '../lib/core/errors';
import { RuntimeCatalog } from '../lib/core/runtime-catalog';
import { ConciergeService } from '../lib/core/service';
import type { PackPrepareContext, PackReadContext, TrustedPackRuntime } from '../lib/core/runtime-contracts';
import { createSeedData } from '../lib/seed/generate';
import { createSqliteStore } from '../lib/storage/sqlite';
import { hrRuntime } from '../lib/packs/hr-runtime';
import { operationsRuntime } from '../lib/packs/operations-runtime';
import { salesRuntime } from '../lib/packs/sales-runtime';
import {
  actors,
  BUSINESS_DATE,
  CLOSED_BUSINESS_DATE,
  createWorkspaceFixture,
  dashboardPayload,
  FIXED_NOW,
  loseOneTicketCommitResponse,
} from './helpers/workspace';
import {
  baseQueryPlan, clarifyStep, conversationStep, plan, planner, regionQueryStep, ticketCreateStep,
} from './helpers/turn-planner';

import type { TurnPlannerInput } from '@/lib/router/planner/input';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

/** A region query whose interpretation spans are fully located in `message` (the shared helper emits span-less text). */
function regionQuery(input: Parameters<typeof regionQueryStep>[0], message: string, regionText: string, dateText: string,
  measures: Array<[fieldId: string, text: string]> = [], regionId = 'east') {
  const span = (text: string) => ({ start: message.indexOf(text), end: message.indexOf(text) + text.length, text });
  const step = regionQueryStep(input, regionId, regionText, '2026-10-01', dateText);
  const query = step.plan as { dimensions: Array<{ interpretation: { sourceText: unknown } }>; measures: unknown[] };
  query.dimensions[0]!.interpretation.sourceText = span(regionText);
  if (measures.length) query.measures = measures.map(([fieldId, text]) => ({
    fieldId, aggregation: 'sum', interpretation: { value: fieldId, source: 'explicit', sourceText: span(text), confidence: 1 } }));
  return step;
}

/** An hr_query step for employee E024 whose evidence is located in `message`. */
function hrEmployeeStep(input: Parameters<typeof regionQueryStep>[0], message: string) {
  const query = baseQueryPlan(input.context, {
    datasetId: 'hr_employees',
    measures: [{ fieldId: 'headcount', aggregation: 'count', interpretation: { value: 'headcount', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [],
    filters: [{ fieldId: 'employee_id', op: 'eq', value: 'E024', source: 'explicit', evidenceText: 'E024',
      sourceText: { start: message.indexOf('E024'), end: message.indexOf('E024') + 4, text: 'E024' }, confidence: 1 }],
    time: null, grain: ['employee_id'], aggregation: 'rows', group: { fieldIds: [] },
  });
  return { kind: 'hr_query', plan: query };
}

const demoIdentity = (requestKey: string, demoShowcaseId: string) => ({ contractVersion: 2 as const, requestKey, demoShowcaseId });

type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

async function makeTicketPayload(
  service: ConciergeService,
  actor: Actor,
  branchIds: string[],
  region: string,
): Promise<Extract<ActionPayload, { kind: 'ticket_create' }>> {
  const evidence = await service.queryEvidence(actor, {
    region,
    date: CLOSED_BUSINESS_DATE,
    branchIds,
  });
  const assignees: Record<string, string> = { E02: 'E024', C01: 'C001' };
  return {
    kind: 'ticket_create',
    scope: evidence.scope,
    targets: evidence.branches.map((branch) => ({
      branchId: branch.branchId,
      assigneeId: assignees[branch.branchId] ?? 'E024',
      title: 'Review branch ' + branch.branchId,
      reason: 'Synthetic review target for accepted regression coverage.',
      sourceIds: [...branch.sourceIds],
      unansweredQuestion: 'Which evidence would explain the result?',
    })),
  };
}

interface StoreFaults {
  failTicket?: (row: StoredRow) => boolean;
  ticketFailure?: unknown;
  dropFirstDemoWriteTo?: Table;
}

function faultStore(base: Store, faults: StoreFaults = {}) {
  let ticketWrites = 0;
  let droppedDemoWrites = 0;
  return {
    adapter: base.adapter,
    list: <T>(table: Table) => base.list<T>(table),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      return base.transaction(async (tx) => {
        const intercepted: Transaction = {
          list: <R>(table: Table, filters?: Parameters<Transaction['list']>[1]) => tx.list<R>(table, filters),
          get: <R>(table: Table, id: string) => tx.get<R>(table, id),
          put: async <R extends { id: string }>(table: Table, value: R) => {
            const row = value as StoredRow;
            if (table === 'mock_tickets' && faults.failTicket?.(row)) {
              throw faults.ticketFailure ?? new Error('Injected ticket target failure');
            }
            if (table === 'mock_tickets') ticketWrites += 1;
            if (table === faults.dropFirstDemoWriteTo && typeof row.operationKey === 'string' && droppedDemoWrites === 0) {
              droppedDemoWrites += 1;
              await tx.remove(table, row.id);
              return;
            }
            await tx.put(table, value);
          },
          remove: (table: Table, id: string) => tx.remove(table, id),
        };
        return work(intercepted);
      });
    },
    close: () => base.close?.(),
    ticketWriteCount: () => ticketWrites,
    droppedDemoWriteCount: () => droppedDemoWrites,
  };
}

function hideOneTicketReadbackAfterCommitLoss(
  base: Store & { targetCommitCount(): number },
): Store {
  let hideNextTicketRead = false;
  return {
    adapter: base.adapter,
    list: <T>(table: Table) => base.list<T>(table),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const commitsBefore = base.targetCommitCount();
      let wroteTicketTarget = false;
      try {
        return await base.transaction((tx) => work({
          list: <R>(table: Table, filters?: Parameters<Transaction['list']>[1]) => tx.list<R>(table, filters),
          get: async <R>(table: Table, id: string) => {
            if (hideNextTicketRead && table === 'mock_tickets') {
              hideNextTicketRead = false;
              return undefined;
            }
            return tx.get<R>(table, id);
          },
          put: <R extends { id: string }>(table: Table, value: R) => {
            if (table === 'mock_tickets') wroteTicketTarget = true;
            return tx.put(table, value);
          },
          remove: (table: Table, id: string) => tx.remove(table, id),
        }));
      } catch (error) {
        if (wroteTicketTarget && base.targetCommitCount() > commitsBefore) hideNextTicketRead = true;
        throw error;
      }
    },
    close: () => base.close?.(),
  };
}

async function createFullSeedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-tests-review-'));
  const store = createSqliteStore(join(directory, 'private.sqlite'));
  try {
    const seed = createSeedData(BUSINESS_DATE);
    const today = <T extends { date: string }>(rows: T[]) => rows.filter((row) => row.date === BUSINESS_DATE);
    const rows: Array<[Table, Array<{ id: string }>] > = [
      ['profiles', seed.profiles],
      ['branches', seed.branches],
      ['products', seed.products],
      ['sales_orders', today(seed.sales_orders)],
      ['sales_targets', today(seed.sales_targets)],
      ['inventory_snapshots', today(seed.inventory_snapshots)],
      ['incidents', today(seed.incidents)],
      ['staffing_summaries', today(seed.staffing_summaries)],
      ['employees', seed.employees],
      ['policy_documents', seed.policy_documents],
      ['mock_badges', seed.mock_badges],
      ['sessions', Object.values(actors).map((actor) => ({
        id: actor.sessionId,
        profileId: actor.id,
        mode: actor.mode,
        modeRevision: actor.modeRevision,
        csrfToken: 'private-review-csrf',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }))],
    ];
    await store.transaction(async (tx) => {
      for (const [table, values] of rows) {
        for (const value of values) await tx.put(table, value);
      }
    });
    const service = new ConciergeService(store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
    return {
      store,
      service,
      async dispose() {
        store.close?.();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function captureToolContext(runtime: TrustedPackRuntime, toolName: string, captured: string[][]): TrustedPackRuntime {
  const tool = runtime.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error('Missing runtime tool ' + toolName);
  const originalRun = tool.run as (
    context: PackReadContext | PackPrepareContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  const wrapped = {
    ...tool,
    run: async (context: PackReadContext | PackPrepareContext, args: Record<string, unknown>) => {
      captured.push(Object.keys(context));
      return originalRun(context, args);
    },
  };
  return {
    ...runtime,
    tools: runtime.tools.map((candidate) => candidate.name === toolName ? wrapped : candidate),
  } as TrustedPackRuntime;
}

describe('accepted review regressions in the service boundary', () => {
  let fixture!: WorkspaceFixture;

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

  async function live(actor: Actor): Promise<Actor> {
    await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actor, mode: 'live_ai', modeRevision: 1 };
  }

  it('answers an HR employee lookup in Scripted Demo with HR evidence and denies HR sales reads', async () => {
    const answer = await fixture.service.turn(actors.hr, 'Find employee E024.', undefined, undefined, demoIdentity('review-hr-employee-key-001', 'hr-employee'));
    // Source ids are server-minted population digests now (no longer per-employee ids); they must still be HR-system evidence the fact cites.
    const sourceIds = answer.sources?.map((source) => source.id) ?? [];
    expect(sourceIds.length).toBeGreaterThan(0);
    expect(answer.sources?.every((source) => source.system === 'hr' && source.id.startsWith('hr:'))).toBe(true);
    expect(answer.analysis?.facts[0]?.sourceIds.length).toBeGreaterThan(0);
    expect(answer.analysis?.facts[0]?.sourceIds.every((sourceId) => sourceIds.includes(sourceId))).toBe(true);
    expect(answer.message).toContain('Synthetic Employee E024');

    // Structured equivalent of the old typed-text sales read: the planner asks for East sales as an HR actor.
    const liveHr = await live(actors.hr);
    const salesMessage = 'Show East sales totals for 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, salesMessage, 'East', '2026-10-01')));
    const denied = await fixture.service.turn(liveHr, salesMessage);
    expect(denied).toMatchObject({ clarification: true });
    // Refusals say what was understood (from the plan's registered kind) before the authorization reason.
    expect(denied.message).toContain('บัญชีนี้ไม่มีสิทธิ์ทำรายการหรือดูข้อมูลตามคำขอนี้ จึงยังไม่ได้ดำเนินการใด ๆ');
    expect(denied.sources).toBeUndefined();
    expect(denied.analysis).toBeUndefined();
    const afterDeniedSales = await fixture.service.getWorkspace(liveHr);
    expect(JSON.stringify(afterDeniedSales.messages)).not.toContain('SO-E02-PAID');
    expect(JSON.stringify(afterDeniedSales.messages)).not.toContain('net_sales');
    expect(await fixture.store.list('tool_executions', { actorId: liveHr.id })
      .then(rows => (rows as { name?: string }[]).filter(row => row.name === 'retail.dynamic_query'))).toEqual([]);
  });

  it('keeps a persisted HR employee answer readable in the workspace history', async () => {
    const answer = await fixture.service.turn(actors.hr, 'Find employee E024.', undefined, undefined, demoIdentity('review-hr-history-key-0001', 'hr-employee'));
    const sourceIds = answer.sources?.map((source) => source.id) ?? [];
    const workspace = await fixture.service.getWorkspace(actors.hr);
    const assistant = workspace.messages.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.sources?.map((source) => source.id)).toEqual(sourceIds);
    expect(JSON.stringify(assistant)).toContain('Synthetic Employee E024');
  });

  it('redacts old operations evidence and analysis after operations.read is revoked while sales and East remain', async () => {
    const liveEast = await live(actors.east);
    const opsMessage = 'Check inventory and incidents in East on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, opsMessage, 'East', '2026-10-01', [['stock_issues', 'inventory'], ['incident_count', 'incidents']])));
    const answered = await fixture.service.turn(liveEast, opsMessage);
    expect(answered.sources?.some((source) => source.system === 'inventory' || source.system === 'incidents')).toBe(true);
    await fixture.store.transaction(async (tx) => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'east');
      if (!profile) throw new Error('Missing East profile fixture.');
      await tx.put('profiles', {
        ...profile,
        permissions: ['sales.read', 'dashboard.create', 'dashboard.share', 'ticket.create'],
        regions: ['east'],
      });
    });

    const workspace = await fixture.service.getWorkspace(actors.east);
    expect(workspace.actor.permissions).toContain('sales.read');
    expect(workspace.actor.regions).toEqual(['east']);
    const assistant = workspace.messages.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.text).toBe('ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน');
    expect(assistant?.analysis).toBeUndefined();
    expect(assistant?.evidence).toBeUndefined();
    expect(assistant?.sources).toBeUndefined();
  });

  it('hides a pending operations approval when operations.read is revoked but sales and region remain', async () => {
    const payload = await makeTicketPayload(fixture.service, actors.east, ['E02'], 'east');
    const pending = await fixture.service.prepare(actors.east, payload);
    await fixture.store.transaction(async (tx) => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'east');
      if (!profile) throw new Error('Missing East profile fixture.');
      await tx.put('profiles', {
        ...profile,
        permissions: ['sales.read', 'dashboard.create', 'dashboard.share', 'ticket.create'],
        regions: ['east'],
      });
    });

    const workspace = await fixture.service.getWorkspace(actors.east);
    expect(workspace.actions.some((action) => action.id === pending.id)).toBe(false);
  });

  it('hides an East approval after the current profile loses East scope', async () => {
    const pending = await fixture.service.prepare(actors.executive, dashboardPayload('east'));
    await fixture.store.transaction(async (tx) => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'executive');
      if (!profile) throw new Error('Missing Executive profile fixture.');
      await tx.put('profiles', { ...profile, regions: ['central'] });
    });

    const workspace = await fixture.service.getWorkspace(actors.executive);
    expect(workspace.actor.permissions).toContain('sales.read');
    expect(workspace.actor.regions).toEqual(['central']);
    expect(workspace.actions.some((action) => action.id === pending.id)).toBe(false);
    expect(workspace.receipts.some((receipt) => receipt.actionId === pending.id)).toBe(false);
  });

  // Ported from "returns 403 for live-AI broker attempts": the model no longer calls tools, so the structured equivalent is
  // a planner plan that reaches outside the actor's authority. The server denies it with the typed not-permitted text and
  // never reads or stores the out-of-scope evidence.
  it('denies live-AI plans outside regional and HR permissions without reading or storing the evidence', async () => {
    const liveEast = await live(actors.east);
    const centralMessage = 'Hello. Show Central sales on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, centralMessage, 'Central', '2026-10-01', [], 'central')));
    const centralRead = await fixture.service.turn(liveEast, centralMessage);
    expect(centralRead.clarification).toBe(true);
    expect(centralRead.message).toContain('อยู่นอกสิทธิ์ของบัญชีนี้');
    expect(centralRead.sources).toBeUndefined();

    const hrMessage = 'Hello again. Find employee E024.';
    planner.reply((input: TurnPlannerInput) => plan(hrEmployeeStep(input, hrMessage)));
    const hrRead = await fixture.service.turn(liveEast, hrMessage);
    expect(hrRead).toMatchObject({ clarification: true });
    expect(hrRead.message).not.toContain('Synthetic Employee E024');
    expect(hrRead.sources).toBeUndefined();

    const afterDenied = await fixture.service.getWorkspace(liveEast);
    expect(JSON.stringify(afterDenied.messages)).not.toContain('Central Confidential Branch');
    expect(JSON.stringify(afterDenied.messages)).not.toContain('Synthetic Employee E024');
    const executions = (await fixture.store.list<{ name?: string }>('tool_executions')).filter(row => row.name === 'retail.dynamic_query');
    expect(executions).toEqual([]);
  });

  it('does not return or store a live-AI amount hallucination: planner prose with an invented amount is replaced and evidence text comes from the server', async () => {
    const liveExecutive = await live(actors.executive);
    const fabricatedAmount = '987654321';
    // Prose path: a conversation step carrying an invented amount is dropped for server-owned capability text.
    planner.reply(plan(conversationStep('advice', `Net sales reached ${fabricatedAmount} THB.`)));
    const prose = await fixture.service.turn(liveExecutive, 'Compare sales in East.');
    expect(JSON.stringify(prose)).not.toContain(fabricatedAmount);
    // Clarify path: an invented amount in the question is replaced by the server template.
    planner.reply(plan(clarifyStep({ kind: 'query' }, 'interpretation', `Did you mean ${fabricatedAmount} THB?`)));
    const clarified = await fixture.service.turn(liveExecutive, 'Compare sales in East.', prose.conversationId);
    expect(JSON.stringify(clarified)).not.toContain(fabricatedAmount);
    // Evidence path: a real query answer carries sources and only executor-rendered numbers.
    const message = 'Compare sales in East on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, message, 'East', '2026-10-01')));
    const response = await fixture.service.turn(liveExecutive, message, prose.conversationId);
    const workspace = await fixture.service.getWorkspace(liveExecutive);
    const assistant = workspace.messages.filter((item) => item.role === 'assistant').at(-1);
    expect(JSON.stringify(response)).not.toContain(fabricatedAmount);
    expect(JSON.stringify(workspace.messages)).not.toContain(fabricatedAmount);
    expect(response.sources?.length).toBeGreaterThan(0);
    expect(assistant?.sources?.length).toBeGreaterThan(0);
  });

  it('stales a dashboard approval after its referenced branch is renamed', async () => {
    const pending = await fixture.service.prepare(actors.executive, dashboardPayload('east'));
    await fixture.store.transaction(async (tx) => {
      const branch = await tx.get<Record<string, unknown> & { id: string }>('branches', 'E02');
      if (!branch) throw new Error('Missing East branch fixture.');
      await tx.put('branches', { ...branch, name: 'Renamed East Two' });
    });

    await expect(fixture.service.confirm(actors.executive, pending.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(await fixture.store.list('dashboards')).toHaveLength(0);
  });

  it('marks a definitely-uncommitted ticket conflict failed and allows a fresh preparation', async () => {
    const conflict = Object.assign(new Error('known pre-commit conflict'), {
      code: 'CONFLICT',
      definitelyNotCommitted: true,
    });
    const wrapped = faultStore(fixture.store, {
      failTicket: (row) => row.branchId === 'E02',
      ticketFailure: conflict,
    });
    const service = new ConciergeService(wrapped, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
    const payload = await makeTicketPayload(service, actors.executive, ['E02'], 'east');
    const pending = await service.prepare(actors.executive, payload);
    const receipt = await service.confirm(actors.executive, pending.id);

    expect(receipt.status).toBe('failed');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'E02', status: 'failed' }),
    ]);
    expect(await wrapped.get<{ id: string }>('pending_actions', pending.id)).toMatchObject({ status: 'completed' });
    expect(await wrapped.list<Ticket>('mock_tickets')).toHaveLength(0);
    expect((await service.prepare(actors.executive, payload)).status).toBe('pending');
  });

  it('keeps an unknown ticket transport outcome pending, blocks overlap, and reconciles without replay', async () => {
    const responseLossStore = loseOneTicketCommitResponse(fixture.store);
    const wrapped = hideOneTicketReadbackAfterCommitLoss(responseLossStore);
    const service = new ConciergeService(wrapped, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
    const payload = await makeTicketPayload(service, actors.executive, ['E02'], 'east');
    const pending = await service.prepare(actors.executive, payload);
    const receipt = await service.confirm(actors.executive, pending.id);

    expect(receipt.status).toBe('pending');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'E02', status: 'pending' }),
    ]);
    expect(await wrapped.get<{ id: string }>('pending_actions', pending.id)).toMatchObject({ status: 'claimed' });
    const ticketId = receipt.results[0]?.id;
    expect(ticketId).toEqual(expect.any(String));
    expect(await fixture.store.get<Ticket>('mock_tickets', ticketId!)).toMatchObject({
      id: ticketId,
      branchId: 'E02',
      operationKey: `${receipt.id}:E02`,
      status: 'open',
    });
    expect(responseLossStore.targetDispatchCount()).toBe(1);
    expect(responseLossStore.targetCommitCount()).toBe(1);
    await expect(service.prepare(actors.executive, payload))
      .rejects.toMatchObject({ code: 'PENDING_EFFECT', status: 409 });
    const reconciled = await service.confirm(actors.executive, pending.id);
    expect(reconciled).toMatchObject({
      id: receipt.id,
      status: 'verified_success',
      results: [expect.objectContaining({ targetId: 'E02', status: 'verified_success' })],
    });
    expect(responseLossStore.targetDispatchCount()).toBe(1);
    expect(responseLossStore.targetCommitCount()).toBe(1);
    expect(await fixture.store.list<Ticket>('mock_tickets')).toHaveLength(1);
  });

  it('closes mixed ticket outcomes as failed and never rewrites targets during read-only reconciliation', async () => {
    await fixture.store.transaction(async (tx) => {
      await tx.put('employees', { id: 'C001', name: 'Central Employee C001', branchId: 'C01', active: true });
    });
    const wrapped = faultStore(fixture.store, {
      failTicket: (row) => row.branchId === 'C01',
      ticketFailure: new DomainError('TARGET_REJECTED', 'Synthetic Central target rejection.', 409),
    });
    const service = new ConciergeService(wrapped, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
    const payload = await makeTicketPayload(service, actors.executive, ['E02', 'C01'], 'all');
    const pending = await service.prepare(actors.executive, payload);
    const receipt = await service.confirm(actors.executive, pending.id);

    expect(receipt.status).toBe('failed');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'E02', status: 'verified_success' }),
      expect.objectContaining({ targetId: 'C01', status: 'failed' }),
    ]);
    expect(await wrapped.get<{ id: string }>('pending_actions', pending.id)).toMatchObject({ status: 'completed' });
    expect(wrapped.ticketWriteCount()).toBe(1);
    expect(await wrapped.list<Ticket>('mock_tickets')).toHaveLength(1);

    const reconciled = await service.reconcile(actors.executive, receipt.id);
    expect(reconciled).toEqual(receipt);
    expect(wrapped.ticketWriteCount()).toBe(1);
    expect(await wrapped.list<Ticket>('mock_tickets')).toHaveLength(1);
    expect((await service.prepare(actors.executive, payload)).status).toBe('pending');
  });

  it.each([
    { scenario: 'baseline' as const, table: 'inventory_snapshots' as const, rowKind: 'inventory' },
    { scenario: 'stock_recovered' as const, table: 'inventory_snapshots' as const, rowKind: 'inventory' },
    { scenario: 'payment_resolved' as const, table: 'incidents' as const, rowKind: 'incident' },
  ])('leaves the $scenario demo action pending if an $rowKind row is dropped', async ({ scenario, table }) => {
    const seeded = await createFullSeedFixture();
    try {
      const wrapped = faultStore(seeded.store, { dropFirstDemoWriteTo: table });
      const service = new ConciergeService(wrapped, {
        businessDate: BUSINESS_DATE,
        now: () => new Date(FIXED_NOW),
      });
      const pending = await service.prepare(actors.executive, { kind: 'demo_update', scenario });
      const receipt = await service.confirm(actors.executive, pending.id);

      expect(wrapped.droppedDemoWriteCount()).toBe(1);
      expect(receipt.status).toBe('pending');
      expect(receipt.results).toEqual([
        expect.objectContaining({ targetId: 'artifact', status: 'pending' }),
      ]);
      expect(await wrapped.get<{ id: string }>('pending_actions', pending.id)).toMatchObject({ status: 'claimed' });
    } finally {
      await seeded.dispose();
    }
  });

  it('rejects incomplete and duplicate tool bindings and disables HR when its runtime is omitted', async () => {
    expect(() => new RuntimeCatalog([{
      ...salesRuntime,
      tools: salesRuntime.tools.slice(1),
    }])).toThrowError();
    expect(() => new RuntimeCatalog([{
      ...salesRuntime,
      tools: [salesRuntime.tools[0]!, salesRuntime.tools[0]!, ...salesRuntime.tools.slice(2)],
    }])).toThrowError();

    const service = new ConciergeService(fixture.store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
      runtimes: [salesRuntime, operationsRuntime],
    });
    expect(service.catalog.manifests.map((manifest) => manifest.id)).toEqual(['sales', 'operations']);
    expect(service.catalog.descriptor('hr.find_employee')).toBeUndefined();
    expect((await service.getWorkspace(actors.hr)).capabilities.some((capability) => capability.id === 'hr')).toBe(false);
  });

  it('serves no HR data when the HR runtime is omitted from the service', async () => {
    const service = new ConciergeService(fixture.store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
      runtimes: [salesRuntime, operationsRuntime],
    });
    // Structured equivalent of the old typed lookup: a live HR actor whose HR runtime is not registered must get no HR data.
    const liveHr = await live(actors.hr);
    const message = 'Find employee E024.';
    planner.reply((input: TurnPlannerInput) => plan(hrEmployeeStep(input, message)));
    const lookup = await service.turn(liveHr, message);
    expect(lookup.sources).toBeUndefined();
    expect(JSON.stringify(lookup)).not.toContain('Synthetic Employee E024');
  });

  it('does not expose writes, transactions, preparation, or confirmation on the prepare context of a planned action', async () => {
    const prepareContextKeys: string[][] = [];
    const service = new ConciergeService(fixture.store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
      runtimes: [
        salesRuntime,
        captureToolContext(operationsRuntime, 'ticket.prepare_create', prepareContextKeys),
        hrRuntime,
      ],
    });

    const liveExecutive = await live(actors.executive);
    planner.reply(plan(ticketCreateStep(['E02'], 'E02')));
    await service.turn(liveExecutive, 'Create a ticket for branch E02.');
    expect(prepareContextKeys.length).toBeGreaterThan(0);
    for (const keys of prepareContextKeys) {
      expect(keys).toContain('prepare');
      expect(keys).not.toContain('tx');
      expect(keys).not.toContain('transaction');
      expect(keys).not.toContain('execute');
      expect(keys).not.toContain('confirm');
    }
  });
});
