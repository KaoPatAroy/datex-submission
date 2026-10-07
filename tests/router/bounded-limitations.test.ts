import { describe, expect, it } from 'vitest';
import { boundedLimitations } from '@/lib/router/executors/query';

describe('boundedLimitations', () => {
  it('keeps a bounded sample plus an explicit count so a sparse month never exceeds the answer cap', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `ไม่มีข้อมูลยอดขาย สาขา E${i} วันที่ 2026-09-${String(i % 30 + 1).padStart(2, '0')}`);
    const out = boundedLimitations(many);
    expect(out).toHaveLength(6);
    expect(out[5]).toContain('1,995');
    expect(Buffer.byteLength(out.join('\n'), 'utf8')).toBeLessThan(2_000);
  });
  it('passes short lists through (deduplicated) and caps very long lines', () => {
    expect(boundedLimitations(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect([...boundedLimitations(['x'.repeat(1000)])[0]].length).toBe(240);
  });
});
