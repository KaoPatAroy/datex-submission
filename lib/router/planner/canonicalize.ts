import { HR_HEADCOUNT_MEASURE } from '../../dynamic/catalog/hr';
import { preparePlannerSpans } from '../../dynamic/plan/normalize';
import { INTERACTION_IDS } from '../../visualization/contracts';
import type { ActionRegistry } from '../action-registry';
import type { PlannerContext } from '../planner-context';
import { PRODUCT_CONCEPT_IDS } from '../product-model';
import { TURN_PLAN_VERSION } from '../turn-plan';

/**
 * Canonicalizes the MODEL's plan output before schema validation. It never sees or reads user text: it only removes
 * harmless noise the live model emits around otherwise valid plans and rewrites shapes to the canonical form, using the
 * registry / planner-context data as the only reference. Every safety decision (authority, scope, recipients, evidence
 * provenance of user_quoted values, numbers from evidence) stays in the validator and executors; nothing here can make a
 * value more trusted than the model claimed:
 *
 *  - null / "" optional fields (evidenceText, evidenceFrom, followUps) are dropped; null arrays become [].
 *  - evidenceText / evidenceFrom on a param whose source is not user_quoted is dropped (context ids / inherited / default /
 *    generated values are checked against the context, never against the message, so the text is meaningless there).
 *  - a registry-default param the model sent as source:"default" is dropped, so the server fills (and labels) its own default.
 *  - params the registry does not declare for the action are dropped (executors only read declared params).
 *  - an omitted turnPlanVersion / query planVersion is version 1; an omitted query planId gets a server placeholder id.
 *  - query steps: requestedUses is reduced to the uses a query itself serves (answer/explore; an effect is a separate step);
 *    requiredSourceIds that merely name a catalog dataset are dropped; null or omitted sort/clarificationNeeds/filters/dimensions -> [];
 *    omitted scope/time/multiDateGrain/compare/topN -> null, omitted group -> no grouping, omitted sourceText -> null, an omitted
 *    measure/dimension interpretation -> the default interpretation of that field, omitted completeness -> the requested-scope default; a time
 *    evidenceText is kept only for explicit time.
 *  - clarify: a slot naming an action param by bare name (`threshold`) becomes `params.threshold` when the registry declares
 *    that param; a choice without a label gets its id as label (the validator replaces every label with the server label).
 *  - a query that claims `inherited` values is marked as a continuation (the server then binds and checks the prior state);
 *    an hr_query without measures gets the HR dataset's single registered measure (row lookups list columns only).
 *  - everything else is returned untouched; the function is idempotent.
 */
export interface CanonicalizeOptions { context?: PlannerContext; registry?: ActionRegistry }

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const QUERY_USES = new Set(['answer', 'explore']);

function canonicalEnvelope(envelope: unknown): unknown {
  if (!isObject(envelope)) return envelope;
  const out: Json = { ...envelope };
  if (blank(out.evidenceText) || out.source !== 'user_quoted') delete out.evidenceText;
  if (blank(out.evidenceFrom) || out.source !== 'user_quoted') delete out.evidenceFrom;
  return out;
}

/**
 * G5 (live v6 revise): the model labels a kept Result title source "inherited" or "context_id". A Result title is display text the server
 * validates for length/charset/safety only (ARTIFACT_TITLE_SPEC: user_quoted | generated), so any other claimed source of a plain string title
 * is the model's own authored text: generated. Never upgrades to user_quoted.
 */
function canonicalArtifactTitle(title: unknown): unknown {
  const envelope = canonicalEnvelope(title);
  if (typeof title === 'string' && title.trim()) return { value: title, source: 'generated' };
  if (!isObject(envelope) || typeof envelope.value !== 'string' || envelope.source === 'user_quoted' || envelope.source === 'generated') return envelope;
  return { value: envelope.value, source: 'generated' };
}

function canonicalParams(params: unknown, actionId: unknown, options: CanonicalizeOptions): unknown {
  if (!isObject(params)) return params;
  const definition = typeof actionId === 'string' ? options.registry?.get(actionId) : undefined;
  const out: Json = {};
  for (const [name, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined) continue;
    const spec = definition?.params[name];
    if (definition && !spec) continue;
    const envelope = canonicalEnvelope(raw);
    if (spec?.default && isObject(envelope) && envelope.source === 'default') continue;
    if (isObject(envelope) && (envelope.value === null || envelope.value === undefined)) continue;
    // Shape only: a single id where the registry declares a list of ids becomes a one-element list (its provenance is unchanged).
    if (spec && isObject(envelope) && typeof envelope.value === 'string' && !spec.value.safeParse(envelope.value).success && spec.value.safeParse([envelope.value]).success) {
      out[name] = { ...envelope, value: [envelope.value] };
      continue;
    }
    out[name] = envelope;
  }
  return operationTolerance(derivedBranchTolerance(out, actionId, options), actionId);
}

/** Registry operation tokens of the organize/lifecycle actions, with the model's common synonyms for the same registered operation. */
const OPERATION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'dashboard.manage': { unarchive: 'restore', copy: 'duplicate' },
  'monitor.manage': {},
};
/**
 * Operation tolerance (model output only): `operation` of dashboard.manage / monitor.manage is a registry token the planner generates, never
 * quoted user text. A token is trimmed and lower-cased (a registered synonym maps to its operation) and its provenance is `generated`;
 * whether the token is a registered operation stays the validator's decision (the enum).
 */
function operationTolerance(params: Json, actionId: unknown): Json {
  const aliases = typeof actionId === 'string' ? OPERATION_ALIASES[actionId] : undefined;
  if (!aliases || !isObject(params.operation) || typeof params.operation.value !== 'string') return params;
  const token = params.operation.value.trim().toLowerCase();
  return { ...params, operation: { value: aliases[token] ?? token, source: 'generated' } };
}

const DERIVED_BRANCH_ACTIONS = new Set(['ticket.create', 'task.create']);
/**
 * S2 tolerance (model output only): a derived branch set arrives in the canonical shape `branchesFrom` (accepted answer id or "$stepN") +
 * `branchesRule`. The model often puts the answer reference into branchIds, or marks it user_quoted/generated: the reference is a context id, never
 * quoted text, and a rule token is lower_snake_cased. Whether the id really is an accepted state stays the validator's decision.
 */
function derivedBranchTolerance(params: Json, actionId: unknown, options: CanonicalizeOptions): Json {
  if (typeof actionId !== 'string' || !DERIVED_BRANCH_ACTIONS.has(actionId)) return params;
  const states = new Set((options.context?.acceptedStates ?? []).map(state => state.stateId));
  const isState = (value: unknown): value is string => typeof value === 'string' && (/^\$step\d+$/u.test(value) || states.has(value));
  const out: Json = { ...params };
  const ids = out.branchIds;
  const single = isObject(ids) ? (Array.isArray(ids.value) && ids.value.length === 1 ? ids.value[0] : ids.value) : undefined;
  if (isState(single)) { if (!out.branchesFrom) out.branchesFrom = { value: single, source: 'context_id' }; delete out.branchIds; }
  if (isObject(out.branchesFrom) && isState(out.branchesFrom.value) && out.branchesFrom.source !== 'inherited') out.branchesFrom = { value: out.branchesFrom.value, source: 'context_id' };
  if (isObject(out.branchesRule) && typeof out.branchesRule.value === 'string') {
    const token = out.branchesRule.value.trim().replace(/([a-z])([A-Z])/gu, '$1_$2').replace(/[\s-]+/gu, '_').toLowerCase();
    out.branchesRule = { value: token, source: 'generated' };
  }
  return out;
}

function canonicalQueryPlan(plan: unknown, options: CanonicalizeOptions): unknown {
  if (!isObject(plan)) return plan;
  const out: Json = { ...plan };
  // The only plan version, and a plan id the server never interprets (the accepted ref digests the whole plan).
  if (out.planVersion === undefined) out.planVersion = 1;
  if (out.planId === undefined) out.planId = 'planner';
  for (const key of ['sort', 'clarificationNeeds', 'filters', 'dimensions'] as const) if (out[key] === null || out[key] === undefined) out[key] = [];
  for (const key of ['scope', 'time', 'multiDateGrain', 'compare', 'topN'] as const) if (out[key] === undefined) out[key] = null;
  if (out.group === null || out.group === undefined) out.group = { fieldIds: [] };
  else if (isObject(out.group) && out.group.fieldIds === null) out.group = { ...out.group, fieldIds: [] };
  if (isObject(out.time)) {
    const time: Json = { ...out.time };
    if (blank(time.evidenceText) || time.source !== 'explicit') delete time.evidenceText;
    out.time = time;
  }
  if (Array.isArray(out.filters)) out.filters = out.filters.map(filter => {
    if (!isObject(filter)) return filter;
    const next: Json = { ...filter };
    if (blank(next.evidenceText)) delete next.evidenceText;
    if (next.source === null) delete next.source;
    if (next.sourceText === undefined) next.sourceText = null;
    return next;
  });
  if (out.completeness === undefined) out.completeness = { expectation: 'requested_scope', requireFullPopulation: false, requiredSourceIds: [], minimumCoverage: 0 };
  for (const key of ['measures', 'dimensions'] as const) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(item => {
    // A field chosen without an interpretation is a default choice (no user text): the same object the model may write out in full.
    if (isObject(item) && item.interpretation === undefined && typeof item.fieldId === 'string') {
      return { ...item, interpretation: { value: item.fieldId, source: 'default', sourceText: null, confidence: 1 } };
    }
    if (!isObject(item) || !isObject(item.interpretation)) return item;
    const interpretation: Json = { ...item.interpretation };
    if (interpretation.sourceText === undefined || blank(interpretation.sourceText)) interpretation.sourceText = null;
    return { ...item, interpretation };
  });
  if (Array.isArray(out.requestedUses)) {
    const uses = out.requestedUses.filter(use => typeof use === 'string' && QUERY_USES.has(use));
    out.requestedUses = uses.length ? [...new Set(uses)] : ['answer'];
  } else if (out.requestedUses === undefined || out.requestedUses === null) out.requestedUses = ['answer'];
  if (isObject(out.completeness) && Array.isArray(out.completeness.requiredSourceIds)) {
    const datasetIds = new Set([...(options.context?.catalog.datasets.map(d => d.id) ?? []), ...(typeof out.datasetId === 'string' ? [out.datasetId] : [])]);
    out.completeness = { ...out.completeness, requiredSourceIds: out.completeness.requiredSourceIds.filter(id => !(typeof id === 'string' && datasetIds.has(id))) };
  }
  return out;
}

function inheritsValues(plan: unknown): boolean {
  if (!isObject(plan)) return false;
  const inherited = (item: unknown) => isObject(item) && (item.source === 'inherited' || isObject(item.interpretation) && item.interpretation.source === 'inherited');
  return [plan.measures, plan.dimensions, plan.filters].some(list => Array.isArray(list) && list.some(inherited))
    || isObject(plan.time) && plan.time.source === 'inherited';
}

function canonicalClarify(step: Json, options: CanonicalizeOptions): Json {
  const out: Json = { ...step };
  if (out.choices === null || out.choices === undefined) out.choices = [];
  if (Array.isArray(out.choices)) out.choices = out.choices.filter(isObject).map(choice => ({
    id: choice.id, label: blank(choice.label) ? choice.id : choice.label,
  }));
  const about = isObject(out.about) ? out.about : undefined;
  const definition = about?.kind === 'action' && typeof about.actionId === 'string' ? options.registry?.get(about.actionId) : undefined;
  if (Array.isArray(out.missing)) out.missing = out.missing.map(item => {
    if (!isObject(item) || typeof item.slot !== 'string') return item;
    const slot = item.slot.trim();
    if (definition && !slot.startsWith('params.') && Object.hasOwn(definition.params, slot)) return { ...item, slot: `params.${slot}` };
    // The target of a Dashboard refine IS its pendingActionId (the model often names it params.dashboard).
    if (about?.kind === 'refine' && (slot === 'params.dashboard' || slot === 'dashboard')) return { ...item, slot: 'pendingActionId' };
    if (about?.kind === 'refine' && slot.startsWith('params.')) return { ...item, slot: slot.slice('params.'.length) };
    return { ...item, slot };
  });
  return out;
}

/** Real-model tolerance for the chart request: optional fields as null/[] are absent, unknown interaction ids are dropped, `inspect_data` is always kept. */
function canonicalVisual(visual: Json): Json {
  const out: Json = { ...visual };
  for (const key of ['groupFieldId', 'lineFieldIds'] as const) if (out[key] === null || (Array.isArray(out[key]) && out[key].length === 0) || out[key] === '') delete out[key];
  // G5 (live: "line of net sales by region over 7 days" -> line with groupFieldId region): outside a heatmap the series split is every query
  // dimension other than x (the compiler derives it), so a model-named series dimension is redundant: dropped, never reinterpreted.
  if (out.primitiveId !== 'heatmap' && out.groupFieldId !== undefined) delete out.groupFieldId;
  const known = new Set<unknown>(INTERACTION_IDS);
  const ids = Array.isArray(out.interactionIds) ? out.interactionIds.filter(id => known.has(id)) : [];
  out.interactionIds = [...new Set(['inspect_data', ...ids])];
  if (out.animation === null || out.animation === undefined || out.animation === '') out.animation = 'none';
  return out;
}

function canonicalStep(step: unknown, options: CanonicalizeOptions): unknown {
  if (!isObject(step)) return step;
  switch (step.kind) {
    case 'query': case 'hr_query': {
      const plan = canonicalQueryPlan(step.plan, options);
      const out: Json = { ...step, plan };
      if (step.kind === 'query') {
        // A plan that claims inherited values is a continuation by its own account; the server binds the prior state and
        // checks every inherited value against it (continuation=false would make every inherited value unverifiable).
        out.continuation = out.continuation === true || inheritsValues(plan);
      }
      if (step.kind === 'hr_query') {
        delete out.continuation;
        // HR row lookups carry the dataset's single registered measure (headcount/count) even when only columns are listed.
        if (isObject(plan) && (!Array.isArray(plan.measures) || plan.measures.length === 0)) out.plan = { ...plan, measures: [{
          fieldId: HR_HEADCOUNT_MEASURE.fieldId, aggregation: HR_HEADCOUNT_MEASURE.aggregation,
          interpretation: { value: HR_HEADCOUNT_MEASURE.fieldId, source: 'default', sourceText: null, confidence: 1 } }] };
      }
      return out;
    }
    case 'action': {
      const out: Json = { ...step, params: canonicalParams(step.params ?? {}, step.actionId, options) };
      if (out.visualization === null && step.actionId !== 'dashboard.create') delete out.visualization;
      return out;
    }
    case 'refine': {
      if (!isObject(step.operation)) return step;
      const operation: Json = { ...step.operation };
      for (const key of ['title', 'removeWidgetIndexes'] as const) {
        if (operation[key] === null) delete operation[key];
        else if (operation[key] !== undefined) operation[key] = canonicalEnvelope(operation[key]);
      }
      return { ...step, operation };
    }
    case 'artifact': return { ...step, title: canonicalArtifactTitle(step.title), ...(isObject(step.visual) ? { visual: canonicalVisual(step.visual) } : {}) };
    case 'policy_read': {
      // Model tolerance: a single `policyId` string or a bare string is the one-element policyIds list.
      const ids = Array.isArray(step.policyIds) ? step.policyIds : typeof step.policyIds === 'string' ? [step.policyIds] : typeof step.policyId === 'string' ? [step.policyId] : step.policyIds;
      return { kind: 'policy_read', policyIds: ids };
    }
    case 'clarify': return canonicalClarify(step, options);
    case 'resource_lookup': {
      // Model tolerance: `artifact`/`results`/`chart` mean the Result library; `kind`/`type` for `resource`; `name`/`title`/`text` for `query`.
      const rawResource = [step.resource, step.kind === 'resource_lookup' ? undefined : step.kind, step.type].find(value => typeof value === 'string' && value !== 'resource_lookup');
      const resource = typeof rawResource === 'string' ? (['artifact', 'artifacts', 'results', 'chart', 'table', 'report'].includes(rawResource.toLowerCase()) ? 'result' : rawResource.toLowerCase().replace(/s$/, '')) : rawResource;
      const query = [step.query, step.name, step.title, step.text].find(value => typeof value === 'string' && value.trim());
      return { kind: 'resource_lookup', resource, query: typeof query === 'string' ? query.trim() : query };
    }
    case 'workflow_read': {
      // Model tolerance: the V2 tool name ("workflow.director_queue") or `read` for readId; `queue`/`queueId` for the snapshot id; null/blank ids absent.
      const rawRead = [step.readId, step.read, step.capabilityId].find(value => typeof value === 'string');
      const readId = typeof rawRead === 'string' ? rawRead.replace(/^workflow\./, '') : rawRead;
      const snapshotId = [step.snapshotId, step.queue, step.queueId].find(value => typeof value === 'string' && value.trim());
      const requestId = typeof step.requestId === 'string' && step.requestId.trim() ? step.requestId : undefined;
      return { kind: 'workflow_read', readId, ...(snapshotId ? { snapshotId } : {}), ...(requestId ? { requestId } : {}) };
    }
    case 'conversation': return canonicalConversation(step);
    default: return step;
  }
}

/**
 * Model tolerance for product_help concept ids (MODEL output only): case, separators, plurals and the internal/alias names
 * of a concept map to its PRODUCT_MODEL id; unknown names are dropped (the explanation stays, the server adds no account line
 * for them). Concepts are kept only on a product_help step.
 */
const CONCEPT_ALIASES: Readonly<Record<string, string>> = { artifact: 'result', work_item: 'task', workitem: 'task', inbox: 'message', receipt: 'history', onboarding: 'onboarding_request' };
function canonicalConversation(step: Json): Json {
  const { concepts, ...rest } = step;
  if (step.topic !== 'product_help' || !Array.isArray(concepts)) return rest;
  const ids = concepts.filter((value): value is string => typeof value === 'string').map(value => {
    const name = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const single = (PRODUCT_CONCEPT_IDS as readonly string[]).includes(name) ? name : name.replace(/s$/, '');
    return CONCEPT_ALIASES[single] ?? single;
  }).filter(id => (PRODUCT_CONCEPT_IDS as readonly string[]).includes(id));
  const unique = [...new Set(ids)].slice(0, 4);
  return unique.length ? { ...rest, concepts: unique } : rest;
}

export function canonicalizeModelPlan(candidate: unknown, options: CanonicalizeOptions = {}): unknown {
  if (!isObject(candidate)) return candidate;
  const out: Json = { ...candidate };
  // TurnPlan v1 is the only version: an omitted version is that version.
  if (out.turnPlanVersion === undefined && Array.isArray(out.steps)) out.turnPlanVersion = TURN_PLAN_VERSION;
  // Span offsets are server-owned: a text-only span gets placeholder offsets (the executors re-ground every span's text).
  if (Array.isArray(out.steps)) out.steps = out.steps.map(step => preparePlannerSpans(canonicalStep(step, options), false));
  // G5 (live v6: 6/7 monitor requests): [query, clarify] is not a legal envelope, but its meaning is unambiguous: the model still needs an
  // answer from the user before anything runs. Keep the clarify alone (its question and server-validated choices) instead of failing the turn.
  if (Array.isArray(out.steps) && out.steps.length === 2 && isObject(out.steps[1]) && out.steps[1].kind === 'clarify'
    && isObject(out.steps[0]) && (out.steps[0].kind === 'query' || out.steps[0].kind === 'hr_query')) out.steps = [out.steps[1]];
  if (out.followUps === null || (out.followUps !== undefined && !Array.isArray(out.followUps))) delete out.followUps;
  else if (Array.isArray(out.followUps)) out.followUps = out.followUps.filter(text => typeof text === 'string' && text.trim());
  if (out.suggestedConversationTitle !== undefined && (typeof out.suggestedConversationTitle !== 'string' || !out.suggestedConversationTitle.trim())) delete out.suggestedConversationTitle;
  return out;
}
