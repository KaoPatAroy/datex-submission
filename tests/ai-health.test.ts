import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('passive per-instance Live AI health', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NINEARM_API_KEY', 'fixture-health-key');
    vi.stubEnv('AI_PROVIDER', 'ninearm');
    vi.stubEnv('NINEARM_BASE_URL', 'https://api.example.test/v1');
    vi.stubEnv('NINEARM_MODEL', 'fixture-model');
    vi.stubEnv('AI_TOOL_MODE', 'planner');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('moves ok → degraded → unavailable after two of the last three fail, and recovers', async () => {
    const { getAIHealth, recordAIHealth } = await import('../lib/ai/health');
    expect(getAIHealth(now)).toMatchObject({ status: 'degraded', reason: 'no_recent_turns' });
    recordAIHealth('ok', now - 4000);
    expect(getAIHealth(now).status).toBe('ok');
    recordAIHealth('provider_unavailable', now - 3000);
    expect(getAIHealth(now).status).toBe('degraded');
    recordAIHealth('deadline_exceeded', now - 2000);
    expect(getAIHealth(now)).toEqual({ status: 'unavailable', reason: 'recent_provider_failures', checkedAt: new Date(now - 2000).toISOString() });
    recordAIHealth('ok', now - 1000);
    expect(getAIHealth(now).status).toBe('unavailable');
    recordAIHealth('ok', now);
    expect(getAIHealth(now).status).toBe('degraded');
    recordAIHealth('ok', now);
    expect(getAIHealth(now).status).toBe('ok');
    expect(getAIHealth(now + 300_000)).toMatchObject({ status: 'degraded', reason: 'no_recent_turns' });
  });

  it('missing key or invalid configuration is not_configured even with successful history', async () => {
    const { getAIHealth, recordAIHealth } = await import('../lib/ai/health');
    recordAIHealth('ok', now);
    vi.stubEnv('NINEARM_API_KEY', '');
    expect(getAIHealth(now).status).toBe('not_configured');
    vi.stubEnv('NINEARM_API_KEY', 'fixture-health-key');
    vi.stubEnv('AI_PROVIDER', 'unsupported');
    expect(getAIHealth(now)).toEqual({ status: 'not_configured', reason: 'not_configured', checkedAt: new Date(now).toISOString() });
  });

  it('records typed provider failures once while preserving the error and ignoring Demo/auth/cancellation', async () => {
    const { getAIHealth, observeLiveAITurn } = await import('../lib/ai/health');
    const { AIRuntimeError } = await import('../lib/ai/errors');
    const failure = new AIRuntimeError('provider_unavailable', 'safe message');
    const fail = () => Promise.reject(failure);
    await expect(observeLiveAITurn(false, fail)).rejects.toBe(failure);
    expect(getAIHealth().reason).toBe('no_recent_turns');
    await expect(observeLiveAITurn(true, fail)).rejects.toBe(failure);
    expect(getAIHealth().status).toBe('degraded');
    await expect(observeLiveAITurn(true, () => Promise.reject(new DOMException('stopped', 'AbortError')))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(observeLiveAITurn(true, () => Promise.reject(new AIRuntimeError('FORBIDDEN', 'denied', undefined, 403)))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getAIHealth().status).toBe('degraded');
    await expect(observeLiveAITurn(true, fail)).rejects.toBe(failure);
    expect(getAIHealth().status).toBe('unavailable');
  });

  it('the actual turn planner entry observes setup failures before provider creation', async () => {
    const { requestTurnPlan } = await import('../lib/router/planner/provider');
    const { getAIHealth, observeLiveAITurn } = await import('../lib/ai/health');
    vi.stubEnv('NINEARM_API_KEY', '');
    const input = { currentMessage: 'fixture', systemPrompt: 'fixture', context: { business: { date: '2026-10-01' } }, inputBytes: 1 } as unknown as Parameters<typeof requestTurnPlan>[0];
    const actor = { id: 'executive', name: 'Fixture Executive', sessionId: 'health-session', role: 'executive', active: true, mode: 'live_ai', modeRevision: 0, regions: ['east'], permissions: [] } as unknown as Parameters<typeof requestTurnPlan>[1]['actor'];
    await expect(observeLiveAITurn(true, () => requestTurnPlan(input, { actor, diagnosticId: 'health-turn' }))).rejects.toMatchObject({ code: 'not_configured' });
    vi.stubEnv('NINEARM_API_KEY', 'fixture-health-key');
    expect(getAIHealth().reason).toBe('not_configured');
    expect(getAIHealth().status).toBe('degraded');
  });
});

describe('per-actor unusable planner output', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NINEARM_API_KEY', 'fixture-health-key'); vi.stubEnv('AI_PROVIDER', 'ninearm');
    vi.stubEnv('NINEARM_BASE_URL', 'https://api.example.test/v1'); vi.stubEnv('NINEARM_MODEL', 'fixture-model'); vi.stubEnv('AI_TOOL_MODE', 'planner');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('3 of the actor\'s last 5 malformed responses flip health for that actor only; validation rejections never count', async () => {
    const { getAIHealth, observeLiveAITurn } = await import('../lib/ai/health');
    const { AIRuntimeError } = await import('../lib/ai/errors');
    const bad = () => Promise.reject(new AIRuntimeError('invalid_model_response', 'unusable'));
    await expect(observeLiveAITurn(true, bad, 'u1')).rejects.toBeTruthy();
    await expect(observeLiveAITurn(true, async () => 'ok', 'u1')).resolves.toBe('ok');
    await expect(observeLiveAITurn(true, bad, 'u1')).rejects.toBeTruthy();
    expect(getAIHealth(Date.now(), 'u1').reason).not.toBe('recent_unusable_plans');
    await expect(observeLiveAITurn(true, bad, 'u1')).rejects.toBeTruthy();
    expect(getAIHealth(Date.now(), 'u1')).toMatchObject({ status: 'unavailable', reason: 'recent_unusable_plans' });
    expect(getAIHealth(Date.now(), 'u2').reason).not.toBe('recent_unusable_plans');
    expect(getAIHealth().reason).not.toBe('recent_unusable_plans');
    // A valid plan that validation later rejects is a successful model response.
    for (let i = 0; i < 5; i++) await observeLiveAITurn(true, async () => ({ rejectedLater: true }), 'u3');
    expect(getAIHealth(Date.now(), 'u3').reason).not.toBe('recent_unusable_plans');
  });
});
