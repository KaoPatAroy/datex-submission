import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { listInboxPage, markInboxRead } from '@/lib/router/ports/effect-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Acknowledges messages as read. Body is EXACTLY one of `{ ids: [...] }` (the messages the recipient was shown) or `{ all: true }` (an explicit
 * mark-all); an empty body is rejected. Returns the authoritative remaining unread count so the client reconciles its badge only from a
 * successful server response. Owner-scoped; CSRF-checked; idempotent.
 */
const bodySchema = z.union([z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(200) }).strict(), z.object({ all: z.literal(true) }).strict()]);
export async function POST(request: NextRequest) {
  try {
    const store = await getStore();
    const { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    const body = bodySchema.parse(await request.json());
    const marked = await markInboxRead(store, actor, new Date(), body);
    return NextResponse.json({ marked, unreadTotal: (await listInboxPage(store, actor, { limit: 1 })).unreadTotal }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
