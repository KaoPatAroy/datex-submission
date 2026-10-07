import { invariant } from '../core/errors';
import type { WorkflowScopeRequest } from './authority';
import type { RoleV2, WorkflowActionKind } from './contracts';

export interface WorkflowActionAuthority extends Pick<WorkflowScopeRequest, 'permission' | 'roles' | 'purpose'> {
  readonly readPermissions: readonly string[];
}

const salesRoles = Object.freeze(['executive', 'east_manager'] satisfies RoleV2[]);
const hrRoles = Object.freeze(['hr_admin'] satisfies RoleV2[]);
const salesReads = Object.freeze(['sales.read', 'operations.read']);
const hrReads = Object.freeze(['hr.read']);
function policy(permission: string, roles: readonly RoleV2[], purpose: WorkflowScopeRequest['purpose'], reads: readonly string[]): WorkflowActionAuthority {
  return Object.freeze({ permission, roles, purpose, readPermissions: Object.freeze([...reads]) });
}

/** Closed server policy from WORKFLOW_CONTRACT_V2 sections 2/4 and existing pack permission names. */
const policies: Readonly<Record<WorkflowActionKind, WorkflowActionAuthority>> = Object.freeze({
  dashboard_create: policy('dashboard.create', salesRoles, 'sales_operations', salesReads),
  dashboard_share: policy('dashboard.share', salesRoles, 'sales_operations', salesReads),
  dashboard_share_revoke: policy('dashboard.share', salesRoles, 'sales_operations', salesReads),
  investigation_create: policy('ticket.create', salesRoles, 'sales_operations', salesReads),
  restock_create: policy('restock.create', salesRoles, 'sales_operations', ['operations.read']),
  crm_followup_create: policy('crm.followup.create', salesRoles, 'sales_operations', ['crm.read']),
  incident_escalate: policy('incident.escalate', salesRoles, 'sales_operations', ['operations.read']),
  discount_request_create: policy('discount.request.create', salesRoles, 'sales_operations', ['crm.read']),
  branch_review_assign: policy('branch.review.assign', salesRoles, 'sales_operations', salesReads),
  onboarding_manager_approve: policy('hr.onboarding.manager_approve', Object.freeze(['east_manager']), 'manager_onboarding', ['hr.onboarding.manager_read']),
  onboarding_director_approve: policy('hr.onboarding.director_approve', Object.freeze(['hr_director']), 'director_onboarding', ['hr.onboarding.director_read']),
  onboarding_return: policy('hr.onboarding.return', Object.freeze(['hr_director']), 'director_onboarding', ['hr.onboarding.director_read']),
  onboarding_start: policy('hr.onboarding.start', hrRoles, 'hr_operations', hrReads),
  onboarding_tasks_create: policy('hr.onboarding.tasks', hrRoles, 'hr_operations', hrReads),
  offboarding_plan_create: policy('hr.offboarding.plan', hrRoles, 'hr_operations', hrReads),
  it_disable_request: policy('hr.it_disable.request', hrRoles, 'hr_operations', hrReads),
  asset_return_create: policy('hr.asset_return.create', hrRoles, 'hr_operations', hrReads),
  badge_revoke: policy('badge.revoke', hrRoles, 'hr_operations', hrReads),
  contract_reminder_create: policy('hr.contract.reminder', hrRoles, 'hr_operations', hrReads),
  policy_acknowledgement_assign: policy('hr.policy.assign', hrRoles, 'hr_operations', hrReads),
});

export function getWorkflowActionAuthority(kind: WorkflowActionKind): WorkflowActionAuthority { return policies[kind]; }

export function assertWorkflowBindingAuthority(kind: WorkflowActionKind, declared: Pick<WorkflowScopeRequest, 'permission' | 'roles' | 'purpose'>): void {
  const expected = getWorkflowActionAuthority(kind);
  invariant(expected && declared.permission === expected.permission && declared.purpose === expected.purpose &&
    declared.roles.length === expected.roles.length && new Set(declared.roles).size === declared.roles.length &&
    expected.roles.every(role => declared.roles.includes(role)),
  'WORKFLOW_INVALID_BINDING', 'The binding authority does not match the closed action policy');
}
