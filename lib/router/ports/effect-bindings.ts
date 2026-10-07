import type { Actor, Branch, Profile, Reader, Store, Transaction } from '../../contracts';
import { DomainError } from '../../core/errors';
import { createSemanticCatalog, type SemanticDatasetCatalog } from '../../dynamic/catalog/semantic';
import type { EvidenceBundle } from '../../dynamic/evidence/bundle';
import type { ClaimGraph, NumericClaim } from '../../dynamic/evidence/claim-graph';
import { authority as queryAuthority, renderNumericClaim } from '../../dynamic/runtime';
import { conversationStateRef } from '../../dynamic/planner/planner';
import { conversationStateSchema, type ConversationState } from '../../dynamic/state/conversation';
import {
  digest, snapshotRef, type ContentClaim, type EvidenceSnapshot, type PlanContext, type Ref,
} from '../../effects/shared';
import type { MonitorContext, MonitorQuery, MonitorState } from '../../monitors';
import type { CommunicationBinding, EffectBindings, MonitorBinding } from '../executors/action-ports';
import { authoritySnapshot, consentSnapshot, effectPermissions, recipientSnapshot } from './effect-snapshots';
import { personLabel } from '../context/display';
import { createMonitorRunner } from './monitor-runner';
import { renameMonitor } from '../../monitors/direct';
import { createArtifactShareEffects } from './artifact-share';
import { createWorkItemEffects } from './work-items';
import { createPolicyAckEffects } from './policy-ack';
import { contentFromTableEvidence, isTableEvidence, loadAcceptedTableEvidence, type TableAcceptedEvidence } from './table-evidence';
import { commitInboxRecords, getMonitor, installMonitor, monitorRowId, monitorTitle, sentInboxRecords, MONITOR_NAME,
  MONITOR_STATUS_BY_LIFECYCLE, type MonitorBound, type MonitorRow } from './effect-store';

/**
 * Server-owned snapshot loaders + commits for communication.send and monitor.create (Wave 4 -> live).
 *
 * Everything here is derived from accepted, server-persisted query evidence (`tool_executions` retail.dynamic_query rows);
 * the AI plan only names ids from the planner context. Content text is the trusted `renderNumericClaim` rendering of
 * evidenced numeric claims, so no number can enter a message that is not in an evidence bundle.
 *
 * Consent: the Wave 4 modules require a consent snapshot bound to actor, channel, exact recipients and exact claim refs.
 * Here the consent IS the user's explicit confirmation of the exact preview (the proposal is only executable through
 * confirmProposal's CAS claim). The snapshot is deterministic over (actor, recipients, claims), never over the clock,
 * so the digest the user approved is the digest that executes. It expires with the evidence it is bound to.
 */
export const COMMUNICATION_EVIDENCE_TTL_MS = 24 * 3_600_000;
export const MONITOR_LIFETIME_MS = 7 * 24 * 3_600_000;
const MAX_CLAIMS = 32, MAX_TEXT = 4000, MAX_BRANCHES = 1000;

// ------------------------------------------------------------------------------------------- accepted state -> content

export interface AcceptedEvidence { state: ConversationState; bundle: EvidenceBundle; graph: ClaimGraph; catalog: SemanticDatasetCatalog; datasetPermissions: string[] }

/** Re-load one of THIS actor's accepted retail states and re-check it against the current authority and catalog. */
export async function loadAcceptedEvidence(store: Store, actor: Actor, stateId: string): Promise<AcceptedEvidence | undefined> {
  const catalog = createSemanticCatalog(await store.list<Branch>('branches'));
  const permitted = new Set(catalog.branches.filter(b => actor.regions.includes('*') || actor.regions.includes(b.region)).map(b => b.id));
  const currentAuthority = digest(queryAuthority(actor));
  const records = (await store.list<{ name: string; actorId: string; sessionId: string; state: unknown; bundle: EvidenceBundle; claims: ClaimGraph }>('tool_executions',
    { actorId: actor.id, sessionId: actor.sessionId, status: 'completed' })).filter(r => r.name === 'retail.dynamic_query' && r.actorId === actor.id);
  for (const record of records) {
    const parsed = conversationStateSchema.safeParse(record.state);
    if (!parsed.success || conversationStateRef(parsed.data).id !== stateId) continue;
    const state = parsed.data;
    const { bundle, claims: graph } = record;
    if (!bundle?.ref || !graph?.claims) return undefined;
    const { ref, ...payload } = bundle;
    if (digest(payload) !== ref.digest || ref.digest !== state.evidenceBundle.digest || `claims:${graph.digest}` !== state.claimGraph.id ||
      graph.evidence.digest !== ref.digest) return undefined;
    if (state.conversationId.length === 0 || state.authoritySnapshot.id !== actor.id || state.authoritySnapshot.digest !== currentAuthority ||
      state.catalogSnapshot.digest !== catalog.digest || state.resolvedScope.branchIds.some(id => !permitted.has(id))) return undefined;
    const dataset = catalog.datasets.find(d => d.id === state.dataset.id);
    if (!dataset) return undefined;
    return { state, bundle, graph, catalog, datasetPermissions: [...dataset.requiredPermissions] };
  }
  return undefined;
}

/**
 * Evidenced numeric claims -> trusted ContentClaim snapshots. Difference claims are skipped (their wording needs a comparison
 * context the claim graph alone does not carry); null-valued claims never become text. Bounded to 32 claims / 4000 chars.
 */
export function contentFromEvidence(found: AcceptedEvidence, uses: ContentClaim['allowedUses'], evidenceExpiresAt: number): { claims: ContentClaim[]; evidence: EvidenceSnapshot } | undefined {
  const { bundle, graph, catalog, datasetPermissions } = found;
  const fresh = bundle.sources.length > 0 && bundle.sources.every(s => s.freshness === 'fresh');
  const readAt = Date.parse(bundle.provenance.readAt);
  const evidence: EvidenceSnapshot = { ref: bundle.ref, regions: [...bundle.scope.regions], permissions: datasetPermissions, fresh, complete: bundle.coverage.complete,
    trust: 'certified', sensitive: false, expiresAt: evidenceExpiresAt, sourceIds: bundle.sources.map(s => s.id),
    ...(Number.isFinite(readAt) ? { observedAt: readAt } : {}) };
  const rows = new Map(bundle.rows.map(r => [r.rowId, r]));
  const claims: ContentClaim[] = [];
  let length = 0;
  for (const claim of graph.claims as readonly NumericClaim[]) {
    if (claims.length >= MAX_CLAIMS) break;
    if (claim.value === null || claim.dimensions.comparison === 'difference') continue;
    const claimRows = claim.rowRefs.map(id => rows.get(id));
    if (claimRows.some(r => !r)) return undefined;
    const text = renderNumericClaim(claim, catalog);
    if (!text || length + text.length + 1 > MAX_TEXT) break;
    length += text.length + 1;
    claims.push({ ref: snapshotRef(`claim:${digest({ graph: graph.digest, claim: claim.id }).slice(0, 24)}`, 1, { graph: graph.digest, claim }),
      regions: [...new Set(claimRows.map(r => r!.region))].sort(), permissions: datasetPermissions, text, evidence: bundle.ref,
      allowedUses: uses, subjectIds: [...new Set(claimRows.map(r => r!.branchId))].sort() });
  }
  return claims.length ? { claims, evidence } : undefined;
}

async function recipientProfiles(store: Store, ids: readonly string[]): Promise<Profile[] | undefined> {
  const out: Profile[] = [];
  for (const id of ids) {
    const profile = await store.get<Profile>('profiles', id);
    if (!profile || profile.id !== id) return undefined;
    out.push(profile);
  }
  return out;
}

export interface EffectBindingDeps {
  store: Store; now: () => Date;
  /** Business date the monitor scheduler reads fresh evidence for (the service's businessDate). */
  businessDate: string;
  /** Same server recipient policy the action ports use. `reader` = the transaction an in-transaction re-check runs in (defaults to the store). */
  recipientAllowed: (actor: Actor, recipientId: string, reader?: Reader) => Promise<boolean>;
}

export function createEffectBindings(deps: EffectBindingDeps): EffectBindings {
  const { store } = deps;
  const runner = createMonitorRunner({ store, now: deps.now, businessDate: deps.businessDate, recipientAllowed: deps.recipientAllowed });

  async function authorizedRecipients(actor: Actor, ids: readonly string[]): Promise<{ allowed: string[]; profiles: Profile[] } | undefined> {
    const allowed: string[] = [];
    for (const id of ids) if (await deps.recipientAllowed(actor, id)) allowed.push(id);
    const profiles = await recipientProfiles(store, ids);
    return profiles ? { allowed, profiles } : undefined;
  }

  const bindCommunication = async (actor: Actor, input: { recipientIds: string[]; contentStateId: string; inTurn?: AcceptedEvidence | TableAcceptedEvidence }): Promise<CommunicationBinding | undefined> => {
    // `inTurn` = the accepted answer of an earlier step of THIS turn (not yet persisted); everything else is loaded from the ledger
    // (a branch-evidence state, or an accepted answer over a registered table dataset).
    const found = input.inTurn ?? await loadAcceptedEvidence(store, actor, input.contentStateId) ?? await loadAcceptedTableEvidence(store, actor, input.contentStateId);
    if (!found) return undefined;
    const readAt = Date.parse(isTableEvidence(found) ? found.bundle.createdAt : found.bundle.provenance.readAt);
    if (!Number.isFinite(readAt)) return undefined;
    const content = isTableEvidence(found) ? contentFromTableEvidence(found, ['communication', 'monitor'], readAt + COMMUNICATION_EVIDENCE_TTL_MS)
      : contentFromEvidence(found, ['communication', 'monitor'], readAt + COMMUNICATION_EVIDENCE_TTL_MS);
    const who = await authorizedRecipients(actor, input.recipientIds);
    if (!content || !who) return undefined;
    const consent = consentSnapshot(actor.id, input.recipientIds, content.claims, content.evidence.expiresAt);
    const context: PlanContext = { authority: authoritySnapshot(actor, who.allowed), now: deps.now().getTime(), evidence: [content.evidence],
      claims: content.claims, recipients: who.profiles.map(recipientSnapshot), consents: [consent] };
    return { context, consent: consent.ref, contentClaimIds: content.claims.map(c => c.ref.id), inbox: await sentInboxRecords(store, actor) };
  };

  const bindMonitor = async (actor: Actor, input: { queryStateId: string; recipientIds: string[]; inTurn?: AcceptedEvidence | TableAcceptedEvidence }): Promise<MonitorBinding & { bound: MonitorBound } | undefined> => {
    // The only registered monitor condition is sales below target: table datasets (stock, Incident, Ticket) have no registered threshold, so they never bind.
    const found = input.inTurn ?? await loadAcceptedEvidence(store, actor, input.queryStateId);
    if (!found || isTableEvidence(found) || found.state.dataset.id !== 'branch_performance') return undefined;
    const { state } = found;
    if (state.resolvedScope.branchIds.length > MAX_BRANCHES) return undefined;
    const readAt = Date.parse(found.bundle.provenance.readAt);
    if (!Number.isFinite(readAt)) return undefined;
    const content = contentFromEvidence(found, ['communication', 'monitor'], readAt + MONITOR_LIFETIME_MS);
    const who = await authorizedRecipients(actor, input.recipientIds);
    if (!content || !who) return undefined;
    const branchIds = [...state.resolvedScope.branchIds].sort(), regions = [...state.resolvedScope.regions].sort();
    const query: MonitorQuery = { ref: snapshotRef(`monitor_query:${digest({ regions, branchIds }).slice(0, 24)}`, 1, { datasetId: 'branch_performance', regions, branchIds }),
      datasetId: 'branch_performance', branchIds, regions, permissions: ['sales.read'] };
    const consent = consentSnapshot(actor.id, input.recipientIds, content.claims, readAt + MONITOR_LIFETIME_MS);
    const context: MonitorContext = { authority: authoritySnapshot(actor, who.allowed), now: deps.now().getTime(), evidence: [content.evidence],
      claims: content.claims, recipients: who.profiles.map(recipientSnapshot), consents: [consent], queries: [query] };
    return { context, query: query.ref, consent: consent.ref, contentClaimIds: content.claims.map(c => c.ref.id),
      bound: { query, claims: content.claims, evidence: [content.evidence], consent, dataset: { id: 'branch_performance', permissions: found.datasetPermissions } } };
  };

  return {
    workItems: createWorkItemEffects({ store, now: deps.now, recipientAllowed: deps.recipientAllowed }),
    artifactShare: createArtifactShareEffects({ store, now: deps.now, recipientAllowed: deps.recipientAllowed }),
    policyAck: createPolicyAckEffects({ store, now: deps.now }),
    acceptedEvidence: async (actor, stateId) => await loadAcceptedEvidence(store, actor, stateId) ?? await loadAcceptedTableEvidence(store, actor, stateId),
    communication: bindCommunication,
    async monitor(actor, input) {
      const bound = await bindMonitor(actor, input);
      if (!bound) return undefined;
      return { context: bound.context, query: bound.query, consent: bound.consent, contentClaimIds: bound.contentClaimIds };
    },
    manageMonitor: (actor, input, options) => runner.manage(actor, input, options),
    async renameMonitor(actor, input, options) {
      try { return { ok: true, text: (await renameMonitor(store, deps.now, actor, input.monitorId, { op: 'rename', title: input.title }, options)).text }; }
      catch (error) { if (error instanceof DomainError) return { ok: false, code: error.code.toLowerCase(), text: error.message }; throw error; }
    },
    listMonitors: actor => runner.list(actor),
    searchMonitors: (actor, opts) => runner.search(actor, opts),
    findMonitor: (actor, monitorId) => runner.find(actor, monitorId),
    async commitInbox(actor, inbox, expected) {
      const mine = inbox.filter(r => r.kind === 'simulated_inbox');
      // Authority is re-read INSIDE the transaction that writes the inbox rows: the sender and every recipient must still be
      // exactly what the preview was bound to (profile, permissions, scope). Any drift refuses the write.
      const guard = async (tx: Transaction) => {
        await expected?.fence?.(tx);
        const forbidden = (): never => { throw new DomainError('AUTHORITY_CHANGED', 'Sender or recipient authority changed before delivery', 403); };
        const profile = await tx.get<Profile>('profiles', actor.id);
        if (!profile || !profile.active || profile.id !== actor.id) return forbidden();
        const fresh: Actor = { ...profile, sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision };
        if (!effectPermissions(fresh.permissions).includes('communication.send')) return forbidden();
        if (expected?.authority && digest(authoritySnapshot(fresh, expected.authority.recipientIds).actor) !== digest(expected.authority.actor)) return forbidden();
        for (const id of new Set(mine.map(r => r.target.id))) {
          const recipient = await tx.get<Profile>('profiles', id);
          if (!recipient || !(await deps.recipientAllowed(fresh, id, tx))) return forbidden();
          const bound = expected?.recipients?.find(r => r.ref.id === id);
          if (bound && recipientSnapshot(recipient).ref.digest !== bound.ref.digest) return forbidden();
        }
      };
      const sender = personLabel(actor);
      await commitInboxRecords(store, actor, mine, { now: deps.now(), title: `ข้อความจาก ${sender}`, senderName: sender, guard, ...(expected?.boundArtifact ? { boundArtifact: expected.boundArtifact } : {}), ...(expected?.boundArtifact && expected.openArtifact ? { openArtifact: expected.openArtifact } : {}) });
    },
    async commitMonitor(actor, proposalId, state: MonitorState, fence) {
      const staged = await store.get<{ actorId: string; conversationId: string; actionId: string; data: { params?: { queryStateId?: string; recipientIds?: string[] } } }>('router_proposals', proposalId);
      if (!staged || staged.actorId !== actor.id || staged.actionId !== 'monitor.create') throw new Error('Monitor proposal not found');
      const params = staged.data.params;
      if (!params?.queryStateId || !Array.isArray(params.recipientIds)) throw new Error('Monitor proposal is incomplete');
      const bound = await bindMonitor(actor, { queryStateId: params.queryStateId, recipientIds: params.recipientIds.map(String) });
      if (!bound) throw new Error('Monitor evidence is no longer bound');
      if (state.workflow.status !== 'verified') throw new Error('Monitor installation was not verified');
      const plan = state.workflow.preview.plan;
      const now = deps.now();
      const row: MonitorRow = { id: monitorRowId(proposalId), name: MONITOR_NAME, status: MONITOR_STATUS_BY_LIFECYCLE[state.lifecycle], actorId: actor.id,
        sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision, conversationId: staged.conversationId, proposalId,
        title: monitorTitle(plan.threshold, bound.bound.query.branchIds.length), rowVersion: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: bound.bound.consent.expiresAt, state, bound: bound.bound, lastEvaluatedAt: null, lastError: null, lastAlertId: null };
      await installMonitor(store, row, fence);
      // Independent readback of the persisted installation.
      const back = await getMonitor(store, row.id);
      if (!back || back.actorId !== actor.id || back.state.workflow.status !== 'verified' || back.state.workflow.preview.digest !== state.workflow.preview.digest)
        throw new Error('Monitor installation could not be verified');
    },
  };
}

export type { Ref };
