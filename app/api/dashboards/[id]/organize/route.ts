import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
const bodySchema = z.object({ op: z.enum(['pin', 'unpin', 'archive', 'restore', 'duplicate']) }).strict();

/**
 * Owner-only organization of one Dashboard: pin / unpin / archive / restore / duplicate. Private and reversible, so it runs directly through the same
 * server rules (owner, permission, not deleted); it never changes the widgets, their revision or what a recipient of a share sees.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `dashboards:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `dashboards:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    return NextResponse.json(await new ConciergeService(store).organizeDashboard(actor, id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
