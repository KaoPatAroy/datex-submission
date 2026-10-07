import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Store, Table, Transaction } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { conversationStep, plan, planner } from './helpers/turn-planner';
import type { TurnPlannerInput } from '../lib/router/planner/input';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

const PAIRS = 3; // planner context keeps the newest six messages (three completed pairs)
const PROOF_READS = 6; // plannerHistory proves at most the newest six completed turns, however many exist (12 here)
type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

function countCompletionReads(base: Store): Store & { completionReads(): number; reset(): void } {
  let reads = 0;
  return {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: Record<string, string | string[]>) => base.list<T>(table, filters),
    get: <T>(table: Table, id: string) => {
      if (table === 'tool_executions' && id.startsWith('turncompletion_')) reads += 1;
      return base.get<T>(table, id);
    },
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(work),
    close: () => base.close?.(),
    completionReads: () => reads,
    reset: () => { reads = 0; },
  };
}

// Planner prose is digit-bearing on purpose: ungrounded digits must never be shown or fed back as history.
function plainPlan(input: TurnPlannerInput) {
  return plan(conversationStep('advice', `Assistant reply to: ${input.currentMessage}`));
}

describe('completed AI history read bounds', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture.dispose();
  });

  async function liveActor(): Promise<Actor> {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
  }

  it('reuses workspace completion proofs and keeps the newest three completed pairs after many turns and a failed user turn', async () => {
    const actor = await liveActor();
    const countedStore = countCompletionReads(fixture.store);
    let clockTicks = 0;
    let failMessage: string | undefined;
    const service = new ConciergeService(countedStore, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW.getTime() + clockTicks++ * 1_000),
    });
    planner.reply((input: TurnPlannerInput) => {
      if (input.currentMessage === failMessage) throw new Error('Synthetic provider failure for an incomplete turn.');
      return plainPlan(input);
    });

    let conversationId: string | undefined;
    const successfulUserMessages: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const message = `Synthetic completed request ${index}`;
      successfulUserMessages.push(message);
      const response = await service.turn(actor, message, conversationId);
      conversationId = response.conversationId;
    }
    if (!conversationId) throw new Error('The synthetic conversation was not created.');

    const failedMessage = 'Synthetic failed user request';
    failMessage = failedMessage;
    await expect(service.turn(actor, failedMessage, conversationId))
      .rejects.toThrow('Synthetic provider failure for an incomplete turn.');
    failMessage = undefined;
    expect((await service.getWorkspace(actor)).messages.some(message => message.role === 'user' && message.text === failedMessage)).toBe(true);

    countedStore.reset();
    const finalMessage = 'Synthetic request after the failed turn';
    await service.turn(actor, finalMessage, conversationId);

    expect(countedStore.completionReads()).toBe(PROOF_READS);
    const history = planner.calls.at(-1)?.context.conversation ?? [];
    expect(history.map(item => item.role)).toEqual(Array.from({ length: PAIRS }, () => ['user', 'assistant']).flat());
    expect(history.filter(item => item.role === 'user').map(item => item.text)).toEqual(successfulUserMessages.slice(-PAIRS));
    // Digit-bearing ungrounded prose is replaced by the server capability reply, never the bare refusal.
    for (const item of history.filter(entry => entry.role === 'assistant')) {
      expect(item.text).not.toBe('โปรดระบุข้อมูลหรือการดำเนินงานในรายการความสามารถของบัญชีนี้');
      expect(item.text).not.toMatch(/\p{N}/u);
    }
    expect(history.some(item => item.text === failedMessage)).toBe(false);
  });

  it('does not read prior completed-turn proofs in Scripted Demo, where model history is unused', async () => {
    const countedStore = countCompletionReads(fixture.store);
    const service = new ConciergeService(countedStore, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });

    const first = await service.turn(actors.executive, 'A synthetic scripted question');
    countedStore.reset();
    await service.turn(actors.executive, 'A second synthetic scripted question', first.conversationId);

    expect(countedStore.completionReads()).toBe(0);
  });
});
