import { NextRequest, NextResponse } from 'next/server';
import { failure } from '@/lib/server/http';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { applyMonitorOp, monitorOpSchema, monitorRenameSchema, renameMonitor } from '@/lib/monitors/direct';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-private Monitor lifecycle from the UI: pause / resume directly, delete only with an explicit confirmDelete from the confirm dialog. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `monitors:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `monitors:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, raw: unknown = await request.json();
    // Metadata edit (display title only): same owner check + row-version CAS, never the condition/recipients/cadence.
    if (raw && typeof raw === 'object' && (raw as { op?: unknown }).op === 'rename') {
      const renamed = await renameMonitor(store, () => new Date(), actor, id, monitorRenameSchema.parse(raw));
      return NextResponse.json({ outcome: 'updated', text: renamed.text }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const body = monitorOpSchema.parse(raw);
    const runner = createMonitorRunner({ store, now: () => new Date(), businessDate: process.env.DEMO_BUSINESS_DATE ?? '2026-10-01', recipientAllowed: createRecipientPolicy(store) });
    const done = await applyMonitorOp(runner, actor, id, body);
    return NextResponse.json({ outcome: 'updated', text: done.text }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
