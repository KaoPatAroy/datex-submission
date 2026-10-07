import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/storage';
import { actorSession, checkCsrf, rateLimit, trustedClientIp } from '@/lib/server/session';
import { failure } from '@/lib/server/http';
import { DomainError } from '@/lib/core/errors';
import {
  createConversation,
  DEFAULT_CONVERSATION_PAGE_SIZE,
  listConversations,
  MAX_CONVERSATION_PAGE_SIZE,
  MAX_CONVERSATION_SEARCH_LENGTH,
  MAX_CONVERSATION_TITLE_LENGTH
} from '@/lib/core/conversations';

export const runtime = 'nodejs';

const createSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_LENGTH).optional()
}).strict();

function boundedInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new DomainError('INVALID_INPUT', 'รูปแบบการแบ่งหน้าไม่ถูกต้อง', 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new DomainError('INVALID_INPUT', 'รูปแบบการแบ่งหน้าไม่ถูกต้อง', 400);
  return parsed;
}

function readOptions(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const rawQuery = search.get('q') ?? '';
  if (rawQuery.length > MAX_CONVERSATION_SEARCH_LENGTH) throw new DomainError('INVALID_INPUT', 'คำค้นหายาวเกินไป', 400);
  const includeArchived = search.get('includeArchived') ?? 'false';
  if (includeArchived !== 'true' && includeArchived !== 'false') throw new DomainError('INVALID_INPUT', 'ตัวกรองสถานะไม่ถูกต้อง', 400);
  return {
    query: rawQuery,
    cursor: search.get('cursor') ?? undefined,
    limit: boundedInteger(search.get('limit'), DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE),
    includeArchived: includeArchived === 'true'
  };
}

async function limitMutation(request: NextRequest, sessionId: string, store: Awaited<ReturnType<typeof getStore>>) {
  await rateLimit(store, `conversations:session:${sessionId}`, Number(process.env.DEMO_SESSION_REQUEST_LIMIT ?? 20));
  await rateLimit(store, `conversations:ip:${trustedClientIp(request)}`, Number(process.env.DEMO_IP_REQUEST_LIMIT ?? 60));
}

export async function GET(request: NextRequest) {
  try {
    const store = await getStore();return await withReadSnapshot(store,async()=>{
    const { actor } = await actorSession(store);
    const result = await listConversations(store, actor.id, readOptions(request));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  });} catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const store = await getStore();
    const { actor, session } = await actorSession(store);
    checkCsrf(request, session);
    await limitMutation(request, session.id, store);
    const body = createSchema.parse(await request.json());
    const conversation = await createConversation(store, actor.id, body.title);
    return NextResponse.json({ conversation }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}
