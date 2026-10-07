import { z } from 'zod';
import { attempt, authorize, consentFor, contentFor, exactRecords, idSchema, ids, keySchema, recipientsFor,
  refSchema, requirePlan, sameRef, snapshotRef, transition, type EffectRecord, type PlanContext,
  type Request, type Result, type Workflow } from '../effects/shared';

export const communicationRegistry = Object.freeze({ version: 1, channelIds: Object.freeze(['simulated_inbox']), maxRecipients: 20 });
export const communicationPlanSchema = z.object({
  version: z.literal(1), channelId: idSchema, recipientIds: ids(20), contentClaimIds: ids(32),
  authorization: refSchema, consent: refSchema, approvalRequired: z.literal(true), idempotencyKey: keySchema,
}).strict();
export type CommunicationPlan = z.infer<typeof communicationPlanSchema>;
export function authorizationRef(context: PlanContext) { return snapshotRef('communication_authority', context.authority.revision, context.authority); }
export interface CommunicationOutput { workflow: Workflow<CommunicationPlan>; inbox: readonly EffectRecord[] }

/** Pure simulated delivery. It cannot email, call a URL, or access a third-party messaging API. */
export function runCommunicationPlan(input: { request: Request<CommunicationPlan>; context: PlanContext; inbox: readonly EffectRecord[] }): Result<CommunicationOutput> {
  return attempt(() => {
    let inbox = structuredClone(input.inbox);
    const context = input.context;
    const validate = (raw: unknown) => {
      const plan = communicationPlanSchema.parse(raw);
      requirePlan(communicationRegistry.channelIds.includes(plan.channelId), 'unsupported_concept', 'unknown_channel');
      requirePlan(sameRef(plan.authorization, authorizationRef(context)), 'permission_denied', 'authorization_changed');
      const content = contentFor(context, plan.contentClaimIds, 'communication');
      const regions = [...new Set(content.claims.flatMap(c => c.regions))];
      authorize(context, { regions, permissions: ['communication.send'] });
      const recipients = recipientsFor(context, plan.recipientIds, regions, [...new Set(content.claims.flatMap(c => c.permissions))]);
      const consent = consentFor(context, plan.consent, plan.channelId, plan.recipientIds, content.claims.map(c => c.ref));
      return { plan, intent: { targets: recipients.map(r => r.ref), content: content.text,
        binding: { claims: content.claims, recipients, consent } } };
    };
    const workflow = transition(input.request, context, communicationRegistry, validate, p => p.idempotencyKey,
      (preview, operationKey) => {
        const prior = inbox.filter(r => r.operationKey === operationKey);
        requirePlan(prior.length === 0 || exactRecords(prior, preview, 'simulated_inbox'), 'execution_failed', 'idempotency_conflict');
        if (prior.length) return;
        inbox = [...inbox, ...preview.intent.targets.map(target => ({ operationKey, target, planDigest: preview.planDigest,
          content: preview.intent.content, kind: 'simulated_inbox' }))];
      }, (preview, operationKey) => {
        const records = inbox.filter(r => r.operationKey === operationKey);
        return exactRecords(records, preview, 'simulated_inbox');
      });
    return { workflow, inbox };
  });
}
