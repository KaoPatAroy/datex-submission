import { describe, expect, it } from 'vitest';
import { actionRegistry, actionParamsSchema, bindHandlers, createActionRegistry, ACTION_DEFINITIONS } from '@/lib/router/action-registry';
import { jsonSchemaBytes, PLANNER_JSON_SCHEMA_MAX_BYTES, plannerJsonSchema, plannerTurnPlanSchema } from '@/lib/router/json-schema';
import { envelopeError, turnPlanSchema, turnStepSchema } from '@/lib/router/turn-plan';
import { plan, queryStep, shareStep } from './fixtures';

const clarifyStep = {
  kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
  missing: [{ slot: 'params.recipientId', reason: 'absent' }], question: 'Who?', choices: [],
};
const conversationStep = { kind: 'conversation', topic: 'greeting', prose: 'Hello' };

describe('TurnPlan schema', () => {
  it('round-trips every step kind', () => {
    const steps = [
      queryStep(), { ...queryStep(), kind: 'hr_query', continuation: undefined }, shareStep(),
      { kind: 'refine', pendingActionId: 'PA1', operation: { op: 'cancel' } },
      { kind: 'refine', pendingActionId: 'PA1', operation: { op: 'revise_dashboard', title: { value: 'New', source: 'generated' } } },
      { kind: 'artifact', sourceStateId: 'ST1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null, title: { value: 'T', source: 'generated' }, outputFormat: 'preview', visual: null },
      clarifyStep, conversationStep,
    ];
    for (const step of steps) {
      const parsed = turnStepSchema.parse(JSON.parse(JSON.stringify(step)));
      expect(turnStepSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
    const full = turnPlanSchema.parse(plan(queryStep(), shareStep()));
    expect(turnPlanSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it.each([
    ['unknown top-level key', { ...plan(conversationStep), extra: 1 }],
    ['wrong version', { turnPlanVersion: 2, steps: [conversationStep] }],
    ['zero steps', plan()],
    ['three steps', plan(conversationStep, conversationStep, conversationStep)],
    ['unknown kind', plan({ kind: 'shell', cmd: 'x' })],
    ['extra key on step', plan({ ...conversationStep, extra: true })],
    ['unknown source', plan({ ...shareStep(), params: { dashboard: { value: 'D1', source: 'explicit' } } })],
    ['extra key on param', plan({ ...shareStep(), params: { dashboard: { value: 'D1', source: 'context_id', confidence: 1 } } })],
    ['bad context id charset', plan({ kind: 'refine', pendingActionId: 'a b', operation: { op: 'cancel' } })],
    ['empty prose', plan({ ...conversationStep, prose: ' ' })],
    ['too many clarify slots', plan({ ...clarifyStep, missing: Array.from({ length: 5 }, () => ({ slot: 'a', reason: 'absent' })) })],
  ])('rejects %s', (_name, raw) => {
    expect(turnPlanSchema.safeParse(raw).success).toBe(false);
  });

  it('enforces the envelope rules', () => {
    expect(envelopeError([{ kind: 'query' }, { kind: 'action' }])).toBeNull();
    expect(envelopeError([{ kind: 'hr_query' }, { kind: 'artifact' }])).toBeNull();
    expect(envelopeError([{ kind: 'action' }, { kind: 'action' }])).not.toBeNull();
    expect(envelopeError([{ kind: 'query' }, { kind: 'clarify' }])).not.toBeNull();
    expect(envelopeError([{ kind: 'query' }, { kind: 'query' }])).not.toBeNull();
    expect(envelopeError([{ kind: 'conversation' }, { kind: 'action' }])).not.toBeNull();
  });
});

describe('action registry', () => {
  it('registers the actions with runtime-contract risk tiers and unique ids', () => {
    expect(actionRegistry.ids()).toEqual(['dashboard.create', 'dashboard.share', 'dashboard.revoke_share', 'ticket.create', 'badge.revoke', 'communication.send', 'monitor.create', 'monitor.manage', 'result.manage', 'result.unarchive', 'dashboard.rename', 'dashboard.delete', 'artifact.share', 'task.create', 'policy.acknowledge',
      'onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email', 'dashboard.manage']);
    expect(ACTION_DEFINITIONS.filter(d => d.riskTier === 'direct').map(d => d.actionId)).toEqual(['dashboard.create', 'monitor.manage', 'result.manage', 'result.unarchive', 'dashboard.rename', 'dashboard.manage']);
    expect(ACTION_DEFINITIONS.every(d => d.requiredPermissions.length > 0 || (d.anyPermissions?.length ?? 0) > 0)).toBe(true);
    expect(() => createActionRegistry([ACTION_DEFINITIONS[0], ACTION_DEFINITIONS[0]])).toThrow(/Duplicate/);
  });

  it('filters actions by role permissions', () => {
    const ids = (permissions: string[]) => actionRegistry.availableFor({ permissions }).map(d => d.actionId);
    expect(ids(['dashboard.create', 'dashboard.share', 'ticket.create', 'sales.read'])).toEqual(['dashboard.create', 'dashboard.share', 'dashboard.revoke_share', 'ticket.create', 'communication.send', 'monitor.create', 'monitor.manage', 'result.manage', 'result.unarchive', 'dashboard.rename', 'dashboard.delete', 'artifact.share', 'task.create', 'dashboard.manage']);
    expect(ids(['hr.read', 'badge.revoke'])).toEqual(['badge.revoke', 'policy.acknowledge']);
    expect(ids(['dashboard.create'])).toEqual(['dashboard.create', 'result.manage', 'result.unarchive', 'dashboard.delete']);
    expect(ids([])).toEqual([]);
    // HR Director: exactly the Workflow V2 director permissions; HR Admin / Sales never hold them.
    expect(ids(['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'])).toEqual(['onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email']);
    expect(ids(['hr.onboarding.director_read', 'hr.onboarding.director_approve'])).toEqual(['onboarding.director_approve', 'onboarding.notify_email']);
    expect(actionRegistry.describeFor({ permissions: ['badge.revoke'] }).map(d => d.actionId)).toEqual(['badge.revoke']);
  });

  it('describes params with provenance, verbatim and default flags', () => {
    const [badge] = actionRegistry.describeFor({ permissions: ['badge.revoke'] });
    const reason = badge.params.find(p => p.name === 'reason');
    expect(reason).toMatchObject({ required: true, verbatim: true, sources: ['user_quoted'] });
    const [dash] = actionRegistry.describeFor({ permissions: ['dashboard.create'] });
    expect(dash.params.find(p => p.name === 'date')).toMatchObject({ required: false, hasDefault: true });
    expect(dash.params.find(p => p.name === 'title')?.sources).toEqual(['user_quoted', 'generated']);
  });

  it('typed params schema narrows sources and rejects unknown params', () => {
    const schema = actionParamsSchema(actionRegistry.get('badge.revoke')!);
    const ok = { badgeId: { value: 'B', source: 'context_id' }, employeeId: { value: 'E', source: 'context_id' }, reason: { value: 'lost', source: 'user_quoted', evidenceText: 'lost' } };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, reason: { value: 'lost', source: 'generated' } }).success).toBe(false);
    expect(schema.safeParse({ ...ok, other: ok.badgeId }).success).toBe(false);
    expect(schema.safeParse({ badgeId: ok.badgeId }).success).toBe(false);
  });

  it('binds handlers fail-closed', () => {
    const handlers = actionRegistry.ids().map(actionId => ({ actionId, run: async () => ({ outcome: 'failed' as const, code: 'x', text: 'x' }) }));
    expect(bindHandlers(actionRegistry, handlers).size).toBe(19);
    expect(() => bindHandlers(actionRegistry, handlers.slice(1))).toThrow(/Missing handler/);
    expect(() => bindHandlers(actionRegistry, [...handlers, { actionId: 'nope', run: handlers[0].run }])).toThrow(/unregistered/);
    expect(() => bindHandlers(actionRegistry, [...handlers, handlers[0]])).toThrow(/Duplicate/);
  });
});

describe('planner JSON schema', () => {
  const executive = actionRegistry.availableFor({ permissions: ['dashboard.create', 'dashboard.share', 'ticket.create'] });
  const typical = ['query', 'action', 'refine', 'clarify', 'conversation'] as const;

  it('stays within the size budget', () => {
    const size = jsonSchemaBytes(plannerJsonSchema({ actions: executive, kinds: typical }));
    expect(size).toBeLessThanOrEqual(PLANNER_JSON_SCHEMA_MAX_BYTES);
    expect(jsonSchemaBytes(plannerJsonSchema({ actions: executive }))).toBeLessThanOrEqual(PLANNER_JSON_SCHEMA_MAX_BYTES + 3 * 1024);
  });

  it('only exposes usable action ids and enabled kinds', () => {
    const hr = JSON.stringify(plannerJsonSchema({ actions: actionRegistry.availableFor({ permissions: ['badge.revoke'] }), kinds: ['action', 'clarify'] }));
    expect(hr).toContain('badge.revoke');
    expect(hr).not.toContain('dashboard.share');
    expect(hr).not.toContain('continuation');
    const none = JSON.stringify(plannerJsonSchema({ actions: [], kinds: ['action', 'conversation'] }));
    expect(none).not.toContain('actionId');
  });

  it('is draft-07 and the zod schema accepts valid plans', () => {
    const json = plannerJsonSchema({ actions: executive });
    expect(JSON.stringify(json)).not.toContain('additionalProperties');
    expect(plannerTurnPlanSchema({ actions: executive }).safeParse(plan(shareStep())).success).toBe(true);
    expect(plannerTurnPlanSchema({ actions: [] }).safeParse(plan(shareStep())).success).toBe(false);
  });
});
