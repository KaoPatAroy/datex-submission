import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';

/**
 * Direct library operation on the owner's own Result: { op: 'rename' | 'clear_title' | 'pin' | 'unpin' | 'archive' | 'unarchive', title? }.
 * Private and reversible, so no confirmation step. Only display metadata changes; the stored versions, their digests, shares and receipts are untouched.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `results:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `results:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params;
    const item = await new ConciergeService(store).updateResult(actor, id, await request.json());
    return NextResponse.json({ outcome: 'updated', item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
