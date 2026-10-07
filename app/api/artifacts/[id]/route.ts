import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const querySchema = z.object({ revision: z.coerce.number().int().positive().max(100).optional() }).strict();

/**
 * Reload of one immutable artifact version (owner only). The version is read from the server store, its evidence/claim digests are
 * rechecked, and the spec is compiled under the CURRENT actor + catalog: a revoked permission or changed catalog fails closed.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    await rateLimit(store, `artifacts:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params;
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await new ConciergeService(store).openArtifact(actor, id, query.revision), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
