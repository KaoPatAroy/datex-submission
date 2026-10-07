import { z } from 'zod';
import { authorizationRef } from '../communication';
import { attempt, authorize, consentFor, contentFor, digest, evidenceFor, idSchema, ids, keySchema,
  recipientsFor, refSchema, requirePlan, sameRef, transition, type PlanContext, type Ref, type Request,
  type Result, type ScopedSnapshot, type Workflow } from '../effects/shared';

export const monitorRegistry = Object.freeze({ version: 1, conditionIds: Object.freeze(['sales_below_target']),
  // `hourly`/`one_hour` stay registered only so already-stored monitors keep validating; new monitors are daily (Vercel Hobby cron).
  // `daily` is 22h (not 24h) so a cron that fires a few minutes early/late still counts as the next day's run.
  cadence: Object.freeze({ hourly: 3_600_000, daily: 79_200_000 }), cooldown: Object.freeze({ one_hour: 3_600_000, one_day: 79_200_000 }),
  maxBranches: 1000, maxHistory: 64 });
export const monitorPlanSchema = z.object({
  version: z.literal(1), queryPlan: refSchema, conditionId: idSchema,
  /** Configuration, not an asserted business number; 1 means below 100% of evidenced target. */
  /** recipientIds: extra people alerted besides the owner (who always receives the alert); empty = owner-only monitor. */
  threshold: z.number().finite().gt(0).max(1), cadenceId: idSchema, recipientIds: z.array(idSchema).max(20).refine(v => new Set(v).size === v.length),
  cooldownId: idSchema, dedupeKey: keySchema, authorization: refSchema, consent: refSchema,
  contentClaimIds: ids(32), approvalRequired: z.literal(true), lifecycle: z.enum(['active', 'paused']),
}).strict();
export type MonitorPlan = z.infer<typeof monitorPlanSchema>;
export interface MonitorQuery extends ScopedSnapshot { datasetId: 'branch_performance'; branchIds: readonly string[] }
export interface MonitorContext extends PlanContext { queries: readonly MonitorQuery[] }
export interface MonitorState {
  version: number; workflow: Workflow<MonitorPlan>; lifecycle: 'active' | 'paused' | 'needs_renewal';
  authoritySnapshot: { actorId: string; permissions: readonly string[]; regions: readonly string[] };
  lastEvaluatedAt: number | null; lastObservedAt: number | null; lastAlertAt: number | null;
  history: readonly { key: string; observedAt: number; breachBranchIds: readonly string[]; alert: boolean }[];
}
export type MonitorRequest = Request<MonitorPlan> |
  { phase: 'pause' | 'resume'; state: MonitorState; expectedVersion: number } |
  { phase: 'evaluate'; state: MonitorState; expectedVersion: number; evidence: Ref };
export interface MonitorOutput { state: MonitorState; alert: null | { recipientIds: readonly string[]; evidence: Ref; branchIds: readonly string[]; dedupeKey: string } }

function validateMonitor(raw: unknown, context: MonitorContext, checkAuthorization = true) {
  const plan = monitorPlanSchema.parse(raw);
  requirePlan(monitorRegistry.conditionIds.includes(plan.conditionId) && Object.hasOwn(monitorRegistry.cadence, plan.cadenceId) &&
    Object.hasOwn(monitorRegistry.cooldown, plan.cooldownId), 'unsupported_concept', 'unknown_monitor_kind');
  if (checkAuthorization) requirePlan(sameRef(plan.authorization, authorizationRef(context)), 'permission_denied', 'authorization_changed');
  const query = context.queries.find(q => sameRef(q.ref, plan.queryPlan));
  requirePlan(query && query.datasetId === 'branch_performance' && query.branchIds.length > 0 &&
    query.branchIds.length <= monitorRegistry.maxBranches && new Set(query.branchIds).size === query.branchIds.length,
    'clarification_required', 'query_budget_or_binding');
  authorize(context, { regions: query.regions, permissions: [...query.permissions, 'monitor.manage', 'sales.read'] });
  const content = contentFor(context, plan.contentClaimIds, 'monitor');
  requirePlan(content.claims.every(c => c.regions.every(r => query.regions.includes(r))), 'incomplete_evidence', 'monitor_content_scope');
  const recipients = recipientsFor(context, plan.recipientIds, query.regions, [...new Set([...query.permissions, ...content.claims.flatMap(c => c.permissions)])]);
  const consent = consentFor(context, plan.consent, 'simulated_inbox', plan.recipientIds, content.claims.map(c => c.ref));
  return { plan, query, intent: { targets: recipients.map(r => r.ref),
    content: `${plan.cadenceId === 'hourly' ? 'Hourly' : 'Daily'} sales below ${Math.round(plan.threshold * 10000) / 100}% of target; ${plan.cooldownId === 'one_hour' ? 'one-hour' : 'one-day'} cooldown\n${content.text}`,
    binding: { query, recipients, claims: content.claims, consent } } };
}

/** Pure threshold evaluation + lifecycle reducer. Returns an alert candidate, never delivers it. */
export function runMonitorPlan(input: { request: MonitorRequest; context: MonitorContext; state?: MonitorState }): Result<MonitorOutput> {
  return attempt(() => {
    const request = input.request, context = input.context;
    if (!('state' in request)) {
      const old = input.state;
      requirePlan(request.phase === 'preview' ? !old : old && digest(old.workflow) === digest(request.workflow),
        'execution_failed', 'monitor_state_mismatch');
      const workflow = transition(request, context, monitorRegistry, raw => validateMonitor(raw, context), p => p.dedupeKey,
        () => { /* Installation is represented only in the returned server state. */ },
        preview => !!old && (old.workflow.status === 'executed' || old.workflow.status === 'verified') && old.workflow.preview.digest === preview.digest);
      if (old && digest(workflow) === digest(old.workflow)) return { state: old, alert: null };
      const state: MonitorState = old ? { ...old, version: old.version + 1, workflow } : {
        version: 1, workflow, lifecycle: workflow.preview.plan.lifecycle,
        authoritySnapshot: { actorId: context.authority.actor.id,
          permissions: [...context.authority.actor.permissions].sort(), regions: [...context.authority.actor.regions].sort() },
        lastEvaluatedAt: null, lastObservedAt: null, lastAlertAt: null, history: [] };
      return { state, alert: null };
    }
    const old = request.state;
    requirePlan(request.expectedVersion === old.version, 'execution_failed', 'cas_conflict');
    const snapshot = old.authoritySnapshot;
    const authorityMatches = snapshot.actorId === context.authority.actor.id &&
      digest(snapshot.permissions) === digest([...context.authority.actor.permissions].sort()) &&
      digest(snapshot.regions) === digest([...context.authority.actor.regions].sort());
    if ('evidence' in request && !authorityMatches && old.lifecycle !== 'needs_renewal')
      return { state: { ...old, version: old.version + 1, lifecycle: 'needs_renewal' }, alert: null };
    if (old.lifecycle === 'needs_renewal') return { state: old, alert: null };
    const { plan, query, intent } = validateMonitor(old.workflow.preview.plan, context, false);
    const { digest: previewDigest, ...previewBody } = old.workflow.preview;
    requirePlan(digest(previewBody) === previewDigest && digest(plan) === old.workflow.preview.planDigest &&
      digest(intent) === digest(old.workflow.preview.intent), 'execution_failed', 'preview_mismatch');
    requirePlan(old.workflow.status === 'verified', 'execution_failed', 'monitor_not_installed');
    requirePlan(old.workflow.preview.registryDigest === digest(monitorRegistry), 'permission_denied', 'authorization_changed');
    if (!('evidence' in request)) {
      const lifecycle = request.phase === 'pause' ? 'paused' : 'active';
      requirePlan(old.lifecycle !== lifecycle, 'execution_failed', 'lifecycle_conflict');
      return { state: { ...old, version: old.version + 1, lifecycle }, alert: null };
    }
    if (old.lifecycle === 'paused') return { state: old, alert: null };
    const evidence = evidenceFor(context, request.evidence), rows = evidence.sales;
    requirePlan(digest([...evidence.regions].sort()) === digest([...query.regions].sort()) && rows &&
      rows.length === query.branchIds.length && new Set(rows.map(r => r.branchId)).size === rows.length &&
      rows.every(r => query.branchIds.includes(r.branchId) && Number.isFinite(r.netSales) && Number.isFinite(r.target) && r.target > 0),
      'incomplete_evidence', 'monitor_evidence_binding');
    const observedAt = evidence.observedAt;
    requirePlan(observedAt !== undefined && Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt <= context.now,
      'incomplete_evidence', 'observation_clock');
    if ((old.lastObservedAt !== null && observedAt <= old.lastObservedAt) ||
      (old.lastEvaluatedAt !== null && context.now - old.lastEvaluatedAt < monitorRegistry.cadence[plan.cadenceId as keyof typeof monitorRegistry.cadence])) return { state: old, alert: null };
    const key = digest({ dedupeKey: plan.dedupeKey, query: query.ref, evidence: evidence.ref });
    const breachBranchIds = rows.filter(r => r.netSales / r.target < plan.threshold).map(r => r.branchId);
    const alert = breachBranchIds.length > 0 && (old.lastAlertAt === null || context.now - old.lastAlertAt >= monitorRegistry.cooldown[plan.cooldownId as keyof typeof monitorRegistry.cooldown]) &&
      !old.history.some(h => h.key === key);
    return { state: { ...old, version: old.version + 1, lastEvaluatedAt: context.now, lastObservedAt: observedAt,
      lastAlertAt: alert ? context.now : old.lastAlertAt,
      history: [...old.history, { key, observedAt, breachBranchIds, alert }].slice(-monitorRegistry.maxHistory) },
      alert: alert ? { recipientIds: plan.recipientIds, evidence: evidence.ref, branchIds: breachBranchIds, dedupeKey: key } : null };
  });
}
