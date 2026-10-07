import { z } from 'zod';
import type { DepartmentPack } from '../contracts';
import {
  actionReferenceSchema,
  badgeSchema,
  defineTool,
  employeeSchema,
  pendingActionSchema,
  sourceRefSchema,
  analysisSchema
} from './shared';

const employeeSearchInputSchema = z.object({
  employeeId: z.string().min(1).max(80)
}).strict();

const employeeSearchResultSchema = z.object({
  employee: employeeSchema.nullable(),
  /** The employee's badges, so the AI can emit canonical badge IDs without asking the user for them. */
  badges: z.array(z.object({ id: z.string().min(1), state: z.enum(['active', 'revoked']) }).strict()).max(20).optional(),
  sourceIds: z.array(z.string().min(1)).max(100),
  sources: z.array(sourceRefSchema).max(100),
  analysis: analysisSchema.optional()
}).strict().superRefine((result, context) => {
  const sourceIds = new Set(result.sourceIds);
  const sourceRefs = new Set(result.sources.map((source) => source.id));
  if (result.employee === null && (result.sourceIds.length > 0 || result.sources.length > 0)) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'A missing employee cannot carry evidence.' });
  }
  if (result.employee !== null && result.sourceIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['sourceIds'], message: 'A found employee requires source evidence.' });
  }
  if (result.sourceIds.some((id) => !sourceRefs.has(id)) || result.sources.some((source) => !sourceIds.has(source.id))) {
    context.addIssue({ code: 'custom', path: ['sourceIds'], message: 'Source IDs and returned sources must match.' });
  }
});

const prepareBadgeRevocationInputSchema = z.object({
  badgeId: z.string().min(1),
  employeeId: z.string().min(1),
  reason: z.string().trim().min(1).max(500)
}).strict();

const badgePendingActionSchema = pendingActionSchema.extend({
  payload: z.object({
    kind: z.literal('badge_revoke'),
    badgeId: z.string().min(1),
    employeeId: z.string().min(1),
    reason: z.string().min(1).max(500)
  }).strict()
});
const prepareBadgeRevocationResultSchema = z.object({ pendingAction: badgePendingActionSchema }).strict();

const executeBadgeRevocationResultSchema = z.object({
  badge: badgeSchema,
  status: z.literal('revoked')
}).strict();

const verifyBadgeRevocationInputSchema = z.object({
  ...actionReferenceSchema.shape,
  badgeId: z.string().min(1),
  employeeId: z.string().min(1)
}).strict();

const verifyBadgeRevocationResultSchema = z.object({
  verified: z.boolean(),
  badgeId: z.string().min(1),
  employeeId: z.string().min(1),
  state: z.enum(['active', 'revoked']).nullable(),
  version: z.number().int().positive().nullable(),
  detail: z.string().min(1).max(500),
  checkedAt: z.string().datetime({ offset: true })
}).strict();

export const hrPack: DepartmentPack = {
  id: 'hr',
  contractVersion: 1,
  version: '1.0.0',
  implementationRevision: 'hr-pack-v1',
  dependencies: [],
  title: 'People and badge administration',
  entities: ['employees', 'mock_badges'],
  adapterBindings: ['employees', 'mock_badges'],
  metrics: [],
  tools: [
    defineTool(
      'hr.find_employee',
      'Find synthetic employee records by ID, name query, or branch.',
      'hr.read',
      'read',
      employeeSearchInputSchema,
      employeeSearchResultSchema
    ),
    defineTool(
      'badge.prepare_revoke',
      'Check the employee and badge match, then preview a revocation for confirmation.',
      'badge.revoke',
      'prepare',
      prepareBadgeRevocationInputSchema,
      prepareBadgeRevocationResultSchema
    ),
    defineTool(
      'badge.execute_revoke',
      'Revoke only the badge target from an approved pending action.',
      'badge.revoke',
      'execute',
      actionReferenceSchema,
      executeBadgeRevocationResultSchema
    ),
    defineTool(
      'badge.verify',
      'Independently read back the badge state after revocation.',
      'badge.revoke',
      'verify',
      verifyBadgeRevocationInputSchema,
      verifyBadgeRevocationResultSchema
    )
  ],
  permissionConstraints: ['hr.read', 'badge.revoke'],
  approvalMode: 'requester_confirmation',
  templates: [],
  evaluationCases: [
    'employee-search-is-scoped-and-bounded',
    'badge-lookup-confirms-employee-owner',
    'badge-revocation-requires-confirmation-and-readback'
  ]
};
