import { z } from 'zod';
import type { Actor } from '../contracts';
import { idSchema, refSchema, type Ref } from '../dynamic/plan/schemas';
import { digest, freeze } from '../dynamic/shared';

export { idSchema, refSchema, digest };
export type { Ref };
export const ids = (max: number) => z.array(idSchema).min(1).max(max).refine(v => new Set(v).size === v.length);
export const refs = (max: number) => z.array(refSchema).min(1).max(max).refine(v => new Set(v.map(r => r.id)).size === v.length);
export const keySchema = z.string().min(16).max(100).regex(/^[A-Za-z0-9_-]+$/);
export function immutable<T>(value: T): T { return freeze(structuredClone(value)); }
export function sameRef(a: Ref, b: Ref): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest; }
export function snapshotRef(id: string, version: number, value: unknown): Ref { return { id, version, digest: digest(value) }; }

export interface Authority {
  actor: Pick<Actor, 'id' | 'role' | 'active' | 'permissions' | 'regions' | 'sessionId' | 'mode' | 'modeRevision'>;
  revision: number;
  /** Explicit server-resolved recipient policy; region access alone never grants delivery. */
  recipientIds: readonly string[];
}
export interface ScopedSnapshot { ref: Ref; regions: readonly string[]; permissions: readonly string[] }
export interface Recipient extends ScopedSnapshot { name: string; active: boolean }
export interface EvidenceSnapshot extends ScopedSnapshot {
  fresh: boolean; complete: boolean; trust: 'certified' | 'verified_physical' | 'inferred' | 'unknown';
  sensitive: boolean; expiresAt: number; sourceIds: readonly string[];
  observedAt?: number;
  sales?: readonly { branchId: string; netSales: number; target: number }[];
}
/** Text is rendered by a trusted ClaimGraph adapter, never supplied by the AI plan. */
export type ClaimUse = 'share' | 'communication' | 'badge_reason' | 'monitor';
export interface ContentClaim extends ScopedSnapshot {
  text: string; evidence: Ref; allowedUses: readonly ClaimUse[]; subjectIds: readonly string[];
}
export interface Consent {
  ref: Ref; actorId: string; channelId: string; recipientIds: readonly string[];
  contentClaimIds: readonly string[]; contentClaims: readonly Ref[]; expiresAt: number; granted: boolean;
}
export interface PlanContext {
  authority: Authority; now: number; evidence: readonly EvidenceSnapshot[];
  claims: readonly ContentClaim[]; recipients: readonly Recipient[]; consents: readonly Consent[];
}
export type Outcome = 'accepted' | 'clarification_required' | 'unsupported_concept' | 'permission_denied' |
  'incomplete_evidence' | 'execution_failed';
export type Result<T> = { outcome: 'accepted'; value: T } | { outcome: Exclude<Outcome, 'accepted'>; code: string; safeDetail: string };
export class PlanFault extends Error {
  constructor(readonly outcome: Exclude<Outcome, 'accepted'>, readonly code: string) { super(code); }
}
export function requirePlan(test: unknown, outcome: PlanFault['outcome'], code: string): asserts test {
  if (!test) throw new PlanFault(outcome, code);
}
export function attempt<T>(run: () => T): Result<T> {
  try { return { outcome: 'accepted', value: immutable(run()) }; }
  catch (error) {
    if (!(error instanceof PlanFault || error instanceof z.ZodError)) throw error;
    return { outcome: error instanceof PlanFault ? error.outcome : 'clarification_required',
      code: error instanceof PlanFault ? error.code : 'invalid_schema', safeDetail: 'The plan cannot be used with current authorization, evidence, or lifecycle state.' };
  }
}
export function authorize(context: PlanContext, snapshot: Pick<ScopedSnapshot, 'regions' | 'permissions'>): void {
  const a = context.authority.actor;
  requirePlan(Number.isSafeInteger(context.now) && context.now >= 0, 'clarification_required', 'invalid_clock');
  requirePlan(a.active && snapshot.permissions.every(p => a.permissions.includes(p)) && snapshot.regions.length > 0 &&
    snapshot.regions.every(r => a.regions.includes('*') || a.regions.includes(r)), 'permission_denied', 'scope_or_permission');
}
export function evidenceFor(context: PlanContext, ref: Ref): EvidenceSnapshot {
  const evidence = context.evidence.find(e => sameRef(e.ref, ref));
  requirePlan(evidence, 'incomplete_evidence', 'evidence_missing');
  authorize(context, evidence);
  requirePlan(evidence.fresh && evidence.complete && evidence.expiresAt > context.now && evidence.sourceIds.length > 0 &&
    !evidence.sensitive && evidence.trust === 'certified', 'incomplete_evidence', 'evidence_unusable');
  return evidence;
}
export function contentFor(context: PlanContext, claimIds: readonly string[], use: ClaimUse): { text: string; claims: ContentClaim[]; evidence: Ref[] } {
  const claims = claimIds.map(id => {
    const claim = context.claims.find(c => c.ref.id === id);
    requirePlan(claim, 'incomplete_evidence', 'claim_missing');
    requirePlan(claim.allowedUses.includes(use), 'permission_denied', 'claim_use_denied');
    authorize(context, claim);
    const evidence = evidenceFor(context, claim.evidence);
    requirePlan(claim.regions.every(r => evidence.regions.includes(r)) && evidence.permissions.every(p => claim.permissions.includes(p)),
      'incomplete_evidence', 'claim_scope_or_permissions');
    return claim;
  });
  const text = claims.map(c => c.text).join('\n');
  requirePlan(text.length > 0 && text.length <= 4000, 'clarification_required', 'content_budget');
  return { text, claims, evidence: [...new Map(claims.map(c => [c.evidence.id, c.evidence])).values()] };
}
export function recipientsFor(context: PlanContext, recipientIds: readonly string[], scope: readonly string[], permissions: readonly string[]): Recipient[] {
  return recipientIds.map(id => {
    const recipient = context.recipients.find(r => r.ref.id === id);
    requirePlan(recipient && recipient.active && context.authority.recipientIds.includes(id), 'permission_denied', 'recipient_denied');
    authorize(context, { regions: recipient.regions, permissions: [] });
    requirePlan(scope.every(r => recipient.regions.includes('*') || recipient.regions.includes(r)) &&
      permissions.every(p => recipient.permissions.includes(p)), 'permission_denied', 'recipient_scope');
    return recipient;
  });
}
export function consentFor(context: PlanContext, ref: Ref, channelId: string, recipientIds: readonly string[], claimRefs: readonly Ref[]): Consent {
  const consent = context.consents.find(c => sameRef(c.ref, ref));
  requirePlan(consent && consent.granted && consent.actorId === context.authority.actor.id && consent.channelId === channelId &&
    consent.expiresAt > context.now && digest([...consent.recipientIds].sort()) === digest([...recipientIds].sort()) &&
    digest([...consent.contentClaimIds].sort()) === digest(claimRefs.map(r => r.id).sort()) &&
    consent.contentClaims.length === claimRefs.length && claimRefs.every(r => consent.contentClaims.some(c => sameRef(c, r))),
    'permission_denied', 'consent_denied');
  return consent;
}

export interface Intent { targets: readonly Ref[]; content: string; binding: unknown }
export interface Preview<P> {
  version: 1; plan: P; planDigest: string; actorId: string; sessionId: string; authorityDigest: string;
  registryDigest: string; intent: Intent; expiresAt: number; digest: string;
}
export interface Workflow<P> {
  version: number; status: 'previewed' | 'confirmed' | 'executed' | 'verified' | 'failed'; preview: Preview<P>;
  receipt: null | { operationKey: string; planDigest: string; targets: readonly Ref[]; content: string;
    status: 'pending' | 'verified_success' | 'failed'; verifiedAt: number | null };
  audit: readonly { phase: string; at: number; previewDigest: string }[];
}
export type Request<P> = { phase: 'preview'; plan: unknown } |
  { phase: 'confirm' | 'execute' | 'verify'; workflow: Workflow<P>; expectedVersion: number; previewDigest: string };
export interface EffectRecord { operationKey: string; planDigest: string; target: Ref; content: string; kind: string; resource?: Ref }
export const workflowAuditLimit = 64;
export function exactRecords(records: readonly EffectRecord[], preview: Preview<unknown>, kind: string, resource?: Ref): boolean {
  return records.length === preview.intent.targets.length && new Set(records.map(r => r.target.id)).size === records.length &&
    preview.intent.targets.every(t => records.some(r => sameRef(t, r.target) && r.planDigest === preview.planDigest &&
      r.content === preview.intent.content && r.kind === kind &&
      (resource ? !!r.resource && sameRef(resource, r.resource) : r.resource === undefined)));
}
export function operationKey<P>(preview: Preview<P>, key: string): string {
  return digest({ actorId: preview.actorId, sessionId: preview.sessionId, key });
}

/** All inputs other than preview.plan must come from server-owned durable state, never request JSON. */
export function transition<P>(request: Request<P>, context: PlanContext, registry: unknown,
  validate: (plan: unknown, verifying: boolean) => { plan: P; intent: Intent }, key: (plan: P) => string,
  execute: (preview: Preview<P>, operationKey: string) => void, verify: (preview: Preview<P>, operationKey: string) => boolean,
  pendingActionExpiresAt?: number): Workflow<P> {
  const registryDigest = digest(registry), authorityDigest = digest(context.authority);
  if (request.phase === 'preview') {
    const { plan, intent } = validate(request.plan, false);
    const body = { version: 1 as const, plan, planDigest: digest(plan), actorId: context.authority.actor.id,
      sessionId: context.authority.actor.sessionId, authorityDigest, registryDigest, intent,
      expiresAt: Math.min(context.now + 600_000, pendingActionExpiresAt ?? Number.POSITIVE_INFINITY) };
    const preview = { ...body, digest: digest(body) };
    return { version: 1, status: 'previewed', preview, receipt: null, audit: [{ phase: 'preview', at: context.now, previewDigest: preview.digest }] };
  }
  const old = request.workflow, p = old.preview;
  const { digest: approvedDigest, ...body } = p;
  requirePlan(request.expectedVersion === old.version, 'execution_failed', 'cas_conflict');
  requirePlan(request.previewDigest === approvedDigest && digest(body) === approvedDigest && digest(p.plan) === p.planDigest,
    'execution_failed', 'preview_mismatch');
  requirePlan((request.phase === 'verify' || (p.actorId === context.authority.actor.id && p.sessionId === context.authority.actor.sessionId)) &&
    (request.phase === 'verify' || p.authorityDigest === authorityDigest) && p.registryDigest === registryDigest,
    'permission_denied', 'authorization_changed');
  if (request.phase === 'execute' && (old.status === 'executed' || old.status === 'verified')) return old;
  requirePlan(request.phase === 'verify' || context.now < p.expiresAt, 'execution_failed', 'preview_expired');
  const { intent } = request.phase === 'verify' ? { intent: p.intent } :
    validate(p.plan, request.phase === 'execute' && old.status !== 'confirmed');
  requirePlan(digest(intent) === digest(p.intent), 'execution_failed', 'target_or_content_changed');
  const op = operationKey(p, key(p.plan));
  let status: Workflow<P>['status'];
  let receipt = old.receipt;
  if (request.phase === 'confirm') {
    requirePlan(old.status === 'previewed', 'execution_failed', 'confirmation_required');
    status = 'confirmed';
  } else if (request.phase === 'execute') {
    requirePlan(old.status === 'confirmed' || old.status === 'executed' || old.status === 'verified', 'execution_failed', 'confirmation_required');
    if (old.status === 'executed' || old.status === 'verified') return old;
    execute(p, op);
    status = 'executed';
    receipt = { operationKey: op, planDigest: p.planDigest, targets: p.intent.targets, content: p.intent.content, status: 'pending', verifiedAt: null };
  } else {
    requirePlan(old.status === 'executed' || old.status === 'verified' || old.status === 'failed', 'execution_failed', 'execution_required');
    const receiptMatches = !!receipt && receipt.operationKey === op && receipt.planDigest === p.planDigest &&
      digest(receipt.targets) === digest(p.intent.targets) && receipt.content === p.intent.content;
    const success = receiptMatches && verify(p, op);
    if ((old.status === 'verified' && success) || (old.status === 'failed' && !success)) return old;
    status = success ? 'verified' : 'failed';
    receipt = { operationKey: receiptMatches ? receipt!.operationKey : op,
      planDigest: receiptMatches ? receipt!.planDigest : p.planDigest,
      targets: receiptMatches ? receipt!.targets : p.intent.targets,
      content: receiptMatches ? receipt!.content : p.intent.content,
      status: success ? 'verified_success' : 'failed', verifiedAt: success ? context.now : null };
  }
  return { ...old, version: old.version + 1, status, receipt,
    audit: [...old.audit, { phase: request.phase, at: context.now, previewDigest: approvedDigest }].slice(-workflowAuditLimit) };
}
