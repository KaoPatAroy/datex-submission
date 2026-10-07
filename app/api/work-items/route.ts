import { NextRequest, NextResponse } from 'next/server';
import { failure } from '@/lib/server/http';
import { actorSession } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { pageInputFrom } from '@/lib/pagination';
import { listManagedWorkItemsPage, type WorkItemScope } from '@/lib/work-items/lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES: readonly WorkItemScope[] = ['created', 'assigned', 'tickets'];

/**
 * Bounded pages of the signed-in actor's work: `?scope=created` (default: tasks I created), `assigned` (tasks assigned to me by someone else) or
 * `tickets` (legacy Tickets I created). Archived items only with `?view=archived` (or both with the legacy `?archived=1`); optional `?q=` search,
 * `?cursor=&limit=`. Archive and search are applied BEFORE the page boundary; `total` is the exact size of the selection.
 */
export async function GET(request: NextRequest) {
  try {
    const store = await getStore(), { actor } = await actorSession(store);
    const params = request.nextUrl.searchParams, scope = params.get('scope') as WorkItemScope | null, needle = params.get('q')?.slice(0, 80);
    const page = await listManagedWorkItemsPage(store, actor, { ...pageInputFrom(params, JSON.stringify(['work-items', actor.id, scope && SCOPES.includes(scope) ? scope : 'created', params.get('archived') === '1', params.get('view') === 'archived', needle ?? ''])), scope: scope && SCOPES.includes(scope) ? scope : 'created',
      includeArchived: params.get('archived') === '1', archivedOnly: params.get('view') === 'archived', ...(needle ? { needle } : {}) });
    return NextResponse.json({ items: page.items, total: page.total, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
