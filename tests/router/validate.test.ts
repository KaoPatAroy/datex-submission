import { describe, expect, it } from 'vitest';
import { validateTurnPlan, type TurnPlanValidation } from '@/lib/router/validate';
import { contextFor, fromContext, inputFor, MESSAGE, plan, quoted, queryStep, revokeStep, shareStep } from './fixtures';

const outcome = (result: TurnPlanValidation) => result.outcome === 'accepted' ? 'accepted' : `${result.outcome}:${result.code}`;
const run = (raw: unknown, role: 'executive' | 'east_manager' | 'hr_admin' = 'executive', extra = {}, hooks = undefined as Parameters<typeof inputFor>[3]) =>
  validateTurnPlan(inputFor(raw, role, extra, hooks));
const action = (actionId: string, params: Record<string, unknown>) => ({ kind: 'action', actionId, params });
const accepted = (result: TurnPlanValidation) => {
  if (result.outcome !== 'accepted') throw new Error(`expected accepted, got ${outcome(result)}: ${JSON.stringify(result)}`);
  return result;
};

describe('accepted plans', () => {
  it('accepts a share action with context + user_quoted params', () => {
    const result = accepted(run(plan(shareStep())));
    expect(result.steps[0].params.recipientId).toMatchObject({ source: 'user_quoted', serverDefault: false });
    expect(result.steps[0].params.recipientId.span?.text).toBe('Somchai');
    expect(result.steps[0].riskTier).toBe('confirm');
  });

  it('fills registry defaults and labels them', () => {
    const result = accepted(run(plan(action('dashboard.create', {}))));
    expect(result.steps[0].params.regionIds).toMatchObject({ value: ['east', 'west'], source: 'default', serverDefault: true });
    expect(result.steps[0].params.date).toMatchObject({ value: '2026-10-06', serverDefault: true });
  });

  it('allows generated titles with no evidence', () => {
    const raw = plan(action('dashboard.create', { title: { value: 'Weekly overview', source: 'generated' } }));
    expect(accepted(run(raw)).steps[0].params.title).toMatchObject({ source: 'generated', span: null });
  });

  it('a model-sent default is replaced by the registry default (server-labeled), never by the model value', () => {
    const ok = plan(action('dashboard.create', { date: { value: '2026-10-06', source: 'default' } }));
    expect(outcome(run(ok))).toBe('accepted');
    const bad = run(plan(action('dashboard.create', { date: { value: '2026-10-01', source: 'default' } })));
    expect(outcome(bad)).toBe('accepted');
    if (bad.outcome === 'accepted') expect(bad.steps[0].params.date).toMatchObject({ value: '2026-10-06', source: 'default', serverDefault: true });
  });

  it('accepts inherited values equal to prior state and rejects a different one', () => {
    const ok = plan(action('dashboard.create', { date: { value: '2026-10-05', source: 'inherited' } }));
    expect(outcome(run(ok))).toBe('accepted');
    const bad = plan(action('dashboard.create', { date: { value: '2026-10-04', source: 'inherited' } }));
    expect(outcome(run(bad))).toBe('clarify:inherited_mismatch');
    const noPrior = run(ok, 'executive', { context: contextFor('executive', { previousState: null }) });
    expect(outcome(noPrior)).toBe('clarify:inherited_mismatch');
  });

  it('inherits refine title from the pending payload', () => {
    const raw = plan({ kind: 'refine', pendingActionId: 'PA1', operation: { op: 'revise_dashboard', title: { value: 'Draft', source: 'inherited' } } });
    expect(outcome(run(raw))).toBe('accepted');
  });

  it('binds query continuation to prior state, or treats it as fresh', () => {
    expect(accepted(run(plan(queryStep(true)))).steps[0].continuation).toBe('bound');
    expect(accepted(run(plan(queryStep(false)))).steps[0].continuation).toBe('none');
    const fresh = run(plan(queryStep(true)), 'executive', { context: contextFor('executive', { previousState: null }) });
    expect(accepted(fresh).steps[0].continuation).toBe('fresh');
  });

  it('accepts a query then action two-step plan with $step0', () => {
    const raw = plan(queryStep(), action('communication.send', { recipientIds: { value: ['U_SOMCHAI'], source: 'context_id' }, content: fromContext('$step0') }));
    const context = contextFor('executive');
    context.scope.permissions.push('communication.send');
    context.actions = [...context.actions, ...contextFor('executive', {}).actions];
    const base = inputFor(raw);
    const withPerm = { ...base, context: { ...context, actions: base.registry.describeFor({ permissions: context.scope.permissions }) } };
    expect(outcome(validateTurnPlan(withPerm))).toBe('accepted');
  });
});

describe('schema and envelope rejections', () => {
  it('denies malformed output with issue paths', () => {
    const result = run({ turnPlanVersion: 1, steps: [{ kind: 'nope' }] });
    expect(result).toMatchObject({ outcome: 'denied', code: 'invalid_plan' });
    expect(run('not json')).toMatchObject({ outcome: 'denied', code: 'invalid_plan' });
  });

  it('denies illegal two-step envelopes', () => {
    expect(outcome(run(plan(shareStep(), shareStep())))).toBe('denied:envelope_invalid');
    expect(outcome(run(plan(queryStep(), { kind: 'conversation', topic: 'greeting', prose: 'hi' })))).toBe('denied:envelope_invalid');
  });

  it('denies unknown actions', () => {
    expect(outcome(run(plan(action('dashboard.refine', {}))))).toBe('denied:unknown_action');
    expect(outcome(run(plan(action('rm.rf', {}))))).toBe('denied:unknown_action');
  });

  it('denies invalid typed params and disallowed sources', () => {
    // Undeclared params are model noise: dropped by canonicalization (executors only ever read declared params).
    const extra = run(plan(action('dashboard.share', { dashboard: fromContext('D1'), recipientId: fromContext('U_SOMCHAI'), extra: fromContext('x') })));
    expect(outcome(extra)).toBe('accepted');
    if (extra.outcome === 'accepted') expect(Object.keys(extra.steps[0].params).sort()).toEqual(['dashboard', 'recipientId']);
    const generatedId = plan(action('dashboard.share', { dashboard: { value: 'D1', source: 'generated' }, recipientId: fromContext('U_SOMCHAI') }));
    expect(outcome(run(generatedId))).toBe('denied:invalid_plan');
    const badValue = plan(action('dashboard.create', { date: quoted('not-a-date', 'Please') }));
    expect(outcome(run(badValue))).toBe('denied:invalid_plan');
  });

  it('drops evidenceText on non user_quoted sources (context ids are checked against the context, never the message)', () => {
    const raw = plan(action('dashboard.share', { dashboard: { value: 'D1', source: 'context_id', evidenceText: 'dashboard' }, recipientId: fromContext('U_SOMCHAI') }));
    const result = run(raw);
    expect(outcome(result)).toBe('accepted');
    if (result.outcome === 'accepted') expect(result.plan.steps[0]).toMatchObject({ params: { dashboard: { value: 'D1', source: 'context_id' } } });
    if (result.outcome === 'accepted') expect(JSON.stringify(result.plan)).not.toContain('evidenceText');
    // An unknown context id is still refused whatever evidence text came with it.
    expect(outcome(run(plan(action('dashboard.share', { dashboard: { value: 'D9', source: 'context_id', evidenceText: 'dashboard' }, recipientId: fromContext('U_SOMCHAI') }))))).toBe('clarify:unknown_context_id');
  });
});

describe('permissions, scope and catalog', () => {
  it('denies actions the role lacks', () => {
    expect(outcome(run(plan(revokeStep()), 'executive'))).toBe('denied:permission_denied');
    expect(outcome(run(plan(shareStep()), 'hr_admin'))).toBe('denied:permission_denied');
    expect(outcome(run(plan(revokeStep()), 'hr_admin'))).toBe('accepted');
  });

  it('denies when the actor has the permission but the context does not list the action', () => {
    const context = contextFor('executive', { actions: [] });
    expect(outcome(run(plan(shareStep()), 'executive', { context }))).toBe('denied:permission_denied');
  });

  it('applies the fresh permission hook', () => {
    expect(outcome(run(plan(shareStep()), 'executive', {}, { permitAction: () => false }))).toBe('denied:permission_denied');
  });

  it('denies regions and branches outside the authorized scope', () => {
    const north = plan(action('dashboard.create', { regionIds: quoted(['north'], 'Bangkok') }));
    expect(outcome(run(north, 'executive'))).toBe('denied:scope_denied');
    const west = plan(action('dashboard.create', { regionIds: quoted(['west'], 'Bangkok') }));
    expect(outcome(run(west, 'east_manager'))).toBe('denied:scope_denied');
    expect(outcome(run(west, 'executive'))).toBe('accepted');
    const branch = plan(action('ticket.create', { branchIds: quoted(['BR99'], 'Bangkok') }));
    expect(outcome(run(branch))).toBe('denied:scope_denied');
    const wild = contextFor('executive');
    wild.scope.regionIds = ['*'];
    expect(outcome(run(north, 'executive', { context: wild }))).toBe('accepted');
  });

  it('applies the scope hook to resolved scope', () => {
    const raw = plan(action('ticket.create', { branchIds: quoted(['BR01'], 'Bangkok') }));
    expect(outcome(run(raw, 'executive', {}, { permitScope: () => true }))).toBe('accepted');
    expect(outcome(run(raw, 'executive', {}, { permitScope: (_id, scope) => scope.branchIds?.[0] !== 'BR01' }))).toBe('denied:scope_denied');
  });

  it('checks dataset availability and kind match', () => {
    expect(outcome(run(plan(queryStep()), 'hr_admin'))).toBe('denied:dataset_unavailable');
    const salesPlan = (queryStep() as { plan: Record<string, unknown> }).plan;
    const hrOnSales = { kind: 'hr_query', plan: salesPlan };
    const hrPlan = { kind: 'hr_query', plan: { ...salesPlan, datasetId: 'hr_employees' } };
    expect(outcome(run(plan(hrPlan), 'executive'))).toBe('denied:dataset_unavailable');
    expect(outcome(run(plan(hrPlan), 'hr_admin'))).toBe('accepted');
    const mismatch = contextFor('executive');
    mismatch.catalog.datasets.push({ id: 'hr_employees', label: 'Employees' });
    expect(outcome(run(plan(hrOnSales), 'executive', { context: mismatch }))).toBe('denied:dataset_mismatch');
  });
});

describe('evidence and provenance', () => {
  it('clarifies when evidenceText is not in the message', () => {
    const raw = plan(shareStep({ recipientId: quoted('U_SOMCHAI', 'Somsak') }));
    expect(run(raw)).toMatchObject({ outcome: 'clarify', code: 'evidence_not_found', slot: 'params.recipientId' });
  });

  it('requires evidenceText for user_quoted', () => {
    const raw = plan(shareStep({ recipientId: { value: 'U_SOMCHAI', source: 'user_quoted' } }));
    expect(outcome(run(raw))).toBe('clarify:evidence_not_found');
  });

  it('requires the badge reason to be user_quoted, verbatim and present', () => {
    expect(outcome(run(plan(revokeStep({ reason: { value: 'lost badge', source: 'generated' } })), 'hr_admin'))).toBe('denied:invalid_plan');
    expect(outcome(run(plan(revokeStep({ reason: { value: 'lost badge', source: 'context_id' } })), 'hr_admin'))).toBe('denied:invalid_plan');
    expect(outcome(run(plan(revokeStep({ reason: quoted('badge was stolen', 'lost badge') })), 'hr_admin'))).toBe('clarify:verbatim_mismatch');
    expect(outcome(run(plan(revokeStep({ reason: quoted('lost badge', 'never said') })), 'hr_admin'))).toBe('clarify:evidence_not_found');
    const missing = { kind: 'action', actionId: 'badge.revoke', params: { badgeId: quoted('B1', 'badge B1'), employeeId: quoted('E1', 'badge B1') } };
    expect(run(plan(missing), 'hr_admin')).toMatchObject({ outcome: 'denied', code: 'invalid_plan' });
    expect(run(plan(revokeStep()), 'hr_admin')).toMatchObject({ outcome: 'accepted' });
  });

  it('matches evidence through span normalization (whitespace, NFC)', () => {
    const raw = plan(shareStep({ recipientId: quoted('U_SOMCHAI', 'with   Somchai') }));
    expect(outcome(run(raw))).toBe('accepted');
  });

  it('resolves clarified_turn evidence only against the persisted clarify message', () => {
    const raw = plan(shareStep({ recipientId: { value: 'U_SOMCHAI', source: 'user_quoted', evidenceText: 'Somsak', evidenceFrom: 'clarified_turn' } }));
    expect(outcome(run(raw))).toBe('clarify:clarified_turn_unavailable');
    const ok = run(raw, 'executive', { messages: { current: MESSAGE, clarifiedTurn: 'I meant Somsak' } });
    expect(outcome(ok)).toBe('accepted');
    const found = plan(shareStep({ recipientId: { value: 'U_SOMCHAI', source: 'user_quoted', evidenceText: 'Somchai', evidenceFrom: 'clarified_turn' } }));
    expect(outcome(run(found, 'executive', { messages: { current: 'x', clarifiedTurn: 'share with Somchai' } }))).toBe('accepted');
    expect(outcome(run(found, 'executive', { messages: { current: MESSAGE, clarifiedTurn: 'other words' } }))).toBe('clarify:evidence_not_found');
  });

  it('resolves an omitted quote marker only within the same pending action and never across message boundaries', () => {
    const pending = { about: 'action:dashboard.share', missing: ['params.recipientId'] };
    const extra = { context: contextFor('executive', { pendingClarification: pending }),
      messages: { current: 'Use that recipient', clarifiedTurns: ['share with', 'Somchai'] } };
    const raw = plan(shareStep({ recipientId: quoted('U_SOMCHAI', 'Somchai') }));
    expect(outcome(run(raw, 'executive', extra))).toBe('accepted');
    expect(outcome(run(plan(shareStep({ recipientId: quoted('U_SOMCHAI', 'with Somchai') })), 'executive', extra))).toBe('clarify:evidence_not_found');
    expect(outcome(run(raw, 'executive', { ...extra, context: contextFor('executive', { pendingClarification: { ...pending, about: 'action:task.create' } }) }))).toBe('clarify:evidence_not_found');
    expect(outcome(run(plan(shareStep({ recipientId: { ...quoted('U_SOMCHAI', 'Somchai'), evidenceFrom: 'current' } })), 'executive', extra))).toBe('clarify:evidence_not_found');
  });

  it('clarifies on missing required params and unknown context ids', () => {
    const missing = plan({ kind: 'action', actionId: 'dashboard.share', params: { dashboard: fromContext('D1') } });
    expect(run(missing)).toMatchObject({ outcome: 'denied', code: 'invalid_plan' });
    expect(outcome(run(plan(shareStep({ dashboard: fromContext('D404') }))))).toBe('clarify:unknown_context_id');
    expect(outcome(run(plan(shareStep({ recipientId: quoted('U_OTHER', 'Somchai') }))))).toBe('clarify:unknown_context_id');
    const arr = plan(action('dashboard.create', { measureIds: fromContext(['net_sales', 'bogus']) }));
    expect(outcome(run(arr))).toBe('clarify:unknown_context_id');
  });

  it('rejects unsafe generated text', () => {
    const raw = plan(action('dashboard.create', { title: { value: 'Weekly\u0000', source: 'generated' } }));
    expect(outcome(run(raw))).toBe('clarify:unsafe_generated');
    const hook = run(plan(action('dashboard.create', { title: { value: 'Weekly overview', source: 'generated' } })), 'executive', {}, { isSafeText: () => false });
    expect(outcome(hook)).toBe('clarify:unsafe_generated');
  });

  it('only allows $step0 in step 1 of a query plan', () => {
    const context = contextFor('executive');
    context.scope.permissions.push('monitor.create');
    const action1 = { kind: 'action', actionId: 'monitor.create', params: {
      query: fromContext('$step0'), threshold: quoted(0.8, 'Bangkok'), recipientIds: fromContext(['U_SOMCHAI']) } };
    const input = (raw: unknown) => ({ ...inputFor(raw), context: { ...context, actions: inputFor(raw).registry.describeFor({ permissions: context.scope.permissions }) } });
    expect(outcome(validateTurnPlan(input(plan(action1))))).toBe('clarify:unknown_context_id');
    expect(outcome(validateTurnPlan(input(plan(queryStep(), action1))))).toBe('accepted');
  });
});

describe('refine and artifact', () => {
  const revise = (operation: unknown, id = 'PA1') => plan({ kind: 'refine', pendingActionId: id, operation });
  it('requires the pending action to exist in context', () => {
    expect(outcome(run(revise({ op: 'cancel' }, 'PA9')))).toBe('clarify:unknown_context_id');
    expect(outcome(run(revise({ op: 'cancel' })))).toBe('accepted');
  });

  it('validates widget indexes against the pending action and requires a change', () => {
    const ok = revise({ op: 'revise_dashboard', removeWidgetIndexes: fromContext([1, 2]) });
    expect(outcome(run(ok))).toBe('accepted');
    expect(outcome(run(revise({ op: 'revise_dashboard', removeWidgetIndexes: fromContext([7]) })))).toBe('clarify:unknown_context_id');
    expect(outcome(run(revise({ op: 'revise_dashboard' })))).toBe('clarify:missing_param');
    expect(outcome(run(revise({ op: 'revise_dashboard', removeWidgetIndexes: quoted([1], 'Somchai') })))).toBe('denied:source_not_allowed');
  });

  it('title is generated or quoted', () => {
    expect(outcome(run(revise({ op: 'revise_dashboard', title: quoted('Bangkok dashboard', 'Bangkok dashboard') })))).toBe('accepted');
    expect(outcome(run(revise({ op: 'revise_dashboard', title: quoted('Other', 'Other') })))).toBe('clarify:evidence_not_found');
    expect(outcome(run(revise({ op: 'revise_dashboard', title: { value: 'Fresh', source: 'generated' } })))).toBe('accepted');
  });

  const artifact = (over: Record<string, unknown> = {}) => plan({
    kind: 'artifact', sourceStateId: 'ST1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null,
    title: { value: 'Sales table', source: 'generated' }, outputFormat: 'preview', visual: null, ...over,
  });
  it('validates artifact references and shape rules', () => {
    expect(outcome(run(artifact()))).toBe('accepted');
    expect(outcome(run(artifact({ sourceStateId: 'ST9' })))).toBe('clarify:unknown_context_id');
    expect(outcome(run(artifact({ operation: 'revise' })))).toBe('denied:invalid_plan');
    expect(outcome(run(artifact({ operation: 'revise', baseArtifactId: 'AR1' })))).toBe('accepted');
    expect(outcome(run(artifact({ operation: 'revise', baseArtifactId: 'AR9' })))).toBe('clarify:unknown_context_id');
    expect(outcome(run(artifact({ artifactTypeId: 'chart' })))).toBe('denied:invalid_plan');
    expect(outcome(run(artifact({ outputFormat: 'csv' })))).toBe('denied:invalid_plan');
  });
});

describe('clarify and conversation', () => {
  const clarify = (over: Record<string, unknown> = {}) => plan({
    kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
    missing: [{ slot: 'params.recipientId', reason: 'absent' }], question: 'Who should receive it?',
    choices: [{ id: 'U_SOMCHAI', label: 'Invented label' }, { id: 'U_GHOST', label: 'Hidden person' }], ...over,
  });

  it('relabels choices from server labels and drops unknown ones', () => {
    const result = accepted(run(clarify()));
    expect(result.steps[0].step).toMatchObject({ choices: [{ id: 'U_SOMCHAI', label: 'Somchai' }] });
    expect(result.steps[0].safeText).toBe('Who should receive it?');
  });

  it('rejects unknown targets and slots', () => {
    expect(outcome(run(clarify({ about: { kind: 'action', actionId: 'nope' } })))).toBe('denied:unknown_clarify_target');
    expect(outcome(run(clarify({ about: { kind: 'refine', pendingActionId: 'PA9' } })))).toBe('denied:unknown_clarify_target');
    expect(outcome(run(clarify({ missing: [{ slot: 'params.bogus', reason: 'absent' }] })))).toBe('denied:invalid_plan');
  });

  it('nulls unsafe question and prose so the server uses its own text', () => {
    const unsafe = { isSafeText: () => false };
    expect(accepted(run(clarify(), 'executive', {}, unsafe)).steps[0].safeText).toBeNull();
    const chat = plan({ kind: 'conversation', topic: 'advice', prose: 'Sales are 12345' });
    expect(accepted(run(chat, 'executive', {}, unsafe)).steps[0].safeText).toBeNull();
    expect(accepted(run(chat)).steps[0].safeText).toBe('Sales are 12345');
  });
});

describe('S1: policy.acknowledge only for a policy the actor was shown', () => {
  const policies = [{ id: 'POL_1', title: 'Incident handling', version: '1.0' }, { id: 'POL_2', title: 'Other', version: '2.0' }];
  const ack = (id: string, version: string) => action('policy.acknowledge', { policy: fromContext(id), version: fromContext(version) });
  const withPolicies = (shownPolicies: { id: string; version: string }[]) => ({ context: contextFor('executive', { policies, shownPolicies }) });
  it('accepts a shown id+version, refuses an unseen policy or a different version', () => {
    expect(outcome(run(plan(ack('POL_1', '1.0')), 'executive', withPolicies([{ id: 'POL_1', version: '1.0' }])))).toBe('accepted');
    expect(outcome(run(plan(ack('POL_2', '2.0')), 'executive', withPolicies([{ id: 'POL_1', version: '1.0' }])))).toBe('clarify:policy_not_shown');
    expect(outcome(run(plan(ack('POL_1', '1.0')), 'executive', withPolicies([])))).toBe('clarify:policy_not_shown');
  });
});

