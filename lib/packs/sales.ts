import { z } from 'zod';
import { dashboardSpecSchema, metricIds, scopeSchema, type DepartmentPack } from '../contracts';
import {
  defineTool,
  demoTemplateDate,
  evidenceAnalysisResultSchema,
  pendingActionResultSchema
} from './shared';

const performanceInputSchema = z.object({
  ...scopeSchema.shape,
  metrics: z.array(z.enum(metricIds)).max(metricIds.length).optional()
}).strict();

const prepareDashboardInputSchema = z.object({ spec: dashboardSpecSchema }).strict();
const prepareDashboardResultSchema = z.object({
  pendingAction: pendingActionResultSchema.shape.pendingAction
}).strict();

const actionReferenceSchema = z.object({
  actionId: z.string().min(1).max(120),
  targetId: z.string().min(1).max(120)
}).strict();

const dashboardCreatedSchema = z.object({
  dashboardId: z.string().min(1),
  ownerId: z.string().min(1),
  title: z.string().min(1).max(120),
  scope: scopeSchema,
  createdAt: z.string().datetime({ offset: true }),
  status: z.literal('created')
}).strict();

const prepareShareInputSchema = z.object({
  dashboardId: z.string().min(1),
  recipientId: z.string().min(1)
}).strict();

const prepareShareResultSchema = pendingActionResultSchema;

const shareResultSchema = z.object({
  dashboardId: z.string().min(1),
  recipientId: z.string().min(1),
  status: z.literal('shared'),
  sharedAt: z.string().datetime({ offset: true })
}).strict();

export const salesPack: DepartmentPack = {
  id: 'sales',
  contractVersion: 1,
  version: '1.0.0',
  implementationRevision: 'sales-pack-v1',
  dependencies: [],
  title: 'Sales performance',
  entities: ['branches', 'sales_orders', 'sales_targets', 'dashboards', 'dashboard_shares'],
  adapterBindings: ['branches', 'sales_orders', 'sales_targets'],
  metrics: [
    {
      id: 'net_sales',
      calculatorId: 'sales.net_sales.v1',
      definition: 'Sum of paid order values. Refunded and cancelled order rows are excluded.',
      unit: 'THB',
      timezone: 'Asia/Bangkok',
      source: 'sales_orders',
      owner: 'sales',
      freshnessMinutes: 1440
    },
    {
      id: 'target',
      calculatorId: 'sales.target.v1',
      definition: 'Approved daily sales target for the branch and business date.',
      unit: 'THB',
      timezone: 'Asia/Bangkok',
      source: 'sales_targets',
      owner: 'sales',
      freshnessMinutes: 1440
    },
    {
      id: 'gap',
      calculatorId: 'sales.gap.v1',
      definition: 'Difference between net sales and the approved daily target.',
      unit: 'THB',
      timezone: 'Asia/Bangkok',
      source: 'sales_orders, sales_targets',
      owner: 'sales',
      freshnessMinutes: 1440
    },
    {
      id: 'achievement',
      calculatorId: 'sales.achievement.v1',
      definition: 'Net sales achievement as a percentage of target; unavailable when no target exists.',
      unit: 'percent',
      timezone: 'Asia/Bangkok',
      source: 'sales_orders, sales_targets',
      owner: 'sales',
      freshnessMinutes: 1440
    }
  ],
  tools: [
    defineTool(
      'sales.query_metrics',
      'Read sales, target, and achievement evidence for one region and business date; metrics may be limited to requested measures.',
      'sales.read',
      'read',
      performanceInputSchema,
      evidenceAnalysisResultSchema
    ),
    defineTool(
      'dashboard.prepare_create',
      'Validate and preview a dashboard spec for requester confirmation.',
      'dashboard.create',
      'prepare',
      prepareDashboardInputSchema,
      prepareDashboardResultSchema
    ),
    defineTool(
      'dashboard.create',
      'Create only the dashboard target from an approved pending action.',
      'dashboard.create',
      'execute',
      actionReferenceSchema,
      dashboardCreatedSchema
    ),
    defineTool(
      'dashboard.prepare_share',
      'Preview a scoped dashboard share for requester confirmation.',
      'dashboard.share',
      'prepare',
      prepareShareInputSchema,
      prepareShareResultSchema
    ),
    defineTool(
      'dashboard.share',
      'Share only the dashboard target from an approved pending action.',
      'dashboard.share',
      'execute',
      actionReferenceSchema,
      shareResultSchema
    ),
  ],
  permissionConstraints: ['sales.read', 'dashboard.create', 'dashboard.share'],
  approvalMode: 'requester_confirmation',
  templates: [
    {
      id: 'sales.branch-performance',
      title: 'East branch sales performance',
      spec: {
        title: 'East branch sales performance',
        description: 'Closed-day sales, target, gap, and achievement by East branch.',
        scope: { region: 'east', date: demoTemplateDate },
        widgets: [
          { type: 'metric', title: 'Net sales', metric: 'net_sales' },
          { type: 'metric', title: 'Target', metric: 'target' },
          { type: 'metric', title: 'Target gap', metric: 'gap' },
          { type: 'bar_chart', title: 'Sales vs target by branch', metric: 'net_sales', comparisonMetric: 'target', groupBy: 'branch' }
        ]
      }
    }
  ],
  evaluationCases: [
    'east-shortage-branch-sales-context',
    'east-payment-incident-is-not-refund-free-sales',
    'east-unexplained-poor-sales-requires-missing-evidence',
    'east-above-target-with-operations-incident'
  ]
};
