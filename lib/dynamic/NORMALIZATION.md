Dynamic planner normalization (TB-DYN-AI-FIRST)
==============================================

The AI owns conversation meaning: time, region, branch, measures and follow-up
context. Its prompt includes businessDate/timezone, the authorized serving date
window, up to six recent user/assistant pairs (8 KiB), prior accepted plan/state,
catalog identities and human labels, and the actor's authorized scope. The service
supplies its existing permission-filtered completed conversation history.

Time is canonical {fieldId, timezone, source, dates, evidenceText?}. The server
validates ISO calendar dates, ordering, budgets and availability. Explicit time
requires evidenceText located in the current message; inherited dates must equal
the verified prior state's dates; default time uses businessDate. It never derives
date meaning from message text, converts Buddhist years, or interprets month names
or relative words. Registered comparison calculations operate on canonical dates.

Filters use catalog codes within authorized scope. Explicit evidence must occur
in the message; inherited filters must equal a prior accepted filter. The server
does not bind labels, aliases or phrases to values. Every accepted answer states
the interpreted dates, regions/branches and measures, using existing scope-label
rendering and labeled default/inherited markers.

Text-only source spans get server-resolved UTF-16 offsets. Matching allows NFC,
duplicate identical Thai combining marks and whitespace collapse; it performs no
spelling corrections, synonym matching or language interpretation. Stored spans
retain the original text and offsets. Single-date aggregates remove date grouping;
row plans preserve their evidence grain.

The provider uses one bounded request with enable_thinking=false. A single fenced
or prose-wrapped JSON object is tolerated; competing objects fail closed. With
mode=on, eligible live-AI turns reach the planner first; {intentKind:"not_query"}
falls through to the existing live AI loop. Existing action/clarification
exclusions and off/shadow admission remain unchanged.

Diagnostics contain metadata only. Provider health counts malformed_model_json
and invalid_model_response per actor: three of the latest five outcomes within
five minutes. Invalid_model_plan and user ambiguity never count as failures.
Shadow jobs do not contribute to on-path health.

The scripted provider is an exact-prompt test double returning canonical plans;
unknown prompts are not_query. It requires AI_PROVIDER=scripted, local demo data,
no VERCEL, a non-production BIZTANIA_DEPLOYMENT_ENV, and either NODE_ENV=test or
the explicit local NEXUS_E2E_RUNNER=1. BIZTANIA_DEPLOYMENT_ENV=production refuses
fixtures even with that runner flag.

Captured provider raw text is preserved alongside migrated contractPlan test
data. These offline replays verify normalization, authorization, compilation and
grounded claims; they do not verify live gateway latency or model accuracy.
