import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { listResultsPage, applyResultOp } from '@/lib/artifacts/library';
import { ARTIFACT_HEAD_TOOL } from '@/lib/artifacts/store';
import { actionRegistry } from '@/lib/router/action-registry';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { validateTurnPlan } from '@/lib/router/validate';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS, SCRIPTED_LOOKUP_PROMPTS, SCRIPTED_REVISE_CHART_PROMPT, SCRIPTED_SHARE_THIS_RESULT_PROMPT } from '@/lib/router/planner/scripted';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const iso = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 60_000).toISOString();
const pad = (n: number) => String(n).padStart(3, '0');
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 2 as const, requestKey: `scale_key_${Math.random().toString(36).slice(2)}_${Date.now()}_padding`.slice(0, 80), ...extra });

describe('PC-03: Results library beyond one page (101 Results)', { timeout: 180_000 }, () => {
  it('search / status / archive are applied BEFORE the page boundary; every Result is reachable; totals are matching counts', async () => {
    const actorId = 'executive';
    await seeded.store.transaction(async tx => {
      for (let i = 0; i < 101; i += 1) {
        const id = `artifact_scale_${pad(i)}`;
        await tx.put('tool_executions', { id: `artifact-head:${id}`, name: ARTIFACT_HEAD_TOOL, status: 'artifact_head', actorId, conversationId: `conv_${i % 7}`, artifactId: id, revision: 1,
          ref: { id, version: 1, digest: `digest_${i}` }, kind: 'table', title: i === 0 ? 'รายงานเก่าที่สุด ศูนย์' : `รายงาน ${pad(i)}`, createdAt: iso(i), updatedAt: iso(i),
          ...(i === 0 ? { savedRef: { id, version: 1, digest: 'digest_0' }, savedAt: iso(500) } : {}) });
      }
    });
    const page1 = await listResultsPage(seeded.store, actorId, { limit: 50 });
    expect(page1.total).toBe(101);
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeTruthy();
    // The oldest saved Result is on no "newest 100" window, yet the Saved filter finds it first.
    const saved = await listResultsPage(seeded.store, actorId, { section: 'saved' });
    expect(saved.items.map(item => item.id)).toEqual(['artifact_scale_000']);
    expect(saved.total).toBe(1);
    // Text search reaches it too.
    expect((await listResultsPage(seeded.store, actorId, { query: 'ศูนย์' })).items.map(item => item.id)).toEqual(['artifact_scale_000']);
    // Walking cursors visits every Result exactly once.
    const seen: string[] = [];
    for (let cursor: string | null = null, guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<typeof listResultsPage>> = await listResultsPage(seeded.store, actorId, { limit: 30, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(101);
    expect(new Set(seen).size).toBe(101);
    // Archive the newest 60: the Recent view still holds the 40 older unsaved ones plus nothing is dropped from Archived.
    await seeded.store.transaction(async tx => { for (let i = 100; i > 40; i -= 1) await applyResultOp(tx, actorId, `artifact_scale_${pad(i)}`, { op: 'archive' }, iso(1000)); });
    const recent = await listResultsPage(seeded.store, actorId, { section: 'recent', limit: 100 });
    expect(recent.total).toBe(40);
    expect(recent.items.every(item => !item.archived)).toBe(true);
    const archived = await listResultsPage(seeded.store, actorId, { section: 'archived', limit: 100 });
    expect(archived.total).toBe(60);
    // A page is never presented as the total.
    expect((await listResultsPage(seeded.store, actorId, { section: 'archived', limit: 10 })).nextCursor).toBeTruthy();
    // Another owner sees none of them.
    expect((await listResultsPage(seeded.store, 'east', {})).total).toBe(0);
  });
});

describe('PC-03: exact-target lookup outside the bounded context window (21 Dashboards, 11 Monitors)', { timeout: 180_000 }, () => {
  const catalogOf = async () => createSemanticCatalog(await seeded.store.list('branches'));
  let oldestId = '';
  it('a Dashboard older than the newest 20 is absent from the planner context unless the user SELECTED it (server-verified, owner-only)', async () => {
    const actor = seeded.actors.executive;
    await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    const base = (await seeded.store.list<Dashboard>('dashboards')).find(d => d.ownerId === 'executive')!;
    await seeded.store.transaction(async tx => {
      for (let i = 0; i < 21; i += 1) await tx.put('dashboards', { ...base, id: `dash_scale_${pad(i)}`, spec: { ...base.spec, title: i === 0 ? 'Archive Alpha รายงานเก่า' : `Dashboard ${pad(i)}` }, createdAt: iso(i), updatedAt: iso(i) });
    });
    oldestId = 'dash_scale_000';
    const build = async (selected?: Parameters<typeof buildPlannerContext>[0]['selected']) => buildPlannerContext({ store: seeded.store, actor, conversationId: 'c_scale', businessDate: '2026-10-01', registry: actionRegistry,
      now: () => SEED_NOW.getTime(), catalog: await catalogOf(), recipientAllowed: async () => false, ...(selected ? { selected } : {}) });
    const plain = await build();
    expect(plain.dashboards).toHaveLength(20);
    expect(plain.dashboards.some(d => d.id === oldestId)).toBe(false);
    const refine = (id: string) => ({ turnPlanVersion: 1, steps: [{ kind: 'refine', pendingActionId: id, operation: { op: 'revise_dashboard', title: { value: 'ชื่อใหม่', source: 'generated' } } }] });
    expect(validateTurnPlan({ raw: refine(oldestId), messages: { current: 'x' }, context: plain, registry: actionRegistry }).outcome).not.toBe('accepted');
    const withSelected = await build({ dashboards: [{ id: oldestId, title: 'Archive Alpha รายงานเก่า' }] });
    expect(withSelected.dashboards[0].id).toBe(oldestId);
    expect(withSelected.selectedTargets?.dashboards).toEqual([oldestId]);
    expect(validateTurnPlan({ raw: refine(oldestId), messages: { current: 'x' }, context: withSelected, registry: actionRegistry }).outcome).toBe('accepted');
    // 11 monitors: the context shows 10; the 11th is reachable only as a selected, server-listed monitor.
    const monitors = Array.from({ length: 11 }, (_, i) => ({ id: `mon_${pad(i)}`, title: `Monitor ${pad(i)}`, status: 'active' }));
    const common = { store: seeded.store, actor, conversationId: 'c_scale', businessDate: '2026-10-01', registry: actionRegistry, now: () => SEED_NOW.getTime(), catalog: await catalogOf(), recipientAllowed: async () => false, monitors: async () => monitors };
    expect((await buildPlannerContext(common)).monitors).toHaveLength(10);
    const many = await buildPlannerContext({ ...common, selected: { monitors: [monitors[10]] } });
    expect(many.monitors![0].id).toBe('mon_010');
  });

  it('resource_lookup finds the old Dashboard by name, the user taps it, the server re-verifies and the SAME exact id is used; another owner finds nothing', async () => {
    const actor = seeded.actors.executive;
    const found = await seeded.service.turn(actor, SCRIPTED_LOOKUP_PROMPTS.dashboard);
    expect(found.clarification).toBe(true);
    expect(found.choices?.map(choice => choice.id)).toEqual([oldestId]);
    expect(found.message).toContain('1 รายการ');
    const tapped = await seeded.service.turn(actor, 'Archive Alpha รายงานเก่า', found.conversationId, undefined, identity({ clarification: { choiceId: oldestId, clarifiedTurnId: found.turnId } }) as never);
    expect(tapped.clarification, tapped.message).toBeUndefined();
    expect((await seeded.store.get<Dashboard>('dashboards', oldestId))!.spec.title).toBe('Found by lookup');
    // Another actor's lookup never sees it (and a forged tap is not a saved choice).
    const east = await seeded.service.turn(seeded.actors.east, SCRIPTED_LOOKUP_PROMPTS.dashboard);
    expect(east.choices ?? []).toEqual([]);
  });
});

describe('PC-04: saved state per revision and exact version targets', { timeout: 180_000 }, () => {
  let artifactId = '';
  const COMBO = 'Make a combo chart of East sales and target by branch for 2026-10-01.';
  it('save v1, create v2: the Result is Saved but the latest is a newer draft; saving v1 again is refused (latest-only) and v2 saves', async () => {
    const actor = seeded.actors.executive;
    const made = await seeded.service.turn(actor, COMBO);
    artifactId = (await seeded.service.resultsLibrary(actor)).find(item => item.kind === 'chart')!.id;
    await seeded.service.saveArtifact(actor, artifactId);
    const revised = await seeded.service.turn(actor, SCRIPTED_REVISE_CHART_PROMPT, made.conversationId);
    expect(revised.clarification, revised.message).toBeUndefined();
    const item = (await seeded.service.resultsLibrary(actor)).find(i => i.id === artifactId)!;
    expect(item).toMatchObject({ latestRevision: 2, savedRevision: 1, saved: true, latestSaved: false, section: 'saved' });
    expect((await seeded.service.openArtifact(actor, artifactId, 1)).saved).toBe(true);
    expect((await seeded.service.openArtifact(actor, artifactId, 2)).saved).toBe(false);
    await expect(seeded.service.saveArtifact(actor, artifactId, { revision: 1 })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    // A concurrent v3 appears: a click bound to v2 conflicts instead of silently saving v3.
    await seeded.service.turn(actor, SCRIPTED_REVISE_CHART_PROMPT, made.conversationId);
    await expect(seeded.service.saveArtifact(actor, artifactId, { revision: 2 })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    await seeded.service.saveArtifact(actor, artifactId, { revision: 3 });
    expect((await seeded.service.resultsLibrary(actor)).find(i => i.id === artifactId)).toMatchObject({ latestRevision: 3, savedRevision: 3, latestSaved: true });
  });

  it('Add to Dashboard uses the version the action represents: v1 and the latest produce different widgets', async () => {
    const actor = seeded.actors.executive;
    await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    const dashboard = (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive' && d.spec.widgets.length === 7)[0];
    const { specRevision } = await import('@/lib/router/executors/action-ports');
    const fresh = async () => specRevision((await seeded.store.get<Dashboard>('dashboards', dashboard.id))!.spec);
    await seeded.service.addResultToDashboard(actor, dashboard.id, { baseRevision: await fresh(), artifactId, revision: 1 });
    const widgets = (await seeded.store.get<Dashboard>('dashboards', dashboard.id))!.spec.widgets;
    expect(widgets.at(-1)!.title).toBe('East sales and target');
    await seeded.service.editDashboardWidgets(actor, dashboard.id, { baseRevision: await fresh(), change: { op: 'remove', index: widgets.length - 1 } });
    await seeded.service.addResultToDashboard(actor, dashboard.id, { baseRevision: await fresh(), artifactId });
    expect((await seeded.store.get<Dashboard>('dashboards', dashboard.id))!.spec.widgets.at(-1)!.title).toBe('East sales and target (revised)');
  });

  it('a selected OLDER version from another conversation is shared as exactly that version, under its CURRENT display title', async () => {
    const actor = seeded.actors.executive;
    await seeded.service.updateResult(actor, artifactId, { op: 'rename', title: 'ชื่อที่แสดงใหม่' });
    const { listPendingProposals } = await import('@/app/api/router-proposals/_view');
    const before = (await listPendingProposals(seeded.store, actor, SEED_NOW.getTime())).length;
    // New conversation: the artifact is NOT among that conversation's artifacts; only the verified selection admits it.
    const answer = await seeded.service.turn(actor, SCRIPTED_SHARE_THIS_RESULT_PROMPT, undefined, undefined, identity({ targets: [{ kind: 'artifact', id: artifactId, revision: 1 }] }) as never);
    expect(answer.clarification, answer.message).toBeUndefined();
    const proposals = await listPendingProposals(seeded.store, actor, SEED_NOW.getTime());
    expect(proposals.length).toBe(before + 1);
    const proposal = proposals.find(p => p.actionId === 'artifact.share')!;
    expect(proposal.preview).toContain('ฉบับที่ 1');
    // Without the selection the planner has no such id: nothing is staged.
    const none = await seeded.service.turn(actor, SCRIPTED_SHARE_THIS_RESULT_PROMPT);
    expect(JSON.stringify(none)).not.toContain('ฉบับที่ 1');
    expect((await listPendingProposals(seeded.store, actor, SEED_NOW.getTime())).length).toBe(before + 1);
    // Forged / foreign selection: another owner's artifact id is dropped (never admitted).
    const forged = await seeded.service.turn(seeded.actors.east, SCRIPTED_SHARE_THIS_RESULT_PROMPT, undefined, undefined, identity({ targets: [{ kind: 'artifact', id: artifactId }] }) as never);
    expect((await listPendingProposals(seeded.store, seeded.actors.east, SEED_NOW.getTime())).length).toBe(0);
    expect(forged.message).toBeTruthy();
  });
});
