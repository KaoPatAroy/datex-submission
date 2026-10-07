import 'server-only';

import OpenAI from 'openai';
import type { AIInput, ToolDescriptor } from '../contracts';
import type { RuntimeSettings } from './client';
import { AIRuntimeError, backendAuthorizationFailure } from './errors';
import { DomainError } from '../core/errors';
import { unsupportedWidgetResultSchema } from '../core/dashboard-renderer-support';
import type { ExposedTool } from './tool-schemas';
import {
  AI_MAX_REQUEST_TIMEOUT_MS,
  AI_MIN_REQUEST_REMAINING_MS,
  AI_OVERALL_DEADLINE_MS,
  getAIProviderOptions,
  getAIMaxStepsPerTurn,
  getRequestTimeoutForRemaining,
} from './provider-options';

/** A registered tool refused a model-built request (4xx domain rule) before any effect; the model may adjust and retry. */
export class ToolRejectedError extends AIRuntimeError {
  constructor(readonly domainCode: string, readonly domainMessage: string, status: number) {
    super('tool_execution_failed', 'A requested tool rejected the request.', undefined, status);
    this.name = 'ToolRejectedError';
  }
}

export const MAX_INPUT_BYTES = 24_000;
export const MAX_HISTORY_MESSAGES = 12;
export const MAX_TOOL_CALLS = 6;
export const MAX_MODEL_STEPS = 7;
export const MAX_TOOL_RESULT_BYTES = 48_000;
export const MAX_TOTAL_TOOL_RESULT_BYTES = 160_000;
export const MAX_FINAL_TEXT_BYTES = 6_000;
export const OVERALL_DEADLINE_MS = AI_OVERALL_DEADLINE_MS;
export const MAX_REQUEST_TIMEOUT_MS = AI_MAX_REQUEST_TIMEOUT_MS;

export interface RunContext {
  input: AIInput;
  settings: RuntimeSettings;
  client: OpenAI;
  tools: ExposedTool[];
  byCanonicalName: Map<string, ExposedTool>;
  byWireName: Map<string, ExposedTool>;
  deadlineAt: number;
  /** Overrides the per-request timeout policy for short, self-bounded callers such as the query planner. */
  requestTimeoutForRemaining?: (remainingMs: number) => number | undefined;
  maxModelSteps?: number;
  modelRequests: number;
  reservedFinalRequests: number;
  signal?: AbortSignal;
  calls: number;
  toolResults: { name: string; audit?:'read'|'prepare'; result: unknown }[];
  totalToolResultBytes: number;
  preparedToolCallKeys: Set<string>;
}

export class NativeCapabilityError extends Error {
  constructor() {
    super('native tool capability unavailable');
    this.name = 'NativeCapabilityError';
  }
}

export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function isProviderTimeout(error: unknown, status = providerStatus(error)): boolean {
  const name = error instanceof Error ? error.name
    : error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : undefined;
  return error instanceof OpenAI.APIConnectionTimeoutError || name === 'APIConnectionTimeoutError'
    || name === 'TimeoutError' || status === 408 || status === 504;
}

/** Server-only, allowlisted failure metadata. Never log provider messages or request bodies. */
export function logProviderFailure(input: {
  diagnosticId?: string;
  baseURL: string;
  model: string;
  stage: 'gathering' | 'final_synthesis_stream' | 'final_synthesis_nonstream';
  requestOrdinal?: number;
  timeoutMs: number;
  thinkingDisabled: boolean;
  maxTokens: number;
  startedAt: number;
  error: unknown;
}): void {
  const name = input.error instanceof Error ? input.error.name : '';
  const errorClass = input.error instanceof OpenAI.APIConnectionTimeoutError ? 'APIConnectionTimeoutError'
    : input.error instanceof OpenAI.APIConnectionError ? 'APIConnectionError'
    : new Set([
    'APIConnectionTimeoutError', 'APIConnectionError', 'RateLimitError',
    'AuthenticationError', 'PermissionDeniedError', 'NotFoundError',
    'BadRequestError', 'InternalServerError', 'APIError', 'TimeoutError'
  ]).has(name) ? name : 'unknown';
  const status = providerStatus(input.error);
  console.error('BIZTANIA_AI_PROVIDER_FAILURE', JSON.stringify({
    diagnosticId: input.diagnosticId ?? null,
    stage: input.stage,
    requestOrdinal: input.requestOrdinal ?? null,
    endpointHost: new URL(input.baseURL).host,
    model: input.model,
    errorClass,
    upstreamStatus: status ?? null,
    timeoutStage: errorClass === 'APIConnectionTimeoutError' || errorClass === 'TimeoutError' || status === 408 || status === 504 ? input.stage : null,
    timeoutMs: input.timeoutMs,
    thinkingDisabled: input.thinkingDisabled,
    maxTokens: input.maxTokens,
    elapsedMs: Math.max(0, Date.now() - input.startedAt)
  }));
}

export function ensureBeforeDeadline(context: RunContext): number {
  context.signal?.throwIfAborted();
  const remaining = context.deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new AIRuntimeError('deadline_exceeded', 'The AI response took too long. Switch to Scripted Demo or try again.');
  }
  return remaining;
}

export function modelStepLimit(context: RunContext): number {
  return Math.min(MAX_MODEL_STEPS, context.maxModelSteps ?? getAIMaxStepsPerTurn());
}

/** Rejected attempts count too; gathering cannot consume the final request reserve. */
export function debitModelRequest(context: RunContext, phase: 'gathering' | 'synthesis'): number {
  const remaining = ensureBeforeDeadline(context);
  if (context.requestTimeoutForRemaining ? context.requestTimeoutForRemaining(remaining) === undefined : remaining < AI_MIN_REQUEST_REMAINING_MS) {
    throw new AIRuntimeError('deadline_exceeded', 'The AI response took too long. Switch to Scripted Demo or try again.');
  }
  const limit = modelStepLimit(context) - (phase === 'gathering' ? context.reservedFinalRequests : 0);
  if (context.modelRequests >= limit) {
    throw new AIRuntimeError('invalid_model_response', 'The AI reached its response step limit. Switch to Scripted Demo or try again.',
      undefined, undefined, { reason: 'model_step_limit' });
  }
  context.modelRequests++;
  return remaining;
}

export async function requestCompletion(
  context: RunContext,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  withNativeTools = false
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  debitModelRequest(context, 'gathering');
  const providerOptions = getAIProviderOptions('gathering');
  const base = {
    model: context.settings.model,
    messages,
    temperature: 0,
    ...providerOptions.request,
  };
  const toolParameters = withNativeTools ? {
    tools: context.tools.map(({ wireName, descriptor, strictInputJsonSchema }) => ({
      type: 'function' as const,
      function: {
        name: wireName,
        description: descriptor.description.slice(0, 500),
        parameters: strictInputJsonSchema,
        strict: true
      }
    })),
    tool_choice: 'auto' as const
  } : {};

  const requestBody = { ...base, ...toolParameters };
  const firstGatheringRequest = context.modelRequests === 1 && context.calls === 0 && context.toolResults.length === 0;
  let attempt = 0;
  while (true) {
    const timeoutMs = (context.requestTimeoutForRemaining ?? getRequestTimeoutForRemaining)(context.deadlineAt - Date.now());
    if (timeoutMs === undefined) {
      throw new AIRuntimeError('deadline_exceeded', 'The AI response took too long. Switch to Scripted Demo or try again.');
    }
    const startedAt = Date.now();
    try {
      const completion = await context.client.chat.completions.create(
        requestBody,
        { timeout: timeoutMs, signal: context.signal }
      );
      if (!completion || !Array.isArray(completion.choices)
        || completion.choices.some(choice => !choice || typeof choice !== 'object')) {
        throw new AIRuntimeError('invalid_model_response', 'The AI returned an invalid completion envelope.');
      }
      // Never parse or execute a truncated envelope, even if its JSON happens to be valid.
      if (completion.choices.some(choice => choice.finish_reason === 'length')) {
        throw new AIRuntimeError('invalid_model_response', 'The AI gathering response was truncated.',
          undefined, undefined, { finishReason: 'length' });
      }
      return completion;
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof AIRuntimeError) throw error;
      logProviderFailure({
        diagnosticId: context.input.diagnosticId,
        baseURL: context.settings.baseURL,
        model: context.settings.model,
        stage: 'gathering',
        requestOrdinal: context.modelRequests,
        timeoutMs,
        thinkingDisabled: providerOptions.thinkingDisabled,
        maxTokens: providerOptions.maxTokens,
        startedAt,
        error,
      });
      const status = providerStatus(error);
      const remainingAfterFailure = context.deadlineAt - Date.now();
      if (attempt === 0 && firstGatheringRequest && isRetryableGatheringFailure(error, status)
        && remainingAfterFailure >= 25_000) {
        attempt++;
        continue;
      }
      const timedOut = isProviderTimeout(error, status);
      throw new AIRuntimeError(
        timedOut ? 'deadline_exceeded' : 'provider_unavailable',
        timedOut
          ? 'The AI response took too long. Switch to Scripted Demo or try again.'
          : 'The AI provider is unavailable. Switch to Scripted Demo or try again.',
        status
      );
    }
  }
}

function isRetryableGatheringFailure(error: unknown, status = providerStatus(error)): boolean {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return true;
  if (status !== undefined && status >= 500) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === 'ECONNRESET') return true;
    current = value.cause;
  }
  return false;
}

export function validateInput(input: AIInput): void {
  if (typeof input.message !== 'string' || Buffer.byteLength(input.message, 'utf8') > MAX_INPUT_BYTES) {
    throw new AIRuntimeError('invalid_input', 'The message is too long for the AI runtime.');
  }
  if (!Array.isArray(input.history) || input.history.length > MAX_HISTORY_MESSAGES) {
    throw new AIRuntimeError('invalid_input', 'The conversation is too long for the AI runtime.');
  }
  let size = Buffer.byteLength(input.message, 'utf8')+Buffer.byteLength(JSON.stringify(input.context??{}),'utf8');
  for (const item of input.history) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') {
      throw new AIRuntimeError('invalid_input', 'The conversation contains an invalid message.');
    }
    const itemSize = Buffer.byteLength(item.content, 'utf8');
    if (itemSize > 8_000) throw new AIRuntimeError('invalid_input', 'A conversation message is too long for the AI runtime.');
    size += itemSize;
  }
  if (size > MAX_INPUT_BYTES) throw new AIRuntimeError('invalid_input', 'The conversation is too long for the AI runtime.');
}

export function parseArguments(tool: ExposedTool, raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > 16_000) {
    throw new AIRuntimeError('invalid_model_response', 'The AI returned oversized tool arguments.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new AIRuntimeError('invalid_model_response', 'The AI returned invalid tool arguments.');
  }
  return decoded;
}

export async function validateToolArguments(tool: ExposedTool, decoded: unknown): Promise<unknown> {
  try {
    const parsed = await tool.descriptor.inputSchema.parseAsync(decoded);
    return parsed;
  } catch {
    throw new AIRuntimeError('invalid_model_response', 'The AI returned tool arguments that failed validation.');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function executeTool(
  context: RunContext,
  descriptor: ToolDescriptor,
  args: unknown
): Promise<unknown> {
  const remaining = ensureBeforeDeadline(context);
  if (descriptor.audit !== 'read' && descriptor.audit !== 'prepare') {
    throw new AIRuntimeError('tool_unavailable', 'That operation requires the guarded confirmation flow.');
  }
  const preparedToolCallKey = descriptor.audit === 'prepare' ? `${descriptor.name}:${stableJson(args)}` : undefined;
  if (preparedToolCallKey && context.preparedToolCallKeys.has(preparedToolCallKey)) {
    throw new AIRuntimeError('invalid_model_response', 'The AI repeated a preparation request in the same turn.');
  }
  if (context.calls >= MAX_TOOL_CALLS) {
    throw new AIRuntimeError('invalid_model_response', 'The AI requested too many tool calls.');
  }

  context.calls++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const timeoutMs = Math.max(1, Math.min(descriptor.timeoutMs, remaining));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AIRuntimeError('deadline_exceeded', 'A tool took too long. Switch to Scripted Demo or try again.')), timeoutMs);
    });
    const canceled = new Promise<never>((_, reject) => {
      if (!context.signal) return;
      abortListener = () => reject(context.signal?.reason ?? new DOMException('The response was stopped.', 'AbortError'));
      context.signal.addEventListener('abort', abortListener, { once: true });
      if (context.signal.aborted) abortListener();
    });
    ensureBeforeDeadline(context);
    const raw = await Promise.race([context.input.broker.execute(descriptor.name, args), timeout, canceled]);
    ensureBeforeDeadline(context);
    const validated = await descriptor.resultSchema.parseAsync(raw);
    ensureBeforeDeadline(context);
    const resultBytes = Buffer.byteLength(JSON.stringify(validated) ?? '', 'utf8');
    if (resultBytes > MAX_TOOL_RESULT_BYTES || context.totalToolResultBytes + resultBytes > MAX_TOTAL_TOOL_RESULT_BYTES) {
      throw new AIRuntimeError('tool_execution_failed', 'A tool returned too much data for the AI runtime.');
    }
    context.totalToolResultBytes += resultBytes;
    context.toolResults.push({ name: descriptor.name, audit:descriptor.audit, result: validated });
    if (preparedToolCallKey && !unsupportedWidgetResultSchema.safeParse(validated).success) context.preparedToolCallKeys.add(preparedToolCallKey);
    return validated;
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof AIRuntimeError) throw error;
    const authorizationFailure = backendAuthorizationFailure(error);
    if (authorizationFailure) {
      const message = authorizationFailure.code === 'FORBIDDEN'
        ? 'You are not authorized to use this tool.'
        : 'Your session is no longer valid. Sign in again.';
      throw new AIRuntimeError(authorizationFailure.code, message, undefined, authorizationFailure.status);
    }
    if (error instanceof DomainError && error.status >= 400 && error.status < 500) {
      throw new ToolRejectedError(error.code, error.message, error.status);
    }
    throw new AIRuntimeError('tool_execution_failed', 'A requested tool could not be completed safely.');
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) context.signal?.removeEventListener('abort', abortListener);
  }
}

export function makeConversationMessages(context: RunContext, systemPrompt: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: systemPrompt },
    ...context.input.history.map((item) => ({ role: item.role, content: item.content } as const)),
    { role: 'user', content: context.input.message }
  ];
}

export function assertFinalTextSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_FINAL_TEXT_BYTES) {
    throw new AIRuntimeError('invalid_model_response', 'The AI response was too long. Switch to Scripted Demo or try again.');
  }
}
