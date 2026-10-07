import { describe, expect, it } from 'vitest';
import { CONVERSATIONAL_PROSE_MAX_CHARS, capabilityReply, isGreetingProse, isUngroundedSafeProse } from '../../lib/dynamic/response/conversational';

const entities = ['E01', 'สาขาบางนา', 'east', 'ภาคตะวันออก'];

describe('isUngroundedSafeProse (model-output safety gate)', () => {
  it('accepts a plain greeting', () => {
    expect(isUngroundedSafeProse('สวัสดีครับ มีอะไรให้ช่วยไหมครับ', entities)).toBe(true);
    expect(isUngroundedSafeProse('Hello! At least tell me what you need.', entities)).toBe(true);
  });
  it('rejects Arabic and Thai numerals', () => {
    expect(isUngroundedSafeProse('ยอดขายประมาณ 5,000 บาท', entities)).toBe(false);
    expect(isUngroundedSafeProse('ยอดขาย ๕๐๐ บาท', entities)).toBe(false);
  });
  it('rejects Thai and English number words in model prose', () => {
    for (const prose of ['มีหนึ่งทางเลือก', 'ยอดขายหลายล้านบาท', 'คิดเป็นเปอร์เซ็นต์', 'one option is available',
      'sales rose by ten percent', 'hundreds of branches']) expect(isUngroundedSafeProse(prose, entities)).toBe(false);
  });
  it('rejects catalog entities (branch id, branch name, region code, region label)', () => {
    expect(isUngroundedSafeProse('สาขาที่ดีที่สุดคือ e01', entities)).toBe(false);
    expect(isUngroundedSafeProse('สาขาบางนาขายดี', entities)).toBe(false);
    expect(isUngroundedSafeProse('The East region is strong', entities)).toBe(false);
    expect(isUngroundedSafeProse('ภาคตะวันออกขายดี', entities)).toBe(false);
  });
  it('rejects empty and over-long prose', () => {
    expect(isUngroundedSafeProse('   ', entities)).toBe(false);
    expect(isUngroundedSafeProse('ก'.repeat(CONVERSATIONAL_PROSE_MAX_CHARS + 1), entities)).toBe(false);
  });
});

describe('capabilityReply exact labels', () => {
  it('advertises only the areas of tools the actor holds', () => {
    const reply = capabilityReply(['incidents.search']);
    expect(reply).toContain('เหตุการณ์');
    for (const absent of ['สต็อก', 'ยอดขาย', 'กำลังคน', 'พนักงาน', 'Dashboard']) expect(reply).not.toContain(absent);
    const stockOnly = capabilityReply(['operations.query_inventory']);
    expect(stockOnly).toContain('สต็อก');
    expect(stockOnly).not.toContain('เหตุการณ์');
  });
  it('lists HR admin areas and none for an empty catalog', () => {
    const reply = capabilityReply(['hr.find_employee', 'workflow.director_queue']);
    expect(reply).toContain('ข้อมูลพนักงาน');
    expect(reply).toContain('คิวงานและการอนุมัติ');
    expect(reply).not.toContain('ยอดขาย');
    expect(capabilityReply([])).toContain('ยังไม่มีสิทธิ์');
  });
  it('appends a fixed limits paragraph that stays free of digits and entity words', () => {
    const reply = capabilityReply(['incidents.search']);
    expect(reply).toContain('ขอบเขตการทำงาน');
    expect(reply).toContain('ยืนยัน');
    expect(reply).toContain('ส่ง Email จริง');
    expect(/\p{N}/u.test(reply)).toBe(false);
    expect(reply.split('\n').length).toBeLessThanOrEqual(8);
    expect(capabilityReply([])).not.toContain('ขอบเขตการทำงาน');
  });
  it('joins three or more areas with commas and a final และ', () => {
    const reply = capabilityReply(['incidents.search', 'operations.query_inventory', 'hr.find_employee']);
    expect(reply).toContain(', ');
    expect(reply.match(/ และ /g)).toHaveLength(1);
    expect(reply).toMatch(/, [^,]+ และ [^,—]+ —/);
  });
  it('greets only on the first turn and gives later turns a helpful capability clarification', () => {
    expect(capabilityReply(['sales.query_metrics'], true)).toMatch(/^สวัสดีครับ/u);
    const later = capabilityReply(['sales.query_metrics'], false);
    expect(later).toContain('ยอดขาย');
    expect(later).toContain('ต้องการให้ช่วยดูส่วนไหน');
    expect(later).not.toContain('สวัสดีครับ');
    expect(isGreetingProse('Hello, how can I help?')).toBe(true);
    expect(isGreetingProse('ผมช่วยดูช่วงเวลาที่ต้องการได้ครับ')).toBe(false);
  });
});
