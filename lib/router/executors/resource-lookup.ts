import type { Actor } from '../../contracts';
import type { TurnStep } from '../turn-plan';
import { modelTextSafe } from '../render/safety';

/** One owned item offered as a choice. `label` is server-built from CURRENT stored titles; `id` is the exact server id. */
export interface LookupCandidate { id: string; label: string }
export type LookupResource = 'dashboard' | 'result' | 'monitor';
export interface ResourceLookupPorts {
  /**
   * Owner-scoped search (title substring over the actor's OWN retained resources), newest first. `total` counts ALL matches; `items` is the
   * window [offset, offset + limit). `truncated` = the owner's retained set exceeded one bounded scan, so `total` is a lower bound.
   */
  search(actor: Actor, input: { resource: LookupResource; query: string; limit: number; offset?: number }): Promise<{ items: LookupCandidate[]; total: number; truncated?: boolean }>;
}
export const LOOKUP_LIMIT = 8;
const KIND_TEXT = { dashboard: 'Dashboard', result: 'ผลลัพธ์', monitor: 'Monitor' } as const;
/** Choice id/label size limit of the chat stream contract. */
const CHOICE_TEXT_MAX = 160;
/** A server-built "next page" choice id: `lookup-more:<resource>:<offset>:<query>`. It is stored with the turn's choices, so only server-issued ids resolve. */
const MORE_PREFIX = 'lookup-more:';

export function lookupMoreChoiceId(resource: LookupResource, offset: number, query: string): string {
  return `${MORE_PREFIX}${resource}:${offset}:${query}`.slice(0, CHOICE_TEXT_MAX);
}
export function parseLookupMoreChoiceId(id: string): { resource: LookupResource; offset: number; query: string } | undefined {
  if (!id.startsWith(MORE_PREFIX)) return undefined;
  const [resource, offset = '', ...rest] = id.slice(MORE_PREFIX.length).split(':');
  const query = rest.join(':').trim();
  if (resource !== 'dashboard' && resource !== 'result' && resource !== 'monitor') return undefined;
  if (!/^\d{1,6}$/.test(offset) || !query || query.length > 80) return undefined;
  return { resource, offset: Number(offset), query };
}

export type ResourceLookupResult =
  | { outcome: 'choices'; text: string; choices: LookupCandidate[]; about: string; missing: string[] }
  | { outcome: 'none'; text: string; about: string; missing: string[] }
  | { outcome: 'denied'; code: string; text: string };

/**
 * Answers a resource_lookup step: the actor's own matching resources as server-labelled choices. Nothing is selected or changed here; the user's
 * tap is verified again (owner + current permission) before the planner may reference the id. Counts are matches, never "all" when truncated.
 * PC-03: every match stays reachable — when more matches follow this window, the last slot is a server-built "next page" choice.
 */
export async function executeResourceLookupStep(input: { ports: ResourceLookupPorts | undefined; actor: Actor; step: Extract<TurnStep, { kind: 'resource_lookup' }>; offset?: number }): Promise<ResourceLookupResult> {
  if (!input.ports) return { outcome: 'denied', code: 'lookup_unavailable', text: 'ยังค้นหารายการเก่าในตอนนี้ไม่ได้ จึงไม่ได้ดำเนินการต่อ' };
  const { resource, query } = input.step;
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const found = await input.ports.search(input.actor, { resource, query, limit: LOOKUP_LIMIT, offset });
  const about = `lookup:${resource}`, missing = [`params.${resource}`];
  const noun = KIND_TEXT[resource];
  // G6: the name fragment is MODEL text echoed to the user: it passes the model-text gate, else the answer names no fragment.
  const named = modelTextSafe('lookup_query', query) ? `ที่ชื่อตรงกับ “${query}”` : 'ที่ชื่อตรงกับคำที่ค้นหา';
  if (!found.items.length) return { outcome: 'none', about, missing, text: `ไม่พบ${noun}ของคุณ${named}${offset ? 'เพิ่มเติม' : ''} — ลองใช้ชื่ออื่นหรือเปิดจากหน้า${noun === 'ผลลัพธ์' ? 'ผลลัพธ์' : noun}โดยตรง` };
  // G2: a "next page" is offered only when a found match follows this window, never just because the scan was truncated (that page would be empty).
  const hasMore = found.total > offset + found.items.length;
  const shown = hasMore ? found.items.slice(0, LOOKUP_LIMIT - 1) : found.items;
  const choices = distinctLabels(shown, offset);
  const totalText = found.truncated ? `อย่างน้อย ${found.total}` : `${found.total}`;
  if (hasMore) {
    const next = offset + shown.length;
    choices.push({ id: lookupMoreChoiceId(resource, next, query), label: `ดูรายการถัดไป (ลำดับที่ ${next + 1} เป็นต้นไป จาก ${totalText} รายการ)` });
  }
  const range = offset || hasMore ? ` (แสดงลำดับที่ ${offset + 1}–${offset + shown.length})` : '';
  const older = found.truncated && !hasMore ? ` — ยังมี${noun}ที่เก่ากว่านี้ซึ่งไม่ได้รวมในการค้นหาครั้งนี้` : '';
  return { outcome: 'choices', about, missing, choices, text: `พบ${noun}ของคุณ${named} ${totalText} รายการ${range}${older} โปรดเลือกรายการที่ต้องการ` };
}

/** Server-built disambiguation: labels that are still identical (same title, type, revision, time) get their position in the newest-first list. */
function distinctLabels(items: readonly LookupCandidate[], offset: number): LookupCandidate[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return items.map((item, index) => ({ id: item.id, label: fitLabel(item.label, (counts.get(item.label) ?? 0) > 1 ? ` · ลำดับที่ ${offset + index + 1}` : '') }));
}

/** Keeps the server-built suffix (type / revision / date / position) intact and shortens only the title part to the choice size limit. */
export function fitLabel(label: string, suffix = ''): string {
  const full = label + suffix;
  return full.length <= CHOICE_TEXT_MAX ? full : `${label.slice(0, CHOICE_TEXT_MAX - suffix.length - 1)}…${suffix}`;
}
