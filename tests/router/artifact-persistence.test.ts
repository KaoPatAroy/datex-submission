import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import type { Actor, Branch } from '@/lib/contracts';
import { createArtifactReader, persistArtifactPreview, type ArtifactPreview } from '@/lib/artifacts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { authority } from '@/lib/dynamic/runtime';
import { executeArtifactStep, type ArtifactSource } from '@/lib/router/executors/artifact';
import { executeQueryStep } from '@/lib/router/executors/query';
import type { ArtifactStep } from '@/lib/router/turn-plan';
import type { GroundedStep } from '@/lib/router/validate';
import { proposal } from '../dynamic/fixtures';
import { actors, base, read, seed, type Fixture } from './executors/fixtures';

let fixture: Fixture;
const NOW = new Date('2026-10-01T03:00:00Z');
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
async function prepare(actor: Actor, id: string, over: Partial<ArtifactStep> = {}, title?: string): Promise<ArtifactPreview> {
  const result = await executeArtifactStep({ store: fixture.store, actor, now: () => NOW, step: step(over, title), source: await source(),
    artifacts: createArtifactReader(fixture.store, actor.id), newArtifactId: id });
  if (result.outcome !== 'accepted') throw new Error(`artifact denied: ${result.code}`);
  return result.preview;
}
async function persist(actor: Actor, preview: ArtifactPreview, turnId = 't1') {
  return fixture.store.transaction(async tx => {
    const catalog = createSemanticCatalog(await tx.list<Branch>('branches'));
    return persistArtifactPreview(tx, { preview, authority: { ...authority(actor), catalogDigest: catalog.digest }, conversationId: 'c1', turnId, now: NOW.toISOString() });
  });
}

describe('artifact persistence, save, export and revise', () => {
  it('persists a draft, reloads it from the store, then saves it privately and exports a neutralized CSV', async () => {
    await persist(actors.executive, await prepare(actors.executive, 'artifact-a1', {}, '=HYPERLINK("x")'));
    const reader = createArtifactReader(fixture.store, actors.executive.id);
    const latest = await reader.latest('artifact-a1');
    expect(latest?.revision).toBe(1);
    expect((await reader.listHeads('c1')).map(head => head.artifactId)).toEqual(['artifact-a1']);
    expect((await reader.head('artifact-a1'))?.savedRef).toBeUndefined();

    const saved = await fixture.service.saveArtifact(actors.executive, 'artifact-a1', { revision: 1, conversationId: 'c1' });
    expect(saved.revision).toBe(1);
    expect((await reader.head('artifact-a1'))?.savedRef?.version).toBe(1);

    const exported = await fixture.service.exportArtifact(actors.executive, 'artifact-a1', { conversationId: 'c1' });
    expect(exported.filename).toBe('artifact-a1-r1.csv');
    const lines = exported.csv.split('\r\n');
    expect(lines[0]).toContain('claim_id');
    expect(lines.length).toBe(latest!.graph.claims.length + 1);
  });

  it('revises from the stored artifact: a new immutable version, latest pointer advanced, saved flag only on the saved version', async () => {
    await persist(actors.executive, await prepare(actors.executive, 'artifact-a2'));
    await fixture.service.saveArtifact(actors.executive, 'artifact-a2');
    const revised = await prepare(actors.executive, 'ignored', { operation: 'revise', baseArtifactId: 'artifact-a2', artifactTypeId: 'chart',
      visual: { primitiveId: 'bar', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data'], animation: 'none' } });
    expect(revised.artifact.revision).toBe(2);
    await persist(actors.executive, revised, 't2');
    const reader = createArtifactReader(fixture.store, actors.executive.id);
    const head = await reader.head('artifact-a2');
    expect(head?.revision).toBe(2);
    expect(head?.kind).toBe('chart');
    expect(head?.savedRef?.version).toBe(1); // v2 is a draft until saved
    expect((await reader.read({ id: 'artifact-a2', version: 1, digest: head!.savedRef!.digest }))?.revision).toBe(1);
  });

  it('refuses a replayed write (CAS) and hides artifacts from other owners', async () => {
    const preview = await prepare(actors.executive, 'artifact-a3');
    await persist(actors.executive, preview);
    await expect(persist(actors.executive, preview, 't2')).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    expect(await createArtifactReader(fixture.store, actors.east.id).latest('artifact-a3')).toBeNull();
    await expect(fixture.service.saveArtifact(actors.east, 'artifact-a3')).rejects.toMatchObject({ status: 404 });
    await expect(fixture.service.exportArtifact(actors.executive, 'artifact-a3', { conversationId: 'other' })).rejects.toMatchObject({ status: 404 });
  });

  it('fails closed on export when current authority no longer covers the stored evidence', async () => {
    await persist(actors.executive, await prepare(actors.executive, 'artifact-a4'));
    await fixture.store.transaction(async tx => {
      const profile = await tx.get<Record<string, unknown> & { id: string; permissions: string[] }>('profiles', actors.executive.id);
      await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'sales.read') });
    });
    await expect(fixture.service.exportArtifact(actors.executive, 'artifact-a4')).rejects.toMatchObject({ status: 403 });
  });

  it('detects a tampered stored record by its digests', async () => {
    await persist(actors.executive, await prepare(actors.executive, 'artifact-a5'));
    await fixture.store.transaction(async tx => {
      const row = await tx.get<{ id: string; record: { graph: { claims: { value: number | null }[] } } }>('tool_executions', 'artifact-version:artifact-a5:1');
      row!.record.graph.claims[0].value = 999999;
      await tx.put('tool_executions', row!);
    });
    await expect(fixture.service.exportArtifact(actors.executive, 'artifact-a5')).rejects.toMatchObject({ code: 'ARTIFACT_STORE_INVALID' });
  });
});
