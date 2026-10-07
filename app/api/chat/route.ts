import { NextRequest, NextResponse } from 'next/server';
import { ConciergeService } from '@/lib/core/service';
import { failure } from '@/lib/server/http';
import { prepareChatRequest } from '@/lib/server/chat-request';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  try {
    const { store, actor, body } = await prepareChatRequest(request);
    return NextResponse.json(await new ConciergeService(store, { routeStartedAt }).turn(
      actor,
      body.message,
      body.conversationId,
      body.recoveryOfTurnId,
      body.contractVersion === 2 && body.requestKey
        ? {
            contractVersion: 2,
            requestKey: body.requestKey,
            ...(body.demoShowcaseId ? { demoShowcaseId: body.demoShowcaseId } : {}),
            ...(body.catalogEntryId ? { catalogEntryId: body.catalogEntryId } : {}),
            ...(body.targets?.length ? { targets: body.targets } : {}),
            ...(body.clarificationChoiceId && body.clarifiedTurnId ? { clarification: { choiceId: body.clarificationChoiceId, clarifiedTurnId: body.clarifiedTurnId } } : {}),
          }
        : undefined
    ));
  } catch (error) {
    return failure(error);
  }
}
