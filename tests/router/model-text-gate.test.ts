import { describe, expect, it } from 'vitest';
import { validateTurnPlan, type TurnPlanValidation } from '@/lib/router/validate';
import { contextFor, fromContext, fullCapabilityContext, inputFor, plan, quoted } from './fixtures';
import { executeResourceLookupStep } from '@/lib/router/executors/resource-lookup';
import type { Actor } from '@/lib/contracts';

/**
 * G6: every model-authored user-visible string passes the ONE model-text gate (modelTextSafe) WITHOUT relying on a caller hook:
 * validate runs it on conversation prose, clarify questions and generated free-text params; a blocked title falls back to a server title.
 */
const CLAIM_EN = 'Dashboard created and ready to use';
const CLAIM_TH = 'สร้าง Dashboard เรียบร้อยแล้ว';
const outcome = (result: TurnPlanValidation) => result.outcome === 'accepted' ? 'accepted' : `${result.outcome}:${result.code}`;
const run = (raw: unknown, extra = {}) => validateTurnPlan(inputFor(raw, 'executive', extra));
const accepted = (result: TurnPlanValidation) => {
  if (result.outcome !== 'accepted') throw new Error(`expected accepted, got ${outcome(result)}`);
  return result;
};
const action = (actionId: string, params: Record<string, unknown>) => ({ kind: 'action', actionId, params });
const generated = (value: unknown) => ({ value, source: 'generated' });

describe('validate gates model text without any hook', () => {
  it.each([CLAIM_EN, CLAIM_TH])('nulls conversation and product_help prose that claims a completion: %s', claim => {
    expect(accepted(run(plan({ kind: 'conversation', topic: 'advice', prose: claim }))).steps[0].safeText).toBeNull();
    expect(accepted(run(plan({ kind: 'conversation', topic: 'product_help', prose: claim }))).steps[0].safeText).toBeNull();
    expect(accepted(run(plan({ kind: 'conversation', topic: 'advice', prose: 'Dashboards re-query permitted data whenever they are opened.' }))).steps[0].safeText).not.toBeNull();
  });

  it.each([`${CLAIM_EN}. Who should receive it?`, `${CLAIM_TH} ต้องส่งให้ใคร`])('nulls a clarify question that claims a completion: %s', question => {
    const raw = plan({ kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' }, missing: [{ slot: 'params.recipientId', reason: 'absent' }],
      question, choices: [] });
    expect(accepted(run(raw)).steps[0].safeText).toBeNull();
  });

  it.each([CLAIM_EN, CLAIM_TH])('a blocked generated Dashboard title is dropped so the server title applies: %s', claim => {
    const result = accepted(run(plan(action('dashboard.create', { title: generated(claim) }))));
    expect(result.steps[0].params.title).toBeUndefined();
    // A user-quoted title is the user's own words, never gated as model text.
    expect(accepted(run(plan(action('dashboard.create', { title: quoted('Bangkok dashboard', 'Bangkok dashboard') })))).steps[0].params.title?.value).toBe('Bangkok dashboard');
  });

  it.each([CLAIM_EN, CLAIM_TH])('a blocked generated Result title falls back to a server title: %s', claim => {
    const raw = plan({ kind: 'artifact', sourceStateId: 'ST1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null,
      title: generated(claim), outputFormat: 'preview', visual: null });
    const title = accepted(run(raw)).steps[0].params.title;
    expect(title).toMatchObject({ source: 'default', serverDefault: true });
    expect(title?.value).toBe('ตาราง — Branch performance');
  });

  it('a blocked generated name the user must choose (rename, task title) is asked again, never shown', () => {
    expect(outcome(run(plan(action('dashboard.rename', { dashboard: fromContext('D1'), title: generated(CLAIM_EN) }))))).toBe('clarify:unsafe_generated');
    const refine = plan({ kind: 'refine', pendingActionId: 'PA1', operation: { op: 'revise_dashboard', title: generated(CLAIM_TH) } });
    expect(outcome(run(refine))).toBe('clarify:unsafe_generated');
    expect(outcome(run(plan({ kind: 'refine', pendingActionId: 'PA1', operation: { op: 'revise_dashboard', title: generated('ยอดขายภาคตะวันออก') } })))).toBe('accepted');
  });

  it('a blocked optional staged text (task note / checklist) is dropped; enum values are not text', () => {
    const raw = plan(action('task.create', { title: generated('ติดตามยอดขายสาขา'), note: generated('ส่งให้ผู้จัดการเรียบร้อยแล้ว'),
      checklist: generated(['ตรวจสต็อก', 'Ticket has been submitted']), priority: generated('high') }));
    const params = accepted(run(raw)).steps[0].params;
    expect(params.title?.value).toBe('ติดตามยอดขายสาขา');
    expect(params.note).toBeUndefined();
    expect(params.checklist).toBeUndefined();
    expect(params.priority?.value).toBe('high');
  });

  it('a blocked Email subject/body is dropped so the executor writes its server template', () => {
    const base = fullCapabilityContext();
    const context = { ...base, workflow: { ...base.workflow!, verifiedApprovals: [{ id: 'APR1', label: 'Approval', requestIds: ['R1'] }] } };
    const raw = plan(action('onboarding.notify_email', { approval: fromContext('APR1'), subject: generated('อนุมัติเรียบร้อยแล้ว'), body: generated('Your request has been approved.') }));
    const params = accepted(run(raw, { context })).steps[0].params;
    expect(params.subject).toBeUndefined();
    expect(params.body).toBeUndefined();
  });

  it('visualization text is not a validation failure: the builder falls back to server copy', () => {
    const visualization = { version: 1, title: CLAIM_EN, description: CLAIM_TH, widgets: [{ kind: 'bar', title: 'Sales updated', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: null }] };
    const raw = plan(action('dashboard.create', { source: fromContext('ST1') }), );
    (raw.steps[0] as Record<string, unknown>).visualization = visualization;
    expect(outcome(run(raw, { context: contextFor('executive') }))).toBe('accepted');
  });
});

describe('resource_lookup does not echo a model name fragment that claims a completion', () => {
  const actor = { id: 'U1' } as Actor;
  const ports = { search: async () => ({ items: [], total: 0 }) };
  it('echoes a plain fragment and withholds a claim', async () => {
    const plain = await executeResourceLookupStep({ ports, actor, step: { kind: 'resource_lookup', resource: 'dashboard', query: 'ยอดขาย' } });
    expect(plain.text).toContain('“ยอดขาย”');
    const claim = await executeResourceLookupStep({ ports, actor, step: { kind: 'resource_lookup', resource: 'dashboard', query: 'Dashboard deleted' } });
    expect(claim.text).not.toContain('deleted');
  });
});
