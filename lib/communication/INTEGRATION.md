# Wave 4 communication integration (not wired)

Entry: `runCommunicationPlan({request, context, inbox}) -> Result<CommunicationOutput>`.
Only `simulated_inbox` is registered. This is simulated delivery, with no outbound
API, email, webhook, URL or HTML support. Content comes only from trusted
ClaimGraph-rendered snapshots. Consent binds actor, channel, exact recipient set
and exact content claim refs/versions with expiry and revocation.

Lead hook: add `communication.prepare_plan` to the tool broker in
`ConciergeService.turn` where existing prepare tools are dispatched. Under
`BIZTANIA_DYNAMIC_EFFECTS=on` (default off), reload actor and
recipient policy, validate the AI plan, call `preview`, persist workflow and return
the exact recipients/names and content for user review. Missing WHO/content/consent
returns a safe rejection; resolve those through authorized choices, never a team
alias or all-profile default. `authorizationRef(context)` pins current authority.

Add a distinct dynamic communication branch in service `confirm`, execution and
`reconcile`, invoking confirm -> execute -> verify. Persist whole workflow with CAS;
unique actor/session/idempotency operation key + exact-target inbox records prevent
retries from duplicating delivery. Reauthorize and recheck consent inside each
transaction. Never accept workflow, claim text, recipient policy, consent or refs
from client/AI as authority; only preview plan and confirmation digest are untrusted
inputs. Ledger state and context are trusted server-owned snapshots. Preserve
historical versions, audit and restricted receipt access. Independent readback must
match operation key, immutable recipient ref, content, kind and plan digest.

Storage/migrations, UI exact-preview rendering, pending-action envelope and consent
capture/revocation are lead-owned Wave 5 work. This new channel does not treat legacy
dashboard sharing as general messaging. Caps: 20 recipients, 32 content claims,
4000 content characters, 10-minute preview. Flag and service wiring are absent.


## Live wiring (Track B lane C)

`communication.send` is a registered confirm-tier action (router_proposals). An optional `artifact` param binds the message to one exact artifact version (sender and every recipient are reauthorized for its whole scope at preview and confirm). Delivery writes each recipient's own inbox row inside one transaction that re-reads sender and recipients, then reads every row back; the sender's verified receipt (recipients delivered, content, bound artifact) is persisted beside the proposal and listed by `GET /api/router-proposals/receipts`. Recipients never see other recipients.
