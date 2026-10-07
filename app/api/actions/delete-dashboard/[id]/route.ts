import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ConciergeService } from '@/lib/core/service';
import { failure } from '@/lib/server/http';
import { actorSession, checkCsrf } from '@/lib/server/session';
import { getStore } from '@/lib/storage';

export const runtime = 'nodejs';

/** Undo for a directly created private dashboard. Owner only; audited by the service. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore();
    const { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    z.object({}).strict().parse(await request.json());
    const { id } = await context.params;
    const result = await new ConciergeService(store).deleteDashboard(actor, id);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
