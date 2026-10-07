import { describe, expect, it } from 'vitest';
import { paginate, pageInputFrom } from '@/lib/pagination';

const items = Array.from({ length: 25 }, (_, i) => ({ k: `2026-10-01|${String(i).padStart(3, '0')}` }));
const first = (bind?: string) => paginate(items, i => i.k, { ...(bind !== undefined ? { bind } : {}) }, { limit: 10 });

/** FW-B: cursors are signed and bound to the actor + filter scope. */
describe('signed, bound pagination cursors', () => {
  it('a cursor minted for a scope continues in that scope', () => {
    const a = first('actor-a|unread');
    expect(a.nextCursor).toMatch(/\.[A-Za-z0-9_-]{22}$/);
    const b = paginate(items, i => i.k, { cursor: a.nextCursor, bind: 'actor-a|unread' }, { limit: 10 });
    expect(b.items).toHaveLength(10);
    expect(b.items[0]!.k < a.items.at(-1)!.k).toBe(true);
  });

  it('a forged cursor (hand-made position, tampered body or tag) is refused', () => {
    const a = first('s');
    const [body, tag] = a.nextCursor!.split('.') as [string, string];
    const forgedKey = Buffer.from('0000|zzz', 'utf8').toString('base64url');
    for (const cursor of [forgedKey, `${forgedKey}.${tag}`, `${body}.${'A'.repeat(22)}`, Buffer.from('2026-10-01|005', 'utf8').toString('base64url')])
      expect(() => paginate(items, i => i.k, { cursor, bind: 's' }, { limit: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });

  it('a cursor replayed under another actor or another filter is refused', () => {
    const cursor = first('actor-a|filter-1').nextCursor!;
    for (const bind of ['actor-b|filter-1', 'actor-a|filter-2', ''])
      expect(() => paginate(items, i => i.k, { cursor, bind }, { limit: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });

  it('pageInputFrom carries the bind scope', () => {
    expect(pageInputFrom(new URLSearchParams('limit=5&cursor=abc'), 'scope')).toEqual({ cursor: 'abc', limit: 5, bind: 'scope' });
  });
});
