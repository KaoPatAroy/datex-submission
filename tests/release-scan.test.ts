import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs release script without type declarations
import { trackedLineFindings } from '../scripts/release-scan.mjs';

const scan = trackedLineFindings as (file: string, line: string) => string[];
// Fixture lines are assembled at runtime so this tracked test file never contains a literal assignment the release scan itself would flag.
const assign = (key: string, value: string, prefix = '') => `${prefix}${key} = "${value}"`;
const SECRET = ['sec', 'ret'].join('');
const AUTH_TOKEN = ['auth', '_token'].join('');
const API_KEY = ['api', '_key'].join('');
const SESSION = ['DEMO_SESSION', '_SECRET'].join('');

describe('release scan env(NAME) placeholder', () => {
  it('accepts a Supabase CLI env(NAME) reference in supabase/config.toml only', () => {
    expect(scan('supabase/config.toml', assign(SECRET, 'env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)'))).toEqual([]);
    expect(scan('supabase\\config.toml', assign(AUTH_TOKEN, 'env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)'))).toEqual([]);
  });

  it('still flags an env(...)-shaped literal secret anywhere else', () => {
    expect(scan('lib/config.ts', assign(SECRET, 'env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)', 'const '))).toEqual(['generic secret assignment']);
    expect(scan('supabase/other.toml', assign(API_KEY, 'env(OPENAI_API_KEY_VALUE)'))).toEqual(['generic api_key assignment']);
    expect(scan('scripts/deploy.mjs', assign(SESSION, 'env(DEMO_SESSION)'))).toContain('non-placeholder DEMO_SESSION_SECRET assignment');
  });

  it('still flags a real-looking value inside supabase/config.toml', () => {
    expect(scan('supabase/config.toml', assign(SECRET, ['a1b2c3d4e5f6', 'g7h8i9j0k1l2'].join('')))).toEqual(['generic secret assignment']);
  });
});
