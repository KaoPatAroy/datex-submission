import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTurnPlannerInput } from '@/lib/router/planner/input';
import { parseTurnPlan } from '@/lib/router/planner/parse';
import { localScriptedPlannerAllowed } from '@/lib/router/planner/provider';
import { SCRIPTED_TURN_FIXTURE_PROMPTS, scriptedTurnPlan, ScriptedTurnPlannerFixtureMissing } from '@/lib/router/planner/scripted';
import { contextFor } from '../fixtures';

afterEach(() => vi.unstubAllEnvs());

describe('scripted TurnPlan fixtures', () => {
  it('has a validated TurnPlan for every exact E2E prompt fixture', () => {
    for (const prompt of SCRIPTED_TURN_FIXTURE_PROMPTS) {
      const role = prompt.startsWith('Revoke badge') ? 'hr_admin' : 'executive';
      const context = contextFor(role);
      const input = buildTurnPlannerInput(context, { current: prompt });
      const result = parseTurnPlan(scriptedTurnPlan(input), input.validator);
      expect(result.success, `${prompt}: ${result.success ? '' : result.issuePaths.join(',')}`).toBe(true);
    }
    expect(SCRIPTED_TURN_FIXTURE_PROMPTS).toContain('Create dashboard.');
    expect(SCRIPTED_TURN_FIXTURE_PROMPTS).toContain('Compare sales across all regions on 2026-10-01.');
    expect(SCRIPTED_TURN_FIXTURE_PROMPTS).toContain('Share dashboard with East manager.');
    expect(SCRIPTED_TURN_FIXTURE_PROMPTS).toContain('Revoke badge C102 for E024 because their employment ended.');
    const createInput = buildTurnPlannerInput(contextFor(), { current: 'Create dashboard.' });
    const create = scriptedTurnPlan(createInput).steps[0];
    expect(create).toMatchObject({ kind: 'action', actionId: 'dashboard.create', params: { title: { source: 'generated' } } });
  });

  it('throws a loud error for any prompt without an exact fixture key', () => {
    const input = buildTurnPlannerInput(contextFor(), { current: 'Please do something similar to Create dashboard.' });
    expect(() => scriptedTurnPlan(input)).toThrowError(ScriptedTurnPlannerFixtureMissing);
    expect(() => scriptedTurnPlan(input)).toThrow(expect.objectContaining({ code: 'scripted_fixture_missing' }));
  });

  it('requires the exact local scripted-runtime guard', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXUS_E2E_RUNNER', '');
    vi.stubEnv('AI_PROVIDER', 'scripted');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
    expect(localScriptedPlannerAllowed()).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');
    expect(localScriptedPlannerAllowed()).toBe(false);
    vi.stubEnv('NEXUS_E2E_RUNNER', '1');
    expect(localScriptedPlannerAllowed()).toBe(false); // F5: a production build needs the per-run token too
    vi.stubEnv('NEXUS_E2E_RUN_TOKEN', 'short');
    expect(localScriptedPlannerAllowed()).toBe(false);
    vi.stubEnv('NEXUS_E2E_RUN_TOKEN', 'ab12'.repeat(12));
    expect(localScriptedPlannerAllowed()).toBe(true);
    vi.stubEnv('VERCEL', '1');
    expect(localScriptedPlannerAllowed()).toBe(false);
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'production');
    expect(localScriptedPlannerAllowed()).toBe(false);
    vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'false');
    expect(localScriptedPlannerAllowed()).toBe(false);
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('AI_PROVIDER', 'ninearm');
    expect(localScriptedPlannerAllowed()).toBe(false);
  });
});
