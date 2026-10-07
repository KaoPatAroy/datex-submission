import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
const bodySchema = z.object({ revision: z.number().int().positive().optional(), conversationId: z.string().min(1).max(200).optional() }).strict();

/** Private save of the owner's artifact version (reversible, owner-only => direct, no confirmation step). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `artifacts:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `artifacts:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    const saved = await new ConciergeService(store).saveArtifact(actor, id, body);
    return NextResponse.json({ outcome: 'saved', text: `บันทึก Result ฉบับที่ ${saved.revision} แล้ว`, ...saved }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
