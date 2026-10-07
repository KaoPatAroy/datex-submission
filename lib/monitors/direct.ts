import { z } from 'zod';
import type { Actor } from '../contracts';
import { DomainError } from '../core/errors';
import type { Store } from '../contracts';
import { assertMonitorManager, casMonitor, getOwnedMonitor, transactionAsStore } from '../router/ports/effect-store';
import type { DeferredWrites } from '../router/executors/action-ports';
import type { MonitorRunner } from '../router/ports/monitor-runner';

/** Body of the direct Monitor operation. `confirmDelete` is the UI's explicit confirm-dialog result; delete is refused without it. */
export const monitorOpSchema = z.object({ op: z.enum(['pause', 'resume', 'delete']), confirmDelete: z.boolean().optional() }).strict();
export type MonitorOpInput = z.infer<typeof monitorOpSchema>;

const STATUS_BY_CODE: Record<string, number> = { monitor_not_found: 404, monitor_needs_renewal: 409, monitor_conflict: 409, forbidden: 403 };

/**
 * Direct (UI) Monitor lifecycle: the same `runner.manage` the router executor uses (owner check, CAS, pause/resume revalidation).
 * Delete is a soft delete (evaluation history and audit rows stay). An unknown id and another owner's id are both 404.
 */
export async function applyMonitorOp(runner: Pick<MonitorRunner, 'manage'>, actor: Actor, monitorId: string, input: MonitorOpInput): Promise<{ text: string }> {
  if (input.op === 'delete' && input.confirmDelete !== true) throw new DomainError('CONFIRMATION_REQUIRED', 'การลบ Monitor ต้องยืนยันก่อน', 400);
  const result = await runner.manage(actor, { monitorId, op: input.op });
  if (!result.ok) throw new DomainError(result.code.toUpperCase(), result.text, STATUS_BY_CODE[result.code] ?? 409);
  return { text: result.text };
}

/** Body of the direct metadata edit (display title only; the condition, recipients and cadence are never editable here: those need a new, re-approved Monitor). */
export const monitorRenameSchema = z.object({ op: z.literal('rename'), title: z.string().trim().min(1).max(120) }).strict();
export type MonitorRenameInput = z.infer<typeof monitorRenameSchema>;

/**
 * Owner-only rename: the same owner check and row-version CAS as the other Monitor operations (an unknown id and another owner's id are both 404, a deleted
 * Monitor is 404). Metadata only: state, lifecycle, evidence binding, recipients and history are untouched; one metadata audit row in the same transaction.
 * `defer` (chat turn, monitor.manage rename): the same checks run now and the CAS write runs inside the turn's completion transaction.
 */
export async function renameMonitor(store: Store, now: () => Date, actor: Actor, monitorId: string, input: MonitorRenameInput, options: { defer?: DeferredWrites } = {}): Promise<{ text: string }> {
  const title = monitorRenameSchema.shape.title.parse(input.title);
  await assertMonitorManager(store, actor.id); // fresh precheck; re-run inside the mutation transaction
  const missing = () => new DomainError('MONITOR_NOT_FOUND', 'ไม่พบ Monitor ของคุณตามที่ระบุ', 404);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await getOwnedMonitor(store, actor, monitorId);
    if (!row || row.status === 'monitor_deleted') throw missing();
    const write = (target: Store) => casMonitor(target, row.id, row.rowVersion, now(), r => { if (r.actorId !== actor.id) throw missing(); return { title }; },
      async tx => { await assertMonitorManager(tx, actor.id); await tx.put('audit_events', { id: `audit_monitor_${crypto.randomUUID()}`, actorId: actor.id, category: 'monitor_manage', summary: 'monitor.rename', actionId: row.id, createdAt: now().toISOString() }); });
    const text = `เปลี่ยนชื่อ Monitor เป็น “${title}” แล้ว`;
    if (options.defer) { options.defer.push(async (tx, finalActor) => { if (finalActor.id !== actor.id) throw new DomainError('FORBIDDEN', 'Final actor changed', 403); await write(transactionAsStore(tx, store)); }); return { text }; }
    try {
      await write(store);
      return { text };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MONITOR_CONFLICT' && attempt === 0) continue;
      throw error;
    }
  }
  throw new DomainError('MONITOR_CONFLICT', 'Monitor ถูกแก้ไขไปแล้ว โปรดลองอีกครั้ง', 409);
}
