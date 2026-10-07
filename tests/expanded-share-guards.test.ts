import { describe, expect, it } from 'vitest';
import type { PendingAction, Profile, Receipt, RowFilter, Store, Table } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { actors, BUSINESS_DATE, createWorkspaceFixture, dashboardPayload, FIXED_NOW } from './helpers/workspace';

async function createAndShareDashboard(fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>) {
  const dashboardAction = await fixture.service.prepare(actors.executive, dashboardPayload('all'));
  const dashboardReceipt = await fixture.service.confirm(actors.executive, dashboardAction.id);
  const dashboardId = dashboardReceipt.dashboardId ?? dashboardReceipt.results[0]?.id;
  if (dashboardReceipt.status !== 'verified_success' || !dashboardId) {
    throw new Error('Expected dashboard creation to be verified before sharing.');
  }

  const shareAction = await fixture.service.prepare(actors.executive, {
    kind: 'dashboard_share',
    dashboardId,
    recipientId: 'east',
  });
  const shareReceipt = await fixture.service.confirm(actors.executive, shareAction.id);
  if (shareReceipt.status !== 'verified_success') {
    throw new Error('Expected dashboard sharing to be verified before reading as the recipient.');
  }

  return dashboardId;
}

async function setEastRecipientRegions(
  fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
  regions: string[],
) {
  await fixture.store.transaction(async (tx) => {
    const profile = await tx.get<Profile>('profiles', 'east');
    if (!profile) throw new Error('Missing East recipient profile in the SQLite fixture.');
    await tx.put('profiles', { ...profile, regions });
  });
}

describe('expanded dashboard-share guards', () => {
  it('does not widen a shared recipient view when new regions become readable', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const dashboardId = await createAndShareDashboard(fixture);
      const approvedView = await fixture.service.dashboard(actors.east, dashboardId);
      const approvedBranchIds = new Set(approvedView.evidence.branches.map((branch) => branch.branchId));
      const approvedSourceIds = new Set(approvedView.evidence.sources.map((source) => source.id));
      expect(approvedBranchIds.size).toBeGreaterThan(0);
      expect(approvedSourceIds.size).toBeGreaterThan(0);

      await setEastRecipientRegions(fixture, [...new Set([...approvedView.evidence.branches.map((branch) => branch.region), 'central'])]);

      let expandedView;
      try {
        expandedView = await fixture.service.dashboard(actors.east, dashboardId);
      } catch (error) {
        expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
        return;
      }

      const expandedBranchIds = expandedView.evidence.branches.map((branch) => branch.branchId);
      const expandedSourceIds = expandedView.evidence.sources.map((source) => source.id);
      expect(expandedBranchIds.length).toBeGreaterThan(0);
      expect(expandedSourceIds.length).toBeGreaterThan(0);
      expect.soft(expandedBranchIds.every((branchId) => approvedBranchIds.has(branchId))).toBe(true);
      expect.soft(expandedSourceIds.every((sourceId) => approvedSourceIds.has(sourceId))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not create a second grant or mock delivery for a fresh repeated share confirmation', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const dashboardId = await createAndShareDashboard(fixture);
      const grantsAfterFirstShare = await fixture.store.list<{ id: string }>('dashboard_shares');
      const deliveriesAfterFirstShare = await fixture.store.list('mock_messages');
      expect(grantsAfterFirstShare).toHaveLength(1);
      expect(deliveriesAfterFirstShare).toHaveLength(1);
      const firstShareAction = (await fixture.store.list<PendingAction>('pending_actions')).find((action) =>
        action.payload.kind === 'dashboard_share' && action.payload.dashboardId === dashboardId && action.status === 'completed');
      if (!firstShareAction) throw new Error('Expected the original dashboard-share action to be completed.');
      const firstReceipt = await fixture.store.get<Receipt>('action_executions', `execution_${firstShareAction.id}`);
      if (!firstReceipt) throw new Error('Expected the original dashboard-share receipt to be persisted.');

      const replayed = await fixture.service.confirm(actors.executive, firstShareAction.id);
      expect(replayed).toMatchObject({ id: firstReceipt.id, status: 'verified_success', results: firstReceipt.results });
      expect(firstReceipt.results[0]).toMatchObject({ targetId: 'east', id: grantsAfterFirstShare[0].id, status: 'verified_success' });

      const repeatedAction = await fixture.service.prepare(actors.executive, {
        kind: 'dashboard_share',
        dashboardId,
        recipientId: 'east',
      });

      const repeatedResult = await fixture.service.confirm(actors.executive, repeatedAction.id).then(
        (receipt) => ({ receipt }),
        (error: unknown) => ({ error }),
      );
      if ('error' in repeatedResult) {
        expect(repeatedResult.error).toMatchObject({ status: 409 });
      } else {
        expect(['verified_success', 'denied']).toContain(repeatedResult.receipt.status);
      }

      expect.soft(await fixture.store.list('dashboard_shares')).toHaveLength(1);
      expect.soft(await fixture.store.list('mock_messages')).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('denies a fresh duplicate confirmation before either receipt or effect is written', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const dashboardAction = await fixture.service.prepare(actors.executive, dashboardPayload('all'));
      const dashboardReceipt = await fixture.service.confirm(actors.executive, dashboardAction.id);
      const dashboardId = dashboardReceipt.dashboardId ?? dashboardReceipt.results[0]?.id;
      if (dashboardReceipt.status !== 'verified_success' || !dashboardId) {
        throw new Error('Expected dashboard creation to be verified before sharing.');
      }
      const payload = { kind: 'dashboard_share' as const, dashboardId, recipientId: 'east' };
      const [first, second] = await Promise.all([
        fixture.service.prepare(actors.executive, payload),
        fixture.service.prepare(actors.executive, payload),
      ]);

      const results = await Promise.allSettled([
        fixture.service.confirm(actors.executive, first.id),
        fixture.service.confirm(actors.executive, second.id),
      ]);
      const fulfilled = results.flatMap((result, index) => result.status === 'fulfilled' ? [{ actionId: [first.id, second.id][index], receipt: result.value }] : []);
      const rejected = results.flatMap((result, index) => result.status === 'rejected' ? [{ actionId: [first.id, second.id][index], reason: result.reason }] : []);

      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].receipt.status).toBe('verified_success');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409 });
      expect(await fixture.store.get('action_executions', `execution_${rejected[0].actionId}`)).toBeUndefined();
      expect(await fixture.store.list('dashboard_shares')).toHaveLength(1);
      expect(await fixture.store.list('mock_messages')).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    { kind: 'missing', operationKey: undefined },
    { kind: 'non-string', operationKey: 42 },
    { kind: 'malformed-string', operationKey: 'legacy-unbound-share' },
  ])('denies a markerless legacy grant with a $kind operation key', async ({ operationKey }) => {
    const fixture = await createWorkspaceFixture();
    try {
      const dashboardId = await createAndShareDashboard(fixture);
      const legacyStore = Object.create(fixture.store) as Store;
      legacyStore.list = async <T>(table: Table, filters?: RowFilter): Promise<T[]> => {
        const rows = await fixture.store.list<T>(table, filters);
        if (table !== 'dashboard_shares') return rows;
        return rows.map((row) => {
          const legacyGrant = { ...(row as Record<string, unknown>) };
          if (operationKey === undefined) delete legacyGrant.operationKey;
          else legacyGrant.operationKey = operationKey;
          return legacyGrant as T;
        });
      };
      const legacyService = new ConciergeService(legacyStore, {
        businessDate: BUSINESS_DATE,
        now: () => new Date(FIXED_NOW),
      });

      await expect(legacyService.dashboard(actors.east, dashboardId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect((await legacyService.getWorkspace(actors.east)).inbox).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('denies the shared view after the recipient loses every region approved at share time', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const dashboardId = await createAndShareDashboard(fixture);
      const approvedView = await fixture.service.dashboard(actors.east, dashboardId);
      const approvedBranchIds = new Set(approvedView.evidence.branches.map((branch) => branch.branchId));
      const approvedSourceIds = new Set(approvedView.evidence.sources.map((source) => source.id));
      expect(approvedBranchIds.size).toBeGreaterThan(0);
      expect(approvedSourceIds.size).toBeGreaterThan(0);

      const ownerView = await fixture.service.dashboard(actors.executive, dashboardId);
      const newlyReadableRegion = ownerView.evidence.branches.find((branch) => !approvedBranchIds.has(branch.branchId))?.region;
      if (!newlyReadableRegion) throw new Error('Expected the all-region fixture to contain data outside the East recipient view.');
      await setEastRecipientRegions(fixture, [newlyReadableRegion]);

      let readError: unknown;
      let laterView: { branchIds: string[]; sourceIds: string[] } | undefined;
      try {
        const view = await fixture.service.dashboard(actors.east, dashboardId);
        laterView = {
          branchIds: view.evidence.branches.map((branch) => branch.branchId),
          sourceIds: view.evidence.sources.map((source) => source.id),
        };
      } catch (error) {
        readError = error;
      }
      if (laterView) {
        expect.soft(laterView.branchIds.every((branchId) => approvedBranchIds.has(branchId))).toBe(true);
        expect.soft(laterView.sourceIds.every((sourceId) => approvedSourceIds.has(sourceId))).toBe(true);
      }
      expect(readError).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    } finally {
      await fixture.dispose();
    }
  });
});
