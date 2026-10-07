import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const querySchema = z.object({
  revision: z.coerce.number().int().positive().max(100).optional(), field: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/),
  value: z.string().min(1).max(200), message: z.string().min(1).max(200).optional(),
}).strict();

/**
 * Drilldown of one selected group: a read-only LINKED READ. The viewer (owner, or a recipient through their own inbox message) is
 * reauthorized, the artifact's registered query is re-run through the registered query path under their current authority, and only
 * the selected group's claims are returned. Nothing is written.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    await rateLimit(store, `artifacts:drill:${session.id}`, Number(process.env.DEMO_DRILL_REQUEST_LIMIT ?? 30));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params;
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const result = await new ConciergeService(store).drillArtifact(actor, { artifactId: id, field: query.field, value: query.value,
      ...(query.revision ? { revision: query.revision } : {}), ...(query.message ? { messageId: query.message } : {}) }, request.signal);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
