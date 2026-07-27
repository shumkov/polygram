---
title: Reliable Autonomous Workflow Completion Delivery - Plan
type: fix
date: 2026-07-24
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reliable Autonomous Workflow Completion Delivery - Plan

> **Execution note (2026-07-25):** The delivery and prompt work in U1–U5 shipped
> as Orchestra `0.4.3` and polygram `0.20.2`/`0.20.3`, and the out-of-turn
> delivery path was revalidated in production from an isolated Telegram topic.
> Do not execute this document's U6–U8 proposal for Claude Code `2.1.218`.
> Polygram `0.21.0` and Orchestra `0.5.0` changed the release baseline, and the
> user selected `2.1.220` instead. The replacement upgrade contract is
> [`2026-07-25-001-claude-code-2.1.220-upgrade-plan.md`](./2026-07-25-001-claude-code-2.1.220-upgrade-plan.md).

## Goal Capsule

Deliver a completed background Workflow result to its originating Telegram chat
and isolated topic when the launch turn has already closed, without forwarding
unrelated background-agent fan-in or duplicating a reply that is still being
delivered or has already succeeded.

Authority, in descending order:

1. The reproduced production trace and production prevalence in
   [`docs/workflow-delivery-loss-findings.md`](../workflow-delivery-loss-findings.md).
2. The channels HARD CONTRACT appended by Orchestra: CLI-visible output must use
   the channels reply tool because ordinary inline output is not user-visible.
3. Existing pending-turn delivery, chat/topic routing, security, deduplication, and
   teardown contracts in Orchestra and polygram.
4. This plan's scoped extension for terminal CLI cycles with no pending consumer
   turn.

Execution profile:

- Two repositories: `shumkov/orchestra` owns the CLI lifecycle; `shumkov/polygram`
  owns Telegram routing, prompts, deployment, and the live upgrade harnesses.
- Correctness fix, prompt alignment, and Claude Code pin upgrade remain separately
  attributable changes.
- TDD is mandatory for the production bug.
- The implementation tail ends at reviewable PRs. Merges, package publication,
  release tags, and production deployment require later operator approval.

Stop immediately if the transcript cannot prove that the terminal cycle was
triggered by a completion notification for a `Workflow` tool call, or if
implementation would require guessing which of multiple overlapping Claude cycles
owns a `Stop`, replacing the channels delivery model, or adding a timeout that can
race a late successful Telegram send. Those are design changes outside this
incident.

## Product Contract

### Summary

The production failure was not a Workflow failure, Telegram routing failure,
topic-isolation failure, or restart. Claude Code completed the Workflow, injected
the result into the parent context, and produced a substantive inline final. The
CLI emitted a terminal `Stop` with zero pending turns, so Orchestra discarded that
final because its Stop fallback only serves a pending turn.

The deterministic fix extends that existing final-output seam only to a
non-overlapping, no-pending terminal cycle that the transcript correlates to a
completed Workflow. Prompt alignment prevents polygram from contradicting the
channels HARD CONTRACT. A later, separately validated release updates the pinned
Claude Code binary from `2.1.173` to `2.1.218`.

### Requirements

- **R1 — Workflow-qualified autonomous handoff.** A terminal CLI `Stop` with no
  pending consumer turn and a non-empty inline final may hand that final to
  Orchestra's existing `autonomous-assistant-message` callback only when the
  captured transcript proves that the current final's nearest user-text ancestor
  is a `<task-notification>` whose `<tool-use-id>` identifies a `Workflow` tool
  call in the same transcript. The handoff is once with
  `alreadyDelivered:false`.
- **R2 — Same-branch successful reply suppression.** A successful non-interim
  channels `reply` suppresses the inline Stop fallback only when the Workflow
  notification→terminal-final ancestry contains that reply's tool-use and its
  successful MCP delivery receipt marked as a direct send. A completed-cache or
  in-flight replay receipt must be distinguishable and may suppress only when its
  opaque source-attempt id links to an earlier timed-out/failed tool result with
  matching delivery arguments on the same ancestry. A success from another cycle
  must not suppress.
- **R3 — Failed reply rescue and timeout resolution.** An explicit failed reply
  receipt on that branch must not suppress the captured inline final. A bridge
  timeout is ambiguous while its dispatcher may still succeed: the decision must
  wait only for the live/recent matching `attempt_id`; success suppresses and
  failure rescues. If restart erased that outcome and no causally linked replay
  exists, fail closed rather than guessing delivery.
- **R4 — Interim and progressive-edit semantics.** An interim reply or successful
  `edit_message` receipt on the same ancestry suppresses only an identical Stop
  text. A distinct inline final must still be rescued. Comparison is transient and
  stores no reply plaintext after the decision.
- **R5 — Pending-turn compatibility.** Existing pending-turn final, zero-reply,
  interim-only, foreign-Stop, grace, and synchronous stop-hook behavior must remain
  unchanged.
- **R6 — Lifecycle and eviction safety.** Bridge disconnect, process kill, and
  session reset must invalidate pending transcript decisions so late promises
  cannot emit or repopulate state. ProcessManager must not evict a process while a
  validated reply/edit dispatch or transcript decision is pending, and must
  re-evaluate waiting capacity promptly when that work settles.
- **R7 — Backend-consistent and honest prompt.** SDK prompts retain inline-delivery
  guidance. CLI prompts state that inline text is invisible and the active channels
  reply MCP contract is mandatory for user-visible output. They also forbid
  treating assistant transcript text as proof of user-visible delivery: without a
  successful reply receipt, delivery is unconfirmed and the result must be sent
  now rather than described as already posted.
- **R8 — Topic-safe delivery.** An autonomous event with
  `alreadyDelivered:false` must continue through polygram's shared delivery
  pipeline to the originating chat and isolated topic; `alreadyDelivered:true`
  must remain a no-send.
- **R9 — Release attribution.** Polygram must declare an exact Orchestra version.
  The fallback release and CLI-pin release must not collapse through a caret range
  or unpublished lockfile state.
- **R10 — Deliberate CLI upgrade.** The `2.1.218` pin may change only in a
  separate release after old/new real-Claude gates reproduce the out-of-turn
  Workflow lifecycle and show no adapter regression.
- **R11 — Privacy-safe evidence.** Tests and telemetry may record event names,
  routing identifiers, hashes, lengths, counts, ordering, versions, and checksums,
  but not production message bodies or unredacted research output.
- **R12 — Review boundary.** Implementation may create branches, commits, and PRs
  after plan approval, but may not merge, publish packages, tag releases, or deploy.
- **R13 — Fail-closed eligibility and provenance.** Missing transcript paths,
  unreadable or truncated JSONL, schema drift, a final-message mismatch, a
  non-Workflow task notification, unknown notification provenance, or an ambiguous
  ancestry chain must suppress the fallback and emit content-free diagnostic
  telemetry. Qualification requires Claude's native internal provenance
  (`origin.kind:"task-notification"` and `promptSource:"system"` on the current
  pinned format), not XML-looking text alone.

### Acceptance Examples

- **AE1 — Reproduced loss is rescued.** Given zero pending turns, no reply
  dispatch, and a final whose nearest user-text ancestor is the matching Workflow
  task notification, when terminal Stop contains a substantive final, Orchestra
  emits one autonomous event with that text and `alreadyDelivered:false`.
- **AE2 — Same-branch success is not duplicated.** Given the matched ancestry
  contains a final reply and successful `{ok:true,delivery:"sent"}` MCP tool
  result, when Stop contains inline text, no autonomous fallback is emitted.
- **AE3 — Earlier-cycle success cannot suppress.** Given a prior final reply
  succeeded but its Stop was missed, when a later Workflow completion has no
  successful reply on its own ancestry, the later final is rescued.
- **AE4 — Failed delivery is rescued.** Given the matched ancestry contains a
  failed or `isError` reply result, the captured fallback is emitted once.
- **AE4a — A replay is not new delivery proof.** Given an earlier branch primed
  content dedup and the Workflow branch receives
  `{ok:true,delivery:"replayed",replay_of:<id>}` without the linked source attempt
  on its own ancestry, the Workflow final is still rescued.
- **AE4b — A linked slow-send replay preserves exactly-once.** Given a same-branch
  reply times out at the bridge with structured `attempt_id`, the direct dispatcher
  later succeeds, and a retry joins or hits completed dedup with
  `replay_of:<attempt_id>`, the linked replay suppresses fallback.
- **AE4c — A timeout without retry resolves causally.** Given the same timeout and
  no retry, Stop waits for the matching live attempt outcome. Direct success
  suppresses; direct failure rescues; missing outcome after restart fails closed.
- **AE5 — Delayed Stop after pending finalization is safe.** Given a final reply was
  delivered while a turn was pending and activity-quiet removes that pending turn
  before a delayed Stop, the direct-send receipt remains on the transcript branch
  and the Stop does not duplicate it.
- **AE6 — Interim result is completed.** Given a directly sent interim status and
  a distinct Stop final, only the final is handed to the autonomous pipeline. If
  both normalize to the same text, no duplicate is handed off.
- **AE6a — Progressive edit is respected.** Given the same ancestry shows an
  interim bubble successfully edited to the final text, an identical Stop final is
  suppressed; a distinct Stop final or a failed edit is rescued.
- **AE7 — Teardown cancels a deferred decision.** Given a transcript decision in
  flight, when disconnect, kill, or reset happens before settlement, later
  settlement causes neither state mutation nor autonomous emission.
- **AE8 — Isolated topic survives.** Given session key
  `<chat-id>:<thread-id>`, an undelivered autonomous event is delivered to that
  thread; an already-delivered event is skipped.
- **AE9 — Backend prompts diverge intentionally.** The SDK prompt says normal
  inline output is delivered; the CLI prompt requires channels `reply` and contains
  none of the contradictory blanket prohibition, and never claims prior delivery
  from transcript text alone.
- **AE10 — Upgrade gate reproduces the incident shape.** Against both pinned
  binaries, a bounded synthetic Workflow finishes after its launch turn, receives
  no later user prompt, and yields exactly one user-visible sentinel through either
  direct reply or deterministic fallback.
- **AE11 — Agent fan-in fails closed.** Given a no-pending inline Stop whose nearest
  user-text ancestor is an Agent task notification or an ordinary user message,
  Orchestra emits no autonomous fallback.
- **AE12 — Notification-shaped user text fails closed.** A human message containing
  task-notification XML and a historical Workflow id is ineligible without native
  internal provenance and mainline ancestry.

### Success Criteria

- The exact production-shaped, Workflow-qualified Orchestra regression test is red
  on `0.4.2` and green with the fix.
- Same-branch success/failure, missed-prior-Stop, resume, interim/edit, teardown,
  eviction, and ordinary pending-turn tests all pass deterministically.
- Orchestra and polygram each report a fully green `npm test`.
- Polygram's manifest and installed-package contract prove an exact dependency.
- The prompt/fallback correctness release is reviewable independently of the
  Claude Code pin release.
- The pin does not advance unless every required old/new live gate is recorded as
  `PASS`; `FAIL` or `BLOCKED` stops the upgrade PR.

### Scope Boundaries

In scope:

- Orchestra CLI/channels delivery state for terminal Stop events.
- Polygram backend-aware prompt and bundled send-skill wording.
- Existing autonomous callback routing, including isolated topics.
- Exact Orchestra dependency declarations.
- A focused real-Claude Workflow completion gate.
- A minimal, read-only transcript correlation parser for Workflow eligibility.
- Minimal repairs that make the named old/new spike gates select and attest the
  intended executable.
- Updating the canonical CLI-upgrade documentation and marking unrelated stale
  spikes as historical.

Out of scope:

- Rewriting Workflow, Claude Code background tasks, or polygram IPC.
- Forwarding arbitrary transcript fragments or intermediate reasoning.
- Treating every background Agent notification as user-visible.
- Generic rescue of every no-pending Stop.
- Solving overlapping/foreign Stop ownership when another Telegram turn arrives
  during an autonomous cycle.
- SDK delivery behavior changes.
- Repairing every historical CLI spike.
- Overriding Claude Code `2.1.217+` concurrency or nested-agent defaults without a
  separately approved staging decision.
- Absolute end-to-end exactly-once delivery across Telegram/network failures.
  This plan guarantees one handoff from Orchestra to the existing polygram
  delivery pipeline for the reproduced non-overlapping cycle.

### Dependencies and Sources

- Findings: [`docs/workflow-delivery-loss-findings.md`](../workflow-delivery-loss-findings.md)
- Orchestra lifecycle: `lib/process/cli-process.js`
- Orchestra channels contract: `lib/process/channels-bridge.mjs`
- Polygram callback: `lib/sdk/callbacks.js` and `polygram.js`
- Polygram prompt: `lib/prompt.js`
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude Code 2.1.218 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.218)
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code background subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)

## Planning Contract

### Key Technical Decisions

- **KTD1 — Pair deterministic fallback with prompt alignment.**
  (session-settled: user-approved — chosen over prompt-only remediation:
  production already showed mixed model compliance, so correctness cannot depend
  on prose alone.)
- **KTD2 — Derive suppression from the same transcript branch.** The Workflow
  notification→terminal-final ancestry contains channels reply/edit tool-use blocks
  and their MCP tool results. Extend the bridge receipt to distinguish an actual
  dispatcher send from a completed-cache/in-flight replay and carry a stable opaque
  source-attempt id through timeout, direct success, and replay. A successful
  `delivery:"sent"` receipt on that exact branch suppresses; a replay suppresses
  only when it causally links to its earlier same-branch timed-out/failed attempt
  with matching arguments. This survives resume/restart and cannot be contaminated
  by a missed Stop or replay from a prior cycle.
- **KTD3 — Keep live state narrow.** Do not build a reply-success epoch. Track only
  validated reply/edit attempts by opaque id while unresolved and in a bounded
  recent-outcome ledger long enough to resolve a same-branch bridge timeout.
  Transcript ancestry must name that exact attempt before live state can affect the
  decision. The ledger also pins eviction while unresolved; it is not a generic
  cycle-success flag.
- **KTD4 — Do not use `UserPromptSubmit` as the cycle opener.** Production task
  notifications are internal Claude inputs and are not guaranteed to produce a
  bridge-authored `UserPromptSubmit`. Terminal Stop is the observable cycle
  boundary; overlap attribution remains explicitly out of scope.
- **KTD5 — Qualify fallback from transcript ancestry and native provenance.** At
  the captured transcript boundary, coalesce the terminal assistant message and
  follow its parent chain to the nearest user-text ancestor. Only a
  `<task-notification>` whose `<tool-use-id>` matches a `Workflow` tool-use block
  in the same mainline transcript is eligible. The record must also carry Claude's
  native internal task-notification provenance; XML text is not authority.
  Production showed the id relation for all 7/7 Workflow completions and for none
  of 77 unrelated task notifications. Missing, malformed, mismatched, forked, or
  ambiguous state fails closed.
- **KTD6 — Do not invent a dispatcher timeout.** Claude cannot produce a channels
  MCP tool result or continue to terminal Stop until the bridge dispatcher has
  settled. A never-settling dispatcher therefore remains a hung tool call rather
  than an autonomous decision race. It stays eviction-pinned and is handled by
  existing teardown; a guessed timeout would reintroduce delivery ambiguity.
- **KTD7 — Pin Orchestra exactly in polygram.** The prompt PR first changes the
  current dependency from `^0.4.2` to `0.4.2` and adds a manifest/install contract.
  The fallback integration advances it to exact `0.4.3`.
- **KTD8 — Put the CLI upgrade behind a minor-version boundary.** The fallback is
  Orchestra `0.4.3`; the Claude pin upgrade is `0.5.0`, not the initially proposed
  `0.4.4`. Existing polygram releases with `^0.4.2` may receive the compatible
  fallback but cannot silently receive the lifecycle-changing CLI upgrade.
- **KTD9 — Keep the CLI upgrade separate.**
  (session-settled: user-approved — chosen over bundling it with the delivery fix:
  releases `2.1.198` through `2.1.218` materially change the same background
  lifecycle and require independent attribution and rollback.)
- **KTD10 — Target Claude Code `2.1.218`.**
  (session-settled: user-approved — chosen over retaining `2.1.173`: `2.1.218` is
  the current official release on 2026-07-24 and is locally available for
  old/new validation.)
- **KTD11 — Use a hard release checkpoint, not stacked release PRs.** The
  `0.5.0` pin branch starts from main only after `0.4.3` is reviewed, merged, and
  published. This prevents a nominally separate PR from depending on unpublished
  history or being retargeted incorrectly.
- **KTD12 — Keep polygram version bumps out of feature PRs.** Release-tag work later
  updates both `package.json` and `.claude-plugin/plugin.json` together, as required
  by the release workflow. Feature PRs change only the Orchestra dependency spec
  and lock where applicable.

### High-Level Technical Design

The adapter uses transcript causality for settled delivery and keeps only
lifecycle tokens for work that is currently unresolved:

```text
validated reply or edit path
  -> bridge creates opaque attempt_id; register it before await
  -> direct dispatch: result includes delivery:"sent", attempt_id
  -> timeout/error: structured result retains attempt_id
  -> cache/in-flight replay: result includes delivery:"replayed", replay_of
  -> release token; do not retain success as cycle authority

terminal Stop
  -> snapshot pending count, transcript path/size, and final before stop-hook
  -> stop_hook_active=true: do not decide
  -> otherwise:
       -> pre-Stop pending > 0: existing pending-turn path only
       -> pre-Stop pending = 0:
            prove native Workflow completion on one mainline ancestry
            extract same-branch reply/edit tool uses + MCP tool results
            successful final reply receipt? suppress
            same-branch timeout attempt active/recent?
              -> wait/read exact outcome: success suppresses, failure rescues
            empty Stop text?                 suppress
            matches successful interim/edit? suppress
            failed receipt or no delivery?   emit autonomous, not delivered
            incomplete/ambiguous structure?  fail closed

disconnect / kill / reset
  -> invalidate the lifecycle generation
  -> late transcript decisions become no-ops

ProcessManager eviction
  -> unresolved dispatch or transcript decision: retain process
  -> otherwise: use existing idle/LRU policy
```

Unresolved-dispatch tokens are registered only after the existing validation,
rate, chat-id, and dedup gates establish a real delivery attempt, and before
awaiting `toolDispatcher`. They exist only to prevent ProcessManager from killing a
live autonomous send. They do not suppress fallback. Invalid, rate-limited,
chat-mismatched, or cache-only operations create no token; an in-flight dedup join
shares the original token.

The daemon-to-bridge `tool_ack` and the bridge's MCP result gain causal receipt
fields:

- every original bridge invocation exposes its existing random tool-call UUID as
  opaque `attempt_id`, including structured timeout/error results;
- `delivery:"sent"` means that attempt called `toolDispatcher` and it succeeded;
- `delivery:"replayed"` means the invocation was satisfied by tool-call/content
  dedup or joined another dispatch; `replay_of` identifies the originating direct
  attempt stored with the in-flight/completed cache entry.

An unknown or missing discriminator is ambiguous schema and fails closed. A known
replay suppresses only when the same notification→final ancestry contains the
earlier timed-out/failed result whose `attempt_id` equals `replay_of` and whose
normalized immutable delivery arguments match. A source attempt found only on a
prior branch cannot suppress. The tool description and protocol tests pin these
fields so a later cache refactor cannot silently collapse the distinction again.

`CliProcess` keeps a bounded attempt ledger keyed by the same opaque id. It stores
only immutable argument hashes, pending promise/outcome, and expiry—never reply
plaintext. When transcript ancestry contains a structured bridge-timeout result,
the decision may consult only the matching id and argument hash: wait if active,
suppress on success, rescue on explicit failure. The ledger uses the existing
dedup retention bound/window. If the id is absent after restart or the hash
conflicts, the timeout is ambiguous and the fallback fails closed.

Workflow eligibility and delivery receipts are evaluated from the transcript
snapshot captured at Stop:

1. Read only complete JSONL lines ending at or before the captured byte boundary;
   a partial last line is ineligible. Consider only non-sidechain assistant rows
   for the current session with non-empty `uuid`, `parentUuid`, `requestId`, and
   `message.id`.
2. Select the last mainline assistant row by file offset. Coalesce all consecutive
   rows sharing `(session, requestId, message.id)` that form an exact linear UUID
   chain ending at that row. Their distinct UUIDs are fragments of one response,
   not duplicate messages.
3. Require the coalesced group to be the sole terminal candidate, have
   `stop_reason:"end_turn"`, and contain no `tool_use` block. Concatenate string
   `text` blocks in parent/file order with `"\n\n"` and ignore `thinking`. Normalize
   only line endings and outer whitespace before exact comparison with
   `last_assistant_message`; internal whitespace and punctuation remain
   significant. Duplicate UUIDs, forks, cycles, broken parents, interleaved logical
   messages, conflicting identities, or multiple terminal candidates fail closed.
4. Walk backward past tool-result-only user rows to the nearest user-text record.
   Require `type:"user"`, mainline ancestry, the current session, a string user
   message, `origin.kind:"task-notification"`,
   `promptSource:"system"`, and `isSidechain:false`.
5. Parse the notification structurally, extract `<tool-use-id>`, and require a
   unique earlier assistant `tool_use` block with that id and `name:"Workflow"` on
   the same mainline. Queue-operation echoes and user-authored XML are ineligible.
6. On the notification→terminal branch, pair each expected channels `reply` or
   `edit_message` assistant `tool_use.id` with its descendant user
   `tool_result.tool_use_id`. Only a successful
   `{ok:true,delivery:"sent",attempt_id}` non-interim reply is durable same-cycle
   delivery proof. A successful replay is equivalent only when its `replay_of`
   links to an earlier same-branch timeout/error receipt with the same
   `attempt_id`, tool name, chat, target message id where applicable, interim flag,
   and normalized text/files arguments. Successful direct or causally linked
   interim replies/edits contribute transient normalized text for equality
   comparison. An unlinked replay or explicit failed receipt does not prove
   delivery. A structured timeout may resolve only through the matching live/recent
   attempt ledger; otherwise it is ambiguous. A missing discriminator/id,
   unmatched pair, or conflicting result fails closed.

The parser is private and read-only. It returns only eligibility, delivery
semantics, normalized hashes/lengths, and a reason; it never returns notification
or reply text. The captured Stop final remains outside that result and exists only
until the existing autonomous handoff is suppressed or emitted.

`Process` gains a conservative `hasPendingDeliveryWork()` defaulting to `false`;
`CliProcess` returns `true` while any validated dispatcher or transcript decision
remains unresolved.
ProcessManager's idle eviction and pinned-process checks honor that signal. This
prevents an otherwise idle process from being removed while a slow reply or
transcript decision is still capable of completing.
When the last decision settles or is invalidated, `CliProcess` emits the existing
idle/capacity signal so a parked LRU waiter does not sleep until its timeout.

### Prompt and Routing Design

`buildPrompt` gains a backend option with an SDK-preserving default. Production
`formatPrompt` resolves the backend with the same `pickBackend` inputs used for
process spawn, including topic overrides.

- `sdk`: keep current inline response guidance.
- `cli`: defer to the channels system contract, say inline text is invisible, and
  require `mcp__polygram-bridge__reply` for user-visible output. A successful reply
  receipt is the only delivery proof; transcript text alone must never justify
  saying a result was already posted. When delivery is uncertain, send the result
  now and describe the uncertainty accurately.

The bundled `polygram-send` skill distinguishes SDK turns, CLI/channels turns, and
cron/script IPC. It continues to reject raw Telegram Bot API calls and does not
recommend IPC as an in-turn substitute.

No new routing code is introduced. Polygram continues deriving chat/topic from the
session key and passing `alreadyDelivered:false` through the shared reply pipeline.

### Release and Upgrade Design

The current polygram worktree is based on `v0.19.0`, while `origin/main` is already
`0.20.0`. After this plan is approved and the findings/plan are safely committed,
the branch must be rebased onto current `origin/main` before source or manifest
edits. No `0.19.0` package metadata may be reintroduced.

Branches and checkpoints:

1. Orchestra `fix/autonomous-stop-delivery`, based on current Orchestra `main`,
   produces the `0.4.3` fallback PR.
2. Polygram `investigate/workflow-delivery-loss`, rebased onto current
   `origin/main`, produces the prompt/findings/exact-`0.4.2` PR.
3. Before publication, pack the Orchestra branch locally. Copy polygram into a
   mode-700 temporary directory, change only that temporary manifest to exact
   `0.4.3`, install the tarball without saving a `file:` manifest spec, assert the
   installed package reports `0.4.3`, and run focused and full suites. Its lock is
   explicitly temporary tarball evidence, not a registry lock. The live polygram
   worktree remains exact `0.4.2` and runs its own full suite.
4. After the user reviews, merges, tags, and publishes Orchestra `0.4.3`, update
   polygram to exact `0.4.3`, refresh the registry-backed lock, and open the
   fallback-integration PR.
5. The pin wave starts only after the polygram prompt PR is merged and the
   published `0.4.3` integration is available for correctness staging. The actual
   24-hour correctness staging window is an external checkpoint before the pin PR;
   it is not performed by this no-deploy execution.
6. Open the mandatory tracking issue
   `bump claude CLI v2.1.173 → v2.1.218`.
7. A dedicated polygram `upgrade/claude-code-2.1.218-gates` PR adds the reproducible
   spike harnesses and documentation after the `0.4.3` integration.
8. Orchestra `upgrade/claude-code-2.1.218`, based on main after the `0.4.3`
   release and correctness staging, produces the `0.5.0` pin PR.
9. After `0.5.0` is published, a separate polygram upgrade PR advances the exact
   dependency to `0.5.0` and updates the registry lock and upgrade docs.

The old published polygram releases that already contain a caret cannot be changed.
Using Orchestra `0.5.0` prevents those `^0.4.2` releases from silently crossing the
CLI compatibility boundary.

Current authorization covers U1–U4 only and ends with the two correctness PRs.
U5–U8 are future resumable waves behind named operator actions:

- **Fallback integration wave:** resume U5 only after both correctness PRs are
  reviewed/merged and Orchestra `0.4.3` is tagged and published.
- **Upgrade-gate wave:** resume U6 only after exact `0.4.3` integration and
  separately authorized correctness staging.
- **Pin wave:** resume U7 only after the gate PR is merged and staging is accepted.
- **Upgrade integration/rollout wave:** resume U8 only after `0.5.0` is reviewed,
  merged, tagged, and published; deployment remains separately authorized.

### CLI Compatibility Risks

The official changelog makes the pin jump non-mechanical:

- `2.1.187` fixes channel connections dropping after background/TUI navigation.
- `2.1.198` makes subagents background by default and introduces explicit
  `Notification(agent_completed)` behavior.
- `2.1.200`, `2.1.208`, and `2.1.216` change daemon handover, restart, resume, and
  background persistence. The `2.1.208` failed-reply fix concerns messages sent to
  background agents, not Telegram channels replies.
- `2.1.211` changes background-agent result reporting and text forwarding.
- `2.1.212` may auto-background MCP calls longer than two minutes.
- `2.1.214` changes stream-json draining and hook behavior.
- `2.1.217` caps concurrent subagents at 20 and disables nested agents by default.
- `2.1.218` changes `/deep-research`, fork-context skill backgrounding, paste
  handling, and engine teardown.

The production run's reported 102-agent topology will not be treated as a required
shape under the new defaults. Staging compares completion, evidence quality,
routing, elapsed time, and topology; any request to override the new concurrency or
nesting limits is a separate decision.

### Assumptions and Residual Risks

- A validated `toolDispatcher` promise eventually settles during normal operation.
  A never-settling promise cannot be made exactly-once with a local timeout because
  a late success remains possible.
- Stop is sufficient as a boundary for the reproduced non-overlapping autonomous
  cycle. A new user turn overlapping a delayed autonomous Stop remains out of scope.
- Transcript qualification deliberately couples this fallback to the current
  Claude JSONL ancestry and task-notification shape. Schema drift fails closed and
  emits content-free telemetry, preferring a missed rescue over forwarding the
  wrong autonomous text.
- A never-settling dispatcher keeps the process pinned rather than risking a
  duplicate or losing the rescue decision. Bounded cancellation or end-to-end
  delivery idempotency would be a separate design.
- Telegram may accept a send and lose the response at the network boundary. The
  existing outbound pipeline owns that ambiguity; this adapter cannot provide
  absolute end-to-end exactly-once delivery.
- The `2.1.173` rollback binary must be checksummed and preserved outside
  Orchestra's garbage-collected vendor directory before staging `0.5.0`.

## Implementation Units

### U1. Synchronize repositories and preserve the evidence baseline

**Goal:** Start implementation from current main branches without losing the
reviewed incident artifacts.

**Requirements:** R11, R12

**Files:**

- Polygram: `docs/workflow-delivery-loss-findings.md`
- Polygram: `docs/plans/2026-07-24-001-workflow-completion-delivery-plan.md`

**Dependencies:** User approval of this reviewed plan.

**Approach:**

1. Remove every local and VPS `/tmp/polygram-inspect-*.mjs` script created for the
   read-only investigation.
2. Commit the findings and approved plan on the current branch.
3. Fetch and rebase the polygram branch onto current `origin/main`, preserving the
   two documents and verifying the package baseline remains `0.20.0` or newer.
4. Create Orchestra `fix/autonomous-stop-delivery` from current Orchestra `main`.
5. Run `npm ci` in both repositories before the focused red tests, then record
   clean/expected worktree state before source edits.

**Test Scenarios:**

- Rebase retains both documents byte-for-byte except conflict resolution required
  by current main.
- No unrelated tracked or untracked user changes are modified.

**Verification:**

- `git status --short --branch`
- `git diff --check`
- `npm ci` in each repository
- `node -p "require('./package.json').version"` in both repositories

### U2. Add the Orchestra transcript-qualified fallback with TDD

**Goal:** Rescue a Workflow-qualified no-pending inline Stop final while
suppressing only same-branch successful delivery receipts and failing closed for
unrelated task fan-in or ambiguous transcript state.

**Requirements:** R1, R2, R3, R4, R5, R6, R11, R13

**Files:**

- Orchestra: `lib/process/cli-process.js`
- Orchestra: `lib/process/channels-bridge.mjs`
- Orchestra: `lib/process/process.js`
- Orchestra: `lib/process/process-manager.js`
- Orchestra: `lib/process/workflow-completion-correlation.js` or an equivalently
  focused private parser module
- Orchestra: `tests/cli-process-integration.test.js` or one focused lifecycle test
- Orchestra: `tests/channels-bridge.test.js`
- Orchestra: a focused transcript-correlation test
- Orchestra: `tests/process-manager.test.js`
- Orchestra: `package.json`
- Orchestra: `package-lock.json`

**Dependencies:** U1

**Approach:**

1. Write the production-shaped Workflow/no-pending Stop test first and prove it
   fails on unmodified `0.4.2`.
2. Add transcript fixtures for linear fragmented assistant rows, Workflow
   provenance, same-branch reply/edit receipts, resume, and fail-closed Agent,
   ordinary-user, spoofed-XML, queue-operation, sidechain, missing, malformed,
   truncated, ambiguous, final-mismatch, and fork cases.
3. Add lifecycle tests for active dispatcher pinning, transcript-decision teardown,
   synchronous stop-hook reentrancy, delayed Stop after pending finalization,
   ordinary pending fallback, and ProcessManager capacity wakeup.
4. Implement the smallest private read-only correlation parser. It must parse only
   through the Stop snapshot, coalesce linear assistant fragments, follow mainline
   UUID ancestry, require native notification provenance, pair same-branch tool
   uses/results, and return no content.
5. Snapshot pending count, transcript path/size, and final before `stop-hook`.
   Preserve the existing pending path; on a terminal zero-pending Stop, run the
   qualified transcript decision and hand off only an eligible, unsuppressed final.
6. Extend `tool_ack`/MCP results with opaque `attempt_id`,
   `delivery:"sent"|"replayed"`, and `replay_of`. Preserve `attempt_id` in
   structured timeout/error results and in completed/in-flight dedup entries. Mark
   direct successful dispatcher calls `sent`; mark dedup/join results `replayed`
   with their source. Keep a bounded id→argument-hash/outcome ledger so a
   same-branch timeout without retry can wait for or read the exact dispatcher
   outcome.
7. Invalidate transcript decisions on disconnect, kill, and reset. A later resume
   recomputes settled delivery from the durable transcript receipts rather than
   process memory.
8. Add `Process.hasPendingDeliveryWork()` with a default `false`, override it in
   `CliProcess`, make ProcessManager `_evictLRU`, `_hasPinnedSession`, and
   `_pinnedSessionKeys` preserve/report such processes, and wake capacity waiters
   when the last decision settles or is invalidated.
9. Add content-free telemetry for eligibility failure, fallback, deferred decision,
   suppression reason, and bounded counts.
10. Bump Orchestra to `0.4.3` and correct the stale package-lock root version.

**Test Scenarios:**

1. Zero pending + matching Workflow notification + inline final + Stop emits one
   undelivered autonomous event.
2. Same-branch successful final reply receipt emits no fallback.
3. Missed prior Stop + prior-cycle success does not suppress the Workflow final.
4. Prior identical-text success + current failed receipt still rescues.
5. A prior branch primes completed-content dedup; the Workflow branch's identical
   replay does not call `toolDispatcher`, has no same-branch source attempt, and
   still rescues.
6. Same-branch bridge timeout → late direct success → in-flight join, completed
   cache retry, and same-attempt transport replay each carry causal source ids and
   suppress exactly once; mismatched id or delivery arguments fail closed.
7. Same-branch timeout without retry waits for the exact active attempt: success
   suppresses and explicit failure rescues. If restart removes an otherwise
   unrecorded outcome, the decision fails closed.
8. The recent attempt ledger is bounded by the existing dedup limit/window, retains
   no plaintext, and cannot affect a branch that does not name its id and argument
   hash.
9. Successful same-branch delivery then disconnect/resume remains suppressed;
   failed reply/edit then resume remains eligible.
10. Successful same-branch interim or edit suppresses a normalized-identical final;
   a distinct final or failed receipt rescues.
11. Thinking→text and multi-text fragmented assistant rows coalesce in parent order;
   CRLF and outer whitespace normalize, while internal differences do not.
12. Duplicate UUID, branch, broken parent, interleaved message, conflicting session,
   sidechain terminal, terminal tool-use, partial line, or multiple candidates fail
   closed.
13. User-authored notification XML, queue-operation echo, wrong
   origin/promptSource, stale/forked Workflow id, Agent notification, and ordinary
   input fail closed.
14. Final reply while pending, pending removed before delayed Stop, does not
   duplicate.
15. A normal pending Stop still uses existing `_computeTurnDelivery` behavior.
16. A synchronous `stop-hook` finalizer cannot reclassify a pre-existing pending
    turn as autonomous.
17. `stop_hook_active:true` makes no autonomous decision; the later terminal Stop
    decides.
18. Transcript settlement after disconnect, kill, or reset causes no emission or
    state mutation.
19. A resumed transcript with matching Workflow ancestry is eligible without
    relying on in-memory tool ids or reply-success state.
20. Slow pre-Stop reply/edit dispatch and transcript qualification pin the process
    against idle/LRU eviction;
    success, failure, and teardown release the pin and wake a parked capacity
    waiter.
21. Telemetry contains lengths, counts, ids, hashes, and reasons but no reply text.

**Verification:**

- Focused red command captured before implementation.
- The same focused command green after implementation.
- Orchestra: `npm test`
- `git diff --check`

### U3. Align polygram prompts and freeze the current dependency exactly

**Goal:** Remove the prompt contradiction and prevent a future Orchestra release
from entering polygram without an explicit manifest change.

**Requirements:** R7, R8, R9, R11

**Files:**

- Polygram: `lib/prompt.js`
- Polygram: `polygram.js`
- Polygram: `skills/polygram-send/SKILL.md`
- Polygram: `tests/prompt.test.js`
- Polygram: `tests/sdk-callbacks.test.js`
- Polygram: `tests/orchestra-dependency-contract.test.js`
- Polygram: `package.json`
- Polygram: `package-lock.json`

**Dependencies:** U1; may proceed in parallel with U2 after the reviewed plan is
approved.

**Approach:**

1. Add backend-aware prompt tests before editing prompt generation.
2. Resolve prompt backend through the existing `pickBackend` path, including topic
   overrides.
3. Keep SDK guidance unchanged and replace only the CLI contradiction.
4. State explicitly that a transcript answer is not proof of delivery; without a
   successful reply receipt, the agent must send the result now and must not claim
   it was already posted.
5. Rewrite the bundled skill's delivery section into explicit SDK, CLI/channels,
   and IPC lanes with the same honest-delivery rule.
6. Add an isolated-topic autonomous callback test for both
   `alreadyDelivered:false` and `alreadyDelivered:true`.
7. Change the current Orchestra dependency from `^0.4.2` to exact `0.4.2` and lock
   the same version.
8. Add a contract test that rejects non-exact manifest specs and an installed
   Orchestra version different from the manifest.
9. Do not bump polygram's package or plugin version in this feature PR.

**Test Scenarios:**

- SDK prompt retains ordinary inline-delivery guidance.
- CLI prompt requires reply MCP and omits both contradictory phrases.
- CLI prompt cannot infer “already sent” from assistant transcript history.
- A topic backend override selects the matching prompt.
- The send skill has three non-conflicting lanes.
- Undelivered autonomous output reaches the isolated topic once.
- Already-delivered autonomous output sends nothing.
- Caret, tilde, range, or manifest/install mismatch fails the dependency test.

**Verification:**

- Focused prompt, callback, and dependency tests.
- Polygram: `npm test`
- `git diff --check`

### U4. Verify cross-package behavior and open the correctness PRs

**Goal:** Prove the unpublished Orchestra source works through polygram without
writing a false registry lock, then hand both changes to review.

**Requirements:** R1 through R9, R11, R12

**Files:**

- No durable source file beyond U2 and U3.
- Temporary tarball and install state live under a mode-700 temporary directory.

**Dependencies:** U2, U3

**Approach:**

1. Run `npm pack --pack-destination <tmp>` in the Orchestra branch.
2. Create a mode-700 temporary copy of polygram, excluding `.git` and
   `node_modules`.
3. In that copy only, change the manifest to exact `0.4.3`, install the local
   tarball with `--no-save`, assert `package.json` still declares exact `0.4.3` and
   `node_modules/@shumkov/orchestra/package.json` reports `0.4.3`, and run focused
   autonomous callback/dependency coverage plus full `npm test`. Treat any
   tarball-resolved temporary lock entry as local evidence, not a registry lock.
4. Independently run `npm ci` and full `npm test` in the live polygram worktree,
   which remains exact `0.4.2`.
5. Run independent multi-agent code reviews of each diff and fold must-fixes.
6. Commit with signed commits. The Orchestra bug-fix commit records the exact
   red-to-green proof.
7. Push:
   - Orchestra `fix/autonomous-stop-delivery`;
   - polygram `investigate/workflow-delivery-loss`.
8. Open an Orchestra fallback PR and a polygram prompt/findings PR. Mark the
   polygram PR's deterministic dependency integration as pending until `0.4.3`
   exists in the registry.

**Test Scenarios:**

- The packed `0.4.3` source emits the new event into polygram's isolated-topic
  pipeline.
- The temporary manifest remains exact `0.4.3` and installed package reports
  `0.4.3`; no `file:` spec is accepted in the manifest.
- The live worktree remains exact `0.4.2` with no tarball path in its manifest or
  lock.
- Both PR diffs exclude the Claude pin.

**Verification:**

- Orchestra: `npm test`
- Polygram against packed Orchestra: `npm test`
- Live polygram worktree: `npm test`
- `git status --short` in both repositories
- PR checks green

### U5. Integrate the published fallback release

**Goal:** Make a registry-reproducible polygram release consume the deterministic
fallback.

**Requirements:** R8, R9, R12

**Files:**

- Polygram: `package.json`
- Polygram: `package-lock.json`
- Polygram: `tests/orchestra-dependency-contract.test.js`

**Dependencies:** U4; user review/merge of the polygram prompt PR; user
review/merge/tag/publication of Orchestra `0.4.3`

**Approach:**

1. Verify `npm view @shumkov/orchestra@0.4.3 version` returns `0.4.3`.
2. Change the exact dependency and lock from `0.4.2` to `0.4.3`.
3. Run focused and full suites from a clean `npm ci`.
4. Open the fallback-integration PR. Do not merge or deploy.

**Test Scenarios:**

- Fresh install resolves exactly `0.4.3`.
- Manifest/install mismatch or a range spec fails CI.

**Verification:**

- `npm ci`
- `npm test`
- `npm ls @shumkov/orchestra`

### U6. Build a reproducible Claude Code upgrade gate

**Goal:** Ensure every claimed old/new check actually uses and attests the selected
binary, including a real out-of-turn Workflow completion.

**Requirements:** R10, R11, R12

**Files:**

- Polygram: `scripts/spikes/claude-executable.mjs`
- Polygram: `scripts/spikes/workflow-autonomous-completion.mjs`
- Polygram: `scripts/spikes/delayed-mcp-background.mjs`
- Polygram:
  `scripts/spikes/fixtures/workflow-plugin/.claude-plugin/plugin.json`
- Polygram:
  `scripts/spikes/fixtures/workflow-plugin/workflows/completion-sentinel.js`
- Polygram: `scripts/spikes/post-tool-batch.mjs`
- Polygram: `scripts/spikes/subagent-task.mjs`
- Polygram: `scripts/spikes/session-resume.mjs`
- Polygram: `scripts/spikes/compact-boundary.mjs`
- Polygram: `scripts/spikes/tool-less-drain.mjs`
- Polygram: `scripts/spikes/README.md`
- Polygram: `AGENTS.md`
- Polygram: a focused test for the executable helper

**Dependencies:** U5; the published fallback is integrated and the correctness fix
has completed its separately authorized staging checkpoint; tracking issue opened
before any pin edit.

**Approach:**

1. Create polygram branch `upgrade/claude-code-2.1.218-gates` from current main and
   open `bump claude CLI v2.1.173 → v2.1.218`.
2. Add one helper that requires a selected binary, sets
   `ORCHESTRA_CLAUDE_BIN` for CLI/channels and `POLYGRAM_CLAUDE_BIN` for SDK,
   resolves the path, verifies `--version`, computes SHA-256, creates a per-run
   artifact directory, and supplies `pathToClaudeCodeExecutable` to Agent SDK
   queries.
3. Update only the five named SDK spikes to use the helper and report executable,
   SDK version, session id, model/effort, elapsed time, and artifact path.
4. Deliberately revise `subagent-task.mjs` assertions for the
   `2.1.198`/`2.1.211` background and forwarding semantics rather than preserving
   an obsolete foreground assumption.
5. Add a version-controlled minimal local plugin exposing one bounded Workflow.
   Load it into the isolated test configuration via the candidate CLI's supported
   local-plugin mechanism, record the fixture tree/config SHA-256, and preflight
   that the tool is available and emits a `Workflow` tool-use plus a natively
   sourced matching task notification. Absence or provenance drift is `BLOCKED`.
6. Add a bounded real-Claude Workflow scenario with a unique sentinel:
   launch resolves first; completion arrives later; no second user message is
   injected; exactly one user-visible completion is observed; sanitized hook,
   channels, and JSONL artifacts are saved.
7. Add `scripts/spikes/delayed-mcp-background.mjs`, a lowered-threshold delayed MCP
   scenario covering the `2.1.212` auto-background risk.
8. Correct `AGENTS.md` and `scripts/spikes/README.md` to name current gates and
   Orchestra as pin owner. Mark other scripts that import deleted modules as
   historical/stale; do not repair them.
9. Run polygram's full suite, obtain independent code review, commit, push, and
   open the upgrade-gate PR before changing the Orchestra pin.

**Test Scenarios:**

- Missing, divergent, or non-executable CLI/SDK selectors fail loudly.
- Helper attestation matches the chosen old/new path and checksum.
- Every constructed `CliProcess.claudeBin` and Agent SDK query path equals the
  selected binary; any selector mismatch aborts.
- Every SDK spike passes the explicit executable to `query()`.
- Workflow fixture provenance/config hash and expected notification shape are
  attested before the lifecycle assertion.
- Workflow sentinel is visible once without a later user prompt.
- Saved artifacts exclude prompt/report content and retain ordering evidence.

**Verification:**

- Focused helper test.
- Polygram: `npm test`
- Manual inspection of one sanitized artifact bundle.

### U7. Compare `2.1.173` and `2.1.218`, then open the pin PR

**Goal:** Advance the pin only with reproducible compatibility evidence and an
offline-safe rollback.

**Requirements:** R10, R11, R12

**Files:**

- Orchestra: `lib/claude-bin.js`
- Orchestra: `package.json`
- Orchestra: `package-lock.json`
- Sanitized run artifacts attached to the tracking issue and linked from the
  Orchestra pin PR; no unowned polygram source change

**Dependencies:** U5, U6; the correctness staging checkpoint is explicitly
approved and complete; the polygram upgrade-gate PR is merged; Orchestra
`upgrade/claude-code-2.1.218` starts from main after `0.4.3` is released.

**Approach:**

1. Preserve/checksum `2.1.173` outside Orchestra's garbage-collected vendor
   directory and prove the fallback path can resolve it.
2. Run the same adapter commit, model, effort, argv, relevant environment, and
   isolated test account serially against:
   - old: `~/.local/share/orchestra/claude-bin/2.1.173`;
   - candidate: `~/.local/share/claude/versions/2.1.218`.
   Set both `ORCHESTRA_CLAUDE_BIN` and `POLYGRAM_CLAUDE_BIN` to the selected path
   for each run.
3. Capture binary path/version/checksum, session id, startup pane/ready signal, raw
   and normalized hooks, session JSONL, channels tool calls, autonomous events, and
   task-notification-to-Stop ordering. Copy each run's JSONL before the next run.
   Preflight that every constructed CLI process and SDK query reports that exact
   selected path; abort the run on any mismatch.
4. Run:
   - current channels real-Claude scenarios;
   - rich-media real-Claude scenarios;
   - Workflow autonomous-completion scenario;
   - delayed MCP auto-background scenario;
   - the five explicit-binary SDK spikes.
5. Record every gate as `PASS`, `FAIL`, or `BLOCKED` with command, executable
   attestation, elapsed time, and artifact path. Any non-PASS blocks the pin.
6. While background work is active, capture the recursive process tree rooted at
   the launched Claude process, correlate daemon/worker descendants to the run,
   and record each executable path and reported version. An absolute parent binary
   alone is insufficient proof across daemon-handover releases; inability to
   correlate the worker is `BLOCKED`, not an inferred pass.
7. Only after all gates pass, change `CLAUDE_CLI_PINNED_VERSION` to `2.1.218` and
   bump Orchestra to `0.5.0`.
8. Run Orchestra's full suite, perform independent multi-agent code review, commit,
   push, and open the separate pin PR. Do not merge or publish.

**Test Scenarios:**

- Old and new Workflow runs both deliver one sentinel after launch-turn closure.
- Hook names/fields, Stop ordering, reply/ask/edit, folding, cancellation,
  background shell, multiline input, rich media, resume, compact, tool-only drain,
  and subagent completion have explicit results.
- A background worker version mismatch blocks the pin.
- Restoring the preserved old binary and `0.4.3` package state is rehearsed before
  staging.

**Verification:**

- Orchestra: `npm test`
- Polygram: `npm test`
- All live-gate records are `PASS`
- `git diff` for the Orchestra pin PR contains no fallback redesign

### U8. Integrate the CLI release and stage it separately

**Goal:** Make the new pin opt-in for polygram and validate routing and research
quality before partner rollout.

**Requirements:** R9, R10, R11, R12

**Files:**

- Polygram: `package.json`
- Polygram: `package-lock.json`

**Dependencies:** User review/merge/tag/publication of Orchestra `0.5.0`; U7

**Approach:**

1. Advance polygram's exact dependency from `0.4.3` to `0.5.0`.
2. Run `npm ci`, focused dependency checks, and full `npm test`.
3. Open a separate polygram CLI-upgrade PR. Do not merge or deploy.
4. After later merge/release/deploy authorization outside this execution, stage on
   shumorobot for at least 24 hours with:
   - one synthetic DM Workflow;
   - one isolated-topic Workflow;
   - one representative FAQ research run.
5. Compare completion count, routing, elapsed time, evidence/report completeness,
   agent topology, startup/hook telemetry, and autonomous fallback usage.
6. Roll back to exact `0.4.3` and preserved `2.1.173` on any lifecycle or research
   regression. Roll to shumabit and umi-assistant only after separate approval.

**Test Scenarios:**

- Fresh install resolves exactly `0.5.0`.
- DM and isolated-topic completions each arrive once.
- Representative research remains complete despite the 20-agent/depth defaults.
- Rollback works without downloading a deleted or garbage-collected binary.

**Verification:**

- `npm ci`
- `npm test`
- `npm ls @shumkov/orchestra`
- The integration PR itself: `npm ci`, `npm test`, and exact dependency output.
- External post-merge rollout gate: 24-hour staging evidence reviewed before any
  partner rollout.

## Verification Contract

### Automated correctness gates

- Orchestra focused regression command must show red on `0.4.2`, then green after
  U2.
- Orchestra full suite: `npm test`.
- Polygram focused prompt/callback/dependency tests.
- Polygram full suite: `npm test`.
- Both suites must be 100% green; skipped or environment-gated tests are reported
  explicitly and never described as passing.
- `git diff --check` is clean in both repositories.

### Cross-package gate

Use a local `npm pack` tarball in a mode-700 temporary polygram copy whose manifest
declares exact `0.4.3`. Assert the installed package reports `0.4.3`, run focused
and full suites there, and treat its tarball-resolved lock as non-registry evidence.
Separately run the live worktree's full suite at exact `0.4.2`, and prove no local
path entered its `package.json` or `package-lock.json`.

### Live Claude Code gate

Each old/new run records:

- executable path, `--version`, and SHA-256;
- both selector values plus constructed CLI and SDK executable attestations;
- SDK version, model, effort, argv, and relevant channel environment;
- local Workflow fixture/config hash and preflight provenance result;
- session id and copied JSONL artifact path;
- startup/ready evidence, raw and normalized hook names/fields;
- channel tool calls, autonomous events, and final ordering;
- `PASS`, `FAIL`, or `BLOCKED`, elapsed time, and sanitization confirmation.

Background and Workflow comparisons run serially in an isolated account/environment.
The real Workflow gate is mandatory; generic channel startup tests cannot substitute.

### Review and release gates

- Independent multi-agent code review follows implementation in each repository.
- Signed commits only.
- PR CI must be green before handoff.
- No merge, package publish, tag, or deployment is performed in this execution.
- The pin issue exists before the pin changes.
- The `0.5.0` pin PR cannot open until `0.4.3` is released and old/new live gates
  pass.

## Definition of Done

Current authorized execution:

- **U1:** Both repos are on current baselines; incident artifacts are preserved; no
  unrelated changes were touched.
- **U2:** Production-shaped test is demonstrably red then green; Workflow
  provenance, fragmented ancestry, same-branch delivery receipts, resume,
  prior-cycle isolation, pending compatibility, eviction pinning, and teardown
  tests pass; Orchestra full suite is green.
- **U3:** SDK/CLI prompts and skill wording are consistent; isolated-topic callback
  behavior is pinned; dependency is exact `0.4.2`; polygram full suite is green;
  no prompt treats transcript text as proof of delivery.
- **U4:** Packed-source cross-package tests pass and registry state is restored
  cleanly; both correctness diffs have passed independent code review; the
  Orchestra fallback PR and polygram prompt/findings PR are open.

Future resumable waves, each complete only after its named operator prerequisite:

- **U5:** Published fallback is consumed as exact `0.4.3`; integration PR is open.
- **U6:** Every named spike selects and attests its executable; the Workflow and
  delayed-MCP gates exist; stale gate docs are accurate; the dedicated polygram
  upgrade-gate PR is open.
- **U7:** All old/new gates pass; rollback binary is preserved and rehearsed;
  Orchestra `0.5.0` pin PR is open and contains no fallback redesign.
- **U8:** Polygram exact `0.5.0` integration PR is open. The separate post-merge
  rollout gate requires later staging evidence to meet the DM/topic/research
  acceptance criteria before partner rollout.
- **Current global handoff:** abandoned experimental code and temporary
  tarballs/scripts are removed;
  both worktrees contain only intended changes; no sensitive production content is
  committed; no merge, publish, tag, or deployment occurred.
