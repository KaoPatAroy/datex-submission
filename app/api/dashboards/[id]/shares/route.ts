import { NextResponse } from 'next/server';
import { getStore } from '@/lib/storage';
import { withReadSnapshot } from '@/lib/storage/read-snapshot';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner's CURRENT shares of this item (exact share ids), so each can be revoked individually. Owner only. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore();
    return await withReadSnapshot(store, async () => {
    const { actor } = await actorSession(store);
    const { id } = await context.params;
    return NextResponse.json({ shares: await new ConciergeService(store).dashboardShares(actor, id) }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) { return failure(error); }
}
