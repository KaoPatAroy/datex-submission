/** Output-safety gate for model prose on turns the planner classified as not_query and that read no data.
 * It inspects MODEL output only (never user text): prose that cites a number or a catalog entity is not
 * grounded by any evidence, so the caller falls back to the canonical no-evidence text. */
export const CONVERSATIONAL_PROSE_MAX_CHARS = 600;
// Thai has no word boundaries, so common words that merely contain a number syllable are excluded
// (เรียบร้อย, สามารถ, ห้าม, เก้าอี้, พันธ์, สี่แยก ...). One shared gate for every model-output safety check.
const THAI_NUMBER_WORDS = /(?<!เรียบ)(?<!ผูก)(?<!เกี่ยว)(?:ศูนย์|หนึ่ง|สอง|สาม(?!ารถ|ัคคี|ัญ|ิ)|สี่(?!แยก)|ห้า(?!ม|ง)|หก|เจ็ด|แปด|เก้า(?!อี้)|สิบ|ร้อย|พัน(?!ธ)|หมื่น|แสน|ล้าน|เปอร์เซ็นต์)/u;
const ENGLISH_NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundreds?|thousands?|millions?|percent(?:age)?s?|per\s+cent)\b/iu;

/** Spelled-out numbers in MODEL output (numbers must come from evidence). Never applied to user text. */
export function hasNumberWord(text: string): boolean {
  return THAI_NUMBER_WORDS.test(text) || ENGLISH_NUMBER_WORDS.test(text);
}

// Vague quantity claims ("several branches", "หลายสาขา", "ส่วนใหญ่"): a data claim without a number, so evidence cannot back it.
// Quantifier + counted noun in either order, Thai or English. MODEL output only.
const THAI_QUANTIFIER = '(?:เกือบทั้งหมด|ทั้งหมด|ส่วนใหญ่|ส่วนมาก|หลายๆ|หลาย|บาง|ไม่กี่|เพียงไม่กี่)';
const THAI_COUNTED = '(?:คน|สาขา|รายการ|แห่ง|ร้าน|พนักงาน|ครั้ง|ชิ้น|ภูมิภาค|ภาค|เคส|ราย|บริษัท|ลูกค้า|ออเดอร์|คำสั่งซื้อ|สินค้า|แผนก|ทีม)';
const THAI_VAGUE_QUANTITY = new RegExp(`${THAI_QUANTIFIER}[\\s]*(?:ของ[\\s]*)?${THAI_COUNTED}|${THAI_COUNTED}[\\s]*${THAI_QUANTIFIER}`, 'u');
const ENGLISH_VAGUE_QUANTITY = /\b(?:several|many|most|few|numerous|multiple|majority|all|every|handful|lot|number|couple)\s+(?:of\s+)?(?:the\s+|our\s+|your\s+)?(?:[a-z-]+\s+){0,2}(?:people|persons?|employees?|staff|branch(?:es)?|stores?|items?|regions?|customers?|orders?|records?|results?|managers?|teams?|products?|departments?|cases?)\b/iu;

/** Vague quantity claims in MODEL conversation prose (it reads no data, so it may not claim any amount). Never applied to user text. */
export function hasVagueQuantity(text: string): boolean {
  return THAI_VAGUE_QUANTITY.test(text) || ENGLISH_VAGUE_QUANTITY.test(text);
}

// Action claims ("I'll pause the monitor", "the monitor has been deleted", "หยุดให้แล้ว"): conversation prose comes from a
// plan with no validated action step (a conversation step is always single-step), so any claim that an effect happened or
// will happen is false. Effect verbs x first-person future/done or passive-done forms, Thai and English. MODEL output only.
// Words that merely start with an effect stem are not effects: ตั้งใจ (intend), ส่งเสริม (promote), พักผ่อน (rest), ปิดบัง (conceal).
const THAI_EFFECT = '(?:หยุด|ระงับ|พัก(?!ผ่อน)|ลบ|ส่ง(?!เสริม)|สร้าง|แชร์|ยกเลิก|เพิกถอน|ตั้งค่า|ตั้ง(?!ใจ|แต่)|เปลี่ยนชื่อ|เปลี่ยน|แก้ไข|บันทึก|เปิดงาน|ปิด(?!บัง)|เปิดใช้|อนุมัติ)';
// A completed-effect phrase directly after a condition / sequence / future marker describes HOW something works ("หลังจากบันทึก ... เรียบร้อยแล้ว",
// "ถ้าสร้าง ... สำเร็จแล้ว", "จะเปลี่ยน ... ต่อเมื่อ ... สำเร็จแล้ว"), not that it happened. Subject + future claims ("ระบบจะส่ง") stay blocked below.
// G5: a relative clause ("Incident ที่แก้ไขแล้ว" = the resolved Incidents) describes an item; it does not report an effect.
const NOT_DESCRIBED = '(?<!(?:เมื่อ|หลังจาก|หลัง|หาก|ถ้า|จะ|ก่อน|ต่อเมื่อ|ที่)[\\s]*)';
const THAI_ACTION_CLAIM = new RegExp([
  `(?:ผม|ฉัน|ดิฉัน|ระบบ|เรา)[\\s]*(?:จะ|ได้|กำลัง|ขอ)[\\s]*(?:ทำการ|ดำเนินการ)?[\\s]*${THAI_EFFECT}`,
  `(?:ถูก|ได้รับการ)[\\s]*${THAI_EFFECT}`,
  `(?<!ยัง)(?<!ไม่)(?<!ไม่ได้)${NOT_DESCRIBED}${THAI_EFFECT}[^\\s]{0,24}(?:ให้)?(?:เรียบร้อย|สำเร็จ)?แล้ว`,
  // First-person effect ("ผมสร้าง Dashboard ...") and an effect completed later in the same line ("สร้าง Dashboard ให้เรียบร้อยแล้ว").
  `(?:ผม|ฉัน|ดิฉัน)[\\s]*(?:ได้)?[\\s]*${THAI_EFFECT}`,
  `(?<!ยัง)(?<!ไม่)(?<!ไม่ได้)${NOT_DESCRIBED}${THAI_EFFECT}[^\\n]{0,40}?(?:เรียบร้อย|สำเร็จ)แล้ว`,
].join('|'), 'u');
const ENGLISH_ACTION_CLAIM = /\b(?:i(?:['’]ll|['’]ve|['’]m going to| will| have| am going to)|we(?:['’]ll|['’]ve| will| have)|it(?:['’]s| has| was| will be)|(?:has|have|was|were) been)\s+(?:now\s+|already\s+|successfully\s+)?(?:paused|deleted|sent|created|shared|cancel(?:l)?ed|revoked|stopped|scheduled|renamed|saved|pause|delete|send|create|share|cancel|revoke|stop|schedule|rename|save)\b/iu;

// G4 FAIL-CLOSED completion vocabulary. Phrase-by-phrase patching did not converge, so ANY clause carrying a completion word
// blocks unless that clause carries a descriptive / conditional / future / modal marker. Over-blocking is acceptable (blocked
// prose falls back to server copy); a false completion claim is not. MODEL output only, never user text.
const EN_DONE = String.raw`(?:paused|resumed|deleted|removed|sent|created|shared|cancel(?:l)?ed|revoked|stopped|scheduled|renamed|saved|updated|changed|approved|submitted|completed|archived|applied|installed|published|delivered|recorded|stored|done|added|enabled|disabled|configured|generated|built|prepared|fixed|handled|processed|posted|exported|uploaded|moved|restored|assigned|notified|emailed|cleared|closed|resolved|finali[sz]ed|launched|activated|deactivated|confirmed|executed|finished|performed|carried\s+out|implemented|took\s+action|taken\s+action|set\s+up|taken\s+care\s+of)`;
// G5: first-person past doer verbs that are not effect participles ("I put together your dashboard", "I made the changes", "we got it sorted",
// "I took care of it") and readiness phrases ("up and running", "good to go", "ready to use", "live") are completion claims too.
const EN_FIRST_PERSON_DOER = String.raw`(?<=\b(?:i|we)(?:['’]ve|\s+have|\s+had)?\s+(?:(?:just|already|now|also|quickly|finally)\s+)?)(?:made|did|put\s+together|got|took\s+care\s+of|built|set\s+up|prepared|handled|fixed|sorted)`;
const EN_READINESS = String.raw`up-and-running|good\s+to\s+go|ready\s+(?:to|for)\s+use|live(?!\s+(?:ai|data|mode|demo|version)\b)`;
// Future promise of action ("I'll do it now", "Let me take care of that", "I'm going to pause it", "I can do that now"): conversation prose
// runs no effect, so a promise to perform one is false. Generic doer verbs need an object ("do it", not "do my best"); explaining, showing
// and helping are not effects here (G8 below blocks assistant voice outside its allowlist). Same G6 clause semantics as the completion words.
const EN_PROMISE_SUBJECT = String.raw`(?:i(?:['’]ll|\s+will|\s+shall|['’]m\s+going\s+to|\s+am\s+going\s+to|['’]m\s+gonna)|we(?:['’]ll|\s+will|['’]re\s+going\s+to|\s+are\s+going\s+to)|let\s+me)`;
const EN_PROMISE_VERB = String.raw`(?:do\s+(?:it|that|this|so|them)|handle|take\s+care\s+of|get\s+(?:it|that|this|them|everything)\s+(?:done|sorted|set\s+up)|sort\s+(?:it|that|this|them)|set\s+up|put\s+together|build|process|execute|apply|submit|pause|resume|delete|remove|send|create|share|cancel|revoke|stop|schedule|rename|save|update|change|approve|archive|publish|add|enable|disable|configure|generate|prepare|fix|post|export|upload|restore|assign|notify|email|close|resolve|finali[sz]e|launch|activate|deactivate|turn\s+(?:on|off)|pin|unpin|duplicate|proceed)`;
const EN_PROMISE = String.raw`${EN_PROMISE_SUBJECT}\s+(?:(?:just|now|also|quickly|immediately|right\s+away|go-ahead-and|get\s+started\s+and)\s+)*${EN_PROMISE_VERB}|i\s+can\s+(?:do|handle|take\s+care\s+of)\s+(?:that|it|this)(?:\s+for\s+you)?\s+(?:now|right\s+away|immediately)`;
const EN_COMPLETION = new RegExp(String.raw`\b(?:${EN_PROMISE}|${EN_FIRST_PERSON_DOER}|${EN_READINESS}|${EN_DONE}|ready(?!\s+to\s+(?:help|assist|answer|support|explain|chat)\b)|all\s+set|went\s+ahead|(?<!\b(?:a|an|more|most)\s)complete|in\s+place(?!\s+of)|live\s+now|now\s+live|went\s+live|(?:is|are)\s+live)\b`, 'giu');
// Negation that governs the completion word itself ("isn't ready yet", "haven't saved", "nothing has been created").
const EN_NEGATED = /(?:\b(?:not|never)\b|n['’]t)(?:\s+(?:yet|been|be|being|quite|fully|all|actually|really|completely))*\s*$|\b(?:nothing|no\s+[a-z]+)\s+(?:has|have|is|are|was|were)\s+(?:yet\s+)?(?:been\s+)?$/iu;
const EN_DESCRIPTIVE = /\b(?:if|when|whenever|once|after|before|until|unless|only|can|could|will|would|should|might|must|needs?|wants?|whether|how|then|in\s+case)\b|e\.g\./iu;
// G6: a marker exempts ONLY the words AFTER it up to its clause end; a completion word BEFORE it still blocks ("Your changes are saved if you
// want to check History."). One exception: a restrictive condition directly on the completion word ("saved only after you confirm") says when.
const EN_RESTRICTED = /^\s+(?:only|just)\s+(?:after|when|once|if|upon|until|by|while)\b/iu;
// G2: a descriptive marker exempts at most ITS OWN CLAUSE ("Your changes are saved, and you can check History." blocks on its first clause).
// Clause boundaries in MODEL output: punctuation segments, then coordinating conjunctions (English, and Thai ones joining clauses in mixed prose).
const CLAUSE_PUNCTUATION = /[,;:–—]+|\s+-\s+/u;
const CLAUSE_CONJUNCTION = /(?:^|\s+)(?:and|but|so|yet|then|และ|จากนั้น|แต่)\s+/iu;
// A segment that OPENS with a subordinator is one subordinate clause up to the next punctuation ("Once it is created and shared, ..."): exempt whole.
const EN_SUBORDINATE_SEGMENT = /^(?:(?:only|even|just)\s+)?(?:if|when|whenever|once|after|before|until|unless|whether|while|as soon as)\b/iu;
// List continuation ("Dashboards can be created, shared and deleted ..."): a clause that BEGINS with a participle, in a segment
// directly after an exempt segment that ENDS with a participle in the same sentence, continues that description.
const EN_LEADING_PARTICIPLE = new RegExp(String.raw`^(?:also\s+)?${EN_DONE}\b`, 'iu');
const EN_TRAILING_PARTICIPLE = new RegExp(String.raw`\b${EN_DONE}$`, 'iu');

/** A completion word no marker governs: before the clause's first marker, not negated, not restricted ("only after ..."). */
function hasUnnegatedEnglishCompletion(clause: string): boolean {
  const marker = clause.search(EN_DESCRIPTIVE);
  for (const match of clause.matchAll(EN_COMPLETION)) {
    if (marker >= 0 && match.index >= marker) continue;
    if (EN_RESTRICTED.test(clause.slice(match.index + match[0].length))) continue;
    if (!EN_NEGATED.test(clause.slice(0, match.index))) return true;
  }
  return false;
}

function hasEnglishCompletionClaim(input: string): boolean {
  // "up and running" is one readiness phrase, not two clauses joined by "and".
  // Likewise "go ahead and <verb>" is one promise ("I'll go ahead and send it"), not a clause boundary.
  const text = input.replace(/\bup\s+and\s+running\b/giu,'up-and-running').replace(/\bgo\s+ahead\s+and\b/giu,'go-ahead-and');
  for (const sentence of text.split(/[.!?\r\n]+/u).map(part => part.trim()).filter(Boolean)) {
    let listContinues = false;
    for (const segment of sentence.split(CLAUSE_PUNCTUATION).map(part => part.trim()).filter(Boolean)) {
      const subordinate = EN_SUBORDINATE_SEGMENT.test(segment);
      let lastExempt = false;
      for (const clause of segment.split(CLAUSE_CONJUNCTION).map(part => part.trim()).filter(Boolean)) {
        const exempt: boolean = subordinate || (listContinues && EN_LEADING_PARTICIPLE.test(clause));
        if (!exempt && hasUnnegatedEnglishCompletion(clause)) return true;
        lastExempt = exempt || EN_DESCRIPTIVE.test(clause);
      }
      listContinues = lastExempt && EN_TRAILING_PARTICIPLE.test(segment);
    }
  }
  return false;
}

// Thai FAIL-CLOSED completion gate. Clauses: punctuation, then whitespace BETWEEN Thai characters (spaces around Latin words such as
// "Dashboard" stay inside the clause). A completion marker blocks unless a conditional / future / advisory marker precedes it in its clause:
//  - เรียบร้อย / เสร็จ / สำเร็จ always (standalone "เรียบร้อยครับ", "เสร็จแล้วค่ะ", "ระบบจัดการเรียบร้อย");
//  - แล้ว (not "then": แล้วค่อย / แล้วจึง / แล้วก็ ...) when an effect verb or a generic doer verb (ดำเนินการ, จัดการ, ทำ, ตั้ง, เตรียม ...) precedes it.
const THAI_CLAUSE_BREAK = /[.!?\r\n,;:–—]+|\s+-\s+|(?<=[฀-๿])\s+(?=[฀-๿])/u;
const THAI_STRONG_DONE = /(?<!ความ)(?<!ไม่)(?:เรียบร้อย|เสร็จ|สำเร็จ(?!รูป))/gu;
const THAI_ALREADY = /แล้ว(?!ค่อย|จึง|ก็|ไป|ถึง|ต่อ|แต่|หรือ)/gu;
// G5: "ให้แล้ว" (done for you) and "(ใช้งาน|พร้อม|เปิด|ใช้)ได้แล้ว" (usable now) block on their own, with no doer verb ("จัดให้แล้วครับ",
// "Dashboard ใช้งานได้แล้วครับ"), unless a conditional / future marker governs the clause.
const THAI_DONE_FOR_YOU = /(?:ให้|(?:ใช้งาน|พร้อม|เปิด|ใช้)ได้)แล้ว(?!ค่อย|จึง|ก็|ไป|ถึง|ต่อ|แต่|หรือ)/gu;
const THAI_DOER = new RegExp(`(?<!ยัง)(?<!ไม่)(?<!ไม่ได้)(?<!ที่)(?:${THAI_EFFECT}|ดำเนินการ|จัดการ|ทำ(?!ไม)|เตรียม|เพิ่ม|อัปเดต|ปรับ|เก็บ|ยืนยัน|แจ้ง|ย้าย|ใส่|พร้อม)`, 'u');
// Future promise of action ("เดี๋ยวจัดการให้ครับ", "จะดำเนินการให้เลยครับ", "ขอดำเนินการให้"): no effect ran, so the promise is false. Only a
// condition earlier in the SAME clause exempts it ("ถ้ายืนยันจะจัดการให้"); a condition in a sibling clause does not (G6). "จะทำให้" is
// also "will cause" ("จะทำให้ยอดขายเพิ่ม"), so it is a promise only when it ends the phrase ("จะทำให้เลยครับ").
const THAI_PROMISE = new RegExp(`เดี๋ยว[\\s]*(?:ผม|ฉัน|ดิฉัน|เรา)?[\\s]*(?:จะ)?[\\s]*(?:ทำ(?!ไม)|จัดการ|ดำเนินการ|${THAI_EFFECT})|ขอ[\\s]*(?:ดำเนินการ|จัดการ)[\\s]*ให้|จะ[\\s]*(?:จัดการ|ดำเนินการ)[\\s]*ให้|จะ[\\s]*ทำให้(?=[\\s]*(?:เลย|ทันที|เดี๋ยวนี้|ตอนนี้|นะ|ครับ|ค่ะ|คะ|$))`, 'gu');
const THAI_CONDITION = /เมื่อ(?!วาน|กี้|เช้า|คืน|สักครู่|ครู่)|หลังจาก|หาก|ถ้า|ต่อเมื่อ/u;
const THAI_EXEMPT = /(?:เมื่อ(?!วาน|กี้|เช้า|คืน|สักครู่|ครู่)|หลังจาก|หาก|ถ้า|จะ|ต่อเมื่อ|ควร|กรุณา|โปรด|(?<!ถูก)ต้อง|สามารถ|แนะนำ)|^(?:ก่อน|หลัง)/u;

function hasThaiCompletionClaim(text: string): boolean {
  for (const clause of text.split(THAI_CLAUSE_BREAK).map(part => part.trim()).filter(Boolean)) {
    for (const match of clause.matchAll(THAI_STRONG_DONE)) {
      if (!THAI_EXEMPT.test(clause.slice(0, match.index))) return true;
    }
    for (const match of clause.matchAll(THAI_PROMISE)) {
      if (!THAI_CONDITION.test(clause.slice(0, match.index))) return true;
    }
    for (const match of clause.matchAll(THAI_DONE_FOR_YOU)) {
      if (!THAI_EXEMPT.test(clause.slice(0, match.index))) return true;
    }
    for (const match of clause.matchAll(THAI_ALREADY)) {
      const before = clause.slice(0, match.index);
      if (THAI_DOER.test(before) && !THAI_EXEMPT.test(before)) return true;
    }
  }
  return false;
}

// G7 FAIL-CLOSED promise gate (lead decision, ends verb-by-verb patching): model text is never the record of an executed effect, so EVERY
// first-person / assistant-voice commitment to future action blocks, whatever the verb and whatever condition precedes it. Exempt only:
// explanatory self-reference (G8 below narrows this to an exact allowlist) that commits to nothing outside the reply (explain / summarize / answer / clarify, "let me know"), negation
// ("I will not"), and questions ("Shall I ...?", "Would you like me to ...?", "ต้องการให้...ไหมครับ"). Over-blocking falls back to server copy.
const EN_PROMISE_OPENER = /\b(?:i(?:['’]ll|\s+will|\s+shall|['’]m\s+going\s+to|\s+am\s+going\s+to|['’]m\s+gonna|\s+am\s+gonna)|we(?:['’]ll|\s+will|\s+shall|['’]re\s+going\s+to|\s+are\s+going\s+to|['’]re\s+gonna)|let\s+me)\s+/giu;
const EN_CAN_FOR_YOU = /\bi\s+can\s+((?:[a-z’'-]+\s+){1,8}?)for\s+you\b/giu;
const EN_CAN_DO = /\b(?:i|we)\s+can\s+(?:also\s+|now\s+|quickly\s+|certainly\s+|definitely\s+)*(.+)$/giu;
// Fail closed: ANY "I/we can <verb>" offer blocks unless the verb only explains within this reply (allowlist), mirroring the G7 promise gate.
const EN_CAN_EXPLAIN = /^(?:help\s+(?:you\s+)?(?:understand|explain|compare|think|decide|interpret|read|learn)|explain|answer|clarify|summari[sz]e|describe|tell\s+you|walk\s+you\s+through|show\s+you\s+how|compare|help\s+with\s+(?:questions|understanding))\b/iu;
// An allowlisted explanation that goes on to a coordinated effect ("I can explain the options and send you the report") still offers the effect.
// Fail closed: an effect verb ANYWHERE after the allowlisted explanation ("and will send", "then I'll share", "plus send") still offers it.
const EN_CAN_COORDINATED = new RegExp(String.raw`\s${EN_PROMISE_VERB}\b`, 'iu');
const EN_CAN_ACTION = { test: (verb: string) => /^[a-z]/iu.test(verb) && !/^(?:not|never|only)\b/iu.test(verb) && (!EN_CAN_EXPLAIN.test(verb) || EN_CAN_COORDINATED.test(verb)) };
// Adverbs and "be happy to"-style softeners between the opener and the verb; the verb after them decides.
const EN_PROMISE_SOFTENER = /^(?:(?:just|now|also|first|then|quickly|briefly|simply|happily|gladly|certainly|definitely|personally|go-ahead-and|right\s+(?:now|away)|do\s+(?:my|our)\s+best\s+to|try\s+to|be\s+(?:happy|glad)\s+to|[a-z]+ly)\s+)+/iu;
const EN_PROMISE_EXEMPT = /^(?:not|never|explain|summari[sz]e|answer|clarify)\b/iu;
const EN_LET_ME_EXEMPT = /^know\b/iu;
// An explanatory opener that goes on to a coordinated effect ("I'll explain the steps and send the report") still promises the effect.
const EN_COORDINATED_EFFECT = new RegExp(String.raw`\s${EN_PROMISE_VERB}\b`, 'iu');
const EN_QUESTION_OPENER = /^(?:shall|should|would|could|can|do|does|did|is|are|will|want|what|which|who|whom|when|where|how|why)\b/iu;

function hasEnglishPromise(input: string): boolean {
  const text = input.replace(/\bgo\s+ahead\s+and\b/giu, 'go-ahead-and');
  for (const raw of text.split(/(?<=[.!?])\s+|[\r\n]+/u)) {
    const sentence = raw.trim();
    if (!sentence || (sentence.endsWith('?') && EN_QUESTION_OPENER.test(sentence))) continue;
    for (const match of sentence.matchAll(EN_PROMISE_OPENER)) {
      const rest = sentence.slice(match.index + match[0].length);
      const verb = rest.replace(EN_PROMISE_SOFTENER, '');
      if (/^let/iu.test(match[0]) && EN_LET_ME_EXEMPT.test(verb)) continue;
      if (!verb || /^[^a-z]/iu.test(verb)) continue;
      if (!EN_PROMISE_EXEMPT.test(verb) || (!/^(?:not|never)\b/iu.test(verb) && EN_COORDINATED_EFFECT.test(verb))) return true;
    }
    // "I can check that" / "We can look into it": an assistant offer of an action no step will run blocks (capability talk such as
    // "I can help you understand ..." stays allowed because "help"/"explain" are not action verbs here).
    for (const match of sentence.matchAll(EN_CAN_DO)) {
      const verb = match[1].replace(EN_PROMISE_SOFTENER, '');
      if (EN_CAN_ACTION.test(verb)) return true;
    }
    for (const match of sentence.matchAll(EN_CAN_FOR_YOU)) {
      const verb = match[1].replace(EN_PROMISE_SOFTENER, '');
      if (!EN_PROMISE_EXEMPT.test(verb) || EN_COORDINATED_EFFECT.test(verb)) return true;
    }
  }
  return false;
}

// Thai: a future / offer marker (จะ, กำลังจะ, เดี๋ยว, ขอ) in assistant voice = led by a first-person pronoun, or with no subject before it in its
// clause (only discourse words such as รับทราบ / ได้ครับ / ตอนนี้, or a bare condition such as "ถ้าคุณยืนยัน"). A non-assistant subject before the
// marker ("Dashboard จะดึงข้อมูลใหม่", "ระบบจะขอให้คุณยืนยันก่อน", "คุณจะเห็น") is product description and passes here.
const TH_PROMISE_MARKER = /กำลังจะ|จะ|เดี๋ยว|ขอ/gu;
const TH_PRONOUN_BEFORE = /(?:ผม|ฉัน|ดิฉัน|เรา|หนู)(?:เอง)?[\s]*(?:ก็|นั้น)?[\s]*(?:เดี๋ยว)?[\s]*$/u;
const TH_NO_SUBJECT = /^(?:[\s]|รับทราบ|เข้าใจแล้ว|ได้เลย|ได้|โอเค|ok|okay|sure|ยินดี|ครับผม|ครับ|ค่ะ|คะ|นะ|จ้ะ|จ้า|ตอนนี้|เดี๋ยวนี้|ทันที|งั้น|ถ้าอย่างนั้น|ต่อไป|แล้ว|ก็|เลย)*$/iu;
// A bare condition with no named product subject ("ถ้าคุณยืนยัน", "หากต้องการ") leaves the main clause subjectless: assistant voice when the
// verb phrase is done FOR the user ("ถ้าคุณยืนยันจะจัดการให้"), product description otherwise ("เมื่อเปิดจะดึงข้อมูลใหม่").
const TH_BARE_CONDITION = /^(?:ถ้า|หาก|เมื่อ(?!วาน|กี้|เช้า|คืน)|พอ|หลังจาก|ต่อเมื่อ)(?![^]*(?:[A-Za-z]|ระบบ|แดชบอร์ด|รายงาน|การแจ้งเตือน))/u;
const TH_FOR_USER = /^[^\s]{0,30}?(?:ให้|เลย|ทันที)/u;
const TH_EXPLAIN = 'อธิบาย|สรุป|ตอบ|ชี้แจง';
// Words after จะ that describe, not act ("จะเห็นว่า", "จะได้รับ", "จะเป็น", "จะมี", "จะไม่"); "จะทำให้" = "will cause" unless it ends the phrase.
const TH_JA_EXEMPT = new RegExp(`^(?:ไม่|ยัง|เห็น|ได้|เป็น|มี|ต้อง|อยู่|คล้าย|ขึ้นอยู่|สามารถ|${TH_EXPLAIN}|ทำให้(?![\\s]*(?:เลย|ทันที|เดี๋ยวนี้|ตอนนี้|นะ|ครับ|ค่ะ|คะ|$)))`, 'u');
const TH_DEAW_EXEMPT = new RegExp(`^(?:นี้|ก่อน|นะ|คุณ|${TH_EXPLAIN})`, 'u');
// ขอ: apology / thanks / scope / asking the user / advice ("ขออภัย", "ขอบคุณ", "ขอให้ระบุ", "ขอทราบ", "ขอแนะนำ") commit to no action.
const TH_KHO_EXEMPT = new RegExp(`^(?:อภัย|โทษ|บ|ให้|ทราบ|ถาม|ข้อมูล|รายละเอียด|แนะนำ|ความ|ยืนยันว่า|${TH_EXPLAIN})`, 'u');
// Subjectless ขอ is also how user-voice follow-up chips start ("ขอดูยอดขาย"), so it is a promise only with a benefactive ให้ ("ขอจัดการให้เลย").
const TH_KHO_FOR_YOU = /^[^\s]{1,30}?ให้(?=[\s]*(?:เลย|ทันที|นะ|ครับ|ค่ะ|คะ|คุณ|$))/u;
const TH_QUESTION = /ไหม|มั้ย|หรือไม่|หรือเปล่า|หรือยัง|ใคร(?!ก็)|อะไร(?!ก็)|ไหน(?!ก็)|เมื่อไร(?!ก็)|เมื่อไหร่(?!ก็)|อย่างไร(?!ก็)|ยังไง(?!ก็)|เท่าไร(?!ก็)|เท่าไหร่(?!ก็)|กี่|ใด(?![\s]*ๆ)/u;

function hasThaiPromise(text: string): boolean {
  for (const clause of text.split(THAI_CLAUSE_BREAK).map(part => part.trim()).filter(Boolean)) {
    if (TH_QUESTION.test(clause)) continue;
    for (const match of clause.matchAll(TH_PROMISE_MARKER)) {
      const before = clause.slice(0, match.index);
      const pronounLed = TH_PRONOUN_BEFORE.test(before);
      const bareCondition = !pronounLed && !TH_NO_SUBJECT.test(before) && TH_BARE_CONDITION.test(before.trim());
      if (!pronounLed && !bareCondition && !TH_NO_SUBJECT.test(before)) continue;
      const after = clause.slice(match.index + match[0].length).replace(/^[\s]*(?:(?:ผม|ฉัน|ดิฉัน|เรา|หนู)[\s]*)?(?:จะ)?[\s]*/u, '');
      if (!after || (bareCondition && !TH_FOR_USER.test(after))) continue;
      if (match[0] === 'ขอ') {
        if (TH_KHO_EXEMPT.test(after)) continue;
        if (pronounLed || TH_KHO_FOR_YOU.test(after)) return true;
        continue;
      }
      if ((match[0] === 'เดี๋ยว' ? TH_DEAW_EXEMPT : TH_JA_EXEMPT).test(after)) continue;
      return true;
    }
  }
  return false;
}

// G8 FAIL-CLOSED assistant voice (lead decision, ends verb-list patching): model text is never the record of an executed effect, so ANY
// sentence whose subject is the assistant blocks, whatever the verb (I / we / let me / let's; ผม / ฉัน / ดิฉัน / หนู / เรา; a subjectless
// clause led by จะ / เดี๋ยว / ขอ). Exempt only questions and a small EXACT allowlist of whole-sentence explanation / limitation forms with
// nothing after the explanation's object (no second clause, no and / then / และ / แล้ว / จากนั้น continuation). Over-blocking falls back
// to server copy; the completion and promise rules above still apply to every sentence. MODEL output only, never user text.
const EN_ASSISTANT_SUBJECT = /(?<![\p{L}\p{N}'’])(?:i(?:['’](?:m|ve|ll|d))?|we(?:['’](?:re|ve|ll|d))?|let['’]s|let\s+me)(?![\p{L}\p{N}'’-])(?!\.\p{L}\.)/giu;
const EN_INTERJECTION = /^(?:(?:sorry|okay|ok|sure|unfortunately|got\s+it|understood|thanks|thank\s+you|of\s+course|certainly|no\s+problem|hi|hello|yes|no)\b[\s,!–—-]*)+/iu;
const EN_ALLOWED_VOICE = /^(?:(?:i\s+can|let\s+me)\s+explain|i\s+can\s+summari[sz]e|i(?:['’]m|\s+am)\s+not\s+sure|i\s+(?:don['’]t|do\s+not)\s+have\b(?=.*\b(?:access|data)\b)|i\s+can['’]t|i\s+cannot)\b/iu;
// Continuation after the allowlisted head: clause punctuation, a sequencing conjunction, or and/or that does not just join noun phrases
// ("the options and the steps", "a Result and a Dashboard" stay; "and carry out", "and take action" block).
const EN_CONTINUATION = /[,;:–—]|\s-\s|\b(?:then|but|so|plus|also|after|afterwards|before|once|while|later|next|meanwhile|until)\b|\b(?:and|or)\s+(?!(?:a|an|the|its|their|your|this|that|these|those|other|each|every|any)\b|\p{Lu})/u;
const TH_PRONOUN = /(?<!(?:ของ|ให้|กับ|แก่|ถึง|จาก|ต่อ|บอก|ถาม|แจ้ง|ทีม|บริษัท)[\s]*)(?<!ครับ)(?:ดิฉัน|ฉัน(?!ท์)|ผม|หนู|เรา(?!ะ))/u;
const TH_LEAD_PRONOUN = /^(?:ดิฉัน|ฉัน|ผม|หนู|เรา)(?:เอง)?[\s]*/u;
const TH_PARTICLES = '(?:[\\s]*(?:ครับ|ค่ะ|คะ|นะ|จ้ะ|จ้า|ฮะ|ผม))*';
const TH_QUESTION_END = new RegExp(`(?:(?:ไหม|มั้ย|หรือไม่|หรือเปล่า)${TH_PARTICLES}[\\s?]*|\\?[\\s]*)$`, 'u');
const TH_CONTINUATION = /และ|แล้ว|จากนั้น|พร้อม|ต่อ(?:ไป|จาก)|ก่อน|หลัง|ด้วย|ทั้ง/u;
const TH_ALLOWED_VOICE = [
  new RegExp(`^อธิบาย(?<rest>[^]*?)ได้${TH_PARTICLES}$`, 'u'),
  /^ขออธิบาย(?<rest>[^]*)$/u,
  /^(?:ยัง)?ไม่แน่ใจ(?<rest>[^]*)$/u,
  /^(?:ยัง)?ไม่มีข้อมูล(?<rest>[^]*)$/u,
];
const TH_DISCOURSE_WORDS = '(?:[\\s]|รับทราบ|เข้าใจแล้ว|ได้เลย|ได้|โอเค|ok|okay|sure|ยินดี|ครับผม|ครับ|ค่ะ|คะ|นะ|จ้ะ|จ้า|ตอนนี้|ทันที|งั้น|ถ้าอย่างนั้น|ต่อไป|แล้ว|ก็|เลย)*';
const TH_DISCOURSE = new RegExp(`^${TH_DISCOURSE_WORDS}`, 'iu');
const TH_SUBJECTLESS_LEAD = /^(?:กำลังจะ|จะ|เดี๋ยว(?!นี้)|ขอ(?!อภัย|โทษ|บ|ให้|ทราบ|ถาม|ข้อมูล|รายละเอียด|ความ(?:กรุณา|ร่วมมือ)|ยืนยันว่า))/u;
// A จะ / เดี๋ยว / ขอ unit is subjectless when it opens its line or follows a finished unit (particle-ended or discourse only); after a bare
// noun phrase ("Dashboard นี้ จะดึง...") the subject is in the previous unit and the promise rules above decide.
const TH_UNIT_ENDED = new RegExp(`(?:ครับ|ค่ะ|คะ|นะ|จ้ะ|จ้า)$|^${TH_DISCOURSE_WORDS}$`, 'iu');

function isAllowedThaiVoice(unit: string, next: string | undefined): boolean {
  const body = unit.replace(TH_LEAD_PRONOUN, '');
  const allowed = TH_ALLOWED_VOICE.some(form => {
    const match = form.exec(body);
    return !!match && (form !== TH_ALLOWED_VOICE[0] || body !== unit) && !TH_CONTINUATION.test(match.groups?.rest ?? '');
  });
  return allowed && !(next && /^(?:และ|แล้ว|จากนั้น|ต่อจากนั้น|พร้อม|ก็|ทั้ง|and|then)/iu.test(next));
}

export function hasAssistantVoice(text: string): boolean {
  for (const line of text.split(/[\r\n]+/u)) {
    const units = line.split(/(?<=[.!?])\s+|(?<=[฀-๿])\s+(?=[฀-๿])/u).map(part => part.trim()).filter(Boolean);
    for (const [index, unit] of units.entries()) {
      const subjects = [...unit.matchAll(EN_ASSISTANT_SUBJECT)];
      if (subjects.length) {
        const head = unit.replace(EN_INTERJECTION, '');
        const lastClause = unit.length - (unit.split(CLAUSE_PUNCTUATION).pop() ?? '').length;
        const question = unit.endsWith('?') && (EN_QUESTION_OPENER.test(head) || subjects.every(match => match.index >= lastClause));
        const allowedHead = EN_ALLOWED_VOICE.exec(head);
        const allowed = subjects.length === 1 && !!allowedHead && !EN_CONTINUATION.test(head.slice(allowedHead[0].length).replace(/[.!]+$/u, ''));
        if (!question && !allowed) return true;
      }
      // A Thai question needs no "?": a question word (ใคร / อะไร / ไหน / กี่ ...) marks it, unless the unit also states completion.
      if (TH_QUESTION_END.test(unit) || (TH_QUESTION.test(unit) && !/แล้ว|เรียบร้อย|สำเร็จ|เสร็จ/u.test(unit))) continue;
      const pronoun = TH_PRONOUN.exec(unit);
      if (pronoun && !(pronoun.index === 0 && isAllowedThaiVoice(unit, units[index + 1]))) return true;
      const lead = unit.replace(TH_DISCOURSE, '');
      if (TH_SUBJECTLESS_LEAD.test(lead) && (index === 0 || TH_UNIT_ENDED.test(units[index - 1]) || lead !== unit)
        && !isAllowedThaiVoice(lead, units[index + 1])) return true;
    }
  }
  return false;
}

/** Claims in MODEL conversation prose that an effect was or will be performed. Never applied to user text. */
// Future effect in third person ("Your dashboard will be updated shortly", "Dashboard จะถูกอัปเดตเร็ว ๆ นี้") promises an effect no step ran,
// unless the same sentence states the condition it depends on (if / when / once / after ...; ถ้า / หาก / เมื่อ / หลังจาก / ทุกครั้ง ...).
const EN_FUTURE_EFFECT = new RegExp(String.raw`\b(?:will|['’]ll|is\s+going\s+to|are\s+going\s+to|is\s+about\s+to|are\s+about\s+to)\s+(?:(?:now|soon|shortly|automatically|then)\s+)?(?:be|get)\s+(?:(?:now|soon|shortly|automatically)\s+)?${EN_DONE}\b`, 'iu');
const EN_FUTURE_CONDITION = /\b(?:if|when|whenever|once|after|before|until|unless|only|each\s+time|every\s+time|upon)\b/iu;
const TH_FUTURE_EFFECT = new RegExp(String.raw`จะ(?:ถูก|ได้รับการ)\s*(?:${THAI_EFFECT}|อัปเดต|ปรับ|ดำเนินการ|จัดการ)`, 'u');
const TH_FUTURE_CONDITION = /ถ้า|หาก|เมื่อ(?!วาน)|หลังจาก|ทุกครั้ง|ต่อเมื่อ|ก่อน/u;
// Active form too ("Your dashboard will update shortly", "The report will send to your team").
const EN_FUTURE_ACTIVE = new RegExp(String.raw`\b(?:will|['’]ll|is\s+going\s+to|are\s+going\s+to|is\s+about\s+to|are\s+about\s+to)\s+(?:(?:now|soon|shortly|automatically|then|immediately)\s+)?(?:${EN_PROMISE_VERB}|refresh|sync|reload|go\s+out|arrive|appear|change|update)\b`, 'iu');
const EN_FUTURE_CADENCE = /\b(?:daily|weekly|hourly|every|each|whenever|per\s+(?:day|week))\b/iu;
const TH_FUTURE_ACTIVE = new RegExp(String.raw`จะ\s*(?:อัปเดต|ปรับ|ส่ง(?!เสริม)|ถูกส่ง|แชร์|สร้าง|ลบ|เปลี่ยน|บันทึก|ดำเนินการ|รีเฟรช)`, 'u');
function hasFutureEffect(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|[\r\n]+/u).some(sentence => {
    const trimmed = sentence.trim();
    // A real question about a future effect ("Will it update daily?", "จะส่งให้ใครครับ") promises nothing; an assertive tag question
    // ("Your dashboard will update shortly, okay?") is still a promise, so English needs a question opener.
    const thai = /[฀-๿]/u.test(trimmed);
    if ((trimmed.endsWith('?') && EN_QUESTION_OPENER.test(trimmed)) || (thai && TH_QUESTION_END.test(trimmed))
      || (thai && TH_QUESTION.test(trimmed) && !/แล้ว|เรียบร้อย|สำเร็จ|เสร็จ/u.test(trimmed))) return false;
    // The condition / cadence must govern the SAME clause as the promised effect ("will update shortly, and it refreshes daily" blocks).
    const clauses = trimmed.split(CLAUSE_PUNCTUATION).flatMap(part => part.split(CLAUSE_CONJUNCTION)).map(part => part.trim()).filter(Boolean);
    return clauses.some(clause => {
      const enCondition = EN_FUTURE_CONDITION.test(clause) || EN_FUTURE_CADENCE.test(clause);
      const thCondition = TH_FUTURE_CONDITION.test(clause) || /ทุกวัน|ทุกสัปดาห์|ทุกชั่วโมง|ตามรอบ/u.test(clause);
      return ((EN_FUTURE_EFFECT.test(clause) || EN_FUTURE_ACTIVE.test(clause)) && !enCondition)
        || ((TH_FUTURE_EFFECT.test(clause) || TH_FUTURE_ACTIVE.test(clause)) && !thCondition);
    });
  });
}

export function hasActionClaim(text: string, options: { assistantVoice?: boolean } = {}): boolean {
  return hasFutureEffect(text) || THAI_ACTION_CLAIM.test(text) || ENGLISH_ACTION_CLAIM.test(text) || hasThaiCompletionClaim(text) || hasEnglishCompletionClaim(text)
    || hasEnglishPromise(text) || hasThaiPromise(text) || (options.assistantVoice !== false && hasAssistantVoice(text));
}

export function isUngroundedSafeProse(text: string, entityLabels: readonly string[]): boolean {
  const prose = text.trim();
  if (!prose || prose.length > CONVERSATIONAL_PROSE_MAX_CHARS || /\p{N}/u.test(prose) || hasNumberWord(prose)) return false;
  const lower = prose.toLocaleLowerCase();
  return !entityLabels.some(raw => {
    const label = raw.trim().toLocaleLowerCase();
    if (label.length < 2) return false;
    if (!/^[a-z0-9 ]+$/u.test(label)) return lower.includes(label);
    // Latin labels match whole tokens only ("east" must not match "least").
    for (let at = lower.indexOf(label); at >= 0; at = lower.indexOf(label, at + 1)) {
      const before = lower[at - 1], after = lower[at + label.length];
      if (!(before && /[a-z0-9]/u.test(before)) && !(after && /[a-z0-9]/u.test(after))) return true;
    }
    return false;
  });
}

/** Repeated model greetings are not useful turn content after the conversation has started. */
export function isGreetingProse(text: string): boolean {
  const prose = text.trim();
  return prose.startsWith('สวัสดี') || /^hello(?:[\s,!?.]|$)/iu.test(prose);
}

/** Each label is advertised only when the actor holds one of its exact tool names. */
export const CAPABILITY_AREAS: ReadonlyArray<{ tools: readonly string[]; label: string }> = [
  { tools: ['sales.query_metrics'], label: 'ยอดขายและเป้าหมายตามสาขาหรือภูมิภาค' },
  { tools: ['operations.query_inventory'], label: 'สต็อกหน้าร้าน' },
  { tools: ['incidents.search'], label: 'เหตุการณ์หน้าร้าน' },
  { tools: ['staffing.get_summary'], label: 'กำลังคนหน้าร้าน' },
  { tools: ['hr.find_employee'], label: 'ข้อมูลพนักงาน' },
  { tools: ['workflow.manager_queue', 'workflow.director_queue', 'workflow.director_approvals_today', 'workflow.director_start_dates',
    'workflow.director_request_documents', 'workflow.onboarding_ready_for_start'], label: 'คิวงานและการอนุมัติ' },
  { tools: ['dashboard.prepare_create', 'dashboard.prepare_share'], label: 'การเตรียม Dashboard ให้ตรวจก่อนยืนยัน' },
  { tools: ['ticket.prepare_create'], label: 'การเตรียม Ticket ให้ตรวจก่อนยืนยัน' },
  { tools: ['badge.prepare_revoke'], label: 'การเตรียมคำขอเพิกถอนบัตรให้ตรวจก่อนยืนยัน' },
];

/** Server-owned capability reply based only on authorized tool names (never user text). */
function joinThai(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} และ ${items[items.length - 1]}`;
}

/** Fixed, server-owned limits statement: no digits, entity names, or per-account data. */
const CAPABILITY_LIMITS = [
  'ขอบเขตการทำงาน:',
  '• อ่านได้เฉพาะข้อมูลธุรกิจตัวอย่างภายในสิทธิ์ของบัญชีนี้',
  '• สิ่งที่สร้างเป็นของส่วนตัวสร้างให้ทันทีและลบได้ ส่วนสิ่งที่ส่งถึงผู้อื่นหรือย้อนกลับไม่ได้จะเตรียมให้ตรวจและต้องได้รับการยืนยันจากคุณก่อนเสมอ',
  '• ใช้ได้เฉพาะข้อมูลและงานที่ระบบนี้รองรับ ไม่สามารถเข้าถึงระบบภายนอกหรืออินเทอร์เน็ต หรือส่ง Email จริงได้',
  '• คำตอบอ้างอิงแหล่งข้อมูลที่ตรวจสอบได้',
].join('\u000a');

export function capabilityReply(authorizedToolNames: readonly string[], firstTurn = true): string {
  const labels = CAPABILITY_AREAS.filter(area => area.tools.some(tool => authorizedToolNames.includes(tool)))
    .map(area => area.label);
  if (!labels.length) return firstTurn
    ? 'สวัสดีครับ ตอนนี้บัญชีนี้ยังไม่มีสิทธิ์ใช้ความสามารถที่เปิดให้บริการ โปรดติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เพิ่มเติม'
    : 'ตอนนี้บัญชีนี้ยังไม่มีสิทธิ์ใช้ความสามารถที่เปิดให้บริการ โปรดติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เพิ่มเติม';
  if (!firstTurn) return `จากความสามารถที่บัญชีนี้มี ผมช่วยเรื่อง ${joinThai(labels)} ได้ครับ ต้องการให้ช่วยดูส่วนไหนหรือช่วงเวลาใด?`;
  return `สวัสดีครับ บัญชีนี้ให้ผมช่วยได้ในเรื่อง ${joinThai(labels)} — บอกได้เลยว่าต้องการดูหรือทำอะไร

${CAPABILITY_LIMITS}`;
}
