import { z } from 'zod';
import { dashboardSpecSchema, scopeSchema, ticketPlanSchema, type ToolDescriptor } from '../contracts';

export const demoTemplateDate = '2026-10-01';

export const branchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.string().min(1)
}).strict();

export const salesOrderSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  date: scopeSchema.shape.date,
  amountSatang: z.number().int().nonnegative(),
  status: z.enum(['paid', 'refunded', 'cancelled']),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const salesTargetSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  date: scopeSchema.shape.date,
  amountSatang: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const inventorySchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  productId: z.string().min(1),
  date: scopeSchema.shape.date,
  onHand: z.number().int().nonnegative(),
  minimum: z.number().int().nonnegative(),
  observedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const incidentSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  date: scopeSchema.shape.date,
  title: z.string().min(1),
  kind: z.enum(['payment', 'stock', 'operations']),
  status: z.enum(['open', 'resolved']),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const staffingSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  date: scopeSchema.shape.date,
  planned: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
  observedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const employeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  branchId: z.string().min(1).nullable(),
  active: z.boolean()
}).strict();

export const badgeSchema = z.object({
  id: z.string().min(1),
  employeeId: z.string().min(1),
  state: z.enum(['active', 'revoked']),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  operationKey: z.string().min(1).optional()
}).strict();

export const ticketSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  assigneeId: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  unansweredQuestion: z.string().min(1).max(4000),
  sourceIds: z.array(z.string().min(1)).max(20),
  status: z.literal('open'),
  operationKey: z.string().min(1),
  createdAt: z.string().datetime({ offset: true })
}).strict();

export const branchMetricSchema = z.object({
  branchId: z.string().min(1),
  branchName: z.string().min(1),
  region: z.string().min(1),
  netSales: z.number().finite(),
  target: z.number().finite().nonnegative(),
  gap: z.number().finite(),
  achievement: z.number().finite().nonnegative().nullable(),
  stockIssues: z.number().int().nonnegative(),
  incidentCount: z.number().int().nonnegative(),
  staffingPlanned: z.number().int().nonnegative(),
  staffingActual: z.number().int().nonnegative(),
  incidents: z.array(incidentSchema).max(120),
  sourceIds: z.array(z.string().min(1)).max(100)
}).strict();

export const sourceRefSchema = z.object({
  id: z.string().min(1),
  system: z.string().min(1),
  observedAt: z.union([z.string().datetime({ offset: true }), z.literal('')]),
  retrievedAt: z.string().datetime({ offset: true }),
  freshness: z.enum(['fresh', 'stale', 'misaligned', 'missing']),
  detail: z.string().min(1).max(500)
}).strict().superRefine((source, context) => {
  if (source.observedAt === '' && source.freshness !== 'missing') {
    context.addIssue({ code: 'custom', path: ['observedAt'], message: 'An empty observation time requires missing freshness.' });
  }
});

export const evidenceSchema = z.object({
  scope: scopeSchema,
  asOf: z.string().datetime({ offset: true }),
  version: z.string().min(1),
  branches: z.array(branchMetricSchema).max(12),
  totals: z.object({
    netSales: z.number().finite(),
    target: z.number().finite().nonnegative(),
    gap: z.number().finite(),
    achievement: z.number().finite().nonnegative().nullable()
  }).strict(),
  sources: z.array(sourceRefSchema).max(100),
  warnings: z.array(z.string().max(500)).max(50)
}).strict();

const claimSchema = z.object({
  text: z.string().min(1).max(1_000),
  sourceIds: z.array(z.string().min(1)).max(100)
}).strict();

export const analysisSchema = z.object({
  facts: z.array(claimSchema).max(100),
  relationships: z.array(claimSchema).max(100),
  hypotheses: z.array(claimSchema).max(100),
  missingEvidence: z.array(claimSchema).max(100),
  generatedAt: z.string().datetime({ offset: true }),
  evidenceVersion: z.string().min(1)
}).strict();

export const evidenceAnalysisResultSchema = z.object({
  evidence: evidenceSchema,
  analysis: analysisSchema
}).strict();

export const actionTargetSchema = z.object({
  branchId: z.string().min(1),
  assigneeId: z.string().min(1),
  title: z.string().min(1).max(120),
  reason: z.string().min(1).max(500),
  sourceIds: z.array(z.string().min(1)).max(20),
  unansweredQuestion: z.string().min(1).max(500)
}).strict();

export const actionReferenceSchema = z.object({
  actionId: z.string().min(1).max(120),
  targetId: z.string().min(1).max(120)
}).strict();

const actionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dashboard_create'), spec: dashboardSpecSchema }).strict(),
  z.object({ kind: z.literal('dashboard_share'), dashboardId: z.string().min(1), recipientId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('ticket_create'), scope: scopeSchema, targets: z.array(actionTargetSchema).min(1).max(20), plan: ticketPlanSchema.optional() }).strict(),
  z.object({ kind: z.literal('badge_revoke'), badgeId: z.string().min(1), employeeId: z.string().min(1), reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('demo_update'), scenario: z.enum(['stock_recovered', 'payment_resolved', 'baseline']) }).strict()
]);

export const pendingActionSchema = z.object({
  id: z.string().min(1),
  actorId: z.string().min(1),
  sessionId: z.string().min(1),
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  mode: z.enum(['live_ai', 'scripted_demo']),
  modeRevision: z.number().int().nonnegative(),
  payload: actionPayloadSchema,
  payloadHash: z.string().min(1),
  receiptAccess: z.object({readPermissions:z.array(z.string().min(1).max(100)).min(1).max(20),regions:z.array(z.string().min(1).max(100)).max(100)}).strict().optional(),
  releaseRevision: z.string().min(1).max(200).optional(),
  actionContractVersion:z.literal(1).optional(),
  approvalScope:scopeSchema.optional(),
  approvalDisplay:z.object({artifactTitle:z.string().min(1).max(200).optional(),branches:z.array(z.object({id:z.string().min(1),name:z.string().min(1)}).strict()).max(30).optional(),badge:z.object({employeeId:employeeSchema.shape.id,employeeName:employeeSchema.shape.name,employeeBranchId:employeeSchema.shape.branchId,badgeId:badgeSchema.shape.id,state:badgeSchema.shape.state,version:badgeSchema.shape.version,updatedAt:badgeSchema.shape.updatedAt}).strict().optional()}).strict().optional(),
  evidenceVersion: z.string().min(1).nullable(),
  packs: z.array(z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    schemaDigest: z.string().min(1),
    implementationRevision: z.string().min(1)
  }).strict()).max(20),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(['pending', 'claimed', 'completed', 'stale']),
  preview: z.string().min(1).max(2_000)
}).strict();

export const pendingActionResultSchema = z.object({ pendingAction: pendingActionSchema }).strict();

export function defineTool(
  name: string,
  description: string,
  permission: string,
  audit: ToolDescriptor['audit'],
  inputSchema: z.ZodType,
  resultSchema: z.ZodType,
  timeoutMs = 5_000
): ToolDescriptor {
  return { name, description, permission, audit, inputSchema, resultSchema, timeoutMs };
}
