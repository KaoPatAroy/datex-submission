import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { logProviderFailure, requestCompletion, type RunContext } from '../lib/ai/loop-core';

const LOG_TAG = 'BIZTANIA_AI_PROVIDER_FAILURE';
const BASE_URL = 'https://provider.example/v1';
const MODEL = 'diagnostics-test-model';
const FIXED_NOW = 10_000;
const PROVIDER_TIMEOUT_DETAIL = 'provider timeout detail must stay private';

function sdkTimeoutError(): InstanceType<typeof OpenAI.APIConnectionTimeoutError> {
  return new OpenAI.APIConnectionTimeoutError({ message: PROVIDER_TIMEOUT_DETAIL });
}

function namedTimeoutError(): Error {
  return Object.assign(new Error(PROVIDER_TIMEOUT_DETAIL), { name: 'TimeoutError' });
}

function expectTimeoutDiagnostic(
  logError: ReturnType<typeof vi.spyOn>,
  diagnosticId: string,
  stage: 'gathering',
  requestOrdinal?: number,
  errorClass = 'APIConnectionTimeoutError'
): void {
  expect(logError).toHaveBeenCalledTimes(1);
  const [tag, serializedMetadata] = logError.mock.calls[0] ?? [];
  expect(tag).toBe(LOG_TAG);
  const metadata = JSON.parse(String(serializedMetadata));
  expect(metadata).toMatchObject({
    diagnosticId,
    stage,
    requestOrdinal: requestOrdinal ?? null,
    endpointHost: 'provider.example',
    model: MODEL,
    errorClass,
    upstreamStatus: null,
    timeoutStage: stage,
    timeoutMs: stage === 'gathering' ? 30_000 : 25_000,
    thinkingDisabled: true,
    maxTokens: stage === 'gathering' ? 1_024 : 2_048,
    elapsedMs: 0,
  });
  expect(String(serializedMetadata)).not.toContain(PROVIDER_TIMEOUT_DETAIL);
}

function runContext(client: OpenAI, diagnosticId: string): RunContext {
  return {
    input: {
      message: 'Synthetic request input.',
      history: [],
      actor: {
        id: 'actor-test',
        name: 'Test actor',
        role: 'executive',
        active: true,
        permissions: [],
        regions: [],
        sessionId: 'session-test',
        mode: 'live_ai',
        modeRevision: 1,
      },
      businessDate: '2026-10-04',
      broker: { execute: async () => undefined, descriptors: [] },
      diagnosticId,
    },
    settings: { baseURL: BASE_URL, model: MODEL, toolMode: 'planner' },
    client,
    tools: [],
    byCanonicalName: new Map(),
    byWireName: new Map(),
    deadlineAt: FIXED_NOW + 60_000,
    modelRequests: 0,
    reservedFinalRequests: 1,
    calls: 0,
    toolResults: [],
    totalToolResultBytes: 0,
    preparedToolCallKeys: new Set(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('AI_DISABLE_THINKING', 'true');
  vi.stubEnv('AI_REQUEST_TIMEOUT_MS', '30000');
});

describe('AI provider failure diagnostics', () => {
  it('logs a gathering provider failure with the internal diagnostic ID', async () => {
    const providerFailure = Object.assign(new Error('synthetic provider detail'), {
      name: 'APIConnectionError',
      status: 503,
    });
    const create = vi.fn().mockRejectedValue(providerFailure);
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const context = runContext(client, 'internal-diagnostic-callsite-001');
    context.calls = 1;
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    await expect(requestCompletion(context, [{ role: 'user', content: 'synthetic request body marker' }]))
      .rejects.toMatchObject({ code: 'provider_unavailable', providerStatus: 503 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, serializedMetadata] = logError.mock.calls[0] ?? [];
    expect(tag).toBe(LOG_TAG);
    const metadata = JSON.parse(String(serializedMetadata));
    expect(metadata).toMatchObject({
      diagnosticId: 'internal-diagnostic-callsite-001',
      stage: 'gathering',
      requestOrdinal: 1,
      endpointHost: 'provider.example',
      model: MODEL,
      upstreamStatus: 503,
      timeoutMs: 30_000,
      elapsedMs: 0,
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain('synthetic provider detail');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('synthetic request body marker');
  });

  it('classifies and logs the SDK connection timeout during gathering', async () => {
    const timeoutError = sdkTimeoutError();
    expect(timeoutError).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    expect(timeoutError.name).toBe('Error');
    expect(timeoutError.status).toBeUndefined();

    const create = vi.fn().mockRejectedValue(timeoutError);
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const context = runContext(client, 'internal-diagnostic-gathering-timeout');
    context.calls = 1;
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    await expect(requestCompletion(context, [{ role: 'user', content: 'synthetic request body marker' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded', providerStatus: undefined });

    expect(create).toHaveBeenCalledTimes(1);
    expectTimeoutDiagnostic(logError, 'internal-diagnostic-gathering-timeout', 'gathering', 1);
    expect(JSON.stringify(logError.mock.calls)).not.toContain('synthetic request body marker');
  });

  it('classifies a named TimeoutError during gathering as a deadline, not a provider outage', async () => {
    const create = vi.fn().mockRejectedValue(namedTimeoutError());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const context = runContext(client, 'internal-diagnostic-named-gathering-timeout');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    await expect(requestCompletion(context, [{ role: 'user', content: 'synthetic request body marker' }]))
      .rejects.toMatchObject({ code: 'deadline_exceeded', providerStatus: undefined });

    expect(create).toHaveBeenCalledTimes(1);
    expectTimeoutDiagnostic(logError, 'internal-diagnostic-named-gathering-timeout', 'gathering', 1, 'TimeoutError');
  });

  it('gives caller abort precedence over a gathering TimeoutError', async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error('caller stopped the request'), { name: 'AbortError' });
    const create = vi.fn().mockImplementation(async () => {
      controller.abort(abortReason);
      throw namedTimeoutError();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const context = { ...runContext(client, 'internal-diagnostic-abort-wins'), signal: controller.signal };
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    await expect(requestCompletion(context, [{ role: 'user', content: 'synthetic request body marker' }]))
      .rejects.toBe(abortReason);

    expect(create).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('logs allowlisted metadata while excluding provider-controlled details', () => {
    const error = Object.assign(new Error('provider-only-error-message'), {
      name: 'ProviderSecretErrorName',
      status: 504,
      headers: {
        authorization: 'Bearer header-auth-secret',
        'x-api-key': 'header-key-secret',
      },
      auth: 'auth-property-secret',
      apiKey: 'api-key-property-secret',
      prompt: 'prompt-property-secret',
      body: { content: 'body-property-secret' },
      request: { body: { content: 'request-body-secret' } },
    });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(10_000);

    logProviderFailure({
      diagnosticId: 'diag-2026-10-04-abc123',
      baseURL: `${BASE_URL}?api_key=url-query-secret`,
      model: MODEL,
      stage: 'final_synthesis_stream',
      requestOrdinal: 2,
      timeoutMs: 4_500,
      thinkingDisabled: true,
      maxTokens: 2_048,
      startedAt: 8_750,
      error,
    });

    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, serializedMetadata] = logError.mock.calls[0] ?? [];
    expect(tag).toBe(LOG_TAG);
    expect(typeof serializedMetadata).toBe('string');

    const metadata = JSON.parse(String(serializedMetadata));
    expect(metadata).toEqual({
      diagnosticId: 'diag-2026-10-04-abc123',
      stage: 'final_synthesis_stream',
      requestOrdinal: 2,
      endpointHost: 'provider.example',
      model: MODEL,
      errorClass: 'unknown',
      upstreamStatus: 504,
      timeoutStage: 'final_synthesis_stream',
      timeoutMs: 4_500,
      thinkingDisabled: true,
      maxTokens: 2_048,
      elapsedMs: 1_250,
    });

    const output = `${tag} ${serializedMetadata}`;
    for (const sensitiveValue of [
      'provider-only-error-message',
      'ProviderSecretErrorName',
      'header-auth-secret',
      'header-key-secret',
      'auth-property-secret',
      'api-key-property-secret',
      'prompt-property-secret',
      'body-property-secret',
      'request-body-secret',
      'url-query-secret',
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
  });
});
