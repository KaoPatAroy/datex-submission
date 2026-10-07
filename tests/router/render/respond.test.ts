import { describe, expect, it } from 'vitest';
import { renderClarify, renderConversation, renderPlannerFailure, capabilityText } from '@/lib/router/render/respond';
import { hasNumberWord, isSafeClarificationText, isSafeConversationProse, isSafeFollowUp } from '@/lib/router/render/safety';
import { validateTurnPlan, type GroundedStep } from '@/lib/router/validate';
import type { PlannerContext } from '@/lib/router/planner-context';
import { actionRegistry } from '@/lib/router/action-registry';
import { contextFor, inputFor, plan } from '../fixtures';

const gate = (text: string, kind: string) => kind === 'generated' || kind === 'prose' || kind === 'clarify' ? text.length > 0 : true;

function ground(step: unknown, context: PlannerContext = contextFor()): GroundedStep {
  const result = validateTurnPlan(inputFor(plan(step), 'executive', { context }, { isSafeText: gate }));
  if (result.outcome !== 'accepted') throw new Error(`not accepted: ${JSON.stringify(result)}`);
  return result.steps[0];
}
const clarify = (question: string, choices: { id: string; label: string }[] = []) => ({
  kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' },
  missing: [{ slot: 'params.recipientId', reason: 'ambiguous' }], question, choices,
});
const conversation = (topic: string, prose: string) => ({ kind: 'conversation', topic, prose });

describe('number-word gate on model output', () => {
  it.each(['สามสิบเปอร์เซ็นต์', 'ร้อยละห้า', 'ประมาณหมื่นบาท', 'หนึ่งสาขา', 'about ten branches', 'a Million sales', '5 percent'])('rejects %s', text => {
    expect(hasNumberWord(text) || /\p{N}/u.test(text)).toBe(true);
    expect(isSafeConversationProse(text, [])).toBe(false);
  });
  it.each(['คุณสามารถถามได้เลยครับ', 'เรียบร้อยแล้วครับ', 'ห้ามแชร์ข้อมูลนี้', 'How can I help you today?'])('keeps ordinary prose %s', text => {
    expect(isSafeConversationProse(text, [])).toBe(true);
  });
});

describe('isSafeClarificationText', () => {
  it('allows a choice id and its label but not other entities, digits or number words', () => {
    expect(isSafeClarificationText('ส่งให้ BR01 ใช่ไหมครับ', ['BR01'], [], ['Branch One'])).toBe(true);
    expect(isSafeClarificationText('ส่งให้ Somchai ใช่ไหมครับ', ['U1'], ['Somchai'], ['Somchai', 'Mali'])).toBe(true);
    expect(isSafeClarificationText('ส่งให้ Mali ใช่ไหมครับ', ['U1'], ['Somchai'], ['Somchai', 'Mali'])).toBe(false);
    expect(isSafeClarificationText('ส่งให้ 2 คนใช่ไหม', [], [], [])).toBe(false);
    expect(isSafeClarificationText('ส่งให้สองคนใช่ไหม', [], [], [])).toBe(false);
    expect(isSafeClarificationText('ก'.repeat(301), [], [], [])).toBe(false);
  });
});

describe('renderClarify', () => {
  it.each([['params.dueDate', 'วันครบกำหนด'], ['params.assigneeId', 'ผู้รับผิดชอบ']])('names the actual missing task field %s', (slot, label) => {
    const step = ground({ kind: 'clarify', about: { kind: 'action', actionId: 'task.create' },
      missing: [{ slot, reason: 'absent' }], question: '-', choices: [] });
    const rendered = renderClarify({ ...step, safeText: null }, contextFor());
    expect(rendered.text).toContain(label);
    expect(rendered.text).not.toContain('รายละเอียดที่ต้องการ');
  });
  it('renders the AI question with server-labelled chips', () => {
    const out = renderClarify(ground(clarify('ต้องการส่งให้ใครครับ', [{ id: 'U_SOMCHAI', label: 'MODEL LABEL' }, { id: 'ghost', label: 'x' }])), contextFor());
    expect(out).toMatchObject({ kind: 'clarify', text: 'ต้องการส่งให้ใครครับ', clarification: true, fromPlanner: true });
    expect(out.choices).toEqual([{ id: 'U_SOMCHAI', label: 'Somchai' }]);
  });
  it('falls back to a Thai slot template when the question is unsafe (digits / unrelated entity)', () => {
    for (const q of ['ส่งให้ 3 คนใช่ไหม', 'ส่งให้ Branch One ใช่ไหม']) {
      const out = renderClarify(ground(clarify(q)), contextFor());
      expect(out.fromPlanner).toBe(false);
      expect(out.text).toContain('ผู้รับ');
      expect(out.text).not.toContain('Branch One');
    }
  });
  it('falls back when the validator nulled the text', () => {
    const grounded = { ...ground(clarify('ok?')), safeText: null };
    expect(renderClarify(grounded, contextFor()).fromPlanner).toBe(false);
  });
});

describe('renderConversation', () => {
  it('passes safe model prose through unchanged', () => {
    expect(renderConversation(ground(conversation('advice', 'ยินดีครับ ถามต่อได้เลย')), contextFor()))
      .toMatchObject({ text: 'ยินดีครับ ถามต่อได้เลย', fromPlanner: true });
  });
  it.each(['มียอดขาย 120 ล้าน', 'ยอดขายหนึ่งล้านบาท', 'สาขา Branch One ทำได้ดี', 'sales grew by ten percent'])('replaces unsafe prose %s with capability text', prose => {
    const out = renderConversation(ground(conversation('advice', prose)), contextFor());
    expect(out.fromPlanner).toBe(false);
    expect(out.text).not.toContain(prose);
    expect(out.text).toContain('ขอบเขตการทำงาน');
  });
  it('capability topic always uses server text derived from usable actions', () => {
    const out = renderConversation(ground(conversation('capability', 'I can do anything')), contextFor());
    expect(out.text).not.toContain('I can do anything');
    expect(out.text).toContain('เตรียมการแชร์ Dashboard');
    expect(out.text).not.toContain('เตรียมคำขอเพิกถอนบัตร'); // executive context lacks badge.revoke
  });
  it('greets only on the first turn of a conversation', () => {
    const first = renderConversation(ground(conversation('capability', 'x')), contextFor());
    const later = contextFor('executive', { conversation: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] });
    const second = renderConversation(ground(conversation('capability', 'x'), later), later);
    expect(first.text.startsWith('สวัสดีครับ')).toBe(true);
    expect(second.text).not.toContain('สวัสดีครับ');
  });
  it('limits paragraph reflects riskTier: direct drafts vs confirmation', () => {
    const base = contextFor();
    const mixed = capabilityText({ ...base, actions: [
      { ...base.actions[0], riskTier: 'direct', requiresConfirm: false }, { ...base.actions[1], riskTier: 'confirm', requiresConfirm: true }] }, { greeting: false });
    expect(mixed).toContain('สร้างให้ทันที');
    expect(mixed).toContain('ต้องได้รับการยืนยัน');
    const confirmOnly = capabilityText({ ...base, actions: actionRegistry.describeFor({ permissions: base.scope.permissions }).filter(a => a.riskTier === 'confirm') }, { greeting: false });
    expect(confirmOnly).not.toContain('สร้างให้ทันที');
    expect(confirmOnly).toContain('ต้องได้รับการยืนยัน');
  });
  it('states missing permissions when the actor has nothing usable', () => {
    const empty = contextFor('executive', { actions: [], catalog: { datasets: [], measureIds: [], choices: [] } });
    expect(capabilityText(empty, { greeting: true })).toContain('ไม่มีสิทธิ์');
  });
});

describe('renderPlannerFailure', () => {
  it.each(['outage', 'invalid_plan', 'slow'] as const)('is truthful Thai with the demo hint (%s)', reason => {
    const out = renderPlannerFailure(reason);
    expect(out).toMatchObject({ kind: 'planner_failure', reason, hint: 'switch_to_demo', retryable: true });
    expect(out.text).toContain('โหมดสาธิต');
    expect(out.text).toContain('ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล');
  });
});

describe('isSafeFollowUp', () => {
  it('keeps short plain questions and rejects digits, number words, entity labels, markup and long text', () => {
    expect(isSafeFollowUp('เปรียบเทียบกับภูมิภาคอื่นได้ไหม', ['ภาคตะวันออก'])).toBe(true);
    expect(isSafeFollowUp('ขอดู 5 สาขา', [])).toBe(false);
    expect(isSafeFollowUp('ขอดูห้าสาขา', [])).toBe(false);
    expect(isSafeFollowUp('ขอดูภาคตะวันออก', ['ภาคตะวันออก'])).toBe(false);
    expect(isSafeFollowUp('<script>x</script>', [])).toBe(false);
    expect(isSafeFollowUp('ดูที่ https://x.test', [])).toBe(false);
    expect(isSafeFollowUp('ก'.repeat(101), [])).toBe(false);
  });
});
