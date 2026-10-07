import { describe, expect, it } from 'vitest';
import captures from './live-fixtures/qwen-plans.json';
import { boundedConversation, buildPlannerInput, parsePlannerJSON } from '../../lib/dynamic/planner/planner';
import { normalizeQueryPlan, resolveSpan } from '../../lib/dynamic/plan/normalize';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { available, catalog, executive, fakeEvidence, filter, manager, proposal, readAt, span } from './fixtures';

describe('captured Qwen planner regressions', () => {
  it.each(captures.map((capture, i) => ({ ...capture, i })))('parses capture $i: $message', ({ contractPlan }) => {
    expect(parsePlannerJSON(JSON.stringify(contractPlan)).outcome).toBe('planned');
  });
  it.each(captures.map((capture, i) => ({ ...capture, i })))('grounds and executes capture $i: $message', async ({ contractPlan, message, i }) => {
    const result = parsePlannerJSON(JSON.stringify(contractPlan), undefined, { sourceText: message, businessDate: '2026-10-01' });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') throw new Error('code' in result ? result.code : result.outcome);
    const checked = validateQueryPlan(result.plan, catalog, executive, available(message));
    expect(checked.outcome).toBe('accepted');
    if (checked.outcome !== 'accepted') throw new Error(checked.code);
    expect(checked.dates).toEqual([i % 5 === 3 ? '2026-03-01' : '2026-10-01']);
    if (i % 5 === 2) expect(checked.plan.time).toMatchObject({ source: 'default', dates: ['2026-10-01'] });
    const executed = await executeReadRequest(compileQueryPlan(checked), async scope => fakeEvidence(scope), executive, readAt);
    if (executed.outcome !== 'accepted') throw new Error(executed.code);
    const claims = buildClaimGraph(executed.bundle).claims;
    const sales = claims.filter(c => c.measure === 'net_sales' && !c.dimensions.comparison);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.reduce((sum, c) => sum + (c.value ?? 0), 0)).toBe([680, 200, 200, 280, 280][i % 5]);
    if (i % 5 === 4) {
      const targets = claims.filter(c => c.measure === 'target');
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ value: 300, dimensions: { region: 'east' } });
      expect(targets[0].dimensions.comparison).toBeUndefined();
      expect(claims.find(c => c.dimensions.comparison === 'difference')?.value).toBe(-20);
    }
    for (const claim of claims) {
      expect(claim.rowRefs.length).toBeGreaterThan(0);
      expect(claim.sourceRefs.length).toBeGreaterThan(0);
    }
  });
});

describe('server normalization guards', () => {
  it('prompt supplies the business clock, serving window, bounded conversation, catalog labels and authority', () => {
    const previousPlan = proposal('sales');
    const input = buildPlannerInput(catalog, manager, 'and central?', undefined, {
      businessDate: '2026-10-06', timezone: 'Asia/Bangkok', availabilityWindow: { min: '2026-01-01', max: '2026-10-06' },
      conversation: [{ role: 'user', content: 'Earlier sales request' }, { role: 'assistant', content: 'Earlier answer' }], previousPlan,
    });
    for (const value of ['2026-10-06', 'Tuesday', 'ISO week 1 contains the first Thursday of the calendar year', 'Monday through Sunday', 'Asia/Bangkok', '2026-01-01', 'Earlier sales request', 'Earlier answer',
      'First branch', 'ยอดขาย', 'ภาคตะวันออก', 'AUTHORIZED_SCOPE=', 'PREVIOUS_STATE_DATA=']) expect(input.prompt).toContain(value);
    expect(input.prompt.match(/PREVIOUS_STATE_DATA=/gu)).toHaveLength(1);
    expect(input.prompt).not.toContain('Third branch');
    const history = Array.from({ length: 20 }, () => ({ role: 'user' as const, content: '😀'.repeat(3000) }));
    const bounded = boundedConversation(history);
    expect(bounded.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(8192);
  });
  it('missing span text clarifies only the affected element and cannot use model offsets', () => {
    const text = 'East sales', plan = filter(proposal(text), text, 'region', 'east', 'East');
    plan.filters[0].sourceText!.text = 'South';
    expect(normalizeQueryPlan(plan, text, '2026-10-01')).toMatchObject({ outcome: 'clarification_required',
      code: 'unsupported_source_text', clarification: { slotId: 'filters.0' } });
  });
  it('a missing explicit measure span clarifies that measure instead of accepting its label', () => {
    const plan = proposal('sales'); plan.measures[0].interpretation.sourceText = null;
    expect(normalizeQueryPlan(plan, 'sales', '2026-10-01')).toMatchObject({ outcome: 'clarification_required',
      code: 'unsupported_source_text', clarification: { slotId: 'measures.0.interpretation' } });
  });
  it('server offsets replace even negative model offsets and text-only spans parse', () => {
    const text = 'East sales', plan = filter(proposal(text), text, 'region', 'east', 'East');
    const intent = { ...plan, intentKind: 'query', parentState: null };
    const raw = JSON.parse(JSON.stringify(intent));
    raw.filters[0].sourceText = { start: -99, end: -1, text: 'East' };
    raw.measures[0].interpretation.sourceText = { text: 'sales' };
    const parsed = parsePlannerJSON(raw, undefined, { sourceText: text, businessDate: '2026-10-01' });
    expect(parsed).toMatchObject({ outcome: 'planned', plan: { filters: [{ sourceText: span(text, 'East') }] } });
  });
  it.each([['ฝั่่งตะวันออก', 'ฝั่งตะวันออก'], ['net   sales', 'net sales'], ['cafe\u0301', 'café']])('grounds Unicode formatting %s against %s', (model, original) => {
    expect(resolveSpan(`Please ${original} now`, model)?.text).toBe(original);
  });
  it('does not spell-correct missing or meaning-changing text', () => {
    expect(resolveSpan('east sales', 'west')).toBeNull();
    // Bounded transcription-slip tolerance (Thai, >= FUZZY_MIN_CHARS, one edit): the span is always the USER's own text.
    expect(resolveSpan('ฝั่งตะวันออก', 'ฝั้งตะวันออก')?.text).toBe('ฝั่งตะวันออก');
    expect(resolveSpan('ยอดขายสัปดาห์ที่แล้ว', 'สัปดาห์ที่แล่ว')?.text).toBe('สัปดาห์ที่แล้ว');
    expect(resolveSpan('ยอดขายวันนี้', 'วันนนี้')?.text).toBe('วันนี้');
    // Two edits, short Thai (< FUZZY_MIN_CHARS) and Latin text are never fuzzy-matched.
    expect(resolveSpan('ฝั่งตะวันออก', 'ฝั้งตะวันตก')).toBeNull();
    expect(resolveSpan('ภาคใต้', 'ใด้')).toBeNull();
    expect(resolveSpan('east sales today', 'eest sales')).toBeNull();
    // Ambiguous: the slip fits two separate places in the message.
    expect(resolveSpan('ภาคตะวันออก และ ภาคตะวันออก', 'ภาคตะวันออค')).toBeNull();
  });
  it('extracts one wrapped JSON object and rejects competing objects', () => {
    const raw = JSON.stringify({ ...proposal('sales'), intentKind: 'query', parentState: null });
    expect(parsePlannerJSON(`Here is the plan:\n${raw}\nDone.`).outcome).toBe('planned');
    expect(parsePlannerJSON(`${raw}\n${raw}`)).toMatchObject({ code: 'malformed_model_json' });
  });
  it('removes single-date grouping but preserves row grain and ranking completeness', () => {
    const plan = proposal('sales today');
    plan.group.fieldIds.push('date');
    const normalized = normalizeQueryPlan(plan, 'sales today', '2026-10-01');
    expect(normalized).toMatchObject({ outcome: 'normalized', plan: { group: { fieldIds: ['branch'] }, grain: ['branch'] } });
    plan.aggregation = 'rows';
    expect(normalizeQueryPlan(plan, 'sales today', '2026-10-01')).toMatchObject({ outcome: 'normalized', plan: { grain: ['branch', 'date'] } });
  });
  it('model dates are preserved even when the text suggests a different date', () => {
    const text = 'sales on 1 ตุลาคม 2569', plan = proposal(text);
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: '1 ตุลาคม 2569', dates: ['2026-03-01'] };
    expect(normalizeQueryPlan(plan, text, '2026-10-06')).toMatchObject({ outcome: 'normalized', plan: { time: { dates: ['2026-03-01'], source: 'explicit' } } });
  });
  it('hostile model time without evidence text clarifies', () => {
    const plan = proposal('sales');
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-10-01'] };
    const result = parsePlannerJSON({ ...plan, intentKind: 'query', parentState: null }, undefined, { sourceText: 'sales', businessDate: '2026-10-01' });
    expect(result).toMatchObject({ outcome: 'clarification_required', code: 'unsupported_time_text' });
    expect(validateQueryPlan(plan, catalog, executive, available('sales'))).toMatchObject({ outcome: 'clarification_required', code: 'unsupported_time_text' });
  });
  it('explicit date outside availability clarifies before any read', () => {
    const plan = proposal('sales yesterday');
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'yesterday', dates: ['2025-12-31'] };
    expect(validateQueryPlan(plan, catalog, executive, available('sales yesterday'))).toMatchObject({ outcome: 'clarification_required', code: 'date_outside_availability' });
  });
  it('inherited dates must equal the verified previous dates', () => {
    const plan = proposal('sales');
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'inherited', dates: ['2026-09-30'] };
    // `inherited` means the prior state's dates: with a verified prior state the model's copy is restated from it.
    expect(normalizeQueryPlan(plan, 'sales', '2026-10-01', ['2026-10-01'])).toMatchObject({ outcome: 'normalized', plan: { time: { source: 'inherited', dates: ['2026-10-01'] } } });
    // Without a prior state an inherited time is refused unless the dates lie inside the served window (then labeled generated).
    expect(normalizeQueryPlan(plan, 'sales', '2026-10-01')).toMatchObject({ code: 'inherited_time_mismatch' });
    expect(normalizeQueryPlan(plan, 'sales', '2026-10-01', undefined, { availability: { min: '2026-09-02', max: '2026-10-01' } }))
      .toMatchObject({ outcome: 'normalized', plan: { time: { source: 'generated', dates: ['2026-09-30'] } } });
    expect(validateQueryPlan(plan, catalog, executive, { ...available('sales'), previousDates: ['2026-10-01'] })).toMatchObject({ code: 'inherited_time_mismatch' });
  });
  it('inherited filters require the prior canonical value and no current evidence', () => {
    const prior = filter(proposal('East sales'), 'East sales', 'region', 'east', 'East');
    const plan = proposal('again');
    plan.filters = prior.filters.map(filter => ({ ...filter, source: 'inherited' }));
    const normalized = normalizeQueryPlan(plan, 'again', '2026-10-01');
    if (normalized.outcome !== 'normalized') throw new Error(normalized.code);
    expect(normalized.plan.filters[0].sourceText).toBeNull();
    expect(validateQueryPlan(normalized.plan, catalog, executive, { ...available('again'), previousPlan: prior }).outcome).toBe('accepted');
    normalized.plan.filters[0].value = 'south';
    expect(validateQueryPlan(normalized.plan, catalog, executive, { ...available('again'), previousPlan: prior }))
      .toMatchObject({ code: 'inherited_filter_mismatch' });
  });
  it('invented default date is replaced by businessDate without treating modal May as a month', () => {
    const text = 'May I see E01 sales?', plan = proposal(text);
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'default', dates: ['2023-10-27'] };
    expect(normalizeQueryPlan(plan, text, '2026-10-06')).toMatchObject({ outcome: 'normalized', plan: { time: { dates: ['2026-10-06'], source: 'default' } } });
  });
  it('permission denied survives normalization for an East manager asking ภาคใต้', () => {
    const text = 'sales ภาคใต้', plan = filter(proposal(text), text, 'region', 'south', 'ภาคใต้');
    const normalized = normalizeQueryPlan(plan, text, '2026-10-01');
    if (normalized.outcome !== 'normalized') throw new Error(normalized.code);
    expect(validateQueryPlan(normalized.plan, catalog, manager, available(text))).toMatchObject({ outcome: 'permission_denied', code: 'explicit_scope_denied' });
  });
  it.each(['dataset', 'field', 'aggregation', 'timezone', 'time-field'])('invented %s remains rejected after normalization', kind => {
    const text = 'sales', plan = proposal(text);
    if (kind === 'dataset') plan.datasetId = 'invented';
    if (kind === 'field') plan.dimensions[0].fieldId = 'invented';
    if (kind === 'aggregation') plan.measures[0].aggregation = 'invented';
    if (kind === 'timezone' || kind === 'time-field') plan.time = { fieldId: kind === 'time-field' ? 'invented' : 'date', timezone: kind === 'timezone' ? 'invented' : 'Asia/Bangkok', source: 'default', dates: ['2026-10-01'] };
    const normalized = normalizeQueryPlan(plan, text, '2026-10-01');
    if (normalized.outcome !== 'normalized') throw new Error(normalized.code);
    expect(validateQueryPlan(normalized.plan, catalog, executive, available(text)).outcome).toBe('unsupported_concept');
  });
  it.each([
    ['1 October 2026', '2026-10-01'], ['1 ตุลาคม 2569', '2026-10-01'], ['yesterday', '2026-10-05'], ['ตุลาคม??', '2026-10-05'],
  ])('accepts AI-resolved ISO dates with evidence %s', (text, date) => {
    const plan = proposal(text);
    plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: [date], evidenceText: text };
    expect(normalizeQueryPlan(plan, text, '2026-10-06')).toMatchObject({ outcome: 'normalized', plan: { time: { dates: [date] } } });
  });
  it('prompts and schema request text-only spans with compact common shape examples', () => {
    const input = buildPlannerInput(catalog, executive, 'sales');
    expect(input.prompt).toContain('Return raw JSON only');
    expect(input.prompt).toContain('A request to calculate or explain business measures is a query');
    expect(input.prompt).toContain('Requests to create, prepare, share, or change something');
    expect(input.prompt).toContain('Relative month: "sales last month"');
    expect(input.prompt).toContain('A named scope outside AUTHORIZED_SCOPE is still a query');
    for (const shape of ['Aggregate:', 'Branch detail:', 'Region filter:', 'Ranking:', 'bottom 3 branches vs target', 'Follow-up:']) expect(input.prompt).toContain(shape);
    expect(JSON.stringify(input.jsonSchema)).not.toContain('"start":{"type":"integer"');
  });
});
