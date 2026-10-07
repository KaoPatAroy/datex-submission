import { describe, expect, it } from 'vitest';
import { canUseChat, withChatCapability } from '@/lib/core/chat-capability';
import { conciseTitle, actionName } from '@/components/biztania/product-labels';
import { isSafeConversationTitle } from '@/lib/router/render/safety';
import { turnPlanSchema } from '@/lib/router/turn-plan';
import { canonicalizeModelPlan } from '@/lib/router/planner/canonicalize';

const step = { kind: 'conversation', topic: 'greeting', prose: 'สวัสดีครับ' };

describe('conversation title (AI-authored, neutral fallback)', () => {
  it('fallback is neutral truncation: keywords have no effect', () => {
    const tail = 'x'.repeat(60);
    const a = conciseTitle(`revoke ${tail}`);
    const b = conciseTitle(`report ${tail}`);
    expect(a.length).toBe(b.length);
    expect(a.startsWith('revoke')).toBe(true);
    expect(conciseTitle('สร้าง Dashboard ยอดขาย')).toBe('สร้าง Dashboard ยอดขาย');
    expect(conciseTitle('  ')).toBe('บทสนทนาใหม่');
  });

  it('accepts an optional suggestedConversationTitle in the plan and drops malformed model values', () => {
    expect(turnPlanSchema.safeParse({ turnPlanVersion: 1, steps: [step], suggestedConversationTitle: 'ยอดขายรวม' }).success).toBe(true);
    const canon = canonicalizeModelPlan({ turnPlanVersion: 1, steps: [step], suggestedConversationTitle: '  ' }) as Record<string, unknown>;
    expect('suggestedConversationTitle' in canon).toBe(false);
  });

  it('server validates length and safety only', () => {
    expect(isSafeConversationTitle('ยอดขายรวมวันนี้', [])).toBe(true);
    expect(isSafeConversationTitle('ก'.repeat(61), [])).toBe(false);
    expect(isSafeConversationTitle('ก'.repeat(60), [])).toBe(true);
    expect(isSafeConversationTitle('ดู <b>ยอดขาย</b>', [])).toBe(false);
    expect(isSafeConversationTitle('ดู https://x.example', [])).toBe(false);
    expect(isSafeConversationTitle('ยอดขาย 120 ล้าน', [])).toBe(false);
    expect(isSafeConversationTitle('ยอดขายภาคตะวันออก', ['ภาคตะวันออก'])).toBe(false);
  });

  it('keeps English business terms in server copy', () => {
    expect(actionName('dashboard_create')).toBe('สร้าง Dashboard');
    expect(actionName('ticket_create')).toBe('สร้าง Ticket ติดตามสาขา');
  });

  it('canChat comes from the server capability descriptor, not permission names', () => {
    const base = [{ id: 'sales', title: 'Sales', allowed: true, tools: [], templates: [] }];
    expect(canUseChat({ capabilities: withChatCapability(base) })).toBe(true);
    expect(canUseChat({ capabilities: withChatCapability([{ ...base[0], allowed: false }]) })).toBe(false);
    expect(canUseChat({ capabilities: base })).toBe(false);
    const explicit = [{ id: 'concierge_chat', title: 'x', allowed: false, tools: [], templates: [] }, ...base];
    expect(canUseChat({ capabilities: withChatCapability(explicit) })).toBe(false);
  });
});
