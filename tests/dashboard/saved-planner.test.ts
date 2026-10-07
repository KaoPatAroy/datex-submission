import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { specRevision } from '@/lib/router/executors/action-ports';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { actionRegistry } from '@/lib/router/action-registry';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { buildTurnPlannerInput } from '@/lib/router/planner/input';
import { validateTurnPlan } from '@/lib/router/validate';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const owned = async () => (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive');
const contextFor = async (conversationId: string) => buildPlannerContext({ store: seeded.store, actor: seeded.actors.executive, conversationId, businessDate: '2026-10-01', registry: actionRegistry,
  now: () => SEED_NOW.getTime(), catalog: createSemanticCatalog(await seeded.store.list('branches')), recipientAllowed: async () => false });

describe('PC-05: saved-Dashboard operations through the normal planner path', { timeout: 180_000 }, () => {
  it('the live-planner instructions advertise the real saved-Dashboard operations (not rename/delete only)', async () => {
    const context = await contextFor('c_none');
    const prompt = buildTurnPlannerInput(context, { current: 'x' }).prompt;
    expect(prompt).toContain('refine step with pendingActionId = the DASHBOARDS id');
    expect(prompt).toContain('visualizationMode');
    expect(prompt).not.toContain('changed only through their registered actions');
    expect(prompt).toContain('"pendingActionId":"DB_1"');
  });

  let conversationId: string;
  it('a renamed Dashboard keeps its id and is refined (widgets appended) through chat', async () => {
    const actor = seeded.actors.executive;
    const first = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    conversationId = first.conversationId;
    const [dashboard] = await owned();
    await seeded.service.renameDashboard(actor, dashboard.id, { title: 'ชื่อใหม่หลังเปลี่ยน' }, { expectedRevision: specRevision(dashboard.spec) });
    const context = await contextFor(conversationId);
    expect(context.dashboards.map(({ id, title }) => ({ id, title }))).toEqual([{ id: dashboard.id, title: 'ชื่อใหม่หลังเปลี่ยน' }]);
    const before = (await owned())[0].spec.widgets.length;
    const answer = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[1], conversationId);
    expect(answer.clarification, answer.message).toBeUndefined();
    const after = (await owned())[0];
    expect(after.id).toBe(dashboard.id);
    expect(after.spec.title).toBe('ชื่อใหม่หลังเปลี่ยน');
    expect(after.spec.widgets.length).toBe(before + 3);
  });

  it('two Dashboards with the same title are both listed by exact id; the validator accepts only listed ids', async () => {
    const actor = seeded.actors.executive;
    const [first] = await owned();
    await seeded.service.turn(actor, 'Build a dashboard of low stock by branch.');
    const second = (await owned()).find(d => d.id !== first.id)!;
    await seeded.service.renameDashboard(actor, second.id, { title: 'ชื่อใหม่หลังเปลี่ยน' }, { expectedRevision: specRevision(second.spec) });
    const context = await contextFor(conversationId);
    expect(context.dashboards.map(d => d.title)).toEqual(['ชื่อใหม่หลังเปลี่ยน', 'ชื่อใหม่หลังเปลี่ยน']);
    expect(new Set(context.dashboards.map(d => d.id)).size).toBe(2);
    const refine = (id: string) => ({ turnPlanVersion: 1, steps: [{ kind: 'refine', pendingActionId: id, operation: { op: 'revise_dashboard', title: { value: 'ใหม่', source: 'generated' } } }] });
    expect(validateTurnPlan({ raw: refine(first.id), messages: { current: 'x' }, context, registry: actionRegistry }).outcome).toBe('accepted');
    expect(validateTurnPlan({ raw: refine('dashboard_not_listed'), messages: { current: 'x' }, context, registry: actionRegistry }).outcome).not.toBe('accepted');
  });

  it('a refine of a SHARED Dashboard through chat is staged for the owner confirmation; nothing changes until confirm', async () => {
    const actor = seeded.actors.executive;
    const target = (await owned()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; // the scripted planner refines the newest Dashboard
    const prepared = await seeded.service.prepare(actor, { kind: 'dashboard_share', dashboardId: target.id, recipientId: 'east' });
    await seeded.service.confirm(actor, prepared.id);
    const widgets = (await seeded.store.get<Dashboard>('dashboards', target.id))!.spec.widgets.length;
    const answer = await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[2], conversationId);
    expect(answer.clarification, answer.message).toBeUndefined();
    expect((await seeded.store.get<Dashboard>('dashboards', target.id))!.spec.widgets.length).toBe(widgets);
    const { listPendingProposals } = await import('@/app/api/router-proposals/_view');
    const proposal = (await listPendingProposals(seeded.store, actor, SEED_NOW.getTime())).find(p => p.actionId === 'dashboard.refine');
    expect(proposal).toBeTruthy();
    expect((await seeded.service.confirmStagedProposal(actor, proposal!.id)).outcome).toBe('executed');
    expect((await seeded.store.get<Dashboard>('dashboards', target.id))!.spec.widgets.length).toBe(widgets + 1);
  });
});
