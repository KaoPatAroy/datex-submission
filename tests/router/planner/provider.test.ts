import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/contracts';
import { buildTurnPlannerInput } from '@/lib/router/planner/input';
import { PLANNER_RETRY_RESERVE_MS, repairDeadline, requestTurnPlan } from '@/lib/router/planner/provider';
import { REJECT_CODES_MAX, safeRejectCodes, TRUNCATION_REPAIR_PROMPT } from '@/lib/router/planner/diagnostics';
import { contextFor } from '../fixtures';

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/ai/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/ai/client')>(),
  createAIClient: () => ({ chat: { completions: { create: provider.create } } }),
}));

function completion(content: string, finish_reason = 'stop') {
  return { choices: [{ finish_reason, message: { content } }] };
}

const actor = { id: 'exec-1', name: 'Executive', role: 'executive', active: true, permissions: [], regions: [],
  sessionId: 'session-1', mode: 'live_ai', modeRevision: 1 } as Actor;
const greetingJson = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'greeting', prose: 'Hello.' }] });

beforeEach(() => {
  vi.stubEnv('AI_PROVIDER', 'ninearm');
  vi.stubEnv('NINEARM_API_KEY', 'fixture-key');
  vi.stubEnv('NINEARM_BASE_URL', 'https://provider.example/v1');
  vi.stubEnv('NINEARM_MODEL', 'fixture-model');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('TurnPlan provider', () => {
  it('makes one schema repair request and sends only validator paths as the correction', async () => {
    provider.create.mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[]}'))
      .mockResolvedValueOnce(completion(greetingJson));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const input = buildTurnPlannerInput(contextFor(), { current: 'user text must not enter logs' });
    const result = await requestTurnPlan(input, { actor, diagnosticId: 'diag-1' });

    expect(result.steps[0]?.kind).toBe('conversation');
    expect(provider.create).toHaveBeenCalledTimes(2);
    const firstBody = provider.create.mock.calls[0]![0];
    const secondBody = provider.create.mock.calls[1]![0];
    expect(firstBody).toMatchObject({ max_tokens: 1536, chat_template_kwargs: { enable_thinking: false } });
    expect(firstBody).not.toHaveProperty('response_format');
    expect(secondBody.messages.at(-1)?.content).toContain('steps');
    expect(secondBody.messages.at(-1)?.content).not.toContain('user text must not enter logs');
    expect(log).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(String(log.mock.calls[0]?.[1]));
    expect(metadata).toMatchObject({ kinds: ['conversation'], inputBytes: input.inputBytes, providerStatus: null, repairUsed: true });
    expect(metadata.elapsedMs).toEqual(expect.any(Number));
    expect(JSON.stringify(metadata)).not.toContain('user text must not enter logs');
  });

  it('does not make a second repair attempt when the repaired output is still invalid', async () => {
    provider.create.mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[]}'))
      .mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[]}'));
    await expect(requestTurnPlan(buildTurnPlannerInput(contextFor(), { current: 'hello' }), { actor, diagnosticId: 'diag-2' }))
      .rejects.toMatchObject({ code: 'invalid_model_response' });
    expect(provider.create).toHaveBeenCalledTimes(2);
  });
  // G3-1: the fresh "แนะนำ DaTex ให้หน่อย" failure was a response cut off at max_tokens (the gateway looped on Thai prose):
  // finish_reason "length" used to end the turn with no repair and nothing logged.
  it('repairs a truncated response with a compact-output request (no truncated text sent back) and logs the failure code', async () => {
    provider.create.mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[{"kind":"conversation","topic":"product_help","prose":"DaTex เป็น เป็น เป็น', 'length'))
      .mockResolvedValueOnce(completion(greetingJson));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const input = buildTurnPlannerInput(contextFor(), { current: 'user text must not enter logs' });
    const result = await requestTurnPlan(input, { actor, diagnosticId: 'diag-3', turnDeadlineAt: Date.now() + 95_000 });
    expect(result.steps[0]?.kind).toBe('conversation');
    expect(provider.create).toHaveBeenCalledTimes(2);
    const repairBody = provider.create.mock.calls[1]![0];
    expect(repairBody.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'user']);
    expect(repairBody.messages.at(-1)?.content).toBe(TRUNCATION_REPAIR_PROMPT);
    const metadata = JSON.parse(String(log.mock.calls.find(call => call[0] === 'BIZTANIA_TURN_PLANNER')?.[1]));
    expect(metadata).toMatchObject({ kinds: ['conversation'], repairUsed: true, failure: 'truncated' });
    expect(JSON.stringify(metadata)).not.toContain('user text must not enter logs');
  });

  it('logs bounded validator reject codes (paths and codes only) for the first response and the failed repair', async () => {
    provider.create.mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[]}'))
      .mockResolvedValueOnce(completion('{"turnPlanVersion":1,"steps":[{"kind":"conversation","topic":"bogus","prose":"ข้อความของโมเดล"}]}'));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(requestTurnPlan(buildTurnPlannerInput(contextFor(), { current: 'สวัสดี' }), { actor, diagnosticId: 'diag-4' }))
      .rejects.toMatchObject({ code: 'invalid_model_response' });
    const metadata = JSON.parse(String(log.mock.calls.find(call => call[0] === 'BIZTANIA_TURN_PLANNER')?.[1]));
    expect(metadata).toMatchObject({ kinds: [], repairUsed: true, failure: 'invalid_model_plan', repairFailure: 'invalid_model_plan' });
    expect(metadata.rejectCodes).toEqual(expect.arrayContaining([expect.stringMatching(/^steps(\.[\w$()*]+)*:[a-z_]+$/)]));
    expect(metadata.repairRejectCodes.length).toBeGreaterThan(0);
    expect(metadata.repairRejectCodes.length).toBeLessThanOrEqual(REJECT_CODES_MAX);
    expect(JSON.stringify(metadata)).not.toContain('ข้อความของโมเดล');
    expect(JSON.stringify(metadata)).not.toContain('สวัสดี');
  });

  it('reduces reject paths to safe identifiers (a model-invented key never reaches the log)', () => {
    expect(safeRejectCodes(['steps.0.params.สมชาย ใจดี:unrecognized_keys', 'steps.0.prose:too_big', 'steps.0.prose:too_big', '(root):malformed_json']))
      .toEqual(['steps.0.params.*:unrecognized_keys', 'steps.0.prose:too_big', '(root):malformed_json']);
    expect(safeRejectCodes(Array.from({ length: 20 }, (_, i) => `steps.${i}:invalid_type`))).toHaveLength(REJECT_CODES_MAX);
  });

  it('gives the repair the whole-turn budget (minus the post-plan reserve) when the first response used most of its attempt cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      provider.create.mockImplementationOnce(async () => { vi.setSystemTime(start + 9_000); return completion('{"turnPlanVersion":1,"steps":[]}'); })
        .mockResolvedValueOnce(completion(greetingJson));
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      const result = await requestTurnPlan(buildTurnPlannerInput(contextFor(), { current: 'hello' }), { actor, diagnosticId: 'diag-5', turnDeadlineAt: start + 95_000 });
      expect(result.steps[0]?.kind).toBe('conversation');
      expect(provider.create).toHaveBeenCalledTimes(2);
      // The repair request's timeout comes from the extended deadline (well beyond the 6 s left of the 15 s attempt cap).
      expect(provider.create.mock.calls[1]![1].timeout).toBeGreaterThan(8_000);
      expect(JSON.parse(String(log.mock.calls.find(call => call[0] === 'BIZTANIA_TURN_PLANNER')?.[1]))).toMatchObject({ repairUsed: true, failure: 'invalid_model_plan' });

      // Without a whole-turn deadline the attempt cap still bounds it: no time for a repair, and the skip is logged.
      provider.create.mockReset();
      log.mockClear();
      const again = Date.now();
      provider.create.mockImplementationOnce(async () => { vi.setSystemTime(again + 9_000); return completion('{"turnPlanVersion":1,"steps":[]}'); });
      await expect(requestTurnPlan(buildTurnPlannerInput(contextFor(), { current: 'hello' }), { actor, diagnosticId: 'diag-6' }))
        .rejects.toMatchObject({ code: 'invalid_model_response' });
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls.find(call => call[0] === 'BIZTANIA_TURN_PLANNER')?.[1]))).toMatchObject({ repairUsed: false, repairSkipped: 'no_time' });
    } finally { vi.useRealTimers(); }
  });

  it('repairDeadline: up to one attempt cap from now, never into the post-plan reserve, never earlier than the attempt deadline', () => {
    expect(repairDeadline(16_000, 15_000, 96_000, 10_000)).toBe(25_000);
    expect(repairDeadline(16_000, 15_000, 31_000, 10_000)).toBe(16_000);
    expect(repairDeadline(16_000, 15_000, 40_000, 10_000)).toBe(40_000 - PLANNER_RETRY_RESERVE_MS);
    expect(repairDeadline(16_000, 15_000, undefined, 10_000)).toBe(16_000);
  });
});
