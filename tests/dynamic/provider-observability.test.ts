import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAIHealth, recordAIHealth } from '../../lib/ai/health';
import { AIRuntimeError } from '../../lib/ai/errors';
import type { Actor } from '../../lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { plan, planner } from '../helpers/turn-planner';
import { branches, fakeEvidence, filter, proposal } from './fixtures';
import captures from './live-fixtures/qwen-plans.json';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
const message = 'East sales';
const goodPlan = () => filter(proposal(message), message, 'region', 'east', 'East');
const queryStep = (queryPlan: unknown) => ({ kind: 'query', continuation: false, plan: queryPlan });
const live = (actor: Actor = actors.executive): Actor => ({ ...actor, mode: 'live_ai', modeRevision: 1 });
const run = (text = message, actor: Actor = actors.executive) => fixture.service.turn(live(actor), text);
const providerDown = () => new AIRuntimeError('provider_unavailable', 'Synthetic provider outage');
type Proof = { plan: { time: { dates: string[] } }; claims: { claims: { measure: string; value: number | null; dimensions: Record<string, string> }[] } };
const proofFor = (turnId: string) => fixture.store.get<Proof>('tool_executions', `dynamic:${turnId}`);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  vi.stubEnv('AI_PROVIDER', 'ninearm'); vi.stubEnv('NINEARM_API_KEY', 'fixture-key');
  vi.stubEnv('NINEARM_BASE_URL', 'https://provider.example/v1'); vi.stubEnv('NINEARM_MODEL', 'fixture-model');
  planner.reset();
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => { for (const branch of branches) await tx.put('branches', branch); });
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  planner.reply(plan(queryStep(goodPlan())));
  // Clear the per-instance recent-three history through the real runtime boundary.
  for (let i = 0; i < 5; i++) { recordAIHealth('ok'); await run(); }
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.dispose(); vi.unstubAllEnvs(); });

describe('on-path planner health', () => {
  it('turns provider outages into the truthful switch-to-demo reply and counts each once', async () => {
    planner.fail(providerDown());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await run('exec-first');
    expect(first).toMatchObject({ hint: 'switch_to_demo', clarification: true });
    expect(first.sources).toBeUndefined();
    expect(getAIHealth().status).toBe('degraded');
    expect((await run('exec-second')).hint).toBe('switch_to_demo');
    expect(getAIHealth()).toMatchObject({ status: 'unavailable', reason: 'recent_provider_failures' });
    expect(planner.calls.filter(call => call.currentMessage.startsWith('exec-'))).toHaveLength(2);
    planner.reply(plan(queryStep(goodPlan())));
    for (let i = 0; i < 3; i++) await run();
    expect(getAIHealth().status).toBe('ok');
  });
  it('counts only the latest three outcomes and expires failures after five minutes', async () => {
    planner.fail(providerDown());
    await run('initial-invalid:0');
    planner.reply(plan(queryStep(goodPlan())));
    for (let i = 0; i < 4; i++) await run();
    expect(getAIHealth().status).toBe('ok');
    planner.fail(providerDown());
    await run('after-valid-window');
    expect(getAIHealth().status).toBe('degraded');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect(getAIHealth().reason).toBe('no_recent_turns'); // the expired failure no longer counts
    await run('after-expiry:0');
    expect(getAIHealth().status).toBe('degraded');
    await run('after-expiry:1');
    expect(getAIHealth()).toMatchObject({ status: 'unavailable', reason: 'recent_provider_failures' });
  });
  it('does not count invalid or oversized model plans as provider outages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const code of ['invalid_model_response', 'invalid_input'] as const) {
      planner.fail(new AIRuntimeError(code, 'Synthetic invalid planner output'));
      for (let i = 0; i < 5; i++) expect((await run(`invalid:${code}:${i}`)).clarification).toBe(true);
      expect(getAIHealth().status).toBe('ok');
    }
  });
  it('replays all 15 exact provider captures through the on-path normalization and evidence reader', async () => {
    vi.spyOn(fixture.service, 'queryEvidence').mockImplementation(async (_actor, scope) => fakeEvidence(scope, branches));
    for (const [i, capture] of captures.entries()) {
      const contractPlan = { ...(capture.contractPlan as Record<string, unknown>) };
      delete contractPlan.intentKind;
      delete contractPlan.parentState;
      planner.reply(plan(queryStep(contractPlan)));
      const result = await run(capture.message);
      if (i % 5 === 3) { expect(result.clarification, `capture ${i}`).toBe(true); continue; }
      expect(result.clarification, `capture ${i}`).toBeUndefined();
      const proof = await proofFor(result.turnId);
      expect(proof?.plan.time.dates).toEqual(['2026-10-01']);
      const sales = proof?.claims.claims.filter(c => c.measure === 'net_sales' && !c.dimensions.comparison) ?? [];
      expect(sales.length).toBeGreaterThan(0);
      expect(sales.reduce((sum, c) => sum + (c.value ?? 0), 0)).toBe([680, 200, 200, 280, 280][i % 5]);
    }
  });
  it('user ambiguity clarifies the element without making health unhealthy', async () => {
    const raw = structuredClone(goodPlan()); raw.filters[0]!.sourceText!.text = 'absent';
    planner.reply(plan(queryStep(raw)));
    for (let i = 0; i < 3; i++) {
      const result = await run();
      expect(result.clarification).toBe(true);
      expect(result.message).toContain('ช่วยระบุสาขาหรือภูมิภาคที่ต้องการดูให้ชัดเจนขึ้น');
      expect(await proofFor(result.turnId)).toBeUndefined();
    }
    expect(getAIHealth().status).toBe('ok');
  });
  it('refuses an unknown catalog dataset without echoing the rejected plan identity', async () => {
    planner.reply(plan(queryStep({ ...goodPlan(), datasetId: 'private_model_dataset' })));
    const result = await run();
    expect(result.clarification).toBe(true);
    expect(result.sources).toBeUndefined();
    expect(result.message).not.toContain('private_model_dataset');
    expect(await proofFor(result.turnId)).toBeUndefined();
  });
  it('does not count user-induced invalid model plans toward global provider health', async () => {
    planner.reply(plan(queryStep({ ...goodPlan(), planVersion: 999 })));
    for (let i = 0; i < 5; i++) {
      const result = await run();
      expect(result.clarification).toBe(true);
      expect(result.sources).toBeUndefined();
    }
    expect(getAIHealth().status).toBe('ok');
  });
  it('fails one execute-stage reader failure without exposing reader error details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let reads = 0;
    vi.spyOn(fixture.service, 'queryEvidence').mockImplementation(async (_actor, scope) => {
      if (++reads > 1) throw new Error('Sensitive reader values');
      return fakeEvidence(scope, branches);
    });
    const failure = await run().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'tool_execution_failed' });
    expect(String((failure as Error).message)).not.toContain('Sensitive');
  });
});
