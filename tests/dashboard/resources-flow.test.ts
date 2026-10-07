import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { specRevision } from '@/lib/router/executors/action-ports';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { filterResults } from '@/lib/artifacts/library-view';
import { createArtifactReader } from '@/lib/artifacts';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
let conversationId: string;
let dashboardId: string;
let secondDashboardId: string;
let artifactId: string;

const COMBO = 'Make a combo chart of East sales and target by branch for 2026-10-01.';
const dashboards = async (): Promise<Dashboard[]> => (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive');
const byId = async (id: string) => (await seeded.store.get<Dashboard>('dashboards', id))!;
const revisionOf = async (id: string) => specRevision((await byId(id)).spec);

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  vi.stubEnv('NEXUS_E2E_RUNNER', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

describe('Results library + direct Dashboard management (one rule set with the router)', { timeout: 120_000 }, () => {
  it('Dashboard 1: several Dashboards coexist for one owner and the planner context shows their CURRENT titles and ids', async () => {
    const actor = seeded.actors.executive;
    const one = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    conversationId = one.conversationId;
    await seeded.service.turn(actor, 'Build a dashboard of low stock by branch.');
    const owned = await dashboards();
    expect(owned).toHaveLength(2);
    dashboardId = owned.find(d => d.spec.widgets.length === 7)!.id;
    secondDashboardId = owned.find(d => d.id !== dashboardId)!.id;
    // A direct rename shows up in the planner's world immediately (it is read from the store, not a cache).
    await seeded.service.renameDashboard(actor, dashboardId, { title: 'ภาพรวมภาคตะวันออก' }, { expectedRevision: await revisionOf(dashboardId) });
    const { buildPlannerContext } = await import('@/lib/router/context/build-context');
    const { actionRegistry } = await import('@/lib/router/action-registry');
    const { createSemanticCatalog } = await import('@/lib/dynamic/catalog/semantic');
    const context = await buildPlannerContext({ store: seeded.store, actor, conversationId, businessDate: '2026-10-01', registry: actionRegistry, now: () => Date.now(),
      catalog: createSemanticCatalog(await seeded.store.list('branches')), recipientAllowed: async () => false });
    expect(context.dashboards.map(d => d.id).sort()).toEqual([dashboardId, secondDashboardId].sort());
    expect(context.dashboards.find(d => d.id === dashboardId)?.title).toBe('ภาพรวมภาคตะวันออก');
    expect((await byId(dashboardId)).spec.title).toBe('ภาพรวมภาคตะวันออก');
  });

  it('Dashboard 2-6: rename persists, a stale rename conflicts, description/reorder/retitle/remove persist, the last widget cannot be removed', async () => {
    const actor = seeded.actors.executive;
    const stale = await revisionOf(dashboardId);
    await seeded.service.renameDashboard(actor, dashboardId, { title: 'ชื่อใหม่', description: 'คำอธิบายใหม่' }, { expectedRevision: stale });
    expect((await byId(dashboardId)).spec).toMatchObject({ title: 'ชื่อใหม่', description: 'คำอธิบายใหม่' });
    await expect(seeded.service.renameDashboard(actor, dashboardId, { title: 'ทับของใหม่' }, { expectedRevision: stale })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
    expect((await byId(dashboardId)).spec.title).toBe('ชื่อใหม่');

    const before = (await byId(dashboardId)).spec.widgets.map(w => w.title);
    await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'reorder', order: [6, 5, 4, 3, 2, 1, 0] } });
    expect((await byId(dashboardId)).spec.widgets.map(w => w.title)).toEqual([...before].reverse());
    await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'retitle', index: 0, title: 'ชื่อ Widget ใหม่' } });
    expect((await byId(dashboardId)).spec.widgets[0].title).toBe('ชื่อ Widget ใหม่');
    await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'remove', index: 1 } });
    expect((await byId(dashboardId)).spec.widgets).toHaveLength(6);
    // Stale or malformed edits never write.
    const staleRevision = await revisionOf(dashboardId);
    await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: staleRevision, change: { op: 'remove', index: 0 } });
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: staleRevision, change: { op: 'remove', index: 0 } })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'reorder', order: [0, 0, 1, 2, 3] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await byId(dashboardId)).spec.widgets).toHaveLength(5);
    // One widget must stay: removal of the last one is refused (delete the Dashboard instead).
    for (let i = 0; i < 4; i += 1) await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'remove', index: 0 } });
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: await revisionOf(dashboardId), change: { op: 'remove', index: 0 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await byId(dashboardId)).spec.widgets).toHaveLength(1);
  });

  it('Results 1-3: a chat Result appears under Recent, Save marks it Saved, and it survives a reload', async () => {
    const actor = seeded.actors.executive;
    const answer = await seeded.service.turn(actor, COMBO, conversationId);
    expect(answer.clarification, answer.message).toBeUndefined();
    const items = await seeded.service.resultsLibrary(actor);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'chart', section: 'recent', saved: false, pinned: false, archived: false, latestRevision: 1, revisions: [1] });
    artifactId = items[0].id;
    await seeded.service.saveArtifact(actor, artifactId);
    const reloaded = await seeded.service.resultsLibrary(actor);
    expect(reloaded[0]).toMatchObject({ section: 'saved', saved: true, savedRevision: 1 });
  });

  it('Results 4-7, 14: rename is metadata only (version row + digest identical); pin/unpin and archive/unarchive persist; archive never destroys a version', async () => {
    const actor = seeded.actors.executive;
    const versionRow = async () => JSON.stringify(await seeded.store.get('tool_executions', `artifact-version:${artifactId}:1`));
    const headRow = async () => JSON.stringify(await seeded.store.get('tool_executions', `artifact-head:${artifactId}`));
    const [versionBefore, headBefore] = [await versionRow(), await headRow()];
    const renamed = await seeded.service.updateResult(actor, artifactId, { op: 'rename', title: 'ยอดขายและเป้ารายสาขา' });
    expect(renamed).toMatchObject({ title: 'ยอดขายและเป้ารายสาขา', renamed: true });
    expect(await versionRow()).toBe(versionBefore);
    expect(await headRow()).toBe(headBefore);
    expect((await seeded.service.openArtifact(actor, artifactId)).spec.title).not.toBe('ยอดขายและเป้ารายสาขา'); // evidence payload keeps its own title

    expect((await seeded.service.updateResult(actor, artifactId, { op: 'pin' })).pinned).toBe(true);
    expect((await seeded.service.resultsLibrary(actor))[0].pinned).toBe(true);
    expect((await seeded.service.updateResult(actor, artifactId, { op: 'pin' })).pinned).toBe(true); // idempotent
    expect((await seeded.service.updateResult(actor, artifactId, { op: 'unpin' })).pinned).toBe(false);

    expect((await seeded.service.updateResult(actor, artifactId, { op: 'archive' })).section).toBe('archived');
    expect(filterResults(await seeded.service.resultsLibrary(actor), { section: 'saved' })).toHaveLength(0);
    expect(await versionRow()).toBe(versionBefore); // referenced version is never destroyed
    expect((await seeded.service.openArtifact(actor, artifactId)).artifact.id).toBe(artifactId); // still openable (shares/receipts/lineage keep working)
    expect((await seeded.service.updateResult(actor, artifactId, { op: 'unarchive' })).section).toBe('saved');
    expect(await createArtifactReader(seeded.store, actor.id).latest(artifactId)).not.toBeNull();
    await expect(seeded.service.updateResult(actor, artifactId, { op: 'rename', title: '   ' })).rejects.toBeTruthy();
  });

  it('Results 8-9, 12: search and type filters cover owned Results only; another actor cannot enumerate or mutate', async () => {
    const actor = seeded.actors.executive;
    const items = await seeded.service.resultsLibrary(actor);
    expect(filterResults(items, { query: 'เป้ารายสาขา' })).toHaveLength(1);
    expect(filterResults(items, { query: 'ไม่มีชื่อนี้' })).toHaveLength(0);
    expect(filterResults(items, { kind: 'chart' })).toHaveLength(1);
    expect(filterResults(items, { kind: 'table' })).toHaveLength(0);
    const east = seeded.actors.east;
    expect(await seeded.service.resultsLibrary(east)).toEqual([]);
    await expect(seeded.service.updateResult(east, artifactId, { op: 'archive' })).rejects.toMatchObject({ status: 404 });
    await expect(seeded.service.addResultToDashboard(east, dashboardId, { baseRevision: await revisionOf(dashboardId), artifactId })).rejects.toMatchObject({ status: 404 });
  });

  it('Dashboard 15 / Results 15: Add to Dashboard derives a DYNAMIC re-authorized widget (query-bound, no stored rows), re-reads under the viewer, and refuses a stale base', async () => {
    const actor = seeded.actors.executive;
    const base = await revisionOf(dashboardId);
    await seeded.service.addResultToDashboard(actor, dashboardId, { baseRevision: base, artifactId });
    const dashboard = await byId(dashboardId);
    const added = dashboard.spec.widgets.at(-1)!;
    expect(added).toMatchObject({ type: 'viz', kind: 'combo' });
    const stored = JSON.stringify(added);
    expect(stored).not.toMatch(/<svg|<script|data:image|"points"|"facts"/);
    expect((added as { binding: { message: string } }).binding.message).toBe(COMBO);
    const opened = await seeded.service.dashboard(actor, dashboardId);
    const last = opened.vizData!.at(-1)!;
    expect(last.status).toBe('ready');
    if (last.status === 'ready') expect(last.data.chart?.primitive).toBe('combo');
    await expect(seeded.service.addResultToDashboard(actor, dashboardId, { baseRevision: base, artifactId })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
    expect((await byId(dashboardId)).spec.widgets).toHaveLength(2);
    // Permission loss: the widget is not derivable any more, and the Dashboard open is denied.
    const profile = (await seeded.store.get<{ id: string; permissions: string[] } & Record<string, unknown>>('profiles', 'executive'))!;
    await seeded.store.transaction(async tx => { await tx.put('profiles', { ...profile, permissions: profile.permissions.filter(p => p !== 'sales.read') }); });
    await expect(seeded.service.addResultToDashboard(actor, secondDashboardId, { baseRevision: await revisionOf(secondDashboardId), artifactId })).rejects.toMatchObject({ status: 403 });
    await expect(seeded.service.dashboard(actor, dashboardId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await seeded.store.transaction(async tx => { await tx.put('profiles', profile); });
  });

  it('Dashboard 12: a shared Dashboard keeps its confirm tier: direct widget edits and Add Result are refused and nothing changes', async () => {
    const actor = seeded.actors.executive;
    await seeded.store.transaction(async tx => { await tx.put('dashboard_shares', { id: 'share-1', dashboardId: secondDashboardId, recipientId: 'east', actorId: 'executive', active: true, operationKey: 'execution_a:east', createdAt: '2026-10-02T00:00:00.000Z' }); });
    const before = JSON.stringify(await byId(secondDashboardId));
    await expect(seeded.service.editDashboardWidgets(actor, secondDashboardId, { baseRevision: await revisionOf(secondDashboardId), change: { op: 'retitle', index: 0, title: 'x' } })).rejects.toMatchObject({ code: 'DASHBOARD_SHARED' });
    await expect(seeded.service.addResultToDashboard(actor, secondDashboardId, { baseRevision: await revisionOf(secondDashboardId), artifactId })).rejects.toMatchObject({ code: 'DASHBOARD_SHARED' });
    await expect(seeded.service.renameDashboard(actor, secondDashboardId, { title: 'ใหม่' }, { expectedRevision: await revisionOf(secondDashboardId) })).rejects.toMatchObject({ code: 'DASHBOARD_SHARED' });
    expect(JSON.stringify(await byId(secondDashboardId))).toBe(before);
  });

  it('Shared UI edit: direct UI on a shared Dashboard stages the SAME proposal (UI origin), nothing changes until confirm, then the recipient sees it', async () => {
    const actor = seeded.actors.executive;
    const { listPendingProposals } = await import('@/app/api/router-proposals/_view');
    const { createStagedStore } = await import('@/lib/router/storage/staged-store');
    const before = JSON.stringify(await byId(secondDashboardId));
    const staged = await seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'rename', title: 'ชื่อที่ผู้รับเห็น', baseRevision: await revisionOf(secondDashboardId) });
    expect(staged.outcome).toBe('staged');
    if (staged.outcome !== 'staged') return;
    expect(JSON.stringify(await byId(secondDashboardId))).toBe(before);
    const row = await createStagedStore(seeded.store).get(actor, staged.proposalId);
    expect(row).toMatchObject({ actionId: 'dashboard.rename', status: 'pending', conversationId: `ui:dashboard:${actor.id}`, mode: actor.mode });
    expect(row?.turnId).toMatch(/^ui_/);
    expect(row?.data.baseRevision).toBeTruthy();
    expect((await listPendingProposals(seeded.store, actor, SEED_NOW.getTime())).find(p => p.id === staged.proposalId)).toMatchObject({ confirmable: true, actionId: 'dashboard.rename' });
    // Another actor can neither see nor confirm it.
    expect((await listPendingProposals(seeded.store, seeded.actors.east, SEED_NOW.getTime())).some(p => p.id === staged.proposalId)).toBe(false);
    await expect(seeded.service.confirmStagedProposal(seeded.actors.east, staged.proposalId)).rejects.toMatchObject({ status: 404 });
    expect((await byId(secondDashboardId)).spec.title).not.toBe('ชื่อที่ผู้รับเห็น');
    const done = await seeded.service.confirmStagedProposal(actor, staged.proposalId);
    expect(done.outcome).toBe('executed');
    expect((await byId(secondDashboardId)).spec.title).toBe('ชื่อที่ผู้รับเห็น');
    // Recipients read this same stored spec (the synthetic share row has no approval provenance, so the recipient read path is covered by the share tests).
    // Idempotent retry returns the stored result.
    expect((await seeded.service.confirmStagedProposal(actor, staged.proposalId)).outcome).toBe('executed');
  });

  it('Shared UI edit: widget edits and Add Result stage a spec proposal; a stale base revision conflicts; cancel leaves nothing; a forged origin is never confirmable', async () => {
    const actor = seeded.actors.executive;
    const { cancelProposal } = await import('@/app/api/router-proposals/_view');
    const { createStagedStore } = await import('@/lib/router/storage/staged-store');
    const base = await revisionOf(secondDashboardId);
    const widgetsBefore = (await byId(secondDashboardId)).spec.widgets.length;
    const a = await seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'widgets', baseRevision: base, change: { op: 'retitle', index: 0, title: 'หัวข้อใหม่ A' } });
    const b = await seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'add_result', baseRevision: base, artifactId });
    if (a.outcome !== 'staged' || b.outcome !== 'staged') throw new Error('expected staged');
    expect(a.proposalId).not.toBe(b.proposalId);
    expect((await byId(secondDashboardId)).spec.widgets).toHaveLength(widgetsBefore);
    // First confirm wins; the second was bound to the old revision and fails closed without writing.
    expect((await seeded.service.confirmStagedProposal(actor, a.proposalId)).outcome).toBe('executed');
    expect((await byId(secondDashboardId)).spec.widgets[0].title).toBe('หัวข้อใหม่ A');
    expect(await seeded.service.confirmStagedProposal(actor, b.proposalId)).toMatchObject({ outcome: 'denied', code: 'dashboard_changed' });
    expect((await byId(secondDashboardId)).spec.widgets).toHaveLength(widgetsBefore);
    // A stale base revision is refused at stage time (never staged).
    await expect(seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'rename', title: 'x', baseRevision: base })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
    // Add Result on the fresh revision, then cancel: nothing is written and it cannot be confirmed any more.
    const c = await seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'add_result', baseRevision: await revisionOf(secondDashboardId), artifactId });
    if (c.outcome !== 'staged') throw new Error('expected staged');
    expect(await cancelProposal(seeded.store, actor, c.proposalId)).toMatchObject({ status: 'cancelled' });
    expect(await seeded.service.confirmStagedProposal(actor, c.proposalId)).toMatchObject({ outcome: 'denied', code: 'not_pending' });
    expect((await byId(secondDashboardId)).spec.widgets).toHaveLength(widgetsBefore);
    // Add Result confirmed: the shared Dashboard gains the dynamic widget.
    const d = await seeded.service.editDashboardUi(actor, secondDashboardId, { kind: 'add_result', baseRevision: await revisionOf(secondDashboardId), artifactId });
    if (d.outcome !== 'staged') throw new Error('expected staged');
    expect((await seeded.service.confirmStagedProposal(actor, d.proposalId)).outcome).toBe('executed');
    expect((await byId(secondDashboardId)).spec.widgets).toHaveLength(widgetsBefore + 1);
    // Forged origin: a UI-shaped row without the server-written origin (or from a chat-like conversation) keeps the completed-turn proof and is refused.
    const staging = createStagedStore(seeded.store);
    const forge = (conversationId: string, turnId: string, data: Record<string, unknown>) => staging.create(actor, { conversationId, turnId }, { actionId: 'dashboard.rename', digest: `forged-${turnId}`, preview: 'forged',
      data: { params: { dashboardId: secondDashboardId, title: 'ปลอม' }, ...data }, expiresAt: Date.now() + 3_600_000 });
    for (const row of [await forge(`ui:dashboard:${actor.id}`, 'ui_forged1', {}), await forge('conversation_x', 'ui_forged2', { origin: { kind: 'ui_dashboard', ref: 'ui_forged2' } }),
      await forge(`ui:dashboard:${actor.id}`, 'ui_forged3', { origin: { kind: 'ui_dashboard', ref: 'someone_else' } })]) {
      expect(await seeded.service.confirmStagedProposal(actor, row.id), row.turnId).toMatchObject({ outcome: 'denied', code: 'turn_not_completed' });
    }
    expect((await byId(secondDashboardId)).spec.title).not.toBe('ปลอม');
  });

  it('Replace widget: the family changes through the same server function; unsuitable families and Map/Sankey fail closed; CAS holds', async () => {
    const actor = seeded.actors.executive;
    const dashboard = await byId(dashboardId);
    const index = dashboard.spec.widgets.findIndex(w => w.type === 'viz' && w.kind === 'table');
    expect(index).toBeGreaterThanOrEqual(0);
    const base = await revisionOf(dashboardId);
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: base, change: { op: 'change_family', index, kind: 'map' } })).rejects.toBeTruthy();
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: base, change: { op: 'change_family', index, kind: 'sankey' } })).rejects.toBeTruthy();
    expect(await revisionOf(dashboardId)).toBe(base);
    // A single-measure widget cannot become a scatter (needs two measures): refused with an explanation, nothing written.
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: base, change: { op: 'change_family', index, kind: 'scatter' } })).rejects.toMatchObject({ code: 'WIDGET_UNSUITABLE' });
    expect(await revisionOf(dashboardId)).toBe(base);
    await seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: base, change: { op: 'change_family', index, kind: 'bar' } });
    const next = (await byId(dashboardId)).spec.widgets[index];
    expect(next).toMatchObject({ type: 'viz', kind: 'bar' });
    // Binding is the widget's own (never edited) and it still draws from CURRENT evidence.
    expect((next as { binding: unknown }).binding).toEqual((dashboard.spec.widgets[index] as { binding: unknown }).binding);
    const opened = await seeded.service.dashboard(actor, dashboardId);
    expect(opened.vizData!.find(r => r.index === index)?.status).toBe('ready');
    await expect(seeded.service.editDashboardWidgets(actor, dashboardId, { baseRevision: base, change: { op: 'change_family', index, kind: 'table' } })).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
  });

  it('Interop: archived Results are not advertised to the planner as active references', async () => {
    const actor = seeded.actors.executive;
    const { archivedArtifactIds } = await import('@/lib/artifacts/library');
    await seeded.service.updateResult(actor, artifactId, { op: 'archive' });
    expect([...await archivedArtifactIds(seeded.store, actor.id)]).toEqual([artifactId]);
    await seeded.service.updateResult(actor, artifactId, { op: 'unarchive' });
    expect([...await archivedArtifactIds(seeded.store, actor.id)]).toEqual([]);
  });

  it('AI parity: result.manage / result.unarchive run the SAME library functions through the router (direct tier), addressed by server context id', async () => {
    const actor = seeded.actors.executive;
    const item = async () => (await seeded.service.resultsLibrary(actor)).find(i => i.id === artifactId)!;
    const say = (message: string) => seeded.service.turn(actor, message, conversationId);
    const versionRow = async () => JSON.stringify(await seeded.store.get('tool_executions', 'artifact-version:' + artifactId + ':1'));
    const evidence = await versionRow();
    const renamed = await say('Rename my latest result to East weekly view.');
    expect(renamed.clarification, renamed.message).toBeUndefined();
    expect(await item()).toMatchObject({ title: 'East weekly view', renamed: true });
    expect(await versionRow()).toBe(evidence);
    await say('Pin my latest result.');
    expect(await item()).toMatchObject({ pinned: true });
    await say('Unpin my latest result.');
    expect(await item()).toMatchObject({ pinned: false });
    const saved = await say('Save my latest result.');
    expect(saved.message).toContain('บันทึก');
    await say('Archive my latest result.');
    expect(await item()).toMatchObject({ archived: true, section: 'archived' });
    // Archived Results are not active references: the planner has no ARTIFACTS entry, so nothing is pinned.
    await say('Pin my latest result.');
    expect(await item()).toMatchObject({ pinned: false, archived: true });
    await say('Restore my archived result.');
    expect(await item()).toMatchObject({ archived: false });
    expect(await versionRow()).toBe(evidence);
    // Another actor cannot address it by id (not in their context), and the library functions refuse it.
    await expect(seeded.service.updateResult(seeded.actors.east, artifactId, { op: 'pin' })).rejects.toMatchObject({ status: 404 });
  });
});
