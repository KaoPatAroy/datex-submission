import { describe, expect, it } from 'vitest';
import { AIRuntimeError } from '@/lib/ai/errors';
import { boundedPlannerConversation, buildTurnPlannerInput, TURN_PLANNER_MAX_INPUT_BYTES } from '@/lib/router/planner/input';
import { jsonSchemaBytes, PLANNER_JSON_SCHEMA_MAX_BYTES, plannerSchemaWithinBudget } from '@/lib/router/json-schema';
import { contextFor } from '../fixtures';

function block(input: ReturnType<typeof buildTurnPlannerInput>, name: string): unknown {
  const line = input.prompt.split('\n').find(part => part.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} block`);
  return JSON.parse(line.slice(name.length + 1));
}

describe('TurnPlan planner input', () => {
  it('includes business context, authorized data, compact actions, context ids and one previous state', () => {
    const input = buildTurnPlannerInput(contextFor('executive', {
      conversation: [{ role: 'user', text: 'Earlier prompt' }, { role: 'assistant', text: 'Earlier answer' }],
    }), { current: 'Show East sales totals for 2026-10-01.' });

    expect(input.prompt).toContain('businessDate');
    expect(input.prompt).toContain('"businessDate":"2026-10-06"');
    expect(input.prompt).toContain('"weekday":"Tuesday"');
    expect(input.prompt).toContain('ISO week-year');
    expect(input.prompt).toContain('2026-09-01');
    expect(input.prompt).toContain('"role":"executive"');
    expect(input.prompt).toContain('"label":"East region"');
    expect(input.prompt).toContain('"actionId":"dashboard.share"');
    expect(buildTurnPlannerInput(contextFor('hr_admin'), { current: 'Revoke badge B1.' }).prompt).toContain('"verbatim":true');
    expect(input.prompt).toContain('"id":"PA1","kind":"dashboard_create","title":"Draft"');
    expect(input.prompt).toContain('"id":"D1","title":"Bangkok dashboard"');
    expect(input.prompt).toContain('"id":"U_SOMCHAI"');
    expect(block(input, 'PREVIOUS_STATE_DATA')).toMatchObject({ stateId: 'ST1' });
    expect(input.prompt.match(/ST1/g)).toHaveLength(1);
    expect(input.prompt).toContain('Earlier prompt');
    expect(input.prompt).not.toContain('Show East sales totals for 2026-10-01.');
    expect(input.currentMessage).toBe('Show East sales totals for 2026-10-01.');
    expect(input.systemPrompt).toContain(JSON.stringify(input.jsonSchema));
  });

  it('covers query, action, refine, date, HR, negation, conversation and clarification behavior', () => {
    const prompt = buildTurnPlannerInput(contextFor(), { current: 'test' }).prompt;
    for (const example of [
      'ยอดขายรวมวันนี้เท่าไหร่', 'สาขาไหนต่ำกว่าเป้ามากที่สุด 3 อันดับ', 'แล้วภาคกลางล่ะ', 'ยอดขายภาคตะวันออกเทียบเป้า', 
      'สร้าง Dashboard สัดส่วนยอดขาย', 'แชร์ Dashboard นี้ให้ผู้จัดการภาคตะวันออก', 'เปิด Ticket ติดตามสาขา BR_A และ BR_B',
      'ยกเลิกรายการนี้', 'เปลี่ยนชื่อ Dashboard เป็น ภาพรวมขายตะวันออก', 'ลบ Dashboard นี้',
      'แจ้งฉันเมื่อสาขาไหนยอดขายต่ำกว่า 85% ของเป้า', 'Last week', 'don’t revoke yet', 'params.<name>',
    ]) expect(prompt).toContain(example);
    // HR and badge rules reach only the actors who can use them (like the Director block and the examples).
    const hr = buildTurnPlannerInput(contextFor('hr_admin'), { current: 'test' }).prompt;
    for (const rule of ['only HR measure', 'audit assertion']) {
      expect(hr).toContain(rule);
      expect(prompt).not.toContain(rule);
    }
    expect(prompt).toContain('lowest');
    expect(prompt).toContain('out_of_scope');
    expect(prompt).toContain('never an action');
  });

  it('bounds recent history to six messages, 3 KB and code-point-safe excerpts', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `message ${index}`,
    }));
    const excerpt = boundedPlannerConversation(history);
    expect(excerpt).toHaveLength(6);
    expect(excerpt[0]?.text).toBe('message 2');
    expect(Buffer.byteLength(JSON.stringify(excerpt), 'utf8')).toBeLessThanOrEqual(3 * 1024);
    const truncated = boundedPlannerConversation([{ role: 'user', text: '😀'.repeat(500) }]);
    expect([...truncated[0]!.text].length).toBe(401);
    expect(truncated[0]!.text.endsWith('…')).toBe(true);
  });

  it('carries exact clarification request quotes separately from truncated conversation history', () => {
    const request = `สร้างงาน ${'รายละเอียด'.repeat(70)} ภายในวันศุกร์`;
    const context = contextFor('executive', { pendingClarification: { about: 'action:task.create', missing: ['params.title'] },
      conversation: [{ role: 'user', text: request }] });
    const input = buildTurnPlannerInput(context, { current: 'ใช้ชื่อนี้', clarifiedTurns: [request, 'ชื่อ ตรวจสอบสาขา'] });
    expect(block(input, 'CLARIFIED_REQUEST')).toEqual([request, 'ชื่อ ตรวจสอบสาขา']);
    expect(block(input, 'RECENT_CONVERSATION')).not.toEqual([{ role: 'user', text: request }]);
    expect(input.prompt).toContain('evidenceFrom clarified_turn');
    expect(input.inputBytes).toBeLessThanOrEqual(TURN_PLANNER_MAX_INPUT_BYTES);
    expect(() => buildTurnPlannerInput(context, { current: 'reply', clarifiedTurns: ['x'.repeat(25 * 1024)] }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('keeps the full model request within the 76,000-byte planner input budget and rejects an oversized current message', () => {
    // The enforced contract: TURN_PLANNER_MAX_INPUT_BYTES is the runtime limit (76,000 bytes); seeded roles keep >= 8 KB of it spare (input-budget.test.ts).
    expect(TURN_PLANNER_MAX_INPUT_BYTES).toBe(76_000);
    const input = buildTurnPlannerInput(contextFor(), { current: 'Show East sales totals for 2026-10-01.' });
    expect(input.inputBytes).toBeLessThanOrEqual(TURN_PLANNER_MAX_INPUT_BYTES);
    expect(input.inputBytes).toBe(Buffer.byteLength(input.systemPrompt + input.currentMessage, 'utf8'));

    const context = contextFor('executive', {
      scope: { ...contextFor().scope, regionIds: Array.from({ length: 12 }, (_, i) => `region-${i}-${'r'.repeat(30)}`) },
      catalog: { ...contextFor().catalog, choices: Array.from({ length: 100 }, (_, i) => ({ id: `choice-${i}`, label: 'label '.repeat(15) })) },
      recipients: Array.from({ length: 25 }, (_, i) => ({ id: `U${i}`, name: 'recipient '.repeat(7), role: 'manager' })),
      pendingActions: Array.from({ length: 4 }, (_, i) => ({ id: `PA${i}`, kind: 'dashboard_create', title: 'draft '.repeat(25), widgetIndexes: [0] as number[], values: {} })),
      dashboards: Array.from({ length: 10 }, (_, i) => ({ id: `D${i}`, title: 'dashboard '.repeat(12) })),
      acceptedStates: Array.from({ length: 3 }, (_, i) => ({ stateId: `ST${i}`, datasetId: 'branch_performance' })),
      artifacts: Array.from({ length: 5 }, (_, i) => ({ id: `AR${i}`, typeId: 'table', title: 'artifact '.repeat(15) })),
      conversation: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: '😀'.repeat(400) })),
      previousState: { stateId: 'ST0', values: { payload: 'p'.repeat(3_500) } },
    });
    const bounded = buildTurnPlannerInput(context, { current: 'question '.repeat(150) });
    expect(bounded.inputBytes).toBeLessThanOrEqual(TURN_PLANNER_MAX_INPUT_BYTES);
    expect(() => buildTurnPlannerInput(contextFor(), { current: 'x'.repeat(50_000) }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' } satisfies Partial<AIRuntimeError>));
  });

  it('L7: the provider JSON schema is held to the 18 KB budget for every role (action params collapse to a generic object when needed) and an oversize schema is refused', () => {
    for (const role of ['executive', 'east_manager', 'hr_admin'] as const) {
      const input = buildTurnPlannerInput(contextFor(role), { current: 'x' });
      expect(jsonSchemaBytes(input.jsonSchema)).toBeLessThanOrEqual(PLANNER_JSON_SCHEMA_MAX_BYTES);
    }
    expect(plannerSchemaWithinBudget({ pad: 'x'.repeat(PLANNER_JSON_SCHEMA_MAX_BYTES) })).toBe(false);
    // Every registered action id stays selectable in the compact form.
    const executive = JSON.stringify(buildTurnPlannerInput(contextFor('executive'), { current: 'x' }).jsonSchema);
    for (const id of ['dashboard.create', 'ticket.create', 'task.create', 'policy.acknowledge']) expect(executive).toContain(id);
  });
});
