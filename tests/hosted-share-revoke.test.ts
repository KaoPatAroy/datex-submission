import { afterEach, describe, expect, it, vi } from 'vitest';
import { actors, createWorkspaceFixture, dashboardPayload } from './helpers/workspace';
import { failure } from '../lib/server/http';
import { plan, planner } from './helpers/turn-planner';
import type { TurnPlannerInput } from '../lib/router/planner/input';
import { ConciergeService } from '../lib/core/service';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { createSeedData } from '../lib/seed/generate';
import { persistWorkflowV2DemoQueue, persistWorkflowV2SeedPlan, prepareWorkflowV2SeedPlan } from '../lib/seed/workflow-v2';
import { createSeedManagerApprovalAdvancer } from '../lib/seed/workflow-v2-manager-advance';
import type { Profile } from '../lib/contracts';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

afterEach(() => vi.unstubAllEnvs());

describe('hosted share revoke with Workflow V2 enabled', () => {
  it('revokes after a fresh Workflow V2 bootstrap and real demo queue advancement', async () => {
    vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
    vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const seedPlan = prepareWorkflowV2SeedPlan(createSeedData('2026-10-01'), { seed: 1, businessDate: '2026-10-01' });
      const server = { store, advanceManagerApprovals: createSeedManagerApprovalAdvancer(store) };
      await persistWorkflowV2SeedPlan(server, seedPlan, { advanceManagerRequestIds: [seedPlan.identities.onboardingRequestIds[0]] });
      expect((await persistWorkflowV2DemoQueue(server, seedPlan, { advance: true })).state).toBe('verified');
      const profile = (await store.get<Profile>('profiles', 'executive'))!;
      const owner = { ...profile, sessionId: 'hosted-bootstrap-session', mode: 'live_ai' as const, modeRevision: 1 };
      await store.transaction(tx => tx.put('sessions', { id: owner.sessionId, profileId: owner.id, mode: owner.mode, modeRevision: 1, csrfToken: 'test', expiresAt: '2099-01-01T00:00:00.000Z' }));
      const service = new ConciergeService(store, { now: () => new Date('2026-10-02T05:00:00.000Z'), businessDate: '2026-10-01' });
      const creation = await service.prepare(owner, dashboardPayload());
      const made = await service.confirm(owner, creation.id);
      if (made.visibility === 'restricted' || !made.dashboardId) throw new Error('Missing dashboard');
      const share = await service.prepare(owner, { kind: 'dashboard_share', dashboardId: made.dashboardId, recipientId: 'east' });
      expect((await service.confirm(owner, share.id)).status).toBe('verified_success');
      const [grant] = await service.dashboardShares(owner, made.dashboardId);
      await expect(service.revokeDashboardShare(owner, made.dashboardId, grant.shareId)).resolves.toMatchObject({ alreadyRevoked: false });
      expect(await service.dashboardShares(owner, made.dashboardId)).toEqual([]);
    } finally { await fixture.dispose(); }
  }, 60_000);

  it('chat plans from active grants, persists a preview, confirms the exact share and records History', async () => {
    vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
    vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    const fixture = await createWorkspaceFixture();
    try {
      const owner = actors.executive;
      const creation = await fixture.service.prepare(owner, dashboardPayload());
      const made = await fixture.service.confirm(owner, creation.id);
      if (made.visibility === 'restricted' || !made.dashboardId) throw new Error('Missing dashboard');
      const dashboardId = made.dashboardId;
      const share = await fixture.service.prepare(owner, { kind: 'dashboard_share', dashboardId, recipientId: actors.east.id });
      await fixture.service.confirm(owner, share.id);
      const [grant] = await fixture.service.dashboardShares(owner, dashboardId);
      await fixture.patchSession(owner.sessionId, { mode: 'live_ai', modeRevision: 1 });
      const live = { ...owner, mode: 'live_ai' as const, modeRevision: 1 };
      planner.reset();
      planner.reply((input: TurnPlannerInput) => {
        expect(input.context.dashboardShares).toContainEqual({ dashboardId, ...grant });
        return plan({ kind: 'action', actionId: 'dashboard.revoke_share', params: {
          dashboard: { value: dashboardId, source: 'context_id' }, shareId: { value: grant.shareId, source: 'context_id' },
        } });
      });
      const turn = await fixture.service.turn(live, 'Remove the access we discussed.', undefined, undefined, {
        contractVersion: 2,
        requestKey: 'hosted-share-revoke-context-001',
        targets: [{ kind: 'dashboard', id: dashboardId }],
      });
      const rows = await fixture.store.list<{ id: string; actionId: string; status: string }>('router_proposals');
      const proposal = rows.find(r => r.actionId === 'dashboard.revoke_share');
      expect(proposal, turn.message).toMatchObject({ status: 'pending' });
      expect(await fixture.service.dashboardShares(live, dashboardId)).toHaveLength(1);
      expect(await fixture.service.confirmStagedProposal(live, proposal!.id)).toMatchObject({ outcome: 'executed', verified: true });
      expect(await fixture.service.dashboardShares(live, dashboardId)).toEqual([]);
      const { listReceiptsPage } = await import('../app/api/router-proposals/_view');
      expect((await listReceiptsPage(fixture.store, live)).items).toContainEqual(expect.objectContaining({ id: proposal!.id, actionId: 'dashboard.revoke_share' }));
    } finally { await fixture.dispose(); }
  }, 60_000);

  it('revokes a confirmed chat dashboard share and audits it exactly once', async () => {
    vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
    vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    const fixture = await createWorkspaceFixture();
    try {
      const owner = actors.executive;
      const creation = await fixture.service.prepare(owner, dashboardPayload());
      const made = await fixture.service.confirm(owner, creation.id);
      if (made.visibility === 'restricted' || !made.dashboardId) throw new Error('Missing created dashboard');
      const share = await fixture.service.prepare(owner, { kind: 'dashboard_share', dashboardId: made.dashboardId, recipientId: actors.east.id });
      expect((await fixture.service.confirm(owner, share.id)).status).toBe('verified_success');
      const [grant] = await fixture.service.dashboardShares(owner, made.dashboardId);
      expect(grant.recipientId).toBe(actors.east.id);
      await expect(fixture.service.revokeDashboardShare(owner, made.dashboardId, grant.shareId)).resolves.toEqual({ shareId: grant.shareId, alreadyRevoked: false });
      await expect(fixture.service.revokeDashboardShare(owner, made.dashboardId, grant.shareId)).resolves.toEqual({ shareId: grant.shareId, alreadyRevoked: true });
      expect(await fixture.service.dashboardShares(owner, made.dashboardId)).toEqual([]);
      await expect(fixture.service.dashboard(actors.east, made.dashboardId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await fixture.service.getWorkspace(owner)).audit.filter(e => e.category === 'revoke')).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });

  it('logs only swallowed error class, name and code while returning a safe 503', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new TypeError('secret message'), { code: 'STORAGE', token: 'secret-token' });
    const response = failure(error);
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledExactlyOnceWith({ class: 'TypeError', name: 'TypeError', code: 'STORAGE' });
    expect(JSON.stringify(await response.json())).not.toContain('secret');
    log.mockRestore();
  });

  it('logs an inherited error name and omits object payload codes', () => {
    class AdapterFailure extends Error {}
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    failure(Object.assign(new AdapterFailure('private payload'), { code: { token: 'secret' } }));
    expect(log).toHaveBeenCalledExactlyOnceWith({ class: 'AdapterFailure', name: 'Error', code: null });
    log.mockRestore();
  });

  it('omits message-shaped diagnostic fields while preserving machine error codes', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    failure(Object.assign(new Error('private message'), { name: 'customer password: secret', code: 'api_key=secret' }));
    expect(log).toHaveBeenLastCalledWith({ class: 'Error', name: null, code: null });
    failure(Object.assign(new Error('private database message'), { code: '23514' }));
    expect(log).toHaveBeenLastCalledWith({ class: 'Error', name: 'Error', code: '23514' });
    log.mockRestore();
  });
});
