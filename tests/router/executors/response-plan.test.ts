import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeQueryStep } from '@/lib/router/executors/query';
import { executeHrQueryStep } from '@/lib/router/executors/hr';
import { composeResponse, arrangeResponsePlan } from '@/lib/dynamic/response/compose';
import { defaultResponsePlan } from '@/lib/dynamic/response/plan';
import { filter, proposal, span } from '../../dynamic/fixtures';
import { hrPlan } from '../../dynamic/wave2/fixtures';
import { actors, base, read, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

const message = 'Show sales vs target';
const comparing = () => {
  const plan = proposal(message);
  plan.dimensions = []; plan.group.fieldIds = [];
  plan.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span(message, 'vs target'), confidence: 1 };
  return plan;
};
const sales = (presentation?: unknown) => executeQueryStep({ ...base(fixture, actors.executive, message), read,
  step: { kind: 'query', continuation: false, plan: comparing(), ...(presentation ? { presentation } : {}) } as never });
const lines = (text: string) => text.split('\n');

describe('RESPONSE-001 claim-ID ResponsePlan for the sales answer', () => {
  it('renders from claims; a valid arrangement hint reorders sections without changing any claim text', async () => {
    const plain = await sales();
    const arranged = await sales({ order: ['comparisons', 'facts'], style: 'concise' });
    expect(plain.outcome).toBe('accepted'); expect(arranged.outcome).toBe('accepted');
    if (plain.outcome !== 'accepted' || arranged.outcome !== 'accepted') return;
    expect(plain.claims.claims.some(claim => claim.dimensions.comparison === 'difference')).toBe(true);
    // Same set of lines (nothing added, dropped or reworded), different order.
    expect([...lines(arranged.text)].sort()).toEqual([...lines(plain.text)].sort());
    const diffLine = (text: string) => lines(text).findIndex(line => /กว่าเป้าหมาย|เท่ากับเป้าหมาย/.test(line));
    expect(diffLine(plain.text)).toBeGreaterThan(-1);
    expect(diffLine(arranged.text)).toBeLessThan(diffLine(plain.text));
  });

  it('an invalid hint falls back to the deterministic order and never fails the turn', async () => {
    const plain = await sales();
    const bogus = await sales({ order: ['not_a_section'] });
    expect(bogus.outcome).toBe('accepted');
    if (plain.outcome === 'accepted' && bogus.outcome === 'accepted') expect(bogus.text).toBe(plain.text);
  });

  it('composeResponse validates every arrangement as a ResponsePlan over the exact claim ids', async () => {
    const result = await sales();
    if (result.outcome !== 'accepted') throw new Error('expected accepted');
    const { enrichEvidenceBundle } = await import('@/lib/dynamic/evidence/completeness');
    const { createPresentationClaims } = await import('@/lib/dynamic/response/claims');
    const claims = createPresentationClaims(enrichEvidenceBundle(result.bundle));
    if ('outcome' in claims) throw new Error('claims rejected');
    const composed = composeResponse(claims, { order: ['caveats', 'comparisons'] });
    expect(composed?.fromHint).toBe(true);
    expect([...composed!.claimOrder].sort()).toEqual(claims.claims.map(c => c.id).sort());
    const base = defaultResponsePlan(claims);
    expect(arrangeResponsePlan(base, { order: ['comparisons'] }).sections[0].kind).toBe('comparisons');
    expect(composeResponse(claims, { order: [] })?.fromHint).toBe(false);
  });
});

describe('RESPONSE-001 claim-ID ResponsePlan for the HR answer', () => {
  it('orders HR claims through the validated plan and keeps the default when the hint is invalid', async () => {
    const text = 'Find employee EMP-E1';
    const plan = filter(hrPlan(text), text, 'employee_id', 'EMP-E1', 'EMP-E1');
    const run = (presentation?: unknown) => executeHrQueryStep({ ...base(fixture, actors.hr, text), step: { kind: 'hr_query', plan, ...(presentation ? { presentation } : {}) } as never });
    const plain = await run(), hinted = await run({ order: ['facts', 'comparisons'] }), bad = await run({ order: ['x'] });
    expect(plain.outcome).toBe('accepted');
    if (plain.outcome === 'accepted' && hinted.outcome === 'accepted' && bad.outcome === 'accepted') {
      expect(hinted.text).toBe(plain.text);
      expect(bad.text).toBe(plain.text);
    }
  });
});
