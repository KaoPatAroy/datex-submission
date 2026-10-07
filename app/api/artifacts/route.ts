import { NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in actor's own artifacts (every conversation) with their immutable revisions. Owner-scoped; nothing of other owners is listed. */
export async function GET() {
  try {
    const store = await getStore(), { actor } = await actorSession(store);
    return NextResponse.json({ artifacts: await new ConciergeService(store).artifactHistory(actor) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
