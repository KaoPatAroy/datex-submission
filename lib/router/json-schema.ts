import { z } from 'zod';
import { dashboardVisualizationPlanSchema } from '../visualization/dashboard-data';
import { actionParamsSchema, type ActionDefinition } from './action-registry';
import {
  artifactStepSchema, clarifyStepSchema, conversationStepSchema, hrQueryStepSchema, policyReadStepSchema, queryStepSchema, refineStepSchema,
  TURN_PLAN_VERSION, followUpsSchema, resourceLookupStepSchema, workflowReadStepSchema, type TurnStepKind,
} from './turn-plan';

export const PLANNER_JSON_SCHEMA_MAX_BYTES = 18 * 1024;

export interface PlannerSchemaOptions {
  /** Actions usable by the actor (registry.availableFor). Empty => no action step in the schema. */
  actions: readonly ActionDefinition[];
  /** Step kinds enabled for this actor/turn. Defaults to everything the actions/flags allow. */
  kinds?: readonly TurnStepKind[];
  /** Size fallback of the PROVIDER schema only: every action except dashboard.create shares one generic `params` object (the server validator stays strict and typed). */
  genericActionParams?: boolean;
}

/** Structured-output zod schema narrowed per actor: typed action params, only usable action ids. */
export function plannerTurnPlanSchema({ actions, kinds, genericActionParams }: PlannerSchemaOptions) {
  const enabled = new Set<TurnStepKind>(kinds ?? ['query', 'hr_query', 'action', 'refine', 'artifact', 'clarify', 'conversation']);
  const options: z.ZodType[] = [];
  if (enabled.has('query')) options.push(queryStepSchema);
  if (enabled.has('hr_query')) options.push(hrQueryStepSchema);
  if (enabled.has('action') && actions.length) {
    const typed = genericActionParams ? actions.filter(definition => definition.actionId === 'dashboard.create') : actions;
    const generic = genericActionParams ? actions.filter(definition => definition.actionId !== 'dashboard.create') : [];
    options.push(...typed.map(definition => z.object({
      kind: z.literal('action'), actionId: z.literal(definition.actionId), params: actionParamsSchema(definition),
      ...(definition.actionId === 'dashboard.create' ? { visualization: dashboardVisualizationPlanSchema.nullable().optional() } : {}),
    }).strict()));
    if (generic.length) options.push(z.object({ kind: z.literal('action'), actionId: z.enum(generic.map(d => d.actionId) as [string, ...string[]]), params: z.record(z.string(), z.unknown()) }).strict());
  }
  if (enabled.has('refine')) options.push(refineStepSchema);
  if (enabled.has('artifact')) options.push(artifactStepSchema);
  if (enabled.has('clarify')) options.push(clarifyStepSchema);
  if (enabled.has('conversation')) options.push(conversationStepSchema);
  if (enabled.has('policy_read')) options.push(policyReadStepSchema);
  if (enabled.has('workflow_read')) options.push(workflowReadStepSchema);
  if (enabled.has('resource_lookup')) options.push(resourceLookupStepSchema);
  return z.object({
    turnPlanVersion: z.literal(TURN_PLAN_VERSION),
    steps: z.array(z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]])).min(1).max(2),
    followUps: followUpsSchema.optional(),
    suggestedConversationTitle: z.string().trim().min(1).max(300).optional(),
  }).strict();
}

const SERVER_ENFORCED = new Set(['$schema', 'additionalProperties', 'maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum', 'exclusiveMinimum', 'pattern']);
/** Drops constraints the server re-enforces on parse (strictness, bounds, patterns) so the schema stays small for the planner. */
function compact(node: unknown, inProperties = false): unknown {
  if (Array.isArray(node)) return node.map(child => compact(child));
  if (!node || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!inProperties && SERVER_ENFORCED.has(key)) continue;
    if (!inProperties && key === 'type' && ('const' in record || 'enum' in record)) continue;
    out[key] = compact(child, key === 'properties' || key === 'definitions');
  }
  return out;
}

/** Draft-07 JSON schema for the planner's structured output. Refinements and bounds are enforced server-side after parse. */
export function plannerJsonSchema(options: PlannerSchemaOptions): Record<string, unknown> {
  const render = (opts: PlannerSchemaOptions) => inlineSmallRefs(compact(z.toJSONSchema(plannerTurnPlanSchema(opts), { target: 'draft-7', reused: 'ref', unrepresentable: 'any' })) as Record<string, unknown>);
  const full = render(options);
  // L7: over the provider budget -> collapse the per-action typed params into one generic object (REGISTERED_ACTIONS still lists every param).
  return !options.genericActionParams && jsonSchemaBytes(full) > PLANNER_JSON_SCHEMA_MAX_BYTES && options.actions.length > 1 ? render({ ...options, genericActionParams: true }) : full;
}

/** The planner schema must fit the provider's structured-output budget; callers refuse (fail closed) BEFORE any provider call otherwise. */
export const plannerSchemaWithinBudget = (schema: unknown): boolean => jsonSchemaBytes(schema) <= PLANNER_JSON_SCHEMA_MAX_BYTES;

/** Inline tiny shared definitions and unwrap single allOf so trivial leaves do not cost a $ref each. */
function inlineSmallRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = (schema.definitions ?? {}) as Record<string, unknown>;
  const small = new Map(Object.entries(definitions).filter(([, value]) => JSON.stringify(value).length < 60));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    const ref = typeof record.$ref === 'string' ? record.$ref.replace('#/definitions/', '') : null;
    if (ref && small.has(ref)) return small.get(ref);
    if (Array.isArray(record.allOf) && record.allOf.length === 1 && Object.keys(record).length === 1) return walk(record.allOf[0]);
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child)]));
  };
  const out = walk(schema) as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries((out.definitions ?? {}) as Record<string, unknown>).filter(([key]) => !small.has(key)));
  if (Object.keys(kept).length) out.definitions = kept; else delete out.definitions;
  return out;
}
export const jsonSchemaBytes = (schema: unknown): number => Buffer.byteLength(JSON.stringify(schema));
