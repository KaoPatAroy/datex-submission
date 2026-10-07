import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard, Profile } from '@/lib/contracts';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const setActive = (id: string, active: boolean) => seeded.store.transaction(async tx => { const p = (await tx.get<Profile>('profiles', id))!; await tx.put('profiles', { ...p, active }); });

describe('PC-10: current-share resolver + owner revoke (Result shares)', { timeout: 180_000 }, () => {
  const messageIds: string[] = [];
  const shareIds: string[] = [];
  let artifactIds: string[] = [];
  it('shares two Results with the same recipient; both open and drill for the recipient', async () => {
    const owner = seeded.actors.executive, east = seeded.actors.east;
    const { listPendingProposals } = await import('@/app/api/router-proposals/_view');
    for (const chart of ['Make a bar chart of East sales by branch for 2026-10-01 with drilldown.', 'Make a combo chart of East sales and target by branch for 2026-10-01.']) {
      const made = await seeded.service.turn(owner, chart);
      const shared = await seeded.service.turn(owner, 'Share my chart with East manager.', made.conversationId);
      expect(shared.clarification, shared.message).toBeUndefined();
      const proposal = (await listPendingProposals(seeded.store, owner, SEED_NOW.getTime())).find(p => p.actionId === 'artifact.share' && !shareIds.includes(p.id))!;
      expect((await seeded.service.confirmStagedProposal(owner, proposal.id)).outcome).toBe('executed');
      shareIds.push(proposal.id);
    }
    const inbox = (await seeded.store.list<{ id: string; recipientId: string; artifact?: { id: string } }>('mock_messages')).filter(m => m.recipientId === 'east' && m.artifact);
    expect(inbox).toHaveLength(2);
    messageIds.push(...inbox.map(m => m.id)); artifactIds = inbox.map(m => m.artifact!.id);
    for (const [index, messageId] of messageIds.entries()) {
      expect((await seeded.service.openSharedArtifact(east, messageId)).shared).toBe(true);
      expect(artifactIds[index]).toBeTruthy();
    }
    const listed = await seeded.service.artifactShares(owner, artifactIds[0]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ recipientId: 'east', revision: 1 });
  });

  it('a deactivated sender is refused by BOTH open and drill (one resolver)', async () => {
    const east = seeded.actors.east;
    await setActive('executive', false);
    await expect(seeded.service.openSharedArtifact(east, messageIds[0])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(seeded.service.drillArtifact(east, { artifactId: artifactIds[0], field: 'branch', value: 'E01', messageId: messageIds[0] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setActive('executive', true);
    expect((await seeded.service.openSharedArtifact(east, messageIds[0])).shared).toBe(true);
  });

  it('revoke removes exactly that share: cached link fails on open and drill, the other share stays, revoke is idempotent and audited', async () => {
    const owner = seeded.actors.executive, east = seeded.actors.east;
    const [share] = await seeded.service.artifactShares(owner, artifactIds[0]);
    const audits = async () => (await seeded.store.list<{ category?: string }>('audit_events')).filter(e => e.category === 'revoke').length;
    const before = await audits();
    // Only the sender can revoke.
    await expect(seeded.service.revokeArtifactShare(east, artifactIds[0], share.shareId)).rejects.toMatchObject({ status: 404 });
    // A share id of another artifact cannot be revoked through this artifact.
    const [other] = await seeded.service.artifactShares(owner, artifactIds[1]);
    await expect(seeded.service.revokeArtifactShare(owner, artifactIds[0], other.shareId)).rejects.toMatchObject({ status: 404 });
    expect(await seeded.service.revokeArtifactShare(owner, artifactIds[0], share.shareId)).toMatchObject({ alreadyRevoked: false });
    expect(await seeded.service.revokeArtifactShare(owner, artifactIds[0], share.shareId)).toMatchObject({ alreadyRevoked: true });
    expect(await audits()).toBe(before + 1);
    await expect(seeded.service.openSharedArtifact(east, messageIds[0])).rejects.toMatchObject({ code: 'SHARE_REVOKED' });
    await expect(seeded.service.drillArtifact(east, { artifactId: artifactIds[0], field: 'branch', value: 'E01', messageId: messageIds[0] })).rejects.toMatchObject({ code: 'SHARE_REVOKED' });
    expect(await seeded.service.artifactShares(owner, artifactIds[0])).toEqual([]);
    // Unrelated grants are untouched.
    expect((await seeded.service.openSharedArtifact(east, messageIds[1])).shared).toBe(true);
    expect(await seeded.service.artifactShares(owner, artifactIds[1])).toHaveLength(1);
  });
});

describe('PC-10: owner revoke of a Dashboard share', { timeout: 180_000 }, () => {
  it('revokes the exact grant (idempotent, audited); the recipient fails closed; another Dashboard grant stays', async () => {
    const owner = seeded.actors.executive, east = seeded.actors.east;
    await seeded.service.turn(owner, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    await seeded.service.turn(owner, 'Build a dashboard of low stock by branch.');
    const dashboards = (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive');
    expect(dashboards).toHaveLength(2);
    for (const dashboard of dashboards) {
      const action = await seeded.service.prepare(owner, { kind: 'dashboard_share', dashboardId: dashboard.id, recipientId: 'east' });
      expect(JSON.stringify(await seeded.service.confirm(owner, action.id))).toContain('verified_success');
    }
    const [first, second] = dashboards;
    expect((await seeded.service.dashboard(east, first.id)).sharedBy).toBeTruthy();
    const [grant] = await seeded.service.dashboardShares(owner, first.id);
    expect(grant).toMatchObject({ recipientId: 'east' });
    await expect(seeded.service.revokeDashboardShare(east, first.id, grant.shareId)).rejects.toMatchObject({ status: 404 });
    await expect(seeded.service.revokeDashboardShare(owner, second.id, grant.shareId)).rejects.toMatchObject({ status: 404 });
    expect(await seeded.service.revokeDashboardShare(owner, first.id, grant.shareId)).toMatchObject({ alreadyRevoked: false });
    expect(await seeded.service.revokeDashboardShare(owner, first.id, grant.shareId)).toMatchObject({ alreadyRevoked: true });
    await expect(seeded.service.dashboard(east, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await seeded.service.dashboard(east, second.id)).sharedBy).toBeTruthy();
    expect(await seeded.service.dashboardShares(owner, first.id)).toEqual([]);
    expect(await seeded.service.dashboardShares(owner, second.id)).toHaveLength(1);
    // The revoked Dashboard is private again: a direct edit no longer needs the shared-confirm tier.
    const dashboard = (await seeded.store.get<Dashboard>('dashboards', first.id))!;
    await seeded.service.renameDashboard(owner, first.id, { title: 'หลังเพิกถอนการแชร์' });
    expect((await seeded.store.get<Dashboard>('dashboards', first.id))!.spec.title).toBe('หลังเพิกถอนการแชร์');
    expect(dashboard.id).toBe(first.id);
    // A deactivated sender also closes the other Dashboard for its recipient.
    await setActive('executive', false);
    await expect(seeded.service.dashboard(east, second.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setActive('executive', true);
  });
});
