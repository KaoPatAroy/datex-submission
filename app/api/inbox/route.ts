import { NextRequest, NextResponse } from 'next/server';
import { pageInputFrom } from '@/lib/pagination';
import { getStore } from '@/lib/storage';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { listInboxPage } from '@/lib/router/ports/effect-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in actor's simulated inbox (messages addressed to this actor only). No email or external delivery exists. */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore(), { actor } = await actorSession(store);
    const params = request.nextUrl.searchParams;
    const page = await listInboxPage(store, actor, { ...pageInputFrom(params, JSON.stringify(['inbox', actor.id, params.get('unread') === '1'])), unreadOnly: params.get('unread') === '1' });
    return NextResponse.json({ messages: page.items, total: page.total, unreadTotal: page.unreadTotal, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
