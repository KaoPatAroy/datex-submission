import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { conversationStateRef } from '@/lib/dynamic/planner/planner';
import { conversationStateSchema } from '@/lib/dynamic/state/conversation';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { casMonitor, listInbox, listOwnedMonitors, type MonitorRow } from '@/lib/router/ports/effect-store';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { actors, createWorkspaceFixture, BUSINESS_DATE, FIXED_NOW } from '../../helpers/workspace';
import { grounded } from '../executors/action-fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
let now = new Date(FIXED_NOW);
const clock = () => new Date(now);
const CONVERSATION = 'conv-effects';

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  now = new Date(FIXED_NOW);
  flip.on = false;
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

const refuse = async (): Promise<never> => { throw new Error('not available in this test'); };

async function liveActor(base: Actor): Promise<Actor> {
  await fixture.patchSession(base.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...base, mode: 'live_ai', modeRevision: 1 };
}
/** `flip.on` makes the policy deny ONLY when it is consulted inside a transaction (reader given), i.e. authority changed after binding. */
const flip = { on: false };
function portsFor() {
  const { store } = fixture;
  const base = createRecipientPolicy(store);
  const recipientAllowed: typeof base = async (actor, id, reader) => (flip.on && reader ? false : base(actor, id, reader));
  const effects = createEffectBindings({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  const ports: ActionPorts = createActionPorts({
    reloadActor: async a => ({ ...(await store.get<Profile>('profiles', a.id))!, sessionId: a.sessionId, mode: a.mode, modeRevision: a.modeRevision }), prepareTool: refuse, confirmPending: refuse, cancelPending: refuse, revisePending: refuse,
    listPending: async () => [], getDashboard: async () => undefined, renameDashboard: refuse, deleteDashboard: refuse,
    recipientAllowed, staged: createStagedStore(store, { now: () => now.getTime() }), effects,
  });
  const runner = createMonitorRunner({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  return { ports, runner, effects, store };
}
/** Run one real live query turn so an accepted, evidence-bound state exists; returns its planner-context state id. */
async function acceptedStateId(actor: Actor): Promise<string> {
  const response = await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.');
  const record = await fixture.store.get<{ state: unknown }>('tool_executions', `dynamic:${response.turnId}`);
  return conversationStateRef(conversationStateSchema.parse(record?.state)).id;
}
const step = (ports: ActionPorts, actor: Actor, actionId: string, params: Record<string, string | number | string[]>) =>
  executeActionStep({ ports, actor, step: grounded(actionId, params as never), conversationId: CONVERSATION, turnId: 'turn-effects', now: clock });
const confirm = (ports: ActionPorts, actor: Actor, proposalId: string) => confirmProposal({ ports, actor, proposalId, now: clock });
const proposalId = (r: Awaited<ReturnType<typeof step>>) => (r.outcome === 'proposed' ? r.ids.pendingActionId! : '');

describe('communication.send (simulated inbox)', { timeout: 30_000 }, () => {
  it('previews exact recipients + evidence content, delivers on confirm, and only the recipient sees it', async () => {
    const sender = await liveActor(actors.executive), { ports } = portsFor();
    const content = await acceptedStateId(sender);
    const preview = await step(ports, sender, 'communication.send', { recipientIds: ['east'], content });
    expect(preview).toMatchObject({ outcome: 'proposed', deduped: false });
    if (preview.outcome !== 'proposed') return;
    expect(preview.preview).toContain('East Manager (ผู้จัดการภาคตะวันออก)'); // real name + Thai role (demo fixture names show the role only)
    expect(preview.preview).toContain('ไม่ส่งออกภายนอก');
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);

    const done = await confirm(ports, sender, proposalId(preview));
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ source: 'communication', senderName: 'Operations Executive (ผู้บริหาร)', readAt: null });
    // The delivered text is exactly the previewed, evidence-rendered content (no number the evidence does not carry).
    expect(preview.preview.endsWith(inbox[0].content)).toBe(true);
    expect(inbox[0].content).toMatch(/\d/);
    expect(await listInbox(fixture.store, actors.executive)).toHaveLength(0);
    expect(await listInbox(fixture.store, actors.hr)).toHaveLength(0);

    // Replaying the same request cannot duplicate delivery (operation key + exact-target record).
    const again = await step(ports, sender, 'communication.send', { recipientIds: ['east'], content });
    expect(again.outcome).toBe('proposed');
    expect((await confirm(ports, sender, proposalId(again))).outcome).toBe('executed');
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(1);
    expect(await confirm(ports, sender, proposalId(preview))).toMatchObject({ outcome: 'executed' }); // retry = stored result, no second delivery (F9)
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(1);
  });

  it('denies recipients outside the policy and content that is not this actor accepted evidence', async () => {
    const executive = await liveActor(actors.executive), east = await liveActor(actors.east), { ports } = portsFor();
    const content = await acceptedStateId(executive);
    expect(await step(ports, executive, 'communication.send', { recipientIds: ['hr'], content })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await step(ports, executive, 'communication.send', { recipientIds: ['executive'], content })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await step(ports, executive, 'communication.send', { recipientIds: ['east'], content: 'conversation_state:nope' }))
      .toMatchObject({ outcome: 'clarify', code: 'content_unbound' });
    // Another actor cannot send someone else's accepted answer, and cannot message outside their own regions.
    expect(await step(ports, east, 'communication.send', { recipientIds: ['executive'], content })).toMatchObject({ outcome: 'clarify', code: 'content_unbound' });
    const own = await acceptedStateId(east);
    expect(await step(ports, east, 'communication.send', { recipientIds: ['executive'], content: own })).toMatchObject({ outcome: 'denied' });
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
    expect(await listInbox(fixture.store, actors.executive)).toHaveLength(0);
  });

  it('refuses to deliver when authority changed between preview and confirm', async () => {
    const sender = await liveActor(actors.executive), { ports, store } = portsFor();
    const content = await acceptedStateId(sender);
    const preview = await step(ports, sender, 'communication.send', { recipientIds: ['east'], content });
    const profile = await store.get<Profile>('profiles', 'executive');
    await store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'dashboard.share') }));
    expect((await confirm(ports, sender, proposalId(preview))).outcome).toBe('denied');
    expect(await listInbox(store, actors.east)).toHaveLength(0);
  });
});

describe('F3 effects re-read authority inside the writing transaction', { timeout: 30_000 }, () => {
  it('communication: recipient authority that changes after binding but before the write denies the delivery (no inbox row)', async () => {
    const sender = await liveActor(actors.executive), { ports, store } = portsFor();
    const content = await acceptedStateId(sender);
    const preview = await step(ports, sender, 'communication.send', { recipientIds: ['east'], content });
    expect(preview.outcome).toBe('proposed');
    flip.on = true; // every pre-transaction check still passes; only the in-transaction re-read sees the change
    expect(await confirm(ports, sender, proposalId(preview))).toMatchObject({ outcome: 'denied', code: 'authority_changed' });
    expect(await listInbox(store, actors.east)).toHaveLength(0);
    expect(await store.list('mock_messages')).toHaveLength(0);
  });

  it('communication: sender permission removed inside the window is also refused by the in-transaction guard', async () => {
    const sender = await liveActor(actors.executive), { effects, store } = portsFor();
    const profile = await store.get<Profile>('profiles', 'executive');
    await store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'dashboard.share') }));
    const record = { operationKey: 'k1', planDigest: 'd1', target: { id: 'east', version: 1, digest: 'x' }, content: 'hello', kind: 'simulated_inbox' } as never;
    await expect(effects.commitInbox(sender, [record])).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(await store.list('mock_messages')).toHaveLength(0);
  });

  it('cron: a recipient/authority change detected in the alert transaction holds the monitor with a reason and writes no alert', async () => {
    const owner = await liveActor(actors.executive), env = portsFor();
    const query = await acceptedStateId(owner);
    const preview = await step(env.ports, owner, 'monitor.create', { query, threshold: 0.8, recipientIds: ['east'] });
    expect(await confirm(env.ports, owner, proposalId(preview))).toMatchObject({ outcome: 'executed' });
    flip.on = true;
    const tick = await env.runner.tick();
    expect(tick).toMatchObject({ held: 1, alerts: 0 });
    const [held] = await listOwnedMonitors(fixture.store, owner);
    expect(held).toMatchObject({ status: 'monitor_needs_renewal', lastError: 'scope_or_permission' });
    expect(await listInbox(fixture.store, owner)).toHaveLength(0);
    expect(await fixture.store.list('mock_messages')).toHaveLength(0);
  });
});

describe('F11 monitor pause/resume can be deferred into the turn completion transaction', { timeout: 30_000 }, () => {
  it('manage(..., { defer }) changes nothing until the queued write runs inside a transaction', async () => {
    const owner = await liveActor(actors.executive), env = portsFor();
    const query = await acceptedStateId(owner);
    const preview = await step(env.ports, owner, 'monitor.create', { query, threshold: 0.8, recipientIds: ['east'] });
    await confirm(env.ports, owner, proposalId(preview));
    const [row] = await listOwnedMonitors(fixture.store, owner);
    const queued: ((tx: never, actor: Actor) => Promise<void>)[] = [];
    expect(await env.runner.manage(owner, { monitorId: row!.id, op: 'pause' }, { defer: { push: write => { queued.push(write as never); } } })).toMatchObject({ ok: true });
    expect((await listOwnedMonitors(fixture.store, owner))[0]).toMatchObject({ status: 'monitor_active' }); // a failed turn would leave it untouched
    await fixture.store.transaction(tx => queued[0](tx as never, owner));
    expect((await listOwnedMonitors(fixture.store, owner))[0]).toMatchObject({ status: 'monitor_paused' });
  });
});

describe('monitor.create + scheduler + lifecycle', { timeout: 30_000 }, () => {
  async function install() {
    const owner = await liveActor(actors.executive), env = portsFor();
    const query = await acceptedStateId(owner);
    const preview = await step(env.ports, owner, 'monitor.create', { query, threshold: 0.8, recipientIds: ['east'] });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    const done = await confirm(env.ports, owner, proposalId(preview));
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    const [row] = await listOwnedMonitors(fixture.store, owner);
    return { owner, ...env, row: row! };
  }

  it('installs a verified monitor row (owner-only) and alerts the owner and the approved recipient once, with cooldown, dedupe and persisted history', async () => {
    const { owner, runner, store, row } = await install();
    expect(row).toMatchObject({ status: 'monitor_active', actorId: 'executive', name: 'router.monitor' });
    expect(row.state.workflow.status).toBe('verified');
    expect(await listOwnedMonitors(store, actors.east)).toHaveLength(0);

    const first = await runner.tick();
    expect(first).toMatchObject({ scanned: 1, evaluated: 1, alerts: 1, held: 0, errors: 0 });
    const inbox = await listInbox(store, owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ source: 'monitor_alert' });
    expect(inbox[0].content).toContain('East Two');
    expect(inbox[0].content).toContain('75%');
    // The approved recipient (re-authorized in the alert transaction) gets the same alert in their own inbox; nobody else does.
    const eastInbox = await listInbox(store, actors.east);
    expect(eastInbox).toHaveLength(1);
    expect(eastInbox[0]).toMatchObject({ source: 'monitor_alert', content: inbox[0].content });
    // PostgreSQL's mock_message_operation_unique allows one row per operationKey: the owner's and the recipient's copies must differ (SQLite has no such index).
    const alertKeys = (await store.list<{ source?: string; operationKey?: string }>('mock_messages')).filter(m => m.source === 'monitor_alert').map(m => m.operationKey);
    expect(alertKeys).toHaveLength(2);
    expect(new Set(alertKeys).size).toBe(2);
    // Persisted, readable evaluation history.
    const history = (await runner.history(owner))[0]!;
    expect(history.evaluations).toHaveLength(1);
    expect(history.evaluations[0]).toMatchObject({ outcome: 'alerted', checked: expect.any(Number), notified: 2 });

    expect((await runner.tick()).skipped).toBe(1); // cadence: not due again within the day
    now = new Date(now.getTime() + 25 * 3_600_000);
    const later = await runner.tick(); // same observation -> no new sample, no new alert
    expect(later.alerts).toBe(0);
    expect(await listInbox(store, owner)).toHaveLength(1);
  });

  it('overlapping evaluations cannot double-deliver (CAS + outbox key)', async () => {
    const { owner, runner, store, row } = await install();
    await Promise.allSettled([runner.evaluate(row.id, clock()), runner.evaluate(row.id, clock())]);
    expect(await listInbox(store, owner)).toHaveLength(1);
    const after = (await listOwnedMonitors(store, owner))[0]!;
    expect(after.rowVersion).toBeGreaterThan(row.rowVersion);
    await expect(casMonitor(store, row.id, row.rowVersion, now, () => ({ lastError: 'x' }))).rejects.toMatchObject({ code: 'MONITOR_CONFLICT' });
  });

  it('pause / resume / delete are owner-private CAS operations', async () => {
    const { owner, runner, store, row } = await install();
    expect(await runner.manage(actors.east, { monitorId: row.id, op: 'pause' })).toMatchObject({ ok: false, code: 'monitor_not_found' });
    expect(await runner.manage(owner, { monitorId: row.id, op: 'pause' })).toMatchObject({ ok: true });
    expect((await listOwnedMonitors(store, owner))[0]).toMatchObject({ status: 'monitor_paused' });
    expect(await runner.tick()).toMatchObject({ scanned: 0 });
    expect(await listInbox(store, owner)).toHaveLength(0);
    expect(await runner.manage(owner, { monitorId: row.id, op: 'resume' })).toMatchObject({ ok: true });
    expect((await runner.tick()).alerts).toBe(1);
    expect(await runner.manage(owner, { monitorId: row.id, op: 'delete' })).toMatchObject({ ok: true });
    expect(await listOwnedMonitors(store, owner)).toHaveLength(0);
    expect(await runner.manage(owner, { monitorId: row.id, op: 'resume' })).toMatchObject({ ok: false, code: 'monitor_not_found' });
  });

  it('holds the monitor as needs_renewal (no alert) when the owner\'s authority changes', async () => {
    const { owner, runner, store } = await install();
    const profile = await store.get<Profile>('profiles', 'executive');
    await store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'dashboard.create') }));
    const tick = await runner.tick();
    expect(tick).toMatchObject({ held: 1, alerts: 0 });
    const [held] = await listOwnedMonitors(store, owner);
    expect(held).toMatchObject({ status: 'monitor_needs_renewal' });
    expect(held.state.lifecycle).toBe('needs_renewal');
    expect(await listInbox(store, owner)).toHaveLength(0);
    expect(await runner.manage(owner, { monitorId: held.id, op: 'resume' })).toMatchObject({ ok: false, code: 'monitor_needs_renewal' });
    expect((await runner.manage(owner, { monitorId: held.id, op: 'delete' })).ok).toBe(true);
  });

  it('holds the monitor when it passes its lifetime', async () => {
    const { owner, runner, store, row } = await install();
    now = new Date(row.expiresAt + 1);
    expect(await runner.tick()).toMatchObject({ held: 1, alerts: 0 });
    expect((await listOwnedMonitors(store, owner))[0]).toMatchObject({ status: 'monitor_needs_renewal', lastError: 'monitor_expired' }satisfies Partial<MonitorRow>);
  });
});

describe('multi-recipient deliveries satisfy mock_message_operation_unique (one message row per operationKey)', { timeout: 60_000 }, () => {
  // PostgreSQL enforces a unique index on mock_messages.payload->>'operationKey'; SQLite does not. Under BIZTANIA_PG_TESTS=1 a shared key fails the
  // write itself; under SQLite the explicit uniqueness check below catches it.
  const secondEast = async () => {
    const east = (await fixture.store.get<Profile>('profiles', 'east'))!;
    await fixture.store.transaction(tx => tx.put('profiles', { ...east, id: 'east_two', name: 'East Deputy' }));
    return { ...actors.east, id: 'east_two', name: 'East Deputy', sessionId: 'test-session-east-two' } as Actor;
  };
  const messageKeys = async (source: string) =>
    (await fixture.store.list<{ source?: string; operationKey?: string }>('mock_messages')).filter(m => m.source === source).map(m => m.operationKey);

  it('communication.send to two recipients delivers one verified copy each, with distinct operation keys, idempotently', async () => {
    const sender = await liveActor(actors.executive), deputy = await secondEast(), { ports } = portsFor();
    const content = await acceptedStateId(sender);
    const preview = await step(ports, sender, 'communication.send', { recipientIds: ['east', 'east_two'], content });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    expect(await confirm(ports, sender, proposalId(preview))).toMatchObject({ outcome: 'executed', verified: true });
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(1);
    expect(await listInbox(fixture.store, deputy)).toHaveLength(1);
    const keys = await messageKeys('communication');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // Retrying the same proposal and replaying the same request reuse the stored rows: no duplicate delivery.
    expect(await confirm(ports, sender, proposalId(preview))).toMatchObject({ outcome: 'executed' });
    const again = await step(ports, sender, 'communication.send', { recipientIds: ['east', 'east_two'], content });
    expect((await confirm(ports, sender, proposalId(again))).outcome).toBe('executed');
    expect(await messageKeys('communication')).toHaveLength(2);
  });

  it('artifact.share to two recipients delivers one openable copy each, with distinct operation keys, idempotently', async () => {
    const executive = await liveActor(actors.executive), deputy = await secondEast(), { ports } = portsFor();
    const response = await fixture.service.turn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const artifact = response.artifacts?.[0];
    if (!artifact) throw new Error(`no artifact: ${response.message}`);
    const preview = await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['east', 'east_two'] });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    expect(await confirm(ports, executive, proposalId(preview))).toMatchObject({ outcome: 'executed', verified: true });
    expect(await listInbox(fixture.store, actors.east)).toMatchObject([{ source: 'artifact_share' }]);
    expect(await listInbox(fixture.store, deputy)).toMatchObject([{ source: 'artifact_share' }]);
    const keys = await messageKeys('artifact_share');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await confirm(ports, executive, proposalId(preview))).toMatchObject({ outcome: 'executed' });
    expect(await messageKeys('artifact_share')).toHaveLength(2);
  });
});
