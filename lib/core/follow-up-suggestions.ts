import { z } from 'zod';
import type { Actor, Branch, ConversationMessage, FollowUpSuggestion, FollowUpSuggestions, Scope, Store, Workspace } from '../contracts';
import { canRegion, reloadActor } from './auth';
import { DomainError } from './errors';
import { getOwnedConversation } from './conversations';
import { ConciergeService } from './service';
import { readCompletedTurn } from './turn-completion-gate';
import { digest } from './utils';
import { evidenceSchema } from '../packs/shared';
import { retailEvidenceCoverage } from '../packs/retail/coverage';
import { readEvidence } from '../packs/retail/evidence';
import { StorageReadUnavailableError } from '../storage/read-error';

const responseSchema = z.object({
  status: z.enum(['ready', 'none', 'data_unavailable']),
  conversationId: z.string().min(1).max(128),
  afterMessageId: z.string().min(1).max(128),
  items: z.array(z.object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(180),
    prompt: z.string().min(1).max(1_200),
    consequence: z.enum(['read', 'analyze']),
  }).strict()).max(3),
}).strict();

const retailReadTools = ['sales.query_metrics', 'operations.query_inventory', 'incidents.search', 'staffing.get_summary'];
const salesSuggestionIds = ['retail.sales-analysis', 'retail.sales-below-target', 'retail.sales-achievement'];
const identifierText = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const salesSuggestionIntents = [
  { id: 'retail.sales-analysis', label: 'ภาพรวมยอดขาย', prompt: 'ช่วยวิเคราะห์ภาพรวมยอดขายและเป้าหมาย' },
  { id: 'retail.sales-below-target', label: 'ยอดขายเทียบเป้าหมาย', prompt: 'ช่วยวิเคราะห์ส่วนต่างระหว่างยอดขายกับเป้าหมาย' },
  { id: 'retail.sales-achievement', label: 'สัดส่วนยอดขายเทียบเป้าหมาย', prompt: 'ช่วยคำนวณสัดส่วนยอดขายรวมเทียบกับเป้าหมายรวม' },
] as const;
type SalesSuggestionIntent = typeof salesSuggestionIntents[number];

function knownReadUnavailable(error: unknown): boolean {
  return error instanceof StorageReadUnavailableError ||
    (error instanceof DomainError && error.status === 503 && error.code === 'SOURCE_UNAVAILABLE');
}

function result(status: FollowUpSuggestions['status'], conversationId: string, afterMessageId: string,
  items: FollowUpSuggestion[] = []): FollowUpSuggestions {
  return responseSchema.parse({ status, conversationId, afterMessageId, items });
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.region === right.region && left.date === right.date &&
    JSON.stringify([...(left.branchIds ?? [])].sort()) === JSON.stringify([...(right.branchIds ?? [])].sort());
}

function sameAuthority(left: Actor, right: Actor): boolean {
  return left.id === right.id && left.sessionId === right.sessionId && left.active === right.active &&
    left.role === right.role && left.mode === right.mode && left.modeRevision === right.modeRevision &&
    JSON.stringify([...left.permissions].sort()) === JSON.stringify([...right.permissions].sort()) &&
    JSON.stringify([...left.regions].sort()) === JSON.stringify([...right.regions].sort());
}

function currentRetailCapability(workspace: Workspace): boolean {
  const tools = new Set(workspace.capabilities.filter(capability => capability.allowed).flatMap(capability => capability.tools));
  return retailReadTools.every(tool => tools.has(tool));
}

function exactCatalogIntents(workspace: Workspace): SalesSuggestionIntent[] {
  if (workspace.actionCatalogStatus === 'data_unavailable' || !currentRetailCapability(workspace)) return [];
  const entries = workspace.actionCatalog ?? [];
  const allowedIds = new Set(salesSuggestionIds.filter(id => {
    const entry = entries.find(candidate => candidate.id === id && candidate.section === 'ask_analyze' &&
      candidate.consequence === 'analyze' && candidate.actionKind === undefined);
    return !!entry;
  }));
  return salesSuggestionIntents.filter(intent => allowedIds.has(intent.id));
}

function scopedBranchIds(scope: Scope, evidenceBranches: Array<{ branchId: string }>): string[] | undefined {
  const ids = scope.branchIds ?? evidenceBranches.map(branch => branch.branchId);
  if (!ids.length || ids.length > 12 || ids.some(id => !identifierText.test(id)) || new Set(ids).size !== ids.length) return;
  return [...ids].sort();
}

async function evidenceSuggestions(store: Store, actor: Actor, workspace: Workspace,
  evidenceValue: unknown): Promise<FollowUpSuggestion[] | undefined> {
  const parsed = evidenceSchema.safeParse(evidenceValue);
  if (!parsed.success || !parsed.data.branches.length) return;
  const scope = parsed.data.scope;
  const intents = exactCatalogIntents(workspace);
  if (!intents.length) return [];

  let currentEvidence;
  try {
    currentEvidence = await readEvidence(store, actor, scope, new Date());
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) return [];
    if (knownReadUnavailable(error)) throw error;
    return [];
  }
  if (!sameScope(currentEvidence.scope, scope) || !currentEvidence.branches.length) return [];
  const branchIds = scopedBranchIds(scope, currentEvidence.branches);
  if (!branchIds) return [];

  const branches = await store.list<Branch>('branches');
  const allowedIds = new Set(branches.filter(branch => canRegion(actor, branch.region)).map(branch => branch.id));
  if (branchIds.some(id => !allowedIds.has(id))) return [];

  const coverage = retailEvidenceCoverage(currentEvidence);
  if (!coverage.salesComplete || !coverage.targetComplete) return [];
  const refreshedScope = currentEvidence.scope;
  const scopeClause = `วันที่ ${refreshedScope.date} สำหรับสาขา ${branchIds.join(', ')}`;
  return intents.slice(0, 3).map(intent => ({
    id: `${intent.id}:${digest({ scope: refreshedScope, branchIds }).slice(0, 12)}`,
    label: `${intent.label} · ${refreshedScope.date} · ${branchIds.length} สาขา`,
    prompt: `${intent.prompt} ${scopeClause}`,
    consequence: 'analyze' as const,
  }));
}

function currentAnchor(workspace: Workspace, actor: Actor, conversationId: string, afterMessageId: string): ConversationMessage | undefined {
  const messages = workspace.messages.filter(message => message.actorId === actor.id && message.conversationId === conversationId);
  if (!messages.length || messages.some(message => !Number.isFinite(Date.parse(message.createdAt)))) return;
  const anchor = messages.find(message => message.id === afterMessageId);
  if (!anchor || anchor.role !== 'assistant') return;
  const anchorTime = Date.parse(anchor.createdAt);
  const hasLaterContext = messages.some(message => {
    if (message.id === anchor.id) return false;
    const messageTime = Date.parse(message.createdAt);
    if (messageTime > anchorTime) return true;
    return messageTime === anchorTime && !(message.role === 'user' && message.turnId === anchor.turnId);
  });
  return hasLaterContext ? undefined : anchor;
}

/** Recomputes read-only suggestions from a currently authorized, exact completed V1 answer. */
export async function getFollowUpSuggestions(store: Store, actor: Actor, conversationId: string,
  afterMessageId: string): Promise<FollowUpSuggestions> {
  const base = result('none', conversationId, afterMessageId);
  try {
    await getOwnedConversation(store, actor.id, conversationId);
  } catch (error) {
    if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
    throw error;
  }
  let workspace: Workspace;
  try {
    workspace = await new ConciergeService(store).getWorkspace(await reloadActor(store, actor));
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) return base;
    if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
    throw error;
  }
  const current = workspace.actor;
  let conversation;
  try {
    conversation = await getOwnedConversation(store, current.id, conversationId);
  } catch (error) {
    if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
    throw error;
  }
  if (conversation.archivedAt) return base;
  try {
    if (!sameAuthority(current, await reloadActor(store, current))) return result('data_unavailable', conversationId, afterMessageId);
  } catch (error) {
    if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
    throw error;
  }

  const safeAnchor = currentAnchor(workspace, current, conversationId, afterMessageId);
  if (!safeAnchor) return base;
  if (!safeAnchor.turnId || !safeAnchor.sessionId) return result('data_unavailable', conversationId, afterMessageId);
  if (safeAnchor.sessionId !== current.sessionId || safeAnchor.mode !== current.mode || safeAnchor.modeRevision !== current.modeRevision) return base;
  let proof;
  try {
    proof = await readCompletedTurn(store, {
      actorId: safeAnchor.actorId,
      sessionId: safeAnchor.sessionId,
      conversationId: safeAnchor.conversationId,
      turnId: safeAnchor.turnId,
      mode: safeAnchor.mode,
      modeRevision: safeAnchor.modeRevision,
    });
  } catch (error) {
    if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
    throw error;
  }
  if (proof.kind !== 'completed') return result('data_unavailable', conversationId, afterMessageId);
  if (proof.record.origin !== 'chat' || proof.assistant.id !== safeAnchor.id || proof.assistant.text !== safeAnchor.text) return base;

  if (workspace.actionCatalogStatus === 'data_unavailable') return result('data_unavailable', conversationId, afterMessageId);
  // AI-proposed follow-ups were output-safety validated when the turn was saved (plain text, no data); they take priority.
  const proposed = (safeAnchor.followUps ?? []).slice(0, 3);
  if (proposed.length) {
    return result('ready', conversationId, afterMessageId, proposed.map(text => ({
      id: `ai:${digest(text).slice(0, 12)}`, label: text, prompt: text, consequence: 'analyze' as const })));
  }
  if (safeAnchor.evidence !== undefined) {
    try {
      const items = await evidenceSuggestions(store, current, workspace, proof.assistant.evidence);
      if (items === undefined) return result('data_unavailable', conversationId, afterMessageId);
      if (items.length) {
        if (!sameAuthority(current, await reloadActor(store, current))) return result('data_unavailable', conversationId, afterMessageId);
        return result('ready', conversationId, afterMessageId, items);
      }
    } catch (error) {
      if (knownReadUnavailable(error)) return result('data_unavailable', conversationId, afterMessageId);
      throw error;
    }
  }

  return base;
}
