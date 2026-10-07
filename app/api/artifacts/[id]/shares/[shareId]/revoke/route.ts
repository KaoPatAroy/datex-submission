import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';

/** Owner revokes ONE exact share. Direct tier (it only removes access): idempotent, audited, no other share is touched. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; shareId: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `artifacts:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id, shareId } = await context.params;
    const result = await new ConciergeService(store).revokeArtifactShare(actor, id, shareId);
    return NextResponse.json({ outcome: result.alreadyRevoked ? 'already_revoked' : 'revoked', ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
