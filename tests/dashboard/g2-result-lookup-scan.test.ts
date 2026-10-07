import { describe, expect, it } from 'vitest';
import type { Reader } from '@/lib/contracts';
import { searchActiveResults } from '@/lib/artifacts/library';
import { ARTIFACT_HEAD_TOOL } from '@/lib/artifacts/store';
import type { Actor } from '@/lib/contracts';
import { executeResourceLookupStep, type LookupCandidate } from '@/lib/router/executors/resource-lookup';

/** G2 / P2-1: a Result lookup never offers a continuation that leads to an empty page; older Results beyond one listing scan stay reachable. */
const MORE = /^lookup-more:/;
const actor = { id: 'executive' } as Actor;

function headsReader(count: number, title: (i: number) => string): Pick<Reader, 'get' | 'list'> {
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `artifact_scan_${String(i).padStart(5, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    return { id: `artifact-head:${id}`, name: ARTIFACT_HEAD_TOOL, status: 'artifact_head', actorId: 'executive', conversationId: `conv_${i % 7}`, artifactId: id,
      revision: 1, ref: { id, version: 1, digest: `d_${i}` }, kind: 'table', title: title(i), createdAt: at, updatedAt: at };
  });
  return {
    list: async <T,>(_table: string, filters?: Record<string, unknown>) => (filters?.status === 'artifact_head' ? rows : []) as T[],
    get: async () => undefined,
  } as unknown as Pick<Reader, 'get' | 'list'>;
}

describe('Result lookup beyond the listing scan', () => {
  it('finds the OLDEST matching Results even when the owner has more than the listing scan of heads (no truncation for title search)', async () => {
    const reader = headsReader(2_105, i => (i < 3 ? 'Ancient ledger' : `Recent report ${i}`));
    const found = await searchActiveResults(reader, 'executive', 'ancient');
    expect(found.items.map(item => item.id).sort()).toEqual(['artifact_scan_00000', 'artifact_scan_00001', 'artifact_scan_00002']);
    expect(found.truncated).toBe(false);
  });

  it('a truncated search never offers a next page past the last match, and says older items were not searched', async () => {
    const items: LookupCandidate[] = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, label: `x · ${i}` }));
    const found = await executeResourceLookupStep({ actor, step: { kind: 'resource_lookup', resource: 'result', query: 'x' },
      ports: { search: async (_a, input) => ({ total: 5, truncated: true, items: items.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit) }) } });
    expect(found.outcome).toBe('choices');
    if (found.outcome !== 'choices') return;
    expect(found.choices.some(choice => MORE.test(choice.id))).toBe(false);
    expect(found.choices).toHaveLength(5);
    expect(found.text).toContain('อย่างน้อย 5 รายการ');
    expect(found.text).toContain('เก่ากว่า');
  });

  it('every offered continuation of a truncated search leads to a non-empty page', async () => {
    const items: LookupCandidate[] = Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, label: `x · ${i}` }));
    const ports = { search: async (_a: Actor, input: { limit: number; offset?: number }) => ({ total: 16, truncated: true, items: items.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit) }) };
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await executeResourceLookupStep({ actor, step: { kind: 'resource_lookup', resource: 'result', query: 'x' }, ports, offset });
      expect(page.outcome, `offset ${offset}`).toBe('choices');
      if (page.outcome !== 'choices') return;
      const more = page.choices.find(choice => MORE.test(choice.id));
      if (!more) break;
      offset = Number(more.id.split(':')[2]);
    }
    expect(offset).toBeGreaterThan(0);
  });
});
