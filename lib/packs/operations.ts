import { z } from 'zod';
import { scopeSchema, ticketPlanSchema, type DepartmentPack } from '../contracts';
import {
  actionReferenceSchema,
  defineTool,
  demoTemplateDate,
  evidenceAnalysisResultSchema,
  pendingActionResultSchema,
  ticketSchema
} from './shared';

const calendarDateSchema = scopeSchema.shape.date;

const inventoryInputSchema = z.object({
  region: z.string().min(1).max(40),
  date: calendarDateSchema,
  branchIds: z.array(z.string().min(1)).max(12).optional(),
  productIds: z.array(z.string().min(1)).max(40).optional(),
  belowMinimumOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200)
}).strict();

const staffingInputSchema = z.object({ ...scopeSchema.shape }).strict();

const incidentInputSchema = z.object({
  ...scopeSchema.shape,
  status: z.enum(['open', 'resolved']).optional(),
  kinds: z.array(z.enum(['payment', 'stock', 'operations'])).max(3).optional(),
  limit: z.number().int().min(1).max(120).default(100)
}).strict();

const prepareTicketInputSchema = z.object({
  scope: scopeSchema,
  branchIds: z.array(z.string().min(1)).max(12).optional(),
  plan: ticketPlanSchema.omit({ coveredBranchIds: true }).optional()
}).strict();

const executeTicketResultSchema = z.object({
  ticket: ticketSchema,
  status: z.literal('created')
}).strict();

const verifyTicketInputSchema = z.object({
  ...actionReferenceSchema.shape,
  ticketId: z.string().min(1)
}).strict();

const verifyTicketResultSchema = z.object({
  verified: z.boolean(),
  ticket: ticketSchema.nullable(),
  detail: z.string().min(1).max(500),
  checkedAt: z.string().datetime({ offset: true })
}).strict();

const demoScenarioSchema = z.enum(['stock_recovered', 'payment_resolved', 'baseline']);
const demoUpdateExecuteResultSchema = z.object({
  scenario: demoScenarioSchema,
  updatedRows: z.number().int().nonnegative().max(500),
  detail: z.string().min(1).max(500)
}).strict();

export const operationsPack: DepartmentPack = {
  id: 'operations',
  contractVersion: 1,
  version: '1.0.0',
  implementationRevision: 'operations-pack-v1',
  dependencies: [],
  title: 'Branch operations',
  entities: ['branches', 'inventory_snapshots', 'incidents', 'staffing_summaries', 'mock_tickets', 'employees'],
  adapterBindings: ['branches', 'inventory_snapshots', 'incidents', 'staffing_summaries', 'mock_tickets', 'employees'],
  metrics: [
    {
      id: 'stock_issues',
      calculatorId: 'operations.stock_issues.v1',
      definition: 'Count of branch-product snapshots below the recorded minimum quantity.',
      unit: 'branch_product_rows',
      timezone: 'Asia/Bangkok',
      source: 'inventory_snapshots',
      owner: 'operations',
      freshnessMinutes: 1440
    },
    {
      id: 'incident_count',
      calculatorId: 'operations.incident_count.v1',
      definition: 'Count of incidents recorded for the branch and business date.',
      unit: 'incidents',
      timezone: 'Asia/Bangkok',
      source: 'incidents',
      owner: 'operations',
      freshnessMinutes: 1440
    },
    {
      id: 'staffing_actual',
      calculatorId: 'operations.staffing_actual.v1',
      definition: 'Observed staffed headcount for the branch and business date.',
      unit: 'people',
      timezone: 'Asia/Bangkok',
      source: 'staffing_summaries',
      owner: 'operations',
      freshnessMinutes: 1440
    },
    {
      id: 'staffing_planned',
      calculatorId: 'operations.staffing_planned.v1',
      definition: 'Planned staffed headcount for the branch and business date.',
      unit: 'people',
      timezone: 'Asia/Bangkok',
      source: 'staffing_summaries',
      owner: 'operations',
      freshnessMinutes: 1440
    }
  ],
  tools: [
    defineTool(
      'operations.query_inventory',
      'Read branch-product stock snapshots for a region and business date.',
      'operations.read',
      'read',
      inventoryInputSchema,
      evidenceAnalysisResultSchema
    ),
    defineTool(
      'staffing.get_summary',
      'Read planned and observed branch staffing for a business date.',
      'operations.read',
      'read',
      staffingInputSchema,
      evidenceAnalysisResultSchema
    ),
    defineTool(
      'incidents.search',
      'Read a bounded incident list in the requested region and business date.',
      'operations.read',
      'read',
      incidentInputSchema,
      evidenceAnalysisResultSchema
    ),
    defineTool(
      'ticket.prepare_create',
      'Preview system-selected ticket targets in the requested scope for requester confirmation.',
      'ticket.create',
      'prepare',
      prepareTicketInputSchema,
      pendingActionResultSchema
    ),
    defineTool(
      'ticket.execute_create',
      'Create only the ticket target from an approved pending action.',
      'ticket.create',
      'execute',
      actionReferenceSchema,
      executeTicketResultSchema
    ),
    defineTool(
      'ticket.verify',
      'Independently read back a ticket after creation.',
      'ticket.create',
      'verify',
      verifyTicketInputSchema,
      verifyTicketResultSchema
    ),
    defineTool(
      'demo.update',
      'Apply only an approved scripted demo scenario change through the internal action API.',
      'demo.update',
      'execute',
      actionReferenceSchema,
      demoUpdateExecuteResultSchema
    )
  ],
  permissionConstraints: ['operations.read', 'ticket.create', 'demo.update'],
  approvalMode: 'requester_confirmation',
  templates: [
    {
      id: 'operations.daily-readiness',
      title: 'East daily operations readiness',
      spec: {
        title: 'East daily operations readiness',
        description: 'Closed-day stock, staffing, and open incident review for East branches.',
        scope: { region: 'east', date: demoTemplateDate },
        widgets: [
          { type: 'metric', title: 'Stock issues', metric: 'stock_issues' },
          { type: 'table', title: 'Staffing coverage', dataset: 'staffing' },
          { type: 'incident_list', title: 'Open incidents', dataset: 'open_incidents' }
        ]
      }
    }
  ],
  evaluationCases: [
    'east-shortage-inventory-below-minimum',
    'east-payment-incident-has-bounded-window',
    'east-poor-sales-has-no-closed-day-incident',
    'east-above-target-incident-is-still-visible',
    'ticket-create-requires-confirmation-and-readback',
    'demo-update-is-executive-only-and-confirmed'
  ]
};
