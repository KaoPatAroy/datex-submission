import { describe, expect, it } from 'vitest';
import { compileHrQuery, executeHrRead, hrSupportedChoices, validateHrQueryPlan, createWave2Catalog } from '../../../lib/dynamic/catalog/hr';
import { createPresentationClaims } from '../../../lib/dynamic/response/claims';
import { defaultResponsePlan, validateResponsePlan } from '../../../lib/dynamic/response/plan';
import { filter } from '../fixtures';
import { manager, admin, snapshot, catalog, now, hrPlan, headcountPlan, validate, execute, bundle, businessFixtures } from './fixtures';

describe('certified employee plan guards', () => {
  it('East Manager cannot read another region even with broad region metadata', () => {
    const text = 'Find South employees';
    const plan = filter(hrPlan(text), text, 'region', 'south', 'South');
    const result = validate(plan, text, { ...manager, regions: ['*'] });
    expect(result.outcome).toBe('permission_denied');
    expect(JSON.stringify(result)).not.toContain('EMP-S1');
  });
  it('scopes default requests, intersects branch restrictions, and removes private fields', () => {
    const data = bundle();
    expect(data.scope.branchIds).toEqual(['E01', 'E02']);
    expect(data.rows.map(r => r.values.employee_id)).toEqual(['EMP-E1', 'EMP-E2', 'EMP-E3']);
    expect(data.rows.every(row => Object.keys(row.values).sort().join(',') === 'active,branch,employee_id,employee_name')).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/salary|private-phone|South Secret|Global HR/);
    const limited = execute(hrPlan(), 'Find employee', { ...manager, branchIds: ['E02'] });
    expect(limited.outcome).toBe('accepted');
    if (limited.outcome === 'accepted') expect(limited.bundle.rows.map(r => r.values.employee_id)).toEqual(['EMP-E3']);
  });
  it('global employees require HR admin and explicit wildcard authority', () => {
    const result = execute(hrPlan(), 'Find employee', admin);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') expect(result.bundle.rows.some(r => r.values.employee_id === 'EMP-G1')).toBe(true);
    const scoped = execute(hrPlan(), 'Find employee', { ...admin, regions: ['east'] });
    expect(scoped.outcome).toBe('accepted');
    if (scoped.outcome === 'accepted') expect(scoped.bundle.scope.includeGlobal).toBe(false);
  });
  it('unknown scope never becomes all and choices disclose authorized regions only', () => {
    const text = 'Find coastal employees';
    expect(validate(filter(hrPlan(text), text, 'region', 'coastal', 'coastal'), text).outcome).toBe('unsupported_concept');
    expect(hrSupportedChoices(catalog, manager).map(c => c.id)).not.toContain('south');
    expect(hrSupportedChoices(catalog, { ...manager, permissions: [] })).toEqual([]);
    expect(validate(hrPlan(), 'Find employee', { ...manager, regions: [] }).outcome).toBe('permission_denied');
  });
  it.each([{ permissions: [] }, { active: false }])('requires active HR authority %j', change => {
    expect(validate(hrPlan(), 'Find employee', { ...manager, ...change }).outcome).toBe('permission_denied');
  });
  it.each(['salary', 'phone', 'leave_date', 'eval', 'sql'])('rejects unregistered field %s', fieldId => {
    const plan = hrPlan();
    plan.dimensions[0].fieldId = fieldId;
    plan.dimensions[0].interpretation.value = fieldId;
    expect(validate(plan).outcome).toBe('unsupported_concept');
  });
  it.each([{ sql: 'select *' }, { recipientIds: ['south_peer'] }, { html: '<script>' }, { join: 'employees' }])('strictly rejects model extensions %j', change => {
    expect(validateHrQueryPlan({ proposal: { ...hrPlan(), ...change }, actor: manager, catalog, sourceText: 'Find employee' }).outcome).toBe('semantic_uncertainty');
  });
  it('rejects unregistered aggregations, operators, sources and wrong spans', () => {
    const plan = hrPlan();
    expect(validate({ ...plan, measures: [{ ...plan.measures[0], aggregation: 'execute' }] }).outcome).toBe('unsupported_concept');
    expect(validate({ ...plan, completeness: { ...plan.completeness, requiredSourceIds: ['private_hr'] } }).outcome).toBe('unsupported_concept');
    const wrong = filter(plan, 'Find employee', 'employee_id', 'EMP-E1');
    expect(validate({ ...wrong, filters: [{ ...wrong.filters[0], op: 'gt' }] }).outcome).toBe('unsupported_concept');
    expect(validate({ ...wrong, filters: [{ ...wrong.filters[0], sourceText: { start: 0, end: 4, text: 'fake' } }] }).outcome).toBe('semantic_uncertainty');
  });
  it('lookup by name and ID never exposes out-of-scope identity existence', () => {
    const text = 'Find employee Ada';
    const result = execute(filter(hrPlan(text), text, 'employee_name', 'ada', 'Ada'), text);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') expect(result.bundle.rows.map(r => r.values.employee_id)).toEqual(['EMP-E1']);
    for (const id of ['EMP-S1', 'missing']) {
      const prompt = `Find employee ${id}`;
      const data = execute(filter(hrPlan(prompt), prompt, 'employee_id', id, id), prompt);
      expect(data.outcome).toBe('accepted');
      if (data.outcome === 'accepted') expect(data.bundle.rows).toEqual([]);
    }
  });
});

describe('HR snapshot compiler and evidence', () => {
  it('binds tokens to validation and rechecks permission/catalog versions', () => {
    const checked = validate();
    if (checked.outcome !== 'accepted') throw new Error('Fixture rejected');
    const request = compileHrQuery(checked);
    const input = { request, snapshot, freshAuthority: manager, currentCatalog: catalog, now };
    expect(executeHrRead({ ...input, request: structuredClone(request) }).outcome).toBe('execution_failed');
    expect(executeHrRead({ ...input, freshAuthority: { ...manager, revision: 2 } }).outcome).toBe('permission_denied');
    expect(executeHrRead({ ...input, currentCatalog: createWave2Catalog(catalog.branchCatalog.branches, 2) }).outcome).toBe('semantic_uncertainty');
    expect(() => compileHrQuery(structuredClone(checked))).toThrow();
  });
  it('rejects row/time budgets, missing and duplicate expected population', () => {
    expect(execute(hrPlan(), 'Find employee', manager, { ...snapshot, elapsedMs: 1001 }).outcome).toBe('execution_failed');
    expect(execute(hrPlan(), 'Find employee', manager, { ...snapshot, rows: Array(2001).fill(snapshot.rows[0]) }).outcome).toBe('execution_failed');
    expect(execute(hrPlan(), 'Find employee', manager, { ...snapshot, populations: [] }).outcome).toBe('incomplete_evidence');
    expect(execute(hrPlan(), 'Find employee', manager, { ...snapshot, populations: [...snapshot.populations, snapshot.populations[0]] }).outcome).toBe('incomplete_evidence');
    expect(execute(hrPlan(), 'Find employee', manager, { ...snapshot, rows: [...snapshot.rows, snapshot.rows[0]] }).outcome).toBe('incomplete_evidence');
  });
  it('missing employees never satisfy complete headcount or top-N', () => {
    const plan = headcountPlan();
    const partial = { ...snapshot, rows: snapshot.rows.slice(1) };
    expect(execute(plan, 'Headcount by East branch', manager, partial).outcome).toBe('incomplete_evidence');
    plan.completeness.requireFullPopulation = false;
    plan.completeness.minimumCoverage = 0;
    plan.topN = { count: 1, direction: 'highest', completeScopeRequired: true };
    expect(execute(plan, 'Headcount by East branch', manager, partial).outcome).toBe('incomplete_evidence');
  });
  it.each([null, '2026-10-04T05:00:00Z', '2026-10-07T05:00:00Z'])('missing/stale/misaligned source timestamp %s cannot be fabricated', observedAt => {
    const data = { ...snapshot, populations: snapshot.populations.map(p => ({ ...p, observedAt })) };
    expect(execute(hrPlan(), 'Find employee', manager, data).outcome).toBe('data_unavailable');
  });
  it('grounded headcount excludes inactive staff, retains row/source traces, and preserves history', () => {
    const data = bundle(headcountPlan(), 'Headcount by East branch'), claims = createPresentationClaims(data);
    expect(claims.claims.map(c => c.value)).toEqual([1, 1]);
    expect(claims.claims.every(c => c.rowRefs.length && c.sourceRefs.length && c.calculatorId === 'hr.active_headcount.v1')).toBe(true);
    expect(data.coverage).toEqual({ expected: 3, read: 3, matched: 3, complete: true });
    expect(Object.isFrozen(data.rows[0].values)).toBe(true);
    expect(data.rows.every(row => Object.keys(row.values).sort().join(',') === 'branch,headcount')).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/Ada|employee_name|EMP-E1/);
  });
  it('rejects response claim IDs that reorder a sorted claim graph', () => {
    const plan = headcountPlan();
    plan.sort = [{ fieldId: 'headcount', direction: 'desc' }];
    const claims = createPresentationClaims(bundle(plan, 'Headcount by East branch'));
    const response = defaultResponsePlan(claims);
    const facts = response.sections.find(section => section.kind === 'facts')!;
    expect(facts.claimIds).toHaveLength(2);
    expect(validateResponsePlan({ ...response, sections: response.sections.map(section => section.kind === 'facts'
      ? { ...section, claimIds: [...section.claimIds].reverse() } : section) }, claims).outcome).toBe('semantic_uncertainty');
  });
  it('headcount dimensions must match grouping and cannot request employee-name dimensions', () => {
    const plan = headcountPlan();
    plan.dimensions = [{ fieldId: 'employee_name', interpretation: { value: 'employee_name', source: 'explicit', sourceText: { start: 0, end: 9, text: 'Headcount' }, confidence: 1 } }];
    expect(validate(plan, 'Headcount by East branch').outcome).toBe('unsupported_concept');
  });
});

describe('fixture-driven Wave 2 business acceptance', () => {
  it.each(businessFixtures.filter(f => !f.kind.startsWith('sources')))('$prompt ($kind) returns $outcome with scoped evidence or supported choices', fixture => {
    let plan = fixture.kind === 'headcount' || fixture.kind === 'south' ? headcountPlan(fixture.prompt) : hrPlan(fixture.prompt);
    if (fixture.kind === 'leave') plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-10-07'], evidenceText: 'tomorrow' };
    if (fixture.kind === 'id') plan = filter(plan, fixture.prompt, 'employee_id', 'EMP-E1', 'EMP-E1');
    if (fixture.kind === 'name') plan = filter(plan, fixture.prompt, 'employee_name', 'Ada', 'Ada');
    if (fixture.kind === 'south') plan = filter(plan, fixture.prompt, 'region', 'south', 'South');
    const result = execute(plan, fixture.prompt);
    expect(result.outcome).toBe(fixture.outcome);
    if (result.outcome === 'accepted') {
      expect(result.bundle.scope.regions).toEqual(['east']);
      expect(createPresentationClaims(result.bundle).claims.every(c => c.sourceRefs.length && c.rowRefs.length)).toBe(true);
    } else if (fixture.kind === 'leave') {
      expect(result.clarification?.choices.map(c => c.id)).toContain('employee_id');
      expect(result.clarification?.choices.map(c => c.id)).not.toContain('south');
    }
  });
});
