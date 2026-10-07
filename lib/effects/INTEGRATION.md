# Wave 4 effects integration (not wired)

Entry: `runActionPlan({request, context, simulation}) -> Result<ActionOutput>`.
`ActionPlan` v1 supports registered `dashboard_share` and `badge_revoke` only.
Preview contains exact recipient refs/names, artifact/employee identity and trusted
claim-rendered content. Targets never default to all branches. Approval is mandatory.

Lead hook: in `ConciergeService` (`lib/core/service.ts`), add a flag-gated dynamic
preparation branch immediately before legacy `prepare` creates `PendingAction`
(`ConciergeService.prepareInTransaction`). Under `BIZTANIA_DYNAMIC_EFFECTS=on`,
accept the AI's
typed plan and call phase `preview`; persist its immutable workflow alongside the
existing proposal. Default `off` retains Track A. Do not reinterpret prompt text.
`confirm` (`ConciergeService.confirm`, the claim transaction) calls phase `confirm`
with the exact client-supplied preview digest and server-loaded version; `execute`
(`ConciergeService.executeTarget`) uses phase `execute`; `reconcile`
(`ConciergeService.reconcile`) calls `verify` after independent readback. Do not expose the pure simulation as a live effect adapter.

Integration must reload actor/session/mode, catalog, immutable artifact, targets,
ClaimGraph/EvidenceBundle, freshness/coverage/trust and recipient profiles in each
transaction. Adapt those to `ActionContext`; refs must identify exact immutable
versions, never an AI digest. `ContentClaim.text` is trusted server rendering of
evidenced facts. This module deliberately requires explicit HR regions (including
`*` if granted), rather than inventing a global HR exemption. Decide that mapping
against `canReadHrEmployee`. Permission intersection includes all registered read
and effect requirements; the server supplies the recipient policy ID list.
Effect evidence must be certified; verified-physical exploration data is rejected.
Claims require registered allowedUses and subjectIds; badge reasons must be approved
for badge_reason, linked to the exact employee, and backed by certified HR evidence.

CAS the whole workflow + per-target effects + receipt + audit together. Enforce a
unique operation key, derived from actor/session/request key; same key/different
plan is rejected. State is server-owned, not submitted client JSON. A revised
plan requires a new preview/key; atomically stale its predecessor through the
existing pending-action lifecycle. Never overwrite historical versions.
Execute returns pending; verify checks exact kind/target/content/operation record,
and badge readback additionally checks revoked state/operation key. Share records pin
artifact refs and reject an existing artifact/recipient share across operation keys.
Replay requires a distinct complete target set. The pure ledger
is a deterministic reference adapter, not storage or production execution authority.
Lead must map its record to grant+inbox or badge state with existing runtime handlers
and retain receipt visibility restrictions. Budgets: 20 targets/evidence refs,
32 claims, 4000 claim characters, 10-minute preview. No Next runtime/build required.
Workflow retains the latest 64 audit rows; identical failed/successful readback retries
are no-ops. Persist every new version/event in the existing append-only audit store
to preserve earlier history. Registry/compiler behavior changes require a new
registry version and invalidation of old previews before enabling that release.

## Single source of truth

- PendingAction is the single source of truth for lifecycle state (pending, claimed, completed, stale); the effect workflow is stored inside its payload, not as a parallel record.
- Supersession uses PendingAction staleReason and predecessorActionId.
- The receipt is exposed through the existing ReceiptView.
- Preview expiry is the earlier of 10 minutes and the PendingAction expiresAt.
