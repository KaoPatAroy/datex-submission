import { extractTicketPlan } from '@/lib/core/ticket-plan-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionPayload, Ticket } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { param, plan, planner, quoted, ticketCreateStep } from '../helpers/turn-planner';
import { executeActionStep } from '@/lib/router/executors/action';
import { CONVERSATION, eastActor, fakePorts, grounded, NOW, TURN } from './executors/action-fixtures';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

describe('ticket.create flexible fields (ACTIONPLAN-001)', () => {
  it('passes the stated fields to the prepare tool and omits the plan when none is stated', async () => {
    const f = fakePorts();
    const base = { ports: f.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: NOW };
    await executeActionStep({ ...base, step: grounded('ticket.create', { regionIds: ['east'], date: '2026-10-06', branchIds: ['E01'], priority: 'urgent', dueDate: '2026-10-09', checklist: ['A'], note: 'n' }, ['regionIds', 'date']) });
    expect(f.state.prepared[0]!.args).toEqual({ scope: { region: 'east', date: '2026-10-06' }, branchIds: ['E01'],
      plan: { priority: 'urgent', dueDate: '2026-10-09', grouping: 'per_branch', checklist: ['A'], note: 'n' } });
  });

  describe('through the service', () => {
    let fixture!: Awaited<ReturnType<typeof createWorkspaceFixture>>;
    beforeEach(async () => {
      vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
      planner.reset();
      fixture = await createWorkspaceFixture();
      await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
      await fixture.store.transaction(async tx => { await tx.put('employees', { id: 'EMP-C01', name: 'Central Staff', branchId: 'C01', active: true }); });
    });
    afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });
    const exec = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
    const say = 'Open an urgent single ticket for E02 and C01 due 2026-10-05 with a note.';

    it('carries priority/due/grouping/checklist/note into the confirmed ticket and its receipt; single covers both branches in one ticket', async () => {
      planner.reply(plan(ticketCreateStep(['E02', 'C01'], 'E02 and C01', {
        priority: quoted('urgent', 'urgent'), grouping: quoted('single', 'single'), dueDate: quoted('2026-10-05', '2026-10-05'),
        checklist: param(['Check sales', 'Check stock'], 'generated'), note: quoted('with a note', 'with a note') })));
      const turn = await fixture.service.turn(exec, say);
      const pending = turn.pendingAction!;
      const payload = pending.payload as Extract<ActionPayload, { kind: 'ticket_create' }>;
      expect(payload.plan).toMatchObject({ priority: 'urgent', dueDate: '2026-10-05', grouping: 'single', coveredBranchIds: ['E02', 'C01'] });
      expect(payload.targets).toHaveLength(1);
      const receipt = await fixture.service.confirm(exec, pending.id);
      expect(receipt.status).toBe('verified_success');
      const tickets = await fixture.store.list<Ticket>('mock_tickets');
      expect(tickets).toHaveLength(1);
      expect(extractTicketPlan(tickets[0]!.unansweredQuestion)).toMatchObject({ priority: 'urgent', checklist: ['Check sales', 'Check stock'], note: 'with a note' });
      if (receipt.visibility !== 'restricted') expect(receipt.results[0]!.detail).toContain('ความสำคัญ ด่วน');
      // Idempotent: confirming again creates no second ticket.
      await fixture.service.confirm(exec, pending.id).catch(() => undefined);
      expect(await fixture.store.list<Ticket>('mock_tickets')).toHaveLength(1);
    });

    it('per_branch makes one ticket per branch, each carrying the plan', async () => {
      planner.reply(plan(ticketCreateStep(['E02', 'C01'], 'E02 and C01', { priority: quoted('high', 'urgent'), grouping: param('per_branch', 'generated') })));
      const turn = await fixture.service.turn(exec, say);
      const receipt = await fixture.service.confirm(exec, turn.pendingAction!.id);
      expect(receipt.status).toBe('verified_success');
      const tickets = await fixture.store.list<Ticket>('mock_tickets');
      expect(tickets).toHaveLength(2);
      expect(tickets.every(t => extractTicketPlan(t.unansweredQuestion)?.priority === 'high')).toBe(true);
    });
  });
});
