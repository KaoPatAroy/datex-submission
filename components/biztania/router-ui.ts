import type { ConversationMessage, TurnArtifact, TurnChoice } from '@/lib/contracts';
import type { RouterProposalView } from '@/app/api/router-proposals/_view';

export type { RouterProposalView };

/** Same shape as nexus-workspace apiRequest, so the client logic stays unit-testable with a mock. */
export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ProposalConfirmResult =
  | { outcome: 'executed'; actionId: string; text: string; verified: true; ids?: Record<string, string> }
  | { outcome: 'denied' | 'failed'; actionId: string; code: string; text: string };

export const stagedActionTitle: Record<RouterProposalView['actionId'], string> = {
  'dashboard.revoke_share': 'เพิกถอนการแชร์ Dashboard',
  'dashboard.delete': 'ลบ Dashboard',
  'dashboard.refine': 'แก้ไข Dashboard ที่แชร์แล้ว',
  'dashboard.rename': 'เปลี่ยนชื่อ Dashboard ที่แชร์แล้ว',
  'monitor.delete': 'ลบ Monitor',
  'communication.send': 'ส่งข้อความ',
  'monitor.create': 'สร้าง Monitor',
  'artifact.share': 'แชร์ผลลัพธ์',
  'task.create': 'สร้างงานติดตาม',
  'policy.acknowledge': 'รับทราบ Policy',
  'onboarding.director_approve': 'อนุมัติคำขอ Onboarding',
  'onboarding.return': 'ส่งคำขอ Onboarding กลับไปแก้ไข',
  'onboarding.notify_email': 'Email แจ้งผลการอนุมัติ',
};

export const stagedConfirmLabel: Record<RouterProposalView['actionId'], string> = {
  'dashboard.revoke_share': 'ยืนยันเพิกถอนการแชร์ Dashboard',
  'dashboard.delete': 'ยืนยันลบ Dashboard',
  'dashboard.refine': 'ยืนยันแก้ไข Dashboard',
  'dashboard.rename': 'ยืนยันเปลี่ยนชื่อ',
  'monitor.delete': 'ยืนยันลบ Monitor',
  'communication.send': 'ยืนยันส่งข้อความ',
  'monitor.create': 'ยืนยันสร้าง Monitor',
  'artifact.share': 'ยืนยันแชร์ผลลัพธ์',
  'task.create': 'ยืนยันสร้างงานติดตาม',
  'policy.acknowledge': 'ยืนยันรับทราบ Policy',
  'onboarding.director_approve': 'ยืนยันอนุมัติ',
  'onboarding.return': 'ยืนยันส่งกลับไปแก้ไข',
  'onboarding.notify_email': 'ยืนยันส่ง Email',
};

const detailLabels: Record<string, string> = {
  dashboardId: 'Dashboard',
  recipientIds: 'ผู้รับ',
  contentStateId: 'เนื้อหาที่ใช้ส่ง',
  queryStateId: 'คำตอบที่ใช้เฝ้าติดตาม',
  threshold: 'เกณฑ์แจ้งเตือน',
  title: 'ชื่อ',
  monitorId: 'Monitor',
  artifactId: 'ผลลัพธ์',
  revision: 'ฉบับที่',
  priority: 'ความสำคัญ',
  dueDate: 'ครบกำหนด',
  grouping: 'การจัดกลุ่ม',
  checklist: 'รายการตรวจ',
  branchIds: 'สาขา',
  assigneeId: 'ผู้รับผิดชอบ',
  note: 'หมายเหตุ',
  requestLabels: 'คำขอ Onboarding',
  recipientLabels: 'ผู้รับ Email จำลอง',
  subject: 'หัวเรื่อง',
  reason: 'เหตุผล',
};

/** Rows for the review dialog: the exact parameters the confirmation will act on. */
export function proposalDetailRows(proposal: Pick<RouterProposalView, 'details'>): { key: string; label: string; value: string }[] {
  return Object.entries(proposal.details).filter(([key, value]) => key !== 'recipientIds' || !Array.isArray(value) || value.length > 0).map(([key, value]) => ({
    key, label: detailLabels[key] ?? 'รายละเอียด', value: Array.isArray(value) ? value.join(', ') : String(value),
  }));
}

const headers = (csrfToken: string) => ({ 'Content-Type': 'application/json', 'x-csrf-token': csrfToken });

/**
 * Pending staged proposals. A store without the router_proposals table answers an empty list server-side; a FAILED fetch
 * throws so the UI never shows an error as "nothing pending".
 */
export async function fetchPendingProposals(request: ApiRequest): Promise<RouterProposalView[]> {
  const body = await request<{ proposals?: RouterProposalView[] }>('/api/router-proposals', { method: 'GET', cache: 'no-store' });
  return Array.isArray(body.proposals) ? body.proposals : [];
}

export type ProposalsLoad = { status: 'ready'; proposals: RouterProposalView[] } | { status: 'error'; message: string };
export const PROPOSALS_LOAD_ERROR = 'โหลดรายการที่รอยืนยันไม่สำเร็จ — ตรวจการเชื่อมต่อแล้วลองอีกครั้ง';
/** Loading/empty/error stay distinct: an error is reported as such, never as an empty list. */
export async function loadPendingProposals(request: ApiRequest): Promise<ProposalsLoad> {
  try { return { status: 'ready', proposals: await fetchPendingProposals(request) }; }
  catch { return { status: 'error', message: PROPOSALS_LOAD_ERROR }; }
}

export function confirmStagedProposal(request: ApiRequest, csrfToken: string, id: string): Promise<ProposalConfirmResult> {
  return request<ProposalConfirmResult>(`/api/router-proposals/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: headers(csrfToken), body: '{}' });
}

export function cancelStagedProposal(request: ApiRequest, csrfToken: string, id: string): Promise<{ id: string; status: 'cancelled'; text: string }> {
  return request(`/api/router-proposals/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: headers(csrfToken), body: '{}' });
}

/** Proposals created by one assistant turn (rendered inside that chat message). The server only lists unexpired ones; pass `now` to also filter locally. */
export function proposalsForTurn(proposals: readonly RouterProposalView[], turnId: string | undefined, now?: number): RouterProposalView[] {
  if (!turnId) return [];
  return proposals.filter(item => item.turnId === turnId && item.status === 'pending' && (now === undefined || item.expiresAt > now));
}

/** Only the newest assistant message offers its clarification chips; older ones are history. */
export function clarificationChoices(message: Pick<ConversationMessage, 'role' | 'choices' | 'turnId'>, isLatest: boolean): TurnChoice[] {
  if (!isLatest || message.role !== 'assistant' || !message.turnId) return [];
  return message.choices ?? [];
}

/** Structured selection sent with the next chat request. `message` is display text only; the server never parses it. */
export function clarificationSelection(message: Pick<ConversationMessage, 'turnId'>, choice: TurnChoice): { message: string; clarification: { choiceId: string; clarifiedTurnId: string } } | undefined {
  if (!message.turnId) return undefined;
  return { message: choice.label, clarification: { choiceId: choice.id, clarifiedTurnId: message.turnId } };
}

// --- Artifact save / export (server route owned by the artifacts unit: POST /api/artifacts/{id}/save | /export) -------------

export type ArtifactOperation = 'save' | 'export';
export type ArtifactWriteResult =
  | { kind: 'proposal'; operation: ArtifactOperation; proposalId: string; preview: string }
  | { kind: 'done'; operation: ArtifactOperation; text: string }
  | { kind: 'file'; operation: 'export'; filename: string; mime: string; content: string };

export const artifactOperationPath = (artifactId: string, operation: ArtifactOperation) => `/api/artifacts/${encodeURIComponent(artifactId)}/${operation}`;

/**
 * Calls the confirmed artifact write path. The server answers either with a JSON proposal ({ outcome:'proposed' }, to be
 * confirmed like any pending action), a JSON completion, or (export) a CSV file body.
 */
export async function requestArtifactWrite(
  fetcher: typeof fetch, csrfToken: string, artifact: Pick<TurnArtifact, 'id' | 'revision'>, operation: ArtifactOperation, conversationId?: string,
): Promise<ArtifactWriteResult> {
  const response = await fetcher(artifactOperationPath(artifact.id, operation), {
    method: 'POST', credentials: 'include', cache: 'no-store', headers: headers(csrfToken),
    body: JSON.stringify({ revision: artifact.revision, ...(conversationId ? { conversationId } : {}) }),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    let message = operation === 'save' ? 'บันทึกผลลัพธ์ไม่สำเร็จ' : 'ส่งออกไฟล์ไม่สำเร็จ';
    try { const body = await response.json() as { error?: { message?: string } }; if (body.error?.message) message = body.error.message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (type.startsWith('text/csv')) {
    const disposition = response.headers.get('content-disposition') ?? '';
    const named = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    return { kind: 'file', operation: 'export', filename: named ?? `${artifact.id}.csv`, mime: 'text/csv', content: await response.text() };
  }
  const body = await response.json() as { outcome?: string; pendingActionId?: string; proposalId?: string; preview?: string; text?: string };
  const proposalId = body.proposalId ?? body.pendingActionId;
  if (body.outcome === 'proposed' && proposalId) return { kind: 'proposal', operation, proposalId, preview: body.preview ?? body.text ?? '' };
  return { kind: 'done', operation, text: body.text ?? (operation === 'save' ? 'บันทึกผลลัพธ์แล้ว' : 'ส่งออกแล้ว') };
}

// --- Dashboard rename (CAS on the loaded revision) ---------------------------------------------------------------------------

export const DASHBOARD_CHANGED_TEXT = 'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่';
/** A shared Dashboard edit made from the UI is staged as the same confirm proposal chat creates; the page opens the existing confirm dialog for it. */
export interface StagedEditOutcome { outcome: 'staged'; proposalId: string; preview: string; expiresAt: number }
export const isStagedEdit = (body: unknown): body is StagedEditOutcome => !!body && typeof body === 'object' && (body as { outcome?: unknown }).outcome === 'staged' && typeof (body as { proposalId?: unknown }).proposalId === 'string';
export type DashboardRenameResult<V> = { status: 'renamed'; view: V } | { status: 'staged'; proposalId: string; preview: string } | { status: 'conflict'; view: V; message: string };
/** PATCH with the revision the page loaded. A DASHBOARD_CHANGED 409 reloads the dashboard and reports a conflict instead of overwriting. */
export async function renameDashboardRequest<V>(request: ApiRequest, csrfToken: string, dashboardId: string, title: string, baseRevision: string): Promise<DashboardRenameResult<V>> {
  const path = `/api/dashboards/${encodeURIComponent(dashboardId)}`;
  try {
    const body = await request<V | StagedEditOutcome>(path, { method: 'PATCH', headers: headers(csrfToken), body: JSON.stringify({ title, baseRevision }) });
    return isStagedEdit(body) ? { status: 'staged', proposalId: body.proposalId, preview: body.preview } : { status: 'renamed', view: body as V };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'DASHBOARD_CHANGED') throw error;
    return { status: 'conflict', view: await request<V>(path, { method: 'GET', cache: 'no-store' }), message: DASHBOARD_CHANGED_TEXT };
  }
}

// --- Dashboard undo/delete -----------------------------------------------------------------------------------------------

export function deleteDashboardRequest(request: ApiRequest, csrfToken: string, dashboardId: string): Promise<unknown> {
  return request(`/api/actions/delete-dashboard/${encodeURIComponent(dashboardId)}`, { method: 'POST', headers: headers(csrfToken), body: '{}' });
}

// --- Dashboard organization (pin / archive / restore / duplicate) -----------------------------------------------------------

export type DashboardOrganizeOp = 'pin' | 'unpin' | 'archive' | 'restore' | 'duplicate';
/** Owner-only library organization. The server applies the same owner/permission rules as every other Dashboard write; it never changes widgets. */
export function organizeDashboardRequest(request: ApiRequest, csrfToken: string, dashboardId: string, op: DashboardOrganizeOp): Promise<{ dashboardId: string; op: DashboardOrganizeOp }> {
  return request(`/api/dashboards/${encodeURIComponent(dashboardId)}/organize`, { method: 'POST', headers: headers(csrfToken), body: JSON.stringify({ op }) });
}
