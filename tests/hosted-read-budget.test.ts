import { createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Store, Dashboard, Actor } from '../lib/contracts';
import { createSeedData } from '../lib/seed/generate';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import { CountingSupabaseClient, asSupabaseClient, type ReadCall } from './helpers/counting-supabase';
import type { WorkflowStoreCapability } from '../lib/storage/workflow-projections';
import { RuntimeCatalog, defaultRuntimes } from '../lib/core/runtime-catalog';
import { assistantMessageId } from '../lib/core/conversation-actions';
import { finalAssistantContentDigest, turnCompletionId, turnCompletionRecordSchema, turnRequestCompletionProofSchema } from '../lib/core/turn-completion-gate';
import { digest } from '../lib/core/utils';
import type { PersistedConversationMessage } from '../lib/workflows/contracts';
import { defaultSalesDashboard } from '../lib/packs/sales-runtime';
import { workItemRowSchema, WORK_ITEM_TOOL, WORK_ITEM_STATUS } from '../lib/router/ports/work-items';
import { workItemStateRowId, workItemTransitionRowId, WORK_ITEM_STATE_TOOL, WORK_ITEM_STATE_STATUS, WORK_ITEM_TRANSITION_TOOL, WORK_ITEM_TRANSITION_STATUS } from '../lib/work-items/lifecycle';
import { inboxRowSchema, INBOX_KIND, MONITOR_NAME } from '../lib/router/ports/effect-store';
import { runMonitorPlan } from '../lib/monitors';
import { accepted, fixture as effectFixture, next } from './wave4/fixtures';

const harness = vi.hoisted(() => ({ store: undefined as Store | undefined, cookie: '' }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: harness.cookie }) }) }));
vi.mock('../lib/storage', async original => ({
  ...await original<typeof import('../lib/storage')>(),
  getStore: async () => harness.store!,
  getWorkflowV2BootstrapResult: async () => null,
}));

import { GET as workspace } from '../app/api/workspace/route';
import { GET as session } from '../app/api/session/route';
import { GET as inbox } from '../app/api/inbox/route';
import { GET as dashboard } from '../app/api/dashboards/[id]/route';
import { GET as dashboardShares } from '../app/api/dashboards/[id]/shares/route';
import { GET as monitors } from '../app/api/monitors/route';
import { GET as workItems } from '../app/api/work-items/route';
import { GET as workItemDetail } from '../app/api/work-items/[id]/route';
import { GET as history } from '../app/api/conversations/route';
import { GET as conversationDetail } from '../app/api/conversations/[id]/route';
import { GET as receipts } from '../app/api/router-proposals/receipts/route';

let client: CountingSupabaseClient;
let actor: Actor;
const now = new Date('2026-10-07T04:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
  vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
  client = new CountingSupabaseClient();
  const seed = createSeedData('2026-10-01');
  for (const [table, rows] of Object.entries(seed) as [string, { id: string }[]][]) client.rows.set(table, rows.map(payload => ({ id: payload.id, payload })));
  const profile = seed.profiles.find(p => p.id === 'executive')!;
  actor = { ...profile, sessionId: 'budget-session', mode: 'live_ai', modeRevision: 0 };
  client.rows.set('sessions', [{ id: actor.sessionId, payload: { id: actor.sessionId, profileId: actor.id, mode: actor.mode, modeRevision: 0, csrfToken: 'budget-csrf', expiresAt: '2026-10-08T04:00:00Z' } }]);
  const signature = createHmac('sha256', process.env.DEMO_SESSION_SECRET!).update(actor.sessionId).digest('hex');
  harness.cookie = `${actor.sessionId}.${signature}`;
  const catalog = new RuntimeCatalog(defaultRuntimes);
  const dashboards: Dashboard[] = Array.from({ length: 12 }, (_, index) => ({
    id: `budget-dashboard-${index}`, ownerId: actor.id, spec: defaultSalesDashboard({ date: '2026-10-01', region: 'all' }),
    packs: catalog.pins(['sales', 'operations']), createdAt: now.toISOString(), updatedAt: now.toISOString(), lastRefreshAt: now.toISOString(),
    sourceMetadata: [], analysis: null, evidenceVersion: 'old',
  }));
  client.rows.set('dashboards', dashboards.map(payload => ({ id: payload.id, payload })));
  const recipients = Array.from({ length: 20 }, (_, i) => ({ ...profile, id: `budget-recipient-${i}`, name: `Recipient ${i}` }));
  client.rows.set('profiles', [...client.rows.get('profiles')!, ...recipients.map(payload => ({ id: payload.id, payload }))]);
  client.rows.set('dashboard_shares', recipients.map((recipient, i) => ({ id: `budget-share-${i}`, payload: { id: `budget-share-${i}`, actorId: actor.id, dashboardId: dashboards[0]!.id, recipientId: recipient.id, active: true, operationKey: `share-key-${i}`, createdAt: now.toISOString() } })));
  const tickets = Array.from({ length: 20 }, (_, index) => ({ ...seed.mock_tickets[0], id: `budget-ticket-${index}`, branchId: seed.branches[index % seed.branches.length]!.id }));
  client.rows.set('mock_tickets', tickets.map(payload => ({ id: payload.id, payload })));
  client.rows.set('action_executions', [{ id: 'budget-ticket-receipt', payload: { id: 'budget-ticket-receipt', actorId: actor.id, actionId: 'budget-ticket-action', kind: 'ticket_create', status: 'verified_success', results: tickets.map(ticket => ({ targetId: ticket.branchId, id: ticket.id, status: 'verified_success', detail: 'created' })), createdAt: now.toISOString(), verifiedAt: now.toISOString() } }]);
  const task = workItemRowSchema.parse({ id: 'budget-task', name: WORK_ITEM_TOOL, status: WORK_ITEM_STATUS, actorId: actor.id, assigneeId: actor.id, proposalId: 'budget-proposal', operationKey: 'budget-task-key',
    title: 'Budget task', priority: 'normal', dueDate: null, grouping: 'single', checklist: [], branchIds: [], note: null, state: 'open', createdAt: now.toISOString(), digest: 'task-digest' });
  const taskRows = [task, { id: workItemStateRowId(task.id), name: WORK_ITEM_STATE_TOOL, status: WORK_ITEM_STATE_STATUS, actorId: actor.id, workItemId: task.id, state: 'open', revision: 50, updatedAt: now.toISOString(), edits: {}, completedAt: null, cancelledAt: null, archivedAt: null },
    ...Array.from({ length: 50 }, (_, i) => ({ id: workItemTransitionRowId(task.id, i + 1), name: WORK_ITEM_TRANSITION_TOOL, status: WORK_ITEM_TRANSITION_STATUS, actorId: actor.id, workItemId: task.id,
      role: 'creator', op: 'edit', from: 'open', to: 'open', revision: i + 1, at: now.toISOString() })),
    ...Array.from({ length: 20 }, (_, i) => ({ ...task, id: `assigned-task-${i}`, actorId: 'east', assigneeId: actor.id, branchIds: [seed.branches[i % seed.branches.length]!.id] })),
  ];
  const f = effectFixture();
  let out = accepted(runMonitorPlan({ request: { phase: 'preview', plan: f.monitor }, context: f.context }));
  for (const phase of ['confirm', 'execute', 'verify'] as const) out = accepted(runMonitorPlan({ request: next(phase, out.state.workflow), state: out.state, context: f.context }));
  const monitorRows = Array.from({ length: 20 }, (_, i) => ({ id: `budget-monitor-${i}`, name: MONITOR_NAME, status: 'monitor_active', actorId: actor.id, sessionId: actor.sessionId, mode: actor.mode, modeRevision: 0,
    conversationId: null, proposalId: `monitor-proposal-${i}`, title: `Monitor ${i}`, rowVersion: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: now.getTime() + 86400000,
    state: out.state, bound: { query: f.context.queries[0], claims: f.context.claims, evidence: f.context.evidence, consent: f.context.consents[0], dataset: { id: 'branch_performance', permissions: ['sales.read'] } }, lastEvaluatedAt: null, lastError: null, lastAlertId: null }));
  client.rows.set('tool_executions', [...taskRows, ...monitorRows].map(payload => ({ id: payload.id, payload })));
  client.rows.set('mock_messages', Array.from({ length: 80 }, (_, i) => {
    const payload = inboxRowSchema.parse({ id: `budget-inbox-${i}`, kind: INBOX_KIND, actorId: 'east', senderName: 'East manager', recipientId: i < 60 ? actor.id : 'hr', source: 'communication',
      title: `Inbox ${i}`, content: 'Bound inbox content', channelId: 'simulated_inbox', operationKey: `inbox-key-${i}`, planDigest: 'digest', target: { id: 'target', version: 1, digest: 'a'.repeat(64) }, createdAt: now.toISOString(), readAt: null });
    return { id: payload.id, payload };
  }));
  client.rows.set('conversations', [{ id: 'budget-conversation', payload: { id: 'budget-conversation', actorId: actor.id, title: 'Budget conversation', createdAt: now.toISOString(), updatedAt: now.toISOString() } }]);
  // Completed chat turns require request ledgers and both anchors, not just completion lookups.
  client.rows.set('conversation_messages', Array.from({ length: 40 }, (_, index) => {
    const tuple = { actorId: actor.id, sessionId: actor.sessionId, conversationId: 'budget-conversation', turnId: `budget-turn-${index}`, mode: actor.mode, modeRevision: 0 };
    const user: PersistedConversationMessage = { ...tuple, id: tuple.turnId, role: 'user', text: `คำถามที่ได้รับอนุญาต ${index}`, createdAt: now.toISOString() };
    const assistant: PersistedConversationMessage = { ...tuple, id: assistantMessageId(actor.id, tuple), role: 'assistant', text: `สรุปข้อมูลที่ได้รับอนุญาต ${index}`, createdAt: now.toISOString(),
      sources: [{ id: 'sales:E01:2026-10-01', system: 'sales', observedAt: now.toISOString(), retrievedAt: now.toISOString(), freshness: 'fresh', detail: 'Authorized sales source' }] };
    const finalContentDigest = finalAssistantContentDigest(assistant);
    const requestLedger = turnRequestCompletionProofSchema.parse({ ...tuple, id: `budget-request-${index}`, name: 'chat.turn_request', status: 'completed', createdAt: now.toISOString(),
      intentHash: digest({ actorId: actor.id, sessionId: actor.sessionId, conversationId: tuple.conversationId, message: user.text }), finalContentDigest, finalActionIds: [] });
    const completion = turnCompletionRecordSchema.parse({ ...tuple, id: turnCompletionId(tuple), name: 'chat.turn_completion', schemaVersion: 1, origin: 'chat', status: 'completed',
      requestLedgerId: requestLedger.id, assistantMessageId: assistant.id, finalContentDigest, finalActionIds: [], createdAt: now.toISOString() });
    client.rows.get('tool_executions')!.push(...[requestLedger, completion].map(payload => ({ id: payload.id, payload })));
    return [user, assistant].map(payload => ({ id: payload.id, payload }));
  }).flat());
  client.rows.get('conversation_messages')!.push({ id: 'unrelated-message', payload: { id: 'unrelated-message', actorId: actor.id, sessionId: actor.sessionId, conversationId: 'unrelated-conversation', turnId: 'unrelated-turn', role: 'assistant', text: 'unrelated prose', mode: actor.mode, modeRevision: 0, createdAt: now.toISOString() } });
  harness.store = createSupabaseStoreFromClient(asSupabaseClient(client));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const request = (path: string) => new NextRequest(`http://localhost${path}`);
const isCompletionProofBatch = (read: ReadCall, stage: 'request ledgers' | 'anchors') =>
  read.table === (stage === 'request ledgers' ? 'tool_executions' : 'conversation_messages') && read.filters.some(filter =>
    filter.column === 'id' && Array.isArray(filter.value) && filter.value.includes(stage === 'request ledgers' ? 'budget-request-0' : 'budget-turn-0'));
describe('hosted authenticated GET round-trip budgets (warm store, no conflicts)', () => {
  it.each([
    ['workspace/dashboard list', () => workspace(), 22],
    ['session', () => session(), 4],
    ['inbox', () => inbox(request('/api/inbox')), 5],
    ['dashboard detail', () => dashboard(request('/api/dashboards/budget-dashboard-0'), { params: Promise.resolve({ id: 'budget-dashboard-0' }) }), 11],
    ['monitor list', () => monitors(request('/api/monitors')), 5],
    ['work items', () => workItems(request('/api/work-items')), 8],
    ['ticket work items', () => workItems(request('/api/work-items?scope=tickets')), 10],
    ['assigned work items', () => workItems(request('/api/work-items?scope=assigned')), 9],
    ['work item history detail', () => workItemDetail(request('/api/work-items/budget-task'), { params: Promise.resolve({ id: 'budget-task' }) }), 9],
    ['history', () => history(request('/api/conversations')), 5],
    ['receipt history', () => receipts(request('/api/router-proposals/receipts')), 5],
  ] as const)('%s stays within its HTTP budget', async (name, get, budget) => {
    const response = await get();
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    console.info(`HTTP budget ${name}: ${client.reads.length}`);
    if (name === 'workspace/dashboard list') {
      expect(body.dashboards).toHaveLength(12);
      expect(body.messages).toHaveLength(81);
      expect(body.messages.filter((message: { role: string; conversationId: string }) => message.role === 'assistant' && message.conversationId === 'budget-conversation').map((message: { text: string }) => message.text).sort())
        .toEqual(Array.from({ length: 40 }, (_, index) => `สรุปข้อมูลที่ได้รับอนุญาต ${index}`).sort());
      expect(body.messages.find((message: { id: string }) => message.id === 'unrelated-message').text).toBe('ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน');
    }
    if (name === 'ticket work items') expect(body.items).toHaveLength(20);
    if (name === 'assigned work items') expect(body.items).toHaveLength(20);
    if (name === 'work item history detail') expect(body.history).toHaveLength(50);
    if (name === 'monitor list') { expect(body.monitors).toHaveLength(10); expect(body.total).toBe(20); }
    if (name === 'inbox') { expect(body.messages).toHaveLength(50); expect(body.total).toBe(60); }
    expect(client.reads.length).toBeLessThanOrEqual(budget);
    expect(client.reads.filter(r => r.table === 'appmeta')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });
});

describe('dashboard shares and exact conversation history', () => {
  it('preserves authorized content from all 40 completed chat turns and batches every completion proof', async () => {
    const response = await conversationDetail(request('/api/conversations/budget-conversation?limit=100'), { params: Promise.resolve({ id: 'budget-conversation' }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.pagination.total).toBe(80);
    expect(body.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { text: string }) => message.text).sort())
      .toEqual(Array.from({ length: 40 }, (_, index) => `สรุปข้อมูลที่ได้รับอนุญาต ${index}`).sort());
    expect(client.reads.some(read => read.table === 'tool_executions' && read.filters.some(filter => filter.column === 'id' && Array.isArray(filter.value) && filter.value.includes('budget-request-0')))).toBe(true);
    expect(client.reads.some(read => read.table === 'conversation_messages' && read.filters.some(filter => filter.column === 'id' && Array.isArray(filter.value) && filter.value.includes('budget-turn-0')))).toBe(true);
    expect(client.reads).toHaveLength(12);
    expect(client.reads.filter(read => read.table === 'appmeta')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('bounds evidence reads across distinct dashboard dates and branch scopes', async () => {
    client.rows.get('dashboards')!.forEach((row, index) => {
      const payload = row.payload as Dashboard;
      const date = new Date(Date.UTC(2026, 8, 20 + index)).toISOString().slice(0, 10);
      payload.spec.scope = { date, region: 'all', branchIds: [`E0${index % 3 + 1}`] };
    });
    const response = await workspace();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dashboards).toHaveLength(12);
    for(const dashboard of body.dashboards as Dashboard[])expect(dashboard.spec.scope).toEqual((client.rows.get('dashboards')!.find(row=>row.id===dashboard.id)!.payload as Dashboard).spec.scope);
    console.info(`HTTP budget workspace distinct scopes: ${client.reads.length}`);
    expect(client.reads.length).toBeLessThanOrEqual(30);
  });
  it.each([{ active: 'false' }, { permissions: 'sales.read' }, { regions: '*' }])('rejects malformed current profile fields %j before authenticated reads', async changes => {
    const row = client.rows.get('profiles')!.find(profile => profile.id === actor.id)!;
    row.payload = { ...row.payload as object, ...changes };
    expect((await session()).status).toBe(401);
    expect((await workspace()).status).toBe(401);
  });
  it('batches dashboard share recipients inside the authenticated snapshot', async () => {
    const response = await dashboardShares(request('/api/dashboards/budget-dashboard-0/shares'), { params: Promise.resolve({ id: 'budget-dashboard-0' }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.shares).toHaveLength(20);
    expect(client.reads.length).toBeLessThanOrEqual(7);
    expect(client.reads.filter(r => r.table === 'appmeta')).toHaveLength(2);
    expect(client.reads.find(r => r.table === 'dashboard_shares')!.filters).toContainEqual({ kind: 'eq', column: 'payload->>dashboardId', value: 'budget-dashboard-0' });
  });
  it('scopes conversation history and its completion proofs to the selected conversation', async () => {
    client.rows.get('tool_executions')!.push({ id:'unrelated-extra',payload:{id:'unrelated-extra',name:'router.turn_extras',status:'completed',actorId:actor.id,conversationId:'unrelated-conversation',turnId:'unrelated-turn',assistantMessageId:'unrelated-message',followUps:['unrelated suggestion']} });
    const response = await conversationDetail(request('/api/conversations/budget-conversation?limit=100'), { params: Promise.resolve({ id: 'budget-conversation' }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.messages).toHaveLength(80);
    expect(body.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { text: string }) => message.text).sort())
      .toEqual(Array.from({ length: 40 }, (_, index) => `สรุปข้อมูลที่ได้รับอนุญาต ${index}`).sort());
    console.info(`HTTP budget conversation detail: ${client.reads.length}`);
    expect(client.reads.length).toBeLessThanOrEqual(12);
    expect(client.reads.filter(r => r.table === 'dashboards' || r.table === 'mock_messages' || r.table === 'sales_orders')).toHaveLength(0);
    expect(client.reads.find(r => r.table === 'conversation_messages')!.filters).toContainEqual({ kind: 'eq', column: 'payload->>conversationId', value: 'budget-conversation' });
    expect(client.reads.filter(r => r.table === 'tool_executions').some(r => r.filters.some(f => Array.isArray(f.value) && f.value.some(v => String(v).includes('unrelated'))))).toBe(false);
    const extrasRead=client.reads.find(read=>read.table==='tool_executions'&&read.filters.some(filter=>filter.column==='payload->>status'&&filter.value==='completed'))!;
    expect(extrasRead.filters).toContainEqual({kind:'eq',column:'payload->>conversationId',value:'budget-conversation'});
  });
  it('falls back safely when retained action scopes exceed the filter-value budget', async () => {
    const spec=(client.rows.get('dashboards')![0]!.payload as Dashboard).spec;
    client.rows.set('pending_actions',Array.from({length:989},(_,index)=>{
      const id=`old-action-${index}`,date=new Date(Date.UTC(2020,0,index+1)).toISOString().slice(0,10);
      const payload={id,actorId:actor.id,sessionId:actor.sessionId,conversationId:'budget-conversation',turnId:`old-turn-${index}`,mode:actor.mode,modeRevision:0,status:'stale',payload:{kind:'dashboard_create',spec:{...spec,scope:{region:'all',date}}}};
      return{id,payload};
    }));
    const response=await conversationDetail(request('/api/conversations/budget-conversation'),{params:Promise.resolve({id:'budget-conversation'})});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(50);
    expect(body.pagination.total).toBe(80);
  });
  it('uses the physical indexed id for legacy batches', async () => {
    await harness.store!.list('mock_tickets', { id: ['budget-ticket-0', 'budget-ticket-1'] });
    expect(client.reads[0]!.filters).toContainEqual({ kind: 'in', column: 'id', value: ['budget-ticket-0', 'budget-ticket-1'] });
  });
});

describe('request snapshot consistency and isolation', () => {
  it.each([
    ['workspace', 'request ledgers'], ['workspace', 'anchors'],
    ['conversation', 'request ledgers'], ['conversation', 'anchors'],
  ] as const)('sees profile revocation during completed-turn %s %s reads', async (surface, stage) => {
    let revoked = false;
    client.onRead = read => {
      if (revoked || !isCompletionProofBatch(read, stage)) return;
      revoked = true;
      const profile = client.rows.get('profiles')!.find(row => row.id === actor.id)!;
      profile.payload = { ...profile.payload as object, active: false };
      client.revision++;
    };
    const response = surface === 'workspace' ? await workspace()
      : await conversationDetail(request('/api/conversations/budget-conversation?limit=100'), { params: Promise.resolve({ id: 'budget-conversation' }) });
    expect(revoked).toBe(true);
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('messages');
    expect(client.reads.filter(read => read.table === 'sessions')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it.each(['permissions', 'regions'] as const)('redacts completed answers when current %s change during proof reads', async field => {
    let changed = false;
    client.onRead = read => {
      if (changed || !isCompletionProofBatch(read, 'request ledgers')) return;
      changed = true;
      const profile = client.rows.get('profiles')!.find(row => row.id === actor.id)!;
      profile.payload = { ...profile.payload as object, [field]: field === 'permissions' ? actor.permissions.filter(permission => permission !== 'sales.read') : ['south'] };
      client.revision++;
    };
    const response = await conversationDetail(request('/api/conversations/budget-conversation?limit=100'), { params: Promise.resolve({ id: 'budget-conversation' }) });
    const body = await response.json();
    expect(changed).toBe(true);
    expect(response.status, JSON.stringify(body)).toBe(200);
    const answers = body.messages.filter((message: { role: string }) => message.role === 'assistant');
    expect(answers).toHaveLength(40);
    expect(answers.every((message: { text: string; sources?: unknown }) => message.text === 'ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน' && message.sources === undefined)).toBe(true);
    expect(body.messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text).sort())
      .toEqual(Array.from({ length: 40 }, (_, index) => `คำถามที่ได้รับอนุญาต ${index}`).sort());
    expect(client.reads.filter(read => read.table === 'sessions')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it.each(['empty', 'saved'] as const)('keeps the workspace available with %s dashboards and data_unavailable when inventory preloading hits a pool timeout', async dashboards => {
    if (dashboards === 'empty') client.rows.set('dashboards', []);
    client.readFailure = call => call.table === 'inventory_snapshots' ? { code: 'PGRST003', message: 'Controlled pool timeout' } : undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await workspace();
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.actionCatalogStatus).toBe('data_unavailable');
    expect(body.actor.id).toBe(actor.id);
    expect(body.dashboards).toEqual([]);
    expect(client.reads.filter(read => read.table === 'appmeta')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('revalidates the revision and sees revocation after an optional preload fails', async () => {
    client.rows.set('dashboards', []);
    let revoked = false;
    client.readFailure = call => {
      if (call.table !== 'inventory_snapshots') return undefined;
      if (!revoked) {
        revoked = true;
        const profile = client.rows.get('profiles')!.find(row => row.id === actor.id)!;
        profile.payload = { ...profile.payload as object, active: false };
        client.revision++;
      }
      return { code: 'PGRST003', message: 'Controlled pool timeout' };
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await workspace();
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('messages');
    expect(client.reads.filter(read => read.table === 'sessions')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it.each(['42P01', '42501', '40001'])('does not swallow preload schema, authorization or revision failures (%s)', async code => {
    client.rows.set('dashboards', []);
    client.readFailure = call => call.table === 'inventory_snapshots' ? { code, message: 'Controlled hard failure' } : undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await workspace();
    expect(response.status).toBe(code === '40001' ? 409 : 503);
    expect(await response.json()).not.toHaveProperty('messages');
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('coalesces independent projected readers and reuses their rows across nested workflow reads', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    client.project('branches', { id: 'projected-branch', name: 'Projected branch', region: 'east' });
    await store.readSnapshot!(async () => {
      await Promise.all([1, 2].map(() => store.workflowProjectionReader.get('branches', 'projected-branch')));
      await (store as Store & WorkflowStoreCapability).workflowTransaction(async tx => { expect((await tx.workflowProjectionReader.get('branches', 'projected-branch'))?.id).toBe('projected-branch'); });
    });
    expect(client.reads.filter(r => r.table === 'branches')).toHaveLength(1);
    expect(client.reads.filter(r => r.table === 'appmeta')).toHaveLength(2);
  });
  it('shares one revision pair with nested legacy read transactions and caches missing batched ids', async () => {
    const store = harness.store!;
    await store.readSnapshot!(async () => {
      await store.list('tool_executions', { id: ['missing-a', 'missing-b'] });
      expect(await store.get('tool_executions', 'missing-a')).toBeUndefined();
      await store.transaction(async tx => {
        expect(await tx.get('tool_executions', 'missing-b')).toBeUndefined();
        await Promise.all([tx.list('profiles'), tx.list('profiles')]);
      });
    });
    expect(client.reads.map(r => r.table)).toEqual(['appmeta', 'tool_executions', 'profiles', 'appmeta']);
  });
  it('reuses complete supersets but never widens a narrower or bounded cached selection', async () => {
    const store = harness.store!;
    await store.readSnapshot!(async () => {
      await store.list('branches', { region: 'east' });
      await store.list('branches');
      const east = await store.list<{ region: string }>('branches', { region: 'east' });
      expect(east.every(row => row.region === 'east')).toBe(true);
    });
    expect(client.reads.filter(r => r.table === 'branches')).toHaveLength(2);
    client.reads.length = 0;
    await store.readSnapshot!(async () => {
      await store.list('branches', undefined, { limit: 1 });
      expect((await store.list('branches')).length).toBeGreaterThan(1);
    });
    expect(client.reads.filter(r => r.table === 'branches')).toHaveLength(2);
  });

  it('replays the entire authenticated result on a concurrent revision change and sees revocation', async () => {
    let changed = false;
    client.onRead = call => {
      if (call.table === 'branches' && !changed) {
        changed = true;
        client.revision++;
        const profile = client.rows.get('profiles')!.find(r => r.id === actor.id)!;
        profile.payload = { ...profile.payload as object, active: false };
      }
    };
    const response = await workspace();
    expect(response.status).toBe(401);
    expect(client.reads.filter(r => r.table === 'sessions')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('rejects writes in either transaction API inside a GET snapshot', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    await expect(store.readSnapshot!(async () => store.transaction(tx => tx.put('profiles', { id: 'unexpected' })))).rejects.toThrow('Writes are forbidden');
    await expect(store.readSnapshot!(async () => store.workflowTransaction(tx => tx.insertUnique('profiles', { id: 'unexpected' }, { constraint: 'profiles_primary_key', values: { id: 'unexpected' } })))).rejects.toThrow('Writes are forbidden');
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('keeps caches isolated across overlapping requests and refreshes on the next request', async () => {
    const store = harness.store!;
    await Promise.all([1, 2].map(() => store.readSnapshot!(async () => {
      const first = await store.get<{ name: string }>('profiles', actor.id);
      first!.name = 'local mutation';
      expect((await store.get<{ name: string }>('profiles', actor.id))!.name).not.toBe('local mutation');
    })));
    expect(client.reads.filter(r => r.table === 'profiles')).toHaveLength(2);
    expect(client.reads.filter(r => r.table === 'appmeta')).toHaveLength(4);
    const profile = client.rows.get('profiles')!.find(r => r.id === actor.id)!;
    profile.payload = { ...profile.payload as object, name: 'fresh name' };
    client.revision++;
    await store.readSnapshot!(async () => expect((await store.get<{ name: string }>('profiles', actor.id))!.name).toBe('fresh name'));
  });
});
