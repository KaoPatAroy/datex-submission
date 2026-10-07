import { authorizationRef, type CommunicationPlan } from '../../lib/communication';
import type { ActionContext, ActionPlan, ActionSimulation } from '../../lib/effects';
import { digest, snapshotRef, type Ref, type Result, type Workflow } from '../../lib/effects/shared';
import type { MonitorContext, MonitorPlan } from '../../lib/monitors';

export const now = Date.UTC(2026, 9, 6, 4);
export const ref = (id: string, version = 1): Ref => snapshotRef(id, version, { id, version });
export function accepted<T>(result: Result<T>): T {
  if (result.outcome !== 'accepted') throw new Error(`${result.outcome}:${result.code}`);
  return result.value;
}
export function next<P>(phase: 'confirm' | 'execute' | 'verify', workflow: Workflow<P>) {
  return { phase, workflow, expectedVersion: workflow.version, previewDigest: workflow.preview.digest };
}
export function fixture() {
  const context: ActionContext & MonitorContext = {
    now, authority: { revision: 1, recipientIds: ['team_east'], actor: { id: 'east_manager', sessionId: 'session_1',
      role: 'east_manager', mode: 'live_ai', modeRevision: 1, active: true, regions: ['east'],
      permissions: ['sales.read', 'dashboard.share', 'hr.read', 'badge.revoke', 'communication.send', 'monitor.manage'] } },
    evidence: [{ ref: ref('evidence_east'), regions: ['east'], permissions: ['sales.read'], fresh: true, complete: true,
      trust: 'certified', sensitive: false, expiresAt: now + 100 * 3_600_000, sourceIds: ['sales_east'], observedAt: now,
      sales: [{ branchId: 'E03', netSales: 800, target: 1000 }] }],
    claims: [{ ref: ref('sales_claim'), regions: ['east'], permissions: ['sales.read'], text: 'E03 sales: 800; target: 1000.',
      evidence: ref('evidence_east'), allowedUses: ['share', 'communication', 'monitor'], subjectIds: ['E03'] },
    { ref: ref('badge_reason'), regions: ['east'], permissions: ['hr.read'], text: 'Employee access review approved for employee_1.',
      evidence: ref('evidence_hr'), allowedUses: ['badge_reason'], subjectIds: ['employee_1'] }],
    recipients: [
      { ref: ref('team_east'), name: 'East Team', regions: ['east'], permissions: ['sales.read'], active: true },
      { ref: ref('unlisted_east'), name: 'Other East Team', regions: ['east'], permissions: ['sales.read'], active: true },
      { ref: ref('team_south'), name: 'South Team', regions: ['south'], permissions: ['sales.read'], active: true },
    ],
    consents: [{ ref: ref('consent_1'), actorId: 'east_manager', channelId: 'simulated_inbox', recipientIds: ['team_east'],
      contentClaimIds: ['sales_claim'], contentClaims: [ref('sales_claim')], granted: true, expiresAt: now + 100 * 3_600_000 }],
    artifacts: [{ ref: ref('dashboard_1'), ownerId: 'east_manager', title: 'East performance', regions: ['east'],
      permissions: ['sales.read'], contentClaimIds: ['sales_claim'] }],
    queries: [{ ref: ref('query_1'), datasetId: 'branch_performance', branchIds: ['E03'], regions: ['east'], permissions: ['sales.read'] }],
  };
  context.evidence = [...context.evidence, { ...context.evidence[0], ref: ref('evidence_hr'), permissions: ['hr.read'], sourceIds: ['hr_east'], sales: undefined }];
  const simulation: ActionSimulation = { records: [], badges: [{ ref: ref('badge_1'), employeeId: 'employee_1', employeeName: 'East Employee',
    regions: ['east'], permissions: ['hr.read'], activeEmployee: true, state: 'active' }] };
  const action: ActionPlan = { version: 1, actionId: 'dashboard_share', targets: [ref('team_east')], evidence: [ref('evidence_east')],
    effect: { kind: 'dashboard_share', artifact: ref('dashboard_1'), recipientIds: ['team_east'], contentClaimIds: ['sales_claim'] },
    approvalRequired: true, idempotencyKey: 'wave4_test_key_001', expectedPostconditions: ['share_exists'] };
  const badge: ActionPlan = { ...action, actionId: 'badge_revoke', targets: [ref('badge_1')],
    evidence: [ref('evidence_hr')], effect: { kind: 'badge_revoke', badge: ref('badge_1'), employeeId: 'employee_1', reasonClaimIds: ['badge_reason'] }, expectedPostconditions: ['badge_revoked'] };
  const communication: CommunicationPlan = { version: 1, channelId: 'simulated_inbox', recipientIds: ['team_east'],
    contentClaimIds: ['sales_claim'], authorization: authorizationRef(context), consent: ref('consent_1'),
    approvalRequired: true, idempotencyKey: 'wave4_test_key_001' };
  const monitor: MonitorPlan = { version: 1, queryPlan: ref('query_1'), conditionId: 'sales_below_target', threshold: 1,
    cadenceId: 'hourly', recipientIds: ['team_east'], cooldownId: 'one_hour', dedupeKey: 'wave4_monitor_001',
    authorization: authorizationRef(context), consent: ref('consent_1'), contentClaimIds: ['sales_claim'], approvalRequired: true, lifecycle: 'active' };
  return { context, simulation, action, badge, communication, monitor };
}
/** Wave 4's migration-plan prompt and paraphrases; AI fixtures supply plans, no server phrase matching. */
export const acceptancePrompts = [
  { prompt: 'Send this to my team', capability: 'communication' },
  { prompt: 'Please send the East results to my team', capability: 'communication' },
  { prompt: 'Share this dashboard with the East Team', capability: 'action' },
  { prompt: 'Revoke this employee badge', capability: 'badge' },
  { prompt: 'Alert my team when East sales are below target', capability: 'monitor' },
] as const;
export function updatedEvidence(context: MonitorContext, hour: number, sales = 800) {
  const copy = structuredClone(context);
  copy.now += hour * 3_600_000;
  copy.evidence = [...copy.evidence, { ...copy.evidence[0], ref: { id: `sample_${hour}`, version: 1, digest: digest({ hour, sales }) },
    observedAt: copy.now, sales: [{ branchId: 'E03', netSales: sales, target: 1000 }] }];
  return copy;
}
