import { dateList } from '../../lib/dynamic/plan/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ConversationMessage, Profile } from '../../lib/contracts';
import { ConciergeService } from '../../lib/core/service';
import { AIRuntimeError } from '../../lib/ai/errors';
import { liveAIKillSwitchOn, readDynamicPlannerTimeoutMs } from '../../lib/dynamic/config';
import { getAIHealth, recordAIHealth } from '../../lib/ai/health';
import type { QueryPlan } from '../../lib/dynamic/plan/schemas';
import type { ClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import type { EvidenceBundle } from '../../lib/dynamic/evidence/bundle';
import type { ConversationState } from '../../lib/dynamic/state/conversation';
import { conversationStateRef } from '../../lib/dynamic/planner/planner';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from '../helpers/workspace';
import { conversationStep, dashboardCreateStep, plan, planner } from '../helpers/turn-planner';
import { fakeEvidence, filter, proposal, ranking, span } from './fixtures';
import { hrPlan } from './wave2/fixtures';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('../helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
type Proof = { id: string; name: string; turnId: string; plan: QueryPlan; bundle: EvidenceBundle; claims: ClaimGraph; state: ConversationState };
let fixture: Fixture;
const liveActor = (actor = actors.executive): Actor => ({ ...actor, mode: 'live_ai', modeRevision: 1 });

const queryStep = (queryPlan: QueryPlan, continuation = false) => ({ kind: 'query', continuation, plan: queryPlan });
/** The planner answers every call with a (fresh or continuing) query step carrying this QueryPlan. */
function fakePlan(queryPlan: QueryPlan, continuation = false): void { planner.reply(plan(queryStep(queryPlan, continuation))); }

function stockIssuesPlan(message: string): QueryPlan {
  const queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
  queryPlan.measures[0] = { fieldId: 'stock_issues', aggregation: 'sum', interpretation: {
    value: 'stock_issues', source: 'explicit', sourceText: span(message, 'Stock issues'), confidence: 1,
  } };
  queryPlan.measures.push({ fieldId: 'incident_count', aggregation: 'sum', interpretation: {
    value: 'incident_count', source: 'explicit', sourceText: span(message, 'incidents'), confidence: 1,
  } });
  return queryPlan;
}

function service(reviewPrivateCreations = false): ConciergeService {
  return new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => FIXED_NOW, reviewPrivateCreations });
}

async function proof(turnId: string): Promise<Proof> {
  const record = await fixture.store.get<Proof>('tool_executions', `dynamic:${turnId}`);
  if (!record) throw new Error('Missing persisted dynamic query proof.');
  return record;
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  planner.reset();
  fixture = await createWorkspaceFixture();
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  await fixture.patchSession(actors.east.sessionId, { mode: 'live_ai', modeRevision: 1 });
  await fixture.store.transaction(async tx => {
    for (const [id, region, amount] of [['E01', 'east', 100_000], ['S01', 'south', 350_000]] as const) {
      await tx.put('branches', { id, region, name: `Registered branch ${id}` });
      await tx.put('sales_orders', { id: `paid:${id}`, branchId: id, date: BUSINESS_DATE, amountSatang: amount,
        status: 'paid', updatedAt: '2026-10-01T16:59:55.000Z' });
      await tx.put('sales_targets', { id: `target:${id}`, branchId: id, date: BUSINESS_DATE, amountSatang: 200_000,
        updatedAt: '2026-10-01T16:59:55.000Z' });
    }
  });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.dispose(); vi.unstubAllEnvs(); });

describe('live AI kill switch, planner outcomes and health', () => {
  it.each([['', 15_000], ['bad', 15_000], ['999', 1_000], ['1000', 1_000], ['10000', 10_000], ['20000', 15_000]] as const)(
    'bounds planner timeout %s to %s ms', (setting, expected) => {
      vi.stubEnv('BIZTANIA_DYNAMIC_PLANNER_TIMEOUT_MS', setting);
      expect(readDynamicPlannerTimeoutMs()).toBe(expected);
    });

  it('records planner health once per outcome so provider failures trigger demo recovery', async () => {
    vi.stubEnv('NINEARM_API_KEY', 'fixture-health-key');
    vi.stubEnv('NINEARM_BASE_URL', 'https://provider.example/v1');
    vi.stubEnv('NINEARM_MODEL', 'fixture-model');
    vi.stubEnv('AI_PROVIDER', 'ninearm');
    for (let i = 0; i < 3; i++) recordAIHealth('ok');
    const app = service();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    planner.fail(new AIRuntimeError('provider_unavailable', 'down'));
    expect((await app.turn(liveActor(), 'East sales')).message.length).toBeGreaterThan(0);
    expect(getAIHealth()).toMatchObject({ status: 'degraded', reason: 'provider_unavailable' });
    expect((await app.turn(liveActor(), 'East sales')).message.length).toBeGreaterThan(0);
    expect(getAIHealth()).toMatchObject({ status: 'unavailable', reason: 'recent_provider_failures' });
    fakePlan(filter(proposal('East sales'), 'East sales', 'region', 'east', 'East'));
    for (let i = 0; i < 3; i++) await app.turn(liveActor(), 'East sales');
    expect(getAIHealth()).toMatchObject({ status: 'ok', reason: 'ok' });
    planner.fail(new AIRuntimeError('deadline_exceeded', 'timeout'));
    expect((await app.turn(liveActor(), 'East sales')).message.length).toBeGreaterThan(0);
    expect(getAIHealth()).toMatchObject({ status: 'degraded', reason: 'deadline_exceeded' });
    expect((await app.turn(liveActor(), 'East sales')).message.length).toBeGreaterThan(0);
    expect(getAIHealth().status).toBe('unavailable');
  });

  it('reads the kill switch per turn: only the exact off value disables live AI and no model is called', async () => {
    for (const [value, expected] of [['off', true], ['', false], ['invalid', false], ['on', false], ['shadow', false]] as const) {
      vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', value);
      expect(liveAIKillSwitchOn()).toBe(expected);
    }
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    const app = service();
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    expect((await app.turn(liveActor(), message)).clarification).toBeUndefined();
    expect(planner.calls).toHaveLength(1);
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', 'off');
    const off = await app.turn(liveActor(), message);
    expect(off).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(off.sources).toBeUndefined();
    expect(planner.calls).toHaveLength(1);
  });

  it('ranking answers render Thai rank lines from the validated plan', async () => {
    const message = 'Top sales';
    fakePlan(ranking(message));
    const answer = await service().turn(liveActor(), message);
    expect(answer.message).toMatch(/^อันดับ \d+ คือสาข/mu);
    expect(answer.message).not.toContain('Rank:');
    expect(answer.message).not.toContain('position.');
    expect((await proof(answer.turnId)).plan.topN).toMatchObject({ count: 2, direction: 'highest' });
  });

  it('a dashboard request is planned as an action step after one planner call and prepared for confirmation', async () => {
    planner.reply(plan(dashboardCreateStep('Sales overview')));
    const answer = await service(true).turn(liveActor(), 'Create a sales dashboard');
    expect(answer.pendingAction?.status).toBe('pending');
    expect(planner.calls).toHaveLength(1);
    expect(await fixture.store.get('pending_actions', answer.pendingAction!.id)).toMatchObject({ status: 'pending' });
  });

  it('an employee lookup is planned as an hr_query step after one planner call for an HR-permitted actor', async () => {
    await fixture.store.transaction(async tx => {
      const actor = await tx.get<Profile>('profiles', 'executive');
      await tx.put('profiles', { ...actor!, permissions: [...actor!.permissions, 'hr.read'] });
    });
    const message = 'Show employee E024';
    planner.reply(plan({ kind: 'hr_query', plan: filter(hrPlan(message), message, 'employee_id', 'E024', 'E024') }));
    const answer = await service().turn(liveActor(), message);
    expect(planner.calls).toHaveLength(1);
    expect(answer.pendingAction).toBeUndefined();
    expect(answer.message).not.toContain('Untrusted');
  });

  it('on preserves Scripted Demo behaviour: typed text is never planned or read', async () => {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'scripted_demo', modeRevision: 0 });
    const answer = await service().turn(actors.executive, 'East sales');
    expect(answer.mode).toBe('scripted_demo');
    expect(answer.clarification).toBe(true);
    expect(answer.sources).toBeUndefined();
    expect(planner.calls).toHaveLength(0);
  });

  it('an hr_query without hr.read is a server denial with no HR read, however the planner phrased it', async () => {
    const message = 'Show employee E024';
    planner.reply(plan({ kind: 'hr_query', plan: filter(hrPlan(message), message, 'employee_id', 'E024', 'E024') }));
    const answer = await service().turn(liveActor(), message);
    expect(planner.calls).toHaveLength(1);
    expect(answer.clarification).toBe(true);
    expect(answer.sources).toBeUndefined();
    expect(answer.analysis).toBeUndefined();
    expect(answer.message).not.toMatch(/E024/);
  });

  it('an unrelated retail read stays dynamic with a pending dashboard proposal', async () => {
    planner.reply(plan(dashboardCreateStep('East sales dashboard')));
    const app = service(true);
    const prepared = await app.turn(liveActor(), 'Create an East sales dashboard');
    expect(prepared.pendingAction?.status).toBe('pending');
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const answer = await app.turn(liveActor(), message, prepared.conversationId);
    expect(answer.message).toContain('ยอดขายสุทธิ 1,000.00 บาท.');
    expect(planner.calls).toHaveLength(2);
    expect(await fixture.store.get('pending_actions', prepared.pendingAction!.id)).toMatchObject({ status: 'pending' });
  });
});

describe('QueryPlan through ConciergeService.turn', () => {
  it('answers the available part of an explicit month and records its coverage gap', async () => {
    await fixture.store.transaction(tx => tx.put('sales_orders', { id: 'SO-E02-SEP02', branchId: 'E02', date: '2026-09-02',
      amountSatang: 25_000, status: 'paid', updatedAt: '2026-09-02T16:59:55.000Z' }));
    const message = 'Show sales for 2026-09-01 through 2026-09-30', queryPlan = proposal(message);
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit',
      evidenceText: span(message, '2026-09-01 through 2026-09-30').text, dates: dateList('2026-09-01', '2026-09-30', 62) };
    fakePlan(queryPlan);
    // Dense September evidence (the sparse fixture store would list every missing branch/day and exceed the 6 KB answer cap).
    const app = service();
    vi.spyOn(app, 'queryEvidence').mockImplementation(async (_actor, scope) => fakeEvidence(scope));
    const answer = await app.turn(liveActor(), message);
    expect(answer.clarification).toBeUndefined();
    expect((await proof(answer.turnId)).plan.time).toMatchObject({ dates: dateList('2026-09-02', '2026-09-30', 62) });
    expect(answer.message).toContain('ช่วงวันที่ 2026-09-02..2026-09-30');
    expect(answer.message).toContain('ไม่มีข้อมูลสำหรับวันที่ 2026-09-01');
    expect(answer.analysis?.missingEvidence).toContainEqual(expect.objectContaining({ text: expect.stringContaining('ไม่มีข้อมูลสำหรับวันที่ 2026-09-01') }));
  });

  it('unseen region/date wording yields only East claims and persisted evidence origins', async () => {
    const message = 'east-side stores sales on 1 Oct 2026';
    const queryPlan = filter(proposal(message), message, 'region', 'east', 'east-side stores');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(message, '1 Oct 2026')).text, dates: [BUSINESS_DATE] };
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('ยอดขายสุทธิ 1,000.00 บาท.');
    expect(answer.message).toContain('ยอดขายสุทธิ 1,500.00 บาท.');
    expect(answer.message).not.toMatch(/E01|E02|S01|C01|999999/);
    expect(reader.mock.calls.map(call => call[1])).toEqual(Array.from({ length: 2 }, () => ({ region: 'east', date: BUSINESS_DATE, branchIds: ['E01', 'E02'] })));
    const record = await proof(answer.turnId);
    expect(record.bundle.scope.branchIds).toEqual(['E01', 'E02']);
    expect(record.claims.claims).toHaveLength(2);
    for (const claim of record.claims.claims) {
      expect(claim.rowRefs.length).toBeGreaterThan(0);
      expect(claim.rowRefs.every(id => record.bundle.rows.some(row => row.rowId === id && row.region === 'east'))).toBe(true);
      expect(claim.sourceRefs.every(id => record.bundle.sources.some(source => source.id === id))).toBe(true);
    }
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]!.prompt).toContain('AUTHORIZED_CATALOG_DATA');
  });
  it('counts a zero-match inventory snapshot as zero without requiring unrelated source rows', async () => {
    const message = 'Stock issues and incidents in East';
    fakePlan(stockIssuesPlan(message));
    await fixture.store.transaction(async tx => {
      await tx.put('branches', { id: 'E03', name: 'East Three', region: 'east' });
      await tx.put('inventory_snapshots', { id: 'INV-E01-2026-10-01', branchId: 'E01', productId: 'P001', date: BUSINESS_DATE,
        onHand: 5, minimum: 5, observedAt: '2026-10-01T16:59:55.000Z', updatedAt: '2026-10-01T16:59:55.000Z' });
      await tx.put('inventory_snapshots', { id: 'INV-E03-2026-10-01', branchId: 'E03', productId: 'P001', date: BUSINESS_DATE,
        onHand: 5, minimum: 5, observedAt: '2026-10-01T16:59:55.000Z', updatedAt: '2026-10-01T16:59:55.000Z' });
    });

    const answer = await service().turn(liveActor(), message);
    const record = await proof(answer.turnId);
    expect(record.bundle.coverage).toMatchObject({ expected: 3, read: 3, complete: false,
      omittedReasons: expect.arrayContaining([
        'Missing evidence for incidents at branch E01 on 2026-10-01.',
        'Missing evidence for incidents at branch E03 on 2026-10-01.',
      ]) });
    expect(record.claims.claims.filter(claim => claim.measure === 'stock_issues').map(claim => [claim.dimensions.branch, claim.value]))
      .toEqual([['E01', 0], ['E02', 1], ['E03', 0]]);
    expect(record.claims.claims.filter(claim => claim.measure === 'incident_count').map(claim => [claim.dimensions.branch, claim.value]))
      .toEqual([['E02', 1]]);
    expect(answer.message).toContain('East Three มีสต็อกต่ำกว่าขั้นต่ำ 0 รายการ.');
    expect(answer.message).toContain('East Two มี Incident ที่ยังไม่ปิด 1 รายการ.');
    expect(answer.message).toContain('ไม่พบหลักฐานจากแหล่ง Incident ของสาขา East Three');
    expect(answer.message).not.toContain('E03');
  });
  it('reports missing evidence only when that branch has no inventory rows for the date', async () => {
    const message = 'Stock issues and incidents in East';
    fakePlan(stockIssuesPlan(message));
    await fixture.store.transaction(async tx => {
      await tx.put('branches', { id: 'E03', name: 'East Three', region: 'east' });
      await tx.put('inventory_snapshots', { id: 'INV-E01-2026-10-01', branchId: 'E01', productId: 'P001', date: BUSINESS_DATE,
        onHand: 5, minimum: 5, observedAt: '2026-10-01T16:59:55.000Z', updatedAt: '2026-10-01T16:59:55.000Z' });
    });

    const answer = await service().turn(liveActor(), message);
    const record = await proof(answer.turnId);
    expect(record.bundle.coverage).toMatchObject({ expected: 3, read: 2, complete: false,
      omittedReasons: expect.arrayContaining([
        'Missing evidence for incidents at branch E01 on 2026-10-01.',
        'Missing evidence for branch E03 on 2026-10-01.',
      ]) });
    expect(answer.message).toContain('ไม่พบหลักฐานของสาขา East Three วันที่ 2026-10-01');
    expect(answer.message).not.toContain('ไม่พบหลักฐานจากแหล่งสต็อกสินค้า ของสาขา E01');
    expect(record.claims.claims.some(claim => claim.measure === 'stock_issues' && claim.dimensions.branch === 'E01' && claim.value === 0)).toBe(true);
  });
  it('May as a polite request keeps the labeled default date', async () => {
    const message = 'May I see E01 sales?';
    fakePlan(filter(proposal(message), message, 'branch', 'E01', 'E01'));
    const answer = await service().turn(liveActor(), message);
    expect(answer.message).toContain('ขอบเขตที่ตีความ: ช่วงวันที่ 2026-10-01;');
    expect(answer.message).toContain('ยอดขายสุทธิ 1,000.00 บาท.');
    expect(answer.message).not.toContain('Supported choices');
    expect(answer.message).not.toContain('Date alternatives');
    expect((await proof(answer.turnId)).plan.time).toMatchObject({ dates: [BUSINESS_DATE], source: 'default' });
  });
  it('renders one typed scope header without default-choice lines for a fully explicit scope', async () => {
    const message = 'East sales on 2026-10-01', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: '2026-10-01', dates: [BUSINESS_DATE] };
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    expect(answer.message.match(/^ขอบเขตที่ตีความ:/gmu)).toHaveLength(1);
    expect(answer.message).toContain(`ช่วงวันที่ ${BUSINESS_DATE};`);
    expect(answer.message).not.toContain('\nScope:');
    expect(answer.message).not.toContain('Business dates:');
    expect(answer.message).not.toContain('(ค่าเริ่มต้น)');
    expect(answer.message).not.toContain('Supported choices');
  });
  it('an explicit May 2025 request reports the requested dates and serving window', async () => {
    const message = 'E01 sales for May 2025', queryPlan = filter(proposal(message), message, 'branch', 'E01', 'E01');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(message, 'May 2025')).text, dates: dateList('2025-05-01', '2025-05-31', 366) };
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.clarification).toBe(true);
    expect(answer.message).toContain('2025-05-01..2025-05-31');
    expect(answer.message).toContain('ไม่มีข้อมูลในระบบ');
    expect(answer.message).toContain('ข้อมูลที่มีครอบคลุม 2026-10-01 ถึง 2026-10-01');
    expect(answer.message.match(/ข้อมูลที่มีครอบคลุม/gu)).toHaveLength(1);
    expect(answer.message).not.toContain('Date alternatives');
    expect(answer.message).not.toMatch(/1000|1500/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('an invalid model time shape retains canonical proposed dates and the available window', async () => {
    const message = 'East sales last month', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    const time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'last month',
      dates: dateList('2025-05-01', '2025-05-31', 366), period: 'month' };
    // The model-authored time object carries an extra key; the TurnPlan schema is strict, so this is an invalid plan.
    planner.reply(plan(queryStep({ ...queryPlan, time } as unknown as QueryPlan)));
    const answer = await service().turn(liveActor(), message);
    expect(answer.clarification).toBe(true);
    expect(answer.hint).toBe('switch_to_demo');
    expect(answer.sources).toBeUndefined();
    expect(answer.message).not.toMatch(/1000|1500/);
  });
  it('unsupported time evidence reports model dates and the available window', async () => {
    const message = 'East sales today', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'last month',
      dates: dateList('2025-05-01', '2025-05-31', 366) };
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    expect(answer.clarification).toBe(true);
    expect(answer.message).toContain('ยังยืนยันช่วงเวลาที่ต้องการ (2025-05-01..2025-05-31)ไม่ได้');
    expect(answer.message).toContain('ข้อมูลที่มีครอบคลุม 2026-10-01 ถึง 2026-10-01');
  });
  it('executive East requests never widen to the executive whole scope', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect((await proof(answer.turnId)).bundle.rows.every(row => row.region === 'east')).toBe(true);
    expect(reader.mock.calls.every(call => call[1].region === 'east')).toBe(true);
  });
  it('East Manager South request is a denial with authorized choices and no South read', async () => {
    const message = 'South sales';
    fakePlan(filter(proposal(message), message, 'region', 'south', 'South'));
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(actors.east), message);
    expect(answer.message).toContain('อยู่นอกสิทธิ์ของบัญชีนี้');
    expect(answer.message).toContain('ภูมิภาคที่ถามได้ เช่น ภาคตะวันออก');
    expect(answer.message).not.toMatch(/south|S01|3500/);
    expect(answer.message).not.toMatch(/\d/u);
    expect(reader).not.toHaveBeenCalled();
    expect(planner.calls[0]!.prompt).toContain('south');
    expect(planner.calls[0]!.prompt).not.toContain('S01');
  });
  it('unresolved scope clarifies without an all-region read', async () => {
    const message = 'coastal stores sales';
    fakePlan(filter(proposal(message), message, 'region', null, 'coastal stores'));
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(actors.east), message);
    expect(answer.message).toContain('ช่วยระบุตัวชี้วัดหรือขอบเขต');
    expect(answer.message).toContain('ภูมิภาคที่ถามได้ เช่น ภาคตะวันออก');
    expect(reader).not.toHaveBeenCalled();
  });
  it('missing branch source evidence blocks a top-N claim after registered coverage discovery', async () => {
    const message = 'Top East sales', queryPlan = filter(ranking(message), message, 'region', 'east', 'East');
    fakePlan(queryPlan);
    await fixture.store.transaction(tx => tx.remove('sales_orders', 'paid:E01'));
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('ข้อมูลของบางสาขาหรือบางวันยังไม่ครบ');
    expect(answer.message).not.toMatch(/^อันดับ \d+/mu);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(await fixture.store.get('tool_executions', `dynamic:${answer.turnId}`)).toBeUndefined();
  });
  it('a reader returning a subset also blocks ranking and emits no ranking claims', async () => {
    const message = 'Top East sales';
    fakePlan(filter(ranking(message), message, 'region', 'east', 'East'));
    const app = service(), realRead = app.queryEvidence.bind(app);
    vi.spyOn(app, 'queryEvidence').mockImplementation(async (actor, scope) => ({ ...await realRead(actor, scope), branches: [] }));
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('หลักฐานของกลุ่มที่ต้องใช้ยังไม่ครบ');
    expect(answer.message).not.toMatch(/^อันดับ \d+/mu);
  });
  it('unsupported dimension stays unsupported with supported choices', async () => {
    const message = 'East sales by weather', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.dimensions = [{ fieldId: 'weather', interpretation: { value: 'weather', source: 'explicit', sourceText: span(message, 'weather'), confidence: 1 } }];
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    expect(answer.message).toContain('คำถามนี้ยังไม่ตรงกับข้อมูลที่ระบบตรวจสอบได้');
    expect(answer.message).toContain('ตัวชี้วัดที่ถามได้');
    expect(answer.message).not.toMatch(/1000|1500/);
  });
  it('every numeric answer fact comes from a persisted claim value', async () => {
    const message = 'Top East sales';
    fakePlan(filter(ranking(message), message, 'region', 'east', 'East'));
    const answer = await service().turn(liveActor(actors.east), message), record = await proof(answer.turnId);
    const numericFacts = [...answer.message.matchAll(/(-?[\d,]+(?:\.\d+)?) (?:บาท|รายการ|คน)\./g)]
      .map(match => Number(match[1].replaceAll(',', '')));
    expect(numericFacts.length).toBeGreaterThan(0);
    expect(numericFacts.every(value => record.claims.claims.some(claim => Math.abs(claim.value ?? 0) === value))).toBe(true);
    expect(answer.analysis?.facts.map(fact => fact.sourceIds)).toEqual(record.claims.claims.map(claim => claim.sourceRefs));
  });
  it('authorized scope defaults and limitations are stated for a limited manager', async () => {
    const message = 'Top sales';
    fakePlan(ranking(message));
    const answer = await service().turn(liveActor(actors.east), message);
    expect(answer.message).toContain('ภูมิภาค ภาคตะวันออก');
    expect(answer.message).toContain('จำกัดขอบเขตตามสิทธิ์ของคุณ: ภาคตะวันออก');
    expect((await proof(answer.turnId)).claims.claims.filter(claim => claim.computation.operation === 'rank').every(claim => claim.caveat)).toBe(true);
  });
  it('partial date-range coverage is labeled and excludes dates with no evidence', async () => {
    await fixture.store.transaction(tx => tx.put('sales_targets', { id: 'window:next', branchId: 'E02', date: '2026-10-02', amountSatang: 200_000, updatedAt: '2026-10-02T16:59:55.000Z' }));
    const message = 'East sales for 2026-10-01 through 2026-10-02', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(message, '2026-10-01 through 2026-10-02')).text, dates: dateList(BUSINESS_DATE, '2026-10-02', 366) };
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('ไม่พบหลักฐานของสาขา East Two วันที่ 2026-10-02');
    const record = await proof(answer.turnId);
    expect(record.bundle.coverage).toMatchObject({ complete: false, expected: 4, read: 2 });
    expect(reader.mock.calls.map(call => call[1].date)).toEqual([BUSINESS_DATE, '2026-10-02', BUSINESS_DATE]);
    expect(record.bundle.rows.every(row => row.date === BUSINESS_DATE)).toBe(true);
    expect(record.claims.claims.every(claim => claim.rowRefs.every(id => record.bundle.rows.some(row => row.rowId === id && row.date === BUSINESS_DATE)))).toBe(true);
  });
  it('multi-date reads use repeated bounded registered scopes and sum actual evidence only', async () => {
    await fixture.store.transaction(async tx => {
      await tx.put('sales_orders', { id: 'prior:E01', branchId: 'E01', date: '2026-09-30', amountSatang: 50_000,
        status: 'paid', updatedAt: '2026-09-30T16:59:55.000Z' });
    });
    const message = 'E01 sales for 2026-09-30 through 2026-10-01', queryPlan = filter(proposal(message), message, 'branch', 'E01', 'E01');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: (span(message, '2026-09-30 through 2026-10-01')).text, dates: dateList('2026-09-30', BUSINESS_DATE, 366) };
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('ยอดขายสุทธิ 1,500.00 บาท.');
    expect(answer.message).toContain('วันที่ 2026-09-30..2026-10-01');
    expect(reader.mock.calls.map(call => call[1].date)).toEqual(['2026-09-30', BUSINESS_DATE, '2026-09-30', BUSINESS_DATE]);
    expect((await proof(answer.turnId)).claims.claims[0].rowRefs).toHaveLength(2);
  });
  it('registered target comparisons and group aggregation use claim computations', async () => {
    const message = 'East sales vs target', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: span(message, 'East'), confidence: 1 } }];
    queryPlan.group.fieldIds = ['region'];
    queryPlan.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span(message, 'vs target'), confidence: 1 };
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    const record = await proof(answer.turnId);
    expect(record.claims.claims.map(claim => [claim.value, claim.computation.operation])).toEqual([[2500, 'sum'], [4000, 'sum'], [-1500, 'difference']]);
    expect(answer.message).toContain('ภาคตะวันออก มีเป้าหมาย 4,000.00 บาท.');
    expect(answer.message).toContain('ภาคตะวันออก ยอดขายสุทธิต่ำกว่าเป้าหมาย 1,500.00 บาท (-37.5%).');
    expect(answer.message).not.toContain('เปรียบเทียบ=');
  });
  it('compares two grouped regions with a server-computed difference and percentage', async () => {
    const message = 'Compare East and Central region sales', queryPlan = proposal(message);
    queryPlan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit',
      sourceText: span(message, 'region'), confidence: 1 } }];
    queryPlan.group.fieldIds = ['region'];
    queryPlan.filters = [{ fieldId: 'region', op: 'in', value: ['east', 'central'], sourceText: span(message, 'East and Central'), confidence: 1 }];
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    const comparison = 'ภาคตะวันออก มียอดขายสุทธิสูงกว่าภาคกลาง 1,800.00 บาท (257.1%).';
    expect(answer.message).toContain(comparison);
    expect(answer.analysis?.relationships).toContainEqual(expect.objectContaining({ text: comparison, sourceIds: expect.any(Array) }));
    expect(answer.message).not.toContain('ภูมิภาค=');
  });
  it('sales-deficit ranking uses registered gap and excludes branches above target', async () => {
    await fixture.store.transaction(async tx => {
      const row = await tx.get<{ id: string; amountSatang: number }>('sales_orders', 'SO-E02-PAID');
      await tx.put('sales_orders', { ...row!, amountSatang: 250_000 });
    });
    const message = 'Top East branches below sales target';
    let queryPlan = filter(ranking(message, 'gap', 'lowest'), message, 'region', 'east', 'East');
    queryPlan = filter(queryPlan, message, 'gap', 0, 'below');
    queryPlan.filters.at(-1)!.op = 'lt';
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message), record = await proof(answer.turnId);
    expect(record.claims.claims.filter(claim => claim.computation.operation === 'rank').map(claim => claim.dimensions.branch)).toEqual(['E01']);
    expect(answer.message).toContain('ส่วนต่างจากเป้า -1,000.00 บาท.');
  });
  it('prior-day comparisons read the exact baseline and ground the difference', async () => {
    await fixture.store.transaction(tx => tx.put('sales_orders', { id: 'prior:E01', branchId: 'E01', date: '2026-09-30',
      amountSatang: 60_000, status: 'paid', updatedAt: '2026-09-30T16:59:55.000Z' }));
    const message = 'E01 sales vs prior day', queryPlan = filter(proposal(message), message, 'branch', 'E01', 'E01');
    queryPlan.compare = { kind: 'vs_prior_day', period: null, baseline: null, sourceText: span(message, 'vs prior day'), confidence: 1 };
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message), record = await proof(answer.turnId);
    expect(reader.mock.calls.map(call => call[1].date)).toEqual(['2026-09-30', BUSINESS_DATE, '2026-09-30', BUSINESS_DATE]);
    expect(record.claims.claims.map(claim => claim.value)).toEqual([1000, 600, 400]);
    expect(answer.message).toContain('ยอดขายสุทธิเพิ่มขึ้นจากช่วงก่อนหน้า 400.00 บาท (+40%).');
    expect(record.claims.claims.at(-1)!.rowRefs).toHaveLength(2);
  });
  it('partial temporal comparisons clarify instead of silently answering only current-period facts', async () => {
    await fixture.store.transaction(tx => tx.put('sales_orders', { id: 'prior:E01', branchId: 'E01', date: '2026-09-30',
      amountSatang: 60_000, status: 'paid', updatedAt: '2026-09-30T16:59:55.000Z' }));
    const message = 'East sales vs prior day', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.compare = { kind: 'vs_prior_day', period: null, baseline: null, sourceText: span(message, 'vs prior day'), confidence: 1 };
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message);
    expect(answer.message).toContain('ข้อมูลของบางสาขาหรือบางวันยังไม่ครบ');
    expect(answer.analysis).toBeUndefined();
    expect(answer.message).not.toMatch(/1000|1500|600/);
    expect(await fixture.store.get('tool_executions', `dynamic:${answer.turnId}`)).toBeUndefined();
  });
  it.each(['region grouping', 'temporal comparison', 'region grain', 'branch-only grain'])('row plans never silently discard requested %s', async operation => {
    const message = 'East sales vs prior day', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.aggregation = 'rows';
    if (operation === 'region grouping') {
      queryPlan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: span(message, 'East'), confidence: 1 } }];
      queryPlan.group.fieldIds = ['region'];
    } else if (operation === 'temporal comparison') queryPlan.compare = { kind: 'vs_prior_day', period: null, baseline: null, sourceText: span(message, 'vs prior day'), confidence: 1 };
    else queryPlan.grain = operation === 'region grain' ? ['region'] : ['branch'];
    fakePlan(queryPlan);
    const app = service(), reader = vi.spyOn(app, 'queryEvidence');
    const answer = await app.turn(liveActor(), message);
    expect(answer.message).toContain('คำถามนี้ยังไม่ตรงกับข้อมูลที่ระบบตรวจสอบได้');
    expect(reader).not.toHaveBeenCalled();
  });
  it('compatible row plans preserve branch/date evidence grain', async () => {
    const message = 'E01 sales', queryPlan = filter(proposal(message), message, 'branch', 'E01', 'E01');
    queryPlan.aggregation = 'rows';
    fakePlan(queryPlan);
    const answer = await service().turn(liveActor(), message), record = await proof(answer.turnId);
    expect(record.claims.claims[0]).toMatchObject({ value: 1000, dimensions: { branch: 'E01', date: BUSINESS_DATE } });
    expect(record.claims.claims[0].rowRefs).toHaveLength(1);
    expect(answer.message).toContain('1,000.00 บาท.');
  });
  it('accepted dynamic turns recover and replay through the existing ledger without another provider call', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const app = service(), identity = { contractVersion: 2 as const, requestKey: 'dynamic-replay-test' };
    const first = await app.turn(liveActor(), message, undefined, undefined, identity);
    const replay = await app.turn(liveActor(), message, undefined, undefined, identity);
    expect(replay).toMatchObject({ turnId: first.turnId, message: first.message, replayed: true, analysis: first.analysis, sources: first.sources });
    expect(await app.recoverTurn(liveActor(), { ...identity, message })).toMatchObject({ status: 'completed' });
    expect(planner.calls).toHaveLength(1);
    expect((await fixture.store.list<Proof>('tool_executions')).filter(record => record.name === 'retail.dynamic_query')).toHaveLength(1);
  });
  it('authority revoked before persistence denies, streams no answer, and stores no proof', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const app = service(), deltas: string[] = [];
    const pending = app.turn(liveActor(), message, undefined, undefined, { contractVersion: 2, requestKey: 'dynamic-authority-test' }, {
      onTextDelta: text => { deltas.push(text); },
      onStatus: async status => {
        if (status === 'saving') await fixture.store.transaction(async tx => {
          const actor = await tx.get<Profile>('profiles', 'executive');
          await tx.put('profiles', { ...actor!, permissions: [] });
        });
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(deltas.filter(Boolean)).toEqual([]);
    expect((await fixture.store.list<Proof>('tool_executions')).filter(record => record.name === 'retail.dynamic_query')).toEqual([]);
    expect((await fixture.store.list<ConversationMessage>('conversation_messages')).filter(message => message.role === 'assistant')).toEqual([]);
    expect((await fixture.store.list<{ name: string; status: string }>('tool_executions')).find(record => record.name === 'chat.turn_request')?.status).toBe('failed');
  });
  it('stream emits the exact persisted grounded text only after successful persistence', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const deltas: string[] = [], app = service();
    const answer = await app.turn(liveActor(), message, undefined, undefined, undefined, {
      onTextDelta: async text => {
        if (text) expect((await fixture.store.list<ConversationMessage>('conversation_messages')).some(message => message.role === 'assistant' && message.text === text)).toBe(true);
        deltas.push(text);
      },
    });
    expect(deltas.filter(Boolean)).toEqual([answer.message]);
  });
  it('planner timeout uses a server-owned outage reply without model prose', async () => {
    planner.fail(new AIRuntimeError('deadline_exceeded', 'Sensitive planner deadline detail'));
    const answer = await service().turn(liveActor(), 'East sales');
    expect(answer).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(answer.message.length).toBeGreaterThan(0);
    expect(answer.message).not.toMatch(/Sensitive|1500/);
    expect(answer.sources).toBeUndefined();
    expect(planner.calls).toHaveLength(1);
  });
  it('planner provider error uses a server-owned outage reply without model prose', async () => {
    planner.fail(new AIRuntimeError('provider_unavailable', 'Sensitive provider response'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = await service().turn(liveActor(), 'East sales');
    expect(answer).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(answer.message).not.toContain('Sensitive');
    expect(planner.calls).toHaveLength(1);
  });
  it('user abort of the planner ends the turn with AbortError and no answer', async () => {
    const controller = new AbortController();
    planner.reply((_input: unknown, runtime: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      runtime.signal?.addEventListener('abort', () => reject(runtime.signal?.reason), { once: true });
    }));
    const app = service();
    const turn = app.turn(liveActor(), 'East sales', undefined, undefined, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(planner.calls).toHaveLength(1));
    controller.abort(new DOMException('The response was stopped.', 'AbortError'));
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect((await fixture.store.list<ConversationMessage>('conversation_messages')).filter(message => message.role === 'assistant')).toEqual([]);
  });
  it('malformed plan output without prior state uses a server-owned invalid-plan reply', async () => {
    planner.reply({ not: 'a turn plan' });
    const answer = await service().turn(liveActor(), 'East sales');
    expect(answer).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(answer.message.length).toBeGreaterThan(0);
    expect(answer.sources).toBeUndefined();
  });
  it('malformed plan output with prior accepted state still answers truthfully and keeps the prior proof', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const app = service();
    const first = await app.turn(liveActor(), message);
    planner.reply({ not: 'a turn plan' });
    const answer = await app.turn(liveActor(), 'E01 sales', first.conversationId);
    expect(answer).toMatchObject({ clarification: true, hint: 'switch_to_demo' });
    expect(answer.sources).toBeUndefined();
    expect(answer.message).not.toMatch(/1000|1500/);
    expect(await proof(first.turnId)).toMatchObject({ name: 'retail.dynamic_query' });
    expect((await fixture.store.list<Proof>('tool_executions')).filter(record => record.name === 'retail.dynamic_query')).toHaveLength(1);
  });
  it('a bounded runtime abort stops further reads after the first pending read', async () => {
    const message = 'East sales';
    fakePlan(filter(proposal(message), message, 'region', 'east', 'East'));
    const app = service(), controller = new AbortController();
    const read = vi.spyOn(app, 'queryEvidence').mockImplementation((_actor, _scope, signal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const turn = app.turn(liveActor(), message, undefined, undefined, undefined, { signal: controller.signal });
    const settled = turn.then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('The response was stopped.', 'AbortError'));
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledTimes(1);
    expect((await fixture.store.list<Proof>('tool_executions')).filter(record => record.name === 'retail.dynamic_query')).toEqual([]);
  });
  it('treats a follow-up without dynamic state as a fresh query using explicit values', async () => {
    planner.reply(plan(conversationStep('greeting', 'Hello, how can I help?')));
    const app = service();
    const first = await app.turn(liveActor(), 'Hello');
    const message = 'East sales on 2026-10-01', queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    queryPlan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: '2026-10-01', dates: [BUSINESS_DATE] };
    fakePlan(queryPlan, true);
    const answer = await app.turn(liveActor(), message, first.conversationId);
    const sent = planner.calls.at(-1)!;
    expect(sent.prompt).toContain('RECENT_CONVERSATION=');
    expect(sent.context.conversation.map(entry => entry.text)).toContain('Hello, how can I help?');
    expect(sent.context.previousState).toBeNull();
    expect(sent.prompt).toContain('PREVIOUS_STATE_DATA=null');
    expect(answer.clarification).toBeUndefined();
    expect((await proof(answer.turnId)).state.parentState).toBeNull();
    expect((await proof(answer.turnId)).plan.time).toMatchObject({ source: 'explicit', dates: [BUSINESS_DATE] });
  });
  it('recognized follow-ups bind the exact prior state and advance immutable revisions', async () => {
    const app = service(), firstText = 'East sales';
    fakePlan(filter(proposal(firstText), firstText, 'region', 'east', 'East'));
    const first = await app.turn(liveActor(), firstText), firstProof = await proof(first.turnId);
    const nextText = 'แล้วภาคกลางล่ะ', next = filter(proposal(nextText), nextText, 'region', 'central', 'ภาคกลาง');
    next.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'inherited', dates: [BUSINESS_DATE] };
    fakePlan(next, true);
    const second = await app.turn(liveActor(), nextText, first.conversationId), secondProof = await proof(second.turnId);
    expect(planner.calls).toHaveLength(2);
    expect(second.message.split('\n')[0]).toContain('(ต่อจากคำถามก่อน)');
    expect(second.message).not.toContain('Follow-up scope:');
    expect(second.message).not.toContain('Follow-up dates:');
    expect(second.message).toContain('ยอดขายสุทธิ 700.00 บาท.');
    expect(secondProof.state.parentState).toEqual(conversationStateRef(firstProof.state));
    expect(secondProof.state.revision).toBe(2);
    const followUp = planner.calls.at(-1)!;
    expect(followUp.context.previousState?.stateId).toBe(conversationStateRef(firstProof.state).id);
    expect(followUp.prompt.match(/PREVIOUS_STATE_DATA=/gu)).toHaveLength(1);
    const third = await app.turn(liveActor(), nextText, first.conversationId);
    expect((await proof(third.turnId)).state.revision).toBe(3);
  });
  it('fills an omitted follow-up parent ref from server state and keeps inherited East scope', async () => {
    const app = service(), firstText = 'East sales';
    fakePlan(filter(proposal(firstText), firstText, 'region', 'east', 'East'));
    const first = await app.turn(liveActor(), firstText), firstProof = await proof(first.turnId);
    const next = structuredClone(firstProof.plan);
    next.planId = 'plan:follow-up-east';
    next.measures = next.measures.map(measure => ({ ...measure,
      interpretation: { ...measure.interpretation, source: 'inherited', sourceText: null } }));
    next.filters = next.filters.map(filter => ({ ...filter, source: 'inherited', sourceText: null, evidenceText: undefined }));
    next.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'inherited', dates: [...firstProof.state.resolvedScope.dates] };
    fakePlan(next, true);
    const answer = await app.turn(liveActor(), 'same scope and period', first.conversationId), secondProof = await proof(answer.turnId);
    expect(answer.clarification).toBeUndefined();
    expect(secondProof.state.parentState).toEqual(conversationStateRef(firstProof.state));
    expect(secondProof.state.resolvedScope.regions).toEqual(['east']);
    expect(secondProof.plan.filters).toMatchObject([{ fieldId: 'region', value: 'east', source: 'inherited' }]);
    expect(answer.message).toContain('ยอดขายสุทธิ 1,000.00 บาท.');
  });
  it('replaces a stale copied follow-up ref with the latest server state', async () => {
    const app = service(), firstText = 'East sales';
    fakePlan(filter(proposal(firstText), firstText, 'region', 'east', 'East'));
    const first = await app.turn(liveActor(), firstText), firstProof = await proof(first.turnId);
    const second = await app.turn(liveActor(), firstText, first.conversationId), secondProof = await proof(second.turnId);
    expect(conversationStateRef(secondProof.state)).not.toEqual(conversationStateRef(firstProof.state));
    fakePlan(filter(proposal(firstText), firstText, 'region', 'east', 'East'), true);
    const answer = await app.turn(liveActor(), firstText, first.conversationId);
    const thirdProof = await proof(answer.turnId);
    expect(planner.calls.at(-1)!.context.previousState?.stateId).toBe(conversationStateRef(secondProof.state).id);
    expect(answer.clarification).toBeUndefined();
    expect(thirdProof.state.parentState).toEqual(conversationStateRef(secondProof.state));
    expect(thirdProof.state.revision).toBe(3);
  });
  it('a concurrent accepted query invalidates a follow-up parent before persistence', async () => {
    const app = service(), message = 'East sales';
    const queryPlan = filter(proposal(message), message, 'region', 'east', 'East');
    fakePlan(queryPlan);
    const first = await app.turn(liveActor(), message);
    fakePlan(queryPlan, true);
    const request = app.turn(liveActor(), message, first.conversationId, undefined, undefined, {
      onStatus: async status => {
        if (status === 'saving') {
          fakePlan(queryPlan);
          await app.turn(liveActor(), message, first.conversationId);
        }
      },
    });
    await expect(request).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await fixture.store.list<Proof>('tool_executions')).filter(record => record.name === 'retail.dynamic_query')).toHaveLength(2);
  });
  it('revoked prior scope is withheld and an explicit follow-up becomes a fresh query', async () => {
    const app = service(), firstText = 'East sales';
    fakePlan(filter(proposal(firstText), firstText, 'region', 'east', 'East'));
    const first = await app.turn(liveActor(), firstText);
    await fixture.store.transaction(async tx => {
      const actor = await tx.get<Profile>('profiles', 'executive');
      await tx.put('profiles', { ...actor!, regions: ['central'] });
    });
    const message = 'Then Central sales';
    fakePlan(filter(proposal(message), message, 'region', 'central', 'Central'), true);
    const answer = await app.turn(liveActor(), message, first.conversationId);
    const sent = planner.calls.at(-1)!;
    expect(sent.context.previousState).toBeNull();
    expect(sent.prompt).toContain('PREVIOUS_STATE_DATA=null');
    expect(sent.prompt).not.toContain('E01');
    expect(answer.clarification).toBeUndefined();
    expect((await proof(answer.turnId)).state.parentState).toBeNull();
    expect((await proof(answer.turnId)).state.resolvedScope.regions).toEqual(['central']);
  });
});
