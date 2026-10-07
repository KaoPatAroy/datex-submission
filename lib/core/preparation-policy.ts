
export const PREPARE_TOOL_NAMES = [
  'dashboard.prepare_create',
  'dashboard.prepare_share',
  'ticket.prepare_create',
  'badge.prepare_revoke',
] as const;

export type PrepareToolName = typeof PREPARE_TOOL_NAMES[number];

export interface PreparationPolicy {
  /** The one prepare tool a validated TurnPlan action step compiles to. */
  candidateToolName?: PrepareToolName;
  /** Exact prepare tools exposed to the model and accepted by the broker. */
  allowedPrepareToolNames: readonly PrepareToolName[];
  badgeBinding?: { badgeId: string; employeeId: string; reason: string };
  shareBinding?: { recipientId: string };
  ticketBinding?: { branchIds: readonly string[]; region?: string; date?: string };
  dashboardBinding?: { region?: string; date?: string; branchIds?: readonly string[] };
  clarification?: string;
  readOnlyGuidance?: boolean;
  /**
   * Live AI turns: the model reads the conversation and emits canonical, structured arguments.
   * The server does not interpret user wording; it validates catalog, permission, scope and target
   * existence inside the broker/action layer, and the risk tier decides whether confirmation is needed.
   */
  structured?: boolean;
}

/**
 * Broker policy for one validated TurnPlan action step: exactly one prepare tool, bound to the canonical args the
 * executor compiled from validated params. The broker re-checks the tool args against this binding (not language).
 */
export function policyForPrepareTool(toolName: PrepareToolName, args: Record<string, unknown>): PreparationPolicy {
  const base = { candidateToolName: toolName, allowedPrepareToolNames: [toolName] } as const;
  const str = (value: unknown) => typeof value === 'string' ? value : undefined;
  const ids = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  const scope = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  switch (toolName) {
    case 'badge.prepare_revoke':
      return { ...base, badgeBinding: { badgeId: str(args.badgeId) ?? '', employeeId: str(args.employeeId) ?? '', reason: str(args.reason) ?? '' } };
    case 'dashboard.prepare_share':
      return { ...base, shareBinding: { recipientId: str(args.recipientId) ?? '' } };
    case 'ticket.prepare_create': {
      const target = scope(args.scope);
      return { ...base, ticketBinding: { branchIds: ids(args.branchIds) ?? [], region: str(target.region), date: str(target.date) } };
    }
    case 'dashboard.prepare_create': {
      const target = scope(scope(args.spec).scope);
      return { ...base, dashboardBinding: { region: str(target.region), date: str(target.date), ...(ids(target.branchIds) ? { branchIds: ids(target.branchIds) } : {}) } };
    }
  }
}

function sameTargetIds(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string') || value.length !== expected.length) return false;
  const actual = value as string[];
  if (new Set(actual).size !== expected.length) return false;
  const actualSorted = [...actual].sort(), expectedSorted = [...expected].sort();
  return actualSorted.every((id, index) => id === expectedSorted[index]);
}

export function matchesPreparationTarget(policy: PreparationPolicy, toolName: string, args: Record<string, unknown>): boolean {
  if (policy.structured) return (PREPARE_TOOL_NAMES as readonly string[]).includes(toolName);
  if (toolName === 'badge.prepare_revoke') {
    return !!policy.badgeBinding && args.badgeId === policy.badgeBinding.badgeId &&
      args.employeeId === policy.badgeBinding.employeeId && args.reason === policy.badgeBinding.reason;
  }
  if (toolName === 'dashboard.prepare_share') {
    return !!policy.shareBinding && args.recipientId === policy.shareBinding.recipientId;
  }
  if (toolName === 'ticket.prepare_create') {
    if (!policy.ticketBinding || !sameTargetIds(args.branchIds, policy.ticketBinding.branchIds)) return false;
    const scope = args.scope;
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return false;
    const candidate = scope as Record<string, unknown>, binding = policy.ticketBinding;
    return (binding.region === undefined || candidate.region === binding.region) &&
      (binding.date === undefined || candidate.date === binding.date);
  }
  if (toolName === 'dashboard.prepare_create') {
    const spec = args.spec;
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return false;
    const scope = (spec as { scope?: unknown }).scope;
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return false;
    const candidate = scope as Record<string, unknown>, binding = policy.dashboardBinding;
    return !!binding && (binding.region === undefined || candidate.region === binding.region) &&
      (binding.date === undefined || candidate.date === binding.date) &&
      (binding.branchIds === undefined || sameTargetIds(candidate.branchIds, binding.branchIds));
  }
  return false;
}
