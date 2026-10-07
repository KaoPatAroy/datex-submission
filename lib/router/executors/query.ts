import 'server-only';

import type { Actor, Branch, Scope, SourceRef, Store } from '../../contracts';
import { businessDateSchema } from '../../contracts';
import { canRegion, reloadActor } from '../../core/auth';
import { invariant } from '../../core/errors';
import { AIRuntimeError } from '../../ai/errors';
import { assertFinalTextSize } from '../../ai/loop-core';
import { createSemanticCatalog } from '../../dynamic/catalog/semantic';
import { compileQueryPlan, executeReadRequest } from '../../dynamic/compile/reader';
import type { EvidenceBundle } from '../../dynamic/evidence/bundle';
import { buildClaimGraph, type ClaimGraph } from '../../dynamic/evidence/claim-graph';
import { enrichEvidenceBundle } from '../../dynamic/evidence/completeness';
import { createPresentationClaims } from '../../dynamic/response/claims';
import { composeResponse, type ComposedResponse } from '../../dynamic/response/compose';
import { canonicalizeQueryPlan } from '../../dynamic/plan/canonical';
import { normalizeQueryPlan } from '../../dynamic/plan/normalize';
import { conversationStateRef } from '../../dynamic/planner/planner';
import {
  authority, crossGroupComparisons, currentEvidence, previousState, rejectionText, renderClaims, renderNumericClaim, validateAvailable,
  type DynamicQueryInput,
} from '../../dynamic/runtime';
import type { QueryPlan } from '../../dynamic/plan/schemas';
import { conversationStateSchema, prepareConversationState } from '../../dynamic/state/conversation';
import { digest, unique } from '../../dynamic/shared';
import { authorizedBranches, rejected, revalidate, type AcceptedPlan, type RejectedPlan } from '../../dynamic/validate/query-plan';
import type { TurnStep } from '../turn-plan';
import type { GroundedStep } from '../validate';
import { classifyRejection, type ExecutorAccepted, type ExecutorClarify, type ExecutorDenied } from './shared';

export interface QueryExecutorInput {
  store: Store; actor: Actor; message: string; businessDate: string; diagnosticId: string;
  now: () => Date; read: DynamicQueryInput['read']; signal?: AbortSignal; conversationId?: string;
  step: Extract<TurnStep, { kind: 'query' }>;
  /** From the validated GroundedStep. bound = a prior accepted state exists and is attached by the server. */
  continuation?: GroundedStep['continuation'];
  /**
   * Saved-dashboard widget re-execution only: the stored (digest-checked) accepted plan acts as its own prior state, so
   * values it had inherited inside the original conversation (time, scope filters, measures) stay bound to themselves.
   */
  inheritedPlan?: QueryPlan;
}
export type QueryExecutorResult =
  | (ExecutorAccepted & {
    kind: 'query'; plan: AcceptedPlan; bundle: EvidenceBundle; claims: ClaimGraph;
    intent: { intentKind: 'query' | 'follow_up'; parentStateId: string | null };
  })
  | (ExecutorClarify & { kind: 'query' })
  | (ExecutorDenied & { kind: 'query' });

const LIMITATION_SAMPLE = 5, LIMITATION_MAX_CHARS = 240;
/** At most a few sample limitations (each capped) plus an explicit count of the rest. Never fails the turn for length. */
export function boundedLimitations(limitations: readonly string[]): string[] {
  const cap = (text: string) => { const chars = [...text]; return chars.length > LIMITATION_MAX_CHARS ? `${chars.slice(0, LIMITATION_MAX_CHARS - 1).join('')}…` : text; };
  const unique_ = [...new Set(limitations)];
  if (unique_.length <= LIMITATION_SAMPLE) return unique_.map(cap);
  const rest = unique_.length - LIMITATION_SAMPLE;
  return [...unique_.slice(0, LIMITATION_SAMPLE).map(cap), `ข้อจำกัดของหลักฐานอีก ${rest.toLocaleString('th-TH')} รายการ (แสดงตัวอย่างข้างต้น) — รายละเอียดครบถ้วนอยู่ในหลักฐานต้นทาง`];
}

const SERVED_TABLES = ['sales_orders', 'sales_targets', 'inventory_snapshots', 'incidents', 'staffing_summaries'] as const;
/** Persisted answer bounds (persistedConversationMessageSchema / analysisSchema). */
const ANSWER_SOURCES_MAX = 500, CLAIM_SOURCE_IDS_MAX = 100, ANALYSIS_ITEMS_MAX = 100;

/** The shared runtime helpers take the legacy input shape; the router carries the same fields. */
function legacyInput(input: QueryExecutorInput): DynamicQueryInput {
  return { store: input.store, actor: input.actor, message: input.message, businessDate: input.businessDate,
    diagnosticId: input.diagnosticId, now: input.now, read: input.read, signal: input.signal, conversationId: input.conversationId };
}

/**
 * Executes an accepted `query` step through the existing Wave 1 pipeline: normalizeQueryPlan -> validateAvailable ->
 * compileQueryPlan -> executeReadRequest -> ClaimGraph -> Thai rendering. Only the planner call is absent: the
 * TurnPlan validator already produced `step.plan`.
 */
export async function executeQueryStep(input: QueryExecutorInput): Promise<QueryExecutorResult> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const actor = await reloadActor(input.store, input.actor, input.now());
  const catalog = createSemanticCatalog(await input.store.list<Branch>('branches'));
  const initialAuthority = authority(actor);
  if (input.step.plan.datasetId !== 'branch_performance') {
    const text = rejectionText(rejected('unsupported_concept', 'dataset_mismatch'), catalog, actor);
    return { outcome: 'denied', kind: 'query', code: 'dataset_mismatch', text };
  }
  const previous = input.continuation && input.continuation !== 'none'
    ? await previousState(legacyInput(input), actor, catalog) : undefined;
  const parentState = previous ? conversationStateRef(previous.state) : null;
  signal.throwIfAborted();

  const permittedIds = new Set(authorizedBranches(catalog, initialAuthority).map(b => b.id));
  const dateRows = await Promise.all(SERVED_TABLES.map(table => input.store.list<{ id: string; branchId: string; date: string }>(table)));
  const servedDates = unique(dateRows.flat().filter(row => permittedIds.has(row.branchId) &&
    businessDateSchema.safeParse(row.date).success).map(row => row.date)).sort();
  const availabilityWindow = servedDates.length ? { min: servedDates[0], max: servedDates.at(-1)! } : null;

  const refuse = (rejection: RejectedPlan): QueryExecutorResult => {
    if (rejection.outcome === 'execution_failed') {
      throw new AIRuntimeError('tool_execution_failed', 'The registered query reader could not complete the query.');
    }
    const refused = classifyRejection('query', rejection, rejectionText(rejection, catalog, actor, availabilityWindow));
    assertFinalTextSize(refused.text);
    return { ...refused, kind: 'query' };
  };

  const prior = previous ?? (input.inheritedPlan
    ? { state: { resolvedScope: { dates: input.inheritedPlan.time?.dates ?? [] } }, plan: input.inheritedPlan } : undefined);
  const dataset = catalog.datasets.find(d => d.id === input.step.plan.datasetId);
  const canonical = canonicalizeQueryPlan(input.step.plan, dataset, { previousPlan: prior?.plan,
    authorizedRegions: [...new Set(authorizedBranches(catalog, initialAuthority).map(b => b.region))] });
  const normalized = normalizeQueryPlan(canonical, input.message, input.businessDate,
    prior ? prior.state.resolvedScope.dates : undefined, { availability: availabilityWindow });
  if (normalized.outcome !== 'normalized') return refuse(normalized);
  const checked = await validateAvailable(legacyInput(input), normalized.plan, catalog, actor, signal, availabilityWindow, prior);
  signal.throwIfAborted();
  if (checked.outcome !== 'accepted') return refuse(checked);

  const plan = checked;
  const readSources: SourceRef[] = [];
  const read = async (scope: Scope) => {
    signal.throwIfAborted();
    const evidence = await currentEvidence(legacyInput(input), actor, scope, signal);
    readSources.push(...evidence.sources);
    return evidence;
  };
  const executed = await executeReadRequest(compileQueryPlan(plan), read,
    async () => authority(await reloadActor(input.store, actor, input.now())), input.now().toISOString());
  signal.throwIfAborted();
  if (executed.outcome !== 'accepted') return refuse(executed);
  const bundle = executed.bundle, claims = buildClaimGraph(bundle);
  if (!claims.claims.length) return refuse(rejected('data_unavailable', 'no_matching_claims'));

  // Evidence limitations can be huge (a sparse month lists every missing branch x day): keep a bounded sample + a truthful count.
  const limitations = boundedLimitations(claims.limitations);
  // RESPONSE-001: the claim-ID ResponsePlan. The model's hint arranges sections; ids/values/text come from the evidence-bound claims,
  // and any rejection (incomplete source report, invalid arrangement) keeps the deterministic legacy order.
  let composed: ComposedResponse | null = null;
  try {
    const presentation = createPresentationClaims(enrichEvidenceBundle(bundle));
    if (!('outcome' in presentation)) composed = composeResponse(presentation, input.step.presentation);
  } catch { composed = null; }
  const text = renderClaims(plan, { ...claims, limitations }, catalog, composed?.fromHint ? composed.claimOrder : undefined);
  assertFinalTextSize(text);
  const allSources = readSources.filter((source, index, all) => bundle.sources.some(s => s.id === source.id)
    && all.findIndex(s => s.id === source.id) === index);
  // The stored answer carries a bounded provenance view (message schema: <=500 sources, <=100 ids per claim). A month over
  // many branches has more row sources than that; the complete set stays in the persisted query proof (bundle + claims).
  const sources = allSources.slice(0, ANSWER_SOURCES_MAX);
  const kept = new Set(sources.map(source => source.id));
  const boundedIds = (ids: readonly string[]) => [...new Set(ids)].filter(id => kept.has(id)).slice(0, CLAIM_SOURCE_IDS_MAX);
  const analysis = {
    facts: claims.claims.slice(0, ANALYSIS_ITEMS_MAX).map(claim => ({ text: renderNumericClaim(claim, catalog), sourceIds: boundedIds(claim.sourceRefs) })),
    relationships: crossGroupComparisons(plan, claims, catalog).slice(0, ANALYSIS_ITEMS_MAX).map(comparison => ({ text: comparison.text, sourceIds: boundedIds(comparison.sourceIds) })),
    hypotheses: [], missingEvidence: limitations.map(limit => ({ text: limit, sourceIds: [] })),
    generatedAt: input.now().toISOString(), evidenceVersion: bundle.ref.digest,
  };

  return {
    outcome: 'accepted', kind: 'query', text, sources, analysis, plan, bundle, claims,
    intent: { intentKind: previous ? 'follow_up' : 'query', parentStateId: parentState?.id ?? null },
    interpretedScope: { datasetId: plan.plan.datasetId, dates: [...plan.dates], regions: [...plan.scope.regions],
      branchIds: [...plan.scope.branchIds], measures: plan.plan.measures.map(m => m.fieldId) },
    persist: async (tx, finalActor, conversationId) => {
      invariant(digest(authority(finalActor)) === digest(initialAuthority), 'FORBIDDEN', 'Your query authority changed before the response could be saved.', 403);
      const currentCatalog = createSemanticCatalog(await tx.list<Branch>('branches'));
      invariant(currentCatalog.digest === plan.catalogDigest && revalidate(plan, authority(finalActor)).outcome === 'accepted'
        && plan.scope.regions.every(region => canRegion(finalActor, region)),
      'FORBIDDEN', 'The query population changed before the response could be saved.', 403);
      const records = (await tx.list<{ name: string; conversationId: string; state: unknown }>('tool_executions', {
        actorId: finalActor.id, sessionId: finalActor.sessionId, status: 'completed',
      })).filter(record => record.name === 'retail.dynamic_query' && record.conversationId === conversationId);
      const latest = records.flatMap(record => {
        const state = conversationStateSchema.safeParse(record.state);
        return state.success ? [state.data] : [];
      }).sort((a, b) => b.revision - a.revision)[0];
      if (parentState) {
        invariant(latest && digest(conversationStateRef(latest)) === digest(parentState),
          'CONFLICT', 'The prior query state changed before the follow-up could be saved.', 409);
      }
      const prepared = prepareConversationState({ conversationId, turnId: input.diagnosticId, revision: (latest?.revision ?? 0) + 1,
        sourceText: { id: `source:${input.diagnosticId}`, version: 1, digest: digest(input.message) },
        parentState, plan, bundle, claims }, authority(finalActor));
      invariant(prepared.outcome === 'accepted', 'FORBIDDEN', 'The query evidence could not be saved under current authority.', 403);
      const recordId = `dynamic:${input.diagnosticId}`;
      invariant(!await tx.get('tool_executions', recordId), 'CONFLICT', 'The query proof already exists.', 409);
      await tx.put('tool_executions', { id: recordId, name: 'retail.dynamic_query', status: 'completed',
        actorId: finalActor.id, sessionId: finalActor.sessionId, conversationId, turnId: input.diagnosticId,
        plan: plan.plan, bundle, claims, state: prepared.state, responsePlan: composed?.response.ref ?? null, createdAt: input.now().toISOString() });
    },
  };
}
