/**
 * G5 item 6: does OUR code corrupt multi-byte Thai? Every transport hop that decodes bytes is fed the Thai UTF-8 split at EVERY byte boundary
 * (each Thai code point is 3 bytes, so 1-byte chunks split every character, including the combining tone / vowel marks):
 *  - the browser SSE reader (consumeChatStream: TextDecoder with stream:true, frames split mid-line and mid-character);
 *  - the planner provider path (OpenAI SDK non-streaming body -> JSON -> parseTurnPlan: fence extraction, Thai mark normalization, canonicalization).
 * Both reproduce the exact model text, so dropped marks such as "ตองการ" / "ผ้ใช้" are the model's (the G5 live probe also compared the raw gateway
 * bytes, decoded with a fatal decoder, to the SDK string: valid and identical in every one of 73 live calls, including "ตองการให Dashboard ใหม"). Such text is caught by hasMalformedThai instead.
 */
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { chatStreamEventSchema, encodeChatStreamEvent, type ChatStreamEvent } from '@/lib/chat-stream-contracts';
import { consumeChatStream } from '@/components/biztania/stream-client';
import { parseTurnPlan } from '@/lib/router/planner/parse';

const THAI = 'ต้องการให้ Dashboard ใหม่มีชื่ออะไรครับ ผู้ใช้ต่ำกว่าขั้นต่ำ ที่ นั้น เพิ่ม เข้า ได้นะ แชร์ ติดตาม';
const REQUEST_KEY = 'thai-utf8-transport-request-001';
const FOLLOW_UP = 'ดูผู้ใช้ที่ยอดต่ำกว่าขั้นต่ำได้ไหม';

function event(value: unknown): ChatStreamEvent { return chatStreamEventSchema.parse(value); }
function oneByteChunks(text: string): Uint8Array[] { return [...new TextEncoder().encode(text)].map(byte => Uint8Array.of(byte)); }
function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}

describe('Thai UTF-8 survives every transport hop split at every byte boundary', () => {
  it('SSE reader: deltas and the completed response keep every mark (1-byte chunks)', async () => {
    const card = { kind: 'dashboard_organize' as const, title: 'ปักหมุด Dashboard', headline: `ปักหมุด Dashboard “${THAI.slice(0, 20)}” แล้ว`,
      fields: [{ label: 'Dashboard', value: THAI.slice(0, 20) }], verifiedAt: '2026-10-02T05:00:00.000Z' };
    const events = [
      event({ streamVersion: 1, sequence: 1, type: 'turn.started', requestKey: REQUEST_KEY, conversationId: 'c-thai', turnId: 't-thai', assistantMessageId: 'a-thai', mode: 'live_ai', replayed: false }),
      event({ streamVersion: 1, sequence: 2, type: 'text.delta', text: THAI }),
      event({ streamVersion: 1, sequence: 3, type: 'turn.completed', response: { conversationId: 'c-thai', turnId: 't-thai', assistantMessageId: 'a-thai', message: THAI,
        mode: 'live_ai', replayed: false, receiptCards: [card] } }),
    ];
    const seen: ChatStreamEvent[] = [];
    const final = await consumeChatStream(stream(oneByteChunks(events.map(encodeChatStreamEvent).join(''))), REQUEST_KEY, e => seen.push(e));
    expect(final.message).toBe(THAI);
    expect((final as { receiptCards?: unknown }).receiptCards).toEqual([card]);
    expect(seen.find(e => e.type === 'text.delta')).toMatchObject({ text: THAI });
  });

  it('planner provider path: the SDK body read in 1-byte chunks, then parseTurnPlan, returns the exact model Thai', async () => {
    const content = '```json\n' + JSON.stringify({ turnPlanVersion: 1, steps: [{ kind: 'clarify', about: { kind: 'query' }, missing: [{ slot: 'time', reason: 'absent' }],
      question: THAI, choices: [] }], followUps: [FOLLOW_UP] }) + '\n```';
    const body = JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
    const client = new OpenAI({ apiKey: 'test-key', baseURL: 'http://gateway.test/v1', maxRetries: 0,
      fetch: async () => new Response(stream(oneByteChunks(body)), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const completion = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(completion.choices[0]!.message.content).toBe(content);
    const parsed = parseTurnPlan(completion.choices[0]!.message.content);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.plan.steps[0]).toMatchObject({ kind: 'clarify', question: THAI });
    expect(parsed.plan.followUps).toEqual([FOLLOW_UP]);
  });
});
