import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Turn completion proofs belong to the service transaction; the executor only needs the gate to report completion.
vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import { executeQueryStep } from '@/lib/router/executors/query';
import { filter, proposal } from '../../dynamic/fixtures';
import { actors, base, read, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

const run = (message: string, plan = proposal(message), actor = actors.executive, extra: Record<string, unknown> = {}) =>
  executeQueryStep({ ...base(fixture, actor, message), read, step: { kind: 'query', continuation: false, plan }, ...extra });

describe('query executor', () => {
  it('accepts a query and returns Thai text, sources, analysis, interpreted scope and a persist hook', async () => {
    const result = await run('Show sales');
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.text).toContain('ขอบเขตที่ตีความ');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.analysis.facts.length).toBe(result.claims.claims.length);
    expect(result.interpretedScope).toMatchObject({ datasetId: 'branch_performance', dates: ['2026-10-01'], measures: ['net_sales'] });
    expect(result.interpretedScope.branchIds).toContain('E02');
    // Numbers only from evidence: every claim value appears in the typed claim graph.
    expect(result.claims.claims.every(claim => typeof claim.value === 'number')).toBe(true);
  });

  it('persists a CAS-checked state that a follow-up binds to', async () => {
    const first = await run('Show sales');
    if (first.outcome !== 'accepted') throw new Error('expected accepted');
    await fixture.store.transaction(tx => first.persist(tx, actors.executive, 'conv-1'));
    const text = 'And east';
    const followPlan = { ...filter(proposal('Show sales'), text, 'region', 'east', 'east'), measures: proposal('Show sales').measures };
    followPlan.measures = [{ ...followPlan.measures[0], interpretation: { ...followPlan.measures[0].interpretation,
      sourceText: { start: 0, end: 3, text: 'And' } } }];
    const follow = await executeQueryStep({ ...base(fixture, actors.executive, text, 'turn:2'), read, conversationId: 'conv-1',
      step: { kind: 'query', continuation: true, plan: followPlan }, continuation: 'bound' });
    expect(follow.outcome).toBe('accepted');
    if (follow.outcome !== 'accepted') return;
    expect(follow.intent.intentKind).toBe('follow_up');
    expect(follow.intent.parentStateId).toBeTruthy();
    await fixture.store.transaction(tx => follow.persist(tx, actors.executive, 'conv-1'));
    const saved = await fixture.store.get<{ state: { revision: number } }>('tool_executions', 'dynamic:turn:2');
    expect(saved?.state.revision).toBe(2);
  });

  it('denies a scope outside the actor authority without reading other regions', async () => {
    const message = 'Show south sales';
    const reads: string[] = [];
    const result = await run(message, filter(proposal(message), message, 'region', 'south', 'south'), actors.east,
      { read: async (scope: Parameters<typeof read>[0]) => { reads.push(scope.region); return read(scope); } });
    expect(result.outcome).toBe('denied');
    expect(reads).not.toContain('south');
    expect(JSON.stringify(result)).not.toContain('S01');
  });

  it('asks a typed clarification when the requested date is outside the served window', async () => {
    const message = 'Show sales on 2026-08-01';
    const plan = proposal(message);
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-08-01'], evidenceText: '2026-08-01' } as never;
    const result = await run(message, plan);
    expect(result.outcome).toBe('clarify');
    if (result.outcome === 'clarify') {
      expect(result.text).toContain('2026-10-01');
      expect(result.kind).toBe('query');
    }
  });

  it('asks to clarify when a span cannot be located in the user text', async () => {
    const plan = proposal('Show sales');
    plan.measures[0].interpretation.sourceText = { start: 0, end: 6, text: 'profit' };
    const result = await run('Show sales', plan);
    expect(result.outcome).toBe('clarify');
  });

  it('rejects a dataset the query executor does not own', async () => {
    const plan = { ...proposal('Show sales'), datasetId: 'hr_employees' };
    const result = await run('Show sales', plan);
    expect(result).toMatchObject({ outcome: 'denied', code: 'dataset_mismatch' });
  });
});
