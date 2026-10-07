import type { Actor, PendingAction, ReceiptView } from '@/lib/contracts';
import type { ActionPorts, SavedDashboardInfo, StagedProposal } from '@/lib/router/executors/action-ports';
import type { GroundedStep } from '@/lib/router/validate';
import type { ParamValue } from '@/lib/router/turn-plan';
import { digest } from '@/lib/effects/shared';
import { fixture, now } from '../../wave4/fixtures';

export { fixture as wave4Fixture, now as WAVE4_NOW };
export const NOW = () => new Date(now);
export const CONVERSATION = 'conv-1';
export const TURN = 'turn-1';

export const eastActor = (over: Partial<Actor> = {}): Actor => ({
  id: 'east_manager', name: 'East Manager', role: 'east_manager', active: true, regions: ['east'], sessionId: 's1', mode: 'live_ai', modeRevision: 1,
  permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create', 'communication.send', 'monitor.create', 'monitor.manage', 'hr.read', 'badge.revoke'],
  ...over,
} as Actor);

export function grounded(actionId: string, params: Record<string, ParamValue>, defaults: string[] = []): GroundedStep {
  return { index: 0, step: { kind: 'action', actionId, params: {} } as GroundedStep['step'],
    params: Object.fromEntries(Object.entries(params).map(([name, value]) => [name, { name, value, source: defaults.includes(name) ? 'default' : 'context_id', span: null, serverDefault: defaults.includes(name) }])) };
}
export function groundedRefine(pendingActionId: string, operation: unknown, params: Record<string, ParamValue> = {}): GroundedStep {
  return { index: 0, step: { kind: 'refine', pendingActionId, operation } as GroundedStep['step'],
    params: Object.fromEntries(Object.entries(params).map(([name, value]) => [name, { name, value, source: 'user_quoted', span: null, serverDefault: false }])) };
}

export interface FakeState {
  pending: Map<string, PendingAction>; dashboards: Map<string, SavedDashboardInfo>; staged: Map<string, StagedProposal>;
  calls: string[]; prepared: { tool: string; args: Record<string, unknown> }[]; audits: string[]; inbox: unknown[]; monitors: unknown[];
  revisions: { id: string; patch: unknown; key: string }[];
  allowedRecipients: Set<string>; receiptStatus: 'verified_success' | 'failed'; reviseFails: boolean; branchesOk: boolean;
}

export function fakePorts(overrides: Partial<ActionPorts> = {}, state: Partial<FakeState> = {}): { ports: ActionPorts; state: FakeState } {
  const s: FakeState = { pending: new Map(), dashboards: new Map([['D1', { id: 'D1', ownerId: 'east_manager', title: 'Bangkok dashboard', shared: false, deleted: false }]]),
    staged: new Map(), calls: [], prepared: [], audits: [], inbox: [], monitors: [], revisions: [], allowedRecipients: new Set(['team_east']),
    receiptStatus: 'verified_success', reviseFails: false, branchesOk: true, ...state };
  let seq = 0;
  const w4 = fixture();
  const ports: ActionPorts = {
    reloadActor: async actor => actor,
    prepareTool: async (actor, tool, args, ref) => {
      s.calls.push(`prepare:${tool}`); s.prepared.push({ tool, args });
      const kind = tool === 'dashboard.prepare_create' ? 'dashboard_create' : tool === 'dashboard.prepare_share' ? 'dashboard_share' : tool === 'ticket.prepare_create' ? 'ticket_create' : 'badge_revoke';
      const payload = kind === 'dashboard_create' ? { kind, spec: (args as { spec: unknown }).spec } : { kind, ...args };
      const action = { id: `PA-${++seq}`, actorId: actor.id, sessionId: actor.sessionId, conversationId: ref.conversationId, turnId: ref.turnId,
        mode: actor.mode, modeRevision: actor.modeRevision, payload, payloadHash: digest({ actor: actor.id, payload }), evidenceVersion: 'v1', packs: [],
        createdAt: `2026-10-06T00:00:0${seq}.000Z`, expiresAt: '2026-10-07T00:00:00.000Z', status: 'pending', preview: `preview ${kind}` } as unknown as PendingAction;
      s.pending.set(action.id, action); return action;
    },
    confirmPending: async (_actor, id) => {
      s.calls.push(`confirm:${id}`);
      const a = s.pending.get(id)!;
      return { id: `R-${id}`, actionId: id, actorId: a.actorId, kind: a.payload.kind, status: s.receiptStatus, results: [], createdAt: '', verifiedAt: '',
        ...(a.payload.kind === 'dashboard_create' ? { dashboardId: `DASH-${id}` } : {}) } as unknown as ReceiptView;
    },
    cancelPending: async (_actor, id) => { s.calls.push(`cancel:${id}`); const a = s.pending.get(id)!; const c = { ...a, status: 'stale' } as PendingAction; s.pending.set(id, c); return c; },
    revisePending: async (_actor, id, patch, key) => {
      s.calls.push(`revise:${id}`); s.revisions.push({ id, patch, key });
      if (s.reviseFails) throw new Error('boom');
      const base = s.pending.get(id)!;
      const replacement = { ...base, id: `${id}-r`, preview: 'revised' } as PendingAction;
      s.pending.set(replacement.id, replacement);
      return { predecessor: base, replacement, diff: ['title'] };
    },
    listPending: async (actor, conversationId) => [...s.pending.values()].filter(p => p.actorId === actor.id && p.conversationId === conversationId),
    getDashboard: async (_actor, id) => s.dashboards.get(id),
    renameDashboard: async (_actor, id, input) => { s.calls.push(`rename:${id}`); const d = s.dashboards.get(id)!; s.dashboards.set(id, { ...d, title: input.title }); return { id, title: input.title }; },
    deleteDashboard: async (_actor, id) => { s.calls.push(`delete:${id}`); s.dashboards.set(id, { ...s.dashboards.get(id)!, deleted: true }); return { dashboardId: id, deletedAt: 'x' }; },
    recipientAllowed: async (_actor, id) => s.allowedRecipients.has(id),
    branchesAllowed: async () => s.branchesOk,
    audit: async (_actor, e) => { s.audits.push(e.kind); },
    staged: {
      findPending: async (actor, conv, key) => [...s.staged.values()].find(p => p.actorId === actor.id && p.conversationId === conv && p.digest === key && p.status === 'pending'),
      create: async (actor, ref, input) => { const p: StagedProposal = { id: `ST-${++seq}`, actorId: actor.id, conversationId: ref.conversationId, status: 'pending', ...input }; s.staged.set(p.id, p); return p; },
      get: async (_actor, id) => s.staged.get(id),
      claim: async (_actor, id) => { const p = s.staged.get(id); if (!p || p.status !== 'pending') return undefined; const c = { ...p, status: 'claimed' as const }; s.staged.set(id, c); return c; },
      save: async (_actor, id, patch) => { const p = { ...s.staged.get(id)!, status: patch.status, ...(patch.data ? { data: patch.data } : {}) }; s.staged.set(id, p); return p; },
    },
    effects: {
      communication: async () => ({ context: w4.context, consent: w4.communication.consent, contentClaimIds: ['sales_claim'], inbox: [] }),
      monitor: async () => ({ context: w4.context, query: w4.monitor.queryPlan, consent: w4.monitor.consent, contentClaimIds: ['sales_claim'] }),
      commitInbox: async (_a, inbox) => { s.inbox.push(...inbox); },
      commitMonitor: async (_a, _id, st) => { s.monitors.push(st); },
    },
    ...overrides,
  };
  return { ports, state: s };
}
