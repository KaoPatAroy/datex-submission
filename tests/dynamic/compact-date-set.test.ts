import { describe, expect, it } from 'vitest';
import { compactDateSet } from '../../lib/dynamic/runtime';

describe('compactDateSet', () => {
  it('collapses contiguous runs and keeps gaps separate', () => {
    expect(compactDateSet(['2026-05-03', '2026-05-01', '2026-05-02', '2026-05-05'])).toBe('2026-05-01..2026-05-03, 2026-05-05');
  });
  it('renders a single date, de-duplicates, and handles empty input', () => {
    expect(compactDateSet(['2026-05-01', '2026-05-01'])).toBe('2026-05-01');
    expect(compactDateSet([])).toBe('');
  });
  it('treats a leap day as contiguous with its neighbours', () => {
    expect(compactDateSet(['2028-02-28', '2028-02-29', '2028-03-01'])).toBe('2028-02-28..2028-03-01');
    expect(compactDateSet(['2027-02-28', '2027-03-01'])).toBe('2027-02-28..2027-03-01');
  });
});
