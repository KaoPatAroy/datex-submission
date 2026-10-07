import 'server-only';

import OpenAI from 'openai';
import { AIRuntimeError } from './errors';
import { DEFAULT_NINEARM_BASE_URL, DEFAULT_NINEARM_MODEL, normalizeBaseURL } from './capabilities';
import { getAIRequestTimeoutMs } from './provider-options';

export type AIToolMode = 'auto' | 'native' | 'planner';

export interface RuntimeSettings {
  baseURL: string;
  model: string;
  toolMode: AIToolMode;
}

export function getRuntimeSettings(): RuntimeSettings {
  const provider = process.env.AI_PROVIDER?.trim() || 'ninearm';
  if (provider !== 'ninearm') {
    throw new AIRuntimeError('invalid_configuration', 'The configured AI provider is not supported.');
  }

  let baseURL: string;
  try {
    baseURL = normalizeBaseURL(process.env.NINEARM_BASE_URL?.trim() || DEFAULT_NINEARM_BASE_URL);
  } catch {
    throw new AIRuntimeError('invalid_configuration', 'The AI endpoint configuration is invalid.');
  }

  const model = process.env.NINEARM_MODEL?.trim() || DEFAULT_NINEARM_MODEL;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(model)) {
    throw new AIRuntimeError('invalid_configuration', 'The AI model configuration is invalid.');
  }

  const configuredMode = process.env.AI_TOOL_MODE?.trim() || 'auto';
  if (configuredMode !== 'auto' && configuredMode !== 'native' && configuredMode !== 'planner') {
    throw new AIRuntimeError('invalid_configuration', 'The AI tool mode configuration is invalid.');
  }

  return { baseURL, model, toolMode: configuredMode };
}

export function createAIClient(baseURL: string): OpenAI {
  const apiKey = process.env.NINEARM_API_KEY?.trim();
  if (!apiKey) {
    throw new AIRuntimeError('not_configured', 'Live AI is unavailable. Switch to Scripted Demo or configure the server runtime.');
  }
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: getAIRequestTimeoutMs(),
    maxRetries: 0
  });
}
