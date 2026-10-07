import nextEnv from '@next/env';
import OpenAI from 'openai';
import {
  DEFAULT_NINEARM_BASE_URL,
  DEFAULT_NINEARM_MODEL,
  normalizeBaseURL,
  probeCapabilityReportSchema,
  type ProbeCapabilityReport
} from '../lib/ai/capabilities';
import { getAIProviderOptions } from '../lib/ai/provider-options';

const MAX_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STREAM_CHUNKS = 512;
const MAX_STREAM_CONTENT_BYTES = 16_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const THINKING_DISABLED_OPTIONS = getAIProviderOptions('gathering', true).request;
type Status = 'passed' | 'failed' | 'unsupported' | 'skipped';

interface SafeErrorState {
  timeout: 'observed' | 'not_observed' | 'not_tested';
  invalidKey: 'observed' | 'not_attempted';
  rateLimit: 'observed' | 'not_attempted';
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || name === 'AbortError';
}

function classifyFailure(error: unknown): Status {
  const status = statusCode(error);
  if (status === 400 || status === 404 || status === 422) return 'unsupported';
  return 'failed';
}

function updateErrorState(error: unknown, state: SafeErrorState): void {
  const status = statusCode(error);
  if (isTimeout(error) || status === 408 || status === 504) state.timeout = 'observed';
  if (status === 401) state.invalidKey = 'observed';
  if (status === 429) state.rateLimit = 'observed';
}

function safeObservedModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
  return safe || undefined;
}

function emptyChecks(): ProbeCapabilityReport['checks'] {
  return {
    models: 'skipped',
    nonStreaming: 'skipped',
    streaming: 'skipped',
    nativeToolsChoice: 'skipped',
    toolCalls: 'skipped',
    roleTool: 'skipped',
    reasoningEffort: 'skipped',
    usage: 'skipped'
  };
}

async function main(): Promise<void> {
  nextEnv.loadEnvConfig(process.cwd());

  const configuredKey = process.env.NINEARM_API_KEY?.trim();
  const configuredBase = process.env.NINEARM_BASE_URL?.trim() || DEFAULT_NINEARM_BASE_URL;
  const configuredModel = process.env.NINEARM_MODEL?.trim() || DEFAULT_NINEARM_MODEL;
  let baseURL = DEFAULT_NINEARM_BASE_URL;
  let configValid = true;
  try {
    baseURL = normalizeBaseURL(configuredBase);
  } catch {
    configValid = false;
  }
  const model = MODEL_PATTERN.test(configuredModel) ? configuredModel : DEFAULT_NINEARM_MODEL;
  const checks = emptyChecks();
  const errorChecks: SafeErrorState = {
    timeout: 'not_tested',
    invalidKey: 'not_attempted',
    rateLimit: 'not_attempted'
  };
  let requestCount = 0;
  let observedModel: string | undefined;
  let usageAvailable = false;

  const report = (): ProbeCapabilityReport => probeCapabilityReportSchema.parse({
    schemaVersion: 1,
    baseURL,
    model,
    generatedAt: new Date().toISOString(),
    checks,
    errorChecks,
    requestCount,
    ...(observedModel ? { observedModel } : {})
  });

  const keyConfigured = Boolean(configuredKey);
  if (keyConfigured && configValid && MODEL_PATTERN.test(configuredModel)) {
    const client = new OpenAI({
      apiKey: configuredKey,
      baseURL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0
    });
    const startRequest = (): boolean => {
      if (requestCount >= MAX_REQUESTS) return false;
      requestCount++;
      return true;
    };

    if (startRequest()) {
      try {
        await client.models.list({ timeout: REQUEST_TIMEOUT_MS });
        checks.models = 'passed';
      } catch (error) {
        checks.models = classifyFailure(error);
        updateErrorState(error, errorChecks);
      }
    }

    if (startRequest()) {
      try {
        const response = await client.chat.completions.create({
          ...THINKING_DISABLED_OPTIONS,
          model,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          max_tokens: 512,
          temperature: 0
        }, { timeout: REQUEST_TIMEOUT_MS });
        observedModel = safeObservedModel(response.model);
        checks.nonStreaming = response.choices.length > 0
          && typeof response.choices[0].message.content === 'string'
          && response.choices[0].message.content.trim().length > 0
          && response.choices[0].finish_reason === 'stop'
          ? 'passed' : 'failed';
        usageAvailable = Boolean(response.usage && typeof response.usage.total_tokens === 'number');
        checks.usage = usageAvailable ? 'passed' : 'unsupported';
      } catch (error) {
        checks.nonStreaming = classifyFailure(error);
        checks.usage = 'skipped';
        updateErrorState(error, errorChecks);
      }
    }

    if (startRequest()) {
      try {
        const stream = await client.chat.completions.create({
          ...THINKING_DISABLED_OPTIONS,
          model,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          max_tokens: 256,
          temperature: 0,
          stream: true
        }, { timeout: REQUEST_TIMEOUT_MS });
        let chunks = 0;
        let contentBytes = 0;
        let finished = false;
        for await (const chunk of stream) {
          chunks++;
          for (const choice of chunk.choices) {
            if (typeof choice.delta.content === 'string') {
              contentBytes += Buffer.byteLength(choice.delta.content, 'utf8');
            }
            if (choice.finish_reason !== null) finished = true;
          }
          if (finished || contentBytes > MAX_STREAM_CONTENT_BYTES || chunks >= MAX_STREAM_CHUNKS) break;
        }
        checks.streaming = contentBytes > 0 && contentBytes <= MAX_STREAM_CONTENT_BYTES && finished ? 'passed' : 'failed';
      } catch (error) {
        checks.streaming = classifyFailure(error);
        updateErrorState(error, errorChecks);
      }
    }

    let nativeRoundTrip: { id: string; name: string; arguments: string } | undefined;
    if (startRequest()) {
      const probeTool: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
          name: 'probe_echo',
          description: 'Return the fixed probe value.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          },
          strict: true
        }
      };
      try {
        const response = await client.chat.completions.create({
          ...THINKING_DISABLED_OPTIONS,
          model,
          messages: [{ role: 'user', content: 'Call probe_echo once with value "ok".' }],
          tools: [probeTool],
          tool_choice: { type: 'function', function: { name: 'probe_echo' } },
          max_tokens: 512,
          temperature: 0
        }, { timeout: REQUEST_TIMEOUT_MS });
        observedModel = observedModel || safeObservedModel(response.model);
        checks.nativeToolsChoice = 'passed';
        const toolCall = response.choices[0]?.message.tool_calls?.[0];
        if (toolCall?.type === 'function' && toolCall.function.name === 'probe_echo') {
          try {
            const args: unknown = JSON.parse(toolCall.function.arguments);
            if (args && typeof args === 'object' && (args as Record<string, unknown>).value === 'ok') {
              nativeRoundTrip = { id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments };
              checks.toolCalls = 'passed';
            } else {
              checks.toolCalls = 'failed';
            }
          } catch {
            checks.toolCalls = 'failed';
          }
        } else {
          checks.toolCalls = 'unsupported';
        }
      } catch (error) {
        checks.nativeToolsChoice = classifyFailure(error);
        checks.toolCalls = 'skipped';
        updateErrorState(error, errorChecks);
      }
    }

    if (nativeRoundTrip && startRequest()) {
      try {
        const roleToolResponse = await client.chat.completions.create({
          ...THINKING_DISABLED_OPTIONS,
          model,
          messages: [
            { role: 'user', content: 'Call probe_echo once with value "ok".' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: nativeRoundTrip.id,
                type: 'function',
                function: { name: nativeRoundTrip.name, arguments: nativeRoundTrip.arguments }
              }]
            },
            { role: 'tool', tool_call_id: nativeRoundTrip.id, content: '{"value":"ok"}' }
          ],
          max_tokens: 512,
          temperature: 0
        }, { timeout: REQUEST_TIMEOUT_MS });
        checks.roleTool = roleToolResponse.choices.length > 0
          && typeof roleToolResponse.choices[0].message.content === 'string'
          && roleToolResponse.choices[0].message.content.trim().length > 0
          && roleToolResponse.choices[0].finish_reason === 'stop'
          ? 'passed' : 'failed';
      } catch (error) {
        checks.roleTool = classifyFailure(error);
        updateErrorState(error, errorChecks);
      }
    }

    if (startRequest()) {
      try {
        const request = {
          ...THINKING_DISABLED_OPTIONS,
          model,
          messages: [{ role: 'user' as const, content: 'Reply with the single word OK.' }],
          max_tokens: 512,
          temperature: 0,
          reasoning_effort: 'medium' as const
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { reasoning_effort: 'medium' };
        const response = await client.chat.completions.create(request, { timeout: REQUEST_TIMEOUT_MS });
        observedModel = observedModel || safeObservedModel(response.model);
        checks.reasoningEffort = 'passed';
      } catch (error) {
        checks.reasoningEffort = classifyFailure(error);
        updateErrorState(error, errorChecks);
      }
    }
  }

  if (!keyConfigured || !configValid || !MODEL_PATTERN.test(configuredModel)) {
    checks.models = checks.nonStreaming = checks.streaming = 'skipped';
    checks.nativeToolsChoice = checks.toolCalls = checks.roleTool = 'skipped';
    checks.reasoningEffort = checks.usage = 'skipped';
  }

  const finalReport = report();
  const result = {
    ...finalReport,
    requestedModel: model,
    observedModel: finalReport.observedModel ?? null,
    keyConfigured,
    capabilityReportForRuntime: JSON.stringify(finalReport),
    nativeToolRoundTrip: finalReport.checks.nativeToolsChoice === 'passed'
      && finalReport.checks.toolCalls === 'passed'
      && finalReport.checks.roleTool === 'passed',
    errorChecks: {
      ...finalReport.errorChecks,
      note: 'Invalid-key and rate-limit errors are recorded only if encountered naturally; this probe does not send invalid credentials or intentionally rate-limit.'
    },
    usageObserved: usageAvailable,
    maxRequests: MAX_REQUESTS,
    runtimeCapabilityVariable: 'NINEARM_CAPABILITIES_JSON'
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!keyConfigured) process.exitCode = 2;
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'probe could not initialize safely', keyOutput: 'redacted' })}\n`);
  process.exitCode = 1;
});
