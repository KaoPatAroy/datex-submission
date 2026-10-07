import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { canonicalChatStreamResponseSchema } from '@/lib/chat-stream-contracts';
import { ConciergeService } from '@/lib/core/service';
import { failure } from '@/lib/server/http';
import { prepareChatRequest } from '@/lib/server/chat-request';

export const runtime = 'nodejs';

const chatRecoveryRequestSchema = z.object({
  contractVersion: z.literal(2),
  actionContractVersion: z.literal(1).optional(),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,120}$/),
  message: z.string().min(1).max(8_000).refine(value => value.trim().length > 0),
  conversationId: z.string().min(1).max(100).optional(),
}).strict();

const chatRecoveryResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), response: canonicalChatStreamResponseSchema }).strict(),
  z.object({
    status: z.enum(['in_progress', 'failed']),
    conversationId: z.string().min(1).max(100),
    turnId: z.string().min(1).max(100),
  }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);

function noStoreFailure(error: unknown): NextResponse {
  const response = failure(error);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: NextRequest) {
  try {
    const { store, actor, body } = await prepareChatRequest(request, chatRecoveryRequestSchema);
    const recovered = await new ConciergeService(store).recoverTurn(actor, {
      contractVersion: body.contractVersion,
      ...(body.actionContractVersion === undefined ? {} : { actionContractVersion: body.actionContractVersion }),
      requestKey: body.requestKey,
      message: body.message,
      ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
    });
    const result = chatRecoveryResultSchema.parse(recovered);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return noStoreFailure(error);
  }
}
