import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DepartmentPack, PendingAction } from '../lib/contracts';
import { AIRuntimeError } from '../lib/ai/errors';
import { exposeTools } from '../lib/ai/tool-schemas';
import { ConciergeService } from '../lib/core/service';
import { buildTurnPlannerInput, type TurnPlannerInput } from '../lib/router/planner/input';
import { defineTool } from '../lib/packs/shared';
import {
  actors,
  BUSINESS_DATE,
  createWorkspaceFixture,
  dashboardPayload,
  FIXED_NOW,
} from './helpers/workspace';
import {
  badgeRevokeStep, baseQueryPlan, conversationStep, plan, planner,
} from './helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

// Ported from the legacy tool-loop regression suite. Loop internals (tool-plan parsing, citation parsing of final
// answers, forged broker tools, final-summary fallbacks) were removed with runAI; the context-scope, authorization and
// budget assertions now run against the planner input the server builds and the typed outcomes it returns.
type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

async function makeLiveExecutive(fixture: WorkspaceFixture) {
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
}

async function makeLiveHr(fixture: WorkspaceFixture) {
  await fixture.patchSession(actors.hr.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actors.hr, mode: 'live_ai' as const, modeRevision: 1 };
}

function newService(fixture: WorkspaceFixture) {
  return new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
}

/** An all-regions net-sales query for 2026-10-01 whose interpretation spans are located in `message`. */
function allRegionsQuery(input: Parameters<typeof baseQueryPlan>[0] extends infer C ? { context: C } : never, message: string, scopeText: string) {
  const span = (text: string) => ({ start: message.indexOf(text), end: message.indexOf(text) + text.length, text });
  return { kind: 'query', continuation: false, plan: baseQueryPlan(input.context as never, {
    scope: { kind: 'all', sourceText: span(scopeText), confidence: 1 },
    time: { fieldId: 'date', timezone: (input.context as { business: { timezone: string } }).business.timezone, source: 'explicit',
      dates: ['2026-10-01'], evidenceText: '2026-10-01' },
    dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
    group: { fieldIds: ['branch'] },
  }) };
}

describe('live AI context and planner-boundary regressions', () => {
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

  it('passes only saved authorized scope, the owner’s latest dashboard, and eligible active recipients to the planner', async () => {
    const actor = await makeLiveExecutive(fixture);
    const service = newService(fixture);
    const seedMessage = 'Compare all authorized regions on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(allRegionsQuery(input, seedMessage, 'all authorized regions')));
    const first = await service.turn(actor, seedMessage);
    expect(first.sources?.length).toBeGreaterThan(0);
    const pending = await service.prepare(actor, dashboardPayload('all'));
    await service.confirm(actor, pending.id);
    await fixture.store.transaction(async (tx) => {
      await tx.put('profiles', {
        id: 'inactive-ops', name: 'Inactive operations manager', role: 'east_manager', active: false,
        permissions: ['sales.read', 'operations.read'], regions: ['east'],
      });
      await tx.put('profiles', {
        id: 'sales-only', name: 'Sales-only manager', role: 'east_manager', active: true,
        permissions: ['sales.read'], regions: ['east'],
      });
    });

    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await service.turn(actor, 'Use my latest dashboard.', first.conversationId);
    const input = planner.calls.at(-1)!;
    const context = input.context;

    expect(context.scope.actorId).toBe('executive');
    expect(context.scope.regionIds).toEqual(expect.arrayContaining(['central', 'east']));
    // Saved scope: the prior accepted query of this conversation is the continuation state.
    expect(context.previousState).toMatchObject({ stateId: expect.any(String) });
    expect(context.acceptedStates.length).toBeGreaterThan(0);
    expect(context.dashboards).toEqual([expect.objectContaining({ id: expect.any(String), title: 'all sales overview' })]);
    // Eligible = active, holds the share read permissions, and is not the actor (recipientAllowed forbids self-share).
    expect(context.recipients.map((recipient) => recipient.id)).toEqual(['east']);
    const serialized = JSON.stringify(context) + input.prompt;
    expect(serialized).not.toContain('inactive-ops');
    expect(serialized).not.toContain('sales-only');
    expect(context.recipients.map((recipient) => recipient.id)).not.toContain('hr');
    expect(context.scope.permissions).not.toContain('hr.read');
  });

  it('offers the planner only the actions the actor holds and prepares nothing for an unlisted action', async () => {
    const actor = await makeLiveExecutive(fixture);
    const service = newService(fixture);
    planner.reply((input: TurnPlannerInput) => {
      // The planner (wrongly) asks for a badge revocation although this actor holds no badge permission.
      expect(input.context.actions.map((action) => action.actionId)).not.toContain('badge.revoke');
      expect(input.prompt).not.toContain('"actionId":"badge.revoke"');
      return plan(badgeRevokeStep('C102', 'E024', 'employment ended'));
    });
    const response = await service.turn(actor, 'Revoke C102 for E024 because employment ended');

    expect(response.clarification).toBe(true);
    expect(response.pendingAction).toBeUndefined();
    expect(planner.calls[0]!.context.actions.map((action) => action.actionId)).toEqual(expect.arrayContaining(['ticket.create', 'dashboard.create']));
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C102')).toMatchObject({ state: 'active' });
  });

  it('rejects a substituted badge target through a streamed service turn and prepares nothing', async () => {
    const actor = await makeLiveHr(fixture);
    // The user named C102/E024; the planner substitutes C104/E025 and cannot ground them in the user's message.
    planner.reply(plan(badgeRevokeStep('C104', 'E025', 'employment ended')));
    const service = newService(fixture);
    const deltas: string[] = [];
    const statuses: string[] = [];

    const response = await service.turn(actor, 'Revoke badge C102 for employee E024 because employment ended', undefined, undefined, undefined, {
      onTextDelta: (delta) => { deltas.push(delta); },
      onStatus: (status) => { statuses.push(status); },
    });

    expect(planner.calls[0]!.context.actions.map((action) => action.actionId)).toContain('badge.revoke');
    expect(planner.calls[0]!.context.actions.map((action) => action.actionId)).not.toContain('ticket.create');
    expect(response.clarification).toBe(true);
    expect(response.pendingAction).toBeUndefined();
    expect(deltas.join('')).toBe(response.message);
    expect(statuses).not.toContain('preparing');
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C102')).toMatchObject({ state: 'active' });
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C104')).toBeDefined();
  });

  it('removes saved scope and dashboard metadata from planner input after current sales permission is revoked', async () => {
    const actor = await makeLiveExecutive(fixture);
    const service = newService(fixture);
    const seedMessage = 'Compare East sales on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => {
      const step = allRegionsQuery(input, seedMessage, 'East');
      (step.plan as { scope: unknown }).scope = null;
      (step.plan as { filters: unknown[] }).filters = [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', sourceText: null, confidence: 1 }];
      return plan(step);
    });
    const seeded = await service.turn(actor, seedMessage);
    const conversationId = seeded.conversationId;
    const pending = await service.prepare(actor, dashboardPayload('east'));
    await service.confirm(actor, pending.id);
    await fixture.store.transaction(async (tx) => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', actor.id);
      if (!profile) throw new Error('Missing executive fixture profile.');
      await tx.put('profiles', { ...profile, permissions: ['operations.read', 'dashboard.share'], id: actor.id });
    });

    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await service.turn(actor, 'What is my latest dashboard?', conversationId);

    const input = planner.calls.at(-1)!;
    expect(input.context.scope.permissions).not.toContain('sales.read');
    expect(input.context.acceptedStates).toEqual([]);
    expect(input.context.previousState).toBeNull();
    // Sales evidence is gone; the operations-only table datasets (operations.read) remain, and nothing sales-bound is offered.
    expect(input.context.catalog.datasets.map(dataset => dataset.id)).toEqual(['inventory_items', 'incident_log', 'support_tickets']);
    expect(input.prompt).not.toContain('sales:');
  });

  it('removes saved dashboard titles from planner input after current sales permission is revoked', async () => {
    const actor = await makeLiveExecutive(fixture);
    const service = newService(fixture);
    const pending = await service.prepare(actor, dashboardPayload('east'));
    await service.confirm(actor, pending.id);
    await fixture.store.transaction(async (tx) => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', actor.id);
      if (!profile) throw new Error('Missing executive fixture profile.');
      await tx.put('profiles', { ...profile, permissions: ['operations.read', 'dashboard.share'], id: actor.id });
    });
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await service.turn(actor, 'What is my latest dashboard?');
    const input = planner.calls.at(-1)!;
    expect(input.context.dashboards).toEqual([]);
    expect(JSON.stringify(input.context)).not.toContain('east sales overview');
    expect(input.prompt).not.toContain('sales overview');
  });

  it('hides execute and verify tool descriptors from model exposure while keeping namespaced read tools', () => {
    const lookup = defineTool(
      'insights.lookup',
      'Read a synthetic insight and its source identifier.',
      'sales.read',
      'read',
      z.object({ query: z.string().min(1) }).strict(),
      z.object({ summary: z.string(), sourceIds: z.array(z.string().min(1)) }).strict(),
    );
    const hiddenExecute = defineTool('insights.make_change', 'Hidden write.', 'sales.read', 'execute', z.object({}).strict(), z.object({ ok: z.boolean() }).strict());
    const hiddenVerify = defineTool('insights.inspect_change', 'Hidden verifier.', 'sales.read', 'verify', z.object({}).strict(), z.object({ ok: z.boolean() }).strict());
    const manifest: DepartmentPack = {
      id: 'insights', contractVersion: 1, version: '1.0.0', implementationRevision: 'test-insights-v1',
      dependencies: [], title: 'Synthetic insights', entities: [], adapterBindings: [], metrics: [],
      tools: [lookup, hiddenExecute, hiddenVerify], permissionConstraints: ['sales.read'],
      approvalMode: 'requester_confirmation', templates: [], evaluationCases: [],
    };
    expect(manifest.tools).toHaveLength(3);
    expect(exposeTools([lookup, hiddenExecute, hiddenVerify]).map((tool) => tool.descriptor.name)).toEqual(['insights.lookup']);
  });

  it('rejects oversized authorized context before any planner request is made', async () => {
    const actor = await makeLiveExecutive(fixture);
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await newService(fixture).turn(actor, 'Summarize.');
    const real = planner.calls[0]!.context;
    const callsBefore = planner.calls.length;

    // The planner-input budget (the successor of the old runAI context cap) fails closed, it never truncates silently.
    const oversized = { ...real, pendingClarification: { about: 'x'.repeat(25_000), missing: ['date'] } };
    let thrown: unknown;
    try { buildTurnPlannerInput(oversized, { current: 'Summarize.' }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AIRuntimeError);
    expect(thrown).toMatchObject({ code: 'invalid_input' });
    const oversizedScope = { ...real, scope: { ...real.scope, branchIds: Array.from({ length: 400 }, (_, index) => `BRANCH-${String(index).padStart(6, '0')}`) } };
    expect(() => buildTurnPlannerInput(oversizedScope, { current: 'Summarize.' })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(planner.calls).toHaveLength(callsBefore);
    expect(await fixture.store.list<PendingAction>('pending_actions')).toEqual([]);
  });
});
