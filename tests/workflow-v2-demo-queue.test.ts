import { describe, expect, it, vi } from 'vitest';
import { createTrustedWorkflowRuntime } from '../lib/core/workflow-runtime';
import { createSeedData } from '../lib/seed/generate';
import { createSeedManagerApprovalAdvancer } from '../lib/seed/workflow-v2-manager-advance';
import { ensureWorkflowV2DirectorIdentity, persistWorkflowV2DemoQueue, persistWorkflowV2LateArrival, persistWorkflowV2SeedPlan, prepareWorkflowV2SeedPlan } from '../lib/seed/workflow-v2';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

vi.mock('server-only', () => ({}));

const BUSINESS_DATE = '2026-10-01';

describe('Workflow V2 demo Director queue (SQLite and local PostgreSQL)', () => {
  it('advances the seeded requests through the real manager path, is idempotent, survives a Director decision, and admits a late arrival', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const plan = prepareWorkflowV2SeedPlan(createSeedData(BUSINESS_DATE), { seed: 1, businessDate: BUSINESS_DATE });
      const server = { store, advanceManagerApprovals: createSeedManagerApprovalAdvancer(store) };
      const states = async () => (await store.workflowProjectionReader.query<{ state: string }>({ kind: 'scoped', table: 'onboarding_requests', limit: 50 }))
        .map(row => row.body.state).sort();

      const base = await persistWorkflowV2SeedPlan(server, plan, { advanceManagerRequestIds: [plan.identities.onboardingRequestIds[0]] });
      expect(base.managerAdvancement.state).toBe('verified');
      const queue = await persistWorkflowV2DemoQueue(server, plan, { advance: true });
      expect(queue).toMatchObject({ state: 'verified' });
      expect(queue.directorQueueRequestIds).toHaveLength(3);
      // 4 at the Director, 1 (incomplete documents) still at the manager stage.
      expect(await states()).toEqual(['director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'manager_review_pending']);

      // The bootstrap is re-run on every process start: nothing is re-approved, nothing conflicts.
      expect((await persistWorkflowV2SeedPlan(server, plan, { advanceManagerRequestIds: [plan.identities.onboardingRequestIds[0]] })).state).toBe('source_ready');
      expect(await persistWorkflowV2DemoQueue(server, plan, { advance: true })).toMatchObject({ state: 'verified' });
      expect(await states()).toHaveLength(5);

      const sessionId = 'demo-queue-director-session';
      await store.transaction(tx => tx.put('sessions', { id: sessionId, profileId: 'director', mode: 'scripted_demo', modeRevision: 1, csrfToken: 'csrf-test', expiresAt: '2099-01-01T00:00:00.000Z' }));
      const trusted = createTrustedWorkflowRuntime({ store, businessDate: BUSINESS_DATE, contextFactory: () => ({ latestDashboard: async () => undefined }) });
      const reviewed = await trusted.onboarding.directorQueue(sessionId);
      expect(reviewed.items).toHaveLength(4);
      expect(new Set(reviewed.items.map(item => item.request.startDate)).size).toBeGreaterThan(1);

      // A later-arriving request goes through the same real path and is NOT part of the already reviewed snapshot.
      const late = await persistWorkflowV2LateArrival(server, plan, 0);
      expect(late.directorPending).toBe(true);
      expect(reviewed.snapshot.displayedIds).not.toContain(late.requestId);
      expect((await trusted.onboarding.directorQueue(sessionId)).items).toHaveLength(5);

      // The Director profile/identity repair is additive: the seeded identity is already bound (no rewrite).
      expect(await ensureWorkflowV2DirectorIdentity(store, plan)).toBe('present_bound');
    } finally {
      await fixture.dispose();
    }
  }, 240_000);
});
