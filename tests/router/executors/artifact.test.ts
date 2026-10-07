import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import { executeArtifactStep, type ArtifactSource } from '@/lib/router/executors/artifact';
import { executeQueryStep } from '@/lib/router/executors/query';
import type { GroundedStep } from '@/lib/router/validate';
import type { ArtifactStep } from '@/lib/router/turn-plan';
import { proposal } from '../../dynamic/fixtures';
import { actors, base, read, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

async function source(): Promise<ArtifactSource> {
  const message = 'Show sales';
  const result = await executeQueryStep({ ...base(fixture, actors.executive, message), read, step: { kind: 'query', continuation: false, plan: proposal(message) } });
  if (result.outcome !== 'accepted') throw new Error('expected accepted query');
  return { stateId: 'state:1', plan: result.plan, bundle: result.bundle, claims: result.claims };
}
const step = (over: Partial<ArtifactStep> = {}, title = 'ยอดขายรายสาขา'): GroundedStep & { step: ArtifactStep } => {
  const artifact: ArtifactStep = { kind: 'artifact', sourceStateId: 'state:1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null,
    title: { value: title, source: 'generated' }, outputFormat: 'preview', visual: null, ...over };
  return { index: 0, step: artifact, params: { title: { name: 'title', value: title, source: 'generated', span: null, serverDefault: false } } };
};
const run = async (grounded: GroundedStep & { step: ArtifactStep }, artifacts: { latest: (id: string) => Promise<never | null> } = { latest: async () => null }, actor = actors.executive) =>
  executeArtifactStep({ store: fixture.store, actor, now: () => new Date('2026-10-01T03:00:00Z'), step: grounded, source: await source(), artifacts: artifacts as never, newArtifactId: 'artifact:t1' });

describe('artifact executor', () => {
  it('builds a table preview whose values are exactly the evidence claims, with Thai labels and artifact ids', async () => {
    const result = await run(step());
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    const src = await source();
    expect(result.artifactIds).toEqual(['artifact:t1']);
    expect(result.spec.facts.map(f => [f.claimId, f.value])).toEqual(src.claims.claims.map(c => [c.id, c.value]));
    expect(result.spec.labels?.fields.net_sales).toBeTruthy();
    expect(result.spec.title).toBe('ยอดขายรายสาขา');
    expect(result.text).not.toMatch(/\d{3}/);
  });

  it('compiles a bar chart from the registered visual and neutralizes CSV formulas', async () => {
    const chart = await run(step({ artifactTypeId: 'chart', visual: { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['net_sales'],
      interactionIds: ['inspect_data', 'select_point'], animation: 'fade' } }));
    expect(chart.outcome).toBe('accepted');
    if (chart.outcome === 'accepted') {
      expect(chart.spec.visualization?.primitive).toBe('bar');
      expect(chart.spec.visualization?.animation).toMatchObject({ modeId: 'fade', reducedMotion: 'respect' });
      expect(chart.spec.visualization?.points.length).toBe(chart.spec.facts.length);
    }
    const csv = await run(step({ artifactTypeId: 'csv_export', outputFormat: 'csv' }, '=HYPERLINK("x")'));
    expect(csv.outcome).toBe('accepted');
    if (csv.outcome === 'accepted') {
      expect(csv.spec.csv).toBeTruthy();
      expect(csv.spec.csv!.split('\r\n').every(line => !/^"[=+\-@]/.test(line))).toBe(true);
    }
  });

  it('denies a chart over an unknown dimension and a missing base artifact, and propagates lookup failure', async () => {
    const bad = await run(step({ artifactTypeId: 'chart', visual: { primitiveId: 'bar', xFieldId: 'nope', yFieldIds: ['net_sales'], interactionIds: ['inspect_data'], animation: 'none' } }));
    expect(bad).toMatchObject({ outcome: 'denied' });
    const missing = await run(step({ operation: 'revise', baseArtifactId: 'artifact:gone' }));
    expect(missing).toMatchObject({ outcome: 'denied', code: 'artifact_not_found' });
    await expect(run(step(), { latest: async () => { throw new Error('store down'); } })).rejects.toThrow('store down');
  });

  it('reloads the actor from the store: a revoked dashboard.create permission denies even if the caller still holds it (no fallback)', async () => {
    const src = await source();
    await fixture.store.transaction(async tx => {
      const profile = await tx.get<Record<string, unknown> & { id: string; permissions: string[] }>('profiles', actors.executive.id);
      await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'dashboard.create') });
    });
    const result = await executeArtifactStep({ store: fixture.store, actor: actors.executive, now: () => new Date('2026-10-01T03:00:00Z'), step: step(),
      source: src, artifacts: { latest: async () => null }, newArtifactId: 'artifact:t2' });
    expect(result).toMatchObject({ outcome: 'denied', code: 'artifact_permission' });
  });
});
