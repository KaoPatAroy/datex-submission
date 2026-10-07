import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { DomainError } from '@/lib/core/errors';
import { getFollowUpSuggestions } from '@/lib/core/follow-up-suggestions';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

const identifier = z.string().trim().min(1).max(128);

function readAfterMessageId(request: NextRequest): string {
  const keys = [...request.nextUrl.searchParams.keys()];
  const values = request.nextUrl.searchParams.getAll('afterMessageId');
  if (keys.length !== 1 || keys[0] !== 'afterMessageId' || values.length !== 1) {
    throw new DomainError('INVALID_INPUT', 'Invalid suggestion anchor', 400);
  }
  return identifier.parse(values[0]);
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const store = await getStore();
    const { actor } = await actorSession(store);
    const { id: rawConversationId } = await params;
    const conversationId = identifier.parse(rawConversationId);
    const afterMessageId = readAfterMessageId(request);
    const response = await getFollowUpSuggestions(store, actor, conversationId, afterMessageId);
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
