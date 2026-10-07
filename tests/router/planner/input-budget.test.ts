import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, StoredRow, Table } from '@/lib/contracts';
import type { PlannerContext } from '@/lib/router/planner-context';
import { buildTurnPlannerInput, TURN_PLANNER_MAX_INPUT_BYTES, type TurnPlannerInput } from '@/lib/router/planner/input';
import { scriptedTurnPlan } from '@/lib/router/planner/scripted';
import { createSeedData } from '@/lib/seed/generate';
import { actors, BUSINESS_DATE, createWorkspaceFixture } from '../../helpers/workspace';
import { plan, planner } from '../../helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

/**
 * Planner input headroom on the SEEDED demo data (12 branches, every table dataset). The executive worst case is a later turn of a real
 * conversation (a verified query, a chart, a follow-up query: real PREVIOUS_STATE_DATA, REFERENCE_SET, history) with every bounded list at
 * its item cap and long Thai titles. It must fit with at least 8 KB to spare WITHOUT trimming anything (PRODUCT_MODEL and all Dashboards stay).
 */
const HEADROOM_BYTES = 8 * 1024;
const LIMIT = TURN_PLANNER_MAX_INPUT_BYTES - HEADROOM_BYTES;

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
const title = (n: number) => 'ยอดขายสาขาภาคตะวันออกเทียบเป้าหมายรายวันประจำสัปดาห์'.repeat(2).slice(0, n);
const uuid = (prefix: string, i: number) => `${prefix}_${i}0000000-aaaa-4bbb-8ccc-${String(i).padStart(12, '0')}`;
/** Every bounded list at the item cap the planner input keeps, with 40-character Thai titles (assistant history at its 240-character bound). */
function atCaps(context: PlannerContext): PlannerContext {
  return { ...context,
    dashboards: Array.from({ length: 10 }, (_, i) => ({ id: uuid('dash', i), title: title(40) })),
    monitors: Array.from({ length: 5 }, (_, i) => ({ id: uuid('mon', i), title: title(40), status: 'active' })),
    artifacts: Array.from({ length: 5 }, (_, i) => ({ id: uuid('artifact', i), typeId: 'chart', title: title(40), revision: 1 })),
    archivedArtifacts: Array.from({ length: 3 }, (_, i) => ({ id: uuid('artifact', 9 - i), typeId: 'table', title: title(40) })),
    acceptedStates: [...context.acceptedStates, ...Array.from({ length: 3 }, (_, i) => ({ stateId: uuid('state', i), datasetId: 'branch_performance', label: title(30) }))].slice(0, 3),
    pendingActions: Array.from({ length: 4 }, (_, i) => ({ id: uuid('pa', i), kind: 'dashboard_create', title: title(40), widgetIndexes: [0, 1], values: {} })),
    conversation: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: title(i % 2 ? 240 : 40).padEnd(i % 2 ? 240 : 40, 'ก') })),
  };
}
const blockLine = (input: TurnPlannerInput, name: string) => input.prompt.split('\n').find(line => line.startsWith(`${name}=`));

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.reset();
  fixture = await createWorkspaceFixture();
  const seed = createSeedData(BUSINESS_DATE);
  await fixture.store.transaction(async tx => {
    for (const [name, rows] of Object.entries(seed)) {
      const table = name as Table;
      for (const row of await tx.list<StoredRow>(table)) await tx.remove(table, row.id);
      for (const row of rows) if (!('date' in row) || row.date === BUSINESS_DATE) await tx.put(table, row);
    }
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.dispose();
});

describe('planner input budget headroom (seeded roles)', { timeout: 60_000 }, () => {
  it('pins the contract: a 76,000-byte runtime input budget with at least 8 KB (8,192 bytes) of headroom on seeded data', () => {
    expect(TURN_PLANNER_MAX_INPUT_BYTES).toBe(76_000);
    expect(HEADROOM_BYTES).toBeGreaterThanOrEqual(8 * 1024);
    expect(LIMIT).toBe(76_000 - HEADROOM_BYTES);
  });

  it('first and later turns of every seeded role leave at least 8 KB of the input budget', async () => {
    for (const role of ['executive', 'east', 'hr'] as const) {
      planner.reset();
      const actor = await live(actors[role]);
      planner.reply(plan({ kind: 'conversation', topic: 'greeting', prose: 'สวัสดีครับ' }));
      const first = await fixture.service.turn(actor, 'สวัสดี');
      await fixture.service.turn(actor, 'สวัสดีอีกครั้ง', first.conversationId);
      expect(planner.calls).toHaveLength(2);
      for (const call of planner.calls) {
        expect(call.inputBytes, `${role}`).toBeLessThanOrEqual(LIMIT);
        expect(blockLine(call, 'PRODUCT_MODEL'), role).toBeDefined();
      }
    }
  });

  it('the executive worst case (real later turn, every list at its cap) fits with 8 KB to spare and drops nothing', async () => {
    const actor = await live(actors.executive);
    planner.reply((input: TurnPlannerInput) => scriptedTurnPlan(input));
    const first = await fixture.service.turn(actor, 'Show East sales and target for 2026-10-01.');
    await fixture.service.turn(actor, 'Make a combo chart of East sales and target by branch for 2026-10-01.', first.conversationId);
    await fixture.service.turn(actor, 'Show East sales totals for 2026-10-01.', first.conversationId);
    const later = planner.calls.at(-1)!;
    expect(later.context.previousState?.plan).toBeDefined();
    expect(later.context.references).toBeDefined();
    const worst = buildTurnPlannerInput(atCaps(later.context), { current: 'สร้าง Dashboard ยอดขายภาคตะวันออกรายสาขาเทียบเป้าและสัดส่วนยอดขาย' });
    expect(worst.inputBytes, `worst case ${worst.inputBytes} B`).toBeLessThanOrEqual(LIMIT);
    // Nothing was given up under budget pressure.
    expect(blockLine(worst, 'PRODUCT_MODEL')).toBeDefined();
    expect(JSON.parse(blockLine(worst, 'DASHBOARDS')!.slice('DASHBOARDS='.length))).toHaveLength(10);
    // The budget loop gives up archived Results first: all three still present = the loop never ran (ARTIFACTS keeps its own 1 KB block cap).
    expect(JSON.parse(blockLine(worst, 'ARCHIVED_ARTIFACTS')!.slice('ARCHIVED_ARTIFACTS='.length))).toHaveLength(3);
    expect(JSON.parse(blockLine(worst, 'RECENT_CONVERSATION')!.slice('RECENT_CONVERSATION='.length))).toHaveLength(6);
  });
});
