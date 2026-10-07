import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { getAIProviderOptions, getAIMaxStepsPerTurn, getAIRequestTimeoutMs, getRequestTimeoutForRemaining } from '../lib/ai/provider-options';
import { requestCompletion, type RunContext } from '../lib/ai/loop-core';

const NOW = 10_000;
const BASE_URL = 'https://provider.example/v1';
const MODEL = 'latency-test-model';

function context(create: ReturnType<typeof vi.fn>, deadlineAt = NOW + 60_000): RunContext {
  return {
    input: {
      message: 'Summarize the verified evidence.',
      history: [],
      actor: {
        id: 'actor-test', name: 'Test actor', role: 'executive', active: true,
        permissions: [], regions: [], sessionId: 'session-test', mode: 'live_ai', modeRevision: 1,
      },
      businessDate: '2026-10-05',
      broker: { descriptors: [], execute: async () => undefined },
    },
    settings: { baseURL: BASE_URL, model: MODEL, toolMode: 'planner' },
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    tools: [], byCanonicalName: new Map(), byWireName: new Map(), deadlineAt,
    maxModelSteps: 6, modelRequests: 0, reservedFinalRequests: 0, calls: 0,
    toolResults: [], totalToolResultBytes: 0, preparedToolCallKeys: new Set(),
  };
}

function completion(content = 'Verified answer.') {
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AI provider latency options', () => {
  it('sends disabled thinking by default on gathering requests', async () => {
    vi.stubEnv('AI_DISABLE_THINKING', undefined);
    const create = vi.fn().mockResolvedValue(completion());
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await requestCompletion(context(create), [{ role: 'user', content: 'test' }]);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 1_024,
    });
  });

  it('omits chat_template_kwargs when thinking is explicitly enabled', async () => {
    vi.stubEnv('AI_DISABLE_THINKING', 'false');
    const create = vi.fn().mockResolvedValue(completion());
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await requestCompletion(context(create), [{ role: 'user', content: 'test' }]);

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('rejects a length-terminated gathering response with an explicit finishReason diagnostic before parsing', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ index: 0, finish_reason: 'length',
      message: { content: '{"kind":"final","response":{"text":"Valid JSON but truncated"}}' } }] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await expect(requestCompletion(context(create), [{ role: 'user', content: 'test' }]))
      .rejects.toMatchObject({ code: 'invalid_model_response', finishReason: 'length' });
    expect(create).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['gathering', 1_024],
    ['narrativePlan', 1_536],
    ['finalSynthesis', 2_048],
  ] as const)('uses the %s output-token cap', (stage, maxTokens) => {
    expect(getAIProviderOptions(stage).request.max_tokens).toBe(maxTokens);
  });

  it('shrinks request timeouts and refuses to start below eight seconds remaining', () => {
    vi.stubEnv('AI_REQUEST_TIMEOUT_MS', undefined);
    expect(getAIRequestTimeoutMs()).toBe(30_000);
    expect(getRequestTimeoutForRemaining(80_000)).toBe(30_000);
    expect(getRequestTimeoutForRemaining(25_000)).toBe(20_000);
    expect(getRequestTimeoutForRemaining(8_000)).toBe(3_000);
    expect(getRequestTimeoutForRemaining(7_999)).toBeUndefined();
  });

  it('does not start a gathering request with less than eight seconds left', async () => {
    const create = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await expect(requestCompletion(context(create, NOW + 7_999), [{ role: 'user', content: 'test' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(create).not.toHaveBeenCalled();
  });

  it('retries one first-gather connection timeout when at least 25 seconds remain', async () => {
    vi.stubEnv('AI_DISABLE_THINKING', 'true');
    const create = vi.fn()
      .mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError({ message: 'private timeout detail' }))
      .mockResolvedValueOnce(completion());
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await requestCompletion(context(create), [{ role: 'user', content: 'test' }]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('does not retry a gathering failure after a tool call', async () => {
    const create = vi.fn().mockRejectedValue(new OpenAI.APIConnectionTimeoutError({ message: 'private timeout detail' }));
    const run = context(create);
    run.calls = 1;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await expect(requestCompletion(run, [{ role: 'user', content: 'test' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(create).toHaveBeenCalledOnce();
  });

  it('does not retry a connection timeout after the first gathering request', async () => {
    const create = vi.fn().mockRejectedValue(new OpenAI.APIConnectionTimeoutError({ message: 'private timeout detail' }));
    const run = context(create);
    run.modelRequests = 1;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await expect(requestCompletion(run, [{ role: 'user', content: 'test' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(create).toHaveBeenCalledOnce();
  });

  it('does not retry a first-gather timeout when fewer than 25 seconds remain', async () => {
    const create = vi.fn().mockRejectedValue(new OpenAI.APIConnectionTimeoutError({ message: 'private timeout detail' }));
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await expect(requestCompletion(context(create, NOW + 24_999), [{ role: 'user', content: 'test' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(create).toHaveBeenCalledOnce();
  });

  it('uses bounded environment values for request timeout and step count', () => {
    vi.stubEnv('AI_REQUEST_TIMEOUT_MS', '90000');
    vi.stubEnv('AI_MAX_STEPS_PER_TURN', '5');
    expect(getAIRequestTimeoutMs()).toBe(30_000);
    expect(getAIMaxStepsPerTurn()).toBe(5);
    vi.stubEnv('AI_MAX_STEPS_PER_TURN', '999');
    expect(getAIMaxStepsPerTurn()).toBe(6);
  });
});
