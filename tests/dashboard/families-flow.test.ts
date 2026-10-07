import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { VIZ_WIDGET_KINDS, vizWidgetSchema } from '@/lib/contracts';
import { INTERACTION_IDS, ANIMATION_MODES } from '@/lib/visualization/contracts';
import { dashboardVisualizationPlanSchema } from '@/lib/visualization/dashboard-data';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { createSeededService } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;

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

const dashboardsOf = async (): Promise<Dashboard[]> => (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive');

describe('Dashboard chart families (scripted plans through the real router)', { timeout: 120_000 }, () => {
  it('the widget schema mirrors the registered interaction/animation ids and lists exactly the 11 families', () => {
    expect([...VIZ_WIDGET_KINDS].sort()).toEqual(['area', 'bar', 'combo', 'donut', 'heatmap', 'kpi', 'line', 'pie', 'scatter', 'table', 'treemap']);
    const shape = vizWidgetSchema.shape;
    expect(shape.interactions.unwrap().element.options).toEqual([...INTERACTION_IDS]);
    expect(shape.animation.unwrap().options).toEqual([...ANIMATION_MODES]);
  });

  it('Map and Sankey fail closed at the plan', () => {
    const widget = (kind: string) => ({ kind, title: 't', measure: 'net_sales', dimension: 'branch', sort: null, topN: null });
    for (const kind of ['map', 'sankey']) {
      expect(dashboardVisualizationPlanSchema.safeParse({ version: 1, title: 't', description: '', widgets: [widget(kind)] }).success).toBe(false);
    }
    expect(dashboardVisualizationPlanSchema.safeParse({ version: 1, title: 't', description: '', widgets: [widget('pie')] }).success).toBe(true);
  });

  it('three turns build one Dashboard with all 11 families; each re-reads ready under the viewer; reload keeps the same families', async () => {
    const actor = seeded.actors.executive;
    const [first, trend, kpi] = SCRIPTED_DASHBOARD_FAMILY_PROMPTS;
    const one = await seeded.service.turn(actor, first);
    expect(one.clarification, one.message).toBeUndefined();
    let dashboards = await dashboardsOf();
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].spec.widgets.map(w => w.type === 'viz' ? w.kind : w.type)).toEqual(['table', 'bar', 'scatter', 'pie', 'donut', 'treemap', 'combo']);

    const two = await seeded.service.turn(actor, trend, one.conversationId);
    expect(two.clarification, two.message).toBeUndefined();
    const three = await seeded.service.turn(actor, kpi, one.conversationId);
    expect(three.clarification, three.message).toBeUndefined();
    dashboards = await dashboardsOf();
    expect(dashboards).toHaveLength(1);
    const kinds = dashboards[0].spec.widgets.map(w => w.type === 'viz' ? w.kind : w.type);
    expect(new Set(kinds)).toEqual(new Set(VIZ_WIDGET_KINDS));

    const opened = await seeded.service.dashboard(actor, dashboards[0].id);
    expect(opened.vizData).toHaveLength(11);
    expect(opened.vizData!.map(r => r.status), JSON.stringify(opened.vizData!.filter(r => r.status !== 'ready'))).toEqual(Array(11).fill('ready'));
    const primitives = opened.vizData!.flatMap(r => r.status === 'ready' && r.data.chart ? [r.data.chart.primitive] : []);
    expect(new Set(primitives)).toEqual(new Set(['line', 'area', 'scatter', 'heatmap', 'pie', 'donut', 'treemap', 'combo']));
    // Reload: a second open recompiles the identical families.
    const again = await seeded.service.dashboard(actor, dashboards[0].id);
    expect(again.vizData!.map(r => r.status === 'ready' ? r.data.kind : r.status)).toEqual(opened.vizData!.map(r => r.status === 'ready' ? r.data.kind : r.status));
    // Persisted widgets are declarative configuration only: no chart code, markup, rows or computed values.
    expect(JSON.stringify(dashboards[0].spec)).not.toMatch(/<svg|<script|dangerouslySetInnerHTML|"points"|"facts"/);
  });

  it('a viewer without current authority is denied on open (fail closed)', async () => {
    const actor = seeded.actors.executive;
    const [dashboard] = await dashboardsOf();
    const profile = await seeded.store.get<{ id: string; permissions: string[] } & Record<string, unknown>>('profiles', 'executive');
    await seeded.store.transaction(async tx => { await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'sales.read') }); });
    await expect(seeded.service.dashboard(actor, dashboard.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await seeded.store.transaction(async tx => { await tx.put('profiles', profile!); });
  });
});
