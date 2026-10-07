import type {
  ActionPayload,
  Employee,
  Evidence,
  Incident,
  Inventory,
  Product,
  Scope,
  Ticket,
  TicketPlan
} from '../contracts';
import {
  defineAction,
  type PackPrepareContext,
  type PackReadContext,
  type TargetContext,
  type ToolBinding,
  type TrustedPackRuntime
} from '../core/runtime-contracts';
import { invariant } from '../core/errors';
import { deterministicAnalysis } from '../core/evidence';
import { MockTicketSystem } from '../core/targets';
import { digest } from '../core/utils';
import { embedTicketPlan } from '../core/ticket-plan-text';
import { createSeedData } from '../seed/generate';
import { operationsPack } from './operations';

type InventoryArgs = {
  region: string;
  date: string;
  branchIds?: string[];
  productIds?: string[];
  belowMinimumOnly: boolean;
  limit: number;
};
type StaffingArgs = Scope;
type IncidentArgs = Scope & {
  status?: Incident['status'];
  kinds?: Incident['kind'][];
  limit: number;
};
type PrepareTicketArgs = { scope: Scope; branchIds?: string[]; plan?: Omit<TicketPlan, 'coveredBranchIds'> };
type TicketCreatePayload = Extract<ActionPayload, { kind: 'ticket_create' }>;
type DemoUpdatePayload = Extract<ActionPayload, { kind: 'demo_update' }>;
type DemoInventoryRow = Inventory & { operationKey?: string };
type DemoIncidentRow = Incident & { operationKey?: string };

function parseToolArgs<T extends Record<string, unknown>>(name: string, args: Record<string, unknown>): T {
  const tool = operationsPack.tools.find(candidate => candidate.name === name);
  invariant(tool, 'UNKNOWN_TOOL', `Unknown operations tool: ${name}`);
  return tool.inputSchema.parse(args) as T;
}

function evidenceResult(evidence: Evidence, now: Date) {
  return { evidence, analysis: deterministicAnalysis(evidence, now) };
}

function scopeFor(region: string, date: string, branchIds?: string[]): Scope {
  return { region, date, ...(branchIds === undefined ? {} : { branchIds }) };
}

function recalculateTotals(branches: Evidence['branches']): Evidence['totals'] {
  const netSales = branches.reduce((sum, branch) => sum + branch.netSales, 0);
  const target = branches.reduce((sum, branch) => sum + branch.target, 0);
  return {
    netSales,
    target,
    gap: netSales - target,
    achievement: target ? Math.round(netSales / target * 10_000) / 100 : null
  };
}

function projectBranches(evidence: Evidence, branches: Evidence['branches']): Evidence {
  const visibleIds = new Set(branches.map(branch => branch.branchId));
  return {
    ...evidence,
    branches,
    totals: recalculateTotals(branches),
    sources: evidence.sources.filter(source => {
      const branchId = source.id.split(':')[1];
      return visibleIds.has(branchId);
    })
  };
}

function inventoryFreshness(rows: Inventory[], evidence: Evidence): Evidence['sources'][number]['freshness'] {
  if (!rows.length) return 'missing';
  const asOf = new Date(evidence.asOf).getTime();
  const observedAt = Math.max(...rows.map(row => new Date(row.observedAt).getTime()));
  if (!Number.isFinite(observedAt)) return 'missing';
  if (observedAt > asOf) return 'misaligned';
  return asOf - observedAt > 24 * 60 * 60_000 ? 'stale' : 'fresh';
}

async function projectInventory(
  context: PackReadContext,
  evidence: Evidence,
  args: InventoryArgs
): Promise<Evidence> {
  let branches = [...evidence.branches].sort((left, right) => left.branchId.localeCompare(right.branchId));
  let sources = evidence.sources;
  const warnings = [...evidence.warnings];

  if (args.productIds !== undefined) {
    const requested = new Set(args.productIds);
    const products = new Set((await context.reader.list<Product>('products')).map(product => product.id));
    invariant(args.productIds.every(productId => products.has(productId)), 'INVALID_INPUT', 'Unknown product ID in inventory filter');
    const visibleBranches = new Set(evidence.branches.map(branch => branch.branchId));
    const inventory = (await context.reader.list<Inventory>('inventory_snapshots'))
      .filter(row => row.date === evidence.scope.date && visibleBranches.has(row.branchId) && requested.has(row.productId));
    const rowsByBranch = new Map<string, Inventory[]>();
    for (const row of inventory) {
      const rows = rowsByBranch.get(row.branchId) ?? [];
      rows.push(row);
      rowsByBranch.set(row.branchId, rows);
    }
    branches = branches.map(branch => {
      const rows = rowsByBranch.get(branch.branchId) ?? [];
      return {
        ...branch,
        stockIssues: rows.filter(row => row.onHand < row.minimum && new Date(row.observedAt).getTime() <= new Date(evidence.asOf).getTime()).length
      };
    });
    const rowsBySource = new Map(inventory.map(row => [row.branchId, rowsByBranch.get(row.branchId) ?? []]));
    sources = evidence.sources.map(source => {
      if (!source.id.startsWith('inventory:')) return source;
      const branchId = source.id.split(':')[1];
      const rows = rowsBySource.get(branchId) ?? [];
      const observedAt = rows.map(row => row.observedAt).sort().at(-1) ?? '';
      return {
        ...source,
        observedAt,
        freshness: inventoryFreshness(rows, evidence),
        detail: `${source.detail.split(' · ')[0]} · ${evidence.scope.date} · ${rows.length} selected records`
      };
    });
    const label = args.productIds.length ? args.productIds.slice(0, 8).join(', ') : '(empty selection)';
    warnings.push(`Inventory stock issue counts are projected to product IDs ${label}${args.productIds.length > 8 ? ` and ${args.productIds.length - 8} more` : ''}.`);
  }

  if (args.belowMinimumOnly) branches = branches.filter(branch => branch.stockIssues > 0);
  const wasLimited = branches.length > args.limit;
  branches = branches.slice(0, args.limit);
  if (wasLimited) warnings.push(`Inventory branch summary is limited to ${args.limit} branches.`);

  const projected = projectBranches({ ...evidence, sources, warnings }, branches);
  return projected;
}

function projectIncidents(evidence: Evidence, args: IncidentArgs): Evidence {
  const acceptedKinds = args.kinds === undefined ? undefined : new Set(args.kinds);
  const selected = evidence.branches.flatMap(branch => branch.incidents
    .filter(incident => (args.status === undefined || incident.status === args.status)
      && (acceptedKinds === undefined || acceptedKinds.has(incident.kind)))
    .map(incident => ({ branchId: branch.branchId, incident }))
  ).sort((left, right) => left.incident.startedAt.localeCompare(right.incident.startedAt)
    || left.incident.id.localeCompare(right.incident.id));
  const limited = selected.slice(0, args.limit);
  const idsByBranch = new Map<string, Set<string>>();
  for (const row of limited) {
    const ids = idsByBranch.get(row.branchId) ?? new Set<string>();
    ids.add(row.incident.id);
    idsByBranch.set(row.branchId, ids);
  }
  const branches = evidence.branches.map(branch => {
    const ids = idsByBranch.get(branch.branchId) ?? new Set<string>();
    const incidents = branch.incidents.filter(incident => ids.has(incident.id));
    return { ...branch, incidents, incidentCount: incidents.filter(incident => incident.status === 'open').length };
  });
  const warnings = [...evidence.warnings];
  if (args.status !== undefined || args.kinds !== undefined) warnings.push('Incident rows are filtered by the requested status and kinds.');
  if (selected.length > args.limit) warnings.push(`Incident results are limited to ${args.limit} rows.`);
  return { ...evidence, branches, warnings };
}

const ticketBranches = (payload: TicketCreatePayload): string[] => [...new Set([...payload.targets.map(target => target.branchId), ...(payload.plan?.coveredBranchIds ?? [])])];

function ticketTarget(payload: TicketCreatePayload, branchId: string) {
  const matches = payload.targets.filter(target => target.branchId === branchId);
  invariant(matches.length === 1, 'INVALID_INPUT', 'The approved ticket target must identify exactly one branch');
  return matches[0];
}

async function validateTicket(context: PackReadContext, payload: TicketCreatePayload) {
  const evidence = await context.evidence(payload.scope);
  const metrics = new Map(evidence.branches.map(branch => [branch.branchId, branch]));
  const seenBranches = new Set<string>();
  const covered = payload.plan?.coveredBranchIds ?? [];
  if (covered.length) {
    // grouping=single over several branches: exactly one target (the anchor) and every covered branch is inside the current evidence scope.
    invariant(payload.plan?.grouping === 'single' && payload.targets.length === 1 && new Set(covered).size === covered.length && covered.includes(payload.targets[0].branchId),
      'INVALID_INPUT', 'A single ticket must be anchored to one of its covered branches');
    invariant(covered.every(branchId => metrics.has(branchId)), 'FORBIDDEN', 'A covered ticket branch is outside the current evidence scope', 403);
  }
  for (const target of payload.targets) {
    invariant(!seenBranches.has(target.branchId), 'INVALID_INPUT', 'Ticket targets must use unique branches');
    seenBranches.add(target.branchId);
    const branch = metrics.get(target.branchId);
    invariant(branch, 'FORBIDDEN', 'Ticket target branch is outside the current evidence scope', 403);
    const allowedSources = new Set([...branch.sourceIds, ...covered.flatMap(branchId => metrics.get(branchId)?.sourceIds ?? [])]);
    invariant(target.sourceIds.length > 0
      && new Set(target.sourceIds).size === target.sourceIds.length
      && target.sourceIds.every(sourceId => allowedSources.has(sourceId)),
    'INVALID_INPUT', 'Ticket evidence must belong to its target branch');
    const employee = await context.reader.get<Employee>('employees', target.assigneeId);
    invariant(employee?.active && employee.branchId === target.branchId, 'INVALID_INPUT', 'Ticket assignee must be active in the target branch');
  }
  return { version: evidence.version, evidence };
}

function uniqueIds(ids: string[], label: string) {
  invariant(new Set(ids).size === ids.length, 'INVALID_INPUT', `${label} must not contain duplicates`);
}

function parseExplicitTicketBranches(args: PrepareTicketArgs): { scope: Scope; requested?: string[] } {
  if (args.branchIds === undefined) return { scope: args.scope };
  uniqueIds(args.branchIds, 'Ticket branch selection');
  if (args.scope.branchIds !== undefined) {
    const scoped = new Set(args.scope.branchIds);
    invariant(args.branchIds.every(branchId => scoped.has(branchId)), 'INVALID_INPUT', 'Ticket branch selection must be inside the supplied scope');
  }
  return { scope: { ...args.scope, branchIds: args.branchIds }, requested: args.branchIds };
}

async function prepareTicket(context: PackPrepareContext, args: Record<string, unknown>) {
  const parsed = parseToolArgs<PrepareTicketArgs>('ticket.prepare_create', args);
  const { scope, requested } = parseExplicitTicketBranches(parsed);
  const evidence = await context.evidence(scope);
  const metrics = new Map(evidence.branches.map(branch => [branch.branchId, branch]));
  if (requested !== undefined) {
    invariant(requested.every(branchId => metrics.has(branchId)), 'FORBIDDEN', 'A requested ticket branch is outside the current evidence scope', 403);
  }
  // An explicit selection keeps the requested order (the store's list order is not a contract); the gap scan keeps evidence order.
  const candidates = requested === undefined
    ? evidence.branches.filter(branch => branch.gap < 0)
    : requested.flatMap(branchId => metrics.has(branchId) ? [metrics.get(branchId)!] : []);
  invariant(candidates.length > 0, 'INVALID_INPUT', 'No branch in the current scope qualifies for a ticket');
  if (requested !== undefined) invariant(candidates.length === requested.length, 'INVALID_INPUT', 'Every requested branch must have a ticket target');

  const targets = [] as TicketCreatePayload['targets'];
  const employees = await context.reader.list<Employee>('employees');
  const single = parsed.plan?.grouping === 'single' && candidates.length > 1;
  for (const branch of candidates) {
    const assignee = employees.find(employee => employee.active && employee.branchId === branch.branchId);
    invariant(assignee, 'INVALID_INPUT', `No active assignee is available for ${branch.branchName}`);
    targets.push({
      branchId: branch.branchId,
      assigneeId: assignee.id,
      title: `ตรวจสอบยอดขาย ${branch.branchName}`,
      reason: `ยอดขาย ${branch.netSales} บาท เทียบเป้า ${branch.target} บาท; สต็อกต่ำ ${branch.stockIssues} รายการ; Incident เปิด ${branch.incidentCount} รายการ — ยังไม่ยืนยันสาเหตุ`,
      sourceIds: [...branch.sourceIds],
      unansweredQuestion: 'ตรวจ lost demand / conversion และช่วงเวลาที่ผลกระทบเกิดขึ้นเพื่อยืนยันสาเหตุ'
    });
  }
  if (single) {
    // One ticket anchored to the first branch; its reason names every covered branch with that branch's own evidenced figures.
    const [anchor] = targets;
    const covered = candidates.map(branch => branch.branchId);
    const reasons = targets.map(target => `${candidates.find(c => c.branchId === target.branchId)?.branchName ?? target.branchId}: ${target.reason}`).join(' | ');
    targets.splice(0, targets.length, { ...anchor, title: `ตรวจสอบยอดขาย ${covered.length} สาขา`.slice(0, 120), reason: reasons.slice(0, 500),
      sourceIds: [...new Set(candidates.flatMap(branch => branch.sourceIds))].slice(0, 20) });
    return { pendingAction: await context.prepare({ kind: 'ticket_create', scope: evidence.scope, targets, plan: { ...parsed.plan!, coveredBranchIds: covered } }) };
  }
  return { pendingAction: await context.prepare({ kind: 'ticket_create', scope: evidence.scope, targets, ...(parsed.plan ? { plan: parsed.plan } : {}) }) };
}

export function expectedInventory(row: Inventory, scenario: DemoUpdatePayload['scenario']): Inventory {
  return scenario === 'stock_recovered'
    ? { ...row, onHand: Math.max(row.onHand, row.minimum + 10) }
    : row;
}

export function expectedIncident(row: Incident, scenario: DemoUpdatePayload['scenario'], executionAt?: string): Incident {
  if (scenario !== 'payment_resolved') return row;
  return { ...row, status: 'resolved', ...(executionAt === undefined ? {} : { endedAt: executionAt }) };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(new Date(value).getTime());
}

function semanticInventory(row: DemoInventoryRow) {
  const { updatedAt, operationKey, ...semantic } = row;
  void updatedAt;
  void operationKey;
  return semantic;
}

function semanticIncident(row: DemoIncidentRow, ignoreEndedAt: boolean) {
  const { updatedAt, operationKey, endedAt, ...semantic } = row;
  void updatedAt;
  void operationKey;
  return ignoreEndedAt ? semantic : { ...semantic, endedAt };
}

function sameIds(actual: Array<{ id: string }>, expected: Array<{ id: string }>): boolean {
  if (actual.length !== expected.length) return false;
  const actualIds = actual.map(row => row.id).sort();
  const expectedIds = expected.map(row => row.id).sort();
  return actualIds.every((id, index) => id === expectedIds[index]);
}

export async function verifyDemo(context: Pick<TargetContext, 'reader' | 'businessDate' | 'operationKey' | 'executedAt'>, payload: DemoUpdatePayload): Promise<boolean> {
  if (!validTimestamp(context.executedAt)) return false;
  const seed = createSeedData(context.businessDate);
  const expectedInventoryRows = seed.inventory_snapshots.filter(row => row.date === context.businessDate);
  const expectedIncidentRows = seed.incidents.filter(row => row.date === context.businessDate);
  if (!expectedInventoryRows.length || !expectedIncidentRows.length) return false;

  const [actualInventoryRows, actualIncidentRows] = await Promise.all([
    context.reader.list<DemoInventoryRow>('inventory_snapshots'),
    context.reader.list<DemoIncidentRow>('incidents')
  ]);
  const actualInventory = actualInventoryRows.filter(row => row.date === context.businessDate);
  const actualIncidents = actualIncidentRows.filter(row => row.date === context.businessDate);
  if (!sameIds(actualInventory, expectedInventoryRows) || !sameIds(actualIncidents, expectedIncidentRows)) return false;

  const operationKey = context.operationKey;
  // Compare the canonical writer timestamp exactly; Date parsing discards sub-millisecond drift.
  if (actualInventory.some(row => row.operationKey !== operationKey || row.updatedAt !== context.executedAt)) return false;
  if (actualIncidents.some(row => row.operationKey !== operationKey || row.updatedAt !== context.executedAt)) return false;

  const expectedInventoryById = new Map(expectedInventoryRows.map(row => [row.id, expectedInventory(row, payload.scenario)]));
  const expectedIncidentById = new Map(expectedIncidentRows.map(row => [row.id, expectedIncident(row, payload.scenario)]));
  for (const row of actualInventory) {
    const expected = expectedInventoryById.get(row.id);
    if (!expected || digest(semanticInventory(row)) !== digest(semanticInventory(expected))) return false;
  }
  for (const row of actualIncidents) {
    const expected = expectedIncidentById.get(row.id);
    if (!expected || row.status !== expected.status) return false;
    if (row.status === 'resolved' && !validTimestamp(row.endedAt)) return false;
    if (row.status === 'open' && row.endedAt !== null) return false;
    if (payload.scenario === 'payment_resolved' && row.endedAt !== row.updatedAt) return false;
    if (digest(semanticIncident(row, payload.scenario === 'payment_resolved'))
      !== digest(semanticIncident(expected, payload.scenario === 'payment_resolved'))) return false;
  }
  return true;
}

const tools: ToolBinding[] = [
  {
    name: 'operations.query_inventory',
    audit: 'read',
    requiredPermissions: ['sales.read', 'operations.read'],
    run: async (context, args) => {
      const parsed = parseToolArgs<InventoryArgs>('operations.query_inventory', args);
      const evidence = await context.evidence(scopeFor(parsed.region, parsed.date, parsed.branchIds));
      return evidenceResult(await projectInventory(context, evidence, parsed), context.now());
    }
  },
  {
    name: 'incidents.search',
    audit: 'read',
    requiredPermissions: ['sales.read', 'operations.read'],
    run: async (context, args) => {
      const parsed = parseToolArgs<IncidentArgs>('incidents.search', args);
      const evidence = await context.evidence(scopeFor(parsed.region, parsed.date, parsed.branchIds));
      return evidenceResult(projectIncidents(evidence, parsed), context.now());
    }
  },
  {
    name: 'staffing.get_summary',
    audit: 'read',
    requiredPermissions: ['sales.read', 'operations.read'],
    run: async (context, args) => {
      const parsed = parseToolArgs<StaffingArgs>('staffing.get_summary', args);
      return evidenceResult(await context.evidence(parsed), context.now());
    }
  },
  {
    name: 'ticket.prepare_create',
    audit: 'prepare',
    requiredPermissions: ['sales.read', 'operations.read'],
    run: prepareTicket
  }
];

const ticketAction = defineAction({
  kind: 'ticket_create',
  riskTier: 'confirmation_required',
  packIds: ['sales', 'operations'],
  validate: validateTicket,
  targetIds: payload => payload.targets.map(target => target.branchId),
  overlaps: (candidate, claimed) => ticketBranches(candidate).some(branchId => ticketBranches(claimed).includes(branchId)),
  execute: async (context, payload) => {
    const target = ticketTarget(payload, context.targetId);
    const ticket: Ticket = {
      id: context.recordId,
      branchId: target.branchId,
      assigneeId: target.assigneeId,
      title: target.title,
      reason: target.reason,
      unansweredQuestion: embedTicketPlan(target.unansweredQuestion, payload.plan),
      sourceIds: [...target.sourceIds],
      status: 'open',
      operationKey: context.operationKey,
      createdAt: context.now().toISOString()
    };
    await context.tx.put('mock_tickets', ticket);
    return { recordId: context.recordId };
  },
  verify: async (context, payload) => {
    const target = ticketTarget(payload, context.targetId);
    const ticket = await MockTicketSystem.read(context.reader, context.recordId);
    return !!ticket
      && ticket.id === context.recordId
      && ticket.operationKey === context.operationKey
      && ticket.branchId === target.branchId
      && ticket.assigneeId === target.assigneeId
      && ticket.title === target.title
      && ticket.reason === target.reason
      && ticket.unansweredQuestion === embedTicketPlan(target.unansweredQuestion, payload.plan)
      && digest(ticket.sourceIds) === digest(target.sourceIds)
      && ticket.status === 'open';
  },
  visible: async (context, payload) => {
    const evidence = await context.evidence(payload.scope);
    const metrics = new Map(evidence.branches.map(branch => [branch.branchId, branch]));
    const covered = payload.plan?.coveredBranchIds ?? [];
    return covered.every(branchId => metrics.has(branchId)) && payload.targets.every(target => {
      const branch = metrics.get(target.branchId);
      const allowed = new Set([...(branch?.sourceIds ?? []), ...covered.flatMap(branchId => metrics.get(branchId)?.sourceIds ?? [])]);
      return !!branch && target.sourceIds.every(sourceId => allowed.has(sourceId));
    });
  }
});

const demoAction = defineAction({
  kind: 'demo_update',
  riskTier: 'confirmation_required',
  packIds: ['sales', 'operations'],
  validate: async (context: PackReadContext) => {
    const evidence = await context.evidence({ region: 'all', date: context.businessDate });
    return { version: evidence.version, evidence };
  },
  targetIds: () => ['artifact'],
  overlaps: () => true,
  execute: async (context, payload) => {
    invariant(context.targetId === 'artifact', 'INVALID_INPUT', 'Demo update target must be the single artifact');
    const seed = createSeedData(context.businessDate);
    const timestamp = context.now().toISOString();
    const inventory = seed.inventory_snapshots.filter(row => row.date === context.businessDate);
    const incidents = seed.incidents.filter(row => row.date === context.businessDate);
    invariant(inventory.length > 0 && incidents.length > 0, 'INVALID_INPUT', 'Demo update seed has no source rows for the business date');
    for (const row of inventory) {
      await context.tx.put('inventory_snapshots', {
        ...expectedInventory(row, payload.scenario),
        updatedAt: timestamp,
        operationKey: context.operationKey
      });
    }
    for (const row of incidents) {
      await context.tx.put('incidents', {
        ...expectedIncident(row, payload.scenario, timestamp),
        updatedAt: timestamp,
        operationKey: context.operationKey
      });
    }
    return { recordId: context.recordId, executedAt: timestamp };
  },
  verify: verifyDemo,
  visible: async context => {
    const evidence = await context.evidence({ region: 'all', date: context.businessDate });
    const expectedBranches = new Set(createSeedData(context.businessDate).branches.map(branch => branch.id));
    return expectedBranches.size > 0 && expectedBranches.size === evidence.branches.length
      && evidence.branches.every(branch => expectedBranches.has(branch.branchId));
  }
});

export const operationsRuntime: TrustedPackRuntime = {
  sourcePolicies:[{systems:['inventory','incidents','staffing'],permission:'operations.read',branchScoped:true}],
  manifest: operationsPack,
  tools,
  actions: [ticketAction, demoAction]
};
