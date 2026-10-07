import { describe, expect, it } from 'vitest';
import { keyOf, scanRepository, scanVirtual } from './user-text-scan';
import { LEGACY_USER_TEXT_OFFENDERS } from './user-text-legacy-allowlist';

const root = process.cwd();
const branded = (body: string) => `import type { UserText } from '@/lib/router/user-text';\n${body}`;
const scan = (source: string, file = 'lib/core/fixture.ts') => scanVirtual(root, { [file]: source }).map(v => v.rule);

describe('user-text scanner (self test)', { timeout: 60_000 }, () => {
  it.each([
    ['member call', 'export const f = (m: UserText) => m.toLowerCase();', 'string-method:toLowerCase'],
    ['trim launders the brand', 'export const f = (m: UserText) => m.trim();', 'brand:member:trim'],
    ['regex input', 'export const f = (m: UserText) => /x/u.test(m);', 'arg-of:test'],
    ['template span', 'export const f = (m: UserText) => `${m}`;', 'brand:template'],
    ['literal comparison', "export const f = (m: UserText) => m === 'yes';", 'brand:compare-literal'],
    ['cast away', 'export const f = (m: UserText) => m as string;', 'brand:cast'],
    ['switch', "export const f = (m: UserText) => { switch (m) { default: return 1; } };", 'brand:switch'],
    ['new RegExp', 'export const f = (m: UserText) => new RegExp(m);', 'arg-of:new RegExp'],
  ])('flags branded %s', (_name, body, rule) => {
    expect(scan(branded(body))).toContain(rule);
  });
  it('flags unbranded legacy-style gates through assignment and helper-call taint', () => {
    const rules = scan(`
      const lower = (t: string) => t.toLowerCase();
      export const viaHelper = (message: string) => lower(message);
      export function gate(message: string) {
        const text = message.normalize('NFKC');
        return /revoke/.test(text);
      }
    `);
    expect(rules).toEqual(expect.arrayContaining(['string-method:normalize', 'arg-of:test', 'string-method:toLowerCase']));
  });
  it('allows length, passing through, hashing and allowlisted span location', () => {
    expect(scan(branded('export const size = (m: UserText) => m.length; export const pass = (m: UserText) => [m];'))).toEqual([]);
    expect(scan(branded('export function resolveSpan(m: UserText, s: string) { return m.indexOf(s); }'))).toEqual([]);
    expect(scan(branded('export function assertUserTextSize(m: UserText) { return m.trim().length; }'))).toEqual([]);
    expect(scan("export const f = (label: string) => label.toLowerCase().includes('x');")).toEqual([]);
    expect(scan('export const f = (m: string) => m.toLowerCase();', 'lib/router/scripted-turn-planner.ts')).toEqual([]);
  });
});

describe('repository user-text guard', () => {
  let cache: ReturnType<typeof scanRepository> | undefined;
  const found = () => (cache ??= scanRepository(root));

  it('reports exactly the allowlisted legacy offenders (new offenders fail; U9 must empty the allowlist)', () => {
    const keys = found().map(keyOf);
    const allowed = new Set(LEGACY_USER_TEXT_OFFENDERS);
    const fresh = keys.filter(k => !allowed.has(k));
    const stale = LEGACY_USER_TEXT_OFFENDERS.filter(k => !keys.includes(k));
    expect(fresh, `NEW code interprets user text (the server must only locate evidence spans):\n${fresh.join('\n')}`).toEqual([]);
    expect(stale, `Allowlist entries no longer offend - remove them:\n${stale.join('\n')}`).toEqual([]);
  }, 120_000);

  it('still detects the known legacy gates so the allowlist cannot silently hide a broken scanner', () => {
    const files = new Set(found().map(v => v.file));
    for (const file of ['lib/core/intents.ts', 'lib/core/preparation-policy.ts', 'lib/core/clarification-plan.ts', 'lib/core/service.ts', 'lib/packs/retail/answer.ts']) {
      if (LEGACY_USER_TEXT_OFFENDERS.some(k => k.startsWith(`${file}:`))) expect(files.has(file), file).toBe(true);
    }
  }, 120_000);

  it('keeps the new router code clean', () => {
    expect(found().filter(v => v.file.startsWith('lib/router/'))).toEqual([]);
  }, 120_000);
});
