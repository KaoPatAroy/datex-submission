import { z } from 'zod';
import { attempt, authorize, contentFor, digest, evidenceFor, exactRecords, idSchema, ids, keySchema, recipientsFor,
  refs, refSchema, requirePlan, sameRef, transition, type EffectRecord, type PlanContext, type Ref,
  type Request, type Result, type ScopedSnapshot, type Workflow } from './shared';

export const effectRegistry = Object.freeze({ version: 1, kinds: Object.freeze({
  dashboard_share: Object.freeze({ permissions: ['dashboard.share', 'sales.read'], postcondition: 'share_exists' }),
  badge_revoke: Object.freeze({ permissions: ['badge.revoke', 'hr.read'], postcondition: 'badge_revoked' }),
}) });
export const actionPlanSchema = z.object({
  version: z.literal(1), actionId: idSchema, targets: refs(20), evidence: refs(20),
  effect: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dashboard_share'), artifact: refSchema, recipientIds: ids(20), contentClaimIds: ids(32) }).strict(),
    z.object({ kind: z.literal('badge_revoke'), badge: refSchema, employeeId: idSchema, reasonClaimIds: ids(32) }).strict(),
  ]), approvalRequired: z.literal(true), idempotencyKey: keySchema, expectedPostconditions: ids(4),
}).strict();
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export interface ArtifactSnapshot extends ScopedSnapshot { ownerId: string; title: string; contentClaimIds: readonly string[] }
export interface BadgeSnapshot extends ScopedSnapshot {
  employeeId: string; employeeName: string; activeEmployee: boolean; state: 'active' | 'revoked';
  operationKey?: string; priorRef?: Ref;
}
export interface ActionContext extends PlanContext { artifacts: readonly ArtifactSnapshot[] }
export interface ActionSimulation { badges: readonly BadgeSnapshot[]; records: readonly EffectRecord[] }
export interface ActionOutput { workflow: Workflow<ActionPlan>; simulation: ActionSimulation }

/** Only two compiled server handlers exist. There is no model-selected function or code execution. */
export function runActionPlan(input: { request: Request<ActionPlan>; context: ActionContext; simulation: ActionSimulation;
  pendingActionExpiresAt?: number }): Result<ActionOutput> {
  return attempt(() => {
    const simulation = structuredClone(input.simulation);
    const context = input.context;
    const validate = (raw: unknown, verifying: boolean) => {
      const plan = actionPlanSchema.parse(raw), effect = plan.effect;
      requirePlan(Object.hasOwn(effectRegistry.kinds, plan.actionId) && plan.actionId === effect.kind,
        'unsupported_concept', 'unknown_effect');
      const rule = effectRegistry.kinds[effect.kind];
      requirePlan(digest(plan.expectedPostconditions) === digest([rule.postcondition]), 'clarification_required', 'postcondition_mismatch');
      plan.evidence.forEach(ref => evidenceFor(context, ref));
      const content = contentFor(context, effect.kind === 'dashboard_share' ? effect.contentClaimIds : effect.reasonClaimIds,
        effect.kind === 'dashboard_share' ? 'share' : 'badge_reason');
      requirePlan(content.evidence.every(r => plan.evidence.some(p => sameRef(r, p))), 'incomplete_evidence', 'evidence_binding');
      let targets: Ref[], text: string, binding: unknown;
      if (effect.kind === 'dashboard_share') {
        const artifact = context.artifacts.find(a => sameRef(a.ref, effect.artifact));
        requirePlan(artifact && artifact.ownerId === context.authority.actor.id, 'permission_denied', 'artifact_denied');
        authorize(context, { regions: artifact.regions, permissions: [...artifact.permissions, ...rule.permissions] });
        requirePlan(digest(artifact.contentClaimIds) === digest(effect.contentClaimIds) &&
          content.claims.every(c => c.regions.every(r => artifact.regions.includes(r))), 'incomplete_evidence', 'artifact_content_mismatch');
        const recipients = recipientsFor(context, effect.recipientIds, artifact.regions,
          [...new Set([...artifact.permissions, ...content.claims.flatMap(c => c.permissions)])]);
        targets = recipients.map(r => r.ref);
        text = `Share ${artifact.title}\n${content.text}`;
        binding = { artifact, recipients, claims: content.claims };
      } else {
        const badge = simulation.badges.find(b => b.ref.id === effect.badge.id);
        requirePlan(badge && badge.employeeId === effect.employeeId,
          'permission_denied', 'badge_target_denied');
        authorize(context, { regions: badge.regions, permissions: [...badge.permissions, ...rule.permissions] });
        const current = badge.state === 'active' && sameRef(badge.ref, effect.badge);
        const post = verifying && badge.state === 'revoked' && badge.priorRef && sameRef(badge.priorRef, effect.badge);
        requirePlan(current || post, 'execution_failed', 'badge_changed');
        requirePlan(content.claims.every(c => c.regions.every(r => badge.regions.includes(r)) && c.subjectIds.includes(effect.employeeId) &&
          evidenceFor(context, c.evidence).permissions.includes('hr.read')), 'incomplete_evidence', 'badge_claim_scope');
        targets = [effect.badge];
        text = `Revoke badge ${effect.badge.id} for ${badge.employeeName} (${effect.employeeId})\n${content.text}`;
        binding = { badge: effect.badge, employeeId: badge.employeeId, employeeName: badge.employeeName,
          regions: badge.regions, permissions: badge.permissions, claims: content.claims };
      }
      requirePlan(digest(plan.targets) === digest(targets), 'permission_denied', 'exact_target_mismatch');
      requirePlan(text.length <= 4500, 'clarification_required', 'content_budget');
      return { plan, intent: { targets, content: text, binding } };
    };
    const workflow = transition(input.request, context, effectRegistry, validate, p => p.idempotencyKey,
      (preview, operationKey) => {
        const effect = preview.plan.effect;
        const resource = effect.kind === 'dashboard_share' ? effect.artifact : undefined;
        const prior = simulation.records.filter(r => r.operationKey === operationKey);
        requirePlan(prior.length === 0 || exactRecords(prior, preview, effect.kind, resource), 'execution_failed', 'idempotency_conflict');
        if (prior.length) return;
        requirePlan(effect.kind !== 'dashboard_share' || !simulation.records.some(r => r.kind === 'dashboard_share' &&
          r.resource?.id === effect.artifact.id && preview.intent.targets.some(t => t.id === r.target.id)),
          'execution_failed', 'share_already_exists');
        if (effect.kind === 'badge_revoke') {
          simulation.badges = simulation.badges.map(b => b.ref.id === effect.badge.id ? {
            ...b, state: 'revoked', priorRef: b.ref, operationKey,
            ref: { id: b.ref.id, version: b.ref.version + 1, digest: digest({ prior: b.ref, state: 'revoked', operationKey }) },
          } : b);
        }
        simulation.records = [...simulation.records, ...preview.intent.targets.map(target => ({
          operationKey, target, planDigest: preview.planDigest, content: preview.intent.content, kind: effect.kind,
          ...(resource ? { resource } : {}),
        }))];
      }, (preview, operationKey) => {
        const records = simulation.records.filter(r => r.operationKey === operationKey);
        const effect = preview.plan.effect;
        if (!exactRecords(records, preview, effect.kind, effect.kind === 'dashboard_share' ? effect.artifact : undefined)) return false;
        if (preview.plan.effect.kind === 'badge_revoke') {
          const effect = preview.plan.effect;
          const badge = simulation.badges.find(b => b.ref.id === effect.badge.id);
          return !!badge && badge.state === 'revoked' && badge.operationKey === operationKey;
        }
        return true;
      }, input.pendingActionExpiresAt);
    return { workflow, simulation };
  });
}
