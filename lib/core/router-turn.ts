import { executeResourceLookupStep, type ResourceLookupPorts } from '../router/executors/resource-lookup';
import 'server-only';

import type { Actor, Analysis, Branch, Scope, SourceRef, Store, TurnArtifact, TurnChoice, TurnReceiptCard } from '../contracts';
import { AIRuntimeError } from '../ai/errors';
import { observeLiveAITurn } from '../ai/health';
import { createWave2Catalog, HR_DATASET, hrSupportedChoices } from '../dynamic/catalog/hr';
import { createSemanticCatalog, trustPolicy, type SemanticDatasetCatalog } from '../dynamic/catalog/semantic';
import { authority as queryAuthority } from '../dynamic/runtime';
import { businessDateSchema } from '../contracts';
import type { EvidenceBundle } from '../dynamic/evidence/bundle';
import type { ClaimGraph } from '../dynamic/evidence/claim-graph';
import { conversationStateId, conversationStateRef } from '../dynamic/planner/planner';
import type { AcceptedEvidence } from '../router/ports/effect-bindings';
import { queryPlanSchema } from '../dynamic/plan/schemas';
import { conversationStateSchema, prepareConversationState } from '../dynamic/state/conversation';
import { acceptedContext, authorizedBranches, type AcceptedPlan } from '../dynamic/validate/query-plan';
import { hrCatalogAuthority } from '../router/executors/hr-reader';
import type { DashboardVisualizationPlan } from '../visualization/dashboard-data';
import { buildDashboardSpecFromPlan } from '../visualization/dashboard-spec';
import type { DashboardSpec } from '../contracts';
import type { ActionRegistry } from '../router/action-registry';
import type { ActionPorts, StagedPorts } from '../router/executors/action-ports';
import { executeActionStep, STAGED_UNAVAILABLE_CODE, type ActionExecResult, type VisualizationSpecResult } from '../router/executors/action';
import type { ArtifactPreview, ArtifactStore } from '../artifacts';
import { executeArtifactStep } from '../router/executors/artifact';
import { executeHrQueryStep } from '../router/executors/hr';
import { executeQueryStep, type QueryExecutorInput } from '../router/executors/query';
import { executeTableQueryStep, loadTableStates, tableStateId, TABLE_TOOL } from '../router/executors/table-query';
import { buildDashboardSpecFromTablePlan } from '../visualization/dashboard-table';
import type { TableAcceptedEvidence } from '../router/ports/table-evidence';
import { tableStateSchema } from '../router/executors/table-query';
import type { TableAcceptedPlan, TableClaims, TableEvidenceBundle } from '../dynamic/table/engine';
import { executePolicyReadStep } from '../router/executors/policy';
import { executeWorkflowReadStep } from '../router/executors/workflow-read';
import type { DirectorWorkflowPort } from '../router/ports/director-workflow';
import { TABLE_DATASET_IDS } from '../dynamic/catalog/tables';
import { executeRefineStep } from '../router/executors/refine';
import type { PersistFn } from '../router/executors/shared';
import type { PlannerContext, TurnMessages } from '../router/planner-context';
import { CLARIFICATION_CHAIN_MAX_TURNS, CLARIFICATION_REQUEST_MAX_BYTES } from '../router/planner-context';
import { buildTurnPlannerInput } from '../router/planner/input';
import { requestTurnPlan } from '../router/planner/provider';
import { ScriptedTurnPlannerFixtureMissing } from '../router/planner/scripted';
import { actionLabel, entityLabelsOf, isSafeConversationProse, isSafeConversationTitle, isSafeFollowUp, renderClarify, renderConversation, renderPlannerFailure, serverSuggestions } from '../router/render';
import type { TurnPlan, TurnStep } from '../router/turn-plan';
import { slotChoices, validateTurnPlan, type GroundedStep, type TurnPlanValidation } from '../router/validate';
import { DomainError } from './errors';
import { digest, unique } from '../dynamic/shared';
import type { ChatStreamStatusCode } from '../chat-stream-contracts';
import { gateReason, recordGateFallback } from '../router/render/gate-log';
import { hasMalformedThai } from '../router/thai-orthography';
import { dashboardTargetOffer, isDashboardTargetSlot, isGenericDashboardQuery, sameTitleDashboards } from '../router/dashboard-target';

/** Where this turn's plan comes from. The server never derives a plan from user wording. */
export type PlanSource =
  | { kind: 'planner' }
  /** Server-owned plan (demo card / work-catalog entry), grounded against the entry's own canonical prompt. */
  | { kind: 'server'; plan: TurnPlan };

export interface RouterTurnDeps {
  store: Store; actor: Actor; conversationId: string; turnId: string; businessDate: string;
  now: () => Date; signal: AbortSignal; live: boolean;
  /** Wall-clock deadline of the whole turn: a timed-out planner attempt is retried only when this budget still allows it. */
  deadlineAt?: number;
  source: PlanSource; context: PlannerContext; messages: TurnMessages;
  registry: ActionRegistry; ports: ActionPorts; allRegionIds: readonly string[];
  read: QueryExecutorInput['read'];
  permitAction: (actionId: string) => boolean;
  emitStatus: (code: ChatStreamStatusCode) => Promise<void>;
  newArtifactId: () => string;
  /** Runtime/catalog enablement of a dataset (a pack that is not installed disables its dataset everywhere). Absent => all enabled. */
  datasetEnabled?: (datasetId: string) => boolean;
  /** Owner-scoped, transaction-free artifact lookup for create/revise (lookup failure throws; null = absent). */
  artifacts: Pick<ArtifactStore, 'latest'>;
  /** Persists an accepted artifact preview as a new immutable version inside the final turn transaction. */
  persistArtifact: (preview: ArtifactPreview) => PersistFn;
  /** HR Director Workflow V2 bridge (workflow_read steps). Absent = Workflow V2 not composed: the read is refused truthfully. */
  directorWorkflow?: DirectorWorkflowPort;
  /** resource_lookup: owner-scoped search of the actor's own older Dashboards / Results / Monitors. Absent = the lookup is refused truthfully. */
  resourceLookup?: ResourceLookupPorts;
}

export interface RouterTurnOutcome {
  text: string;
  clarification: boolean;
  sources?: SourceRef[];
  analysis?: Analysis;
  /** Accepted query/HR states, written inside the final turn transaction (CAS on the parent state). */
  persists: PersistFn[];
  choices?: TurnChoice[];
  artifacts?: TurnArtifact[];
  /**
   * Single-date retail answer scope: the service persists the V1 evidence snapshot for it beside the assistant message
   * (follow-up suggestions and the evidence card read it; the snapshot is re-read inside the final transaction).
   */
  evidenceScope?: Scope;
  /** Typed denials of this turn (scope, permission, recipient, dataset): audited as `denied` with metadata only, never user text. */
  denials?: { kind: string; code: string }[];
  /**
   * Every permission the answer's dataset and the fields it used require (recorded beside the message). Read-back redaction
   * checks them against the CURRENT actor, so revoking e.g. operations.read hides an answer that only cites sales sources.
   */
  requiredPermissions?: string[];
  pendingClarification?: { about: string; missing: string[]; parentTurnId?: string };
  hint?: 'switch_to_demo';
  /** AI-proposed next questions that passed output safety (plain text; shown as chips, sent as ordinary messages). */
  followUps?: string[];
  /** AI-authored conversation title that passed length/output safety (persisted once on the first turn). */
  suggestedConversationTitle?: string;
  /** Action results of this turn (pending-action ids are linked by the persistence layer). */
  actions: ActionExecResult[];
  /** G5: receipt cards of verified direct Dashboard organization (the service stamps verifiedAt in the transaction that writes and reads back the effect). */
  receiptCards?: Omit<TurnReceiptCard, 'verifiedAt'>[];
}

interface QueryEvidence { stateId: string; plan: AcceptedPlan; bundle: EvidenceBundle; claims: ClaimGraph; message: string }
/** An accepted answer over a registered table dataset (inventory_items, incident_log, support_tickets): the same role as QueryEvidence. */
interface TableEvidence { table: true; stateId: string; accepted: TableAcceptedPlan; bundle: TableEvidenceBundle; claims: TableClaims; message: string }
type AnyEvidence = QueryEvidence | TableEvidence;
const isTable = (evidence: AnyEvidence): evidence is TableEvidence => 'table' in evidence;

const DATASET_DISABLED = 'ชุดข้อมูลนี้ยังไม่เปิดใช้งานในระบบนี้ จึงยังไม่ได้ดำเนินการ';
const STEP_SKIPPED = 'ขั้นตอนถัดไปยังไม่ได้ดำเนินการ เพราะขั้นตอนแรกยังไม่ได้ผลลัพธ์ที่ตรวจสอบแล้ว';
const NOT_PERMITTED = 'บัญชีนี้ไม่มีสิทธิ์ทำรายการหรือดูข้อมูลตามคำขอนี้ จึงยังไม่ได้ดำเนินการใด ๆ';
const SOURCE_UNAVAILABLE = 'ไม่พบคำตอบที่ตรวจสอบแล้วซึ่งใช้เป็นหลักฐานได้ในบทสนทนานี้ โปรดถามข้อมูลก่อนแล้วจึงขอผลลัพธ์';

function plannerFailure(reason: 'outage' | 'invalid_plan' | 'slow', context?: PlannerContext): RouterTurnOutcome {
  const failure = renderPlannerFailure(reason);
  // An unusable plan is never a dead end: server-owned suggestions from the actor's own catalog (not for an outage).
  const followUps = reason === 'invalid_plan' && context ? serverSuggestions(context) : [];
  return { text: failure.text, clarification: true, persists: [], hint: failure.hint, actions: [], ...(followUps.length ? { followUps } : {}) };
}

/** Dataset + used-field permissions of an accepted answer (what the viewer must still hold to read it back). */
export function requiredPermissionsOf(plan: AcceptedPlan): string[] {
  const { dataset } = acceptedContext(plan);
  const used = new Set([...plan.plan.measures.map(m => m.fieldId), ...plan.plan.dimensions.map(d => d.fieldId), ...plan.plan.filters.map(f => f.fieldId)]);
  return unique([...dataset.requiredPermissions, ...dataset.fields.filter(f => used.has(f.id)).flatMap(f => f.requiredPermissions)]);
}

/** V1 evidence scope of an accepted single-date answer (region or 'all'; explicit branches only when they fit the scope schema). */
export function evidenceScopeOf(scope: { dates: string[]; regions: string[]; branchIds: string[] }): Scope | undefined {
  if (scope.dates.length !== 1 || !scope.regions.length) return undefined;
  const region = scope.regions.length === 1 ? scope.regions[0] : 'all';
  return { region, date: scope.dates[0], ...(scope.branchIds.length > 0 && scope.branchIds.length <= 12 ? { branchIds: [...scope.branchIds] } : {}) };
}

/** Typed text for a validation failure. Never echoes user wording. */
function validationOutcome(result: Exclude<TurnPlanValidation, { outcome: 'accepted' }>, context: PlannerContext, raw: unknown, registry: ActionRegistry): RouterTurnOutcome {
  if (result.outcome === 'denied') {
    if (result.code === 'invalid_plan' || result.code === 'envelope_invalid' || result.code === 'source_not_allowed') return plannerFailure('invalid_plan', context);
    const followUps = serverSuggestions(context);
    return { text: `${understoodPrefix(raw, context)}${NOT_PERMITTED}`, clarification: true, persists: [], actions: [], denials: [{ kind: 'plan', code: result.code }],
      ...(followUps.length ? { followUps } : {}) };
  }
  if (result.code === 'policy_not_shown') return { text: `${understoodPrefix(raw, context)}ยังไม่ได้แสดงเนื้อหา Policy ฉบับนี้ในบทสนทนา — โปรดขอเปิดอ่าน Policy ก่อน แล้วค่อยรับทราบ`, clarification: true, persists: [], actions: [],
    denials: [{ kind: 'plan', code: result.code }], pendingClarification: { about: 'action:policy.acknowledge', missing: ['params.policy'] } };
  const slot = result.slot.startsWith('params.') || !result.slot.includes('.') ? result.slot : 'interpretation';
  // The step the model meant (model output, never user text) decides which context items can answer the slot.
  const failing = rawStep(raw, result.stepIndex);
  const about: Extract<TurnStep, { kind: 'clarify' }>['about'] = failing?.kind === 'action' && typeof failing.actionId === 'string' && registry.get(failing.actionId)
    ? { kind: 'action', actionId: failing.actionId } : failing?.kind === 'refine' ? { kind: 'refine', pendingActionId: null } : failing?.kind === 'artifact' ? { kind: 'artifact' } : { kind: 'query' };
  const choices = slotChoices(about, slot, registry, context).slice(0, 8);
  const synthetic: GroundedStep = { index: result.stepIndex, params: {}, safeText: null,
    step: { kind: 'clarify', about, missing: [{ slot, reason: 'absent' }], question: '-', choices } };
  const rendered = renderClarify(synthetic, context);
  const followUps = rendered.choices.length ? [] : serverSuggestions(context);
  return { text: `${understoodPrefix(raw, context)}${rendered.text}`, clarification: true, persists: [], actions: [],
    ...(rendered.choices.length ? { choices: rendered.choices } : {}), ...(followUps.length ? { followUps } : {}),
    pendingClarification: { about: about.kind === 'action' ? `action:${about.actionId}` : `validation:${result.code}`, missing: [slot] } };
}

/** Step kinds of the raw plan (registered kind names only) for the validation log line. */
function rawKinds(raw: unknown): string[] {
  const steps = raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : [];
  return steps.slice(0, 4).map(step => {
    const kind = step && typeof step === 'object' ? (step as { kind?: unknown }).kind : undefined;
    return typeof kind === 'string' && /^[a-z_]{1,24}$/u.test(kind) ? kind : 'other';
  });
}

function rawStep(raw: unknown, index: number | null): Record<string, unknown> | undefined {
  if (index === null || !raw || typeof raw !== 'object' || !Array.isArray((raw as { steps?: unknown }).steps)) return undefined;
  const step = (raw as { steps: unknown[] }).steps[index];
  return step && typeof step === 'object' ? step as Record<string, unknown> : undefined;
}

/** "What I understood" from the MODEL's plan (registered action / dataset kinds only, server-owned Thai names). */
function understoodPrefix(raw: unknown, context: PlannerContext): string {
  const steps = raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : [];
  const names = steps.flatMap(step => {
    if (!step || typeof step !== 'object') return [];
    const s = step as { kind?: unknown; actionId?: unknown; plan?: { datasetId?: unknown } };
    // Dataset names come from the actor's own authorized catalog (an id outside it names nothing).
    const dataset = typeof s.plan?.datasetId === 'string' ? context.catalog.datasets.find(d => d.id === s.plan!.datasetId) : undefined;
    if (s.kind === 'action' && typeof s.actionId === 'string') return [actionLabel(s.actionId)];
    if ((s.kind === 'query' || s.kind === 'hr_query') && dataset) return [`ดูข้อมูล${dataset.label}`];
    return [];
  }).filter((name): name is string => !!name);
  return names.length ? `ผมเข้าใจว่าคุณต้องการ${[...new Set(names)].join(' แล้ว')} — ` : '';
}

function domainFailureText(error: DomainError): string {
  return `ยังไม่ได้ดำเนินการ — ${error.message}`;
}

/**
 * One router turn: plan (planner or server-owned plan) -> validateTurnPlan -> registered executors -> truthful text.
 * Numbers in the answer come only from executor renderers over verified evidence; AI prose passes the output-safety gate.
 */
export async function runRouterTurn(deps: RouterTurnDeps): Promise<RouterTurnOutcome> {
  const { context, messages, signal } = deps;
  let raw: unknown;
  if (deps.source.kind === 'server') raw = deps.source.plan;
  else {
    try {
      const input = buildTurnPlannerInput(context, messages);
      raw = await observeLiveAITurn(deps.live, () => requestTurnPlan(input, { actor: deps.actor, diagnosticId: deps.turnId, signal, ...(deps.deadlineAt ? { turnDeadlineAt: deps.deadlineAt } : {}) }), deps.actor.id);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof ScriptedTurnPlannerFixtureMissing) throw error;
      if (error instanceof AIRuntimeError) {
        return plannerFailure(error.code === 'invalid_model_response' || error.code === 'invalid_input' ? 'invalid_plan'
          : error.code === 'deadline_exceeded' ? 'slow' : 'outage', context);
      }
      throw error;
    }
  }
  signal.throwIfAborted();

  const validation = validateTurnPlan({
    raw, messages, context, registry: deps.registry,
    hooks: {
      permitAction: deps.permitAction,
      // Model Thai the parse-time repair could not fix never reaches a preview / effect param (the slot is asked again instead).
      isSafeText: (text, kind) => !hasMalformedThai(text) && (kind === 'generated' ? !/[\u0000-\u001f\u007f]/u.test(text) : true),
    },
  });
  if (validation.outcome !== 'accepted') {
    // G5: a rejected plan was silent in the logs (the planner line looked clean). Codes, step index, slot and issue PATHS only: never prose or user text.
    console.info('BIZTANIA_TURN_VALIDATION', JSON.stringify({ outcome: validation.outcome, code: validation.code, stepIndex: validation.stepIndex,
      ...(validation.outcome === 'clarify' ? { slot: validation.slot.slice(0, 80) } : {}),
      // Validator details are server-authored templates over registry/context ids (never user text); bounded.
      ...(validation.outcome === 'denied' ? { detail: validation.detail.slice(0, 120) } : {}),
      ...(validation.outcome === 'denied' && validation.issues?.length ? { issues: validation.issues.slice(0, 8).map(issue => issue.split(':')[0]!.slice(0, 80)) } : {}),
      kinds: rawKinds(raw) }));
    return validationOutcome(validation, context, raw, deps.registry);
  }

  const out: RouterTurnOutcome = { text: '', clarification: false, persists: [], actions: [] };
  const texts: string[] = [];
  const deny = (kind: string, code: string) => { (out.denials ??= []).push({ kind, code }); };
  let step0: AnyEvidence | undefined;
  let step0Accepted = false;
  /** Id the step-0 table answer will have once this turn persists (effect proposals store that, never `$step0`). */
  let tableStep0Id: string | undefined;

  const catalogNow = async () => createSemanticCatalog(await deps.store.list<Branch>('branches'));
  const resolveSource = async (sourceId: string): Promise<AnyEvidence | undefined> => {
    if (sourceId === '$step0') return step0;
    return await resolveAcceptedState(deps, sourceId) ?? await resolveAcceptedTableState(deps, sourceId);
  };
  const visualizationSpec = async ({ visualization, sourceId, title }: Parameters<NonNullable<Parameters<typeof executeActionStep>[0]['visualizationSpec']>>[0]): Promise<VisualizationSpecResult> => {
    const evidence = await resolveSource(sourceId);
    if (!evidence) return { outcome: 'rejected', code: 'source_unavailable', text: SOURCE_UNAVAILABLE };
    const actor = await deps.ports.reloadActor(deps.actor);
    const built = isTable(evidence) ? buildDashboardSpecFromTablePlan(visualization, evidence, await catalogNow(), actor)
      : buildDashboardSpecFromPlan(visualization, evidence, await catalogNow(), actor);
    if (built.outcome !== 'accepted') return { outcome: 'rejected', code: built.code, text: built.text };
    return { outcome: 'accepted', spec: title ? { ...built.spec, title } : built.spec, omitted: built.omitted };
  };

  /** Step 0's accepted answer as in-memory evidence for effect binding (communication.send / monitor.create over `$step0`). */
  const stepState = async (): Promise<{ persistedId: string; accepted: AcceptedEvidence | TableAcceptedEvidence } | undefined> => {
    if (!step0 || !step0Accepted) return undefined;
    const tableSource = isTable(step0) ? step0 : undefined;
    if (tableSource) {
      const catalog = await catalogNow();
      const dataset = catalog.datasets.find(d => d.id === tableSource.accepted.dataset.id);
      if (!dataset || !tableStep0Id) return undefined;
      return { persistedId: tableStep0Id, accepted: { table: true, stateId: tableStep0Id, plan: tableSource.accepted.plan, dataset, joined: tableSource.accepted.joined,
        bundle: tableSource.bundle, claims: tableSource.claims, catalog, datasetPermissions: unique([...dataset.requiredPermissions, ...tableSource.accepted.joined.flatMap(d => d.requiredPermissions)]) } };
    }
    if (isTable(step0)) return undefined;
    const actor = await deps.ports.reloadActor(deps.actor);
    const prepared = prepareConversationState({ conversationId: deps.conversationId, turnId: deps.turnId, revision: 1,
      sourceText: { id: `source:${deps.turnId}`, version: 1, digest: digest(step0.message) }, parentState: null,
      plan: step0.plan, bundle: step0.bundle, claims: step0.claims }, queryAuthority(actor));
    if (prepared.outcome !== 'accepted') return undefined;
    const catalog = await catalogNow();
    const dataset = catalog.datasets.find(d => d.id === prepared.state.dataset.id);
    if (!dataset) return undefined;
    return { persistedId: conversationStateId(deps.conversationId, deps.turnId),
      accepted: { state: prepared.state, bundle: step0.bundle, graph: step0.claims, catalog, datasetPermissions: [...dataset.requiredPermissions] } };
  };

  const refineDashboardSpec = async ({ visualization, sourceId, base }: { visualization: DashboardVisualizationPlan; sourceId: string; base: DashboardSpec }): Promise<VisualizationSpecResult> => {
    const evidence = await resolveSource(sourceId);
    if (!evidence) return { outcome: 'rejected', code: 'source_unavailable', text: SOURCE_UNAVAILABLE };
    const actor = await deps.ports.reloadActor(deps.actor);
    const built = isTable(evidence) ? buildDashboardSpecFromTablePlan(visualization, evidence, await catalogNow(), actor, { base })
      : buildDashboardSpecFromPlan(visualization, evidence, await catalogNow(), actor, { base });
    return built.outcome === 'accepted' ? { outcome: 'accepted', spec: built.spec, omitted: built.omitted } : { outcome: 'rejected', code: built.code, text: built.text };
  };

  for (const grounded of validation.steps) {
    signal.throwIfAborted();
    const step = grounded.step;
    if (grounded.index === 1 && !step0Accepted) { texts.push(STEP_SKIPPED); out.clarification = true; break; }
    switch (step.kind) {
      case 'query': {
        if (deps.datasetEnabled && !deps.datasetEnabled(step.plan.datasetId)) { texts.push(DATASET_DISABLED); out.clarification = true; deny('query', 'dataset_disabled'); break; }
        await deps.emitStatus('reading');
        if (TABLE_DATASET_IDS.includes(step.plan.datasetId)) {
          // Registered table datasets run the same plan -> validate -> read -> evidence path with their own registered reader.
          // The accepted answer is a first-class source for a second step (artifact, Dashboard widgets, communication.send).
          const table = await executeTableQueryStep({ store: deps.store, actor: deps.actor, message: messages.current, businessDate: deps.businessDate,
            diagnosticId: deps.turnId, now: deps.now, read: deps.read, signal, conversationId: deps.conversationId, step, continuation: grounded.continuation });
          texts.push(table.text);
          if (table.outcome === 'accepted') {
            step0Accepted = grounded.index === 0;
            step0 = { table: true, stateId: '$step0', accepted: table.plan, bundle: table.bundle, claims: table.claims, message: messages.current };
            tableStep0Id = table.expectedStateId;
            out.sources = table.sources; out.analysis = table.analysis; out.persists.push(table.persist);
            out.requiredPermissions = unique([...(out.requiredPermissions ?? []), ...table.plan.dataset.requiredPermissions, ...table.plan.joined.flatMap(d => d.requiredPermissions)]);
          } else {
            out.clarification = true;
            if (table.outcome === 'denied') deny('query', table.code);
            if (table.outcome === 'clarify' && table.choices.length) out.choices = table.choices.slice(0, 8);
          }
          break;
        }
        const result = await executeQueryStep({ store: deps.store, actor: deps.actor, message: messages.current, businessDate: deps.businessDate,
          diagnosticId: deps.turnId, now: deps.now, read: deps.read, signal, conversationId: deps.conversationId, step, continuation: grounded.continuation });
        texts.push(result.text);
        if (result.outcome === 'accepted') {
          step0Accepted = grounded.index === 0;
          step0 = { stateId: '$step0', plan: result.plan, bundle: result.bundle, claims: result.claims, message: messages.current };
          out.sources = result.sources; out.analysis = result.analysis; out.persists.push(result.persist);
          out.requiredPermissions = unique([...(out.requiredPermissions ?? []), ...requiredPermissionsOf(result.plan)]);
          const scope = evidenceScopeOf(result.interpretedScope);
          if (grounded.index === 0 && scope) out.evidenceScope = scope;
        } else {
          out.clarification = true;
          if (result.outcome === 'denied') deny('query', result.code);
          if (result.outcome === 'clarify' && result.choices.length) out.choices = result.choices.slice(0, 8);
        }
        break;
      }
      case 'hr_query': {
        if (deps.datasetEnabled && !deps.datasetEnabled(step.plan.datasetId)) { texts.push(DATASET_DISABLED); out.clarification = true; deny('hr_query', 'dataset_disabled'); break; }
        await deps.emitStatus('reading');
        const result = await executeHrQueryStep({ store: deps.store, actor: deps.actor, message: messages.current, diagnosticId: deps.turnId,
          now: deps.now, step, conversationId: deps.conversationId, signal,
          isSafeText: text => isSafeConversationProse(text, []) });
        texts.push(result.text);
        if (result.outcome === 'accepted') {
          step0Accepted = grounded.index === 0;
          out.sources = result.sources; out.analysis = result.analysis; out.persists.push(result.persist);
          out.requiredPermissions = unique([...(out.requiredPermissions ?? []), 'hr.read']);
        } else {
          out.clarification = true;
          if (result.outcome === 'denied') deny('hr_query', result.code);
          if (result.outcome === 'clarify' && result.choices.length) out.choices = result.choices.slice(0, 8);
        }
        break;
      }
      case 'action': case 'refine': {
        await deps.emitStatus('preparing');
        let result: ActionExecResult;
        try {
          result = step.kind === 'action'
            ? await executeActionStep({ ports: deps.ports, actor: deps.actor, step: grounded, conversationId: deps.conversationId, turnId: deps.turnId,
              now: deps.now, registry: deps.registry, signal, allRegionIds: deps.allRegionIds, visualizationSpec, stepState,
              sameTitleDashboards: title => sameTitleDashboards(context, title), recipientLabels: new Map(context.recipients.map(person => [person.id, person.name])) })
            : await executeRefineStep({ ports: deps.ports, actor: deps.actor, step: grounded, conversationId: deps.conversationId, turnId: deps.turnId, now: deps.now, signal, refineDashboardSpec });
        } catch (error) {
          if (signal.aborted || !(error instanceof DomainError) || ![400, 403, 404, 409].includes(error.status)) throw error;
          result = { outcome: 'denied', actionId: step.kind === 'action' ? step.actionId : 'refine', code: error.code, text: domainFailureText(error), labels: [] };
        }
        out.actions.push(result);
        if (result.outcome === 'updated' && result.card) out.receiptCards = [...(out.receiptCards ?? []), result.card];
        if (result.outcome === 'denied') deny(`action:${result.actionId}`, result.code);
        // A "[query, monitor.create]" turn: the staged Monitor proposal carries condition, cadence and recipients; the step-0 answer
        // (every branch fact) stays persisted as evidence but is not repeated in the reply.
        if (result.outcome === 'proposed' && result.actionId === 'monitor.create' && grounded.index === 1 && step0Accepted && texts.length === 1) {
          texts.length = 0;
          texts.push(result.text);
        } else texts.push(result.text);
        if (result.outcome === 'clarify' || result.outcome === 'denied' || result.outcome === 'failed') out.clarification = true;
        break;
      }
      case 'artifact': {
        await deps.emitStatus('analyzing');
        const source = await resolveSource(step.sourceStateId);
        if (!source) { texts.push(SOURCE_UNAVAILABLE); out.clarification = true; break; }
        const result = await executeArtifactStep({ store: deps.store, actor: deps.actor, now: deps.now, signal,
          step: grounded as GroundedStep & { step: typeof step },
          source: isTable(source) ? { table: true, stateId: source.stateId, accepted: source.accepted, bundle: source.bundle, claims: source.claims } : source,
          artifacts: deps.artifacts, newArtifactId: deps.newArtifactId() });
        texts.push(result.text);
        if (result.outcome === 'accepted') {
          out.persists.push(deps.persistArtifact(result.preview));
          out.artifacts = [...(out.artifacts ?? []), { id: result.artifact.id, revision: result.artifact.revision, kind: result.artifact.kind,
            title: result.artifact.title, spec: result.spec }];
        } else {
          out.clarification = true;
          if (result.outcome === 'denied') { deny('artifact', result.code); if (result.followUps?.length) out.followUps = result.followUps; }
        }
        break;
      }
      case 'policy_read': {
        await deps.emitStatus('reading');
        const policy = await executePolicyReadStep({ store: deps.store, actor: deps.actor, now: deps.now, step });
        texts.push(policy.text);
        if (policy.outcome === 'accepted') {
          step0Accepted = grounded.index === 0;
          out.sources = policy.sources; out.analysis = policy.analysis;
          out.requiredPermissions = unique([...(out.requiredPermissions ?? []), ...policy.requiredPermissions]);
        } else { out.clarification = true; deny('policy_read', policy.code); }
        break;
      }
      case 'workflow_read': {
        await deps.emitStatus('reading');
        const read = await executeWorkflowReadStep({ port: deps.directorWorkflow, actor: deps.actor, step, conversationId: deps.conversationId, turnId: deps.turnId, now: deps.now });
        texts.push(read.text);
        if (read.outcome === 'accepted') {
          out.sources = read.sources; out.analysis = read.analysis;
          if (read.persist) out.persists.push(read.persist);
          out.requiredPermissions = unique([...(out.requiredPermissions ?? []), ...read.requiredPermissions]);
        } else { out.clarification = true; deny('workflow_read', read.code); }
        break;
      }
      case 'resource_lookup': {
        await deps.emitStatus('reading');
        // G3-5: "a Dashboard" (the generic noun, no title) or no owned match: offer the actor's Dashboards plus create-new, never a dead end.
        const offer = step.resource === 'dashboard' && deps.resourceLookup ? dashboardTargetOffer(context) : undefined;
        if (offer && isGenericDashboardQuery(step.query)) {
          texts.push(offer.text); out.clarification = true; out.choices = offer.choices;
          out.pendingClarification = { about: 'lookup:dashboard', missing: ['params.dashboard'] };
          break;
        }
        const found = await executeResourceLookupStep({ ports: deps.resourceLookup, actor: deps.actor, step });
        if (offer && found.outcome === 'none') {
          texts.push(`${found.text}\n${offer.text}`); out.clarification = true; out.choices = offer.choices;
          out.pendingClarification = { about: found.about, missing: found.missing };
          break;
        }
        texts.push(found.text);
        out.clarification = true;
        if (found.outcome === 'denied') { deny('resource_lookup', found.code); break; }
        if (found.outcome === 'choices') out.choices = found.choices;
        out.pendingClarification = { about: found.about, missing: found.missing };
        break;
      }
      case 'clarify': {
        const rendered = renderClarify(grounded, context);
        if (!rendered.fromPlanner) recordGateFallback('clarify', gateReason(step.question, entityLabelsOf(context), 300));
        texts.push(rendered.text);
        out.clarification = true;
        if (rendered.choices.length) out.choices = rendered.choices;
        // G3-5: a Dashboard target (the first missing slot, which the choices answer) is offered as server-built choices: the listed Dashboards plus create-new.
        const targetOffer = isDashboardTargetSlot(step.about, step.missing[0]?.slot ?? '') ? dashboardTargetOffer(context, rendered.choices) : undefined;
        // A dashboard.create title/source question becomes the target question itself, so its text is the offer's (the model asked for a title).
        if (targetOffer) { out.choices = targetOffer.choices; if (!rendered.fromPlanner || step.about.kind === 'action') texts[texts.length - 1] = targetOffer.text; }
        out.pendingClarification = {
          about: step.about.kind === 'action' ? `action:${step.about.actionId}` : step.about.kind === 'refine' ? `refine:${step.about.pendingActionId ?? ''}` : step.about.kind,
          missing: step.missing.map(m => m.slot),
        };
        break;
      }
      case 'conversation': {
        const rendered = renderConversation(grounded, context);
        if (!rendered.fromPlanner && step.topic !== 'capability' && step.prose !== undefined) recordGateFallback('conversation', gateReason(step.prose, entityLabelsOf(context)), { topic: step.topic });
        texts.push(rendered.text);
        break;
      }
    }
  }
  out.text = texts.filter(Boolean).join('\n\n') || renderPlannerFailure('invalid_plan').text;
  if (!out.clarification && validation.plan.followUps?.length) {
    const labels = entityLabelsOf(context);
    const candidates = [...new Set(validation.plan.followUps.map(text => text.trim()))];
    const passing = candidates.filter(text => isSafeFollowUp(text, labels));
    const safe = passing.slice(0, 3);
    const rejectedFollowUp = candidates.find(text => !passing.includes(text));
    if (rejectedFollowUp !== undefined) recordGateFallback('follow_up', gateReason(rejectedFollowUp, labels, 100), { dropped: candidates.length - passing.length });
    if (safe.length) out.followUps = safe;
  }
  if (validation.plan.suggestedConversationTitle) {
    const title = validation.plan.suggestedConversationTitle.replace(/\s+/g, ' ').trim();
    if (isSafeConversationTitle(title, entityLabelsOf(context))) out.suggestedConversationTitle = title;
    else recordGateFallback('title', gateReason(title, entityLabelsOf(context)));
  }
  // Never a bare dead end: a refusal / clarification with nothing to tap gets server-owned next steps from the catalog.
  if (out.clarification && !out.choices?.length && !out.followUps?.length) {
    const suggestions = serverSuggestions(context);
    if (suggestions.length) out.followUps = suggestions;
  }
  return out;
}

/**
 * Re-executes an accepted answer of this conversation under the CURRENT actor authority (never trusting stored numbers):
 * the stored canonical plan is grounded again against its own stored user message.
 */
async function resolveAcceptedState(deps: RouterTurnDeps, stateId: string): Promise<QueryEvidence | undefined> {
  const records = (await deps.store.list<{ name: string; conversationId: string; actorId: string; turnId: string; state: unknown; plan: unknown }>('tool_executions',
    { actorId: deps.actor.id, sessionId: deps.actor.sessionId, status: 'completed' }))
    .filter(r => r.name === 'retail.dynamic_query' && r.actorId === deps.actor.id && r.conversationId === deps.conversationId);
  const record = records.find(r => {
    const state = conversationStateSchema.safeParse(r.state);
    return state.success && conversationStateRef(state.data).id === stateId;
  });
  const plan = record ? queryPlanSchema.safeParse(record.plan) : undefined;
  if (!record || !plan?.success) return undefined;
  const userMessage = await deps.store.get<{ text: string; actorId: string; role: string; conversationId: string }>('conversation_messages', record.turnId);
  if (!userMessage || userMessage.actorId !== deps.actor.id || userMessage.role !== 'user' || userMessage.conversationId !== deps.conversationId) return undefined;
  const result = await executeQueryStep({ store: deps.store, actor: deps.actor, message: userMessage.text, businessDate: deps.businessDate,
    diagnosticId: `${deps.turnId}:source`, now: deps.now, read: deps.read, signal: deps.signal, conversationId: deps.conversationId,
    step: { kind: 'query', continuation: false, plan: plan.data } });
  return result.outcome === 'accepted' ? { stateId, plan: result.plan, bundle: result.bundle, claims: result.claims, message: userMessage.text } : undefined;
}

/**
 * Re-executes an accepted TABLE answer of this conversation under the CURRENT actor authority (never trusting stored numbers): the stored
 * canonical plan runs again through the registered table path against its own stored user message.
 */
async function resolveAcceptedTableState(deps: RouterTurnDeps, stateId: string): Promise<TableEvidence | undefined> {
  if (!stateId.startsWith('table-state:')) return undefined;
  const catalog = createSemanticCatalog(await deps.store.list<Branch>('branches'));
  const states = await loadTableStates(deps.store, deps.actor, deps.conversationId, catalog);
  const found = states.find(item => tableStateId(item.state) === stateId);
  if (!found) return undefined;
  const records = await deps.store.list<{ name: string; conversationId: string; actorId: string; turnId: string; state: unknown }>('tool_executions',
    { actorId: deps.actor.id, sessionId: deps.actor.sessionId, status: 'completed' });
  const record = records.find(r => r.name === TABLE_TOOL && r.conversationId === deps.conversationId && r.actorId === deps.actor.id
    && tableStateSchema.safeParse(r.state).success && tableStateId(tableStateSchema.parse(r.state)) === stateId);
  if (!record) return undefined;
  const userMessage = await deps.store.get<{ text: string; actorId: string; role: string; conversationId: string }>('conversation_messages', record.turnId);
  if (!userMessage || userMessage.actorId !== deps.actor.id || userMessage.role !== 'user' || userMessage.conversationId !== deps.conversationId) return undefined;
  const result = await executeTableQueryStep({ store: deps.store, actor: deps.actor, message: userMessage.text, businessDate: deps.businessDate,
    diagnosticId: `${deps.turnId}:source`, now: deps.now, read: deps.read, signal: deps.signal, conversationId: deps.conversationId,
    step: { kind: 'query', continuation: false, plan: found.plan }, continuation: 'none' });
  return result.outcome === 'accepted' ? { table: true, stateId, accepted: result.plan, bundle: result.bundle, claims: result.claims, message: userMessage.text } : undefined;
}

// ---------------------------------------------------------------- planner-context helpers (server data only)

export const PENDING_CLARIFICATION_TOOL = 'router.pending_clarification';
export const LIVE_AI_DISABLED_TEXT = 'Live AI ยังไม่ได้เปิดใช้งานในระบบนี้ ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล คุณสามารถใช้โหมดสาธิตเพื่อดูตัวอย่างการทำงานได้';
export const CATALOG_ENTRY_UNAVAILABLE_TEXT = 'รายการงานนี้ไม่พร้อมใช้งานสำหรับบัญชีนี้ในตอนนี้ จึงยังไม่ได้ดำเนินการ — เลือกรายการอื่นจากรายการงานที่ทำได้';
const SERVED_TABLES = ['sales_orders', 'sales_targets', 'inventory_snapshots', 'incidents', 'staffing_summaries'] as const;

/** Thai display labels for catalog datasets (server-owned). */
/** Display names live on the registered datasets (SemanticDataset.label); the caller passes the registered label. */
export function datasetLabel(_id: string, label: string): string { return label; }

/** Authorized dataset/field descriptors the planner needs to write QueryPlans (ids, kinds, canonical values). */
export function plannerCatalogDescriptors(catalog: SemanticDatasetCatalog, actor: Actor, enabled: (datasetId: string) => boolean = () => true): unknown[] {
  const authority = queryAuthority(actor);
  const branchIds = new Set(authorizedBranches(catalog, authority).map(b => b.id));
  const can = (required: readonly string[]) => required.every(p => actor.permissions.includes(p));
  const datasets: unknown[] = catalog.datasets.filter(d => enabled(d.id) && actor.active && branchIds.size > 0 && can(d.requiredPermissions)
    && trustPolicy(d.trust, d.sensitivity, ['explore']).allowed).map(d => ({
    id: d.id, ...(d.label ? { label: d.label } : {}), description: d.description, timezone: d.timezone, defaultMeasure: d.defaultMeasure, defaultDimensions: d.defaultDimensions,
    grain: d.grain, budgets: d.budgets,
    ...(d.table ? { table: { snapshot: d.table.snapshot, joins: d.table.joins.map(join => ({ datasetId: join.to, keys: join.keys })) } } : {}),
    fields: d.fields.filter(f => can(f.requiredPermissions) && trustPolicy(f.trust, f.sensitivity, ['explore']).allowed).map(f => ({
      id: f.id, kind: f.kind, description: f.description, unit: f.unit, aggregations: f.aggregations, additivity: f.additivity,
      targetFieldId: f.targetFieldId,
      canonicalValues: f.canonicalValues?.filter(v => f.id === 'branch' ? branchIds.has(v.id) : true).map(v => ({ id: v.id, label: v.label })),
    })),
  }));
  if (actor.permissions.includes('hr.read') && enabled(HR_DATASET.id)) {
    datasets.push({ id: HR_DATASET.id, description: HR_DATASET.description, grain: HR_DATASET.grain, fields: HR_DATASET.fields,
      budgets: HR_DATASET.budgets, supported: hrSupportedChoices(createWave2Catalog(catalog.branches), hrCatalogAuthority(actor)) });
  }
  return datasets;
}

/** Served-date window over the actor's permitted branches (same rule as the query executor). */
export async function availabilityWindow(store: Store, actor: Actor, catalog: SemanticDatasetCatalog): Promise<{ from: string; to: string } | null> {
  const permitted = new Set(authorizedBranches(catalog, queryAuthority(actor)).map(b => b.id));
  const rows = await Promise.all(SERVED_TABLES.map(table => store.list<{ branchId: string; date: string }>(table)));
  const dates = [...new Set(rows.flat().filter(r => permitted.has(r.branchId) && businessDateSchema.safeParse(r.date).success).map(r => r.date))].sort();
  return dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null;
}

/** The stored canonical plan behind a previous accepted state id (planner continuation context). */
export async function previousPlanFor(store: Store, actor: Actor, conversationId: string, stateId: string): Promise<unknown> {
  const records = (await store.list<{ name: string; conversationId: string; actorId: string; state: unknown; plan: unknown }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(r => r.name === 'retail.dynamic_query' && r.conversationId === conversationId);
  return records.find(r => {
    const state = conversationStateSchema.safeParse(r.state);
    return state.success && conversationStateRef(state.data).id === stateId;
  })?.plan;
}

export interface PendingClarification { turnId: string; about: string; missing: string[]; clarifiedTurnText: string; clarifiedTurns: string[] }
/** The clarify persisted by the immediately preceding completed assistant turn of this conversation (if any). */
export async function latestPendingClarification(store: Store, actor: Actor, conversationId: string, currentTurnId: string): Promise<PendingClarification | undefined> {
  const assistants = (await store.list<{ role: string; conversationId: string; actorId: string; sessionId?: string; turnId?: string; createdAt: string }>('conversation_messages', { actorId: actor.id }))
    .filter(m => m.role === 'assistant' && m.actorId === actor.id && m.conversationId === conversationId && m.sessionId === actor.sessionId && m.turnId && m.turnId !== currentTurnId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.turnId ?? '').localeCompare(b.turnId ?? ''));
  if (!assistants[0]?.turnId) return undefined;
  // Several turns can share one timestamp (and a store's list order is not insertion order). Among the newest group,
  // the turn that actually offered a clarification is the one a selection answers; the order is deterministic.
  const newest = assistants.filter(m => m.createdAt === assistants[0].createdAt);
  type ClarificationRecord = { name: string; actorId: string; sessionId?: string; conversationId: string; turnId: string; about: unknown; missing: unknown; parentTurnId?: unknown };
  let lastTurnId: string | undefined, record: ClarificationRecord | undefined;
  for (const candidate of newest) {
    const found = await store.get<ClarificationRecord>('tool_executions', `clarification:${candidate.turnId}`);
    if (found && found.name === PENDING_CLARIFICATION_TOOL && found.actorId === actor.id && found.sessionId === actor.sessionId && found.conversationId === conversationId && found.turnId === candidate.turnId) {
      lastTurnId = candidate.turnId; record = found; break;
    }
  }
  if (!lastTurnId || !record) return undefined;
  type UserMessage = { role: string; actorId: string; sessionId?: string; conversationId: string; text: string };
  const clarified = await store.get<UserMessage>('conversation_messages', lastTurnId);
  if (!clarified || clarified.role !== 'user' || clarified.actorId !== actor.id || clarified.sessionId !== actor.sessionId || clarified.conversationId !== conversationId || typeof clarified.text !== 'string') return undefined;
  const clarifiedTurns = [clarified.text];
  const visited = new Set([lastTurnId]);
  let parent = record.parentTurnId;
  while (typeof parent === 'string' && clarifiedTurns.length < CLARIFICATION_CHAIN_MAX_TURNS && !visited.has(parent)) {
    visited.add(parent);
    const previous = await store.get<ClarificationRecord>('tool_executions', `clarification:${parent}`);
    const message = await store.get<UserMessage>('conversation_messages', parent);
    if (!previous || previous.name !== PENDING_CLARIFICATION_TOOL || previous.actorId !== actor.id || previous.sessionId !== actor.sessionId ||
      previous.conversationId !== conversationId || previous.turnId !== parent || previous.about !== record.about ||
      !assistants.some(a => a.turnId === parent) || !message || message.role !== 'user' || message.actorId !== actor.id ||
      message.sessionId !== actor.sessionId || message.conversationId !== conversationId || typeof message.text !== 'string') break;
    if (Buffer.byteLength(JSON.stringify([message.text, ...clarifiedTurns]), 'utf8') > CLARIFICATION_REQUEST_MAX_BYTES) break;
    clarifiedTurns.unshift(message.text);
    parent = previous.parentTurnId;
  }
  const missing = Array.isArray(record.missing) ? record.missing.filter((m): m is string => typeof m === 'string').slice(0, 4) : [];
  return { turnId: lastTurnId, about: typeof record.about === 'string' ? record.about : 'unknown', missing, clarifiedTurnText: clarified.text, clarifiedTurns };
}

/** Server selectors permitted only inside server-owned (demo/catalog) plans. */
export function bindServerSelectors(plan: TurnPlan, selectors: { latestOwnedDashboardId?: string; newestReviewedQueueId?: string; latestVerifiedApprovalId?: string }): TurnPlan {
  const walk = (value: unknown): unknown => {
    if (value === '@latest_owned_dashboard') return selectors.latestOwnedDashboardId ?? value;
    if (value === 'selector:newest_reviewed_queue') return selectors.newestReviewedQueueId ?? value;
    if (value === 'selector:latest_verified_approval') return selectors.latestVerifiedApprovalId ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
    return value;
  };
  return walk(plan) as TurnPlan;
}

/** StagedPorts for a store without router_proposals: reads find nothing, writes fail closed with a typed code. */
export function unavailableStagedPorts(): StagedPorts {
  const unavailable = (): never => { throw new DomainError(STAGED_UNAVAILABLE_CODE, 'Staged proposals are not available on this store', 409); };
  return { findPending: async () => unavailable(), create: async () => unavailable(), get: async () => undefined, save: async () => unavailable(), claim: async () => undefined };
}
