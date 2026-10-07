import 'server-only';

import type { Actor, Analysis, Branch, SourceRef, Store } from '../../contracts';
import { reloadActor } from '../../core/auth';
import { invariant } from '../../core/errors';
import { AIRuntimeError } from '../../ai/errors';
import { assertFinalTextSize } from '../../ai/loop-core';
import {
  compileHrQuery, createWave2Catalog, executeHrRead, HR_NO_BADGE, validateHrQueryPlan, type HrEvidenceBundle, type Wave2Catalog, canonicalizeHrPlan,
} from '../../dynamic/catalog/hr';
import { resolveSpan } from '../../dynamic/plan/normalize';
import { displayBranchNames } from '../../presentation/branch-names';
import { regionLabel } from '../context/display';
import type { QueryPlan, Span } from '../../dynamic/plan/schemas';
import { createPresentationClaims, type PresentationClaim, type PresentationClaims } from '../../dynamic/response/claims';
import { composeResponse } from '../../dynamic/response/compose';
import { digest, unique } from '../../dynamic/shared';
import { exactConversationStateSchema, exactSourceTextRef, prepareExactConversationState } from '../../dynamic/state/exact';
import { rejected, type RejectedPlan } from '../../dynamic/validate/query-plan';
import type { TurnStep } from '../turn-plan';
import { hrCatalogAuthority, readHrSnapshot } from './hr-reader';
import {
  classifyRejection, isSafeQuestion, type ExecutorAccepted, type ExecutorChoice, type ExecutorClarify, type ExecutorDenied,
} from './shared';

export interface HrExecutorInput {
  store: Store; actor: Actor; message: string; diagnosticId: string; now: () => Date;
  step: Extract<TurnStep, { kind: 'hr_query' }>;
  conversationId?: string; signal?: AbortSignal;
  /**
   * Lets the AI author the clarification question when the employee reference is ambiguous. The returned text is
   * output-safety checked; otherwise a fixed Thai template is used. Choices always come from authorized data.
   */
  ask?: (context: { slot: 'employee'; choices: ExecutorChoice[] }) => Promise<string | null>;
  isSafeText?: (text: string) => boolean;
}
export type HrExecutorResult =
  | (ExecutorAccepted & { kind: 'hr_query'; bundle: HrEvidenceBundle; claims: PresentationClaims })
  | (ExecutorClarify & { kind: 'hr_query' })
  | (ExecutorDenied & { kind: 'hr_query' });

const MAX_CLARIFY_CHOICES = 8;
const HR_TOOL = 'hr.dynamic_query';
const HR_LABELS: Record<RejectedPlan['outcome'], string> = {
  clarification_required: 'ต้องการข้อมูลเพิ่ม: โปรดระบุพนักงานหรือขอบเขตที่ต้องการให้ชัดเจน',
  semantic_uncertainty: 'ต้องการข้อมูลเพิ่ม: ยังตีความคำถามเกี่ยวกับพนักงานได้ไม่แน่ชัด',
  unsupported_concept: 'ยังไม่รองรับข้อมูลที่ขอ ขณะนี้ค้นได้เฉพาะรหัส ชื่อ สาขา และสถานะพนักงาน รวมถึงรหัส ประเภท และสถานะบัตร หรือนับจำนวนพนักงานที่มีสถานะใช้งานในระบบ',
  data_unavailable: 'ไม่มีข้อมูลพนักงานที่ตรวจสอบได้สำหรับขอบเขตที่ขอ ระบบจึงไม่แสดงตัวเลข',
  permission_denied: 'ไม่มีสิทธิ์: ขอบเขตหรือข้อมูลที่ขออยู่นอกสิทธิ์ HR ปัจจุบันของคุณ',
  incomplete_evidence: 'หลักฐานไม่ครบ: ยังตรวจสอบรายชื่อพนักงานทั้งหมดในขอบเขตที่ขอไม่ได้',
  execution_failed: 'ไม่สามารถดำเนินการค้นหาข้อมูลพนักงานได้',
};

function hrRejectionText(result: RejectedPlan): string {
  const choices = result.clarification?.choices.map(choice => choice.label).join(', ');
  return HR_LABELS[result.outcome] + (choices ? `\nตัวเลือกที่รองรับ: ${choices}` : '');
}

/** Locates spans with the existing resolver and canonicalizes ids; never reads meaning from the text. */
function groundHrSpans(proposal: QueryPlan, message: string): QueryPlan | RejectedPlan {
  const plan = structuredClone(proposal);
  let failure: RejectedPlan | undefined;
  const fail = (slotId: string) => { failure ??= { ...rejected('clarification_required', 'unsupported_source_text'), clarification: { slotId, choices: [] } }; };
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceText' && 'source' in value && value.source === 'inherited') { (value as Record<string, unknown>)[key] = null; continue; }
      if (key === 'sourceText' && child === null && 'source' in value && value.source === 'explicit' &&
        (path.startsWith('measures.') || path.startsWith('dimensions.'))) fail(path);
      if (key === 'sourceText' && child !== null) {
        const grounded = resolveSpan(message, (child as Span).text);
        if (!grounded) fail(path || 'interpretation'); else (value as Record<string, unknown>)[key] = grounded;
      } else if (key !== 'sourceText') walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk({ measures: plan.measures, dimensions: plan.dimensions }, '');
  for (const dimension of plan.dimensions) dimension.interpretation.value = dimension.fieldId;
  for (const measure of plan.measures) measure.interpretation.value = measure.fieldId;
  for (const [index, filter] of plan.filters.entries()) {
    if (filter.source === 'inherited') { filter.sourceText = null; continue; }
    const evidence = filter.evidenceText ?? filter.sourceText?.text;
    const grounded = evidence ? resolveSpan(message, evidence) : null;
    if (!grounded) { fail(`filters.${index}`); continue; }
    filter.evidenceText = grounded.text;
    filter.sourceText = grounded;
  }
  return failure ?? plan;
}

const isRejected = (value: unknown): value is RejectedPlan =>
  typeof value === 'object' && value !== null && 'outcome' in value && (value as { outcome: string }).outcome !== 'accepted' &&
  (value as { outcome: string }).outcome !== 'normalized';

function formatClaim(claim: PresentationClaim, catalog: Wave2Catalog): string {
  const branches = new Map(catalog.branchCatalog.branches.map(branch => [branch.id, branch.name]));
  const branchName = (id: unknown) => id === '__global__' ? 'ส่วนกลาง' : `${displayBranchNames(branches.get(String(id)) ?? String(id))} (${String(id)})`;
  if (claim.fieldId === 'employee_directory') {
    const v = claim.value as { employee_id: string; employee_name: string; branch: string; active: string; badge_id?: string; badge_status?: string; badge_type?: string };
    const base = `${v.employee_id} · ${v.employee_name} · สถานะในระบบ: ${v.active === 'true' ? 'ใช้งาน' : 'ไม่ใช้งาน'} · สาขา ${branchName(v.branch)}`;
    if (v.badge_id === undefined) return base;
    if (v.badge_id === HR_NO_BADGE) return `${base} · ไม่มีบัตรในระบบ`;
    return `${base} · บัตร ${v.badge_id} (${v.badge_type === 'employee_badge' ? 'บัตรพนักงาน' : v.badge_type}) · สถานะบัตร ${v.badge_status === 'active' ? 'ใช้งาน' : v.badge_status === 'revoked' ? 'ถูกเพิกถอน' : v.badge_status}`;
  }
  const dims = Object.entries(claim.dimensions).map(([key, value]) => {
    const label = key === 'branch' ? 'สาขา' : key === 'region' ? 'ภูมิภาค' : 'กลุ่ม';
    return `${label} ${key === 'branch' ? branchName(value) : key === 'region' ? regionLabel(String(value)) : String(value)}`;
  }).join(', ');
  return `จำนวนพนักงานที่มีสถานะใช้งานในระบบ${dims ? ` (${dims})` : ''}: ${new Intl.NumberFormat('th-TH').format(Number(claim.value))} คน`;
}

function renderHr(bundle: HrEvidenceBundle, claims: PresentationClaims, catalog: Wave2Catalog, headcount: boolean, claimOrder?: readonly string[]): { text: string; facts: string[] } {
  const scope = bundle.scope;
  const interpreted = `ขอบเขตข้อมูล: รายชื่อพนักงาน · ภูมิภาค ${scope.regions.map(regionLabel).join(', ') || '-'} · ${scope.branchIds.length} สาขา` +
    `${scope.includeGlobal ? ' · รวมรายชื่อส่วนกลาง' : ''}`;
  const facts = claims.claims.map(claim => formatClaim(claim, catalog));
  const caveats = ['ข้อมูลนี้เป็นข้อมูลที่ระบบอ่านได้สำหรับคำถามนี้ ไม่รวมตารางการลาและข้อมูลส่วนบุคคลอื่น ข้อมูลบัตรแสดงเฉพาะรหัส สถานะ และประเภท',
    ...(headcount ? ['นับเฉพาะพนักงานที่มีสถานะใช้งานในระบบและอยู่ในขอบเขตที่คุณเข้าถึงได้'] : [])];
  const shown = claimOrder ? claimOrder.flatMap(id => { const index = claims.claims.findIndex(claim => claim.id === id); return index >= 0 ? [facts[index]] : []; }) : facts;
  return { text: unique([interpreted, ...caveats, ...claims.limitations, ...shown]).join('\n'), facts };
}

/**
 * Executes an accepted `hr_query` step over the Wave 2 certified HR dataset: grounded spans -> validateHrQueryPlan ->
 * compileHrQuery -> bounded HR snapshot reader -> executeHrRead -> presentation claims -> Thai rendering.
 */
export async function executeHrQueryStep(input: HrExecutorInput): Promise<HrExecutorResult> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const actor = await reloadActor(input.store, input.actor, input.now());
  const loadCatalog = async (reader: Pick<Store, 'list'>) => createWave2Catalog(await reader.list<Branch>('branches'));
  const catalog = await loadCatalog(input.store);
  const authority = hrCatalogAuthority(actor);
  const refuse = (rejection: RejectedPlan): HrExecutorResult => {
    if (rejection.outcome === 'execution_failed') throw new AIRuntimeError('tool_execution_failed', 'The registered HR reader could not complete the query.');
    return { ...classifyRejection('hr_query', rejection, hrRejectionText(rejection)), kind: 'hr_query' };
  };

  const grounded = groundHrSpans(canonicalizeHrPlan(input.step.plan), input.message);
  if (isRejected(grounded)) return refuse(grounded);
  const accepted = validateHrQueryPlan({ proposal: grounded, catalog, actor: authority, sourceText: input.message });
  if (accepted.outcome !== 'accepted') return refuse(accepted);

  const request = compileHrQuery(accepted);
  const snapshot = await readHrSnapshot(input.store, actor, request, input.now);
  signal.throwIfAborted();
  const fresh = await reloadActor(input.store, actor, input.now());
  const read = executeHrRead({ request, snapshot, freshAuthority: hrCatalogAuthority(fresh),
    currentCatalog: await loadCatalog(input.store), now: input.now().toISOString() });
  if (read.outcome !== 'accepted' && read.code === 'hr_scan_truncated') {
    // The bounded store scan hit its row bound: narrowing is the user's choice, offered from authorized branches only.
    const branchNames = new Map(catalog.branchCatalog.branches.map(b => [b.id, b.name]));
    const choices = accepted.scope.branchIds.slice(0, MAX_CLARIFY_CHOICES).map(id => ({ id, label: `สาขา ${displayBranchNames(branchNames.get(id) ?? id)} (${id})` }));
    return { outcome: 'clarify', kind: 'hr_query', code: 'hr_scan_bounded', slot: 'branch', choices, aiAsked: false,
      text: 'ขอบเขตที่ค้นหากว้างเกินกว่าที่ระบบอ่านได้ในครั้งเดียว โปรดระบุสาขาหรือรหัสพนักงานให้แคบลง' };
  }
  if (read.outcome !== 'accepted') return refuse(read);
  const bundle = read.bundle;

  // An exact-name lookup that matches several employees is ambiguous: ask, with choices from authorized evidence.
  const plan = accepted.plan;
  const nameLookup = plan.filters.some(f => f.fieldId === 'employee_name' && f.op === 'eq') && !plan.filters.some(f => f.fieldId === 'employee_id');
  if (plan.aggregation === 'rows' && nameLookup && bundle.rows.length > 1) {
    const branchNames = new Map(catalog.branchCatalog.branches.map(b => [b.id, b.name]));
    const choices = bundle.rows.slice(0, MAX_CLARIFY_CHOICES).map(row => ({ id: String(row.values.employee_id),
      label: `${row.values.employee_name} (${row.values.employee_id}) · สาขา ${row.values.branch === '__global__' ? 'ส่วนกลาง' : branchNames.get(String(row.values.branch)) ?? row.values.branch}` }));
    const asked = await input.ask?.({ slot: 'employee', choices }).catch(() => null);
    const aiAsked = isSafeQuestion(asked, input.isSafeText);
    return { outcome: 'clarify', kind: 'hr_query', code: 'ambiguous_employee', slot: 'employee', choices, aiAsked,
      text: aiAsked ? asked : 'พบพนักงานที่ตรงกับชื่อนี้หลายคน โปรดเลือกคนที่ต้องการ' };
  }

  const claims = createPresentationClaims(bundle);
  if (!claims.claims.length) {
    return { outcome: 'denied', kind: 'hr_query', code: 'no_matching_claims', text: 'ไม่พบพนักงานที่ตรงกับเงื่อนไขในขอบเขตที่คุณเข้าถึงได้' };
  }
  // RESPONSE-001: model arrangement (section kinds only) validated as a claim-ID ResponsePlan; deterministic default otherwise.
  const composed = composeResponse(claims, input.step.presentation);
  if (!composed) return refuse(rejected('semantic_uncertainty', 'invalid_response_plan'));
  const response = composed.response;
  const headcount = plan.aggregation === 'registered';
  const rendered = renderHr(bundle, claims, catalog, headcount, composed.fromHint ? composed.claimOrder : undefined);
  assertFinalTextSize(rendered.text);

  const sources: SourceRef[] = bundle.sourceCompleteness.sources.filter(s => s.observedAt && s.retrievedAt).map(s => ({
    id: s.id, system: 'hr', observedAt: s.observedAt!, retrievedAt: s.retrievedAt!, freshness: 'fresh',
    detail: 'ข้อมูลรายชื่อพนักงานและสถานะที่อ่านจากระบบ' }));
  const sourceIds = sources.map(s => s.id);
  const analysis: Analysis = {
    facts: claims.claims.map((claim, index) => ({ text: rendered.facts[index], sourceIds: claim.sourceRefs.length ? [...claim.sourceRefs] : sourceIds })),
    relationships: [], hypotheses: [], missingEvidence: claims.limitations.map(text => ({ text, sourceIds: [] })),
    generatedAt: input.now().toISOString(), evidenceVersion: bundle.ref.digest,
  };

  return {
    outcome: 'accepted', kind: 'hr_query', text: rendered.text, sources, analysis, bundle, claims,
    interpretedScope: { datasetId: plan.datasetId, dates: [], regions: [...accepted.scope.regions],
      branchIds: [...accepted.scope.branchIds], measures: plan.measures.map(m => m.fieldId) },
    persist: async (tx, finalActor, conversationId) => {
      const finalAuthority = hrCatalogAuthority(finalActor);
      invariant(digest(finalAuthority) === accepted.authority.digest && finalActor.active, 'FORBIDDEN', 'Your HR query authority changed before the response could be saved.', 403);
      const records = (await tx.list<{ name: string; conversationId: string; state: unknown }>('tool_executions', {
        actorId: finalActor.id, sessionId: finalActor.sessionId, status: 'completed',
      })).filter(record => record.name === HR_TOOL && record.conversationId === conversationId);
      const latest = records.flatMap(record => {
        const state = exactConversationStateSchema.safeParse(record.state);
        return state.success ? [state.data] : [];
      }).sort((a, b) => b.revision - a.revision)[0] ?? null;
      const current = latest ? { id: `state:${digest(conversationId)}`, version: latest.revision, digest: digest(latest) } : null;
      const prepared = prepareExactConversationState({ conversationId, turnId: input.diagnosticId, revision: (latest?.revision ?? 0) + 1,
        sourceText: exactSourceTextRef(input.message), parentState: current, currentState: current, response,
        freshAuthority: finalAuthority, currentCatalog: await loadCatalog(tx), now: input.now().toISOString() });
      invariant(prepared.outcome === 'accepted', 'FORBIDDEN', 'The HR evidence could not be saved under current authority.', 403);
      const recordId = `dynamic-hr:${input.diagnosticId}`;
      invariant(!await tx.get('tool_executions', recordId), 'CONFLICT', 'The HR query proof already exists.', 409);
      await tx.put('tool_executions', { id: recordId, name: HR_TOOL, status: 'completed', actorId: finalActor.id,
        sessionId: finalActor.sessionId, conversationId, turnId: input.diagnosticId, plan, bundle, claims,
        state: prepared.state, createdAt: input.now().toISOString() });
    },
  };
}
