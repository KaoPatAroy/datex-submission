import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { failure } from '@/lib/server/http';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';

/**
 * Daily monitor evaluation (Wave 4 monitors). Protected by the CRON_SECRET header check: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; `x-cron-secret` is accepted for manual/other schedulers. Fails closed (503) when the
 * secret is not configured, 401 on mismatch. Bounded per invocation (batch + wall-clock) and idempotent: the pure evaluator
 * enforces cadence/cooldown/dedupe and the alert outbox key makes overlapping invocations safe.
 *
 * Scheduled in vercel.json: `0 1 * * *` (01:00 UTC = 08:00 Bangkok), the finest cadence the Vercel Hobby plan allows. Vercel
 * invokes it with GET + `Authorization: Bearer $CRON_SECRET`, so CRON_SECRET must be set in the project environment. Monitors
 * are therefore checked once a day with at most one alert per day.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(request: NextRequest): 'ok' | 'unconfigured' | 'denied' {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return 'unconfigured';
  const bearer = request.headers.get('authorization');
  const supplied = (bearer?.startsWith('Bearer ') ? bearer.slice(7) : request.headers.get('x-cron-secret') ?? '').trim();
  const a = Buffer.from(supplied), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'denied';
}

async function run(request: NextRequest) {
  try {
    const gate = authorized(request);
    if (gate === 'unconfigured') return NextResponse.json({ error: 'cron_unconfigured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    if (gate === 'denied') return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const store = await getStore();
    const runner = createMonitorRunner({ store, now: () => new Date(), businessDate: process.env.DEMO_BUSINESS_DATE ?? '2026-10-01',
      recipientAllowed: createRecipientPolicy(store) });
    return NextResponse.json({ ok: true, ...(await runner.tick({ limit: 50, budgetMs: 20_000 })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export const GET = run;
export const POST = run;
