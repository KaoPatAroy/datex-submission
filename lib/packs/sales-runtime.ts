import { normalizeModelDashboardSpec } from '../core/dashboard-spec-text';
import type { Actor, Dashboard, DashboardSpec, Evidence, Profile, Scope } from '../contracts';
import { dashboardSpecSchema, scopeSchema } from '../contracts';
import { DomainError, invariant } from '../core/errors';
import { deterministicAnalysis, readEvidence } from '../core/evidence';
import {
  defineAction,
  type ActionBinding,
  type PackPrepareContext,
  type PackReadContext,
  type ToolBinding,
  type TrustedPackRuntime
} from '../core/runtime-contracts';
import { MockInboxSystem, type InboxRecord } from '../core/targets';
import { digest } from '../core/utils';
import { salesPack } from './sales';

const dashboardPackIds = ['sales', 'operations'];
type DashboardWithOperationKey = Dashboard & { operationKey: string };
interface DashboardShare {
  id: string;
  dashboardId: string;
  recipientId: string;
  actorId: string;
  active: boolean;
  operationKey: string;
  createdAt: string;
}

function salesToolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const descriptor = salesPack.tools.find(tool => tool.name === name);
  invariant(descriptor, 'UNKNOWN_TOOL', `Unknown sales tool: ${name}`);
  return descriptor.inputSchema.parse(args) as Record<string, unknown>;
}

function isCurrentProfile(profile: Profile | undefined): profile is Profile {
  return !!profile?.active;
}

function asActor(profile: Profile, session: Pick<Actor, 'sessionId' | 'mode' | 'modeRevision'>): Actor {
  return { ...profile, sessionId:session.sessionId, mode:session.mode, modeRevision:session.modeRevision };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    new Set(right).size === right.length && left.every(id => right.includes(id));
}

function coversWholeScope(evidence: Evidence, requested: Scope): boolean {
  if (evidence.scope.region !== requested.region || evidence.scope.date !== requested.date) return false;
  if (requested.branchIds) {
    const returned = evidence.scope.branchIds ?? evidence.branches.map(branch => branch.branchId);
    return sameIds(requested.branchIds, returned) &&
      sameIds(requested.branchIds, evidence.branches.map(branch => branch.branchId));
  }
  return evidence.scope.branchIds === undefined;
}

async function readableEvidence(
  reader: PackPrepareContext['reader'],
  actor: Actor,
  scope: Scope,
  now: Date
): Promise<Evidence | undefined> {
  try {
    return await readEvidence(reader, actor, scope, now);
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) return undefined;
    throw error;
  }
}

async function visibleProfile(context: PackReadContext): Promise<Profile | undefined> {
  const profile = await context.reader.get<Profile>('profiles', context.actor.id);
  return isCurrentProfile(profile) ? profile : undefined;
}

async function shareEvidence(
  reader: PackPrepareContext['reader'],
  actor: Actor,
  dashboard: Dashboard,
  recipient: Profile,
  now: Date
): Promise<Evidence> {
  const scopedRecipient = asActor(recipient, actor);
  const evidence = await readEvidence(reader, scopedRecipient, dashboard.spec.scope, now);
  invariant(evidence.branches.length > 0, 'FORBIDDEN', 'Recipient has no branches in the dashboard scope', 403);
  return evidence;
}

function dashboardCreateAction(): ActionBinding {
  return defineAction({
    kind: 'dashboard_create',
    riskTier: 'private_reversible',
    packIds: dashboardPackIds,
    validate: async (context, payload) => {
      const spec = dashboardSpecSchema.parse(payload.spec);
      const evidence = await context.evidence(spec.scope);
      invariant(coversWholeScope(evidence, spec.scope), 'FORBIDDEN', 'Dashboard scope exceeds current access', 403);
      return { version: evidence.version, evidence,display:{artifactTitle:spec.title} };
    },
    targetIds: () => ['artifact'],
    overlaps: (candidate, claimed) => digest(candidate.spec) === digest(claimed.spec),
    execute: async (context, payload) => {
      invariant(context.targetId === 'artifact', 'INVALID_INPUT', 'Dashboard target mismatch');
      const evidence = context.evidence;
      invariant(evidence, 'STALE_ACTION', 'Current evidence is required to create a dashboard', 409);
      invariant(evidence.version.length > 0, 'STALE_ACTION', 'Current evidence version is missing', 409);
      const spec = dashboardSpecSchema.parse(payload.spec);
      const createdAt = context.now().toISOString();
      const dashboard: DashboardWithOperationKey = {
        id: context.recordId,
        ownerId: context.actor.id,
        spec,
        packs: context.approvedPacks,
        createdAt,
        updatedAt: createdAt,
        lastRefreshAt: createdAt,
        sourceMetadata: evidence.sources,
        analysis: deterministicAnalysis(evidence, context.now()),
        evidenceVersion: evidence.version,
        operationKey: context.operationKey
      };
      const existing = await context.tx.get<DashboardWithOperationKey>('dashboards', context.recordId);
      if (existing) {
        invariant(existing.operationKey === context.operationKey && existing.ownerId === context.actor.id &&
          digest(existing.spec) === digest(spec), 'CONFLICT', 'Dashboard target is already used by another operation', 409);
      } else {
        await context.tx.put('dashboards', dashboard);
      }
      return { recordId: context.recordId, dashboardId: context.recordId };
    },
    verify: async (context, payload) => {
      const dashboard = await context.reader.get<DashboardWithOperationKey>('dashboards', context.recordId);
      return !!dashboard && dashboard.id === context.recordId && dashboard.ownerId === context.actor.id &&
        dashboard.operationKey === context.operationKey && digest(dashboard.spec) === digest(payload.spec);
    },
    visible: async (context, payload) => {
      const profile = await visibleProfile(context);
      if (!profile?.permissions.includes('sales.read') || !profile.permissions.includes('dashboard.create')) return false;
      const requested = dashboardSpecSchema.parse(payload.spec).scope;
      const evidence = await readableEvidence(context.reader, asActor(profile, context.actor), requested, context.now());
      return !!evidence && coversWholeScope(evidence, requested);
    }
  });
}

function dashboardShareAction(): ActionBinding {
  return defineAction({
    kind: 'dashboard_share',
    riskTier: 'confirmation_required',
    packIds: dashboardPackIds,
    validate: async (context, payload) => {
      const dashboard = await context.reader.get<Dashboard>('dashboards', payload.dashboardId);
      invariant(dashboard && dashboard.ownerId === context.actor.id, 'FORBIDDEN', 'Only the dashboard owner may share it', 403);
      invariant(typeof (dashboard as { deletedAt?: unknown }).deletedAt !== 'string', 'NOT_FOUND', 'Dashboard นี้ถูกลบแล้ว จึงแชร์ไม่ได้', 404);
      context.assertPins(dashboard.packs);
      const ownerEvidence = await context.evidence(dashboard.spec.scope);
      invariant(coversWholeScope(ownerEvidence, dashboard.spec.scope), 'FORBIDDEN', 'Dashboard scope exceeds current access', 403);
      const recipient = await context.reader.get<Profile>('profiles', payload.recipientId);
      invariant(isCurrentProfile(recipient) && recipient.permissions.includes('sales.read'), 'FORBIDDEN', 'Recipient cannot read this dashboard', 403);
      const evidence = await shareEvidence(context.reader, context.actor, dashboard, recipient, context.now());
      return { version: digest({evidenceVersion:evidence.version,spec:dashboard.spec}), evidence,display:{artifactTitle:dashboard.spec.title} };
    },
    targetIds: payload => [payload.recipientId],
    overlaps: (candidate, claimed) => candidate.dashboardId === claimed.dashboardId && candidate.recipientId === claimed.recipientId,
    execute: async (context, payload) => {
      invariant(context.targetId === payload.recipientId, 'INVALID_INPUT', 'Dashboard recipient target mismatch');
      invariant(context.evidence, 'STALE_ACTION', 'Current recipient evidence is required to share a dashboard', 409);
      const dashboard = await context.tx.get<Dashboard>('dashboards', payload.dashboardId);
      invariant(dashboard && dashboard.ownerId === context.actor.id, 'FORBIDDEN', 'Only the dashboard owner may share it', 403);
      // Soft-deleted dashboards can never gain a share: re-checked inside the executing transaction (delete can race a pending share).
      invariant(typeof (dashboard as { deletedAt?: unknown }).deletedAt !== 'string', 'NOT_FOUND', 'Dashboard นี้ถูกลบแล้ว จึงแชร์ไม่ได้', 404);
      context.assertPins(dashboard.packs);
      const ownerEvidence = await readEvidence(context.tx, context.actor, dashboard.spec.scope, context.now());
      invariant(coversWholeScope(ownerEvidence, dashboard.spec.scope), 'FORBIDDEN', 'Dashboard scope exceeds current access', 403);
      const recipient = await context.tx.get<Profile>('profiles', payload.recipientId);
      invariant(isCurrentProfile(recipient) && recipient.permissions.includes('sales.read'), 'FORBIDDEN', 'Recipient cannot read this dashboard', 403);
      await shareEvidence(context.tx, context.actor, dashboard, recipient, context.now());
      const semanticDuplicate = (await context.tx.list<DashboardShare>('dashboard_shares')).some(grant =>
        grant.dashboardId === payload.dashboardId && grant.recipientId === payload.recipientId && grant.active &&
        (grant.operationKey !== context.operationKey || grant.id !== context.recordId));
      invariant(!semanticDuplicate, 'CONFLICT', 'Dashboard is already shared with this recipient', 409);
      const priorGrant = await context.tx.get<DashboardShare>('dashboard_shares', context.recordId);
      const priorInbox = await context.tx.get<InboxRecord>('mock_messages', context.recordId);
      const createdAt = context.now().toISOString();
      const grant: DashboardShare = {
        id: context.recordId,
        dashboardId: payload.dashboardId,
        recipientId: payload.recipientId,
        actorId: context.actor.id,
        active: true,
        operationKey: context.operationKey,
        createdAt
      };
      const inbox: InboxRecord = {
        id: context.recordId,
        recipientId: payload.recipientId,
        dashboardId: payload.dashboardId,
        operationKey: context.operationKey,
        createdAt
      };
      if (priorGrant) {
        invariant(priorGrant.operationKey === context.operationKey && priorGrant.dashboardId === payload.dashboardId &&
          priorGrant.recipientId === payload.recipientId && priorGrant.actorId === context.actor.id && priorGrant.active,
        'CONFLICT', 'Dashboard share target is already used by another operation', 409);
      } else {
        await context.tx.put('dashboard_shares', grant);
      }
      if (priorInbox) {
        invariant(priorInbox.operationKey === context.operationKey && priorInbox.dashboardId === payload.dashboardId &&
          priorInbox.recipientId === payload.recipientId, 'CONFLICT', 'Inbox target is already used by another operation', 409);
      } else {
        await context.tx.put('mock_messages', inbox);
      }
      return { recordId: context.recordId };
    },
    verify: async (context, payload) => {
      const [inbox, grant, dashboard] = await Promise.all([
        MockInboxSystem.read(context.reader, context.recordId),
        context.reader.get<DashboardShare>('dashboard_shares', context.recordId),
        context.reader.get<Dashboard>('dashboards', payload.dashboardId)
      ]);
      return !!inbox && inbox.id === context.recordId && inbox.operationKey === context.operationKey &&
        inbox.recipientId === payload.recipientId && inbox.dashboardId === payload.dashboardId &&
        !!grant && grant.id === context.recordId && grant.operationKey === context.operationKey && grant.active &&
        grant.recipientId === payload.recipientId && grant.dashboardId === payload.dashboardId && grant.actorId === context.actor.id &&
        !!dashboard && dashboard.ownerId === context.actor.id;
    },
    visible: async (context, payload) => {
      const [owner, dashboard, recipient] = await Promise.all([
        visibleProfile(context),
        context.reader.get<Dashboard>('dashboards', payload.dashboardId),
        context.reader.get<Profile>('profiles', payload.recipientId)
      ]);
      if (!owner?.permissions.includes('sales.read') || !owner.permissions.includes('dashboard.share') ||
        !dashboard || dashboard.ownerId !== context.actor.id || !isCurrentProfile(recipient) ||
        !recipient.permissions.includes('sales.read')) return false;
      try {
        context.assertPins(dashboard.packs);
      } catch (error) {
        if (error instanceof DomainError && error.status === 409) return false;
        throw error;
      }
      const requested = dashboard.spec.scope;
      const [ownerEvidence, recipientEvidence] = await Promise.all([
        readableEvidence(context.reader, asActor(owner, context.actor), requested, context.now()),
        readableEvidence(context.reader, asActor(recipient, context.actor), requested, context.now())
      ]);
      return !!ownerEvidence && !!recipientEvidence && recipientEvidence.branches.length > 0 &&
        coversWholeScope(ownerEvidence, requested);
    }
  });
}

const salesQueryTool: ToolBinding = {
  name: 'sales.query_metrics',
  audit: 'read',
  requiredPermissions: ['sales.read', 'operations.read'],
  run: async (context, args) => {
    const parsed = salesToolInput('sales.query_metrics', args);
    const scope = scopeSchema.parse({
      region: parsed.region,
      date: parsed.date,
      ...(parsed.branchIds === undefined ? {} : { branchIds: parsed.branchIds })
    });
    const evidence = await context.evidence(scope);
    return { evidence, analysis: deterministicAnalysis(evidence, context.now()) };
  }
};

const prepareDashboardCreateTool: ToolBinding = {
  name: 'dashboard.prepare_create',
  audit: 'prepare',
  requiredPermissions: ['sales.read', 'operations.read'],
  run: async (context, args) => {
    const parsed = salesToolInput('dashboard.prepare_create', args);
    const requested = dashboardSpecSchema.parse(parsed.spec);
    const evidence = await context.evidence(requested.scope);
    const spec = dashboardSpecSchema.parse(normalizeModelDashboardSpec({ ...requested, scope: evidence.scope }));
    const pendingAction = await context.prepare({ kind: 'dashboard_create', spec });
    return { pendingAction };
  }
};

const prepareDashboardShareTool: ToolBinding = {
  name: 'dashboard.prepare_share',
  audit: 'prepare',
  requiredPermissions: ['sales.read', 'operations.read'],
  run: async (context, args) => {
    const parsed = salesToolInput('dashboard.prepare_share', args);
    const pendingAction = await context.prepare({
      kind: 'dashboard_share',
      dashboardId: String(parsed.dashboardId),
      recipientId: String(parsed.recipientId)
    });
    return { pendingAction };
  }
};

export function defaultSalesDashboard(scope: Scope): DashboardSpec {
  return dashboardSpecSchema.parse({
    title: 'ภาพรวมยอดขายและปฏิบัติการ',
    description: 'ข้อมูลสังเคราะห์สำหรับการตรวจสอบยอดขาย',
    scope,
    widgets: [
      { type: 'metric', title: 'ยอดขายสุทธิ', metric: 'net_sales' },
      { type: 'metric', title: 'เป้าหมาย', metric: 'target' },
      { type: 'bar_chart', title: 'ยอดขายเทียบเป้ารายสาขา', metric: 'net_sales', comparisonMetric: 'target', groupBy: 'branch' },
      { type: 'table', title: 'สต็อกและกำลังคน', dataset: 'branch_metrics' },
      { type: 'incident_list', title: 'Incident ที่เกี่ยวข้อง', dataset: 'open_incidents' },
      { type: 'text_summary', title: 'สรุปพร้อมหลักฐาน' }
    ]
  });
}

export const salesRuntime: TrustedPackRuntime = {
  sourcePolicies:[{systems:['sales','targets'],permission:'sales.read',branchScoped:true}],
  manifest: salesPack,
  tools: [salesQueryTool, prepareDashboardCreateTool, prepareDashboardShareTool],
  actions: [dashboardCreateAction(), dashboardShareAction()]
};
