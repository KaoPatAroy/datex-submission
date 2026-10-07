import { z } from 'zod';
import { MAX_CHAT_STREAM_TEXT_BYTES } from '../chat-stream-contracts';

const factId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/);
const layouts = ['paragraph', 'lines', 'bullets', 'numbered'] as const;
const tones = ['neutral', 'brief', 'formal'] as const;
export const narrativePlanSchema = z.object({
  layout: z.enum(layouts), tone: z.enum(tones),
  phrasing: z.enum(['direct', 'concise', 'explanatory']),
  factIds: z.array(factId).min(1).max(64),
  emphasis: z.enum(['none', 'figures', 'limitations']),
}).strict();
export type NarrativePlan = z.infer<typeof narrativePlanSchema>;

export const factPacketSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['aggregate', 'branch_detail', 'ranking', 'clarification', 'pending_action_refinement']),
  facts: z.array(z.object({
    id: factId, text: z.string().trim().min(1).max(1500),
    category: z.enum(['scope', 'metric', 'source', 'ranking_rule', 'limitation', 'clarification', 'relationship', 'branch']),
    sourceIds: z.array(z.string().min(1).max(200)).max(60),
    sourceLabels: z.array(z.string().min(1).max(100)).max(12),
  }).strict()).min(1).max(64),
  sources: z.array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(100) }).strict()).max(60),
  requiredFactIds: z.array(factId).min(1).max(64),
  defaultLayout: z.enum(layouts),
}).strict().superRefine((packet, context) => {
  const ids = packet.facts.map(fact => fact.id);
  if (new Set(ids).size !== ids.length || ids.length !== packet.requiredFactIds.length
    || ids.some((id, index) => id !== packet.requiredFactIds[index])) {
    context.addIssue({ code: 'custom', message: 'Required facts must match the complete locked fact order' });
  }
  const sources = new Map(packet.sources.map(source => [source.id, source.label]));
  if (sources.size !== packet.sources.length) context.addIssue({ code: 'custom', message: 'Duplicate sources' });
  for (const fact of packet.facts) {
    const labels = [...new Set(fact.sourceIds.map(id => sources.get(id)))];
    if (new Set(fact.sourceIds).size !== fact.sourceIds.length || labels.some(label => label === undefined)
      || labels.length !== fact.sourceLabels.length || labels.some((label, index) => label !== fact.sourceLabels[index])) {
      context.addIssue({ code: 'custom', message: 'Fact sources must match the server source registry' });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > MAX_CHAT_STREAM_TEXT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Fact packet exceeds the stream byte limit' });
  }
});
export type FactPacket = z.infer<typeof factPacketSchema>;
export type PacketFact = FactPacket['facts'][number];

export function defaultNarrativePlan(packet: FactPacket): NarrativePlan {
  const validated = factPacketSchema.parse(packet);
  return {
    layout: validated.defaultLayout,
    tone: validated.kind === 'clarification' || validated.kind === 'branch_detail' ? 'brief' : 'neutral',
    factIds: [...validated.requiredFactIds], emphasis: 'none', phrasing: 'direct',
  };
}

function render(packet: FactPacket, plan: NarrativePlan): string {
  const texts = packet.facts.map(fact => {
    let text = fact.text;
    if (plan.phrasing === 'concise' && fact.category === 'source') text = text.replace(/^แหล่งข้อมูล:/, 'อ้างอิง:');
    if (plan.phrasing === 'explanatory') {
      const prefix: Partial<Record<PacketFact['category'], string>> = {
        metric: 'ข้อมูลที่ตรวจสอบได้: ', scope: 'ขอบเขตข้อมูล: ',
        limitation: 'ข้อจำกัดของคำตอบ: ', branch: 'ข้อมูลสาขาที่เลือก: ',
      };
      text = `${prefix[fact.category] ?? ''}${text}`;
    }
    const emphasize = plan.emphasis === 'figures' && fact.category === 'metric'
      || plan.emphasis === 'limitations' && fact.category === 'limitation';
    return emphasize ? `${fact.category === 'metric' ? 'ตัวเลขสำคัญ' : 'ข้อจำกัดที่ควรพิจารณา'}: ${text}` : text;
  });
  const body = plan.layout === 'paragraph' ? texts.join(' ')
    : plan.layout === 'bullets' ? texts.map(text => `• ${text}`).join('\n')
    : plan.layout === 'numbered' && packet.kind !== 'ranking' ? texts.map((text, index) => `${index + 1}. ${text}`).join('\n')
    : texts.join('\n');
  const introduction = plan.tone === 'formal' ? 'ข้อมูลตามหลักฐานที่ตรวจสอบได้:\n'
    : plan.tone === 'neutral' && packet.kind === 'aggregate' ? 'สรุปจากข้อมูลที่มีสิทธิ์ดู: ' : '';
  return `${introduction}${body}`;
}

/** Candidate authority stops at formatting enums and the complete locked fact IDs. */
export function renderFactPacket(packet: FactPacket, candidate: unknown): { text: string; accepted: boolean } {
  const parsedPacket = factPacketSchema.safeParse(packet);
  if (!parsedPacket.success) return { text: 'ยังไม่สามารถตรวจสอบชุดข้อเท็จจริงนี้ได้ โปรดระบุขอบเขตคำถามให้แคบลง', accepted: false };
  const approved = parsedPacket.data;
  const parsedPlan = narrativePlanSchema.safeParse(candidate);
  const validOrder = parsedPlan.success && parsedPlan.data.factIds.length === approved.requiredFactIds.length
    && parsedPlan.data.factIds.every((id, index) => id === approved.requiredFactIds[index]);
  if (parsedPlan.success && validOrder) {
    const text = render(approved, parsedPlan.data);
    if (new TextEncoder().encode(text).byteLength <= MAX_CHAT_STREAM_TEXT_BYTES) return { text, accepted: true };
  }
  const text = render(approved, defaultNarrativePlan(approved));
  return new TextEncoder().encode(text).byteLength <= MAX_CHAT_STREAM_TEXT_BYTES
    ? { text, accepted: false }
    : { text: 'คำตอบเกินขอบเขตความยาวที่ตรวจสอบได้ โปรดระบุจำนวนสาขาหรือข้อมูลที่ต้องการให้น้อยลง', accepted: false };
}
