import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { failure } from '@/lib/server/http';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { getStore } from '@/lib/storage';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { applyWorkItemOp, editFieldsSchema, getWorkItemDetail, WORK_ITEM_OPS } from '@/lib/work-items/lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const bodySchema = z.object({ op: z.enum(WORK_ITEM_OPS), baseRevision: z.number().int().min(0), fields: editFieldsSchema.optional(), confirmAssigneeChange: z.boolean().optional() }).strict();

/** Exact detail (current state + attributable transition history) for the item's creator or current assignee; anyone else gets 404. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor } = await actorSession(store);
    const { id } = await context.params;
    return NextResponse.json(await getWorkItemDetail(store, actor, id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

/** Lifecycle of one work item for its creator (all operations) or current assignee (complete / reopen) with a revision CAS; the original item row is never rewritten. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore(), { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await rateLimit(store, `work-items:session:${session.id}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
    await rateLimit(store, `work-items:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
    const { id } = await context.params, body = bodySchema.parse(await request.json());
    const item = await applyWorkItemOp({ store, now: () => new Date(), recipientAllowed: createRecipientPolicy(store) }, actor, id, body);
    return NextResponse.json({ outcome: 'updated', item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
