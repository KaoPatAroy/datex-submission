import { z } from 'zod';
import { idSchema, queryPlanSchema } from '../dynamic/plan/schemas';
import { presentationHintSchema } from '../dynamic/response/compose';
import { dashboardVisualizationPlanSchema } from '../visualization/dashboard-data';
import { ANIMATION_MODES, INTERACTION_IDS, VISUAL_PRIMITIVES } from '../visualization/contracts';
import { PRODUCT_CONCEPT_IDS, type ProductConceptId } from './product-model';

export const TURN_PLAN_VERSION = 1 as const;

/** Exact substring of a user message. The server only locates it (resolveSpan); it never interprets it. */
export const evidenceTextSchema = z.string().trim().min(1).max(200);
/** An id copied verbatim from the planner context (or '$step0' in step 1). */
export const contextIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:$-]+$/);

/**
 * user_quoted - the user said it; evidenceText REQUIRED and located in the message.
 * context_id  - value is id(s) copied from the planner context.
 * inherited   - value equals the prior accepted state / pending payload value.
 * default     - registry-declared server default (labeled in the answer).
 * generated   - AI-authored content (titles, descriptions); validated for length/charset/safety only.
 */
export const paramSourceSchema = z.enum(['user_quoted', 'context_id', 'inherited', 'default', 'generated']);
export type ParamSource = z.infer<typeof paramSourceSchema>;
export const PARAM_SOURCES = paramSourceSchema.options;
export const evidenceFromSchema = z.enum(['current', 'clarified_turn']);

export const paramValueSchema = z.union([
  z.string().max(500), z.number().finite(), z.boolean(),
  z.array(z.union([z.string().max(200), z.number().finite()])).max(20),
]);
export type ParamValue = z.infer<typeof paramValueSchema>;

/** Param envelope. `valueSchema`/`sources` narrow it for a concrete registry param. */
export function paramEnvelope<T extends z.ZodTypeAny>(valueSchema: T, sources: readonly ParamSource[] = PARAM_SOURCES) {
  return z.object({
    value: valueSchema,
    source: z.enum(sources as [ParamSource, ...ParamSource[]]),
    evidenceText: evidenceTextSchema.optional(),
    evidenceFrom: evidenceFromSchema.optional(),
  }).strict();
}
export const paramEnvelopeSchema = paramEnvelope(paramValueSchema);
export type ParamEnvelope = z.infer<typeof paramEnvelopeSchema>;

/** RESPONSE-001: optional arrangement of the grounded answer sections (kinds + style only; claim ids are assigned by the server). */
export const presentationSchema = presentationHintSchema;

export const queryStepSchema = z.object({
  kind: z.literal('query'),
  continuation: z.boolean(), // server binds parentState; the model never authors it
  plan: queryPlanSchema,
  presentation: presentationSchema.optional(),
}).strict();

export const hrQueryStepSchema = z.object({ kind: z.literal('hr_query'), plan: queryPlanSchema, presentation: presentationSchema.optional() }).strict();

export const actionStepSchema = z.object({
  kind: z.literal('action'),
  actionId: idSchema,
  params: z.record(z.string().min(1).max(40), paramEnvelopeSchema),
  /** dashboard.create only: AI visualization plan; every widget is validated against the catalog and bound to evidence. */
  visualization: dashboardVisualizationPlanSchema.nullable().optional(),
}).strict();

export const refineStepSchema = z.object({
  kind: z.literal('refine'),
  pendingActionId: contextIdSchema,
  operation: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('revise_dashboard'), title: paramEnvelopeSchema.optional(), removeWidgetIndexes: paramEnvelopeSchema.optional(),
      /** AI visualization plan bound to an accepted answer (`sourceStateId`; `$step0` in step 1): appended to, or replacing, the target's widgets. */
      visualization: dashboardVisualizationPlanSchema.nullable().optional(),
      visualizationMode: z.enum(['append', 'replace']).optional(),
      sourceStateId: contextIdSchema.nullable().optional(),
    }).strict(),
    z.object({ op: z.literal('cancel') }).strict(),
  ]),
}).strict();

export const ARTIFACT_TYPES = ['table', 'ranking', 'chart', 'executive_brief', 'csv_export'] as const;
export const artifactVisualSchema = z.object({
  primitiveId: z.enum(VISUAL_PRIMITIVES), xFieldId: idSchema, yFieldIds: z.array(idSchema).min(1).max(8),
  /** heatmap only: the second (row) dimension. */
  groupFieldId: idSchema.optional(),
  /** combo only: the measures drawn as lines (the rest of yFieldIds are bars). */
  lineFieldIds: z.array(idSchema).min(1).max(8).optional(),
  interactionIds: z.array(z.enum(INTERACTION_IDS)).min(1).max(INTERACTION_IDS.length),
  animation: z.enum(ANIMATION_MODES),
}).strict();
export const artifactStepSchema = z.object({
  kind: z.literal('artifact'),
  sourceStateId: contextIdSchema,
  artifactTypeId: z.enum(ARTIFACT_TYPES),
  operation: z.enum(['create', 'revise']),
  baseArtifactId: contextIdSchema.nullable(),
  title: paramEnvelopeSchema,
  outputFormat: z.enum(['preview', 'csv']),
  visual: artifactVisualSchema.nullable(),
}).strict();

export const clarifyAboutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query') }).strict(),
  z.object({ kind: z.literal('hr_query') }).strict(),
  z.object({ kind: z.literal('action'), actionId: idSchema }).strict(),
  z.object({ kind: z.literal('refine'), pendingActionId: contextIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal('artifact') }).strict(),
]);
export const clarifyReasonSchema = z.enum(['absent', 'ambiguous', 'conflicting', 'not_in_catalog', 'outside_authority', 'needs_target']);
export const clarifyStepSchema = z.object({
  kind: z.literal('clarify'),
  about: clarifyAboutSchema,
  missing: z.array(z.object({ slot: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.]+$/), reason: clarifyReasonSchema }).strict()).min(1).max(4),
  question: z.string().trim().min(1).max(300),
  choices: z.array(z.object({ id: contextIdSchema, label: z.string().trim().min(1).max(120) }).strict()).max(8),
}).strict();

export const CONVERSATION_TOPICS = ['greeting', 'capability', 'advice', 'acknowledgement', 'out_of_scope', 'product_help'] as const;
export const conversationStepSchema = z.object({
  kind: z.literal('conversation'),
  topic: z.enum(CONVERSATION_TOPICS),
  /**
   * G5: optional. product_help omits it (the server writes the explanation from PRODUCT_MODEL: long model prose there cost 10-30 s and was mostly
   * replaced by server copy); any other topic without prose renders the same server fallback as unsafe prose.
   */
  prose: z.string().trim().min(1).max(600).optional(),
  /**
   * product_help only: the PRODUCT_MODEL concept ids the explanation is about (omitted = a general introduction). Refined (not an
   * enum) so the planner JSON schema stays small; the ids are listed in PRODUCT_MODEL and canonicalized before this check.
   */
  concepts: z.array(z.string().refine((id): id is ProductConceptId => (PRODUCT_CONCEPT_IDS as readonly string[]).includes(id))).max(4).optional(),
}).strict();

/** POLICY-001: read registered policy documents by id (ids copied from the authorized POLICIES list; the server never matches text). */
export const policyReadStepSchema = z.object({ kind: z.literal('policy_read'), policyIds: z.array(contextIdSchema).min(1).max(3) }).strict();

/**
 * HR Director (Workflow V2): a registered read capability projected by the V2 runtime for this actor (WORKFLOW.reads). The
 * snapshot/request ids are copied from WORKFLOW.reviewedQueues; the server never searches by wording.
 */
export const WORKFLOW_READ_IDS = ['director_queue', 'director_start_dates', 'director_request_documents', 'director_approvals_today'] as const;
export const workflowReadStepSchema = z.object({
  kind: z.literal('workflow_read'), readId: z.enum(WORKFLOW_READ_IDS),
  snapshotId: contextIdSchema.nullable().optional(), requestId: contextIdSchema.nullable().optional(),
}).strict();

/**
 * RESOURCE-LOOKUP: find the actor's OWN older Dashboard / Result / Monitor by name when it is not in the bounded context window. `query` is a short
 * name fragment the planner chose (plain substring match over the owner's own titles, never an intent parser). The server answers with a bounded,
 * owner-scoped choice list (exact ids, current titles); the user's tap becomes a server-verified selection. Never combined with another step.
 */
export const RESOURCE_LOOKUP_KINDS = ['dashboard', 'result', 'monitor'] as const;
export const resourceLookupStepSchema = z.object({ kind: z.literal('resource_lookup'), resource: z.enum(RESOURCE_LOOKUP_KINDS), query: z.string().trim().min(1).max(80) }).strict();

export const turnStepSchema = z.discriminatedUnion('kind', [
  queryStepSchema, hrQueryStepSchema, actionStepSchema, refineStepSchema, artifactStepSchema, clarifyStepSchema, conversationStepSchema,
  policyReadStepSchema, workflowReadStepSchema, resourceLookupStepSchema,
]);
/** Optional AI-proposed next questions (plain Thai text). Output-safety validated server-side before anything is shown. */
/** Lenient on shape (a sloppy extra/long suggestion must not void the whole plan); the render safety gate keeps <=3 and <=100 chars. */
export const followUpsSchema = z.array(z.string().trim().min(1).max(300)).max(8);
export const turnPlanSchema = z.object({
  turnPlanVersion: z.literal(TURN_PLAN_VERSION),
  steps: z.array(turnStepSchema).min(1).max(2),
  followUps: followUpsSchema.optional(),
  /** Optional AI-authored short conversation title (first turn). Lenient shape; the server validates length and safety before persisting. */
  suggestedConversationTitle: z.string().trim().min(1).max(300).optional(),
}).strict();

export type TurnStep = z.infer<typeof turnStepSchema>;
export type TurnStepKind = TurnStep['kind'];
export type TurnPlan = z.infer<typeof turnPlanSchema>;
export type ActionStep = z.infer<typeof actionStepSchema>;
export type RefineStep = z.infer<typeof refineStepSchema>;
export type ArtifactStep = z.infer<typeof artifactStepSchema>;
export type ClarifyStep = z.infer<typeof clarifyStepSchema>;
export type ConversationStep = z.infer<typeof conversationStepSchema>;

/** Envelope: one step of any kind, or [query|hr_query, action|artifact]. Returns an error string or null. */
export function envelopeError(steps: readonly { kind: TurnStepKind }[]): string | null {
  if (steps.length === 1) return null;
  if (steps.length !== 2) return 'plan must have one or two steps';
  const [first, second] = steps;
  if (first.kind !== 'query' && first.kind !== 'hr_query') return 'step 0 of a two-step plan must be a query';
  if (second.kind !== 'action' && second.kind !== 'artifact' && second.kind !== 'refine') return 'step 1 of a two-step plan must be an action, refine or artifact';
  return null;
}
