import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { ConciergeService } from '@/lib/core/service';
import { RESULT_KINDS } from '@/lib/artifacts/library-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: z.enum([...RESULT_KINDS, 'all']).optional(),
  section: z.enum(['saved', 'recent', 'archived', 'all']).optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
  cursor: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

/**
 * The signed-in owner's Results library: one entry per Result with its revisions grouped, plus display metadata (pin, archive, title).
 * Owner-scoped. Search / type / status are applied on the server BEFORE the page boundary; the answer carries the matching `total` and a
 * `nextCursor` (and `truncated` when the scan itself was capped) so a page is never presented as the complete library.
 */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore(), { actor } = await actorSession(store);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const page = await new ConciergeService(store).resultsLibraryPage(actor, { query: query.q, kind: query.kind, section: query.section, sort: query.sort, cursor: query.cursor, limit: query.limit });
    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
