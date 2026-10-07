import { dateList } from '../../lib/dynamic/plan/time';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { buildPlannerInput, parsePlannerJSON, planQuery } from '../../lib/dynamic/planner/planner';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { prepareConversationState } from '../../lib/dynamic/state/conversation';
import { revalidate, validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { digest } from '../../lib/dynamic/shared';
import { accept, available, branches, catalog, executive, fakeEvidence, fakePlanner, filter, manager, proposal, ranking, readAt, span } from './fixtures';

// Exact fixture phrases are permitted only in the local scripted provider. Its
// non-production/provider guards and real validation path are pinned behaviorally
// in scripted-planner.test.ts; every other dynamic module retains these guards.
const scriptedFixturePath = join(process.cwd(), 'lib/dynamic/planner/scripted.ts');
const catalogSeedPath = join(process.cwd(), 'lib/dynamic/catalog/seed.ts');

describe('Track B architecture acceptance', () => {
  const paraphrases = ['east-side stores', 'branches in the east', 'โซนตะวันออก'];
  it.each(paraphrases)('AI maps %s to canonical East without server language rules', async text => {
    const plan = filter(proposal(text), text, 'region', 'east');
    const parsed = await planQuery(buildPlannerInput(catalog, executive, text), fakePlanner(new Map([[text, plan]])));
    expect(parsed.outcome).toBe('planned');
    if (parsed.outcome !== 'planned') throw new Error('Planner failed.');
    const checked = validateQueryPlan(parsed.plan, catalog, executive, available(text));
    expect(checked.outcome).toBe('accepted');
    if (checked.outcome !== 'accepted') throw new Error('Validation failed.');
    const reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(checked), reader, executive, readAt);
    expect(result.outcome).toBe('accepted');
    expect(reader.mock.calls.every(([scope]) => scope.region === 'east')).toBe(true);
    if (result.outcome === 'accepted') expect(result.bundle.rows.map(r => r.branchId)).toEqual(['E01', 'E02']);
  });
  it('contains no server synonym or acceptance phrase lists in dynamic TypeScript', () => {
    function sources(path: string): string[] {
      return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(path, entry.name)) :
        entry.name.endsWith('.ts') && entry.name !== 'semantic.ts' && join(path, entry.name) !== catalogSeedPath
          && join(path, entry.name) !== scriptedFixturePath ? [readFileSync(join(path, entry.name), 'utf8')] : []);
    }
    const source = sources(join(process.cwd(), 'lib/dynamic')).join('\n');
    for (const phrase of [...paraphrases, 'eastern', 'ตะวันออก']) expect(source.toLowerCase()).not.toContain(phrase.toLowerCase());
  });
  it('contains no region or month phrase rules outside canonical catalog data and zod enums', () => {
    const forbidden = /(?:\b(?:east|west|north|south|central|january|february|march|april|may|june|july|august|september|october|november|december)\b|ตะวันออก|ตะวันตก|เหนือ|ใต้|กลาง|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/iu;
    function files(path: string): string[] {
      return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) :
        entry.name.endsWith('.ts') ? [join(path, entry.name)] : []);
    }
    for (const file of files(join(process.cwd(), 'lib/dynamic'))) {
      if (file === scriptedFixturePath || file === catalogSeedPath) continue;

      const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isRegularExpressionLiteral(node)) expect(forbidden.test(node.text), `${file}: regex ${node.text}`).toBe(false);
        if (ts.isArrayLiteralExpression(node)) {
          const parent = node.parent;
          const canonicalEnum = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
            parent.expression.name.text === 'enum' && parent.expression.expression.getText(sourceFile) === 'z';
          if (!canonicalEnum) for (const element of node.elements) {
            if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
              expect(forbidden.test(element.text), `${file}: string array value ${element.text}`).toBe(false);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  });
  it('scans dynamic regexes and string arrays for Thai region and month words', () => {
    const thaiWords = [
      [0x0e15, 0x0e30, 0x0e27, 0x0e31, 0x0e19, 0x0e2d, 0x0e2d, 0x0e01], [0x0e15, 0x0e30, 0x0e27, 0x0e31, 0x0e19, 0x0e15, 0x0e01],
      [0x0e40, 0x0e2b, 0x0e19, 0x0e37, 0x0e2d], [0x0e43, 0x0e15, 0x0e49], [0x0e01, 0x0e25, 0x0e32, 0x0e07],
      [0x0e21, 0x0e01, 0x0e23, 0x0e32, 0x0e04, 0x0e21], [0x0e01, 0x0e38, 0x0e21, 0x0e20, 0x0e32, 0x0e1e, 0x0e31, 0x0e19, 0x0e18, 0x0e4c],
      [0x0e21, 0x0e35, 0x0e19, 0x0e32, 0x0e04, 0x0e21], [0x0e40, 0x0e21, 0x0e29, 0x0e32, 0x0e22, 0x0e19],
      [0x0e1e, 0x0e24, 0x0e29, 0x0e20, 0x0e32, 0x0e04, 0x0e21], [0x0e21, 0x0e34, 0x0e16, 0x0e38, 0x0e19, 0x0e32, 0x0e22, 0x0e19],
      [0x0e01, 0x0e23, 0x0e01, 0x0e0e, 0x0e32, 0x0e04, 0x0e21], [0x0e2a, 0x0e34, 0x0e07, 0x0e2b, 0x0e32, 0x0e04, 0x0e21],
      [0x0e01, 0x0e31, 0x0e19, 0x0e22, 0x0e32, 0x0e22, 0x0e19], [0x0e15, 0x0e38, 0x0e25, 0x0e32, 0x0e04, 0x0e21],
      [0x0e1e, 0x0e24, 0x0e28, 0x0e08, 0x0e34, 0x0e01, 0x0e32, 0x0e22, 0x0e19], [0x0e18, 0x0e31, 0x0e19, 0x0e27, 0x0e32, 0x0e04, 0x0e21],
    ].map(codes => codes.map(code => String.fromCodePoint(code)).join(''));
    const forbidden = new RegExp(`(?:${thaiWords.join('|')})`, 'iu');
    function files(path: string): string[] {
      return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) :
        entry.name.endsWith('.ts') ? [join(path, entry.name)] : []);
    }
    for (const file of files(join(process.cwd(), 'lib/dynamic'))) {
      if (file === scriptedFixturePath || file === catalogSeedPath) continue;

      const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isRegularExpressionLiteral(node)) expect(forbidden.test(node.text), `${file}: ${node.text}`).toBe(false);
        if (ts.isArrayLiteralExpression(node)) {
          const parent = node.parent;
          const canonicalEnum = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
            parent.expression.name.text === 'enum' && parent.expression.expression.getText(sourceFile) === 'z';
          if (!canonicalEnum) for (const element of node.elements) {
            if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) expect(forbidden.test(element.text), `${file}: ${element.text}`).toBe(false);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  });
  it('May I see E01 sales? has no time filter and gets a labeled default business date', async () => {
    const text = 'May I see E01 sales?', plan = filter(proposal(text), text, 'branch', 'E01', 'E01');
    const parsed = await planQuery(buildPlannerInput(catalog, executive, text), fakePlanner(new Map([[text, plan]])));
    if (parsed.outcome !== 'planned') throw new Error('Planner failed.');
    const checked = accept(parsed.plan, text);
    expect(checked.plan.time).toMatchObject({ source: 'default', dates: ['2026-10-01'] });
    expect(checked.interpretationLabels).toContain('วันที่ธุรกิจ (ค่าเริ่มต้น): 2026-10-01');
    expect(compileQueryPlan(checked).dates).toEqual(['2026-10-01']);
  });
  it('Show E01 sales for May 2026 compiles a structured month into its entire date range', async () => {
    const text = 'Show E01 sales for May 2026', plan = filter(proposal(text), text, 'branch', 'E01', 'E01');
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(text, 'May 2026')).text, dates: dateList('2026-05-01', '2026-05-31', 366) };
    const parsed = await planQuery(buildPlannerInput(catalog, executive, text), fakePlanner(new Map([[text, plan]])));
    if (parsed.outcome !== 'planned') throw new Error('Planner failed.');
    const request = compileQueryPlan(accept(parsed.plan, text));
    expect(request.dateRange).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(request.dates).toHaveLength(31);
    const result = await executeReadRequest(request, async scope => fakeEvidence(scope), executive, readAt);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') expect(buildClaimGraph(result.bundle).claims[0].value).toBe(200 * 31);
  });
  it('reader dateRange includes prior-period baseline dates', () => {
    const text = 'Compare sales for May 2026 to prior month', plan = proposal(text);
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(text, 'May 2026')).text, dates: dateList('2026-05-01', '2026-05-31', 366) };
    plan.compare = { kind: 'vs_prior_period', period: 'month', baseline: null, sourceText: span(text, 'prior month'), confidence: 1 };
    plan.multiDateGrain = { fieldId: 'date', mode: 'sum' };
    expect(compileQueryPlan(accept(plan, text)).dateRange).toEqual({ start: '2026-04-01', end: '2026-05-31' });
  });
  it('executive East request reads only East, including explicit region and branch IDs', async () => {
    const text = 'East sales', checked = accept(filter(proposal(text), text, 'region', 'east', 'East'), text);
    const reader = vi.fn(async scope => fakeEvidence(scope));
    await executeReadRequest(compileQueryPlan(checked), reader, executive, readAt);
    expect(reader).toHaveBeenCalledExactlyOnceWith({ region: 'east', date: '2026-10-01', branchIds: ['E01', 'E02'] });
  });
  it('explicit all for a limited actor labels the authorized population and caveats top-N claims', async () => {
    const text = 'All top sales', plan = ranking(text);
    plan.scope = { kind: 'all', sourceText: span(text, 'All'), confidence: 1 };
    const checked = accept(plan, text, manager);
    const caveat = 'จำกัดขอบเขตตามสิทธิ์ของคุณ: ภาคตะวันออก';
    expect(checked.interpretationLabels).toContain(caveat);
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => fakeEvidence(scope), manager, readAt);
    if (result.outcome !== 'accepted') throw new Error('Read failed.');
    expect(result.bundle.limitations).toContain(caveat);
    expect(buildClaimGraph(result.bundle).claims.filter(claim => claim.computation.operation === 'rank').every(claim => claim.caveat === caveat)).toBe(true);
  });
  it('partial branch/date availability is accepted for ordinary queries and listed in coverage', async () => {
    const base = available();
    const partial = { ...base, branchDates: base.branchIds.flatMap(branchId => base.dates.filter(date => !(branchId === 'E01' && date === '2026-10-01')).map(date => ({ branchId, date }))) };
    const checked = accept(proposal(), 'Show sales', executive, partial);
    const reader = vi.fn(async scope => fakeEvidence(scope));
    const result = await executeReadRequest(compileQueryPlan(checked), reader, executive, readAt);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.bundle.coverage).toEqual({ expected: 4, read: 3, complete: false, omittedReasons: ['Missing evidence for branch E01 on 2026-10-01.'] });
      expect(result.bundle.limitations).toContain('ไม่พบหลักฐานของสาขา First branch วันที่ 2026-10-01.');
      expect(reader.mock.calls.every(([scope]) => scope.branchIds?.every((id: string) => id !== 'E01'))).toBe(true);
    }
  });
  it('assigns equal rank to ties and names ties split by the top-N boundary', async () => {
    const plan = ranking('Top branches by sales');
    plan.topN = { ...plan.topN!, count: 3 };
    const checked = accept(plan, 'Top branches by sales');
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope);
      for (const branch of evidence.branches) if (branch.branchId !== 'S01') branch.netSales = 100;
      return evidence;
    }, executive, readAt);
    if (result.outcome !== 'accepted') throw new Error('Read failed.');
    const graph = buildClaimGraph(result.bundle);
    const ranks = graph.claims.filter(claim => claim.computation.operation === 'rank');
    expect(ranks.filter(claim => claim.value === 2)).toHaveLength(2);
    expect(graph.limitations).toContain('อันดับต้นมีสาขาคะแนนเท่ากันที่ขอบเขตการแสดงผล: C01, E01, E02.');
  });
  it('East manager South request is denied and never invokes the reader', async () => {
    const text = 'South sales', plan = filter(proposal(text), text, 'region', 'south', 'South');
    const parsed = await planQuery(buildPlannerInput(catalog, manager, text), fakePlanner(new Map([[text, plan]])));
    if (parsed.outcome !== 'planned') throw new Error('Planner failed.');
    const result = validateQueryPlan(parsed.plan, catalog, manager, available(text));
    const reader = vi.fn(async scope => fakeEvidence(scope));
    if (result.outcome === 'accepted') await executeReadRequest(compileQueryPlan(result), reader, manager, readAt);
    expect(result.outcome).toBe('permission_denied');
    expect(reader).not.toHaveBeenCalled();
    expect('plan' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('S01');
  });
  it('unresolved explicit scope never becomes all or the manager default', () => {
    const text = 'coastal branches', plan = filter(proposal(text), text, 'region', null);
    for (const authority of [executive, manager]) {
      const result = validateQueryPlan(plan, catalog, authority, available(text));
      expect(result.outcome).toBe('clarification_required');
      expect('scope' in result).toBe(false);
      if (result.outcome === 'clarification_required' && authority === manager) expect(result.clarification?.choices).toEqual([{ id: 'east', label: 'ภาคตะวันออก' }]);
    }
  });
  it('subset evidence for a ranking returns incomplete_evidence and carries no bundle', async () => {
    const checked = accept(ranking(), 'Top sales');
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => {
      const evidence = fakeEvidence(scope);
      evidence.branches = evidence.branches.slice(0, 1);
      return evidence;
    }, executive, readAt);
    expect(result).toMatchObject({ outcome: 'incomplete_evidence', code: 'population_incomplete' });
    expect('bundle' in result).toBe(false);
  });
  it('unsupported weather dimension never maps to a supported dimension', () => {
    const text = 'by weather', plan = proposal(text);
    plan.dimensions[0] = { fieldId: 'weather', interpretation: { value: 'weather', source: 'explicit', sourceText: span(text), confidence: 1 } };
    expect(validateQueryPlan(plan, catalog, executive, available(text)).outcome).toBe('unsupported_concept');
  });
  it('every numeric claim references existing authorized evidence rows and registered source origins', async () => {
    const checked = accept(ranking('Top sales'), 'Top sales', manager);
    const result = await executeReadRequest(compileQueryPlan(checked), async scope => fakeEvidence(scope), manager, readAt);
    if (result.outcome !== 'accepted') throw new Error('Read failed.');
    const graph = buildClaimGraph(result.bundle);
    expect(graph.claims.filter(claim => claim.computation.operation === 'rank').every(claim => claim.caveat === 'จำกัดขอบเขตตามสิทธิ์ของคุณ: ภาคตะวันออก')).toBe(true);
    expect(graph.claims.length).toBeGreaterThan(0);
    for (const claim of graph.claims) {
      expect(claim.rowRefs.length).toBeGreaterThan(0);
      expect(claim.sourceRefs.length).toBeGreaterThan(0);
      for (const id of claim.rowRefs) {
        const row = result.bundle.rows.find(r => r.rowId === id);
        expect(row?.region).toBe('east');
      }
      expect(claim.sourceRefs.every(id => result.bundle.sources.some(s => s.id === id))).toBe(true);
      expect(claim.computation.calculatorId).toMatch(/\.v1$/);
    }
    expect(graph.claims.find(c => c.computation.operation === 'rank')?.rowRefs).toHaveLength(2);
  });
  it('authority revoked between validation and persistence blocks both revalidation and exact-state preparation', async () => {
    const checked = accept(), result = await executeReadRequest(compileQueryPlan(checked), async scope => fakeEvidence(scope), executive, readAt);
    if (result.outcome !== 'accepted') throw new Error('Read failed.');
    const revoked = { ...executive, active: false, revision: 2 };
    expect(revalidate(checked, revoked).outcome).toBe('permission_denied');
    const state = prepareConversationState({ conversationId: 'c:1', turnId: 't:1', revision: 1, sourceText: { id: 'source:1', version: 1, digest: digest('Show sales') },
      parentState: null, plan: checked, bundle: result.bundle, claims: buildClaimGraph(result.bundle) }, revoked);
    expect(state.outcome).toBe('permission_denied');
    expect('state' in state).toBe(false);
  });
  it('raw text outside source spans cannot change validation, including the word may', () => {
    const plan = proposal('sales');
    const a = validateQueryPlan(plan, catalog, executive, available('sales please'));
    const b = validateQueryPlan(plan, catalog, executive, available('sales may May MAY'));
    expect(a.outcome).toBe('accepted');
    expect(b).toEqual(a);
  });
  it.each(['not json', '{"planVersion":1}', '{"planVersion":2}', 'null'])('malformed model JSON %s yields semantic_uncertainty', output => {
    expect(parsePlannerJSON(output).outcome).toBe('semantic_uncertainty');
  });
  it('constructs actor-scoped model context without protected canonical values', () => {
    const input = buildPlannerInput(catalog, manager, 'sales');
    expect(input.prompt).toContain('E01');
    expect(input.prompt).not.toContain('S01');
    expect(input.prompt).toContain('south');
    expect((input.jsonSchema.anyOf as Record<string, unknown>[])[0].additionalProperties).toBe(false);
    expect(((input.jsonSchema.anyOf as Record<string, unknown>[])[0].properties as Record<string, { enum: string[] }>).datasetId.enum).toEqual(['branch_performance']);
    expect(branches).toHaveLength(4);
  });
});
