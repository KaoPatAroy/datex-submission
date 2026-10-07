import { NextResponse } from 'next/server';
import { failure } from '@/lib/server/http';
import { actorSession } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { listPendingProposals } from './_view';

export const runtime = 'nodejs';

/** Pending router-staged proposals of the signed-in actor. Empty when the store has no router_proposals table. */
export async function GET() {
  try {
    const store = await getStore();
    const { actor } = await actorSession(store);
    return NextResponse.json({ proposals: await listPendingProposals(store, actor) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
