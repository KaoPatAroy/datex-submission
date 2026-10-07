# Dynamic Query Integration

## Legacy exclusion gates (Track A, pending removal)

The mode-on route still excludes planner-first handling through
`planContactClarification`, `requestsDashboardRefinement`,
`createPreparationPolicy`, `participantClarification`, and the known-tool gate.
These gates remain unchanged for this track. Replace them with structured
pending-action and conversation-state ids before removing the legacy exclusions.

# Track B Wave 2 module hooks

## Known follow-up state limitation

The planner receives the recent conversation excerpt even when the conversation has no prior accepted dynamic query state. A non-dynamic turn therefore supplies conversational context but cannot supply inherited query values. If the model labels a request `follow_up` without a prior accepted dynamic state, the service treats it as a fresh query and validates only its explicit values. The model must not rely on inherited filters or dates in that case.

Module layer only. Proposed flag: `BIZTANIA_DYNAMIC_CATALOG=off|on`, default `off`.
No flag, service, pack, storage, or migration wiring is included. Wave 1 contracts remain unchanged.

| Capability / typed entry point | Lead-owned `lib/core/service.ts` hook when enabled |
| --- | --- |
| Discovery: `discoverRegisteredCatalog({packs, workflows, revision}) -> DiscoveryCatalog` | At registered pack/runtime catalog construction, pass installed `DepartmentPack` descriptors and `workflowProjectionManifest.values()`. Persist the immutable candidate ref in a separate catalog store. Never expose candidates in planner context or promote them automatically. No tool/DB invocation occurs. |
| Certified catalog: `createWave2Catalog(branches, revision) -> Wave2Catalog` | Alongside `createSemanticCatalog` before planner input construction. Keep Wave 1's branch catalog unchanged; add actor-filtered HR dataset/choices only after fresh `hr.read` authority. Catalog publication/review remains lead-owned. |
| Authority: `authorizeCatalogField(input)` / `validateCatalogAudience(input)` | At actor-scoped planner context and validation boundaries. Populate role, revision, permissions, regions, exact branch restrictions and recipient allowlist from current server policy. Audience validation is a pure prerequisite, never delivery authority. No effect, artifact, monitor, or communication capability is enabled. |
| HR validation: `validateHrQueryPlan({proposal,catalog,actor,sourceText}) -> AcceptedHrPlan | RejectedPlan` | In the dynamic query routing branch of `sendMessage`, after the AI supplies a strict v1 QueryPlan selecting `hr_employees`. Revalidate against the current QueryPlan contract after the AI-first planner contract (canonical ISO dates + evidenceText + not_query) lands; `exactSourceTextRef`/`sourceText` dependencies are affected. No phrase parser. Unknown/denied plans return typed failure and `hrSupportedChoices`; never fall back to a wider query. |
| HR read: `compileHrQuery(accepted) -> HrReadRequest`; `executeHrRead({request,snapshot,freshAuthority,currentCatalog,now}) -> bundle | RejectedPlan` | Before registered HR snapshot reads, reload actor and catalog, enforce the request's deadline and 2000-row cap at the storage boundary. Fetch only requested branches; null-branch records require wildcard HR admin. The bounded `HrSnapshot` must supply an independently attested full employee-ID population for every requested branch (including empty branches), population observed/retrieved timestamps, and measured elapsed time. Missing timestamps return `data_unavailable`; never substitute retrieval time. This pure adapter projects ID/name/branch/active, exact ID/name filters, and registered active headcount. It does not replace the existing ID-only `hr.find_employee` tool or certify leave/private fields. |
| Source evidence: `enrichEvidenceBundle(Wave1Bundle) -> CompleteEvidenceBundle`; `assessSourceCompleteness(input) -> SourceCompleteness` | After Wave 1 `executeReadRequest` succeeds, before response claims. Enrichment preserves the original v1 bundle and adds per-source row counts/digests, freshness, and omissions for the full requested branch/date population. Historical sources use business cutoff freshness. Standalone source reports require server-owned requirements; use `sourceCompletenessOutcome` for complete/top-N checks. |
| Response: `createPresentationClaims(bundle) -> PresentationClaims | RejectedPlan`; `validateResponsePlan(proposal, claims) -> AcceptedResponsePlan | RejectedPlan`; `renderResponsePlan(accepted) -> string` | Replace only the flagged grounded presentation after evidence execution. AI may arrange registered facts/comparisons/missing-evidence/caveat sections and exact claim IDs; values, units, citations, mandatory labels and limitations come from evidence. Incomplete/stale source coverage rejects claim creation. Use `defaultResponsePlan` as the deterministic fallback. Output is plain text, not HTML; the renderer must preserve text escaping. `en`/`th` locale metadata does not itself translate registered labels. |
| Exact state: `prepareExactConversationState(input) -> PreparedExactState | RejectedPlan` | In the existing dynamic result `persist(tx, finalActor, conversationId)` callback, after authority/catalog reload and latest-state lookup. Store source, query, validation, authority, catalog, execution, evidence, claims, response and completeness records atomically with returned state/ref. Enforce returned `expectedPrevious` CAS in the transaction; source/ref-only storage is insufficient for later reference resolution. Rehydrated serialized tokens cannot be executed: revalidate from immutable stored plans/evidence and current authority. Fresh authorization must also precede output release. |
| Governed learning: `proposeGovernedLearning({proposal,catalog,actor,allowedTargetIds,recordedSourceText,now,previous}) -> GovernedLearningRecord` | After a minimized correction/discovery proposal is produced, persist a separate pending suggestion by exact ref/version CAS. `allowedTargetIds` must be authorized for the supplied active actor with `catalog.learning.propose`. No raw prompts or employee examples; pass evidence refs and a reviewed non-personal concept label only. Approved `catalog_label` values are sent only as catalog snapshot context to the AI planner; no server code may match user text against labels. The server never interprets user language through phrase/synonym tables; the AI emits canonical values. Semantic and security owner reviews plus new catalog publication are separate lead capabilities; this module cannot approve or auto-apply suggestions. |

Acceptance/owner decisions: supply bounded HR storage pagination and independent population attestation;
certify freshness/source policies and the synthetic HR projection before enablement; implement transactional CAS/ref storage;
provide pending-suggestion persistence and human-review workflow. Leave data is unsupported and offers authorized directory/headcount choices.
This module has no side effects and grants no execution authority to discovery or learning records.

V2 source text refs use `exactSourceTextRef(text)` (content-addressed ID, version 1 and content digest); persist and resolve that exact tuple.
Headcount plans must have dimensions equal to their group keys; their evidence projects group keys and headcount only, retaining opaque row refs for traceability.
Directory row plans use the registered four-field ID/name/branch/active projection.
Wave 1 source `rowCount` measures branch/date EvidenceRows, not raw upstream orders/items. Its mandatory limitation states that upstream record completeness is not attested.
HR population metadata is a trusted server-reader input, never a model argument; independent attestation is an enablement prerequisite owned by the lead.
