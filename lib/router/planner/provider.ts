import 'server-only';

import type OpenAI from 'openai';
import type { Actor } from '../../contracts';
import { createAIClient, getRuntimeSettings } from '../../ai/client';
import { AIRuntimeError } from '../../ai/errors';
import { scriptedRuntimeAllowed } from '../../ai/scripted-runtime';
import { readDynamicPlannerTimeoutMs } from '../../dynamic/config';
import { requestCompletion, providerStatus, type RunContext } from '../../ai/loop-core';
import type { TurnPlan } from '../turn-plan';
import { TURN_PLANNER_MAX_INPUT_BYTES, type TurnPlannerInput } from './input';
import { parseTurnPlan } from './parse';
import { scriptedTurnPlan } from './scripted';
import { isTruncation, plannerFailureCode, safeRejectCodes, TRUNCATION_REPAIR_PROMPT, type PlannerFailureCode } from './diagnostics';

const TURN_PLANNER_MAX_TOKENS = 1536;
const REPAIR_MIN_REMAINING_MS = 8_000;
/** Work the turn still needs after planning (executors, rendering, persistence): a slow-attempt retry must leave it. */
export const PLANNER_RETRY_RESERVE_MS = 20_000;

export interface TurnPlannerRuntime {
  actor: Actor;
  diagnosticId: string;
  signal?: AbortSignal;
  onFinishReason?: (reason: string | null) => void;
  /** Whole-turn deadline: when the per-attempt cap (BIZTANIA_DYNAMIC_PLANNER_TIMEOUT_MS) is hit, one more attempt is made only if this leaves room. */
  turnDeadlineAt?: number;
}

function createPlannerClient(baseURL: string): ReturnType<typeof createAIClient> {
  const client = createAIClient(baseURL);
  const create = client.chat.completions.create.bind(client.chat.completions);
  const plannerParameters = (body: OpenAI.Chat.Completions.ChatCompletionCreateParams) => ({
    ...body, max_tokens: TURN_PLANNER_MAX_TOKENS, chat_template_kwargs: { enable_thinking: false },
  });
  return { chat: { completions: { create: (body, options) => create(plannerParameters(body), options) } } } as ReturnType<typeof createAIClient>;
}

function localScriptedPlannerAllowed(): boolean {
  return scriptedRuntimeAllowed()
    && process.env.AI_PROVIDER === 'scripted'
    && process.env.USE_LOCAL_DEMO_DATA === 'true'
    && !process.env.VERCEL
    && process.env.BIZTANIA_DEPLOYMENT_ENV !== 'production';
}

function runContext(input: TurnPlannerInput, runtime: TurnPlannerRuntime, settings: ReturnType<typeof getRuntimeSettings>, deadlineAt: number): RunContext {
  return {
    input: {
      message: input.currentMessage, history: [], actor: runtime.actor, businessDate: input.context.business.date,
      diagnosticId: runtime.diagnosticId,
      broker: { descriptors: [], execute: async () => {
        throw new AIRuntimeError('tool_unavailable', 'The turn planner cannot execute tools.');
      } },
    },
    settings, client: createPlannerClient(settings.baseURL), tools: [], byCanonicalName: new Map(), byWireName: new Map(),
    deadlineAt, requestTimeoutForRemaining: remaining => remaining > 0 ? Math.max(1, Math.floor(remaining)) : undefined,
    modelRequests: 0, reservedFinalRequests: 0, signal: runtime.signal, calls: 0, toolResults: [], totalToolResultBytes: 0,
    preparedToolCallKeys: new Set(),
  };
}

function invalidPlanError(): AIRuntimeError {
  return new AIRuntimeError('invalid_model_response', 'The turn planner returned no valid plan.');
}

function completionText(completion: Awaited<ReturnType<typeof requestCompletion>>, runtime: TurnPlannerRuntime): string {
  const choice = completion.choices[0];
  runtime.onFinishReason?.(choice?.finish_reason ?? null);
  if (!choice || choice.finish_reason !== 'stop' || typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
    throw new AIRuntimeError('invalid_model_response', 'The turn planner returned no complete plan.', undefined, undefined,
      { finishReason: choice?.finish_reason });
  }
  return choice.message.content;
}

function validationErrorText(issuePaths: readonly string[]): string {
  return `Validator errors (paths and codes only):\n${issuePaths.join('\n')}`;
}

/** One thinking-disabled model request, followed by at most one schema repair request. */
export async function requestTurnPlan(input: TurnPlannerInput, runtime: TurnPlannerRuntime): Promise<TurnPlan> {
  try { return await requestTurnPlanAttempt(input, runtime); }
  catch (error) {
    // A merely slow gateway: one more attempt (same per-attempt cap) only when the whole-turn budget still holds a full
    // attempt plus the post-plan reserve. Otherwise the deadline error surfaces as the "AI is slow, try again" answer.
    const timedOut = error instanceof AIRuntimeError && error.code === 'deadline_exceeded';
    const room = runtime.turnDeadlineAt !== undefined
      && runtime.turnDeadlineAt - Date.now() >= readDynamicPlannerTimeoutMs() + PLANNER_RETRY_RESERVE_MS;
    if (!timedOut || !room || runtime.signal?.aborted) throw error;
    console.info('BIZTANIA_TURN_PLANNER_RETRY', JSON.stringify({ reason: 'planner_timeout' }));
    return requestTurnPlanAttempt(input, runtime);
  }
}

async function requestTurnPlanAttempt(input: TurnPlannerInput, runtime: TurnPlannerRuntime): Promise<TurnPlan> {
  const startedAt = Date.now();
  const timeoutMs = readDynamicPlannerTimeoutMs();
  const deadlineAt = startedAt + timeoutMs;
  let repairUsed = false;
  let kinds: string[] = [];
  let upstreamStatus: number | null = null;
  // Codes only (never prompt, prose or user text): why the first response / the repair was rejected, and why a repair was skipped.
  let failure: PlannerFailureCode | null = null, repairFailure: PlannerFailureCode | null = null;
  let rejectCodes: string[] = [], repairRejectCodes: string[] = [];
  let repairSkipped: 'no_time' | 'too_large' | null = null;
  try {
    runtime.signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new AIRuntimeError('deadline_exceeded', 'The turn planner deadline has expired.');
    if (localScriptedPlannerAllowed()) {
      const scripted = scriptedTurnPlan(input);
      const parsed = parseTurnPlan(scripted, input.validator, input.context);
      if (!parsed.success) throw invalidPlanError();
      kinds = parsed.plan.steps.map(step => step.kind);
      runtime.onFinishReason?.('stop');
      return parsed.plan;
    }

    const settings = getRuntimeSettings();
    const context = runContext(input, runtime, settings, deadlineAt);
    const initialMessages = [
      { role: 'system' as const, content: input.systemPrompt },
      { role: 'user' as const, content: input.currentMessage },
    ];
    // A response cut off at max_tokens (finish_reason "length") is repaired like a schema failure, with a compact-output instruction
    // instead of the (unusable) truncated text.
    let first: string | null = null;
    try { first = completionText(await requestCompletion(context, initialMessages), runtime); }
    catch (error) { if (!isTruncation(error)) throw error; failure = 'truncated'; }
    const parsed = first === null ? null : parseTurnPlan(first, input.validator, input.context);
    if (parsed?.success) {
      kinds = parsed.plan.steps.map(step => step.kind);
      return parsed.plan;
    }
    if (parsed) { failure = parsed.code; rejectCodes = safeRejectCodes(parsed.issuePaths); }

    const repairMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = parsed && first !== null
      ? [...initialMessages, { role: 'assistant', content: first },
        { role: 'user', content: `The previous response failed schema validation. Correct it and return only JSON matching the schema.\n${validationErrorText(parsed.issuePaths)}` }]
      : [...initialMessages, { role: 'user', content: TRUNCATION_REPAIR_PROMPT }];
    // The repair may use the whole-turn budget beyond this attempt's cap (one slow first response must not forfeit the repair),
    // but never the reserve the turn needs after planning.
    context.deadlineAt = repairDeadline(deadlineAt, timeoutMs, runtime.turnDeadlineAt);
    const repairBytes = Buffer.byteLength(repairMessages.map(message => String(message.content)).join(''), 'utf8');
    if (context.deadlineAt - Date.now() < REPAIR_MIN_REMAINING_MS) { repairSkipped = 'no_time'; throw invalidPlanError(); }
    if (repairBytes > TURN_PLANNER_MAX_INPUT_BYTES) { repairSkipped = 'too_large'; throw invalidPlanError(); }
    repairUsed = true;
    let repaired: string;
    try { repaired = completionText(await requestCompletion(context, repairMessages), runtime); }
    catch (error) { repairFailure = plannerFailureCode(error); throw error; }
    const repairedPlan = parseTurnPlan(repaired, input.validator, input.context);
    if (!repairedPlan.success) {
      repairFailure = repairedPlan.code; repairRejectCodes = safeRejectCodes(repairedPlan.issuePaths);
      throw invalidPlanError();
    }
    kinds = repairedPlan.plan.steps.map(step => step.kind);
    return repairedPlan.plan;
  } catch (error) {
    upstreamStatus = providerStatus(error) ?? (error instanceof AIRuntimeError ? error.providerStatus ?? null : null);
    if (!failure) failure = plannerFailureCode(error);
    throw error;
  } finally {
    console.info('BIZTANIA_TURN_PLANNER', JSON.stringify({
      kinds, elapsedMs: Math.max(0, Date.now() - startedAt), inputBytes: input.inputBytes,
      providerStatus: upstreamStatus, repairUsed,
      ...(failure ? { failure } : {}), ...(rejectCodes.length ? { rejectCodes } : {}),
      ...(repairFailure ? { repairFailure } : {}), ...(repairRejectCodes.length ? { repairRejectCodes } : {}),
      ...(repairSkipped ? { repairSkipped } : {}),
    }));
  }
}

/** Deadline of the one repair request: up to a full per-attempt cap from now, bounded by the whole-turn deadline minus the post-plan reserve (never earlier than this attempt's own deadline). */
export function repairDeadline(attemptDeadlineAt: number, timeoutMs: number, turnDeadlineAt: number | undefined, now = Date.now()): number {
  if (turnDeadlineAt === undefined) return attemptDeadlineAt;
  return Math.max(attemptDeadlineAt, Math.min(now + timeoutMs, turnDeadlineAt - PLANNER_RETRY_RESERVE_MS));
}

export { localScriptedPlannerAllowed };
