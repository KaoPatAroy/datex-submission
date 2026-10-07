import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ConversationMessage } from '@/lib/contracts';
import { getFollowUpSuggestions } from '@/lib/core/follow-up-suggestions';
import { ConciergeService } from '@/lib/core/service';
import { defaultRuntimes } from '@/lib/core/runtime-catalog';
import type { AuditEvent } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

type SeenInput = { context: { pendingActions: { id: string }[]; dashboards: unknown[]; catalog: { datasets: { id: string }[] }; pendingClarification: { selection: { id: string; label: string } } }; currentMessage: string };
const planner = vi.hoisted(() => ({ next: undefined as undefined | ((input: SeenInput) => unknown), seen: [] as SeenInput[] }));
vi.mock('@/lib/router/planner/provider', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/router/planner/provider')>();
  return { ...original, requestTurnPlan: async (input: SeenInput, runtime: never) => {
    planner.seen.push(input);
    return planner.next ? planner.next(input) : original.requestTurnPlan(input as never, runtime as never);
  } };
});

async function live(actor: Actor): Promise<Actor> {
  const next = { ...actor, mode: 'live_ai' as const, modeRevision: 1 };
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return next;
}
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 2 as const, requestKey: `req_${Math.random().toString(36).slice(2)}_0123456789`, ...extra });

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.next = undefined; planner.seen = [];
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('finish-B2 service behaviours', { timeout: 30_000 }, () => {
  it('persists the V1 evidence snapshot with a live retail answer so follow-up suggestions are produced', async () => {
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.');
    expect(response.evidence).toBeTruthy();
    const stored = await fixture.store.get<ConversationMessage>('conversation_messages', response.assistantMessageId);
    expect(stored?.evidence?.scope).toMatchObject({ date: '2026-10-01' });
    const suggestions = await getFollowUpSuggestions(fixture.store, actor, response.conversationId, response.assistantMessageId);
    expect(suggestions.status).toBe('ready');
    expect(suggestions.items.length).toBeGreaterThan(0);
  });

  it('AI-proposed follow-ups are safety-filtered, persisted with the answer, and served ahead of the templates', async () => {
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'Show East sales and target for 2026-10-01.');
    const suggestions = await getFollowUpSuggestions(fixture.store, actor, response.conversationId, response.assistantMessageId);
    expect(suggestions.status).toBe('ready');
    expect(suggestions.items.map(item => item.prompt)).toEqual(['เปรียบเทียบกับภูมิภาคอื่นได้ไหม', 'ช่วยสรุปเป็นรายงานสั้น ๆ ให้หน่อย']);
    expect(suggestions.items.every(item => item.label === item.prompt && item.id.startsWith('ai:'))).toBe(true);
    const workspace = await fixture.service.getWorkspace(actor);
    expect(workspace.messages.find(m => m.id === response.assistantMessageId)?.followUps).toHaveLength(2);

    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'advice', prose: 'ถามต่อได้เลยครับ' }],
      followUps: ['ขอดูยอดขาย 5 สาขา', 'ถามเรื่องอื่นได้ไหม', 'ถามเรื่องอื่นได้ไหม', '<b>x</b>'] });
    const advice = await fixture.service.turn(actor, 'any wording');
    const adviceSuggestions = await getFollowUpSuggestions(fixture.store, actor, advice.conversationId, advice.assistantMessageId);
    expect(adviceSuggestions.items.map(item => item.prompt)).toEqual(['ถามเรื่องอื่นได้ไหม']);

    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'advice', prose: 'ถามต่อได้เลยครับ' }], followUps: ['ขอดูยอดขาย 5 สาขา'] });
    const none = await fixture.service.turn(actor, 'any wording two');
    expect((await getFollowUpSuggestions(fixture.store, actor, none.conversationId, none.assistantMessageId)).status).toBe('none');
  });

  it('clarification selection: the choice must belong to the latest clarify turn; the planner receives the server-labelled selection', async () => {
    const actor = await live(actors.east);
    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'clarify', about: { kind: 'query' }, missing: [{ slot: 'region', reason: 'ambiguous' }],
      question: 'Which region?', choices: [{ id: 'east', label: 'ignored model label' }] }] });
    const first = await fixture.service.turn(actor, 'sales please');
    expect(first.clarification).toBe(true);
    expect(first.choices?.map(choice => choice.id)).toEqual(['east']);

    planner.seen = [];
    planner.next = () => ({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'acknowledgement', prose: 'ok' }] });
    const bad = await fixture.service.turn(actor, 'West', first.conversationId, undefined, identity({ clarification: { choiceId: 'west', clarifiedTurnId: first.turnId } }) as never);
    expect(bad.clarification).toBe(true);
    expect(bad.message).toContain('ไม่ตรงกับคำถามล่าสุด');
    expect(planner.seen).toHaveLength(0); // an invalid selection never reaches the planner

    const wrongTurn = await fixture.service.turn(actor, 'East', first.conversationId, undefined, identity({ clarification: { choiceId: 'east', clarifiedTurnId: 'turn_other' } }) as never);
    expect(wrongTurn.message).toContain('ไม่ตรงกับคำถามล่าสุด');

    const ok = await fixture.service.turn(actor, 'East', first.conversationId, undefined, identity({ clarification: { choiceId: 'east', clarifiedTurnId: first.turnId } }) as never);
    expect(ok.message).toContain('ok');
    expect(planner.seen[0].context.pendingClarification.selection).toEqual({ id: 'east', label: expect.any(String) });
    expect(planner.seen[0].context.pendingClarification.selection.label).not.toBe('ignored model label');
  });

  it('concurrent bookkeeping conflicts are retried a bounded number of times', async () => {
    const service = fixture.service as unknown as { bookkeeping<T>(work: (tx: unknown) => Promise<T>): Promise<T>; store: { transaction: unknown } };
    let calls = 0;
    const original = service.store.transaction;
    service.store.transaction = async (work: (tx: unknown) => unknown) => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error('conflict'), { code: 'CONFLICT', definitelyNotCommitted: true });
      return (original as (w: unknown) => unknown).call(fixture.store, work);
    };
    await expect(service.bookkeeping(async () => 'done')).resolves.toBe('done');
    expect(calls).toBe(4);
    calls = -10;
    service.store.transaction = async () => { calls += 1; throw Object.assign(new Error('conflict'), { code: 'CONFLICT', definitelyNotCommitted: true }); };
    await expect(service.bookkeeping(async () => 'x')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(-6); // 4 attempts = initial + 3 retries
    service.store.transaction = original;
  });
});

describe('finish-B2 query/HR service regressions', { timeout: 30_000 }, () => {
  it('HR answers cite sources the read-back fence accepts (never redacted for the owner)', async () => {
    const actor = actors.hr;
    const response = await fixture.service.turn(actor, 'ค้นหาพนักงาน', undefined, undefined, { contractVersion: 2, requestKey: 'req_hr_showcase_0123456789', demoShowcaseId: 'hr-employee' });
    expect(response.sources?.length).toBeGreaterThan(0);
    const workspace = await fixture.service.getWorkspace(actor);
    const stored = workspace.messages.find(message => message.id === response.assistantMessageId);
    expect(stored?.text).not.toContain('อยู่นอกสิทธิ์ปัจจุบัน');
    expect(stored?.text).toBe(response.message);
  });
});

const revoke = async (actorId: string, permission: string) => fixture.store.transaction(async tx => {
  const profile = await tx.get<Record<string, unknown> & { id: string; permissions: string[] }>('profiles', actorId);
  await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(item => item !== permission) });
});
const conversationPlan = () => ({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'acknowledgement', prose: 'ok' }] });

describe('finish-B2 security regressions', { timeout: 60_000 }, () => {
  it('standalone-prepared proposals (no completed chat turn) are never offered to the planner', async () => {
    const actor = await live(actors.executive);
    planner.next = conversationPlan;
    const first = await fixture.service.turn(actor, 'hello');
    const spec = { title: 'Standalone', description: '', scope: { region: 'all', date: '2026-10-01' }, widgets: [{ type: 'metric', title: 'Net', metric: 'net_sales' }] };
    const standalone = await fixture.service.prepare(actor, { kind: 'dashboard_create', spec } as never, { conversationId: first.conversationId, turnId: 'turn_not_completed' });
    planner.seen = [];
    await fixture.service.turn(actor, 'again', first.conversationId);
    const ids = (planner.seen[0].context.pendingActions as { id: string }[]).map(item => item.id);
    expect(ids).not.toContain(standalone.id);
  });

  it('read-back redaction also checks the dataset permissions recorded with the answer', async () => {
    const actor = await live(actors.east);
    const response = await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.');
    expect(response.sources?.length).toBeGreaterThan(0);
    const visible = (await fixture.service.getWorkspace(actor)).messages.find(message => message.id === response.assistantMessageId);
    expect(visible?.text).toBe(response.message);
    await revoke(actor.id, 'operations.read');
    const after = (await fixture.service.getWorkspace(actor)).messages.find(message => message.id === response.assistantMessageId);
    expect(after?.text).toContain('อยู่นอกสิทธิ์ปัจจุบัน');
  });

  it('an uninstalled HR runtime disables HR reads and the planner never sees the dataset', async () => {
    const service = new ConciergeService(fixture.store, { runtimes: defaultRuntimes.filter(runtime => runtime.manifest.id !== 'hr') });
    const response = await service.turn(actors.hr, 'ค้นหาพนักงาน', undefined, undefined, { contractVersion: 2, requestKey: 'req_hr_disabled_0123456789', demoShowcaseId: 'hr-employee' });
    expect(response.sources).toBeUndefined();
    expect(response.clarification).toBe(true);
    const hrLive = await live(actors.hr);
    planner.next = conversationPlan;
    await service.turn(hrLive, 'hello');
    expect((planner.seen.at(-1)!.context.catalog.datasets as { id: string }[]).map(dataset => dataset.id)).not.toContain('hr_employees');
  });

  it('every typed denial leaves a metadata-only denied audit event', async () => {
    const response = await fixture.service.turn(actors.east, 'ยอดขายภาคใต้', undefined, undefined, { contractVersion: 2, requestKey: 'req_denial_audit_0123456789', demoShowcaseId: 'east-denial' });
    expect(response.sources).toBeUndefined();
    const events = (await fixture.store.list<AuditEvent>('audit_events')).filter(event => event.actorId === actors.east.id && event.category === 'denied');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(event => event.summary.includes('ปฏิเสธ'))).toBe(true);
    expect(events.every(event => !event.summary.includes('ภาคใต้'))).toBe(true);
  });

  it('planner context drops dashboards once sales.read is revoked', async () => {
    const actor = await live(actors.executive);
    const created = await fixture.service.turn(actor, 'Create a sales dashboard');
    expect(created.pendingAction?.payload.kind).toBe('dashboard_create');
    planner.next = conversationPlan;
    await fixture.service.turn(actor, 'hello', created.conversationId);
    expect((planner.seen.at(-1)!.context.dashboards as unknown[]).length).toBeGreaterThan(0);
    await revoke(actor.id, 'sales.read');
    await fixture.service.turn(actor, 'hello again', created.conversationId);
    expect(planner.seen.at(-1)!.context.dashboards).toEqual([]);
  });
});
