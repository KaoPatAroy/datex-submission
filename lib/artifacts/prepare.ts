import type { EvidenceBundle } from '../dynamic/evidence/bundle';
import { bundlePlan } from '../dynamic/evidence/bundle';
import { isBoundClaimGraph, type ClaimGraph } from '../dynamic/evidence/claim-graph';
import type { QueryPlan, Ref } from '../dynamic/plan/schemas';
import { idSchema } from '../dynamic/plan/schemas';
import { acceptedContext, revalidate, rejected, type RejectedPlan } from '../dynamic/validate/query-plan';
import { digest, freeze, unique } from '../dynamic/shared';
import { isShareGrant, type ArtifactShareGrant } from './grant';
import { ARTIFACT_LIMITS, ARTIFACT_REGISTRY, artifactPlanSchema, artifactVersionSchema, responsePlanSchema,
  type ArtifactPlan, type ArtifactAuthority, type ArtifactPreview, type ArtifactResponse, type ArtifactVersion, type LatestArtifact } from './contracts';

export const sameRef = (a: Ref, b: Ref): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest;
export const graphRef = (graph: ClaimGraph): Ref => ({ id: `claims:${graph.digest}`, version: graph.version, digest: graph.digest });
const responseBindings = new WeakMap<ArtifactResponse, ClaimGraph>();
const trustedArtifacts = new WeakSet<ArtifactVersion>();
export function isTrustedArtifact(value: unknown): value is ArtifactVersion {
  return value !== null && typeof value === 'object' && trustedArtifacts.has(value as ArtifactVersion);
}
/** What a preview was bound to: the retail evidence objects, or (table datasets) the registered revalidation of the accepted table plan. */
export interface PreviewBinding { bundle?: EvidenceBundle; graph?: ClaimGraph; authorityDigest: string; revalidate?: (authority: ArtifactAuthority) => { outcome: string } }
const previewBindings = new WeakMap<ArtifactPreview, PreviewBinding>();
export function previewBinding(preview: ArtifactPreview) { return previewBindings.get(preview); }

/** Renderer-owned response adapter: every fact and citation comes from the graph, never AI prose. */
export function createArtifactResponse(graph: ClaimGraph): ArtifactResponse {
  const plan = responsePlanSchema.parse({ version: 1, claimGraph: graphRef(graph),
    sections: [{ kind: 'table', claimIds: graph.claims.map(c => c.id), order: 0 }], wordingStyle: 'concise',
    interpretationLabels: [], citations: graph.claims.map(c => ({ claimId: c.id, sourceRefs: [...c.sourceRefs] })), locale: 'en' });
  const response = freeze({ ref: { id: `response:${digest(plan)}`, version: 1, digest: digest(plan) }, plan });
  responseBindings.set(response, graph);
  return response;
}

export function artifactDigest(record: unknown): string { return digest(record); }
export function validArtifactRecord(value: unknown): value is ArtifactVersion {
  const parsed = artifactVersionSchema.safeParse(value);
  if (!parsed.success) return false;
  const record = parsed.data, { ref, ...body } = record, { ref: evidenceRef, ...evidenceBody } = record.bundle,
    { digest: claimDigest, ...claimBody } = record.graph;
  return ref.id === record.artifactId && ref.version === record.revision && ref.digest === artifactDigest(body) &&
    evidenceRef.digest === digest(evidenceBody) && claimDigest === digest(claimBody) &&
    sameRef(record.plan.evidence, evidenceRef) && sameRef(record.graph.evidence, evidenceRef) &&
    sameRef(record.plan.claimGraph, graphRef(record.graph)) && sameRef(record.response.plan.claimGraph, graphRef(record.graph)) &&
    sameRef(record.plan.queryPlan, record.bundle.query) && digest(record.query) === record.bundle.query.digest &&
    sameRef(record.plan.responsePlan, record.response.ref) && record.response.ref.digest === digest(record.response.plan) &&
    digest(record.response.plan.sections.flatMap(s => s.claimIds).slice().sort()) === digest(record.graph.claims.map(c => c.id).sort()) &&
    record.response.plan.citations.length === record.graph.claims.length && record.graph.claims.every(c =>
      record.response.plan.citations.some(citation => citation.claimId === c.id && digest(citation.sourceRefs) === digest(c.sourceRefs))) &&
    Buffer.byteLength(JSON.stringify(record), 'utf8') <= ARTIFACT_LIMITS.bytes;
}
export function canReadArtifact(record: ArtifactVersion, authority: ArtifactAuthority): boolean {
  return authority.active && authority.catalogDigest === record.catalogSnapshot.digest && record.readPermissions.every(p => authority.permissions.includes(p)) &&
    record.bundle.scope.regions.every(region => authority.regions.includes('*') || authority.regions.includes(region));
}

/** Server-store reload only. expectedRef must come from server-protected state, never from the client. */
export function loadArtifact(input: {
  record: unknown; expectedRef: Ref; authority: ArtifactAuthority;
}): { outcome: 'accepted'; artifact: ArtifactVersion } | RejectedPlan {
  if (!validArtifactRecord(input.record) || !sameRef(input.expectedRef, input.record.ref)) return rejected('semantic_uncertainty', 'artifact_record_mismatch');
  if (input.record.ownerId !== input.authority.id || !canReadArtifact(input.record, input.authority)) return rejected('permission_denied', 'artifact_read_access');
  const artifact = freeze(structuredClone(input.record));
  trustedArtifacts.add(artifact);
  return { outcome: 'accepted', artifact };
}

/**
 * Reload of an owner's exact version for a RECIPIENT. Only with a server-issued share grant naming this exact version and this
 * recipient, and only when the recipient can read the artifact's WHOLE stored scope under current authority and catalog.
 */
export function loadSharedArtifact(input: {
  record: unknown; expectedRef: Ref; authority: ArtifactAuthority; grant: ArtifactShareGrant;
}): { outcome: 'accepted'; artifact: ArtifactVersion } | RejectedPlan {
  if (!validArtifactRecord(input.record) || !sameRef(input.expectedRef, input.record.ref)) return rejected('semantic_uncertainty', 'artifact_record_mismatch');
  const { grant, authority, record } = input;
  if (!isShareGrant(grant) || grant.recipientId !== authority.id || grant.senderId !== record.ownerId || !sameRef(grant.artifact, record.ref) ||
    record.ownerId === authority.id || !canReadArtifact(record, authority)) return rejected('permission_denied', 'artifact_read_access');
  const artifact = freeze(structuredClone(record));
  trustedArtifacts.add(artifact);
  return { outcome: 'accepted', artifact };
}

export interface PrepareArtifactInput {
  proposal: unknown; artifactId: string; bundle: EvidenceBundle; graph: ClaimGraph; response: ArtifactResponse;
  authority: ArtifactAuthority; latest: LatestArtifact; now: string;
}
export type PrepareArtifactResult = { outcome: 'accepted'; preview: ArtifactPreview } | RejectedPlan;

/** Single artifact integration entry: AI plan -> registry/auth/provenance validation -> immutable preview. */
export function prepareArtifact(input: PrepareArtifactInput): PrepareArtifactResult {
  const parsed = artifactPlanSchema.safeParse(input.proposal);
  if (!parsed.success) return rejected(parsed.error.issues.some(i => i.path[0] === 'artifactTypeId') ? 'unsupported_concept' : 'semantic_uncertainty', 'invalid_artifact_plan');
  const plan = parsed.data;
  if (!idSchema.safeParse(input.artifactId).success || !Number.isFinite(Date.parse(input.now))) return rejected('semantic_uncertainty', 'invalid_artifact_context');
  if (input.bundle.rows.length > ARTIFACT_LIMITS.rows || input.graph.claims.length > ARTIFACT_LIMITS.claims || input.bundle.sources.length > ARTIFACT_LIMITS.sources) {
    return rejected('unsupported_concept', 'artifact_budget');
  }
  try {
    const accepted = bundlePlan(input.bundle), context = acceptedContext(accepted);
    if (!isBoundClaimGraph(input.graph, input.bundle) || responseBindings.get(input.response) !== input.graph) return rejected('semantic_uncertainty', 'artifact_provenance');
    // Exact-reference guard: a new visual must preserve every pinned plan/evidence/claim reference.
    if (!sameRef(plan.queryPlan, input.bundle.query) || !sameRef(plan.evidence, input.bundle.ref) ||
      !sameRef(plan.claimGraph, graphRef(input.graph)) || !sameRef(plan.responsePlan, input.response.ref)) return rejected('semantic_uncertainty', 'artifact_reference_mismatch');
    const fresh = revalidate(accepted, input.authority);
    if (fresh.outcome !== 'accepted') return fresh;
    if (input.authority.catalogDigest !== accepted.catalogDigest) return rejected('permission_denied', 'artifact_catalog_changed');
    const registration = ARTIFACT_REGISTRY[plan.artifactTypeId];
    if (!input.authority.permissions.includes(registration.permission)) return rejected('permission_denied', 'artifact_permission');
    if (registration.format !== plan.outputFormat) return rejected('unsupported_concept', 'artifact_format');
    // Persisted evidence includes filter fields and calculator inputs, not just displayed measures.
    // `comparison` is registered ClaimGraph projection metadata, not a physical/catalog field.
    const retainedIds = unique([...input.bundle.rows.flatMap(row => Object.keys(row.values)),
      ...input.graph.claims.flatMap(claim => [claim.measure, ...Object.keys(claim.dimensions).filter(id => id !== 'comparison'), ...claim.computation.inputs])]);
    const fields = retainedIds.map(id => context.dataset.fields.find(field => field.id === id));
    if (context.dataset.trust !== 'certified' || !['internal', 'public_business'].includes(context.dataset.sensitivity) ||
      fields.some(f => !f || f.trust !== 'certified' || !['internal', 'public_business'].includes(f.sensitivity))) {
      return rejected('semantic_uncertainty', 'artifact_trust');
    }
    const readPermissions = unique([...context.dataset.requiredPermissions, ...fields.flatMap(f => f!.requiredPermissions)]);
    if (!readPermissions.every(permission => input.authority.permissions.includes(permission))) return rejected('permission_denied', 'artifact_retained_field_permission');
    if (!input.bundle.coverage.complete || !input.graph.claims.length) return rejected('incomplete_evidence', 'artifact_coverage');
    if (plan.artifactTypeId === 'ranking' && (!accepted.plan.topN || !input.graph.claims.some(c => c.computation.operation === 'rank'))) {
      return rejected('unsupported_concept', 'ranking_unavailable');
    }
    return finalizeArtifact({ plan, artifactId: input.artifactId, authority: input.authority, latest: input.latest, now: input.now, query: accepted.plan,
      response: input.response, bundle: input.bundle, graph: input.graph, readPermissions, catalogVersion: context.catalog.version, catalogDigest: accepted.catalogDigest,
      binding: { bundle: input.bundle, graph: input.graph, authorityDigest: digest(input.authority) } });
  } catch { return rejected('semantic_uncertainty', 'artifact_provenance'); }
}

/** Keys that record WHEN evidence was read, not WHAT it says: a re-read of the same source state differs only in these. */
const READ_TIME_KEYS = new Set(['readAt', 'retrievedAt']);
function withoutReadTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReadTimes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !READ_TIME_KEYS.has(key)).map(([key, item]) => [key, withoutReadTimes(item)]));
}
/** Digest of an evidence bundle's content (rows, sources and their observed times, scope, coverage, limitations) without its own ref or read times. */
export function evidenceContentDigest(bundle: unknown): string | undefined {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined;
  // Its own ref is derived from the read time; the table family's createdAt IS the read time.
  const content = Object.fromEntries(Object.entries(bundle as Record<string, unknown>).filter(([key]) => key !== 'ref' && key !== 'createdAt'));
  return digest(withoutReadTimes(content));
}
/**
 * A revision continues the SAME answer. Revising re-reads the source state under the actor's current authority, so the re-read bundle
 * carries a new read time (and therefore new evidence / claim-graph / response refs) even when nothing changed. The base matches when
 * the refs are identical, or when the query is identical and the evidence CONTENT is identical (claims and response are computed by the
 * server from exactly that query + evidence). Any changed row, source, coverage or scope is still a mismatch.
 */
function sameRevisionEvidence(base: ArtifactVersion, plan: ArtifactPlan, bundle: unknown): boolean {
  if (sameRef(base.plan.evidence, plan.evidence)) return sameRef(base.plan.claimGraph, plan.claimGraph) && sameRef(base.plan.responsePlan, plan.responsePlan);
  const before = evidenceContentDigest(base.bundle), after = evidenceContentDigest(bundle);
  return before !== undefined && before === after;
}

export interface FinalizeArtifactInput {
  plan: ArtifactPlan; artifactId: string; authority: ArtifactAuthority; latest: LatestArtifact; now: string; query: QueryPlan; response: ArtifactResponse;
  bundle: unknown; graph: unknown; readPermissions: string[]; catalogVersion: number; catalogDigest: string; binding: PreviewBinding;
}
/** Shared tail of every artifact preparation (retail and table evidence): revision/base rules, schema parse, immutable preview, bindings. */
export function finalizeArtifact(input: FinalizeArtifactInput): PrepareArtifactResult {
  const { plan, readPermissions } = input;
  try {
    let revision = 1;
    if (input.latest?.kind === 'absent') {
      if (plan.operation !== 'create' || plan.baseRevision !== null) return rejected('semantic_uncertainty', 'artifact_base_mismatch');
    } else if (input.latest?.kind === 'version') {
      const base = input.latest.artifact;
      if (!validArtifactRecord(base) || !canReadArtifact(base, input.authority) || base.ownerId !== input.authority.id) return rejected('permission_denied', 'artifact_base_access');
      if (plan.operation !== 'revise' || !plan.baseRevision || !sameRef(plan.baseRevision, base.ref) || base.artifactId !== input.artifactId ||
        !sameRef(base.plan.queryPlan, plan.queryPlan) || !sameRevisionEvidence(base, plan, input.bundle)) return rejected('semantic_uncertainty', 'artifact_base_mismatch');
      revision = base.revision + 1;
    } else return rejected('semantic_uncertainty', 'artifact_latest_unknown');
    if (revision > ARTIFACT_LIMITS.versions) return rejected('unsupported_concept', 'artifact_version_budget');
    const body = structuredClone({ version: 1 as const, artifactId: input.artifactId, revision, ownerId: input.authority.id,
      plan, query: input.query, response: input.response, bundle: input.bundle, graph: input.graph,
      readPermissions,
      authority: { id: input.authority.id, version: input.authority.revision, digest: digest(input.authority) },
      catalogSnapshot: { id: 'semantic_catalog', version: input.catalogVersion, digest: input.catalogDigest }, createdAt: input.now });
    const artifact = artifactVersionSchema.parse({ ...body, ref: { id: input.artifactId, version: revision, digest: artifactDigest(body) } });
    if (Buffer.byteLength(JSON.stringify(artifact), 'utf8') > ARTIFACT_LIMITS.bytes) return rejected('unsupported_concept', 'artifact_byte_budget');
    const expiresAt = new Date(Date.parse(input.now) + ARTIFACT_LIMITS.previewMs).toISOString();
    const fingerprint = digest({ artifact: artifact.ref, expiresAt, authority: artifact.authority });
    const preview = freeze({ artifact, expiresAt, ref: { id: `preview:${fingerprint}`, version: 1, digest: fingerprint } });
    trustedArtifacts.add(artifact);
    previewBindings.set(preview, input.binding);
    return { outcome: 'accepted', preview };
  } catch { return rejected('semantic_uncertainty', 'artifact_provenance'); }
}
