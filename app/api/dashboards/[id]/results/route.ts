import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
const bodySchema = z.object({ baseRevision: z.string().min(1).max(200).optional(), artifactId: z.string().min(1).max(200), revision: z.number().int().positive().max(100).optional() }).strict();

/**
 * Add an owned Result to the owner's Dashboard (a shared Dashboard stages the confirm proposal) as dynamic, re-authorized widgets (never a screenshot).
 * A Result that cannot become a widget drawn from current evidence is refused with 422 RESULT_NOT_ADDABLE and an explanation.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `dashboards:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `dashboards:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    const result = await new ConciergeService(store).editDashboardUi(actor, id, { kind: 'add_result', ...body });
    return NextResponse.json(result.outcome === 'updated'
      ? { outcome: 'updated', revision: result.view.revision, widgetCount: result.view.dashboard.spec.widgets.length, ...('note' in result.view && typeof result.view.note === 'string' ? { note: result.view.note } : {}) }
      : result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
