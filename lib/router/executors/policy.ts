import 'server-only';

import type { Actor, Analysis, PolicyDocument, SourceRef, Store } from '../../contracts';
import { reloadActor } from '../../core/auth';
import { assertFinalTextSize } from '../../ai/loop-core';
import { canReadPolicy, policyPermissionOf, policySourceId } from '../../dynamic/catalog/policy';
import type { TurnStep } from '../turn-plan';

export interface PolicyExecutorInput { store: Store; actor: Actor; now: () => Date; step: Extract<TurnStep, { kind: 'policy_read' }> }
export type PolicyExecutorResult =
  | { outcome: 'accepted'; kind: 'policy_read'; text: string; sources: SourceRef[]; analysis: Analysis; requiredPermissions: string[] }
  | { outcome: 'denied'; kind: 'policy_read'; code: string; text: string };

const EXCERPT_CHARS = 1200;
const UNAVAILABLE = 'ไม่พบเอกสาร Policy ที่บัญชีนี้มีสิทธิ์อ่าน จึงยังไม่ได้แสดงเนื้อหา';

/** Policy documents the actor may read under CURRENT permissions (what the planner may cite by id). */
export async function listReadablePolicies(reader: Pick<Store, 'list'>, permissions: readonly string[]): Promise<{ id: string; title: string; version: string }[]> {
  return (await reader.list<PolicyDocument>('policy_documents')).filter(doc => canReadPolicy(permissions, doc.id))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20).map(doc => ({ id: doc.id, title: doc.title, version: doc.version }));
}

/**
 * Authorized policy read: the planner picks document ids from the authorized list; the server re-checks the permission against the
 * reloaded actor and returns the registered text with its version and a citable Source. Missing and forbidden documents are
 * indistinguishable. Acknowledging a policy is NOT part of this read (it is a separate confirmed action, not offered here).
 */
export async function executePolicyReadStep(input: PolicyExecutorInput): Promise<PolicyExecutorResult> {
  const actor = await reloadActor(input.store, input.actor, input.now());
  const retrievedAt = input.now().toISOString();
  const sections: string[] = [], sources: SourceRef[] = [], facts: Analysis['facts'] = [], permissions: string[] = [];
  for (const policyId of [...new Set(input.step.policyIds)]) {
    const doc = await input.store.get<PolicyDocument>('policy_documents', policyId);
    if (!doc || !actor.active || !canReadPolicy(actor.permissions, doc.id)) return { outcome: 'denied', kind: 'policy_read', code: 'policy_unavailable', text: UNAVAILABLE };
    const sourceId = policySourceId(doc.id, doc.version);
    // The registered text may open with a synthetic provenance sentence ("Source metadata: …"); it is not policy content and never shown in prose.
    const chars = [...doc.text.replace(/^Source metadata:.*?\.\s+/u, '')];
    const excerpt = chars.slice(0, EXCERPT_CHARS).join('') + (chars.length > EXCERPT_CHARS ? '…' : '');
    // Source ids stay in the sources panel / citations (sources + analysis), never in the prose.
    sections.push(`Policy “${doc.title}” เวอร์ชัน ${doc.version} (อัปเดต ${doc.updatedAt.slice(0, 10)})\nเนื้อหาเอกสาร: ${excerpt}`);
    sources.push({ id: sourceId, system: 'policy', observedAt: doc.updatedAt, retrievedAt: retrievedAt < doc.updatedAt ? doc.updatedAt : retrievedAt, freshness: 'fresh', detail: `${doc.title} v${doc.version}` });
    facts.push({ text: `${doc.title} เวอร์ชัน ${doc.version}`, sourceIds: [sourceId] });
    permissions.push(policyPermissionOf(doc.id)!);
  }
  const text = sections.join('\n\n');
  assertFinalTextSize(text);
  return { outcome: 'accepted', kind: 'policy_read', text, sources,
    analysis: { facts, relationships: [], hypotheses: [], missingEvidence: [], generatedAt: retrievedAt, evidenceVersion: sources.map(s => s.id).join('|') },
    requiredPermissions: [...new Set(permissions)] };
}
