import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { actorSession, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A recipient opens an artifact shared with them through ONE OF THEIR OWN inbox messages. The owner's exact version is reloaded and the
 * recipient is reauthorized for its whole stored scope on every open; a recipient who lost that authority gets a 403 and no data.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ messageId: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    await rateLimit(store, `artifacts:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { messageId } = await context.params;
    return NextResponse.json(await new ConciergeService(store).openSharedArtifact(actor, messageId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
