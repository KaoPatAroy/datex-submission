import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import { NextRequest, NextResponse } from 'next/server';
import { pageInputFrom } from '@/lib/pagination';
import { failure } from '@/lib/server/http';
import { actorSession } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in actor's own monitors (bounded pages, optional ?q= title search, ?deleted=1 for deleted monitors' retained evaluations) with persisted evaluation history. Read-only; owner-scoped. */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore();return await withReadSnapshot(store,async()=>{const  { actor } = await actorSession(store);
    const runner = createMonitorRunner({ store, now: () => new Date(), businessDate: process.env.DEMO_BUSINESS_DATE ?? '2026-10-01', recipientAllowed: createRecipientPolicy(store) });
    const params = request.nextUrl.searchParams, needle = params.get('q')?.slice(0, 80);
    const page = await runner.historyPage(actor, { ...pageInputFrom(params, JSON.stringify(['monitors', actor.id, needle ?? '', params.get('deleted') === '1'])), ...(needle ? { needle } : {}), deleted: params.get('deleted') === '1' });
    return NextResponse.json({ monitors: page.items, total: page.total, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  });} catch (error) { return failure(error); }
}
