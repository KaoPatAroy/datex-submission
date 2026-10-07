import type { Actor, Store } from '../../contracts';
import type { PlannerContext } from '../planner-context';
import { approvalRecordOf, isDirectorActionId } from '../executors/director';
import { listSnapshotLinks } from '../executors/workflow-read';
import type { StagedStore } from '../storage/staged-store';
import { createDirectorWorkflowPort, type DirectorCapabilities, type DirectorWorkflowPort } from './director-workflow';

/**
 * Service glue for the HR Director bridge (kept out of lib/core/service.ts): which router actions the V2 projection permits, the
 * planner's WORKFLOW block (server projection only) and the default composition over the server Workflow V2 runtime.
 */
export const NO_DIRECTOR_CAPABILITIES: DirectorCapabilities = Object.freeze({ reads: [], decisions: [] }) as DirectorCapabilities;
const CONTEXT_QUEUES = 3, CONTEXT_APPROVALS = 3;

const READ_DESCRIPTIONS: Readonly<Record<string, string>> = {
  director_queue: 'Read the onboarding requests waiting for this Director (creates a new immutable reviewed queue; at most 20 per page — add snapshotId of an earlier reviewed queue for the NEXT page)',
  director_start_dates: 'Start dates of the requests in one reviewed queue (snapshotId), sorted by start date',
  director_request_documents: 'Accepted documents of one request (requestId) in one reviewed queue (snapshotId)',
  director_approvals_today: 'This Director’s verified approvals today',
};

/** A router onboarding.* action is permitted only while the V2 projection grants the matching decision to this actor. */
export function directorActionPermitted(actionId: string, capabilities: DirectorCapabilities): boolean | undefined {
  if (!isDirectorActionId(actionId)) return undefined;
  return capabilities.decisions.includes(actionId === 'onboarding.return' ? 'onboarding_return' : 'onboarding_director_approve');
}

export async function buildDirectorPlannerContext(input: {
  port: DirectorWorkflowPort; capabilities: DirectorCapabilities; store: Store; staged: Pick<StagedStore, 'list'>; actor: Actor; conversationId: string;
}): Promise<PlannerContext['workflow']> {
  if (!input.capabilities.reads.length) return undefined;
  const reviewedQueues: NonNullable<PlannerContext['workflow']>['reviewedQueues'] = [];
  // Only queues read in THIS conversation and session, and only while V2 still validates the exact snapshot.
  for (const link of (await listSnapshotLinks(input.store, input.actor, input.conversationId)).slice(0, CONTEXT_QUEUES)) {
    const queue = await input.port.reviewedQueue(input.actor, link.snapshotId);
    if (queue?.requests.length) reviewedQueues.push({ id: queue.snapshotId, expiresAt: queue.expiresAt,
      requests: queue.requests.map(request => ({ id: request.requestId, label: `${request.employeeName} (เริ่มงาน ${request.startDate})`, startDate: request.startDate })) });
  }
  const verifiedApprovals: NonNullable<PlannerContext['workflow']>['verifiedApprovals'] = [];
  if (input.capabilities.decisions.includes('onboarding_director_approve')) {
    for (const proposal of await input.staged.list(input.actor, input.conversationId, { status: 'completed' })) {
      const record = approvalRecordOf(proposal, input.conversationId);
      if (record && verifiedApprovals.length < CONTEXT_APPROVALS) verifiedApprovals.push({ id: proposal.id, label: `อนุมัติแล้ว: ${record.labels.join(', ')}`.slice(0, 200), requestIds: record.requestIds });
    }
  }
  return { reads: input.capabilities.reads.map(readId => ({ readId, description: READ_DESCRIPTIONS[readId] ?? readId })), reviewedQueues, verifiedApprovals };
}

/**
 * Default composition: the single server Workflow V2 runtime (only when WORKFLOW_V2_ENABLED and its bootstrap is ready). Any failure
 * leaves the bridge absent, so nothing is advertised (parity: offered only when it works).
 */
export async function resolveServerDirectorWorkflow(store: Store, now: () => Date): Promise<DirectorWorkflowPort | undefined> {
  if (process.env.WORKFLOW_V2_ENABLED !== 'true') return undefined;
  try {
    const { getWorkflowV2ServerRuntime } = await import('../../server/workflow');
    const runtime = await getWorkflowV2ServerRuntime();
    if (runtime.runtime.store !== (store as unknown)) return undefined;
    return createDirectorWorkflowPort({ workflow: { runtime: runtime.runtime, runner: runtime.runner, onboarding: runtime.onboarding, availability: runtime.availability }, store, now });
  } catch { return undefined; }
}
