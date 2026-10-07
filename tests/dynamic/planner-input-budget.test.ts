import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedPlannerConversation, buildTurnPlannerInput, TURN_PLANNER_MAX_INPUT_BYTES } from '@/lib/router/planner/input';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { conversationStep, plan, planner } from '../helpers/turn-planner';
import { contextFor } from '../router/fixtures';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

// A realistic long accepted answer: Thai text (3 bytes per character).
const longAnswer = 'ยอดขายสุทธิรวมทุกภาคอยู่ที่ระดับสูงกว่าเป้าหมายเล็กน้อยและต่ำกว่าเป้าหมายในบางสาขา '.repeat(40);
const thaiQuestion = 'ยอดขายรวมทุกภาควันที่ 1 ต.ค. เท่าไหร่ เทียบเป้า';
const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: i % 2 ? longAnswer : thaiQuestion }));
const bytes = (input: ReturnType<typeof buildTurnPlannerInput>) => Buffer.byteLength(input.systemPrompt + input.currentMessage, 'utf8');

describe('planner input budget after long accepted answers', () => {
  it('bounds the conversation excerpt and compacts assistant answers', () => {
    expect(Buffer.byteLength(longAnswer, 'utf8')).toBeGreaterThan(8_000);
    const bounded = boundedPlannerConversation(history);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(3 * 1024);
    expect(bounded.length).toBeGreaterThan(0);
    for (const entry of bounded) expect(Buffer.byteLength(entry.text, 'utf8')).toBeLessThan(8_000);
    for (const entry of bounded.filter(e => e.role === 'assistant')) expect([...entry.text].length).toBeLessThanOrEqual(241);
    expect(bounded.at(-1)).toMatchObject({ role: 'assistant' });
  });
  it('stays under the planner ceiling and grows by at most the conversation bound regardless of turn count', () => {
    // The former 24 KB planner limit no longer applies (the TurnPlan prompt is larger); the invariant is the 76,000-byte runtime ceiling (TURN_PLANNER_MAX_INPUT_BYTES)
    // plus a conversation contribution capped at its own 3 KB block, however many long answers precede the turn.
    const sizes = [0, 2, 6, 12].map(n => bytes(buildTurnPlannerInput(contextFor('executive', { conversation: history.slice(0, n) }), { current: 'x' })));
    expect(Math.max(...sizes)).toBeLessThan(TURN_PLANNER_MAX_INPUT_BYTES);
    expect(Math.max(...sizes) - sizes[0]!).toBeLessThanOrEqual(3 * 1024 + 512);
    expect(sizes[3]).toBeLessThanOrEqual(sizes[2]! + 1024);
    expect(bytes(buildTurnPlannerInput(contextFor('executive', { conversation: history }), { current: 'ช่วยแนะนำแพลตฟอร์มนี้หน่อย' }))).toBeLessThan(TURN_PLANNER_MAX_INPUT_BYTES);
  });
  describe('request through the service', () => {
    let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
    beforeEach(async () => {
      vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
      planner.reset();
      fixture = await createWorkspaceFixture();
      await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    });
    afterEach(async () => { await fixture.dispose(); vi.unstubAllEnvs(); });
    it('sends a follow-up carrying long prior answers instead of failing invalid_input locally', async () => {
      const actor = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
      // Thai prose without digits is accepted verbatim by the output gate, so long answers really enter the conversation.
      const prose = 'ระบบช่วยดูยอดขายและผลงานสาขาที่บัญชีนี้มีสิทธิ์ โดยตอบจากข้อมูลที่ตรวจสอบได้เท่านั้น '.repeat(7).slice(0, 590);
      planner.reply(plan(conversationStep('advice', prose)));
      let conversationId: string | undefined;
      for (let i = 0; i < 8; i += 1) conversationId = (await fixture.service.turn(actor, `${thaiQuestion} รอบ ${i}`, conversationId)).conversationId;
      planner.reset();
      planner.reply(plan(conversationStep('capability', 'แนะนำแพลตฟอร์ม')));
      const result = await fixture.service.turn(actor, 'ช่วยแนะนำแพลตฟอร์มนี้หน่อย', conversationId);
      expect(result.message.length).toBeGreaterThan(0);
      expect(planner.calls).toHaveLength(1);
      const sent = planner.calls[0]!;
      expect(sent.context.conversation.length).toBeGreaterThan(0);
      expect(sent.inputBytes).toBeLessThan(TURN_PLANNER_MAX_INPUT_BYTES);
      expect(Buffer.byteLength(sent.systemPrompt + sent.currentMessage, 'utf8')).toBeLessThan(TURN_PLANNER_MAX_INPUT_BYTES);
    });
  });
});
