import { hasActionClaim, hasNumberWord, hasVagueQuantity, isUngroundedSafeProse } from '../../dynamic/response/conversational';
import { hasMalformedThai } from '../thai-orthography';

export { hasActionClaim, hasNumberWord, hasVagueQuantity };

export interface ModelTextSurfaceSpec {
  /** What MODEL-written text this surface carries. */
  readonly what: string;
  /** Repo-relative files that call `modelTextSafe('<surface>', ...)` on that text before it can reach the user (checked by tests/architecture). */
  readonly gatedIn: readonly string[];
  /** What the user sees instead when the gate blocks the text. */
  readonly fallback: string;
  /** Line breaks / tabs are legal (prose, questions, Email body); every other control character is always refused. */
  readonly multiline?: boolean;
}

/**
 * G6: THE registry of every surface where MODEL-written text can reach the user. None of them is ever the record of an executed effect (receipts
 * and effect text are server copy), so ONE gate (`modelTextSafe`: completion claims + Thai orthography + control characters) applies to all of
 * them. tests/architecture/model-text-surfaces.test.ts fails when an executor or renderer reads a raw model-text plan field outside a gate site.
 * MODEL output only, never user text.
 */
export const MODEL_TEXT_REGISTRY = {
  conversation: { what: 'conversation step prose (every topic except product_help)', gatedIn: ['lib/router/validate.ts', 'lib/router/render/respond.ts'],
    fallback: 'server capability / acknowledgement / out-of-scope copy', multiline: true },
  product_help: { what: 'product_help conversation prose', gatedIn: ['lib/router/validate.ts', 'lib/router/render/respond.ts'],
    fallback: 'server PRODUCT_MODEL copy', multiline: true },
  clarify: { what: 'clarify step question; the AI-authored question of an executor clarification (HR ambiguous employee)',
    gatedIn: ['lib/router/validate.ts', 'lib/router/render/safety.ts', 'lib/router/executors/shared.ts'], fallback: 'server slot / executor question template', multiline: true },
  follow_up: { what: 'plan.followUps chips', gatedIn: ['lib/router/render/safety.ts'], fallback: 'chip dropped (server suggestions when none remain)' },
  title: { what: 'plan.suggestedConversationTitle', gatedIn: ['lib/router/render/safety.ts'], fallback: 'server conversation title' },
  dashboard_title: { what: 'Dashboard titles: visualization plan title and generated dashboard.create title param',
    gatedIn: ['lib/router/validate.ts', 'lib/visualization/dashboard-spec.ts'],
    fallback: 'server title (dataset label; the base Dashboard title on refine)' },
  artifact_title: { what: 'generated artifact (Result) title', gatedIn: ['lib/router/validate.ts'], fallback: 'server title (Result type + answer label)' },
  visualization_text: { what: 'visualization plan description and widget titles', gatedIn: ['lib/visualization/dashboard-spec.ts'],
    fallback: 'empty description; widget title from the server measure label' },
  staged_text: { what: 'other generated free-text action params (rename titles, ticket/task note and checklist, Email subject/body)',
    gatedIn: ['lib/router/validate.ts'], fallback: 'param dropped: optional -> absent, Email -> server template, required name -> the user is asked', multiline: true },
  lookup_query: { what: 'resource_lookup name fragment echoed in the answer', gatedIn: ['lib/router/executors/resource-lookup.ts'], fallback: 'neutral wording without the echo' },
} as const satisfies Record<string, ModelTextSurfaceSpec>;
export type ModelTextSurface = keyof typeof MODEL_TEXT_REGISTRY;
export const MODEL_TEXT_SURFACES = Object.keys(MODEL_TEXT_REGISTRY) as ModelTextSurface[];

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const LINE_BREAKS = /[\t\n\r]/u;
/** The single gate for MODEL-written user-visible text on every registered surface: no completion claim, no malformed Thai, no control chars. */
export function modelTextSafe(surface: ModelTextSurface, text: string): boolean {
  const spec: ModelTextSurfaceSpec | undefined = Object.hasOwn(MODEL_TEXT_REGISTRY, surface) ? MODEL_TEXT_REGISTRY[surface] : undefined;
  if (!spec || typeof text !== 'string') return false;
  if (CONTROL_CHARS.test(text) || (!spec.multiline && LINE_BREAKS.test(text))) return false;
  // Follow-up chips are written in the USER's voice ("ขอดูยอดขายภาคตะวันออก"): the assistant-voice rule does not apply to them; every
  // completion / promise rule still does.
  return !hasMalformedThai(text) && !hasActionClaim(text, { assistantVoice: surface !== 'follow_up' });
}

/**
 * Output-safety checks on MODEL-written text only (clarify questions, conversation prose). These never see user text.
 * Numbers must come from evidence, so model prose may not spell them out either.
 */
export const CLARIFY_QUESTION_MAX_CHARS = 300;

/**
 * Conversation prose: no digits, number words, vague quantity claims, or catalog entity labels (it reads no data).
 * Minimal numeral allowance (decided for advice prose): ordered-list enumerators ("1) ... 2) ...") and tokens the server
 * itself put in the planner context (`allowedTokens`: the business date and the availability-window dates) are not data
 * claims and are removed before the digit check. Every other digit (any amount, count or percentage) still fails.
 */
export function isSafeConversationProse(prose: string, entityLabels: readonly string[], allowedTokens: readonly string[] = []): boolean {
  // Thai the parse-time repair could not fix (orphan / conflicting marks) is never shown: the caller uses server copy.
  if (hasMalformedThai(prose)) return false;
  let checked = prose;
  for (const token of [...allowedTokens].filter(t => t.length >= 4).sort((a, b) => b.length - a.length)) checked = checked.split(token).join(' ');
  checked = checked.replace(/(^|[\s:;,(])\d{1,2}[).](?=\s|$)/gu, '$1 ');
  return isUngroundedSafeProse(checked, entityLabels) && !hasNumberWord(checked) && !hasVagueQuantity(checked);
}

/** Follow-up question chip: short plain Thai text, no digits/number words/vague quantities, no entity labels, no markup or control chars. */
export const FOLLOW_UP_MAX_CHARS = 100;
export function isSafeFollowUp(text: string, entityLabels: readonly string[]): boolean {
  const value = text.trim();
  if (!value || value.length > FOLLOW_UP_MAX_CHARS || /[\u0000-\u001f\u007f<>`{}\[\]]/u.test(value) || /https?:|www\./iu.test(value)) return false;
  return modelTextSafe('follow_up', value) && isSafeConversationProse(value, entityLabels);
}

/** AI-authored conversation title: <=60 graphemes, plain text, no markup/URLs/control chars, no digits or entity labels. */
export const CONVERSATION_TITLE_MAX_GRAPHEMES = 60;
export function isSafeConversationTitle(text: string, entityLabels: readonly string[]): boolean {
  const value = text.trim();
  if (!value || [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(value)].length > CONVERSATION_TITLE_MAX_GRAPHEMES) return false;
  if (/[\u0000-\u001f\u007f<>`{}\[\]]/u.test(value) || /https?:|www\./iu.test(value)) return false;
  return modelTextSafe('title', value) && isSafeConversationProse(value, entityLabels);
}

/**
 * Clarify question: <=300 chars, no digits except tokens equal to an allowed choice id, no number words,
 * no entity label other than the labels of the allowed choices.
 */
export function isSafeClarificationText(
  text: string, allowedIds: readonly string[], allowedLabels: readonly string[], entityLabels: readonly string[],
): boolean {
  const question = text.trim();
  if (!question || question.length > CLARIFY_QUESTION_MAX_CHARS || hasMalformedThai(question) || !modelTextSafe('clarify', question)) return false;
  let stripped = question;
  for (const id of [...allowedIds].sort((a, b) => b.length - a.length)) if (id) stripped = stripped.split(id).join(' ');
  const allowed = new Set(allowedLabels.map(label => label.trim().toLocaleLowerCase()));
  const forbidden = entityLabels.filter(label => !allowed.has(label.trim().toLocaleLowerCase()));
  // Allowed choice labels are removed before the forbidden-label check.
  for (const label of [...allowedLabels].sort((a, b) => b.length - a.length)) if (label.trim()) stripped = stripped.split(label).join(' ');
  return isUngroundedSafeProse(stripped, forbidden) && !hasNumberWord(stripped);
}
