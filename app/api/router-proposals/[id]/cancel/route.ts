import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { failure } from '@/lib/server/http';
import { actorSession, checkCsrf } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { cancelProposal } from '../../_view';

export const runtime = 'nodejs';

/** Cancel one still-pending router-staged proposal of the signed-in actor. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore();
    const { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    z.object({}).strict().parse(await request.json());
    const { id } = await context.params;
    return NextResponse.json(await cancelProposal(store, actor, id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
