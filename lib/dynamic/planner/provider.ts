import 'server-only';

import type OpenAI from 'openai';
import type { Actor } from '../../contracts';
import { createAIClient, getRuntimeSettings } from '../../ai/client';
import { AIRuntimeError } from '../../ai/errors';
import { scriptedRuntimeAllowed } from '../../ai/scripted-runtime';
import { requestCompletion, type RunContext } from '../../ai/loop-core';
import type { PlannerInput } from './planner';
import type { QueryPlan } from '../plan/schemas';
import { scriptedQueryPlan } from './scripted';

export interface PlannerRuntime {
  actor: Actor; businessDate: string; diagnosticId: string; deadlineAt: number; signal: AbortSignal;
  previousPlan?: QueryPlan;
  onFinishReason?: (reason: string | null) => void;
}

/** Planner-specific request ceiling; the shared 24 KB runtime limit sizes chat messages, not the catalog-bearing planner prompt. */
export const PLANNER_MAX_INPUT_BYTES = 48_000;

/** Isolated client adapter until shared AI request parameters are centralized. */
function createPlannerClient(baseURL: string): ReturnType<typeof createAIClient> {
  const client = createAIClient(baseURL);
  const create = client.chat.completions.create.bind(client.chat.completions);
  const plannerParameters = (body: OpenAI.Chat.Completions.ChatCompletionCreateParams) => ({
    ...body, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false },
  });
  // Expose only the non-streaming completion method used by the planner.
  return { chat: { completions: { create: (body, options) => create(plannerParameters(body), options) } } } as ReturnType<typeof createAIClient>;
}

/** One model request through the existing client, deadline, and safe provider diagnostics. */
export async function requestQueryPlan(input: PlannerInput, runtime: PlannerRuntime): Promise<unknown> {
  // The current AI client rejects scripted; this adapter is confined to local test data.
  // Local release E2E opts in explicitly; hosted deployments never use fixtures.
  const localScriptedRuntime = scriptedRuntimeAllowed();
  if (process.env.AI_PROVIDER === 'scripted'
    && localScriptedRuntime && !process.env.VERCEL && process.env.USE_LOCAL_DEMO_DATA === 'true'
    && process.env.BIZTANIA_DEPLOYMENT_ENV !== 'production') {
    runtime.signal.throwIfAborted();
    if (Date.now() >= runtime.deadlineAt) {
      throw new AIRuntimeError('deadline_exceeded', 'The query planner deadline has expired.');
    }
    runtime.onFinishReason?.('stop');
    return JSON.stringify(scriptedQueryPlan(input, runtime.businessDate, runtime.previousPlan));
  }
  const settings = getRuntimeSettings();
  const system = `${input.prompt}\nReturn only JSON matching this schema:\n${JSON.stringify(input.jsonSchema)}`;
  const inputBytes = Buffer.byteLength(system + input.sourceText, 'utf8');
  if (inputBytes > PLANNER_MAX_INPUT_BYTES) {
    throw new AIRuntimeError('invalid_input', 'The query context exceeds the AI runtime size limit.');
  }
  const context: RunContext = {
    input: { message: input.sourceText, history: [], actor: runtime.actor, businessDate: runtime.businessDate,
      diagnosticId: runtime.diagnosticId, broker: { descriptors: [], execute: async () => {
        throw new AIRuntimeError('tool_unavailable', 'The query planner cannot execute tools.');
      } } },
    settings, client: createPlannerClient(settings.baseURL), tools: [], byCanonicalName: new Map(), byWireName: new Map(),
    deadlineAt: runtime.deadlineAt, signal: runtime.signal,
    // The planner owns its deadline; the turn-level 8 s minimum would reject every short shadow budget.
    requestTimeoutForRemaining: remaining => remaining > 0 ? Math.max(1, Math.floor(remaining)) : undefined, modelRequests: 0, reservedFinalRequests: 0,
    calls: 0, toolResults: [], totalToolResultBytes: 0, preparedToolCallKeys: new Set(),
  };
  const completion = await requestCompletion(context, [
    { role: 'system', content: system }, { role: 'user', content: input.sourceText },
  ]);
  const choice = completion.choices[0];
  runtime.onFinishReason?.(choice?.finish_reason ?? null);
  if (!choice || choice.finish_reason !== 'stop' || !choice.message.content) {
    throw new AIRuntimeError('invalid_model_response', 'The query planner returned no complete plan.', undefined, undefined,
      { finishReason: choice?.finish_reason });
  }
  return choice.message.content;
}
