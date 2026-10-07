/**
 * Thai orthography repair for MODEL output only (never user text).
 *
 * The live model (qwen via the 9arm gateway) emits Thai with mark-order and duplicated-mark errors: a tone mark before an
 * upper vowel ("ท่ี" for "ที่"), the same mark twice ("ส่่ง", "ขั้้น"), a decomposed sara am, and sequences no reordering can
 * repair (a mark with no consonant base, two different tone marks, an upper and a lower vowel on one consonant).
 * `normalizeModelThai` fixes the repairable classes deterministically; `hasMalformedThai` detects the rest so the caller falls
 * back to server copy instead of showing broken text. Measured on the live gateway (G3 eval): temperature 0 garbles least,
 * temperature 0.7 garbles more, and the thinking switch makes no difference — the errors come from the model, not the settings.
 *
 * Wrong-but-well-formed spellings ("สืนค้า", "ได่", "ต่ากว่า") are valid sequences and cannot be detected mechanically.
 */

const THAI = /[\u0E00-\u0E7F]/u;
const CONSONANT = /[\u0E01-\u0E2E]/u;
/** Upper and lower vowel marks that sit on a consonant (sara am U+0E33 is spacing and is not one of them). */
const VOWEL_MARKS = new Set(['\u0E31', '\u0E34', '\u0E35', '\u0E36', '\u0E37', '\u0E38', '\u0E39', '\u0E3A']);
const MAITAIKHU = '\u0E47';
const TONE_MARKS = new Set(['\u0E48', '\u0E49', '\u0E4A', '\u0E4B']);
/** Thanthakhat, nikhahit, yamakkan: they follow the vowel and tone marks. */
const TRAILING_MARKS = new Set(['\u0E4C', '\u0E4D', '\u0E4E']);
const MARK_RUN = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+/gu;
const DECOMPOSED_SARA_AM = /\u0E4D\u0E32/gu;

function rank(mark: string): number {
  if (VOWEL_MARKS.has(mark)) return 0;
  if (mark === MAITAIKHU) return 1;
  if (TONE_MARKS.has(mark)) return 2;
  return 3;
}

/** Canonical order (vowel, maitaikhu, tone, trailing) with exact duplicates removed. Stable for marks of the same rank. */
function canonicalRun(run: string): string {
  const unique: string[] = [];
  for (const mark of run) if (!unique.includes(mark)) unique.push(mark);
  return unique.map((mark, index) => ({ mark, index })).sort((a, b) => rank(a.mark) - rank(b.mark) || a.index - b.index).map(m => m.mark).join('');
}

/**
 * At most this many repair sites per string. Live outputs with more (H2, R4, M1 of the v5 eval) were also full of well-formed
 * misspellings no rule can see, so such a string is left as it is and the gate below sends it to server copy.
 */
export const MAX_THAI_REPAIR_SITES = 2;

/** Number of places `normalizeModelThai` would change (decomposed sara am, out-of-order or duplicated mark runs). */
export function thaiRepairSites(text: string): number {
  if (!THAI.test(text)) return 0;
  const decomposed = [...text.matchAll(DECOMPOSED_SARA_AM)].length;
  const composed = text.replace(DECOMPOSED_SARA_AM, '\u0E33');
  return decomposed + [...composed.matchAll(MARK_RUN)].filter(match => canonicalRun(match[0]) !== match[0]).length;
}

/**
 * Reorders each run of combining marks into canonical order and collapses duplicated marks, when the string needs at most
 * MAX_THAI_REPAIR_SITES repairs; a more garbled string is returned unchanged (and then fails `hasMalformedThai`). MODEL output only.
 */
export function normalizeModelThai(text: string): string {
  if (!THAI.test(text) || thaiRepairSites(text) > MAX_THAI_REPAIR_SITES) return text;
  // A decomposed sara am ("ก้ําหนด") is composed first so its tone mark stays before it.
  return text.replace(DECOMPOSED_SARA_AM, '\u0E33').replace(MARK_RUN, run => canonicalRun(run));
}

/**
 * G5: well-formed but misspelled words the live model emits by DROPPING or swapping a mark (v6 eval: "ตองการ", "ผ้ใช้", "มชื่อ", "ต่ากว่า",
 * "ขั้นต่า"; v5: "แชร่", "ตีดตาม"), plus "ให" / "ใหม" with no tone mark (Thai has no such standalone words: ให้, ใหญ่, ใหล, ใหม่).
 * The raw gateway bytes are valid UTF-8 and equal the SDK string (tests/router/thai-utf8-transport.test.ts), so the corruption is the model's:
 * such text is never repaired by guesswork, it fails the gate and the caller shows server copy. MODEL output only, never user text.
 */
const KNOWN_MODEL_MISSPELLINGS = /ตองการ|ผ้ใช้|มช(?:\u0E37\u0E48|\u0E35)อ|ต่า(?=กว่า)|ขั้นต่า(?![\u0E00-\u0E7F])|แชร่|ตีดตาม|ให(?![\u0E48-\u0E4Bญมล])|ใหม(?![\u0E48-\u0E4B])/u;

/** True when the text holds a Thai mark sequence that is not canonical (after `normalizeModelThai`: one it could not or would not repair). MODEL output only. */
export function hasMalformedThai(text: string): boolean {
  if (!THAI.test(text)) return false;
  if (KNOWN_MODEL_MISSPELLINGS.test(text)) return true;
  if (text.includes('\u0E4D\u0E32')) return true;
  for (const match of text.matchAll(MARK_RUN)) {
    if (canonicalRun(match[0]) !== match[0]) return true;
    const base = match.index === 0 ? '' : text[match.index - 1]!;
    if (!CONSONANT.test(base)) return true;
    const marks = [...match[0]];
    const vowels = marks.filter(m => VOWEL_MARKS.has(m)).length;
    const tones = marks.filter(m => TONE_MARKS.has(m)).length;
    const maitaikhu = marks.filter(m => m === MAITAIKHU).length;
    if (vowels > 1 || tones > 1 || maitaikhu > 1 || (maitaikhu && (vowels || tones))) return true;
    if (marks.length !== new Set(marks).size) return true;
    if (marks.filter(m => TRAILING_MARKS.has(m)).length > 1) return true;
  }
  return false;
}

/** Keys whose string values are the model's COPY of user text (evidence spans): left untouched so they still match the user's message. */
const USER_TEXT_KEYS = new Set(['sourceText', 'evidenceText', 'evidenceFrom']);

/** Applies `normalizeModelThai` to every string of a parsed MODEL plan, except copies of user text. Never applied to user text. */
export function normalizeModelPlanThai(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return normalizeModelThai(value);
  if (depth > 24 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => normalizeModelPlanThai(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = USER_TEXT_KEYS.has(key) ? item : normalizeModelPlanThai(item, depth + 1);
  return out;
}
