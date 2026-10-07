import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile, TurnChoice } from '@/lib/contracts';
import { conversationStateRef } from '@/lib/dynamic/planner/planner';
import { conversationStateSchema } from '@/lib/dynamic/state/conversation';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { getOwnedMonitor, listOwnedMonitors } from '@/lib/router/ports/effect-store';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { SCRIPTED_LOOKUP_PROMPTS } from '@/lib/router/planner/scripted';
import { actors, createWorkspaceFixture, BUSINESS_DATE, FIXED_NOW } from '../helpers/workspace';
import { grounded } from '../router/executors/action-fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const now = new Date(FIXED_NOW);
const clock = () => new Date(now);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

const refuse = async (): Promise<never> => { throw new Error('not available in this test'); };
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 2 as const, requestKey: `mon_lookup_${Math.random().toString(36).slice(2)}_${Date.now()}_padding`.slice(0, 80), ...extra });

async function installOne() {
  const { store } = fixture;
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  const owner: Actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
  const recipientAllowed = createRecipientPolicy(store);
  const effects = createEffectBindings({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  const ports: ActionPorts = createActionPorts({
    reloadActor: async a => ({ ...(await store.get<Profile>('profiles', a.id))!, sessionId: a.sessionId, mode: a.mode, modeRevision: a.modeRevision }), prepareTool: refuse, confirmPending: refuse, cancelPending: refuse, revisePending: refuse,
    listPending: async () => [], getDashboard: async () => undefined, renameDashboard: refuse, deleteDashboard: refuse,
    recipientAllowed, staged: createStagedStore(store, { now: () => now.getTime() }), effects,
  });
  const turn = await fixture.service.turn(owner, 'Show East sales totals for 2026-10-01.');
  const record = await store.get<{ state: unknown }>('tool_executions', `dynamic:${turn.turnId}`);
  const query = conversationStateRef(conversationStateSchema.parse(record?.state)).id;
  const preview = await executeActionStep({ ports, actor: owner, step: grounded('monitor.create', { query, threshold: 0.8, recipientIds: ['east'] } as never), conversationId: 'conv-direct', turnId: 'turn-direct', now: clock });
  if (preview.outcome !== 'proposed') throw new Error('monitor.create was not proposed');
  expect(await confirmProposal({ ports, actor: owner, proposalId: preview.ids.pendingActionId!, now: clock })).toMatchObject({ outcome: 'executed' });
  const [row] = await listOwnedMonitors(store, owner);
  return { owner, effects, store, row: row! };
}

describe('B-P1: Monitor lookup and selection reach EVERY retained Monitor, not only the newest 10', { timeout: 120_000 }, () => {
  it('12 "Legacy" Monitors: truthful total, the oldest is reachable through the next-page choice, its tap is verified and paused', async () => {
    const { owner, effects, store, row } = await installOne();
    await store.transaction(async tx => {
      await tx.put('tool_executions', { ...row, title: 'Legacy oldest' });
      for (let i = 1; i <= 11; i++) await tx.put('tool_executions', { ...row, id: `monitor:legacy-${i}`, title: `Legacy ${String(i).padStart(2, '0')}`, createdAt: new Date(now.getTime() + i * 60_000).toISOString() });
    });
    // The port-level owner search sees all 12; another owner sees none; an exact old id is found.
    expect((await effects.searchMonitors!(owner, { needle: 'legacy', offset: 0, limit: 8 })).total).toBe(12);
    expect((await effects.searchMonitors!(actors.east, { needle: 'legacy', offset: 0, limit: 8 })).total).toBe(0);
    expect(await effects.findMonitor!(owner, row.id)).toMatchObject({ id: row.id });
    expect(await effects.findMonitor!(actors.east, row.id)).toBeUndefined();

    const first = await fixture.service.turn(owner, SCRIPTED_LOOKUP_PROMPTS.monitor);
    expect(first.message).toContain('12 รายการ');
    const ids = (first.choices ?? []).map(choice => choice.id);
    expect(ids).not.toContain(row.id);
    const more = (first.choices ?? []).find(choice => choice.id.startsWith('lookup-more:'))!;
    expect(more).toBeTruthy();
    await fixture.setNow(new Date(now.getTime() + 1_000)); // each tap is a later turn (the latest offer is the one answered)
    const second = await fixture.service.turn(owner, more.label, first.conversationId, undefined, identity({ clarification: { choiceId: more.id, clarifiedTurnId: first.turnId } }) as never);
    const oldest = (second.choices ?? []).find((choice: TurnChoice) => choice.id === row.id)!;
    expect(oldest.label).toContain('Legacy oldest');
    await fixture.setNow(new Date(now.getTime() + 2_000));
    const tapped = await fixture.service.turn(owner, oldest.label, second.conversationId, undefined, identity({ clarification: { choiceId: oldest.id, clarifiedTurnId: second.turnId } }) as never);
    expect(tapped.clarification, tapped.message).toBeUndefined();
    expect((await getOwnedMonitor(store, owner, row.id))?.status).toBe('monitor_paused');
  });
});
