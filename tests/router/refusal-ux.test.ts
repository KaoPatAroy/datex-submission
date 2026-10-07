import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../lib/contracts';
import { NO_RESULT_MARK } from '../../lib/router/context/build-context';
import { AIRuntimeError } from '../../lib/ai/errors';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { clarifyStep, conversationStep, plan, planner } from '../helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
const extrasOf = (turnId: string) => fixture.store.get<{ followUps?: string[]; clarification?: boolean; hint?: string }>('tool_executions', `turn-extras:${turnId}`);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.reset();
  fixture = await createWorkspaceFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.dispose();
});

describe('refusals are never a bare dead end', { timeout: 30_000 }, () => {
  it('an unusable plan answers in Thai with server-owned suggestion chips and the demo hint', async () => {
    const actor = await live(actors.executive);
    planner.reply({ turnPlanVersion: 1, steps: [{ kind: 'bogus' }] });
    const response = await fixture.service.turn(actor, 'อะไรก็ได้');
    expect(response.message).toContain('ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล');
    expect(response.hint).toBe('switch_to_demo');
    const extras = await extrasOf(response.turnId);
    expect(extras?.followUps?.length).toBeGreaterThanOrEqual(2);
    expect(extras?.followUps?.length).toBeLessThanOrEqual(3);
    expect(extras?.followUps?.join(' ')).not.toMatch(/\d|params\.|_/u);
  });

  it('a clarification with nothing to pick still offers next steps from the actor catalog', async () => {
    const actor = await live(actors.executive);
    planner.reply(plan(clarifyStep({ kind: 'action', actionId: 'monitor.create' }, 'threshold', 'ต้องการให้แจ้งเตือนเมื่อยอดขายต่ำกว่าเป้าแค่ไหนครับ')));
    const response = await fixture.service.turn(actor, 'แจ้งเตือนถ้ายอดขายต่ำกว่าเป้า');
    expect(response.clarification).toBe(true);
    expect(response.message).not.toContain('params.');
    expect((await extrasOf(response.turnId))?.followUps?.length).toBeGreaterThanOrEqual(2);
  });

  it('a slow planner shows the slow-AI text (not "unavailable") and offers the demo switch', async () => {
    const actor = await live(actors.executive);
    planner.fail(new AIRuntimeError('deadline_exceeded', 'The AI response took too long.'));
    const response = await fixture.service.turn(actor, 'ยอดขายวันนี้');
    expect(response.message).toContain('Live AI ใช้เวลาตอบนานเกินไป');
    expect(response.hint).toBe('switch_to_demo');
  });

  it('a refused turn is labeled in the next planner context, so it never reads as a state to continue', async () => {
    const actor = await live(actors.executive);
    planner.reply({ turnPlanVersion: 1, steps: [{ kind: 'bogus' }] });
    const first = await fixture.service.turn(actor, 'คำขอแรก');
    planner.reply(plan(conversationStep('acknowledgement', 'รับทราบครับ')));
    await fixture.service.turn(actor, 'คำขอถัดไป', first.conversationId);
    const context = planner.calls.at(-1)!.context;
    const assistant = context.conversation.filter(entry => entry.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text.startsWith(NO_RESULT_MARK)).toBe(true);
    expect(context.previousState).toBeNull();
  });
});
