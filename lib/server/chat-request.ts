import 'server-only';

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import type { Actor, Store } from '@/lib/contracts';
import { catalogEntryIdPattern, showcaseIdPattern } from '@/lib/demo/ids';
import { DomainError } from '@/lib/core/errors';
import { clarificationFieldsPaired, clarificationSelectionFields, turnTargetsFields } from '@/lib/chat-stream-contracts';

const MAX_CHAT_REQUEST_BODY_BYTES = 64 * 1024;
const INVALID_CHAT_REQUEST_BODY = 'รูปแบบข้อมูลไม่ถูกต้อง';

// Only V2 requests carrying a stable client requestKey have normal-POST replay protection.
export const chatTurnRequestSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().min(1).max(100).optional(),
  recoveryOfTurnId: z.string().min(1).max(100).optional(),
  contractVersion: z.literal(2).optional(),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,120}$/).optional(),
  demoShowcaseId: z.string().regex(showcaseIdPattern).optional(),
  catalogEntryId: z.string().regex(catalogEntryIdPattern).optional(),
  ...clarificationSelectionFields,
  ...turnTargetsFields,
}).strict().refine(body =>
  (body.contractVersion === 2) === (body.requestKey !== undefined) &&
  !((body.demoShowcaseId || body.catalogEntryId || body.clarificationChoiceId || body.targets?.length) && body.requestKey === undefined) &&
  clarificationFieldsPaired(body) &&
  !(body.requestKey && body.recoveryOfTurnId)
);

export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>;

export type PreparedChatRequest<TBody> = {
  store: Store;
  actor: Actor;
  body: TBody;
};

function invalidChatRequestBody(): DomainError {
  return new DomainError('INVALID_INPUT', INVALID_CHAT_REQUEST_BODY, 400);
}

async function parseBoundedJsonBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw invalidChatRequestBody();

  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_CHAT_REQUEST_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw invalidChatRequestBody();
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_CHAT_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw invalidChatRequestBody();
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw invalidChatRequestBody();
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Authenticates and prepares a chat request before parsing its route-specific
 * strict body schema. A stream route can pass its own schema while sharing the
 * same origin, CSRF, and rate-limit checks.
 */
export function prepareChatRequest(request: NextRequest): Promise<PreparedChatRequest<ChatTurnRequest>>;
export function prepareChatRequest<TBody>(
  request: NextRequest,
  bodySchema: z.ZodType<TBody>
): Promise<PreparedChatRequest<TBody>>;
export async function prepareChatRequest<TBody>(
  request: NextRequest,
  bodySchema?: z.ZodType<TBody>
): Promise<PreparedChatRequest<TBody | ChatTurnRequest>> {
  const store = await getStore();
  const { actor, session } = await actorSession(store);

  checkCsrf(request, session);
  await rateLimit(store, `session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
  await rateLimit(store, `ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));

  const rawBody = await parseBoundedJsonBody(request);
  const body = bodySchema
    ? bodySchema.parse(rawBody)
    : chatTurnRequestSchema.parse(rawBody);
  return { store, actor, body };
}
