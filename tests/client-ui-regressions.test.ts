import { describe, expect, it } from 'vitest';
import { composerGuidance, composerConversationId, receiptsForMessage, type ConversationReceipt } from '../components/biztania/conversation-ui';
import { messageTextWithLinkedReceiptOutcome } from '../components/biztania/product-labels';
import { MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY } from '../components/biztania/monitor-data';
import { isStandaloneHistoryEvent } from '../components/biztania/history-panel';
import type { ConversationMessage, PendingAction, Receipt } from '../lib/contracts';

describe('conversation UI after reload', () => {
  it('sends to the conversation currently displayed in the transcript', () => {
    expect(composerConversationId({ activeConversationId: 'visible-conversation', selectedConversationId: null, recentConversationId: 'other-conversation', newConversation: false }))
      .toBe('visible-conversation');
    expect(composerConversationId({ activeConversationId: null, selectedConversationId: null, recentConversationId: 'other-conversation', newConversation: true })).toBeUndefined();
  });

  it('reattaches persisted receipts to the exact conversation turn', () => {
    const receipt: ConversationReceipt = { id: 'receipt-1', actionId: 'monitor.create', completedAt: 1,
      conversationId: 'conversation-1', turnId: 'turn-1', receipt: { kind: 'monitor', title: 'สร้าง Monitor', headline: 'บันทึกแล้ว', verifiedAt: '2026-10-07T00:00:00.000Z' } };
    expect(receiptsForMessage({ conversationId: 'conversation-1', turnId: 'turn-1' }, [receipt])).toEqual([receipt]);
    expect(receiptsForMessage({ conversationId: 'conversation-2', turnId: 'turn-1' }, [receipt])).toEqual([]);
  });

  it('uses truthful composer guidance without promising confirmation for every action', () => {
    expect(composerGuidance).toBe('ระบบตรวจสิทธิ์และข้อมูลก่อนดำเนินการ');
  });
});

describe('prepared action copy across receipt kinds', () => {
  it('shows a successful ticket receipt as the latest outcome', () => {
    const at = '2026-10-07T00:00:00.000Z';
    const action: PendingAction = {
      id: 'ticket-action', actorId: 'actor', sessionId: 'session', conversationId: 'conversation', turnId: 'turn',
      mode: 'live_ai', modeRevision: 1, payload: { kind: 'ticket_create', scope: { region: 'east', date: '2026-10-07' }, targets: [] },
      payloadHash: 'hash', evidenceVersion: 'version', packs: [], createdAt: at, expiresAt: at, status: 'completed', preview: 'เตรียม Ticket — ยังไม่ดำเนินการ',
    };
    const message: ConversationMessage = {
      id: 'message', actorId: 'actor', conversationId: 'conversation', turnId: 'turn', role: 'assistant', text: action.preview,
      mode: 'live_ai', modeRevision: 1, createdAt: at, pendingActionId: action.id,
    };
    const receipt: Receipt = { id: 'receipt', actionId: action.id, actorId: 'actor', kind: 'ticket_create', status: 'verified_success',
      results: [], createdAt: at, verifiedAt: at };

    expect(messageTextWithLinkedReceiptOutcome(message, [action], [receipt]))
      .toBe(`สถานะล่าสุด: สำเร็จแล้ว\nข้อความเมื่อเตรียมรายการ:\n${message.text}`);
  });

  it('keeps prepare-only audit events out of executed and read history lists', () => {
    const prepare = { id: 'prepare', actorId: 'actor', category: 'prepare', summary: 'Prepared change', createdAt: '2026-10-07T00:00:00.000Z' };
    const read = { ...prepare, id: 'read', category: 'read' };

    expect(isStandaloneHistoryEvent(prepare)).toBe(false);
    expect(isStandaloneHistoryEvent(read)).toBe(true);
  });

  it('warns that a Monitor change may be saved after the follow-up read fails', () => {
    expect(MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY).toContain('การเปลี่ยนแปลงล่าสุดอาจบันทึกแล้ว');
    expect(MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY).toContain('โปรดตรวจสอบก่อนทำซ้ำ');
    expect(MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY).toContain('ลองอีกครั้ง');
  });
});
