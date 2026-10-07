import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Table } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import { parseTurnPlan } from '@/lib/router/planner/parse';
import type { TurnPlannerInput } from '@/lib/router/planner/input';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { createSeedData } from '@/lib/seed/generate';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import corpus from './fixtures/real-model-corpus.json';
import { proposal, span } from '../dynamic/fixtures';
import { listPendingProposals } from '@/app/api/router-proposals/_view';

// g3-13 is a recorded model output, replayed verbatim through parse/validate/execute.
// Clarification turns below reconstruct the hosted failure pattern; no hosted raw trace was supplied.
const recorded = corpus.find(entry => entry.id === 'g3-13')!;
const replay = vi.hoisted(() => ({ content: '', inputs: [] as TurnPlannerInput[] }));
vi.mock('@/lib/router/planner/provider', async importOriginal => ({
  ...(await importOriginal<object>()),
  requestTurnPlan: async (input: TurnPlannerInput) => {
    replay.inputs.push(input);
    const parsed = parseTurnPlan(replay.content, input.validator, input.context);
    if (!parsed.success) throw new Error(`Replay parse failed: ${parsed.issuePaths.join(', ')}`);
    return parsed.plan;
  },
}));

let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
let service: ConciergeService;
let actor: Actor;
let clock = 0;
const clarify = (slot: string, actionId = 'task.create') => JSON.stringify({ turnPlanVersion: 1, steps: [{
  kind: 'clarify', about: { kind: 'action', actionId }, missing: [{ slot, reason: 'absent' }], question: '-', choices: [],
}] });
const block = (input: TurnPlannerInput, name: string) => JSON.parse(input.prompt.split('\n').find(line => line.startsWith(`${name}=`))!.slice(name.length + 1));

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  vi.stubEnv('WORKFLOW_V2_ENABLED', 'false');
  fixture = await createWorkspaceFixture();
  const seed = createSeedData('2026-10-01');
  await fixture.store.transaction(async tx => {
    for (const [table, rows] of Object.entries(seed)) for (const row of rows) await tx.put(table as Table, row);
  });
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
  clock = 0; replay.inputs = [];
  service = new ConciergeService(fixture.store, { businessDate: '2026-10-01', now: () => new Date(Date.parse('2026-10-02T05:00:00Z') + clock) });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('task creation recorded-output replay', () => {
  it('reaches a preview after one clarification with the original task/date quotes intact', async () => {
    replay.content = clarify('params.title');
    const first = await service.turn(actor, recorded.user);
    expect(first.clarification).toBe(true);
    clock += 1000;
    replay.content = recorded.content;
    const response = await service.turn(actor, 'ใช้ชื่อ ตรวจสต็อกสาขาภาคตะวันออก', first.conversationId);
    const proposals = await createStagedStore(fixture.store).list(actor, response.conversationId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ actionId: 'task.create', status: 'pending', data: { params: { dueDate: '2026-10-02' } } });
    expect(response.clarification).not.toBe(true);
    expect(block(replay.inputs.at(-1)!, 'CLARIFIED_REQUEST')).toEqual([recorded.user]);
  });

  it('keeps the original task/date after another clarification instead of discarding earlier answers', async () => {
    replay.content = clarify('params.title');
    const first = await service.turn(actor, recorded.user);
    clock += 1000;
    replay.content = clarify('params.note');
    await service.turn(actor, 'ใช้ชื่อ ตรวจสต็อกสาขาภาคตะวันออก', first.conversationId);
    clock += 1000;
    replay.content = recorded.content;
    const response = await service.turn(actor, 'ไม่ต้องมีหมายเหตุ', first.conversationId);
    expect(await createStagedStore(fixture.store).list(actor, response.conversationId)).toHaveLength(1);
    expect(block(replay.inputs.at(-1)!, 'CLARIFIED_REQUEST')).toEqual([recorded.user, 'ใช้ชื่อ ตรวจสต็อกสาขาภาคตะวันออก']);
  });

  it('does not borrow quotes after the planner switches to a different action', async () => {
    replay.content = clarify('params.title');
    const first = await service.turn(actor, recorded.user);
    clock += 1000;
    replay.content = clarify('params.recipientId', 'dashboard.share');
    await service.turn(actor, 'ขอแชร์ Dashboard แทน', first.conversationId);
    clock += 1000;
    replay.content = recorded.content;
    const response = await service.turn(actor, 'ดำเนินการ', first.conversationId);
    expect(await createStagedStore(fixture.store).list(actor, response.conversationId)).toHaveLength(0);
  });

  it('handles a direct topic switch without preparing the old task or carrying it to the following turn', async () => {
    replay.content = clarify('params.title');
    const first = await service.turn(actor, recorded.user);
    clock += 1000;
    replay.content = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'capability' }] });
    const switched = await service.turn(actor, 'ขอถามอย่างอื่น ระบบนี้ทำอะไรได้บ้าง', first.conversationId);
    expect(await createStagedStore(fixture.store).list(actor, first.conversationId)).toHaveLength(0);
    expect(switched.clarification).not.toBe(true);
    expect(replay.inputs.at(-1)!.prompt).toContain('a new request, cancellation or topic switch must not inherit');
    clock += 1000;
    replay.content = recorded.content;
    await service.turn(actor, 'ดำเนินการ', first.conversationId);
    expect(await createStagedStore(fixture.store).list(actor, first.conversationId)).toHaveLength(0);
    expect(replay.inputs.at(-1)!.prompt).not.toContain('CLARIFIED_REQUEST=');
  });

  it('previews a title-like request with a named assignee and Friday date after one assignee clarification', async () => {
    const request = 'สร้างงานให้ผู้จัดการภาคตะวันออกตรวจสอบสาขาที่ต่ำกว่าเป้า ภายในวันศุกร์';
    replay.content = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'clarify', about: { kind: 'action', actionId: 'task.create' },
      missing: [{ slot: 'params.assigneeId', reason: 'ambiguous' }], question: '-', choices: [{ id: 'east', label: 'ผู้จัดการ' }] }] });
    const first = await service.turn(actor, request);
    expect(first.choices?.map(choice => choice.id)).toContain('east');
    clock += 1000;
    // Reconstructed hosted-style plan: the provided acceptance report did not include raw model output.
    replay.content = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'task.create', params: {
      title: { value: 'ตรวจสอบสาขาที่ต่ำกว่าเป้า', source: 'generated' },
      assigneeId: { value: 'east', source: 'context_id' },
      dueDate: { value: '2026-10-02', source: 'user_quoted', evidenceText: 'ภายในวันศุกร์' },
    } }] });
    const response = await service.turn(actor, 'ผู้จัดการที่ใช้งานเดิม', first.conversationId);
    const [proposal] = await createStagedStore(fixture.store).list(actor, response.conversationId);
    expect(proposal).toMatchObject({ actionId: 'task.create', status: 'pending', data: { params: {
      title: 'ตรวจสอบสาขาที่ต่ำกว่าเป้า', assigneeId: 'east', dueDate: '2026-10-02', note: '',
    } } });
    expect(proposal.preview).toContain('2026-10-02');
    expect(proposal.preview).not.toContain('คุณเอง');
    expect(response.clarification).not.toBe(true);
    expect(replay.inputs.at(-1)!.prompt).toContain('only title is required');
    expect(replay.inputs.at(-1)!.prompt).toContain('never ask for a description or note');
  });

  it('previews a query-derived below-target task with the clarified assignee and original due date', async () => {
    const request = 'สร้างงานให้ผู้จัดการภาคตะวันออกตรวจสอบสาขาที่ต่ำกว่าเป้า ภายในวันศุกร์';
    replay.content = clarify('params.title');
    const first = await service.turn(actor, request);
    clock += 1000;
    const reply = 'ชื่อ ตรวจสอบสาขาที่ต่ำกว่าเป้า ให้ผู้จัดการภาคตะวันออก';
    const query = proposal();
    query.measures = ['net_sales', 'target'].map(fieldId => ({ fieldId, aggregation: 'sum',
      interpretation: { value: fieldId, source: 'default', sourceText: null, confidence: 1 } }));
    query.filters = [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit',
      evidenceText: 'ภาคตะวันออก', sourceText: span(reply, 'ภาคตะวันออก'), confidence: 1 }];
    replay.content = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'query', continuation: false, plan: query },
      { kind: 'action', actionId: 'task.create', params: {
        title: { value: 'ตรวจสอบสาขาที่ต่ำกว่าเป้า', source: 'generated' }, assigneeId: { value: 'east', source: 'context_id' },
        dueDate: { value: '2026-10-02', source: 'user_quoted', evidenceText: 'ภายในวันศุกร์' },
        branchesFrom: { value: '$step0', source: 'context_id' }, branchesRule: { value: 'below_target', source: 'generated' },
      } }] });
    const response = await service.turn(actor, reply, first.conversationId);
    const [prepared] = await createStagedStore(fixture.store).list(actor, response.conversationId);
    expect(prepared, response.message).toMatchObject({ actionId: 'task.create', data: { params: { assigneeId: 'east', dueDate: '2026-10-02' } } });
    const ids = prepared.data.params as { branchIds: string[] };
    // Closed-day seed ratios are 0.78/0.62/0.58 for E01/E02/E03 and 1.28 for E04 (generate.ts).
    expect([...ids.branchIds].sort()).toEqual(['E01', 'E02', 'E03']);
    expect(response.clarification).not.toBe(true);
  });

  it('keeps the distinguishing selected account label in both task preview and confirmation details', async () => {
    await fixture.store.transaction(tx => tx.put('profiles', { ...actors.east, id: 'east-operations-v2',
      name: 'Demo East Operations Manager V2 Profile Anchor' }));
    replay.content = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'task.create', params: {
      title: { value: 'ตรวจสอบสาขาที่ต่ำกว่าเป้า', source: 'generated' }, assigneeId: { value: 'east-operations-v2', source: 'context_id' },
    } }] });
    const response = await service.turn(actor, 'สร้างงานให้ผู้จัดการฝ่ายปฏิบัติการภาคตะวันออกตรวจสอบสาขา');
    const selectedLabel = 'ผู้จัดการภาคตะวันออก (East Operations Manager)';
    const [prepared] = await createStagedStore(fixture.store).list(actor, response.conversationId);
    expect(prepared.preview).toContain(selectedLabel);
    const [view] = await listPendingProposals(fixture.store, actor, Date.parse('2026-10-02T05:00:00Z') + clock);
    expect(view.details.assigneeId).toBe(selectedLabel);
    expect(view.preview).toContain(selectedLabel);
    expect(JSON.stringify(view.details)).not.toContain('east-operations-v2');
    expect(prepared.data.params).toMatchObject({ assigneeId: 'east-operations-v2' });
  });
});
