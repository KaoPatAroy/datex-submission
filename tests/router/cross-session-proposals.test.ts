import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor } from '@/lib/contracts';
import { listPendingProposals } from '@/app/api/router-proposals/_view';
import { listInbox, markInboxRead } from '@/lib/router/ports/effect-store';
import { assertStagedFence, createStagedStore, STAGED_MODE_CHANGED_CODE } from '@/lib/router/storage/staged-store';
import { changeMode } from '@/lib/server/session';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const SEND = 'Summarize East sales and target for 2026-10-01 and send it to East manager.';

async function live(actor: Actor, revision = 1): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: revision });
  return { ...actor, mode: 'live_ai', modeRevision: revision };
}
/** A second login of the same profile (its own session row and mode revision). */
async function secondLogin(actor: Actor, mode: Actor['mode'] = 'live_ai', modeRevision = 7): Promise<Actor> {
  const sessionId = `${actor.sessionId}-second-login`;
  await fixture.store.transaction(tx => tx.put('sessions', { id: sessionId, profileId: actor.id, mode, modeRevision, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' }));
  return { ...actor, sessionId, mode, modeRevision };
}
const stagedOf = (actor: Actor, conversationId: string) => createStagedStore(fixture.store).list(actor, conversationId, { includeExpired: true });

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('staged proposals across sessions of the same actor', { timeout: 60_000 }, () => {
  it('a proposal made in one login is confirmable from another login in the same mode, and delivers once', async () => {
    const first = await live(actors.executive);
    const response = await fixture.service.turn(first, SEND);
    const [proposal] = await stagedOf(first, response.conversationId);
    expect(proposal).toMatchObject({ actionId: 'communication.send', status: 'pending' });

    const second = await secondLogin(actors.executive);
    const views = await listPendingProposals(fixture.store, second, proposal.expiresAt - 60_000);
    expect(JSON.stringify(views[0].details)).not.toMatch(/conversation_state:|"east"/u);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: proposal.id, confirmable: true });
    expect(views[0].preview).not.toMatch(/Demo (Executive|East Manager)/u);

    expect(await fixture.service.confirmStagedProposal(second, proposal.id)).toMatchObject({ outcome: 'executed', verified: true });
    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ senderName: 'Operations Executive (ผู้บริหาร)' });
    expect(inbox[0].title).not.toMatch(/Demo/u);
    // Opening Messages marks the recipient's inbox read (badge clears); idempotent.
    expect(await markInboxRead(fixture.store, actors.east, new Date('2026-10-02T06:00:00.000Z'))).toBe(1);
    expect((await listInbox(fixture.store, actors.east))[0].readAt).toBe('2026-10-02T06:00:00.000Z');
    expect(await markInboxRead(fixture.store, actors.east, new Date())).toBe(0);
  });

  it('another mode is never confirmable, and a mode switch of the creating login stales the proposal', async () => {
    const first = await live(actors.executive);
    const response = await fixture.service.turn(first, SEND);
    const [proposal] = await stagedOf(first, response.conversationId);

    const demo = await secondLogin(actors.executive, 'scripted_demo');
    expect((await listPendingProposals(fixture.store, demo, proposal.expiresAt - 60_000))[0]).toMatchObject({ confirmable: false });
    expect(await fixture.service.confirmStagedProposal(demo, proposal.id)).toMatchObject({ outcome: 'denied', code: 'mode_changed' });

    const second = await secondLogin(actors.executive, 'live_ai', 9);
    await changeMode(fixture.store, (await fixture.store.get<never>('sessions', first.sessionId))!, 'scripted_demo');
    expect(await fixture.service.confirmStagedProposal(second, proposal.id)).toMatchObject({ outcome: 'denied' });
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
  });

  it('F10: the claim + session-mode fence is re-checked INSIDE the effect transaction', async () => {
    const first = await live(actors.executive);
    const response = await fixture.service.turn(first, SEND);
    const [proposal] = await stagedOf(first, response.conversationId);
    const staged = createStagedStore(fixture.store, { now: () => proposal.expiresAt - 60_000 });
    const claim = (await staged.claim(first, proposal.id))!;
    const fence = { proposalId: proposal.id, actorId: first.id, claimToken: claim.claimToken, currentSessionId: first.sessionId };
    await expect(fixture.store.transaction(tx => assertStagedFence(tx, fence))).resolves.toBeUndefined();
    await expect(fixture.store.transaction(tx => assertStagedFence(tx, { ...fence, claimToken: 'someone-else-token' }))).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    // A mode switch that commits between the confirm's earlier checks and the effect write is caught in the write transaction.
    await fixture.patchSession(first.sessionId, { mode: 'live_ai', modeRevision: 2 });
    await expect(fixture.store.transaction(tx => assertStagedFence(tx, fence))).rejects.toMatchObject({ code: STAGED_MODE_CHANGED_CODE });
  });

  it('monitor preview is Thai and honest about delivery: the owner and the named recipients are alerted, each re-authorized before every alert', async () => {
    const first = await live(actors.executive);
    const response = await fixture.service.turn(first, 'Summarize East sales and target for 2026-10-01 and alert East manager below 90% of target.');
    const [proposal] = await stagedOf(first, response.conversationId);
    expect(proposal).toMatchObject({ actionId: 'monitor.create' });
    expect(proposal.preview).toContain('กล่องข้อความในแอปของคุณ และของ');
    expect(proposal.preview).toContain('ตรวจสิทธิ์ของแต่ละคนใหม่ทุกครั้งก่อนแจ้ง');
    expect(proposal.preview).toContain('ผู้จัดการภาคตะวันออก');
    expect(proposal.preview).not.toMatch(/[A-Za-z]{4,} (sales|below|target)|Daily|Hourly/u);
  });
});

describe('legacy hourly monitors are migrated on read', () => {
  it('evaluate on the daily cadence and say so truthfully', async () => {
    const { displayTitle, effectiveCadenceMs } = await import('@/lib/router/ports/monitor-runner');
    const { monitorRegistry } = await import('@/lib/monitors');
    const row = (cadenceId: string) => ({ title: 'เฝ้าติดตามยอดขาย', state: { workflow: { preview: { plan: { cadenceId } } } } }) as never;
    expect(effectiveCadenceMs(row('hourly'))).toBe(monitorRegistry.cadence.daily);
    expect(displayTitle(row('hourly'))).toContain('ตรวจวันละครั้ง');
    expect(displayTitle(row('daily'))).toBe('เฝ้าติดตามยอดขาย');
  });
});
