import 'server-only';

import type { Actor, Evidence, Scope, Store } from '../contracts';
import { authorizedScope, canRegion, reloadActor } from '../core/auth';
import { trustPolicy, type SemanticDatasetCatalog } from './catalog/semantic';
import { compileQueryPlan } from './compile/reader';
import type { ClaimGraph, NumericClaim } from './evidence/claim-graph';
import { dateList, resolveTime, shiftDate } from './plan/time';
import { queryPlanSchema, type QueryPlan } from './plan/schemas';
import { acceptedContext, authorizedBranches, rejected, validateQueryPlan,
  type AcceptedPlan, type ActorAuthority, type RejectedPlan } from './validate/query-plan';
import { conversationStateSchema, type ConversationState } from './state/conversation';
import { readCompletedTurn } from '../core/turn-completion-gate';
import { digest, unique } from './shared';
import { displayBranchNames } from '../presentation/branch-names';

export interface DynamicQueryInput {
  store: Store; actor: Actor; message: string; businessDate: string; diagnosticId: string;
  now: () => Date; read: (scope: Scope, signal?: AbortSignal) => Promise<Evidence>; signal?: AbortSignal; conversationId?: string;
  routeStartedAt?: number; history?: { role: 'user' | 'assistant'; content: string }[]; plannerTimeoutMs?: number;
}
export function authority(actor: Actor): ActorAuthority {
  return { id: actor.id, active: actor.active, permissions: [...actor.permissions], regions: [...actor.regions], revision: actor.modeRevision + 1 };
}

/** The race lives inside the service transaction, so cancellation releases its read-only lease. */
export async function cancelableEvidenceRead(work: () => Promise<Evidence>, signal: AbortSignal): Promise<Evidence> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work(), canceled]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

export async function currentEvidence(input: DynamicQueryInput, actor: Actor, scope: Scope, signal: AbortSignal): Promise<Evidence> {
  signal.throwIfAborted();
  const current = await reloadActor(input.store, actor, input.now());
  signal.throwIfAborted();
  const evidence = await input.read(authorizedScope(current, scope), signal);
  signal.throwIfAborted();
  return evidence;
}

/** Discover actual coverage through bounded compiled scopes and the same registered reader. */
export async function validateAvailable(input: DynamicQueryInput, plan: QueryPlan,
  catalog: SemanticDatasetCatalog, actor: Actor, signal: AbortSignal,
  availabilityWindow: { min: string; max: string } | null, previous?: { state: { resolvedScope: { dates: readonly string[] } }; plan: QueryPlan }) {
  actor = await reloadActor(input.store, actor, input.now());
  signal.throwIfAborted();
  const actorAuthority = authority(actor), ids = authorizedBranches(catalog, actorAuthority).map(b => b.id);
  const empty = { availabilityWindow, previousDates: previous?.state.resolvedScope.dates, previousPlan: previous?.plan, sourceText: input.message, businessDate: input.businessDate,
    dates: [] as string[], dateLimitations: [] as string[], branchIds: ids,
    sourceSystems: unique(catalog.datasets.flatMap(dataset => dataset.fields.flatMap(field => field.sourceSystems))) };
  // Time resolution operates on the typed plan alone. Raw text never sets a date or scope.
  let dates: string[], validationPlan = plan;
  try {
    const resolved = resolveTime(plan.time, input.businessDate, catalog.datasets[0].budgets.maxDays);
    dates = resolved.dates;
    if ((resolved.time.source === 'explicit' || resolved.time.source === 'generated') && availabilityWindow) {
      const availableDates = dates.filter(date => date >= availabilityWindow.min && date <= availabilityWindow.max);
      if (availableDates.length > 0 && availableDates.length < dates.length) {
        const omittedDates = dates.filter(date => !availableDates.includes(date));
        empty.dateLimitations.push(`ข้อมูลที่มีครอบคลุม ${compactDateSet(availableDates)}; ไม่มีข้อมูลสำหรับวันที่ ${compactDateSet(omittedDates)}.`);
        dates = availableDates;
        validationPlan = { ...plan, time: { ...resolved.time, dates: availableDates } };
      }
    }
    if (plan.compare && plan.compare.kind !== 'vs_target') {
      const first = dates[0], budget = catalog.datasets[0].budgets.maxDays;
      dates = unique([...dates, ...dateList(shiftDate(first, -budget), shiftDate(first, -1), budget)]);
    }
  } catch { return validateQueryPlan(plan, catalog, actorAuthority, empty); }
  const preflight = validateQueryPlan(validationPlan, catalog, actorAuthority, { ...empty, dates });
  if (preflight.outcome !== 'accepted') return preflight;
  const context = acceptedContext(preflight);
  const branchDates: { branchId: string; date: string }[] = [];
  const requireCompleteSources = !!preflight.plan.topN || preflight.plan.completeness.expectation === 'complete_authorized_population' ||
    !!preflight.plan.compare && preflight.plan.compare.kind !== 'vs_target';
  for (const scope of compileQueryPlan(preflight).scopes) {
    const evidence = await currentEvidence(input, actor, scope, signal);
    if (evidence.scope.date !== scope.date || evidence.scope.region !== scope.region || evidence.branches.some(branch =>
      !scope.branchIds!.includes(branch.branchId) || branch.region !== scope.region)) return rejected('permission_denied', 'unexpected_evidence_scope');
    if (evidence.branches.length !== scope.branchIds!.length || new Set(evidence.branches.map(branch => branch.branchId)).size !== scope.branchIds!.length)
      return rejected('incomplete_evidence', 'population_incomplete');
    for (const branch of evidence.branches) {
      const freshSources = context.sourceSystems.filter(system => {
      const id = `${system}:${branch.branchId}:${scope.date}`;
      return branch.sourceIds.includes(id) && evidence.sources.filter(source => source.id === id && source.system === system && source.freshness === 'fresh').length === 1;
      });
      if (requireCompleteSources ? freshSources.length === context.sourceSystems.length : freshSources.length > 0) {
        branchDates.push({ branchId: branch.branchId, date: scope.date });
      }
    }
  }
  signal.throwIfAborted();
  return validateQueryPlan(validationPlan, catalog, authority(await reloadActor(input.store, actor, input.now())), {
    ...empty, dates: unique(branchDates.map(pair => pair.date)), branchDates,
  });
}

function supportedChoices(catalog: SemanticDatasetCatalog, actor: Actor): string {
  const regions = unique(catalog.branches.filter(branch => canRegion(actor, branch.region)).map(branch => branch.region));
  const values = catalog.datasets.flatMap(dataset => dataset.fields).find(field => field.id === 'region')?.canonicalValues ?? [];
  const regionLabels = regions.map(id => {
    const value = values.find(item => item.id === id);
    return value?.labels?.find(label => label !== id && /[^\x00-\x7f]/u.test(label)) ?? value?.label;
  }).filter((label): label is string => !!label);
  const measureLabels = unique(catalog.datasets.flatMap(dataset => actor.active && regions.length && dataset.requiredPermissions.every(p => actor.permissions.includes(p))
    && trustPolicy(dataset.trust, dataset.sensitivity, ['answer']).allowed
    ? dataset.fields.filter(field => field.kind === 'measure' && field.requiredPermissions.every(p => actor.permissions.includes(p))
      && trustPolicy(field.trust, field.sensitivity, ['answer']).allowed)
      .map(field => field.displayLabel).filter((label): label is string => !!label && /[^\x00-\x7f]/u.test(label)) : []));
  const formatList = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} และ ${items.at(-1)}`;
  const parts = [measureLabels.length ? `ตัวชี้วัดที่ถามได้ เช่น ${formatList(unique(measureLabels))}` : '',
    regionLabels.length ? `ภูมิภาคที่ถามได้ เช่น ${formatList(unique(regionLabels))}` : ''].filter(Boolean);
  return parts.length ? `ข้อมูลที่ตรวจสอบได้ตามสิทธิ์ของบัญชีนี้มีดังนี้: ${parts.join('; ')}`
    : 'โปรดลองระบุตัวชี้วัดหรือขอบเขตที่ต้องการให้ชัดเจนขึ้น';
}

type DateWindow = { min: string; max: string } | null | undefined;

export function compactDateSet(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const ranges: string[] = [];
  let start: string | undefined, previous: string | undefined;
  const flush = () => {
    if (!start || !previous) return;
    ranges.push(start === previous ? start : start + '..' + previous);
  };
  for (const date of sorted) {
    const nextPrevious = previous ? new Date(previous + 'T00:00:00.000Z').getTime() + 86_400_000 : NaN;
    const nextDate = Number.isFinite(nextPrevious) ? new Date(nextPrevious).toISOString().slice(0, 10) : undefined;
    if (!start || date !== nextDate) {
      flush();
      start = date;
    }
    previous = date;
  }
  flush();
  return ranges.join(', ');
}

const TIME_REJECTION_CODES = new Set([
  'date_outside_availability', 'date_unavailable', 'empty_date_scope', 'invalid_canonical_dates',
  'inherited_time_mismatch', 'time_budget_or_range', 'time_dimension', 'unsupported_time_text',
]);

function timeRejectionText(result: RejectedPlan, availabilityWindow?: DateWindow): string {
  const requested = compactDateSet(result.dateAvailability?.requestedDates ?? []);
  const availableFrom = result.dateAvailability?.availableFrom ?? availabilityWindow?.min ?? null;
  const availableTo = result.dateAvailability?.availableTo ?? availabilityWindow?.max ?? null;
  const available = availableFrom && availableTo
    ? `ข้อมูลที่มีครอบคลุม ${availableFrom} ถึง ${availableTo} กรุณาระบุวันที่ภายในช่วงนี้`
    : 'ขณะนี้ยังไม่ทราบช่วงวันที่ที่มีข้อมูล';
  if (result.code === 'date_outside_availability') {
    const dates = requested ? `ช่วงวันที่ ${requested} ที่ขอ` : 'ช่วงวันที่ที่ขอ';
    return availableFrom && availableTo ? `${dates} ไม่มีข้อมูลในระบบ ข้อมูลที่มีครอบคลุม ${availableFrom} ถึง ${availableTo} กรุณาระบุช่วงที่ต้องการดู`
      : `${dates} ยังไม่มีข้อมูลในระบบ`;
  }
  if (result.code === 'unsupported_time_text') return `ยังยืนยันช่วงเวลาที่ต้องการ${requested ? ` (${requested})` : ''}ไม่ได้ กรุณาระบุวันที่หรือช่วงวันที่ให้ชัดเจน ${available}`;
  if (result.code === 'time_budget_or_range' || result.code === 'invalid_canonical_dates') return `ช่วงวันที่${requested ? ` ${requested}` : 'ที่ขอ'}กว้างหรือไม่ชัดเจนพอสำหรับการตรวจสอบ กรุณาระบุช่วงวันที่ให้แคบลง`;
  if (result.code === 'inherited_time_mismatch') return 'ช่วงวันที่ต่อจากคำถามก่อนหน้าไม่ตรงกับข้อมูลที่ยืนยันไว้ กรุณาระบุช่วงวันที่อีกครั้ง';
  if (result.code === 'time_dimension') return 'ยังตรวจสอบข้อมูลตามช่วงเวลาที่ขอไม่ได้ กรุณาระบุช่วงวันที่อีกครั้ง';
  if (result.code === 'empty_date_scope') return 'ไม่พบวันที่ที่ตรงกับขอบเขตที่ขอ กรุณาตรวจสอบช่วงวันที่อีกครั้ง';
  const interpretation = requested ? `ยังตรวจสอบวันที่ ${requested} ไม่ได้` : 'ยังตรวจสอบช่วงเวลาที่ขอไม่ได้';
  return `${interpretation} ${available}`;
}

export function rejectionText(result: RejectedPlan, catalog: SemanticDatasetCatalog, actor: Actor, availabilityWindow?: DateWindow): string {
  if (result.dateAvailability || result.clarification?.slotId === 'time' || TIME_REJECTION_CODES.has(result.code))
    return timeRejectionText(result, availabilityWindow);
  if (result.code === 'unsupported_source_text') {
    const slot = result.clarification?.slotId ?? '';
    const question = slot.startsWith('filters') ? 'ช่วยระบุสาขาหรือภูมิภาคที่ต้องการดูให้ชัดเจนขึ้นได้ไหมครับ'
      : slot.startsWith('measures') ? 'ช่วยระบุตัวชี้วัดที่ต้องการดูให้ชัดเจนขึ้นได้ไหมครับ'
        : slot.startsWith('dimensions') ? 'ช่วยระบุมุมมองที่ต้องการจัดกลุ่มข้อมูลได้ไหมครับ'
          : slot.startsWith('compare') ? 'ช่วยระบุช่วงหรือข้อมูลที่ต้องการเปรียบเทียบได้ไหมครับ'
            : 'ช่วยระบุขอบเขตของข้อมูลที่ต้องการดูได้ไหมครับ';
    return `${question}\n${supportedChoices(catalog, actor)}`;
  }
  const reasonCopy: Record<string, string> = {
    comparison_period_required: 'ช่วยระบุช่วงเวลาที่ต้องการเปรียบเทียบ เช่น วัน ช่วงสัปดาห์ หรือเดือน',
    comparison_period_alignment: 'ช่วงวันที่ที่ขอไม่ตรงกับช่วงเปรียบเทียบที่เลือก กรุณาระบุช่วงเวลาใหม่',
    target_comparison_unavailable: 'ตัวชี้วัดนี้ยังไม่มีเป้าหมายสำหรับใช้เปรียบเทียบ กรุณาเลือกตัวชี้วัดที่มีเป้าหมาย',
    snapshot_aggregation_required: 'ข้อมูลหลายวันต้องระบุวิธีสรุป เช่น ค่าเฉลี่ย ค่าล่าสุด หรือค่าสูงสุด',
    mixed_temporal_aggregation: 'ตัวชี้วัดที่เลือกต้องใช้วิธีสรุปช่วงเวลาที่สอดคล้องกัน กรุณาปรับช่วงหรือวิธีสรุป',
    explicit_scope_denied: 'ขอบเขตที่ขออยู่นอกสิทธิ์ของบัญชีนี้ จึงยังเปิดเผยข้อมูลส่วนนั้นไม่ได้',
    dataset_permission: 'บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลประเภทนี้', field_permission: 'บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลบางส่วนที่คำถามต้องใช้',
    previous_state_outside_authority: 'ขอบเขตจากคำถามก่อนหน้าอยู่นอกสิทธิ์ปัจจุบัน กรุณาระบุขอบเขตใหม่',
    authority_changed: 'สิทธิ์การเข้าถึงเปลี่ยนไประหว่างตรวจสอบ กรุณาส่งคำถามอีกครั้ง', scope_revoked: 'ขอบเขตที่ขอไม่อยู่ในสิทธิ์ปัจจุบันแล้ว',
    date_unavailable: 'ไม่พบข้อมูลในช่วงวันที่ที่ขอ', empty_effective_scope: 'ไม่พบสาขาที่ตรงกับขอบเขตซึ่งบัญชีนี้ดูได้',
    source_unavailable: 'แหล่งข้อมูลที่ต้องใช้ยังไม่พร้อมให้ตรวจสอบ', no_matching_claims: 'ไม่พบข้อมูลที่ตรงกับคำถามในหลักฐานที่ตรวจสอบได้',
    population_unavailable: 'ข้อมูลของบางสาขาหรือบางวันยังไม่ครบ จึงยังเปรียบเทียบหรือจัดอันดับอย่างถูกต้องไม่ได้',
    population_incomplete: 'หลักฐานของกลุ่มที่ต้องใช้ยังไม่ครบ จึงยังสรุปผลไม่ได้',
    ranking_requires_population: 'การจัดอันดับต้องมีข้อมูลครบทุกสาขาในขอบเขตที่ได้รับอนุญาต',
    ranking_budget_or_direction: 'ยังจัดอันดับตามขอบเขตที่ขอไม่ได้ กรุณาปรับจำนวนรายการหรือทิศทางการจัดอันดับ',
    unsupported_time_text: 'ยังยืนยันช่วงเวลาที่ต้องการไม่ได้ กรุณาระบุวันที่หรือช่วงวันที่ให้ชัดเจน',
    invalid_source_span: 'คำถามมีส่วนที่ยังยืนยันความหมายกับข้อมูลที่ลงทะเบียนไว้ไม่ได้ กรุณาใช้ชื่อข้อมูลที่ชัดเจนขึ้น',
    low_confidence: 'ยังตีความคำถามได้ไม่แน่ชัด กรุณาระบุตัวชี้วัดหรือขอบเขตให้ชัดเจนขึ้น',
    invalid_plan: 'ยังตรวจสอบความหมายของคำถามไม่ได้ กรุณาลองเรียบเรียงใหม่',
    malformed_model_json: 'ระบบยังตีความคำถามได้ไม่สำเร็จ กรุณาลองส่งคำถามอีกครั้ง',
    invalid_model_plan: 'ระบบยังตรวจสอบความหมายของคำถามไม่ได้ กรุณาลองเรียบเรียงใหม่',
    planner_clarification: 'ช่วยระบุตัวชี้วัดหรือขอบเขตที่ต้องการให้ชัดเจนขึ้นได้ไหมครับ',
    planner_failed: 'ระบบยังตรวจสอบคำถามนี้ไม่สำเร็จ กรุณาลองอีกครั้ง',
    incomplete_evidence: 'หลักฐานที่ได้รับยังไม่ครบ จึงยังสรุปตัวเลขหรือจัดอันดับให้ไม่ได้',
    unexpected_evidence_scope: 'หลักฐานที่ได้รับไม่ตรงกับขอบเขตที่ตรวจสอบไว้ จึงไม่แสดงผลลัพธ์นี้',
  };
  const outcomes: Record<RejectedPlan['outcome'], string> = {
    clarification_required: 'ช่วยระบุตัวชี้วัดหรือขอบเขตที่ต้องการให้ชัดเจนขึ้นได้ไหมครับ',
    unsupported_concept: 'คำถามนี้ยังไม่ตรงกับข้อมูลที่ระบบตรวจสอบได้ กรุณาเลือกตัวชี้วัดหรือมุมมองอื่น',
    data_unavailable: 'ไม่พบข้อมูลที่เพียงพอสำหรับขอบเขตที่ขอ',
    permission_denied: 'ขอบเขตที่ขออยู่นอกสิทธิ์ของบัญชีนี้ จึงยังเปิดเผยข้อมูลส่วนนั้นไม่ได้',
    incomplete_evidence: 'หลักฐานที่ได้รับยังไม่ครบ จึงยังสรุปผลตามที่ขอไม่ได้',
    semantic_uncertainty: 'ยังตีความคำถามได้ไม่แน่ชัด กรุณาระบุตัวชี้วัดหรือขอบเขตให้ชัดเจนขึ้น',
    execution_failed: 'ระบบยังตรวจสอบคำถามนี้ไม่สำเร็จ กรุณาลองอีกครั้ง',
  };
  const message = reasonCopy[result.code] ?? outcomes[result.outcome];
  return ['clarification_required', 'unsupported_concept', 'permission_denied'].includes(result.outcome)
    ? `${message}\n${supportedChoices(catalog, actor)}` : message;
}

const moneyFormat = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });

function displayDimension(key: string, value: string, dataset: SemanticDatasetCatalog['datasets'][number], catalog: SemanticDatasetCatalog): string {
  const field = dataset.fields.find(item => item.id === key);
  if (key === 'branch') {
    const branch = catalog.branches.find(item => item.id === value);
    const name = branch && displayBranchNames(branch.name);
    const containsId = !!branch && name?.toLocaleLowerCase().includes(branch.id.toLocaleLowerCase());
    if (!name || containsId) return `สาขา ${displayDimension('region', branch?.region ?? '', dataset, catalog)}`;
    return `สาขา${name.replace(/^สาขา\s*/u, '')}`;
  }
  const canonical = field?.canonicalValues?.find(item => item.id === value);
  const label = canonical?.labels?.find(item => item !== value && /[^\x00-\x7f]/u.test(item)) ?? canonical?.label;
  if (key === 'region') return label ?? 'ภูมิภาคที่เกี่ยวข้อง';
  if (key === 'date') return `วันที่ ${value}`;
  return `${field?.displayLabel ?? 'กลุ่มข้อมูล'} ${label ?? (/[a-z0-9_.:-]+/iu.test(value) ? 'ที่เกี่ยวข้อง' : value)}`;
}

function dimensionSubject(claim: NumericClaim, dataset: SemanticDatasetCatalog['datasets'][number], catalog: SemanticDatasetCatalog): string {
  return Object.entries(claim.dimensions).filter(([key]) => key !== 'comparison')
    .map(([key, value]) => displayDimension(key, value, dataset, catalog)).join(' และ ');
}

function numericText(value: number | null, unit: string | undefined): string {
  if (value === null) return 'ไม่มีข้อมูลให้ยืนยัน';
  const formatted = unit === 'บาท' ? moneyFormat.format(value) : numberFormat.format(value);
  return unit === '%' ? `${formatted}%` : `${formatted}${unit ? ` ${unit}` : ''}`;
}

interface RenderComparison { percentage: number | null; kind: 'target' | 'period' }
const percentFormat = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });

export function renderNumericClaim(claim: NumericClaim, catalog: SemanticDatasetCatalog, comparison?: RenderComparison): string {
  const dataset = catalog.datasets.find(item => item.fields.some(field => field.id === claim.measure)) ?? catalog.datasets[0];
  const field = dataset.fields.find(item => item.id === claim.measure);
  const subject = dimensionSubject(claim, dataset, catalog);
  const label = field?.displayLabel ?? 'ตัวชี้วัด';
  // A label that starts with a Latin product term (e.g. Incident) needs a space after the preceding Thai word.
  const gap = label.charCodeAt(0) < 128 ? ' ' : '';
  if (claim.computation.operation === 'rank') {
    return `อันดับ ${claim.value === null ? 'ที่ยังยืนยันไม่ได้' : numberFormat.format(claim.value)} คือ${subject || 'รายการที่เกี่ยวข้อง'}.`;
  }
  if (claim.dimensions.comparison === 'difference' && claim.value !== null) {
    // Callers without the accepted plan do not know the baseline kind: state the signed difference neutrally instead of guessing "previous period".
    if (!comparison) return `${subject ? `${subject} ` : ''}${label}ส่วนต่างเทียบค่าอ้างอิง ${claim.value < 0 ? '-' : claim.value > 0 ? '+' : ''}${numericText(Math.abs(claim.value), field?.displayUnit)}.`;
    const relation = comparison.kind === 'target'
      ? claim.value < 0 ? 'ต่ำกว่าเป้าหมาย' : claim.value > 0 ? 'สูงกว่าเป้าหมาย' : 'เท่ากับเป้าหมาย'
      : claim.value < 0 ? 'ลดลงจากช่วงก่อนหน้า' : claim.value > 0 ? 'เพิ่มขึ้นจากช่วงก่อนหน้า' : 'เท่ากับช่วงก่อนหน้า';
    const percent = comparison?.percentage;
    const percentageText = percent === null || percent === undefined ? '' : ` (${percent > 0 ? '+' : ''}${percentFormat.format(percent)}%)`;
    return `${subject ? `${subject} ` : ''}${label}${relation} ${numericText(Math.abs(claim.value), field?.displayUnit)}${percentageText}.`;
  }
  if (claim.dimensions.comparison === 'baseline') {
    if (claim.measure === 'target' || field?.displayLabel?.includes('เป้า'))
      return `${subject ? `${subject} มี` : ''}เป้าหมาย ${numericText(claim.value, field?.displayUnit)}.`;
    return `${subject ? `${subject} มี${gap}` : ''}${label}ในช่วงก่อนหน้า ${numericText(claim.value, field?.displayUnit)}.`;
  }
  return `${subject ? `${subject} มี${gap}` : `รวม${gap}`}${label} ${numericText(claim.value, field?.displayUnit)}.`;
}

function comparisonForClaim(plan: AcceptedPlan, graph: ClaimGraph, claim: NumericClaim): RenderComparison | undefined {
  if (claim.dimensions.comparison !== 'difference' || !plan.plan.compare) return undefined;
  const dimensions = JSON.stringify(Object.fromEntries(Object.entries(claim.dimensions).filter(([key]) => key !== 'comparison')));
  const field = acceptedContext(plan).dataset.fields.find(item => item.id === claim.measure);
  const baselineMeasure = plan.plan.compare.kind === 'vs_target' ? field?.targetFieldId : claim.measure;
  if (!baselineMeasure) return undefined;
  const baseline = graph.claims.find(candidate => candidate.measure === baselineMeasure && candidate.id !== claim.id &&
    candidate.dimensions.comparison !== 'difference' && JSON.stringify(Object.fromEntries(Object.entries(candidate.dimensions)
      .filter(([key]) => key !== 'comparison'))) === dimensions);
  return { kind: plan.plan.compare.kind === 'vs_target' ? 'target' : 'period',
    percentage: baseline?.value && baseline.value !== 0 && claim.value !== null ? claim.value / baseline.value * 100 : null };
}

export function crossGroupComparisons(plan: AcceptedPlan, graph: ClaimGraph, catalog: SemanticDatasetCatalog): { text: string; sourceIds: string[] }[] {
  if (plan.plan.compare || plan.plan.group.fieldIds.length !== 1) return [];
  const dimension = plan.plan.group.fieldIds[0];
  if (dimension !== 'region') return [];
  const dataset = acceptedContext(plan).dataset;
  const comparisons: { text: string; sourceIds: string[] }[] = [];
  for (const measure of plan.plan.measures) {
    const candidates = graph.claims.filter(claim => claim.measure === measure.fieldId && claim.value !== null &&
      claim.computation.operation !== 'rank' && claim.dimensions[dimension] !== undefined && claim.dimensions.comparison === undefined);
    if (candidates.length !== 2) continue;
    const [left, right] = candidates;
    if (left.value === null || right.value === null) continue;
    const higher = left.value >= right.value ? left : right, lower = higher === left ? right : left;
    const difference = higher.value! - lower.value!;
    const field = dataset.fields.find(item => item.id === measure.fieldId);
    const unit = field?.displayUnit;
    const percentage = lower.value! > 0 ? ` (${percentFormat.format(difference / lower.value! * 100)}%)` : '';
    const leftLabel = displayDimension(dimension, higher.dimensions[dimension], dataset, catalog);
    const rightLabel = displayDimension(dimension, lower.dimensions[dimension], dataset, catalog);
    const comparisonText = difference === 0
      ? `${leftLabel} และ ${rightLabel} มี${field?.displayLabel ?? 'ตัวชี้วัด'}เท่ากันที่ ${numericText(higher.value, unit)}`
      : `${leftLabel} มี${field?.displayLabel ?? 'ตัวชี้วัด'}สูงกว่า${rightLabel} ${numericText(difference, unit)}${percentage}`;
    comparisons.push({ text: `${comparisonText}.`, sourceIds: unique([...higher.sourceRefs, ...lower.sourceRefs]) });
  }
  return comparisons;
}

export function renderClaims(plan: AcceptedPlan, graph: ClaimGraph, catalog: SemanticDatasetCatalog, claimOrder?: readonly string[]): string {
  const dataset = catalog.datasets.find(item => item.id === plan.plan.datasetId);
  const regionValues = dataset?.fields.find(field => field.id === 'region')?.canonicalValues ?? [];
  const regionLabels = new Map(regionValues.map(value => [value.id,
    value.labels?.find(label => label !== value.id && /[^\x00-\x7f]/u.test(label)) ?? value.label ?? 'ภูมิภาคที่เกี่ยวข้อง']));
  const dates = compactDateSet(plan.dates);
  const regions = plan.scope.regions.map(region => regionLabels.get(region) ?? 'ภูมิภาคที่เกี่ยวข้อง').join(', ');
  const branchFiltered = plan.plan.filters.some(filter => filter.fieldId === 'branch');
  const branchNames = plan.scope.branchIds.map(id => displayDimension('branch', id, dataset!, catalog).replace(/^สาขา/u, ''));
  const branches = branchFiltered || plan.scope.branchIds.length <= 3
    ? `สาขา ${branchNames.join(', ')}` : `${numberFormat.format(plan.scope.branchIds.length)} สาขา`;
  const measures = plan.plan.measures.map(measure => dataset?.fields.find(field => field.id === measure.fieldId)?.displayLabel ?? 'ตัวชี้วัด').join(', ');
  const inherited = plan.plan.time?.source === 'inherited' || plan.plan.filters.some(filter => ['region', 'branch'].includes(filter.fieldId) && filter.source === 'inherited');
  const baseline = plan.baselineDates.length ? `; ช่วงเปรียบเทียบ ${compactDateSet(plan.baselineDates)}` : '';
  const interpreted = `ขอบเขตที่ตีความ: ช่วงวันที่ ${dates}${inherited ? ' (ต่อจากคำถามก่อน)' : ''}${baseline}; ภูมิภาค ${regions}; ${branches}; ตัวชี้วัด ${measures}.`;
  const labels = plan.interpretationLabels.filter(label => !label.startsWith('วันที่ธุรกิจ') && !label.startsWith('ขอบเขตเริ่มต้น:') &&
    !label.startsWith('จำกัดขอบเขตตามสิทธิ์ของคุณ:')).map(label => {
      if (label.startsWith('Default comparison grain: ')) return `ใช้ช่วงเปรียบเทียบแบบ${({ day: 'รายวัน', week: 'รายสัปดาห์', month: 'รายเดือน' } as Record<string, string>)[label.replace('Default comparison grain: ', '')] ?? 'ที่ระบบรองรับ'}`;
      return label;
    });
  const ordered = claimOrder ? claimOrder.flatMap(id => graph.claims.filter(claim => claim.id === id)) : graph.claims;
  const claimLines = ordered.map(claim => renderNumericClaim(claim, catalog, comparisonForClaim(plan, graph, claim)));
  return unique([interpreted, ...labels, ...graph.limitations, ...claimLines, ...crossGroupComparisons(plan, graph, catalog).map(comparison => comparison.text)]).join('\n');
}

export async function previousState(input: DynamicQueryInput, actor: Actor, catalog: SemanticDatasetCatalog): Promise<{ state: ConversationState; plan: QueryPlan } | undefined> {
  if (!input.conversationId) return;
  const records = (await input.store.list<{ name: string; conversationId: string; state: unknown; plan: unknown }>('tool_executions', {
    actorId: actor.id, sessionId: actor.sessionId, status: 'completed',
  })).filter(record => record.name === 'retail.dynamic_query' && record.conversationId === input.conversationId);
  const previous = records.flatMap(record => {
    const state = conversationStateSchema.safeParse(record.state), plan = queryPlanSchema.safeParse(record.plan);
    return state.success && plan.success && digest(plan.data) === state.data.lastAcceptedPlan.digest
      ? [{ state: state.data, plan: plan.data }] : [];
  }).sort((a, b) => b.state.revision - a.state.revision)[0];
  if (!previous) return;
  const { state } = previous;
  const current = authority(actor), permitted = new Set(authorizedBranches(catalog, current).map(branch => branch.id));
  if (state.conversationId !== input.conversationId || state.authoritySnapshot.id !== actor.id || state.authoritySnapshot.digest !== digest(current)
    || state.catalogSnapshot.digest !== catalog.digest || state.resolvedScope.branchIds.some(id => !permitted.has(id))) return;
  const completed = await readCompletedTurn(input.store, { actorId: actor.id, sessionId: actor.sessionId, conversationId: input.conversationId,
    turnId: state.turnId, mode: actor.mode, modeRevision: actor.modeRevision });
  return completed.kind === 'completed' ? previous : undefined;
}
