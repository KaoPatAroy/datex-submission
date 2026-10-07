import { describe, expect, it } from 'vitest';
import { authorizationRef, communicationPlanSchema, runCommunicationPlan } from '../../lib/communication';
import { accepted, acceptancePrompts, fixture, next, ref } from './fixtures';

describe('Wave 4 communication', () => {
  it.each(acceptancePrompts.filter(p => p.capability === 'communication'))('acceptance fixture: $prompt', () => {
    const f = fixture();
    const p = accepted(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }));
    expect(p.inbox).toEqual([]);
    expect(p.workflow.preview.intent.content).toBe('E03 sales: 800; target: 1000.');
    expect(p.workflow.preview.intent.targets).toEqual([ref('team_east')]);
    expect(p.workflow.preview.intent.binding).toMatchObject({ recipients: [{ name: 'East Team' }] });
    const c = accepted(runCommunicationPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runCommunicationPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    expect(e.inbox).toHaveLength(1);
    expect(e.workflow.receipt?.status).toBe('pending');
    const v = accepted(runCommunicationPlan({ ...e, request: next('verify', e.workflow), context: f.context }));
    expect(v.workflow.receipt?.status).toBe('verified_success');
    expect(accepted(runCommunicationPlan({ ...v, request: next('execute', v.workflow), context: f.context }))).toEqual(v);
  });
  it('explicit recipient authorization is required even within East', () => {
    const f = fixture();
    f.communication.recipientIds = ['unlisted_east'];
    f.context.consents[0].recipientIds = ['unlisted_east'];
    expect(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] })).toMatchObject({ outcome: 'permission_denied', code: 'recipient_denied' });
  });
  it.each(['email', 'telegram', 'webhook', 'constructor'])('rejects unregistered channel %s', channelId => {
    const f = fixture();
    expect(runCommunicationPlan({ request: { phase: 'preview', plan: { ...f.communication, channelId } }, context: f.context, inbox: [] })).toMatchObject({ outcome: 'unsupported_concept' });
  });
  it('rejects a URL before channel registry lookup', () => {
    expect(communicationPlanSchema.safeParse({ ...fixture().communication, channelId: 'https://bad.test' }).success).toBe(false);
  });
  it.each(['missing', 'expired', 'withdrawn', 'recipient', 'actor', 'claims', 'claim_version'] as const)('requires exact current consent: %s', kind => {
    const f = fixture();
    if (kind === 'missing') f.context.consents = [];
    if (kind === 'expired') f.context.consents[0].expiresAt = f.context.now;
    if (kind === 'withdrawn') f.context.consents[0].granted = false;
    if (kind === 'recipient') f.context.consents[0].recipientIds = ['unlisted_east'];
    if (kind === 'actor') f.context.consents[0].actorId = 'other';
    if (kind === 'claims') f.context.consents[0].contentClaimIds = ['missing'];
    if (kind === 'claim_version') f.context.claims[0].ref = ref('sales_claim', 2);
    expect(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] })).toMatchObject({ outcome: 'permission_denied', code: 'consent_denied' });
  });
  it.each(['region', 'read_permission', 'inactive', 'send_permission', 'authority_ref'] as const)('intersects actor and recipient permission: %s', kind => {
    const f = fixture();
    if (kind === 'region') { f.communication.recipientIds = ['team_south']; f.context.authority.recipientIds = ['team_south']; }
    if (kind === 'read_permission') f.context.recipients[0].permissions = [];
    if (kind === 'inactive') f.context.recipients[0].active = false;
    if (kind === 'send_permission') f.context.authority.actor.permissions = ['sales.read'];
    if (kind === 'authority_ref') f.communication.authorization = ref('communication_authority', 2);
    expect(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }).outcome).not.toBe('accepted');
  });
  it.each(['extra', 'content', 'duplicate', 'budget', 'approval'] as const)('strict schema and budgets %s', kind => {
    const f = fixture(), plan: Record<string, unknown> = { ...f.communication };
    if (kind === 'extra') plan.url = 'https://bad.test';
    if (kind === 'content') plan.content = 'Invented sales: 9999';
    if (kind === 'duplicate') plan.recipientIds = ['team_east', 'team_east'];
    if (kind === 'budget') plan.contentClaimIds = Array.from({ length: 33 }, (_, i) => `claim_${i}`);
    if (kind === 'approval') plan.approvalRequired = false;
    expect(communicationPlanSchema.safeParse(plan).success).toBe(false);
  });
  it('rechecks consent after confirmation and leaves inbox untouched', () => {
    const f = fixture();
    const p = accepted(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }));
    const c = accepted(runCommunicationPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    f.context.consents[0].granted = false;
    expect(runCommunicationPlan({ ...c, request: next('execute', c.workflow), context: f.context }).outcome).toBe('permission_denied');
    expect(c.inbox).toEqual([]);
  });
  it('cannot drop evidence read permissions from the content envelope', () => {
    const f = fixture();
    f.context.claims[0].permissions = [];
    f.context.recipients[0].permissions = [];
    expect(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] })).toMatchObject({ outcome: 'incomplete_evidence', code: 'claim_scope_or_permissions' });
  });
  it('readback checks content, target, operation and kind independently', () => {
    const f = fixture();
    const p = accepted(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }));
    const c = accepted(runCommunicationPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runCommunicationPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    for (const patch of [{ content: 'wrong' }, { target: ref('unlisted_east') }, { operationKey: 'wrong' }, { kind: 'email' }]) {
      const v = accepted(runCommunicationPlan({ ...e, inbox: [{ ...e.inbox[0], ...patch }], request: next('verify', e.workflow), context: f.context }));
      expect(v.workflow.receipt?.status).toBe('failed');
    }
  });
  it('rejects duplicate target records masquerading as a complete inbox replay', () => {
    const f = fixture();
    f.context.authority.recipientIds = ['team_east', 'unlisted_east'];
    f.context.consents[0].recipientIds = ['team_east', 'unlisted_east'];
    f.communication.recipientIds = ['team_east', 'unlisted_east'];
    f.communication.authorization = authorizationRef(f.context);
    const p = accepted(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }));
    const c = accepted(runCommunicationPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runCommunicationPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    expect(runCommunicationPlan({ ...c, inbox: [e.inbox[0], e.inbox[0]], request: next('execute', c.workflow), context: f.context })).toMatchObject({ outcome: 'execution_failed', code: 'idempotency_conflict' });
  });
  it('bounds readback audit and makes identical failed verification retries idempotent', () => {
    const f = fixture();
    const p = accepted(runCommunicationPlan({ request: { phase: 'preview', plan: f.communication }, context: f.context, inbox: [] }));
    const c = accepted(runCommunicationPlan({ ...p, request: next('confirm', p.workflow), context: f.context }));
    const e = accepted(runCommunicationPlan({ ...c, request: next('execute', c.workflow), context: f.context }));
    const failed = accepted(runCommunicationPlan({ ...e, inbox: [], request: next('verify', e.workflow), context: f.context }));
    expect(accepted(runCommunicationPlan({ ...failed, request: next('verify', failed.workflow), context: f.context }))).toEqual(failed);
    let workflow = failed.workflow;
    for (let attempt = 0; attempt < 70; attempt++) {
      workflow = accepted(runCommunicationPlan({ inbox: attempt % 2 === 0 ? e.inbox : [], request: next('verify', workflow), context: f.context })).workflow;
    }
    expect(workflow.audit).toHaveLength(64);
    expect(failed.workflow.audit).toHaveLength(4);
    expect(workflow.version).toBe(74);
  });
});
