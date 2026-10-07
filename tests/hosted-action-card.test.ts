import { describe, expect, it } from 'vitest';
import { messageTextWithLinkedReceiptOutcome } from '@/components/biztania/product-labels';
import { stagedActionTitle, stagedConfirmLabel } from '@/components/biztania/router-ui';
import type { ConversationMessage, PendingAction, Receipt, ReceiptView } from '@/lib/contracts';

const at = '2026-10-06T04:05:06.000Z';
const action: PendingAction = {
  id: 'share-action-1', actorId: 'actor-1', sessionId: 'session-1', conversationId: 'conversation-1', turnId: 'turn-1',
  mode: 'live_ai', modeRevision: 1, payload: { kind: 'dashboard_share', dashboardId: 'dashboard-1', recipientId: 'recipient-1' },
  payloadHash: 'payload-hash', evidenceVersion: 'evidence-1', packs: [], createdAt: at, expiresAt: at,
  status: 'completed', preview: 'เตรียมแชร์ Dashboard — ยังไม่ดำเนินการ',
};
const message: ConversationMessage = {
  id: 'assistant-message-1', actorId: 'actor-1', conversationId: 'conversation-1', role: 'assistant',
  text: action.preview, mode: 'live_ai', modeRevision: 1, createdAt: at, pendingActionId: action.id,
};
function receipt(actionId: string, status: ReceiptView['status'], id = `receipt-${status}`): Receipt {
  return { id, actionId, actorId: 'actor-1', kind: 'dashboard_share', status,
    results: [{ targetId: 'recipient-1', id: 'share-1', status, detail: 'dashboard share result' }], createdAt: at,
    verifiedAt: status === 'pending' ? null : at };
}

describe('hosted action-card copy', () => {
  it('labels persisted preparation text as historical when its exact share receipt is verified', () => {
    const verified = receipt(action.id, 'verified_success');

    expect(messageTextWithLinkedReceiptOutcome(message, [action], [verified]))
      .toBe(`สถานะล่าสุด: สำเร็จแล้ว\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
  });

  it('labels a prior-session share from its exact actor-owned receipt without exposing current-session controls', () => {
    const verified = receipt(action.id, 'verified_success');
    expect(messageTextWithLinkedReceiptOutcome(message, [], [verified])).toBe(`สถานะล่าสุด: สำเร็จแล้ว\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
    expect(messageTextWithLinkedReceiptOutcome(message, [], [{ ...verified, actorId: 'other-actor' }])).toBe(message.text);
    expect(messageTextWithLinkedReceiptOutcome(message, [], [{ ...verified, kind: 'dashboard_create' }])).toBe(`สถานะล่าสุด: สำเร็จแล้ว\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
  });

  it('shows a failed terminal receipt as failed', () => {
    const failed = receipt(action.id, 'failed');

    expect(messageTextWithLinkedReceiptOutcome(message, [action], [failed]))
      .toBe(`สถานะล่าสุด: ไม่สำเร็จ\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
  });

  it('shows a denied terminal receipt as denied', () => {
    const denied = receipt(action.id, 'denied');

    expect(messageTextWithLinkedReceiptOutcome(message, [action], [denied]))
      .toBe(`สถานะล่าสุด: ถูกปฏิเสธ\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
  });

  it('keeps pending, partial, and unrelated outcomes from claiming completion', () => {
    const otherAction: PendingAction = { ...action, id: 'share-action-2' };
    const verified = receipt(action.id, 'verified_success');

    expect(messageTextWithLinkedReceiptOutcome(message, [action], [receipt(action.id, 'pending')])).toBe(message.text);
    expect(messageTextWithLinkedReceiptOutcome({ ...message, pendingActionIds: [action.id, otherAction.id] }, [action, otherAction], [verified])).toBe(message.text);
    expect(messageTextWithLinkedReceiptOutcome({ ...message, receiptId: 'another-receipt' }, [action], [receipt(action.id, 'verified_success', 'receipt-success')])).toBe(message.text);
    expect(messageTextWithLinkedReceiptOutcome(message, [action], [receipt('unrelated-action', 'verified_success')])).toBe(message.text);
    const restricted: ReceiptView = { visibility: 'restricted', id: 'restricted', actionId: action.id, status: 'verified_success', results: [], createdAt: at, verifiedAt: null, detail: 'permission limited' };
    expect(messageTextWithLinkedReceiptOutcome(message, [], [restricted])).toBe(message.text);
  });

  it('labels the Dashboard share-revocation review and confirmation', () => {
    expect(stagedActionTitle['dashboard.revoke_share']).toBe('เพิกถอนการแชร์ Dashboard');
    expect(stagedConfirmLabel['dashboard.revoke_share']).toBe('ยืนยันเพิกถอนการแชร์ Dashboard');
  });
});
