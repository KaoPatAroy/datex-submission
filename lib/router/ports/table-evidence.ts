import type { Actor, Branch, Store } from '../../contracts';
import { renderNumericClaim, authority as queryAuthority } from '../../dynamic/runtime';
import { createSemanticCatalog, type SemanticDataset, type SemanticDatasetCatalog } from '../../dynamic/catalog/semantic';
import { queryPlanSchema, type QueryPlan } from '../../dynamic/plan/schemas';
import { digest, unique } from '../../dynamic/shared';
import type { TableClaims, TableEvidenceBundle } from '../../dynamic/table/engine';
import type { NumericClaim } from '../../dynamic/evidence/claim-graph';
import { snapshotRef, type ContentClaim, type EvidenceSnapshot } from '../../effects/shared';
import { tableFacts } from '../../artifacts/table-prepare';
import { TABLE_TOOL, tableStateId, tableStateSchema, type TableState } from '../executors/table-query';

/**
 * An accepted answer over a registered TABLE dataset, as an effect source (communication.send): either the in-turn answer of step 0 or a
 * stored state re-loaded and re-checked against the CURRENT authority and catalog. Content text is the trusted `renderNumericClaim`
 * rendering of the evidenced numeric facts, so no number can enter a message that is not in the verified table claims.
 */
export interface TableAcceptedEvidence {
  table: true; stateId: string; plan: QueryPlan; dataset: SemanticDataset; joined: readonly SemanticDataset[];
  bundle: TableEvidenceBundle; claims: TableClaims; catalog: SemanticDatasetCatalog; datasetPermissions: string[];
}
export const isTableEvidence = (value: unknown): value is TableAcceptedEvidence => !!value && typeof value === 'object' && (value as { table?: unknown }).table === true;

const MAX_CLAIMS = 32, MAX_TEXT = 4000;

/** Re-load one of THIS actor's accepted table states and re-check it against the current authority and catalog. */
export async function loadAcceptedTableEvidence(store: Store, actor: Actor, stateId: string): Promise<TableAcceptedEvidence | undefined> {
  if (!stateId.startsWith('table-state:')) return undefined;
  const catalog = createSemanticCatalog(await store.list<Branch>('branches'));
  const permitted = new Set(catalog.branches.filter(b => actor.regions.includes('*') || actor.regions.includes(b.region)).map(b => b.id));
  const currentAuthority = digest(queryAuthority(actor));
  const records = (await store.list<{ name: string; actorId: string; sessionId: string; state: unknown; plan: unknown; bundle: TableEvidenceBundle; claims: TableClaims }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(r => r.name === TABLE_TOOL && r.actorId === actor.id);
  for (const record of records) {
    const parsed = tableStateSchema.safeParse(record.state), plan = queryPlanSchema.safeParse(record.plan);
    if (!parsed.success || !plan.success || tableStateId(parsed.data) !== stateId) continue;
    const state: TableState = parsed.data, { bundle, claims } = record;
    if (!bundle?.ref || !claims?.claims) return undefined;
    const { ref, ...payload } = bundle, { ref: claimRef, ...claimPayload } = claims;
    if (digest(payload) !== ref.digest || ref.digest !== state.evidenceBundle.digest || digest(claimPayload) !== claimRef.digest || claimRef.digest !== state.claimGraph.digest ||
      claims.evidence.digest !== ref.digest || digest(plan.data) !== state.planDigest) return undefined;
    if (state.authoritySnapshot.id !== actor.id || state.authoritySnapshot.digest !== currentAuthority || state.catalogSnapshot.digest !== catalog.digest ||
      state.resolvedScope.branchIds.some(id => !permitted.has(id))) return undefined;
    const dataset = catalog.datasets.find(d => d.id === state.datasetId);
    const joined = state.datasets.slice(1).flatMap(id => catalog.datasets.filter(d => d.id === id));
    if (!dataset || joined.length !== state.datasets.length - 1) return undefined;
    return { table: true, stateId, plan: plan.data, dataset, joined, bundle, claims, catalog,
      datasetPermissions: unique([...dataset.requiredPermissions, ...joined.flatMap(d => d.requiredPermissions)]) };
  }
  return undefined;
}

/** Base-dataset numeric facts -> trusted ContentClaim snapshots (bounded to 32 claims / 4000 chars; null values never become text). */
export function contentFromTableEvidence(found: TableAcceptedEvidence, uses: ContentClaim['allowedUses'], evidenceExpiresAt: number): { claims: ContentClaim[]; evidence: EvidenceSnapshot } | undefined {
  const { bundle, claims, catalog, datasetPermissions } = found;
  const branchRegion = new Map(catalog.branches.map(b => [b.id, b.region]));
  const readAt = Date.parse(bundle.createdAt);
  const evidence: EvidenceSnapshot = { ref: bundle.ref, regions: [...bundle.scope.regions], permissions: datasetPermissions, fresh: bundle.sources.length > 0, complete: bundle.coverage.complete,
    trust: 'certified', sensitive: false, expiresAt: evidenceExpiresAt, sourceIds: bundle.sources.map(s => s.id), ...(Number.isFinite(readAt) ? { observedAt: readAt } : {}) };
  const out: ContentClaim[] = [];
  let length = 0;
  const facts = tableFacts({ accepted: { dataset: found.dataset, joined: found.joined, plan: found.plan }, bundle, claims });
  for (const fact of facts) {
    if (out.length >= MAX_CLAIMS) break;
    // Joined (qualified) measures need the joined dataset's labels; only the base dataset's facts are worded.
    if (fact.value === null || fact.measure.includes('.')) continue;
    const text = renderNumericClaim(fact as unknown as NumericClaim, catalog);
    if (!text || length + text.length + 1 > MAX_TEXT) break;
    length += text.length + 1;
    const branch = fact.dimensions.branch, region = fact.dimensions.region;
    const regions = branch && branchRegion.get(branch) ? [branchRegion.get(branch)!] : region ? [region] : [...bundle.scope.regions];
    const subjectIds = branch ? [branch] : [...bundle.scope.branchIds].slice(0, 1000);
    out.push({ ref: snapshotRef(`claim:${digest({ graph: claims.ref.digest, claim: fact.id }).slice(0, 24)}`, 1, { graph: claims.ref.digest, claim: fact }),
      regions: [...new Set(regions)].sort(), permissions: datasetPermissions, text, evidence: bundle.ref, allowedUses: uses, subjectIds: [...new Set(subjectIds)].sort() });
  }
  return out.length ? { claims: out, evidence } : undefined;
}
