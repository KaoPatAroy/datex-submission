import { describe, expect, it } from 'vitest';
import { actionName, messageTextWithLinkedReceiptOutcome, operationLabel, regionName } from '@/components/biztania/product-labels';
import type { ActionKind, ConversationMessage, Receipt } from '@/lib/contracts';

const kinds: [ActionKind, string][] = [
  ['dashboard_create', 'สร้าง Dashboard'], ['dashboard_share', 'แชร์ Dashboard'],
  ['ticket_create', 'สร้าง Ticket ติดตามสาขา'], ['badge_revoke', 'เพิกถอนบัตรพนักงาน'], ['demo_update', 'เปลี่ยนข้อมูลตัวอย่าง'],
];
const message: ConversationMessage = { id: 'message', actorId: 'actor', conversationId: 'conversation', turnId: 'turn', role: 'assistant',
  text: 'เตรียมรายการแล้ว รอคุณยืนยัน', mode: 'live_ai', modeRevision: 1, createdAt: '2026-10-07T00:00:00.000Z', pendingActionId: 'action' };

describe('Thai product labels', () => {
  it.each(kinds)('labels receipt kind %s and reflects its exact linked outcome', (kind, label) => {
    const receipt: Receipt = { id: 'receipt', actorId: 'actor', actionId: 'action', kind, status: 'verified_success', results: [], createdAt: message.createdAt, verifiedAt: message.createdAt };
    expect(actionName(kind)).toBe(label);
    expect(messageTextWithLinkedReceiptOutcome(message, [], [receipt])).toBe(`สถานะล่าสุด: สำเร็จแล้ว\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
    expect(messageTextWithLinkedReceiptOutcome(message, [], [{ ...receipt, status: 'failed' }])).toContain('สถานะล่าสุด: ไม่สำเร็จ');
    expect(messageTextWithLinkedReceiptOutcome(message, [], [{ ...receipt, status: 'denied' }])).toContain('สถานะล่าสุด: ถูกปฏิเสธ');
    expect(messageTextWithLinkedReceiptOutcome(message, [], [{ ...receipt, status: 'pending' }])).toBe(message.text);
  });

  it('uses a Thai fallback instead of unknown historical receipt kinds', () => {
    expect(actionName('future_internal_kind' as ActionKind)).toBe('รายการดำเนินการ');
  });
  it('uses a Thai fallback instead of unknown operation codes', () => {
    expect(operationLabel('future_internal_operation')).toBe('วิธีคำนวณอื่น');
  });

  it.each([['east', 'ภาคตะวันออก'], ['central', 'ภาคกลาง'], ['south', 'ภาคใต้'], ['all', 'ทุกภูมิภาค']])('displays canonical region %s in Thai', (id, label) => {
    expect(regionName(id)).toBe(label);
  });
});
