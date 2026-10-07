import {
  advanceChatStreamSequence,
  assertChatStreamFinished,
  decodeChatStreamFrame,
  initialChatStreamSequenceState,
  legacyTurnResponseSchema,
  MAX_CHAT_STREAM_EVENT_BYTES,
  type CanonicalChatStreamResponse,
  type ChatStreamEvent,
  type ChatStreamStatusCode,
} from '@/lib/chat-stream-contracts';
import type { TurnResponse } from '@/lib/contracts';
import { z } from 'zod';

export const streamProgress: Record<ChatStreamStatusCode, string> = {
  validating: 'กำลังตรวจคำขอ…',
  reading: 'กำลังอ่านข้อมูลที่คุณมีสิทธิ์ดู…',
  analyzing: 'กำลังวิเคราะห์ข้อมูล…',
  preparing: 'กำลังเตรียมคำตอบ…',
  saving: 'กำลังบันทึกคำตอบ…',
};

const streamFailureMessages: Record<string, string> = {
  cancelled: 'หยุดการตอบแล้ว คำตอบนี้อาจยังไม่สมบูรณ์',
  in_progress: 'คำขอเดิมยังอยู่ระหว่างดำเนินการ กรุณาตรวจสถานะอีกครั้ง',
  provider_unavailable: 'การตอบถูกขัดจังหวะ กรุณาตรวจสถานะคำขอเดิม',
  deadline_exceeded: 'ใช้เวลาตอบนานกว่าที่กำหนด กรุณาตรวจสถานะคำขอเดิม',
  invalid_response: 'ยังตรวจสอบคำตอบไม่ได้ กรุณาตรวจสถานะคำขอเดิม',
  persistence_failed: 'ยังยืนยันการบันทึกคำตอบไม่ได้ กรุณาตรวจสถานะคำขอเดิม',
  outcome_unknown: 'ยังไม่ทราบผลคำขอ กรุณาตรวจสถานะคำขอเดิม',
  unauthenticated: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  forbidden: 'คำขอนี้อยู่นอกสิทธิ์ของคุณ',
  rate_limited: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  request_failed: 'การตอบถูกขัดจังหวะ กรุณาตรวจสถานะคำขอเดิม',
};

/** Calm Thai copy for failures whose outcome is known and which prepared nothing, so no recovery check is needed. */
export const cleanFailureMessages: Record<string, string> = {
  cancelled: 'หยุดการตอบแล้ว',
  provider_unavailable: 'Live AI ตอบไม่ได้ในขณะนี้ ลองส่งใหม่อีกครั้ง หรือสลับเป็นโหมดสาธิตเพื่อดูตัวอย่างการทำงาน',
  deadline_exceeded: 'Live AI ใช้เวลาตอบนานเกินไป ลองส่งใหม่อีกครั้ง หรือสลับเป็นโหมดสาธิตเพื่อดูตัวอย่างการทำงาน',
  invalid_response: 'ตอบคำถามนี้ไม่สำเร็จ ลองถามใหม่หรือถามให้เจาะจงขึ้น',
  forbidden: 'คำขอนี้อยู่นอกสิทธิ์ของคุณ จึงไม่ได้ดำเนินการให้',
  request_failed: 'ตอบคำถามนี้ไม่สำเร็จ ลองถามใหม่หรือถามแบบอื่น',
};

export class ChatStreamError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly admitted = false, readonly outcome?: 'failed' | 'cancelled' | 'in_progress' | 'unknown') {
    super(streamFailureMessages[code] ?? streamFailureMessages.request_failed);
    this.name = 'ChatStreamError';
  }
}

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  requestKey: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<CanonicalChatStreamResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let state = initialChatStreamSequenceState();
  let buffer = '';
  let pendingCarriageReturn = '';
  let finalResponse: CanonicalChatStreamResponse | undefined;
  let failure: Extract<ChatStreamEvent, { type: 'turn.failed' }> | undefined;
  let finished = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });

  function append(decoded: string, end = false) {
    let text = pendingCarriageReturn + decoded;
    pendingCarriageReturn = !end && text.endsWith('\r') ? '\r' : '';
    if (pendingCarriageReturn) text = text.slice(0, -1);
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      const event = decodeChatStreamFrame(frame);
      if (!event) continue;
      if (event.type === 'turn.started' && event.requestKey !== requestKey) throw new Error('Request identity mismatch');
      state = advanceChatStreamSequence(state, event);
      if (event.type === 'turn.completed') finalResponse = event.response;
      if (event.type === 'turn.failed') failure = event;
      // Completion is published only after the complete transport validates below.
      if (event.type !== 'turn.completed') onEvent(event);
    }
    if (encoder.encode(buffer).byteLength > MAX_CHAT_STREAM_EVENT_BYTES) throw new Error('Stream frame too large');
  }

  try {
    for (;;) {
      if (signal?.aborted) throw new ChatStreamError('cancelled', 0, Boolean(state.started));
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ChatStreamError('cancelled', 0, Boolean(state.started));
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode(), true);
    if (buffer.length > 0) throw new Error('Incomplete final SSE frame');
    assertChatStreamFinished(state);
    if (failure) throw new ChatStreamError(failure.code, 0, true, failure.outcome);
    if (!finalResponse) throw new Error('Missing completed response');
    finished = true;
    onEvent({ streamVersion: 1, sequence: state.nextSequence - 1, type: 'turn.completed', response: finalResponse });
    return finalResponse;
  } catch (error) {
    if (error instanceof ChatStreamError) throw error;
    throw new ChatStreamError(signal?.aborted ? 'cancelled' : 'invalid_response', 0, Boolean(state.started));
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type ChatStreamRequestOptions = {
  message: string;
  conversationId?: string;
  demoShowcaseId?: string;
  catalogEntryId?: string;
  /** Structured clarification chip pick (never parsed from text). */
  clarification?: { choiceId: string; clarifiedTurnId: string };
  /** Owned resources the user selected in the UI (exact ids; the server verifies them). */
  targets?: { kind: 'artifact' | 'dashboard' | 'monitor'; id: string; revision?: number }[];
  requestKey: string;
  csrfToken: string;
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
};

function statusError(status: number) {
  return new ChatStreamError(status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'request_failed', status);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ChatStreamError('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CHAT_STREAM_EVENT_BYTES) throw new ChatStreamError('invalid_response');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    finished = true;
    return value;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestChatStream(options: ChatStreamRequestOptions): Promise<TurnResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let deadline = false;
  const timer = setTimeout(() => { deadline = true; controller.abort(); }, 130_000);
  const payload = { contractVersion: 2, requestKey: options.requestKey, message: options.message, ...(options.conversationId ? { conversationId: options.conversationId } : {}), ...(options.demoShowcaseId ? { demoShowcaseId: options.demoShowcaseId } : {}), ...(options.catalogEntryId ? { catalogEntryId: options.catalogEntryId } : {}), ...(options.clarification ? { clarificationChoiceId: options.clarification.choiceId, clarifiedTurnId: options.clarification.clarifiedTurnId } : {}), ...(options.targets?.length ? { targets: options.targets } : {}) };
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': options.csrfToken };
  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, streamVersion: 1, actionContractVersion: 1 }),
    });
    if ([404, 405, 501].includes(response.status) && response.headers.get('x-biztania-chat-stream') === 'unavailable') {
      // Only an explicit pre-admission adapter signal permits a second POST.
      // Status alone may be a business rejection from an installed stream route.
      await response.body?.cancel();
      const fallback = await fetch('/api/chat', { method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal, headers, body: JSON.stringify(payload) });
      if (!fallback.ok) { await fallback.body?.cancel(); throw statusError(fallback.status); }
      return legacyTurnResponseSchema.parse(await readBoundedJson(fallback));
    }
    if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) throw new ChatStreamError('invalid_response');
    return legacyTurnResponseSchema.parse(await consumeChatStream(response.body, options.requestKey, options.onEvent, controller.signal));
  } catch (error) {
    if (deadline) throw new ChatStreamError('deadline_exceeded', 0, error instanceof ChatStreamError && error.admitted);
    if (options.signal.aborted) throw new ChatStreamError('cancelled', 0, error instanceof ChatStreamError && error.admitted);
    if (error instanceof ChatStreamError) throw error;
    throw new ChatStreamError('request_failed');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}

const recoveryResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), response: legacyTurnResponseSchema }).strict(),
  z.object({ status: z.enum(['in_progress', 'failed']), conversationId: z.string().min(1).max(100), turnId: z.string().min(1).max(100) }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export type ChatRecoveryResult = z.infer<typeof recoveryResultSchema>;

export async function recoverChatStream(options: {
  requestKey: string;
  message: string;
  conversationId?: string;
  csrfToken: string;
  signal?: AbortSignal;
}): Promise<ChatRecoveryResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch('/api/chat/recovery', {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': options.csrfToken },
      body: JSON.stringify({ contractVersion: 2, actionContractVersion: 1, requestKey: options.requestKey, message: options.message, ...(options.conversationId ? { conversationId: options.conversationId } : {}) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
    return recoveryResultSchema.parse(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof ChatStreamError) throw error;
    throw new ChatStreamError('outcome_unknown');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
