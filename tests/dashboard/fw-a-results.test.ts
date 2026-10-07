import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard, TurnChoice } from '@/lib/contracts';
import { listResultsPage } from '@/lib/artifacts/library';
import { resultCardActions } from '@/lib/artifacts/library-view';
import { ARTIFACT_HEAD_TOOL } from '@/lib/artifacts/store';
import { executeResourceLookupStep } from '@/lib/router/executors/resource-lookup';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS, SCRIPTED_LOOKUP_PROMPTS, SCRIPTED_REVISE_CHART_PROMPT } from '@/lib/router/planner/scripted';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const pad = (n: number) => String(n).padStart(3, '0');
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 2 as const, requestKey: `fwa_key_${Math.random().toString(36).slice(2)}_${Date.now()}_padding`.slice(0, 80), ...extra });
const MORE = /^lookup-more:/;

describe('PC-03: Result lookup pages through EVERY same-name Result with a truthful total and distinct labels', { timeout: 180_000 }, () => {
  it('105 same-name Results (2 archived): total 103, every page has distinct labels, the oldest is reachable by next-page taps and the tap selects it', async () => {
    const actorId = 'executive', actor = seeded.actors.executive;
    await seeded.store.transaction(async tx => {
      for (let i = 0; i < 105; i += 1) {
        const id = `artifact_same_${pad(i)}`;
        // Pairs share the same minute so title/type/revision/time collide: the server must still label them apart.
        const at = new Date(Date.UTC(2026, 8, 1) + Math.floor(i / 2) * 60_000).toISOString();
        await tx.put('tool_executions', { id: `artifact-head:${id}`, name: ARTIFACT_HEAD_TOOL, status: 'artifact_head', actorId, conversationId: `conv_same_${i % 5}`, artifactId: id, revision: 1,
          ref: { id, version: 1, digest: `digest_same_${i}` }, kind: 'table', title: 'Old East report', createdAt: at, updatedAt: at });
      }
    });
    for (const i of [104, 103]) await seeded.service.updateResult(actor, `artifact_same_${pad(i)}`, { op: 'archive' });

    const first = await seeded.service.turn(actor, SCRIPTED_LOOKUP_PROMPTS.result);
    expect(first.clarification).toBe(true);
    expect(first.message).toContain('103 รายการ');
    const seen: string[] = [];
    let page: { message: string; choices?: TurnChoice[]; conversationId: string; turnId: string } = first;
    for (let guard = 0; guard < 30; guard += 1) {
      const choices = page.choices ?? [];
      expect(choices.length).toBeLessThanOrEqual(8);
      const labels = choices.map(choice => choice.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.every(label => label.length <= 160)).toBe(true);
      seen.push(...choices.filter(choice => !MORE.test(choice.id)).map(choice => choice.id));
      const more = choices.find(choice => MORE.test(choice.id));
      if (!more) break;
      seeded.setNow(new Date(SEED_NOW.getTime() + (guard + 1) * 1000)); // each tap is a later turn
      page = await seeded.service.turn(actor, more.label, page.conversationId, undefined, identity({ clarification: { choiceId: more.id, clarifiedTurnId: page.turnId } }) as never);
      expect(page.message).toContain('103 รายการ');
    }
    expect(seen).toHaveLength(103);
    expect(new Set(seen).size).toBe(103);
    expect(seen).not.toContain('artifact_same_104');
    expect(seen.slice(-2).sort()).toEqual(['artifact_same_000', 'artifact_same_001']); // the oldest pair is on the last page
    // Tap the oldest on the last page: the server verifies the exact id and the planner acts on it (scripted: pin).
    const oldest = page.choices!.find(choice => choice.id === 'artifact_same_000')!;
    seeded.setNow(new Date(SEED_NOW.getTime() + 60_000));
    const tapped = await seeded.service.turn(actor, oldest.label, page.conversationId, undefined, identity({ clarification: { choiceId: oldest.id, clarifiedTurnId: page.turnId } }) as never);
    expect(tapped.clarification, tapped.message).toBeUndefined();
    expect((await listResultsPage(seeded.store, actorId, { query: 'Old East', section: 'all', limit: 100 })).items.find(item => item.id === 'artifact_same_000')?.pinned).toBe(true);
    seeded.setNow(SEED_NOW);
  });

  it('a truncated owner scan reports a lower bound and offers NO next page past its last match (G2: it would be empty)', async () => {
    const found = await executeResourceLookupStep({ actor: seeded.actors.executive, step: { kind: 'resource_lookup', resource: 'result', query: 'x' },
      ports: { search: async (_actor, input) => ({ total: 8, truncated: true, items: Array.from({ length: input.limit }, (_, i) => ({ id: `r${i}`, label: `x · ${i}` })) }) } });
    expect(found.outcome).toBe('choices');
    if (found.outcome !== 'choices') return;
    expect(found.text).toContain('อย่างน้อย 8 รายการ');
    expect(found.text).toContain('เก่ากว่านี้ซึ่งไม่ได้รวมในการค้นหาครั้งนี้');
    expect(found.choices.some(choice => MORE.test(choice.id))).toBe(false);
  });
});

describe('PC-04: a shared-Dashboard Add-Result confirmation names the Result and its exact revision', { timeout: 180_000 }, () => {
  it('the staged preview carries the server display title and the chosen revision (not the latest)', async () => {
    const actor = seeded.actors.executive;
    const made = await seeded.service.turn(actor, 'Make a combo chart of East sales and target by branch for 2026-10-01.');
    const artifactId = (await seeded.service.resultsLibrary(actor)).find(item => item.kind === 'chart')!.id;
    await seeded.service.turn(actor, SCRIPTED_REVISE_CHART_PROMPT, made.conversationId);
    await seeded.service.updateResult(actor, artifactId, { op: 'rename', title: 'ยอดขายตะวันออกเทียบเป้า' });
    await seeded.service.turn(actor, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
    const dashboard = (await seeded.store.list<Dashboard>('dashboards')).find(d => d.ownerId === actor.id && d.spec.scope.region === 'east')!;
    const action = await seeded.service.prepare(actor, { kind: 'dashboard_share', dashboardId: dashboard.id, recipientId: 'east' });
    expect(JSON.stringify(await seeded.service.confirm(actor, action.id))).toContain('verified_success');
    const staged = await seeded.service.editDashboardUi(actor, dashboard.id, { kind: 'add_result', artifactId, revision: 1 });
    expect(staged.outcome).toBe('staged');
    if (staged.outcome !== 'staged') return;
    expect(staged.preview).toContain('“ยอดขายตะวันออกเทียบเป้า” ฉบับที่ 1');
    const latest = await seeded.service.editDashboardUi(actor, dashboard.id, { kind: 'add_result', artifactId });
    if (latest.outcome !== 'staged') throw new Error('expected staged');
    expect(latest.preview).toContain('ฉบับที่ 2');
  });
});

describe('PC-10: an archived Result keeps its revoke control', { timeout: 180_000 }, () => {
  it('the card offers share management (revoke) for an archived Result, but no new share or Dashboard add', () => {
    expect(resultCardActions({ kind: 'chart', archived: true })).toEqual({ share: false, addToDashboard: false, manageShares: true });
    expect(resultCardActions({ kind: 'chart', archived: false })).toEqual({ share: true, addToDashboard: true, manageShares: true });
  });

  it('the owner lists and revokes the exact active share of an ARCHIVED Result; the recipient then fails closed', async () => {
    const owner = seeded.actors.executive, east = seeded.actors.east;
    const { listPendingProposals } = await import('@/app/api/router-proposals/_view');
    const made = await seeded.service.turn(owner, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const shared = await seeded.service.turn(owner, 'Share my chart with East manager.', made.conversationId);
    expect(shared.clarification, shared.message).toBeUndefined();
    const proposal = (await listPendingProposals(seeded.store, owner, SEED_NOW.getTime())).find(p => p.actionId === 'artifact.share' && p.confirmable)!;
    expect((await seeded.service.confirmStagedProposal(owner, proposal.id)).outcome).toBe('executed');
    const message = (await seeded.store.list<{ id: string; recipientId: string; artifact?: { id: string } }>('mock_messages')).filter(m => m.recipientId === 'east' && m.artifact).at(-1)!;
    const artifactId = message.artifact!.id;
    await seeded.service.updateResult(owner, artifactId, { op: 'archive' });
    expect((await seeded.service.resultsLibrary(owner)).find(item => item.id === artifactId)?.archived).toBe(true);
    const [share] = await seeded.service.artifactShares(owner, artifactId);
    expect(share).toMatchObject({ recipientId: 'east' });
    expect(await seeded.service.revokeArtifactShare(owner, artifactId, share.shareId)).toMatchObject({ alreadyRevoked: false });
    await expect(seeded.service.openSharedArtifact(east, message.id)).rejects.toMatchObject({ code: 'SHARE_REVOKED' });
  });
});
