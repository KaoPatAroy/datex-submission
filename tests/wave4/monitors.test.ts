import { describe, expect, it } from 'vitest';
import { monitorPlanSchema, runMonitorPlan, type MonitorContext, type MonitorState } from '../../lib/monitors';
import { accepted, acceptancePrompts, fixture, next, ref, updatedEvidence } from './fixtures';

function install() {
  const f = fixture();
  let out = accepted(runMonitorPlan({ request: { phase: 'preview', plan: f.monitor }, context: f.context }));
  for (const phase of ['confirm', 'execute', 'verify'] as const) {
    out = accepted(runMonitorPlan({ request: next(phase, out.state.workflow), state: out.state, context: f.context }));
  }
  return { ...f, state: out.state };
}
function evaluate(state: MonitorState, context: MonitorContext, evidence = context.evidence.filter(e => e.sales).at(-1)?.ref ?? ref('evidence_east')) {
  return runMonitorPlan({ request: { phase: 'evaluate', state, expectedVersion: state.version, evidence }, context });
}

describe('Wave 4 monitors', () => {
  it.each(acceptancePrompts.filter(p => p.capability === 'monitor'))('acceptance fixture: $prompt', () => {
    const f = fixture();
    const p = accepted(runMonitorPlan({ request: { phase: 'preview', plan: f.monitor }, context: f.context }));
    expect(p.alert).toBeNull();
    expect(p.state.workflow.preview.intent.targets).toEqual([ref('team_east')]);
    expect(p.state.workflow.preview.intent.content).toContain('100% of target');
    expect(p.state.workflow.preview.intent.binding).toMatchObject({ recipients: [{ name: 'East Team' }] });
    expect(evaluate(p.state, f.context).outcome).toBe('execution_failed');
  });
  it('evaluates a real evidenced threshold, with no delivery side effects', () => {
    const f = install(), before = structuredClone(f.state);
    const out = accepted(evaluate(f.state, f.context));
    expect(out.alert).toMatchObject({ recipientIds: ['team_east'], evidence: ref('evidence_east'), branchIds: ['E03'] });
    expect(out.state.history[0].alert).toBe(true);
    expect(f.state).toEqual(before);
    const normal = updatedEvidence(f.context, 1, 1000);
    expect(accepted(evaluate(out.state, normal)).alert).toBeNull();
  });
  it('daily monitors are not re-evaluated within the day and say Daily in the preview; stored hourly plans still validate', () => {
    const f = fixture(), daily = { ...f.monitor, cadenceId: 'daily', cooldownId: 'one_day' };
    const preview = accepted(runMonitorPlan({ request: { phase: 'preview', plan: daily }, context: f.context }));
    expect(preview.state.workflow.preview.intent.content).toContain('Daily sales below');
    expect(accepted(runMonitorPlan({ request: { phase: 'preview', plan: f.monitor }, context: f.context })).state.workflow.preview.intent.content).toContain('Hourly sales below');
  });
  it('formats fractional percentage thresholds deterministically', () => {
    const f = fixture(), plan = { ...f.monitor, threshold: 0.07 };
    const out = accepted(runMonitorPlan({ request: { phase: 'preview', plan }, context: f.context }));
    expect(out.state.workflow.preview.intent.content).toContain('7% of target');
  });
  it('keeps evaluation across session changes and marks changed authority for renewal', () => {
    const f = install();
    f.context.authority.actor.sessionId = 'session_2';
    const sameAuthority = accepted(evaluate(f.state, f.context));
    expect(sameAuthority.state.lifecycle).toBe('active');
    f.context.authority.actor.permissions = ['sales.read'];
    const changed = accepted(evaluate(sameAuthority.state, f.context));
    expect(changed.state.lifecycle).toBe('needs_renewal');
  });
  it('dedupes retries and old observations, enforces cadence/cooldown, then alerts on new evidence', () => {
    const f = install(), first = accepted(evaluate(f.state, f.context));
    expect(accepted(evaluate(first.state, f.context))).toEqual({ state: first.state, alert: null });
    const tooSoon = updatedEvidence(f.context, 0.5);
    expect(accepted(evaluate(first.state, tooSoon)).state).toEqual(first.state);
    const later = updatedEvidence(f.context, 1);
    const second = accepted(evaluate(first.state, later));
    expect(second.alert).not.toBeNull();
    const cooldownState = { ...first.state, lastEvaluatedAt: null };
    expect(accepted(evaluate(cooldownState, tooSoon)).alert).toBeNull();
    expect(accepted(evaluate(second.state, { ...later, now: later.now + 3_600_000 }, ref('evidence_east'))).alert).toBeNull();
  });
  it('pause/resume CAS preserves history and exact plan identity', () => {
    const f = install(), evaluated = accepted(evaluate(f.state, f.context));
    const paused = accepted(runMonitorPlan({ request: { phase: 'pause', state: evaluated.state, expectedVersion: evaluated.state.version }, context: f.context }));
    expect(paused.state.lifecycle).toBe('paused');
    expect(evaluate(paused.state, updatedEvidence(f.context, 1))).toMatchObject({ outcome: 'accepted', value: { state: paused.state, alert: null } });
    expect(runMonitorPlan({ request: { phase: 'resume', state: paused.state, expectedVersion: 0 }, context: f.context })).toMatchObject({ outcome: 'execution_failed', code: 'cas_conflict' });
    const resumed = accepted(runMonitorPlan({ request: { phase: 'resume', state: paused.state, expectedVersion: paused.state.version }, context: f.context }));
    expect(resumed.state.lifecycle).toBe('active');
    expect(resumed.state.history).toEqual(evaluated.state.history);
    expect(resumed.state.workflow.preview).toEqual(evaluated.state.workflow.preview);
  });
  it('bounds persistent evaluation history and preserves high-water dedupe after eviction', () => {
    const f = install();
    let state = f.state;
    for (let hour = 0; hour < 70; hour++) state = accepted(evaluate(state, updatedEvidence(f.context, hour))).state;
    expect(state.history).toHaveLength(64);
    const context = updatedEvidence(f.context, 71);
    expect(accepted(evaluate(state, context, ref('evidence_east'))).state).toEqual(state);
  });
  it('installation replay cannot reset alert history or pause state', () => {
    const f = install(), out = accepted(evaluate(f.state, f.context));
    const paused = accepted(runMonitorPlan({ request: { phase: 'pause', state: out.state, expectedVersion: out.state.version }, context: f.context }));
    const replay = accepted(runMonitorPlan({ request: next('execute', paused.state.workflow), state: paused.state, context: f.context }));
    expect(replay.state).toEqual(paused.state);
    const verifiedReplay = accepted(runMonitorPlan({ request: next('verify', paused.state.workflow), state: paused.state, context: f.context }));
    expect(verifiedReplay.state).toEqual(paused.state);
  });
  it.each(['conditionId', 'cadenceId', 'cooldownId'] as const)('rejects unregistered %s', key => {
    const f = fixture();
    expect(runMonitorPlan({ request: { phase: 'preview', plan: { ...f.monitor, [key]: 'eval' } }, context: f.context })).toMatchObject({ outcome: 'unsupported_concept' });
  });
  it.each(['extra', 'threshold', 'nonfinite', 'version', 'recipient_budget', 'query_budget', 'ambiguous_query'] as const)('validates schemas and budgets %s', kind => {
    const f = fixture(), plan: Record<string, unknown> = { ...f.monitor };
    if (kind === 'extra') plan.code = 'while(true) {}';
    if (kind === 'threshold') plan.threshold = 1.1;
    if (kind === 'nonfinite') plan.threshold = NaN;
    if (kind === 'version') plan.version = 2;
    if (kind === 'recipient_budget') plan.recipientIds = Array.from({ length: 21 }, (_, i) => `recipient_${i}`);
    if (kind === 'query_budget') f.context.queries[0].branchIds = Array.from({ length: 1001 }, (_, i) => `E${i}`);
    if (kind === 'ambiguous_query') f.context.queries = [];
    if (!['query_budget', 'ambiguous_query'].includes(kind)) expect(monitorPlanSchema.safeParse(plan).success).toBe(false);
    expect(runMonitorPlan({ request: { phase: 'preview', plan }, context: f.context }).outcome).not.toBe('accepted');
  });
  it.each(['south', 'permission', 'recipient', 'consent', 'query_version'] as const)('rechecks exact monitoring authority %s', kind => {
    const f = install();
    if (kind === 'south') f.context.queries[0].regions = ['south'];
    if (kind === 'permission') f.context.authority.actor.permissions = ['sales.read'];
    if (kind === 'recipient') f.context.authority.recipientIds = [];
    if (kind === 'consent') f.context.consents[0].granted = false;
    if (kind === 'query_version') f.context.queries[0].ref = ref('query_1', 2);
    const result = evaluate(f.state, f.context);
    if (kind === 'permission') expect(accepted(result).state.lifecycle).toBe('needs_renewal');
    else expect(result.outcome).not.toBe('accepted');
  });
  it.each(['missing', 'stale', 'partial', 'wrong_branch', 'duplicate', 'zero_target', 'nonfinite', 'wrong_scope', 'future'] as const)('rejects invalid observation %s', kind => {
    const f = install(), e = f.context.evidence[0];
    if (kind === 'missing') f.context.evidence = [];
    if (kind === 'stale') e.fresh = false;
    if (kind === 'partial') e.complete = false;
    if (kind === 'wrong_branch') e.sales = [{ branchId: 'S01', netSales: 1, target: 10 }];
    if (kind === 'duplicate') e.sales = [...e.sales!, ...e.sales!];
    if (kind === 'zero_target') e.sales = [{ branchId: 'E03', netSales: 0, target: 0 }];
    if (kind === 'nonfinite') e.sales = [{ branchId: 'E03', netSales: NaN, target: 10 }];
    if (kind === 'wrong_scope') e.regions = ['south'];
    if (kind === 'future') e.observedAt = f.context.now + 1;
    expect(evaluate(f.state, f.context, ref('evidence_east')).outcome).not.toBe('accepted');
  });
});
