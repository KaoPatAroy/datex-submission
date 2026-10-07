'use client';

import type { VizWidgetResult } from '@/lib/visualization/dashboard-data';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor, ConversationMessage, Dashboard, Evidence, Mode, PendingAction, Receipt, ReceiptView, Role, SourceRef, TurnResponse, Workspace } from '@/lib/contracts';
import ActionReviewDialog, { type DashboardRevisionRequest } from '@/components/action-review-dialog';
import DashboardDetail from '@/components/dashboard-detail';
import DashboardTaskOptions from '@/components/biztania/dashboard-task-options';
import { dashboardIntentRequest, validDashboardTaskOptions, type DashboardIntent, type DashboardTaskOptions as TaskOptions } from '@/lib/dashboards/task-intent';
import ActionSummary, { hasShareApprovalDetails } from '@/components/action-summary';
import { Icon, type IconName } from '@/components/icons';
import ChatThread, { type LocalMessage, type TurnRecovery } from '@/components/biztania/chat-thread';
import ContextPanel, { type DetailSelection } from '@/components/biztania/context-panel';
import WorkCatalog, { workspaceCatalog, workspaceCatalogReady, workspaceCatalogStatus, catalogStatusMessage, catalogStatusRetryable } from '@/components/biztania/work-catalog';
import HistoryPanel from '@/components/biztania/history-panel';
import RouterHistory from '@/components/biztania/router-history';
import ConversationSidebar from '@/components/biztania/conversation-sidebar';
import { badgeReviewIsCurrent, type BadgeReviewStatus } from '@/components/biztania/badge-review';
import styles from '@/components/biztania/workspace.module.css';
import { canUseChat } from '@/lib/core/chat-capability';
import { freshnessText, sourceDisplayName } from '@/lib/presentation/source-names';
import { dashboardSourcesForWidgets } from '@/lib/visualization/dashboard-sources';
import { actionName, actionState, actorScope, conciseTitle, demoScenarioImpact, demoScenarioLabel, displayPerson, messageTextWithLinkedReceiptOutcome, retryActionPrompt, type LifecycleAction } from '@/components/biztania/product-labels';
import { ChatStreamError, cleanFailureMessages, recoverChatStream, requestChatStream, streamProgress, type ChatRecoveryResult } from '@/components/biztania/stream-client';
import DemoGuide from '@/components/biztania/demo-guide';
import demoStyles from '@/components/biztania/demo-guide.module.css';
import type { ShowcaseItem } from '@/lib/demo/showcase';
import type { AIHealth } from '@/lib/ai/health';
import type { TurnArtifact, TurnChoice } from '@/lib/contracts';
import ResultsLibrary from './biztania/results-library';
import type { EditOutcome, WidgetChange } from './biztania/dashboard-manage';
import RouterWorkItems from './biztania/router-work-items';
import RouterMonitors from './biztania/router-monitors';
import RouterReceipts from './biztania/router-receipts';
import { composerConversationId } from './biztania/conversation-ui';
import {
  beginConversationReceiptLoad, finishConversationReceiptLoad, parseRouterReceiptPage, reconcileDashboardTaskTarget,
  type ConversationReceiptLoadState,
} from '@/lib/dashboards/workspace-client-state';
import InboxPanel from '@/components/biztania/inbox-panel';
import { StagedProposalDialog, StagedProposalList } from '@/components/biztania/router-panels';
import { cancelStagedProposal, clarificationSelection, confirmStagedProposal, deleteDashboardRequest, isStagedEdit, loadPendingProposals, organizeDashboardRequest, renameDashboardRequest, requestArtifactWrite, type ArtifactOperation, type DashboardOrganizeOp, type ProposalConfirmResult, type RouterProposalView } from '@/components/biztania/router-ui';

type Session = { actor: Actor; csrfToken: string; businessDate: string; storage: string };
type ScreenState = 'checking' | 'login' | 'ready' | 'failed';
type Section = 'overview' | 'dashboards' | 'inbox' | 'messages' | 'actions' | 'audit' | 'capabilities' | 'results' | 'dashboard';
type ApiErrorEnvelope = { error?: { code?: string; message?: string; turnId?: string; executionId?: string; details?: unknown } };
type ActionRevisionResult = { predecessor: LifecycleAction; replacement: LifecycleAction; diff: string[] };
type ActionMutation = { actionId: string; kind: 'revise' | 'cancel' };
type ActionMutationMarker = { kind: 'revise' | 'cancel'; rejected?: true };
type ActionMutationMemory = Record<string, ActionMutationMarker>;
function actionMutationStorageKey(actor: Actor) {
  return `biztania:action-mutations:v1:${actor.id}:${actor.sessionId}`;
}
function writeActionMutationMemory(actor: Actor, memory: ActionMutationMemory) {
  try {
    window.sessionStorage.setItem(actionMutationStorageKey(actor), JSON.stringify(memory));
    return true;
  } catch { return false; }
}
function readActionMutationMemory(workspace: Workspace): ActionMutationMemory {
  try {
    const raw = window.sessionStorage.getItem(actionMutationStorageKey(workspace.actor));
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid action recovery');
    const entries = Object.entries(value).map(([id, marker]): [string, ActionMutationMarker] => {
      if (marker === 'revise' || marker === 'cancel') return [id, { kind: marker }];
      if (!marker || typeof marker !== 'object' || !('kind' in marker) || (marker.kind !== 'revise' && marker.kind !== 'cancel') || ('rejected' in marker && marker.rejected !== true)) throw new Error('Invalid action recovery');
      return [id, { kind: marker.kind, ...('rejected' in marker ? { rejected: true } : {}) }];
    });
    // A pending or absent row cannot prove that an interrupted write did not commit.
    const memory = Object.fromEntries(entries.filter(([id]) => !workspace.actions.some(action => action.id === id && action.status !== 'pending')));
    writeActionMutationMemory(workspace.actor, memory);
    return memory;
  } catch {
    return Object.fromEntries(workspace.actions.filter(action => action.payload.kind === 'dashboard_create' && action.status === 'pending').map(action => [action.id, { kind: 'revise' }]));
  }
}
type UnknownExecution = { actionId: string; executionId?: string; message: string };
type Scenario = 'stock_recovered' | 'payment_resolved' | 'baseline';
type DashboardView = { dashboard: Dashboard; revision?: string; evidence: Evidence; analysisStale: boolean; sharedBy?: { name: string }; vizData?: VizWidgetResult[] };
const composerPrefillKey = 'biztania:dashboard-prefill:v1';
const composerPrefillLifetimeMs = 120_000;
type DashboardPrefill = DashboardIntent & { actorId: string; sessionId: string; catalogId: string; createdAt: number };

function validDashboardPrefill(value: unknown): value is DashboardPrefill {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DashboardPrefill>;
  return typeof item.actorId === 'string' && typeof item.sessionId === 'string' && typeof item.dashboardId === 'string' && item.dashboardId.length > 0 && item.dashboardId.length <= 200 && (item.title === undefined || typeof item.title === 'string' && item.title.length <= 200) && typeof item.catalogId === 'string' && (item.actionKind === 'dashboard_share' || item.actionKind === 'ticket_create') && typeof item.prompt === 'string' && item.prompt.length > 0 && item.prompt.length <= 8000 && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) && (item.taskOptions === undefined || validDashboardTaskOptions(item.taskOptions));
}
type RecoveryMemory = { pending: TurnRecovery | null; blockedTexts: string[]; newConversation: boolean; selectedConversationId?: string };

function canonicalConversationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value && !value.startsWith('local-conversation-') ? value : undefined;
}

function failedTurnConversationId(recovery: TurnRecovery | null, workspace: Workspace | null) {
  if (!recovery?.statusChecked || recovery.recoveryStatus !== 'failed') return undefined;
  const known = canonicalConversationId(recovery.conversationId) ?? canonicalConversationId(recovery.requestConversationId);
  if (known) return known;
  if (!workspace || !recovery.turnId) return undefined;
  const matches = workspace.messages.filter(message => message.role === 'user' && message.actorId === workspace.actor.id && message.sessionId === workspace.actor.sessionId && (message.id === recovery.turnId || message.turnId === recovery.turnId));
  const ids = [...new Set(matches.map(message => canonicalConversationId(message.conversationId)).filter((id): id is string => Boolean(id)))];
  return ids.length === 1 ? ids[0] : undefined;
}

function recoveryStorageKey(actor: Actor) {
  return `biztania:turn-recovery:${actor.id}:${actor.sessionId}`;
}

function writeRecoveryMemory(actor: Actor, pending: TurnRecovery | null, blockedTexts: string[], newConversation = false, selectedConversationId?: string) {
  try {
    const key = recoveryStorageKey(actor);
    if (!pending && !blockedTexts.length && !newConversation && !selectedConversationId) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify({ version: 2, pending: pending ? { message: pending.message, conversationId: pending.conversationId, turnId: pending.turnId, startedAt: pending.startedAt, previousMessageIds: pending.previousMessageIds.slice(-40), failedResponse: pending.failedResponse, requestKey: pending.requestKey, requestConversationId: pending.requestConversationId, assistantMessageId: pending.assistantMessageId, partialText: pending.partialText, interruptedBy: pending.interruptedBy } : null, blockedTexts, newConversation, selectedConversationId }));
    return true;
  } catch { return false; }
}

function readRecoveryMemory(actor: Actor): RecoveryMemory {
  try {
    const raw = window.sessionStorage.getItem(recoveryStorageKey(actor));
    if (!raw) return { pending: null, blockedTexts: [], newConversation: false };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value) || (value.version !== 1 && value.version !== 2) || !('pending' in value) || !('blockedTexts' in value) || !Array.isArray(value.blockedTexts)) throw new Error('Invalid recovery marker');
    const blockedTexts = value.blockedTexts.filter((text): text is string => typeof text === 'string' && text.length <= 8000);
    const newConversation = 'newConversation' in value && value.newConversation === true;
    const selectedConversationId = !newConversation && 'selectedConversationId' in value ? canonicalConversationId(value.selectedConversationId) : undefined;
    if (value.pending === null) return { pending: null, blockedTexts, newConversation, selectedConversationId };
    const pending = value.pending;
    if (!pending || typeof pending !== 'object' || !('message' in pending) || typeof pending.message !== 'string' || pending.message.length > 8000 || !('startedAt' in pending) || typeof pending.startedAt !== 'string' || !Number.isFinite(new Date(pending.startedAt).getTime()) || !('previousMessageIds' in pending) || !Array.isArray(pending.previousMessageIds)) throw new Error('Invalid recovery marker');
    if ('requestKey' in pending && (typeof pending.requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(pending.requestKey))) throw new Error('Invalid request key');
    return { pending: { message: pending.message, startedAt: pending.startedAt, previousMessageIds: pending.previousMessageIds.filter((id): id is string => typeof id === 'string' && id.length <= 100).slice(-40), errorMessage: 'แท็บนี้มีคำขอเดิมที่ยังไม่ทราบผล ตรวจประวัติและสถานะก่อนส่งใหม่', failedResponse: 'failedResponse' in pending && pending.failedResponse === true, statusChecked: false, ...('conversationId' in pending && typeof pending.conversationId === 'string' && pending.conversationId.length <= 100 ? { conversationId: pending.conversationId } : {}), ...('turnId' in pending && typeof pending.turnId === 'string' && pending.turnId.length <= 100 ? { turnId: pending.turnId } : {}), ...('requestKey' in pending && typeof pending.requestKey === 'string' ? { requestKey: pending.requestKey } : {}), ...('requestConversationId' in pending && typeof pending.requestConversationId === 'string' && pending.requestConversationId.length <= 100 ? { requestConversationId: pending.requestConversationId } : {}), ...('assistantMessageId' in pending && typeof pending.assistantMessageId === 'string' && pending.assistantMessageId.length <= 100 ? { assistantMessageId: pending.assistantMessageId } : {}), ...('partialText' in pending && typeof pending.partialText === 'string' && new TextEncoder().encode(pending.partialText).byteLength <= 6000 ? { partialText: pending.partialText } : {}), ...('interruptedBy' in pending && (pending.interruptedBy === 'stop' || pending.interruptedBy === 'connection') ? { interruptedBy: pending.interruptedBy } : {}) }, blockedTexts, newConversation, selectedConversationId };
  } catch {
    return { pending: { message: '', startedAt: new Date().toISOString(), previousMessageIds: [], errorMessage: 'อ่านสถานะคำขอที่พักไว้ในแท็บไม่ได้ โหลดประวัติก่อนเริ่มคำถามใหม่', failedResponse: false, statusChecked: false }, blockedTexts: [], newConversation: false };
  }
}

function recoverLocalMessages(recovery: TurnRecovery, actor: Actor): LocalMessage[] {
  if (!recovery.requestKey) return [];
  const common = { actorId: actor.id, sessionId: actor.sessionId, conversationId: recovery.conversationId ?? recovery.requestConversationId ?? `local-conversation-${recovery.requestKey}`, turnId: recovery.turnId, requestKey: recovery.requestKey, mode: actor.mode, modeRevision: actor.modeRevision, createdAt: recovery.startedAt, local: true as const };
  return [
    { ...common, id: `local-user-${recovery.requestKey}`, role: 'user', text: recovery.message },
    { ...common, id: `local-assistant-${recovery.requestKey}`, role: 'assistant', text: recovery.partialText ?? '', delivery: recovery.interruptedBy === 'stop' ? 'stopped' : 'interrupted' },
  ];
}

function belongsToHeldTurn(entry: { id?: string; turnId?: string; conversationId?: string; createdAt: string }, recovery: TurnRecovery | null) {
  if (!recovery?.requestKey) return false;
  if (recovery.turnId) return entry.turnId === recovery.turnId || entry.id === recovery.turnId || entry.id === recovery.assistantMessageId;
  return !recovery.previousMessageIds.includes(entry.id ?? '') && (!recovery.requestConversationId || entry.conversationId === recovery.requestConversationId) && new Date(entry.createdAt).getTime() >= new Date(recovery.startedAt).getTime() - 1000;
}

const loginProfiles: { id: string; label: string; description: string }[] = [
  { id: 'executive', label: 'ผู้บริหาร', description: 'Executive' },
  { id: 'east', label: 'ผู้จัดการภาคตะวันออก', description: 'East Manager' },
  { id: 'hr', label: 'ผู้ดูแลฝ่ายบุคคล', description: 'HR Admin' },
  { id: 'director', label: 'ผู้อำนวยการฝ่ายบุคคล', description: 'HR Director' },
];

class ApiError extends Error {
  status: number;
  code?: string;
  turnId?: string;
  executionId?: string;

  constructor(message: string, status: number, code?: string, turnId?: string, executionId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.turnId = turnId;
    this.executionId = executionId;
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}, readDeadlineMs?: number): Promise<T> {
  async function request(signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'include', cache: 'no-store', ...init, ...(signal ? { signal } : {}) });
  } catch {
    throw new ApiError('เชื่อมต่อบริการไม่ได้ ตรวจการเชื่อมต่อแล้วลองโหลดสถานะอีกครั้ง', 0, 'network_error');
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!response.ok) {
    const envelope = body as ApiErrorEnvelope | null;
    throw new ApiError(
      envelope?.error?.message || `บริการตอบกลับไม่สำเร็จ กรุณาตรวจสถานะคำขอเดิมก่อนลองอีกครั้ง`,
      response.status,
      envelope?.error?.code,
      envelope?.error?.turnId,
      envelope?.error?.executionId,
    );
  }
  if (response.status === 204) return undefined as T;
  if (body === null) throw new ApiError('บริการส่งข้อมูลกลับมาในรูปแบบที่อ่านไม่ได้', response.status, 'invalid_response');
  return body as T;
  }
  if (readDeadlineMs === undefined) return request();
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (effect: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      effect();
    };
    const timer = setTimeout(() => finish(() => {
      controller.abort();
      reject(new ApiError('หมดเวลารอข้อมูลเริ่มต้น กรุณาตรวจการเชื่อมต่อแล้วตรวจสอบสถานะอีกครั้ง', 0, 'request_timeout'));
    }), readDeadlineMs);
    void request(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function jsonHeaders(csrfToken?: string) {
  return {
    'content-type': 'application/json',
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
  };
}

function roleLabel(role: Role) {
  const labels: Record<Role, string> = { executive: 'ผู้บริหาร', east_manager: 'ผู้จัดการภาคตะวันออก', hr_admin: 'ผู้ดูแลฝ่ายบุคคล', hr_director: 'ผู้อำนวยการฝ่ายบุคคล' };
  return labels[role];
}

function actorDisplayName(actor: Actor) {
  const syntheticNames: Record<string, string> = { 'Demo Executive': 'ผู้บริหารสาธิต', 'Demo East Manager': 'ผู้จัดการภาคตะวันออกสาธิต', 'Demo HR Admin': 'ผู้ดูแลฝ่ายบุคคลสาธิต', 'Demo HR Administrator': 'ผู้ดูแลฝ่ายบุคคลสาธิต', 'Demo HR Director': 'ผู้อำนวยการฝ่ายบุคคลสาธิต' };
  return syntheticNames[actor.name] ?? actor.name;
}

function formatDate(value: string, withTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'long' }).format(date);
}




function modeLabel(mode: Mode) {
  return mode === 'scripted_demo' ? 'โหมดสาธิต' : 'Live AI';
}

function responseSources(value: unknown): SourceRef[] | undefined {
  if (!value || typeof value !== 'object' || !('sources' in value) || !Array.isArray(value.sources)) return undefined;
  const sources = value.sources.filter((source): source is SourceRef => source && typeof source === 'object' && typeof source.id === 'string' && typeof source.system === 'string' && typeof source.detail === 'string' && typeof source.observedAt === 'string' && typeof source.retrievedAt === 'string' && ['fresh', 'stale', 'misaligned', 'missing'].includes(source.freshness));
  return sources;
}

function capabilityAllowed(workspace: Workspace | null, actor: Actor | null, kind: PendingAction['payload']['kind']) {
  if (!workspace || !actor) return false;
  const grants = {
    dashboard_create: ['dashboard.create', 'dashboard.prepare_create'], dashboard_share: ['dashboard.share', 'dashboard.prepare_share'],
    ticket_create: ['ticket.create', 'ticket.prepare_create'], badge_revoke: ['badge.revoke', 'badge.prepare_revoke'], demo_update: ['demo.update', ''],
  } as const;
  const [permission, tool] = grants[kind];
  return actor.permissions.includes(permission) && (kind === 'demo_update' ? actor.mode === 'scripted_demo' : workspace.capabilities.some(capability => capability.allowed && capability.tools.includes(tool)));
}

function actionLabel(kind: PendingAction['payload']['kind']) {
  return actionName(kind);
}


function receiptStatus(status: Receipt['status']) {
  const labels: Record<Receipt['status'], { label: string; tone: string }> = {
    verified_success: { label: 'สำเร็จแล้ว', tone: 'badge-success' },
    pending: { label: 'รอตรวจสอบ', tone: 'badge-warning' },
    failed: { label: 'ไม่สำเร็จ', tone: 'badge-danger' },
    denied: { label: 'ถูกปฏิเสธ', tone: 'badge-muted' },
  };
  return labels[status];
}

function recentConversationId(messages: ConversationMessage[], actorId: string) {
  return [...messages].filter((message) => message.actorId === actorId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.conversationId;
}

function matchLocalMessages(server: ConversationMessage[], local: LocalMessage[]) {
  const remaining = [...server];
  return local.filter((entry) => {
    if (entry.delivery) return true;
    const matchIndex = remaining.findIndex((message) => message.actorId === entry.actorId && message.conversationId === entry.conversationId && message.role === entry.role && (message.id === entry.id || (entry.turnId && message.turnId === entry.turnId) || (!entry.turnId && !message.turnId && message.text === entry.text && Math.abs(new Date(message.createdAt).getTime() - new Date(entry.createdAt).getTime()) < 10 * 60_000)));
    if (matchIndex < 0) return true;
    remaining.splice(matchIndex, 1);
    return false;
  });
}

function attachResponseContexts(messages: LocalMessage[], contexts: LocalMessage[]) {
  const available = new Set(messages.map((_, index) => index));
  const enriched = [...messages];
  for (const context of contexts) {
    const match = messages.map((message, index) => ({ message, index })).filter(({ message, index }) => !message.delivery && available.has(index) && message.actorId === context.actorId && message.conversationId === context.conversationId && message.role === context.role && (message.id === context.id || (context.turnId && message.turnId === context.turnId) || (!context.turnId && !message.turnId && message.text === context.text && Math.abs(new Date(message.createdAt).getTime() - new Date(context.createdAt).getTime()) < 10 * 60_000))).sort((a, b) => Number(b.message.id === context.id) - Number(a.message.id === context.id) || Math.abs(new Date(a.message.createdAt).getTime() - new Date(context.createdAt).getTime()) - Math.abs(new Date(b.message.createdAt).getTime() - new Date(context.createdAt).getTime()))[0];
    if (!match) continue;
    available.delete(match.index);
    enriched[match.index] = { ...match.message, evidence: match.message.evidence ?? context.evidence, sources: responseSources(match.message) ?? context.sources, responseAnalysis: context.responseAnalysis, clarification: match.message.clarification ?? context.clarification };
  }
  return enriched;
}

function LoginScreen({
  busy,
  error,
  onSubmit,
  onRetry,
  showRetry,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (profileId: string, accessCode: string) => void;
  onRetry: () => void;
  showRetry: boolean;
}) {
  const [profileId, setProfileId] = useState('executive');
  const [accessCode, setAccessCode] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(profileId, accessCode);
  }
  return (
    <main className="auth-screen">
      <section className="auth-intro" aria-label="DaTex">
        <div className="auth-brand"><div className="auth-brand-mark"><Icon name="nexus" size={22} /></div><div><strong>DaTex</strong></div></div>
        <div className="auth-message"><h1>ข้อมูลที่เชื่อถือได้<br />สำหรับการตัดสินใจที่ชัดเจน</h1><p>รวมมุมมองธุรกิจ หลักฐาน และข้อเสนอที่ต้องตรวจยืนยันไว้ในพื้นที่เดียว ทุกการดำเนินการผ่านการตรวจสอบและยืนยันตามสิทธิ์ของคุณ</p></div>
        <div className="auth-foot">ระบบพื้นที่ทำงานภายใน · DaTex</div>
      </section>
      <section className="auth-panel-wrap">
        <div className="auth-panel">
          <h2>เข้าสู่พื้นที่ทำงาน</h2>
          <p>เลือกโปรไฟล์ที่ได้รับอนุญาตและใส่รหัสเข้าใช้งาน</p>
          {error && <div className="error-banner" role="alert"><Icon name="alertCircle" /><div className="banner-copy"><strong>เข้าใช้งานไม่ได้</strong><p>{error}</p>{showRetry && <button className="text-button" style={{ marginTop: 8 }} type="button" onClick={onRetry}>ตรวจสอบสถานะอีกครั้ง</button>}</div></div>}
          <form onSubmit={submit}>
            <div className="form-field"><label htmlFor="profileId">โปรไฟล์</label><select id="profileId" value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={busy}>{loginProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label} · {profile.description}</option>)}</select></div>
            <div className="form-field"><label htmlFor="accessCode">รหัสเข้าใช้งาน</label><input id="accessCode" name="accessCode" type="password" autoComplete="current-password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} required disabled={busy} /><span className="form-hint">ระบบใช้รหัสนี้เพื่อตรวจสอบสิทธิ์เข้าใช้งาน</span></div>
            <button className="btn btn-primary auth-submit" type="submit" disabled={busy || !accessCode.trim()}>{busy ? 'กำลังตรวจสอบสิทธิ์…' : 'เข้าสู่ระบบ'}</button>
          </form>
          <p className="auth-privacy">ระบบจะแสดงข้อมูลตามขอบเขตและสิทธิ์ของโปรไฟล์ที่เลือก</p>
        </div>
      </section>
    </main>
  );
}

function LoadingScreen({ session }: { session?: Session }) {
  return (
    <main className={styles.root}>
      <div className={styles.datasetBar}><Icon name="database" size={13} /><span>ข้อมูลสังเคราะห์ · สำหรับสาธิตระบบ</span></div>
      <header className={`${styles.header} ${styles.loadingHeader}`}><div className={styles.brand}><span className={styles.brandMark}><Icon name="nexus" size={21} /></span><span><strong>DaTex</strong></span></div></header>
      <section className={styles.loadingContent}>
        <div className="loading-panel panel">
          <div role="status"><h1 className="panel-title">{session ? 'กำลังโหลดพื้นที่ทำงาน' : 'กำลังตรวจสอบการเข้าสู่ระบบ'}</h1><p className="panel-subtitle">{session ? 'เข้าสู่ระบบแล้ว กำลังรอข้อมูลพื้นที่ทำงาน' : 'กำลังเชื่อมต่อเพื่อเตรียมพื้นที่ทำงานของคุณ'}</p></div>
          {session && <div className="scope-meta"><span className="scope-pill">{actorDisplayName(session.actor)} · {roleLabel(session.actor.role)}</span><span className="scope-pill">วันทำการ {formatDate(session.businessDate, false)}</span><span className={`badge ${session.actor.mode === 'scripted_demo' ? 'badge-demo' : 'badge-info'}`}>{modeLabel(session.actor.mode)}</span></div>}
          <div aria-hidden="true"><div className="skeleton" style={{ width: 220, maxWidth: '100%', height: 24 }} /><div className="skeleton" style={{ width: '80%', height: 13, marginTop: 13 }} /><div className="skeleton" style={{ width: '100%', height: 170, marginTop: 20 }} /></div>
        </div>
      </section>
    </main>
  );
}

function ActionCard({ action, currentTime, canConfirm, busy, unknown, submitted, receipt, onOpenDashboard, onReview, onReconcile, onRefresh, onPrepare, onDetails, preparationBlockedReason, mutationKind, mutationUncertain, mutationRejected, canReview, profiles }: {
  action: PendingAction; currentTime: number; canConfirm: boolean; busy: boolean; unknown?: UnknownExecution; submitted: boolean;
  receipt?: ReceiptView; onOpenDashboard: (id: string) => void;
  onReview: (action: PendingAction) => void; onReconcile: (executionId: string) => void; onRefresh: () => void;
  onPrepare: (action: PendingAction) => void; onDetails: (action: PendingAction) => void; preparationBlockedReason?: string; mutationKind?: 'revise' | 'cancel'; mutationUncertain?: boolean; mutationRejected?: boolean; canReview?: boolean; profiles?: Workspace['profiles'];
}) {
  const terminalReceipt = receipt?.actionId === action.id && receipt.visibility !== 'restricted' && receipt.status !== 'pending' ? receipt : undefined;
  const verifiedReceipt = terminalReceipt?.status === 'verified_success' ? terminalReceipt : undefined;
  const displayedUnknown = terminalReceipt ? undefined : unknown;
  const displayedMutationUncertain = terminalReceipt ? false : mutationUncertain;
  const displayedMutationRejected = terminalReceipt ? false : mutationRejected;
  const dashboardId = verifiedReceipt?.kind === 'dashboard_create' && action.payload.kind === 'dashboard_create' ? verifiedReceipt.dashboardId : undefined;
  const status = terminalReceipt ? { key: terminalReceipt.status, ...receiptStatus(terminalReceipt.status) } : mutationKind ? { key: 'revising', label: mutationKind === 'revise' ? 'กำลังตรวจคำขอแก้ไข' : 'กำลังยกเลิกข้อเสนอ', tone: 'badge-info' } : displayedMutationRejected ? { key: 'rejected', label: 'ต้องเตรียมข้อเสนอใหม่', tone: 'badge-warning' } : displayedMutationUncertain ? { key: 'unresolved', label: 'ยังไม่ทราบผลคำขอเปลี่ยนข้อเสนอ', tone: 'badge-warning' } : actionState(action, currentTime);
  const renewable = ['expired', 'stale', 'invalid', 'rejected'].includes(status.key) && !submitted && !displayedUnknown;
  return <article className="action-row" tabIndex={-1} data-action-id={action.id} data-action-state={status.key}>
    <div className="action-row-top"><h3>{actionLabel(action.payload.kind)}</h3><span className={`badge ${displayedUnknown ? 'badge-danger' : status.tone}`} data-action-receipt-status={terminalReceipt?.status}>{terminalReceipt ? status.label : displayedUnknown ? 'ยังไม่ทราบผล' : submitted ? 'ส่งแล้ว · ตรวจผลในประวัติ' : status.label}</span></div>
    <ActionSummary action={action} profiles={profiles} />
    {verifiedReceipt && <div className="proposal-summary" role="status" aria-label="ผลที่ตรวจสอบแล้ว"><p>ตรวจสอบผลสำเร็จ</p>{dashboardId && <p>Dashboard พร้อมเปิดดูแล้ว</p>}</div>}
    {displayedUnknown && <p className="record-body" role="status">{displayedUnknown.message}</p>}
    {renewable && <p className="record-body">{displayedMutationRejected ? 'คำขอเปลี่ยนข้อเสนอถูกปฏิเสธ ข้อเสนอเดิมยังยืนยันไม่ได้ กรุณาตรวจสถานะหรือเตรียมรายการใหม่ให้ระบบตรวจข้อมูลปัจจุบัน' : 'รายการนี้ยืนยันต่อไม่ได้ เริ่มคำขอใหม่เพื่อให้ตรวจข้อมูลปัจจุบันก่อนเตรียมข้อเสนอ'}</p>}
    {!displayedUnknown && !submitted && status.key === 'pending' && !canConfirm && <p className="record-body">{action.payload.kind === 'badge_revoke' ? 'เปิดตรวจและยืนยัน เพื่ออ่านชื่อพนักงานและสถานะบัตรล่าสุดก่อนดำเนินการ' : 'ยังยืนยันไม่ได้ โปรดตรวจสิทธิ์ ขอบเขต และโหมดของรายการ'}</p>}
    {renewable && preparationBlockedReason && <p className="record-body" role="status">{preparationBlockedReason}</p>}
    <div className="action-footer"><div className="action-details"><span>เตรียม {formatDate(action.createdAt)}</span><span>หมดอายุ {formatDate(action.expiresAt)}</span></div><div className="record-end" style={displayedMutationRejected ? { maxWidth: "100%" } : undefined}>
      <button className="btn btn-small" type="button" onClick={() => onDetails(action)}>รายละเอียดรายการ</button>
      {dashboardId && <button className="btn btn-small btn-primary" type="button" data-open-dashboard={dashboardId} onClick={() => onOpenDashboard(dashboardId)}>เปิด Dashboard</button>}
      {displayedUnknown && <button className="btn btn-small" type="button" disabled={busy} onClick={() => onReconcile(displayedUnknown.executionId ?? displayedUnknown.actionId)}>ตรวจผลคำขอเดิม</button>}
      {displayedUnknown && <button className="text-button" type="button" disabled={busy} onClick={onRefresh}>โหลดสถานะ</button>}
      {displayedMutationUncertain && <button className="btn btn-small" type="button" disabled={busy} onClick={onRefresh}>ตรวจผลคำขอเดิม</button>}
      {renewable && <button className="btn btn-small" type="button" disabled={busy || Boolean(preparationBlockedReason)} title={preparationBlockedReason} onClick={() => onPrepare(action)}>เตรียมรายการใหม่</button>}
      {!displayedUnknown && !submitted && actionState(action, currentTime).key === 'pending' && (canReview || canConfirm) && <button className="btn btn-small btn-primary" type="button" data-action-review={action.id} disabled={busy} onClick={() => onReview(action)}>{canConfirm || action.payload.kind === 'badge_revoke' ? 'ตรวจและยืนยัน' : 'ตรวจข้อเสนอ'}</button>}
    </div></div>
    <details className="technical-detail"><summary>รายละเอียดทางเทคนิค</summary><pre className="action-preview">{JSON.stringify({ id: action.id, payload: action.payload, evidenceVersion: action.evidenceVersion, mode: action.mode, receipt: terminalReceipt }, null, 2)}</pre></details>
  </article>;
}

/** Business outcome first; verification counts stay in the technical details. */
function receiptOutcomeText(receipt: ReceiptView) {
  const label = receipt.kind ? actionLabel(receipt.kind) : 'รายการ';
  const total = receipt.results.length;
  const ok = receipt.results.filter(result => result.status === 'verified_success').length;
  const pending = receipt.results.filter(result => result.status === 'pending').length;
  const bad = total - ok - pending;
  if (receipt.status === 'verified_success') return `${label} เรียบร้อยแล้ว${total > 1 ? ` (${total} รายการ)` : ''}`;
  if (receipt.status === 'pending') return `${label}: กำลังรอยืนยันผลจากระบบปลายทาง${ok ? ` (สำเร็จแล้ว ${ok} จาก ${total} รายการ)` : ''}`;
  return `${label} ไม่สำเร็จ${total > 1 ? ` ${bad} จาก ${total} รายการ` : ''} — ตรวจรายละเอียดหรือเตรียมใหม่อีกครั้ง`;
}

function ReceiptRecord({ receipt, onReconcile, onDetails, busy = false }: { receipt: ReceiptView; onReconcile?: (receipt: ReceiptView, readbackRevision?: string) => void; onDetails?: (receipt: ReceiptView) => void; busy?: boolean }) {
  const restricted = receipt.visibility === 'restricted';
  const status = receiptStatus(receipt.status);
  const canUseCurrentVerifier = !restricted && receipt.status === 'pending' && Boolean(receipt.readbackRevision);
  return <article className={`record-row${restricted ? ' restricted-receipt' : ''}${canUseCurrentVerifier ? ' receipt-with-upgrade' : ''}`}><div className="record-main"><strong>{restricted ? 'จำกัดสิทธิ์อ่านผลเดิม' : actionLabel(receipt.kind)}</strong><span>บันทึก {formatDate(receipt.createdAt)}{receipt.verifiedAt ? ` · ตรวจผล ${formatDate(receipt.verifiedAt)}` : ''}</span><p className="record-body">{restricted ? 'โปรไฟล์นี้ไม่มีสิทธิ์อ่านรายละเอียดผลเดิม' : receiptOutcomeText(receipt)}</p>{canUseCurrentVerifier && <p className="record-body">ตรวจผลด้วยตัวตรวจสอบรุ่นปัจจุบันได้ โดยไม่สร้างรายการปลายทางใหม่</p>}<details className="technical-detail"><summary>รายละเอียดทางเทคนิค</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details></div><div className="record-end"><span className={`badge ${restricted ? 'badge-warning' : status.tone}`}>{restricted ? 'จำกัดสิทธิ์' : status.label}</span>{onDetails && <button className="btn btn-small" type="button" onClick={() => onDetails(receipt)}>รายละเอียดผล</button>}{restricted && onReconcile && <button className="btn btn-small" type="button" disabled={busy} onClick={() => onReconcile(receipt)}>ตรวจสิทธิ์และอ่านผลเดิม</button>}{!restricted && receipt.status === 'pending' && onReconcile && <button className="btn btn-small" type="button" disabled={busy} aria-label={`ตรวจผลคำขอเดิม: ${actionLabel(receipt.kind)}`} onClick={() => onReconcile(receipt)}>ตรวจผลคำขอเดิม</button>}{canUseCurrentVerifier && onReconcile && <button className="btn btn-small btn-primary" type="button" disabled={busy} aria-label={`ตรวจผลด้วยรุ่นปัจจุบัน: ${actionLabel(receipt.kind)}`} onClick={() => onReconcile(receipt, receipt.readbackRevision)}>ตรวจผลด้วยรุ่นปัจจุบัน</button>}</div></article>;
}


function DashboardRecord({ dashboard, onOpen, onShare, onTasks, canShare, canTasks, onOrganize, organizeBusy = false }: { dashboard: Dashboard; onOpen: (id: string) => void; onShare: (id: string) => void; onTasks: (id: string) => void; canShare: boolean; canTasks: boolean; onOrganize?: (id: string, op: DashboardOrganizeOp) => void; organizeBusy?: boolean }) {
  const dashboardSources = dashboardSourcesForWidgets(dashboard.sourceMetadata, dashboard.spec.widgets);
  return <article className="record-row" data-dashboard-record={dashboard.id} data-dashboard-pinned={dashboard.pinnedAt ? 'true' : 'false'} data-dashboard-archived={dashboard.archivedAt ? 'true' : 'false'}><div className="record-main">{dashboard.pinnedAt && <span className="badge badge-info" style={{ justifySelf: 'start' }} data-dashboard-pin-badge>ปักหมุด</span>}<button type="button" className="text-button record-link" style={{ justifySelf: 'start', textAlign: 'left' }} onClick={() => onOpen(dashboard.id)}>{dashboard.spec.title}</button><span>{dashboard.spec.description || 'ไม่มีคำอธิบาย'} · อัปเดต {formatDate(dashboard.updatedAt)}</span><span>{dashboardSources.length ? `${dashboardSources.length} แหล่งข้อมูล` : 'ยังไม่มีข้อมูลแหล่งที่มา'}</span><div className="record-end" style={{ justifyContent: 'flex-start', marginTop: 4 }}>{dashboardSources.slice(0, 4).map(source => { const state = freshness(source.freshness); return <span className={`badge ${state[1]}`} key={source.id}>{sourceDisplayName(source.system)}: {state[0]}</span>; })}</div></div><div className="record-end"><button className="btn btn-small" type="button" onClick={() => onOpen(dashboard.id)}>เปิด</button>{canShare && <button className="btn btn-small" type="button" onClick={() => onShare(dashboard.id)}>เตรียมแชร์</button>}{canTasks && <button className="btn btn-small" type="button" onClick={() => onTasks(dashboard.id)}>เตรียมงานติดตาม</button>}{onOrganize && <>{!dashboard.archivedAt && <button className="btn btn-small" type="button" data-dashboard-action={dashboard.pinnedAt ? 'unpin' : 'pin'} aria-pressed={Boolean(dashboard.pinnedAt)} disabled={organizeBusy} onClick={() => onOrganize(dashboard.id, dashboard.pinnedAt ? 'unpin' : 'pin')}>{dashboard.pinnedAt ? 'เลิกปักหมุด' : 'ปักหมุด'}</button>}<button className="btn btn-small" type="button" data-dashboard-action="duplicate" disabled={organizeBusy} onClick={() => onOrganize(dashboard.id, 'duplicate')}>ทำสำเนา</button><button className="btn btn-small" type="button" data-dashboard-action={dashboard.archivedAt ? 'restore' : 'archive'} disabled={organizeBusy} onClick={() => onOrganize(dashboard.id, dashboard.archivedAt ? 'restore' : 'archive')}>{dashboard.archivedAt ? 'นำกลับมา' : 'เก็บถาวร'}</button></>}</div></article>;
}

function freshness(status: Dashboard['sourceMetadata'][number]['freshness']) {
  const labels = { fresh: [freshnessText.fresh, 'badge-info'], stale: [freshnessText.stale, 'badge-warning'], misaligned: [freshnessText.misaligned, 'badge-danger'], missing: [freshnessText.missing, 'badge-danger'] } as const;
  return labels[status];
}

function EmptyPanel({ icon, title, message, action }: { icon: IconName; title: string; message: string; action?: React.ReactNode }) {
  return <div className={`panel ${styles.emptyPanel}`}><div className={styles.emptyPanelContent}><div className={styles.emptyPanelIcon}><Icon name={icon} size={20} /></div><h2>{title}</h2><p>{message}</p>{action && <div className={styles.emptyPanelAction}>{action}</div>}</div></div>;
}

function ScenarioPanel({ busy, unknown, onPropose }: { busy: boolean; unknown: string | null; onPropose: (scenario: Scenario) => void }) {
  const scenarios: { id: Scenario; title: string; description: string }[] = [
    { id: 'stock_recovered', title: demoScenarioLabel.stock_recovered, description: demoScenarioImpact.stock_recovered },
    { id: 'payment_resolved', title: demoScenarioLabel.payment_resolved, description: demoScenarioImpact.payment_resolved },
    { id: 'baseline', title: demoScenarioLabel.baseline, description: demoScenarioImpact.baseline },
  ];
  return (
    <section className="panel">
      <header className="panel-header"><div><h2 className="panel-title">จำลองสถานการณ์ด้วยข้อมูล Demo</h2><p className="panel-subtitle">เลือกสถานการณ์เพื่อให้ระบบเตรียมรายการ จากนั้นตรวจรายละเอียดและยืนยันก่อนเปลี่ยนข้อมูล</p></div><span className="badge badge-demo">โหมดสาธิต</span></header>
      <div className="panel-body"><div className="demo-controls">{unknown && <div className="warning-banner" role="status"><Icon name="alertCircle" /><div className="banner-copy"><strong>ยังไม่ทราบว่าเตรียมรายการสำเร็จหรือไม่</strong><p>{unknown} · โหลดสถานะเพื่อตรวจว่ามีรายการรอยืนยันแล้วหรือไม่ ก่อนเริ่มคำขอใหม่</p></div></div>}{scenarios.map((scenario) => <button className="demo-scenario" type="button" key={scenario.id} disabled={busy || Boolean(unknown)} onClick={() => onPropose(scenario.id)}><span><strong>{scenario.title}</strong><span>{scenario.description}</span></span><Icon name="chevron" size={15} /></button>)}</div><p className="freshness-note">ระบบจะเปลี่ยนข้อมูลหลังจากคุณตรวจรายละเอียดและยืนยันรายการแล้วเท่านั้น</p></div>
    </section>
  );
}


const dashboardPathId = (pathname: string) => {
  const match = /^\/dashboards\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
};

export default function NexusWorkspace({ requestedDashboardId: initialDashboardId }: { requestedDashboardId?: string }) {
  // Dashboard selection lives in state and is mirrored to the URL with history.pushState, so opening a dashboard never remounts the workspace.
  const [requestedDashboardId, setRequestedDashboardId] = useState<string | undefined>(initialDashboardId);
  const [screen, setScreen] = useState<ScreenState>('checking');
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const workspaceReadGeneration = useRef(0);
  const readLatestWorkspace = useCallback(async (): Promise<{ generation: number; workspace: Workspace } | { generation: number; error: unknown }> => {
    const generation = ++workspaceReadGeneration.current;
    try {
      return { generation, workspace: await apiRequest<Workspace>('/api/workspace', {}, 30_000) };
    } catch (error) {
      return { generation, error };
    }
  }, []);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [activeSection, setActiveSection] = useState<Section>(requestedDashboardId ? 'dashboard' : 'overview');
  const [dashboardResult, setDashboardResult] = useState<DashboardView | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardReload, setDashboardReload] = useState(0);
  const [dashboardTaskTarget, setDashboardTaskTarget] = useState<{ dashboardId: string; title: string; actorId: string; sessionId: string } | null>(null);
  const dashboardTaskTrigger = useRef<HTMLElement | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [demoGuideOpen, setDemoGuideOpen] = useState(false);
  const [aiUnavailable, setAIUnavailable] = useState(false);
  const [aiUnavailableStatus, setAIUnavailableStatus] = useState<'unavailable' | 'not_configured'>('unavailable');
  const aiAvailabilityDismissed = useRef(false);
  const guideSeen = useRef(new Set<string>());
  const guideActorId = session?.actor.id;
  const guideSessionId = session?.actor.sessionId;
  const guideMode = session?.actor.mode;
  useEffect(() => {
    if (!guideActorId || !guideSessionId) return;
    aiAvailabilityDismissed.current = false;
    let cancelled = false;
    async function checkMode() {
      if (guideMode === 'scripted_demo') {
        const key = `biztania:demo-guide:v1:${guideActorId}:${guideSessionId}`;
        let seen = guideSeen.current.has(key);
        try { seen ||= window.sessionStorage.getItem(key) === 'seen'; } catch { /* Use this tab's in-memory record. */ }
        if (!seen && !cancelled) {
          guideSeen.current.add(key);
          try { window.sessionStorage.setItem(key, 'seen'); } catch { /* The guide remains usable without storage. */ }
          setDemoGuideOpen(true);
        }
        return;
      }
      try {
        const health = await apiRequest<AIHealth>('/api/ai/health', {}, 8_000);
        if (!cancelled && !aiAvailabilityDismissed.current && (health.status === 'unavailable' || health.status === 'not_configured')) {
          setAIUnavailable(true);
          setAIUnavailableStatus(health.status);
        }
      } catch { /* A failed health read is not proof of provider failure. */ }
    }
    void checkMode();
    return () => { cancelled = true; };
  }, [guideActorId, guideSessionId, guideMode]);
  const [draft, setDraft] = useState('');
  // Server-owned work-catalog entry bound to the current draft; any edit clears it (ChatThread), so typed text is never treated as an entry.
  const [catalogEntryId, setCatalogEntryId] = useState<string | undefined>(undefined);
  // Owned resource the user selected on a screen (e.g. a Result version on the Results page): sent as an exact server-verified target with the next message.
  const [turnTargets, setTurnTargets] = useState<{ kind: 'artifact' | 'dashboard' | 'monitor'; id: string; revision?: number }[] | undefined>(undefined);
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnRecovery, setTurnRecovery] = useState<TurnRecovery | null>(null);
  const [recoveryChecking, setRecoveryChecking] = useState(false);
  const [chatRejection, setChatRejection] = useState<string | null>(null);
  const [blockedRequestTexts, setBlockedRequestTexts] = useState<string[]>([]);
  const [newConversation, setNewConversation] = useState(false);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [responseContexts, setResponseContexts] = useState<LocalMessage[]>([]);
  const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null);
  const [selectedAction, setSelectedAction] = useState<PendingAction | null>(null);
  const [badgeReviewRead, setBadgeReviewRead] = useState<{ actionId: string; payloadHash: string; status: BadgeReviewStatus } | null>(null);
  const badgeReviewGeneration = useRef(0);
  const [confirmBusyId, setConfirmBusyId] = useState<string | null>(null);
  const confirmationFocusRef = useRef<string | null>(null);
  const [actionMutation, setActionMutation] = useState<ActionMutation | null>(null);
  const actionMutationRef = useRef<ActionMutation | null>(null);
  const [uncertainActionMutations, setUncertainActionMutations] = useState<ActionMutationMemory>({});
  const [confirmError, setConfirmError] = useState<{ actionId: string; message: string } | null>(null);
  const [unknownExecutions, setUnknownExecutions] = useState<Record<string, UnknownExecution>>({});
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioUnknown, setScenarioUnknown] = useState<string | null>(null);
  const [scenarioUnknownId, setScenarioUnknownId] = useState<Scenario | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | { message: string; tone: 'success' } | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationTitles, setConversationTitles] = useState<Record<string, string>>({});
  const updateConversationTitles = useCallback((titles: Record<string, string>) => setConversationTitles(current => ({ ...current, ...titles })), []);
  const [contextOpen, setContextOpen] = useState(false);
  const [sourceTarget, setSourceTarget] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => { if (!media.matches) setSessionsOpen(false); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const sessionsDialogRef = useRef<HTMLDialogElement>(null);
  const submissionRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [activeStreamTurn, setActiveStreamTurn] = useState<TurnRecovery | null>(null);
  const [completionNotice, setCompletionNotice] = useState<{ turnId: string; text: string } | null>(null);

  useEffect(() => () => streamAbortRef.current?.abort(), []);

  useEffect(() => {
    const actionId = confirmationFocusRef.current;
    if (!actionId || confirmBusyId || selectedAction) return;
    confirmationFocusRef.current = null;
    const card = Array.from(document.querySelectorAll<HTMLElement>('[data-action-id]')).find(item => item.dataset.actionId === actionId);
    (card?.querySelector<HTMLButtonElement>('[data-open-dashboard]') ?? card)?.focus();
  }, [confirmBusyId, selectedAction, workspace]);

  useEffect(() => {
    const restoreSection = () => {
      const section = new URLSearchParams(window.location.search).get('section');
      const supported: Section[] = ['overview', 'dashboards', 'inbox', 'messages', 'actions', 'audit', 'capabilities', 'results'];
      setActiveSection(supported.includes(section as Section) ? section as Section : 'overview');
      setRequestedDashboardId(dashboardPathId(window.location.pathname));
      setContextOpen(false);
      setOperationNotice(current => current && typeof current !== 'string' ? null : current);
    };
    restoreSection();
    window.addEventListener('popstate', restoreSection);
    return () => window.removeEventListener('popstate', restoreSection);
  }, []);


  useEffect(() => {
    const dialog = sessionsDialogRef.current;
    if (sessionsOpen && dialog && !dialog.open) dialog.showModal();
    if (!sessionsOpen && dialog?.open) dialog.close();
  }, [sessionsOpen]);

  const displayedSection: Section = requestedDashboardId ? 'dashboard' : activeSection;
  const actor = session?.actor ?? workspace?.actor ?? null;
  const actorId = actor?.id;
  const actorSessionId = actor?.sessionId;
  const csrfToken = session?.csrfToken ?? workspace?.csrfToken;
  const sessionId = session?.actor.sessionId;

  // Router-staged proposals (dashboard.delete, communication.send, monitor.create). Empty when the store lacks router_proposals.
  const [stagedProposals, setStagedProposals] = useState<RouterProposalView[]>([]);
  const [proposalsLoadError, setProposalsLoadError] = useState<string | null>(null);
  const refreshProposals = useCallback(async () => {
    const result = await loadPendingProposals(apiRequest);
    if (result.status === 'ready') { setStagedProposals(result.proposals); setProposalsLoadError(null); }
    else setProposalsLoadError(result.message); // keep the last good list: an error is never shown as "nothing pending"
  }, []);
  const [reviewedProposal, setReviewedProposal] = useState<RouterProposalView | null>(null);
  const [proposalBusy, setProposalBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalReceipt, setProposalReceipt] = useState<ProposalConfirmResult | { outcome: 'cancelled'; text: string } | null>(null);
  const [conversationReceiptState, setConversationReceiptState] = useState<ConversationReceiptLoadState>({ scopeKey: null, requestId: 0, items: [], hasOlder: false, error: false });
  const [conversationReceiptAttempt, setConversationReceiptAttempt] = useState(0);
  const conversationReceiptRequestId = useRef(0);
  const conversationReceipts = conversationReceiptState.items;
  const [artifactBusy, setArtifactBusy] = useState<{ artifactId: string; operation: ArtifactOperation } | null>(null);
  const [artifactNotice, setArtifactNotice] = useState<{ artifactId: string; tone: 'ok' | 'error'; text: string } | null>(null);
  const proposalRefreshKey = `${session?.actor.id ?? ''}:${workspace?.messages.length ?? 0}:${workspace?.actions.length ?? 0}:${workspace?.receipts.length ?? 0}:${proposalReceipt?.outcome ?? ''}:${proposalReceipt?.text ?? ''}`;
  const selectedReceiptConversationId = selectedConversationId ?? (newConversation ? null : workspace ? recentConversationId([...workspace.messages, ...localMessages], workspace.actor.id) ?? null : null);
  const receiptConversationId = selectedReceiptConversationId?.startsWith('local-conversation-') ? null : selectedReceiptConversationId;
  const receiptActorId = session?.actor.id;
  const receiptSessionId = session?.actor.sessionId;
  const workspaceDashboards = workspace?.dashboards;
  useEffect(() => {
    if (screen !== 'ready' || !csrfToken || !workspace) { setStagedProposals([]); setProposalsLoadError(null); return; }
    let cancelled = false;
    void loadPendingProposals(apiRequest).then(result => {
      if (cancelled) return;
      if (result.status === 'ready') { setStagedProposals(result.proposals); setProposalsLoadError(null); } else setProposalsLoadError(result.message);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, csrfToken, proposalRefreshKey]);

  useEffect(() => {
    const requestId = ++conversationReceiptRequestId.current;
    if (screen !== 'ready' || !csrfToken || !receiptConversationId || !receiptActorId || !receiptSessionId) {
      setConversationReceiptState(current => beginConversationReceiptLoad(current, null, requestId));
      return;
    }
    const scopeKey = JSON.stringify([receiptActorId, receiptSessionId, receiptConversationId]);
    let cancelled = false;
    setConversationReceiptState(current => beginConversationReceiptLoad(current, scopeKey, requestId));
    void apiRequest<unknown>(`/api/router-proposals/receipts?conversationId=${encodeURIComponent(receiptConversationId)}&limit=100`, {}, 8_000)
      .then(value => {
        if (cancelled) return;
        const page = parseRouterReceiptPage(value);
        setConversationReceiptState(current => finishConversationReceiptLoad(current, scopeKey, requestId, page));
      })
      .catch(() => { if (!cancelled) setConversationReceiptState(current => finishConversationReceiptLoad(current, scopeKey, requestId, null)); });
    return () => { cancelled = true; };
  }, [screen, csrfToken, receiptConversationId, proposalRefreshKey, receiptActorId, receiptSessionId, conversationReceiptAttempt]);

  useEffect(() => {
    if (!dashboardTaskTarget) return;
    const ownedIds = workspaceDashboards && actorId && actorSessionId
      ? workspaceDashboards.filter(dashboard => dashboard.ownerId === actorId).map(dashboard => dashboard.id)
      : null;
    if (!reconcileDashboardTaskTarget(dashboardTaskTarget, actorId && actorSessionId ? { id: actorId, sessionId: actorSessionId } : null, ownedIds)) setDashboardTaskTarget(null);
  }, [dashboardTaskTarget, actorId, actorSessionId, workspaceDashboards]);

  // Unread simulated-inbox messages (badge on the Messages nav). The badge shows the SERVER's authoritative unread count; only the Messages
  // panel acknowledges messages (exactly the ones it displayed) and reports the server's remaining count back through this event.
  const [unreadMessages, setUnreadMessages] = useState(0);
  useEffect(() => {
    if (screen !== 'ready' || !csrfToken || !workspace) { setUnreadMessages(0); return; }
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiRequest<{ unreadTotal?: number }>('/api/inbox?limit=1', { cache: 'no-store' }, 8_000);
        if (!cancelled && typeof body.unreadTotal === 'number') setUnreadMessages(body.unreadTotal);
      } catch { /* keep the last known badge */ }
    })();
    const onUnread = (event: Event) => { const count = (event as CustomEvent<number>).detail; if (typeof count === 'number' && count >= 0) setUnreadMessages(count); };
    window.addEventListener('biztania:inbox-unread', onUnread);
    return () => { cancelled = true; window.removeEventListener('biztania:inbox-unread', onUnread); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, csrfToken, proposalRefreshKey, displayedSection]);

  useEffect(() => {
    if (requestedDashboardId || screen !== 'ready' || !session || !workspace || workspace.actor.id !== session.actor.id || workspace.actor.sessionId !== session.actor.sessionId) return;
    let raw: string | null;
    try {
      raw = window.sessionStorage.getItem(composerPrefillKey);
      if (!raw) return;
      window.sessionStorage.removeItem(composerPrefillKey);
    } catch {
      setOperationNotice('อ่านคำถามที่เตรียมไว้ไม่ได้ กรุณาเลือกข้อเสนอจาก Dashboard อีกครั้ง');
      return;
    }
    let item: unknown;
    try { item = raw.length <= 12_000 ? JSON.parse(raw) : null; } catch { return; }
    if (!validDashboardPrefill(item) || item.actorId !== session.actor.id || item.sessionId !== session.actor.sessionId) return;
    const age = Date.now() - item.createdAt;
    if (age < 0 || age > composerPrefillLifetimeMs) {
      setOperationNotice('คำถามที่เตรียมไว้หมดอายุ กรุณาเลือกข้อเสนอจาก Dashboard อีกครั้ง');
      return;
    }
    const entry = workspaceCatalog(workspace).find(entry => entry.id === item.catalogId && entry.actionKind === item.actionKind && entry.prompt === item.prompt);
    if (!entry) {
      setOperationNotice('รายการงานเปลี่ยนไป กรุณาเลือกข้อเสนอที่พร้อมใช้อีกครั้ง');
      return;
    }
    const request = dashboardIntentRequest({ ...item, prompt: entry.prompt }, workspace, session.actor.id);
    if (!request) {
      setOperationNotice('ตัวเลือกงานติดตามเปลี่ยนไป กรุณาเลือกผู้รับผิดชอบและกำหนดส่งจาก Dashboard อีกครั้ง');
      return;
    }
    setDraft(request.prompt);
    setCatalogEntryId(undefined);
    setTurnTargets(request.targets);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="ข้อความถึง DaTex"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [requestedDashboardId, screen, session, workspace]);


  const applyCanonicalTurn = useCallback((turn: TurnResponse, responseActor: Actor, original: TurnRecovery, blockedTexts: string[], previousConversationId?: string, optimisticIds: string[] = [], replaceUser = true, announce = false) => {
    const common = { conversationId: turn.conversationId, actorId: responseActor.id, sessionId: responseActor.sessionId, turnId: turn.turnId, mode: turn.mode, modeRevision: responseActor.modeRevision, createdAt: new Date().toISOString(), local: true as const };
    const userMessage: LocalMessage = { ...common, id: turn.turnId, role: 'user', text: original.message, createdAt: original.startedAt };
    const assistantMessage: LocalMessage = { ...common, id: turn.assistantMessageId, role: 'assistant', text: turn.message, analysis: turn.analysis, responseAnalysis: turn.analysis, evidence: turn.evidence, sources: responseSources(turn), pendingActionId: turn.pendingAction?.id, pendingActionIds: turn.pendingActions?.map((action) => action.id), receiptId: turn.receipt?.id, clarification: turn.clarification, ...(turn.choices ? { choices: turn.choices } : {}), ...(turn.artifacts ? { artifacts: turn.artifacts } : {}), ...(turn.hint ? { hint: turn.hint } : {}), ...(turn.receiptCards ? { receiptCards: turn.receiptCards } : {}) };
    setLocalMessages((current) => [...current.filter((entry) => !optimisticIds.includes(entry.id) && entry.id !== turn.assistantMessageId && (!replaceUser || entry.id !== turn.turnId) && (!original.requestKey || entry.requestKey !== original.requestKey)).map((entry) => entry.conversationId === previousConversationId ? { ...entry, conversationId: turn.conversationId } : entry), ...(replaceUser ? [userMessage] : []), assistantMessage]);
    setSelectedConversationId(turn.conversationId);
    setResponseContexts((current) => [...current.filter((entry) => entry.id !== assistantMessage.id).slice(-29), assistantMessage]);
    const actions = turn.pendingActions ?? (turn.pendingAction ? [turn.pendingAction] : []);
    const receipts = turn.receipts ?? (turn.receipt ? [turn.receipt] : []);
    setWorkspace((current) => current ? { ...current, actions: [...actions, ...current.actions.filter((action) => !actions.some((next) => next.id === action.id))], receipts: [...receipts, ...current.receipts.filter((receipt) => !receipts.some((next) => next.id === receipt.id))] } : current);
    setTurnRecovery(null);
    setActiveStreamTurn(null);
    setNewConversation(false);
    setCompletionNotice(announce ? { turnId: turn.turnId, text: turn.message } : null);
    writeRecoveryMemory(responseActor, null, blockedTexts, false, turn.conversationId);
  }, []);

  const applyExactRecovery = useCallback((result: ChatRecoveryResult, original: TurnRecovery, responseActor: Actor, blockedTexts: string[], announce = false) => {
    if (result.status === 'completed') {
      if ((original.turnId && result.response.turnId !== original.turnId) || (original.assistantMessageId && result.response.assistantMessageId !== original.assistantMessageId) || (original.conversationId && result.response.conversationId !== original.conversationId)) throw new ChatStreamError('invalid_response');
      applyCanonicalTurn(result.response, responseActor, original, blockedTexts, `local-conversation-${original.requestKey}`, [], true, announce);
      setOperationNotice('พบคำตอบที่บันทึกไว้แล้ว กู้คืนคำขอเดิมโดยไม่ได้ส่งซ้ำ');
      return;
    }
    if (result.status !== 'unavailable' && ((original.turnId && result.turnId !== original.turnId) || (original.conversationId && result.conversationId !== original.conversationId))) throw new ChatStreamError('invalid_response');
    const errorMessage = result.status === 'in_progress' ? 'คำขอเดิมยังอยู่ระหว่างดำเนินการ ตรวจสถานะอีกครั้งได้โดยไม่ส่งซ้ำ' : result.status === 'failed' ? 'ตรวจแล้วว่าคำขอเดิมสิ้นสุดโดยไม่มีคำตอบที่บันทึกสำเร็จ คุณถามต่อได้โดยไม่ส่งคำขอเดิมซ้ำ' : 'ยังยืนยันผลคำขอเดิมไม่ได้ กรุณาตรวจสถานะอีกครั้ง ระบบจะไม่ส่งข้อความเดิมซ้ำ';
    const next: TurnRecovery = { ...original, statusChecked: true, recoveryStatus: result.status, errorMessage, ...(result.status !== 'unavailable' ? { turnId: result.turnId, conversationId: result.conversationId } : {}) };
    setTurnRecovery(next);
    setLocalMessages((current) => {
      const restored = recoverLocalMessages(next, responseActor);
      return [...current.filter((entry) => entry.requestKey !== next.requestKey), ...restored];
    });
    setSelectedConversationId(next.conversationId ?? next.requestConversationId ?? `local-conversation-${next.requestKey}`);
    writeRecoveryMemory(responseActor, next, blockedTexts, false, next.conversationId ?? next.requestConversationId ?? undefined);
  }, [applyCanonicalTurn]);

  const applyTurnReadback = useCallback((recovery: TurnRecovery, fresh: Workspace, blockedTexts: string[]) => {
    if (recovery.requestKey) {
      // Exact key recovery is activated with the server adapter, never inferred from text/time.
      setTurnRecovery(recovery);
      setLocalMessages(recoverLocalMessages(recovery, fresh.actor));
      setSelectedConversationId(recovery.conversationId ?? recovery.requestConversationId ?? `local-conversation-${recovery.requestKey}`);
      writeRecoveryMemory(fresh.actor, recovery, blockedTexts, false, recovery.conversationId ?? recovery.requestConversationId ?? undefined);
      return;
    }
    const candidates = fresh.messages.filter((entry) => entry.role === 'user' && entry.actorId === fresh.actor.id && (recovery.turnId ? entry.id === recovery.turnId : !recovery.previousMessageIds.includes(entry.id) && entry.text === recovery.message && (!recovery.conversationId || entry.conversationId === recovery.conversationId) && new Date(entry.createdAt).getTime() >= new Date(recovery.startedAt).getTime() - 1000));
    const original = candidates.length === 1 ? candidates[0] : undefined;
    const originalTurnId = recovery.turnId ?? original?.id;
    const action = originalTurnId ? fresh.actions.find((entry) => entry.actorId === fresh.actor.id && entry.sessionId === fresh.actor.sessionId && entry.turnId === originalTurnId) : undefined;
    const nextUserTime = original ? Math.min(...fresh.messages.filter((entry) => entry.role === 'user' && entry.conversationId === original.conversationId && new Date(entry.createdAt).getTime() > new Date(original.createdAt).getTime()).map((entry) => new Date(entry.createdAt).getTime())) : 0;
    const answer = original ? fresh.messages.find((entry) => entry.role === 'assistant' && entry.actorId === fresh.actor.id && entry.conversationId === original.conversationId && !recovery.previousMessageIds.includes(entry.id) && new Date(entry.createdAt).getTime() >= new Date(original.createdAt).getTime() && new Date(entry.createdAt).getTime() < nextUserTime) : undefined;
    if (action || answer) {
      setTurnRecovery(null);
      setDraft('');
      setNewConversation(false);
      const conversationId = answer?.conversationId ?? original?.conversationId ?? recovery.conversationId;
      if (conversationId) setSelectedConversationId(conversationId);
      writeRecoveryMemory(fresh.actor, null, blockedTexts, false, conversationId);
      setOperationNotice('พบผลคำขอเดิมในประวัติแล้ว ตรวจคำตอบและรายการที่บันทึกไว้ได้ โดยไม่ได้ส่งคำขอเดิมซ้ำ');
      return;
    }
    const next = { ...recovery, statusChecked: true, ...(recovery.failedResponse && original ? { turnId: original.id, conversationId: original.conversationId } : {}) };
    setTurnRecovery(next);
    writeRecoveryMemory(fresh.actor, next, blockedTexts, false, next.conversationId ?? original?.conversationId ?? undefined);
  }, []);

  useEffect(() => {
    const update = () => setCurrentTime(Date.now());
    update();
    const interval = window.setInterval(update, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setScreen('checking');
      setLoginError(null);
      try {
        const currentSession = await apiRequest<Session>('/api/session', {}, 30_000);
        if (cancelled) return;
        const memory = readRecoveryMemory(currentSession.actor);
        setTurnRecovery(memory.pending);
        setBlockedRequestTexts(memory.blockedTexts);
        setNewConversation(memory.newConversation);
        if (memory.pending) setDraft(memory.pending.requestKey ? '' : memory.pending.message);
        setSession(currentSession);
        setScreen('ready');
        try {
          const read = await readLatestWorkspace();
          if (cancelled || read.generation !== workspaceReadGeneration.current) return;
          if ('error' in read) throw read.error;
          const currentWorkspace = read.workspace;
          setWorkspace(currentWorkspace);
          setUncertainActionMutations(readActionMutationMemory(currentWorkspace));
          setWorkspaceError(null);
          const currentMemory = currentWorkspace.actor.id === currentSession.actor.id && currentWorkspace.actor.sessionId === currentSession.actor.sessionId ? memory : readRecoveryMemory(currentWorkspace.actor);
          setSession({ ...currentSession, actor: currentWorkspace.actor });
          setTurnRecovery(currentMemory.pending);
          setBlockedRequestTexts(currentMemory.blockedTexts);
          setNewConversation(currentMemory.newConversation);
          setSelectedConversationId(currentMemory.selectedConversationId ?? null);
          setDraft(currentMemory.pending?.requestKey ? '' : currentMemory.pending?.message ?? '');
          if (currentMemory.pending) {
            applyTurnReadback(currentMemory.pending, currentWorkspace, currentMemory.blockedTexts);
            if (currentMemory.pending.requestKey) {
              setRecoveryChecking(true);
              try {
                const recovered = await recoverChatStream({ requestKey: currentMemory.pending.requestKey, message: currentMemory.pending.message, conversationId: currentMemory.pending.requestConversationId, csrfToken: currentWorkspace.csrfToken });
                if (cancelled) return;
                applyExactRecovery(recovered, currentMemory.pending, currentWorkspace.actor, currentMemory.blockedTexts);
              } catch (error) {
                if (cancelled) return;
                setTurnRecovery({ ...currentMemory.pending, errorMessage: error instanceof Error ? error.message : 'ยังตรวจสถานะคำขอเดิมไม่ได้', statusChecked: false });
              } finally {
                if (!cancelled) setRecoveryChecking(false);
              }
            }
          }
        } catch (error) {
          if (cancelled) return;
          setWorkspaceError(error instanceof Error ? error.message : 'โหลดข้อมูลพื้นที่ทำงานไม่สำเร็จ');
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setScreen('login');
          setSession(null);
          setWorkspace(null);
          return;
        }
        setScreen('failed');
        setLoginError(error instanceof Error ? error.message : 'ตรวจสอบการเข้าสู่ระบบไม่ได้ กรุณาลองอีกครั้ง');
      }
    }
    void bootstrap();
    return () => { cancelled = true; workspaceReadGeneration.current += 1; };
  }, [bootstrapAttempt, applyTurnReadback, applyExactRecovery, readLatestWorkspace]);

  useEffect(() => {
    if (!requestedDashboardId) {
      setDashboardResult(null);
      setDashboardError(null);
      setDashboardLoading(false);
      return;
    }
    if (!sessionId) return;
    let cancelled = false;
    async function loadDashboard() {
      setDashboardLoading(true);
      setDashboardError(null);
      setDashboardResult(null);
      try {
        const result = await apiRequest<DashboardView>(`/api/dashboards/${encodeURIComponent(requestedDashboardId!)}`);
        if (!cancelled) setDashboardResult(result);
      } catch (error) {
        if (cancelled) return;
        // Server text is shown only when it is reader copy (Thai); raw technical messages become a plain retryable failure.
        setDashboardError(error instanceof Error && /[฀-๿]/.test(error.message) ? error.message : 'โหลด Dashboard ไม่สำเร็จ กรุณาลองอีกครั้ง');
        if (error instanceof ApiError && error.status === 401) {
          setSession(null);
          setWorkspace(null);
          setScreen('login');
          setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
        }
      } finally {
        if (!cancelled) setDashboardLoading(false);
      }
    }
    void loadDashboard();
    return () => { cancelled = true; };
  }, [requestedDashboardId, sessionId, dashboardReload]);

  useEffect(() => {
    if (requestedDashboardId) setActiveSection('dashboard');
  }, [requestedDashboardId]);

  async function refreshWorkspace(expectedScenario?: Scenario) {
    if (!workspace) setWorkspaceError(null);
    try {
      const read = await readLatestWorkspace();
      if (read.generation !== workspaceReadGeneration.current) return null;
      if ('error' in read) throw read.error;
      const currentWorkspace = read.workspace;
      setWorkspace(currentWorkspace);
      setUncertainActionMutations(readActionMutationMemory(currentWorkspace));
      setWorkspaceError(null);
      setSession((current) => current ? { ...current, actor: currentWorkspace.actor, csrfToken: currentWorkspace.csrfToken, businessDate: currentWorkspace.businessDate, storage: currentWorkspace.storage } : current);
      const actionsById = new Map(currentWorkspace.actions.map((action) => [action.id, action]));
      const receiptsByActionId = new Map(currentWorkspace.receipts.map((receipt) => [receipt.actionId, receipt]));
      setUnknownExecutions((current) => {
        const next = { ...current };
        for (const actionId of Object.keys(next)) {
          const relatedReceipt = receiptsByActionId.get(actionId);
          const relatedAction = actionsById.get(actionId);
          if (relatedReceipt?.status === 'pending') next[actionId] = { ...next[actionId], executionId: relatedReceipt.id };
          else if (relatedReceipt || !relatedAction || relatedAction.status !== 'pending') delete next[actionId];
        }
        return next;
      });
      const scenarioToResolve = expectedScenario ?? scenarioUnknownId;
      if (scenarioToResolve && currentWorkspace.actions.some((action) => action.payload.kind === 'demo_update' && action.payload.scenario === scenarioToResolve)) {
        setScenarioUnknownId(null);
        setScenarioUnknown(null);
      }
      return currentWorkspace;
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'โหลดสถานะพื้นที่ทำงานไม่สำเร็จ');
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      return null;
    }
  }

  async function login(profileId: string, accessCode: string) {
    setLoginBusy(true);
    setLoginError(null);
    try {
      const newSession = await apiRequest<Session>('/api/session', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ profileId, accessCode }) });
      writeRecoveryMemory(newSession.actor, null, []);
      setSession(newSession);
      setScreen('ready');
      setWorkspace(null);
      setWorkspaceError(null);
      setLocalMessages([]);
      setSelectedConversationId(null);
      setConversationTitles({});
      setContextOpen(false);
      setSessionsOpen(false);
      setSourceTarget(null);
      setCompletionNotice(null);
      setDraft('');
      setActiveStreamTurn(null);
      setTurnRecovery(null);
      setChatRejection(null);
      setBlockedRequestTexts([]);
      setNewConversation(false);
      setResponseContexts([]);
      setDetailSelection(null);
      setUnknownExecutions({});
      setUncertainActionMutations({});
      setSelectedAction(null);
      setConfirmError(null);
      setScenarioUnknown(null);
      setScenarioUnknownId(null);
      setModeError(null);
      setModeNotice(null);
      setDemoGuideOpen(false);
      setAIUnavailable(false);
      setOperationNotice(null);
      try {
        const read = await readLatestWorkspace();
        if (read.generation !== workspaceReadGeneration.current) return;
        if ('error' in read) throw read.error;
        const currentWorkspace = read.workspace;
        setWorkspace(currentWorkspace);
        setWorkspaceError(null);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : 'เข้าสู่ระบบแล้ว แต่โหลดพื้นที่ทำงานไม่ได้');
      }
    } catch (error) {
      setScreen('login');
      setLoginError(error instanceof Error ? error.message : 'ตรวจสอบรหัสเข้าใช้งานไม่สำเร็จ');
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    if (!csrfToken) return;
    try {
      await apiRequest<void>('/api/session', { method: 'DELETE', headers: { 'x-csrf-token': csrfToken } });
      workspaceReadGeneration.current += 1;
      if (actor) writeRecoveryMemory(actor, null, []);
      setSession(null);
      setWorkspace(null);
      setLocalMessages([]);
      setSelectedConversationId(null);
      setConversationTitles({});
      setContextOpen(false);
      setSessionsOpen(false);
      setSourceTarget(null);
      setCompletionNotice(null);
      setDraft('');
      setActiveStreamTurn(null);
      setTurnRecovery(null);
      setChatRejection(null);
      setBlockedRequestTexts([]);
      setNewConversation(false);
      setResponseContexts([]);
      setDetailSelection(null);
      setUnknownExecutions({});
      setSelectedAction(null);
      setConfirmError(null);
      setScenarioUnknown(null);
      setScenarioUnknownId(null);
      setModeError(null);
      setModeNotice(null);
      setDemoGuideOpen(false);
      setAIUnavailable(false);
      setOperationNotice(null);
      setWorkspaceError(null);
      setScreen('login');
      setLoginError(null);
      setActiveSection('overview');
      setRequestedDashboardId(undefined);
      if (window.location.pathname + window.location.search !== '/') window.history.pushState(null, '', '/');
    } catch (error) {
      setOperationNotice(error instanceof Error ? `ออกจากระบบไม่สำเร็จ: ${error.message}` : 'ออกจากระบบไม่สำเร็จ');
    }
  }

  async function switchMode(nextMode?: Mode, dedicatedRecovery = false, availabilitySwitch = false) {
    if (turnRecovery && (!turnRecovery.statusChecked || (availabilitySwitch && turnRecovery.recoveryStatus !== 'failed') || (!availabilitySwitch && !dedicatedRecovery))) return false;
    if (!session || !csrfToken || modeBusy || turnBusy) return false;
    const target: Mode = nextMode ?? (session.actor.mode === 'live_ai' ? 'scripted_demo' : 'live_ai');
    if (target === session.actor.mode) return true;
    setModeBusy(true);
    setModeError(null);
    setModeNotice(null);
    try {
      await apiRequest<unknown>('/api/session', { method: 'PATCH', headers: jsonHeaders(csrfToken), body: JSON.stringify({ mode: target }) });
      const refreshedSession = await apiRequest<Session>('/api/session');
      // A mode change always starts a fresh conversation so Live AI and demo turns are never mixed.
      // Reset before the session flips so the new mode is never visible with the old conversation selected.
      setSelectedConversationId(null);
      setDetailSelection(null);
      setNewConversation(true);
      writeRecoveryMemory(refreshedSession.actor, null, blockedRequestTexts, true);
      setSession(refreshedSession);
      setAIUnavailable(false);
      const read = await readLatestWorkspace();
      if (read.generation !== workspaceReadGeneration.current) return false;
      if ('error' in read) throw read.error;
      const refreshedWorkspace = read.workspace;
      setWorkspace(refreshedWorkspace);
      setWorkspaceError(null);
      setModeNotice(`เปลี่ยนเป็น ${modeLabel(refreshedSession.actor.mode)} แล้ว · รายการที่รอยืนยันจากโหมดเดิมจะยืนยันต่อไม่ได้`);
      if (target === 'scripted_demo' && availabilitySwitch) {
        setDemoGuideOpen(true);
        navigate('overview');
      }
      return refreshedSession.actor.mode === target;
    } catch (error) {
      setModeError(error instanceof Error ? error.message : 'เปลี่ยนโหมดไม่สำเร็จ');
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      return false;
    } finally {
      setModeBusy(false);
    }
  }

  async function sendTurn(message: string, recoveryOfTurnId?: string, recoveryConversationId?: string, preserveDraft = false, demoShowcaseId?: string, catalogEntryId?: string, clarification?: { choiceId: string; clarifiedTurnId: string }, targets?: { kind: 'artifact' | 'dashboard' | 'monitor'; id: string; revision?: number }[]): Promise<boolean> {
    if (!session || !csrfToken || !workspace) {
      setChatRejection('ส่งข้อความไม่ได้ เพราะบทสนทนายังโหลดไม่ครบ กรุณาลองอีกครั้ง');
      return false;
    }
    if (turnBusy || submissionRef.current) return false;
    if (turnRecovery && (!recoveryOfTurnId || recoveryOfTurnId !== turnRecovery.turnId || !turnRecovery.statusChecked)) return false;
    if (!recoveryOfTurnId && blockedRequestTexts.includes(message.trim())) {
      setChatRejection('ข้อความนี้เป็นคำขอเดิมที่พักไว้ ระบบจะไม่ส่งซ้ำ โปรดถามคำถามใหม่ด้วยข้อความอื่นหรือโหลดประวัติเพื่อตรวจผลเดิม');
      return false;
    }
    const startedAt = new Date().toISOString();
    const selectedCanonicalConversationId = selectedConversationId?.startsWith('local-conversation-') ? undefined : selectedConversationId;
    const visibleCanonicalConversationId = activeConversationId?.startsWith('local-conversation-') ? null : activeConversationId;
    const attemptedConversationId = recoveryConversationId ?? composerConversationId({ activeConversationId: visibleCanonicalConversationId, selectedConversationId: selectedCanonicalConversationId ?? null, recentConversationId: recentConversationId(workspace.messages, session.actor.id), newConversation });
    const previousMessageIds = workspace.messages.map((entry) => entry.id);
    const useStream = !recoveryOfTurnId;
    const requestKey = useStream ? crypto.randomUUID() : undefined;
    let marker: TurnRecovery = { message, conversationId: attemptedConversationId, turnId: recoveryOfTurnId, startedAt, previousMessageIds, failedResponse: false, statusChecked: false, errorMessage: 'กำลังรอผลคำขอเดิม', ...(requestKey ? { requestKey, requestConversationId: attemptedConversationId } : {}) };
    if (!writeRecoveryMemory(session.actor, marker, blockedRequestTexts, newConversation, attemptedConversationId)) {
      setChatRejection('ยังไม่ได้ส่งคำขอ เพราะเก็บสถานะพักคำขอในแท็บไม่ได้ ตรวจการตั้งค่าเบราว์เซอร์แล้วลองใหม่');
      return false;
    }
    submissionRef.current = true;
    setTurnBusy(true);
    setTurnRecovery(null);
    setChatRejection(null);
    setOperationNotice(null);
    setCompletionNotice(null);
    if (!preserveDraft) setDraft('');
    const optimisticId = requestKey ?? crypto.randomUUID();
    const optimisticConversationId = attemptedConversationId ?? (selectedConversationId?.startsWith('local-conversation-') ? selectedConversationId : `local-conversation-${optimisticId}`);
    const optimisticCommon = { conversationId: optimisticConversationId, actorId: session.actor.id, mode: session.actor.mode, modeRevision: session.actor.modeRevision, createdAt: startedAt, requestKey, local: true as const };
    const optimisticAssistantId = `local-assistant-${optimisticId}`;
    const optimisticUserId = `local-user-${optimisticId}`;
    setSelectedConversationId(optimisticConversationId);
    setLocalMessages((current) => [...current, ...(!recoveryOfTurnId ? [{ ...optimisticCommon, id: optimisticUserId, role: 'user' as const, text: message }] : []), { ...optimisticCommon, id: optimisticAssistantId, role: 'assistant', text: '', delivery: 'waiting', progress: 'กำลังตรวจคำขอ…' }]);
    const streamController = useStream ? new AbortController() : null;
    streamAbortRef.current = streamController;
    if (useStream) setActiveStreamTurn(marker);
    let streamedText = '';
    let sawPrepare = false;
    let deltaFrame: number | null = null;
    function flushText() {
      if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
      deltaFrame = null;
      if (streamedText) setLocalMessages((current) => current.map((entry) => entry.id === optimisticAssistantId ? { ...entry, text: streamedText, delivery: 'streaming' } : entry));
    }
    try {
      const conversationId = attemptedConversationId;
      const payload: { message: string; conversationId?: string; recoveryOfTurnId?: string } = { message };
      if (conversationId) payload.conversationId = conversationId;
      if (recoveryOfTurnId) payload.recoveryOfTurnId = recoveryOfTurnId;
      const turn = requestKey && streamController ? await requestChatStream({
        message, conversationId: attemptedConversationId, requestKey, csrfToken, signal: streamController.signal, ...(demoShowcaseId ? { demoShowcaseId } : {}), ...(catalogEntryId ? { catalogEntryId } : {}), ...(clarification ? { clarification } : {}), ...(targets?.length ? { targets } : {}),
        onEvent(event) {
          if (event.type === 'turn.started') {
            marker = { ...marker, conversationId: event.conversationId, turnId: event.turnId, assistantMessageId: event.assistantMessageId };
            if (!writeRecoveryMemory(session.actor, marker, blockedRequestTexts, false, event.conversationId)) {
              streamController.abort();
              throw new ChatStreamError('request_failed', 0, true);
            }
            setActiveStreamTurn(marker);
            setSelectedConversationId(event.conversationId);
            setLocalMessages((current) => current.map((entry) => entry.requestKey === requestKey ? { ...entry, conversationId: event.conversationId, turnId: event.turnId, mode: event.mode } : entry));
          } else if (event.type === 'status') {
            if (event.code === 'preparing' || event.code === 'saving') sawPrepare = true;
            setLocalMessages((current) => current.map((entry) => entry.id === optimisticAssistantId ? { ...entry, progress: streamProgress[event.code] } : entry));
          } else if (event.type === 'text.delta') {
            streamedText += event.text;
            if (deltaFrame === null) deltaFrame = requestAnimationFrame(flushText);
          }
        },
      }) : await apiRequest<TurnResponse>('/api/chat', { method: 'POST', headers: jsonHeaders(csrfToken), body: JSON.stringify(payload) });
      if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
      deltaFrame = null;
      applyCanonicalTurn(turn, session.actor, marker, blockedRequestTexts, optimisticConversationId, [optimisticUserId, optimisticAssistantId], !recoveryOfTurnId, true);
      void refreshWorkspace().then((fresh) => { if (fresh) setLocalMessages((current) => matchLocalMessages(fresh.messages, current)); });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'ส่งคำขอไม่สำเร็จ';
      if (session.actor.mode === 'live_ai' && error instanceof ChatStreamError && (error.code === 'provider_unavailable' || error.code === 'deadline_exceeded')) { aiAvailabilityDismissed.current = false; setAIUnavailableStatus('unavailable'); setAIUnavailable(true); }
      const turnId = marker.turnId ?? (error instanceof ApiError ? error.turnId : undefined);
      const status = error instanceof ApiError || error instanceof ChatStreamError ? error.status : 0;
      const rejected = !turnId && [400, 403, 404, 413, 422, 429].includes(status);
      const stopped = error instanceof ChatStreamError && error.code === 'cancelled';
      flushText();
      // A known outcome that prepared nothing needs no recovery check: the user can keep working immediately.
      const serverKnown = error instanceof ChatStreamError && error.outcome !== undefined && ['provider_unavailable', 'deadline_exceeded', 'invalid_response', 'forbidden', 'request_failed'].includes(error.code)
        && !(error.code === 'request_failed' && error.outcome !== 'failed');
      const userStopped = stopped && Boolean(streamController?.signal.aborted);
      const cleanFailure = useStream && error instanceof ChatStreamError && !sawPrepare && !rejected && (userStopped || serverKnown);
      const cleanMessage = error instanceof ChatStreamError ? cleanFailureMessages[error.code] ?? cleanFailureMessages.request_failed : errorMessage;
      setLocalMessages((current) => current.map((entry) => entry.id === optimisticAssistantId ? { ...entry, delivery: rejected ? 'rejected' : stopped ? 'stopped' : cleanFailure ? 'rejected' : 'interrupted', progress: cleanFailure ? cleanMessage : errorMessage } : entry));
      if (cleanFailure) {
        writeRecoveryMemory(session.actor, null, blockedRequestTexts, newConversation, marker.conversationId ?? selectedCanonicalConversationId ?? undefined);
        void refreshWorkspace().then((fresh) => { if (fresh) setLocalMessages((current) => matchLocalMessages(fresh.messages, current)); });
      } else if (rejected) {
        setChatRejection(errorMessage);
        writeRecoveryMemory(session.actor, null, blockedRequestTexts, newConversation, selectedCanonicalConversationId ?? undefined);
      } else {
        const recovery: TurnRecovery = { ...marker, turnId, errorMessage, failedResponse: status >= 500, ...(requestKey ? { partialText: streamedText, interruptedBy: stopped ? 'stop' : 'connection' } : {}) };
        setTurnRecovery(recovery);
        writeRecoveryMemory(session.actor, recovery, blockedRequestTexts, newConversation, recovery.conversationId ?? attemptedConversationId);
      }
      setOperationNotice(null);
      if (status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      if (!useStream) void refreshWorkspace();
      return false;
    } finally {
      if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
      streamAbortRef.current = null;
      setActiveStreamTurn(null);
      submissionRef.current = false;
      setTurnBusy(false);
    }
  }

  async function recoverTurn() {
    if (turnRecovery?.requestKey) return;
    if (!turnRecovery?.turnId || !turnRecovery.statusChecked || turnBusy || recoveryChecking) return;
    const recovery = turnRecovery;
    if (session?.actor.mode !== 'scripted_demo') {
      const switched = await switchMode('scripted_demo', true);
      if (!switched) return;
    }
    if (await sendTurn(recovery.message, recovery.turnId, recovery.conversationId)) setDraft('');
  }

  async function tryShowcase(item: ShowcaseItem) {
    if (!session || session.actor.mode !== 'scripted_demo' || modeBusy || turnBusy || turnRecovery || recoveryChecking || actionMutation) return;
    const sent = await sendTurn(item.prompt, undefined, undefined, true, item.id);
    if (sent) {
      setDemoGuideOpen(false);
      if (item.kind === 'scenario') {
        navigate('actions');
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-actions-heading]')?.focus({ preventScroll: true }));
      } else {
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')?.focus());
      }
    }
  }

  async function refreshTurnStatus() {
    const recovery = turnRecovery;
    if (!recovery || recoveryChecking || !session || !csrfToken) return;
    setRecoveryChecking(true);
    try {
      if (recovery.requestKey) {
        const recovered = await recoverChatStream({ requestKey: recovery.requestKey, message: recovery.message, conversationId: recovery.requestConversationId, csrfToken });
        applyExactRecovery(recovered, recovery, session.actor, blockedRequestTexts, true);
        if (recovered.status === 'completed') {
          const fresh = await refreshWorkspace();
          if (fresh) setLocalMessages((current) => matchLocalMessages(fresh.messages, current));
        }
        return;
      }
      const fresh = await refreshWorkspace();
      if (!fresh) return;
      applyTurnReadback(recovery, fresh, blockedRequestTexts);
    } catch (error) {
      const next = { ...recovery, statusChecked: false, errorMessage: error instanceof Error ? error.message : 'ยังตรวจสถานะคำขอเดิมไม่ได้' };
      setTurnRecovery(next);
      writeRecoveryMemory(session.actor, next, blockedRequestTexts, false, next.conversationId ?? next.requestConversationId ?? recovery.conversationId ?? recovery.requestConversationId ?? undefined);
      if (error instanceof ChatStreamError && error.status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
    } finally {
      setRecoveryChecking(false);
    }
  }

  function startNewQuestion() {
    if (turnRecovery?.requestKey) {
      if (!turnRecovery.statusChecked || turnRecovery.recoveryStatus !== 'failed' || recoveryChecking || turnBusy) return;
      const conversationId = failedTurnConversationId(turnRecovery, workspace);
      const nextBlockedTexts = [...new Set([...blockedRequestTexts, turnRecovery.message.trim()])];
      if (!actor || !writeRecoveryMemory(actor, null, nextBlockedTexts, !conversationId, conversationId)) {
        setOperationNotice('ยังเปิดให้ถามต่อไม่ได้ เพราะบันทึกสถานะคำขอเดิมในแท็บไม่สำเร็จ กรุณาลองอีกครั้ง');
        return;
      }
      setBlockedRequestTexts(nextBlockedTexts);
      setTurnRecovery(null);
      setSelectedConversationId(conversationId ?? null);
      setNewConversation(!conversationId);
      setDraft('');
      setOperationNotice(conversationId ? 'ถามต่อในบทสนทนาเดิมได้แล้ว ประวัติยังอยู่และคำขอที่สิ้นสุดจะไม่ถูกส่งซ้ำ' : 'ไม่พบรหัสบทสนทนาเดิมที่ตรวจสอบได้ คำถามถัดไปจะเริ่มบทสนทนาใหม่ โดยไม่ส่งคำขอเดิมซ้ำ');
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="ข้อความถึง DaTex"]')?.focus());
      return;
    }
    if (!turnRecovery?.statusChecked || turnRecovery.turnId || recoveryChecking || turnBusy) return;
    const nextBlockedTexts = blockedRequestTexts.includes(turnRecovery.message.trim()) ? blockedRequestTexts : [...blockedRequestTexts, turnRecovery.message.trim()];
    setBlockedRequestTexts(nextBlockedTexts);
    if (actor) writeRecoveryMemory(actor, null, nextBlockedTexts, true);
    setTurnRecovery(null);
    setDraft('');
    setNewConversation(true);
    setOperationNotice('ผลคำขอเดิมยังไม่ยืนยัน เริ่มคำถามใหม่ได้โดยไม่ส่งข้อความเดิมซ้ำ คำถามใหม่จะเริ่มบทสนทนาใหม่');
  }

  async function proposeScenario(scenario: Scenario) {
    if (!session || !csrfToken || scenarioBusy || session.actor.mode !== 'scripted_demo') return;
    setScenarioBusy(true);
    setScenarioUnknown(null);
    setScenarioUnknownId(null);
    setOperationNotice(null);
    const scenarioLabels: Record<Scenario, string> = demoScenarioLabel;
    try {
      const response = await apiRequest<PendingAction | { pendingAction: PendingAction }>('/api/demo/scenario', { method: 'POST', headers: jsonHeaders(csrfToken), body: JSON.stringify({ scenario }) });
      const pendingAction = 'pendingAction' in response ? response.pendingAction : response;
      setWorkspace((current) => current ? { ...current, actions: [pendingAction, ...current.actions.filter((action) => action.id !== pendingAction.id)] } : current);
      setSelectedAction(pendingAction);
      setConfirmError(null);
      setOperationNotice('ระบบเตรียมรายการไว้แล้ว กรุณาตรวจรายการและขอบเขตในหน้าต่างยืนยัน');
    } catch (error) {
      setScenarioUnknown(scenarioLabels[scenario]);
      setScenarioUnknownId(scenario);
      setOperationNotice(`ยังไม่ทราบว่าเตรียมรายการ “${scenarioLabels[scenario]}” สำเร็จหรือไม่ กรุณาโหลดสถานะก่อนเริ่มคำขอใหม่`);
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      void refreshWorkspace(scenario);
    } finally {
      setScenarioBusy(false);
    }
  }

  function actionIsCurrent(action: PendingAction) {
    const current = workspace?.actions.find(item => item.id === action.id);
    if (!current || current.payloadHash !== action.payloadHash || !hasShareApprovalDetails(current) || !currentTime) return false;
    if (!actor || actionState(current, currentTime).key !== 'pending' || current.actorId !== actor.id || current.sessionId !== actor.sessionId || current.mode !== actor.mode || current.modeRevision !== actor.modeRevision) return false;
    return capabilityAllowed(workspace, actor, current.payload.kind) && !unknownExecutions[current.id] && !workspace?.receipts.some(receipt => receipt.actionId === current.id);
  }
  function canConfirm(action: PendingAction) {
    const badgeReady = action.payload.kind !== 'badge_revoke' || badgeReviewRead?.status === 'ready' && badgeReviewRead.actionId === action.id && badgeReviewRead.payloadHash === action.payloadHash && badgeReviewIsCurrent(action, workspace?.badgeReviews?.[action.id]);
    return actionIsCurrent(action) && badgeReady && !actionMutation && !uncertainActionMutations[action.id];
  }
  async function refreshBadgeForAction(action: PendingAction) {
    if (action.payload.kind !== 'badge_revoke') return;
    const generation = ++badgeReviewGeneration.current;
    const owner = { id: actor?.id, sessionId: actor?.sessionId };
    setBadgeReviewRead({ actionId: action.id, payloadHash: action.payloadHash, status: 'loading' });
    const fresh = await refreshWorkspace();
    if (generation !== badgeReviewGeneration.current) return;
    const current = fresh?.actions.find(item => item.id === action.id);
    const matched = fresh?.actor.id === owner.id && fresh?.actor.sessionId === owner.sessionId && current?.payloadHash === action.payloadHash && fresh?.badgeReviews?.[action.id]?.payloadHash === action.payloadHash;
    setBadgeReviewRead({ actionId: action.id, payloadHash: action.payloadHash, status: matched ? 'ready' : 'unavailable' });
  }
  function openActionReview(action: PendingAction) {
    badgeReviewGeneration.current += 1;
    setBadgeReviewRead(null);
    setConfirmError(null);
    setSelectedAction(action);
    if (action.payload.kind === 'badge_revoke') void refreshBadgeForAction(action);
  }
  function closeActionReview() {
    badgeReviewGeneration.current += 1;
    setBadgeReviewRead(null);
    setSelectedAction(null);
  }
  function canReviseAction(action: PendingAction) {
    // Cancel is available for every pending proposal kind; only dashboards can be revised (guarded in mutateAction).
    return actionIsCurrent(action) && !confirmBusyId && !turnBusy && !turnRecovery && !uncertainActionMutations[action.id]?.rejected;
  }
  function mutationMessage(error: unknown, kind: 'revise' | 'cancel') {
    if (error instanceof ApiError && error.status === 400) return 'ข้อมูลแก้ไขไม่ผ่านการตรวจสอบ โปรดตรวจชื่อ คำอธิบาย และมุมมองอีกครั้ง';
    if (error instanceof ApiError && error.status === 403) return 'สิทธิ์ปัจจุบันไม่อนุญาตให้เปลี่ยนข้อเสนอนี้';
    if (error instanceof ApiError && [404, 409].includes(error.status)) return 'ข้อเสนอหรือหลักฐานเปลี่ยนไป กรุณาโหลดสถานะล่าสุดก่อนดำเนินการต่อ';
    return kind === 'revise' ? 'ยังยืนยันผลตัวอย่างใหม่ไม่ได้ ข้อความที่แก้ไขยังอยู่ กรุณาลองคำขอเดิมอีกครั้ง' : 'ยังยืนยันผลการยกเลิกไม่ได้ กรุณาลองยกเลิกข้อเสนอเดิมอีกครั้งหรือโหลดสถานะ';
  }
  async function mutateAction(action: PendingAction, kind: 'revise' | 'cancel', request?: DashboardRevisionRequest) {
    if (!csrfToken || !canReviseAction(action) || (kind === 'revise' && action.payload.kind !== 'dashboard_create') || actionMutationRef.current) throw new Error('ยังเปลี่ยนข้อเสนอนี้ไม่ได้ กรุณารอหรือตรวจสถานะล่าสุด');
    const previousUncertainty = uncertainActionMutations[action.id];
    const unresolved: ActionMutationMemory = { ...uncertainActionMutations, [action.id]: { kind } };
    // Save before dispatch: navigation can interrupt the response at any point.
    if (!actor || !writeActionMutationMemory(actor, unresolved)) throw new Error('บันทึกสถานะคำขอในแท็บไม่ได้ จึงยังไม่ส่งคำขอ กรุณาตรวจการตั้งค่าเบราว์เซอร์');
    setUncertainActionMutations(unresolved);
    const operation = { actionId: action.id, kind };
    actionMutationRef.current = operation;
    setActionMutation(operation);
    setConfirmError(null);
    try {
      const result = await apiRequest<ActionRevisionResult | { action: LifecycleAction }>(`/api/actions/${encodeURIComponent(action.id)}/${kind}`, { method: 'POST', headers: jsonHeaders(csrfToken), body: JSON.stringify(kind === 'revise' ? request : {}) });
      const sameOwner = (candidate: PendingAction | undefined) => candidate?.actorId === action.actorId && candidate?.sessionId === action.sessionId && candidate?.conversationId === action.conversationId;
      let updates: LifecycleAction[];
      let next: LifecycleAction;
      if (kind === 'revise') {
        if (!result || !('replacement' in result) || result.predecessor?.id !== action.id || result.predecessor.payloadHash !== action.payloadHash || result.predecessor.status !== 'stale' || result.predecessor.staleReason !== 'superseded' || !sameOwner(result.predecessor) || !sameOwner(result.replacement) || result.replacement.id === action.id || result.predecessor.supersededByActionId !== result.replacement.id || result.replacement.predecessorActionId !== action.id || result.replacement.payload.kind !== 'dashboard_create' || !Array.isArray(result.diff) || !result.diff.length || !result.diff.every(line => typeof line === 'string') || !Array.isArray(result.replacement.revisionDiff) || result.replacement.revisionDiff.length !== result.diff.length || result.replacement.revisionDiff.some((line, index) => line !== result.diff[index])) throw new ApiError('Invalid revision response', 502, 'invalid_response');
        next = result.replacement;
        updates = [result.predecessor, next];
      } else {
        if (!result || !('action' in result) || result.action?.id !== action.id || !sameOwner(result.action) || result.action.status !== 'stale' || result.action.staleReason !== 'user_cancelled') throw new ApiError('Invalid cancellation response', 502, 'invalid_response');
        next = result.action;
        updates = [next];
      }
      // A verified mutation is newer than every workspace read already in flight.
      workspaceReadGeneration.current += 1;
      setWorkspace(current => current && current.actor.id === action.actorId && current.actor.sessionId === action.sessionId ? { ...current, actions: [...current.actions.filter(item => !updates.some(update => update.id === item.id)), ...updates] } : current);
      setSelectedAction(current => current?.id === action.id ? next : current);
      setDetailSelection(current => current?.kind === 'action' && current.id === action.id ? { kind: 'action', id: next.id } : current);
      const resolved = { ...unresolved }; delete resolved[action.id];
      writeActionMutationMemory(actor, resolved);
      setUncertainActionMutations(resolved);
      setOperationNotice(kind === 'revise' ? 'บันทึกข้อเสนอฉบับใหม่แล้ว กรุณาตรวจสิ่งที่เปลี่ยนก่อนยืนยัน' : 'ยกเลิกข้อเสนอแล้ว ไม่มีการสร้าง Dashboard จากการยกเลิกนี้');
    } catch (error) {
      if (error instanceof ApiError && [404, 409].includes(error.status)) {
        workspaceReadGeneration.current += 1;
        const guarded: ActionMutationMemory = { ...unresolved, [action.id]: { kind, ...(!previousUncertainty ? { rejected: true } : {}) } };
        writeActionMutationMemory(actor, guarded);
        setUncertainActionMutations(guarded);
      } else if (!previousUncertainty && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        const rejected = { ...unresolved }; delete rejected[action.id];
        writeActionMutationMemory(actor, rejected);
        setUncertainActionMutations(rejected);
      }
      throw new Error(mutationMessage(error, kind));
    } finally {
      actionMutationRef.current = null;
      setActionMutation(null);
    }
  }

  function openProposalReview(proposal: RouterProposalView) {
    setProposalError(null);
    setProposalReceipt(null);
    setReviewedProposal(proposal);
  }
  function closeProposalReview() {
    if (proposalBusy) return;
    setReviewedProposal(null);
    setProposalReceipt(null);
    setProposalError(null);
  }
  async function confirmProposalAction(proposal: RouterProposalView) {
    if (!csrfToken || proposalBusy) return;
    setProposalBusy('confirm');
    setProposalError(null);
    try {
      const result = await confirmStagedProposal(apiRequest, csrfToken, proposal.id);
      setProposalReceipt(result);
      if (result.outcome === 'executed') {
        setOperationNotice({ message: result.text, tone: 'success' });
        // A confirmed shared-Dashboard edit: show the new state of the open Dashboard.
        if (requestedDashboardId) void apiRequest<DashboardView>(`/api/dashboards/${encodeURIComponent(requestedDashboardId)}`, { method: 'GET', cache: 'no-store' }).then(setDashboardResult).catch(() => undefined);
      }
    } catch (error) {
      // The outcome is unknown: keep the dialog open with the error and let a refresh show the true state.
      setProposalError(error instanceof Error ? error.message : 'ยืนยันรายการไม่สำเร็จ ตรวจสถานะก่อนลองอีกครั้ง');
    } finally {
      setProposalBusy(null);
      void refreshProposals();
      void refreshWorkspace();
    }
  }
  async function cancelProposalAction(proposal: RouterProposalView) {
    if (!csrfToken || proposalBusy) return;
    setProposalBusy('cancel');
    setProposalError(null);
    try {
      const result = await cancelStagedProposal(apiRequest, csrfToken, proposal.id);
      setProposalReceipt({ outcome: 'cancelled', text: result.text });
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : 'ยกเลิกรายการไม่สำเร็จ ตรวจสถานะก่อนลองอีกครั้ง');
    } finally {
      setProposalBusy(null);
      void refreshProposals();
    }
  }
  function chooseClarification(message: LocalMessage, choice: TurnChoice) {
    const selection = clarificationSelection(message, choice);
    if (!selection) return;
    void sendTurn(selection.message, undefined, undefined, true, undefined, undefined, selection.clarification);
  }
  async function artifactWrite(message: LocalMessage, artifact: TurnArtifact, operation: ArtifactOperation) {
    if (!csrfToken || artifactBusy) return;
    setArtifactBusy({ artifactId: artifact.id, operation });
    setArtifactNotice(null);
    try {
      const result = await requestArtifactWrite(fetch, csrfToken, artifact, operation, message.conversationId);
      if (result.kind === 'file') {
        const url = URL.createObjectURL(new Blob(['﻿', result.content], { type: result.mime }));
        const link = document.createElement('a');
        link.href = url; link.download = result.filename; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setArtifactNotice({ artifactId: artifact.id, tone: 'ok', text: `ส่งออกไฟล์ ${result.filename} แล้ว` });
      } else if (result.kind === 'proposal') {
        setArtifactNotice({ artifactId: artifact.id, tone: 'ok', text: result.preview || 'เตรียมรายการแล้ว โปรดตรวจและยืนยันในหน้า “คำขอและผลการทำงาน”' });
        void refreshWorkspace();
        void refreshProposals();
      } else {
        setArtifactNotice({ artifactId: artifact.id, tone: 'ok', text: result.text });
        void refreshWorkspace();
      }
    } catch (error) {
      setArtifactNotice({ artifactId: artifact.id, tone: 'error', text: error instanceof Error ? error.message : 'ดำเนินการไม่สำเร็จ' });
    } finally {
      setArtifactBusy(null);
    }
  }
  const [organizeBusy, setOrganizeBusy] = useState(false);
  /** Pin / archive / restore / duplicate: runs on the server first; if the follow-up reload fails the page says so (and offers a retry) instead of showing a silent success. */
  async function organizeOwnDashboard(dashboardId: string, op: DashboardOrganizeOp) {
    if (!csrfToken || organizeBusy) return;
    setOrganizeBusy(true);
    try {
      await organizeDashboardRequest(apiRequest, csrfToken, dashboardId, op);
      const fresh = await refreshWorkspace();
      const done = op === 'pin' ? 'ปักหมุด Dashboard แล้ว' : op === 'unpin' ? 'เลิกปักหมุดแล้ว' : op === 'archive' ? 'เก็บ Dashboard ถาวรแล้ว' : op === 'restore' ? 'นำ Dashboard กลับมาแล้ว' : 'ทำสำเนา Dashboard แล้ว';
      setOperationNotice(fresh ? { message: done, tone: 'success' } : `${done} แต่โหลดรายการล่าสุดไม่สำเร็จ — กด “ลองอีกครั้ง” เพื่อดูสถานะล่าสุด`);
    } catch (error) {
      setOperationNotice(error instanceof Error ? error.message : 'จัดการ Dashboard ไม่สำเร็จ กรุณาลองอีกครั้ง');
    } finally { setOrganizeBusy(false); }
  }
  async function deleteOwnDashboard(dashboardId: string) {
    if (!csrfToken) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    await deleteDashboardRequest(apiRequest, csrfToken, dashboardId);
    navigate('dashboards');
    setOperationNotice({ message: 'ลบ Dashboard แล้ว', tone: 'success' });
    void refreshWorkspace();
  }

  async function confirmAction(action: PendingAction) {
    if (!csrfToken || !canConfirm(action) || confirmBusyId || actionMutationRef.current) return;
    setConfirmBusyId(action.id);
    setConfirmError(null);
    try {
      const receipt = await apiRequest<ReceiptView>(`/api/actions/${encodeURIComponent(action.id)}/confirm`, { method: 'POST', headers: jsonHeaders(csrfToken), body: '{}' });
      setWorkspace((current) => current ? { ...current, receipts: [receipt, ...current.receipts.filter((item) => item.id !== receipt.id)] } : current);
      setSelectedAction(null);
      if (receipt.visibility === 'restricted') {
        setUnknownExecutions((current) => ({ ...current, [action.id]: { actionId: action.id, executionId: receipt.id, message: receipt.detail } }));
        setOperationNotice('ยังไม่มีสิทธิ์อ่านผลปัจจุบัน ระบบเก็บผลเดิมไว้โดยไม่ส่งการยืนยันซ้ำ คุณตรวจสิทธิ์และอ่านผลเดิมได้ในประวัติ');
      } else if (receipt.status === 'pending') {
        setUnknownExecutions((current) => ({ ...current, [action.id]: { actionId: action.id, executionId: receipt.id, message: 'ผลการดำเนินการยังรอตรวจสอบ' } }));
        setOperationNotice('บันทึกผลการดำเนินการแล้ว แต่ยังตรวจยืนยันผลไม่ได้ ใช้ “ตรวจผลคำขอเดิม” เพื่อตรวจสถานะ โดยระบบจะไม่ส่งการยืนยันซ้ำ');
      } else {
        setUnknownExecutions((current) => { const next = { ...current }; delete next[action.id]; return next; });
        const message = `${actionLabel(receipt.kind)} · ${receiptStatus(receipt.status).label}`;
        setOperationNotice(receipt.status === 'verified_success' ? { message, tone: 'success' } : message);
      }
      void refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ยืนยันรายการไม่สำเร็จ';
      setConfirmError({ actionId: action.id, message });
      setUnknownExecutions((current) => ({ ...current, [action.id]: { actionId: action.id, executionId: error instanceof ApiError ? error.executionId : undefined, message } }));
      setSelectedAction(null);
      setOperationNotice('ยังไม่ทราบผลการดำเนินการ จึงระงับการยืนยันซ้ำไว้ โปรดเลือก “ตรวจผลคำขอเดิม” เพื่อตรวจสอบสถานะ');
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
        setWorkspace(null);
        setScreen('login');
        setLoginError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      void refreshWorkspace();
    } finally {
      confirmationFocusRef.current = action.id;
      setConfirmBusyId(null);
    }
  }

  async function reconcile(reconcileId: string, actionId: string, readbackRevision?: string) {
    if (!csrfToken) return;
    setConfirmBusyId(actionId);
    try {
      const receipt = await apiRequest<ReceiptView>(`/api/executions/${encodeURIComponent(reconcileId)}/reconcile`, { method: 'POST', headers: jsonHeaders(csrfToken), body: JSON.stringify(readbackRevision ? { readbackRevision } : {}) });
      setWorkspace((current) => current ? { ...current, receipts: [receipt, ...current.receipts.filter((item) => item.id !== receipt.id)] } : current);
      if (receipt.visibility === 'restricted') {
        setUnknownExecutions((current) => ({ ...current, [actionId]: { actionId, executionId: receipt.id, message: receipt.detail } }));
        setOperationNotice('ยังไม่มีสิทธิ์อ่านผลปัจจุบัน สถานะเดิมยังถูกเก็บไว้ ไม่มีการยืนยันหรือเขียนซ้ำ');
      } else if (receipt.status === 'pending') {
        setUnknownExecutions((current) => ({ ...current, [actionId]: { actionId, executionId: receipt.id, message: 'ผลการดำเนินการยังรอตรวจสอบ' } }));
        setOperationNotice('ผลยังรอตรวจสอบ');
      } else {
        setUnknownExecutions((current) => { const next = { ...current }; delete next[actionId]; return next; });
        const message = `${actionLabel(receipt.kind)} · ${receiptStatus(receipt.status).label}`;
        setOperationNotice(receipt.status === 'verified_success' ? { message, tone: 'success' } : message);
      }
      void refreshWorkspace();
    } catch (error) {
      setOperationNotice(`อ่านผลซ้ำไม่ได้: ${error instanceof Error ? error.message : 'บริการไม่ตอบกลับ'} · รายการยังล็อกไว้`);
      void refreshWorkspace();
    } finally {
      setConfirmBusyId(null);
    }
  }

  if (screen === 'checking') return <LoadingScreen />;
  if (screen === 'failed' || screen === 'login') return <LoginScreen busy={loginBusy} error={loginError} onSubmit={login} onRetry={() => setBootstrapAttempt((attempt) => attempt + 1)} showRetry={screen === 'failed'} />;
  if (!session || !actor) return <LoadingScreen />;
  if (!workspace) {
    if (!workspaceError) return <LoadingScreen session={session} />;
    return <main className="auth-screen"><section className="auth-panel-wrap"><div className="auth-panel"><div className="auth-brand"><div className="auth-brand-mark"><Icon name="nexus" size={22} /></div><div><strong>DaTex</strong></div></div><h2 style={{ marginTop: 24 }}>เข้าสู่ระบบแล้ว แต่เปิดพื้นที่ทำงานไม่ได้</h2><p>{workspaceError || 'กำลังรอข้อมูลจากบริการ'}</p><div className="banner-actions"><button className="btn btn-primary" type="button" onClick={() => void refreshWorkspace()}>โหลดพื้นที่ทำงานอีกครั้ง</button><button className="btn" type="button" onClick={() => void logout()}>ออกจากระบบ</button></div></div></section></main>;
  }

  const myDashboards = workspace.dashboards.filter((dashboard) => dashboard.ownerId === actor.id);
  const taskTargetOwnedIds = myDashboards.map(dashboard => dashboard.id);
  const currentDashboardTaskTarget = reconcileDashboardTaskTarget(dashboardTaskTarget, actor, taskTargetOwnedIds);
  const activeDashboards = myDashboards.filter((dashboard) => !dashboard.archivedAt);
  const archivedDashboards = myDashboards.filter((dashboard) => dashboard.archivedAt);
  const inboxItems = workspace.inbox;
  const heldTurn = turnRecovery?.requestKey ? turnRecovery : activeStreamTurn;
  const withheldActionIds = new Set(workspace.actions.filter((action) => belongsToHeldTurn(action, heldTurn)).map((action) => action.id));
  const visibleActions = workspace.actions.filter((action) => action.actorId === actor.id && action.sessionId === actor.sessionId && !withheldActionIds.has(action.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleReceipts = workspace.receipts.filter((receipt) => (receipt.visibility === 'restricted' || receipt.actorId === actor.id) && !withheldActionIds.has(receipt.actionId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleAudit = workspace.audit.filter((event) => event.actorId === actor.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const serverMessages = workspace.messages.filter((message) => message.actorId === actor.id && !belongsToHeldTurn(message, heldTurn));
  const allMessages = attachResponseContexts([...serverMessages, ...matchLocalMessages(serverMessages, localMessages.filter((message) => message.actorId === actor.id))].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), responseContexts.filter((context) => context.actorId === actor.id));
  const activeConversationId = selectedConversationId ?? (newConversation ? null : recentConversationId(allMessages, actor.id) ?? null);
  const displayedMessages = activeConversationId ? allMessages.filter((message) => message.conversationId === activeConversationId) : [];
  const chatMessages = displayedMessages.map(message => {
    const text = messageTextWithLinkedReceiptOutcome(message, visibleActions, visibleReceipts);
    return text === message.text ? message : { ...message, text };
  });
  const conversations = [...new Set(allMessages.map((message) => message.conversationId))].map((id) => {
    const messages = allMessages.filter((message) => message.conversationId === id);
    return { id, title: conversationTitles[id] || conciseTitle(messages.find((message) => message.role === 'user')?.text ?? ''), updatedAt: messages.at(-1)?.createdAt ?? '' };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const detailMessage = detailSelection?.kind === 'message' ? displayedMessages.find(message => message.id === detailSelection.id) : undefined;
  const detailAction = detailSelection?.kind === 'action' ? visibleActions.find(action => action.id === detailSelection.id) : undefined;
  const detailReceipt = detailSelection?.kind === 'receipt' ? visibleReceipts.find(receipt => receipt.id === detailSelection.id) : undefined;
  const catalog = workspaceCatalog(workspace);
  const catalogReady = workspaceCatalogReady(workspace);
  const catalogStatus = workspaceCatalogStatus(workspace);
  const canChat = canUseChat(workspace);
  const dashboardCreateEntry = catalog.find(entry => entry.actionKind === 'dashboard_create');
  const canCreateDashboard = capabilityAllowed(workspace, actor, 'dashboard_create') && Boolean(dashboardCreateEntry);
  const canShareDashboard = capabilityAllowed(workspace, actor, 'dashboard_share') && catalog.some(entry => entry.actionKind === 'dashboard_share');
  const canPrepareTasks = capabilityAllowed(workspace, actor, 'ticket_create') && catalog.some(entry => entry.actionKind === 'ticket_create');
  const canDemoUpdate = capabilityAllowed(workspace, actor, 'demo_update') && actor.mode === 'scripted_demo';

  function openDashboard(id: string) {
    setDashboardTaskTarget(null);
    setCompletionNotice(null);
    clearSuccessNotice();
    setActiveSection('dashboard');
    setRequestedDashboardId(id);
    setContextOpen(false);
    const target = `/dashboards/${encodeURIComponent(id)}`;
    if (window.location.pathname + window.location.search !== target) window.history.pushState(null, '', target);
  }

  /** A success banner belongs to the surface where the action happened: leaving that surface clears it (warnings stay until dismissed). */
  function clearSuccessNotice() { setOperationNotice(current => current && typeof current !== 'string' ? null : current); }

  function navigate(section: Section) {
    setDashboardTaskTarget(null);
    setCompletionNotice(null);
    if (section !== activeSection || requestedDashboardId) clearSuccessNotice();
    const target = section === 'overview' ? '/' : `/?section=${section}`;
    if (window.location.pathname + window.location.search !== target) window.history.pushState(null, '', target);
    setRequestedDashboardId(undefined);
    setActiveSection(section);
    setContextOpen(false);
  }

  function prefillRequest(prompt: string, entryId?: string, targets?: { kind: 'artifact' | 'dashboard' | 'monitor'; id: string; revision?: number }[]) {
    if (turnBusy || turnRecovery) return;
    setDraft(prompt);
    setCatalogEntryId(entryId);
    setTurnTargets(targets);
    navigate('overview');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="ข้อความถึง DaTex"]')?.focus());
  }

  async function dashboardIntent(kind: 'share' | 'tasks', id: string, taskOptions?: TaskOptions) {
    const entry = catalog.find(item => item.actionKind === (kind === 'share' ? 'dashboard_share' : 'ticket_create'));
    if (!entry || !actor || turnBusy || turnRecovery) return;
    // Owner-only intents: a recipient of a shared Dashboard never prepares a share/Ticket for someone else's Dashboard.
    const owned = myDashboards.find(dashboard => dashboard.id === id) ?? (dashboardResult?.dashboard.id === id && dashboardResult.dashboard.ownerId === actor.id && !dashboardResult.sharedBy ? dashboardResult.dashboard : undefined);
    if (!owned) return;
    const title = owned.spec.title;
    if (kind === 'tasks' && taskOptions === undefined) {
      dashboardTaskTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDashboardTaskTarget({ dashboardId: id, title, actorId: actor.id, sessionId: actor.sessionId });
      return;
    }
    const intent: DashboardIntent = { dashboardId: id, title, actionKind: kind === 'share' ? 'dashboard_share' : 'ticket_create', prompt: entry.prompt, ...(kind === 'tasks' ? { taskOptions } : {}) };
    const request = dashboardIntentRequest(intent, workspace!, actor.id);
    if (!request) {
      setOperationNotice('ตัวเลือกงานติดตามเปลี่ยนไป กรุณาเลือกผู้รับผิดชอบและกำหนดส่งอีกครั้ง');
      return;
    }
    if (requestedDashboardId) {
      if (id !== requestedDashboardId || dashboardResult?.dashboard.id !== id) return;
      const handoff: DashboardPrefill = { ...intent, actorId: actor.id, sessionId: actor.sessionId, catalogId: entry.id, createdAt: Date.now() };
      try { window.sessionStorage.setItem(composerPrefillKey, JSON.stringify(handoff)); }
      catch { setOperationNotice('เตรียมคำถามเพื่อเปิดบทสนทนาไม่ได้ กรุณาลองเลือกข้อเสนออีกครั้ง'); return; }
      setDashboardTaskTarget(null);
      navigate('overview');
      return;
    }
    setDashboardTaskTarget(null);
    prefillRequest(request.prompt, undefined, request.targets);
  }

  async function renameDashboard(title: string) {
    if (!requestedDashboardId || !csrfToken) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    const baseRevision = dashboardResult?.revision;
    if (!baseRevision) throw new Error('โหลด Dashboard ยังไม่เสร็จ กรุณาลองใหม่');
    const outcome = await renameDashboardRequest<DashboardView>(apiRequest, csrfToken, requestedDashboardId, title, baseRevision);
    if (outcome.status === 'conflict') {
      setDashboardResult(outcome.view);
      throw new Error(outcome.message);
    }
    if (outcome.status === 'staged') { await openStagedProposalById(outcome.proposalId); return; }
    const result = outcome.view;
    setDashboardResult(result);
    setOperationNotice({ message: 'เปลี่ยนชื่อ Dashboard แล้ว', tone: 'success' });
    void refreshWorkspace();
  }

  /** Direct owner edits of the open Dashboard. Same server write path as AI refinement: a stale page gets a conflict and the latest view, never an overwrite. */
  async function mutateDashboard(path: string, init: RequestInit): Promise<EditOutcome> {
    if (!requestedDashboardId || !csrfToken) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    try {
      const body = await apiRequest<unknown>(path, { ...init, headers: jsonHeaders(csrfToken) });
      // A shared Dashboard: the server staged the SAME confirm proposal chat creates. Open the existing confirm dialog; nothing changed yet.
      if (isStagedEdit(body)) { await openStagedProposalById(body.proposalId); return 'staged'; }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'DASHBOARD_CHANGED') {
        setDashboardResult(await apiRequest<DashboardView>(`/api/dashboards/${encodeURIComponent(requestedDashboardId)}`, { method: 'GET', cache: 'no-store' }));
        throw new Error('Dashboard ถูกแก้ไขไปแล้ว โหลดข้อมูลล่าสุดให้แล้ว กรุณาลองใหม่');
      }
      throw error;
    }
    // The write already succeeded. If the follow-up read fails, say exactly that (the shown view is stale; the next edit would be refused by the revision check) instead of a success or a misleading "failed".
    try { setDashboardResult(await apiRequest<DashboardView>(`/api/dashboards/${encodeURIComponent(requestedDashboardId)}`, { method: 'GET', cache: 'no-store' })); }
    catch { throw new Error('บันทึกการแก้ไขแล้ว แต่โหลด Dashboard ล่าสุดไม่สำเร็จ — โหลดหน้านี้ใหม่เพื่อดูสถานะล่าสุด'); }
    void refreshWorkspace();
    return 'updated';
  }
  /** Loads the pending proposals and opens the existing staged confirm dialog on the one a UI edit just created. */
  async function openStagedProposalById(proposalId: string) {
    const result = await loadPendingProposals(apiRequest);
    if (result.status !== 'ready') { setProposalsLoadError(result.message); throw new Error('เตรียมรายการแล้ว แต่เปิดหน้าตรวจไม่ได้ — ดูที่หน้า “งานและการอนุมัติ”'); }
    setStagedProposals(result.proposals); setProposalsLoadError(null);
    const created = result.proposals.find(item => item.id === proposalId);
    if (created) openProposalReview(created);
  }
  async function editDashboardWidgets(change: WidgetChange): Promise<EditOutcome> {
    const baseRevision = dashboardResult?.revision;
    if (!requestedDashboardId || !baseRevision) throw new Error('โหลด Dashboard ยังไม่เสร็จ กรุณาลองใหม่');
    return mutateDashboard(`/api/dashboards/${encodeURIComponent(requestedDashboardId)}/widgets`, { method: 'POST', body: JSON.stringify({ baseRevision, change }) });
  }
  async function editDashboardDescription(description: string): Promise<EditOutcome> {
    const baseRevision = dashboardResult?.revision;
    if (!requestedDashboardId || !baseRevision || !dashboardResult) throw new Error('โหลด Dashboard ยังไม่เสร็จ กรุณาลองใหม่');
    return mutateDashboard(`/api/dashboards/${encodeURIComponent(requestedDashboardId)}`, { method: 'PATCH', body: JSON.stringify({ title: dashboardResult.dashboard.spec.title, description, baseRevision }) });
  }

  /** Refinement goes through the same chat and confirmation flow as creation; the dashboard only seeds the request. */
  function refineDashboard(dashboard: Dashboard) {
    // The Dashboard travels as a UI-selected target (owner-verified by the server); the composer text never carries its internal id.
    prefillRequest(`เกี่ยวกับ Dashboard “${dashboard.spec.title}”: `, undefined, dashboard.ownerId === actor?.id ? [{ kind: 'dashboard', id: dashboard.id }] : undefined);
  }

  const sectionTitles: Record<Exclude<Section, 'dashboard'>, { title: string; description: string }> = {
    overview: { title: 'แชต', description: 'ค้นข้อมูล วิเคราะห์ และตรวจข้อเสนอ' },
    dashboards: { title: 'Dashboard ของฉัน', description: 'Dashboard ที่คุณเป็นเจ้าของ พร้อมช่วงเวลาการอัปเดตและสถานะแหล่งข้อมูล' },
    inbox: { title: 'กล่องรับเข้า', description: 'Dashboard ที่แชร์มายังโปรไฟล์นี้' },
    results: { title: 'ผลลัพธ์', description: 'สิ่งที่ผู้ช่วยทำให้คุณ: ตาราง กราฟ สรุปผู้บริหาร และไฟล์ CSV — ค้นหา ตั้งชื่อ ปักหมุด และเพิ่มเข้า Dashboard' },
    messages: { title: 'ข้อความ', description: 'ข้อความจากเพื่อนร่วมงานและการแจ้งเตือนจาก Monitor' },
    actions: { title: 'งานและการอนุมัติ', description: 'ตรวจสิ่งที่จะดำเนินการ ขอบเขต และสถานะก่อนยืนยัน รายการหมดอายุหรือข้อมูลเปลี่ยนต้องเตรียมใหม่' },
    audit: { title: 'ประวัติการทำงาน', description: 'อ่านผลรายเป้าหมายและเหตุการณ์ตรวจสอบของโปรไฟล์นี้' },
    capabilities: { title: 'งานที่ทำได้', description: 'เลือกคำถามหรือข้อเสนอที่พร้อมสำหรับสิทธิ์ของคุณ ข้อความจะถูกเติมในบทสนทนาให้ตรวจแก้ก่อนส่ง' },
  };
  const heading = displayedSection === 'dashboard' ? null : sectionTitles[displayedSection];
  const modeButtonText = modeLabel(actor.mode);
  const profiles = workspace.profiles;
  const reviewedAction = selectedAction ? workspace.actions.find(action => action.id === selectedAction.id) ?? selectedAction : null;

  function selectConversation(id: string) {
    setCompletionNotice(null);
    setSelectedConversationId(id);
    setDetailSelection(null);
    setNewConversation(false);
    if (!turnBusy && !submissionRef.current) writeRecoveryMemory(actor!, turnRecovery, blockedRequestTexts, false, id);
    setSessionsOpen(false);
    navigate('overview');
  }

  function createConversation() {
    if (turnBusy || turnRecovery) return;
    setCompletionNotice(null);
    setSelectedConversationId(null);
    setDetailSelection(null);
    setNewConversation(true);
    writeRecoveryMemory(actor!, null, blockedRequestTexts, true);
    setDraft('');
    setSessionsOpen(false);
    navigate('overview');
  }

  const conversationSidebar = <ConversationSidebar key={actor.id + actor.sessionId} request={apiRequest} csrfToken={csrfToken} activeId={activeConversationId} disabled={turnBusy || Boolean(turnRecovery)} revision={`${workspace.messages.length}:${workspace.messages.at(-1)?.id ?? ''}:${completionNotice?.turnId ?? ''}`} onSelect={selectConversation} onNew={createConversation} onArchived={id => { if (id === activeConversationId) createConversation(); }} onTitles={updateConversationTitles} footer={<>วันของข้อมูล {formatDate(workspace.businessDate, false)}<br />{actorScope(actor)}</>} />;
  const showcaseDisabled = modeBusy || turnBusy || Boolean(turnRecovery) || recoveryChecking || Boolean(actionMutation) || !canChat || Boolean(workspaceError);
  const demoGuide = actor.mode === 'scripted_demo' && demoGuideOpen ? <DemoGuide role={actor.role} disabled={showcaseDisabled} recoveryPending={Boolean(turnRecovery)} onTry={item => void tryShowcase(item)} onClose={() => { setDemoGuideOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-demo-guide-opener]')?.focus()); }} onLive={() => void switchMode('live_ai')} /> : undefined;

  function renderMessageActions(message: LocalMessage) {
    if (message.delivery) return null;
    const actionIds = message.pendingActionIds ?? (message.pendingActionId ? [message.pendingActionId] : []);
    const linkedIds = new Set(actionIds);
    const anchoredElsewhere = new Set(displayedMessages.filter(item => item.id !== message.id).flatMap(item => item.pendingActionIds ?? (item.pendingActionId ? [item.pendingActionId] : [])));
    for (let pass = 0; pass < visibleActions.length; pass += 1) {
      let added = false;
      for (const candidate of visibleActions as LifecycleAction[]) {
        if (!candidate.predecessorActionId || !linkedIds.has(candidate.predecessorActionId) || linkedIds.has(candidate.id) || anchoredElsewhere.has(candidate.id)) continue;
        const predecessor = visibleActions.find(item => item.id === candidate.predecessorActionId) as LifecycleAction | undefined;
        if (predecessor?.supersededByActionId === candidate.id && candidate.conversationId === message.conversationId) { linkedIds.add(candidate.id); added = true; }
      }
      if (!added) break;
    }
    const actions = visibleActions.filter(action => linkedIds.has(action.id));
    const receipts = visibleReceipts.filter((receipt) => receipt.id === message.receiptId || actions.some((action) => action.id === receipt.actionId));
    if (!actions.length && !receipts.length) return null;
    return <div className={styles.inlineActions}>{actions.map((action) => {
      const submitted = visibleReceipts.some((receipt) => receipt.actionId === action.id);
      return <ActionCard key={action.id} action={action} currentTime={currentTime} canConfirm={canConfirm(action) && !submitted && !unknownExecutions[action.id]} busy={confirmBusyId === action.id || Boolean(actionMutation)} mutationKind={actionMutation?.actionId === action.id ? actionMutation.kind : undefined} mutationUncertain={Boolean(uncertainActionMutations[action.id])} mutationRejected={uncertainActionMutations[action.id]?.rejected} canReview={canReviseAction(action) || action.payload.kind === 'badge_revoke' && actionIsCurrent(action)} unknown={unknownExecutions[action.id]} submitted={submitted} receipt={visibleReceipts.find(receipt => receipt.actionId === action.id)} onOpenDashboard={openDashboard} onReview={openActionReview} onReconcile={(executionId) => void reconcile(executionId, action.id)} onRefresh={() => void refreshWorkspace()} preparationBlockedReason={turnRecovery ? 'ตรวจสถานะคำขอเดิมก่อนเริ่มคำขอใหม่' : turnBusy ? 'รอคำตอบปัจจุบันก่อนเริ่มคำขอใหม่' : undefined} onPrepare={(item) => prefillRequest(retryActionPrompt(item))} onDetails={(item) => { setDetailSelection({ kind: 'action', id: item.id }); setSourceTarget(null); setContextOpen(true); }} profiles={profiles} />;
    })}{receipts.map((receipt) => <section className="panel" key={receipt.id}><div className="panel-body"><ReceiptRecord receipt={receipt} onDetails={(item) => { setDetailSelection({ kind: 'receipt', id: item.id }); setSourceTarget(null); setContextOpen(true); }} busy={confirmBusyId === receipt.actionId} onReconcile={(pendingReceipt, revision) => void reconcile(pendingReceipt.id, pendingReceipt.actionId, revision)} /></div></section>)}</div>;
  }

  return (
    <main className={styles.root} data-details={contextOpen && Boolean(detailSelection)}>
      <a className={styles.skipLink} href="#main-content">ข้ามไปเนื้อหาหลัก</a>
      <div className={styles.statusBar} aria-label="สถานะพื้นที่ทำงาน"><span><strong>{roleLabel(actor.role)}</strong> · {actor.mode === 'live_ai' ? 'โหมด Live AI' : 'โหมดสาธิต'}</span><span><Icon name="database" size={13} />ข้อมูลจำลองสำหรับสาธิต · อ่านเฉพาะข้อมูลที่คุณมีสิทธิ์เห็น</span></div>
      <header className={styles.header}>
        <button type="button" className={styles.brand} onClick={() => navigate('overview')} aria-label="DaTex แชต"><span className={styles.brandMark}><Icon name="nexus" size={21} /></span><span><strong>DaTex</strong></span></button>
        <nav className={styles.mainNav} aria-label="เมนูหลัก">{([{ section: 'overview', label: 'แชต' }, { section: 'dashboards', label: 'Dashboard' }, { section: 'results', label: 'ผลลัพธ์' }, { section: 'actions', label: 'งานและการอนุมัติ', short: 'งาน/อนุมัติ' }, { section: 'messages', label: 'ข้อความ' }, { section: 'audit', label: 'ประวัติการทำงาน', short: 'ประวัติ' }] as const).map((item) => <button key={item.section} type="button" {...('short' in item ? { 'aria-label': item.label } : {})} aria-current={displayedSection === item.section || (item.section === 'dashboards' && ['dashboard', 'inbox'].includes(displayedSection)) || (item.section === 'actions' && displayedSection === 'capabilities') ? 'page' : undefined} onClick={() => navigate(item.section)}>{'short' in item ? <><span className={styles.navFull}>{item.label}</span><span className={styles.navShort} aria-hidden="true">{item.short}</span></> : item.label}{item.section === 'messages' && unreadMessages > 0 && <span className={styles.navBadge} aria-label={`ยังไม่ได้อ่าน ${unreadMessages} ข้อความ`}>{unreadMessages > 99 ? '99+' : unreadMessages}</span>}</button>)}</nav>
        {actor.mode === 'scripted_demo' && <button className={`btn btn-small ${demoStyles.headerButton}`} type="button" data-demo-guide-opener onClick={() => { setDemoGuideOpen(true); navigate('overview'); }}>คู่มือโหมดสาธิต</button>}
        <div className={styles.identity}><button type="button" className="mode-control" role="switch" aria-label="เปลี่ยนโหมดการทำงาน" title="เปิด: Live AI · ปิด: โหมดสาธิต" aria-checked={actor.mode === 'live_ai'} disabled={modeBusy || turnBusy || Boolean(turnRecovery) || recoveryChecking || Boolean(actionMutation)} onClick={() => void switchMode()}><span className="mode-track" /><span className="mode-state">{modeBusy ? 'กำลังเปลี่ยน…' : modeButtonText}</span></button><button className="icon-button" type="button" aria-label="ออกจากระบบ" title="ออกจากระบบ" disabled={turnBusy || recoveryChecking || Boolean(actionMutation)} onClick={() => void logout()}><Icon name="logout" /></button></div>
      </header>
      <div className={styles.shell}>
        {displayedSection === 'overview' && !sessionsOpen && conversationSidebar}
        <section className={styles.workspace} id="main-content" tabIndex={-1}>
          {displayedSection === 'overview' && <header className={styles.workspaceToolbar}><button className={styles.mobileSessions} type="button" aria-label="เปิดบทสนทนา" onClick={() => setSessionsOpen(true)}><Icon name="message" size={19} /></button><div className={styles.toolbarTitle}><h1>{(activeConversationId && conversationTitles[activeConversationId]) || conversations.find((conversation) => conversation.id === activeConversationId)?.title || 'บทสนทนาใหม่'}</h1><p>ข้อมูลวันที่ {workspace.businessDate}</p></div>{detailSelection && <button className="btn btn-small" type="button" onClick={() => setContextOpen(true)}><Icon name="book" size={15} />รายละเอียดที่เลือก</button>}</header>}
          <div className={styles.notices}>
            {workspaceError && <div className="error-banner" role="alert"><Icon name="alertCircle" /><div className="banner-copy"><strong>โหลดข้อมูลล่าสุดไม่สำเร็จ</strong><p>{workspaceError}</p></div><button className="text-button" type="button" onClick={() => void refreshWorkspace()}>ลองอีกครั้ง</button></div>}
            {modeError && <div className="error-banner" role="alert" style={{ marginTop: workspaceError ? 10 : 0 }}><Icon name="alertCircle" /><div className="banner-copy"><strong>เปลี่ยนโหมดไม่สำเร็จ</strong><p>{modeError}</p></div><button className="icon-button" type="button" aria-label="ปิดข้อความ" onClick={() => setModeError(null)}><Icon name="close" /></button></div>}
            {modeNotice && displayedSection === 'overview' && <div className="info-banner" role="status" style={{ marginTop: 10 }}><Icon name="check" /><div className="banner-copy"><p>{modeNotice}</p></div><button className="icon-button" type="button" aria-label="ปิดข้อความ" onClick={() => setModeNotice(null)}><Icon name="close" /></button></div>}
            {operationNotice && <div className={typeof operationNotice === 'string' ? 'warning-banner' : 'success-banner'} role="status" aria-label="ผลการดำเนินการ" style={{ marginTop: workspaceError || modeError || modeNotice ? 10 : 0 }}><Icon name={typeof operationNotice === 'string' ? 'alertCircle' : 'check'} /><div className="banner-copy"><p>{typeof operationNotice === 'string' ? operationNotice : operationNotice.message}</p></div><button className="icon-button" type="button" aria-label="ปิดข้อความ" onClick={() => setOperationNotice(null)}><Icon name="close" /></button></div>}
            {conversationReceiptState.error && displayedSection === 'overview' && <p className="form-hint" role="alert" data-conversation-receipts-error style={{ marginTop: 10 }}>โหลดผลการดำเนินการไม่สำเร็จ <button className="text-button" type="button" onClick={() => setConversationReceiptAttempt(attempt => attempt + 1)}>ลองอีกครั้ง</button></p>}
            {conversationReceiptState.hasOlder && displayedSection === 'overview' && <p className="panel-subtitle" data-conversation-receipts-cap>แสดงผลการดำเนินการล่าสุดได้สูงสุด 100 รายการต่อบทสนทนา</p>}

          </div>
          {displayedSection === 'overview' ? <ChatThread demoGuide={demoGuide} onShowcase={item => void tryShowcase(item)} onOpenDemoGuide={() => setDemoGuideOpen(true)} aiUnavailable={aiUnavailable} aiUnavailableStatus={aiUnavailableStatus} onSwitchToDemo={() => void switchMode('scripted_demo', false, true)} onDismissAIUnavailable={() => { aiAvailabilityDismissed.current = true; setAIUnavailable(false); }} modeBusy={modeBusy || Boolean(actionMutation)} catalogStatus={catalogStatus} onCatalogRetry={refreshWorkspace} catalog={catalog} businessDate={workspace.businessDate} pendingCount={visibleActions.filter(action => canConfirm(action) && !visibleReceipts.some(receipt => receipt.actionId === action.id)).length} messages={chatMessages} conversationKey={activeConversationId ?? 'new'} actor={actor} actorDisplayName={actorDisplayName(actor)} currentMode={actor.mode} busy={turnBusy} draft={draft} setDraft={setDraft} catalogEntryId={catalogEntryId} onCatalogEntryIdChange={setCatalogEntryId} onSend={(message) => { const entryId = catalogEntryId, targets = turnTargets; setCatalogEntryId(undefined); setTurnTargets(undefined); return sendTurn(message, undefined, undefined, false, undefined, entryId, undefined, targets); }} recovery={turnRecovery} onRecover={() => void recoverTurn()} onRefresh={() => void refreshTurnStatus()} recoveryChecking={recoveryChecking} onNewQuestion={startNewQuestion} continueConversation={Boolean(failedTurnConversationId(turnRecovery, workspace))} rejection={chatRejection} blockedDraft={blockedRequestTexts.includes(draft.trim())} chatEnabled={canChat} suggestionsEnabled={!modeBusy && !workspaceError} onEvidence={(id, target) => { setDetailSelection({ kind: 'message', id }); setSourceTarget(target ?? null); setContextOpen(true); }} onChooseWork={() => navigate('capabilities')} onStop={activeStreamTurn ? () => streamAbortRef.current?.abort() : undefined} renderAction={renderMessageActions} completionNotice={completionNotice} routerReceipts={conversationReceipts} routerUi={{ proposals: stagedProposals, proposalsError: proposalsLoadError, onRetryProposals: () => void refreshProposals(), onReviewProposal: openProposalReview, onChoose: chooseClarification, onArtifact: (message, artifact, operation) => void artifactWrite(message, artifact, operation), artifactBusy, artifactNotice }} /> : <div className={styles.contentPage}><div className={styles.pageInner}>{demoGuide}
            {['dashboards', 'inbox'].includes(displayedSection) && <nav className={styles.subNav} aria-label="ประเภท Dashboard"><button type="button" aria-current={displayedSection === 'dashboards' ? 'page' : undefined} onClick={() => navigate('dashboards')}>Dashboard ของฉัน</button><button type="button" aria-current={displayedSection === 'inbox' ? 'page' : undefined} onClick={() => navigate('inbox')}>แชร์ถึงฉัน {inboxItems.length > 0 ? `(${inboxItems.length})` : ''}</button></nav>}
            {['actions', 'capabilities'].includes(displayedSection) && <nav className={styles.subNav} aria-label="งานของคุณ"><button type="button" aria-current={displayedSection === 'actions' ? 'page' : undefined} onClick={() => navigate('actions')}>คำขอและผลการทำงาน</button><button type="button" aria-current={displayedSection === 'capabilities' ? 'page' : undefined} onClick={() => navigate('capabilities')}>งานที่ทำได้</button></nav>}
            {currentDashboardTaskTarget && (displayedSection === 'dashboards' || displayedSection === 'dashboard' && currentDashboardTaskTarget.dashboardId === requestedDashboardId) && <DashboardTaskOptions key={`${actor.sessionId}:${currentDashboardTaskTarget.dashboardId}`} title={currentDashboardTaskTarget.title} actorId={actor.id} assigneeOptions={workspace.taskAssigneeOptions} disabled={!canPrepareTasks || turnBusy || Boolean(turnRecovery) || modeBusy || Boolean(workspaceError)} onPrepare={options => void dashboardIntent('tasks', currentDashboardTaskTarget.dashboardId, options)} onCancel={() => { setDashboardTaskTarget(null); dashboardTaskTrigger.current?.focus(); }} />}
            {displayedSection === 'dashboards' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div>{myDashboards.length > 0 && canCreateDashboard && <div className="heading-tools"><button className="btn btn-primary" type="button" disabled={!canCreateDashboard || Boolean(turnRecovery)} title={!canCreateDashboard ? 'สิทธิ์ปัจจุบันยังไม่มีข้อเสนอสร้าง Dashboard ที่พร้อมใช้' : undefined} onClick={() => dashboardCreateEntry && prefillRequest(dashboardCreateEntry.prompt, dashboardCreateEntry.id)}><Icon name="plus" size={15} /> เริ่มสร้าง Dashboard ใหม่</button></div>}</header>
              {myDashboards.length ? <section className="panel"><div className="panel-body"><div className="record-list">{[...activeDashboards].sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) || b.updatedAt.localeCompare(a.updatedAt)).map((dashboard) => <DashboardRecord key={dashboard.id} dashboard={dashboard} onOpen={openDashboard} onShare={(id) => void dashboardIntent('share', id)} onTasks={(id) => void dashboardIntent('tasks', id)} canShare={canShareDashboard} canTasks={canPrepareTasks} onOrganize={(id, op) => void organizeOwnDashboard(id, op)} organizeBusy={organizeBusy} />)}</div>{archivedDashboards.length > 0 && <details data-dashboards-archived style={{ marginTop: 16 }}><summary>เก็บถาวร ({archivedDashboards.length})</summary><div className="record-list">{[...archivedDashboards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((dashboard) => <DashboardRecord key={dashboard.id} dashboard={dashboard} onOpen={openDashboard} onShare={(id) => void dashboardIntent('share', id)} onTasks={(id) => void dashboardIntent('tasks', id)} canShare={false} canTasks={false} onOrganize={(id, op) => void organizeOwnDashboard(id, op)} organizeBusy={organizeBusy} />)}</div></details>}</div></section> : <EmptyPanel icon="chart" title="ยังไม่มี Dashboard ของคุณ" message={!catalogReady ? catalogStatusMessage(catalogStatus) : canCreateDashboard ? actor.mode === 'live_ai' ? "เติมคำขอสร้าง Dashboard ในแชต ตรวจคำขอแล้วกดส่ง เมื่อข้อมูลพร้อม ระบบอาจสร้าง Dashboard ส่วนตัวให้ทันที หรือเตรียมข้อเสนอให้ตรวจและยืนยันตามนโยบายของระบบ" : "เติมคำขอสร้าง Dashboard ในแชต ตรวจคำขอแล้วกดส่ง ระบบจะเตรียมข้อเสนอให้ตรวจและยืนยันก่อนสร้าง" : "เมื่อมี Dashboard ที่คุณเป็นเจ้าของ รายการจะแสดงที่นี่ ขณะนี้ยังไม่มีข้อเสนอสร้าง Dashboard ที่พร้อมใช้"} action={!catalogReady && catalogStatusRetryable(catalogStatus) ? <button className="btn" type="button" onClick={() => void refreshWorkspace()}>โหลดรายการงานอีกครั้ง</button> : canCreateDashboard ? <button className="btn btn-primary" type="button" disabled={turnBusy || Boolean(turnRecovery)} onClick={() => dashboardCreateEntry && prefillRequest(dashboardCreateEntry.prompt, dashboardCreateEntry.id)}>เริ่มสร้าง Dashboard</button> : undefined} />}
            </>}

            {displayedSection === 'inbox' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div></header>
              {inboxItems.length ? <section className="panel"><div className="panel-body"><div className="record-list">{[...inboxItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <article className="record-row" key={item.id}><div className="record-main"><strong>{item.title}</strong><span>{item.sharedBy ? `แชร์โดย ${displayPerson(item.sharedBy)} · ` : ''}รับเมื่อ {formatDate(item.createdAt)}</span></div><button className="btn btn-small btn-primary" type="button" data-open-dashboard={item.dashboardId} onClick={() => openDashboard(item.dashboardId)}>เปิด Dashboard</button></article>)}</div></div></section> : <EmptyPanel icon="inbox" title="ยังไม่มีรายการที่แชร์มา" message="เมื่อมีผู้แชร์ Dashboard มายังโปรไฟล์นี้ รายการจะแสดงพร้อมวันที่แชร์" />}
            </>}

            {displayedSection === 'results' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div></header>
              <ResultsLibrary onOpenConversation={selectConversation} dashboards={myDashboards.map(dashboard => ({ id: dashboard.id, title: dashboard.spec.title, shared: false }))} onAskInChat={(prompt, target) => prefillRequest(prompt, undefined, target ? [target] : undefined)} onStaged={proposalId => openStagedProposalById(proposalId)} />
            </>}

            {displayedSection === 'messages' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div></header>
              <InboxPanel />
            </>}

            {displayedSection === 'actions' && <>
              <header className="page-heading"><div><h1 data-actions-heading tabIndex={-1}>{heading?.title}</h1><p>{heading?.description}</p></div><button className="btn" type="button" onClick={() => void refreshWorkspace()} disabled={Boolean(workspaceError)}><Icon name="refresh" size={15} /> โหลดสถานะ</button></header>
              {actor.mode === 'scripted_demo' && canDemoUpdate && <div style={{ marginBottom: 18 }}><ScenarioPanel busy={scenarioBusy} unknown={scenarioUnknown} onPropose={(scenario) => void proposeScenario(scenario)} /></div>}
              <StagedProposalList proposals={stagedProposals} onReview={openProposalReview} loadError={proposalsLoadError} onRetry={() => void refreshProposals()} />
              {visibleActions.length ? <div className="section-stack">{[{ label: 'รอตรวจและยืนยัน', items: visibleActions.filter(action => actionState(action, currentTime).key === 'pending' && !visibleReceipts.some(receipt => receipt.actionId === action.id) && !unknownExecutions[action.id]) }, { label: 'ต้องตรวจสถานะ', items: visibleActions.filter(action => ['claimed', 'invalid'].includes(actionState(action, currentTime).key) || unknownExecutions[action.id] || (visibleReceipts.some(receipt => receipt.actionId === action.id && receipt.status === 'pending'))) }].filter(group => group.items.length).map(group => <section key={group.label}><h2 className={styles.queueHeading}>{group.label} · {group.items.length}</h2><div className="action-list">{group.items.map(action => {
                const submitted = visibleReceipts.some((receipt) => receipt.actionId === action.id);
                return <ActionCard key={action.id} action={action} currentTime={currentTime} canConfirm={canConfirm(action) && !submitted && !unknownExecutions[action.id]} busy={confirmBusyId === action.id || Boolean(actionMutation)} mutationKind={actionMutation?.actionId === action.id ? actionMutation.kind : undefined} mutationUncertain={Boolean(uncertainActionMutations[action.id])} mutationRejected={uncertainActionMutations[action.id]?.rejected} canReview={canReviseAction(action) || action.payload.kind === 'badge_revoke' && actionIsCurrent(action)} unknown={unknownExecutions[action.id]} submitted={submitted} receipt={visibleReceipts.find(receipt => receipt.actionId === action.id)} onOpenDashboard={openDashboard} onReview={openActionReview} onReconcile={(executionId) => void reconcile(executionId, action.id)} onRefresh={() => void refreshWorkspace()} preparationBlockedReason={turnRecovery ? 'ตรวจสถานะคำขอเดิมก่อนเริ่มคำขอใหม่' : turnBusy ? 'รอคำตอบปัจจุบันก่อนเริ่มคำขอใหม่' : undefined} onPrepare={(item) => prefillRequest(retryActionPrompt(item))} onDetails={(item) => { setDetailSelection({ kind: 'action', id: item.id }); setSourceTarget(null); setContextOpen(true); }} profiles={workspace.profiles} />;
              })}</div></section>)}</div> : <EmptyPanel icon="shield" title="ไม่มีรายการรอยืนยัน" message="ข้อเสนอที่พร้อมตรวจและยืนยันจะแสดงที่นี่ หลังผู้ช่วยตรวจข้อมูลที่จำเป็นแล้ว" />}
              {visibleReceipts.some((receipt) => receipt.status === 'pending') && <div style={{ marginTop: 18 }}><section className="panel"><header className="panel-header"><div><h2 className="panel-title">รออ่านผล</h2><p className="panel-subtitle">ผลการดำเนินการที่ยังรอตรวจสอบ</p></div></header><div className="panel-body"><div className="record-list">{visibleReceipts.filter((receipt) => receipt.status === 'pending').map((receipt) => <ReceiptRecord key={receipt.id} receipt={receipt} busy={confirmBusyId === receipt.actionId} onReconcile={(pendingReceipt, revision) => void reconcile(pendingReceipt.id, pendingReceipt.actionId, revision)} />)}</div></div></section></div>}
              <h2 className={styles.queueHeading}>ผลการดำเนินการที่ตรวจผลแล้ว</h2>
              {/* Re-keyed when the pending list changes so a just-confirmed proposal's verified result appears here, not only as a banner. */}
              <RouterReceipts key={stagedProposals.map(item => item.id).join(',')} />
              <h2 className={styles.queueHeading}>งานติดตามของฉัน</h2>
              <RouterWorkItems />
              <h2 className={styles.queueHeading}>Monitor ของฉัน</h2>
              <RouterMonitors />
            </>}

            {displayedSection === 'audit' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div><button className="btn" type="button" onClick={() => void refreshWorkspace()}><Icon name="refresh" size={15} /> โหลดสถานะ</button></header>
              <HistoryPanel actions={visibleActions} receipts={visibleReceipts} audit={visibleAudit} actorName={actorDisplayName(actor)} now={currentTime} onAction={item => { setDetailSelection({ kind: 'action', id: item.id }); setContextOpen(true); }} renderReceipt={receipt => <ReceiptRecord receipt={receipt} onDetails={item => { setDetailSelection({ kind: 'receipt', id: item.id }); setContextOpen(true); }} busy={confirmBusyId === receipt.actionId} onReconcile={(item, revision) => void reconcile(item.id, item.actionId, revision)} />} routerHistory={sections => <RouterHistory {...sections} />} />
            </>}

            {displayedSection === 'capabilities' && <>
              <header className="page-heading"><div><h1>{heading?.title}</h1><p>{heading?.description}</p></div></header>
              <WorkCatalog status={catalogStatus} onRetry={refreshWorkspace} entries={catalog} disabled={turnBusy || Boolean(turnRecovery)} onSelect={entry => prefillRequest(entry.prompt, entry.id)} />
            </>}

            {displayedSection === 'dashboard' && <>
              <button className="btn mobile-dashboard-detail" type="button" aria-label="รายละเอียด Dashboard" aria-current="page" onClick={() => requestedDashboardId && openDashboard(requestedDashboardId)}><Icon name="chart" size={17} /><span>รายละเอียด Dashboard</span></button>
              {dashboardLoading && <div className="loading-card panel"><div className="skeleton" style={{ width: 260, height: 23 }} /><div className="skeleton" style={{ width: '74%', height: 13 }} /><div className="skeleton" style={{ width: '100%', height: 230, marginTop: 15 }} /></div>}
              {dashboardError && !dashboardLoading && <EmptyPanel icon="alert" title="เปิด Dashboard ไม่ได้" message={dashboardError} action={<div className="record-end" style={{ justifyContent: 'center' }}><button className="btn btn-primary" type="button" data-dashboard-retry onClick={() => setDashboardReload(n => n + 1)}>ลองโหลดอีกครั้ง</button><button className="btn" type="button" onClick={() => navigate('overview')}>กลับไปพื้นที่ทำงาน</button></div>} />}
              {!dashboardLoading && !dashboardError && dashboardResult && <DashboardDetail dashboard={dashboardResult.dashboard} evidence={dashboardResult.evidence} vizData={dashboardResult.vizData} analysisStale={dashboardResult.analysisStale} sources={dashboardResult.evidence.sources} canShare={canShareDashboard && dashboardResult.dashboard.ownerId === actor.id && !dashboardResult.sharedBy} canPrepareTasks={canPrepareTasks && dashboardResult.dashboard.ownerId === actor.id && !dashboardResult.sharedBy} sharedBy={dashboardResult.sharedBy} onRename={dashboardResult.dashboard.ownerId === actor.id ? renameDashboard : undefined} manage={dashboardResult.dashboard.ownerId === actor.id ? { onWidgetOp: editDashboardWidgets, onDescription: editDashboardDescription, onGoResults: () => navigate('results'), onAddWithAI: () => refineDashboard(dashboardResult.dashboard) } : undefined} onDelete={dashboardResult.dashboard.ownerId === actor.id && !dashboardResult.sharedBy ? () => deleteOwnDashboard(dashboardResult.dashboard.id) : undefined} onRefine={() => refineDashboard(dashboardResult.dashboard)} onBackToChat={() => navigate('overview')} onShare={() => void dashboardIntent('share', dashboardResult.dashboard.id)} onPrepareTasks={() => void dashboardIntent('tasks', dashboardResult.dashboard.id)} />}
              {!dashboardLoading && !dashboardError && !dashboardResult && <EmptyPanel icon="chart" title="กำลังเปิด Dashboard" message="กำลังอ่านข้อมูล Dashboard และหลักฐาน" />}
            </>}
          </div></div>}
        </section>
      {contextOpen && detailSelection && <ContextPanel selection={detailSelection} message={detailMessage} action={detailAction} receipt={detailReceipt} recovery={turnRecovery} profiles={profiles} now={currentTime} confirmable={Boolean(detailAction && canConfirm(detailAction) && !unknownExecutions[detailAction.id] && !visibleReceipts.some(receipt => receipt.actionId === detailAction.id))} sourceTarget={sourceTarget} conversationTitle={activeConversationId ? conversationTitles[activeConversationId] : undefined} onClose={() => setContextOpen(false)} />}
      </div>

      <dialog ref={sessionsDialogRef} className={`${styles.contextDialog} ${styles.sessionDialog}`} aria-labelledby="conversation-dialog-title" onCancel={(event) => { event.preventDefault(); setSessionsOpen(false); }}><header className={styles.drawerHead}><h2 id="conversation-dialog-title">บทสนทนา</h2><button className="icon-button" type="button" aria-label="ปิดบทสนทนา" onClick={() => setSessionsOpen(false)}><Icon name="close" /></button></header>{sessionsOpen && conversationSidebar}</dialog>
      <StagedProposalDialog proposal={reviewedProposal} busy={proposalBusy} error={proposalError} receipt={proposalReceipt} onConfirm={proposal => void confirmProposalAction(proposal)} onCancel={proposal => void cancelProposalAction(proposal)} onClose={closeProposalReview} />
      <ActionReviewDialog key={reviewedAction ? `${reviewedAction.actorId}:${reviewedAction.sessionId}:${reviewedAction.id}` : "closed"} action={reviewedAction} currentTime={currentTime} canConfirm={reviewedAction ? canConfirm(reviewedAction) : false} canRevise={reviewedAction ? canReviseAction(reviewedAction) : false} confirmBusy={Boolean(reviewedAction && confirmBusyId === reviewedAction.id)} mutationBusy={reviewedAction && actionMutation?.actionId === reviewedAction.id ? actionMutation.kind : undefined} mutationUncertain={reviewedAction && !uncertainActionMutations[reviewedAction.id]?.rejected ? uncertainActionMutations[reviewedAction.id]?.kind : undefined} confirmError={reviewedAction && uncertainActionMutations[reviewedAction.id]?.rejected ? 'คำขอเปลี่ยนข้อเสนอถูกปฏิเสธ ข้อเสนอเดิมยังยืนยันไม่ได้ ปิดหน้าต่างเพื่อตรวจสถานะหรือเตรียมรายการใหม่' : reviewedAction && confirmError?.actionId === reviewedAction.id ? confirmError.message : null} badgeReview={reviewedAction && badgeReviewRead?.status === 'ready' && badgeReviewRead.actionId === reviewedAction.id && badgeReviewRead.payloadHash === reviewedAction.payloadHash ? workspace.badgeReviews?.[reviewedAction.id] : undefined} badgeReviewStatus={reviewedAction && badgeReviewRead?.actionId === reviewedAction.id && badgeReviewRead.payloadHash === reviewedAction.payloadHash ? badgeReviewRead.status : 'unavailable'} onRefreshBadge={() => reviewedAction && void refreshBadgeForAction(reviewedAction)} onClose={closeActionReview} onConfirm={action => void confirmAction(action)} onRevise={(action, request) => mutateAction(action, 'revise', request)} onCancelAction={action => mutateAction(action, 'cancel')} onRefresh={refreshWorkspace} profiles={workspace.profiles} />
    </main>
  );
}
