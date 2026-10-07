import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SalesTarget } from '@/lib/contracts';
import { SCRIPTED_REVISE_CHART_PROMPT } from '@/lib/router/planner/scripted';
import { createSeededService, SEED_NOW } from '../helpers/seeded-service';

type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

const COMBO = 'Make a combo chart of East sales and target by branch for 2026-10-01.';
const identity = () => ({ contractVersion: 2 as const, requestKey: `revise_key_${Math.random().toString(36).slice(2)}_${Date.now()}_padding`.slice(0, 80) });

describe('revise the latest chart in real time (UI path)', { timeout: 180_000 }, () => {
  it('a revision requested seconds after the chart was made becomes revision 2 of the same Result', async () => {
    const actor = seeded.actors.executive;
    seeded.setNow(new Date(SEED_NOW));
    const made = await seeded.service.turn(actor, COMBO, undefined, undefined, identity());
    const artifactId = (await seeded.service.resultsLibrary(actor)).find(item => item.kind === 'chart')!.id;
    // The clock moves between turns, as it does for a real user.
    seeded.setNow(new Date(SEED_NOW.getTime() + 7_000));
    const revised = await seeded.service.turn(actor, SCRIPTED_REVISE_CHART_PROMPT, made.conversationId, undefined, identity());
    expect(revised.clarification, revised.message).toBeUndefined();
    expect((await seeded.service.resultsLibrary(actor)).find(item => item.id === artifactId)).toMatchObject({ latestRevision: 2 });
  });

  it('a revision is still refused when the evidence itself changed since the latest version (not only its read time)', async () => {
    const actor = seeded.actors.executive;
    seeded.setNow(new Date(SEED_NOW.getTime() + 60_000));
    const made = await seeded.service.turn(actor, COMBO, undefined, undefined, identity());
    const target = (await seeded.store.list<SalesTarget>('sales_targets')).find(row => row.branchId === 'E01' && row.date === '2026-10-01')!;
    await seeded.store.transaction(async tx => { await tx.put('sales_targets', { ...target, amountSatang: target.amountSatang + 100_00 }); });
    seeded.setNow(new Date(SEED_NOW.getTime() + 67_000));
    const revised = await seeded.service.turn(actor, SCRIPTED_REVISE_CHART_PROMPT, made.conversationId, undefined, identity());
    expect(revised.clarification).toBe(true);
    expect(revised.message).toContain('ผลลัพธ์เดิมไม่ตรงกับหลักฐานนี้');
  });
});
