import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Actor, Profile, Store } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import { digest } from '@/lib/core/utils';
import { listConversations, workflowExecutionConversationId } from '@/lib/core/conversations';
import { createHrApprovalWorkflowBindings } from '@/lib/packs/hr-approval-workflows';
import { createWorkflowActionRunner } from '@/lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '@/lib/workflows/action-runtime';
import { createOnboardingQueryService } from '@/lib/workflows/onboarding-queries';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '@/lib/workflows/policy';
import type { OnboardingRequest } from '@/lib/workflows/contracts';
import { showcaseById } from '@/lib/demo/showcase';
import { actionRegistry } from '@/lib/router/action-registry';
import { listPendingProposals } from '@/app/api/router-proposals/_view';
import { createDirectorWorkflowPort, SIMULATED_EMAIL_TOOL, type DirectorWorkflowPort } from '@/lib/router/ports/director-workflow';
import { buildDirectorPlannerContext, directorActionPermitted } from '@/lib/router/ports/director-context';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { createWorkflowSqliteFixture } from '../helpers/workflow-storage';

const NOW = '2026-10-04T04:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const QUEUE = 'Show the onboarding requests waiting for my approval.';
const APPROVE_ALL = 'Approve all the requests I just reviewed.';
const APPROVE_FIRST = 'Approve the first request.';
const EMAIL = 'Email the related people that these requests were approved.';
const DIRECTOR_PERMISSIONS = ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'];

type Key = 'director' | 'manager' | 'admin' | 'executive' | 'east';
interface Harness {
  fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
  store: Store & Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'];
  actors: Record<Key, Actor>;
  identity: Record<'director' | 'manager' | 'admin', string>;
  port: DirectorWorkflowPort;
  service: ConciergeService;
  addRequest(label: string): Promise<string>;
  managerApprove(requestId: string): Promise<void>;
  count(sql: string, ...values: string[]): number;
  request(id: string): Promise<OnboardingRequest>;
  dispose(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const orgUnitId = `org-${suffix}`, branchId = 'E02';
  const profiles: Record<Key, Profile> = {
    director: { id: 'director', name: 'Demo HR Director', role: 'hr_director', active: true, permissions: [...DIRECTOR_PERMISSIONS], regions: ['east'] },
    manager: { id: `manager-${suffix}`, name: 'Synthetic Onboarding Manager', role: 'east_manager', active: true, permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'], regions: ['east'] },
    admin: { id: 'hr', name: 'Demo HR Administrator', role: 'hr_admin', active: true, permissions: ['hr.read', 'badge.revoke', 'hr.onboarding.start'], regions: ['east'] },
    executive: { id: 'executive', name: 'Demo Executive', role: 'executive', active: true, permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'], regions: ['east'] },
    east: { id: 'east', name: 'Demo East Manager', role: 'east_manager', active: true, permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'], regions: ['east'] },
  };
  const actors = Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, { ...profile, sessionId: `session-${key}-${suffix}`, mode: 'live_ai', modeRevision: 1 }])) as Record<Key, Actor>;
  const identity = { director: `identity-director-${suffix}`, manager: `identity-manager-${suffix}`, admin: `identity-admin-${suffix}` };
  const managerConversation = `conversation-manager-${suffix}`;
  await store.transaction(async tx => {
    await tx.put('branches', { id: branchId, name: 'Demo East Branch 2', region: 'east' });
    for (const [key, profile] of Object.entries(profiles)) {
      await tx.put('profiles', profile);
      await tx.put('sessions', { id: actors[key as Key].sessionId, profileId: profile.id, mode: 'live_ai', modeRevision: 1, csrfToken: `csrf-${key}`, expiresAt: '2099-01-01T00:00:00.000Z' });
    }
  });
  const pin = getDemoWorkflowPolicyV1Pin();
  await store.workflowTransaction(async tx => {
    await tx.insertUnique('org_units', { id: orgUnitId, name: 'Synthetic HR Unit', parentOrgUnitId: null, active: true }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
    const definitions = [
      { key: 'director' as const, role: 'hr_director', purpose: 'director_onboarding', name: 'ผู้อำนวยการฝ่ายบุคคล (ทดสอบ)' },
      { key: 'manager' as const, role: 'east_manager', purpose: 'manager_onboarding', name: 'ผู้จัดการผู้ส่งคำขอ (ทดสอบ)' },
      { key: 'admin' as const, role: 'hr_admin', purpose: 'hr_operations', name: 'ผู้ดูแลฝ่ายบุคคล (ทดสอบ)' },
    ];
    for (const definition of definitions) {
      await tx.insertUnique('directory_identities', { id: identity[definition.key], profileId: profiles[definition.key].id, displayName: definition.name, active: true,
        role: definition.role, department: 'hr', orgUnitId, managerIdentityId: null, verifiedDemoEmail: `${definition.key}-${suffix}@example.invalid`, slackIdentity: null,
        allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1 }, { constraint: 'directory_identities_primary_key', values: { id: identity[definition.key] } });
      await tx.insertUnique('responsibilities', { id: `responsibility-${definition.key}-${suffix}`, identityId: identity[definition.key], orgUnitId, purpose: definition.purpose,
        branchIds: [branchId], active: true, rowVersion: 1 }, { constraint: 'responsibilities_open_identity_purpose_unique', values: { identityId: identity[definition.key], purpose: definition.purpose, orgUnitId } });
    }
    await tx.insertUnique('conversations', { id: managerConversation, actorId: profiles.manager.id, title: 'Manager stage', pinned: false, archivedAt: null, rowVersion: 1,
      createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null }, { constraint: 'conversations_primary_key', values: { id: managerConversation } });
    await tx.insertUnique('workflow_policies', { id: `policy-${suffix}`, version: pin.version, digest: pin.digest, policy: demoWorkflowPolicyV1 },
      { constraint: 'workflow_policies_primary_key', values: { id: `policy-${suffix}` } });
  });
  const runtime = createWorkflowActionRuntime({ store, bindings: createHrApprovalWorkflowBindings(), businessDate: BUSINESS_DATE,
    getReleaseRevision: () => 'director-router-test-r1',
    getPackPins: packIds => packIds.map(id => ({ id, version: '1.0', schemaDigest: 'a'.repeat(64), implementationRevision: 'director-router-test-r1' })),
    contextFactory: () => ({ evidence: async () => { throw new Error('no retail evidence in HR approvals'); }, latestDashboard: async () => undefined }),
    now: () => new Date(NOW) });
  const runner = createWorkflowActionRunner(runtime), onboarding = createOnboardingQueryService(runtime);
  const availability = (['onboarding_manager_approve', 'onboarding_director_approve', 'onboarding_return', 'onboarding_start'] as const)
    .map(kind => ({ kind, available: true, reason: null }));
  const port = createDirectorWorkflowPort({ workflow: { runtime, runner, onboarding, availability }, store, now: () => new Date(NOW) });
  const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW), directorWorkflow: async () => port });
  let requestNumber = 0;
  return {
    fixture, store, actors, identity, port, service,
    async addRequest(label) {
      requestNumber += 1;
      const requestId = `req-${label}-${suffix}`, employeeId = `emp-${label}-${suffix}`;
      await store.transaction(tx => tx.put('employees', { id: employeeId, name: `พนักงานใหม่ ${label}`, branchId, active: true }));
      await store.workflowTransaction(async tx => {
        await tx.insertUnique('onboarding_requests', { id: requestId, employeeId, orgUnitId, managerIdentityId: identity.manager, directorIdentityId: identity.director,
          startDate: `2026-10-${String(10 + requestNumber).padStart(2, '0')}`, state: 'manager_review_pending', rowVersion: 1, lifecycleId: `life-${label}-${suffix}`,
          managerApprovalEventId: null, managerApprovedBy: null, managerApprovedAt: null, directorApprovalEventId: null, directorApprovedBy: null, directorApprovedAt: null,
          createdAt: NOW, updatedAt: NOW } satisfies OnboardingRequest, { constraint: 'onboarding_requests_primary_key', values: { id: requestId } });
        for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
          await tx.insertUnique('onboarding_documents', { id: `doc-${label}-${documentType}-${suffix}`, rowVersion: 1, requestId, employeeId, documentType, status: 'accepted',
            policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion, classification: demoWorkflowPolicyV1.classification,
            contentDigest: digest({ requestId, documentType }), createdAt: NOW, withdrawnAt: null },
          { constraint: 'onboarding_documents_request_type_unique', values: { requestId, documentType } });
        }
      });
      return requestId;
    },
    async managerApprove(requestId) {
      const page = await onboarding.managerQueue(actors.manager.sessionId);
      const prepared = await runtime.prepare(actors.manager.sessionId, { kind: 'onboarding_manager_approve', snapshotId: page.snapshot.id, requestIds: [requestId] },
        { conversationId: managerConversation, turnId: `manager-turn-${randomUUID()}` });
      if (!prepared.pendingAction) throw new Error(`manager stage did not prepare: ${JSON.stringify(prepared.reasons)}`);
      const confirmed = await runner.confirm(actors.manager.sessionId, prepared.pendingAction.id, `manager-${randomUUID()}`,
        { conversationId: prepared.pendingAction.conversationId, turnId: prepared.pendingAction.turnId });
      if (confirmed.receipt?.outcome !== 'verified_success') throw new Error('manager stage did not verify');
    },
    count(sql, ...values) {
      const database = fixture.openDatabase();
      try { return Number((database.prepare(sql).get(...values) as { count: number }).count); } finally { database.close(); }
    },
    async request(id) { return (await store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', id))!.body; },
    dispose: () => fixture.dispose(),
  };
}

let h: Harness;
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  h = await createHarness();
});
afterEach(async () => { vi.unstubAllEnvs(); await h.dispose(); });

const directorEvents = () => h.count("SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = 'director'");
const emailRows = async () => (await h.store.list<{ name?: string }>('tool_executions', { actorId: 'director' })).filter(row => row.name === SIMULATED_EMAIL_TOOL).length;
const directorV2Actions = async () => (await h.store.list<{ contractVersion?: number; actorId?: string }>('pending_actions')).filter(row => row.contractVersion === 2 && row.actorId === 'director').length;
const staged = (actor: Actor, conversationId: string) => createStagedStore(h.store).list(actor, conversationId, { includeExpired: true });
async function reviewedQueueTurn(): Promise<{ conversationId: string; text: string }> {
  const response = await h.service.turn(h.actors.director, QUEUE);
  return { conversationId: response.conversationId, text: response.message };
}
async function proposalFor(conversationId: string, actionId: string) {
  return (await staged(h.actors.director, conversationId)).find(row => row.actionId === actionId && row.status === 'pending');
}

describe('HR Director through the unified router (real Workflow V2 runtime)', { timeout: 120_000 }, () => {
  it('reads the queue, approves exactly the reviewed snapshot (not a later arrival), verifies, is idempotent, and never auto-sends Email', async () => {
    const [a, b] = [await h.addRequest('a'), await h.addRequest('b')];
    await h.managerApprove(a); await h.managerApprove(b);

    // 1/3: the Director sees the registered read capability and only authorized requests.
    expect((await h.port.capabilities(h.actors.director)).reads).toContain('director_queue');
    const queue = await reviewedQueueTurn();
    expect(queue.text).toContain('2 รายการ');
    expect(queue.text).toContain('พนักงานใหม่ a');
    expect(queue.text).toContain('พนักงานใหม่ b');

    // 6: a request that reaches the Director queue AFTER the review is not part of "approve all I reviewed".
    const late = await h.addRequest('late');
    await h.managerApprove(late);

    const prepared = await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const proposal = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    expect(proposal, prepared.message).toBeTruthy();
    // 4/5: bound to the immutable snapshot, exactly its request ids.
    expect((proposal!.data.params as { requestIds: string[] }).requestIds.sort()).toEqual([a, b].sort());
    expect(proposal!.preview).toContain('ไม่รวมรายการที่เข้ามาภายหลัง');
    // 10: nothing changed before confirm (no V2 pending action, no event, states unchanged).
    expect(directorEvents()).toBe(0);
    expect(await directorV2Actions()).toBe(0);
    expect((await h.request(a)).state).toBe('director_approval_pending');
    const views = await listPendingProposals(h.store, h.actors.director, Date.parse(NOW));
    expect(views.find(view => view.id === proposal!.id)?.details.requestLabels).toEqual(expect.arrayContaining([expect.stringContaining('พนักงานใหม่ a')]));

    const confirmed = await h.service.confirmStagedProposal(h.actors.director, proposal!.id);
    expect(confirmed).toMatchObject({ outcome: 'executed', verified: true });
    // 11/12: exactly the reviewed rows are director_approved and read back; the later arrival is untouched.
    for (const id of [a, b]) expect(await h.request(id)).toMatchObject({ state: 'director_approved', directorApprovedBy: h.identity.director });
    expect((await h.request(late)).state).toBe('director_approval_pending');
    expect(directorEvents()).toBe(2);
    // 20: a verified, readable receipt with display data only.
    const completed = (await staged(h.actors.director, queue.conversationId)).find(row => row.id === proposal!.id)!;
    const receipt = completed.data.receipt as { fields: { label: string; value: string }[]; lines: string[] };
    expect(receipt.fields).toEqual(expect.arrayContaining([{ label: 'สถานะที่ตรวจแล้ว', value: 'ผู้อำนวยการอนุมัติแล้ว' }, { label: 'จำนวน', value: '2 รายการ' }]));
    expect(JSON.stringify(receipt)).not.toMatch(/snapshot|bindingDigest|example\.invalid|identity-|claim|token/i);
    // 13: a repeated confirm has no duplicate effect.
    expect(await h.service.confirmStagedProposal(h.actors.director, proposal!.id)).toMatchObject({ outcome: 'executed' });
    expect(directorEvents()).toBe(2);
    // 15: approval never sends Email by itself.
    expect(await emailRows()).toBe(0);
    // The V2 operations live in the hidden system conversation, never in the Director's chat list.
    const listed = await listConversations(h.store, 'director', { query: '', limit: 50, includeArchived: true });
    expect(listed.conversations.map(c => c.id)).not.toContain(workflowExecutionConversationId('director'));
    // The workspace stays readable (no legacy-rendered V2 receipt, answer not redacted).
    const workspace = await h.service.getWorkspace(h.actors.director);
    expect(workspace.receipts).toEqual([]);
    expect(workspace.messages.find(m => m.conversationId === queue.conversationId && m.role === 'assistant')?.text).toContain('พนักงานใหม่ a');
  });

  it('demo-mode Director showcase cards (server-owned plans): queue -> approve reviewed -> separate Email, each staged and confirmed', async () => {
    const [a, b] = [await h.addRequest('a'), await h.addRequest('b')];
    await h.managerApprove(a); await h.managerApprove(b);
    const demo: Actor = { ...h.actors.director, mode: 'scripted_demo' };
    await h.store.transaction(tx => tx.put('sessions', { id: demo.sessionId, profileId: 'director', mode: 'scripted_demo', modeRevision: 1, csrfToken: 'csrf-demo', expiresAt: '2099-01-01T00:00:00.000Z' }));
    const card = (id: string, conversationId?: string) => {
      const item = showcaseById('hr_director', id)!;
      return h.service.turn(demo, item.prompt, conversationId, undefined, { contractVersion: 2, requestKey: `req_${id.replaceAll('-', '_')}_0123456789`, demoShowcaseId: id });
    };
    const queue = await card('director-queue');
    expect(queue.message).toContain('2 รายการ');
    await card('director-start-dates', queue.conversationId);
    await card('director-approve-reviewed', queue.conversationId);
    const approve = (await staged(demo, queue.conversationId)).find(row => row.actionId === 'onboarding.director_approve' && row.status === 'pending');
    expect(approve).toBeTruthy();
    expect((approve!.data.params as { requestIds: string[] }).requestIds.sort()).toEqual([a, b].sort());
    expect(directorEvents()).toBe(0);
    expect(await h.service.confirmStagedProposal(demo, approve!.id)).toMatchObject({ outcome: 'executed', verified: true });
    await card('director-email', queue.conversationId);
    const email = (await staged(demo, queue.conversationId)).find(row => row.actionId === 'onboarding.notify_email' && row.status === 'pending');
    expect(email).toBeTruthy();
    expect(await emailRows()).toBe(0);
    expect(await h.service.confirmStagedProposal(demo, email!.id)).toMatchObject({ outcome: 'executed' });
    expect(await emailRows()).toBeGreaterThan(0);
  });

  it('approves an exact subset and leaves the rest of the reviewed queue pending', async () => {
    const [a, b] = [await h.addRequest('a'), await h.addRequest('b')];
    await h.managerApprove(a); await h.managerApprove(b);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_FIRST, queue.conversationId);
    const proposal = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    const ids = (proposal!.data.params as { requestIds: string[] }).requestIds;
    expect(ids).toHaveLength(1);
    expect(await h.service.confirmStagedProposal(h.actors.director, proposal!.id)).toMatchObject({ outcome: 'executed' });
    const other = [a, b].find(id => id !== ids[0])!;
    expect((await h.request(ids[0])).state).toBe('director_approved');
    expect((await h.request(other)).state).toBe('director_approval_pending');
  });

  it('a changed manager-approval proof or employee before confirm rejects the WHOLE batch: no partial approval', async () => {
    for (const change of ['manager_proof', 'employee'] as const) {
      const [a, b] = [await h.addRequest(`${change}-a`), await h.addRequest(`${change}-b`)];
      await h.managerApprove(a); await h.managerApprove(b);
      const queue = await reviewedQueueTurn();
      await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
      const proposal = await proposalFor(queue.conversationId, 'onboarding.director_approve');
      expect(proposal, change).toBeTruthy();
      if (change === 'manager_proof') {
        // 9: the manager identity behind the approval proof changed after the preview (its reviewed row version no longer matches).
        const row = await h.store.workflowProjectionReader.get<Record<string, unknown>>('directory_identities', h.identity.manager);
        await h.store.workflowTransaction(async tx => {
          const changed = await tx.compareAndSwap('directory_identities', h.identity.manager, { rowVersion: row!.rowVersion, state: 'active' },
            { ...row!.body, displayName: 'ผู้จัดการผู้ส่งคำขอ (เปลี่ยนแล้ว)', rowVersion: row!.rowVersion + 1 } as never);
          if (!changed.updated) throw new Error('could not change the manager identity');
        });
      } else {
        // 7: one reviewed request's employee is no longer active.
        const employeeId = (await h.request(b)).employeeId;
        await h.store.transaction(async tx => { await tx.put('employees', { ...(await tx.get<Record<string, unknown> & { id: string }>('employees', employeeId))!, active: false }); });
      }
      const result = await h.service.confirmStagedProposal(h.actors.director, proposal!.id);
      expect(result.outcome, change).toBe('denied');
      expect(result.outcome === 'denied' ? result.text : '').toContain('ไม่ได้ดำเนินการรายการใดเลย');
      // 14: fail closed for every request, including the unchanged one.
      expect((await h.request(a)).state, change).toBe('director_approval_pending');
      expect((await h.request(b)).state, change).toBe('director_approval_pending');
      expect(directorEvents()).toBe(0);
    }
  });

  it('returns an eligible request for revision with the exact reason (separate confirm, verified)', async () => {
    const [a, b] = [await h.addRequest('a'), await h.addRequest('b')];
    await h.managerApprove(a); await h.managerApprove(b);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, 'Return the first request because the signed contract is wrong.', queue.conversationId);
    const proposal = await proposalFor(queue.conversationId, 'onboarding.return');
    expect(proposal?.preview).toContain('the signed contract is wrong');
    const [target] = (proposal!.data.params as { requestIds: string[] }).requestIds;
    expect(await h.service.confirmStagedProposal(h.actors.director, proposal!.id)).toMatchObject({ outcome: 'executed', verified: true });
    expect(await h.request(target)).toMatchObject({ state: 'returned_for_revision', managerApprovalEventId: null });
    expect((await h.request([a, b].find(id => id !== target)!)).state).toBe('director_approval_pending');
  });

  it('a permission revoked before confirm executes nothing', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const proposal = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    await h.store.transaction(async tx => { await tx.put('profiles', { ...(await tx.get<Profile>('profiles', 'director'))!, permissions: ['hr.onboarding.director_read'] }); });
    const result = await h.service.confirmStagedProposal({ ...h.actors.director, permissions: ['hr.onboarding.director_read'] }, proposal!.id);
    expect(result).toMatchObject({ outcome: 'denied', code: 'permission_denied' });
    expect((await h.request(a)).state).toBe('director_approval_pending');
    expect(directorEvents()).toBe(0);
  });

  it('Email: separate proposal + confirm, bound to the verified approval, delivered once, receipt; recipient authority rechecked', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const approval = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    await h.service.confirmStagedProposal(h.actors.director, approval!.id);

    await h.service.turn(h.actors.director, EMAIL, queue.conversationId);
    const email = await proposalFor(queue.conversationId, 'onboarding.notify_email');
    expect(email, 'email proposal').toBeTruthy();
    // 16/17: its own preview, recipients chosen by the server, body carries the verified approval list.
    expect(email!.preview).toContain('ยังไม่ได้ส่ง');
    // The reader sees the server-chosen recipient by name; the simulated mailbox address stays internal.
    expect(email!.preview).toContain('ถึง: ผู้จัดการผู้ส่งคำขอ (ทดสอบ)');
    expect(email!.preview).not.toMatch(/@|example\.invalid/);
    expect(String((email!.data.params as { body: string }).body)).toContain('พนักงานใหม่ a — เริ่มงาน');
    expect(await emailRows()).toBe(0);

    const sent = await h.service.confirmStagedProposal(h.actors.director, email!.id);
    expect(sent).toMatchObject({ outcome: 'executed', verified: true });
    expect(await emailRows()).toBe(1);
    // 19: delivered exactly once, a retry writes nothing.
    await h.service.confirmStagedProposal(h.actors.director, email!.id);
    expect(await emailRows()).toBe(1);
    const receipt = (await staged(h.actors.director, queue.conversationId)).find(row => row.id === email!.id)!.data.receipt as { recipients: unknown[]; fields: { label: string }[] };
    expect(receipt.recipients).toEqual([{ name: 'ผู้จัดการผู้ส่งคำขอ (ทดสอบ)', status: 'delivered' }]);

    // 18: a second Email whose recipient lost its simulated channel before confirm is refused, nothing written.
    await h.service.turn(h.actors.director, EMAIL, queue.conversationId);
    const second = await proposalFor(queue.conversationId, 'onboarding.notify_email');
    const managerRow = await h.store.workflowProjectionReader.get<Record<string, unknown>>('directory_identities', h.identity.manager);
    await h.store.workflowTransaction(async tx => {
      const row = managerRow;
      await tx.compareAndSwap('directory_identities', h.identity.manager, { rowVersion: row!.rowVersion, state: 'active' }, { ...row!.body, allowedChannels: [], rowVersion: row!.rowVersion + 1 } as never);
    });
    expect((await h.service.confirmStagedProposal(h.actors.director, second!.id)).outcome).toBe('denied');
    expect(await emailRows()).toBe(1);
  });
});

describe('PC-03 Director queue and approvals beyond one page (21 requests)', { timeout: 240_000 }, () => {
  const NEXT = 'Show the next onboarding requests waiting for my approval.';
  it('pages the waiting queue by 20 with a truthful continuation, "all reviewed" = exactly the reviewed page, and approvals today lists all 21', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) { const id = await h.addRequest(`p${String(i).padStart(2, '0')}`); await h.managerApprove(id); ids.push(id); }

    // First page: 20 requests, a visible "more" notice, and no claim of a total of 21 (or of 20).
    // A ticking clock keeps the reviewed queues strictly ordered by time (the harness clock is frozen).
    let tick = 0;
    const service = new ConciergeService(h.store, { businessDate: BUSINESS_DATE, now: () => new Date(Date.parse(NOW) + (tick += 1000)), directorWorkflow: async () => h.port });
    const first = await service.turn(h.actors.director, QUEUE);
    expect(first.message).toContain('หน้าแรก 20 รายการ');
    expect(first.message).toContain('ไม่ใช่ยอดรวม');
    expect(first.message).not.toContain('มี 21 รายการ');
    // Second page (continues after the first reviewed queue): exactly the one request that did not fit.
    const second = await service.turn(h.actors.director, NEXT, first.conversationId);
    expect(second.message).toContain('หน้าถัดไป 1 รายการ');
    expect(second.message).not.toContain('ยังมีรายการรออนุมัติอยู่อีก');

    // "Approve all I reviewed" now means exactly the newest reviewed page (1 request), never the 20 on the earlier page or later arrivals.
    await service.turn(h.actors.director, APPROVE_ALL, first.conversationId);
    const proposal = await proposalFor(first.conversationId, 'onboarding.director_approve');
    expect(proposal).toBeTruthy();
    expect((proposal!.data.params as { requestIds: string[] }).requestIds).toHaveLength(1);
    expect(await service.confirmStagedProposal(h.actors.director, proposal!.id)).toMatchObject({ outcome: 'executed', verified: true });
    expect(directorEvents()).toBe(1);

    // The other 20 are still waiting and still reachable: a fresh read shows them as ONE complete page.
    const rest = await service.turn(h.actors.director, QUEUE);
    expect(rest.message).toContain('มี 20 รายการ');
    await service.turn(h.actors.director, APPROVE_ALL, rest.conversationId);
    const second20 = await proposalFor(rest.conversationId, 'onboarding.director_approve');
    expect((second20!.data.params as { requestIds: string[] }).requestIds).toHaveLength(20);
    expect(await service.confirmStagedProposal(h.actors.director, second20!.id)).toMatchObject({ outcome: 'executed', verified: true });
    expect(directorEvents()).toBe(21);
    for (const id of ids) expect((await h.request(id)).state).toBe('director_approved');

    // Approvals today are not cut at 20.
    const today = await h.port.read(h.actors.director, { readId: 'director_approvals_today' });
    expect(today.ok && today.read.readId === 'director_approvals_today' ? today.read.items.length : -1).toBe(21);
    expect(today.ok && today.read.readId === 'director_approvals_today' ? today.read.hasMore : undefined).toBe(false);
  });
});

describe('HR Director bridge guards', { timeout: 120_000 }, () => {
  it('2/24: other roles get no Director capability, no queue details and no onboarding actions', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    for (const key of ['admin', 'manager', 'executive', 'east'] as const) {
      const actor = h.actors[key];
      expect(await h.port.capabilities(actor), key).toEqual({ reads: [], decisions: [] });
      const read = await h.port.read(actor, { readId: 'director_queue' });
      expect(read.ok, key).toBe(false);
      expect(actionRegistry.availableFor(actor).map(d => d.actionId).filter(id => id.startsWith('onboarding.')), key).toEqual([]);
      expect(directorActionPermitted('onboarding.director_approve', await h.port.capabilities(actor))).toBe(false);
    }
    // HR Admin keeps its own capabilities and is still denied the Director decision by the V2 runtime itself.
    const denied = await h.port.bindDecision(h.actors.admin, { kind: 'onboarding_director_approve', snapshotId: 'none', requestIds: [a] });
    expect(denied.ok).toBe(false);
    const executive = await h.service.turn(h.actors.executive, QUEUE);
    expect(executive.message).not.toContain('พนักงานใหม่');
  });

  it('the planner context advertises Director decisions only with a reviewed queue, and Email only after a verified approval', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const capabilities = await h.port.capabilities(h.actors.director);
    expect(capabilities.decisions.sort()).toEqual(['onboarding_director_approve', 'onboarding_return']);
    const before = await buildDirectorPlannerContext({ port: h.port, capabilities, store: h.store, staged: createStagedStore(h.store), actor: h.actors.director, conversationId: 'c-none' });
    expect(before).toMatchObject({ reviewedQueues: [], verifiedApprovals: [] });
    const queue = await reviewedQueueTurn();
    const after = await buildDirectorPlannerContext({ port: h.port, capabilities, store: h.store, staged: createStagedStore(h.store), actor: h.actors.director, conversationId: queue.conversationId });
    expect(after?.reviewedQueues[0]?.requests.map(r => r.id)).toEqual([a]);
    // Another session of the same Director never sees this session's reviewed queue (V2 snapshots are session-bound).
    const other = { ...h.actors.director, sessionId: `${h.actors.director.sessionId}-other` };
    await h.store.transaction(tx => tx.put('sessions', { id: other.sessionId, profileId: 'director', mode: 'live_ai', modeRevision: 1, csrfToken: 'x', expiresAt: '2099-01-01T00:00:00.000Z' }));
    expect((await buildDirectorPlannerContext({ port: h.port, capabilities, store: h.store, staged: createStagedStore(h.store), actor: other, conversationId: queue.conversationId }))?.reviewedQueues).toEqual([]);
  });

  it('21: a delivery that cannot be read back is never reported as sent', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const approval = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    await h.service.confirmStagedProposal(h.actors.director, approval!.id);
    await h.service.turn(h.actors.director, EMAIL, queue.conversationId);
    const email = await proposalFor(queue.conversationId, 'onboarding.notify_email');
    // A store whose simulated-email write silently disappears: the readback must fail the delivery.
    const bound = <T extends object>(target: T, override: (prop: string | symbol) => unknown) => new Proxy(target, { get(t, prop) {
      const replaced = override(prop);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    } });
    const lossy = bound(h.store, prop => prop === 'transaction' ? ((work: (tx: Parameters<Parameters<Store['transaction']>[0]>[0]) => Promise<unknown>) =>
      h.store.transaction(tx => work(bound(tx, inner => inner === 'put' ? async (table: string, row: { name?: string }) => {
        if (table === 'tool_executions' && row.name === SIMULATED_EMAIL_TOOL) return;
        await tx.put(table as never, row as never);
      } : undefined)))) : undefined) as Store;
    const lossyPort = createDirectorWorkflowPort({ workflow: await workflowOf(), store: lossy, now: () => new Date(NOW) });
    const service = new ConciergeService(h.store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW), directorWorkflow: async () => lossyPort });
    const result = await service.confirmStagedProposal(h.actors.director, email!.id);
    expect(result).toMatchObject({ outcome: 'failed', code: 'delivery_unverified' });
    expect(result.text).not.toMatch(/ส่ง Email จำลองแจ้งผลการอนุมัติถึง/);
    expect(await emailRows()).toBe(0);
  });

  it('FW-B: a committed approval whose confirm result is unusable (stale-looking code) reports an UNKNOWN outcome, never "no rows executed"', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const approval = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    const real = await workflowOf();
    // V2 really commits, then the caller only sees an error whose certainty is NOT "definitely not committed".
    const runner = Object.assign(Object.create(real.runner), { confirm: async (...args: Parameters<typeof real.runner.confirm>) => {
      await real.runner.confirm(...args);
      return { receipt: null, error: { code: 'WORKFLOW_STALE', commitCertainty: 'unknown', domainEffect: 'unknown' } };
    } });
    const flaky = createDirectorWorkflowPort({ workflow: { ...real, runner }, store: h.store, now: () => new Date(NOW) });
    const service = new ConciergeService(h.store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW), directorWorkflow: async () => flaky });
    const result = await service.confirmStagedProposal(h.actors.director, approval!.id);
    expect(directorEvents()).toBe(1); // it DID commit
    expect(result).toMatchObject({ outcome: 'failed', code: 'unverified' });
    expect(result.text).toContain('ยังยืนยันผลการดำเนินการไม่ได้ กรุณาตรวจสถานะรายการก่อนส่งคำขอใหม่');
    expect(result.text).not.toContain('ไม่ได้ดำเนินการรายการใดเลย');
  });

  it('FW-B: a confirm that V2 PROVES did not commit keeps the specific denial text', async () => {
    const a = await h.addRequest('a');
    await h.managerApprove(a);
    const queue = await reviewedQueueTurn();
    await h.service.turn(h.actors.director, APPROVE_ALL, queue.conversationId);
    const approval = await proposalFor(queue.conversationId, 'onboarding.director_approve');
    const real = await workflowOf();
    const runner = Object.assign(Object.create(real.runner), { confirm: async () => ({ receipt: null, error: { code: 'WORKFLOW_STALE', commitCertainty: 'definitely_not_committed', domainEffect: 'none' } }) });
    const port = createDirectorWorkflowPort({ workflow: { ...real, runner }, store: h.store, now: () => new Date(NOW) });
    const service = new ConciergeService(h.store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW), directorWorkflow: async () => port });
    const result = await service.confirmStagedProposal(h.actors.director, approval!.id);
    expect(directorEvents()).toBe(0);
    expect(result.text).toContain('ไม่ได้ดำเนินการรายการใดเลย');
  });

  it('FW-B: approvals today follows the engine cursor across pages (bounded), reporting hasMore only beyond the bound', async () => {
    const real = await workflowOf();
    const item = (n: number) => ({ request: { id: `r${n}`, startDate: '2026-10-10' }, employee: { name: `E${n}` }, approval: { approvedAt: NOW } });
    const pager = (total: number) => ({ ...real.onboarding, directorApprovalsToday: async (_session: string, input?: { cursor?: string; limit?: number }) => {
      const from = input?.cursor ? Number(input.cursor) : 0, limit = input?.limit ?? 20, items = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, i) => item(from + i));
      return { asOf: NOW, items, nextCursor: from + limit < total ? String(from + limit) : null };
    } }) as unknown as typeof real.onboarding;
    const read = async (total: number) => {
      const port = createDirectorWorkflowPort({ workflow: { ...real, onboarding: pager(total) }, store: h.store, now: () => new Date(NOW) });
      const out = await port.read(h.actors.director, { readId: 'director_approvals_today' });
      return out.ok && out.read.readId === 'director_approvals_today' ? out.read : undefined;
    };
    expect(await read(75)).toMatchObject({ hasMore: false, items: expect.any(Array) });
    const mid = (await read(190))!;
    expect(mid.items).toHaveLength(190);
    expect(mid.hasMore).toBe(false);
    expect(new Set(mid.items.map(i => i.requestId)).size).toBe(190);
    const capped = (await read(1000))!;
    expect(capped.items).toHaveLength(400);
    expect(capped.hasMore).toBe(true);
  });
});

/** The same V2 runtime composition as the harness (separate instance over the same store). */
async function workflowOf() {
  const runtime = createWorkflowActionRuntime({ store: h.store, bindings: createHrApprovalWorkflowBindings(), businessDate: BUSINESS_DATE,
    getReleaseRevision: () => 'director-router-test-r1',
    getPackPins: packIds => packIds.map(id => ({ id, version: '1.0', schemaDigest: 'a'.repeat(64), implementationRevision: 'director-router-test-r1' })),
    contextFactory: () => ({ evidence: async () => { throw new Error('no retail evidence'); }, latestDashboard: async () => undefined }), now: () => new Date(NOW) });
  return { runtime, runner: createWorkflowActionRunner(runtime), onboarding: createOnboardingQueryService(runtime),
    availability: (['onboarding_director_approve', 'onboarding_return'] as const).map(kind => ({ kind, available: true, reason: null })) };
}
