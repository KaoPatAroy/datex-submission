import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS, SCRIPTED_RANKING_FIVE_PROMPT } from '@/lib/router/planner/scripted';
import { specRevision } from '@/lib/router/executors/action-ports';
import { createSeededService } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const owned = async () => (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive');

describe('PC-06: Result -> Dashboard keeps every measure and the ranking, never silently', { timeout: 180_000 }, () => {
  let artifactId: string;
  let dashboardId: string;
  it('a five-measure top-3 ranking becomes five widgets, each showing exactly the three ranked rows with the Result values', async () => {
    const actor = seeded.actors.executive;
    const first = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    dashboardId = (await owned())[0].id;
    const answer = await seeded.service.turn(actor, SCRIPTED_RANKING_FIVE_PROMPT, first.conversationId);
    expect(answer.clarification, answer.message).toBeUndefined();
    artifactId = (await seeded.service.resultsLibrary(actor)).find(item => item.kind === 'ranking')!.id;
    const source = await seeded.service.openArtifact(actor, artifactId);
    const resultFacts = source.spec.facts ?? [];
    const resultMeasures = [...new Set(resultFacts.map(f => f.measure))];
    expect(resultMeasures).toHaveLength(5);
    const before = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!.spec.widgets.length; // 7 widgets; 5 more fit exactly
    await seeded.service.addResultToDashboard(actor, dashboardId, { baseRevision: specRevision((await seeded.store.get<Dashboard>('dashboards', dashboardId))!.spec), artifactId });
    const dashboard = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!;
    expect(dashboard.spec.widgets).toHaveLength(before + 5);
    const added = dashboard.spec.widgets.slice(before);
    expect(added.map(w => (w as { measure: string }).measure).sort()).toEqual([...resultMeasures].sort());
    const view = await seeded.service.dashboard(actor, dashboardId);
    for (const [offset, widget] of added.entries()) {
      const result = view.vizData!.find(r => r.index === before + offset)!;
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') continue;
      const measure = (widget as { measure: string }).measure;
      const expected = resultFacts.filter(f => f.measure === measure && f.operation !== 'rank');
      expect(result.data.points).toHaveLength(expected.length);
      expect(result.data.points.map(p => p.value).sort((a, b) => Number(a) - Number(b))).toEqual(expected.map(f => f.value).sort((a, b) => Number(a) - Number(b)));
      expect(result.data.topN).toBe(3);
      expect(result.data.shown).toBe(3);
    }
  });

  it('a Dashboard without room is refused BEFORE anything is written (no silent partial conversion)', async () => {
    const actor = seeded.actors.executive;
    const before = JSON.stringify(await seeded.store.get<Dashboard>('dashboards', dashboardId));
    await expect(seeded.service.addResultToDashboard(actor, dashboardId, { baseRevision: specRevision((await seeded.store.get<Dashboard>('dashboards', dashboardId))!.spec), artifactId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(JSON.stringify(await seeded.store.get<Dashboard>('dashboards', dashboardId))).toBe(before);
  });

  it('family widgets apply sort/top-N to the marks AND the data rows (top 3 of four branches, ranked)', async () => {
    const actor = seeded.actors.executive;
    const dashboard = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!;
    const index = dashboard.spec.widgets.findIndex(w => w.type === 'viz' && w.kind === 'combo');
    const widgets = dashboard.spec.widgets.map((w, i) => i === index ? { ...w, sort: 'desc' as const, topN: 3 } : w);
    await seeded.store.transaction(async tx => { await tx.put('dashboards', { ...dashboard, spec: { ...dashboard.spec, widgets } }); });
    const view = await seeded.service.dashboard(actor, dashboardId);
    const result = view.vizData!.find(r => r.index === index)!;
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const netSales = (result.data.facts ?? []).filter(f => f.measure === 'net_sales');
    expect(netSales).toHaveLength(3);
    expect(netSales.map(f => f.value)).toEqual([...netSales.map(f => f.value)].sort((a, b) => Number(b) - Number(a)));
    const categories = new Set((result.data.chart?.points ?? []).map(p => p.category));
    expect(categories.size).toBe(3);
    expect(result.data.total).toBeGreaterThan(result.data.shown);
    expect(result.data.topN).toBe(3);
  });
});
