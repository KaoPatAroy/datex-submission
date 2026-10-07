import { dateList } from '../../lib/dynamic/plan/time';
import { describe, expect, it, vi } from 'vitest';
import type { Evidence } from '../../lib/contracts';
import { createSemanticCatalog } from '../../lib/dynamic/catalog/semantic';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { prepareConversationState, conversationStateSchema } from '../../lib/dynamic/state/conversation';
import { buildPlannerInput, conversationStateRef, planQuery } from '../../lib/dynamic/planner/planner';
import { validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { digest } from '../../lib/dynamic/shared';
import { accept, available, branches, executive, fakeEvidence, filter, manager, proposal, ranking, readAt, span } from './fixtures';

async function bundle(plan = proposal(), text = 'Show sales', authority = executive) {
  const accepted = accept(plan, text, authority);
  const result = await executeReadRequest(compileQueryPlan(accepted), async scope => fakeEvidence(scope), authority, readAt);
  if (result.outcome !== 'accepted') throw new Error(`Execution failed: ${result.code}`);
  return { accepted, bundle: result.bundle, graph: buildClaimGraph(result.bundle) };
}

describe('registered execution, coverage, and provenance', () => {
  it('immutable tokens cannot be forged or changed after validation/compilation', async () => {
    const accepted = accept(), request = compileQueryPlan(accepted), reader = vi.fn(async scope => fakeEvidence(scope));
    expect(() => compileQueryPlan(structuredClone(accepted))).toThrow(/validated/);
    expect(Object.isFrozen(accepted.plan.measures[0])).toBe(true);
    expect(Object.isFrozen(request.scopes[0].branchIds)).toBe(true);
    expect(await executeReadRequest(structuredClone(request), reader, executive, readAt)).toMatchObject({ outcome: 'execution_failed', code: 'invalid_read_request' });
    expect(reader).not.toHaveBeenCalled();
  });
  it('chunks branch scopes at the existing reader limit and verifies all chunks before claims', async () => {
    const registry = Array.from({ length: 25 }, (_, i) => ({ id: `B${i}`, name: `Branch ${i}`, region: 'one_region' }));
    const catalog = createSemanticCatalog(registry);
    const result = validateQueryPlan(proposal(), catalog, executive, { ...available(), branchIds: registry.map(b => b.id) });
    if (result.outcome !== 'accepted') throw new Error('Validation failed.');
    const request = compileQueryPlan(result);
    expect(request.scopes.map(s => s.branchIds?.length)).toEqual([12, 12, 1]);
    const executed = await executeReadRequest(request, async scope => fakeEvidence(scope, registry), executive, readAt);
    expect(executed.outcome).toBe('accepted');
    if (executed.outcome === 'accepted') expect(executed.bundle.coverage).toMatchObject({ expected: 25, read: 25, complete: true });
  });
  it.each([
    ['duplicate row', 'incomplete_evidence', (e: Evidence) => { e.branches.push(e.branches[0]); }],
    ['source duplicate', 'incomplete_evidence', (e: Evidence) => { e.sources.push(e.sources[0]); }],
    ['source system mismatch', 'incomplete_evidence', (e: Evidence) => { e.sources[0].system = 'inventory'; }],
    ['stale source', 'data_unavailable', (e: Evidence) => { e.sources[0].freshness = 'stale'; }],
    ['future source', 'data_unavailable', (e: Evidence) => { e.sources[0].observedAt = '2027-01-01T00:00:00Z'; }],
    ['false freshness', 'data_unavailable', (e: Evidence) => { e.sources[0].observedAt = '2026-01-01T00:00:00Z'; }],
    ['non-finite measure', 'data_unavailable', (e: Evidence) => { e.branches[0].netSales = NaN; }],
    ['wrong business date', 'incomplete_evidence', (e: Evidence) => { e.scope = { ...e.scope, date: '2026-09-30' }; }],
  ] as const)('rejects %s without returning an evidence bundle', async (_name, outcome, mutate) => {
    const checked = accept(), result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope); mutate(evidence); return evidence;
    }, executive, readAt);
    expect(result.outcome).toBe(outcome); expect('bundle' in result).toBe(false);
  });
  it('omits a branch only when its requested source has no rows for that branch/date', async () => {
    const checked = accept();
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope);
      evidence.sources = evidence.sources.filter(source => source.id !== `sales:E01:${scope.date}`);
      evidence.branches[0].sourceIds = evidence.branches[0].sourceIds.filter(id => id !== `sales:E01:${scope.date}`);
      return evidence;
    }, executive, readAt);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.bundle.coverage).toMatchObject({ expected: 4, read: 3, complete: false,
        omittedReasons: ['Missing evidence for branch E01 on 2026-10-01.'] });
      expect(result.bundle.limitations).toContain('ไม่พบหลักฐานของสาขา First branch วันที่ 2026-10-01.');
      expect(buildClaimGraph(result.bundle).claims.map(claim => claim.dimensions.branch)).not.toContain('E01');
    }
  });
  it('a reader injecting a South row into a manager read is denied without protected output', async () => {
    const checked = accept(proposal(), 'Show sales', manager);
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope);
      evidence.branches.push(fakeEvidence({ region: 'south', date: scope.date }).branches[0]);
      return evidence;
    }, manager, readAt);
    expect(result.outcome).toBe('permission_denied');
    expect(JSON.stringify(result)).not.toContain('S01');
  });
  it('reauthorizes immediately before reads and never calls the reader for revoked authority', async () => {
    const reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(accept()), reader, { ...executive, active: false }, readAt);
    expect(result.outcome).toBe('permission_denied'); expect(reader).not.toHaveBeenCalled();
  });
  it('authority loader revocation during multi-region reads stops remaining reads and suppresses the bundle', async () => {
    let calls = 0;
    const authority = async () => ++calls === 1 ? executive : { ...executive, active: false, revision: 2 };
    const reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(accept()), reader, authority, readAt);
    expect(result.outcome).toBe('permission_denied'); expect(reader).toHaveBeenCalledTimes(1);
  });
  it('checks authority again after the last read before returning protected evidence', async () => {
    let calls = 0;
    const checked = accept(proposal(), 'Show sales', manager), reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(checked), reader, async () => ++calls === 1 ? manager : { ...manager, active: false }, readAt);
    expect(result.outcome).toBe('permission_denied'); expect(reader).toHaveBeenCalledTimes(1);
  });
  it('reader exceptions produce execution_failed with no source error leakage', async () => {
    const result = await executeReadRequest(compileQueryPlan(accept()), async () => { throw new Error('secret connection details'); }, executive, readAt);
    expect(result.outcome).toBe('execution_failed'); expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('registered claim computations and exact state', () => {
  it('aggregate/group use calculated gap and weighted achievement rather than summing percentages', async () => {
    const text = 'Show sales by region', plan = proposal(text);
    plan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'default', sourceText: span(text, 'region'), confidence: 1 } }];
    plan.group = { fieldIds: ['region'] };
    plan.measures = ['net_sales', 'target', 'gap', 'achievement'].map(fieldId => ({ fieldId,
      aggregation: fieldId === 'gap' ? 'gap' : fieldId === 'achievement' ? 'weighted_ratio' : 'sum',
      interpretation: { value: fieldId, source: 'explicit', sourceText: span(text, 'sales'), confidence: 1 } }));
    const result = await bundle(plan, text);
    const east = result.graph.claims.filter(c => c.dimensions.region === 'east');
    expect(Object.fromEntries(east.map(c => [c.measure, c.value]))).toEqual({ net_sales: 280, target: 300, gap: -20, achievement: 93.33 });
    const total = await bundle({ ...plan, group: { fieldIds: [] } }, text);
    expect(total.graph.claims.find(c => c.measure === 'net_sales')?.value).toBe(680);
    expect(total.graph.claims.find(c => c.measure === 'achievement')?.value).toBe(136);
  });
  it.each(['avg', 'latest', 'max'] as const)('uses explicit %s aggregation for multi-date snapshot measures', async aggregation => {
    const text = 'Show stock issues from 2026-09-30 through 2026-10-01', plan = proposal(text);
    plan.measures[0] = { fieldId: 'stock_issues', aggregation, interpretation: { value: 'stock_issues', source: 'explicit', sourceText: span(text, 'stock issues'), confidence: 1 } };
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(text, '2026-09-30 through 2026-10-01')).text, dates: dateList('2026-09-30', '2026-10-01', 366) };
    const accepted = accept(plan, text);
    const result = await executeReadRequest(compileQueryPlan(accepted), async scope => {
      const evidence = fakeEvidence(scope);
      evidence.branches.forEach(branch => { branch.stockIssues = scope.date === '2026-10-01' ? 4 : 2; });
      return evidence;
    }, executive, readAt);
    if (result.outcome !== 'accepted') throw new Error('Read failed.');
    const claim = buildClaimGraph(result.bundle).claims.find(item => item.measure === 'stock_issues');
    expect(claim?.value).toBe(aggregation === 'avg' ? 3 : 4);
    expect(claim?.computation.operation).toBe(aggregation);
  });
  it('branch detail claims carry only the selected branch evidence', async () => {
    const result = await bundle(filter(proposal(), 'Show sales', 'branch', 'E01'));
    expect(result.bundle.rows.map(r => r.branchId)).toEqual(['E01']);
    expect(result.graph.claims[0]).toMatchObject({ value: 200, dimensions: { branch: 'E01' }, rowRefs: ['row:E01:2026-10-01'] });
  });
  it('zero positive target yields a null weighted achievement claim, not a fabricated percentage', async () => {
    const plan = proposal(); plan.measures[0] = { ...plan.measures[0], fieldId: 'achievement', aggregation: 'weighted_ratio',
      interpretation: { ...plan.measures[0].interpretation, value: 'achievement' } };
    const checked = accept(plan), result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope);
      evidence.branches.forEach(row => { row.target = 0; row.achievement = null; });
      return evidence;
    }, executive, readAt);
    if (result.outcome !== 'accepted') throw new Error('Execution failed.');
    expect(buildClaimGraph(result.bundle).claims.every(claim => claim.value === null)).toBe(true);
  });
  it('null achievements cannot be assigned a highest or lowest rank', async () => {
    const plan = ranking('Top sales');
    plan.measures[0] = { ...plan.measures[0], fieldId: 'achievement', aggregation: 'weighted_ratio', interpretation: { ...plan.measures[0].interpretation, value: 'achievement' } };
    plan.sort[0].fieldId = 'achievement';
    const checked = accept(plan, 'Top sales'), result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope); evidence.branches.forEach(row => { row.target = 0; row.achievement = null; }); return evidence;
    }, executive, readAt);
    if (result.outcome !== 'accepted') throw new Error('Execution failed.');
    expect(() => buildClaimGraph(result.bundle)).toThrow(/Ranking metric unavailable/);
  });
  it.each(['highest', 'lowest'] as const)('complete %s top-N is deterministic and records the complete candidate population', async direction => {
    const result = await bundle(ranking('Top sales', 'net_sales', direction), 'Top sales');
    const rows = result.graph.claims.filter(c => c.computation.operation !== 'rank').map(c => c.dimensions.branch);
    expect(rows).toEqual(direction === 'highest' ? ['S01', 'E01'] : ['E02', 'C01']);
    expect(result.graph.populationRowRefs).toHaveLength(4);
    expect(result.graph.claims.filter(c => c.computation.operation === 'rank').every(c => c.rowRefs.length === 4)).toBe(true);
  });
  it('sales deficit ranking applies gap eligibility only after proving the full population', async () => {
    const plan = ranking('Deficit branches', 'gap', 'lowest');
    plan.filters = [{ fieldId: 'gap', op: 'lt', value: 0, sourceText: span('Deficit branches'), confidence: 1 }];
    const result = await bundle(plan, 'Deficit branches');
    expect(result.graph.claims.filter(c => c.computation.operation !== 'rank')).toHaveLength(1);
    expect(result.graph.claims[0]).toMatchObject({ value: -120, dimensions: { branch: 'E02' }, computation: { operation: 'gap', inputs: ['net_sales', 'target'] } });
    expect(result.bundle.coverage).toMatchObject({ expected: 4, read: 4, complete: true });
  });
  it('measure-filter dependencies are read even when only net sales is selected', async () => {
    const plan = proposal(); plan.filters = [{ fieldId: 'gap', op: 'lt', value: 0, sourceText: span('Show sales'), confidence: 1 }];
    const result = await bundle(plan);
    expect(result.graph.claims.map(c => c.dimensions.branch)).toEqual(['E02']);
  });
  it('prior-day comparison reads both dates and links baseline/difference claims to the exact rows', async () => {
    const plan = proposal(); plan.compare = { kind: 'vs_prior_day', period: null, baseline: null, sourceText: span('Show sales'), confidence: 1 };
    const result = await bundle(plan);
    expect(result.bundle.provenance.dates).toEqual(['2026-09-30', '2026-10-01']);
    const difference = result.graph.claims.find(c => c.dimensions.branch === 'E01' && c.computation.operation === 'difference');
    expect(difference).toMatchObject({ value: 0, rowRefs: ['row:E01:2026-10-01', 'row:E01:2026-09-30'] });
  });
  it('vs-target comparison records the registered target baseline and its source', async () => {
    const plan = proposal(); plan.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span('Show sales'), confidence: 1 };
    const result = await bundle(filter(plan, 'Show sales', 'branch', 'E02'));
    expect(result.graph.claims.find(c => c.dimensions.comparison === 'baseline')).toMatchObject({ measure: 'target', value: 200, computation: { inputs: ['target'] } });
    expect(result.graph.claims.find(c => c.computation.operation === 'difference')?.value).toBe(-120);
  });
  it('does not duplicate the target claim when target is already selected', async () => {
    const text = 'sales and target vs target', plan = proposal(text);
    plan.measures.push({ fieldId: 'target', aggregation: 'sum', interpretation: {
      value: 'target', source: 'explicit', sourceText: span(text, 'target'), confidence: 1,
    } });
    plan.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span(text, 'vs target'), confidence: 1 };
    const result = await bundle(plan, text);
    const targetClaims = result.graph.claims.filter(claim => claim.measure === 'target');
    expect(targetClaims).toHaveLength(result.accepted.scope.branchIds.length);
    expect(targetClaims.map(claim => claim.dimensions.branch).sort()).toEqual([...result.accepted.scope.branchIds].sort());
    expect(targetClaims.every(claim => claim.dimensions.comparison === undefined)).toBe(true);
  });
  it('prior-month comparison uses registered sum/avg multi-date grain', async () => {
    const text = 'Compare month', plan = filter(proposal(text), text, 'branch', 'E01');
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(text)).text, dates: dateList('2026-05-01', '2026-05-31', 366) };
    plan.multiDateGrain = { mode: 'sum', fieldId: 'date' };
    plan.compare = { kind: 'vs_prior_period', period: 'month', baseline: null, sourceText: span(text), confidence: 1 };
    const summed = await bundle(plan, text);
    expect(summed.accepted.baselineDates).toHaveLength(30);
    expect(summed.graph.claims.find(c => c.computation.operation === 'difference')?.value).toBe(200);
    const averaged = await bundle({ ...plan, multiDateGrain: { mode: 'avg', fieldId: 'date' } }, text);
    expect(averaged.graph.claims.find(c => c.computation.operation === 'difference')?.value).toBe(0);
  });
  it('exact conversation state supports follow-up intent refs and typed authority denial', async () => {
    const result = await bundle(proposal(), 'Show sales', manager);
    const prepared = prepareConversationState({ conversationId: 'conversation:1', turnId: 'turn:1', revision: 1,
      sourceText: { id: 'source:1', version: 1, digest: digest('Show sales') }, parentState: null,
      plan: result.accepted, bundle: result.bundle, claims: result.graph }, manager);
    if (prepared.outcome !== 'accepted') throw new Error('State failed.');
    expect(prepared.state.lastAcceptedPlan).toEqual({ id: 'plan:1', version: 1, digest: result.accepted.planDigest });
    expect(prepared.state.evidenceBundle.id).toBe(result.bundle.ref.id);
    expect(prepared.state.resolvedScope).toEqual({ regions: ['east'], branchIds: ['E01', 'E02'], dates: ['2026-10-01'] });
    expect(conversationStateSchema.safeParse({ ...prepared.state, lastScope: 'east' }).success).toBe(false);
    expect(Object.isFrozen(prepared.state.resolvedScope.branchIds)).toBe(true);
    const catalog = createSemanticCatalog(branches), input = buildPlannerInput(catalog, manager, 'follow-up', prepared.state);
    expect(input.previousState).toBe(prepared.state);
    expect(input.previousStateRef).toEqual(conversationStateRef(prepared.state));
    const followUp = await planQuery(input, async () => JSON.stringify({ ...proposal('follow-up sales'), intentKind: 'follow_up', parentState: conversationStateRef(prepared.state) }));
    expect(followUp).toMatchObject({ outcome: 'planned', intent: { intentKind: 'follow_up', parentState: conversationStateRef(prepared.state) } });
    const mismatched = await planQuery(input, async () => JSON.stringify({ ...proposal('follow-up sales'), intentKind: 'follow_up',
      parentState: { ...conversationStateRef(prepared.state), digest: '0'.repeat(64) } }));
    expect(mismatched).toMatchObject({ outcome: 'planned', intent: { parentState: conversationStateRef(prepared.state) } });
    const wrongInheritedScope = filter(proposal('follow-up south sales'), 'follow-up south sales', 'region', 'south', 'south');
    wrongInheritedScope.filters[0].source = 'inherited';
    wrongInheritedScope.filters[0].sourceText = null;
    expect(validateQueryPlan(wrongInheritedScope, catalog, manager, { ...available('follow-up south sales'),
      previousPlan: result.accepted.plan, previousDates: result.accepted.dates }))
      .toMatchObject({ outcome: 'clarification_required', code: 'inherited_filter_mismatch', clarification: { choices: [{ id: 'east', label: 'ภาคตะวันออก' }] } });
    const deniedInput = buildPlannerInput(catalog, { ...manager, regions: [] }, 'follow-up', prepared.state);
    const model = vi.fn(async () => 'should not run');
    expect(await planQuery(deniedInput, model)).toMatchObject({ outcome: 'permission_denied', code: 'previous_state_outside_authority' });
    expect(model).not.toHaveBeenCalled();
  });
  it('state preparation rejects forged numeric claims even if row refs exist', async () => {
    const result = await bundle();
    const forged = structuredClone(result.graph); forged.claims[0].value = 9999;
    const prepared = prepareConversationState({ conversationId: 'c:1', turnId: 't:1', revision: 1,
      sourceText: { id: 'source:1', version: 1, digest: digest('Show sales') }, parentState: null,
      plan: result.accepted, bundle: result.bundle, claims: forged }, executive);
    expect(prepared.outcome).toBe('semantic_uncertainty');
  });
  it('state preparation requires the digest of the exact source text used to validate the plan', async () => {
    const result = await bundle();
    const prepared = prepareConversationState({ conversationId: 'c:1', turnId: 't:1', revision: 1,
      sourceText: { id: 'source:1', version: 1, digest: digest('another request') }, parentState: null,
      plan: result.accepted, bundle: result.bundle, claims: result.graph }, executive);
    expect(prepared.outcome).toBe('semantic_uncertainty');
  });
});
