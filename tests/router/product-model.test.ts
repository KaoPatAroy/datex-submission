import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import { ACTION_COPY } from '@/lib/router/action-copy';
import type { PlannerContext } from '@/lib/router/planner-context';
import { buildTurnPlannerInput, type TurnPlannerInput } from '@/lib/router/planner/input';
import { canonicalizeModelPlan } from '@/lib/router/planner/canonicalize';
import { PLANNER_EXAMPLES } from '@/lib/router/planner/examples';
import { SCRIPTED_PRODUCT_HELP, scriptedTurnPlan, ScriptedTurnPlannerFixtureMissing } from '@/lib/router/planner/scripted';
import {
  accountCapability, PRODUCT_CONCEPT_IDS, PRODUCT_CONCEPT_TEXT, PRODUCT_MODEL, PRODUCT_MODEL_MAX_BYTES, PRODUCT_MODEL_VERSION, PRODUCT_OVERVIEW_TEXT,
} from '@/lib/router/product-model';
import { renderConversation } from '@/lib/router/render';
import { validateTurnPlan } from '@/lib/router/validate';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import type { Branch } from '@/lib/contracts';
import { LEGACY_USER_TEXT_OFFENDERS } from '../architecture/user-text-legacy-allowlist';
import { actors, createWorkspaceFixture, profiles } from '../helpers/workspace';
import { plan, planner } from '../helpers/turn-planner';
import { contextFor, fullCapabilityContext } from './fixtures';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

const MODEL_LINE = `PRODUCT_MODEL=${JSON.stringify(PRODUCT_MODEL)}`;
const promptLine = (prompt: string, name: string) => prompt.split('\n').find(line => line.startsWith(`${name}=`));
const capabilityOf = (prompt: string) => JSON.parse(promptLine(prompt, 'ACCOUNT_CAPABILITY')!.slice('ACCOUNT_CAPABILITY='.length)) as { unavailable: string[] };

/** Planner input -> scripted model plan -> server validation -> server rendering (the live path minus the provider). */
function answer(context: PlannerContext, message: string, raw?: unknown) {
  const input = buildTurnPlannerInput(context, { current: message });
  const validation = validateTurnPlan({ raw: raw ?? scriptedTurnPlan(input), messages: { current: message }, context, registry: actionRegistry,
    hooks: { isSafeText: () => true } });
  if (validation.outcome !== 'accepted') throw new Error(JSON.stringify(validation));
  expect(validation.steps).toHaveLength(1);
  return renderConversation(validation.steps[0]!, context);
}
const productHelp = (prose: string, concepts?: string[]) => plan({ kind: 'conversation', topic: 'product_help', prose, ...(concepts ? { concepts } : {}) });
const withoutDashboards = (context: PlannerContext): PlannerContext => ({ ...context, actions: context.actions.filter(a => !a.actionId.startsWith('dashboard.')) });
/** Every mention of realtime is a negation ("not realtime"): the product never claims realtime updates. */
const onlyNegatedRealtime = (text: string) => [...text.matchAll(/เรียลไทม์|realtime|real-time/giu)].every(m => /(ไม่ได้อัปเดตแบบ|ไม่ใช่|ไม่ใช่แบบ|no |not )$/u.test(text.slice(0, m.index)));

describe('PRODUCT MODEL manifest', () => {
  it('(1) reaches the planner context for every role, before the dynamic context, with the dynamic ACCOUNT_CAPABILITY beside it', () => {
    for (const role of ['executive', 'east_manager', 'hr_admin'] as const) {
      const prompt = buildTurnPlannerInput(contextFor(role), { current: 'x' }).prompt;
      expect(promptLine(prompt, 'PRODUCT_MODEL')).toBe(MODEL_LINE);
      expect(Array.isArray(capabilityOf(prompt).unavailable)).toBe(true);
      expect(capabilityOf(prompt).unavailable).not.toContain('chat');
      expect(prompt).toContain('topic=product_help');
    }
  });

  it('(2) is bounded and (3) explicitly versioned', () => {
    expect(Buffer.byteLength(JSON.stringify(PRODUCT_MODEL), 'utf8')).toBeLessThanOrEqual(PRODUCT_MODEL_MAX_BYTES);
    expect(PRODUCT_MODEL_MAX_BYTES).toBeLessThanOrEqual(1536);
    expect(PRODUCT_MODEL.productModelVersion).toBe(1);
    expect(PRODUCT_MODEL_VERSION).toBe(1);
    expect(MODEL_LINE).toContain('"productModelVersion":1');
    expect(Object.keys(PRODUCT_MODEL.concepts)).toEqual([...PRODUCT_CONCEPT_IDS]);
  });

  it('(4) holds no business facts, numbers, resource ids, recipients, action ids, datasets or role permissions', () => {
    const text = JSON.stringify({ ...PRODUCT_MODEL, productModelVersion: undefined });
    expect(text).not.toMatch(/\d/u);
    const branches: Branch[] = [{ id: 'E01', name: 'Demo East Branch 1', region: 'east' }];
    const forbidden = [
      ...actionRegistry.ids(), ...createSemanticCatalog(branches).datasets.map(d => d.id), 'branch_performance', 'hr_employees',
      ...profiles.flatMap(p => [p.id, p.name, p.role]), 'east', 'E01', 'U_SOMCHAI', 'Somchai', 'D1', 'AR1', 'ST1', 'PA1',
      'sales.read', 'dashboard.create', 'executive', 'east_manager', 'hr_admin', 'hr_director',
    ];
    for (const token of forbidden) expect(text.toLowerCase(), token).not.toContain(` ${token.toLowerCase()} `);
    for (const token of actionRegistry.ids()) expect(text).not.toContain(token);
    expect(text).not.toMatch(/permission":|role":|recipient":|ids?":/u);
  });

  it('(2) budget: always present on a conversation’s first turn; on a later turn under pressure it is the first block given up', () => {
    const heavy = (conversation: PlannerContext['conversation']) => contextFor('executive', {
      catalog: { ...contextFor().catalog, choices: Array.from({ length: 100 }, (_, i) => ({ id: `choice-${i}`, label: 'label '.repeat(15) })) },
      recipients: Array.from({ length: 25 }, (_, i) => ({ id: `U${i}`, name: 'recipient '.repeat(7), role: 'manager' })),
      pendingActions: Array.from({ length: 4 }, (_, i) => ({ id: `PA${i}`, kind: 'dashboard_create', title: 'draft '.repeat(25), widgetIndexes: [0], values: {} })),
      dashboards: Array.from({ length: 10 }, (_, i) => ({ id: `D${i}`, title: 'dashboard '.repeat(12) })),
      previousState: { stateId: 'ST0', values: { payload: 'p'.repeat(3_500) } }, conversation,
    });
    const history: PlannerContext['conversation'] = [{ role: 'user', text: 'u' }, { role: 'assistant', text: 'a' }];
    // A current message that overflows the budget by less than the PRODUCT_MODEL block.
    const current = 'q'.repeat(76_000 - buildTurnPlannerInput(heavy(history), { current: '' }).inputBytes + 200);
    const later = buildTurnPlannerInput(heavy(history), { current });
    expect(later.inputBytes).toBeLessThanOrEqual(76_000);
    expect(promptLine(later.prompt, 'PRODUCT_MODEL')).toBeUndefined();
    expect(promptLine(later.prompt, 'ACCOUNT_CAPABILITY')).toBeDefined();
    expect(promptLine(later.prompt, 'DASHBOARDS')).toContain('"D9"');
    expect(promptLine(later.prompt, 'RECENT_CONVERSATION')).toContain('"u"');
    const first = buildTurnPlannerInput(heavy([]), { current });
    expect(promptLine(first.prompt, 'PRODUCT_MODEL')).toBe(MODEL_LINE);
    expect(promptLine(buildTurnPlannerInput(heavy(history), { current: 'x' }).prompt, 'PRODUCT_MODEL')).toBe(MODEL_LINE);
  });

  it('(9) never claims realtime: the manifest and the server copy only negate it', () => {
    expect(onlyNegatedRealtime(PRODUCT_MODEL.concepts.dashboard)).toBe(true);
    expect(PRODUCT_MODEL.concepts.dashboard).toContain('no realtime');
    expect(onlyNegatedRealtime(PRODUCT_CONCEPT_TEXT.dashboard)).toBe(true);
    for (const text of Object.values(PRODUCT_CONCEPT_TEXT)) expect(onlyNegatedRealtime(text)).toBe(true);
  });

  it('the product_help planner example (no prose: server copy) and every scripted product_help fixture validate and render (full-capability account)', () => {
    const example = PLANNER_EXAMPLES.find(e => e.id === 'product_help_result_vs_dashboard');
    expect(example).toBeDefined();
    // G5: the example teaches the prose-less shape; the server explains the named concepts.
    const fromExample = answer(fullCapabilityContext(), example!.say, example!.plan);
    expect(fromExample.topic).toBe('product_help');
    expect(fromExample.fromPlanner).toBe(false);
    expect(fromExample.text).toContain('Result');
    for (const message of Object.keys(SCRIPTED_PRODUCT_HELP)) {
      const out = answer(fullCapabilityContext(), message);
      expect(out.topic).toBe('product_help');
      expect(out.fromPlanner, message).toBe(true);
      expect(onlyNegatedRealtime(out.text), message).toBe(true);
    }
  });
});

describe('product self-help in a fresh conversation (structured plan, server validated, server account part)', () => {
  const executive = contextFor('executive');

  it('(5)(10) introduces DaTex with Chat, Results, Dashboard, Actions, Messages and History plus this account’s capability', () => {
    for (const message of ['แนะนำ DaTex ให้หน่อย', 'platform นี้ทำอะไรได้บ้าง']) {
      const out = answer(executive, message);
      for (const term of ['DaTex', 'Chat', 'Results', 'Dashboard', 'Actions', 'Messages', 'History']) expect(out.text, term).toContain(term);
      expect(out.text).toContain(ACTION_COPY['dashboard.create']!.capability);
    }
    for (const term of ['Chat', 'Results', 'Dashboard', 'Actions', 'Messages', 'History']) expect(PRODUCT_OVERVIEW_TEXT).toContain(term);
  });

  it('(6)(7)(8) explains Result (snapshot) vs Dashboard (refresh on open/reload)', () => {
    const diff = answer(executive, 'Dashboard กับ Result ต่างกันยังไง');
    expect(diff.text).toContain('snapshot');
    expect(diff.text).toContain('รีโหลด');
    expect(diff.text).toContain('สำหรับบัญชีของคุณ: ใช้ Results, Dashboard ได้');
    expect(answer(executive, 'Result คืออะไร').text).toContain('snapshot');
    expect(answer(executive, 'Dashboard อัปเดตข้อมูลยังไง').text).toMatch(/เปิดหรือรีโหลด/u);
    expect(answer(executive, 'Monitor คืออะไร').text).toContain('Messages');
    expect(answer(executive, 'ทำไมบาง Action ต้องยืนยัน').text).toContain('ยืนยัน');
    // The manifest carries the same semantics to the model.
    expect(PRODUCT_MODEL.concepts.result).toContain('SNAPSHOT');
    expect(PRODUCT_MODEL.concepts.dashboard).toContain('re-query permitted data on open/reload');
    // Server fallback (prose rejected by the gate) keeps the same truth from static server copy.
    const fallback = answer(executive, 'x', productHelp('Dashboard รีโหลดทุก 5 นาที', ['result', 'dashboard']));
    expect(fallback.fromPlanner).toBe(false);
    expect(fallback.text).toContain(PRODUCT_CONCEPT_TEXT.result);
    expect(fallback.text).toContain(PRODUCT_CONCEPT_TEXT.dashboard);
  });

  it('(11)(12) account capability is derived from the runtime context; removing a permission changes it, never the static model', () => {
    const full = buildTurnPlannerInput(executive, { current: 'x' }).prompt;
    const reduced = buildTurnPlannerInput(withoutDashboards(executive), { current: 'x' }).prompt;
    expect(capabilityOf(full).unavailable).not.toContain('dashboard');
    expect(accountCapability(executive).available).toEqual(expect.arrayContaining(['dashboard', 'widget', 'result']));
    expect(capabilityOf(reduced).unavailable).toEqual(expect.arrayContaining(['dashboard', 'widget']));
    expect(promptLine(reduced, 'PRODUCT_MODEL')).toBe(promptLine(full, 'PRODUCT_MODEL'));
    // Same derivation over the registry projection of real permissions (no role list anywhere).
    const hr = accountCapability(contextFor('hr_admin'));
    expect(hr.unavailable).toEqual(expect.arrayContaining(['dashboard', 'monitor']));
    const director = accountCapability({ catalog: { datasets: [], measureIds: [], choices: [] }, actions: actionRegistry.describeFor({ permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve'] }),
      workflow: { reads: [{ readId: 'director_queue', description: 'q' }], reviewedQueues: [], verifiedApprovals: [] } });
    expect(director.available).toContain('onboarding_request');
    expect(director.available).not.toContain('result');
    expect(accountCapability(executive).unavailable).toContain('onboarding_request');
  });

  it('(13) a restricted account is not told it can use unavailable operations', () => {
    const restricted = withoutDashboards(executive);
    const diff = answer(restricted, 'Dashboard กับ Result ต่างกันยังไง');
    expect(diff.text).toContain('ตอนนี้ยังไม่มีสิทธิ์ใช้ Dashboard');
    expect(diff.text).not.toMatch(/ใช้ [^\n]*Dashboard[^\n]* ได้/u);
    const intro = answer(restricted, 'แนะนำ DaTex ให้หน่อย');
    for (const id of ['dashboard.create', 'dashboard.share', 'dashboard.rename', 'dashboard.delete']) expect(intro.text).not.toContain(ACTION_COPY[id]!.capability);
    const hrIntro = answer(contextFor('hr_admin'), 'แนะนำ DaTex ให้หน่อย');
    expect(hrIntro.text).not.toContain(ACTION_COPY['dashboard.create']!.capability);
    expect(hrIntro.text).not.toContain(ACTION_COPY['monitor.create']!.capability);
    expect(answer(contextFor('hr_admin'), 'Monitor คืออะไร').text).toContain('ตอนนี้ยังไม่มีสิทธิ์ใช้ Monitor');
  });

  it('FW-B: model product_help prose that talks up a capability this account lacks is replaced by the server copy (named or merely mentioned)', () => {
    const restricted = withoutDashboards(executive);
    // The plan names only chat/result but the prose advertises Dashboard / Widget creation the account cannot use.
    for (const prose of ['Result เก็บคำตอบไว้ และคุณเพิ่มลง Dashboard ได้ทันที', 'Chat ช่วยวิเคราะห์ แล้วสร้าง Widget บนแดชบอร์ดให้ได้']) {
      const out = answer(restricted, 'x', productHelp(prose, ['chat', 'result']));
      expect(out.fromPlanner, prose).toBe(false);
      expect(out.text).not.toContain(prose);
      expect(out.text).toContain(PRODUCT_CONCEPT_TEXT.result);
    }
    // A general introduction (no concepts) whose prose names an unavailable concept falls back to server copy as well.
    const intro = answer(restricted, 'x', productHelp('DaTex ช่วยสร้าง Dashboard และ Monitor ให้คุณ'));
    expect(intro.fromPlanner).toBe(false);
    expect(intro.text).not.toContain('ช่วยสร้าง Dashboard และ Monitor ให้คุณ');
    // Same prose for an account that HAS every capability stays model prose.
    expect(answer(fullCapabilityContext(), 'x', productHelp('Result เก็บคำตอบไว้ และคุณเพิ่มลง Dashboard ได้ในภายหลัง', ['chat', 'result'])).fromPlanner).toBe(true);
    // G2: a restricted account never shows free model prose (a paraphrase could still advertise what it lacks); server copy explains the concept.
    const restrictedResult = answer(restricted, 'x', productHelp('Result คือผลวิเคราะห์ที่บันทึกไว้เป็น snapshot', ['result']));
    expect(restrictedResult.fromPlanner).toBe(false);
    expect(restrictedResult.text).toContain(PRODUCT_CONCEPT_TEXT.result);
  });

  it('(17) product-help prose may not claim an executed effect and (18) may not state numbers: the server copy replaces it', () => {
    for (const prose of ['ผมสร้าง Dashboard ให้เรียบร้อยแล้ว', 'I have created your dashboard', 'Dashboard อัปเดตทุก 5 นาที', 'มีสาม Dashboard ในบัญชีนี้']) {
      const out = answer(executive, 'x', productHelp(prose, ['dashboard']));
      expect(out.fromPlanner, prose).toBe(false);
      expect(out.text).not.toContain(prose);
      expect(out.text).not.toMatch(/\d/u);
      expect(out.text).toContain(PRODUCT_CONCEPT_TEXT.dashboard);
    }
  });

  it('(15) no phrase or regex routing: rendering ignores the user wording; fixtures are exact keys; the legacy offender list stays empty', () => {
    const raw = productHelp('Result คงค่าเดิมแบบ snapshot ส่วน Dashboard ดึงข้อมูลใหม่เมื่อเปิดหรือรีโหลด', ['result', 'dashboard']);
    const texts = ['Result คืออะไร', 'something unrelated', 'ลบ Dashboard ทั้งหมด'].map(message => answer(executive, message, raw).text);
    expect(new Set(texts).size).toBe(1);
    expect(() => scriptedTurnPlan(buildTurnPlannerInput(executive, { current: 'แนะนำ biztania ให้หน่อย' }))).toThrow(ScriptedTurnPlannerFixtureMissing);
    expect(LEGACY_USER_TEXT_OFFENDERS).toEqual([]);
  });

  it('canonicalizes model concept names (case, plural, aliases), drops unknown ones and keeps concepts only on product_help', () => {
    const out = canonicalizeModelPlan(plan({ kind: 'conversation', topic: 'product_help', prose: 'p', concepts: ['Results', 'Work Item', 'artifact', 'bogus', 'Onboarding-Request'] })) as { steps: { concepts?: string[] }[] };
    expect(out.steps[0]!.concepts).toEqual(['result', 'task', 'onboarding_request']);
    const advice = canonicalizeModelPlan(plan({ kind: 'conversation', topic: 'advice', prose: 'p', concepts: ['result'] })) as { steps: { concepts?: string[] }[] };
    expect(advice.steps[0]!.concepts).toBeUndefined();
    const none = canonicalizeModelPlan(plan({ kind: 'conversation', topic: 'product_help', prose: 'p', concepts: ['bogus'] })) as { steps: Record<string, unknown>[] };
    expect('concepts' in none.steps[0]!).toBe(false);
  });
});

describe('product self-help through the service', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    planner.reply((input: TurnPlannerInput) => scriptedTurnPlan(input));
    fixture = await createWorkspaceFixture();
  });
  afterEach(async () => { await fixture.dispose(); vi.unstubAllEnvs(); planner.reset(); });
  const live = async (actor: typeof actors.executive) => {
    await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actor, mode: 'live_ai' as const, modeRevision: 1 };
  };

  it('(5)(14)(17) a new conversation explains DaTex from the manifest only: no prose from another conversation, no effect', async () => {
    const actor = await live(actors.executive);
    const first = await fixture.service.turn(actor, 'Monitor คืออะไร');
    expect(first.message).toContain('Monitor');
    const fresh = await fixture.service.turn(actor, 'แนะนำ DaTex ให้หน่อย');
    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect(fresh.message).toContain('DaTex');
    expect(fresh.pendingAction).toBeUndefined();
    expect(fresh.receipt).toBeUndefined();
    expect(fresh.sources).toBeUndefined();
    const sent = planner.calls[1]!;
    expect(sent.context.conversation).toEqual([]);
    expect(promptLine(sent.prompt, 'RECENT_CONVERSATION')).toBe('RECENT_CONVERSATION=[]');
    expect(sent.prompt).not.toContain('Monitor คืออะไร');
    expect(sent.prompt).not.toContain(first.message.slice(0, 40));
    expect(promptLine(sent.prompt, 'PRODUCT_MODEL')).toBe(MODEL_LINE);
  });

  it('(11)(13) the HR account gets its own capability, never Dashboard or Monitor operations', async () => {
    const actor = await live(actors.hr);
    const response = await fixture.service.turn(actor, 'แนะนำ DaTex ให้หน่อย');
    expect(response.message).not.toContain(ACTION_COPY['dashboard.create']!.capability);
    expect(response.message).not.toContain(ACTION_COPY['monitor.create']!.capability);
    expect(capabilityOf(planner.calls[0]!.prompt).unavailable).toEqual(expect.arrayContaining(['dashboard', 'monitor']));
  });

  it('(16) existing query and action flows still pass with the manifest in the prompt', async () => {
    const east = await live(actors.east);
    const query = await fixture.service.turn(east, 'Show East sales totals for 2026-10-01.');
    expect(query.sources?.length).toBeGreaterThan(0);
    const executive = await live(actors.executive);
    const dashboard = await fixture.service.turn(executive, 'Create a sales dashboard');
    expect(dashboard.pendingAction?.payload.kind).toBe('dashboard_create');
  });

  it('(19) demo mode is unchanged: typed product questions get showcase chips and never call the planner', async () => {
    const response = await fixture.service.turn(actors.east, 'แนะนำ DaTex ให้หน่อย');
    expect(response.clarification).toBe(true);
    expect(response.choices?.length).toBeGreaterThan(0);
    expect(planner.calls).toHaveLength(0);
  });
});
