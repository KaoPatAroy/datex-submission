import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import type { Actor, Branch } from '@/lib/contracts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { actionRegistry } from '@/lib/router/action-registry';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { executeTableQueryStep } from '@/lib/router/executors/table-query';
import { buildTurnPlannerInput } from '@/lib/router/planner/input';
import { validateTurnPlan } from '@/lib/router/validate';
import { actors, BUSINESS_DATE, FIXED_NOW, seedTables, tableBase, tableFixtureCleanup, tableFixtures, tDimension, tMeasure, tablePlan } from '../executors/table-fixtures';

afterEach(async () => { await tableFixtureCleanup(); });

const listing = (cursor: string | null) => tablePlan('incident_log', {
  measures: [tMeasure('incident_records', 'count')], dimensions: [tDimension('branch'), tDimension('kind')], aggregation: 'rows',
  sort: [{ fieldId: 'branch', direction: 'asc' }], page: { limit: 2, cursor },
} as never);

async function context(fixture: Awaited<ReturnType<typeof seedTables>>, actor: Actor = actors.executive, conversationId = 'conv-r') {
  const catalog = createSemanticCatalog(await fixture.store.list<Branch>('branches'));
  return buildPlannerContext({ store: fixture.store, actor, conversationId, businessDate: BUSINESS_DATE, catalog, registry: actionRegistry,
    recipientAllowed: async () => true, now: () => FIXED_NOW.getTime() });
}

describe('CONTEXT-001 exact reference set', () => {
  it('offers the accepted table state, its page cursor, the drill path and a stable digest', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 5 }));
    const empty = await context(fixture);
    expect(empty.references).toMatchObject({ pagination: null, continuation: { table: null, retail: null, hr: null }, queryStates: [] });

    const first = await executeTableQueryStep({ ...tableBase(fixture, actors.executive, 'list incidents'), step: { kind: 'query', continuation: false, plan: listing(null) } } as never);
    if (first.outcome !== 'accepted') throw new Error('expected accepted');
    await fixture.store.transaction(tx => first.persist(tx, actors.executive, 'conv-r'));
    const after = await context(fixture);
    const refs = after.references!;
    expect(refs.queryStates).toHaveLength(1);
    expect(refs.queryStates[0]).toMatchObject({ family: 'table', datasetId: 'incident_log', revision: 1 });
    expect(refs.continuation.table).toBe(refs.queryStates[0].stateId);
    expect(refs.pagination).toMatchObject({ stateId: refs.queryStates[0].stateId, offset: 0, limit: 2, nextCursor: first.bundle.page.nextCursor });
    expect(refs.drillPath).toMatchObject({ stateId: refs.queryStates[0].stateId, datasetId: 'incident_log', groupBy: [] });
    expect(refs.digest).not.toBe(empty.references!.digest);
    // A table answer is a first-class accepted state: a later step (artifact, Dashboard widgets, message) may build on its exact id.
    expect(after.acceptedStates).toMatchObject([{ stateId: refs.queryStates[0].stateId, datasetId: 'incident_log' }]);
    // Another conversation and another actor see none of it.
    expect((await context(fixture, actors.executive, 'conv-other')).references!.queryStates).toEqual([]);
    expect((await context(fixture, actors.east)).references!.queryStates).toEqual([]);
    // The same context twice has the same digest (exact identity).
    expect((await context(fixture)).references!.digest).toBe(refs.digest);
  });

  it('a follow-up may present only the cursor the reference set offers; the page then advances', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 5 }));
    const first = await executeTableQueryStep({ ...tableBase(fixture, actors.executive, 'list incidents'), step: { kind: 'query', continuation: false, plan: listing(null) } } as never);
    if (first.outcome !== 'accepted') throw new Error('expected accepted');
    await fixture.store.transaction(tx => first.persist(tx, actors.executive, 'conv-r'));
    const ctx = await context(fixture);
    const offered = ctx.references!.pagination!.nextCursor!;
    const step = (cursor: string) => ({ turnPlanVersion: 1, steps: [{ kind: 'query', continuation: true, plan: listing(cursor) }] });
    const messages = { current: 'list incidents' };
    expect(validateTurnPlan({ raw: step(offered), messages, context: ctx, registry: actionRegistry }).outcome).toBe('accepted');
    const forged = validateTurnPlan({ raw: step('Zm9yZ2Vk'), messages, context: ctx, registry: actionRegistry });
    expect(forged).toMatchObject({ outcome: 'clarify', code: 'unknown_context_id' });

    const second = await executeTableQueryStep({ ...tableBase(fixture, actors.executive, 'list incidents', 'turn:t2'),
      step: { kind: 'query', continuation: true, plan: listing(offered) }, continuation: 'bound', conversationId: 'conv-r' } as never);
    expect(second.outcome).toBe('accepted');
    if (second.outcome !== 'accepted') return;
    expect(second.bundle.page.offset).toBe(2);
    await fixture.store.transaction(tx => second.persist(tx, actors.executive, 'conv-r'));
    const next = (await context(fixture)).references!;
    expect(next.queryStates.map(s => s.revision)).toEqual([2, 1]);
    expect(next.pagination?.offset).toBe(2);
    // The old cursor is no longer on offer.
    expect(validateTurnPlan({ raw: step(offered), messages, context: await context(fixture), registry: actionRegistry }).outcome).toBe('clarify');
  });

  it('the planner prompt carries the reference set block and the authorized policies list', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 5 }));
    await fixture.store.transaction(async tx => { await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 't', updatedAt: '2026-10-01T10:00:00+07:00' }); });
    const input = buildTurnPlannerInput(await context(fixture), { current: 'x' });
    expect(input.prompt).toContain('REFERENCE_SET=');
    expect(input.prompt).toContain('POLICIES=[{"id":"POL-OPS-001"');
    expect(input.inputBytes).toBeLessThan(70_000); // widened from 66_000 (Results library actions + guidance); earlier 64_000: the Dashboard chart-family guidance + one validated example
  });
});
