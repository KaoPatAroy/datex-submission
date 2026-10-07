import { z } from 'zod';
import type { Actor, Branch, Profile, Reader, Store } from '../../contracts';
import { DomainError } from '../../core/errors';
import { digest } from '../../dynamic/shared';
import { refSchema } from '../../dynamic/plan/schemas';
import type { EffectFence } from '../executors/action-ports';
import { INBOX_KIND, inboxRowId, inboxRowSchema } from './effect-store';
import { recipientSnapshot } from './effect-snapshots';
import { personLabel } from '../context/display';

/**
 * Work items created by the registered `task.create` ActionPlan (priority, due date, grouping, checklist, note). Stored on the
 * existing `tool_executions` table (status `work_item`, owner-scoped by `actorId`); created only through a confirmed, claimed
 * router proposal, inside one transaction that re-authorizes the creator and the assignee.
 */
export const WORK_ITEM_TOOL = 'router.work_item' as const;
export const WORK_ITEM_STATUS = 'work_item' as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const GROUPINGS = ['single', 'per_branch'] as const;
export const PRIORITY_LABEL: Record<(typeof PRIORITIES)[number], string> = { low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วน' };

export const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120), priority: z.enum(PRIORITIES), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  grouping: z.enum(GROUPINGS), checklist: z.array(z.string().trim().min(1).max(120)).max(8), branchIds: z.array(z.string().min(1).max(100)).max(12),
  assigneeId: z.string().min(1).max(200), note: z.string().trim().max(300).nullable(),
}).strict().refine(f => f.grouping === 'single' || f.branchIds.length > 0, { message: 'per_branch grouping needs branches' });
export type TaskFields = z.infer<typeof taskFieldsSchema>;

export const workItemRowSchema = z.object({
  id: z.string().min(1).max(200), name: z.literal(WORK_ITEM_TOOL), status: z.literal(WORK_ITEM_STATUS), actorId: z.string().min(1).max(200),
  assigneeId: z.string().min(1).max(200), proposalId: z.string().min(1).max(200), operationKey: z.string().min(1).max(200),
  title: z.string().max(200), priority: z.enum(PRIORITIES), dueDate: z.string().nullable(), grouping: z.enum(GROUPINGS), checklist: z.array(z.string().max(120)).max(8),
  branchIds: z.array(z.string().max(100)).max(12), note: z.string().max(300).nullable(), state: z.literal('open'), createdAt: z.string(), digest: z.string(),
}).strict();
export type WorkItemRow = z.infer<typeof workItemRowSchema>;
export const workItemRowId = (operationKey: string, group: string): string => `work-item:${digest({ operationKey, group }).slice(0, 32)}`;
const parse = (raw: unknown): WorkItemRow | undefined => { const r = workItemRowSchema.safeParse(raw); return r.success ? r.data : undefined; };

/** The items one task plan expands to: one for `single`, one per branch for `per_branch` (the branch ids stay with each item). */
export function expandTask(fields: TaskFields): { group: string; title: string; branchIds: string[] }[] {
  return fields.grouping === 'per_branch' ? fields.branchIds.map(id => ({ group: id, title: `${fields.title} · ${id}`.slice(0, 200), branchIds: [id] }))
    : [{ group: 'all', title: fields.title, branchIds: [...fields.branchIds] }];
}

const regionAllowed = (p: Pick<Profile, 'active' | 'regions'>, region: string): boolean => p.active && (p.regions.includes('*') || p.regions.includes(region));

export interface WorkItemDeps { store: Store; now: () => Date; recipientAllowed: (actor: Actor, recipientId: string, reader?: Reader) => Promise<boolean> }
export interface CreatedWorkItems { items: { id: string; title: string }[]; assigneeName: string; notified: boolean }

export function createWorkItemEffects(deps: WorkItemDeps) {
  const { store } = deps;
  return {
    /** Fresh check used at prepare and again at confirm: creator holds ticket.create; an assignee other than the creator passes the recipient policy. */
    async authorize(actor: Actor, assigneeId: string, reader: Reader = store, branchIds: readonly string[] = []): Promise<{ ok: true; assignee: Profile } | { ok: false }> {
      const profile = await reader.get<Profile>('profiles', actor.id);
      if (!profile?.active || !profile.permissions.includes('ticket.create')) return { ok: false };
      const assignee = assigneeId === actor.id ? profile : await reader.get<Profile>('profiles', assigneeId);
      if (!assignee?.active || assignee.id !== assigneeId) return { ok: false };
      if (assigneeId !== actor.id && !(await deps.recipientAllowed({ ...profile, sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision }, assigneeId, reader))) return { ok: false };
      // Every target branch must be inside BOTH the creator's and the assignee's CURRENT region authority (an item never reveals a branch its assignee cannot read).
      for (const branchId of new Set(branchIds)) {
        const branch = await reader.get<Branch>('branches', branchId);
        if (!branch || !regionAllowed(profile, branch.region) || !regionAllowed(assignee, branch.region)) return { ok: false };
      }
      return { ok: true, assignee };
    },
    async create(actor: Actor, input: { fields: TaskFields; proposalId: string; fence?: EffectFence }): Promise<CreatedWorkItems> {
      const fields = taskFieldsSchema.parse(input.fields);
      const now = deps.now();
      const operationKey = `task_${digest({ proposalId: input.proposalId }).slice(0, 32)}`;
      const expanded = expandTask(fields);
      let assigneeName = '';
      const written = await store.transaction(async tx => {
        await input.fence?.(tx);
        const check = await this.authorize(actor, fields.assigneeId, tx, fields.branchIds);
        if (!check.ok) throw new DomainError('AUTHORITY_CHANGED', 'Creator or assignee authority changed before the work item was created', 403);
        assigneeName = personLabel(check.assignee);
        const out: { id: string; title: string }[] = [];
        for (const part of expanded) {
          const id = workItemRowId(operationKey, part.group);
          const prior = await tx.get<unknown>('tool_executions', id);
          if (prior !== undefined) { const row = parse(prior); if (!row || row.actorId !== actor.id) throw new DomainError('WORK_ITEM_CONFLICT', 'Work item id conflict', 409); out.push({ id, title: row.title }); continue; }
          const body = { title: part.title, priority: fields.priority, dueDate: fields.dueDate, grouping: fields.grouping, checklist: fields.checklist, branchIds: part.branchIds, note: fields.note };
          const row: WorkItemRow = workItemRowSchema.parse({ id, name: WORK_ITEM_TOOL, status: WORK_ITEM_STATUS, actorId: actor.id, assigneeId: fields.assigneeId, proposalId: input.proposalId,
            operationKey, ...body, state: 'open', createdAt: now.toISOString(), digest: digest(body) });
          await tx.put('tool_executions', row);
          out.push({ id, title: row.title });
        }
        // The assignee (when not the creator) is told through their own inbox; the message is idempotent per work item.
        if (fields.assigneeId !== actor.id) {
          const sender = personLabel(await tx.get<Profile>('profiles', actor.id) as Profile);
          const target = recipientSnapshot(check.assignee).ref;
          // One item => one message that opens it; a per-branch expansion sends ONE message per created item so every notification links its exact item (workItemId).
          for (const [index, item] of out.entries()) {
            const part = expanded[index]!, single = out.length === 1;
            const title = single ? fields.title : item.title;
            const branches = single ? fields.branchIds : part.branchIds;
            const lines = [`${sender} มอบหมายงาน “${title}” ให้คุณ`, `ความสำคัญ: ${PRIORITY_LABEL[fields.priority]}${fields.dueDate ? ` · ครบกำหนด ${fields.dueDate}` : ''}`,
              ...(branches.length ? [`สาขา: ${branches.join(', ')}`] : []), ...(fields.checklist.length ? ['รายการตรวจ:', ...fields.checklist.map(c => `- ${c}`)] : []), ...(fields.note ? [`หมายเหตุ: ${fields.note}`] : [])];
            const messageKey = single ? operationKey : `${operationKey}:${part.group}`;
            const messageId = inboxRowId(messageKey, fields.assigneeId);
            if ((await tx.get('mock_messages', messageId)) === undefined) {
              await tx.put('mock_messages', inboxRowSchema.parse({ id: messageId, kind: INBOX_KIND, actorId: actor.id, senderName: sender, recipientId: fields.assigneeId,
                source: 'task_assigned', title: `งานใหม่: ${title}`.slice(0, 200), content: lines.join(String.fromCharCode(10)).slice(0, 4000), channelId: 'simulated_inbox',
                operationKey: messageKey, planDigest: digest({ operationKey: messageKey, fields }), target: refSchema.parse(target), createdAt: now.toISOString(), readAt: null, workItemId: item.id }));
            }
          }
        }
        return out;
      });
      // Independent readback of every stored item.
      for (const item of written) {
        const row = parse(await store.get<unknown>('tool_executions', item.id));
        if (!row || row.actorId !== actor.id || row.assigneeId !== fields.assigneeId || row.priority !== fields.priority || row.state !== 'open') throw new DomainError('WORK_ITEM_READBACK', 'ยังยืนยันผลการสร้างงานติดตามไม่ได้ กรุณาตรวจสถานะก่อนส่งคำขอใหม่', 500);
      }
      return { items: written, assigneeName, notified: fields.assigneeId !== actor.id };
    },
  };
}
export type WorkItemEffects = ReturnType<typeof createWorkItemEffects>;

/** Every work item the creator wrote, newest first (callers page; there is no hidden cap). */
export async function listWorkItems(store: Store, actor: Actor): Promise<WorkItemRow[]> {
  return (await store.list<unknown>('tool_executions', { actorId: actor.id, status: WORK_ITEM_STATUS })).map(parse)
    .filter((r): r is WorkItemRow => !!r && r.actorId === actor.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
