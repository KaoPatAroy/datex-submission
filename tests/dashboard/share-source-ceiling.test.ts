import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { approvedShareSourceIds, bundleWithinCeiling } from '@/lib/router/executors/dashboard-widgets';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { createSeededService } from '../helpers/seeded-service';

const DATE = '2026-10-01';
const ceiling = { region: 'east', date: DATE, branchIds: ['E01'], sourceIds: [`sales:E01:${DATE}`, `targets:E01:${DATE}`, `inventory:E01:${DATE}`] };
const bundle = (sourceId: string, date = DATE) => ({
  scope: { regions: ['east'], branchIds: ['E01'] }, provenance: { dates: [date] }, sources: [{ id: sourceId }],
  rows: [{ branchId: 'E01', region: 'east', date, sourceRefs: [sourceId] }],
});

describe('PC-01: the approved share ceiling binds the source set and the exact date', () => {
  it('a widget citing a source outside the approved source set is outside the ceiling', () => {
    expect(bundleWithinCeiling(bundle(`sales:E01:${DATE}`), ceiling)).toBe(true);
    expect(bundleWithinCeiling(bundle(`tickets:E01:${DATE}`), ceiling)).toBe(false);
    expect(bundleWithinCeiling({ ...bundle(`sales:E01:${DATE}`), rows: [{ branchId: 'E01', region: 'east', date: DATE, sourceRefs: [`staffing:E01:${DATE}`] }] }, ceiling)).toBe(false);
  });
  it('an earlier date is outside an approved share ceiling (the Dashboard header ceiling keeps its history window)', () => {
    expect(bundleWithinCeiling(bundle(`sales:E01:2026-09-30`, '2026-09-30'), ceiling)).toBe(false);
    expect(bundleWithinCeiling(bundle(`sales:E01:2026-09-30`, '2026-09-30'), { region: 'east', date: DATE, branchIds: ['E01'] })).toBe(true);
  });
  it('the approved source set is the header sources of approved branches at the exact approved date', () => {
    expect(approvedShareSourceIds({ date: DATE, branchIds: ['E01'] }, [`sales:E01:${DATE}`, `sales:E02:${DATE}`, `sales:E01:2026-09-30`, 'bogus', `tickets:E01:${DATE}`]))
      .toEqual([`sales:E01:${DATE}`, `tickets:E01:${DATE}`]);
    expect(approvedShareSourceIds({ date: DATE }, [`sales:E01:${DATE}`])).toEqual([]);
  });
});

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

describe('PC-01: a shared Dashboard never widens past its approved source/date ceiling', { timeout: 120_000 }, () => {
  it('earlier-date widget: refused at write while shared, and denied at open for a recipient authorized for both dates', async () => {
    const owner = seeded.actors.executive;
    await seeded.service.turn(owner, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]); // East E01-E04, 2026-10-01
    const dashboardId = (await seeded.store.list<Dashboard>('dashboards')).find(d => d.ownerId === owner.id && d.spec.scope.region === 'east')!.id;
    const base = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!;
    // Private, unshared: a 3-day trend (earlier dates inside the header window) is still allowed.
    await seeded.service.turn(owner, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[1]);
    const withTrend = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!;
    const known = new Set(base.spec.widgets.map(widget => JSON.stringify(widget)));
    const trend = withTrend.spec.widgets.filter(widget => !known.has(JSON.stringify(widget)));
    expect(trend.length).toBeGreaterThan(0);
    expect(trend.some(widget => widget.type === 'viz' && (widget.binding.query as { time?: { dates?: string[] } }).time?.dates?.some(date => date < DATE))).toBe(true);
    await seeded.service.updateDashboardSpec(owner, dashboardId, base.spec);

    const action = await seeded.service.prepare(owner, { kind: 'dashboard_share', dashboardId, recipientId: 'east' });
    expect(JSON.stringify(await seeded.service.confirm(owner, action.id))).toContain('verified_success');

    // Write: even with the owner's confirmation guard, a widget reading earlier dates widens the approved share and is refused.
    const shared = (await seeded.store.get<Dashboard>('dashboards', dashboardId))!;
    await expect(seeded.service.updateDashboardSpec(owner, dashboardId, { ...shared.spec, widgets: [...shared.spec.widgets, ...trend] }, { allowShared: true }))
      .rejects.toMatchObject({ code: 'WIDGET_SCOPE_MISMATCH' });
    expect((await seeded.store.get<Dashboard>('dashboards', dashboardId))!.spec).toEqual(shared.spec);
    // Re-saving the approved widgets is not a widening.
    await seeded.service.updateDashboardSpec(owner, dashboardId, shared.spec, { allowShared: true });

    // Open: a stored (legacy) earlier-date widget is denied for the recipient, who is authorized for every East date.
    await seeded.store.transaction(async tx => { await tx.put('dashboards', { ...shared, spec: { ...shared.spec, widgets: [...shared.spec.widgets, ...trend] } }); });
    const view = await seeded.service.dashboard(seeded.actors.east, dashboardId);
    const added = view.vizData!.filter(result => result.index >= shared.spec.widgets.length);
    expect(added.length).toBe(trend.length);
    expect(added.every(result => result.status === 'denied' && (result as { code?: string }).code === 'scope_ceiling')).toBe(true);
    expect(JSON.stringify(added)).not.toContain('2026-09-');
    expect(view.vizData!.filter(result => result.index < shared.spec.widgets.length).every(result => result.status === 'ready')).toBe(true);
    // The owner's own view is not bounded by a share ceiling.
    const own = await seeded.service.dashboard(owner, dashboardId);
    expect(own.vizData!.filter(result => result.index >= shared.spec.widgets.length).every(result => result.status === 'ready')).toBe(true);
  });
});
