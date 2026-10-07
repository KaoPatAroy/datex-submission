import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasMalformedThai, MAX_THAI_REPAIR_SITES, normalizeModelPlanThai, normalizeModelThai, thaiRepairSites } from '@/lib/router/thai-orthography';
import { isSafeClarificationText, isSafeConversationProse, isSafeConversationTitle, isSafeFollowUp } from '@/lib/router/render';
import { parseTurnPlan } from '@/lib/router/planner/parse';
import { gateFallbackCounts, gateReason, recordGateFallback, resetGateFallbackCounts } from '@/lib/router/render/gate-log';

/** Garbled MODEL strings exactly as the live model produced them (v5 spot check P1, P3, M1, H2, R4 and the G3 reproductions). */
const V5 = {
  p1: 'DaTex เป็น AI business concierge ที่ช่วยถาม วิเคราะห์ สร้าง Dashboard แชร่ผลลัพธ์ และตีดตามงานในบริบทข้อมูลท่ีได้รับอนุญาตครับ',
  p1Orphan: 'DaTex เป็น AI business concierge ที่ช่วยถาม วิเคราะหข์ ้อมูล สร้าง Dashboard และ Result แชร้งาน',
  p3: 'Result เป็น snapshot ของคำตอบที่ตรวจสอบแล้ว ไม่ได่รีเฟรชเองโดยไม่แจ้ง เมื่อเปิดหรือโหลดใหม่จะดึงข้อมูลที่ได้รับอนุญาตในขณะนั้่น แต่ไม่ได่เป็น real-time',
  m1: 'Monitor ท่ีจดทะเบียนรองรับเฉพาะการเฝ้ายอดขายต่ากว่าเป้า (sales_below_target) ยังไม่รองรับการเฝ้าสต็อกต่ากว่าขั้้นต่าในปจจบุัน',
  m1Question: 'ตองการใหแจงเตือนเมือสต็อกตํากวาขั้้นตํากี่รายการ และส่่งถิงใครครับ',
  h2: 'ข้อมูล Policy การลาไม่อยู่ในระบบน้ี ท่ีคณืเข้้าถิงได้มมีเพีียง Policy การเพิกถอนบัตร (Demo badge revocation policy) ท่ีสามารถดูหรือรบัทราบได้เท่านั้',
  r4: 'ขออนุญาตแจ้งว่าข้อมีการส่่ง Email ยังไม่เป็็นความสามารถท่ีเปิดให้ในชั่่งน้ี คุณสามารถยื้่นยันการอนุมัติคำขอ Onboarding ท่ีเตรียมไว้แล้วในขั้้นตอ่ไปได้นะครับ',
  title: 'ความต่างระหว่่าง Dashboard กับ Result',
};

describe('Thai orthography repair (MODEL output only)', () => {
  it('reorders a tone mark written before an upper vowel and collapses a duplicated mark', () => {
    expect(normalizeModelThai('ท่ี')).toBe('ที่');
    expect(normalizeModelThai('ส่่ง')).toBe('ส่ง');
    expect(normalizeModelThai('ขั้้น')).toBe('ขั้น');
    expect(normalizeModelThai('เป็็น')).toBe('เป็น');
    expect(normalizeModelThai(V5.p1)).toBe(V5.p1.replace('ท่ี', 'ที่'));
    expect(normalizeModelThai(V5.title)).toBe('ความต่างระหว่าง Dashboard กับ Result');
    // G5: the mark ORDER is repaired, but p1 also carries the swapped-mark misspellings "แชร่" / "ตีดตาม": it still fails the gate.
    expect(hasMalformedThai(normalizeModelThai(V5.p1))).toBe(true);
    expect(hasMalformedThai(normalizeModelThai(V5.p1).replace('แชร่', 'แชร์').replace('ตีดตาม', 'ติดตาม'))).toBe(false);
  });

  it('composes a decomposed sara am and leaves well-formed Thai and non-Thai text untouched', () => {
    expect(normalizeModelThai('ก้ําหนด')).toBe('กำหนด'.replace('ก', 'ก้'));
    for (const ok of ['เปลี่ยนชื่อ สิทธิ์ พันธุ์ ต่ำ น้ำ ก็ เป็น ศักดิ์ เกี่ยว ที่', 'sales_below_target 2026-10-01', '']) {
      expect(normalizeModelThai(ok)).toBe(ok);
      expect(hasMalformedThai(ok)).toBe(false);
    }
  });

  it('flags what no reordering can repair: an orphan mark, two tone marks, an upper and a lower vowel together', () => {
    expect(hasMalformedThai(normalizeModelThai(V5.p1Orphan))).toBe(true); // "หข์ ้อมูล": a tone mark after a space
    expect(hasMalformedThai(normalizeModelThai(V5.p3))).toBe(true); // "นั้่น": two tone marks
    expect(hasMalformedThai(normalizeModelThai(V5.m1))).toBe(true); // "ปจจบุัน": sara u + mai han-akat on one consonant
  });

  it('leaves a heavily garbled string as it is (more than the bounded number of repairs) so the gate falls back', () => {
    for (const garbled of [V5.h2, V5.r4, V5.m1Question]) {
      expect(thaiRepairSites(garbled)).toBeGreaterThan(MAX_THAI_REPAIR_SITES);
      expect(normalizeModelThai(garbled)).toBe(garbled);
      expect(hasMalformedThai(normalizeModelThai(garbled))).toBe(true);
    }
  });

  it('normalizes every MODEL string of a plan but never the copied user-text spans (sourceText / evidenceText)', () => {
    const plan = { steps: [{ kind: 'conversation', topic: 'out_of_scope', prose: 'ข้อมูลท่ีได้รับอนุญาต' },
      { kind: 'query', plan: { filters: [{ fieldId: 'status', value: 'open', sourceText: { start: 11, end: 24, text: 'ท่ียังเปิดอยู่' } }] },
        params: { title: { value: 'งานท่ีต้องทำ', source: 'user_quoted', evidenceText: 'งานท่ีต้องทำ' } } }],
    followUps: ['ดู Incident ท่ียังเปิดอยู่'] };
    const out = normalizeModelPlanThai(plan) as typeof plan;
    expect(out.steps[0]).toMatchObject({ prose: 'ข้อมูลที่ได้รับอนุญาต' });
    expect(out.followUps).toEqual(['ดู Incident ที่ยังเปิดอยู่']);
    const query = out.steps[1] as unknown as { plan: { filters: { sourceText: { text: string } }[] }; params: { title: { value: string; evidenceText: string } } };
    expect(query.plan.filters[0]!.sourceText.text).toBe('ท่ียังเปิดอยู่');
    expect(query.params.title).toEqual({ value: 'งานที่ต้องทำ', source: 'user_quoted', evidenceText: 'งานท่ีต้องทำ' });
  });

  it('parseTurnPlan repairs the real model plan before validation (the planner entry point)', () => {
    const raw = JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'product_help', prose: V5.p1 }], suggestedConversationTitle: V5.title });
    const parsed = parseTurnPlan(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.plan.steps[0]).toMatchObject({ prose: normalizeModelThai(V5.p1) });
    expect(parsed.plan.suggestedConversationTitle).toBe('ความต่างระหว่าง Dashboard กับ Result');
  });

  it('every MODEL-text gate rejects Thai that is still malformed after repair (server copy is used instead)', () => {
    for (const text of [V5.p1Orphan, V5.p3, V5.m1, V5.h2, V5.r4].map(normalizeModelThai)) {
      expect(isSafeConversationProse(text, [])).toBe(false);
      expect(isSafeClarificationText(text, [], [], [])).toBe(false);
    }
    expect(isSafeClarificationText(normalizeModelThai(V5.m1Question), [], [], [])).toBe(false);
    expect(isSafeFollowUp('ดู Incident ท่ีคณืเข้้าถิงได้', [])).toBe(false);
    expect(isSafeConversationTitle('ค้้นหา Policy ท่ีคณืเข้้าถิง', [])).toBe(false);
    expect(isSafeConversationProse(normalizeModelThai(V5.p1).replace('แชร่', 'แชร์').replace('ตีดตาม', 'ติดตาม'), [])).toBe(true);
  });

  // G5 (live v6): DROPPED marks give well-formed but misspelled words the mark-order rules cannot see. Exact model strings from the v6 eval / G5 reproduction.
  it.each([
    'ตองการให Dashboard ใหมมีชื่อยังไงครับ', 'ต้องการให้ Dashboard ใหม่นี้มชื่ออะไรครับ', 'ต้องการให้ Dashboard ใหม่นี้มชีออะไรครับ',
    'ยังไม่มี Dashboard ที่เก็บบันทึกไว้อยู่ในรายการของผ้ใช้ในขณะนี้ จึงยังปักหมุดไม่ได้', 'ไม่พบ Monitor ที่ชื่อตรงกับ “สต็อกต่ากว่าขั้นต่า”',
    'ตองการปักหมุด Dashboard ไหนครับ',
  ])('flags the dropped-mark model Thai %s', text => {
    expect(hasMalformedThai(normalizeModelThai(text))).toBe(true);
    expect(isSafeClarificationText(normalizeModelThai(text), [], [], [])).toBe(false);
  });
  it.each(['ต้องการให้ Dashboard ใหม่มีชื่ออะไรครับ', 'ผู้ใช้ ใหญ่ ไหลไป ต่ำกว่าขั้นต่ำ แชร์ ติดตาม ไหม', 'ให้ ใหม่ ใหญ่'])('keeps correct Thai %s', text => {
    expect(hasMalformedThai(text)).toBe(false);
  });
});

describe('claim-gate fallback log', () => {
  afterEach(() => { resetGateFallbackCounts(); vi.restoreAllMocks(); });

  it('names the reason and counts per surface, logging codes only (never the text)', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(gateReason(normalizeModelThai(V5.p3))).toBe('malformed_thai');
    expect(gateReason('ยอดขายวันนี้ 5 ล้านบาท')).toBe('number');
    expect(gateReason('ผมสร้าง Dashboard ให้เรียบร้อยแล้ว')).toBe('action_claim');
    expect(gateReason('ยอดขายภาคตะวันออกดีขึ้น', ['ภาคตะวันออก'])).toBe('entity_label');
    expect(gateReason('  ')).toBe('empty');
    recordGateFallback('conversation', 'malformed_thai', { topic: 'product_help' });
    recordGateFallback('conversation', 'malformed_thai', { topic: 'product_help' });
    recordGateFallback('follow_up', 'number', { dropped: 2 });
    expect(gateFallbackCounts()).toEqual({ 'conversation:malformed_thai': 2, 'follow_up:number': 1 });
    const lines = log.mock.calls.filter(call => call[0] === 'BIZTANIA_CLAIM_GATE').map(call => JSON.parse(String(call[1])));
    expect(lines).toEqual([
      { surface: 'conversation', reason: 'malformed_thai', count: 1, topic: 'product_help' },
      { surface: 'conversation', reason: 'malformed_thai', count: 2, topic: 'product_help' },
      { surface: 'follow_up', reason: 'number', count: 1, dropped: 2 },
    ]);
  });
});
