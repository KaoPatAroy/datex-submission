import { dateList } from '../../lib/dynamic/plan/time';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { discoverPhysicalCatalog } from '../../lib/dynamic/catalog/physical';
import { createSemanticCatalog, trustPolicy } from '../../lib/dynamic/catalog/semantic';
import { intentPlanSchema, queryPlanSchema } from '../../lib/dynamic/plan/schemas';
import { resolveTime } from '../../lib/dynamic/plan/time';
import { buildPlannerInput, parsePlannerJSON } from '../../lib/dynamic/planner/planner';
import { validateQueryPlan, revalidate } from '../../lib/dynamic/validate/query-plan';
import { digest } from '../../lib/dynamic/shared';
import { accept, available, branches, catalog, executive, filter, manager, proposal, ranking, span } from './fixtures';

describe('physical and semantic catalogs', () => {
  it('keeps Thai display names and units on measure metadata', () => {
    expect(catalog.datasets[0].fields.filter(field => field.kind === 'measure')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'net_sales', displayLabel: 'ยอดขายสุทธิ', displayUnit: 'บาท' }),
      expect.objectContaining({ id: 'target', displayLabel: 'เป้าหมาย', displayUnit: 'บาท' }),
      expect.objectContaining({ id: 'gap', displayLabel: 'ส่วนต่างจากเป้า', displayUnit: 'บาท' }),
      expect.objectContaining({ id: 'stock_issues', displayLabel: 'สต็อกต่ำกว่าขั้นต่ำ', displayUnit: 'รายการ' }),
      expect.objectContaining({ id: 'incident_count', displayLabel: 'Incident ที่ยังไม่ปิด', displayUnit: 'รายการ' }),
    ]));
  });
  it('discovers a new SQLite column without edits, including nested SQL type/check commas', () => {
    const original = 'CREATE TABLE branches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);';
    const extended = 'CREATE TABLE branches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, margin DECIMAL(10,2) CHECK (margin IN (1,2)));';
    const before = discoverPhysicalCatalog(original), after = discoverPhysicalCatalog(extended);
    expect(before.fields.map(f => f.path)).toEqual(['id', 'payload']);
    expect(after.fields.map(f => f.path)).toEqual(['id', 'payload', 'margin']);
    expect(after.fields.at(-1)).toMatchObject({ trust: 'verified_physical', sensitivity: 'restricted', queryable: false });
    expect(after.digest).not.toBe(before.digest);
  });
  it('discovers provided column lists and never infers business permission', () => {
    const discovered = discoverPhysicalCatalog([{ table: 'branches', name: 'id', type: 'text', nullable: false, primaryKey: true },
      { table: 'branches', name: 'new_field', type: 'integer' }]);
    expect(discovered.fields[0]).toMatchObject({ keyRole: 'primary', nullable: false });
    expect(discovered.fields[1]).toMatchObject({ path: 'new_field', nullable: 'unknown', sensitivity: 'restricted', queryable: false });
    expect(() => discoverPhysicalCatalog([{ table: 'b', name: 'id', type: 'text' }, { table: 'b', name: 'id', type: 'text' }])).toThrow(/Duplicate/);
  });
  it('derives canonical region data from rows and includes a new region without phrase changes', () => {
    const registry = createSemanticCatalog([...branches, { id: 'X01', name: 'Additional branch', region: 'new_region' }]);
    expect(registry.datasets[0].fields.find(f => f.id === 'region')?.canonicalValues?.map(v => v.id)).toContain('new_region');
    expect(() => createSemanticCatalog([...branches, branches[0]])).toThrow(/unique/);
    expect(Object.isFrozen(registry.datasets[0].fields)).toBe(true);
  });
  it('registers measures as additive or snapshot and binds target comparisons in catalog metadata', () => {
    const dataset = catalog.datasets[0];
    expect(dataset.fields.find(f => f.id === 'net_sales')).toMatchObject({ additivity: 'additive', targetFieldId: 'target' });
    for (const id of ['stock_issues', 'staffing_actual', 'staffing_planned', 'incident_count']) {
      expect(dataset.fields.find(f => f.id === id)).toMatchObject({ additivity: 'snapshot' });
    }
  });
  it.each(['verified_physical', 'inferred'] as const)('%s allows bounded non-sensitive exploration with an interpretation label', trust => {
    expect(trustPolicy(trust, 'internal', ['explore'])).toMatchObject({ allowed: true, label: expect.any(String) });
    const updated = structuredClone(catalog);
    updated.datasets[0].fields.find(f => f.id === 'net_sales')!.trust = trust;
    const plan = proposal(); plan.requestedUses = ['explore'];
    const checked = validateQueryPlan(plan, updated, executive, available());
    expect(checked.outcome).toBe('accepted');
    if (checked.outcome === 'accepted') expect(checked.interpretationLabels.some(label => /interpretation/i.test(label))).toBe(true);
  });
  it.each(['confidential', 'personal', 'restricted'] as const)('blocks sensitive inferred %s even when authorized', sensitivity => {
    const updated = structuredClone(catalog);
    const field = updated.datasets[0].fields.find(f => f.id === 'net_sales')!;
    field.trust = 'inferred'; field.sensitivity = sensitivity;
    const plan = proposal(); plan.requestedUses = ['explore'];
    expect(validateQueryPlan(plan, updated, executive, available()).outcome).toBe('semantic_uncertainty');
    expect(trustPolicy('inferred', sensitivity, ['explore']).allowed).toBe(false);
  });
  it('provisional metrics cannot become authoritative answers, and unknown trust is unsupported', () => {
    expect(trustPolicy('verified_physical', 'internal', ['answer']).allowed).toBe(false);
    expect(trustPolicy('inferred', 'internal', ['artifact']).allowed).toBe(false);
    const updated = structuredClone(catalog);
    updated.datasets[0].fields.find(f => f.id === 'net_sales')!.trust = 'unknown';
    expect(validateQueryPlan(proposal(), updated, executive, available()).outcome).toBe('unsupported_concept');
  });
});

describe('strict versioned contracts and validation', () => {
  it('round-trips QueryPlan and IntentPlan without widening the contract', () => {
    const plan = proposal();
    expect(queryPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const intent = { ...plan, intentKind: 'query', parentState: null };
    expect(intentPlanSchema.parse(intent)).toEqual(intent);
    expect(parsePlannerJSON(intent)).toMatchObject({ outcome: 'planned', intent: { intentKind: 'query', parentState: null }, plan });
    expect(queryPlanSchema.safeParse(intent).success).toBe(false);
    expect(intentPlanSchema.safeParse({ ...intent, expression: 'arbitrary' }).success).toBe(false);
    expect(digest(z.toJSONSchema(queryPlanSchema, { target: 'draft-7', unrepresentable: 'any' }))).toMatchInlineSnapshot(`"f36008d5d0566560e6a0851a09abf3b29abfcf4c33d8da05efd41ef3a7b01495"`);
  });
  it('attaches date availability to invalid_model_plan only when the time element itself failed', () => {
    const badMeasure = proposal(); badMeasure.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-05-01'] };
    Object.assign(badMeasure.measures[0], { formula: '1 + 1' });
    const generic = parsePlannerJSON({ ...badMeasure, intentKind: 'query', parentState: null });
    expect(generic).toMatchObject({ outcome: 'semantic_uncertainty', code: 'invalid_model_plan' });
    expect(generic).not.toHaveProperty('dateAvailability');
    const badTime = proposal(); badTime.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-05-01', 'not-a-date'] } as never;
    expect(parsePlannerJSON({ ...badTime, intentKind: 'query', parentState: null }))
      .toMatchObject({ code: 'invalid_model_plan', dateAvailability: { requestedDates: ['2026-05-01'] } });
  });
  it.each([
    (p: ReturnType<typeof proposal>) => Object.assign(p, { sql: 'select anything' }),
    (p: ReturnType<typeof proposal>) => Object.assign(p.measures[0], { formula: '1 + 1' }),
    (p: ReturnType<typeof proposal>) => Object.assign(p.measures[0].interpretation, { synonym: 'sales' }),
    (p: ReturnType<typeof proposal>) => Object.assign(p.group, { code: '() => 1' }),
    (p: ReturnType<typeof proposal>) => Object.assign(p.completeness, { allowPartial: true }),
  ])('rejects extra execution keys at every nested boundary %#', mutate => {
    const plan = proposal(); mutate(plan);
    expect(parsePlannerJSON(plan).outcome).toBe('semantic_uncertainty');
  });
  it.each([
    (p: ReturnType<typeof proposal>) => { p.datasetId = 'nonexistent'; },
    (p: ReturnType<typeof proposal>) => { p.measures[0].fieldId = 'rma_total'; },
    (p: ReturnType<typeof proposal>) => { p.measures[0].aggregation = 'unregistered'; },
    (p: ReturnType<typeof proposal>) => { p.grain = ['weather']; },
    (p: ReturnType<typeof proposal>) => { p.sort = [{ fieldId: 'weather', direction: 'asc' }]; },
  ])('unknown catalog concept stays unsupported %#', mutate => {
    const plan = proposal(); mutate(plan);
    expect(validateQueryPlan(plan, catalog, executive, available()).outcome).toBe('unsupported_concept');
  });
  it('unsupported canonical value is neither another region nor an empty success', () => {
    expect(validateQueryPlan(filter(proposal(), 'Show sales', 'region', 'coastal'), catalog, executive, available()).outcome).toBe('unsupported_concept');
  });
  it('absent scope labels the authorized default regions and explicit all stays bounded to authority', () => {
    const plan = proposal(), defaultScope = accept(plan, 'Show sales', manager);
    expect(defaultScope.scope).toEqual({ regions: ['east'], branchIds: ['E01', 'E02'], source: 'default' });
    expect(defaultScope.interpretationLabels).toContain('ขอบเขตเริ่มต้น: ภูมิภาคที่ได้รับอนุญาต ภาคตะวันออก');
    expect(defaultScope.interpretationLabels).toContain('จำกัดขอบเขตตามสิทธิ์ของคุณ: ภาคตะวันออก');
    const executiveDefault = accept(proposal(), 'Show sales', executive);
    expect(executiveDefault.interpretationLabels).toContain('ขอบเขตเริ่มต้น: ภูมิภาคที่ได้รับอนุญาต ภาคกลาง, ภาคตะวันออก, ภาคใต้');
    const text = 'All sales', explicit = proposal(text);
    explicit.scope = { kind: 'all', sourceText: span(text, 'All'), confidence: 1 };
    const checked = accept(explicit, text, manager);
    expect(checked.scope.regions).toEqual(['east']);
    expect(checked.scope.source).toBe('explicit');
    expect(checked.interpretationLabels.some(label => label.startsWith('ขอบเขตเริ่มต้น:'))).toBe(false);
  });
  it('asks for a source span when a default dimension is not registered', () => {
    const text = 'Show sales by region', plan = proposal(text);
    plan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'default', sourceText: null, confidence: 1 } }];
    plan.group = { fieldIds: ['region'] };
    expect(validateQueryPlan(plan, catalog, executive, available(text))).toMatchObject({ outcome: 'clarification_required', code: 'unregistered_default_dimension' });
    plan.dimensions[0].interpretation.sourceText = span(text, 'region');
    expect(validateQueryPlan(plan, catalog, executive, available(text)).outcome).toBe('accepted');
  });
  it('requires an explicit supported aggregation for multi-date snapshots', () => {
    const text = 'Show stock issues from 2026-09-30 through 2026-10-01', plan = proposal(text);
    plan.measures[0] = { fieldId: 'stock_issues', aggregation: 'sum', interpretation: { value: 'stock_issues', source: 'explicit', sourceText: span(text, 'stock issues'), confidence: 1 } };
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(text, '2026-09-30 through 2026-10-01')).text, dates: dateList('2026-09-30', '2026-10-01', 366) };
    const clarification = validateQueryPlan(plan, catalog, executive, available(text));
    expect(clarification).toMatchObject({ outcome: 'clarification_required', code: 'snapshot_aggregation_required', clarification: { slotId: 'snapshot_aggregation' } });
    if (clarification.outcome === 'clarification_required') expect(clarification.clarification?.choices.map(choice => choice.id)).toEqual(['avg', 'latest', 'max']);
    plan.measures[0].aggregation = 'avg';
    expect(validateQueryPlan(plan, catalog, executive, available(text)).outcome).toBe('accepted');
    const filteredSnapshot = proposal(text);
    filteredSnapshot.time = plan.time;
    filteredSnapshot.filters = [{ fieldId: 'stock_issues', op: 'gt', value: 1, sourceText: span(text, 'stock issues'), confidence: 1 }];
    expect(validateQueryPlan(filteredSnapshot, catalog, executive, available(text)).outcome).toBe('clarification_required');
    filteredSnapshot.multiDateGrain = { fieldId: 'date', mode: 'avg' };
    expect(validateQueryPlan(filteredSnapshot, catalog, executive, available(text)).outcome).toBe('accepted');
  });
  it('caps source spans and rejects a whole-prompt span that is too broad', () => {
    const longPrompt = 'Show the daily net sales for every branch across the entire requested period';
    const broad = proposal(longPrompt);
    broad.measures[0].interpretation.sourceText = span(longPrompt);
    expect(validateQueryPlan(broad, catalog, executive, available(longPrompt))).toMatchObject({ outcome: 'semantic_uncertainty', code: 'invalid_source_span' });
    const oversized = proposal();
    oversized.measures[0].interpretation.sourceText = { start: 0, end: 201, text: 'a'.repeat(201) };
    expect(queryPlanSchema.safeParse(oversized).success).toBe(false);
  });
  it('clarifies unsupported target comparisons and defaults prior-period grain from time kind', () => {
    const unsupported = proposal();
    unsupported.measures[0] = { ...unsupported.measures[0], fieldId: 'stock_issues', aggregation: 'sum', interpretation: { ...unsupported.measures[0].interpretation, value: 'stock_issues' } };
    unsupported.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span('Show sales'), confidence: 1 };
    expect(validateQueryPlan(unsupported, catalog, executive, available())).toMatchObject({ outcome: 'clarification_required', code: 'target_comparison_unavailable' });

    const daily = proposal();
    daily.compare = { kind: 'vs_prior_period', period: null, baseline: null, sourceText: span('Show sales'), confidence: 1 };
    const acceptedDaily = validateQueryPlan(daily, catalog, executive, available());
    expect(acceptedDaily.outcome).toBe('accepted');
    if (acceptedDaily.outcome === 'accepted') {
      expect(acceptedDaily.plan.compare?.period).toBe('day');
      expect(acceptedDaily.plan.multiDateGrain).toEqual({ fieldId: 'date', mode: 'sum' });
      expect(acceptedDaily.baselineDates).toEqual(['2026-09-30']);
      expect(acceptedDaily.interpretationLabels).toContain('Default comparison grain: day');
    }
    const monthText = 'Compare sales for May 2026', monthly = proposal(monthText);
    monthly.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(monthText, 'May 2026')).text, dates: dateList('2026-05-01', '2026-05-31', 366) };
    monthly.compare = { kind: 'vs_prior_period', period: null, baseline: null, sourceText: span(monthText, 'Compare'), confidence: 1 };
    const acceptedMonth = validateQueryPlan(monthly, catalog, executive, available(monthText));
    expect(acceptedMonth.outcome).toBe('accepted');
    if (acceptedMonth.outcome === 'accepted') {
      expect(acceptedMonth.plan.compare?.period).toBe('month');
      expect(acceptedMonth.plan.multiDateGrain).toEqual({ fieldId: 'date', mode: 'sum' });
      expect(acceptedMonth.baselineDates).toHaveLength(30);
      expect(acceptedMonth.interpretationLabels).toContain('Default comparison grain: month');
    }
  });
  it('rejects invalid spans and forged defaults without language interpretation', () => {
    const invalid = proposal(); invalid.measures[0].interpretation.sourceText!.start++;
    expect(validateQueryPlan(invalid, catalog, executive, available()).outcome).toBe('semantic_uncertainty');
    const defaultPlan = proposal(); defaultPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'default', dates: ['2026-05-01'] };
    expect(validateQueryPlan(defaultPlan, catalog, executive, available())).toMatchObject({ outcome: 'accepted', dates: ['2026-10-01'] });
    const noSpan = proposal(); noSpan.measures[0].interpretation.sourceText = null;
    expect(validateQueryPlan(noSpan, catalog, executive, available()).outcome).toBe('semantic_uncertainty');
  });
  it('unavailable dates/sources fail transparently and ranking requires the entire population', () => {
    expect(validateQueryPlan(proposal(), catalog, executive, { ...available(), dates: [] }).outcome).toBe('data_unavailable');
    expect(validateQueryPlan(proposal(), catalog, executive, { ...available(), sourceSystems: [] }).outcome).toBe('data_unavailable');
    const mayText = 'sales in May 2025', may = proposal(mayText);
    may.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'May 2025', dates: dateList('2025-05-01', '2025-05-31', 366) };
    expect(validateQueryPlan(may, catalog, executive, { ...available(mayText), availabilityWindow: { min: '2026-01-01', max: '2026-10-01' } }))
      .toMatchObject({ outcome: 'clarification_required', code: 'date_outside_availability', dateAvailability: {
        requestedDates: dateList('2025-05-01', '2025-05-31', 366), availableFrom: '2026-01-01', availableTo: '2026-10-01',
      } });
    const plan = ranking();
    expect(validateQueryPlan(plan, catalog, executive, { ...available('Top sales'), branchIds: ['E01'] }).outcome).toBe('incomplete_evidence');
    plan.completeness.minimumCoverage = 0.5;
    expect(validateQueryPlan(plan, catalog, executive, available('Top sales')).outcome).toBe('incomplete_evidence');
  });
  it('accepts partial non-ranking availability but rejects incomplete complete-population plans', () => {
    const base = available();
    const partial = { ...base, branchDates: base.branchIds.flatMap(branchId => base.dates.filter(date => !(branchId === 'E01' && date === '2026-10-01')).map(date => ({ branchId, date }))) };
    expect(validateQueryPlan(proposal(), catalog, executive, partial).outcome).toBe('accepted');
    const top = ranking();
    expect(validateQueryPlan(top, catalog, executive, { ...partial, sourceText: 'Top sales' }).outcome).toBe('incomplete_evidence');
  });
  it('revoking one region or a permission with the same revision cannot reuse the accepted evidence population', () => {
    expect(revalidate(accept(), { ...executive, regions: ['east'] }).outcome).toBe('permission_denied');
    expect(revalidate(accept(), { ...executive, permissions: ['sales.read'] }).outcome).toBe('permission_denied');
  });
  it('month/date/range/relative plans obey calendar and time budgets', () => {
    const time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit' as const, evidenceText: 'period' };
    expect(resolveTime({ ...time, dates: dateList('2024-02-01', '2024-02-29', 366) }, '2026-10-01', 62).dates).toHaveLength(29);
    expect(resolveTime({ ...time, dates: dateList('2026-09-30', '2026-10-01', 366) }, '2026-10-01', 62).dates).toEqual(['2026-09-30', '2026-10-01']);
    expect(resolveTime({ ...time, dates: ['2026-09-30'] }, '2026-10-01', 62).dates).toEqual(['2026-09-30']);
    expect(resolveTime({ ...time, dates: dateList('2026-09-21', '2026-09-27', 366) }, '2026-10-01', 62).dates).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(() => resolveTime({ ...time, dates: dateList('2026-01-01', '2026-12-31', 366) }, '2026-10-01', 62)).toThrow(/budget/);
    expect(queryPlanSchema.safeParse({ ...proposal(), time: { ...time, dates: ['2026-02-30'] } }).success).toBe(false);
    const invalidDate = filter(proposal(), 'Show sales', 'date', '2026-02-30');
    expect(validateQueryPlan(invalidDate, catalog, executive, available()).outcome).toBe('unsupported_concept');
  });
  it('model schema exposes all region codes, limits listed branches, and lets branch codes reach validation', () => {
    const input = buildPlannerInput(catalog, manager, 'sales');
    const json = JSON.stringify(input.jsonSchema);
    expect(json).toContain('net_sales'); expect(json).toContain('branch');
    expect(json).not.toContain('S01'); expect(json).toContain('south');
    const text = 'X99 sales', unknownBranch = filter(proposal(text), text, 'branch', 'X99', 'X99');
    expect(parsePlannerJSON({ ...unknownBranch, intentKind: 'query', parentState: null }).outcome).toBe('planned');
    expect(validateQueryPlan(unknownBranch, catalog, manager, available(text)))
      .toMatchObject({ outcome: 'permission_denied', code: 'explicit_scope_denied' });
    const deniedRegionText = 'South sales';
    expect(validateQueryPlan(filter(proposal(deniedRegionText), deniedRegionText, 'region', 'south', 'South'), catalog, manager, available(deniedRegionText)))
      .toMatchObject({ outcome: 'permission_denied', code: 'explicit_scope_denied' });
    expect(input.prompt).toContain('Unresolved'.toLowerCase());
  });
  it('keeps catalog region labels in planner prompt data', () => {
    const prompt = buildPlannerInput(catalog, executive, 'sales').prompt;
    expect(prompt).toContain('ภาคตะวันออก');
    expect(prompt).toContain('ภาคกลาง');
    expect(prompt).toContain('ภาคใต้');
  });
  it('an unaligned month or sparse date selection cannot become a complete prior-month comparison', () => {
    const plan = proposal();
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span('Show sales')).text, dates: dateList('2026-02-01', '2026-03-28', 366) };
    plan.compare = { kind: 'vs_prior_period', period: 'month', baseline: null, sourceText: span('Show sales'), confidence: 1 };
    plan.multiDateGrain = { fieldId: 'date', mode: 'sum' };
    expect(validateQueryPlan(plan, catalog, executive, available()).outcome).toBe('semantic_uncertainty');
    plan.time = { ...plan.time, dates: dateList('2026-05-01', '2026-05-31', 62) };
    plan.filters = [{ fieldId: 'date', op: 'in', value: ['2026-05-01', '2026-05-31'], sourceText: span('Show sales'), confidence: 1 }];
    expect(validateQueryPlan(plan, catalog, executive, available()).outcome).toBe('semantic_uncertainty');
  });
  it('no authorized population produces an impossible planner schema with no protected identities', () => {
    const context = buildPlannerInput(catalog, { ...manager, regions: [] }, 'sales');
    expect((context.jsonSchema.anyOf as Record<string, unknown>[])[0].not).toEqual({});
    expect(context.prompt).not.toContain('E01');
    expect(context.prompt).not.toContain('S01');
  });
});
