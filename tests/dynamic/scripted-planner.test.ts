import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestQueryPlan, type PlannerRuntime } from '../../lib/dynamic/planner/provider';
import { buildPlannerInput, parsePlannerJSON } from '../../lib/dynamic/planner/planner';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { ConciergeService } from '../../lib/core/service';
import type { StoredRow, Table } from '../../lib/contracts';
import { createSeedData } from '../../lib/seed/generate';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from '../helpers/workspace';
import { available, catalog, executive, fakeEvidence, manager, readAt } from './fixtures';

const network = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }));
vi.mock('../../lib/ai/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/ai/client')>(),
  createAIClient: network.client,
}));

const eastPrompt = 'ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569';
const formatMoney = (value: number) => new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const runtime = (): PlannerRuntime => ({ actor: { ...actors.executive, mode: 'live_ai' },
  businessDate: BUSINESS_DATE, diagnosticId: 'scripted-test', deadlineAt: Date.now() + 5_000,
  signal: new AbortController().signal });

beforeEach(() => {
  vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('NEXUS_E2E_RUNNER', '');
  network.create.mockReset();
  network.client.mockReset().mockReturnValue({ chat: { completions: { create: network.create } } });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('local scripted query planner', () => {
  it.each([eastPrompt, 'May I see E01 sales?', 'ยอดขายภาคใต้', 'แล้วภาคกลางล่ะ', 'แล้วภาคกลางยอดขายล่ะ', 'unlisted sales query'])(
    'returns deterministic parseable JSON for %s without a network client', async text => {
      const input = buildPlannerInput(catalog, executive, text);
      const first = await requestQueryPlan(input, runtime());
      expect(await requestQueryPlan(input, runtime())).toBe(first);
      expect(parsePlannerJSON(first).outcome).toBe(text === 'unlisted sales query' ? 'not_query' : 'planned');
      expect(network.client).not.toHaveBeenCalled();
    });
  it('keeps an out-of-window metric request as a query with canonical May dates', async () => {
    const text = 'sales in May 2025';
    const parsed = parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, executive, text), runtime()));
    expect(parsed.outcome).toBe('planned');
    if (parsed.outcome !== 'planned') throw new Error('Expected a canonical query plan.');
    expect(parsed.plan.time).toMatchObject({ source: 'explicit', dates: expect.arrayContaining(['2025-05-01', '2025-05-31']) });
  });
  it('validates and compiles East aggregate through evidence and grounded claims', async () => {
    const parsed = parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime()));
    if (parsed.outcome !== 'planned') throw new Error('Expected a parsed plan.');
    const checked = validateQueryPlan(parsed.plan, catalog, executive, available(eastPrompt));
    if (checked.outcome !== 'accepted') throw new Error(`Rejected: ${checked.code}`);
    const reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(checked), reader, executive, readAt);
    expect(reader).toHaveBeenCalledExactlyOnceWith({ region: 'east', date: BUSINESS_DATE, branchIds: ['E01', 'E02'] });
    if (result.outcome !== 'accepted') throw new Error('Expected evidence.');
    const claims = buildClaimGraph(result.bundle).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: 280, dimensions: { region: 'east' }, computation: { operation: 'sum' } });
    expect(claims[0].rowRefs).toHaveLength(2);
    expect(claims[0].sourceRefs.length).toBeGreaterThan(0);
  });
  it('May is a question word and E01 receives the validated default date', async () => {
    const text = 'May I see E01 sales?';
    const parsed = parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, executive, text), runtime()));
    if (parsed.outcome !== 'planned') throw new Error('Expected a parsed plan.');
    expect(parsed.plan.time).toMatchObject({ source: 'default', dates: [BUSINESS_DATE] });
    expect(parsed.plan.filters).toMatchObject([{ fieldId: 'branch', value: 'E01' }]);
    const checked = validateQueryPlan(parsed.plan, catalog, executive, available(text));
    expect(checked).toMatchObject({ outcome: 'accepted', dates: [BUSINESS_DATE], scope: { branchIds: ['E01'] } });
  });
  it('unauthorized scripted South scope is refused by the real validator before any read', async () => {
    const text = 'ยอดขายภาคใต้';
    const parsed = parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, manager, text), runtime()));
    if (parsed.outcome !== 'planned') throw new Error('Expected a parsed plan.');
    const checked = validateQueryPlan(parsed.plan, catalog, manager, available(text));
    expect(checked).toMatchObject({ outcome: 'permission_denied', code: 'explicit_scope_denied' });
    expect(network.client).not.toHaveBeenCalled();
  });
  it('unknown exact fixture prompts classify as not_query', async () => {
    const text = 'unlisted sales query';
    expect(parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, executive, text), runtime())))
      .toEqual({ outcome: 'not_query' });
  });
  it('routes create-action requests to the legacy action flow', async () => {
    const text = 'Create a sales dashboard', input = buildPlannerInput(catalog, executive, text);
    expect(input.prompt).toContain('create, prepare, share, or change something');
    expect(input.prompt).toContain('actions, dashboards, tasks, and messages');
    expect(parsePlannerJSON(await requestQueryPlan(input, runtime()))).toEqual({ outcome: 'not_query' });
  });
  it('instructs the model to expand relative months into every ISO date', () => {
    const input = buildPlannerInput(catalog, executive, 'sales last month');
    expect(input.prompt).toContain('every canonical ISO date in the previous complete calendar month');
    expect(input.prompt).toContain('The server then validates availability.');
  });
  it.each(['production', 'development', 'nonlocal', 'hosted', 'deployment'])('cannot activate scripted fixtures in %s', async guard => {
    if (guard === 'production') vi.stubEnv('NODE_ENV', 'production');
    if (guard === 'development') vi.stubEnv('NODE_ENV', 'development');
    if (guard === 'nonlocal') vi.stubEnv('USE_LOCAL_DEMO_DATA', 'false');
    if (guard === 'hosted') vi.stubEnv('VERCEL', '1');
    if (guard === 'deployment') { vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'production'); vi.stubEnv('NEXUS_E2E_RUNNER', '1'); }
    await expect(requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime()))
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(network.client).not.toHaveBeenCalled();
  });
  it('allows production-build fixtures only with the explicit local E2E runner', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXUS_E2E_RUNNER', '1');
    vi.stubEnv('NEXUS_E2E_RUN_TOKEN', 'a'.repeat(48));
    expect(parsePlannerJSON(await requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime())).outcome).toBe('planned');
    expect(network.client).not.toHaveBeenCalled();
  });
  it('F5: NEXUS_E2E_RUNNER=1 on a production build without the per-run token cannot activate fixtures', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXUS_E2E_RUNNER', '1');
    for (const token of ['', 'short', 'zz'.repeat(24)]) {
      vi.stubEnv('NEXUS_E2E_RUN_TOKEN', token);
      await expect(requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime())).rejects.toMatchObject({ code: 'invalid_configuration' });
    }
  });
  it.each(['hosted', 'nonlocal', 'wrong-runner'])('production E2E cannot bypass %s guard', async guard => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXUS_E2E_RUNNER', '1'); vi.stubEnv('NEXUS_E2E_RUN_TOKEN', 'a'.repeat(48));
    if (guard === 'hosted') vi.stubEnv('VERCEL', '1');
    if (guard === 'nonlocal') vi.stubEnv('USE_LOCAL_DEMO_DATA', 'false');
    if (guard === 'wrong-runner') vi.stubEnv('NEXUS_E2E_RUNNER', 'true');
    await expect(requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime())).rejects.toMatchObject({ code: 'invalid_configuration' });
  });
  it('uses the existing client for the real provider even with local demo data', async () => {
    vi.stubEnv('AI_PROVIDER', 'ninearm');
    network.create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: 'real provider result' } }] });
    expect(await requestQueryPlan(buildPlannerInput(catalog, executive, eastPrompt), runtime())).toBe('real provider result');
    expect(network.client).toHaveBeenCalledOnce();
    expect(network.create).toHaveBeenCalledOnce();
  });
  it('honors cancellation and deadline for local fixtures', async () => {
    const input = buildPlannerInput(catalog, executive, eastPrompt), controller = new AbortController();
    controller.abort(new Error('canceled'));
    await expect(requestQueryPlan(input, { ...runtime(), signal: controller.signal })).rejects.toThrow('canceled');
    await expect(requestQueryPlan(input, { ...runtime(), deadlineAt: 0 })).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });
});

it('scripted live_ai service persists grounded seed claims, binds follow-up state, and prepares no actions', async () => {
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'on');
  const fixture = await createWorkspaceFixture();
  try {
    const seed = createSeedData(BUSINESS_DATE);
    await fixture.store.transaction(async tx => {
      for (const [name, rows] of Object.entries(seed)) {
        const table = name as Table;
        for (const row of await tx.list<StoredRow>(table)) await tx.remove(table, row.id);
        // Only the queried day is needed; avoid persisting the entire 30-day history.
        for (const row of rows) if (!('date' in row) || row.date === BUSINESS_DATE) await tx.put(table, row);
      }
    });
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    await fixture.patchSession(actors.east.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const actor = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
    const app = new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => FIXED_NOW });
    const first = await app.turn(actor, eastPrompt);
    const expected = (region: string) => seed.sales_orders.filter(row => row.date === BUSINESS_DATE && row.status === 'paid'
      && seed.branches.some(branch => branch.id === row.branchId && branch.region === region))
      .reduce((sum, row) => sum + row.amountSatang, 0) / 100;
    expect(first.message).toContain(`ภาคตะวันออก มียอดขายสุทธิ ${formatMoney(expected('east'))} บาท.`);
    // A changed default date must not replace the prior explicit query date.
    const nextDay = new ConciergeService(fixture.store, { businessDate: '2026-10-02', now: () => FIXED_NOW });
    const second = await nextDay.turn(actor, 'แล้วภาคกลางยอดขายล่ะ', first.conversationId);
    expect(second.message).toContain(`ขอบเขตที่ตีความ: ช่วงวันที่ ${BUSINESS_DATE} (ต่อจากคำถามก่อน)`);
    expect(second.message).not.toContain('Follow-up scope:');
    expect(second.message).not.toContain('Follow-up dates:');
    expect(second.message).not.toContain('Business dates:');
    expect(second.message).toContain(`ภาคกลาง มียอดขายสุทธิ ${formatMoney(expected('central'))} บาท.`);
    const proof = await fixture.store.get<{ state: { revision: number; parentState: unknown } }>('tool_executions', `dynamic:${second.turnId}`);
    expect(proof?.state.revision).toBe(2);
    expect(proof?.state.parentState).toBeTruthy();
    const branch = await app.turn(actor, 'May I see E01 sales?', first.conversationId);
    const branchSales = seed.sales_orders.filter(row => row.branchId === 'E01' && row.date === BUSINESS_DATE && row.status === 'paid')
      .reduce((sum, row) => sum + row.amountSatang, 0) / 100;
    expect(branch.message).toContain(`รวมยอดขายสุทธิ ${formatMoney(branchSales)} บาท.`);
    expect(branch.message).toContain(`ขอบเขตที่ตีความ: ช่วงวันที่ ${BUSINESS_DATE}`);
    expect(branch.message.match(/^ขอบเขตที่ตีความ:/gmu)).toHaveLength(1);
    expect(branch.message).not.toContain('\nScope:');
    expect(branch.message).not.toContain('Business dates:');
    expect(branch.message).not.toContain('2026-05');
    const denied = await app.turn({ ...actors.east, mode: 'live_ai', modeRevision: 1 }, 'ยอดขายภาคใต้');
    expect(denied.message).toContain('อยู่นอกสิทธิ์ของบัญชีนี้');
    expect(denied.analysis).toBeUndefined();
    expect(await fixture.store.get('tool_executions', `dynamic:${denied.turnId}`)).toBeUndefined();
    expect(await fixture.store.list('pending_actions')).toEqual([]);
    expect(network.client).not.toHaveBeenCalled();
    const bottom = await app.turn(actor, 'bottom 3 vs target');
    expect(bottom.message.match(/^สาขา.* มีส่วนต่างจากเป้า /gmu)).toHaveLength(3);
    expect(bottom.message.match(/^อันดับ \d+ คือสาข/gmu)).toHaveLength(3);
    expect((await fixture.store.get<{ plan: { topN?: { count: number; direction: string } } }>('tool_executions', `dynamic:${bottom.turnId}`))?.plan.topN)
      .toEqual({ count: 3, direction: 'lowest', completeScopeRequired: true });
  } finally { await fixture.dispose(); }
});
