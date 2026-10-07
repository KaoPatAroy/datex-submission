import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from './core/errors';

/**
 * Bounded keyset pagination over ALREADY RETAINED records (no retention or storage change). Callers filter/search first, so a page
 * boundary never hides a matching older record, and `total` is the exact size of the filtered set (never the page length).
 * The cursor is the sort key of the last returned item; the next page is everything strictly after it (stable while newer rows arrive).
 */
export interface Page<T> { items: T[]; /** exact size of the filtered set */ total: number; nextCursor: string | null }
export interface PageInput {
  cursor?: string | null; limit?: number;
  /** Query scope the cursor is bound to (actor id + every filter that changes the selection). A cursor minted for another scope is refused. */
  bind?: string;
}

/**
 * Cursors are signed (HMAC-SHA256 over the scope + sort key) so a client can neither forge a position nor replay one across another
 * actor/filter. Key: the configured DEMO_SESSION_SECRET (at least 32 characters), the same secret and the same fail-closed configuration error as
 * sessions (lib/server/session.ts), so every instance signs alike. There is no per-process fallback key.
 */
const signingKey = (): string => {
  const configured = process.env.DEMO_SESSION_SECRET;
  invariant(configured && configured.length >= 32, 'CONFIGURATION', 'ยังไม่พร้อมให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแล', 503);
  return configured;
};
const mac = (bind: string, key: string): string => createHmac('sha256', signingKey()).update(JSON.stringify(['pagination-cursor-v1', bind, key])).digest('base64url').slice(0, 22);
const invalidCursor = () => new DomainError('INVALID_CURSOR', 'ตัวชี้หน้าถัดไปไม่ถูกต้อง', 400);
const encode = (key: string, bind: string): string => `${Buffer.from(key, 'utf8').toString('base64url')}.${mac(bind, key)}`;
function decode(cursor: string, bind: string): string {
  if (!/^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{22}$/u.test(cursor)) throw invalidCursor();
  const [body, tag] = cursor.split('.') as [string, string];
  const key = Buffer.from(body, 'base64url').toString('utf8');
  const expected = Buffer.from(mac(bind, key)), given = Buffer.from(tag);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalidCursor();
  return key;
}
/** Sort descending by `keyOf` (display order = newest first) and return one bounded page. */
export function paginate<T>(items: readonly T[], keyOf: (item: T) => string, input: PageInput, defaults: { limit: number; max?: number }): Page<T> {
  const max = defaults.max ?? 100;
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? defaults.limit) || defaults.limit, max));
  const sorted = items.map(item => ({ item, key: keyOf(item) })).sort((a, b) => b.key < a.key ? -1 : b.key > a.key ? 1 : 0);
  const bind = input.bind ?? '';
  const after = input.cursor ? decode(input.cursor, bind) : undefined;
  const rest = after === undefined ? sorted : sorted.filter(entry => entry.key < after);
  const slice = rest.slice(0, limit);
  const nextCursor = rest.length > limit ? encode(slice[slice.length - 1]!.key, bind) : null;
  return { items: slice.map(entry => entry.item), total: sorted.length, nextCursor };
}
/** Reads `?cursor=&limit=` (limit clamped by `paginate`). */
export function pageInputFrom(params: URLSearchParams, bind?: string): PageInput {
  const limit = Number(params.get('limit'));
  const cursor = params.get('cursor');
  return { ...(cursor ? { cursor } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), ...(bind !== undefined ? { bind } : {}) };
}
export const sortKey = (at: string, id: string): string => `${at}|${id}`;
