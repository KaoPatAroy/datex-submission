import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import { dashboardSpecSchema, type Branch } from '@/lib/contracts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { executeDashboardVizWidgets } from '@/lib/router/executors/dashboard-widgets';
import { executeQueryStep } from '@/lib/router/executors/query';
import { buildDashboardSpecFromPlan, type DashboardEvidence } from '@/lib/visualization/dashboard-spec';
import { vizDataToChartSpec } from '@/lib/visualization';
import { proposal } from '../../dynamic/fixtures';
import { actors, base, BUSINESS_DATE, FIXED_NOW, read, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

const message = 'Show sales';
async function evidence(): Promise<DashboardEvidence> {
  const result = await executeQueryStep({ ...base(fixture, actors.executive, message), read, step: { kind: 'query', continuation: false, plan: proposal(message) } });
  if (result.outcome !== 'accepted') throw new Error('expected accepted query');
  return { plan: result.plan, bundle: result.bundle, claims: result.claims, message };
}
const catalog = async () => createSemanticCatalog(await fixture.store.list<Branch>('branches'));
const plan = (widgets: unknown[] = [{ kind: 'bar', title: 'ยอดขายรายสาขา', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: null }]) =>
  ({ version: 1, title: 'Dashboard ยอดขาย', description: 'สร้างจากคำถามยอดขาย', widgets });

describe('dashboard spec from VisualizationPlan', () => {
  it('binds each widget to the evidence digest and yields a legacy-schema-valid spec with sorted, evidence-only values', async () => {
    const ev = await evidence();
    const result = buildDashboardSpecFromPlan(plan([
      { kind: 'bar', title: 'ยอดขายรายสาขา', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: 2 },
      { kind: 'table', title: 'ตารางยอดขาย', measure: 'net_sales', dimension: 'branch', sort: null, topN: null },
    ]), ev, await catalog(), actors.executive);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(dashboardSpecSchema.safeParse(result.spec).success).toBe(true);
    const viz = result.spec.widgets.filter(w => w.type === 'viz');
    expect(viz.every(w => w.binding.evidenceDigest === ev.bundle.ref.digest && w.binding.claimGraphDigest === ev.claims.digest)).toBe(true);
    const values = result.widgets[0].points.map(p => p.value);
    expect(values).toEqual([...values].sort((a, b) => (b as number) - (a as number)));
    expect(result.widgets[0].shown).toBe(2);
    const claimValues = new Set(ev.claims.claims.map(c => c.value));
    expect(values.every(v => claimValues.has(v))).toBe(true);
    expect(vizDataToChartSpec(result.widgets[0])?.primitive).toBe('bar');
  });

  it('rejects unknown measures/dimensions, ungrouped KPIs over a grouped result, unsafe text and a missing permission', async () => {
    const ev = await evidence(), cat = await catalog();
    const code = (p: unknown, actor = actors.executive) => { const r = buildDashboardSpecFromPlan(p, ev, cat, actor); return r.outcome === 'rejected' ? r.code : 'accepted'; };
    expect(code(plan([{ kind: 'bar', title: 't', measure: 'salary', dimension: 'branch', sort: null, topN: null }]))).toBe('unknown_measure');
    expect(code(plan([{ kind: 'bar', title: 't', measure: 'net_sales', dimension: 'employee', sort: null, topN: null }]))).toBe('unknown_dimension');
    expect(code(plan([{ kind: 'kpi', title: 't', measure: 'net_sales', dimension: null, sort: null, topN: null }]))).toBe('widget_unavailable');
    expect(code(plan([{ kind: 'line', title: 't', measure: 'net_sales', dimension: 'branch', sort: null, topN: null }]))).toBe('widget_unavailable');
    expect(code({ ...plan(), title: 'bad\u0007title' })).toBe('unsafe_text');
    expect(code({ version: 1, title: 'x', description: '', widgets: [] })).toBe('invalid_plan');
    expect(code(plan(), { ...actors.executive, permissions: actors.executive.permissions.filter(p => p !== 'dashboard.create') })).toBe('permission_denied');
    expect(buildDashboardSpecFromPlan(plan(), { ...ev, message: '' }, cat, actors.executive).outcome).toBe('rejected');
  });

  // G6: Dashboard / visualization text is model text: a completion claim never reaches the Dashboard; server copy replaces it (never a rejection).
  it('replaces a title, description or widget title that claims a completion with server copy', async () => {
    const ev = await evidence(), cat = await catalog();
    const claimed = { version: 1, title: 'Dashboard สร้างเรียบร้อยแล้ว', description: 'Your dashboard is ready.',
      widgets: [{ kind: 'bar', title: 'Sales updated', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: null },
        { kind: 'bar', title: 'ยอดขายรายสาขา', measure: 'net_sales', dimension: 'branch', sort: 'asc', topN: null }] };
    const result = buildDashboardSpecFromPlan(claimed, ev, cat, actors.executive);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.spec.title).toBe('Dashboard ยอดขายและผลงานสาขา');
    expect(result.spec.description).toBe('');
    expect(result.spec.widgets.map(w => w.title)).toEqual(['ยอดขายสุทธิ', 'ยอดขายรายสาขา']);
    const refined = buildDashboardSpecFromPlan(claimed, ev, cat, actors.executive,
      { base: { title: 'เดิม', description: '', scope: { region: 'all', date: BUSINESS_DATE }, widgets: [] } });
    expect(refined.outcome === 'accepted' && refined.spec.title).toBe('เดิม');
  });

  it('appends to a base dashboard without disturbing legacy widgets (refine)', async () => {
    const ev = await evidence();
    const baseSpec = { title: 'เดิม', description: '', scope: { region: 'all', date: BUSINESS_DATE }, widgets: [{ type: 'metric' as const, title: 'ยอดขาย', metric: 'net_sales' as const }] };
    const result = buildDashboardSpecFromPlan(plan(), ev, await catalog(), actors.executive, { base: baseSpec });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') expect(result.spec.widgets.map(w => w.type)).toEqual(['metric', 'viz']);
  });
});

describe('dashboard viz widgets re-query on open', () => {
  async function dashboard() {
    const result = buildDashboardSpecFromPlan(plan(), await evidence(), await catalog(), actors.executive);
    if (result.outcome !== 'accepted') throw new Error('expected spec');
    return result.spec;
  }
  const open = (spec: Awaited<ReturnType<typeof dashboard>>, viewer = actors.executive) =>
    executeDashboardVizWidgets({ store: fixture.store, viewer, now: () => FIXED_NOW, businessDate: BUSINESS_DATE, read, diagnosticId: 'open:1', spec });

  it('re-queries with the owner scope and returns evidence-bound data', async () => {
    const [widget] = await open(await dashboard());
    expect(widget.status).toBe('ready');
    if (widget.status === 'ready') expect(widget.data.points.length).toBeGreaterThan(1);
  });

  it('never shows a viewer more than their own authority (south data absent for an east viewer)', async () => {
    const results = await open(await dashboard(), actors.east);
    expect(JSON.stringify(results)).not.toContain('S01');
    for (const result of results) if (result.status === 'ready') expect(result.data.points.every(p => !p.key.startsWith('S'))).toBe(true);
  });

  it('fails closed on a tampered stored query', async () => {
    const spec = await dashboard();
    const widget = spec.widgets[0];
    if (widget.type !== 'viz') throw new Error('viz');
    widget.binding.query = { ...widget.binding.query, topN: { count: 1, direction: 'highest', completeScopeRequired: true } };
    const [result] = await open(spec);
    expect(result.status).toBe('unavailable');
  });
});
