import 'server-only';
import type { Dashboard, Store } from '../contracts';
import { DomainError } from '../core/errors';
import { createTrustedWorkflowRuntime } from '../core/workflow-runtime';
import type { WorkflowStoreCapability, WorkflowProjectionReader, ProjectedRow } from '../storage/workflow-projections';
import { getStore, getWorkflowV2BootstrapResult, isWorkflowV2Enabled } from '../storage';
import type { WorkflowV2SeedResult } from '../seed/workflow-v2';
import type { DashboardShareSigningOptions } from '../workflows/dashboard-access';

type ComposedWorkflowRuntime = ReturnType<typeof createTrustedWorkflowRuntime>;

type WorkflowV2ServerReadiness = Pick<WorkflowV2SeedResult,
  'state' | 'sourcePhasesComplete' | 'bootstrapReady' | 'seedVersion' | 'seed' | 'businessDate' | 'inputDigest'>;

export type WorkflowV2ServerRuntime = Pick<ComposedWorkflowRuntime,
  'availability' | 'runner' | 'broker' | 'capabilities' | 'suggestions' | 'runtime' | 'onboarding'> & {
    readonly readiness: WorkflowV2ServerReadiness;
  };

const dashboardPageSize = 100;
const maximumOwnedDashboards = 1_000;
let runtimePromise: Promise<WorkflowV2ServerRuntime> | undefined;
let runtimeBootstrap: WorkflowV2SeedResult | undefined;

function dashboardSelectionUnavailable(): DomainError {
  return new DomainError('WORKFLOW_METADATA_UNAVAILABLE', 'Current dashboard selection could not be established', 503);
}

async function latestOwnedDashboard(
  projections: WorkflowProjectionReader,
  ownerId: string,
): Promise<Dashboard | undefined> {
  const rows: ProjectedRow<Dashboard>[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let complete = false;

  // Scoped queries use backend keyset ordering and cap pages at 100 rows. A one-row
  // tail query proves exhaustion after any short page, including an empty first page.
  const maximumPages = Math.floor(maximumOwnedDashboards / dashboardPageSize) + 1;
  for (let page = 0; page < maximumPages; page += 1) {
    const pageRows = await projections.query<Dashboard>({
      kind: 'scoped',
      table: 'dashboards',
      ownerId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: dashboardPageSize,
    });
    if (pageRows.length > dashboardPageSize) throw dashboardSelectionUnavailable();

    for (const row of pageRows) {
      if (seenIds.has(row.id) || row.body.id !== row.id || row.body.ownerId !== ownerId) {
        throw dashboardSelectionUnavailable();
      }
      seenIds.add(row.id);
    }

    rows.push(...pageRows);
    if (rows.length > maximumOwnedDashboards) throw dashboardSelectionUnavailable();
    if (pageRows.length < dashboardPageSize) {
      const lastPageId = pageRows.length === 0 ? cursor : pageRows[pageRows.length - 1].id;
      const tailRows = await projections.query<Dashboard>({
        kind: 'scoped',
        table: 'dashboards',
        ownerId,
        ...(lastPageId === undefined ? {} : { cursor: lastPageId }),
        limit: 1,
      });
      if (tailRows.length !== 0) throw dashboardSelectionUnavailable();
      complete = true;
      break;
    }

    const nextCursor = pageRows[pageRows.length - 1]?.id;
    if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) throw dashboardSelectionUnavailable();
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!complete) throw dashboardSelectionUnavailable();
  return rows.sort((left, right) =>
    right.body.createdAt.localeCompare(left.body.createdAt) || left.id.localeCompare(right.id))[0]?.body;
}

function dashboardShareSigningOptions(): DashboardShareSigningOptions | undefined {
  const key = process.env.DASHBOARD_SHARE_SIGNING_KEY_V1;
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (!key || Buffer.byteLength(key, 'utf8') < 32 || !configuredOrigin) return undefined;

  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    return undefined;
  }

  const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !localHttp)) return undefined;

  return {
    applicationOrigin: origin.origin,
    sessionSigningSecrets: new Map<number, string>([[1, key]]),
    allowedKeyVersions: [1],
  };
}

async function composeWorkflowV2ServerRuntime(bootstrap: WorkflowV2SeedResult): Promise<WorkflowV2ServerRuntime> {
  const store = await getStore();
  // The bootstrap getter and getStore share one cached store. A ready result proves this store passed
  // the workflow storage capability check before the canonical source plan was persisted.
  const workflowStore = store as Store & WorkflowStoreCapability;
  if (!isWorkflowV2Enabled()) {
    throw new DomainError('WORKFLOW_UNAVAILABLE', 'Workflow V2 is disabled', 503);
  }

  const runtime = createTrustedWorkflowRuntime({
    store: workflowStore,
    businessDate: bootstrap.businessDate,
    contextFactory: (_reader, principal, view) => ({
      latestDashboard: () => latestOwnedDashboard(view.projections, principal.actor.id),
    }),
    dashboardShareSigning: dashboardShareSigningOptions(),
  });

  const readiness: WorkflowV2ServerReadiness = Object.freeze({
    state: bootstrap.state,
    sourcePhasesComplete: bootstrap.sourcePhasesComplete,
    bootstrapReady: bootstrap.bootstrapReady,
    seedVersion: bootstrap.seedVersion,
    seed: bootstrap.seed,
    businessDate: bootstrap.businessDate,
    inputDigest: bootstrap.inputDigest,
  });

  return Object.freeze({
    availability: runtime.availability,
    runner: runtime.runner,
    broker: runtime.broker,
    capabilities: runtime.capabilities,
    suggestions: runtime.suggestions,
    // HR Director router bridge (lib/router/ports/director-workflow.ts) reuses the same composed runtime and onboarding reads.
    runtime: runtime.runtime,
    onboarding: runtime.onboarding,
    readiness,
  });
}

/** Returns the single server-composed V2 runtime after its canonical source bootstrap is ready. */
export async function getWorkflowV2ServerRuntime(): Promise<WorkflowV2ServerRuntime> {
  if (!isWorkflowV2Enabled()) {
    throw new DomainError('WORKFLOW_UNAVAILABLE', 'Workflow V2 is disabled', 503);
  }

  const bootstrap = await getWorkflowV2BootstrapResult();
  if (!isWorkflowV2Enabled() || !bootstrap || bootstrap.state !== 'source_ready' ||
    !bootstrap.sourcePhasesComplete || !bootstrap.bootstrapReady) {
    throw new DomainError('WORKFLOW_UNAVAILABLE', 'Workflow V2 source bootstrap is not ready', 503);
  }

  if (!runtimePromise || runtimeBootstrap !== bootstrap) {
    runtimeBootstrap = bootstrap;
    const composing = composeWorkflowV2ServerRuntime(bootstrap).catch(error => {
      if (runtimePromise === composing) runtimePromise = undefined;
      throw error;
    });
    runtimePromise = composing;
  }
  return runtimePromise;
}
