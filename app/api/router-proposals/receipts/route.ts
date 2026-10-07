import { NextRequest, NextResponse } from 'next/server';
import { pageInputFrom } from '@/lib/pagination';
import { failure } from '@/lib/server/http';
import { actorSession } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { listReceiptsPage } from '../_view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Persisted, verified receipts of the signed-in actor's own confirmed staged effects (sender view). Other actors' receipts are never listed. */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore();
    const { actor } = await actorSession(store);
    const conversationId = request.nextUrl.searchParams.get('conversationId') ?? undefined;
    const page = await listReceiptsPage(store, actor, pageInputFrom(request.nextUrl.searchParams, JSON.stringify(['receipts', actor.id, conversationId ?? null])), conversationId);
    return NextResponse.json({ receipts: page.items, total: page.total, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
