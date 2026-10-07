import { actionRegistry } from '@/lib/router/action-registry';
import type { PlannerContext } from '@/lib/router/planner-context';
import type { ValidateInput, ValidationHooks } from '@/lib/router/validate';
import { proposal } from '../dynamic/fixtures';

export const MESSAGE = 'Please share the Bangkok dashboard with Somchai and revoke badge B1 because lost badge';

export function permissionsFor(role: 'executive' | 'east_manager' | 'hr_admin'): string[] {
  if (role === 'hr_admin') return ['hr.read', 'badge.revoke'];
  const base = ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'];
  return role === 'executive' ? [...base, 'demo.update'] : base;
}

export function contextFor(role: 'executive' | 'east_manager' | 'hr_admin' = 'executive', overrides: Partial<PlannerContext> = {}): PlannerContext {
  const permissions = permissionsFor(role);
  return {
    business: { date: '2026-10-06', weekday: 'Tuesday', timezone: 'Asia/Bangkok', availability: { from: '2026-09-01', to: '2026-10-06' } },
    scope: { actorId: `${role}-1`, role, regionIds: role === 'east_manager' ? ['east'] : ['east', 'west'], branchIds: ['BR01', 'BR02'], permissions },
    catalog: {
      datasets: role === 'hr_admin' ? [{ id: 'hr_employees', label: 'Employees' }] : [{ id: 'branch_performance', label: 'Branch performance' }],
      measureIds: ['net_sales', 'target'], choices: [{ id: 'east', label: 'East region' }, { id: 'BR01', label: 'Branch One' }],
    },
    actions: actionRegistry.describeFor({ permissions }),
    recipients: [{ id: 'U_SOMCHAI', name: 'Somchai', role: 'east_manager' }],
    pendingActions: [{ id: 'PA1', kind: 'dashboard_create', title: 'Draft', widgetIndexes: [0, 1, 2], values: { title: 'Draft' } }],
    dashboards: [{ id: 'D1', title: 'Bangkok dashboard' }],
    acceptedStates: [{ stateId: 'ST1', datasetId: 'branch_performance' }],
    artifacts: [{ id: 'AR1', typeId: 'table', title: 'Sales table' }],
    pendingClarification: null,
    conversation: [],
    previousState: { stateId: 'ST1', values: { date: '2026-10-05' } },
    ...overrides,
  };
}

/** A context whose account can use EVERY product concept (all action families plus a Workflow V2 projection): product_help model prose is shown only here. */
export function fullCapabilityContext(): PlannerContext {
  const permissions = [...permissionsFor('executive'), 'hr.read', 'badge.revoke', 'hr.onboarding.director_read', 'hr.onboarding.director_approve'];
  const base = contextFor('executive');
  return { ...base, scope: { ...base.scope, permissions }, actions: actionRegistry.describeFor({ permissions }),
    workflow: { reads: [{ readId: 'director_queue', description: 'q' }], reviewedQueues: [], verifiedApprovals: [] } } as PlannerContext;
}

export function inputFor(raw: unknown, role: 'executive' | 'east_manager' | 'hr_admin' = 'executive', extra: Partial<ValidateInput> = {}, hooks?: ValidationHooks): ValidateInput {
  return { raw, messages: { current: MESSAGE }, context: contextFor(role), registry: actionRegistry, hooks, ...extra };
}

export const plan = (...steps: unknown[]) => ({ turnPlanVersion: 1, steps });
export const quoted = (value: unknown, evidenceText: string) => ({ value, source: 'user_quoted', evidenceText });
export const fromContext = (value: unknown) => ({ value, source: 'context_id' });
export const queryStep = (continuation = false) => ({ kind: 'query', continuation, plan: proposal() });
export const shareStep = (params: Record<string, unknown> = {}) => ({
  kind: 'action', actionId: 'dashboard.share',
  params: { dashboard: fromContext('D1'), recipientId: quoted('U_SOMCHAI', 'Somchai'), ...params },
});
export const revokeStep = (params: Record<string, unknown> = {}) => ({
  kind: 'action', actionId: 'badge.revoke',
  params: { badgeId: quoted('B1', 'badge B1'), employeeId: quoted('E1', 'badge B1'), reason: quoted('lost badge', 'lost badge'), ...params },
});
