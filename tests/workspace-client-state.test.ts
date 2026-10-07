import { describe, expect, it } from 'vitest';
import {
  beginConversationReceiptLoad,
  finishConversationReceiptLoad,
  parseRouterReceiptPage,
  reconcileDashboardTaskTarget,
  type ConversationReceiptLoadState,
} from '@/lib/dashboards/workspace-client-state';
import type { ConversationReceipt } from '@/components/biztania/conversation-ui';

const receipt: ConversationReceipt = {
  id: 'receipt-1', actionId: 'monitor.create', completedAt: 1, conversationId: 'conversation-a', turnId: 'turn-a',
  receipt: { kind: 'monitor', title: 'สร้าง Monitor', headline: 'บันทึกแล้ว', verifiedAt: '2026-10-07T00:00:00.000Z' },
};
const emptyReceiptState: ConversationReceiptLoadState = { scopeKey: null, requestId: 0, items: [], hasOlder: false, error: false };

describe('workspace client state', () => {
  it('keeps the last good conversation receipts and exposes retry after a failed fetch', () => {
    const scopeKey = JSON.stringify(['actor-a', 'session-a', 'conversation-a']);
    const loaded = finishConversationReceiptLoad(beginConversationReceiptLoad(emptyReceiptState, scopeKey, 1), scopeKey, 1, { items: [receipt], nextCursor: 'older' });
    const failed = finishConversationReceiptLoad(beginConversationReceiptLoad(loaded, scopeKey, 2), scopeKey, 2, null);

    expect(failed).toMatchObject({ items: [receipt], hasOlder: true, error: true });
  });

  it('ignores a receipt response from an older conversation request', () => {
    const oldScope = JSON.stringify(['actor-a', 'session-a', 'conversation-a']);
    const newScope = JSON.stringify(['actor-a', 'session-a', 'conversation-b']);
    const state = beginConversationReceiptLoad(emptyReceiptState, newScope, 2);

    expect(finishConversationReceiptLoad(state, oldScope, 1, { items: [receipt], nextCursor: null })).toBe(state);
  });

  it('validates each receipt and retains the page cursor', () => {
    const valid = parseRouterReceiptPage({ receipts: [receipt], total: 2, nextCursor: 'older' });
    expect(valid).toMatchObject({ items: [receipt], total: 2, nextCursor: 'older' });
    expect(parseRouterReceiptPage({ receipts: [{ ...receipt, receipt: { ...receipt.receipt, headline: 4 } }] })).toBeNull();
  });

  it('clears a task-options target when its actor session or Dashboard is stale', () => {
    const target = { dashboardId: 'dashboard-a', title: 'Sales', actorId: 'actor-a', sessionId: 'session-a' };

    expect(reconcileDashboardTaskTarget(target, { id: 'actor-a', sessionId: 'session-a' }, ['dashboard-a'])).toEqual(target);
    expect(reconcileDashboardTaskTarget(target, { id: 'actor-a', sessionId: 'session-b' }, ['dashboard-a'])).toBeNull();
    expect(reconcileDashboardTaskTarget(target, { id: 'actor-a', sessionId: 'session-a' }, [])).toBeNull();
  });
});
