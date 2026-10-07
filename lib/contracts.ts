import { z } from 'zod';
import type { NarrativePlan } from './ai/fact-packet';
import type { ArtifactRendererSpec } from './visualization/contracts';
import type { DashboardRefinementCandidate, DashboardRefinementDecision } from './core/dashboard-refinement-contracts';

export type Role = 'executive' | 'east_manager' | 'hr_admin' | 'hr_director';
export type Mode = 'live_ai' | 'scripted_demo';
export const turnFailureReasonSchema = z.enum(['turn_failed', 'turn_cancelled']);
export type TurnFailureReason = z.infer<typeof turnFailureReasonSchema>;
export interface Profile { id: string; name: string; role: Role; active: boolean; permissions: string[]; regions: string[] }
export const profileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), role: z.enum(['executive','east_manager','hr_admin','hr_director']),
  active: z.boolean(), permissions: z.array(z.string().min(1)), regions: z.array(z.string().min(1)),
});
export interface Actor extends Profile { sessionId: string; mode: Mode; modeRevision: number }
export interface Branch { id: string; name: string; region: string }
export interface Product { id: string; name: string; category: string }
export interface SalesOrder { id: string; branchId: string; date: string; amountSatang: number; status: 'paid' | 'refunded' | 'cancelled'; updatedAt: string }
export interface SalesTarget { id: string; branchId: string; date: string; amountSatang: number; updatedAt: string }
export interface Inventory { id: string; branchId: string; productId: string; date: string; onHand: number; minimum: number; observedAt: string; updatedAt: string }
export interface Incident { id: string; branchId: string; date: string; title: string; kind: 'payment' | 'stock' | 'operations'; status: 'open' | 'resolved'; startedAt: string; endedAt: string | null; updatedAt: string }
export interface Staffing { id: string; branchId: string; date: string; planned: number; actual: number; observedAt: string; updatedAt: string }
export interface Employee { id: string; name: string; branchId: string | null; active: boolean }
export interface Badge { id: string; employeeId: string; state: 'active' | 'revoked'; version: number; updatedAt: string; operationKey?: string }
export interface PolicyDocument { id: string; title: string; version: string; text: string; updatedAt: string }
export type StoredRow = { id: string; [key: string]: unknown };
export const tables = ['profiles','branches','products','sales_orders','sales_targets','inventory_snapshots','incidents','staffing_summaries','employees','policy_documents','sessions','conversations','conversation_messages','tool_executions','dashboards','dashboard_shares','pending_actions','action_executions','audit_events','mock_tickets','mock_badges','mock_messages','rate_limits','router_proposals'] as const;
export type Table = typeof tables[number];
export type RowFilter = Record<string,string|string[]>;
/** Optional read bound pushed into the store (a store that ignores it is still checked by the caller's post-read budget). */
export interface ReadOptions { limit?: number }
export interface Reader { list<T>(table: Table, filters?:RowFilter, options?: ReadOptions): Promise<T[]>; get<T>(table: Table, id: string): Promise<T | undefined> }
export interface Transaction extends Reader { put<T extends { id: string }>(table: Table, row: T): Promise<void>; remove(table: Table, id: string): Promise<void> }
export interface Store extends Reader { transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>; adapter: 'sqlite' | 'supabase'; close?(): void; /** Pure reads only; the callback may be replayed after a revision change. */ readSnapshot?<T>(work: () => Promise<T>): Promise<T> }
export interface SeedData { profiles: Profile[]; branches: Branch[]; products: Product[]; sales_orders: SalesOrder[]; sales_targets: SalesTarget[]; inventory_snapshots: Inventory[]; incidents: Incident[]; staffing_summaries: Staffing[]; employees: Employee[]; policy_documents: PolicyDocument[]; mock_badges: Badge[]; mock_tickets: Ticket[] }

export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
export const scopeSchema = z.object({ region: z.string().min(1).max(40), date: businessDateSchema, branchIds: z.array(z.string()).max(12).optional() }).strict();
/** ACTIONPLAN-001: schema-validated flexible fields of a ticket plan (carried inside the ticket_create payload and the stored ticket JSON; no new table). */
export const ticketPlanSchema = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']), dueDate: businessDateSchema.nullable(), grouping: z.enum(['single', 'per_branch']),
  checklist: z.array(z.string().trim().min(1).max(120)).max(8), note: z.string().trim().max(300).nullable(),
  /** grouping=single over several branches: the one ticket is anchored to the first target and names every covered branch here. */
  coveredBranchIds: z.array(z.string().min(1).max(100)).min(2).max(12).optional()
}).strict();
export type TicketPlan = z.infer<typeof ticketPlanSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Freshness = 'fresh' | 'stale' | 'misaligned' | 'missing';
export interface SourceRef { id: string; system: string; observedAt: string; retrievedAt: string; freshness: Freshness; detail: string }
/** Monetary metric values are THB, already converted from integer amountSatang. Achievement is percentage points. */
export interface BranchMetric { branchId: string; branchName: string; region: string; netSales: number; target: number; gap: number; achievement: number | null; stockIssues: number; incidentCount: number; staffingPlanned: number; staffingActual: number; incidents: Incident[]; sourceIds: string[] }
export interface Evidence { scope: Scope; asOf: string; version: string; branches: BranchMetric[]; totals: { netSales: number; target: number; gap: number; achievement: number | null }; sources: SourceRef[]; warnings: string[] }
export interface Claim { text: string; sourceIds: string[] }
export interface Analysis { facts: Claim[]; relationships: Claim[]; hypotheses: Claim[]; missingEvidence: Claim[]; generatedAt: string; evidenceVersion: string }
export const metricIds = ['net_sales','target','gap','achievement','stock_issues','incident_count','staffing_actual','staffing_planned'] as const;
/** Dashboard widget families: the legacy four plus every registered chart family. Map and Sankey are intentionally absent (fail closed). */
export const VIZ_WIDGET_KINDS = ['kpi', 'bar', 'line', 'table', 'area', 'scatter', 'heatmap', 'pie', 'donut', 'treemap', 'combo'] as const;
export type VizWidgetKind = (typeof VIZ_WIDGET_KINDS)[number];
// Mirrors lib/visualization/contracts INTERACTION_IDS / ANIMATION_MODES (a test keeps them equal; this file must not import the visualization layer).
const VIZ_INTERACTION_IDS = ['inspect_data', 'inspect_sources', 'select_point', 'tooltip', 'legend_toggle', 'cross_filter', 'drilldown', 'zoom_brush', 'reset'] as const;
const VIZ_ANIMATION_MODES = ['none', 'fade', 'interpolate', 'reorder'] as const;
/** Evidence-bound dynamic widget (AI-proposed VisualizationPlan, server-validated). Re-queried on open under the viewer's authority. */
export const vizWidgetSchema = z.object({
  type: z.literal('viz'), title: z.string().min(1).max(100), kind: z.enum(VIZ_WIDGET_KINDS),
  measure: z.string().min(1).max(100), dimension: z.string().min(1).max(100).optional(),
  sort: z.enum(['asc', 'desc']).optional(), topN: z.number().int().min(1).max(50).optional(),
  // Declarative family configuration (no code, markup or options): extra y measures, heatmap row dimension, combo line measures, registered interaction/animation ids.
  measures: z.array(z.string().min(1).max(100)).min(1).max(7).optional(), groupDimension: z.string().min(1).max(100).optional(),
  lineMeasures: z.array(z.string().min(1).max(100)).min(1).max(7).optional(),
  interactions: z.array(z.enum(VIZ_INTERACTION_IDS)).min(1).max(9).optional(), animation: z.enum(VIZ_ANIMATION_MODES).optional(),
  binding: z.object({
    datasetId: z.string().min(1).max(100), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), claimGraphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/), queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    message: z.string().min(1).max(2000), query: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();
export type VizWidget = z.infer<typeof vizWidgetSchema>;
export const widgetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('metric'), title: z.string().max(100), metric: z.enum(metricIds) }).strict(),
  z.object({ type: z.enum(['bar_chart','line_chart']), title: z.string().max(100), metric: z.enum(metricIds), comparisonMetric: z.enum(metricIds).optional(), groupBy: z.literal('branch') }).strict(),
  z.object({ type: z.literal('table'), title: z.string().max(100), dataset: z.enum(['branch_metrics','inventory','staffing','open_incidents']) }).strict(),
  z.object({ type: z.literal('incident_list'), title: z.string().max(100), dataset: z.literal('open_incidents') }).strict(),
  z.object({ type: z.literal('text_summary'), title: z.string().max(100) }).strict(),
  vizWidgetSchema
]);
export const dashboardSpecSchema = z.object({ title: z.string().min(1).max(120), description: z.string().max(500), scope: scopeSchema, widgets: z.array(widgetSchema).min(1).max(12) }).strict();
export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;
export interface PackPin { id: string; version: string; schemaDigest: string; implementationRevision: string }
export interface Dashboard { id: string; ownerId: string; spec: DashboardSpec; packs: PackPin[]; createdAt: string; updatedAt: string; lastRefreshAt: string; sourceMetadata: SourceRef[]; analysis: Analysis | null; evidenceVersion: string; pinnedAt?: string; archivedAt?: string }
export type ActionKind = 'dashboard_create' | 'dashboard_share' | 'ticket_create' | 'badge_revoke' | 'demo_update';
export type ActionPayload = { kind: 'dashboard_create'; spec: DashboardSpec } | { kind: 'dashboard_share'; dashboardId: string; recipientId: string } | { kind: 'ticket_create'; scope: Scope; targets: { branchId: string; assigneeId: string; title: string; reason: string; sourceIds: string[]; unansweredQuestion: string }[]; plan?: TicketPlan } | { kind: 'badge_revoke'; badgeId: string; employeeId: string; reason: string } | { kind: 'demo_update'; scenario: 'stock_recovered' | 'payment_resolved' | 'baseline' };
export interface ReceiptAccess { readPermissions: string[]; regions: string[] }
export interface ApprovalDisplay { artifactTitle?:string; branches?:{id:string;name:string}[]; badge?:{ employeeId:string; employeeName:string; employeeBranchId:string|null; badgeId:string; state:Badge['state']; version:number; updatedAt:string } }
export interface BadgeReview { payloadHash:string; checkedAt:string; status:'current'|'stale'|'unavailable'; current?:{ employeeName:string; badgeState:Badge['state']; badgeVersion:number; updatedAt:string } }
export const pendingActionStaleReasonSchema = z.enum([
  'superseded', 'user_cancelled', 'expired', 'mode_changed', 'release_changed', 'evidence_changed',
  'source_turn_failed', 'source_turn_cancelled',
]);
export type PendingActionStaleReason = z.infer<typeof pendingActionStaleReasonSchema>;
export const pendingActionRevisionDiffSchema = z.array(z.string().trim().min(1).max(600)).min(1).max(32);
export type ActionCatalogSection = 'ask_analyze' | 'prepare_review';
export type ActionCatalogConsequence = 'read' | 'analyze' | 'review_required';
export interface ActionCatalogEntry {
  id: string;
  section: ActionCatalogSection;
  title: string;
  description: string;
  prompt: string;
  consequence: ActionCatalogConsequence;
  actionKind?: ActionKind;
}
export type ActionCatalogStatus = 'ready' | 'limited' | 'no_authorized_flows' | 'no_current_targets' | 'data_unavailable';
export interface FollowUpSuggestion { id:string; label:string; prompt:string; consequence:'read'|'analyze' }
export interface FollowUpSuggestions { status:'ready'|'none'|'data_unavailable'; conversationId:string; afterMessageId:string; items:FollowUpSuggestion[] }
export interface PendingAction { id: string; actorId: string; sessionId: string; conversationId: string; turnId: string; mode: Mode; modeRevision: number; payload: ActionPayload; payloadHash: string; evidenceVersion: string | null; packs: PackPin[]; receiptAccess?:ReceiptAccess; releaseRevision?:string; actionContractVersion?:1; approvalScope?:Scope; approvalDisplay?:ApprovalDisplay; predecessorActionId?:string; supersededByActionId?:string; staleReason?:PendingActionStaleReason; revisionDiff?:string[]; createdAt: string; expiresAt: string; status: 'pending' | 'claimed' | 'completed' | 'stale'; preview: string }
export interface PendingActionRevisionResult { predecessor: PendingAction; replacement: PendingAction; diff: string[] }
export interface TargetResult { targetId: string; id: string | null; executedAt?: string; status: 'verified_success' | 'pending' | 'failed' | 'denied'; detail: string }
export interface Receipt { visibility?:'full'; readbackRevision?:string; id: string; actionId: string; actorId: string; kind: ActionKind; status: 'verified_success' | 'pending' | 'failed' | 'denied'; results: TargetResult[]; createdAt: string; verifiedAt: string | null; dashboardId?: string }
export interface RestrictedReceipt { visibility:'restricted'; id:string; actionId:string; status:Receipt['status']; results:[]; createdAt:string; verifiedAt:null; detail:string; kind?:never; actorId?:never; dashboardId?:never }
export type ReceiptView = Receipt | RestrictedReceipt;
export interface Ticket { id: string; branchId: string; assigneeId: string; title: string; reason: string; unansweredQuestion: string; sourceIds: string[]; status: 'open'; operationKey: string; createdAt: string }
export interface AuditEvent { id: string; actorId: string; category: string; summary: string; actionId?: string; region?: string; createdAt: string }
/** Turn/session linkage is server-owned; absent fields identify legacy stored messages. */
export interface ConversationMessage { id: string; conversationId: string; actorId: string; turnId?: string; sessionId?: string; role: 'user' | 'assistant'; text: string; mode: Mode; modeRevision: number; createdAt: string; analysis?: Analysis; evidence?:Evidence; sources?:SourceRef[]; pendingActionId?: string; pendingActionIds?: string[]; receiptId?: string; artifacts?: TurnArtifact[]; choices?: TurnChoice[]; hint?: 'switch_to_demo'; followUps?: string[]; receiptCards?: TurnReceiptCard[] }
/** Structured pick of a rendered clarification chip: the choice id and the assistant turn that offered it. Never free text. */
export interface TurnClarificationSelection { choiceId: string; clarifiedTurnId: string }
/** Server-validated clarification choice (ids from server context, labels replaced by server labels). */
export interface TurnChoice { id: string; label: string }
/**
 * G5: receipt card of a DIRECT chat effect that has no pending-action receipt (Dashboard pin / unpin / archive / restore / duplicate). Server copy only;
 * persisted in the same transaction as the effect write and its read-back postcondition, so it exists only when the effect was verified.
 */
export interface TurnReceiptCard { kind: 'dashboard_organize'; title: string; headline: string; fields: { label: string; value: string }[]; verifiedAt: string }
/** Evidence-bound artifact preview (Wave 3) attached to an assistant message; every value comes from verified claims. */
export interface TurnArtifact { id: string; revision: number; kind: 'table' | 'ranking' | 'chart' | 'executive_brief' | 'csv_export'; title: string; spec: ArtifactRendererSpec }
/** An owned resource the user SELECTED in the UI (exact id; `revision` only for a Result version). The server verifies owner + current permissions before the planner may reference it. */
export type TurnTarget = { kind: 'artifact'; id: string; revision?: number } | { kind: 'dashboard'; id: string } | { kind: 'monitor'; id: string };
export interface TurnRequestIdentity { contractVersion: 2; requestKey: string; demoShowcaseId?: string; catalogEntryId?: string; clarification?: TurnClarificationSelection; targets?: TurnTarget[] }
export interface TurnResponse { conversationId: string; turnId: string; assistantMessageId: string; message: string; mode: Mode; contractVersion?: 2; replayed?: boolean; analysis?: Analysis; evidence?: Evidence; sources?:SourceRef[]; pendingAction?: PendingAction; pendingActions?: PendingAction[]; receipt?: ReceiptView; receipts?: ReceiptView[]; clarification?: boolean; choices?: TurnChoice[]; artifacts?: TurnArtifact[]; hint?: 'switch_to_demo'; receiptCards?: TurnReceiptCard[] }
export interface Workspace { actor: Actor; csrfToken: string; businessDate: string; storage: string; metrics?:DepartmentPack['metrics']; dashboards: Dashboard[]; actions: PendingAction[]; badgeReviews?:Record<string,BadgeReview>; receipts: ReceiptView[]; audit: AuditEvent[]; messages: ConversationMessage[]; inbox: { id: string; dashboardId: string; title: string; createdAt: string; sharedBy?: string }[]; profiles: { id: string; name: string; role: Role }[]; taskAssigneeOptions?: { id: string; label: string }[]; capabilities: { id: string; title: string; allowed: boolean; tools: string[]; templates: { id: string; title: string }[] }[]; actionCatalog?: ActionCatalogEntry[]; actionCatalogStatus?: ActionCatalogStatus }

export interface ToolDescriptor { name: string; description: string; inputSchema: z.ZodType; resultSchema: z.ZodType; permission: string; audit: 'read' | 'prepare' | 'execute' | 'verify'; timeoutMs: number }
export interface DepartmentPack { id: string; contractVersion: 1; version: string; implementationRevision: string; dependencies: { id: string; version: string }[]; title: string; entities: string[]; adapterBindings: string[]; metrics: { id: string; calculatorId: string; definition: string; unit: string; timezone: string; source: string; owner: string; freshnessMinutes: number }[]; tools: ToolDescriptor[]; permissionConstraints: string[]; approvalMode: 'requester_confirmation'; templates: { id: string; title: string; spec: DashboardSpec }[]; evaluationCases: string[] }
export interface ToolBroker { execute(name: string, args: unknown): Promise<unknown>; descriptors: ToolDescriptor[] }
export interface AIRunResult { text: string; analysis?: Analysis; finalSummaryFailed?:boolean; narrativePlan?: NarrativePlan; refinementDecision?: DashboardRefinementDecision; calls: number; toolResults: { name: string; audit?:'read'|'prepare'; result: unknown }[]; toolMode: 'native' | 'planner' }
export interface AIContext { selectedScope?:Scope; latestDashboard?:{id:string;title:string;scope:Scope}; recipients?:{id:string;name:string;role:Role;regions:string[]}[] }
export interface AIInput { message: string; history: { role: 'user' | 'assistant'; content: string }[]; actor: Actor; businessDate: string; context?:AIContext; refinementCandidates?:DashboardRefinementCandidate[]; broker: ToolBroker; diagnosticId?: string }
