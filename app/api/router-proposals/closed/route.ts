import { NextRequest, NextResponse } from 'next/server';
import { pageInputFrom } from '@/lib/pagination';
import { failure } from '@/lib/server/http';
import { actorSession } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { listClosedProposalsPage } from '../_view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** History of the signed-in actor's own proposals that ended WITHOUT an effect (cancelled, expired, not completed). Read-only; other actors' proposals are never listed. */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore();
    const { actor } = await actorSession(store);
    const raw = request.nextUrl.searchParams.get('outcome');
    const outcome = raw === 'cancelled' || raw === 'expired' || raw === 'not_completed' ? raw : undefined;
    const page = await listClosedProposalsPage(store, actor, pageInputFrom(request.nextUrl.searchParams, JSON.stringify(['closed', actor.id, outcome ?? 'all'])), Date.now(), outcome);
    return NextResponse.json({ proposals: page.items, total: page.total, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
