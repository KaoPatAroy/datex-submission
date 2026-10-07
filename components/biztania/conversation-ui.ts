export interface ConversationReceipt {
  id: string; actionId: string; completedAt: number; conversationId: string; turnId: string;
  receipt: { kind: string; title: string; headline: string; verifiedAt: string };
}

export function composerConversationId(input: {
  activeConversationId: string | null; selectedConversationId: string | null; recentConversationId: string | undefined; newConversation: boolean;
}) {
  return input.newConversation ? undefined : input.activeConversationId ?? input.selectedConversationId ?? input.recentConversationId;
}

export function receiptsForMessage(message: { conversationId: string; turnId?: string }, receipts: readonly ConversationReceipt[]) {
  if (!message.turnId) return [];
  return receipts.filter(receipt => receipt.conversationId === message.conversationId && receipt.turnId === message.turnId);
}

export const composerGuidance = 'ระบบตรวจสิทธิ์และข้อมูลก่อนดำเนินการ';
