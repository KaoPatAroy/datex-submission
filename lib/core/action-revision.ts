import { z } from 'zod';
import { pendingActionRevisionDiffSchema, type DashboardSpec } from '../contracts';
import { DomainError, invariant } from './errors';
import { dashboardCreatePatchSchema, DashboardPatchError, applyDashboardCreatePatch } from './pending-action-lifecycle';
import { digest } from './utils';
import { assertDashboardRendererSupport } from './dashboard-renderer-support';

export { assertDashboardRendererSupport } from './dashboard-renderer-support';

export const actionRevisionRequestKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,120}$/);
export const revisePendingActionRequestSchema = z.object({
  requestKey: actionRevisionRequestKeySchema,
  patch: dashboardCreatePatchSchema,
}).strict();
export const cancelPendingActionRequestSchema = z.object({}).strict();

export function revisionActionId(actorId: string, sessionId: string, baseActionId: string, requestKey: string): string {
  return `action_revision_${digest({ actorId, sessionId, baseActionId, requestKey }).slice(0, 40)}`;
}

export function createDashboardRevision(base: DashboardSpec, patch: unknown): {
  spec: DashboardSpec;
  diff: string[];
} {
  try {
    const applied = applyDashboardCreatePatch(base, patch);
    const diff = pendingActionRevisionDiffSchema.safeParse(applied.diff);
    invariant(diff.success, 'INVALID_REVISION', 'The dashboard revision diff exceeds the supported size.', 400);
    assertDashboardRendererSupport(applied.spec);
    return { spec: applied.spec, diff: diff.data };
  } catch (error) {
    if (error instanceof DashboardPatchError) {
      throw new DomainError('INVALID_REVISION', error.message, 400);
    }
    throw error;
  }
}
