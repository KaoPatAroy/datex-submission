import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

async function live(actor: Actor): Promise<Actor> {
  const next = { ...actor, mode: 'live_ai' as const, modeRevision: 1 };
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return next;
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXUS_E2E_RUNNER', '');
  vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.dispose();
});

describe('ConciergeService turn through the unified TurnPlan router', { timeout: 30_000 }, () => {
  it('demo mode never interprets typed text: it answers with showcase chips', async () => {
    const response = await fixture.service.turn(actors.east, 'ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569');
    expect(response.clarification).toBe(true);
    expect(response.choices?.map(choice => choice.id)).toEqual(expect.arrayContaining(['east-overview']));
    expect(response.pendingAction).toBeUndefined();
  });

  it('live query: planner plan -> validated query step -> evidence-bound answer persisted with the turn', async () => {
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.');
    expect(response.clarification).toBeUndefined();
    expect(response.sources?.length).toBeGreaterThan(0);
    const state = await fixture.store.get<{ name: string }>('tool_executions', `dynamic:${response.turnId}`);
    expect(state?.name).toBe('retail.dynamic_query');
  });

  it('live action: dashboard.create prepares through the broker and links the proposal to the turn', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Create a sales dashboard');
    expect(response.pendingActions?.length).toBe(1);
    expect(response.pendingAction?.payload.kind).toBe('dashboard_create');
    expect(response.pendingAction?.turnId).toBe(response.turnId);
  });

  it('kill switch: BIZTANIA_DYNAMIC_QUERY=off completes truthfully with the switch-to-demo hint', async () => {
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'off');
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.');
    expect(response.hint).toBe('switch_to_demo');
    expect(response.clarification).toBe(true);
    expect(response.sources).toBeUndefined();
  });

  it('planner outage renders the truthful failure instead of a second router', async () => {
    vi.stubEnv('AI_PROVIDER', '');
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'anything at all');
    expect(response.hint).toBe('switch_to_demo');
    expect(response.pendingAction).toBeUndefined();
  });
});
