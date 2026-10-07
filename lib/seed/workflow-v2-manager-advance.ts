import 'server-only';
import type { Store } from '../contracts';
import { DomainError } from '../core/errors';
import { digest } from '../core/utils';
import { createTrustedWorkflowRuntime } from '../core/workflow-runtime';
import type { WorkflowStoreCapability } from '../storage/workflow-projections';
import type { WorkflowV2ManagerAdvanceRequest, WorkflowV2ManagerApprovalAdvancer } from './workflow-v2';

/**
 * Production advancer for the V2 bootstrap: approves the selected seeded onboarding requests as the seeded East onboarding manager
 * through the REAL Workflow V2 manager path (immutable manager-queue snapshot -> prepare -> confirm -> execute -> independent verify).
 * It writes nothing itself except an inert, already-expired system session and a hidden conversation for the manager anchor profile
 * (not a login profile) that the V2 runtime requires to own the pending action. Deterministic: fixed clock derived from the business
 * date and ids derived from the exact request batch, so a restart or a second advance never collides.
 */
export function createSeedManagerApprovalAdvancer(store: Store & WorkflowStoreCapability): WorkflowV2ManagerApprovalAdvancer {
  return async (input: WorkflowV2ManagerAdvanceRequest): Promise<void> => {
    const requestIds = [...input.requestIds];
    if (requestIds.length === 0) return;
    const batch = digest({ requestIds: [...requestIds].sort(), managerIdentityId: input.managerIdentityId }).slice(0, 16);
    const now = new Date(`${input.businessDate}T06:00:00.000Z`);
    const sessionId = `seed-v2-manager-session:${batch}`;
    const conversationId = `seed-v2-manager-conversation:${digest({ managerProfileId: input.managerProfileId }).slice(0, 16)}`;
    const turn = { conversationId, turnId: `seed-v2-manager-turn:${batch}` };
    const createdAt = now.toISOString();
    await store.transaction(async tx => {
      // Expires 15 minutes after the fixed seed clock, i.e. long before any real request: the row can never authenticate a browser.
      await tx.put('sessions', { id: sessionId, profileId: input.managerProfileId, mode: 'scripted_demo', modeRevision: 1,
        csrfToken: `seed-${batch}`, expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() });
    });
    await store.workflowTransaction(async tx => {
      await tx.insertUnique('conversations', { id: conversationId, actorId: input.managerProfileId, title: 'Synthetic seed manager approval',
        pinned: false, archivedAt: null, rowVersion: 1, createdAt, updatedAt: createdAt, lastScope: null, lastDashboardId: null },
      { constraint: 'conversations_primary_key', values: { id: conversationId } });
    });

    let counter = 0;
    const trusted = createTrustedWorkflowRuntime({
      store, businessDate: input.businessDate,
      contextFactory: () => ({ latestDashboard: async () => undefined }),
      now: () => now,
      makeId: prefix => `seed-v2-${batch}-${prefix}-${counter++}`,
    });
    const queue = await trusted.onboarding.managerQueue(sessionId);
    const displayed = new Set(queue.snapshot.displayedIds);
    if (!requestIds.every(id => displayed.has(id))) {
      throw new DomainError('WORKFLOW_STALE', 'The seeded requests are not all in the manager queue', 409);
    }
    const prepared = await trusted.runtime.prepare(sessionId, { kind: 'onboarding_manager_approve', snapshotId: queue.snapshot.id,
      requestIds: queue.snapshot.displayedIds.filter(id => requestIds.includes(id)) }, turn);
    if (prepared.outcome !== 'pending' || !prepared.pendingAction) throw new DomainError('WORKFLOW_UNAVAILABLE', 'Seed manager approval could not be prepared', 503);
    const confirmed = await trusted.runner.confirm(sessionId, prepared.pendingAction.id, `seed-v2-manager-confirm:${batch}`, turn);
    if (confirmed.error || confirmed.receipt?.outcome !== 'verified_success') {
      throw new DomainError('WORKFLOW_UNAVAILABLE', 'Seed manager approval was not verified', 503);
    }
  };
}
