import 'server-only';

import type { Actor, Branch, Profile, Store } from '../../contracts';
import { reloadActor } from '../../core/auth';
import { DomainError } from '../../core/errors';
import type { ArtifactAuthority, ArtifactVersion } from '../../artifacts';
import { isArtifactSaved, loadSharedStoredArtifact, loadStoredArtifact, createArtifactReader } from '../../artifacts/store';
import { issueShareGrant } from '../../artifacts/grant';
import { resolveCurrentShare } from '../../artifacts/shared-store';
import { createSemanticCatalog, type SemanticDatasetCatalog } from '../../dynamic/catalog/semantic';
import { queryPlanSchema } from '../../dynamic/plan/schemas';
import { authority as queryAuthority, type DynamicQueryInput } from '../../dynamic/runtime';
import {
  compileArtifactRenderer, type ArtifactFact, type ArtifactLabels, type ArtifactRendererSpec, type VisualExpression, type VisualTraits,
} from '../../visualization';
import { personLabel } from '../context/display';
import { artifactLabelsFromDataset, artifactLabelsFromTable, visualTraitsFromDataset } from './artifact';
import { executeQueryStep } from './query';
import { executeTableQueryStep, TABLE_TOOL } from './table-query';
import { tableFacts } from '../../artifacts/table-prepare';

export interface ArtifactReadDeps { store: Store; actor: Actor; now: () => Date }

interface Ctx { actor: Actor; catalog: SemanticDatasetCatalog; authority: ArtifactAuthority; labels?: ArtifactLabels; traits?: VisualTraits }
async function context(deps: ArtifactReadDeps): Promise<Ctx> {
  const actor = await reloadActor(deps.store, deps.actor, deps.now());
  const catalog = createSemanticCatalog(await deps.store.list<Branch>('branches'));
  const dataset = catalog.datasets.find(d => d.id === 'branch_performance');
  return { actor, catalog, authority: { ...queryAuthority(actor), catalogDigest: catalog.digest },
    ...(dataset ? { labels: artifactLabelsFromDataset(dataset), traits: visualTraitsFromDataset(dataset) } : {}) };
}
/** Labels/traits of the dataset an artifact was made from (branch performance or a registered table dataset, with its joined datasets). */
function datasetViewOf(ctx: Ctx, artifact: ArtifactVersion): { labels?: ArtifactLabels; traits?: VisualTraits } {
  const dataset = ctx.catalog.datasets.find(d => d.id === artifact.query.datasetId);
  if (!dataset) return { ...(ctx.labels ? { labels: ctx.labels } : {}), ...(ctx.traits ? { traits: ctx.traits } : {}) };
  const joined = (artifact.query.joins ?? []).flatMap(j => ctx.catalog.datasets.filter(d => d.id === j.datasetId));
  return { labels: joined.length ? artifactLabelsFromTable({ dataset, joined }) : artifactLabelsFromDataset(dataset), traits: visualTraitsFromDataset(dataset) };
}
const unavailable = (): never => { throw new DomainError('ARTIFACT_RENDER_DENIED', 'สิทธิ์หรือแคตตาล็อกปัจจุบันไม่ครอบคลุมผลลัพธ์นี้ จึงแสดงไม่ได้ — โปรดสร้างผลลัพธ์ใหม่จากข้อมูลล่าสุด', 403); };

export interface ArtifactHistoryItem {
  id: string; title: string; kind: ArtifactVersion['plan']['artifactTypeId']; conversationId: string;
  latestRevision: number; revisions: number[]; savedRevision: number | null; savedAt: string | null; updatedAt: string;
}

/** The actor's own artifacts across conversations, newest first, with every immutable revision number (reload targets). */
export async function listArtifactHistory(deps: ArtifactReadDeps): Promise<ArtifactHistoryItem[]> {
  const actor = await reloadActor(deps.store, deps.actor, deps.now());
  const heads = await createArtifactReader(deps.store, actor.id).listAll();
  return heads.slice(0, 50).map(head => ({ id: head.artifactId, title: head.title, kind: head.kind, conversationId: head.conversationId,
    latestRevision: head.revision, revisions: Array.from({ length: Math.min(head.revision, 100) }, (_, i) => i + 1),
    savedRevision: head.savedRef?.version ?? null, savedAt: head.savedAt ?? null, updatedAt: head.updatedAt }));
}

export interface OpenedArtifact {
  spec: ArtifactRendererSpec; artifact: { id: string; revision: number; kind: string; title: string };
  latestRevision: number; saved: boolean; shared: boolean;
}

/** Reloads one immutable version under CURRENT authority + catalog and compiles it with the very expression it was previewed with. */
export async function openArtifactVersion(deps: ArtifactReadDeps, artifactId: string, revision?: number): Promise<OpenedArtifact> {
  const ctx = await context(deps);
  const { artifact, head, visual } = await loadStoredArtifact(deps.store, ctx.authority, artifactId, revision);
  const compiled = compileArtifactRenderer({ artifact, authority: ctx.authority, visualExpression: visual as VisualExpression | null,
    ...datasetViewOf(ctx, artifact), legacyChartWithoutVisual: true });
  if (compiled.outcome !== 'accepted') return unavailable();
  return { spec: compiled.spec, artifact: { id: artifact.artifactId, revision: artifact.revision, kind: artifact.plan.artifactTypeId, title: artifact.plan.title },
    latestRevision: head.revision, saved: !!head.savedRef && head.savedRef.version === artifact.revision && isArtifactSaved({ ref: artifact.ref, savedRef: head.savedRef }), shared: false };
}

/**
 * A recipient opens an artifact through one of THEIR OWN inbox messages. The owner's exact version is reloaded and the
 * recipient is reauthorized for its whole stored scope (current permissions, regions and catalog) on every open.
 */
export async function openSharedArtifact(deps: ArtifactReadDeps, messageId: string): Promise<OpenedArtifact> {
  const ctx = await context(deps);
  const link = await resolveCurrentShare(deps.store, ctx.actor.id, messageId);
  const sender = await deps.store.get<Profile>('profiles', link.share.actorId) as Profile;
  const grant = issueShareGrant({ artifact: link.share.ref, senderId: link.share.actorId, recipientId: ctx.actor.id });
  const { artifact, visual } = await loadSharedStoredArtifact(deps.store, { ownerId: link.share.actorId, authority: ctx.authority, grant,
    artifactId: link.share.artifactId, revision: link.share.revision });
  const compiled = compileArtifactRenderer({ artifact, authority: ctx.authority, grant, visualExpression: visual as VisualExpression | null,
    ...datasetViewOf(ctx, artifact), legacyChartWithoutVisual: true });
  if (compiled.outcome !== 'accepted') return unavailable();
  return { spec: { ...compiled.spec, sharedBy: personLabel(sender) }, artifact: { id: artifact.artifactId, revision: artifact.revision, kind: artifact.plan.artifactTypeId, title: artifact.plan.title },
    latestRevision: artifact.revision, saved: false, shared: true };
}

/** A read view where the viewer's own profile carries regions intersected with a stored scope: every reload inside the registered query path sees the bounded authority (never wider). */
function boundedStore(store: Store, viewerId: string, bound: readonly string[]): Store {
  const narrow = <T>(row: T): T => { const p = row as unknown as Profile | undefined;
    return p && p.id === viewerId ? { ...p, regions: p.regions.includes('*') ? [...bound] : p.regions.filter(region => bound.includes(region)) } as unknown as T : row; };
  return { adapter: store.adapter,
    get: async <T>(table: Parameters<Store['get']>[0], id: string) => { const row = await store.get<T>(table, id); return table === 'profiles' ? narrow(row) : row; },
    list: async <T>(table: Parameters<Store['list']>[0], filters?: Parameters<Store['list']>[1], options?: Parameters<Store['list']>[2]) => {
      const rows = await store.list<T>(table, filters, options); return table === 'profiles' ? rows.map(narrow) : rows; },
    transaction: work => store.transaction(work) };
}

export interface ArtifactDrillInput { artifactId: string; revision?: number; field: string; value: string; messageId?: string }
export interface ArtifactDrillResult { field: string; value: string; facts: ArtifactFact[]; labels?: ArtifactLabels; matchesVersion: boolean; note: string }
export interface ArtifactDrillDeps extends ArtifactReadDeps {
  businessDate: string; read: DynamicQueryInput['read']; signal?: AbortSignal;
}

/**
 * Drilldown = a LINKED READ, never a client-side peek: the viewer (owner or share recipient) is reauthorized against the whole
 * stored scope, then the artifact's exact registered QueryPlan is re-run through the registered query path
 * (executeQueryStep: validate -> compile -> authorized reader -> ClaimGraph) under the viewer's CURRENT authority, and only the
 * claims of the selected group are returned, with a flag saying whether they still equal the immutable version.
 */
export async function drillArtifact(deps: ArtifactDrillDeps, input: ArtifactDrillInput): Promise<ArtifactDrillResult> {
  const ctx = await context(deps);
  let artifact: ArtifactVersion;
  if (input.messageId) {
    const link = await resolveCurrentShare(deps.store, ctx.actor.id, input.messageId);
    if (link.share.artifactId !== input.artifactId) throw new DomainError('NOT_FOUND', 'ไม่พบผลลัพธ์ที่แชร์', 404);
    const grant = issueShareGrant({ artifact: link.share.ref, senderId: link.share.actorId, recipientId: ctx.actor.id });
    artifact = (await loadSharedStoredArtifact(deps.store, { ownerId: link.share.actorId, authority: ctx.authority, grant, artifactId: link.share.artifactId, revision: link.share.revision })).artifact;
  } else {
    artifact = (await loadStoredArtifact(deps.store, ctx.authority, input.artifactId, input.revision)).artifact;
  }
  const refuse = (text: string): never => { throw new DomainError('ARTIFACT_DRILL_DENIED', text, 403); };
  const target = artifact.graph.claims.filter(claim => claim.dimensions[input.field] === input.value);
  if (!artifact.query.dimensions.some(d => d.fieldId === input.field) || !target.length) return refuse('กลุ่มที่เลือกไม่อยู่ในผลลัพธ์นี้');
  const isTable = artifact.query.datasetId !== 'branch_performance';
  const records = (await deps.store.list<{ name: string; actorId: string; turnId: string; plan: unknown; bundle?: { ref?: { digest?: string } }; state?: { planDigest?: string } }>('tool_executions',
    { actorId: artifact.ownerId, status: 'completed' })).filter(r => isTable ? r.name === TABLE_TOOL && r.state?.planDigest === artifact.bundle.query.digest
    : r.name === 'retail.dynamic_query' && r.bundle?.ref?.digest === artifact.bundle.ref.digest);
  const record = records[0];
  const plan = record ? queryPlanSchema.safeParse(record.plan) : undefined;
  const message = record ? await deps.store.get<{ text: string; actorId: string; role: string }>('conversation_messages', record.turnId) : undefined;
  if (!record || !plan?.success || !message || message.actorId !== artifact.ownerId || message.role !== 'user') return refuse('ยังเจาะลึกผลลัพธ์นี้ไม่ได้ในตอนนี้ — โปรดถามข้อมูลใหม่');
  // The rerun is bounded to the artifact's STORED region scope (intersected with the viewer's current authority): a wider viewer never widens it.
  const storedRegions = artifact.bundle.scope.regions, storedBranches = new Set(artifact.bundle.scope.branchIds);
  const rerun = { store: boundedStore(deps.store, ctx.actor.id, storedRegions), actor: ctx.actor, message: message.text, businessDate: deps.businessDate,
    diagnosticId: `drill:${artifact.ref.digest.slice(0, 16)}`, now: deps.now, read: deps.read, ...(deps.signal ? { signal: deps.signal } : {}),
    step: { kind: 'query' as const, continuation: false, plan: plan.data } };
  let facts: ArtifactFact[];
  if (isTable) {
    // L6: table-dataset artifacts re-run through the registered TABLE executor and project facts exactly like the artifact preview did.
    const result = await executeTableQueryStep(rerun);
    if (result.outcome !== 'accepted') return refuse('ยังอ่านข้อมูลรายละเอียดซ้ำไม่ได้ภายใต้สิทธิ์ปัจจุบัน');
    if (storedBranches.size && result.bundle.scope.branchIds.some(id => !storedBranches.has(id))) return refuse('ขอบเขตข้อมูลปัจจุบันกว้างกว่าผลลัพธ์ที่บันทึกไว้ จึงเจาะลึกไม่ได้ — โปรดสร้างผลลัพธ์ใหม่');
    facts = tableFacts({ accepted: result.plan, bundle: result.bundle, claims: result.claims }).filter(fact => fact.dimensions[input.field] === input.value).map(fact => ({
      claimId: fact.id, measure: fact.measure, value: fact.value, unit: fact.unit, dimensions: { ...fact.dimensions }, rowRefs: [...fact.rowRefs], sourceRefs: [...fact.sourceRefs], operation: fact.computation.operation }));
  } else {
    const result = await executeQueryStep(rerun);
    if (result.outcome !== 'accepted') return refuse('ยังอ่านข้อมูลรายละเอียดซ้ำไม่ได้ภายใต้สิทธิ์ปัจจุบัน');
    if (storedBranches.size && result.bundle.scope.branchIds.some(id => !storedBranches.has(id))) return refuse('ขอบเขตข้อมูลปัจจุบันกว้างกว่าผลลัพธ์ที่บันทึกไว้ จึงเจาะลึกไม่ได้ — โปรดสร้างผลลัพธ์ใหม่');
    facts = result.claims.claims.filter(claim => claim.dimensions[input.field] === input.value).map(claim => ({
      claimId: claim.id, measure: claim.measure, value: claim.value, unit: claim.unit, dimensions: { ...claim.dimensions }, rowRefs: [...claim.rowRefs],
      sourceRefs: [...claim.sourceRefs], operation: claim.computation.operation, ...(claim.caveat ? { caveat: claim.caveat } : {}) }));
  }
  if (!facts.length) return refuse('กลุ่มที่เลือกไม่มีข้อมูลในการอ่านซ้ำภายใต้สิทธิ์ปัจจุบัน');
  const same = (a: ArtifactFact[], b: typeof target) => a.length === b.length && a.every(f => b.some(c => c.id === f.claimId && c.value === f.value));
  const labels = datasetViewOf(ctx, artifact).labels;
  return { field: input.field, value: input.value, facts, ...(labels ? { labels } : {}),
    matchesVersion: same(facts, target),
    note: 'อ่านข้อมูลของรายการที่เลือกจาก Source อีกครั้ง และตรวจสิทธิ์ปัจจุบันของคุณแล้ว' };
}

