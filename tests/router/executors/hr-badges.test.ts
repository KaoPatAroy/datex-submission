import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryPlan } from '@/lib/dynamic/plan/schemas';
import { executeHrQueryStep } from '@/lib/router/executors/hr';
import { filter } from '../../dynamic/fixtures';
import { hrPlan } from '../../dynamic/wave2/fixtures';
import { actors, base, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => {
  fixture = await seed();
  await fixture.store.transaction(async tx => {
    for (const badge of [
      { id: 'B-E1', employeeId: 'EMP-E1', state: 'active', version: 3, updatedAt: '2026-09-01T00:00:00Z', operationKey: 'secret-op' },
      { id: 'B-E1b', employeeId: 'EMP-E1', state: 'revoked', version: 2, updatedAt: '2026-09-02T00:00:00Z' },
      { id: 'B-S1', employeeId: 'EMP-S1', state: 'active', version: 1, updatedAt: '2026-09-01T00:00:00Z' },
    ]) await tx.put('mock_badges', badge);
  });
});
afterEach(async () => { await fixture.dispose(); });

const withBadge = (plan: QueryPlan, message: string, field = 'badge_status'): QueryPlan => ({ ...plan,
  dimensions: [{ fieldId: field, interpretation: { value: field, source: 'explicit', sourceText: { start: 0, end: 4, text: message.slice(0, 4) }, confidence: 1 } }] });
const run = (message: string, plan: QueryPlan, actor = actors.hr) => executeHrQueryStep({ ...base(fixture, actor, message), step: { kind: 'hr_query', plan } });

describe('HR badge state', () => {
  it('answers badge id, status and type for an authorized employee without private badge fields', async () => {
    const message = 'Find employee EMP-E1 badge status';
    const plan = withBadge(filter(hrPlan(message), message, 'employee_id', 'EMP-E1', 'EMP-E1'), message);
    const result = await run(message, plan);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.text).toContain('บัตร B-E1 (บัตรพนักงาน) · สถานะบัตร ใช้งาน');
    expect(result.text).toContain('บัตร B-E1b (บัตรพนักงาน) · สถานะบัตร ถูกเพิกถอน');
    const json = JSON.stringify(result, (_k, v) => typeof v === 'function' ? undefined : v);
    for (const secret of ['secret-op', 'updatedAt', '"version":3']) expect(json).not.toContain(secret);
  });

  it('filters by badge status and says so when an employee has no badge', async () => {
    const message = 'Find employee EMP-E3 badge status';
    const none = await run(message, withBadge(filter(hrPlan(message), message, 'employee_id', 'EMP-E3', 'EMP-E3'), message));
    expect(none.outcome).toBe('accepted');
    if (none.outcome === 'accepted') expect(none.text).toContain('ไม่มีบัตรในระบบ');
    const revoked = await run('Find revoked badge', withBadge(filter(hrPlan('Find revoked badge'), 'Find revoked badge', 'badge_status', 'revoked', 'revoked'), 'Find revoked badge'));
    expect(revoked.outcome).toBe('accepted');
    if (revoked.outcome === 'accepted') { expect(revoked.text).toContain('B-E1b'); expect(revoked.text).not.toContain('B-E1 '); }
  });

  it('keeps the HR scope fence: a regional manager never sees badges of out-of-scope employees', async () => {
    const message = 'Find employee EMP-S1 badge status';
    const denied = await run(message, withBadge(filter(hrPlan(message), message, 'employee_id', 'EMP-S1', 'EMP-S1'), message), actors.east);
    const text = JSON.stringify(denied, (_k, v) => typeof v === 'function' ? undefined : v);
    expect(text).not.toContain('B-S1');
    const own = await run('Find employee', withBadge(hrPlan('Find employee'), 'Find employee'), actors.east);
    expect(own.outcome).toBe('accepted');
    if (own.outcome === 'accepted') { expect(own.text).toContain('B-E1'); expect(own.text).not.toContain('B-S1'); }
  });

  it('refuses badge fields in aggregated headcount plans', async () => {
    const message = 'Headcount by badge status';
    const plan = withBadge({ ...hrPlan(message), aggregation: 'registered', group: { fieldIds: ['branch'] } }, message);
    const result = await run(message, plan);
    expect(result.outcome).not.toBe('accepted');
  });
});
