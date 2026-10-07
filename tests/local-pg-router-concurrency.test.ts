import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, Branch, Profile, Store } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import { createArtifactReader, persistArtifactPreview, type ArtifactPreview } from '@/lib/artifacts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { conversationStateRef } from '@/lib/dynamic/planner/planner';
import { conversationStateSchema } from '@/lib/dynamic/state/conversation';
import { authority } from '@/lib/dynamic/runtime';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { executeArtifactStep, type ArtifactSource } from '@/lib/router/executors/artifact';
import { executeQueryStep } from '@/lib/router/executors/query';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { listInbox, listOwnedMonitors } from '@/lib/router/ports/effect-store';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import type { ArtifactStep } from '@/lib/router/turn-plan';
import type { GroundedStep } from '@/lib/router/validate';
import { withCommitConflictRetry } from '@/lib/storage/conflict-retry';
import { createSupabaseStore } from '@/lib/storage/supabase';
import { proposal as queryProposal } from './dynamic/fixtures';
import { localPgConfig, pgTestsEnabled } from './helpers/local-pg';
import { BUSINESS_DATE, FIXED_NOW, actors, createWorkspaceFixture } from './helpers/workspace';
import { grounded } from './router/executors/action-fixtures';
import { actors as artifactActors, base, read, seed, type Fixture } from './router/executors/fixtures';

/**
 * Router-era concurrency and authority on the PostgreSQL adapter. "Two server instances" are two independent
 * createSupabaseStore adapters over the same database (nothing is shared in process), so every race below is decided by
 * the database: the global revision check, the claim-token CAS, and the row-level CAS on versions.
 */
const SEND = 'Summarize East sales and target for 2026-10-01 and send it to East manager.';
let fixture: Fixture;
let second: Store;
let now = new Date(FIXED_NOW);
const clock = () => new Date(now);

function secondStore(): Store {
  const config = localPgConfig();
  return withCommitConflictRetry(createSupabaseStore(config.url, config.serviceRoleKey));
}
const service = (store: Store) => new ConciergeService(store, { businessDate: BUSINESS_DATE, now: clock });
async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}

describe.skipIf(!pgTestsEnabled)('router concurrency and authority (local PostgreSQL)', { timeout: 120_000 }, () => {
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    now = new Date(FIXED_NOW);
    fixture = await createWorkspaceFixture();
    second = secondStore();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

  it('two instances racing to claim one staged proposal: exactly one claim token wins and only it can finish the row', async () => {
    const owner = await live(actors.executive);
    const first = createStagedStore(fixture.store, { now: () => now.getTime() });
    const other = createStagedStore(second, { now: () => now.getTime() });
    const created = await first.create(owner, { conversationId: 'c-claim', turnId: 't1' }, {
      actionId: 'dashboard.delete', digest: 'claim-race', preview: 'delete D1', data: { params: { dashboardId: 'D1' } }, expiresAt: now.getTime() + 600_000,
    });
    const claims = await Promise.all([first.claim(owner, created.id), other.claim(owner, created.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    expect(winner.status).toBe('claimed');
    await expect(first.save(owner, created.id, { status: 'completed' })).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    await expect(first.save(owner, created.id, { status: 'completed', claimToken: 'clm_not-the-token' })).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    expect((await first.save(owner, created.id, { status: 'completed', claimToken: winner.claimToken })).status).toBe('completed');
    expect(await other.claim(owner, created.id)).toBeUndefined();
    expect(await other.get(owner, created.id)).toMatchObject({ status: 'completed' });
  });

  it('double confirm of one staged proposal from two instances: one delivery, a stored result for the other', async () => {
    const owner = await live(actors.executive);
    const response = await fixture.service.turn(owner, SEND);
    const staged = createStagedStore(fixture.store, { now: () => FIXED_NOW.getTime() });
    const [pending] = await staged.list(owner, response.conversationId, { includeExpired: true });
    expect(pending).toMatchObject({ actionId: 'communication.send', status: 'pending' });

    const outcomes = await Promise.all([
      fixture.service.confirmStagedProposal(owner, pending.id),
      service(second).confirmStagedProposal(owner, pending.id),
    ]);
    // One confirmation delivers. The other either lost the claim (denied, nothing written) or arrived after completion (stored result).
    expect(outcomes.filter(outcome => outcome.outcome === 'executed').length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes.filter(item => item.outcome !== 'executed')) {
      expect(outcome).toMatchObject({ outcome: 'denied', code: 'not_pending' });
    }
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(1);
    const final = await staged.get(owner, pending.id);
    expect(final).toMatchObject({ status: 'completed' });
    expect(final?.claimToken).toBeUndefined();
    // A later retry is a stored result: no second delivery.
    expect(await fixture.service.confirmStagedProposal(owner, pending.id)).toMatchObject({ outcome: 'executed' });
    expect(await listInbox(second, actors.east)).toHaveLength(1);
  });

  it('authority revoked on another instance between preview and confirm: nothing is delivered', async () => {
    const owner = await live(actors.executive);
    const response = await fixture.service.turn(owner, SEND);
    const staged = createStagedStore(fixture.store, { now: () => FIXED_NOW.getTime() });
    const [pending] = await staged.list(owner, response.conversationId, { includeExpired: true });
    expect(pending).toMatchObject({ status: 'pending' });

    await second.transaction(async tx => {
      const profile = await tx.get<Profile>('profiles', 'executive');
      await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(permission => permission !== 'dashboard.share') });
    });
    const denied = await fixture.service.confirmStagedProposal(owner, pending.id);
    expect(denied.outcome).toBe('denied');
    expect(await listInbox(second, actors.east)).toHaveLength(0);
    expect((await staged.get(owner, pending.id))?.status).not.toBe('completed');
  });

  it('overlapping cron ticks on two instances deliver one monitor alert and advance the monitor once', async () => {
    const owner = await live(actors.executive);
    const refuse = async (): Promise<never> => { throw new Error('not available in this test'); };
    const policy = createRecipientPolicy(fixture.store);
    const effects = createEffectBindings({ store: fixture.store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed: policy });
    const ports: ActionPorts = createActionPorts({
      reloadActor: async a => ({ ...(await fixture.store.get<Profile>('profiles', a.id))!, sessionId: a.sessionId, mode: a.mode, modeRevision: a.modeRevision }),
      prepareTool: refuse, confirmPending: refuse, cancelPending: refuse, revisePending: refuse, listPending: async () => [], getDashboard: async () => undefined,
      renameDashboard: refuse, deleteDashboard: refuse, recipientAllowed: policy, staged: createStagedStore(fixture.store, { now: () => now.getTime() }), effects,
    });
    const turn = await fixture.service.turn(owner, 'Show East sales totals for 2026-10-01.');
    const record = await fixture.store.get<{ state: unknown }>('tool_executions', `dynamic:${turn.turnId}`);
    const query = conversationStateRef(conversationStateSchema.parse(record?.state)).id;
    const preview = await executeActionStep({ ports, actor: owner, step: grounded('monitor.create', { query, threshold: 0.8, recipientIds: ['east'] } as never),
      conversationId: 'conv-cron', turnId: 'turn-cron', now: clock });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    if (preview.outcome !== 'proposed') return;
    expect(await confirmProposal({ ports, actor: owner, proposalId: preview.ids.pendingActionId!, now: clock })).toMatchObject({ outcome: 'executed', verified: true });
    const [installed] = await listOwnedMonitors(fixture.store, owner);
    expect(installed).toMatchObject({ status: 'monitor_active' });

    const runner = (store: Store) => createMonitorRunner({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed: createRecipientPolicy(store) });
    const ticks = await Promise.all([runner(fixture.store).tick(), runner(second).tick()]);
    expect(ticks.reduce((sum, tick) => sum + tick.alerts, 0)).toBe(1);
    expect(ticks.reduce((sum, tick) => sum + tick.errors, 0)).toBe(0);
    expect(await listInbox(fixture.store, owner)).toHaveLength(1);
    const [after] = await listOwnedMonitors(second, owner);
    expect(after!.rowVersion).toBeGreaterThan(installed!.rowVersion);
    // The cadence gate now holds both instances: a third tick does not alert again.
    expect((await runner(second).tick()).alerts).toBe(0);
    expect(await listInbox(fixture.store, owner)).toHaveLength(1);
  });

  it('artifact version CAS: two instances revising the same head concurrently, one revision wins and the other conflicts', async () => {
    await fixture.dispose();
    fixture = await seed(); // multi-branch HR/sales fixture the artifact executors expect
    const owner = artifactActors.executive;
    const source = async (): Promise<ArtifactSource> => {
      const message = 'Show sales';
      const result = await executeQueryStep({ ...base(fixture, owner, message), read, step: { kind: 'query', continuation: false, plan: queryProposal(message) } });
      if (result.outcome !== 'accepted') throw new Error('expected accepted query');
      return { stateId: 'state:1', plan: result.plan, bundle: result.bundle, claims: result.claims };
    };
    const stepFor = (over: Partial<ArtifactStep>, title: string): GroundedStep & { step: ArtifactStep } => {
      const artifact: ArtifactStep = { kind: 'artifact', sourceStateId: 'state:1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null,
        title: { value: title, source: 'generated' }, outputFormat: 'preview', visual: null, ...over };
      return { index: 0, step: artifact, params: { title: { name: 'title', value: title, source: 'generated', span: null, serverDefault: false } } };
    };
    const prepare = async (id: string, over: Partial<ArtifactStep> = {}, title = 'ยอดขายรายสาขา'): Promise<ArtifactPreview> => {
      const result = await executeArtifactStep({ store: fixture.store, actor: owner, now: () => FIXED_NOW, step: stepFor(over, title), source: await source(),
        artifacts: createArtifactReader(fixture.store, owner.id), newArtifactId: id });
      if (result.outcome !== 'accepted') throw new Error(`artifact denied: ${result.code}`);
      return result.preview;
    };
    const persist = (store: Store, preview: ArtifactPreview, turnId: string) => store.transaction(async tx => {
      const catalog = createSemanticCatalog(await tx.list<Branch>('branches'));
      return persistArtifactPreview(tx, { preview, authority: { ...authority(owner), catalogDigest: catalog.digest }, conversationId: 'c1', turnId, now: FIXED_NOW.toISOString() });
    });

    await persist(fixture.store, await prepare('artifact-cas'), 't1');
    const revise = (title: string) => prepare('ignored', { operation: 'revise', baseArtifactId: 'artifact-cas', artifactTypeId: 'chart',
      visual: { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data'], animation: 'none' } }, title);
    const [one, two] = [await revise('revision A'), await revise('revision B')];
    expect([one.artifact.revision, two.artifact.revision]).toEqual([2, 2]);

    const results = await Promise.allSettled([persist(fixture.store, one, 't2a'), persist(second, two, 't2b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'ARTIFACT_CONFLICT', status: 409 });
    const reader = createArtifactReader(second, owner.id);
    expect((await reader.head('artifact-cas'))?.revision).toBe(2);
    expect(await reader.latest('artifact-cas')).toMatchObject({ revision: 2 });
    expect(await second.get('tool_executions', 'artifact-version:artifact-cas:3')).toBeUndefined();
  });
});
