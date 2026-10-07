import 'server-only';

import { z } from 'zod';
import type { Actor, Branch, Product, SourceRef, Store } from '../../contracts';
import { businessDateSchema } from '../../contracts';
import { reloadActor } from '../../core/auth';
import { invariant } from '../../core/errors';
import { AIRuntimeError } from '../../ai/errors';
import { assertFinalTextSize } from '../../ai/loop-core';
import { createSemanticCatalog, type SemanticDatasetCatalog, type SemanticField } from '../../dynamic/catalog/semantic';
import { normalizeQueryPlan } from '../../dynamic/plan/normalize';
import { queryPlanSchema, refSchema, type QueryPlan, type Ref } from '../../dynamic/plan/schemas';
import { authority, compactDateSet, rejectionText } from '../../dynamic/runtime';
import { digest, unique } from '../../dynamic/shared';
import { authorizedBranches, rejected, type RejectedPlan } from '../../dynamic/validate/query-plan';
import {
  canonicalizeTablePlan, executeTablePlan, revalidateTablePlan, tableDatasetOf, validateTablePlan,
  type TableAcceptedPlan, type TableClaim, type TableClaims, type TableEvidenceBundle,
} from '../../dynamic/table/engine';
import type { DeriveContext } from '../../dynamic/table/derive';
import { branchLabel, regionLabel } from '../context/display';
import { classifyRejection, type ExecutorAccepted, type ExecutorClarify, type ExecutorDenied } from './shared';
import type { QueryExecutorInput } from './query';

export const TABLE_TOOL = 'table.dynamic_query';
const SERVED_TABLES = ['sales_orders', 'sales_targets', 'inventory_snapshots', 'incidents', 'staffing_summaries', 'mock_tickets'] as const;
const ANSWER_SOURCES_MAX = 500, ANALYSIS_ITEMS_MAX = 100, WINDOW_ROW_BOUND = 50_000;

/** Persisted proof of an accepted table answer: refs only, bounded. Follow-ups and pagination read it back. */
export const tableStateSchema = z.object({
  version: z.literal(3), kind: z.literal('table'), conversationId: z.string().min(1).max(100), turnId: z.string().min(1).max(100),
  revision: z.number().int().positive(), status: z.literal('accepted'), datasetId: z.string().min(1).max(100), datasets: z.array(z.string().min(1).max(100)).max(3),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceText: refSchema, evidenceBundle: refSchema, claimGraph: refSchema, authoritySnapshot: refSchema, catalogSnapshot: refSchema,
  resolvedScope: z.object({ regions: z.array(z.string().min(1).max(40)).max(2000), branchIds: z.array(z.string().min(1).max(100)).max(2000),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(62) }).strict(),
  page: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().positive(), total: z.number().int().nonnegative(), nextCursor: z.string().max(300).nullable() }).strict(),
  parentState: refSchema.nullable(),
}).strict();
export type TableState = z.infer<typeof tableStateSchema>;
/** Exact id of one accepted table state (conversation + revision): what REFERENCE_SET.queryStates / pagination cite. */
export const tableStateIdOf = (conversationId: string, revision: number): string => `table-state:${digest(conversationId).slice(0, 16)}:${revision}`;
export const tableStateId = (state: TableState): string => tableStateIdOf(state.conversationId, state.revision);
/** The revision the NEXT accepted table answer of this conversation will persist with (same scan the persist step uses). */
export async function nextTableRevision(reader: Pick<Store, 'list'>, actor: Actor, conversationId: string): Promise<number> {
  const records = (await reader.list<{ name: string; conversationId: string; state: unknown }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(record => record.name === TABLE_TOOL && record.conversationId === conversationId);
  return Math.max(0, ...records.flatMap(record => { const parsed = tableStateSchema.safeParse(record.state); return parsed.success ? [parsed.data.revision] : []; })) + 1;
}
export const tableStateRef = (state: TableState): Ref => ({ id: `table-state:${digest(state.conversationId).slice(0, 24)}`, version: state.revision, digest: digest(state) });

export type TableQueryResult =
  | (ExecutorAccepted & { kind: 'query'; table: true; plan: TableAcceptedPlan; bundle: TableEvidenceBundle; claims: TableClaims;
    /** Id the state will have once this turn persists (what a later step / effect proposal binds to); absent without a conversation. */
    expectedStateId?: string })
  | (ExecutorClarify & { kind: 'query' })
  | (ExecutorDenied & { kind: 'query' });

const numberFormat = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const isRejected = (value: unknown): value is RejectedPlan => typeof value === 'object' && value !== null && 'outcome' in value &&
  (value as { outcome: string }).outcome !== 'accepted' && (value as { outcome: string }).outcome !== 'normalized';

/** The conversation's accepted table states (newest first) whose authority and catalog are still current. */
export async function loadTableStates(reader: Pick<Store, 'list'>, actor: Actor, conversationId: string, catalog: SemanticDatasetCatalog): Promise<{ state: TableState; plan: QueryPlan; createdAt: string }[]> {
  const records = (await reader.list<{ name: string; actorId: string; sessionId: string; conversationId: string; state: unknown; plan: unknown; createdAt?: string }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(r => r.name === TABLE_TOOL && r.conversationId === conversationId && r.actorId === actor.id);
  const current = digest(authority(actor));
  return records.flatMap(record => {
    const state = tableStateSchema.safeParse(record.state), plan = queryPlanSchema.safeParse(record.plan);
    if (!state.success || !plan.success || digest(plan.data) !== state.data.planDigest || state.data.conversationId !== conversationId) return [];
    if (state.data.authoritySnapshot.digest !== current || state.data.catalogSnapshot.digest !== catalog.digest) return [];
    return [{ state: state.data, plan: plan.data, createdAt: record.createdAt ?? '' }];
  }).sort((a, b) => b.state.revision - a.state.revision);
}

/** Served-date window over the actor's permitted branches (same rule as the branch executor, plus tickets). */
async function servedWindow(store: Store, permitted: ReadonlySet<string>): Promise<{ min: string; max: string } | null> {
  const dates = new Set<string>();
  for (const table of SERVED_TABLES) {
    // Bounded like every other read: authorized branches pushed into the store, capped at the window row bound.
    for (const row of await store.list<{ branchId: string; date?: string; createdAt?: string }>(table, { branchId: [...permitted] }, { limit: WINDOW_ROW_BOUND })) {
      const date = row.date ?? (typeof row.createdAt === 'string' ? row.createdAt.slice(0, 10) : undefined);
      if (permitted.has(row.branchId) && date && businessDateSchema.safeParse(date).success) dates.add(date);
    }
  }
  const sorted = [...dates].sort();
  return sorted.length ? { min: sorted[0], max: sorted.at(-1)! } : null;
}

const fieldFor = (accepted: TableAcceptedPlan, id: string): SemanticField | undefined => {
  const dot = id.indexOf('.');
  const dataset = dot < 0 ? accepted.dataset : accepted.joined.find(d => d.id === id.slice(0, dot));
  return dataset?.fields.find(f => f.id === (dot < 0 ? id : id.slice(dot + 1)));
};
function dimensionText(field: SemanticField | undefined, id: string, value: string, branches: ReadonlyMap<string, Branch>): string {
  if (id === 'branch' || id.endsWith('.branch')) { const branch = branches.get(value); return branch ? branchLabel(branch) : `สาขา ${value}`; }
  if (id === 'region') return regionLabel(value);
  const label = field?.canonicalValues?.find(v => v.id === value)?.label ?? value;
  return `${field?.displayLabel ?? id} ${label}`;
}
function valueText(field: SemanticField | undefined, value: unknown): string {
  if (value === null || value === undefined) return 'ไม่มีข้อมูลให้ยืนยัน';
  if (typeof value === 'number') return `${numberFormat.format(value)}${field?.displayUnit ? ` ${field.displayUnit}` : ''}`;
  return String(value);
}
/** One Thai sentence per claim; every number is copied from the claim (never computed here). */
export function renderTableClaim(accepted: TableAcceptedPlan, claim: TableClaim, branches: ReadonlyMap<string, Branch>): string {
  if (claim.fieldId === accepted.dataset.id && typeof claim.value === 'object' && claim.value !== null) {
    // A record's own count measure is always 1: the listing's total is its own headline claim, so the record shows its other values.
    const entries = Object.entries(claim.value);
    const counted = new Set(accepted.plan.measures.filter(m => m.aggregation === 'count').map(m => m.fieldId));
    const shown = entries.some(([id]) => !counted.has(id)) ? entries.filter(([id]) => !counted.has(id)) : entries;
    const parts = shown.map(([id, value]) => {
      const field = fieldFor(accepted, id);
      if (field?.kind === 'dimension') return id === 'branch' ? dimensionText(field, id, String(value), branches) : id === 'region' ? regionLabel(String(value)) : `${field.displayLabel ?? id} ${field.canonicalValues?.find(v => v.id === value)?.label ?? value}`;
      return `${field?.displayLabel ?? id} ${valueText(field, value)}`;
    });
    return `${parts.join(' · ')}.`;
  }
  const field = fieldFor(accepted, claim.fieldId);
  const subject = Object.entries(claim.dimensions).map(([id, value]) => dimensionText(fieldFor(accepted, id), id, value, branches)).join(' และ ');
  return `${subject ? `${subject} มี` : 'รวม'}${field?.displayLabel ?? 'Metric'} ${valueText(field, claim.value)}.`;
}
export function renderTableAnswer(accepted: TableAcceptedPlan, bundle: TableEvidenceBundle, claims: TableClaims, branches: ReadonlyMap<string, Branch>): { text: string; facts: string[] } {
  const datasets = [accepted.dataset, ...accepted.joined].map(d => d.label ?? d.id).join(' + ');
  const regions = accepted.scope.regions.map(regionLabel).join(', ');
  const measures = accepted.plan.measures.map(m => fieldFor(accepted, m.fieldId)?.displayLabel ?? 'Metric').join(', ');
  const interpreted = `ขอบเขตที่ตีความ: ${datasets}; ช่วงวันที่ ${compactDateSet(accepted.dates)}; ภูมิภาค ${regions}; ${numberFormat.format(accepted.scope.branchIds.length)} สาขา; ${measures ? `Metric ${measures}` : 'รายการข้อมูล'}.`;
  const labels = accepted.interpretationLabels.filter(l => !l.startsWith('วันที่ธุรกิจ') && !l.startsWith('ขอบเขตเริ่มต้น:') && !l.startsWith('จำกัดขอบเขตตามสิทธิ์ของคุณ'));
  const facts = claims.claims.map(claim => renderTableClaim(accepted, claim, branches));
  const page = bundle.page;
  // One ungrouped total is not a list: no "showing 1–1 of 1" line next to it.
  const singleTotal = accepted.mode === 'groups' && !accepted.plan.group.fieldIds.length && page.total === 1;
  const paging = singleTotal ? '' : page.total === 0 ? 'ไม่พบรายการที่ตรงกับเงื่อนไขในหลักฐานที่ตรวจสอบได้.'
    : `แสดงรายการที่ ${numberFormat.format(page.offset + 1)}–${numberFormat.format(page.offset + bundle.rows.length)} จากทั้งหมด ${numberFormat.format(page.total)} รายการ${page.nextCursor ? ' (ขอให้แสดงต่อเพื่อดูหน้าถัดไป)' : ''}.`;
  return { text: unique([interpreted, ...labels, ...bundle.limitations, ...facts, paging].filter(Boolean)).join('\n'), facts };
}

/**
 * Executes an accepted `query` step over a registered table dataset (inventory_items, incident_log, support_tickets): the same
 * QueryPlan -> validator -> compiler -> registered reader -> EvidenceBundle path as the branch dataset, with its own registered
 * reader. Planner output never carries SQL, expressions or join keys; the server supplies every executable thing.
 */
export async function executeTableQueryStep(input: QueryExecutorInput): Promise<TableQueryResult> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const actor = await reloadActor(input.store, input.actor, input.now());
  const branchList = await input.store.list<Branch>('branches');
  const catalog = createSemanticCatalog(branchList);
  const initialAuthority = authority(actor);
  const dataset = tableDatasetOf(catalog, input.step.plan.datasetId);
  const refuse = (rejection: RejectedPlan, window?: { min: string; max: string } | null): TableQueryResult => {
    if (rejection.outcome === 'execution_failed') throw new AIRuntimeError('tool_execution_failed', 'The registered table reader could not complete the query.');
    const refused = classifyRejection('query', rejection, rejectionText(rejection, catalog, actor, window));
    assertFinalTextSize(refused.text);
    return { ...refused, kind: 'query' };
  };
  if (!dataset) return refuse(rejected('unsupported_concept', 'dataset_mismatch'));

  const states = input.continuation && input.continuation !== 'none' && input.conversationId ? await loadTableStates(input.store, actor, input.conversationId, catalog) : [];
  const previous = states.find(s => s.state.datasetId === dataset.id) ?? states[0];
  const permitted = new Set(authorizedBranches(catalog, initialAuthority).map(b => b.id));
  const window = await servedWindow(input.store, permitted);
  signal.throwIfAborted();
  const products = await input.store.list<Product>('products');
  const canonical = canonicalizeTablePlan(input.step.plan, dataset, { previousPlan: previous?.plan,
    authorizedRegions: unique(authorizedBranches(catalog, initialAuthority).map(b => b.region)) });
  const normalized = normalizeQueryPlan(canonical, input.message, input.businessDate, previous?.state.resolvedScope.dates, { availability: window });
  if (normalized.outcome !== 'normalized') return refuse(normalized, window);
  const validated = validateTablePlan({ proposal: normalized.plan, catalog, authority: initialAuthority, sourceText: input.message, businessDate: input.businessDate,
    availabilityWindow: window, previousPlan: previous?.plan, products });
  if (isRejected(validated)) return refuse(validated, window);
  const accepted: TableAcceptedPlan = validated;

  const context: DeriveContext = { branches: new Map(branchList.map(b => [b.id, b])), products: new Map(products.map(p => [p.id, p])) };
  const executed = await executeTablePlan({ reader: input.store, accepted, context, readAt: input.now().toISOString(),
    freshAuthority: async () => authority(await reloadActor(input.store, actor, input.now())),
    currentCatalog: async () => createSemanticCatalog(await input.store.list<Branch>('branches')) });
  signal.throwIfAborted();
  if (executed.outcome !== 'accepted') return refuse(executed, window);
  const { bundle, claims } = executed;
  if (!claims.claims.length) return { outcome: 'denied', kind: 'query', code: 'no_matching_claims', text: 'ไม่พบข้อมูลที่ตรงกับเงื่อนไขในขอบเขตที่คุณเข้าถึงได้' };
  const rendered = renderTableAnswer(accepted, bundle, claims, context.branches);
  assertFinalTextSize(rendered.text);

  const bundleSources = new Map(bundle.sources.map(s => [s.id, s]));
  const sources: SourceRef[] = bundle.sources.slice(0, ANSWER_SOURCES_MAX).map(s => ({ id: s.id, system: s.system, observedAt: s.observedAt, retrievedAt: s.retrievedAt,
    freshness: 'fresh', detail: `${accepted.dataset.label ?? accepted.dataset.id}: ${s.id}` }));
  const kept = new Set(sources.map(s => s.id));
  const boundedIds = (ids: readonly string[]) => [...new Set(ids)].filter(id => kept.has(id) && bundleSources.has(id)).slice(0, 100);
  const analysis = {
    facts: claims.claims.slice(0, ANALYSIS_ITEMS_MAX).map((claim, index) => ({ text: rendered.facts[index], sourceIds: boundedIds(claim.sourceRefs) })),
    relationships: [], hypotheses: [], missingEvidence: bundle.limitations.map(text => ({ text, sourceIds: [] })),
    generatedAt: input.now().toISOString(), evidenceVersion: bundle.ref.digest,
  };
  const sourceText: Ref = { id: `source:${input.diagnosticId}`, version: 1, digest: digest(input.message) };
  const parentState: Ref | null = previous ? tableStateRef(previous.state) : null;
  const expectedStateId = input.conversationId ? tableStateIdOf(input.conversationId, await nextTableRevision(input.store, actor, input.conversationId)) : undefined;
  const buildState = (conversationId: string, revision: number, parent: Ref | null, authoritySnapshot: Ref, catalogSnapshot: Ref): TableState => tableStateSchema.parse({
    version: 3, kind: 'table', conversationId, turnId: input.diagnosticId, revision, status: 'accepted', datasetId: accepted.dataset.id,
    datasets: [accepted.dataset.id, ...accepted.joined.map(d => d.id)], planDigest: accepted.planDigest, bindingDigest: accepted.bindingDigest, sourceText,
    evidenceBundle: bundle.ref, claimGraph: claims.ref, authoritySnapshot, catalogSnapshot,
    resolvedScope: { regions: [...accepted.scope.regions], branchIds: [...accepted.scope.branchIds], dates: [...accepted.dates] },
    page: { offset: bundle.page.offset, limit: bundle.page.limit, total: bundle.page.total, nextCursor: bundle.page.nextCursor }, parentState: parent });

  return {
    outcome: 'accepted', kind: 'query', table: true, text: rendered.text, sources, analysis, plan: accepted, bundle, claims, ...(expectedStateId ? { expectedStateId } : {}),
    interpretedScope: { datasetId: accepted.dataset.id, dates: [...accepted.dates], regions: [...accepted.scope.regions],
      branchIds: [...accepted.scope.branchIds], measures: accepted.plan.measures.map(m => m.fieldId) },
    persist: async (tx, finalActor, conversationId) => {
      const finalAuthority = authority(finalActor);
      invariant(digest(finalAuthority) === accepted.authorityDigest, 'FORBIDDEN', 'Your query authority changed before the response could be saved.', 403);
      const currentCatalog = createSemanticCatalog(await tx.list<Branch>('branches'));
      const rechecked = revalidateTablePlan(accepted, finalAuthority, currentCatalog);
      invariant(!isRejected(rechecked), 'FORBIDDEN', 'The query population changed before the response could be saved.', 403);
      const records = (await tx.list<{ name: string; conversationId: string; state: unknown }>('tool_executions', {
        actorId: finalActor.id, sessionId: finalActor.sessionId, status: 'completed',
      })).filter(record => record.name === TABLE_TOOL && record.conversationId === conversationId);
      const latest = records.flatMap(record => { const parsed = tableStateSchema.safeParse(record.state); return parsed.success ? [parsed.data] : []; })
        .sort((a, b) => b.revision - a.revision)[0];
      if (parentState) invariant(latest && digest(tableStateRef(latest)) === digest(parentState), 'CONFLICT', 'The prior query state changed before the follow-up could be saved.', 409);
      const finalState = buildState(conversationId, (latest?.revision ?? 0) + 1, parentState,
        { id: finalActor.id, version: finalAuthority.revision, digest: digest(finalAuthority) }, { id: 'semantic_catalog', version: 1, digest: currentCatalog.digest });
      invariant(!expectedStateId || tableStateId(finalState) === expectedStateId, 'CONFLICT', 'The conversation changed before the table answer could be saved.', 409);
      const recordId = `dynamic-table:${input.diagnosticId}`;
      invariant(!await tx.get('tool_executions', recordId), 'CONFLICT', 'The query proof already exists.', 409);
      await tx.put('tool_executions', { id: recordId, name: TABLE_TOOL, status: 'completed', actorId: finalActor.id, sessionId: finalActor.sessionId,
        conversationId, turnId: input.diagnosticId, plan: accepted.plan, bundle, claims, state: finalState, createdAt: input.now().toISOString() });
    },
  };
}
