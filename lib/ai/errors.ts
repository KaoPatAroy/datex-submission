import 'server-only';

export type AIRuntimeErrorCode =
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'invalid_input'
  | 'not_live_mode'
  | 'not_configured'
  | 'invalid_configuration'
  | 'provider_unavailable'
  | 'deadline_exceeded'
  | 'invalid_model_response'
  | 'tool_unavailable'
  | 'tool_execution_failed';

/** Safe, stable errors for the API layer. Never attach provider messages or headers. */
export class AIRuntimeError extends Error {
  readonly code: AIRuntimeErrorCode;
  readonly fallback = 'scripted_demo' as const;
  readonly providerStatus?: number;
  readonly status?: number;
  readonly finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
  readonly diagnosticReason?: 'model_step_limit';

  constructor(code: AIRuntimeErrorCode, message: string, providerStatus?: number, status?: number,
    diagnostic?: { finishReason?: AIRuntimeError['finishReason']; reason?: AIRuntimeError['diagnosticReason'] }) {
    super(message);
    this.name = 'AIRuntimeError';
    this.code = code;
    this.providerStatus = providerStatus;
    this.status = status;
    if (diagnostic?.finishReason && ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(diagnostic.finishReason)) {
      this.finishReason = diagnostic.finishReason;
    }
    if (diagnostic?.reason === 'model_step_limit') this.diagnosticReason = diagnostic.reason;
  }
}

export type BackendAuthorizationFailure =
  | { code: 'FORBIDDEN'; status: 403 }
  | { code: 'UNAUTHENTICATED'; status: 401 };

/** Recognize only the core auth contract's exact code/status pairs. */
export function backendAuthorizationFailure(error: unknown): BackendAuthorizationFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const candidate = error as { code?: unknown; status?: unknown };
    if (candidate.code === 'FORBIDDEN' && candidate.status === 403) return { code: 'FORBIDDEN', status: 403 };
    if (candidate.code === 'UNAUTHENTICATED' && candidate.status === 401) return { code: 'UNAUTHENTICATED', status: 401 };
  } catch {
    return undefined;
  }
  return undefined;
}
