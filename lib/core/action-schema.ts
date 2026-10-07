import {z} from 'zod';
import {dashboardSpecSchema,scopeSchema,ticketPlanSchema} from '../contracts';
const text = z.string().min(1).max(1000);
export const actionPayloadSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('dashboard_create'),spec:dashboardSpecSchema}).strict(),
  z.object({kind:z.literal('dashboard_share'),dashboardId:text,recipientId:text}).strict(),
  z.object({kind:z.literal('ticket_create'),scope:scopeSchema,targets:z.array(z.object({branchId:text,assigneeId:text,title:z.string().min(1).max(160),reason:z.string().min(1).max(1000),sourceIds:z.array(text).max(30),unansweredQuestion:z.string().min(1).max(500)}).strict()).min(1).max(12),plan:ticketPlanSchema.optional()}).strict(),
  z.object({kind:z.literal('badge_revoke'),badgeId:text,employeeId:text,reason:z.string().min(1).max(500)}).strict(),
  z.object({kind:z.literal('demo_update'),scenario:z.enum(['stock_recovered','payment_resolved','baseline'])}).strict()
]);
