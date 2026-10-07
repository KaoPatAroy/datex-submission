import { z } from 'zod';
import type { Actor, DashboardSpec, Store } from '../contracts';
import { digest } from '../effects/shared';
import { dashboardWidgetOpSchema } from './widget-ops';
import { isWidgetFamilyOp } from './widget-family';
import { createStagedStore, STAGED_PROPOSAL_TTL_MS } from '../router/storage/staged-store';
import type { StagedActionId, StagedProposal } from '../router/executors/action-ports';

/**
 * Shared Dashboard edits made from the normal UI (no chat turn). They create the SAME staged proposal the chat path creates
 * (router_proposals: claim token, mode fence, base revision) and execute through the same confirmProposal path.
 *
 * Origin proof. A chat-originated proposal is only confirmable with a COMPLETED chat turn (that proof is not weakened).
 * A UI-originated proposal has no chat turn, so it carries an explicit server-written origin instead:
 *   - conversationId is the reserved `ui:dashboard:<actorId>` (a real conversation is always a generated `conversation_*` id that must
 *     exist in the conversations table, so a chat turn can never produce this id);
 *   - turnId is a server-generated `ui_<uuid>` reference, repeated in `data.origin.ref`;
 *   - the action is one of the two dashboard staged actions and the creating session + mode revision are recorded (the claim and the
 *     effect transaction re-check them exactly like a chat proposal).
 * The effect re-checks authority, ownership, share state and the base revision (CAS) at confirm, so the origin only answers
 * "who created this and from where", never "is it allowed".
 */
export const UI_ORIGIN_KIND = 'ui_dashboard' as const;
const UI_CONVERSATION_PREFIX = 'ui:dashboard:';
const UI_ACTIONS: ReadonlySet<StagedActionId> = new Set<StagedActionId>(['dashboard.refine', 'dashboard.rename']);
export const uiProposalConversationId = (actorId: string): string => `${UI_CONVERSATION_PREFIX}${actorId}`;

export function isUiProposalOrigin(actor: Pick<Actor, 'id'>, proposal: StagedProposal): boolean {
  const origin = proposal.data.origin as { kind?: unknown; ref?: unknown } | undefined;
  return proposal.actorId === actor.id
    && proposal.conversationId === uiProposalConversationId(actor.id)
    && typeof proposal.turnId === 'string' && proposal.turnId.startsWith('ui_')
    && UI_ACTIONS.has(proposal.actionId)
    && origin?.kind === UI_ORIGIN_KIND && origin.ref === proposal.turnId
    && !!proposal.sessionId && proposal.mode !== undefined && proposal.modeRevision !== undefined;
}

/** The UI operations on a Dashboard. `baseRevision` is the revision the page loaded (CAS). */
export const dashboardUiEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), title: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional(), baseRevision: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('widgets'), change: z.unknown(), baseRevision: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('add_result'), artifactId: z.string().min(1).max(200), revision: z.number().int().positive().max(100).optional(), baseRevision: z.string().min(1).max(200).optional() }).strict(),
]);
export type DashboardUiEdit = z.infer<typeof dashboardUiEditSchema>;

const OP_LABEL: Record<string, string> = { reorder: 'จัดลำดับ Widget', remove: 'เอา Widget ออก', retitle: 'เปลี่ยนชื่อ Widget' };
/**
 * `result` (PC-04): the server-validated display title and the EXACT revision being added, so the confirmation names what the recipients
 * will see. Never taken from the client request.
 */
export function uiEditLabel(edit: DashboardUiEdit, result?: { title: string; revision: number }): string {
  if (edit.kind === 'rename') return edit.description !== undefined ? 'แก้ชื่อหรือคำอธิบาย' : 'เปลี่ยนชื่อ';
  if (edit.kind === 'add_result') return result ? `เพิ่มผลลัพธ์ “${result.title.slice(0, 120)}” ฉบับที่ ${result.revision} เป็น Widget` : 'เพิ่มผลลัพธ์เป็น Widget';
  if (isWidgetFamilyOp(edit.change)) return 'เปลี่ยนรูปแบบ Widget';
  const parsed = dashboardWidgetOpSchema.safeParse(edit.change);
  return parsed.success ? OP_LABEL[parsed.data.op] ?? 'ปรับ Widget' : 'ปรับ Widget';
}

export interface UiStageInput {
  store: Store; now: () => Date; actor: Actor;
  dashboard: { id: string; title: string; revision: string };
  /** Planned change: a new title only (dashboard.rename) or a full new spec (dashboard.refine). */
  change: { kind: 'rename'; title: string } | { kind: 'spec'; spec: DashboardSpec; label: string };
}
export interface UiStaged { proposalId: string; preview: string; expiresAt: number; deduped: boolean }

export async function stageDashboardUiProposal(input: UiStageInput): Promise<UiStaged> {
  const { actor, dashboard, change } = input;
  const staged = createStagedStore(input.store, { now: () => input.now().getTime() });
  const conversationId = uiProposalConversationId(actor.id), turnId = `ui_${crypto.randomUUID()}`;
  const actionId: StagedActionId = change.kind === 'rename' ? 'dashboard.rename' : 'dashboard.refine';
  const key = digest({ actionId, actorId: actor.id, canonical: change.kind === 'rename' ? { dashboardId: dashboard.id, title: change.title, base: dashboard.revision } : { dashboardId: dashboard.id, spec: change.spec, base: dashboard.revision } });
  const existing = await staged.findPending(actor, conversationId, key);
  const origin = { kind: UI_ORIGIN_KIND, ref: turnId };
  const preview = change.kind === 'rename'
    ? `เปลี่ยนชื่อ Dashboard ที่แชร์แล้ว “${dashboard.title}” เป็น “${change.title}” (ผู้ที่ได้รับแชร์จะเห็นชื่อใหม่หลังยืนยัน)`
    : `${change.label}ใน Dashboard ที่แชร์แล้ว “${dashboard.title}” (ผู้ที่ได้รับแชร์จะเห็นการเปลี่ยนแปลงหลังยืนยัน)`;
  const data = change.kind === 'rename'
    ? { params: { dashboardId: dashboard.id, title: change.title }, title: dashboard.title, baseRevision: dashboard.revision, origin }
    : { params: { dashboardId: dashboard.id }, title: dashboard.title, spec: change.spec, baseRevision: dashboard.revision, origin };
  const proposal = existing ?? await staged.create(actor, { conversationId, turnId }, { actionId, digest: key, preview, data, expiresAt: input.now().getTime() + STAGED_PROPOSAL_TTL_MS });
  return { proposalId: proposal.id, preview: proposal.preview, expiresAt: proposal.expiresAt, deduped: !!existing };
}
