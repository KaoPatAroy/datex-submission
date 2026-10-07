import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeHrQueryStep, type HrExecutorInput } from '@/lib/router/executors/hr';
import { filter } from '../../dynamic/fixtures';
import { headcountPlan, hrPlan } from '../../dynamic/wave2/fixtures';
import { actors, base, seed, type Fixture, PRIVATE } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

const run = (message: string, plan = hrPlan(message), actor = actors.hr, extra: Partial<HrExecutorInput> = {}) =>
  executeHrQueryStep({ ...base(fixture, actor, message), step: { kind: 'hr_query', plan }, ...extra });
const byId = (message: string, id: string) => filter(hrPlan(message), message, 'employee_id', id, id);
const byName = (message: string, name: string) => filter(hrPlan(message), message, 'employee_name', name, name);

describe('HR executor', () => {
  it('looks up an employee by exact id with Thai text and only the four safe fields', async () => {
    const message = 'Find employee EMP-E1';
    const result = await run(message, byId(message, 'EMP-E1'));
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.text).toContain('EMP-E1 · Ada Lovelace · สถานะในระบบ: ใช้งาน');
    expect(result.text).toContain('ขอบเขตข้อมูล');
    expect(result.sources[0]).toMatchObject({ system: 'hr', freshness: 'fresh' });
    expect(result.analysis.facts).toHaveLength(1);
    expect(result.interpretedScope.datasetId).toBe('hr_employees');
  });

  it('never exposes private fields or out-of-scope employees', async () => {
    const message = 'Find employee EMP-E1';
    const result = await run(message, byId(message, 'EMP-E1'));
    const all = await run('Find employee', hrPlan('Find employee'));
    for (const value of [result, all]) {
      const json = JSON.stringify(value, (_k, v) => typeof v === 'function' ? undefined : v);
      for (const secret of [String(PRIVATE.salary), PRIVATE.phone, PRIVATE.nationalId]) expect(json).not.toContain(secret);
    }
    expect(all.outcome).toBe('accepted');
    if (all.outcome === 'accepted') {
      expect(all.text).toContain('EMP-G1'); // hr_admin sees global records
      expect(all.text).toContain('EMP-S1');
    }
  });

  it('returns a headcount of active employees computed from evidence', async () => {
    const message = 'Headcount by East branch';
    const plan = filter(headcountPlan(message), message, 'region', 'east', 'East');
    const result = await run(message, plan);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.text).toContain('จำนวนพนักงานที่มีสถานะใช้งานในระบบ');
      expect(result.text).toMatch(/E01.*: 2 คน/); // Ada + Dana (Bea inactive)
    }
  });

  it('enforces region scope for a non-admin with hr.read', async () => {
    const message = 'Find employee EMP-S1';
    const denied = await run(message, filter(hrPlan(message), message, 'region', 'south', 'EMP-S1'), actors.east);
    expect(denied.outcome).toBe('denied');
    const own = await run('Find employee', hrPlan('Find employee'), actors.east);
    expect(own.outcome).toBe('accepted');
    if (own.outcome === 'accepted') {
      expect(own.text).not.toContain('EMP-S1');
      expect(own.text).not.toContain('EMP-G1');
    }
  });

  it('denies HR queries for roles without hr.read', async () => {
    const message = 'Find employee EMP-E1';
    const result = await run(message, byId(message, 'EMP-E1'), actors.executive);
    expect(result).toMatchObject({ outcome: 'denied', code: 'hr_permission', kind: 'hr_query' });
    expect(JSON.stringify(result)).not.toContain('Ada');
  });

  it('asks a typed clarification with authorized choices when the name matches several employees', async () => {
    const message = 'Find employee Dana Dup';
    const asked: unknown[] = [];
    const result = await run(message, byName(message, 'Dana Dup'), actors.hr, {
      ask: async ctx => { asked.push(ctx); return 'ต้องการ Dana Dup คนไหน'; },
    });
    expect(result).toMatchObject({ outcome: 'clarify', code: 'ambiguous_employee', aiAsked: true, text: 'ต้องการ Dana Dup คนไหน' });
    if (result.outcome === 'clarify') {
      expect(result.choices.map(c => c.id).sort()).toEqual(['EMP-D1', 'EMP-D2']);
      expect(JSON.stringify(result)).not.toContain(PRIVATE.phone);
    }
    expect(asked).toHaveLength(1);
  });

  it('falls back to a fixed Thai question when the AI question is unsafe', async () => {
    const message = 'Find employee Dana Dup';
    const result = await run(message, byName(message, 'Dana Dup'), actors.hr, { ask: async () => 'bad\u0007text' });
    expect(result).toMatchObject({ outcome: 'clarify', aiAsked: false });
  });

  // G6: the AI-authored HR clarification passes the shared model-text gate (completion claims) whatever hook the caller supplies.
  it.each([undefined, () => true, (text: string) => !text.includes('\u0007')])('falls back to server copy when the AI question claims a completion (hook %#)', async hook => {
    const message = 'Find employee Dana Dup';
    for (const claim of ['I have deleted the Dashboard; which employee did you mean?', 'ลบ Dashboard เรียบร้อยแล้ว ต้องการ Dana Dup คนไหน']) {
      const result = await run(message, byName(message, 'Dana Dup'), actors.hr, { ask: async () => claim, ...(hook ? { isSafeText: hook } : {}) });
      expect(result).toMatchObject({ outcome: 'clarify', code: 'ambiguous_employee', aiAsked: false, text: 'พบพนักงานที่ตรงกับชื่อนี้หลายคน โปรดเลือกคนที่ต้องการ' });
    }
  });

  it('does not ask when a unique name resolves', async () => {
    const message = 'Find employee Ada Lovelace';
    const result = await run(message, byName(message, 'Ada Lovelace'));
    expect(result.outcome).toBe('accepted');
  });

  it('persists a CAS-checked exact state and rejects a stale authority', async () => {
    const message = 'Find employee EMP-E1';
    const result = await run(message, byId(message, 'EMP-E1'));
    if (result.outcome !== 'accepted') throw new Error('expected accepted');
    await fixture.store.transaction(tx => result.persist(tx, actors.hr, 'conv-hr'));
    const record = await fixture.store.get<{ name: string; state: { version: number } }>('tool_executions', 'dynamic-hr:turn:1');
    expect(record).toMatchObject({ name: 'hr.dynamic_query', state: { version: 2 } });
    await expect(fixture.store.transaction(tx => result.persist(tx, { ...actors.hr, permissions: [] }, 'conv-hr2'))).rejects.toThrow();
  });

  it('reports no matching claims as a typed denial', async () => {
    const message = 'Find employee EMP-NONE';
    const result = await run(message, byId(message, 'EMP-NONE'));
    expect(result).toMatchObject({ outcome: 'denied', code: 'no_matching_claims' });
  });
});
