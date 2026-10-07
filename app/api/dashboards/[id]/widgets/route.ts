import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
const bodySchema = z.object({ baseRevision: z.string().min(1).max(200), change: z.unknown() }).strict();

/**
 * Direct widget edit of the owner's own Dashboard: change = { op: 'reorder', order } | { op: 'remove', index } | { op: 'retitle', index, title }.
 * Same write path as AI refinement: the revision CAS (stale => 409 DASHBOARD_CHANGED, never an overwrite) runs inside the transaction; a shared Dashboard stages the same confirm proposal chat creates ({ outcome: 'staged', proposalId }).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `dashboards:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `dashboards:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    const result = await new ConciergeService(store).editDashboardUi(actor, id, { kind: 'widgets', ...body });
    return NextResponse.json(result.outcome === 'updated'
      ? { outcome: 'updated', revision: result.view.revision, widgetCount: result.view.dashboard.spec.widgets.length }
      : result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
