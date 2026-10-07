import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { drillArtifact, openArtifactVersion, openSharedArtifact, listArtifactHistory } from '@/lib/router/executors/artifact-read';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { listInbox } from '@/lib/router/ports/effect-store';
import { listWorkItems } from '@/lib/router/ports/work-items';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { listReceipts } from '@/app/api/router-proposals/_view';
import { conversationStateRef } from '@/lib/dynamic/planner/planner';
import { conversationStateSchema } from '@/lib/dynamic/state/conversation';
import { actors, createWorkspaceFixture, BUSINESS_DATE, FIXED_NOW } from '../../helpers/workspace';
import { grounded } from '../executors/action-fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const now = new Date(FIXED_NOW);
const clock = () => new Date(now);
const CONVERSATION = 'conv-artifact-flows';

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
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
    branchesAllowed: async (actor, ids) => { const branches = await store.list<{ id: string; region: string }>('branches'); return ids.every(id => { const b = branches.find(x => x.id === id); return !!b && (actor.regions.includes('*') || actor.regions.includes(b.region)); }); },
  });
  return { ports, store };
}
const step = (ports: ActionPorts, actor: Actor, actionId: string, params: Record<string, string | number | string[]>) =>
  executeActionStep({ ports, actor, step: grounded(actionId, params as never), conversationId: CONVERSATION, turnId: 'turn-artifact-flows', now: clock });
const confirm = (ports: ActionPorts, actor: Actor, proposalId: string) => confirmProposal({ ports, actor, proposalId, now: clock });
const pid = (r: Awaited<ReturnType<typeof step>>) => (r.outcome === 'proposed' ? r.ids.pendingActionId! : '');
const deps = (actor: Actor) => ({ store: fixture.store, actor, now: clock });
const patchPermissions = async (id: string, change: (p: string[]) => string[]) => {
  const profile = await fixture.store.get<Profile>('profiles', id);
  await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: change(profile!.permissions) }));
};

async function chartTurn(actor: Actor, prompt: string) {
  const response = await fixture.service.turn(actor, prompt);
  const artifact = response.artifacts?.[0];
  if (!artifact) throw new Error(`no artifact: ${response.message}`);
  return { response, artifact };
}

describe('artifact families, reload parity and fallback', { timeout: 60_000 }, () => {
  it('a donut chart is persisted with its expression and reloads to the identical spec (preview equals persisted version)', async () => {
    const executive = await liveActor(actors.executive);
    const { artifact } = await chartTurn(executive, 'Make a donut chart of sales across all regions on 2026-10-01.');
    expect(artifact.kind).toBe('chart');
    expect(artifact.spec.visualization).toMatchObject({ primitive: 'donut', animation: { modeId: 'interpolate', reducedMotion: 'respect' } });
    expect(artifact.spec.visualization?.interaction.interactionIds).toEqual(expect.arrayContaining(['tooltip', 'select_point', 'cross_filter', 'reset']));
    const opened = await openArtifactVersion(deps(executive), artifact.id, artifact.revision);
    expect(JSON.stringify(opened.spec)).toBe(JSON.stringify(artifact.spec));
    const history = await listArtifactHistory(deps(executive));
    expect(history.find(item => item.id === artifact.id)).toMatchObject({ kind: 'chart', latestRevision: 1, revisions: [1] });
    // Another actor sees nothing of it.
    expect(await listArtifactHistory(deps(actors.east))).toHaveLength(0);
    await expect(openArtifactVersion(deps(actors.east), artifact.id, 1)).rejects.toMatchObject({ status: 404 });
  });

  it('reload fails closed when the owner loses a read permission', async () => {
    const executive = await liveActor(actors.executive);
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    await patchPermissions('executive', p => p.filter(x => x !== 'operations.read'));
    await expect(openArtifactVersion(deps(executive), artifact.id, 1)).rejects.toMatchObject({ status: 403 });
  });

  it('a family the data cannot support falls back to the exact table and says why', async () => {
    const executive = await liveActor(actors.executive);
    const { response, artifact } = await chartTurn(executive, 'Make a scatter plot of East sales by branch for 2026-10-01.');
    expect(artifact.kind).toBe('table');
    expect(artifact.spec.visualization).toBeNull();
    expect(response.message).toContain('ไม่เหมาะกับข้อมูลนี้');
  });

  it('combo, with a legend toggle on two series, compiles with a single value axis for equal units', async () => {
    const executive = await liveActor(actors.executive);
    const { artifact } = await chartTurn(executive, 'Make a combo chart of East sales and target by branch for 2026-10-01.');
    expect(artifact.spec.visualization).toMatchObject({ primitive: 'combo', axisUnits: ['THB'] });
    expect(artifact.spec.visualization?.interaction.interactionIds).toContain('legend_toggle');
  });
});

describe('drilldown is a linked read under the viewer\'s current authority', { timeout: 60_000 }, () => {
  it('re-runs the registered query for the selected group and is refused after authority is lost', async () => {
    const executive = await liveActor(actors.executive);
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const branch = artifact.spec.facts[0].dimensions.branch;
    const result = await fixture.service.drillArtifact(executive, { artifactId: artifact.id, field: 'branch', value: branch });
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.every(fact => fact.dimensions.branch === branch)).toBe(true);
    expect(result.matchesVersion).toBe(true);
    await expect(fixture.service.drillArtifact(executive, { artifactId: artifact.id, field: 'branch', value: 'NOT_A_BRANCH' })).rejects.toMatchObject({ status: 403 });
    await patchPermissions('executive', p => p.filter(x => x !== 'sales.read'));
    await expect(fixture.service.drillArtifact(executive, { artifactId: artifact.id, field: 'branch', value: branch })).rejects.toBeTruthy();
  });
});

describe('L4/L6 drilldown stays inside the stored scope', { timeout: 60_000 }, () => {
  it('L4: an East default-scoped artifact shared to an all-region viewer re-reads only East', async () => {
    const east = await liveActor(actors.east), executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(east, 'Make a donut chart of sales across all regions on 2026-10-01.');
    const share = await step(ports, east, 'artifact.share', { artifact: artifact.id, recipientIds: ['executive'] });
    expect(share).toMatchObject({ outcome: 'proposed' });
    expect(await confirm(ports, east, pid(share))).toMatchObject({ outcome: 'executed' });
    const [message] = await listInbox(fixture.store, actors.executive);
    const requested: string[] = [];
    const service = fixture.service as unknown as { queryEvidence(actor: Actor, scope: { region: string; branchIds?: string[] }, signal?: AbortSignal): Promise<unknown> };
    const field = Object.keys(artifact.spec.facts[0].dimensions)[0], branch = artifact.spec.facts[0].dimensions[field];
    const result = await drillArtifact({ store: fixture.store, actor: executive, now: clock, businessDate: BUSINESS_DATE,
      read: (scope, signal) => { requested.push(scope.region); return service.queryEvidence(executive, scope, signal) as never; } },
    { artifactId: artifact.id, field, value: branch, messageId: message.id });
    expect(result.facts.length).toBeGreaterThan(0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every(region => region === 'east')).toBe(true);
  });
});

describe('artifact.share', { timeout: 60_000 }, () => {
  it('stages, confirms, delivers a read-only link to the recipient inbox and persists a readable receipt', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const preview = await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['east'] });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    if (preview.outcome !== 'proposed') return;
    expect(preview.preview).toContain('อ่านอย่างเดียว');
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0); // nothing before the explicit confirm
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });

    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ source: 'artifact_share', artifact: { revision: 1, kind: 'chart' } });
    expect(JSON.stringify(inbox)).not.toContain('executive'); // no ids of the sender or other recipients leak to the recipient view
    const shared = await openSharedArtifact(deps(actors.east), inbox[0].id);
    expect(shared.spec.sharedBy).toBeTruthy();
    expect(shared.spec.facts.map(f => [f.claimId, f.value])).toEqual(artifact.spec.facts.map(f => [f.claimId, f.value]));
    expect(await listInbox(fixture.store, actors.hr)).toHaveLength(0);

    const receipts = await listReceipts(fixture.store, executive);
    expect(receipts[0]).toMatchObject({ actionId: 'artifact.share', receipt: { kind: 'artifact_share', recipients: [{ status: 'delivered' }] } });
    expect(await listReceipts(fixture.store, actors.east)).toHaveLength(0);
    // Another recipient cannot open someone else's message.
    await expect(openSharedArtifact(deps(actors.hr), inbox[0].id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a recipient that cannot read the whole stored scope (no partial share) and an unknown recipient with the same denial', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(executive, 'Make a bar chart of sales across all regions on 2026-10-01.');
    const denied = await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['east'] });
    expect(denied).toMatchObject({ outcome: 'denied', code: 'artifact_recipient_scope' });
    expect(await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['hr'] })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['executive'] })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await step(ports, executive, 'artifact.share', { artifact: 'artifact_missing', recipientIds: ['east'] })).toMatchObject({ outcome: 'denied' });
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
  });

  it('rechecks sender and recipient at confirm and the recipient on every open', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const first = await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['east'] });
    await patchPermissions('east', p => p.filter(x => x !== 'operations.read'));
    expect((await confirm(ports, executive, pid(first))).outcome).toBe('denied'); // recipient lost scope between preview and confirm
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
    await patchPermissions('east', p => [...p, 'operations.read']);
    const second = await step(ports, executive, 'artifact.share', { artifact: artifact.id, recipientIds: ['east'] });
    expect((await confirm(ports, executive, pid(second))).outcome).toBe('executed');
    const [message] = await listInbox(fixture.store, actors.east);
    await patchPermissions('east', p => p.filter(x => x !== 'operations.read'));
    await expect(openSharedArtifact(deps(actors.east), message.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe('communication bound to an artifact version, with a persisted receipt', { timeout: 60_000 }, () => {
  it('attaches the exact version, delivers once, and the sender reads the receipt (the recipient sees only the message)', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const record = (await fixture.store.list<{ name: string; state: unknown }>('tool_executions', { actorId: 'executive', status: 'completed' })).find(r => r.name === 'retail.dynamic_query');
    const content = conversationStateRef(conversationStateSchema.parse(record?.state)).id;
    const preview = await step(ports, executive, 'communication.send', { recipientIds: ['east'], content, artifact: artifact.id });
    expect(preview).toMatchObject({ outcome: 'proposed' });
    if (preview.outcome !== 'proposed') return;
    expect(preview.preview).toContain('พร้อมแนบผลลัพธ์');
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });
    const inbox = await listInbox(fixture.store, actors.east);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ source: 'communication', boundArtifact: { revision: 1 } });
    const [receipt] = await listReceipts(fixture.store, executive);
    expect(receipt.receipt).toMatchObject({ kind: 'communication', content: inbox[0].content, artifact: { revision: 1 } });
    expect(JSON.stringify(receipt)).not.toContain('previewToken');
    expect(await listReceipts(fixture.store, actors.east)).toHaveLength(0);
  });

  it('PC-08: the recipient opens the EXACT attached version through the message; a retry adds no duplicate; reopen rechecks current permission', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const { artifact } = await chartTurn(executive, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
    const record = (await fixture.store.list<{ name: string; state: unknown }>('tool_executions', { actorId: 'executive', status: 'completed' })).find(r => r.name === 'retail.dynamic_query');
    const content = conversationStateRef(conversationStateSchema.parse(record?.state)).id;
    const preview = await step(ports, executive, 'communication.send', { recipientIds: ['east'], content, artifact: artifact.id });
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });
    const [message] = await listInbox(fixture.store, actors.east);
    expect(message).toMatchObject({ source: 'communication', boundArtifact: { revision: 1 }, artifact: { revision: 1 } });
    const opened = await openSharedArtifact(deps(actors.east), message.id);
    expect(opened).toMatchObject({ shared: true, artifact: { id: artifact.id, revision: 1 } });
    // Retried confirmation: still ONE message and ONE grant for this recipient.
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed' });
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(1);
    expect(await fixture.store.list('tool_executions', { actorId: 'executive', status: 'artifact_share' })).toHaveLength(1);
    // Another recipient with no message cannot use this message id (404), and a permission shrink closes the open.
    await expect(openSharedArtifact(deps(actors.hr), message.id)).rejects.toMatchObject({ status: 404 });
    await patchPermissions('east', p => p.filter(x => x !== 'operations.read'));
    await expect(openSharedArtifact(deps(actors.east), message.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe('task.create ActionPlan fields', { timeout: 60_000 }, () => {
  it('validates priority, due date, grouping and checklist, expands per branch, notifies the assignee and lists the items', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const eastBranches = (await fixture.store.list<{ id: string; region: string }>('branches')).filter(b => b.region === 'east').map(b => b.id);
    expect(eastBranches.length).toBeGreaterThan(0);
    const fields = { title: 'Follow up', priority: 'urgent', dueDate: '2026-10-05', grouping: 'per_branch', branchIds: eastBranches, checklist: ['Check sales', 'Check stock'], assigneeId: 'east' };
    const preview = await step(ports, executive, 'task.create', fields);
    expect(preview).toMatchObject({ outcome: 'proposed' });
    if (preview.outcome !== 'proposed') return;
    expect(preview.preview).toContain(`${eastBranches.length} รายการ`);
    expect(await listWorkItems(fixture.store, executive)).toHaveLength(0);
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed', verified: true });
    const items = await listWorkItems(fixture.store, executive);
    expect(items).toHaveLength(eastBranches.length);
    expect(items[0]).toMatchObject({ priority: 'urgent', dueDate: '2026-10-05', checklist: ['Check sales', 'Check stock'], assigneeId: 'east' });
    const inbox = await listInbox(fixture.store, actors.east);
    // FW-B: a per-branch expansion sends ONE notification per created item, each linking its exact item (workItemId).
    expect(inbox).toHaveLength(eastBranches.length);
    expect(inbox.every(message => message.source === 'task_assigned')).toBe(true);
    expect(inbox.map(message => message.workItemId).sort()).toEqual(items.map(item => item.id).sort());
    const [receipt] = await listReceipts(fixture.store, executive);
    expect(receipt.receipt.fields).toEqual(expect.arrayContaining([{ label: 'ความสำคัญ', value: 'ด่วน' }]));
    // Retrying the confirmation does not create more work.
    expect(await confirm(ports, executive, pid(preview))).toMatchObject({ outcome: 'executed' });
    expect(await listWorkItems(fixture.store, executive)).toHaveLength(eastBranches.length);
  });

  it('rejects invalid fields and unauthorized assignees', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    expect(await step(ports, executive, 'task.create', { title: 'x', grouping: 'per_branch' })).toMatchObject({ outcome: 'clarify' });
    expect(await step(ports, executive, 'task.create', { title: 'x', priority: 'urgent', assigneeId: 'hr' })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await step(ports, executive, 'task.create', { title: 'x', priority: 'whenever' })).toMatchObject({ outcome: 'clarify' });
    expect(await step(ports, actors.east, 'task.create', { title: 'x', branchIds: ['S01', 'C01'] })).toMatchObject({ outcome: 'denied' });
  });

  it('L1: an assignee without region access to every target branch is refused at prepare (no branch detail reaches their inbox)', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const otherRegion = (await fixture.store.list<{ id: string; region: string }>('branches')).find(b => b.region !== 'east')!;
    const result = await step(ports, executive, 'task.create', { title: 'Follow up', priority: 'high', grouping: 'per_branch', branchIds: [otherRegion.id], assigneeId: 'east' });
    expect(result.outcome).toBe('denied');
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
    expect(await listWorkItems(fixture.store, executive)).toHaveLength(0);
  });

  it('L2: confirm rechecks the creator and the assignee against every target branch inside the write transaction', async () => {
    const executive = await liveActor(actors.executive), { ports } = portsFor();
    const east = (await fixture.store.list<{ id: string; region: string }>('branches')).filter(b => b.region === 'east').map(b => b.id);
    const preview = await step(ports, executive, 'task.create', { title: 'Follow up', priority: 'high', grouping: 'per_branch', branchIds: east, assigneeId: 'east' });
    expect(preview.outcome).toBe('proposed');
    const creator = await fixture.store.get<Profile>('profiles', 'executive');
    await fixture.store.transaction(tx => tx.put('profiles', { ...creator!, regions: ['central'] }));
    const denied = await confirm(ports, executive, pid(preview));
    expect(denied.outcome).not.toBe('executed');
    expect(await listWorkItems(fixture.store, executive)).toHaveLength(0);
    expect(await listInbox(fixture.store, actors.east)).toHaveLength(0);
  });
});
