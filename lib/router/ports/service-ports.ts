import type { Actor, DashboardSpec, PendingAction } from '../../contracts';
import { DomainError } from '../../core/errors';
import type { ActionPorts, DashboardWriteGuard, EffectBindings, EffectFence, StagedPorts, StagedProposal } from '../executors/action-ports';

/**
 * Dependency-injected ActionPorts. ConciergeService (U9a) passes closures over its broker/service methods;
 * this module owns no I/O and no user-text handling. It adds defence in depth on top of the injected functions:
 * results of prepare/list are re-checked for actor + conversation ownership before they reach the executors.
 */
export type ActionPortFns = Pick<ActionPorts,
  'reloadActor' | 'prepareTool' | 'confirmPending' | 'cancelPending' | 'revisePending' | 'listPending' |
  'getDashboard' | 'renameDashboard' | 'deleteDashboard' | 'recipientAllowed' | 'dashboardShares' | 'revokeDashboardShare'>;

export interface ActionPortsDeps extends ActionPortFns {
  branchesAllowed?: ActionPorts['branchesAllowed'];
  updateDashboardSpec?: ActionPorts['updateDashboardSpec'];
  proposalBound?: ActionPorts['proposalBound'];
  stagedTurnCompleted?: ActionPorts['stagedTurnCompleted'];
  audit?: ActionPorts['audit'];
  results?: ActionPorts['results'];
  organizeDashboard?: ActionPorts['organizeDashboard'];
  /** createStagedStore(store, ...) from lib/router/storage/staged-store.ts. */
  staged: StagedPorts;
  /** Wave 4 snapshot loaders + commits; omit to keep communication/monitor disabled (executors report effects_disabled). */
  effects?: EffectBindings;
}

const REQUIRED: (keyof ActionPortFns)[] = ['reloadActor', 'prepareTool', 'confirmPending', 'cancelPending', 'revisePending', 'listPending',
  'getDashboard', 'renameDashboard', 'deleteDashboard', 'recipientAllowed'];

const owns = (actor: Actor, conversationId: string | undefined, a: PendingAction): boolean =>
  a.actorId === actor.id && (conversationId === undefined || a.conversationId === conversationId);

export function createActionPorts(deps: ActionPortsDeps): ActionPorts {
  for (const name of REQUIRED) if (typeof deps[name] !== 'function') throw new TypeError(`createActionPorts: missing ${name}`);
  if (!deps.staged || typeof deps.staged.create !== 'function') throw new TypeError('createActionPorts: missing staged store');
  const denied = (): never => { throw new DomainError('PORT_OWNERSHIP', 'Action does not belong to this actor or conversation', 403); };

  return {
    reloadActor: actor => deps.reloadActor(actor),
    async prepareTool(actor, tool, args, ref) {
      const action = await deps.prepareTool(actor, tool, args, ref);
      return owns(actor, ref.conversationId, action) ? action : denied();
    },
    confirmPending: (actor, id) => deps.confirmPending(actor, id),
    cancelPending: (actor, id) => deps.cancelPending(actor, id),
    revisePending: (actor, id, patch, key) => deps.revisePending(actor, id, patch, key),
    async listPending(actor, conversationId) {
      return (await deps.listPending(actor, conversationId)).filter(a => owns(actor, conversationId, a) && a.status === 'pending');
    },
    async getDashboard(actor, id) {
      const d = await deps.getDashboard(actor, id);
      return d && d.id === id ? d : undefined;
    },
    ...(deps.dashboardShares ? { dashboardShares: (actor: Actor, id: string) => deps.dashboardShares!(actor, id) } : {}),
    ...(deps.revokeDashboardShare ? { revokeDashboardShare: (actor: Actor, id: string, shareId: string, options?: { fence?: EffectFence }) =>
      options ? deps.revokeDashboardShare!(actor, id, shareId, options) : deps.revokeDashboardShare!(actor, id, shareId) } : {}),
    renameDashboard: (actor, id, input, guard) => guard ? deps.renameDashboard(actor, id, input, guard) : deps.renameDashboard(actor, id, input),
    deleteDashboard: (actor, id, guard) => guard ? deps.deleteDashboard(actor, id, guard) : deps.deleteDashboard(actor, id),
    ...(deps.stagedTurnCompleted ? { stagedTurnCompleted: (actor: Actor, proposal: StagedProposal) => deps.stagedTurnCompleted!(actor, proposal) } : {}),
    ...(deps.proposalBound ? { proposalBound: (actor: Actor, action: PendingAction) => deps.proposalBound!(actor, action) } : {}),
    ...(deps.updateDashboardSpec ? { updateDashboardSpec: (actor: Actor, id: string, spec: DashboardSpec, guard?: DashboardWriteGuard) => (guard ? deps.updateDashboardSpec!(actor, id, spec, guard) : deps.updateDashboardSpec!(actor, id, spec)) } : {}),
    recipientAllowed: async (actor, id) => (await deps.recipientAllowed(actor, id)) === true,
    ...(deps.branchesAllowed ? { branchesAllowed: (actor: Actor, ids: string[]) => deps.branchesAllowed!(actor, ids) } : {}),
    ...(deps.audit ? { audit: (actor: Actor, event: { kind: string; detail: string; refId?: string }) => deps.audit!(actor, event) } : {}),
    staged: deps.staged,
    ...(deps.effects ? { effects: deps.effects } : {}),
    ...(deps.results ? { results: deps.results } : {}),
    ...(deps.organizeDashboard ? { organizeDashboard: (actor: Actor, id: string, op: Parameters<NonNullable<ActionPorts['organizeDashboard']>>[2]) => deps.organizeDashboard!(actor, id, op) } : {}),
  };
}
