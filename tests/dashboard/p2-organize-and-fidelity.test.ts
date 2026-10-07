import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { specRevision } from '@/lib/router/executors/action-ports';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { vizDataToChartSpec } from '@/lib/visualization/dashboard-data';
import { deriveResultWidgets } from '@/lib/artifacts/dashboard-widget';
import { createSeededService } from '../helpers/seeded-service';

// Test hook: lets one test hand deriveResultWidgets a stored Result whose visual is a metric (the scripted planner has no metric fixture).
type Loaded = { visual: { visualization: Record<string, unknown> }; artifact: { graph: { claims: { measure: string }[] } } } & Record<string, unknown>;
const hook = vi.hoisted(() => ({ override: null as null | ((loaded: Loaded) => Loaded) }));
vi.mock('@/lib/artifacts/store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/artifacts/store')>();
  return { ...actual, loadStoredArtifact: async (...args: Parameters<typeof actual.loadStoredArtifact>) => { const loaded = await actual.loadStoredArtifact(...args); return hook.override ? hook.override(loaded as unknown as Loaded) : loaded; } };
});

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
let dashboardId: string;
let artifactId: string;
const DRILL_BAR = 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.';
const byId = async (id: string) => (await seeded.store.get<Dashboard>('dashboards', id))!;

beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
  const actor = seeded.actors.executive;
  const first = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
  dashboardId = (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive')[0].id;
  const answer = await seeded.service.turn(actor, DRILL_BAR, first.conversationId);
  expect(answer.clarification, answer.message).toBeUndefined();
  artifactId = (await seeded.service.resultsLibrary(actor)).find(item => item.kind === 'chart')!.id;
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

describe('P2-1: Dashboard pin / archive / restore / duplicate (owner-only, direct)', { timeout: 120_000 }, () => {
  it('pin, unpin, archive and restore persist and never touch the widgets, their revision or updatedAt', async () => {
    const actor = seeded.actors.executive;
    const before = await byId(dashboardId);
    const revision = specRevision(before.spec);
    expect((await seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' })).pinnedAt).toBeTruthy();
    expect((await byId(dashboardId)).pinnedAt).toBeTruthy();
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' }); // idempotent
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'unpin' });
    expect((await byId(dashboardId)).pinnedAt).toBeUndefined();
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' });
    // Archiving hides the pin (an archived Dashboard cannot be pinned), and restoring brings it back as a normal, unpinned-or-pinned entry.
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'archive' });
    expect((await byId(dashboardId)).archivedAt).toBeTruthy();
    await expect(seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // An archived Dashboard still opens (shares, receipts and lineage keep working).
    expect((await seeded.service.dashboard(actor, dashboardId, { vizData: false })).dashboard.archivedAt).toBeTruthy();
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'restore' });
    const after = await byId(dashboardId);
    expect(after.archivedAt).toBeUndefined();
    expect(specRevision(after.spec)).toBe(revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.spec).toEqual(before.spec);
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'unpin' });
  });

  it('an archived Dashboard is not the default "latest" and the workspace still lists it with its archive flag', async () => {
    const actor = seeded.actors.executive;
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'archive' });
    const listed = (await seeded.service.getWorkspace(actor)).dashboards.find(d => d.id === dashboardId);
    expect(listed?.archivedAt).toBeTruthy();
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'restore' });
    expect((await seeded.service.getWorkspace(actor)).dashboards.find(d => d.id === dashboardId)?.archivedAt).toBeUndefined();
  });

  it('duplicate makes a NEW private Dashboard with the same declarative widgets, without pin, archive or shares', async () => {
    const actor = seeded.actors.executive;
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' });
    const source = await byId(dashboardId);
    const copy = await seeded.service.organizeDashboard(actor, dashboardId, { op: 'duplicate' });
    expect(copy.dashboardId).not.toBe(dashboardId);
    const duplicated = await byId(copy.dashboardId);
    expect(duplicated).toMatchObject({ ownerId: 'executive' });
    expect(duplicated.pinnedAt).toBeUndefined();
    expect(duplicated.archivedAt).toBeUndefined();
    expect(duplicated.spec.title).toBe(`สำเนา — ${source.spec.title}`);
    expect(duplicated.spec.widgets).toEqual(source.spec.widgets);
    // Same widgets, still dynamic: the copy re-queries under the viewer on open.
    const view = await seeded.service.dashboard(actor, copy.dashboardId);
    expect(view.vizData?.every(result => result.status === 'ready')).toBe(true);
    expect((await byId(dashboardId)).spec).toEqual(source.spec); // the source is untouched
    await seeded.service.organizeDashboard(actor, dashboardId, { op: 'unpin' });
  });

  it("another actor cannot organize, duplicate or archive someone else's Dashboard, and an unknown id is 404", async () => {
    const east = seeded.actors.east;
    for (const op of ['pin', 'archive', 'duplicate'] as const) await expect(seeded.service.organizeDashboard(east, dashboardId, { op })).rejects.toMatchObject({ status: 404 });
    await expect(seeded.service.organizeDashboard(seeded.actors.executive, 'missing', { op: 'pin' })).rejects.toMatchObject({ status: 404 });
    await expect(seeded.service.organizeDashboard(seeded.actors.executive, dashboardId, { op: 'delete' as never })).rejects.toBeTruthy();
  });

  it('a deleted Dashboard cannot be organized', async () => {
    const actor = seeded.actors.executive;
    const copy = await seeded.service.organizeDashboard(actor, dashboardId, { op: 'duplicate' });
    await seeded.service.deleteDashboard(actor, copy.dashboardId);
    await expect(seeded.service.organizeDashboard(actor, copy.dashboardId, { op: 'pin' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('P2-3: a single-series Bar/Line Result keeps its interaction and animation fields on the Dashboard', { timeout: 120_000 }, () => {
  it("the widget stores the Result's registered interaction ids (minus drilldown) and animation, and the rendered spec carries them", async () => {
    const actor = seeded.actors.executive;
    const derived = await deriveResultWidgets(seeded.store, actor, { artifactId });
    expect(derived.outcome).toBe('ok');
    if (derived.outcome !== 'ok') return;
    const widget = derived.widgets[0];
    expect(widget.kind).toBe('bar');
    expect(widget.measures).toBeUndefined(); // single series
    expect(widget.animation).toBe('reorder');
    expect(widget.interactions).toEqual(expect.arrayContaining(['inspect_data', 'tooltip', 'select_point', 'cross_filter']));
    expect(widget.interactions).not.toContain('drilldown');

    const base = specRevision((await byId(dashboardId)).spec);
    await seeded.service.addResultToDashboard(actor, dashboardId, { baseRevision: base, artifactId });
    const dashboard = await byId(dashboardId);
    const view = await seeded.service.dashboard(actor, dashboardId);
    const index = dashboard.spec.widgets.length - 1;
    const result = view.vizData!.find(r => r.index === index)!;
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const spec = result.data.chart ?? vizDataToChartSpec(result.data);
    expect(spec?.animation.modeId).toBe('reorder');
    expect(spec?.interaction.interactionIds).toEqual(expect.arrayContaining(['tooltip', 'cross_filter']));
  });
});

describe('P2-2: a compatible Metric Result keeps its KPI widget; otherwise the conversion is disclosed', { timeout: 120_000 }, () => {
  const asMetric = (keepOneClaim: boolean) => (loaded: Loaded): Loaded => ({
    ...loaded,
    visual: { ...loaded.visual, visualization: { ...loaded.visual.visualization, primitiveId: 'metric' } },
    artifact: keepOneClaim ? { ...loaded.artifact, graph: { ...loaded.artifact.graph, claims: loaded.artifact.graph.claims.filter(c => c.measure === 'net_sales').slice(0, 1) } } : loaded.artifact,
  });
  it('a metric that is one verified value becomes a KPI widget (no conversion note)', async () => {
    hook.override = asMetric(true);
    try {
      const derived = await deriveResultWidgets(seeded.store, seeded.actors.executive, { artifactId });
      expect(derived.outcome).toBe('ok');
      if (derived.outcome !== 'ok') return;
      expect(derived.widgets.map(w => w.kind)).toEqual(['kpi']);
      expect(derived.widgets[0].dimension).toBeUndefined();
      expect(derived.note).toBeUndefined();
    } finally { hook.override = null; }
  });
  it('a metric over several values stays an exact table and says so', async () => {
    hook.override = asMetric(false);
    try {
      const derived = await deriveResultWidgets(seeded.store, seeded.actors.executive, { artifactId });
      expect(derived.outcome).toBe('ok');
      if (derived.outcome !== 'ok') return;
      expect(derived.widgets.map(w => w.kind)).toEqual(['table']);
      expect(derived.note).toMatch(/ตาราง/);
    } finally { hook.override = null; }
  });
});
