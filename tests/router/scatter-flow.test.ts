import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';
import { param, plan, planner } from '../helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const STAMP = '2026-10-01T16:59:55.000Z';
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.reset();
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => {
    for (const [id, paid, target] of [['E03', 90_000, 120_000], ['E04', 160_000, 150_000]] as const) {
      await tx.put('branches', { id, name: `East ${id}`, region: 'east' });
      await tx.put('sales_orders', { id: `SO-${id}`, branchId: id, date: '2026-10-01', amountSatang: paid, status: 'paid', updatedAt: STAMP });
      await tx.put('sales_targets', { id: `TGT-${id}`, branchId: id, date: '2026-10-01', amountSatang: target, updatedAt: STAMP });
    }
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });
async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}

const interp = (id: string, text?: string) => ({ value: id, source: text ? 'explicit' : 'default', sourceText: text ? { text } : null, confidence: 1 });
const say = 'scatter East sales vs target by branch on 2026-10-01';
const query = (context: { business: { timezone: string } }) => ({ kind: 'query', continuation: false, plan: {
  planVersion: 1, planId: 'live:scatter', datasetId: 'branch_performance',
  measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: interp('net_sales', 'sales') }, { fieldId: 'target', aggregation: 'sum', interpretation: interp('target', 'target') }],
  dimensions: [{ fieldId: 'branch', interpretation: interp('branch', 'by branch') }],
  filters: [{ fieldId: 'region', op: 'eq', value: 'east', source: 'explicit', evidenceText: 'East', confidence: 1 }], scope: null,
  time: { fieldId: 'date', timezone: context.business.timezone, source: 'explicit', dates: ['2026-10-01'], evidenceText: '2026-10-01' },
  grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null, group: { fieldIds: ['branch'] }, compare: null, sort: [], topN: null,
  completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 }, clarificationNeeds: [], confidence: 1, requestedUses: ['answer'] } });
const scatter = (visual: Record<string, unknown>) => ({ kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'chart', operation: 'create', baseArtifactId: null,
  title: param('East sales vs target', 'generated'), outputFormat: 'preview', visual: { primitiveId: 'scatter', interactionIds: ['inspect_data', 'tooltip', 'select_point'], animation: 'none', ...visual } });

describe('S3: a scatter chart over two measures builds (and keeps the real-model plan shapes working)', { timeout: 60_000 }, () => {
  for (const [name, visual] of [
    ['x = entity dimension, y = both measures', { xFieldId: 'branch', yFieldIds: ['net_sales', 'target'] }],
    ['x = a measure (target), y = the other measure', { xFieldId: 'target', yFieldIds: ['net_sales'] }],
    ['x = a measure (net_sales), y = the other measure', { xFieldId: 'net_sales', yFieldIds: ['target'] }],
  ] as const) {
    it(name, async () => {
      const executive = await live(actors.executive);
      planner.reply((input: { context: { business: { timezone: string } } }) => plan(query(input.context), scatter(visual)));
      const turn = await fixture.service.turn(executive, say);
      expect(turn.clarification, turn.message).toBeUndefined();
      const artifact = turn.artifacts?.[0];
      expect(artifact, turn.message).toBeTruthy();
      expect(artifact!.kind).toBe('chart');
      expect(artifact!.spec.visualization).toMatchObject({ primitive: 'scatter' });
      expect(artifact!.spec.visualization?.pairs?.length).toBeGreaterThanOrEqual(3);
    });
  }
});
