import { z } from 'zod';
import { dashboardSpecSchema } from '../contracts';

const actionIdSchema = z.string().trim().min(1).max(160);
const payloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const removalIndexesSchema = z.array(z.number().int().min(0).max(11)).min(1).max(12)
  .refine(indexes => new Set(indexes).size === indexes.length, 'Removal indexes must be unique.');

export const dashboardRefinementCandidateSchema = z.object({
  id: actionIdSchema,
  payloadHash: payloadHashSchema,
  spec: dashboardSpecSchema,
}).strict();

export type DashboardRefinementCandidate = z.infer<typeof dashboardRefinementCandidateSchema>;

export const dashboardRefinementPatchSchema = z.object({
  title: dashboardSpecSchema.shape.title.optional(),
  widgetChange: z.object({
    operation: z.literal('remove'),
    indexes: removalIndexesSchema,
  }).strict().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, 'Refinement requires a change.');

export type DashboardRefinementPatch = z.infer<typeof dashboardRefinementPatchSchema>;

export const dashboardRefinementDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('revise'),
    baseActionId: actionIdSchema,
    basePayloadHash: payloadHashSchema,
    patch: dashboardRefinementPatchSchema,
  }).strict(),
  z.object({
    kind: z.literal('clarify'),
    reason: z.enum([
      'proposal_ambiguous',
      'widget_ambiguous',
      'participants_unspecified',
      'unsupported_change',
      'proposal_unavailable',
    ]),
  }).strict(),
  z.object({ kind: z.literal('continue') }).strict(),
]);

export type DashboardRefinementDecision = z.infer<typeof dashboardRefinementDecisionSchema>;
