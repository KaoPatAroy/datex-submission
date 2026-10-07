import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Dashboard, Profile } from '@/lib/contracts';
import { actors } from '../helpers/workspace';
import { seedTables, type TableFixture } from './executors/table-fixtures';
import { drillArtifact, openArtifactVersion } from '@/lib/router/executors/artifact-read';
import { listInbox } from '@/lib/router/ports/effect-store';

let fixture: TableFixture;
async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await seedTables({ incidents: 5 });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('a table answer is a first-class accepted state (artifact, Dashboard widgets, messages, monitors)', { timeout: 60_000 }, () => {
  it('two-step: the low-stock answer becomes a Dashboard whose widgets re-read the table under the viewer\'s authority', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Build a dashboard of low stock by branch.');
    expect(response.clarification).toBeUndefined();
    expect(response.message).not.toContain('ยังไม่ได้ดำเนินการ — ขั้นตอนถัดไป');
    const dashboards = await fixture.store.list<Dashboard>('dashboards');
    expect(dashboards).toHaveLength(1);
    const dashboard = dashboards[0]!;
    expect(dashboard.spec.widgets.every(w => w.type === 'viz' && w.binding.datasetId === 'inventory_items')).toBe(true);
    const opened = await fixture.service.dashboard(actor, dashboard.id);
    expect(opened.vizData?.length).toBe(2);
    expect(opened.vizData?.every(item => item.status === 'ready')).toBe(true);
    const bar = opened.vizData![0]!;
    if (bar.status === 'ready') {
      expect(bar.data.measure).toBe('low_stock_items');
      expect(bar.data.points.length).toBeGreaterThan(0);
      // Numbers are the table claims (counts of low-stock rows per branch), nothing recomputed here.
      const byBranch = Object.fromEntries(bar.data.points.map(p => [p.key, p.value]));
      expect(byBranch.C01).toBe(1);
      expect(byBranch.E02).toBeGreaterThanOrEqual(1);
    }
    // The east manager is not the owner and has no share: the dashboard is not theirs to open.
    await expect(fixture.service.dashboard(await live(actors.east), dashboard.id)).rejects.toBeTruthy();
  });

  it('a Dashboard widget of a table dataset is denied for a viewer who lost operations.read', async () => {
    const actor = await live(actors.executive);
    await fixture.service.turn(actor, 'Build a dashboard of low stock by branch.');
    const [dashboard] = await fixture.store.list<Dashboard>('dashboards');
    const profile = await fixture.store.get<Profile>('profiles', 'executive');
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'operations.read') }));
    const opened = await fixture.service.dashboard(actor, dashboard!.id).catch(() => undefined);
    // Either the whole open is refused or no widget is ready: the table is never read without the permission.
    expect(!opened || opened.vizData?.every(item => item.status !== 'ready')).toBe(true);
  });

  it('two-step: the low-stock answer becomes a table artifact that is persisted and reloads identically', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Make a table of low stock by branch.');
    expect(response.clarification).toBeUndefined();
    const artifact = response.artifacts?.[0];
    expect(artifact).toMatchObject({ kind: 'table' });
    expect(artifact!.spec.facts.length).toBeGreaterThan(0);
    expect(artifact!.spec.facts.every(f => f.measure === 'low_stock_items' && f.sourceRefs.length > 0 && f.rowRefs.length > 0)).toBe(true);
    expect(artifact!.spec.labels?.fields.low_stock_items).toBe('รายการสต็อกต่ำกว่าขั้นต่ำ');
    const reopened = await openArtifactVersion({ store: fixture.store, actor, now: () => new Date() }, artifact!.id, artifact!.revision);
    expect(JSON.stringify(reopened.spec)).toBe(JSON.stringify(artifact!.spec));
    // A role without the dataset permission cannot reload it.
    const profile = await fixture.store.get<Profile>('profiles', 'executive');
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'operations.read') }));
    await expect(openArtifactVersion({ store: fixture.store, actor, now: () => new Date() }, artifact!.id, 1)).rejects.toMatchObject({ status: 403 });
  });

  it('L6: drilling a table-dataset artifact re-runs through the registered table executor and matches the stored version', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Make a table of low stock by branch.');
    const artifact = response.artifacts![0]!;
    const branch = artifact.spec.facts[0]!.dimensions.branch!;
    const result = await drillArtifact({ store: fixture.store, actor, now: () => new Date(), businessDate: '2026-10-01', read: async () => { throw new Error('table datasets never use the branch evidence reader'); } },
      { artifactId: artifact.id, field: 'branch', value: branch });
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.every(f => f.dimensions.branch === branch && f.sourceRefs.length > 0)).toBe(true);
    expect(result.matchesVersion).toBe(true);
  });

  it('two-step: a bar chart over the table answer is a registered chart family', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Make a bar chart of low stock by branch.');
    expect(response.clarification).toBeUndefined();
    expect(response.artifacts?.[0]).toMatchObject({ kind: 'chart' });
    expect(response.artifacts![0]!.spec.visualization).toMatchObject({ primitive: 'bar', xField: 'branch', yFields: ['low_stock_items'] });
  });

  it('follow-up turn: "send this answer" binds the table state, stages, and confirm delivers evidenced text to the recipient inbox', async () => {
    const actor = await live(actors.executive);
    const first = await fixture.service.turn(actor, 'Show East low stock by branch.');
    expect(first.clarification).toBeUndefined();
    const second = await fixture.service.turn(actor, 'Send this stock answer to East manager.', first.conversationId);
    expect(second.clarification).toBeUndefined();
    const proposalId = second.pendingActions?.[0]?.id ?? (second as { stagedProposals?: { id: string }[] }).stagedProposals?.[0]?.id;
    const staged = await fixture.store.list<{ id: string; actionId: string; status: string; data: { params: { contentStateId: string } } }>('router_proposals');
    expect(staged).toHaveLength(1);
    expect(staged[0]!.actionId).toBe('communication.send');
    expect(staged[0]!.data.params.contentStateId).toMatch(/^table-state:/);
    void proposalId;
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
    const result = await fixture.service.confirmStagedProposal(actor, staged[0]!.id);
    expect(result).toMatchObject({ outcome: 'executed', verified: true });
    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content).toContain('สต็อก');
  });

  it('sending a table answer is refused when a recipient cannot read the whole scope (nothing staged, nothing delivered)', async () => {
    const actor = await live(actors.executive);
    const first = await fixture.service.turn(actor, 'Show low stock by branch.');
    const second = await fixture.service.turn(actor, 'Send this stock answer to East manager.', first.conversationId);
    expect(second.clarification).toBe(true);
    expect(await fixture.store.list('router_proposals')).toHaveLength(0);
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
  });

  it('a monitor over a table answer is refused honestly (no registered threshold) and writes nothing', async () => {
    const actor = await live(actors.executive);
    const first = await fixture.service.turn(actor, 'Show low stock by branch.');
    const second = await fixture.service.turn(actor, 'Alert East manager when low stock is below 90%.', first.conversationId);
    expect(second.clarification).toBe(true);
    expect(second.message).toContain('Monitor ตั้งได้เฉพาะคำตอบผลงานสาขา');
    expect(await fixture.store.list('router_proposals')).toHaveLength(0);
  });

  it('a role without operations.read gets no table state to build on', async () => {
    const actor = await live(actors.hr);
    const response = await fixture.service.turn(actor, 'Make a table of low stock by branch.');
    expect(response.artifacts).toBeUndefined();
  });
});
