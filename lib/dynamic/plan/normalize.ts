import type { QueryPlan, Span } from './schemas';
import { resolveTime } from './time';
import { rejected, type RejectedPlan } from '../validate/query-plan';

/**
 * Only formatting changes: NFC, duplicate Thai combining marks, the tone-mark-before-upper-vowel typing order (a pure
 * code-point ordering slip; the rendered glyph is identical), stacked tone marks (an invalid sequence; the first is kept)
 * and whitespace. No spelling correction, case folding or synonyms.
 */
function normalizedText(text: string): string {
  return text.normalize('NFC').replace(/([\u0e31\u0e34-\u0e3a\u0e47-\u0e4e])\1+/gu, '$1')
    .replace(/([\u0e48-\u0e4b])([\u0e31\u0e34-\u0e37\u0e47])/gu, '$2$1').replace(/([\u0e48-\u0e4b])[\u0e48-\u0e4b]+/gu, '$1')
    .replace(/\s+/gu, ' ');
}

/**
 * Transcription-slip tolerance for MODEL-copied evidence (the model re-types the user's Thai and occasionally drops,
 * doubles or swaps one character). Bounded: only for evidence containing Thai, at least FUZZY_MIN_CHARS non-space
 * characters, at most ONE edit (insert/delete/substitute), messages up to FUZZY_MAX_TEXT chars, and only when every
 * best-distance window maps to the same place in the message (otherwise the evidence is ambiguous -> no span). The
 * returned span is always the USER's own substring; the model text never becomes evidence. This compares model output
 * with the user string; it does not interpret meaning.
 */
export const FUZZY_MIN_CHARS = 5;
const FUZZY_MAX_TEXT = 4000;
function withinOneEdit(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ? 1 : 2;
  return (a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)) ? 1 : 2;
}
function fuzzyWindow(normalized: string, wanted: string): { start: number; end: number } | null {
  if (!/[\u0e00-\u0e7f]/u.test(wanted) || [...wanted].filter(char => !/\s/u.test(char)).length < FUZZY_MIN_CHARS) return null;
  if (normalized.length > FUZZY_MAX_TEXT) return null;
  const hits: { start: number; end: number }[] = [];
  for (let start = 0; start < normalized.length; start++) {
    for (const length of [wanted.length, wanted.length - 1, wanted.length + 1]) {
      if (length < 1 || start + length > normalized.length) continue;
      const window = normalized.slice(start, start + length);
      if (window.trim() !== window) continue;
      if (withinOneEdit(window, wanted) <= 1) { hits.push({ start, end: start + length }); break; }
    }
  }
  if (!hits.length) return null;
  // Overlapping hits are one location; two separate locations are ambiguous.
  const first = hits[0]!;
  if (hits.some(hit => hit.start >= first.end)) return null;
  return hits.find(hit => hit.end - hit.start === wanted.length) ?? first;
}

/** Offsets are server-owned. Identical repeated substrings have identical meaning. */
export function resolveSpan(text: string, part: string): Span | null {
  const wanted = normalizedText(part);
  if ([...wanted].filter(char => !/\s/u.test(char)).length < 2) return null;
  const latinToken = /^[A-Za-z0-9]+$/u.test(wanted);
  const hasTokenBoundaries = (start: number, end: number) => !latinToken ||
    (!/[A-Za-z0-9]/u.test(text[start - 1] ?? '') && !/[A-Za-z0-9]/u.test(text[end] ?? ''));
  let exact = text.indexOf(part);
  while (exact >= 0) {
    const end = exact + part.length;
    if (hasTokenBoundaries(exact, end)) return { start: exact, end, text: part };
    exact = text.indexOf(part, exact + 1);
  }
  // Map normalized grapheme clusters back to original UTF-16 boundaries.
  const segments = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text)];
  let normalized = '';
  const starts: number[] = [], ends: number[] = [];
  for (const { segment, index } of segments) {
    const chunk = normalizedText(segment);
    let offset = 0;
    for (const char of chunk) {
      if (char === ' ' && normalized.endsWith(' ')) { ends[ends.length - 1] = index + segment.length; continue; }
      normalized += char;
      for (let i = 0; i < char.length; i++) {
        starts.push(chunk === segment ? index + offset + i : index);
        ends.push(chunk === segment ? index + offset + i + 1 : index + segment.length);
      }
      offset += char.length;
    }
  }
  let start = normalized.indexOf(wanted);
  while (start >= 0) {
    const from = starts[start], to = ends[start + wanted.length - 1];
    const original = text.slice(from, to);
    if (hasTokenBoundaries(from, to) && normalizedText(original) === wanted) return { start: from, end: to, text: original };
    start = normalized.indexOf(wanted, start + 1);
  }
  const fuzzy = fuzzyWindow(normalized, wanted);
  if (fuzzy) {
    const from = starts[fuzzy.start], to = ends[fuzzy.end - 1];
    if (from !== undefined && to !== undefined && to > from) return { start: from, end: to, text: text.slice(from, to) };
  }
  return null;
}

/** Accept text-only model spans; never let unreliable offsets prevent normalization. */
export function preparePlannerSpans(value: unknown, replaceOffsets: boolean): unknown {
  if (Array.isArray(value)) return value.map(child => preparePlannerSpans(child, replaceOffsets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'sourceText' && child && typeof child === 'object' && 'text' in child && typeof child.text === 'string') {
      const span = child as Record<string, unknown>;
      return [key, replaceOffsets || span.start === undefined || span.end === undefined ? { ...span, start: 0, end: child.text.length } : span];
    }
    return [key, preparePlannerSpans(child, replaceOffsets)];
  }));
}

/** Served-date window: a time interpretation whose evidence cannot be located may still be accepted inside it (see below). */
export interface NormalizeOptions { availability?: { min: string; max: string } | null }

const BROAD_SPAN_RATIO = 0.8, BROAD_SPAN_MIN_TEXT = 20;

export function normalizeQueryPlan(proposal: QueryPlan, message: string, businessDate: string, inheritedDates?: readonly string[], options: NormalizeOptions = {}): { outcome: 'normalized'; plan: QueryPlan } | RejectedPlan {
  const plan = structuredClone(proposal);
  const timeRejection = (result: RejectedPlan): RejectedPlan => plan.time
    ? { ...result, dateAvailability: { requestedDates: plan.time.dates, availableFrom: null, availableTo: null } }
    : result;
  let failure: RejectedPlan | undefined;
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceText' && 'source' in value && value.source === 'inherited') {
        (value as Record<string, unknown>)[key] = null;
        continue;
      }
      if (key === 'sourceText' && child === null && 'source' in value && value.source === 'explicit' &&
        (path.startsWith('measures.') || path.startsWith('dimensions.'))) {
        failure ??= { ...rejected('clarification_required', 'unsupported_source_text'), clarification: { slotId: path, choices: [] } };
      }
      if (key === 'sourceText' && child !== null) {
        const grounded = resolveSpan(message, (child as Span).text);
        if (!grounded) failure ??= { ...rejected('clarification_required', 'unsupported_source_text'),
          clarification: { slotId: path || 'interpretation', choices: [] } };
        else (value as Record<string, unknown>)[key] = grounded;
      } else walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(plan, '');
  if (failure) return failure;
  /*
   * An interpretation (measure/dimension) whose "evidence" is (almost) the whole message proves nothing and the
   * validator refuses it. Canonical form: borrow the grounded span of a filter on the same field when there is one
   * (grouping by the field the user filtered on), otherwise the choice is the model's own -> source 'default' (labeled).
   */
  for (const choice of [...plan.measures, ...plan.dimensions]) {
    const span = choice.interpretation.sourceText;
    if (!span || choice.interpretation.source !== 'explicit' || message.length <= BROAD_SPAN_MIN_TEXT || span.text.length <= message.length * BROAD_SPAN_RATIO) continue;
    const filter = plan.filters.find(f => f.fieldId === choice.fieldId && f.source !== 'inherited' && (f.evidenceText ?? f.sourceText?.text));
    const borrowed = filter ? resolveSpan(message, (filter.evidenceText ?? filter.sourceText?.text)!) : null;
    if (borrowed && borrowed.text.length <= message.length * BROAD_SPAN_RATIO) choice.interpretation.sourceText = borrowed;
    else choice.interpretation = { ...choice.interpretation, source: 'default', sourceText: null };
  }
  for (const dimension of plan.dimensions) dimension.interpretation.value = dimension.fieldId;
  for (const measure of plan.measures) measure.interpretation.value = measure.fieldId;
  for (const [index, filter] of plan.filters.entries()) {
    if (filter.source === 'inherited') { filter.sourceText = null; continue; }
    const evidence = filter.evidenceText ?? filter.sourceText?.text;
    const grounded = evidence ? resolveSpan(message, evidence) : null;
    if (!grounded) return { ...rejected('clarification_required', 'unsupported_source_text'), clarification: { slotId: `filters.${index}`, choices: [] } };
    filter.evidenceText = grounded.text;
    filter.sourceText = grounded;
  }
  /*
   * Time provenance tolerance (decided for the live model, documented in docs/BIZTANIA_TRACK_B_UNIFIED_ROUTER.md):
   * the model resolves relative dates itself, so its ISO dates are the interpretation and its evidenceText only proves
   * the user mentioned a time. When that proof fails (a transcription slip beyond the fuzzy bound) or an `inherited`
   * time does not equal the prior state, the dates are still accepted IF they overlap the served availability window:
   * provenance becomes `generated` and the answer states the resolved range as the system's interpretation (dates outside
   * the window are clipped and listed as missing, exactly as for explicit dates). Dates entirely outside the window keep
   * the truthful refusal (with the available window), so nothing is answered without the resolved range being visible.
   */
  const asGenerated = (): boolean => {
    const window = options.availability;
    if (!plan.time || !window || !plan.time.dates.some(date => date >= window.min && date <= window.max)) return false;
    plan.time = { fieldId: plan.time.fieldId, timezone: plan.time.timezone, source: 'generated', dates: plan.time.dates };
    return true;
  };
  if (plan.time?.source === 'explicit') {
    const grounded = plan.time.evidenceText ? resolveSpan(message, plan.time.evidenceText) : null;
    if (grounded) plan.time.evidenceText = grounded.text;
    else if (!asGenerated()) return timeRejection({ ...rejected('clarification_required', 'unsupported_time_text'), clarification: { slotId: 'time', choices: [] } });
  }
  // `inherited` means "the prior state's dates": with a prior state the model's copy of them is restated from that state.
  if (plan.time?.source === 'inherited' && inheritedDates?.length && JSON.stringify(plan.time.dates) !== JSON.stringify(inheritedDates))
    plan.time = { ...plan.time, dates: [...inheritedDates] };
  if (plan.time?.source === 'inherited' && (!inheritedDates || JSON.stringify(plan.time.dates) !== JSON.stringify(inheritedDates)) && !asGenerated())
    return timeRejection(rejected('semantic_uncertainty', 'inherited_time_mismatch'));
  try { plan.time = resolveTime(plan.time, businessDate, 62).time; }
  catch { return timeRejection({ ...rejected('clarification_required', 'invalid_canonical_dates'), clarification: { slotId: 'time', choices: [] } }); }
  if (plan.aggregation === 'registered' && plan.time.dates.length === 1) {
    // A single date is not a grouping axis. The grain keeps 'date' when it is the only grain (it must stay non-empty).
    const grain = plan.grain.filter(id => id !== 'date');
    if (grain.length) plan.grain = grain;
    plan.group.fieldIds = plan.group.fieldIds.filter(id => id !== 'date');
  }
  return { outcome: 'normalized', plan };
}
