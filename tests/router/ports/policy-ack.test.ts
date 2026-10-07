import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { listPolicyAcknowledgements } from '@/lib/router/ports/policy-ack';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { listReceipts } from '@/app/api/router-proposals/_view';
import { actionRegistry } from '@/lib/router/action-registry';
import { actors, createWorkspaceFixture, BUSINESS_DATE, FIXED_NOW } from '../../helpers/workspace';
import { grounded } from '../executors/action-fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const now = new Date(FIXED_NOW);
const clock = () => new Date(now);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => {
    await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 'Document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' });
    await tx.put('policy_documents', { id: 'POL-HR-001', title: 'Badge revocation', version: '2.0', text: 'Needs a reason.', updatedAt: '2026-10-01T10:00:00+07:00' });
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

const refuse = async (): Promise<never> => { throw new Error('not available in this test'); };
async function liveActor(base: Actor): Promise<Actor> {
  await fixture.patchSession(base.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...base, mode: 'live_ai', modeRevision: 1 };
}
function portsFor() {
  const { store } = fixture;
  const recipientAllowed = createRecipientPolicy(store);
  const effects = createEffectBindings({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  const ports: ActionPorts = createActionPorts({
    reloadActor: async a => ({ ...(await store.get<Profile>('profiles', a.id))!, sessionId: a.sessionId, mode: a.mode, modeRevision: a.modeRevision }), prepareTool: refuse, confirmPending: refuse,
    cancelPending: refuse, revisePending: refuse, listPending: async () => [], getDashboard: async () => undefined, renameDashboard: refuse, deleteDashboard: refuse,
    recipientAllowed, staged: createStagedStore(store, { now: () => now.getTime() }), effects,
  });
  return ports;
}
const step = (ports: ActionPorts, actor: Actor, params: Record<string, string>) =>
  executeActionStep({ ports, actor, step: grounded('policy.acknowledge', params as never), conversationId: 'conv-policy-ack', turnId: 'turn-policy-ack', now: clock });
const confirm = (ports: ActionPorts, actor: Actor, proposalId: string) => confirmProposal({ ports, actor, proposalId, now: clock });
const pid = (r: Awaited<ReturnType<typeof step>>) => (r.outcome === 'proposed' ? r.ids.pendingActionId! : '');

describe('policy.acknowledge (POLICY-001)', { timeout: 60_000 }, () => {
  it('is registered as a confirm-tier action offered only to actors that can read a policy library', () => {
    expect(actionRegistry.get('policy.acknowledge')).toMatchObject({ riskTier: 'confirm' });
    expect(actionRegistry.availableFor({ permissions: ['operations.read'] }).map(d => d.actionId)).toContain('policy.acknowledge');
    expect(actionRegistry.availableFor({ permissions: ['hr.read'] }).map(d => d.actionId)).toContain('policy.acknowledge');
    expect(actionRegistry.availableFor({ permissions: ['sales.read'] }).map(d => d.actionId)).not.toContain('policy.acknowledge');
  });

  it('stages the exact id+version, writes nothing before confirm, then records one acknowledgement with a readable receipt', async () => {
    const executive = await liveActor(actors.executive), ports = portsFor();
    const preview = await step(ports, executive, { policy: 'POL-OPS-001', version: '1.0' });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    expect(await listPolicyAcknowledgements(fixture.store, executive)).toHaveLength(0);
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });
    const rows = await listPolicyAcknowledgements(fixture.store, executive);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: 'executive', policyId: 'POL-OPS-001', policyVersion: '1.0' });
    const [receipt] = await listReceipts(fixture.store, executive);
    expect(receipt.receipt.fields).toEqual(expect.arrayContaining([{ label: 'เวอร์ชัน', value: '1.0' }, { label: 'รหัสเอกสาร', value: 'POL-OPS-001' }]));
    // Retrying the confirmation records nothing more.
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed' });
    expect(await listPolicyAcknowledgements(fixture.store, executive)).toHaveLength(1);
  });

  it('is idempotent per actor + policy + version: an existing acknowledgement is reported, not staged again', async () => {
    const executive = await liveActor(actors.executive), ports = portsFor();
    await confirm(ports, executive, pid(await step(ports, executive, { policy: 'POL-OPS-001', version: '1.0' })));
    const again = await step(ports, executive, { policy: 'POL-OPS-001', version: '1.0' });
    expect(again).toMatchObject({ outcome: 'updated' });
    expect(await listPolicyAcknowledgements(fixture.store, executive)).toHaveLength(1);
  });

  it('refuses a stale version, a forbidden document and an actor without a readable library', async () => {
    const executive = await liveActor(actors.executive), ports = portsFor();
    expect(await step(ports, executive, { policy: 'POL-OPS-001', version: '0.9' })).toMatchObject({ outcome: 'clarify', code: 'policy_changed' });
    expect(await step(ports, executive, { policy: 'POL-HR-001', version: '2.0' })).toMatchObject({ outcome: 'denied', code: 'policy_unavailable' });
    expect(await step(ports, await liveActor(actors.hr), { policy: 'POL-OPS-001', version: '1.0' })).toMatchObject({ outcome: 'denied' });
  });

  it('re-authorizes at confirm: a revoked permission blocks the effect', async () => {
    const executive = await liveActor(actors.executive), ports = portsFor();
    const preview = await step(ports, executive, { policy: 'POL-OPS-001', version: '1.0' });
    const profile = await fixture.store.get<Profile>('profiles', 'executive');
    await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'operations.read') }));
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'denied' });
    expect(await listPolicyAcknowledgements(fixture.store, executive)).toHaveLength(0);
  });

  it('HR acknowledges only HR documents', async () => {
    const hr = await liveActor(actors.hr), ports = portsFor();
    const preview = await step(ports, hr, { policy: 'POL-HR-001', version: '2.0' });
    expect(await confirm(ports, hr, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });
    expect((await listPolicyAcknowledgements(fixture.store, hr))[0]).toMatchObject({ policyId: 'POL-HR-001', policyVersion: '2.0' });
  });
});
