import { describe, expect, it } from 'vitest';
import { actionPlanSchema, runActionPlan, type ActionPlan } from '../../lib/effects';
import { digest } from '../../lib/effects/shared';
import { accepted, acceptancePrompts, fixture, next, ref } from './fixtures';

describe('Wave 4 effects', () => {
  it.each(['action', 'badge'] as const)('preview → confirm → execute → verify %s with an exact receipt', kind => {
    const f = fixture(), plan = f[kind];
    const preview = accepted(runActionPlan({ request: { phase: 'preview', plan }, context: f.context, simulation: f.simulation }));
    expect(preview.simulation).toEqual(f.simulation);
    expect(preview.workflow.preview.intent.targets).toEqual(plan.targets);
    const confirmed = accepted(runActionPlan({ ...preview, request: next('confirm', preview.workflow), context: f.context }));
    const executed = accepted(runActionPlan({ ...confirmed, request: next('execute', confirmed.workflow), context: f.context }));
    expect(executed.workflow.receipt?.status).toBe('pending');
    const verified = accepted(runActionPlan({ ...executed, request: next('verify', executed.workflow), context: f.context }));
    expect(verified.workflow.receipt?.status).toBe('verified_success');
    expect(verified.workflow.audit.map(a => a.phase)).toEqual(['preview', 'confirm', 'execute', 'verify']);
    const replay = accepted(runActionPlan({ ...verified, request: next('execute', verified.workflow), context: f.context }));
    expect(replay).toEqual(verified);
  });
  it('execution requires confirmation of the exact preview', () => {
    const f = fixture(), before = digest(f.simulation);
    const preview = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    expect(runActionPlan({ ...preview, request: next('execute', preview.workflow), context: f.context })).toMatchObject({ outcome: 'execution_failed', code: 'confirmation_required' });
    expect(digest(f.simulation)).toBe(before);
  });
  it.each(['root', 'nested', 'version', 'approval', 'duplicate', 'budget', 'postcondition'] as const)('rejects invalid schema %s', kind => {
    const f = fixture();
    const plan: Record<string, unknown> = { ...f.action };
    if (kind === 'root') plan.sql = 'SELECT *';
    if (kind === 'nested') plan.effect = { ...f.action.effect, html: '<script />' };
    if (kind === 'version') plan.version = 2;
    if (kind === 'approval') plan.approvalRequired = false;
    if (kind === 'duplicate') plan.targets = [ref('team_east'), ref('team_east')];
    if (kind === 'budget') plan.targets = Array.from({ length: 21 }, (_, i) => ref(`team_${i}`));
    if (kind === 'postcondition') plan.expectedPostconditions = [];
    expect(actionPlanSchema.safeParse(plan).success).toBe(false);
  });
  it.each(['shell', 'dashboard_share_other', 'constructor', 'toString'])('rejects unregistered effect %s', actionId => {
    const f = fixture();
    expect(runActionPlan({ request: { phase: 'preview', plan: { ...f.action, actionId } }, context: f.context, simulation: f.simulation })).toMatchObject({ outcome: 'unsupported_concept', code: 'unknown_effect' });
  });
  it('rejects unregistered discriminator and postcondition', () => {
    const f = fixture();
    expect(runActionPlan({ request: { phase: 'preview', plan: { ...f.action, effect: { kind: 'eval' } } }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
    expect(runActionPlan({ request: { phase: 'preview', plan: { ...f.action, expectedPostconditions: ['anything'] } }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
  });
  it.each(['region', 'recipient', 'owner', 'permission', 'inactive', 'target_ref', 'artifact_ref', 'evidence_ref'] as const)('blocks scope/target mismatch %s', kind => {
    const f = fixture(), plan = f.action;
    if (kind === 'region') f.context.artifacts[0].regions = ['south'];
    if (kind === 'recipient' && plan.effect.kind === 'dashboard_share') { plan.effect.recipientIds = ['team_south']; plan.targets = [ref('team_south')]; }
    if (kind === 'owner') f.context.artifacts[0].ownerId = 'other';
    if (kind === 'permission') f.context.authority.actor.permissions = ['sales.read'];
    if (kind === 'inactive') f.context.authority.actor.active = false;
    if (kind === 'target_ref') plan.targets = [ref('team_east', 2)];
    if (kind === 'artifact_ref' && plan.effect.kind === 'dashboard_share') plan.effect.artifact = ref('dashboard_1', 2);
    if (kind === 'evidence_ref') plan.evidence = [ref('evidence_east', 2)];
    expect(runActionPlan({ request: { phase: 'preview', plan }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
  });
  it.each(['stale', 'partial', 'sensitive', 'inferred', 'verified_physical', 'expired', 'sources', 'claim_scope', 'content_budget'] as const)('blocks unsafe evidence %s', kind => {
    const f = fixture(), e = f.context.evidence[0];
    if (kind === 'stale') e.fresh = false;
    if (kind === 'partial') e.complete = false;
    if (kind === 'sensitive') e.sensitive = true;
    if (kind === 'inferred') e.trust = 'inferred';
    if (kind === 'verified_physical') e.trust = 'verified_physical';
    if (kind === 'expired') e.expiresAt = f.context.now;
    if (kind === 'sources') e.sourceIds = [];
    if (kind === 'claim_scope') f.context.claims[0].regions = ['south'];
    if (kind === 'content_budget') f.context.claims[0].text = 'x'.repeat(4001);
    expect(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
  });
  it.each(['sales_reason', 'wrong_employee', 'wrong_use'] as const)('requires certified employee-linked HR rationale %s', kind => {
    const f = fixture();
    if (kind === 'sales_reason' && f.badge.effect.kind === 'badge_revoke') { f.badge.effect.reasonClaimIds = ['sales_claim']; f.badge.evidence = [ref('evidence_east')]; }
    if (kind === 'wrong_employee') f.context.claims[1].subjectIds = ['other_employee'];
    if (kind === 'wrong_use') f.context.claims[1].allowedUses = ['communication'];
    expect(runActionPlan({ request: { phase: 'preview', plan: f.badge }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
  });
  it.each(['employee', 'scope', 'version', 'inactive'] as const)('validates badge identity %s', kind => {
    const f = fixture();
    if (kind === 'employee' && f.badge.effect.kind === 'badge_revoke') f.badge.effect.employeeId = 'wrong_employee';
    if (kind === 'scope') f.simulation.badges[0].regions = ['south'];
    if (kind === 'version') f.simulation.badges[0].ref = ref('badge_1', 2);
    if (kind === 'inactive') f.simulation.badges[0].state = 'revoked';
    expect(runActionPlan({ request: { phase: 'preview', plan: f.badge }, context: f.context, simulation: f.simulation }).outcome).not.toBe('accepted');
  });
  it('allows revoking an active badge for an inactive employee', () => {
    const f = fixture();
    f.simulation.badges[0].activeEmployee = false;
    expect(runActionPlan({ request: { phase: 'preview', plan: f.badge }, context: f.context, simulation: f.simulation }).outcome).toBe('accepted');
  });
  it('keeps an executed retry idempotent after preview expiry', () => {
    const f = fixture();
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    f.context.now = e.workflow.preview.expiresAt;
    expect(accepted(runActionPlan({ ...e, request: next('execute', e.workflow), context: f.context }))).toEqual(e);
  });
  it('pins preview expiry to the pending action expiry', () => {
    const f = fixture(), expiresAt = f.context.now + 1234;
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation, pendingActionExpiresAt: expiresAt }));
    expect(p.workflow.preview.expiresAt).toBe(expiresAt);
  });
  it('records failed readback after authority changes rather than stalling verification', () => {
    const f = fixture();
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    f.context.authority.actor.sessionId = 'session_2';
    const v = accepted(runActionPlan({ ...e, simulation: { ...e.simulation, records: [] }, request: next('verify', e.workflow), context: f.context }));
    expect(v.workflow.status).toBe('failed');
    expect(v.workflow.receipt?.status).toBe('failed');
  });
  it('turns a receipt mismatch into terminal failed verification', () => {
    const f = fixture();
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    const corrupted = { ...e, workflow: { ...e.workflow, receipt: { ...e.workflow.receipt!, content: 'different' } } };
    const v = accepted(runActionPlan({ ...corrupted, request: next('verify', corrupted.workflow), context: f.context }));
    expect(v.workflow.status).toBe('failed');
    expect(v.workflow.receipt?.status).toBe('failed');
  });
  it.each(['authority', 'role', 'session', 'mode', 'authority_revision', 'content', 'digest', 'cas', 'expiry', 'target', 'receipt'] as const)('binds confirmation and readback to immutable snapshot %s', kind => {
    const f = fixture();
    const preview = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    const confirmed = accepted(runActionPlan({ ...preview, request: next('confirm', preview.workflow), context: f.context }));
    const request = next('execute', confirmed.workflow);
    if (kind === 'authority') f.context.authority.actor.permissions = [];
    if (kind === 'role') f.context.authority.actor.role = 'executive';
    if (kind === 'session') f.context.authority.actor.sessionId = 'session_2';
    if (kind === 'mode') f.context.authority.actor.modeRevision++;
    if (kind === 'authority_revision') f.context.authority.revision++;
    if (kind === 'content') f.context.claims[0].text = 'Changed to 9999';
    if (kind === 'digest') request.previewDigest = 'wrong';
    if (kind === 'cas') request.expectedVersion = 0;
    if (kind === 'expiry') f.context.now += 600_000;
    if (kind === 'target') f.context.recipients[0].ref = ref('team_east', 2);
    if (kind === 'receipt') {
      const executed = accepted(runActionPlan({ ...confirmed, request, context: f.context }));
      const bad = { ...executed, simulation: { ...executed.simulation, records: [] } };
      expect(accepted(runActionPlan({ ...bad, request: next('verify', bad.workflow), context: f.context })).workflow.receipt?.status).toBe('failed');
    } else expect(runActionPlan({ ...confirmed, request, context: f.context }).outcome).not.toBe('accepted');
  });
  it('freezes copied previews and preserves historical versions', () => {
    const f = fixture();
    const preview = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, context: f.context, simulation: f.simulation }));
    const original = digest(preview.workflow);
    f.action.targets[0].version = 20;
    expect(preview.workflow.preview.plan.targets[0].version).toBe(1);
    expect(Object.isFrozen(preview.workflow.preview.intent.targets[0])).toBe(true);
    const nextVersion = accepted(runActionPlan({ ...preview, request: next('confirm', preview.workflow), context: f.context }));
    expect(nextVersion.workflow.version).toBe(2);
    expect(digest(preview.workflow)).toBe(original);
  });
  it('idempotency rejects a different plan using the same key', () => {
    const f = fixture();
    const execute = (plan: ActionPlan, simulation = f.simulation) => {
      const p = accepted(runActionPlan({ request: { phase: 'preview', plan }, simulation, context: f.context }));
      const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
      return runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context });
    };
    const first = accepted(execute(f.action));
    expect(execute(f.badge, first.simulation)).toMatchObject({ outcome: 'execution_failed', code: 'idempotency_conflict' });
  });
  it('rejects duplicate target records masquerading as a complete action replay', () => {
    const f = fixture();
    f.context.authority.recipientIds = ['team_east', 'unlisted_east'];
    if (f.action.effect.kind === 'dashboard_share') f.action.effect.recipientIds = ['team_east', 'unlisted_east'];
    f.action.targets = [ref('team_east'), ref('unlisted_east')];
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, simulation: f.simulation, context: f.context }));
    const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    expect(runActionPlan({ ...c, simulation: { ...e.simulation, records: [e.simulation.records[0], e.simulation.records[0]] },
      request: next('execute', c.workflow), context: f.context })).toMatchObject({ outcome: 'execution_failed', code: 'idempotency_conflict' });
  });
  it('rejects a second active share for the same artifact and recipient under a new key', () => {
    const f = fixture();
    const p = accepted(runActionPlan({ request: { phase: 'preview', plan: f.action }, simulation: f.simulation, context: f.context }));
    const c = accepted(runActionPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runActionPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    const p2 = accepted(runActionPlan({ request: { phase: 'preview', plan: { ...f.action, idempotencyKey: 'wave4_other_key_002' } }, simulation: e.simulation, context: f.context }));
    const c2 = accepted(runActionPlan({ ...p2, request: next('confirm', p2.workflow), context: f.context }));
    expect(runActionPlan({ ...c2, request: next('execute', c2.workflow), context: f.context })).toMatchObject({ outcome: 'execution_failed', code: 'share_already_exists' });
  });
  it.each(acceptancePrompts.filter(p => p.capability === 'action' || p.capability === 'badge'))('acceptance fixture: $prompt', p => {
    const f = fixture(), plan = p.capability === 'badge' ? f.badge : f.action;
    const output = accepted(runActionPlan({ request: { phase: 'preview', plan }, simulation: f.simulation, context: f.context }));
    expect(output.workflow.preview.intent.content).toContain(p.capability === 'badge' ? 'Employee access review approved for employee_1.' : '800');
    expect(output.workflow.preview.intent.targets).toEqual(plan.targets);
    expect(output.simulation.records).toHaveLength(0);
  });
});
