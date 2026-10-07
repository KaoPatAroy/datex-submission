import { NextResponse } from 'next/server';
import { getAIHealth } from '@/lib/ai/health';
import { getStore } from '@/lib/storage';
import { actorSession } from '@/lib/server/session';
import { failure } from '@/lib/server/http';

export const runtime = 'nodejs';
export async function GET() {
  try {
    const store = await getStore();
    const { actor } = await actorSession(store);
    return NextResponse.json(getAIHealth(Date.now(), actor.id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = failure(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
