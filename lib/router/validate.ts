import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { resolveSpan } from '../dynamic/plan/normalize';
import type { Span } from '../dynamic/plan/schemas';
import {
  actionParamsSchema, ARTIFACT_TITLE_SPEC, holdsActionPermissions, REFINE_PARAM_SPECS, serverArtifactTitle, type ActionDefinition, type ActionRegistry, type ParamSpec,
} from './action-registry';
import { modelTextSafe, type ModelTextSurface } from './render/safety';
import type { PlannerContext, TurnMessages } from './planner-context';
import { dashboardChoiceLabels } from './dashboard-target';
import { canonicalizeModelPlan } from './planner/canonicalize';
import {
  envelopeError, turnPlanSchema, type ParamEnvelope, type ParamSource, type ParamValue, type TurnPlan, type TurnStep,
} from './turn-plan';

export type ClarifyCode =
  | 'missing_param' | 'evidence_not_found' | 'verbatim_mismatch' | 'unknown_context_id' | 'inherited_mismatch'
  | 'clarified_turn_unavailable' | 'invalid_default' | 'unsafe_generated' | 'policy_not_shown';
export type DeniedCode =
  | 'invalid_plan' | 'envelope_invalid' | 'unknown_action' | 'permission_denied' | 'scope_denied'
  | 'dataset_unavailable' | 'dataset_mismatch' | 'source_not_allowed' | 'unknown_clarify_target';

export interface GroundedParam {
  name: string; value: ParamValue; source: ParamSource;
  /** Server-located evidence span for user_quoted params. */
  span: Span | null;
  /** true when the server (registry default) supplied the value; the answer must label it. */
  serverDefault: boolean;
}
export interface GroundedStep {
  index: number;
  /** Sanitized step (clarify choices relabeled from server labels; unsafe free text nulled). */
  step: TurnStep;
  params: Record<string, GroundedParam>;
  /** query only: bound = parentState attached, fresh = no valid prior state so validated as new, none = not a continuation. */
  continuation?: 'none' | 'bound' | 'fresh';
  /** clarify question / conversation prose after the safety hook; null means the server must use its own template. */
  safeText?: string | null;
  riskTier?: 'direct' | 'confirm';
}

export type TurnPlanValidation =
  | { outcome: 'accepted'; plan: TurnPlan; steps: GroundedStep[] }
  | { outcome: 'clarify'; code: ClarifyCode; stepIndex: number; slot: string; detail: string }
  | { outcome: 'denied'; code: DeniedCode; stepIndex: number | null; detail: string; issues?: string[] };

export interface ValidationHooks {
  /** Fresh permission re-check (e.g. after reloadActor). Return false to deny. */
  permitAction?(actionId: string): boolean;
  /** Final scope intersection hook over resolved scope values. Return false to deny. */
  permitScope?(actionId: string, scope: { regionIds?: string[]; branchIds?: string[] }): boolean;
  /** Output-safety gate for AI-authored text. */
  isSafeText?(text: string, kind: 'generated' | 'clarify' | 'prose'): boolean;
}

export interface ValidateInput {
  /** Raw planner output (unknown). */
  raw: unknown;
  messages: TurnMessages;
  context: PlannerContext;
  registry: ActionRegistry;
  hooks?: ValidationHooks;
}

type Fail = Exclude<TurnPlanValidation, { outcome: 'accepted' }>;
const clarify = (code: ClarifyCode, stepIndex: number, slot: string, detail: string): Fail => ({ outcome: 'clarify', code, stepIndex, slot, detail });
const denied = (code: DeniedCode, stepIndex: number | null, detail: string, issues?: string[]): Fail => ({ outcome: 'denied', code, stepIndex, detail, issues });
const isFail = (value: unknown): value is Fail => typeof value === 'object' && value !== null && 'outcome' in value;

const STEP0 = '$step0';
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const wildcard = (allowed: readonly string[], id: string) => allowed.includes('*') || allowed.includes(id);

function contextValues(kind: NonNullable<ParamSpec['contextKind']>, context: PlannerContext, stepIndex: number, pendingActionId?: string): Set<string | number> {
  const set = new Set<string | number>();
  switch (kind) {
    case 'dashboard': context.dashboards.forEach(d => set.add(d.id)); break;
    case 'monitor': (context.monitors ?? []).forEach(m => set.add(m.id)); break;
    case 'recipient': context.recipients.forEach(r => set.add(r.id)); break;
    case 'pending_action': context.pendingActions.forEach(p => set.add(p.id)); break;
    case 'artifact': context.artifacts.forEach(a => set.add(a.id)); break;
    case 'archived_artifact': (context.archivedArtifacts ?? []).forEach(a => set.add(a.id)); break;
    case 'policy': (context.policies ?? []).forEach(p => set.add(p.id)); break;
    case 'policy_version': (context.policies ?? []).forEach(p => set.add(p.version)); break;
    case 'measure': context.catalog.measureIds.forEach(m => set.add(m)); break;
    case 'accepted_state':
      context.acceptedStates.forEach(s => set.add(s.stateId));
      if (stepIndex === 1) set.add(STEP0);
      break;
    case 'widget_index':
      context.pendingActions.find(p => p.id === pendingActionId)?.widgetIndexes.forEach(i => set.add(i));
      break;
    case 'review_queue': (context.workflow?.reviewedQueues ?? []).forEach(q => set.add(q.id)); break;
    // Membership in the CHOSEN queue is re-checked by the executor against the stored V2 snapshot.
    case 'onboarding_request': (context.workflow?.reviewedQueues ?? []).forEach(q => q.requests.forEach(r => set.add(r.id))); break;
    case 'onboarding_approval': (context.workflow?.verifiedApprovals ?? []).forEach(a => set.add(a.id)); break;
  }
  return set;
}

interface GroundEnv {
  input: ValidateInput; stepIndex: number; priorValues: Record<string, ParamValue>; pendingActionId?: string;
  clarificationAbout?: string;
  /** G6: the MODEL_TEXT_REGISTRY surface of a generated free-text param (default staged_text). */
  surfaceOf?: (name: string) => ModelTextSurface;
}

/**
 * G6: a generated free-text value failed the model-text gate (modelTextSafe). The param is treated as absent: an optional one stays absent (server
 * title / no note), a serverCopyWhenUnsafe one is written by the server, and a required one is asked again. It is never shown.
 */
const UNSAFE_MODEL_TEXT = Symbol('unsafe_model_text');
type Grounded = GroundedParam | Fail | typeof UNSAFE_MODEL_TEXT;
/** Free text the model writes (not a registry enum id such as an operation or a priority). */
function isFreeText(spec: ParamSpec): boolean {
  const schema = spec.value instanceof z.ZodArray ? spec.value.element : spec.value;
  return !(schema instanceof z.ZodEnum);
}

function ground(name: string, spec: ParamSpec, envelope: ParamEnvelope, env: GroundEnv): Grounded {
  const { input, stepIndex } = env;
  const slot = `params.${name}`;
  if (!spec.sources.includes(envelope.source)) return denied('source_not_allowed', stepIndex, `${slot} may not use source ${envelope.source}`);
  const value = spec.value.safeParse(envelope.value);
  if (!value.success) return denied('invalid_plan', stepIndex, `${slot} value is invalid`, value.error.issues.map(i => `${slot}.${i.path.join('.')}: ${i.message}`));
  let typed = value.data as ParamValue;
  const base = { name, value: typed, source: envelope.source, span: null, serverDefault: false } satisfies GroundedParam;
  if (envelope.source !== 'user_quoted' && envelope.evidenceText !== undefined) return denied('invalid_plan', stepIndex, `${slot} evidenceText is only legal for user_quoted`);

  if (spec.scope) {
    const allowed = spec.scope === 'region' ? input.context.scope.regionIds : input.context.scope.branchIds;
    const requested = Array.isArray(typed) ? typed : [typed];
    if (!requested.every(id => typeof id === 'string' && wildcard(allowed, id))) return denied('scope_denied', stepIndex, `${slot} is outside the authorized ${spec.scope} scope`);
  }

  switch (envelope.source) {
    case 'user_quoted': {
      if (envelope.evidenceText === undefined) return clarify('evidence_not_found', stepIndex, slot, `${slot} user_quoted requires evidenceText`);
      const sameRequest = !env.clarificationAbout || !input.context.pendingClarification || env.clarificationAbout === input.context.pendingClarification.about;
      const previous = sameRequest ? input.messages.clarifiedTurns ?? (input.messages.clarifiedTurn === undefined ? [] : [input.messages.clarifiedTurn]) : [];
      if (envelope.evidenceFrom === 'clarified_turn' && !previous.length) return clarify('clarified_turn_unavailable', stepIndex, slot, 'no persisted clarify turn');
      // A missing marker is resolved from exact quotes of this pending request, never arbitrary chat history.
      const messages = envelope.evidenceFrom === 'clarified_turn' ? previous
        : envelope.evidenceFrom === undefined && env.clarificationAbout === input.context.pendingClarification?.about ? [input.messages.current, ...previous]
          : [input.messages.current];
      const located = messages.map(message => ({ message, span: resolveSpan(message, envelope.evidenceText!) })).find(found => found.span);
      if (!located?.span) return clarify('evidence_not_found', stepIndex, slot, `${slot} evidenceText is not in the message`);
      const { message, span } = located;
      if (spec.verbatim) {
        const valueSpan = typeof typed === 'string' ? resolveSpan(message, typed) : null;
        if (!valueSpan || valueSpan.text !== span.text) return clarify('verbatim_mismatch', stepIndex, slot, `${slot} must equal the quoted span`);
        // The fuzzy locator may accept a near-match (model typo/alteration). Downstream always uses the user's EXACT text span,
        // never the model's string.
        if (typed !== span.text) {
          const exact = spec.value.safeParse(span.text);
          if (!exact.success) return clarify('verbatim_mismatch', stepIndex, slot, `${slot} quoted span is not a valid value`);
          typed = exact.data as ParamValue;
          base.value = typed;
        }
      }
      Object.assign(base, { span });
      break;
    }
    case 'inherited': {
      const prior = env.priorValues[name];
      if (prior === undefined || !isDeepStrictEqual(prior, typed)) return clarify('inherited_mismatch', stepIndex, slot, `${slot} does not equal the prior state value`);
      break;
    }
    case 'default': {
      if (!spec.default) return denied('source_not_allowed', stepIndex, `${slot} has no registry default`);
      if (!isDeepStrictEqual(spec.default(input.context), typed)) return clarify('invalid_default', stepIndex, slot, `${slot} is not the registry default`);
      Object.assign(base, { serverDefault: true });
      break;
    }
    case 'generated': {
      const texts = Array.isArray(typed) ? typed : [typed];
      if (texts.some(t => typeof t !== 'string' || CONTROL_CHARS.test(t) || input.hooks?.isSafeText?.(t, 'generated') === false)) return clarify('unsafe_generated', stepIndex, slot, `${slot} generated text failed safety`);
      if (isFreeText(spec) && texts.some(t => !modelTextSafe(env.surfaceOf?.(name) ?? 'staged_text', String(t)))) return UNSAFE_MODEL_TEXT;
      break;
    }
    case 'context_id': break;
  }
  if (spec.contextKind && envelope.source !== 'default' && envelope.source !== 'generated') {
    const known = contextValues(spec.contextKind, input.context, stepIndex, env.pendingActionId);
    const requested = Array.isArray(typed) ? typed : [typed];
    if (!requested.every(id => known.has(id as string | number))) return clarify('unknown_context_id', stepIndex, slot, `${slot} references an id that is not in the context`);
  }
  return base;
}

function groundParams(specs: Readonly<Record<string, ParamSpec>>, given: Readonly<Record<string, ParamEnvelope | undefined>>, env: GroundEnv): Record<string, GroundedParam> | Fail {
  const out: Record<string, GroundedParam> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const envelope = given[name];
    if (!envelope) {
      if (spec.default) out[name] = { name, value: spec.default(env.input.context), source: 'default', span: null, serverDefault: true };
      else if (spec.required) return clarify('missing_param', env.stepIndex, `params.${name}`, `${name} is required`);
      continue;
    }
    const result = ground(name, spec, envelope, env);
    if (result === UNSAFE_MODEL_TEXT) {
      if (spec.default) out[name] = { name, value: spec.default(env.input.context), source: 'default', span: null, serverDefault: true };
      else if (spec.required && !spec.serverCopyWhenUnsafe) return clarify('unsafe_generated', env.stepIndex, `params.${name}`, `${name} generated text failed the model-text gate`);
      continue;
    }
    if (isFail(result)) return result;
    out[name] = result;
  }
  return out;
}

function checkAction(step: Extract<TurnStep, { kind: 'action' }>, index: number, input: ValidateInput, priorValues: Record<string, ParamValue>): GroundedStep | Fail {
  const definition: ActionDefinition | undefined = input.registry.get(step.actionId);
  if (!definition) return denied('unknown_action', index, `${step.actionId} is not a registered action`);
  const permitted = holdsActionPermissions(definition, input.context.scope.permissions)
    && input.context.actions.some(a => a.actionId === definition.actionId)
    && input.hooks?.permitAction?.(definition.actionId) !== false;
  if (!permitted) return denied('permission_denied', index, `${step.actionId} is not available to this actor`);
  if (step.visualization) {
    if (definition.actionId !== 'dashboard.create') return denied('invalid_plan', index, 'visualization is legal only for dashboard.create');
    if (!step.params.source) return clarify('missing_param', index, 'params.source', 'a visualization needs an accepted answer as evidence');
    const texts = [step.visualization.title, step.visualization.description, ...step.visualization.widgets.map(w => w.title)].filter(Boolean);
    if (texts.some(t => CONTROL_CHARS.test(t) || input.hooks?.isSafeText?.(t, 'generated') === false)) return clarify('unsafe_generated', index, 'visualization', 'visualization text failed safety');
  }
  const typed = actionParamsSchema(definition).safeParse(step.params);
  if (!typed.success) return denied('invalid_plan', index, 'action params are invalid', typed.error.issues.map(i => `params.${i.path.join('.')}: ${i.message}`));
  const params = groundParams(definition.params, typed.data as Record<string, ParamEnvelope | undefined>, { input, stepIndex: index, priorValues, clarificationAbout: `action:${definition.actionId}`,
    surfaceOf: name => name === 'title' && definition.actionId.startsWith('dashboard.') ? 'dashboard_title' : 'staged_text' });
  if (isFail(params)) return params;
  if (definition.actionId === 'dashboard.revoke_share' && !(input.context.dashboardShares ?? []).some(grant =>
    grant.dashboardId === params.dashboard?.value && grant.shareId === params.shareId?.value)) {
    return clarify('unknown_context_id', index, 'shareId', 'the Dashboard and share must match one active outgoing grant in the context');
  }
  if (definition.actionId === 'ticket.create' && !params.branchIds && !params.branchesFrom) return clarify('missing_param', index, 'params.branchIds', 'branchIds or branchesFrom is required');
  if (definition.actionId === 'policy.acknowledge') {
    // S1: only a policy this actor was SHOWN (accepted policy_read in this conversation) may be acknowledged: id AND version.
    const id = params.policy?.value, version = params.version?.value;
    const shown = (input.context.shownPolicies ?? []).some(p => p.id === id && p.version === version);
    if (!shown) return clarify('policy_not_shown', index, 'params.policy', 'the policy was not shown to this actor in this conversation');
  }
  const scope = {
    regionIds: params.regionIds?.value as string[] | undefined,
    branchIds: params.branchIds?.value as string[] | undefined,
  };
  if ((scope.regionIds || scope.branchIds) && input.hooks?.permitScope?.(definition.actionId, scope) === false) {
    return denied('scope_denied', index, 'scope hook denied the resolved scope');
  }
  return { index, step, params, riskTier: definition.riskTier };
}

function checkRefine(step: Extract<TurnStep, { kind: 'refine' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const pending = input.context.pendingActions.find(p => p.id === step.pendingActionId);
  // A saved dashboard in the context is also a legal refine target (title only; the executor enforces the rest).
  const saved = pending ? undefined : input.context.dashboards.find(d => d.id === step.pendingActionId);
  if (!pending && !saved) return clarify('unknown_context_id', index, 'pendingActionId', 'refine target is not in the context');
  if (step.operation.op === 'cancel') return { index, step, params: {} };
  const given = { title: step.operation.title, removeWidgetIndexes: step.operation.removeWidgetIndexes };
  const plan = step.operation.visualization ?? null;
  if (plan) {
    const sourceId = step.operation.sourceStateId;
    if (!sourceId) return clarify('missing_param', index, 'operation.sourceStateId', 'a visualization needs an accepted answer as evidence');
    if (!contextValues('accepted_state', input.context, index).has(sourceId)) return clarify('unknown_context_id', index, 'operation.sourceStateId', 'source state is not in the context');
    const texts = [plan.title, plan.description, ...plan.widgets.map(w => w.title)].filter(Boolean);
    if (texts.some(t => CONTROL_CHARS.test(t) || input.hooks?.isSafeText?.(t, 'generated') === false)) return clarify('unsafe_generated', index, 'visualization', 'visualization text failed safety');
  }
  if (!given.title && !given.removeWidgetIndexes && !plan) return clarify('missing_param', index, 'operation', 'revise_dashboard needs a title, widgets or a visualization');
  const params = groundParams(REFINE_PARAM_SPECS, given, { input, stepIndex: index, priorValues: pending?.values ?? { title: saved!.title }, pendingActionId: step.pendingActionId,
    surfaceOf: () => 'dashboard_title' });
  if (isFail(params)) return params;
  // G6: a revision whose only change was a blocked generated title asks for the name again (it never shows the model text).
  if (!params.title && !params.removeWidgetIndexes && !plan) return clarify('unsafe_generated', index, 'title', 'title generated text failed the model-text gate');
  return { index, step, params };
}

function checkArtifact(step: Extract<TurnStep, { kind: 'artifact' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const states = contextValues('accepted_state', input.context, index);
  if (!states.has(step.sourceStateId)) return clarify('unknown_context_id', index, 'sourceStateId', 'source state is not in the context');
  if ((step.operation === 'revise') !== (step.baseArtifactId !== null)) return denied('invalid_plan', index, 'baseArtifactId is required iff operation is revise');
  if (step.baseArtifactId !== null && !contextValues('artifact', input.context, index).has(step.baseArtifactId)) return clarify('unknown_context_id', index, 'baseArtifactId', 'artifact is not in the context');
  if ((step.artifactTypeId === 'chart') !== (step.visual !== null)) return denied('invalid_plan', index, 'visual is required iff artifactTypeId is chart');
  if ((step.outputFormat === 'csv') !== (step.artifactTypeId === 'csv_export')) return denied('invalid_plan', index, 'csv outputFormat is legal only for csv_export');
  const title = ground('title', ARTIFACT_TITLE_SPEC, step.title, { input, stepIndex: index, priorValues: {}, surfaceOf: () => 'artifact_title' });
  if (title === UNSAFE_MODEL_TEXT) {
    // G6: a blocked generated Result title falls back to a server title (type + the server label of the source dataset).
    const datasetId = input.context.acceptedStates.find(s => s.stateId === step.sourceStateId)?.datasetId;
    const datasetLabel = input.context.catalog.datasets.find(d => d.id === datasetId)?.label;
    return { index, step, params: { title: { name: 'title', value: serverArtifactTitle(step.artifactTypeId, datasetLabel), source: 'default', span: null, serverDefault: true } } };
  }
  return isFail(title) ? title : { index, step, params: { title } };
}

function checkQuery(step: Extract<TurnStep, { kind: 'query' | 'hr_query' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const datasetId = step.plan.datasetId;
  if (!input.context.catalog.datasets.some(d => d.id === datasetId)) return denied('dataset_unavailable', index, `${datasetId} is not available to this actor`);
  // `query` runs any registered non-HR dataset (branch_performance or a registered table dataset); `hr_query` only the HR directory.
  if (step.kind === 'hr_query' ? datasetId !== 'hr_employees' : datasetId === 'hr_employees') {
    return denied('dataset_mismatch', index, `${step.kind} cannot run dataset ${datasetId}`);
  }
  // CONTEXT-001: a page cursor is only legal when it is exactly the one the reference set offers (never model-invented or stale).
  const cursor = step.plan.page?.cursor;
  if (step.kind === 'query' && cursor && input.context.references && cursor !== input.context.references.pagination?.nextCursor) {
    return clarify('unknown_context_id', index, 'page.cursor', 'cursor is not in the reference set');
  }
  const continuation = step.kind === 'hr_query' || !step.continuation ? 'none' : input.context.previousState ? 'bound' : 'fresh';
  return { index, step, params: {}, continuation };
}

/** Context items of the kind the first missing slot refers to (registry contextKind), as server-labeled choices. */
export function contextItemsOf(kind: NonNullable<ParamSpec['contextKind']> | undefined, context: PlannerContext): { id: string; label: string }[] {
  switch (kind) {
    case 'dashboard': { const labels = dashboardChoiceLabels(context.dashboards); return context.dashboards.map(d => ({ id: d.id, label: labels.get(d.id) ?? d.title })); }
    case 'recipient': return context.recipients.map(r => ({ id: r.id, label: r.name }));
    case 'monitor': return (context.monitors ?? []).map(m => ({ id: m.id, label: m.title }));
    case 'pending_action': return context.pendingActions.map(p => ({ id: p.id, label: p.title }));
    case 'artifact': return context.artifacts.map(a => ({ id: a.id, label: a.title }));
    case 'archived_artifact': return (context.archivedArtifacts ?? []).map(a => ({ id: a.id, label: a.title }));
    case 'policy': return (context.policies ?? []).map(p => ({ id: p.id, label: p.title }));
    case 'accepted_state': return context.acceptedStates.filter(s => s.label).map(s => ({ id: s.stateId, label: s.label! }));
    case 'review_queue': return (context.workflow?.reviewedQueues ?? []).map(q => ({ id: q.id, label: `คิวที่ตรวจแล้ว (${q.requests.length} รายการ)` }));
    case 'onboarding_request': return (context.workflow?.reviewedQueues[0]?.requests ?? []).map(r => ({ id: r.id, label: r.label }));
    case 'onboarding_approval': return (context.workflow?.verifiedApprovals ?? []).map(a => ({ id: a.id, label: a.label }));
    default: return [];
  }
}
export function slotContextKind(about: Extract<TurnStep, { kind: 'clarify' }>['about'], slot: string, registry: ActionRegistry): NonNullable<ParamSpec['contextKind']> | undefined {
  const name = slot.replace(/^params\./, '');
  if (about.kind === 'action') return registry.get(about.actionId)?.params[name]?.contextKind;
  if (about.kind === 'refine' && name === 'pendingActionId') return 'pending_action';
  if (about.kind === 'artifact') return name === 'sourceStateId' ? 'accepted_state' : name === 'baseArtifactId' ? 'artifact' : undefined;
  return undefined;
}
/**
 * Server-owned choices for a slot, derived from the actor's CURRENT context: context-backed targets (dashboards, recipients, ...) and
 * authorized scope values (branch/region params offer the actor's own authorized choices; never a widening).
 */
export function slotChoices(about: Extract<TurnStep, { kind: 'clarify' }>['about'], slot: string, registry: ActionRegistry, context: PlannerContext): { id: string; label: string }[] {
  const items = contextItemsOf(slotContextKind(about, slot, registry), context);
  if (items.length || about.kind !== 'action') return items;
  const scope = registry.get(about.actionId)?.params[slot.replace(/^params\./, '')]?.scope;
  const allowed = scope === 'branch' ? context.scope.branchIds : scope === 'region' ? context.scope.regionIds : [];
  return scope ? context.catalog.choices.filter(choice => allowed.includes(choice.id)) : [];
}
function contextChoices(step: Extract<TurnStep, { kind: 'clarify' }>, input: ValidateInput): { id: string; label: string }[] {
  const first = step.missing[0];
  return first ? slotChoices(step.about, first.slot, input.registry, input.context) : [];
}

function checkClarify(step: Extract<TurnStep, { kind: 'clarify' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const { about } = step;
  const knownSlots = new Set<string>();
  if (about.kind === 'action') {
    const definition = input.registry.get(about.actionId);
    if (!definition) return denied('unknown_clarify_target', index, `${about.actionId} is not a registered action`);
    Object.keys(definition.params).forEach(n => knownSlots.add(`params.${n}`));
  } else if (about.kind === 'refine') {
    if (about.pendingActionId !== null && !input.context.pendingActions.some(p => p.id === about.pendingActionId)) return denied('unknown_clarify_target', index, 'pending action is not in the context');
    ['pendingActionId', 'operation', 'title', 'removeWidgetIndexes'].forEach(s => knownSlots.add(s));
  } else if (about.kind === 'artifact') {
    ['sourceStateId', 'artifactTypeId', 'baseArtifactId', 'title', 'visual'].forEach(s => knownSlots.add(s));
  }
  if (about.kind === 'query' || about.kind === 'hr_query') {
    // Query slots are catalog slot ids chosen by the planner; the server cannot enumerate them, only bound their shape (schema).
  } else if (!step.missing.every(m => knownSlots.has(m.slot))) {
    return denied('invalid_plan', index, 'clarify.missing names a slot that is not a param of the target');
  }
  const labels = new Map<string, string>();
  for (const c of input.context.catalog.choices) labels.set(c.id, c.label);
  input.context.recipients.forEach(r => labels.set(r.id, r.name));
  input.context.dashboards.forEach(d => labels.set(d.id, d.title));
  input.context.pendingActions.forEach(p => labels.set(p.id, p.title));
  input.context.artifacts.forEach(a => labels.set(a.id, a.title));
  (input.context.monitors ?? []).forEach(m => labels.set(m.id, m.title));
  (input.context.archivedArtifacts ?? []).forEach(a => labels.set(a.id, a.title));
  input.context.acceptedStates.forEach(s => { if (s.label) labels.set(s.stateId, s.label); });
  input.context.workflow?.reviewedQueues.forEach(q => { labels.set(q.id, `คิวที่ตรวจแล้ว (${q.requests.length} รายการ)`); q.requests.forEach(r => labels.set(r.id, r.label)); });
  input.context.workflow?.verifiedApprovals.forEach(a => labels.set(a.id, a.label));
  let choices = step.choices.filter(c => labels.has(c.id)).map(c => ({ id: c.id, label: labels.get(c.id) as string }));
  // The model offered nothing usable: when the first missing slot is a context-backed target, the server offers the
  // actor's own context items of that kind (ids and labels are server data; never a widening — the validator re-checks the pick).
  if (!choices.length) choices = contextChoices(step, input).slice(0, 8);
  const safe = modelTextSafe('clarify', step.question) && input.hooks?.isSafeText?.(step.question, 'clarify') !== false;
  return { index, step: { ...step, choices }, params: {}, safeText: safe ? step.question : null };
}

function checkPolicy(step: Extract<TurnStep, { kind: 'policy_read' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const known = new Set((input.context.policies ?? []).map(p => p.id));
  if (!step.policyIds.every(id => known.has(id))) return clarify('unknown_context_id', index, 'policyIds', 'policy id is not in the authorized POLICIES list');
  return { index, step, params: {} };
}

/** RESOURCE-LOOKUP: only kinds the actor may use (PlannerContext.lookup); the search itself runs in the executor under the actor's own ownership. */
function checkResourceLookup(step: Extract<TurnStep, { kind: 'resource_lookup' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  if (!input.context.lookup?.resources.includes(step.resource)) return denied('permission_denied', index, `${step.resource} lookup is not available to this actor`);
  if (CONTROL_CHARS.test(step.query)) return denied('invalid_plan', index, 'lookup query contains control characters');
  return { index, step, params: {} };
}

/** HR Director read: a read the V2 projection grants (WORKFLOW.reads); snapshot/request ids only from WORKFLOW.reviewedQueues. */
function checkWorkflowRead(step: Extract<TurnStep, { kind: 'workflow_read' }>, index: number, input: ValidateInput): GroundedStep | Fail {
  const workflow = input.context.workflow;
  if (!workflow?.reads.some(read => read.readId === step.readId)) return denied('permission_denied', index, `${step.readId} is not available to this actor`);
  if (step.readId === 'director_approvals_today') return { index, step: { kind: 'workflow_read', readId: step.readId }, params: {} };
  if (step.readId === 'director_queue') {
    // A new queue read; with a snapshotId copied from WORKFLOW.reviewedQueues it is the NEXT page after that reviewed queue (the server derives the cursor).
    if (!step.snapshotId) return { index, step: { kind: 'workflow_read', readId: step.readId }, params: {} };
    if (!workflow.reviewedQueues.some(q => q.id === step.snapshotId)) return clarify('unknown_context_id', index, 'snapshotId', 'the reviewed queue is not in WORKFLOW.reviewedQueues');
    return { index, step: { kind: 'workflow_read', readId: step.readId, snapshotId: step.snapshotId }, params: {} };
  }
  if (!step.snapshotId) return clarify('missing_param', index, 'snapshotId', 'a reviewed queue is required');
  const queue = workflow.reviewedQueues.find(q => q.id === step.snapshotId);
  if (!queue) return clarify('unknown_context_id', index, 'snapshotId', 'the reviewed queue is not in WORKFLOW.reviewedQueues');
  if (step.readId === 'director_start_dates') return { index, step: { kind: 'workflow_read', readId: step.readId, snapshotId: queue.id }, params: {} };
  if (!step.requestId) return clarify('missing_param', index, 'requestId', 'a request of the reviewed queue is required');
  if (!queue.requests.some(r => r.id === step.requestId)) return clarify('unknown_context_id', index, 'requestId', 'the request is not in that reviewed queue');
  return { index, step: { kind: 'workflow_read', readId: step.readId, snapshotId: queue.id, requestId: step.requestId }, params: {} };
}

function checkConversation(step: Extract<TurnStep, { kind: 'conversation' }>, index: number, input: ValidateInput): GroundedStep {
  if (step.prose === undefined) return { index, step, params: {}, safeText: null };
  const safe = modelTextSafe(step.topic === 'product_help' ? 'product_help' : 'conversation', step.prose) && input.hooks?.isSafeText?.(step.prose, 'prose') !== false;
  return { index, step, params: {}, safeText: safe ? step.prose : null };
}

/** Validate raw planner output. Never reads user language: spans are only located, ids only looked up. */
export function validateTurnPlan(input: ValidateInput): TurnPlanValidation {
  const parsed = turnPlanSchema.safeParse(canonicalizeModelPlan(input.raw, { context: input.context, registry: input.registry }));
  if (!parsed.success) return denied('invalid_plan', null, 'plan does not match the TurnPlan schema', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  const plan = parsed.data;
  const envelope = envelopeError(plan.steps);
  if (envelope) return denied('envelope_invalid', null, envelope);
  const steps: GroundedStep[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const prior = input.context.previousState?.values ?? {};
    let result: GroundedStep | Fail;
    switch (step.kind) {
      case 'query': case 'hr_query': result = checkQuery(step, index, input); break;
      case 'action': result = checkAction(step, index, input, prior); break;
      case 'refine': result = checkRefine(step, index, input); break;
      case 'artifact': result = checkArtifact(step, index, input); break;
      case 'clarify': result = checkClarify(step, index, input); break;
      case 'conversation': result = checkConversation(step, index, input); break;
      case 'policy_read': result = checkPolicy(step, index, input); break;
      case 'workflow_read': result = checkWorkflowRead(step, index, input); break;
      case 'resource_lookup': result = checkResourceLookup(step, index, input); break;
    }
    if (isFail(result)) return result;
    steps.push(result);
  }
  return { outcome: 'accepted', plan: { ...plan, steps: steps.map(s => s.step) }, steps };
}
