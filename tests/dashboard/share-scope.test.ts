import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard, Profile } from '@/lib/contracts';
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

const setRegions = async (id: string, regions: string[]) => seeded.store.transaction(async tx => {
  const profile = (await tx.get<Profile>('profiles', id))!; await tx.put('profiles', { ...profile, regions });
});

describe('PC-01: approved share scope bounds every dynamic widget', { timeout: 120_000 }, () => {
  let aId: string;
  let bId: string;
  it('add/edit: a widget whose query is wider than the Dashboard scope is refused and nothing is written', async () => {
    const owner = seeded.actors.executive;
    await seeded.service.turn(owner, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]); // East E01-E04
    await seeded.service.turn(owner, 'Build a dashboard of low stock by branch.'); // all regions
    const all = await seeded.store.list<Dashboard>('dashboards');
    aId = all.find(d => d.spec.scope.region === 'east')!.id;
    bId = all.find(d => d.spec.scope.region === 'all')!.id;
    const a = (await seeded.store.get<Dashboard>('dashboards', aId))!;
    const b = (await seeded.store.get<Dashboard>('dashboards', bId))!;
    const wide = b.spec.widgets[0];
    await expect(seeded.service.updateDashboardSpec(owner, aId, { ...a.spec, widgets: [...a.spec.widgets.slice(0, 11), wide] }))
      .rejects.toMatchObject({ code: 'WIDGET_SCOPE_MISMATCH' });
    expect((await seeded.store.get<Dashboard>('dashboards', aId))!.spec).toEqual(a.spec);
    // A widget that stays inside the header scope is still accepted (same query, same scope).
    await seeded.service.updateDashboardSpec(owner, aId, { ...a.spec, widgets: [...a.spec.widgets] });
  });

  it('open: an approved E01-E04 share never shows a widget that reads beyond the approval, even when the recipient authority widens', async () => {
    const owner = seeded.actors.executive;
    const action = await seeded.service.prepare(owner, { kind: 'dashboard_share', dashboardId: aId, recipientId: 'east' });
    expect(JSON.stringify(await seeded.service.confirm(owner, action.id))).toContain('verified_success');
    const a = (await seeded.store.get<Dashboard>('dashboards', aId))!;
    const b = (await seeded.store.get<Dashboard>('dashboards', bId))!;
    // Simulate stored data that already carries a wider widget (legacy / pre-fix append): the recipient open must still bound it.
    await seeded.store.transaction(async tx => { await tx.put('dashboards', { ...a, spec: { ...a.spec, widgets: [...a.spec.widgets, b.spec.widgets[0]] } }); });
    const regions = [...new Set((await seeded.store.list<{ region: string }>('branches')).map(branch => branch.region))];
    await setRegions('east', regions);
    const view = await seeded.service.dashboard(seeded.actors.east, aId);
    const last = view.vizData!.find(r => r.index === a.spec.widgets.length)!;
    expect(last.status).toBe('denied');
    expect((last as { code?: string }).code).toBe('scope_ceiling');
    expect(JSON.stringify(last)).not.toMatch(/C0[1-4]|S0[1-4]/);
    // Widgets inside the approval still draw, and only approved branches appear in them.
    const ready = view.vizData!.filter(r => r.status === 'ready');
    expect(ready.length).toBe(a.spec.widgets.length);
    expect(JSON.stringify(ready)).not.toMatch(/"(label|category|key)":"[CS]0[1-4]"/);
    // The owner's own view of their Dashboard is not bounded by a share ceiling.
    const own = await seeded.service.dashboard(owner, aId);
    expect(own.vizData!.find(r => r.index === a.spec.widgets.length)!.status).toBe('ready');
    await setRegions('east', ['east']);
  });
});
