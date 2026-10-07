import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hrPack } from '../../../lib/packs/hr';
import { getWorkflowProjection } from '../../../lib/storage/workflow-projections';
import { discoverRegisteredCatalog, discoveryCatalogSchema } from '../../../lib/dynamic/catalog/discovery';
import { authorizeCatalogField, validateCatalogAudience, catalogAuthoritySchema } from '../../../lib/dynamic/catalog/authority';
import { proposeGovernedLearning } from '../../../lib/dynamic/catalog/learning';
import { approvedCatalogLabelsForPlanner } from '../../../lib/dynamic/catalog/learning';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWave2Catalog } from '../../../lib/dynamic/catalog/hr';
import { createSemanticCatalog } from '../../../lib/dynamic/catalog/semantic';
import { buildPlannerInput } from '../../../lib/dynamic/planner/planner';
import { digest } from '../../../lib/dynamic/shared';
import { branches, executive } from '../fixtures';
import { manager, catalog, now } from './fixtures';

describe('physical discovery remains a candidate registry', () => {
  it('derives safe HR result fields from the real registered pack schema', () => {
    const found = discoverRegisteredCatalog({ packs: [hrPack], workflows: [], revision: 1 });
    const dataset = found.datasets.find(d => d.id === 'pack:hr:hr.find_employee')!;
    expect(dataset.fields.map(f => f.path)).toContain('employee.name');
    expect(dataset.fields.every(f => !f.queryable && f.sensitivity === 'restricted' && f.status === 'candidate')).toBe(true);
    expect(Object.isFrozen(found.datasets[0].fields[0])).toBe(true);
  });
  it('discovers a newly registered result field without semantic changes', () => {
    const pack = { ...hrPack, tools: [{ ...hrPack.tools[0], resultSchema: z.object({ new_field: z.number(), rma_total: z.number().nullable() }).strict() }] };
    const found = discoverRegisteredCatalog({ packs: [pack], workflows: [], revision: 2 });
    expect(found.datasets[0].fields.map(f => f.path).sort()).toEqual(['new_field', 'rma_total']);
    expect(catalog.hrDataset.fields).not.toContain('rma_total');
    expect(found.datasets[0].fields.find(f => f.path === 'rma_total')?.nullable).toBe(true);
  });
  it('derives projection metadata without importing storage execution', () => {
    const manifest = getWorkflowProjection('employees');
    const found = discoverRegisteredCatalog({ packs: [], workflows: [manifest], revision: 1 });
    expect(found.datasets[0].fields.length).toBe(manifest.columns.length);
    expect(found.datasets[0].fields.every(f => !f.queryable)).toBe(true);
    expect(found.datasets[0].sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects duplicate datasets and excessive input budgets', () => {
    expect(() => discoverRegisteredCatalog({ packs: [hrPack, hrPack], workflows: [], revision: 1 })).toThrow('Duplicate');
    expect(() => discoverRegisteredCatalog({ packs: Array(101).fill(hrPack), workflows: [], revision: 1 })).toThrow('budget');
  });
  it('rejects forged certification and unknown nested schema keys', () => {
    const found = structuredClone(discoverRegisteredCatalog({ packs: [hrPack], workflows: [], revision: 1 }));
    expect(discoveryCatalogSchema.safeParse({ ...found, sql: 'select *' }).success).toBe(false);
    expect(discoveryCatalogSchema.safeParse({ ...found, datasets: [{ ...found.datasets[0], status: 'certified' }] }).success).toBe(false);
  });
  it('publishes new immutable catalog versions and preserves the Wave 1 dataset', () => {
    const second = createWave2Catalog(catalog.branchCatalog.branches, 2);
    expect(second.ref.version).toBe(2);
    expect(second.ref.digest).not.toBe(catalog.ref.digest);
    expect(second.branchCatalog).toEqual(catalog.branchCatalog);
    expect(catalog.ref.version).toBe(1);
    expect(Reflect.set(catalog.hrDataset.fields, '0', 'salary')).toBe(false);
  });
});

describe('trust and audience are independent authority gates', () => {
  it.each(['personal', 'restricted', 'confidential'] as const)('blocks discovered %s data even in exploration', sensitivity => {
    expect(authorizeCatalogField({ trust: 'verified_physical', sensitivity, uses: ['explore'], requiredPermissions: [], actor: manager }).allowed).toBe(false);
  });
  it.each(['verified_physical', 'inferred'] as const)('permits only labeled low-risk %s exploration', trust => {
    const input = { trust, sensitivity: 'internal' as const, uses: ['explore'], requiredPermissions: ['hr.read'], actor: manager };
    expect(authorizeCatalogField(input).label).toMatch(/interpretation/i);
    for (const use of ['answer', 'action', 'monitor', 'artifact', 'send', 'eval']) expect(authorizeCatalogField({ ...input, uses: [use] }).allowed).toBe(false);
  });
  it('requires HR permission for certified personal fields and blocks restricted fields', () => {
    const input = { trust: 'certified' as const, sensitivity: 'personal' as const, uses: ['answer'], requiredPermissions: [], actor: { ...manager, permissions: [] } };
    expect(authorizeCatalogField(input).allowed).toBe(false);
    expect(authorizeCatalogField({ ...input, actor: manager }).allowed).toBe(true);
    expect(authorizeCatalogField({ ...input, actor: manager, sensitivity: 'restricted' }).allowed).toBe(false);
  });
  it('unknown trust and missing permissions never authorize exploration', () => {
    expect(authorizeCatalogField({ trust: 'unknown', sensitivity: 'internal', uses: ['explore'], requiredPermissions: [], actor: manager }).allowed).toBe(false);
    expect(authorizeCatalogField({ trust: 'certified', sensitivity: 'internal', uses: ['answer'], requiredPermissions: ['sales.read'], actor: manager }).allowed).toBe(false);
  });
  it('East Manager cannot target another region or unauthorized recipient', () => {
    const peer = { ...manager, id: 'east_peer' };
    const input = { actor: manager, recipients: [peer], recipientIds: ['east_peer'], branches: [{ id: 'E01', region: 'east' }], requiredPermissions: ['hr.read'] };
    expect(validateCatalogAudience(input)).toBe(true);
    expect(validateCatalogAudience({ ...input, recipientIds: ['south_peer'] })).toBe(false);
    expect(validateCatalogAudience({ ...input, branches: [{ id: 'S01', region: 'south' }], actor: { ...manager, regions: ['*'] } })).toBe(false);
    expect(validateCatalogAudience({ ...input, recipients: [{ ...peer, regions: ['south'] }] })).toBe(false);
    expect(validateCatalogAudience({ ...input, recipients: [{ ...peer, active: false }] })).toBe(false);
    expect(validateCatalogAudience({ ...input, recipients: [peer, peer] })).toBe(false);
  });
  it('authority schemas reject unknown keys and invalid versions', () => {
    expect(catalogAuthoritySchema.safeParse({ ...manager, sql: 'select *' }).success).toBe(false);
    expect(catalogAuthoritySchema.safeParse({ ...manager, revision: 0 }).success).toBe(false);
  });
});

describe('governed learning cannot self-certify or apply mappings', () => {
  const actor = { id: manager.id, active: true, permissions: [...manager.permissions, 'catalog.learning.propose'], regions: manager.regions, revision: manager.revision };
  const proposal = { version: 1, id: 'suggestion:1', revision: 1, kind: 'catalog_label', catalog: catalog.ref,
    targetId: 'headcount', proposedLabel: 'staff count', provenance: { source: 'model_suggestion', evidence: { id: 'source:1', version: 1, digest: digest('redacted correction') } },
    status: 'pending_review', requiredReviewers: ['semantic_owner', 'security_owner'], activationAllowed: false, previous: null, createdAt: now };
  const propose = (input: unknown = proposal, overrides: Partial<Parameters<typeof proposeGovernedLearning>[0]> = {}) =>
    proposeGovernedLearning({ proposal: input, catalog: catalog.ref, actor, allowedTargetIds: ['headcount'], recordedSourceText: 'number of staff', now, ...overrides });
  it('records immutable pending proposals with privacy-minimized provenance', () => {
    const record = propose();
    expect(record.status).toBe('pending_review');
    expect(record.activationAllowed).toBe(false);
    expect(record).not.toHaveProperty('recordedSourceText');
    expect(Object.isFrozen(record.provenance)).toBe(true);
    expect(catalog.hrDataset.fields).not.toContain('staff count');
  });
  it.each([{ status: 'approved' }, { activationAllowed: true }, { targetId: 'salary' }, { kind: 'synonym' }, { kind: 'mapping' },
    { kind: 'sql' }, { rawPrompt: 'private' }, { revision: 2 }])('rejects unsafe proposal %j', change => {
    expect(() => propose({ ...proposal, ...change })).toThrow();
  });
  it('versions proposals without mutating previous records', () => {
    const prior = propose();
    const next = proposeGovernedLearning({ proposal: { ...proposal, revision: 2, proposedLabel: 'active staff', previous: prior.ref },
      previous: prior, catalog: catalog.ref, actor, allowedTargetIds: ['headcount'], recordedSourceText: 'number of staff', now });
    expect(prior.proposedLabel).toBe('staff count');
    expect(next.ref.digest).not.toBe(prior.ref.digest);
    expect(next.previous).toEqual(prior.ref);
  });
  it('compares proposal timestamps by UTC instant across offsets', () => {
    const prior = propose({ ...proposal, createdAt: '2026-10-06T07:00:00+02:00' });
    expect(() => proposeGovernedLearning({ proposal: { ...proposal, revision: 2, previous: prior.ref, createdAt: '2026-10-06T06:58:00+02:00' },
      previous: prior, catalog: catalog.ref, actor, allowedTargetIds: ['headcount'], recordedSourceText: 'number of staff', now })).toThrow('revision');
    const next = proposeGovernedLearning({ proposal: { ...proposal, revision: 2, previous: prior.ref, createdAt: '2026-10-06T07:01:00+02:00' },
      previous: prior, catalog: catalog.ref, actor, allowedTargetIds: ['headcount'], recordedSourceText: 'number of staff', now });
    expect(next.revision).toBe(2);
  });
  it('rejects labels containing recorded source text, unauthorized actors, and timestamps outside five minutes', () => {
    expect(() => propose({ ...proposal, proposedLabel: 'number of staff count' })).toThrow('source text');
    expect(() => propose(proposal, { actor: { ...actor, active: false } })).toThrow('Unregistered');
    expect(() => propose(proposal, { actor: { ...actor, permissions: [] } })).toThrow('Unregistered');
    expect(() => propose(proposal, { now: '2026-10-06T05:06:00Z' })).toThrow('clock skew');
  });
  it('exposes approved labels only for current registered IDs and scans imports to the planner context builder', () => {
    const labels = [{ catalog: catalog.ref, targetId: 'headcount', label: 'staff count', status: 'approved' as const },
      { catalog: catalog.ref, targetId: 'unregistered', label: 'private label', status: 'approved' as const }];
    expect(approvedCatalogLabelsForPlanner(labels, catalog.ref, new Set(['headcount']))).toEqual([{ targetId: 'headcount', label: 'staff count' }]);
    const semantic = createSemanticCatalog(branches), semanticRef = { id: 'semantic_catalog', version: semantic.version, digest: semantic.digest };
    const plannerInput = buildPlannerInput(semantic, executive, 'Show sales', undefined, undefined,
      [{ catalog: semanticRef, targetId: 'net_sales', label: 'turnover', status: 'approved' }]);
    expect(plannerInput.prompt).toContain('AUTHORIZED_CATALOG_DATA={"datasets"');
    expect(plannerInput.prompt).toContain('"label":"turnover"');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..'), lib = join(root, 'lib');
    const sources: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name)) sources.push(path);
      }
    };
    visit(lib);
    const importing = sources.filter(path => readFileSync(path, 'utf8').split(/\r?\n/)
      .some(line => /^\s*import\b/.test(line) && /\bapprovedCatalogLabelsForPlanner\b/.test(line)))
      .map(path => relative(root, path).replaceAll('\\', '/'));
    expect(importing).toEqual(['lib/dynamic/planner/planner.ts']);
  });
});
