import { afterEach, describe, expect, it } from 'vitest';
import { executePolicyReadStep, listReadablePolicies } from '@/lib/router/executors/policy';
import { canReadPolicy, policyPermissionOf } from '@/lib/dynamic/catalog/policy';
import { actors, FIXED_NOW, tableFixtureCleanup, tableFixtures, seedTables } from './table-fixtures';

afterEach(async () => { await tableFixtureCleanup(); });

async function withPolicies() {
  const fixture = await tableFixtures(await seedTables());
  await fixture.store.transaction(async tx => {
    await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident and ticket handling', version: '1.0', text: 'Document the branch and escalate payment incidents.', updatedAt: '2026-10-01T10:00:00+07:00' });
    await tx.put('policy_documents', { id: 'POL-HR-001', title: 'Badge revocation', version: '2.1', text: 'Revocation needs a reason and readback.', updatedAt: '2026-10-01T10:00:00+07:00' });
    await tx.put('policy_documents', { id: 'POL-OTHER-9', title: 'Unregistered owner', version: '1', text: 'secret', updatedAt: '2026-10-01T10:00:00+07:00' });
  });
  return fixture;
}
const step = (...policyIds: string[]) => ({ kind: 'policy_read' as const, policyIds });

describe('policy read executor', () => {
  it('registry fails closed for unknown prefixes', () => {
    expect(policyPermissionOf('POL-OPS-001')).toBe('operations.read');
    expect(policyPermissionOf('POL-OTHER-9')).toBeNull();
    expect(canReadPolicy(['operations.read', 'hr.read'], 'POL-OTHER-9')).toBe(false);
  });

  it('lists and reads only the policies the actor is authorized for, with version and a citable Source', async () => {
    const fixture = await withPolicies();
    expect((await listReadablePolicies(fixture.store, actors.executive.permissions)).map(p => p.id)).toEqual(['POL-OPS-001']);
    expect((await listReadablePolicies(fixture.store, actors.hr.permissions)).map(p => p.id)).toEqual(['POL-HR-001']);
    const result = await executePolicyReadStep({ store: fixture.store, actor: actors.executive, now: () => FIXED_NOW, step: step('POL-OPS-001') });
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.text).toContain('เวอร์ชัน 1.0');
    expect(result.text).not.toContain('policy:POL-OPS-001');
    expect(result.text).not.toContain('Source:');
    expect(result.text).toContain('Policy “Incident and ticket handling”');
    expect(result.sources).toMatchObject([{ id: 'policy:POL-OPS-001:1.0', system: 'policy', freshness: 'fresh' }]);
    expect(result.requiredPermissions).toEqual(['operations.read']);
  });

  it('S5: the synthetic provenance sentence of the registered text never reaches the prose', async () => {
    const fixture = await withPolicies();
    await fixture.store.transaction(tx => tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident and ticket handling', version: '1.0',
      text: 'Source metadata: synthetic NEXUS demonstration fixture; version 1.0; no real company content. Training policy: document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' }));
    const result = await executePolicyReadStep({ store: fixture.store, actor: actors.executive, now: () => FIXED_NOW, step: step('POL-OPS-001') });
    expect(result.outcome === 'accepted' ? result.text : '').not.toContain('Source metadata');
    expect(result.outcome === 'accepted' ? result.text : '').toContain('Training policy: document the branch.');
  });

  it('a forbidden, missing or unregistered document is indistinguishable and leaks nothing', async () => {
    const fixture = await withPolicies();
    const texts = new Set<string>();
    for (const id of ['POL-HR-001', 'POL-NOPE-1', 'POL-OTHER-9']) {
      const result = await executePolicyReadStep({ store: fixture.store, actor: actors.executive, now: () => FIXED_NOW, step: step(id) });
      expect(result).toMatchObject({ outcome: 'denied', code: 'policy_unavailable' });
      texts.add(result.text);
    }
    expect(texts.size).toBe(1);
    expect([...texts][0]).not.toContain('Badge revocation');
  });

  it('rechecks authority at read time: a permission revoked after planning denies the read', async () => {
    const fixture = await withPolicies();
    await fixture.store.transaction(async tx => {
      const profile = await tx.get<Record<string, unknown> & { id: string; permissions: string[] }>('profiles', 'executive');
      await tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'operations.read') });
    });
    const result = await executePolicyReadStep({ store: fixture.store, actor: actors.executive, now: () => FIXED_NOW, step: step('POL-OPS-001') });
    expect(result.outcome).toBe('denied');
  });
});
