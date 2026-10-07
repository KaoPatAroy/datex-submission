import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Dashboard, DashboardSpec, Profile, Reader, Scope } from '../contracts';
import { dashboardSpecSchema } from '../contracts';
import { readEvidence, deterministicAnalysis } from '../core/evidence';
import { DomainError, invariant } from '../core/errors';
import { canonical, digest, id } from '../core/utils';
import { incidentSchema, inventorySchema, salesOrderSchema, salesTargetSchema, staffingSchema } from '../packs/shared';
import type { ProjectedRow, WorkflowProjectionReader, WorkflowStorageQuery, WorkflowStoreCapability, WorkflowTransactionContext } from '../storage/workflow-projections';
import { reloadWorkflowPrincipal } from './authority';
import {
  dashboardShareV2Schema, directoryIdentitySchema, expectedRowSchema, instantSchema,
  recipientDashboardViewSchema, responsibilitySchema, versionedDemoWorkflowPolicySchema,
  type DashboardShareV2, type DeliveryChannel, type DirectoryIdentity, type ExpectedRow,
  type Instant, type RecipientDashboardView, type Responsibility, type Store,
} from './contracts';
import { dashboardShareExpiresAt, demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from './policy';
import { writeWorkflowAudit } from './action-results';

const purpose = demoWorkflowPolicyV1.shareSigning.purpose;
const identifier = directoryIdentitySchema.shape.id;
const opaqueGrantId = /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/;
const pageSize = 100;
const salesRoles = new Set(['executive', 'east_manager']);
const permissions = ['sales.read', 'operations.read'];
const profileSchema = z.object({ id: identifier, name: z.string().min(1).max(160), active: z.boolean(), permissions: z.array(z.string()), regions: z.array(z.string()) });
const branchSchema = z.object({ id: identifier, name: z.string().min(1).max(160), region: z.string().min(1).max(40), orgUnitId: identifier.nullable().optional(), active: z.boolean().optional() });
const orgSchema = z.object({ id: identifier, name: z.string(), active: z.boolean(), parentOrgUnitId: identifier.nullable().optional() });
const relationshipSchema = z.object({ id: identifier, managerIdentityId: identifier, reportIdentityId: identifier, orgUnitId: identifier, active: z.boolean() });
const versionSchema = z.object({
  id: identifier, dashboardId: identifier, version: z.number().int().positive(), ownerId: identifier,
  createdAt: instantSchema, spec: dashboardSpecSchema,
  packs: z.array(z.object({ id: identifier, version: z.string(), schemaDigest: z.string(), implementationRevision: z.string() }).strict()),
  sourceMetadata: recipientDashboardViewSchema.shape.sources,
  analysis: recipientDashboardViewSchema.shape.analysis.nullable(), evidenceVersion: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), rowVersion: z.number().int().positive().optional(),
}).strict();
export type DashboardVersionForDigest = Omit<z.infer<typeof versionSchema>, 'digest' | 'rowVersion'>;

/** One recipe for the immutable artifact version, shared with its creating binding. */
export function dashboardVersionDigest(version: DashboardVersionForDigest): string {
  return digest({ purpose: 'biztania.dashboard-version/v2', id: version.id, dashboardId: version.dashboardId,
    version: version.version, ownerId: version.ownerId, createdAt: version.createdAt, spec: version.spec,
    packs: version.packs, sourceMetadata: version.sourceMetadata, analysis: version.analysis, evidenceVersion: version.evidenceVersion });
}

export interface DashboardShareSigningOptions {
  applicationOrigin: string;
  sessionSigningSecrets: ReadonlyMap<number, string | Uint8Array>;
  /** Explicit policy authorization for every retained key. No automatic retention. */
  allowedKeyVersions: readonly number[];
}
export type DashboardShareSigningFields = Omit<DashboardShareV2, 'verificationDigest'>;

/** Rejection sampling preserves a 32-random-byte token within the existing identifier grammar. */
export function createDashboardGrantId(): string {
  let value: string;
  do { value = randomBytes(32).toString('base64url'); } while (!opaqueGrantId.test(value));
  return value;
}

function origin(options: DashboardShareSigningOptions): string {
  let parsed: URL;
  try { parsed = new URL(options.applicationOrigin); } catch { throw new DomainError('SHARE_CONFIGURATION_INVALID', 'Share signing configuration is unavailable', 503); }
  invariant(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' &&
    (parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)),
  'SHARE_CONFIGURATION_INVALID', 'Share signing configuration is unavailable', 503);
  return parsed.origin;
}

function purposeKey(options: DashboardShareSigningOptions, keyVersion: number): Buffer {
  const secret = options.sessionSigningSecrets.get(keyVersion);
  invariant(Number.isSafeInteger(keyVersion) && keyVersion >= 1 && options.allowedKeyVersions.includes(keyVersion) &&
    secret !== undefined && (typeof secret === 'string' ? secret.length > 0 : secret.byteLength > 0),
  'SHARE_KEY_UNAVAILABLE', 'The share signing key is unavailable', 403);
  return Buffer.from(hkdfSync('sha256', secret, 'nexus-share-key-v1', `${purpose}/key/${keyVersion}`, 32));
}

function signatureFor(grant: DashboardShareSigningFields, options: DashboardShareSigningOptions): string {
  invariant(opaqueGrantId.test(grant.id), 'SHARE_DENIED', 'This share is unavailable', 403);
  const input = { purpose, keyVersion: grant.keyVersion, id: grant.id, dashboardVersionId: grant.dashboardVersionId,
    senderIdentityId: grant.senderIdentityId, recipientIdentityId: grant.recipientIdentityId, expiresAt: grant.expiresAt,
    approvedBranchIds: [...grant.approvedBranchIds].sort(), classification: grant.classification,
    channel: grant.channel, policyDigest: grant.policy.digest };
  return createHmac('sha256', purposeKey(options, grant.keyVersion)).update(canonical(input)).digest('base64url');
}

function signatureDigest(signature: string): string { return createHash('sha256').update(signature).digest('hex'); }
function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pure: the binding supplies expiry derived from CORE's persisted confirmedAt. Never persist signature/url. */
export function signDashboardShare(fields: DashboardShareSigningFields, options: DashboardShareSigningOptions): { verificationDigest: string; signature: string; url: string } {
  const parsed = dashboardShareV2Schema.safeParse({ ...fields, verificationDigest: '0'.repeat(64) });
  invariant(parsed.success && parsed.data.approvedBranchIds.length > 0 && parsed.data.status === 'active' && parsed.data.revokedAt === null &&
    Date.parse(parsed.data.expiresAt) === Date.parse(dashboardShareExpiresAt(new Date(parsed.data.createdAt))),
  'SHARE_DENIED', 'This share is unavailable', 403);
  const applicationOrigin = origin(options), signature = signatureFor(parsed.data, options);
  return { verificationDigest: signatureDigest(signature), signature,
    url: `${applicationOrigin}/shared/${parsed.data.id}?v=${parsed.data.keyVersion}&sig=${signature}` };
}

export function verifyDashboardShareSignature(grant: DashboardShareV2, keyVersion: number, signature: string, options: DashboardShareSigningOptions): boolean {
  try {
    if (!dashboardShareV2Schema.safeParse(grant).success || keyVersion !== grant.keyVersion || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expected = signatureFor(grant, options);
    // Both comparisons are evaluated; neither digest nor signature uses ordinary string equality.
    const signatureMatches = equalText(signature, expected);
    const digestMatches = equalText(signatureDigest(expected), grant.verificationDigest.toLowerCase());
    return signatureMatches && digestMatches;
  } catch { return false; }
}

function checked<T extends { id: string }>(row: ProjectedRow<T> | undefined, requestedId: string): ProjectedRow<T> {
  invariant(row && row.id === requestedId && row.body.id === requestedId && Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0,
    'SHARE_DENIED', 'Current share authority is unavailable', 403);
  if ('rowVersion' in row.body) invariant(row.body.rowVersion === row.rowVersion, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
  return row;
}
function expected(table: ExpectedRow['ref']['table'], row: ProjectedRow<{ id: string }>, state: string | null): ExpectedRow {
  return expectedRowSchema.parse({ ref: { table, id: row.id }, rowVersion: row.rowVersion, state });
}
async function pages<T extends { id: string }>(reader: WorkflowProjectionReader, query: Extract<WorkflowStorageQuery, { kind: 'scoped' }>): Promise<ProjectedRow<T>[]> {
  const rows: ProjectedRow<T>[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await reader.query<T>({ ...query, limit: pageSize, ...(cursor ? { cursor } : {}) });
    invariant(page.length <= pageSize, 'SHARE_DENIED', 'The share data query is invalid', 403);
    for (const row of page) {
      checked(row, row.id);
      invariant(!seen.has(row.id), 'SHARE_DENIED', 'The share data query is invalid', 403);
      seen.add(row.id); rows.push(row);
    }
    if (page.length < pageSize) return rows;
    cursor = page.at(-1)?.id;
    invariant(cursor !== undefined, 'SHARE_DENIED', 'The share data query is invalid', 403);
  }
}

interface Participant {
  directory: DirectoryIdentity; profile: z.infer<typeof profileSchema>;
  responsibilities: Responsibility[]; branches: Map<string, z.infer<typeof branchSchema>>;
  units: Map<string, z.infer<typeof orgSchema>>; expectedRows: ExpectedRow[];
}

/** Sender authority comes from durable directory/profile rows, without fabricating a sender session. */
async function participant(reader: WorkflowProjectionReader, identityId: string): Promise<Participant> {
  const directoryRow = checked(await reader.get<DirectoryIdentity>('directory_identities', identityId), identityId);
  const parsedDirectory = directoryIdentitySchema.safeParse(directoryRow.body);
  invariant(parsedDirectory.success && parsedDirectory.data.rowVersion === directoryRow.rowVersion, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
  const directory = parsedDirectory.data;
  invariant(directory.active && directory.department === 'sales_operations' && salesRoles.has(directory.role) && directory.classificationCeiling === 'internal',
    'SHARE_DENIED', 'Current share authority does not permit access', 403);
  const profileRow = checked(await reader.get<Profile>('profiles', directory.profileId), directory.profileId);
  const profile = profileSchema.safeParse(profileRow.body);
  invariant(profile.success && profile.data.active && permissions.every(permission => profile.data.permissions.includes(permission)),
    'SHARE_DENIED', 'Current share authority does not permit access', 403);
  const responsibilities = await pages<Responsibility>(reader, { kind: 'scoped', table: 'responsibilities', ownerId: identityId });
  const parsedResponsibilities = responsibilities.map(row => {
    const value = responsibilitySchema.safeParse(row.body);
    invariant(value.success && value.data.identityId === identityId && value.data.rowVersion === row.rowVersion,
      'SHARE_DENIED', 'Current share authority is unavailable', 403);
    return value.data;
  });
  const branches = new Map<string, z.infer<typeof branchSchema>>(), units = new Map<string, z.infer<typeof orgSchema>>();
  const expectedRows = [expected('directory_identities', directoryRow, 'active'),
    ...responsibilities.map(row => expected('responsibilities', row, row.body.active ? 'active' : 'inactive'))];
  const unitQueue = new Set([directory.orgUnitId, ...parsedResponsibilities.map(row => row.orgUnitId)]);
  for (const branchId of new Set(parsedResponsibilities.filter(row => row.active && row.purpose === 'sales_operations').flatMap(row => row.branchIds))) {
    const row = checked(await reader.get<{ id: string }>('branches', branchId), branchId), value = branchSchema.safeParse(row.body);
    invariant(value.success, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
    branches.set(branchId, value.data); expectedRows.push(expected('branches', row, null));
    if (value.data.orgUnitId) unitQueue.add(value.data.orgUnitId);
  }
  for (const unitId of unitQueue) {
    invariant(unitQueue.size <= 100, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
    const row = checked(await reader.get<{ id: string }>('org_units', unitId), unitId), value = orgSchema.safeParse(row.body);
    invariant(value.success, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
    units.set(unitId, value.data); expectedRows.push(expected('org_units', row, value.data.active ? 'active' : 'inactive'));
    if (value.data.parentOrgUnitId) unitQueue.add(value.data.parentOrgUnitId);
  }
  invariant(units.get(directory.orgUnitId)?.active, 'SHARE_DENIED', 'Current share authority does not permit access', 403);
  return { directory, profile: profile.data, responsibilities: parsedResponsibilities, branches, units, expectedRows };
}

function unitLine(participant: Participant, unitId: string): Set<string> {
  const result = new Set<string>();
  let current: string | null | undefined = unitId;
  while (current) {
    invariant(!result.has(current), 'SHARE_DENIED', 'Current share authority is unavailable', 403);
    const unit = participant.units.get(current);
    if (!unit?.active) break;
    result.add(current); current = unit.parentOrgUnitId;
  }
  return result;
}
function permitted(participant: Participant, spec: DashboardSpec): Set<string> {
  return new Set(participant.responsibilities.filter(row => row.active && row.purpose === 'sales_operations' && participant.units.get(row.orgUnitId)?.active)
    .flatMap(row => row.branchIds).filter(branchId => {
      const branch = participant.branches.get(branchId);
      return branch && branch.active !== false && (participant.profile.regions.includes('*') || participant.profile.regions.includes(branch.region)) &&
        (spec.scope.region === 'all' || spec.scope.region === branch.region) &&
        (spec.scope.branchIds === undefined || spec.scope.branchIds.includes(branchId)) &&
        (!branch.orgUnitId || participant.units.get(branch.orgUnitId)?.active === true);
    }));
}

export interface DashboardShareScopeInput {
  senderIdentityId: string; recipientIdentityId: string; spec: DashboardSpec; channel: DeliveryChannel;
}
export interface DashboardShareScope {
  branchIds: string[]; sender: DirectoryIdentity; recipient: DirectoryIdentity; expectedRows: ExpectedRow[];
}

/** Pure targeted reads; the binding pins the returned authority rows and the open path fences them transactionally. */
export async function resolveDashboardShareScope(reader: WorkflowProjectionReader, input: DashboardShareScopeInput): Promise<DashboardShareScope> {
  const spec = dashboardSpecSchema.safeParse(input.spec);
  invariant(spec.success && identifier.safeParse(input.senderIdentityId).success && identifier.safeParse(input.recipientIdentityId).success &&
    dashboardShareV2Schema.shape.channel.safeParse(input.channel).success,
  'SHARE_DENIED', 'This share is unavailable', 403);
  const sender = await participant(reader, input.senderIdentityId), recipient = await participant(reader, input.recipientIdentityId);
  invariant(sender.profile.permissions.includes('dashboard.share') && recipient.directory.allowedChannels.includes(input.channel) &&
    (input.channel !== 'simulated_slack' || recipient.directory.slackIdentity !== null), 'SHARE_DENIED', 'Current share authority does not permit access', 403);
  const senderLine = unitLine(sender, sender.directory.orgUnitId), recipientLine = unitLine(recipient, recipient.directory.orgUnitId);
  const relationships = await reader.query<{ id: string }>({ kind: 'unique', table: 'reporting_relationships',
    constraint: 'reporting_relationships_open_pair_unique', values: { managerIdentityId: sender.directory.id, reportIdentityId: recipient.directory.id } });
  invariant(relationships.length <= 1, 'SHARE_DENIED', 'Current share authority is unavailable', 403);
  const relationshipRows = relationships.map(row => {
    checked(row, row.id);
    const value = relationshipSchema.safeParse(row.body);
    invariant(value.success && value.data.managerIdentityId === sender.directory.id && value.data.reportIdentityId === recipient.directory.id,
      'SHARE_DENIED', 'Current share authority is unavailable', 403);
    return { row, body: value.data };
  });
  const currentRelationship = relationshipRows.some(({ body }) => body.active && body.reportIdentityId === recipient.directory.id &&
    sender.units.get(body.orgUnitId)?.active === true && recipient.units.get(body.orgUnitId)?.active === true);
  invariant([...senderLine].some(unitId => recipientLine.has(unitId)) || currentRelationship, 'SHARE_DENIED', 'The share has no current organizational relevance', 403);
  const senderIds = permitted(sender, spec.data), recipientIds = permitted(recipient, spec.data);
  const branchIds = [...senderIds].filter(branchId => recipientIds.has(branchId)).sort();
  invariant(branchIds.length > 0, 'SHARE_DENIED', 'The share has no current permitted data', 403);
  const expectedRows = new Map<string, ExpectedRow>();
  for (const row of [...sender.expectedRows, ...recipient.expectedRows,
    ...relationshipRows.map(({ row, body }) => expected('reporting_relationships', row, body.active ? 'active' : 'inactive'))]) {
    const key = `${row.ref.table}:${row.ref.id}`, previous = expectedRows.get(key);
    invariant(!previous || digest(previous) === digest(row), 'SHARE_DENIED', 'Current share authority changed', 403);
    expectedRows.set(key, row);
  }
  return { branchIds, sender: sender.directory, recipient: recipient.directory,
    expectedRows: [...expectedRows.values()].sort((a, b) => `${a.ref.table}:${a.ref.id}`.localeCompare(`${b.ref.table}:${b.ref.id}`)) };
}

async function currentPolicy(reader: WorkflowProjectionReader): Promise<void> {
  const pin = getDemoWorkflowPolicyV1Pin(), row = checked(await reader.get<{ id: string; version: number; digest: string; policy: unknown }>('workflow_policies', pin.id), pin.id);
  const parsed = versionedDemoWorkflowPolicySchema.safeParse(row.body.policy);
  invariant(parsed.success && row.body.version === pin.version && equalText(row.body.digest, pin.digest) && digest(parsed.data) === pin.digest,
    'STALE_SHARE', 'The share policy changed. A fresh approval is required', 403);
}
async function approvedVersion(reader: WorkflowProjectionReader, grant: DashboardShareV2) {
  const row = checked(await reader.get<z.infer<typeof versionSchema>>('dashboard_versions', grant.dashboardVersionId), grant.dashboardVersionId);
  const parsed = versionSchema.safeParse(row.body);
  invariant(parsed.success && parsed.data.dashboardId === grant.dashboardId && parsed.data.spec.scope.branchIds?.length &&
    new Set(parsed.data.spec.scope.branchIds).size === parsed.data.spec.scope.branchIds.length &&
    digest(parsed.data.spec.scope.branchIds) === digest([...parsed.data.spec.scope.branchIds].sort()) &&
    equalText(parsed.data.digest, dashboardVersionDigest(parsed.data)), 'SHARE_DENIED', 'The approved dashboard version is unavailable', 403);
  return parsed.data;
}

const metricTitles = { net_sales: 'Net sales', target: 'Sales target', gap: 'Sales gap', achievement: 'Target achievement', stock_issues: 'Stock issues', incident_count: 'Open incidents', staffing_actual: 'Actual staffing', staffing_planned: 'Planned staffing' } satisfies Record<Extract<DashboardSpec['widgets'][number], { type: 'metric' }>['metric'], string>;
const datasetTitles = { branch_metrics: 'Branch metrics', inventory: 'Inventory', staffing: 'Staffing', open_incidents: 'Open incidents' };
function safeWidgets(widgets: DashboardSpec['widgets']): DashboardSpec['widgets'] {
  return widgets.map(widget => {
    if ('metric' in widget) return { ...widget, title: metricTitles[widget.metric] };
    if ('dataset' in widget) return { ...widget, title: datasetTitles[widget.dataset] };
    return { type: 'text_summary', title: 'Evidence summary' };
  });
}

/** One serialization projector for detail/open/preview. It never reads original analysis or source free text. */
async function project(reader: WorkflowProjectionReader, input: { dashboardId: string; spec: DashboardSpec; branchIds: string[]; profile: Profile; ownerLabel: string | null; now: Date }): Promise<RecipientDashboardView> {
  const branchIds = [...input.branchIds].sort(), allowed = new Set(branchIds);
  const branchRows = await reader.query<{ id: string }>({ kind: 'ids', table: 'branches', ids: branchIds });
  invariant(branchRows.length === branchIds.length, 'SHARE_DENIED', 'The permitted dashboard data is unavailable', 403);
  const branches = branchRows.map(row => {
    checked(row, row.id); const parsed = branchSchema.safeParse(row.body);
    invariant(parsed.success && allowed.has(parsed.data.id) && parsed.data.active !== false, 'SHARE_DENIED', 'The permitted dashboard data is unavailable', 403);
    return parsed.data;
  });
  invariant(new Set(branches.map(branch => branch.id)).size === branchIds.length, 'SHARE_DENIED', 'The permitted dashboard data is unavailable', 403);
  const regions = [...new Set(branches.map(branch => branch.region))], scope: Scope = { date: input.spec.scope.date, region: regions.length === 1 ? regions[0] : 'all', branchIds };
  const evidenceSchemas = {
    sales_orders: salesOrderSchema.strip(), sales_targets: salesTargetSchema.strip(),
    inventory_snapshots: inventorySchema.strip(), incidents: incidentSchema.strip(), staffing_summaries: staffingSchema.strip(),
  };
  // readEvidence normally lists all branch metadata. This adapter exposes only authorized projected rows.
  const boundedReader: Reader = {
    get: async () => { throw new DomainError('SHARE_DENIED', 'The dashboard query is unavailable', 403); },
    list: async <T>(table: Parameters<Reader['list']>[0]): Promise<T[]> => {
      if (table === 'branches') return structuredClone(branches) as T[];
      invariant(Object.hasOwn(evidenceSchemas, table), 'SHARE_DENIED', 'The dashboard query is unavailable', 403);
      const rows = await pages<{ id: string; branchId: string; date: string }>(reader,
        { kind: 'scoped', table, branchIds, fromDate: scope.date, throughDate: scope.date });
      invariant(rows.every(row => allowed.has(row.body.branchId) && row.body.date === scope.date), 'SHARE_DENIED', 'The dashboard query exceeded its permitted scope', 403);
      const schema = evidenceSchemas[table as keyof typeof evidenceSchemas];
      return rows.map(row => {
        const parsed = schema.safeParse(row.body);
        invariant(parsed.success, 'SHARE_DENIED', 'The permitted dashboard evidence is unavailable', 403);
        if ('kind' in parsed.data) return { ...parsed.data, title: `${parsed.data.kind} incident — ${parsed.data.status}` };
        return parsed.data;
      }) as T[];
    },
  };
  invariant(salesRoles.has(input.profile.role), 'SHARE_DENIED', 'Current share authority does not permit access', 403);
  const actor: Actor = { ...input.profile, sessionId: 'projection', mode: 'scripted_demo', modeRevision: 0 };
  const evidence = await readEvidence(boundedReader, actor, scope, input.now);
  invariant(evidence.branches.length === branchIds.length && evidence.branches.every(branch => allowed.has(branch.branchId)), 'SHARE_DENIED', 'The permitted dashboard data is unavailable', 403);
  const sources = evidence.sources.map(source => ({ id: source.id, system: source.system, observedAt: source.observedAt,
    retrievedAt: source.retrievedAt, freshness: source.freshness, detail: `${source.system} records in your permitted scope` }));
  const sourceIds = new Set(sources.map(source => source.id));
  invariant(evidence.branches.every(branch => branch.sourceIds.every(sourceId => sourceIds.has(sourceId))), 'SHARE_DENIED', 'The permitted dashboard sources are unavailable', 403);
  const safeEvidence = { ...evidence, sources, warnings: [] };
  safeEvidence.version = digest({ scope: safeEvidence.scope, asOf: safeEvidence.asOf, branches: safeEvidence.branches.map(branch => ({ ...branch,
    incidents: branch.incidents.map(event => ({ id: event.id, branchId: event.branchId, kind: event.kind, status: event.status, startedAt: event.startedAt, endedAt: event.endedAt })) })), sources });
  const analysis = deterministicAnalysis(safeEvidence, input.now);
  analysis.missingEvidence.push(...sources.filter(source => source.freshness !== 'fresh' && source.system !== 'incidents')
    .map(source => ({ text: `${source.system}: ${source.freshness}`, sourceIds: [source.id] })));
  invariant(Object.values(analysis).filter(Array.isArray).flat().every(claim => claim.sourceIds.length > 0 &&
    claim.sourceIds.every((sourceId: string) => sourceIds.has(sourceId))), 'SHARE_DENIED', 'The permitted dashboard citations are unavailable', 403);
  const raw = { id: input.dashboardId, title: 'Dashboard in your permitted scope', ownerLabel: input.ownerLabel,
    currentScope: safeEvidence.scope, widgets: safeWidgets(input.spec.widgets),
    branches: safeEvidence.branches.map(branch => ({ branchId: branch.branchId, branchName: branch.branchName, region: branch.region,
      netSales: branch.netSales, target: branch.target, gap: branch.gap, achievement: branch.achievement,
      stockIssues: branch.stockIssues, incidentCount: branch.incidentCount, staffingPlanned: branch.staffingPlanned,
      staffingActual: branch.staffingActual, sourceIds: branch.sourceIds,
      incidents: branch.incidents.map(event => ({ id: event.id, kind: event.kind, status: event.status,
        startedAt: event.startedAt, endedAt: event.endedAt, title: `${event.kind} incident — ${event.status}` })) })),
    totals: safeEvidence.totals, sources, analysis, asOf: safeEvidence.asOf };
  const parsed = recipientDashboardViewSchema.safeParse(raw);
  invariant(parsed.success, 'SHARE_DENIED', 'The permitted dashboard projection is unavailable', 403);
  return parsed.data;
}

export interface DashboardShareOpenInput { sessionId: string; grantId: string; keyVersion: number; signature: string }
const shareOpenInputSchema = z.object({ sessionId: identifier, grantId: identifier.regex(opaqueGrantId),
  keyVersion: dashboardShareV2Schema.shape.keyVersion, signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const shareRecoveryInputSchema = z.object({ sessionId: identifier, grantId: identifier.regex(opaqueGrantId) }).strict();
const dashboardDetailInputSchema = z.object({ sessionId: identifier, dashboardId: identifier }).strict();
export interface DashboardAccessOptions {
  store: Store & WorkflowStoreCapability; signing: DashboardShareSigningOptions;
  now?: () => Date; makeId?: (prefix: string) => string;
}
interface AuditContext { actorId?: string; actorIdentityId?: string; shareId?: string }
type AccessResult<T> = { ok: true; value: T } | { ok: false; code: string; status: number };

export function createDashboardAccess(options: DashboardAccessOptions) {
  const store = options.store, now = options.now ?? (() => new Date()), makeId = options.makeId ?? id;
  const signing: DashboardShareSigningOptions = { applicationOrigin: origin(options.signing),
    sessionSigningSecrets: new Map([...options.signing.sessionSigningSecrets].map(([version, secret]) => [version, typeof secret === 'string' ? secret : Uint8Array.from(secret)])),
    allowedKeyVersions: [...options.signing.allowedKeyVersions] };
  invariant(store.workflowContractVersion === 2, 'SHARE_CONFIGURATION_INVALID', 'Guarded share storage is unavailable', 503);

  async function audit(tx: WorkflowTransactionContext, context: AuditContext, event: string, at: Instant, correlationId: string): Promise<void> {
    if (context.shareId && context.actorIdentityId) {
      const row = { id: makeId('share_access'), shareId: context.shareId, actorIdentityId: context.actorIdentityId, event, createdAt: at, correlationId, outcome: event === 'opened' ? 'allowed' : 'denied' };
      const inserted = await tx.insertUnique('share_access_events', row, { constraint: 'share_access_events_primary_key', values: { id: row.id } });
      invariant(inserted.inserted, 'SHARE_AUDIT_UNAVAILABLE', 'Share access could not be recorded', 503);
    } else if (context.actorId) {
      await writeWorkflowAudit(tx, { id: makeId('share_access_denial'), actorId: context.actorId, category: 'share_access',
        summary: 'Share access denied', createdAt: at, correlationId, outcome: 'denied' });
    } else {
      // The current audit schema requires a real profile/directory FK; never invent an anonymous actor.
      throw new DomainError('SHARE_AUDIT_UNAVAILABLE', 'Share access could not be recorded', 503);
    }
  }
  async function attempt<T>(work: (tx: WorkflowTransactionContext, context: AuditContext, at: Instant) => Promise<T>, successfulEvent?: string): Promise<T> {
    let at = instantSchema.parse(now().toISOString());
    const correlationId = makeId('share_access_correlation'), context: AuditContext = {};
    let result: AccessResult<T>;
    try {
      result = await store.workflowTransaction(async tx => {
        // Lock acquisition or an adapter's read-only retry must not preserve an expired request-time clock.
        at = instantSchema.parse(now().toISOString());
        try {
          const value = await work(tx, context, at);
          if (successfulEvent) await audit(tx, context, successfulEvent, at, correlationId);
          return { ok: true, value } as const;
        } catch (error) {
          if (!(error instanceof DomainError) || ![401, 403, 404].includes(error.status)) throw error;
          const event = error.code === 'STALE_SHARE' ? 'stale_policy' : error.code === 'SHARE_EXPIRED' ? 'expired' : error.code === 'SHARE_REVOKED' ? 'revoked' : 'denied';
          await audit(tx, context, event, at, correlationId);
          return { ok: false, code: error.code === 'STALE_SHARE' ? 'STALE_SHARE' : 'SHARE_DENIED', status: 403 } as const;
        }
      });
    } catch {
      // One bounded bookkeeping attempt. Discard all projected data regardless of commit certainty.
      try { await store.workflowTransaction(tx => audit(tx, context, 'denied', at, correlationId)); } catch { /* No data can escape an unavailable audit commit. */ }
      throw new DomainError('SHARE_ACCESS_UNAVAILABLE', 'Share access could not be established', 503);
    }
    if (!result.ok) throw new DomainError(result.code, result.code === 'STALE_SHARE' ? 'The share policy changed. A fresh approval is required' : 'This share is unavailable', result.status);
    return result.value;
  }
  async function load(tx: WorkflowTransactionContext, sessionId: string, grantId: string, at: Instant, context: AuditContext) {
    const principal = await sessionPrincipal(tx, sessionId, at, context);
    context.actorId = principal.actor.id; context.actorIdentityId = principal.directory.id;
    invariant(opaqueGrantId.test(grantId), 'SHARE_DENIED', 'This share is unavailable', 403);
    const grantRow = await tx.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', grantId);
    invariant(grantRow, 'SHARE_DENIED', 'This share is unavailable', 403);
    const grant = dashboardShareV2Schema.safeParse(checked(grantRow, grantId).body);
    invariant(grant.success && opaqueGrantId.test(grant.data.id) && grant.data.approvedBranchIds.length > 0 &&
      Date.parse(grant.data.expiresAt) === Date.parse(dashboardShareExpiresAt(new Date(grant.data.createdAt))),
    'SHARE_DENIED', 'This share is unavailable', 403);
    context.shareId = grant.data.id;
    return { principal, grant: grant.data };
  }
  async function authorize(tx: WorkflowTransactionContext, grant: DashboardShareV2, at: Instant) {
    invariant(grant.status === 'active' && grant.revokedAt === null, 'SHARE_REVOKED', 'This share is unavailable', 403);
    invariant(Date.parse(grant.expiresAt) > Date.parse(at), 'SHARE_EXPIRED', 'This share is unavailable', 403);
    await currentPolicy(tx.workflowProjectionReader);
    const pin = getDemoWorkflowPolicyV1Pin();
    invariant(grant.policy.id === pin.id && grant.policy.version === pin.version && equalText(grant.policy.digest, pin.digest), 'STALE_SHARE', 'The share policy changed. A fresh approval is required', 403);
    purposeKey(signing, grant.keyVersion);
    const version = await approvedVersion(tx.workflowProjectionReader, grant);
    const scope = await resolveDashboardShareScope(tx.workflowProjectionReader, { senderIdentityId: grant.senderIdentityId, recipientIdentityId: grant.recipientIdentityId, spec: version.spec, channel: grant.channel });
    invariant(scope.sender.profileId === version.ownerId, 'SHARE_DENIED', 'This share is unavailable', 403);
    const dashboard = checked(await tx.workflowProjectionReader.get<Dashboard>('dashboards', grant.dashboardId), grant.dashboardId);
    invariant(dashboard.body.ownerId === version.ownerId, 'SHARE_DENIED', 'This share is unavailable', 403);
    const ceiling: string[] = [];
    for (const branchId of [...grant.approvedBranchIds].sort()) {
      const rows = await tx.workflowProjectionReader.query<{ id: string; shareId: string; branchId: string }>({ kind: 'unique', table: 'share_scope_branches',
        constraint: 'share_scope_branches_share_branch_unique', values: { shareId: grant.id, branchId } });
      invariant(rows.length === 1 && rows[0].body.shareId === grant.id && rows[0].body.branchId === branchId,
        'SHARE_DENIED', 'The approved share ceiling is unavailable', 403);
      checked(rows[0], rows[0].id); ceiling.push(branchId);
    }
    invariant(new Set(ceiling).size === ceiling.length && digest(ceiling) === digest([...grant.approvedBranchIds].sort()), 'SHARE_DENIED', 'The approved share ceiling is unavailable', 403);
    const branchIds = ceiling.filter(branchId => scope.branchIds.includes(branchId) && version.spec.scope.branchIds?.includes(branchId));
    invariant(branchIds.length > 0, 'SHARE_DENIED', 'The share has no current permitted data', 403);
    return { version, scope, branchIds };
  }
  function freshUntil(expiresAt: Instant, code: string): void {
    invariant(Date.parse(expiresAt) > Date.parse(instantSchema.parse(now().toISOString())), code, 'This share is unavailable', 403);
  }
  async function open(input: DashboardShareOpenInput): Promise<RecipientDashboardView> {
    return attempt(async (tx, context, at) => {
      const validated = shareOpenInputSchema.safeParse(input);
      if (!validated.success) {
        await sessionPrincipal(tx, input?.sessionId, at, context);
        throw new DomainError('SHARE_DENIED', 'This share is unavailable', 403);
      }
      input = validated.data;
      const { principal, grant } = await load(tx, input.sessionId, input.grantId, at, context);
      if (!verifyDashboardShareSignature(grant, input.keyVersion, input.signature, signing)) {
        delete context.shareId; // Invalid signatures use a bounded audit without grant/recipient disclosure.
        throw new DomainError('SHARE_DENIED', 'This share is unavailable', 403);
      }
      invariant(principal.directory.id === grant.recipientIdentityId, 'SHARE_DENIED', 'This share is unavailable', 403);
      const authorized = await authorize(tx, grant, at);
      const profile = checked(await tx.workflowProjectionReader.get<Profile>('profiles', authorized.scope.recipient.profileId), authorized.scope.recipient.profileId).body;
      const view = await project(tx.workflowProjectionReader, { dashboardId: grant.dashboardId, spec: authorized.version.spec,
        branchIds: authorized.branchIds, profile: { ...profile, role: authorized.scope.recipient.role === 'executive' ? 'executive' : 'east_manager' }, ownerLabel: null, now: new Date(at) });
      freshUntil(grant.expiresAt, 'SHARE_EXPIRED');
      freshUntil(principal.sessionAnchor.expiresAt, 'SHARE_DENIED');
      return view;
    }, 'opened');
  }
  async function recover(input: { sessionId: string; grantId: string }): Promise<{ shareId: string; url: string }> {
    return attempt(async (tx, context, at) => {
      const validated = shareRecoveryInputSchema.safeParse(input);
      if (!validated.success) {
        await sessionPrincipal(tx, input?.sessionId, at, context);
        throw new DomainError('SHARE_DENIED', 'This share is unavailable', 403);
      }
      input = validated.data;
      const { principal, grant } = await load(tx, input.sessionId, input.grantId, at, context);
      invariant(principal.directory.id === grant.senderIdentityId, 'SHARE_DENIED', 'This share is unavailable', 403);
      await authorize(tx, grant, at);
      freshUntil(grant.expiresAt, 'SHARE_EXPIRED');
      freshUntil(principal.sessionAnchor.expiresAt, 'SHARE_DENIED');
      const signed = signDashboardShare(grant, signing);
      invariant(equalText(signed.verificationDigest, grant.verificationDigest.toLowerCase()), 'SHARE_DENIED', 'This share is unavailable', 403);
      return { shareId: grant.id, url: signed.url };
    });
  }
  async function detail(input: { sessionId: string; dashboardId: string }): Promise<RecipientDashboardView> {
    return attempt(async (tx, context, at) => {
      const validated = dashboardDetailInputSchema.safeParse(input);
      if (!validated.success) {
        await sessionPrincipal(tx, input?.sessionId, at, context);
        throw new DomainError('SHARE_DENIED', 'The dashboard is unavailable', 403);
      }
      input = validated.data;
      const principal = await sessionPrincipal(tx, input.sessionId, at, context);
      context.actorId = principal.actor.id; context.actorIdentityId = principal.directory.id;
      const dashboard = checked(await tx.workflowProjectionReader.get<Dashboard>('dashboards', input.dashboardId), input.dashboardId);
      invariant(dashboard.body.ownerId === principal.actor.id, 'SHARE_DENIED', 'The dashboard is unavailable', 403);
      const current = await participant(tx.workflowProjectionReader, principal.directory.id), spec = dashboardSpecSchema.parse(dashboard.body.spec);
      const branchIds = [...permitted(current, spec)].sort();
      invariant(branchIds.length > 0, 'SHARE_DENIED', 'The dashboard has no current permitted data', 403);
      const profile = checked(await tx.workflowProjectionReader.get<Profile>('profiles', current.directory.profileId), current.directory.profileId).body;
      const view = await project(tx.workflowProjectionReader, { dashboardId: dashboard.id, spec, branchIds,
        profile: { ...profile, role: current.directory.role === 'executive' ? 'executive' : 'east_manager' }, ownerLabel: current.directory.displayName, now: new Date(at) });
      freshUntil(principal.sessionAnchor.expiresAt, 'SHARE_DENIED');
      return view;
    });
  }
  async function sessionPrincipal(tx: WorkflowTransactionContext, sessionId: string, at: Instant, context: AuditContext) {
    // A known expired/inactive session may still attribute a denial to its durable profile.
    // This read grants no authority; reloadWorkflowPrincipal remains the authentication gate.
    if (identifier.safeParse(sessionId).success) {
      const session = await tx.workflowProjectionReader.get<{ id: string; profileId: string }>('sessions', sessionId);
      if (session?.id === sessionId && session.body.id === sessionId && identifier.safeParse(session.body.profileId).success) {
        const profile = await tx.workflowProjectionReader.get<{ id: string }>('profiles', session.body.profileId);
        if (profile?.id === session.body.profileId && profile.body.id === profile.id) context.actorId = profile.id;
      }
    }
    return reloadWorkflowPrincipal(tx, sessionId, at);
  }
  return { open, preview: open, recover, detail };
}
