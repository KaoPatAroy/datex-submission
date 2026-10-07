import type { SemanticDataset, SemanticDatasetCatalog, SemanticField } from '../dynamic/catalog/semantic';
import { idSchema, type Ref } from '../dynamic/plan/schemas';
import { digest, unique } from '../dynamic/shared';
import { isBoundTableClaims, revalidateTablePlan, tableBundlePlan, type TableAcceptedPlan, type TableClaims, type TableEvidenceBundle } from '../dynamic/table/engine';
import { rejected } from '../dynamic/validate/query-plan';
import type { ClaimGraph } from '../dynamic/evidence/claim-graph';
import { ARTIFACT_LIMITS, ARTIFACT_REGISTRY, artifactPlanSchema, type ArtifactAuthority, type ArtifactKind, type LatestArtifact } from './contracts';
import { createArtifactResponse, finalizeArtifact, graphRef, type PrepareArtifactResult } from './prepare';

/**
 * Artifacts over a registered TABLE dataset answer (inventory_items, incident_log, support_tickets). The same immutable ArtifactVersion contract
 * as branch evidence: every fact is a numeric claim copied from the verified TableClaims (never recomputed); the stored bundle carries the
 * table sources, coverage, scope and limitations, and each claim keeps its own row and source references. The accepted table plan is
 * revalidated under fresh authority + the current catalog before a preview and again before persistence.
 */
export interface TableArtifactFact {
  id: string; kind: 'fact'; measure: string; value: number | null; unit: string; dimensions: Record<string, string>; rowRefs: string[]; sourceRefs: string[];
  computation: { calculatorId: string; operation: 'value'; inputs: string[] };
}
export interface TableArtifactEvidence { accepted: TableAcceptedPlan; bundle: TableEvidenceBundle; claims: TableClaims }
/** What the fact projection needs from an accepted table answer (also available from a stored, re-validated state). */
export interface TableFactSource { accepted: Pick<TableAcceptedPlan, 'dataset' | 'joined' | 'plan'>; bundle: Pick<TableEvidenceBundle, 'sources'>; claims: Pick<TableClaims, 'claims'> }

const MAX_SOURCE_REFS = 100;
const fieldOf = (accepted: Pick<TableAcceptedPlan, 'dataset' | 'joined'>, id: string): { dataset: SemanticDataset; field: SemanticField } | undefined => {
  const dot = id.indexOf('.');
  const dataset = dot < 0 ? accepted.dataset : accepted.joined.find(d => d.id === id.slice(0, dot));
  const field = dataset?.fields.find(f => f.id === (dot < 0 ? id : id.slice(dot + 1)));
  return dataset && field ? { dataset, field } : undefined;
};

/** Numeric facts of a table answer: grouped answers map claim -> fact; a record listing yields one fact per numeric measure of each record. */
export function tableFacts(evidence: TableFactSource): TableArtifactFact[] {
  const { accepted, bundle, claims } = evidence;
  const out: TableArtifactFact[] = [];
  const sourcesFor = (dims: Record<string, string>, own: readonly string[]): string[] => {
    if (own.length) return [...own];
    // An event table with no matching record is a genuine zero attested by its empty source slices for those branches.
    const branch = dims.branch ?? dims['branch'];
    const scoped = branch ? bundle.sources.filter(s => s.id.includes(`:${branch}:`)) : bundle.sources;
    return scoped.slice(0, MAX_SOURCE_REFS).map(s => s.id);
  };
  const push = (measure: string, value: number | null, dims: Record<string, string>, rowRefs: readonly string[], own: readonly string[], unit?: string, calculatorId?: string) => {
    const resolved = fieldOf(accepted, measure);
    if (!resolved || resolved.field.kind !== 'measure' || value !== null && !Number.isFinite(value)) return;
    const sourceRefs = sourcesFor(dims, own);
    if (!sourceRefs.length || !rowRefs.length) return;
    out.push({ id: `claim:${out.length + 1}`, kind: 'fact', measure, value, unit: unit ?? resolved.field.unit ?? 'units', dimensions: { ...dims }, rowRefs: [...rowRefs], sourceRefs,
      computation: { calculatorId: calculatorId ?? resolved.field.calculatorId ?? 'table.registered.v1', operation: 'value', inputs: [] } });
  };
  for (const claim of claims.claims) {
    if (claim.fieldId === accepted.dataset.id && typeof claim.value === 'object' && claim.value !== null) {
      for (const measure of accepted.plan.measures) {
        const value = claim.value[measure.fieldId];
        if (typeof value === 'number') push(measure.fieldId, value, claim.dimensions, claim.rowRefs, claim.sourceRefs);
      }
    } else if (typeof claim.value === 'number' || claim.value === null) {
      push(claim.fieldId, claim.value, claim.dimensions, claim.rowRefs, claim.sourceRefs, claim.unit, claim.calculatorId);
    }
  }
  return out;
}

export interface PrepareTableArtifactInput {
  request: { artifactTypeId: ArtifactKind; operation: 'create' | 'revise'; title: string; baseRevision: Ref | null; outputFormat: 'preview' | 'csv' };
  artifactId: string; evidence: TableArtifactEvidence; authority: ArtifactAuthority; catalog: SemanticDatasetCatalog; latest: LatestArtifact; now: string;
}

export function prepareTableArtifact(input: PrepareTableArtifactInput): PrepareArtifactResult {
  const { accepted, bundle, claims } = input.evidence;
  try {
    if (!idSchema.safeParse(input.artifactId).success || !Number.isFinite(Date.parse(input.now))) return rejected('semantic_uncertainty', 'invalid_artifact_context');
    if (tableBundlePlan(bundle) !== accepted || !isBoundTableClaims(claims, bundle)) return rejected('semantic_uncertainty', 'artifact_provenance');
    const fresh = revalidateTablePlan(accepted, input.authority, input.catalog);
    if (fresh.outcome !== 'accepted') return fresh;
    if (input.authority.catalogDigest !== accepted.catalogDigest) return rejected('permission_denied', 'artifact_catalog_changed');
    const registration = ARTIFACT_REGISTRY[input.request.artifactTypeId];
    if (!input.authority.permissions.includes(registration.permission)) return rejected('permission_denied', 'artifact_permission');
    if (registration.format !== input.request.outputFormat) return rejected('unsupported_concept', 'artifact_format');
    // A complete top-N ranking proof only exists for branch evidence.
    if (input.request.artifactTypeId === 'ranking') return rejected('unsupported_concept', 'ranking_unavailable');
    const facts = tableFacts(input.evidence);
    if (!facts.length) return rejected('incomplete_evidence', 'artifact_no_numeric_facts');
    if (facts.length > ARTIFACT_LIMITS.claims || bundle.sources.length > ARTIFACT_LIMITS.sources) return rejected('unsupported_concept', 'artifact_budget');
    if (!bundle.coverage.complete) return rejected('incomplete_evidence', 'artifact_coverage');
    if (!accepted.scope.regions.length || !accepted.scope.branchIds.length || !accepted.dates.length) return rejected('incomplete_evidence', 'artifact_coverage');

    // Trust + read permissions of everything the artifact retains (dataset, measures, dimensions, calculator inputs).
    const datasets = [accepted.dataset, ...accepted.joined];
    const retained = unique([...facts.map(f => f.measure), ...facts.flatMap(f => Object.keys(f.dimensions))]);
    const fields = retained.map(id => fieldOf(accepted, id));
    const trusted = (sensitivity: string) => ['internal', 'public_business'].includes(sensitivity);
    if (datasets.some(d => d.trust !== 'certified' || !trusted(d.sensitivity)) || fields.some(f => !f || f.field.trust !== 'certified' || !trusted(f.field.sensitivity))) {
      return rejected('semantic_uncertainty', 'artifact_trust');
    }
    const readPermissions = unique([...datasets.flatMap(d => d.requiredPermissions), ...fields.flatMap(f => f!.field.requiredPermissions)]);
    if (!readPermissions.every(permission => input.authority.permissions.includes(permission))) return rejected('permission_denied', 'artifact_retained_field_permission');

    const limitations = [...bundle.limitations];
    const bundleBody = {
      version: 1 as const, query: { id: accepted.plan.planId, version: 1, digest: accepted.planDigest }, dataset: { ...bundle.dataset },
      authorityDigest: accepted.authorityDigest, scope: { regions: [...accepted.scope.regions], branchIds: [...accepted.scope.branchIds] },
      grain: [...accepted.dataset.grain], rows: [] as never[],
      sources: bundle.sources.map(s => ({ id: s.id, system: s.system, observedAt: s.observedAt, retrievedAt: s.retrievedAt, freshness: 'fresh' as const })),
      provenance: { sourceNames: unique(bundle.sources.map(s => s.system)), dates: [...accepted.dates], readAt: bundle.createdAt },
      coverage: { expected: bundle.coverage.expected, read: bundle.coverage.read, complete: bundle.coverage.complete, omittedReasons: [...bundle.coverage.omittedReasons] },
      limitations, interpretationLabels: [...bundle.interpretationLabels],
    };
    const evidenceRef = { id: `evidence:${digest(bundleBody)}`, version: 1, digest: digest(bundleBody) };
    const storedBundle = { ...bundleBody, ref: evidenceRef };
    const graphBody = { version: 1 as const, evidence: evidenceRef, claims: facts,
      edges: facts.flatMap(f => f.rowRefs.map(to => ({ from: f.id, to, relation: 'derived_from' as const }))),
      populationRowRefs: unique(facts.flatMap(f => f.rowRefs)), limitations };
    const graph = { ...graphBody, digest: digest(graphBody) };
    const response = createArtifactResponse(graph as unknown as ClaimGraph);
    const plan = artifactPlanSchema.safeParse({ version: 1, artifactTypeId: input.request.artifactTypeId, operation: input.request.operation, title: input.request.title.trim(),
      baseRevision: input.request.baseRevision, queryPlan: storedBundle.query, responsePlan: response.ref, evidence: evidenceRef, claimGraph: graphRef(graph as unknown as ClaimGraph),
      outputFormat: input.request.outputFormat });
    if (!plan.success) return rejected('semantic_uncertainty', 'invalid_artifact_plan');
    const { authority, catalog } = input;
    return finalizeArtifact({ plan: plan.data, artifactId: input.artifactId, authority, latest: input.latest, now: input.now, query: accepted.plan, response,
      bundle: storedBundle, graph, readPermissions, catalogVersion: catalog.version, catalogDigest: accepted.catalogDigest,
      binding: { authorityDigest: digest(authority), revalidate: fresher => revalidateTablePlan(accepted, fresher, catalog) } });
  } catch { return rejected('semantic_uncertainty', 'artifact_provenance'); }
}
