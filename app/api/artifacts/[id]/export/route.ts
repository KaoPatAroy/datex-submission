import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
const bodySchema = z.object({ revision: z.number().int().positive().optional(), conversationId: z.string().min(1).max(200).optional() }).strict();

/** CSV download of the owner's artifact; text cells are formula-neutralized and the evidence digests are rechecked on load. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `artifacts:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    const { filename, csv } = await new ConciergeService(store).exportArtifact(actor, id, body);
    return new NextResponse(csv, { status: 200, headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return failure(error); }
}
