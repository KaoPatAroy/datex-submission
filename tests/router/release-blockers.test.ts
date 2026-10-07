import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, Dashboard } from '@/lib/contracts';
import { listPendingProposals } from '@/app/api/router-proposals/_view';
import { assertStagedFence, createStagedStore, STAGED_MODE_CHANGED_CODE } from '@/lib/router/storage/staged-store';
import { validateTurnPlan } from '@/lib/router/validate';
import { pgTestsEnabled, seedRawV2ActiveShare } from '../helpers/local-pg';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { inputFor, plan, quoted, revokeStep } from './fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

describe('P1-1: verbatim values are the user exact text, never the model string', () => {
  const REASON = 'บัตรหายระหว่างเดินทาง', ALTERED = 'บัตรพายระหว่างเดินทาง';
  const THAI = `revoke badge B1 เพราะ ${REASON}`;
  const run = (raw: unknown, current = THAI) => validateTurnPlan(inputFor(raw, 'hr_admin', { messages: { current } }));
  it('a 1-char altered model value (fuzzy-matched) is replaced by the exact user span', () => {
    const result = run(plan(revokeStep({ reason: quoted(ALTERED, ALTERED) })), THAI);
    if (result.outcome !== 'accepted') throw new Error(JSON.stringify(result));
    expect(result.steps[0].params.reason.value).toBe(REASON);
    expect(result.steps[0].params.reason.span?.text).toBe(REASON);
  });
  it('an ambiguous near-match (two candidate locations) is clarified', () => {
    const twice = `revoke badge B1 เพราะ ${REASON} และ ${REASON.slice(0, -1)}ว`;
    const result = run(plan(revokeStep({ reason: quoted(REASON.slice(0, -1) + 'ก', REASON.slice(0, -1) + 'ก') })), twice);
    expect(result.outcome).toBe('clarify');
  });
  it('a value that does not resolve to the same span as the evidence is clarified, not accepted', () => {
    const result = run(plan(revokeStep({ reason: quoted('badge B1', REASON) })));
    expect(result).toMatchObject({ outcome: 'clarify', code: 'verbatim_mismatch' });
  });
});

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
const stagedOf = (actor: Actor, conversationId: string) => createStagedStore(fixture.store).list(actor, conversationId, { includeExpired: true });
async function stagedRename(actor: Actor) {
  await fixture.service.turn(actor, 'Create a sales dashboard');
  const row = (await fixture.store.list<Dashboard>('dashboards')).filter(item => item.ownerId === actor.id).at(-1)!;
  await fixture.store.transaction(tx => tx.put('dashboards', { ...row, spec: { ...row.spec, title: 'Old name' } }));
  if (pgTestsEnabled) seedRawV2ActiveShare('share_x', row.id);
  else await fixture.store.transaction(tx => tx.put('dashboard_shares', { id: 'share_x', dashboardId: row.id, recipientId: 'east', actorId: 'executive', operationKey: 'op', createdAt: '2026-10-01T00:00:00.000Z', status: 'active' } as never));
  const response = await fixture.service.turn(actor, 'Rename my dashboard to Regional pulse');
  const [proposal] = await stagedOf(actor, response.conversationId);
  expect(proposal).toMatchObject({ actionId: 'dashboard.rename', status: 'pending' });
  return { id: row.id, proposal, conversationId: response.conversationId };
}
const titleOf = async (id: string) => (await fixture.store.get<Dashboard>('dashboards', id))!.spec.title;

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixture.dispose(); });

describe('P1-2/P1-3: dashboard effects are fenced; unverifiable mode fails closed', { timeout: 60_000 }, () => {
  it('a mode switch after the claim, before the dashboard write, writes nothing', async () => {
    const actor = await live(actors.executive);
    const { id, proposal } = await stagedRename(actor);
    const realGet = fixture.store.get.bind(fixture.store);
    let claimed = false, switched = false;
    vi.spyOn(fixture.store, 'get').mockImplementation((async (table: string, key: string) => {
      const value = await realGet(table as never, key);
      if (table === 'router_proposals' && (value as { status?: string } | undefined)?.status === 'claimed') claimed = true;
      if (table === 'dashboards' && claimed && !switched) { switched = true; await fixture.patchSession(actor.sessionId, { mode: 'scripted_demo', modeRevision: 2 }); }
      return value;
    }) as never);
    const result = await fixture.service.confirmStagedProposal(actor, proposal.id);
    expect(switched).toBe(true);
    expect(result).toMatchObject({ outcome: 'denied', code: 'mode_changed' });
    expect(await titleOf(id)).toBe('Old name');
  });

  it('a missing creator session row stales the proposal at claim and it is not confirmable', async () => {
    const actor = await live(actors.executive);
    const { id, proposal } = await stagedRename(actor);
    // Simulate an unverifiable creator by pointing the stored proposal at a session row that does not exist.
    const row = (await fixture.store.get<Record<string, unknown>>('router_proposals', proposal.id))!;
    await fixture.store.transaction(tx => tx.put('router_proposals', { ...row, sessionId: 'vanished-session' } as never));
    const views = await listPendingProposals(fixture.store, actor, proposal.expiresAt - 60_000);
    expect(views[0]).toMatchObject({ id: proposal.id, confirmable: false });
    const staged = createStagedStore(fixture.store, { now: () => proposal.expiresAt - 60_000 });
    expect(await staged.claim(actor, proposal.id)).toBeUndefined();
    expect((await stagedOf(actor, proposal.conversationId))[0].status).toBe('stale');
    expect(await titleOf(id)).toBe('Old name');
    const claimedRow = { ...row, sessionId: 'vanished-session', status: 'claimed', claimToken: 'clm_abcdefgh', claimExpiresAt: proposal.expiresAt };
    await fixture.store.transaction(tx => tx.put('router_proposals', claimedRow as never));
    await expect(fixture.store.transaction(tx => assertStagedFence(tx, { proposalId: proposal.id, actorId: actor.id, claimToken: 'clm_abcdefgh', currentSessionId: actor.sessionId })))
      .rejects.toMatchObject({ code: STAGED_MODE_CHANGED_CODE });
  });
});
