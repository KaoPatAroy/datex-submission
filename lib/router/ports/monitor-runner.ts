import type { Actor, Profile, Reader, Store, Transaction } from '../../contracts';
import { DomainError } from '../../core/errors';
import { readEvidence } from '../../packs/retail/evidence';
import { digest, snapshotRef, type EvidenceSnapshot } from '../../effects/shared';
import { paginate, sortKey, type Page, type PageInput } from '../../pagination';
import { monitorRegistry, runMonitorPlan, type MonitorContext, type MonitorOutput, type MonitorState } from '../../monitors';
import { authoritySnapshot, recipientSnapshot } from './effect-snapshots';
import type { DeferredWrites } from '../executors/action-ports';
import { assertMonitorManager, casMonitor, getOwnedMonitor, inboxRowId, inboxRowSchema, INBOX_KIND, listActiveMonitors, listOwnedMonitors,
  MONITOR_STATUS_BY_LIFECYCLE, recipientOperationKey, transactionAsStore, type MonitorEvaluation, type MonitorRow } from './effect-store';

/**
 * Scheduler + lifecycle for installed monitors. Evaluation is pure (lib/monitors); this adapter supplies the trusted,
 * freshly reloaded inputs (actor, recipient policy, registered branch evidence) and persists the result with a row-level CAS.
 *
 * - One tick = one bounded batch (limit + wall-clock budget). Each monitor is reloaded and re-authorized every tick.
 * - Alert delivery goes to the OWNER's simulated inbox only, with an outbox key derived from the monitor's dedupe key, so a
 *   retried tick (or two overlapping cron invocations) cannot deliver the same alert twice. State advance and the alert row
 *   commit in ONE store transaction.
 * - Authority/recipient/consent changes hold the monitor as `needs_renewal`; it never alerts again until re-created.
 */
export interface MonitorRunnerDeps {
  store: Store; now: () => Date; businessDate: string;
  /** `reader` = the transaction an in-transaction re-check runs in (defaults to the store). */
  recipientAllowed: (actor: Actor, recipientId: string, reader?: Reader) => Promise<boolean>;
}
export interface MonitorTickResult { scanned: number; evaluated: number; alerts: number; held: number; skipped: number; errors: number; deadlineReached: boolean }
export type ManageResult = { ok: true; text: string } | { ok: false; code: string; text: string };
export interface ManageInput { monitorId: string; op: 'pause' | 'resume' | 'delete' }
export interface MonitorListItem { id: string; title: string; status: MonitorRow['status'] }
export interface MonitorHistoryItem { id: string; title: string; status: MonitorRow['status']; lifecycle: string; cadence: 'daily' | 'hourly'; recipientCount: number;
  lastEvaluatedAt: string | null; lastError: string | null; expiresAt: string; evaluations: MonitorEvaluation[];
  /** The configured condition, for the UI explanation: alert when sales fall below this share of target (0..1), then stay quiet for the cooldown. */
  threshold: number; cooldown: 'one_hour' | 'one_day' }

const HOLD_CODES = new Set(['scope_or_permission', 'recipient_denied', 'recipient_scope', 'consent_denied', 'claim_use_denied', 'authorization_changed']);
const money = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

/** Owner + approved recipients, once each (the owner always sees the alert of their own monitor). */
export function audienceOf(ownerId: string, recipientIds: readonly string[]): string[] { return [...new Set([ownerId, ...recipientIds])]; }
const MAX_EVALUATIONS = 30;
/** Persisted, readable evaluation history of a monitor (newest last, bounded). */
export function appendEvaluation(row: Pick<MonitorRow, 'evaluations'>, entry: MonitorEvaluation): MonitorEvaluation[] {
  return [...(row.evaluations ?? []), entry].slice(-MAX_EVALUATIONS);
}

export function createMonitorRunner(deps: MonitorRunnerDeps) {
  const { store } = deps;

  async function actorFor(row: MonitorRow): Promise<Actor | undefined> {
    const profile = await store.get<Profile>('profiles', row.actorId);
    if (!profile || !profile.active || profile.id !== row.actorId) return undefined;
    return { ...profile, sessionId: row.sessionId, mode: row.mode, modeRevision: row.modeRevision };
  }

  async function baseContext(row: MonitorRow, actor: Actor, nowMs: number): Promise<MonitorContext | undefined> {
    const plan = row.state.workflow.preview.plan;
    const profiles: Profile[] = [];
    for (const id of plan.recipientIds) {
      const profile = await store.get<Profile>('profiles', id);
      if (!profile) return undefined;
      profiles.push(profile);
    }
    const allowed: string[] = [];
    for (const id of plan.recipientIds) if (await deps.recipientAllowed(actor, id)) allowed.push(id);
    return { authority: authoritySnapshot(actor, allowed), now: nowMs, evidence: row.bound.evidence, claims: row.bound.claims,
      recipients: profiles.map(recipientSnapshot), consents: [row.bound.consent], queries: [row.bound.query] };
  }

  /** Fresh per-branch sales vs target from the registered reader, as a trusted evidence snapshot. */
  async function sample(actor: Actor, row: MonitorRow, nowMs: number): Promise<{ snapshot: EvidenceSnapshot; names: Map<string, string>; date: string }> {
    const { query } = row.bound;
    const rows: { branchId: string; netSales: number; target: number }[] = [];
    const names = new Map<string, string>();
    const sourceIds: string[] = [];
    let fresh = true, observedAt = 0, parsedAll = true;
    for (const region of query.regions) {
      const evidence = await store.transaction(tx => readEvidence(tx, actor, { region, date: deps.businessDate }, new Date(nowMs)));
      for (const metric of evidence.branches) {
        if (!query.branchIds.includes(metric.branchId)) continue;
        rows.push({ branchId: metric.branchId, netSales: metric.netSales, target: metric.target });
        names.set(metric.branchId, metric.branchName);
        for (const system of ['sales', 'targets']) {
          const source = evidence.sources.find(s => s.id === `${system}:${metric.branchId}:${deps.businessDate}`);
          if (!source) { fresh = false; continue; }
          sourceIds.push(source.id);
          if (source.freshness !== 'fresh') fresh = false;
          const at = Date.parse(source.observedAt);
          if (Number.isFinite(at)) observedAt = Math.max(observedAt, at); else parsedAll = false;
        }
      }
    }
    const complete = rows.length === query.branchIds.length && new Set(rows.map(r => r.branchId)).size === rows.length && sourceIds.length === rows.length * 2;
    const body = { date: deps.businessDate, rows: [...rows].sort((a, b) => a.branchId.localeCompare(b.branchId)), observedAt };
    const snapshot: EvidenceSnapshot = { ref: snapshotRef(`monitor_sample:${digest(body).slice(0, 24)}`, 1, body), regions: [...query.regions],
      permissions: ['sales.read', 'operations.read'], fresh: fresh && parsedAll, complete, trust: 'certified', sensitive: false,
      expiresAt: nowMs + 3_600_000, sourceIds: sourceIds.length ? sourceIds : ['none'], observedAt, sales: rows };
    return { snapshot, names, date: deps.businessDate };
  }

  function alertContent(output: NonNullable<MonitorOutput['alert']>, snapshot: EvidenceSnapshot, names: Map<string, string>, threshold: number, date: string): string {
    const lines = output.branchIds.slice(0, 12).map(id => {
      const r = snapshot.sales!.find(s => s.branchId === id)!;
      return `${names.get(id) ?? id}: ยอดขาย ${money(r.netSales)} บาท จากเป้า ${money(r.target)} บาท (${pct(r.netSales / r.target)})`;
    });
    const more = output.branchIds.length > 12 ? [`และอีก ${output.branchIds.length - 12} สาขา`] : [];
    return [`แจ้งเตือนจาก Monitor: ยอดขายต่ำกว่า ${pct(threshold)} ของเป้า ใน ${output.branchIds.length} สาขา (ข้อมูลวันที่ ${date})`, ...lines, ...more].join('\n');
  }

  const holdState = (state: MonitorState): MonitorState => state.lifecycle === 'needs_renewal' ? state : { ...state, version: state.version + 1, lifecycle: 'needs_renewal' };

  async function hold(row: MonitorRow, reason: string, now: Date): Promise<void> {
    await casMonitor(store, row.id, row.rowVersion, now, r => ({ state: holdState(r.state), status: 'monitor_needs_renewal', lastError: reason,
      evaluations: appendEvaluation(r, { at: now.toISOString(), observedAt: null, date: deps.businessDate, checked: 0, breached: 0, outcome: 'held', notified: 0, reason }) }));
  }

  /** One monitor, one tick. Retries once on a CAS conflict (reload + reevaluate). */
  async function evaluate(rowId: string, now: Date): Promise<'evaluated' | 'alerted' | 'held' | 'skipped' | 'error'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = (await store.get<MonitorRow>('tool_executions', rowId));
      if (!row || row.status !== 'monitor_active') return 'skipped';
      const nowMs = now.getTime();
      const last = row.state.lastEvaluatedAt;
      if (last !== null && nowMs - last < effectiveCadenceMs(row)) return 'skipped';
      try {
        const actor = await actorFor(row);
        if (!actor || nowMs >= row.expiresAt) { await hold(row, actor ? 'monitor_expired' : 'owner_inactive', now); return 'held'; }
        const base = await baseContext(row, actor, nowMs);
        if (!base) { await hold(row, 'recipient_missing', now); return 'held'; }
        const taken = await sample(actor, row, nowMs);
        const context: MonitorContext = { ...base, evidence: [...base.evidence, taken.snapshot] };
        const result = runMonitorPlan({ request: { phase: 'evaluate', state: row.state, expectedVersion: row.state.version, evidence: taken.snapshot.ref }, context });
        if (result.outcome !== 'accepted') {
          if (result.outcome === 'permission_denied' || HOLD_CODES.has(result.code)) { await hold(row, `${result.outcome}:${result.code}`, now); return 'held'; }
          const reason = `${result.outcome}:${result.code}`;
          if (row.lastError !== reason) await casMonitor(store, row.id, row.rowVersion, now, () => ({ lastError: reason }));
          return 'skipped';
        }
        const { state, alert } = result.value;
        if (state === row.state || digest(state) === digest(row.state)) return 'skipped';
        const plan = state.workflow.preview.plan;
        const alertId = alert ? inboxRowId(alert.dedupeKey, row.actorId) : null;
        await casMonitor(store, row.id, row.rowVersion, now,
          r => ({ state, status: MONITOR_STATUS_BY_LIFECYCLE[state.lifecycle], lastEvaluatedAt: state.lastEvaluatedAt,
            evaluations: appendEvaluation(r, { at: now.toISOString(), observedAt: new Date(taken.snapshot.observedAt ?? nowMs).toISOString(), date: taken.date,
              checked: row.bound.query.branchIds.length, breached: alert ? alert.branchIds.length : state.history.at(-1)?.breachBranchIds.length ?? 0,
              outcome: state.lifecycle === 'needs_renewal' ? 'held' : alert ? 'alerted' : (state.history.at(-1)?.breachBranchIds.length ?? 0) > 0 ? 'breach_cooldown' : 'ok', notified: alert ? audienceOf(row.actorId, plan.recipientIds).length : 0 }),
            lastError: state.lifecycle === 'needs_renewal' ? 'authority_changed' : null,
            lastAlertId: alertId ?? row.lastAlertId }),
          async (tx) => {
            if (!alert || !alertId || (await tx.get('mock_messages', alertId)) !== undefined) return;
            // Authority is re-read in THIS transaction (the one that writes the alert): owner + every recipient must be unchanged,
            // otherwise nothing is written (state advance included) and the monitor is held below.
            const forbidden = (): never => { throw new DomainError('FORBIDDEN', 'Monitor authority changed before the alert was written', 403); };
            const profile = await tx.get<Profile>('profiles', row.actorId);
            if (!profile || !profile.active || profile.id !== row.actorId) return forbidden();
            const fresh: Actor = { ...profile, sessionId: row.sessionId, mode: row.mode, modeRevision: row.modeRevision };
            if (digest(authoritySnapshot(fresh, base.authority.recipientIds).actor) !== digest(base.authority.actor)) return forbidden();
            for (const id of plan.recipientIds) {
              const recipient = await tx.get<Profile>('profiles', id);
              const bound = base.recipients.find(r => r.ref.id === id);
              if (!recipient || !bound || recipientSnapshot(recipient).ref.digest !== bound.ref.digest || !(await deps.recipientAllowed(fresh, id, tx))) return forbidden();
            }
            // Every approved recipient (and the owner) gets the alert in their own inbox. Each one was re-read and re-authorized above, in THIS
            // transaction; delivery is idempotent per (dedupe key, recipient), so a retried tick cannot deliver twice.
            const content = alertContent(alert, taken.snapshot, taken.names, plan.threshold, taken.date);
            for (const personId of audienceOf(row.actorId, plan.recipientIds)) {
              const person = personId === row.actorId ? profile : await tx.get<Profile>('profiles', personId);
              const messageId = inboxRowId(alert.dedupeKey, personId);
              if (!person || (await tx.get('mock_messages', messageId)) !== undefined) continue;
              await tx.put('mock_messages', inboxRowSchema.parse({ id: messageId, kind: INBOX_KIND, actorId: actor.id, senderName: 'ระบบเฝ้าติดตาม',
                recipientId: personId, source: 'monitor_alert', title: displayTitle(row), content, channelId: 'simulated_inbox',
                // PostgreSQL enforces one mock_messages row per operationKey (mock_message_operation_unique), so each recipient's copy carries
                // its own key; the owner's keeps the bare dedupe key. Idempotency stays on the row id (dedupe key + recipient).
                operationKey: personId === row.actorId ? alert.dedupeKey : recipientOperationKey(alert.dedupeKey, personId), planDigest: state.workflow.preview.planDigest, target: recipientSnapshot(person).ref, createdAt: now.toISOString(), readAt: null, monitorId: row.id }));
            }
          });
        return state.lifecycle === 'needs_renewal' ? 'held' : alert ? 'alerted' : 'evaluated';
      } catch (error) {
        if (error instanceof DomainError && error.code === 'MONITOR_CONFLICT' && attempt === 0) continue;
        if (error instanceof DomainError && (error.code === 'FORBIDDEN' || error.status === 403)) { await hold(row, 'scope_or_permission', now).catch(() => undefined); return 'held'; }
        return 'error';
      }
    }
    return 'error';
  }

  async function tick(options: { limit?: number; budgetMs?: number } = {}): Promise<MonitorTickResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200)), started = Date.now(), budget = options.budgetMs ?? 20_000;
    const rows = (await listActiveMonitors(store)).sort((a, b) => (a.state.lastEvaluatedAt ?? 0) - (b.state.lastEvaluatedAt ?? 0)).slice(0, limit);
    const result: MonitorTickResult = { scanned: rows.length, evaluated: 0, alerts: 0, held: 0, skipped: 0, errors: 0, deadlineReached: false };
    for (const row of rows) {
      if (Date.now() - started > budget) { result.deadlineReached = true; break; }
      const outcome = await evaluate(row.id, deps.now());
      if (outcome === 'alerted') { result.alerts++; result.evaluated++; }
      else if (outcome === 'evaluated') result.evaluated++;
      else if (outcome === 'held') result.held++;
      else if (outcome === 'skipped') result.skipped++;
      else result.errors++;
    }
    return result;
  }

  /** Owner-private lifecycle (direct tier): pause / resume / delete, each a CAS on the monitor row. */
  async function manage(actor: Actor, input: ManageInput, options: { defer?: DeferredWrites; fence?: (tx: Transaction) => Promise<void> } = {}): Promise<ManageResult> {
    const now = deps.now();
    const notFound: ManageResult = { ok: false, code: 'monitor_not_found', text: 'ไม่พบ Monitor ของคุณตามที่ระบุ จึงไม่ได้ดำเนินการ' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await getOwnedMonitor(store, actor, input.monitorId);
      if (!row || row.status === 'monitor_deleted') return notFound;
      try {
        // The CAS write runs now, or (turn-scoped direct writes) inside the turn's completion transaction via `defer`.
        // Metadata-only audit (kind, monitor id, operation; never user text), written in the SAME transaction as the CAS, for every path
        // (UI route, direct AI turn, staged delete confirm) because they all run through this function.
        const auditOp = async (tx: Transaction): Promise<void> => {
          // Final-actor reauthorization in the mutation transaction (route AND deferred chat write) for pause / resume; an owner may always delete their own Monitor (stops alerts).
          if (input.op !== 'delete') await assertMonitorManager(tx, actor.id);
          await tx.put('audit_events', { id: `audit_monitor_${crypto.randomUUID()}`, actorId: actor.id, category: 'monitor_manage', summary: `monitor.${input.op}`, actionId: row.id, createdAt: now.toISOString() });
        };
        const commit = async (change: (target: Store) => Promise<unknown>, text: string): Promise<ManageResult> => {
          if (options.defer) { options.defer.push(async (tx, finalActor) => { if (finalActor.id !== actor.id) throw new DomainError('FORBIDDEN', 'Final actor changed', 403); await change(transactionAsStore(tx, store)); }); return { ok: true, text }; }
          await change(store);
          return { ok: true, text };
        };
        const ownedBy = (r: MonitorRow) => { if (r.actorId !== actor.id) throw new DomainError('MONITOR_NOT_FOUND', 'Monitor not found', 404); };
        if (input.op === 'delete') {
          // A staged delete's claim/session-mode fence runs in the same transaction as the write (it rolls the write back).
          return commit(target => casMonitor(target, row.id, row.rowVersion, now, r => { ownedBy(r); return { status: 'monitor_deleted' }; },
            async tx => { if (options.fence) await options.fence(tx); await auditOp(tx); }),
            `ลบ Monitor “${row.title}” แล้ว จะไม่มีการแจ้งเตือนอีก`);
        }
        if (row.state.lifecycle === 'needs_renewal')
          return { ok: false, code: 'monitor_needs_renewal', text: 'Monitor นี้ต้องสร้างใหม่ (สิทธิ์ ผู้รับ หรือหลักฐานเปลี่ยนไป) จึงหยุดหรือเริ่มต่อไม่ได้' };
        // Fresh precheck of the CURRENT owner grants (the same check re-runs inside the mutation transaction).
        try { await assertMonitorManager(store, actor.id); }
        catch (error) { if (error instanceof DomainError && error.code === 'FORBIDDEN') return { ok: false, code: 'forbidden', text: error.message }; throw error; }
        const target = input.op === 'pause' ? 'paused' : 'active';
        if (row.state.lifecycle === target) return { ok: true, text: input.op === 'pause' ? `Monitor “${row.title}” หยุดอยู่แล้ว` : `Monitor “${row.title}” ทำงานอยู่แล้ว` };
        let next: MonitorState | undefined;
        const base = await baseContext(row, actor, now.getTime());
        if (base) {
          const r = runMonitorPlan({ request: { phase: input.op, state: row.state, expectedVersion: row.state.version }, context: base });
          if (r.outcome === 'accepted') next = r.value.state;
        }
        // Pausing is always safe: if the full re-validation fails, stop the monitor anyway.
        if (!next && input.op === 'pause') next = { ...row.state, version: row.state.version + 1, lifecycle: 'paused' };
        if (!next) return { ok: false, code: 'monitor_needs_renewal', text: 'ตรวจสิทธิ์หรือหลักฐานของ Monitor นี้ไม่ผ่านแล้ว จึงเริ่มต่อไม่ได้ — โปรดสร้างใหม่' };
        const state = next;
        return commit(target => casMonitor(target, row.id, row.rowVersion, now, r => { ownedBy(r); return { state, status: MONITOR_STATUS_BY_LIFECYCLE[state.lifecycle] }; }, auditOp),
          input.op === 'pause' ? `หยุด Monitor “${row.title}” ชั่วคราวแล้ว` : `เริ่ม Monitor “${row.title}” ต่อแล้ว`);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'MONITOR_CONFLICT' && attempt === 0) continue;
        if (error instanceof DomainError && error.code === 'MONITOR_NOT_FOUND') return notFound;
        throw error;
      }
    }
    return { ok: false, code: 'monitor_conflict', text: 'Monitor เปลี่ยนระหว่างดำเนินการ — ลองอีกครั้ง' };
  }

  /**
   * One bounded page of the owner's monitors with the persisted evaluation history (newest first). Search/status selection runs BEFORE the
   * page boundary, `total` is exact, and `deleted: true` lists the owner's deleted monitors, whose retained evaluations stay readable.
   */
  async function historyPage(actor: Actor, opts: PageInput & { needle?: string; deleted?: boolean } = {}): Promise<Page<MonitorHistoryItem>> {
    const rows = await listOwnedMonitors(store, actor, opts.deleted ? ['monitor_deleted'] : undefined);
    const wanted = opts.needle?.trim().toLocaleLowerCase('th-TH');
    const selected = wanted ? rows.filter(r => displayTitle(r).toLocaleLowerCase('th-TH').includes(wanted)) : rows;
    const page = paginate(selected, r => sortKey(r.createdAt, r.id), opts, { limit: 10 });
    return { ...page, items: page.items.map(r => ({ id: r.id, title: displayTitle(r), status: r.status, lifecycle: r.state.lifecycle,
      cadence: effectiveCadenceMs(r) >= 79_200_000 ? 'daily' : 'hourly', recipientCount: r.state.workflow.preview.plan.recipientIds.length, lastEvaluatedAt: r.state.lastEvaluatedAt === null ? null : new Date(r.state.lastEvaluatedAt).toISOString(),
      lastError: r.lastError, expiresAt: new Date(r.expiresAt).toISOString(), evaluations: [...(r.evaluations ?? [])].reverse().slice(0, 15),
      threshold: r.state.workflow.preview.plan.threshold, cooldown: r.state.workflow.preview.plan.cooldownId === 'one_hour' ? 'one_hour' : 'one_day' })) };
  }
  /** The newest page (compat). */
  async function history(actor: Actor): Promise<MonitorHistoryItem[]> { return (await historyPage(actor)).items; }

  async function list(actor: Actor): Promise<MonitorListItem[]> {
    return (await listOwnedMonitors(store, actor)).slice(0, 10).map(r => ({ id: r.id, title: displayTitle(r), status: r.status }));
  }
  /** Owner-scoped title search over ALL retained (non-deleted) monitors, newest first: exact `total`, window [offset, offset + limit). */
  async function search(actor: Actor, opts: { needle: string; offset: number; limit: number }): Promise<{ items: (MonitorListItem & { createdAt: string })[]; total: number }> {
    const wanted = opts.needle.trim().toLocaleLowerCase('th-TH');
    const rows = (await listOwnedMonitors(store, actor)).filter(r => !wanted || r.id === opts.needle.trim() || displayTitle(r).toLocaleLowerCase('th-TH').includes(wanted));
    return { total: rows.length, items: rows.slice(opts.offset, opts.offset + opts.limit).map(r => ({ id: r.id, title: displayTitle(r), status: r.status, createdAt: r.createdAt })) };
  }
  /** One exact retained (non-deleted) monitor of this owner, whatever its age (selection verification). */
  async function find(actor: Actor, monitorId: string): Promise<MonitorListItem | undefined> {
    const row = await getOwnedMonitor(store, actor, monitorId);
    return row && row.status !== 'monitor_deleted' ? { id: row.id, title: displayTitle(row), status: row.status } : undefined;
  }

  return { tick, manage, list, evaluate, history, historyPage, search, find };
}
export type MonitorRunner = ReturnType<typeof createMonitorRunner>;

/**
 * Legacy hourly monitors (stored before the daily scheduler) are migrated on read: the only scheduler is the daily cron,
 * so they are evaluated on the daily cadence and every listing says so truthfully (never "hourly").
 */
export function isLegacyHourly(row: Pick<MonitorRow, 'state'>): boolean {
  return row.state.workflow.preview.plan.cadenceId === 'hourly';
}
export function effectiveCadenceMs(row: Pick<MonitorRow, 'state'>): number {
  return isLegacyHourly(row) ? monitorRegistry.cadence.daily
    : monitorRegistry.cadence[row.state.workflow.preview.plan.cadenceId as keyof typeof monitorRegistry.cadence] ?? monitorRegistry.cadence.daily;
}
export function displayTitle(row: Pick<MonitorRow, 'state' | 'title'>): string {
  return isLegacyHourly(row) ? `${row.title} (ตรวจวันละครั้ง — เดิมตั้งเป็นรายชั่วโมง)` : row.title;
}
