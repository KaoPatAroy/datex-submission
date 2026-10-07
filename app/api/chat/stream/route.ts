import { NextRequest, NextResponse } from 'next/server';
import { AIRuntimeError } from '@/lib/ai/errors';
import { ConciergeService } from '@/lib/core/service';
import { DomainError } from '@/lib/core/errors';
import {
  advanceChatStreamSequence,
  canonicalChatStreamResponseSchema,
  legacyChatStreamRequestSchema,
  chatStreamStatusCodeSchema,
  encodeChatStreamEvent,
  initialChatStreamSequenceState,
  type ChatStreamErrorCode,
  type ChatStreamEvent,
  type ChatStreamRequest,
} from '@/lib/chat-stream-contracts';
import { failure } from '@/lib/server/http';
import { prepareChatRequest, type PreparedChatRequest } from '@/lib/server/chat-request';

export const runtime = 'nodejs';
export const maxDuration = 120;

type LegacyChatStreamRequest = Extract<ChatStreamRequest, { actionContractVersion?: 1 }>;

type QueuedFrame = { readonly bytes: Uint8Array; readonly consumed: () => void };

/** A one-frame channel lets awaited service callbacks follow client backpressure. */
function createFrameChannel() {
  let frame: QueuedFrame | undefined;
  let pendingRead: ((frame: QueuedFrame | null) => void) | undefined;
  const pendingSpace = new Set<() => void>();
  let closed = false;
  let cancelled = false;
  const encoder = new TextEncoder();

  async function push(value: string, waitForConsumption = true): Promise<void> {
    if (closed || cancelled) return;
    while (frame && !cancelled && !closed) {
      await new Promise<void>(resolve => { pendingSpace.add(resolve); });
    }
    if (closed || cancelled) return;
    const queued: QueuedFrame = { bytes: encoder.encode(value), consumed: () => undefined };
    if (pendingRead) {
      const read = pendingRead;
      pendingRead = undefined;
      read(queued);
      return;
    }
    let consumed!: () => void;
    const consumedPromise = new Promise<void>(resolve => { consumed = resolve; });
    frame = { bytes: queued.bytes, consumed };
    if (waitForConsumption) await consumedPromise;
  }

  function read(): Promise<QueuedFrame | null> {
    if (frame) {
      const queued = frame;
      frame = undefined;
      queued.consumed();
      for (const space of pendingSpace) space();
      pendingSpace.clear();
      return Promise.resolve(queued);
    }
    if (closed || cancelled) return Promise.resolve(null);
    return new Promise(resolve => { pendingRead = resolve; });
  }

  function close(): void {
    if (closed || cancelled) return;
    closed = true;
    const read = pendingRead;
    pendingRead = undefined;
    read?.(null);
    for (const space of pendingSpace) space();
    pendingSpace.clear();
  }

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    frame?.consumed();
    frame = undefined;
    const read = pendingRead;
    pendingRead = undefined;
    read?.(null);
    for (const space of pendingSpace) space();
    pendingSpace.clear();
  }

  return { push, read, close, cancel };
}

function safeFailure(error: unknown, signal: AbortSignal): {
  code: ChatStreamErrorCode;
  outcome: 'failed' | 'cancelled' | 'in_progress' | 'unknown';
} {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return { code: 'cancelled', outcome: 'cancelled' };
  }

  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if ((code === 'UNAUTHENTICATED' && status === 401) || status === 401) {
    return { code: 'unauthenticated', outcome: 'failed' };
  }
  if ((code === 'FORBIDDEN' && status === 403) || status === 403) {
    return { code: 'forbidden', outcome: 'failed' };
  }
  if (code === 'TURN_IN_PROGRESS') return { code: 'in_progress', outcome: 'in_progress' };
  if (code === 'TRANSPORT_OUTCOME_UNKNOWN') return { code: 'outcome_unknown', outcome: 'unknown' };
  if (error instanceof AIRuntimeError) {
    if (error.code === 'tool_execution_failed' || error.code === 'invalid_input' || error.code === 'not_live_mode'
      || error.code === 'invalid_configuration') {
      // A refused or failed read tool, or a rejected input, has no persisted effect.
      return { code: 'request_failed', outcome: 'failed' };
    }
    if (error.code === 'provider_unavailable' || error.code === 'not_configured') {
      return { code: 'provider_unavailable', outcome: 'unknown' };
    }
    if (error.code === 'deadline_exceeded') return { code: 'deadline_exceeded', outcome: 'unknown' };
    if (error.code === 'invalid_model_response') return { code: 'invalid_response', outcome: 'unknown' };
  }
  if (error instanceof DomainError && (error.code === 'STORAGE' || error.code === 'PERSISTENCE_FAILED')) {
    return { code: 'persistence_failed', outcome: 'unknown' };
  }
  if (error instanceof DomainError && error.status >= 400 && error.status < 500) {
    return { code: 'request_failed', outcome: 'failed' };
  }
  return { code: 'request_failed', outcome: typeof status === 'number' && status < 500 ? 'failed' : 'unknown' };
}

function noStoreFailure(error: unknown): NextResponse {
  const response = failure(error);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  let prepared: PreparedChatRequest<LegacyChatStreamRequest>;
  try {
    prepared = await prepareChatRequest(request, legacyChatStreamRequestSchema);
  } catch (error) {
    return noStoreFailure(error);
  }

  const { store, actor, body } = prepared;
  const service = new ConciergeService(store, { routeStartedAt });
  const channel = createFrameChannel();
  const operation = new AbortController();
  operation.signal.addEventListener('abort', channel.cancel, { once: true });
  if (request.signal.aborted) {
    operation.abort(request.signal.reason);
    return noStoreFailure(Object.assign(new Error('Request aborted before stream admission'), { name: 'AbortError' }));
  }

  let sequence = initialChatStreamSequenceState();
  let admitted = false;
  let terminal = false;
  let settleAdmission!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  let admissionSettled = false;
  const admission = new Promise<void>((resolve, reject) => {
    settleAdmission = () => {
      if (admissionSettled) return;
      admissionSettled = true;
      resolve();
    };
    rejectAdmission = error => {
      if (admissionSettled) return;
      admissionSettled = true;
      reject(error);
    };
  });
  const propagateAbort = () => {
    operation.abort(request.signal.reason);
    if (!admitted) {
      const error = Object.assign(new Error('Request aborted before stream admission'), { name: 'AbortError' });
      rejectAdmission(error);
    }
  };
  request.signal.addEventListener('abort', propagateAbort, { once: true });
  if (request.signal.aborted) propagateAbort();

  function frame(event: (sequence: number) => ChatStreamEvent): string {
    const next = event(sequence.nextSequence);
    const advanced = advanceChatStreamSequence(sequence, next);
    const encoded = encodeChatStreamEvent(next);
    sequence = advanced;
    return encoded;
  }

  async function failStream(error: unknown): Promise<void> {
    if (terminal) return;
    const failureEvent = safeFailure(error, operation.signal);
    // Metadata only: never log user text, tool arguments or provider messages.
    if (failureEvent.code !== 'cancelled') {
      const named = error as { name?: unknown; code?: unknown; status?: unknown } | null;
      console.error('[chat-stream] turn failed', {
        code: failureEvent.code,
        outcome: failureEvent.outcome,
        errorName: typeof named?.name === 'string' ? named.name : typeof error,
        errorCode: typeof named?.code === 'string' ? named.code : undefined,
        errorStatus: typeof named?.status === 'number' ? named.status : undefined,
      });
    }
    const encoded = frame(sequenceNumber => ({
      streamVersion: 1,
      sequence: sequenceNumber,
      type: 'turn.failed',
      ...failureEvent,
      recovery: 'check_original_request',
    }));
    terminal = true;
    await channel.push(encoded);
  }

  const work = service.turn(
    actor,
    body.message,
    body.conversationId,
    undefined,
    {
      contractVersion: 2,
      requestKey: body.requestKey,
      ...(body.demoShowcaseId ? { demoShowcaseId: body.demoShowcaseId } : {}),
      ...(body.catalogEntryId ? { catalogEntryId: body.catalogEntryId } : {}),
      ...('targets' in body && body.targets?.length ? { targets: body.targets } : {}),
      ...('clarificationChoiceId' in body && body.clarificationChoiceId && body.clarifiedTurnId ? { clarification: { choiceId: body.clarificationChoiceId, clarifiedTurnId: body.clarifiedTurnId } } : {}),
    },
    {
      signal: operation.signal,
      onStarted: async turn => {
        if (admitted) throw new Error('The service admitted the same stream twice');
        const encoded = frame(sequenceNumber => ({
          streamVersion: 1,
          sequence: sequenceNumber,
          type: 'turn.started',
          requestKey: body.requestKey,
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          assistantMessageId: turn.assistantMessageId,
          mode: turn.mode,
          replayed: turn.replayed,
        }));
        admitted = true;
        await channel.push(encoded, false);
        settleAdmission();
      },
      onStatus: async code => {
        const parsed = chatStreamStatusCodeSchema.safeParse(code);
        if (!admitted || terminal || !parsed.success) return;
        const encoded = frame(sequenceNumber => ({
          streamVersion: 1,
          sequence: sequenceNumber,
          type: 'status',
          code: parsed.data,
        }));
        await channel.push(encoded);
      },
      onTextDelta: async text => {
        if (!admitted || terminal || text.length === 0) return;
        const encoded = frame(sequenceNumber => ({
          streamVersion: 1,
          sequence: sequenceNumber,
          type: 'text.delta',
          text,
        }));
        await channel.push(encoded);
      },
    },
  ).then(async response => {
    if (!admitted) {
      rejectAdmission(new Error('The service returned without an admission event'));
      channel.close();
      return;
    }
    const parsed = canonicalChatStreamResponseSchema.safeParse(response);
    if (!parsed.success) {
      await failStream(new Error('The durable turn response did not match the stream contract'));
    } else if (!terminal) {
      const encoded = frame(sequenceNumber => ({
        streamVersion: 1,
        sequence: sequenceNumber,
        type: 'turn.completed',
        response: parsed.data,
      }));
      terminal = true;
      await channel.push(encoded);
    }
    channel.close();
  }, async error => {
    if (!admitted) {
      rejectAdmission(error);
      channel.close();
      return;
    }
    await failStream(error);
    channel.close();
  }).catch(async error => {
    try {
      if (!admitted) rejectAdmission(error);
      else await failStream(error);
    } catch {
      // A cancelled reader or invalid service event must not create an unhandled rejection.
    } finally {
      channel.close();
    }
  });

  try {
    await admission;
  } catch (error) {
    operation.abort();
    request.signal.removeEventListener('abort', propagateAbort);
    return noStoreFailure(error);
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const queued = await channel.read();
      if (queued) controller.enqueue(queued.bytes);
      else controller.close();
    },
    cancel() {
      operation.abort();
      channel.cancel();
    },
  }, { highWaterMark: 0 });

  const cleanup = () => request.signal.removeEventListener('abort', propagateAbort);
  void work.then(cleanup, cleanup);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
