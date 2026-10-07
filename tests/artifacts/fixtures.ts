import type { QueryPlan } from '../../lib/dynamic/plan/schemas';
import { compileQueryPlan, executeReadRequest } from '../../lib/dynamic/compile/reader';
import type { EvidenceReader } from '../../lib/dynamic/compile/reader';
import { buildClaimGraph } from '../../lib/dynamic/evidence/claim-graph';
import { createArtifactResponse, prepareArtifact, type ArtifactPlan, type ArtifactVersion } from '../../lib/artifacts';
import { manager, accept, proposal, fakeEvidence, readAt, ranking, span, catalog } from '../dynamic/fixtures';
import type { VisualExpression } from '../../lib/visualization';

export const now = '2026-10-02T00:00:00Z';
export const actor = { ...manager, catalogDigest: catalog.digest, permissions: [...manager.permissions, 'dashboard.create', 'dashboard.share'] };
export async function evidenceFixture(query: QueryPlan = proposal(), reader: EvidenceReader = async scope => fakeEvidence(scope)) {
  const accepted = accept(query, 'Show sales', actor);
  const result = await executeReadRequest(compileQueryPlan(accepted), reader, actor, readAt);
  if (result.outcome !== 'accepted') throw new Error(`Fixture execution ${result.code}`);
  const bundle = result.bundle, graph = buildClaimGraph(bundle), response = createArtifactResponse(graph);
  const plan: ArtifactPlan = { version: 1, artifactTypeId: 'table', operation: 'create', title: 'East sales', baseRevision: null,
    queryPlan: bundle.query, responsePlan: response.ref, evidence: bundle.ref,
    claimGraph: { id: `claims:${graph.digest}`, version: 1, digest: graph.digest }, outputFormat: 'preview' };
  return { proposal: plan, artifactId: 'artifact:east', bundle, graph, response, authority: actor, latest: { kind: 'absent' } as const, now };
}
export async function artifactFixture(kind: ArtifactPlan['artifactTypeId'] = 'table') {
  const query = kind === 'ranking' ? ranking('Show sales') : proposal();
  const input = await evidenceFixture(query);
  input.proposal = { ...input.proposal, artifactTypeId: kind, outputFormat: kind === 'csv_export' ? 'csv' : 'preview' };
  const result = prepareArtifact(input);
  if (result.outcome !== 'accepted') throw new Error(`Fixture artifact ${result.code}`);
  return { input, preview: result.preview, artifact: result.preview.artifact };
}
export function visual(artifact: ArtifactVersion, primitiveId: 'bar' | 'line' = 'bar'): VisualExpression {
  return { visualization: { version: 1, artifact: artifact.ref, primitiveId, xFieldId: primitiveId === 'bar' ? 'branch' : 'date',
    yFieldIds: ['net_sales'], encodings: { x: primitiveId === 'bar' ? 'category' : 'time', y: 'value' }, maxMarks: 500 },
    interaction: { version: 1, interactionIds: ['inspect_data', 'inspect_sources', 'select_point'], selectionFields: ['branch'] },
    animation: { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' } };
}
export async function datedFixture(reader?: EvidenceReader) {
  const query = proposal();
  query.aggregation = 'rows'; query.group.fieldIds = [];
  query.dimensions.push({ fieldId: 'date', interpretation: { value: 'date', source: 'default', sourceText: span('Show sales', 'sales'), confidence: 1 } });
  query.time = { fieldId: 'date', dates: ['2026-09-28', '2026-09-29', '2026-09-30'], timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'sales' };
  if (reader) query.filters.push({ fieldId: 'net_sales', op: 'gte', value: 100, sourceText: span('Show sales', 'sales'), confidence: 1 });
  return evidenceFixture(query, reader);
}
