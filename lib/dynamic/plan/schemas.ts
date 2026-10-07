import { z } from 'zod';
import { businessDateSchema } from '../../contracts';

export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/);
export const refSchema = z.object({ id: idSchema, version: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Ref = z.infer<typeof refSchema>;
export const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(200) }).strict()
  .refine(span => span.end > span.start, 'Span must be non-empty.');
export type Span = z.infer<typeof spanSchema>;
const confidence = z.number().min(0).max(1);
export const interpretationSchema = z.object({ value: idSchema, source: z.enum(['explicit', 'default', 'inherited']), sourceText: spanSchema.nullable(), confidence }).strict();
export const timeSchema = z.object({ fieldId: idSchema, timezone: z.string().min(1).max(50),
  // generated: model-resolved dates whose evidence could not be located; accepted only inside the served window and always shown.
  source: z.enum(['explicit', 'default', 'inherited', 'generated']), dates: z.array(businessDateSchema).min(1).max(62),
  evidenceText: z.string().min(1).max(200).optional() }).strict();
export type PlanTime = z.infer<typeof timeSchema>;
const scalar = z.union([z.string().min(1).max(200), z.number().finite()]);
export const queryPlanSchema = z.object({
  planVersion: z.literal(1), planId: idSchema, datasetId: idSchema,
  measures: z.array(z.object({ fieldId: idSchema, aggregation: idSchema, interpretation: interpretationSchema }).strict()).min(1).max(16),
  dimensions: z.array(z.object({ fieldId: idSchema, interpretation: interpretationSchema }).strict()).max(8),
  filters: z.array(z.object({ fieldId: idSchema, op: z.enum(['eq', 'in', 'gte', 'gt', 'lte', 'lt', 'between']),
    value: z.union([scalar, z.array(scalar).min(1).max(2000), z.null()]), source: z.enum(['explicit', 'inherited']).optional(),
    evidenceText: z.string().min(1).max(200).optional(), sourceText: spanSchema.nullable().default(null), confidence }).strict()).max(16),
  scope: z.object({ kind: z.literal('all'), sourceText: spanSchema, confidence }).strict().nullable(),
  time: timeSchema.nullable(), grain: z.array(idSchema).min(1).max(8), aggregation: z.enum(['rows', 'registered']),
  multiDateGrain: z.object({ mode: z.enum(['sum', 'avg', 'latest', 'max']), fieldId: idSchema }).strict().nullable(),
  group: z.object({ fieldIds: z.array(idSchema).max(8) }).strict(),
  compare: z.object({ kind: z.enum(['vs_prior_day', 'vs_target', 'vs_prior_period']), period: z.enum(['day', 'week', 'month']).nullable(),
    baseline: timeSchema.nullable(), sourceText: spanSchema, confidence }).strict().nullable(),
  sort: z.array(z.object({ fieldId: idSchema, direction: z.enum(['asc', 'desc']) }).strict()).max(3),
  topN: z.object({ count: z.number().int().positive().max(100), direction: z.enum(['highest', 'lowest']), completeScopeRequired: z.literal(true) }).strict().nullable(),
  completeness: z.object({ expectation: z.enum(['requested_scope', 'complete_authorized_population']), requireFullPopulation: z.boolean(),
    requiredSourceIds: z.array(idSchema).max(8), minimumCoverage: z.number().min(0).max(1) }).strict(),
  clarificationNeeds: z.array(z.object({ slotId: idSchema, question: z.string().min(1).max(300),
    choices: z.array(z.object({ id: idSchema, label: z.string().min(1).max(200) }).strict()).max(20) }).strict()).max(8),
  confidence, requestedUses: z.array(z.enum(['answer', 'explore', 'artifact', 'action', 'monitor'])).min(1).max(5),
  /**
   * table_rows datasets only. `joins` names registered join targets (the join KEYS are declared by the catalog, never by the plan;
   * joined fields are written `<datasetId>.<fieldId>`). `page` is a bounded page request; `cursor` is an opaque server value.
   */
  joins: z.array(z.object({ datasetId: idSchema }).strict()).max(2).optional(),
  page: z.object({ limit: z.number().int().min(1).max(100), cursor: z.string().min(1).max(300).nullable() }).strict().optional(),
}).strict();
export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const intentPlanSchema = queryPlanSchema.extend({ intentKind: z.enum(['query', 'follow_up']), parentState: refSchema.nullable() }).strict();
export const plannerOutputSchema = z.union([intentPlanSchema, z.object({ intentKind: z.literal('not_query') }).strict()]);
export type IntentPlan = z.infer<typeof intentPlanSchema>;
