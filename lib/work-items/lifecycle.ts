import { z } from 'zod';
import type { Actor, Branch, Employee, Profile, Reader, Receipt, Store, Ticket } from '../contracts';
import { listByIds } from '../storage/batch';
import { DomainError } from '../core/errors';
import { extractTicketPlan } from '../core/ticket-plan-text';
import { paginate, sortKey, type Page, type PageInput } from '../pagination';
import { personLabel } from '../router/context/display';
import { createWorkItemEffects, PRIORITIES, workItemRowSchema, WORK_ITEM_STATUS, type WorkItemRow } from '../router/ports/work-items';

/**
 * Lifecycle overlay for work items. The original `router.work_item` row (written by the confirmed task.create plan) is immutable;
 * every later change lives in ONE overlay row per item (`work-item-state:<id>`, status `work_item_state`) guarded by a revision CAS, and
 * every accepted change also appends ONE small immutable transition record (`work-item-transition:<id>:<revision>`) in the same
 * transaction. An absent overlay means: open, revision 0, no edits. The same business rules serve the UI route and any future executor.
 *
 * Who may do what (all rechecked against CURRENT profiles inside the transaction):
 *  - creator  (holds ticket.create): complete / reopen / cancel / archive / edit (incl. confirmed reassignment, branch scope rechecked);
 *  - assignee (current assignee, active, region covers the item's branches): view + complete / reopen only (audited);
 *  - legacy `ticket.create` Tickets (`mock_tickets`, never rewritten): the creator (proven by the verified creation receipt) gets the same
 *    lifecycle through the SAME overlay; their assignees are employees (no login), so there is no assignee role for them.
 */
export const WORK_ITEM_STATE_TOOL = 'router.work_item_state' as const;
export const WORK_ITEM_STATE_STATUS = 'work_item_state' as const;
export const WORK_ITEM_TRANSITION_TOOL = 'router.work_item_transition' as const;
export const WORK_ITEM_TRANSITION_STATUS = 'work_item_transition' as const;
export const WORK_ITEM_STATES = ['open', 'completed', 'cancelled', 'archived'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
export const WORK_ITEM_OPS = ['complete', 'reopen', 'cancel', 'archive', 'edit', 'unarchive'] as const;
export type WorkItemOp = (typeof WORK_ITEM_OPS)[number];
export const ASSIGNEE_OPS: readonly WorkItemOp[] = ['complete', 'reopen'];
export const workItemStateRowId = (workItemId: string): string => `work-item-state:${workItemId}`;
export const workItemTransitionRowId = (workItemId: string, revision: number): string => `work-item-transition:${workItemId}:${revision}`;
const MAX_HISTORY = 100;

/** Same field rules as taskFieldsSchema (title<=120, priority enum, yyyy-mm-dd|null, checklist<=8x120, note<=300). */
const editableShape = {
  title: z.string().trim().min(1).max(120), priority: z.enum(PRIORITIES), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  checklist: z.array(z.string().trim().min(1).max(120)).max(8), note: z.string().trim().max(300).nullable(), assigneeId: z.string().min(1).max(200),
};
export const editFieldsSchema = z.object(editableShape).partial().strict();
export type EditFields = z.infer<typeof editFieldsSchema>;

const overlaySchema = z.object({
  id: z.string().min(1).max(220), name: z.literal(WORK_ITEM_STATE_TOOL), status: z.literal(WORK_ITEM_STATE_STATUS), actorId: z.string().min(1).max(200),
  workItemId: z.string().min(1).max(200), state: z.enum(WORK_ITEM_STATES), revision: z.number().int().min(1), updatedAt: z.string(),
  edits: editFieldsSchema, completedAt: z.string().nullable(), cancelledAt: z.string().nullable(), archivedAt: z.string().nullable(),
}).strict();
type Overlay = z.infer<typeof overlaySchema>;

const transitionSchema = z.object({
  id: z.string().min(1).max(260), name: z.literal(WORK_ITEM_TRANSITION_TOOL), status: z.literal(WORK_ITEM_TRANSITION_STATUS),
  /** the person who performed the change */
  actorId: z.string().min(1).max(200), workItemId: z.string().min(1).max(200), role: z.enum(['creator', 'assignee']),
  op: z.enum(WORK_ITEM_OPS), from: z.enum(WORK_ITEM_STATES), to: z.enum(WORK_ITEM_STATES), revision: z.number().int().min(1), at: z.string(),
  /** edit only: the NAMES of the changed fields (never their values) and, for a reassignment, the old/new assignee ids */
  changed: z.array(z.string().max(20)).max(8).optional(), assigneeFrom: z.string().max(200).optional(), assigneeTo: z.string().max(200).optional(),
}).strict();
type Transition = z.infer<typeof transitionSchema>;

export type WorkItemKind = 'task' | 'ticket';
export interface ManagedWorkItem {
  id: string; kind: WorkItemKind; title: string; priority: string; dueDate: string | null; grouping: string; checklist: string[]; branchIds: string[]; note: string | null;
  /** assigned to the viewer */
  mine: boolean; createdByMe: boolean; assigneeId: string; assigneeLabel: string; creatorLabel: string;
  /** legacy Tickets: the stored reason */
  detail: string | null;
  createdAt: string; state: WorkItemState; revision: number; updatedAt: string;
  /** the operations THIS viewer may perform right now in the item's current state (the server enforces the same rule on every write) */
  allowedOps: WorkItemOp[];
}
export interface WorkItemTransitionView { revision: number; op: WorkItemOp; from: WorkItemState; to: WorkItemState; at: string; actorLabel: string; role: 'creator' | 'assignee'; changed?: string[]; assigneeFrom?: string; assigneeTo?: string }
export interface WorkItemLifecycleDeps { store: Store; now: () => Date; recipientAllowed: (actor: Actor, recipientId: string, reader?: Reader) => Promise<boolean> }
export interface WorkItemOpInput { op: WorkItemOp; baseRevision: number; fields?: EditFields; confirmAssigneeChange?: boolean }
export type WorkItemScope = 'created' | 'assigned' | 'tickets';
export interface WorkItemListOptions { includeArchived?: boolean; /** archived items only (the archive section) */ archivedOnly?: boolean; scope?: WorkItemScope; needle?: string }

const parseOverlay = (raw: unknown): Overlay | undefined => { const r = overlaySchema.safeParse(raw); return r.success ? r.data : undefined; };
const parseTransition = (raw: unknown): Transition | undefined => { const r = transitionSchema.safeParse(raw); return r.success ? r.data : undefined; };
const parseTask = (raw: unknown): WorkItemRow | undefined => { const r = workItemRowSchema.safeParse(raw); return r.success ? r.data : undefined; };
const notFound = () => new DomainError('NOT_FOUND', 'ไม่พบงานของคุณตามที่ระบุ', 404);
const regionAllowed = (p: Pick<Profile, 'active' | 'regions'>, region: string): boolean => p.active && (p.regions.includes('*') || p.regions.includes(region));

/** One item as the lifecycle sees it, whichever storage it came from (tasks: `tool_executions`; legacy Tickets: `mock_tickets`). */
interface BaseItem {
  kind: WorkItemKind; id: string; creatorId: string; assigneeId: string; title: string; priority: string; dueDate: string | null; grouping: string;
  checklist: string[]; branchIds: string[]; note: string | null; detail: string | null; createdAt: string;
}
const assigneeOf = (base: BaseItem, overlay?: Overlay): string => overlay?.edits.assigneeId ?? base.assigneeId;
const fromTask = (row: WorkItemRow): BaseItem => ({ kind: 'task', id: row.id, creatorId: row.actorId, assigneeId: row.assigneeId, title: row.title, priority: row.priority, dueDate: row.dueDate,
  grouping: row.grouping, checklist: row.checklist, branchIds: row.branchIds, note: row.note, detail: null, createdAt: row.createdAt });
function fromTicket(ticket: Ticket, creatorId: string): BaseItem {
  const plan = extractTicketPlan(ticket.unansweredQuestion);
  return { kind: 'ticket', id: ticket.id, creatorId, assigneeId: ticket.assigneeId, title: ticket.title, priority: plan?.priority ?? 'normal', dueDate: plan?.dueDate ?? null,
    grouping: plan?.grouping ?? 'single', checklist: plan?.checklist ?? [], branchIds: plan?.coveredBranchIds ? [...plan.coveredBranchIds] : [ticket.branchId], note: plan?.note ?? null,
    detail: ticket.reason, createdAt: ticket.createdAt };
}

/** Legacy Tickets the actor created: proven by their own verified `ticket_create` receipt (the ticket row itself carries no creator). */
async function ticketIdsCreatedBy(reader: Reader, actor: Actor): Promise<string[]> {
  const receipts = await reader.list<Receipt>('action_executions', { actorId: actor.id });
  const ids = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.actorId !== actor.id || receipt.kind !== 'ticket_create') continue;
    for (const result of receipt.results ?? []) if (result.status === 'verified_success' && typeof result.id === 'string') ids.add(result.id);
  }
  return [...ids];
}
const isLegacyTicket = (row: unknown): row is Ticket => { const t = row as Partial<Ticket> | undefined; return !!t && typeof t.operationKey === 'string' && typeof t.assigneeId === 'string' && typeof t.branchId === 'string' && typeof t.unansweredQuestion === 'string'; };

/** Display names (profiles for task assignees, employees for legacy Ticket assignees). Read once per call. */
async function labeler(reader: Reader): Promise<(id: string) => string> {
  const [profiles, employees] = await Promise.all([reader.list<Profile>('profiles'), reader.list<Employee>('employees')]);
  const byProfile = new Map(profiles.map(p => [p.id, personLabel(p)])), byEmployee = new Map(employees.map(e => [e.id, e.name]));
  return id => byProfile.get(id) ?? byEmployee.get(id) ?? id;
}

function opsFor(role: 'creator' | 'assignee', state: WorkItemState): WorkItemOp[] {
  const all: WorkItemOp[] = state === 'open' ? ['complete', 'edit', 'cancel'] : state === 'completed' ? ['reopen', 'archive'] : state === 'cancelled' ? ['archive'] : ['unarchive'];
  return role === 'creator' ? all : all.filter(op => ASSIGNEE_OPS.includes(op));
}
function view(actor: Actor, base: BaseItem, overlay: Overlay | undefined, label: (id: string) => string): ManagedWorkItem {
  const e = overlay?.edits ?? {}, assignee = assigneeOf(base, overlay), state = overlay?.state ?? 'open';
  const createdByMe = base.creatorId === actor.id;
  return { id: base.id, kind: base.kind, title: e.title ?? base.title, priority: e.priority ?? base.priority, dueDate: e.dueDate !== undefined ? e.dueDate : base.dueDate,
    grouping: base.grouping, checklist: e.checklist ?? base.checklist, branchIds: base.branchIds, note: e.note !== undefined ? e.note : base.note,
    mine: assignee === actor.id, createdByMe, assigneeId: assignee, assigneeLabel: label(assignee), creatorLabel: label(base.creatorId), detail: base.detail,
    createdAt: base.createdAt, state, revision: overlay?.revision ?? 0, updatedAt: overlay?.updatedAt ?? base.createdAt,
    allowedOps: opsFor(createdByMe ? 'creator' : 'assignee', state) };
}

/** Every item this actor may see in `scope`, with its lifecycle applied (unfiltered by archive/search; callers narrow before paging). */
async function collect(store: Store, actor: Actor, scope: WorkItemScope): Promise<ManagedWorkItem[]> {
  const [label, overlayRows] = await Promise.all([
    labeler(store),
    store.list<unknown>('tool_executions', scope === 'created' || scope === 'tickets' ? { actorId: actor.id, status: WORK_ITEM_STATE_STATUS } : { status: WORK_ITEM_STATE_STATUS }),
  ]);
  const overlays = new Map<string, Overlay>();
  for (const raw of overlayRows) { const o = parseOverlay(raw); if (o && o.id === workItemStateRowId(o.workItemId)) overlays.set(o.workItemId, o); }
  if (scope === 'tickets') {
    const ids = await ticketIdsCreatedBy(store, actor);
    const [profile, rows] = await Promise.all([store.get<Profile>('profiles', actor.id), listByIds<unknown>(store, 'mock_tickets', ids)]);
    const tickets = rows.filter(isLegacyTicket).filter(row => ids.includes(row.id));
    const bases = tickets.map(row => fromTicket(row, actor.id));
    const branches = new Map((await listByIds<Branch>(store, 'branches', bases.flatMap(base => base.branchIds))).map(branch => [branch.id, branch]));
    const items: ManagedWorkItem[] = [];
    for (const base of bases) {
      if (profile && !(await branchesInScope(store, profile, base.branchIds, branches))) continue;
      items.push(view(actor, base, overlays.get(base.id), label));
    }
    return items;
  }
  if (scope === 'created') {
    const rows = (await store.list<unknown>('tool_executions', { actorId: actor.id, status: WORK_ITEM_STATUS })).map(parseTask).filter((r): r is WorkItemRow => !!r && r.actorId === actor.id);
    return rows.map(row => view(actor, fromTask(row), overlays.get(row.id), label));
  }
  // assigned to me by someone else: scan task rows of every creator (bounded by the retained dataset), then apply the CURRENT assignee (overlay edits win)
  const profile = await store.get<Profile>('profiles', actor.id);
  const rows = (await store.list<unknown>('tool_executions', { status: WORK_ITEM_STATUS })).map(parseTask).filter((r): r is WorkItemRow => !!r);
  const candidates = rows.filter(row => row.actorId !== actor.id && assigneeOf(fromTask(row), overlays.get(row.id)) === actor.id);
  const branches = new Map((await listByIds<Branch>(store, 'branches', candidates.flatMap(row => fromTask(row).branchIds))).map(branch => [branch.id, branch]));
  const items: ManagedWorkItem[] = [];
  for (const row of candidates) {
    const base = fromTask(row), overlay = overlays.get(row.id);
    if (row.actorId === actor.id || assigneeOf(base, overlay) !== actor.id) continue;
    if (!profile?.active || !profile.permissions.includes('sales.read') || !(await branchesInScope(store, profile, base.branchIds, branches))) continue;
    items.push(view(actor, base, overlay, label));
  }
  return items;
}

async function branchesInScope(reader: Reader, profile: Pick<Profile, 'active' | 'regions'>, branchIds: readonly string[], branches?: ReadonlyMap<string, Branch>): Promise<boolean> {
  if (!profile.active) return false;
  for (const id of new Set(branchIds)) {
    const branch = branches ? branches.get(id) : await reader.get<Branch>('branches', id);
    // Fail closed: a branch that cannot be resolved is never "authorized by default".
    if (!branch || !regionAllowed(profile, branch.region)) return false;
  }
  return true;
}
/** An assignee reads/acts on an item only while they still hold the sales read grant (the recipient-policy grant) AND the item's branches are in their region. */
const assigneeMayReach = async (reader: Reader, profile: Pick<Profile, 'active' | 'regions' | 'permissions'>, branchIds: readonly string[]): Promise<boolean> =>
  profile.active && profile.permissions.includes('sales.read') && await branchesInScope(reader, profile, branchIds);

/**
 * One bounded page of this actor's items. Archive and search selection happen BEFORE the page boundary, so archiving the newest
 * items never hides older open ones; `total` is the exact size of the selection (never the page length).
 */
export async function listManagedWorkItemsPage(store: Store, actor: Actor, opts: WorkItemListOptions & PageInput = {}): Promise<Page<ManagedWorkItem>> {
  const all = await collect(store, actor, opts.scope ?? 'created');
  const wanted = opts.needle?.trim().toLocaleLowerCase('th-TH');
  const selected = all.filter(item => (opts.archivedOnly ? item.state === 'archived' : opts.includeArchived || item.state !== 'archived')
    && (!wanted || [item.title, item.note ?? '', item.assigneeLabel, item.detail ?? ''].some(field => field.toLocaleLowerCase('th-TH').includes(wanted))));
  return paginate(selected, item => sortKey(item.createdAt, item.id), opts, { limit: 50 });
}
/** Every item the actor created (compat helper for callers that need the whole selection). Archived only with `includeArchived`. */
export async function listManagedWorkItems(store: Store, actor: Actor, opts: { includeArchived?: boolean } = {}): Promise<ManagedWorkItem[]> {
  return (await collect(store, actor, 'created')).filter(item => opts.includeArchived || item.state !== 'archived')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

const TRANSITIONS: Record<Exclude<WorkItemOp, 'edit'>, { from: readonly WorkItemState[]; to: WorkItemState }> = {
  complete: { from: ['open'], to: 'completed' }, cancel: { from: ['open'], to: 'cancelled' },
  reopen: { from: ['completed'], to: 'open' }, archive: { from: ['completed', 'cancelled'], to: 'archived' },
  // Unarchive returns the item to the state it was archived from (cancelled when it was cancelled, else completed); the real target is resolved below.
  unarchive: { from: ['archived'], to: 'completed' },
};

/** The item as THIS actor may reach it (creator or current assignee; legacy Tickets: creator by receipt), or undefined. Works on a store or a transaction. */
async function resolve(reader: Reader, actor: Actor, workItemId: string): Promise<{ base: BaseItem; overlay: Overlay | undefined; role: 'creator' | 'assignee' } | undefined> {
  const rawOverlay = await reader.get<unknown>('tool_executions', workItemStateRowId(workItemId));
  const overlay = rawOverlay === undefined ? undefined : parseOverlay(rawOverlay);
  if (rawOverlay !== undefined && !overlay) return undefined;
  const task = parseTask(await reader.get<unknown>('tool_executions', workItemId));
  if (task) {
    const base = fromTask(task);
    return base.creatorId === actor.id ? { base, overlay, role: 'creator' } : assigneeOf(base, overlay) === actor.id ? { base, overlay, role: 'assignee' } : undefined;
  }
  const ticket = await reader.get<unknown>('mock_tickets', workItemId);
  if (!isLegacyTicket(ticket) || ticket.id !== workItemId || !(await ticketIdsCreatedBy(reader, actor)).includes(workItemId)) return undefined;
  return { base: fromTicket(ticket, actor.id), overlay, role: 'creator' };
}

/** One lifecycle operation, fully re-validated inside a single transaction (fresh actor, role, branch scope, revision CAS). Returns the new view. */
export async function applyWorkItemOp(deps: WorkItemLifecycleDeps, actor: Actor, workItemId: string, input: WorkItemOpInput): Promise<ManagedWorkItem> {
  const { store } = deps;
  const effects = createWorkItemEffects({ store, now: deps.now, recipientAllowed: deps.recipientAllowed });
  return store.transaction(async tx => {
    const profile = await tx.get<Profile>('profiles', actor.id);
    if (!profile?.active || profile.id !== actor.id) throw new DomainError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์จัดการงานนี้', 403);
    const found = await resolve(tx, actor, workItemId);
    if (!found) throw notFound();
    const { base, overlay, role } = found;
    if (role === 'creator') {
      if (!profile.permissions.includes('ticket.create')) throw new DomainError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์จัดการงานนี้', 403);
      if (base.kind === 'ticket' && !(await branchesInScope(tx, profile, base.branchIds))) throw new DomainError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ในสาขาของงานนี้แล้ว', 403);
    } else {
      // The assignee only ever acts on an item whose branches are inside their CURRENT region authority.
      if (!(await assigneeMayReach(tx, profile, base.branchIds))) throw new DomainError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ในสาขาของงานนี้แล้ว', 403);
      if (!ASSIGNEE_OPS.includes(input.op)) throw new DomainError('FORBIDDEN', 'ผู้รับงานทำได้เฉพาะทำเครื่องหมายว่าเสร็จหรือเปิดงานอีกครั้ง', 403);
    }
    const state: WorkItemState = overlay?.state ?? 'open', revision = overlay?.revision ?? 0;
    if (input.op === 'complete' && state === 'completed') return view(actor, base, overlay, await labeler(tx)); // idempotent: no write, no revision bump
    if (input.baseRevision !== revision) throw new DomainError('WORK_ITEM_CHANGED', 'งานนี้ถูกแก้ไขไปแล้ว โหลดข้อมูลล่าสุดแล้วลองอีกครั้ง', 409);
    const now = deps.now().toISOString();
    const next: Overlay = { id: workItemStateRowId(workItemId), name: WORK_ITEM_STATE_TOOL, status: WORK_ITEM_STATE_STATUS, actorId: base.creatorId, workItemId,
      state, revision: revision + 1, updatedAt: now, edits: { ...(overlay?.edits ?? {}) }, completedAt: overlay?.completedAt ?? null, cancelledAt: overlay?.cancelledAt ?? null, archivedAt: overlay?.archivedAt ?? null };
    const record: Transition = { id: workItemTransitionRowId(workItemId, revision + 1), name: WORK_ITEM_TRANSITION_TOOL, status: WORK_ITEM_TRANSITION_STATUS, actorId: actor.id, workItemId,
      role, op: input.op, from: state, to: state, revision: revision + 1, at: now };
    if (input.op === 'edit') {
      if (state !== 'open') throw new DomainError('INVALID_TRANSITION', 'แก้ไขได้เฉพาะงานที่ยังเปิดอยู่', 409);
      const fields = editFieldsSchema.parse(input.fields ?? {});
      if (!Object.keys(fields).length) throw new DomainError('INVALID_INPUT', 'ไม่มีข้อมูลที่ต้องแก้ไข', 400);
      record.changed = Object.keys(fields);
      if (fields.assigneeId !== undefined && fields.assigneeId !== assigneeOf(base, overlay)) {
        if (base.kind === 'ticket') throw new DomainError('INVALID_INPUT', 'Ticket นี้เปลี่ยนผู้รับผ่านหน้านี้ไม่ได้', 400);
        // Same hardened helper the creation path uses: creator AND new assignee must hold CURRENT authority over EVERY stored branch of the item (same transaction as the write).
        if (!(await effects.authorize(actor, fields.assigneeId, tx, base.branchIds)).ok) throw new DomainError('AUTHORITY_CHANGED', 'ไม่มีสิทธิ์มอบหมายงานให้ผู้รับคนนี้', 403);
        if (input.confirmAssigneeChange !== true) throw new DomainError('CONFIRMATION_REQUIRED', 'การเปลี่ยนผู้รับงานต้องยืนยันอีกครั้ง', 409);
        record.assigneeFrom = assigneeOf(base, overlay); record.assigneeTo = fields.assigneeId;
      }
      next.edits = { ...next.edits, ...fields };
    } else {
      const rule = TRANSITIONS[input.op];
      if (!rule.from.includes(state)) throw new DomainError('INVALID_TRANSITION', 'ไม่สามารถเปลี่ยนสถานะงานนี้ได้', 409);
      const to: WorkItemState = input.op === 'unarchive' ? (overlay?.cancelledAt ? 'cancelled' : 'completed') : rule.to;
      next.state = to; record.to = to;
      if (input.op !== 'unarchive' && to === 'completed') next.completedAt = now;
      if (input.op !== 'unarchive' && to === 'cancelled') next.cancelledAt = now;
      if (to === 'archived') next.archivedAt = now;
      if (to === 'open') next.completedAt = null;
      if (input.op === 'unarchive') next.archivedAt = null;
    }
    await tx.put('tool_executions', overlaySchema.parse(next));
    await tx.put('tool_executions', transitionSchema.parse(record));
    const operationLabels = { edit: 'แก้ไขงาน', complete: 'ทำเครื่องหมายว่าเสร็จ', reopen: 'เปิดงานอีกครั้ง', cancel: 'ยกเลิกงาน', archive: 'เก็บงานถาวร', unarchive: 'นำงานกลับมา' };
    await tx.put('audit_events', { id: `audit_${record.id}`, actorId: actor.id, actionId: workItemId,
      category: 'update', summary: `${base.kind === 'ticket' ? 'Ticket' : 'งานติดตาม'}: ${operationLabels[input.op]}แล้ว`, createdAt: now });
    return view(actor, base, next, await labeler(tx));
  });
}

/** Exact detail of one item for its creator or current assignee, with the ordered, attributable transition history. */
export async function getWorkItemDetail(store: Store, actor: Actor, workItemId: string): Promise<{ item: ManagedWorkItem; history: WorkItemTransitionView[]; /** true when older revisions than `historyFromRevision` exist but are not listed */ historyTruncated: boolean; historyFromRevision: number }> {
  const profile = await store.get<Profile>('profiles', actor.id);
  const found = profile?.active ? await resolve(store, actor, workItemId) : undefined;
  if (!found) throw notFound();
  if (found.role === 'assignee' && !(await assigneeMayReach(store, profile!, found.base.branchIds))) throw notFound();
  if (found.role === 'creator' && found.base.kind === 'ticket' && !(await branchesInScope(store, profile!, found.base.branchIds))) throw notFound();
  const label = await labeler(store);
  const item = view(actor, found.base, found.overlay, label);
  const history: WorkItemTransitionView[] = [];
  // Latest window: the most recent MAX_HISTORY revisions (never the oldest), with an explicit marker when older ones are omitted.
  const fromRevision = Math.max(1, item.revision - MAX_HISTORY + 1);
  const transitionIds = Array.from({ length: Math.max(0, item.revision - fromRevision + 1) }, (_, index) => workItemTransitionRowId(workItemId, fromRevision + index));
  const transitions = new Map((await listByIds<unknown>(store, 'tool_executions', transitionIds)).flatMap(raw => {
    const row = parseTransition(raw); return row ? [[row.id, row] as const] : [];
  }));
  for (let revision = fromRevision; revision <= item.revision; revision++) {
    const row = transitions.get(workItemTransitionRowId(workItemId, revision));
    if (!row || row.workItemId !== workItemId) continue;
    history.push({ revision: row.revision, op: row.op, from: row.from, to: row.to, at: row.at, actorLabel: label(row.actorId), role: row.role,
      ...(row.changed ? { changed: row.changed } : {}), ...(row.assigneeFrom ? { assigneeFrom: label(row.assigneeFrom) } : {}), ...(row.assigneeTo ? { assigneeTo: label(row.assigneeTo) } : {}) });
  }
  return { item, history, historyTruncated: fromRevision > 1, historyFromRevision: fromRevision };
}
