export const ROUTE_MAX_DURATION_MS = 120_000;
export const POST_AI_PERSISTENCE_RESERVE_MS = 25_000;
export const TURN_WORK_DEADLINE_MS = ROUTE_MAX_DURATION_MS - POST_AI_PERSISTENCE_RESERVE_MS;
export const AI_OVERALL_DEADLINE_MS = 85_000;
export const AI_MAX_REQUEST_TIMEOUT_MS = 30_000;
export const AI_REQUEST_TIMEOUT_RESERVE_MS = 5_000;
export const AI_MIN_REQUEST_REMAINING_MS = 8_000;
export const DEFAULT_AI_MAX_STEPS_PER_TURN = 6;
export const MAX_AI_MAX_STEPS_PER_TURN = 7;

export const AI_STAGE_MAX_TOKENS = {
  gathering: 1_024,
  narrativePlan: 1_536,
  finalSynthesis: 2_048,
} as const;

export type AIProviderStage = keyof typeof AI_STAGE_MAX_TOKENS;

type ThinkingOption = { chat_template_kwargs: { enable_thinking: false } };

export interface AIProviderOptions {
  request: { max_tokens: number; chat_template_kwargs?: ThinkingOption['chat_template_kwargs'] };
  thinkingDisabled: boolean;
  maxTokens: number;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function getAIRequestTimeoutMs(): number {
  return boundedInteger(process.env.AI_REQUEST_TIMEOUT_MS, AI_MAX_REQUEST_TIMEOUT_MS, 1_000, AI_MAX_REQUEST_TIMEOUT_MS);
}

export function getAIMaxStepsPerTurn(): number {
  return boundedInteger(process.env.AI_MAX_STEPS_PER_TURN, DEFAULT_AI_MAX_STEPS_PER_TURN, 3, MAX_AI_MAX_STEPS_PER_TURN);
}

export function getRequestTimeoutForRemaining(remainingMs: number): number | undefined {
  if (!Number.isFinite(remainingMs) || remainingMs < AI_MIN_REQUEST_REMAINING_MS) {
    return undefined;
  }
  return Math.min(getAIRequestTimeoutMs(), Math.floor(remainingMs - AI_REQUEST_TIMEOUT_RESERVE_MS));
}

export function getAIProviderOptions(stage: AIProviderStage, thinkingDisabledOverride?: boolean): AIProviderOptions {
  const setting = process.env.AI_DISABLE_THINKING?.trim().toLowerCase();
  const thinkingDisabled = thinkingDisabledOverride ?? setting !== 'false';
  const maxTokens = AI_STAGE_MAX_TOKENS[stage];
  return {
    request: {
      max_tokens: maxTokens,
      ...(thinkingDisabled ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    },
    thinkingDisabled,
    maxTokens,
  };
}
