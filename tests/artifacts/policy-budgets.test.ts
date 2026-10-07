import { describe, expect, it } from 'vitest';
import { createSemanticCatalog, type SemanticDatasetCatalog } from '../../lib/dynamic/catalog/semantic';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { createArtifactResponse, prepareArtifact, authorizeArtifactShare, ARTIFACT_LIMITS } from '../../lib/artifacts';
import { compileArtifactRenderer } from '../../lib/visualization';
import { digest } from '../../lib/dynamic/shared';
import { available, branches, catalog, fakeEvidence, proposal, readAt, span } from '../dynamic/fixtures';
import { actor, artifactFixture, now, visual } from './fixtures';

async function contextFor(customCatalog: SemanticDatasetCatalog, query = proposal(), availability = available(), registry = branches, permissions = actor.permissions) {
  const pinnedCatalog = { ...customCatalog, digest: digest({ version: customCatalog.version, datasets: customCatalog.datasets, branches: customCatalog.branches }) };
  const authority = { ...actor, permissions, catalogDigest: pinnedCatalog.digest };
  const accepted = validateQueryPlan(query, pinnedCatalog, authority, availability);
  if (accepted.outcome !== 'accepted') throw new Error(`Query fixture rejected ${accepted.code}`);
  const executed = await executeReadRequest(compileQueryPlan(accepted), async scope => fakeEvidence(scope, registry), authority, readAt);
  if (executed.outcome !== 'accepted') throw new Error(`Read fixture rejected ${executed.code}`);
  const bundle = executed.bundle, graph = buildClaimGraph(bundle), response = createArtifactResponse(graph);
  return { artifactId: 'artifact:policy', bundle, graph, response, authority, now, latest: { kind: 'absent' } as const,
    proposal: { version: 1, artifactTypeId: 'table', operation: 'create', title: 'Scoped evidence', baseRevision: null, queryPlan: bundle.query,
      evidence: bundle.ref, claimGraph: response.plan.claimGraph, responsePlan: response.ref, outputFormat: 'preview' } };
}

describe('catalog policy, completeness and independent artifact budgets', () => {
  it.each(['inferred', 'verified_physical'] as const)('denies %s exploratory fields for an authoritative artifact', async trust => {
    const custom = structuredClone(catalog);
    custom.datasets[0].fields = custom.datasets[0].fields.map(field => field.id === 'net_sales' ? { ...field, trust } : field);
    const { digest: previous, ...payload } = custom; expect(previous).toBeDefined(); custom.digest = digest(payload);
    const query = proposal(); query.requestedUses = ['explore'];
    const result = prepareArtifact(await contextFor(custom, query));
    expect(result).toMatchObject({ outcome: 'semantic_uncertainty', code: 'artifact_trust' }); expect('preview' in result).toBe(false);
  });
  it('denies certified personal fields even when the query reader permits them', async () => {
    const custom = structuredClone(catalog);
    custom.datasets[0].fields = custom.datasets[0].fields.map(field => field.id === 'net_sales' ? { ...field, sensitivity: 'personal' } : field);
    expect(prepareArtifact(await contextFor(custom))).toMatchObject({ code: 'artifact_trust' });
  });
  it('denies a personal field retained only as a measure filter', async () => {
    const custom = structuredClone(catalog);
    custom.datasets[0].fields = custom.datasets[0].fields.map(field => field.id === 'stock_issues' ? { ...field, sensitivity: 'personal' } : field);
    const query = proposal(); query.filters.push({ fieldId: 'stock_issues', op: 'gte', value: 1, sourceText: span('Show sales', 'sales'), confidence: 1 });
    const context = await contextFor(custom, query);
    expect(context.bundle.rows[0].values.stock_issues).toBe(2);
    expect(context.graph.claims.every(claim => claim.measure === 'net_sales')).toBe(true);
    expect(prepareArtifact(context).outcome).toBe('semantic_uncertainty');
  });
  it('denies personal calculator inputs even when the selected gap measure is internal', async () => {
    const custom = structuredClone(catalog);
    custom.datasets[0].fields = custom.datasets[0].fields.map(field => field.id === 'target' ? { ...field, sensitivity: 'personal' } : field);
    const query = proposal(); query.measures = [{ ...query.measures[0], fieldId: 'gap', aggregation: 'gap', interpretation: { ...query.measures[0].interpretation, value: 'gap' } }];
    const context = await contextFor(custom, query);
    expect(context.bundle.rows[0].values.target).toBe(100);
    expect(context.graph.claims.every(claim => claim.measure === 'gap')).toBe(true);
    expect(prepareArtifact(context)).toMatchObject({ code: 'artifact_trust' });
  });
  it('denies personal dataset classification independently of safe field classifications', async () => {
    const custom = structuredClone(catalog); custom.datasets[0].sensitivity = 'personal';
    expect(prepareArtifact(await contextFor(custom))).toMatchObject({ code: 'artifact_trust' });
  });
  it('retains filter-field read permission in artifact policy and denies a recipient missing it', async () => {
    const custom = structuredClone(catalog);
    custom.datasets[0].fields = custom.datasets[0].fields.map(field => field.id === 'stock_issues' ? { ...field, requiredPermissions: ['private_metric.read'] } : field);
    const query = proposal(); query.filters.push({ fieldId: 'stock_issues', op: 'gte', value: 1, sourceText: span('Show sales', 'sales'), confidence: 1 });
    const context = await contextFor(custom, query, available(), branches, [...actor.permissions, 'private_metric.read']);
    const prepared = prepareArtifact(context);
    if (prepared.outcome !== 'accepted') throw new Error('Expected authorized artifact');
    const record = prepared.preview.artifact;
    expect(record.readPermissions).toContain('private_metric.read');
    const sender = { ...context.authority, role: 'east_manager' as const }, recipient = { ...actor, catalogDigest: context.authority.catalogDigest, role: 'east_manager' as const, id: 'team_lead' };
    expect(authorizeArtifactShare({ record, sender, recipient, proposal: { version: 1, artifact: record.ref, recipientId: recipient.id, channelId: 'in_app' },
      policy: { senderId: sender.id, recipientIds: [recipient.id], permittedRolePairs: [{ sender: 'east_manager', recipient: 'east_manager' }] } })).toMatchObject({ code: 'artifact_recipient_scope' });
  });
  it('denies a genuinely bound partial-population graph, rather than relying on a forged-bundle test', async () => {
    const query = proposal(); query.completeness.requireFullPopulation = false; query.completeness.minimumCoverage = .5;
    const context = await contextFor(catalog, query, { ...available(), branchIds: ['E01'] });
    expect(context.bundle.coverage.complete).toBe(false);
    expect(prepareArtifact(context)).toMatchObject({ outcome: 'incomplete_evidence', code: 'artifact_coverage' });
  });
  it('enforces the byte budget independently of allowed row/claim counts on real bound evidence', async () => {
    const registry = Array.from({ length: ARTIFACT_LIMITS.rows }, (_, i) => ({ id: `E${i.toString().padStart(4, '0')}${'X'.repeat(50)}`, name: `Branch ${i}`, region: 'east' }));
    const context = await contextFor(createSemanticCatalog(registry), proposal(), { ...available(), branchIds: registry.map(b => b.id) }, registry);
    expect(context.bundle.rows).toHaveLength(ARTIFACT_LIMITS.rows);
    expect(context.graph.claims).toHaveLength(ARTIFACT_LIMITS.claims);
    const result = prepareArtifact(context);
    expect(result.outcome).toBe('unsupported_concept');
    if (result.outcome !== 'accepted') expect(result.code).toBe('artifact_byte_budget');
  });
  it('forbids a revision to replace the pinned evidence with a different date', async () => {
    const { artifact: base } = await artifactFixture();
    const query = proposal(); query.time = { fieldId: 'date', dates: ['2026-09-30'], timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'sales' };
    const context = await contextFor(catalog, query);
    expect(prepareArtifact({ ...context, artifactId: base.artifactId, proposal: { ...context.proposal, operation: 'revise', baseRevision: base.ref }, latest: { kind: 'version', artifact: base } })).toMatchObject({ code: 'artifact_base_mismatch' });
  });
  it('charts preserve all claims while refusing a misleading mixed-unit numeric axis', async () => {
    const query = proposal();
    query.measures.push({ fieldId: 'achievement', aggregation: 'weighted_ratio', interpretation: { value: 'achievement', source: 'explicit', sourceText: span('Show sales', 'sales'), confidence: 1 } });
    const context = await contextFor(catalog, query);
    const prepared = prepareArtifact({ ...context, proposal: { ...context.proposal, artifactTypeId: 'chart' } });
    if (prepared.outcome !== 'accepted') throw new Error('Expected artifact');
    const artifact = prepared.preview.artifact, expression = visual(artifact);
    expect(compileArtifactRenderer({ artifact, authority: context.authority, visualExpression: { ...expression, visualization: { ...expression.visualization, yFieldIds: ['net_sales', 'achievement'] } } })).toMatchObject({ code: 'visual_mixed_units' });
    const result = compileArtifactRenderer({ artifact, authority: context.authority, visualExpression: expression });
    if (result.outcome !== 'accepted') throw new Error('Expected compatible chart');
    expect(result.spec.visualization?.points).toHaveLength(2); expect(result.spec.facts).toHaveLength(4);
    expect(result.spec.facts.map(f => f.value)).toEqual([200, 200, 80, 40]);
  });
  it('preserves registered baseline/difference comparison metadata and every source-backed number', async () => {
    const query = proposal(); query.compare = { kind: 'vs_target', period: null, baseline: null, sourceText: span('Show sales', 'sales'), confidence: 1 };
    const context = await contextFor(catalog, query);
    const result = prepareArtifact(context);
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.preview.artifact.graph.claims.map(c => c.value)).toEqual([200, 100, 100, 80, 200, -120]);
      expect(result.preview.artifact.graph.claims.map(c => c.dimensions.comparison)).toEqual([undefined, 'baseline', 'difference', undefined, 'baseline', 'difference']);
    }
  });
});
