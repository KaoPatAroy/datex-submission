import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { DomainError } from '@/lib/core/errors';
import type { PendingAction } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import {
  getOwnedConversation,
  MAX_CONVERSATION_MESSAGE_OFFSET,
  MAX_CONVERSATION_PAGE_SIZE,
  MAX_CONVERSATION_TITLE_LENGTH,
  toConversationView,
  updateConversation
} from '@/lib/core/conversations';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  mutation: z.discriminatedUnion('type', [
    z.object({ type: z.literal('rename'), title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_LENGTH) }).strict(),
    z.object({ type: z.literal('pin'), pinned: z.boolean() }).strict(),
    z.object({ type: z.literal('archive'), archived: z.boolean() }).strict()
  ])
}).strict();

function boundedInteger(value: string | null, fallback: number, maximum: number, minimum = 1): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new DomainError('INVALID_INPUT', 'รูปแบบการแบ่งหน้าไม่ถูกต้อง', 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new DomainError('INVALID_INPUT', 'รูปแบบการแบ่งหน้าไม่ถูกต้อง', 400);
  return parsed;
}

function readMessagePage(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  return {
    limit: boundedInteger(search.get('limit'), 50, MAX_CONVERSATION_PAGE_SIZE),
    offset: boundedInteger(search.get('offset'), 0, MAX_CONVERSATION_MESSAGE_OFFSET, 0)
  };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function limitMutation(request: NextRequest, sessionId: string, store: Awaited<ReturnType<typeof getStore>>) {
  await rateLimit(store, `conversations:session:${sessionId}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
  await rateLimit(store, `conversations:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const store = await getStore();return await withReadSnapshot(store,async()=>{
    const { actor } = await actorSession(store);
    const { id: conversationId } = await params;
    const page = readMessagePage(request);
    const conversation = await getOwnedConversation(store, actor.id, conversationId);
    // Reuse the workspace's current-permission and source-scope message sanitizer.
    const workspace = await new ConciergeService(store).getConversationHistory(actor,conversationId);
    const safeMessages = workspace.messages
      .filter((message) => message.actorId === actor.id && message.conversationId === conversationId)
      .sort((left, right) => {
        const timeOrder = timestamp(left.createdAt) - timestamp(right.createdAt);
        return timeOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      });
    const visibleActions = new Map<string, Pick<PendingAction, 'id' | 'actorId' | 'sessionId' | 'conversationId' | 'turnId'>>(
      workspace.actions
        .filter((action) => action.actorId === actor.id && action.conversationId === conversationId)
        .map((action) => [action.id, action])
    );
    const messages = safeMessages.slice(page.offset, page.offset + page.limit).map((message) => {
      const referencedActionIds = [...new Set([
        ...(message.pendingActionIds ?? []),
        ...(message.pendingActionId ? [message.pendingActionId] : [])
      ])];
      const associatedActions = message.role === 'assistant'
        ? referencedActionIds
          .map((actionId) => visibleActions.get(actionId))
          .filter((action): action is Pick<PendingAction, 'id' | 'actorId' | 'sessionId' | 'conversationId' | 'turnId'> =>
            !!action && action.actorId === message.actorId && action.conversationId === message.conversationId &&
            !!message.turnId && action.turnId === message.turnId &&
            (!message.sessionId || action.sessionId === message.sessionId))
        : [];
      const linkedActionIds = associatedActions.map((action) => action.id);
      const turnId = message.turnId ?? (message.role === 'user'
        ? message.id
        : undefined);
      const safeMessage = { ...message };
      delete safeMessage.sessionId;
      delete safeMessage.pendingActionId;
      delete safeMessage.pendingActionIds;
      return {
        ...safeMessage,
        ...(turnId ? { turnId } : {}),
        ...(linkedActionIds.length ? {
          pendingActionIds: linkedActionIds,
          pendingActionId: linkedActionIds[linkedActionIds.length - 1]
        } : {})
      };
    });
    const result = {
      conversation: toConversationView(conversation),
      messages,
      pagination: {
        limit: page.limit,
        offset: page.offset,
        total: safeMessages.length,
        hasMore: page.offset + messages.length < safeMessages.length
      }
    };
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  });} catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const store = await getStore();
    const { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await limitMutation(request, session.id, store);
    const { id: conversationId } = await params;
    const body = updateSchema.parse(await request.json());
    const conversation = await updateConversation(store, actor.id, conversationId, body.expectedVersion, body.mutation);
    return NextResponse.json({ conversation }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}
