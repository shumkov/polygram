---
title: Shumabit Scoped Shared Memory - Plan
type: feat
date: 2026-07-31
topic: shumabit-scoped-memory
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
implementation_gate: extraction-processor-approval
execution: code
---

# Shumabit Scoped Shared Memory - Plan

## Goal Capsule

- **Objective:** Give Shumabit one automatic, provider-neutral memory system with general UMI memory, person-private memory, and partner-private memory while preserving the different read and write rules Ivan specified for UMI team members and UMI partners.
- **Product authority:** Ivan's decisions in the 2026-07-31 Polygram/Codex design session define the channel roles, read scopes, write destinations, classification default, and separation between team-member and partner behavior.
- **Backend constraint:** Reuse memsearch as the Markdown-backed semantic index behind a thin policy router; do not build or adopt a second memory engine.
- **Execution profile:** This is cross-repository code and infrastructure work.
- **Open blocker:** Ivan must approve the fixed extraction processor and its data boundary before U3 begins. The reviewed recommendation is one Anthropic structured-output call for every backend; the non-egress alternative is a fixed local extractor evaluated against the same fixture set.
- **Release gates:** Bounded memsearch isolation, same-UID peer attestation, cross-scope publication visibility, and extraction-quality spikes must pass before rollout.

---

## Product Contract

### Summary

Polygram owns a deterministic memory policy client that derives authorized scopes from Telegram identity, sender authorization, and configured channel role.
A local scoped-memory service uses memsearch for storage and search, gives Claude and Codex the same scoped recall, and automatically captures durable memories after delivered turns.

### Problem Frame

Shumabit currently has one workspace-wide memsearch collection and agent-file instructions that restrict long-term memory to Ivan's main session.
That arrangement provides useful recall but cannot express separate person-private, general UMI, and partner scopes.
It also relies on the model to respect a privacy instruction instead of ensuring that ordinary memory operations only reach the scopes allowed for the current channel.

Provider switching makes a provider-owned memory path worse.
Claude and Codex sessions in the same Telegram chat should remember the same facts without copying data into separate provider stores.

### Key Decisions

- **Keep one memory engine behind a policy adapter.** (session-settled: user-approved — chosen over Mem0, Supermemory, Graphiti, and a custom vector store: memsearch already provides the required Markdown and semantic-index layer.) Governs R14-R18, R24-R28.
- **Keep team-member and partner policies distinct.** (session-settled: user-directed — chosen over one unified private-memory policy: partners must never read general UMI memory.) Governs R5-R11.
- **Duplicate partner memory without a shareability classifier.** (session-settled: user-directed — chosen over separate partner-private and partner-to-UMI write decisions: Ivan specified that the partner and general UMI copies contain the same safe durable data.) Governs R11.
- **Default uncertain team memories to general UMI.** (session-settled: user-directed — chosen over a privacy-first uncertain result: Ivan wants information shared unless it can be identified as private.) Governs R6, R38.
- **Make capture automatic.** (session-settled: user-directed — chosen over per-memory approval: memory should work without manual confirmation.) Governs R19-R21, R37.
- **Treat agent instructions as guidance, not enforcement.** (session-settled: user-approved — chosen over an AGENTS.md-only boundary: the router must own scope selection.) Governs R2-R4, R13-R18, R25.
- **Quarantine the legacy corpus from general and partner recall.** The current unscoped collection contains Ivan-session and chat-derived material, so migration must not reinterpret it as general UMI data. Governs R26.
- **Separate provider processes from memory storage.** The scoped-memory service and its data run under a distinct production OS identity; Claude and Codex receive only turn-bound router operations. Governs R15, R18, R25.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan owns provider-neutral Shumabit memory policy, routing, storage topology, automatic capture, and recall.
The broader breakdown is the current understanding rather than a committed roadmap.

- **Can proceed independently of:** Polygram's model-label and settings-card cleanup.
- **Can proceed independently of:** Enabling Codex web access and Shumabit skills.
- **Enables:** The same memory behavior when a Telegram chat switches between Claude and Codex.
- **Supersedes:** Direct Codex access to the current workspace-wide memsearch collection in `polygram/docs/plans/2026-07-31-001-feat-codex-shumabit-parity-and-config-ux-plan.md`.
- **Shares:** Polygram's authenticated bot, chat, topic, and sender context as the routing authority.
- **Depends on:** A deployment-owned registry that classifies each enabled channel and authorizes its senders as a team DM, person-private group, shared UMI group, or partner channel.

### Actors

- A1. **UMI team member:** A verified person using their DM or an explicitly assigned private group.
- A2. **Shared UMI group participant:** A verified sender in a configured UMI team group.
- A3. **UMI partner:** A participant using a configured partner assistant channel.
- A4. **Polygram memory policy client:** The only component allowed to turn Telegram context into authorized opaque memory scopes.
- A5. **Memory extractor and classifier:** Produces durable memory candidates and the limited judgment needed by the routing rules.
- A6. **Scoped-memory service:** Runs separately from provider children, owns capture reconciliation, and exposes only authenticated scope-bound operations.
- A7. **Memsearch:** Maintains scoped Markdown sources and rebuildable semantic indexes behind the scoped-memory service.
- A8. **Claude or Codex:** Receives authorized recalled context and may request deeper recall through the same scope-bound interface.

### Architecture Boundary

```mermaid
flowchart TB
  T[Authenticated Telegram turn] --> P[Polygram scope registry]
  P --> R[Scope-bound memory request]
  R --> M[Local scoped-memory service]
  M --> Q[Authorized memsearch queries]
  Q --> C[Bounded recalled context]
  C --> A[Claude or Codex turn]
  A --> X[Durably delivered turn]
  X --> E[Durable-memory extraction]
  E --> S[Secret suppression and classification]
  S --> M
  M --> G[General UMI scope]
  M --> U[Person-private scope]
  M --> N[Partner-private scope]
```

Polygram supplies authenticated, authorized opaque scopes when it invokes recall.
Neither provider supplies a collection name, person identifier, partner identifier, or visibility label.
The scoped-memory service and its data run under a separate production OS identity, and its credential is not inherited by provider children.
Memsearch remains an implementation detail behind that service.

### Requirements

**Identity and channel policy**

- R1. The memory policy is provider-neutral, so changing a chat between Claude and Codex does not change its readable or writable memory.
- R2. Polygram derives memory access from authenticated bot, chat, topic, and sender identifiers plus an explicit role and sender allowlist for that exact channel/scope pair.
- R3. An unmapped or internally inconsistent channel runs with memory recall and capture disabled and emits an operator-visible diagnostic.
- R4. Every private channel maps to one immutable typed principal identity, person or partner, and never infers it from a display name, username, model output, or conversation content.

**UMI team-member behavior**

- R5. A UMI team member's DM and assigned private groups read that person's private memory plus general UMI memory.
- R6. In a team member's private channel, credentials, access details, infrastructure identifiers, security weaknesses, personally private material, and non-UMI material route to that person's private memory; all other material routes to general UMI memory, including a valid semantic result that is uncertain.
- R7. All DMs and assigned private groups for the same team member share one person-private scope.
- R8. A shared UMI group reads general UMI memory only.
- R9. Every safe durable memory captured in a shared UMI group writes to general UMI memory without person-private classification.

**UMI partner behavior**

- R10. A partner channel reads only that partner's private memory.
- R11. Each durable memory that survives deterministic secret suppression in a partner channel is written idempotently with the same normalized content to both that partner's private memory and general UMI memory.
- R12. A partner channel never reads general UMI memory, another partner's memory, or a UMI team member's private memory.

**Safety and enforcement**

- R13. Raw passwords, tokens, private keys, authentication codes, session cookies, and equivalent secret values are suppressed before any auxiliary extraction/classification request and before every memory write.
- R14. The router, not Claude, Codex, an agent file, or a skill, chooses the authorized read scopes and write destinations.
- R15. A provider can request deeper recall only through a scope-bound operation created for the current Telegram turn.
- R16. Recall fails closed: an unavailable, unknown, or malformed scope never falls back to another collection or to the legacy workspace-wide collection.
- R17. Agent instructions and a shared provider-neutral memory skill explain recall and capture behavior but cannot widen the scopes selected by the router.
- R18. Production provider children cannot read memory source/index/backup paths, invoke memsearch directly, or inherit the scoped-memory service credential; the boundary does not claim protection from root or a compromised Polygram process.

**Automatic recall and capture**

- R19. Before each eligible provider turn, the router performs bounded semantic recall over exactly the authorized read scopes and injects deduplicated normalized facts in a delimited data-only block.
- R20. After a durably delivered turn, one backend-independent extraction/classification contract automatically proposes memories without a command or approval and never uses the selected Claude/Codex session backend as a policy input.
- R21. The scoped-memory service persists one immutable capture job and normalized candidate set before memory side effects, then reconciles a protected destination ledger keyed by stable source-turn and candidate identifiers without rerunning extraction after that candidate checkpoint.
- R22. Stored memories carry enough provenance to correct, delete, deduplicate, audit, and rebuild them without retaining raw transcripts in the semantic index.
- R23. The first release provides an operator-only tombstone operation that blocks future recall and reconciles every derived copy, while documenting that already delivered provider-session context and retained backups are not retroactively erased.

**Backend and infrastructure**

- R24. Memsearch remains the semantic backend, with a distinct Markdown source path and collection for general UMI, each person-private scope, and each partner-private scope.
- R25. Legacy direct memory hooks, skills, executables, databases, `MEMORY.md`, daily-memory corpora, and other cross-scope memory artifacts are disabled, relocated, or technically excluded before activation, and Claude/Codex receive no configured filesystem or command access to scoped memory state.
- R26. The current unscoped Shumabit corpus becomes an Ivan-only read-only source inside Ivan's private authorization set, receives no new writes, and is never queried for another principal.
- R27. Markdown is the recoverable source of truth; indexes can be rebuilt per scope without changing authorization or provenance.
- R28. Backup, restore, integrity checks, retention, and tombstone reapplication operate per scope so recovery cannot merge or resurrect private, general, or partner data.
- R29. Operators can independently disable recall and capture globally or for one mapped scope without changing the selected Claude/Codex backend.
- R30. Structural telemetry and every child/provider error path use opaque identifiers and bounded error codes without logging memory text, recalled snippets, queries, Telegram content, raw stderr, or secret values.
- R31. The deployed scope registry, storage topology, ownership, backup/restore procedure, security boundary, monitoring, and rollback controls are documented in the Shumabit VPS infrastructure repository without secret values.
- R32. A release-gating spike must prove multi-collection isolation, concurrent query/write behavior, deletion, rebuild, and negative cross-scope sentinels against the deployed memsearch backend or block rollout until a separately isolated topology passes.
- R33. The effective memory-scope set and binding-specific authorization digest are part of provider-session identity, so a scope remap or authorization change retires affected Claude and Codex sessions and quarantines incompatible queued work before memory is enabled again. A separate full-registry digest exists for deployment auditing and wire compatibility but does not retire unrelated sessions.
- R34. Each turn carries an immutable policy snapshot, but capture revalidates the binding-specific authorization digest, sender authorization, scope mapping, and kill-switch state immediately before commit and quarantines a changed or revoked job without writing.
- R35. Extraction stores normalized declarative facts rather than transcript passages and rejects instruction-shaped content, destination requests, scope labels, and tool-control text.
- R36. Initial cutover freezes and hashes the legacy corpus, disables old writers and recall paths, quarantines its backups, and starts fresh non-Ivan provider sessions before scoped memory becomes available.
- R37. Capture eligibility requires Polygram's durable Telegram delivery finalization, an immutable identity for the complete consumed Telegram-message set plus provider turn, and durable identities for the delivered outbound messages. Failed, ambiguous, interrupted, or superseded attempts do not capture; attached file bytes and local paths are never extraction input.
- R38. Team-private classification returns a structured `private`, `general`, `reject`, or `failure` result; only a valid semantic uncertainty defaults to general, mixed-sensitivity candidates route private, and operational or malformed results write nothing.
- R39. A logical record with multiple destinations remains unavailable to recall until every required destination is committed or tombstoned in its durable ledger.

### Key Flows

- F1. Team member private-channel turn
  - **Trigger:** A verified team member sends a message in their DM or assigned private group.
  - **Actors:** A1, A4, A5, A6, A7, A8
  - **Steps:** The router reads person-private plus general UMI memory, the selected provider answers, extraction suppresses secrets, and classification sends one candidate to either the person's private scope or general UMI.
  - **Outcome:** The person receives both useful company context and private continuity without another person's memory.
  - **Covered by:** R1-R7, R13-R23, R34, R37, R38

- F2. Shared UMI group turn
  - **Trigger:** A message arrives in a configured shared UMI group.
  - **Actors:** A2, A4, A5, A6, A7, A8
  - **Steps:** The router reads general UMI only, then stores every safe durable candidate in general UMI without choosing a person-private scope.
  - **Outcome:** The group contributes to company memory without selecting an arbitrary person's private scope.
  - **Covered by:** R2, R3, R8, R9, R13-R23, R34, R35, R37

- F3. Partner turn
  - **Trigger:** A message arrives through a configured partner assistant channel.
  - **Actors:** A3, A4, A5, A6, A7, A8
  - **Steps:** The router reads that partner's scope only, then writes each safe durable candidate to that partner's scope and general UMI with linked provenance.
  - **Outcome:** The partner gets isolated continuity while the UMI team receives the same operational knowledge.
  - **Covered by:** R1-R4, R10-R23, R34, R35, R37, R39

- F4. Provider switch
  - **Trigger:** An eligible chat changes from Claude to Codex or from Codex to Claude.
  - **Actors:** A4, A6, A7, A8
  - **Steps:** Polygram preserves the channel role and memory identity, then the new provider receives recall from the same authorized scopes.
  - **Outcome:** Provider switching changes the session runtime but not memory ownership or history.
  - **Covered by:** R1, R2, R14-R17, R19, R24, R25

- F5. Scope, authorization, or kill-switch change
  - **Trigger:** An operator remaps a channel, changes its sender allowlist, disables memory, or removes a principal.
  - **Actors:** A4, A6, A8
  - **Steps:** A binding or sender-authorization change produces a new policy identity, quarantines incompatible queued/capture work, and retires both provider sessions before accepting memory-enabled turns under the new mapping. A kill-switch change immediately blocks new recall/capture and quarantines affected capture work without retiring provider sessions.
  - **Outcome:** Previously recalled context cannot silently cross into a newly authorized scope, while an operational disable does not destroy conversation continuity.
  - **Covered by:** R2-R4, R29, R33, R34

### Acceptance Examples

- AE1. **Covers R2, R5-R7.** Given Ivan's DM and Ivan's assigned private group, when an allowlisted sender uses either channel, then both can retrieve Ivan-private and general UMI items but not another person's private items.
- AE2. **Covers R6, R20, R37.** Given a normal delivered turn contains a durable UMI product fact in a team member DM, when no memory command or approval occurs, then capture runs automatically and writes the fact to general UMI.
- AE3. **Covers R6, R20, R38.** Given a team-private candidate receives a valid semantically uncertain classification, when capture commits, then it writes to general UMI; a timeout, malformed response, or classifier failure writes nothing.
- AE4. **Covers R6, R13.** Given an infrastructure identifier and a raw token in a team member DM, when capture runs, then the identifier may be stored only in that person's private scope and the raw token reaches no extractor, memory source, index, log, or backup.
- AE5. **Covers R8, R9, R13.** Given a shared UMI group contains a safe durable fact and a raw secret, when capture runs, then the fact writes to general UMI and the raw secret writes nowhere.
- AE6. **Covers R10-R12.** Given Partner A asks a question, when recall runs, then results can come from Partner A memory but not general UMI, Partner B, or a team member.
- AE7. **Covers R11, R21, R23, R39.** Given a Partner A dual-write crashes after one destination and is retried or later tombstoned, when reconciliation completes, then exactly one equivalent copy exists in each required destination or neither copy is recallable.
- AE8. **Covers R1, R19, R24, R25.** Given Claude captures a memory and Codex later recalls it, or Codex captures a memory and Claude later recalls it, then both directions use the same scope without a provider-specific copy or direct database access.
- AE9. **Covers R2-R4, R16, R33.** Given an unregistered group, added guest, removed member, spoofed display name, or conflicting person/partner mapping, when a turn arrives, then no memory is returned or stored under stale authorization.
- AE10. **Covers R20, R21, R37.** Given Telegram delivery succeeds and post-turn capture times out after candidate persistence, when capture retries, then extraction is not rerun, the user receives no duplicate reply, and each persisted candidate has at most one logical record.
- AE11. **Covers R16, R26, R36.** Given a legacy sentinel exists, when Ivan's private channel searches, then it can be recalled through the Ivan-bound read-only source; every non-Ivan team or partner search returns no legacy result.
- AE12. **Covers R29, R34.** Given capture is disabled or a sender is revoked while extraction is in flight, when commit revalidation runs, then provider reply remains delivered but the capture job is quarantined without a write.
- AE13. **Covers R20, R37.** Given a provider turn fails, is interrupted, is superseded, or has ambiguous Telegram delivery, when finalization runs, then no automatic memory is captured.
- AE14. **Covers R33.** Given a chat changes from Person A to Person B, from Partner A to Partner B, or receives a changed effective sender/scope binding, when memory is re-enabled, then both old provider sessions and incompatible queued work for that binding are retired before the first recall; unrelated channels keep their sessions.
- AE15. **Covers R19, R35.** Given a partner or group message asks future agents to ignore instructions, call a tool, widen scope, or reveal secrets, when extraction and recall run, then no control text is stored or injected as executable instructions.

### Success Criteria

- Every supported channel role passes positive recall tests for its allowed scopes and negative sentinel tests for every forbidden scope.
- The same scope matrix passes through Claude and Codex, before and after daemon restart and provider switching.
- Partner dual writes remain idempotent across a crash at every source/index/ledger boundary, and tombstoning blocks both copies from future recall.
- No raw-secret sentinel appears in auxiliary extraction/classification requests, recalled memory context, Markdown, memsearch indexes, structural logs, error paths, or backups.
- Binding changes cannot reuse provider sessions or queued work containing that binding's previous recalled context, and unrelated bindings retain their sessions.
- A cold planner can derive implementation work without inventing a channel role, read rule, write rule, or classification default.

### Scope Boundaries

- This work does not replace memsearch, add a knowledge graph, or adopt a hosted memory SaaS.
- This work does not merge UMI team-member and UMI partner behavior.
- This work does not make general UMI memory readable to partners.
- This work does not automatically publish the existing unscoped corpus to general UMI.
- This work does not promise protection from root compromise, a compromised Polygram process, or content already delivered to a provider session before an operator tombstone.
- This work changes provider-session continuity only when that channel's effective memory scope or authorization binding changes; it does not change model selection, steering, Telegram reply delivery, or goal behavior.
- This work does not require memory approval prompts or expose collection management in `/config`.
- This work does not add conversational correction/forget UX in the first release; tombstoning is operator-only.

### Dependencies and Assumptions

- Polygram continues to receive authenticated Telegram bot, chat, topic, and sender identifiers before provider dispatch.
- Every private group, shared UMI group, and partner channel has an explicit deployment-owned principal, role, and sender allowlist before memory is enabled there.
- Memsearch's path and collection configuration can isolate multiple logical memories against the deployed backend; planning must prove concurrency and rebuild behavior with a bounded spike.
- The production memory service and its data run under a separate Unix principal, and Polygram authenticates without exposing the credential to provider children.
- Automatic extraction begins only after Polygram durably finalizes Telegram delivery.
- General UMI memory is internal UMI team data, not public content.
- Existing provider prompts treat recalled memory as untrusted declarative data rather than executable instructions.

### Outstanding Questions

**Resolved by the Planning Contract, except where explicitly gated**

- Which fixed supported provider/model or local classifier implements the backend-independent extraction contract remains the one pre-U3 user decision; the Planning Contract defines the comparison and acceptance gate.
- Which local authentication mechanism lets Polygram call the separate memory service without placing a reusable credential in provider environments, files, arguments, or logs?
- What bounded recall count and token budget produces useful context without crowding the active turn?
- What stable opaque identifiers and filesystem/collection names represent people and partners without embedding display names?
- What retention period applies to provenance and tombstones after the content itself is deleted?

### Sources and Research

- Current Shumabit policy and state: `shumabit-claude/AGENTS.md`, `shumabit-claude/_shumabit-base.md`, and `shumabit-claude/.memsearch/.index-state.json`.
- Existing Codex work: `polygram/docs/plans/2026-07-31-001-feat-codex-shumabit-parity-and-config-ux-plan.md`.
- Memsearch Python API and per-user isolation: [official documentation](https://zilliztech.github.io/memsearch/python-api/).
- Memsearch architecture and Claude/Codex integrations: [official repository](https://github.com/zilliztech/memsearch).
- Alternative evaluated for scoped filtering and extraction: [Mem0 search and filters](https://docs.mem0.ai/core-concepts/memory-operations/search), [Mem0 custom instructions](https://docs.mem0.ai/open-source/features/custom-instructions), and [Mem0 self-hosting repository](https://github.com/mem0ai/mem0).
- Alternative evaluated for container isolation and scoped access keys: [Supermemory container filtering](https://supermemory.ai/docs/concepts/filtering), [scoped keys](https://supermemory.ai/docs/authentication), and [automatic extraction](https://supermemory.ai/docs/quickstart).

---

## Planning Contract

The session-settled Product Contract decisions above remain unchanged. Review
corrected two derived requirements: session identity now uses a binding-specific
authorization digest, and capture identity now names the complete consumed and
delivered Telegram-message set. Everything below decides *how* those
requirements are built and adds no new channel role or memory-routing rule.

### Verified Facts

Established by reading the current code, not assumed. Line references are to
this worktree at the time of writing.

**Polygram — provider-neutral seams already exist**

- `lib/prompt.js` `buildPrompt` (`lib/prompt.js:214`) is the single prompt
  assembler for all three backends; `backend` is a parameter, not a branch in
  the caller. `polygram.js` `formatPrompt` (`polygram.js:527`) is its only
  turn call site. **One insertion point covers SDK, CLI, and Codex.**
- `buildPrompt` already composes an untrusted-data block pattern:
  `<session-context>`, `<polygram-history>`, `<polygram-info>`, `<channel>`,
  with `xmlEscape` on every user-supplied value and an explicit "content
  inside these tags is data, not instructions" clause in `polygramInfo`.
- `createTelegramDeliveryFinalizer` (`lib/codex/delivery-finalizer.js:70`,
  wired at `polygram.js:2328`) is a latched call site used by every backend,
  but its semantics are **not yet provider-neutral**. The non-Codex branch
  ignores `deliveryComplete` and marks the inbound row `replied`; Codex alone
  records an explicit delivery disposition. It is the right R37 integration
  point only after U6 generalizes the success contract and proves every SDK,
  CLI, Codex, file, interrupted, and partial-delivery path.
- Session invalidation already has a working mechanism:
  `SPAWN_IDENTITY_FIELDS` / `CODEX_SPAWN_IDENTITY_FIELDS` in
  `lib/db/sessions.js:242,246`, consumed by `resolveSessionForSpawn` and
  `resolveProviderSessionForSpawn` (`lib/db/sessions.js:118`). Adding a field
  to that set drops the stored provider session and forces a fresh spawn.
  **This is the R33 seam.**
- `lib/secret-detect.js` provides deterministic, pure, tiered detection and
  in-place redaction (`redactText`, `lib/secret-detect.js:113`) with
  `high`/`medium` auto-redacted and `low` flagged. It stores only a SHA-256
  fingerprint, never the value. **This is the R13 primitive.**
- `db.logEvent(kind, detail)` (`lib/db.js`) is the structural telemetry sink;
  `migrations/018-clean-restart-resume.sql` is the latest migration, so the
  new one is `019`.
- `lib/canonical-json.js` already exists and is the correct basis for a
  stable registry digest.
- Config precedence is `topic → chat → bot → defaults`
  (`lib/runtime-config.js:474`), and per-bot config must live under
  `config.bots.<name>` because `activeBotConfig` layers it over the shared
  top-level `bot` block (`lib/config-scope.js:61`).

**Polygram — what does not exist yet**

- **There is no per-sender authorization anywhere.** `shouldHandle`
  (`lib/handlers/should-handle.js`) gates on chat-allowlist, `requireMention`,
  and pairings only. R2's "explicit role and sender allowlist for that exact
  channel/scope pair" is entirely new surface.
- Polygram's DB is readable and writable by provider children (same Unix
  user), so it cannot be authoritative for candidate text, content hashes,
  destination state, global controls, or publication visibility. It may hold
  only delivery-outbox identifiers and structural receipts; `memoryd` owns the
  authoritative capture ledger and rejects work not received from an attested
  Polygram main process.
- A resolved provider turn does not currently expose one normalized complete
  set of consumed Telegram message IDs. Claude CLI has an internal
  `InputLedger`, SDK autosteer tracks queued contexts, and Codex has durable
  dispatch/steer attempt records, but Polygram receives no common result
  field. R37 therefore requires a small Orchestra contract change before U6.

**Shumabit workspace — the legacy corpus is wider than R25 enumerates**

- `.memsearch/.index-state.json` pins collection `ms_shumabit_claude_2f892669`
  over `/home/shumabit/shumabit-claude/.memsearch/memory` (103 files) with
  `milvus_uri: ~/.memsearch/milvus.db` — a Milvus-Lite file inside the
  `shumabit` home, readable by every provider child today.
- `.claude/settings.json` enables `memsearch@memsearch-plugins` **and** a
  `UserPromptSubmit` hook running `hooks/chat-session.sh` with
  `SESSION_DIR=$HOME/shumabit-claude/sessions` and
  `CROSS_SESSION_DIRS=$HOME/shumabit-partners/sessions`. That hook injects
  another agent's per-chat session file into this agent's turn — **a live
  cross-scope memory path that R25 must disable**, and the one legacy artifact
  that is genuinely cross-principal rather than merely unscoped.
- Polygram independently reads `<cwd>/sessions/<sessionKey>.md`
  (`polygram.js:323`). Injection is channel-local, but every provider child can
  read every file in the shared workspace directly. Retaining this corpus
  therefore violates the technical R25 boundary even if prompt injection is
  scoped correctly; it must be frozen and quarantined before activation.
- Legacy corpus also includes `MEMORY.md`, `memory/YYYY-MM-DD.md` (44 files in
  git, 103 in the indexed copy), and `USERS.md` (team directory with raw
  Telegram IDs — the raw material for the registry, but not the registry).

**Infrastructure — the separate-identity dependency is not yet met**

- `umi-vps-infra/docs/POLYGRAM_WATER_RUNTIME_ISOLATION_SPEC.md` §6.3 states
  plainly that the current split is "operational and resource isolation, not a
  same-UID security sandbox", and §18 records that **separate Unix users were
  deliberately deferred**. Both Polygram bots, Water, and every Claude/Codex
  child run as `shumabit` (uid 1000).
- Therefore this plan's "separate production OS identity" is not a
  configuration tweak on existing infrastructure — it is the first
  least-privilege identity on the host, and it is a hard prerequisite (U10)
  rather than a rollout detail.

**Orchestra**

- The Channels MCP bridge tool list is fixed in Orchestra at
  `lib/process/channels-bridge.mjs:454`: `reply`, `ask`, `edit_message`,
  `stream`. Any provider-callable memory tool for the CLI backend requires an
  Orchestra release. Release 1 does not add a memory tool, but it **does** need
  one bounded Orchestra result-contract change so all backends report the
  complete consumed Telegram-message set used by automatic capture.

### Resolved Planning Questions

The Product Contract's five deferred questions, answered.

**Q1 — Which fixed processor implements the extraction/classification
contract, and what budget applies?**

**Recommended, pending Ivan's explicit approval:** one fixed Anthropic
Messages API call issued by the memory service, never by the provider child
and never by the session backend (R20). Default model
`claude-haiku-4-5` with structured outputs
(`output_config.format` + a `json_schema`), `max_tokens` 2048, request timeout
10s, 2 retries with jittered backoff, hard per-job deadline 60s. Budget at
Haiku 4.5 rates ($1/$5 per MTok) is well under $0.01 per captured turn at the
bounded transcript sizes below. A labelled-fixture precision/recall gate (G3)
decides whether extraction escalates to `claude-sonnet-5`; the model ID is a
single config key so escalation is a config change plus a re-run of the gate,
not a code change.

Notes that shape the implementation: Haiku 4.5's minimum cacheable prompt
prefix is 4096 tokens, so the fixed system prompt will **not** engage prompt
caching at that tier (Sonnet 5's minimum is 1024) — do not build cost
projections that assume cache reads. Structured outputs pay a one-time schema
compilation cost per new schema, cached 24h.

Data boundary, stated plainly: for Claude-backed chats the turn content has
already been processed by Anthropic, so extraction adds no new vendor. For
**Codex-backed chats it does** — the same content is then sent to Anthropic
for extraction. That would be a deliberate consequence of R20's
"never uses the selected session backend as a policy input", and it is
recorded here rather than hidden. It is **not** accepted by this plan review.
Before U3, compare it with one viable fixed local extractor on the same
labelled privacy/durability fixture and record Ivan's processor choice,
allowed data classes, retention/logging posture, region, credential owner,
measured latency, and operating cost. Routing extraction to whichever vendor
answered the chat remains rejected because it makes remembered content
backend-dependent.

**Q2 — Which local authentication mechanism and state owner?**

A Unix domain data socket at `/run/shumabit-memory/memoryd.sock`, a root-only
administrative socket, and mandatory process attestation. The target-host
attestation spike is a release gate, not optional hardening:

1. *Data at rest (a real boundary).* All Markdown sources, indexes, the Milvus
   file, staging, and backups live under `/var/lib/shumabit-memory`, mode
   `0700`, owned by the `shumabit-memory` system user. A provider child
   running as `shumabit` cannot read them. This is what discharges R18's
   "cannot read memory source/index/backup paths".
2. *Peer attestation (mandatory).* Before parsing a request, the service reads
   the peer PID/UID from the kernel, verifies that PID is the current systemd
   `MainPID` of an allowlisted Polygram unit, and verifies its invocation and
   cgroup. UID equality is insufficient because provider children use the same
   uid. If the deployed kernel/Python/systemd combination cannot perform a
   race-safe check, memoryd fails closed and rollout stops.
3. *Short-lived recall ticket.* After attestation and policy validation,
   Polygram receives a 256-bit recall ticket bound to one provider turn, the
   exact read scopes, a small operation count, and a short TTL. It never lives
   in a file, environment variable, command line, log, or child environment.
4. *Durable capture job, not a long-lived turn ticket.* After confirmed
   Telegram delivery, the attested Polygram MainPID submits one bounded
   `enqueue_capture` request. Memoryd persists the job before acknowledging,
   then owns extraction, retries, authorization revalidation, destination
   reconciliation, and boot recovery. Polygram does not retain a reusable
   capture capability across restarts.
5. *Separate administration.* A second socket accepts uid 0 only, before
   parsing, for kill switches, tombstone, verify, backup, restore, and rebuild.
   The operator CLI runs through `sudo`; there is no reusable `admin_ticket`.

What this does **not** claim: root compromise or code execution inside the
Polygram MainPID or memoryd. It does reject an ordinary same-UID provider child
even if that child opens the data socket directly, reads or modifies
`shumabit.db`, or replays a structural receipt.

**Q3 — What bounded recall count and token budget?**

Defaults: at most **8 records** after cross-scope dedup, at most **2000
characters** rendered, at most **1200ms** wall clock for the whole recall call,
per-scope search `k = 6` before merge. All four are config keys under
`config.memory.recall`. Rationale: the existing `<polygram-history>` preload is
15 rows × ≤600 chars and is already the largest injected block; memory must
stay visibly smaller than history so it cannot crowd the turn. Over-budget
results are truncated by dropping lowest-scoring records whole — never by
cutting a record mid-sentence.

**Q4 — What stable opaque identifiers?**

Operator-assigned, validated, immutable slugs — not derived from display names,
usernames, or Telegram IDs, and not auto-generated from mutable identity:

- person scope: `p_<6-16 lowercase alnum>` (e.g. `p_7f3a1c`)
- partner scope: `pt_<6-16 lowercase alnum>`
- general scope: the literal `general`
- frozen legacy corpus: `legacy_<slug>` (release 1 has exactly one:
  `legacy_ivan`)

Filesystem: `/var/lib/shumabit-memory/scopes/<kind>-<id>/`. Collection name:
`ms_scope_<kind>_<id-without-underscore>`. The registry validator rejects
duplicate slugs, slugs containing a Telegram ID substring, and any change to a
slug that already has committed records (immutability is enforced by the
service refusing to open a scope whose directory exists under a different
registry-recorded identity).

**Q5 — What retention applies to provenance and tombstones?**

Provenance sidecars survive the record they describe: on tombstone, the
Markdown body is deleted and reindexed away, while the sidecar is reduced to
`{record_id, scope_id, keyed_content_digest, sibling_record_ids, tombstoned_ts,
actor, reason_code}` and retained **400 days**, then deleted by the same sweep
that prunes events. Tombstone entries themselves are retained for the same
400 days so a restore of an older backup can have tombstones re-applied
(R28). Scope backups are encrypted, root-restorable only, and retained at most
90 days. Each AEAD-authenticated encrypted generation binds a SQLite online
snapshot/export to the exact Markdown bodies and sidecars in its manifest; a
partner logical record's
linked scopes belong to the same generation. Restore occurs offline with all
logical records inactive, reapplies every still-retained tombstone, rebuilds
all required sibling indexes, and passes `verify` before recall is enabled.
Polygram's structural capture receipts are pruned 90 days after a
terminal state. Authoritative tombstones and provenance live only in memoryd.

### Key Technical Decisions

1. **The policy client lives in Polygram; protected memory state lives in a
   separate daemon.** (planning decision, implements R14/R18.) Polygram
   derives scopes from a validated in-memory registry snapshot and owns prompt
   injection and Telegram delivery settlement. A `memoryd` process under a
   distinct Unix identity owns the authoritative registry, controls, capture
   ledger, candidate text, publication visibility, Markdown, indexes,
   extraction, and classification. Rejected:
   an in-process memsearch adapter inside Polygram — it would put memory text
   and the extraction credential inside the same process tree as the provider
   children.

2. **`memoryd` ships in the Polygram repository as a Python service.**
   (planning decision.) `services/memoryd/`, released
   with the npm package, run by its own systemd unit under
   `shumabit-memory`. Python because memsearch's supported surface is Python
   and because `SO_PEERCRED` is available there. Same repo because the router
   and the service share one wire contract that must be tested together and
   released together. Rejected: a separate repo (contract skew between router
   and service across two release trains); `umi-vps-infra` (no test harness —
   it is Ansible, docs, and no `npm test`/`pytest` equivalent).

3. **Polygram's database is an outbox/receipt store, never the memory
   authority.** (implements R18/R30.) `shumabit.db` is readable and writable
   by provider children. It stores only one delivery-turn key, immutable
   inbound/outbound Telegram message IDs, provider identities, a
   binding-specific policy identity, state, and bounded error code. It stores
   no memory text, query, snippet, candidate, destination, raw content hash,
   registry binding, control, or tombstone. Memoryd persists the authoritative
   job before acknowledging `enqueue_capture`; repeated submission of the same
   delivery-turn key returns the existing job. It also protects session-binding
   receipts, so a child-writable session row is not trusted to authorize reuse.
   A provider-child modification of Polygram's DB cannot create or widen an
   accepted memoryd job or relabel an old provider session because the child
   fails process attestation and cannot mint either protected receipt.

4. **Recall injection reuses the existing prompt seam, not a provider tool.**
   (implements R1/R19.) A `<polygram-memory>` block is assembled by
   `buildPrompt` exactly like `<polygram-history>`, escaped identically and
   covered by the same "data, not instructions" clause. Provider-neutrality is
   then structural rather than duplicated per backend.

5. **Capture enqueue rides a generalized delivery finalizer latch.**
   (implements R37/R21.) U6 first makes delivery success semantics identical
   across SDK, CLI, and Codex. On confirmed delivery it atomically records the
   structural outbox/source set with inbound handler settlement, then attempts
   only a bounded idempotent memoryd enqueue. Extraction and reconciliation
   are asynchronous inside memoryd. Enqueue failure emits bounded telemetry
   but never changes an already-delivered Telegram reply into a handler error.
   Rejected: running extraction in the reply handler or hooking each terminal
   branch of `handleMessage`.

6. **Release 1 ships automatic recall only; provider-initiated deep recall is
   wholly deferred.** (implements the release-1 interpretation of R15 without
   provider asymmetry.) No dark handler and no `deepRecall` config surface are
   built. A future plan may expose a scope-bound operation only when both
   provider transports can support the same affordance.

7. **Registry changes take effect at memoryd start; kill switches take effect
   immediately.** (implements R29/R33.) The deployment-owned registry is
   unreadable to provider children and loaded by memoryd. An attested Polygram
   MainPID fetches a validated immutable routing snapshot at boot and applies
   the policy table locally. A full registry digest supports auditing and wire
   compatibility; a per-binding policy digest retires only affected sessions.
   Authoritative global/per-scope kill switches live in memoryd so both bot
   databases observe one state, and deliberately do not participate in session
   identity.

8. **A durable logical-record marker makes multi-destination visibility
   atomic at the single recall boundary.** (implements R39/R11.) Every
   destination is staged, moved, and indexed as hidden. Only after all
   destinations succeed does one memoryd transaction mark the logical record
   visible. Every recall result is intersected with that authoritative marker;
   inactive siblings are never returned. The pre-U3 spike crash-injects every
   move, index, and activation boundary. Direct memsearch access remains
   technically impossible, so there is one enforceable visibility call site.

9. **Capture revalidates against live authorization immediately before
   commit.** (implements R34.) The turn carries an immutable policy snapshot
   for reproducibility, but memoryd re-reads the effective binding digest,
   sender authorization, and kill-switch state, and quarantines on any
   relevant change. An unrelated registry edit does not invalidate the job.
   The reply is already delivered and is never rolled back.

10. **The legacy corpus is frozen; a sanitized derived corpus is imported.**
    (implements R26/R36.) Originals are quiesced, hashed by source path, and
    quarantined root-only. Divergent same-path files are preserved by content
    hash rather than overwritten. An all-tier secret scan creates sanitized
    derived records with provenance; unresolved content fails closed. Only the
    derived records are indexed into read-only `legacy_ivan`, readable by
    Ivan's principal. No legacy content is promoted to `general`.

### Architecture

#### Component and trust topology

```text
uid 1000 (shumabit)                       uid shumabit-memory (new)
┌────────────────────────────────┐        ┌──────────────────────────────┐
│ polygram-shumabit.service      │        │ shumabit-memoryd.service     │
│  ├─ lib/memory/registry.js     │        │  ├─ attested data socket     │
│  ├─ lib/memory/policy.js       │─socket→│  ├─ root-only admin socket   │
│  ├─ lib/memory/client.js       │        │  ├─ state DB + scope store   │
│  ├─ lib/memory/capture.js      │        │  ├─ memsearch adapter        │
│  └─ shumabit.db (outbox only)  │        │  ├─ extractor/classifier     │
│                                │        │  │    → approved processor   │
│  claude.slice/run-*.scope      │        │  └─ /var/lib/shumabit-memory │
│   ├─ claude CLI child          │        │       mode 0700, 0700 files  │
│   └─ codex app-server child    │  ✗ no read access; peer rejected
└────────────────────────────────┘        └──────────────────────────────┘
```

The provider children keep exactly what they have today: a prompt, and (for
CLI) the Channels bridge tools. They gain no filesystem path, executable,
environment variable, credential, registry file, or accepted socket peer
belonging to memory. The service rejects them before reading their request.

#### Scope identity and the deployment registry

A JSON file outside `config.json`, referenced by memoryd's environment, owned
`root:shumabit-memory`, mode `0640`, and unreadable to `shumabit` provider
children. Memoryd validates it and returns an immutable normalized routing
snapshot only to an attested Polygram MainPID:

```json
{
  "version": 1,
  "scopes": {
    "general":     { "kind": "general" },
    "p_7f3a1c":    { "kind": "person" },
    "pt_a91b2c":   { "kind": "partner" },
    "legacy_ivan": { "kind": "legacy", "readOnly": true,
                     "readableBy": ["p_7f3a1c"] }
  },
  "channels": [
    { "bot": "shumabit", "chat": "68861949", "thread": null,
      "role": "team-private", "principal": "p_7f3a1c",
      "senders": ["68861949"] },
    { "bot": "shumabit", "chat": "-100…", "thread": "12",
      "role": "team-shared", "senders": ["68861949", "45270985"] },
    { "bot": "umi-assistant", "chat": "-100…", "thread": null,
      "role": "partner", "principal": "pt_a91b2c", "senders": ["…"] }
  ]
}
```

Validation (all failures are fatal at boot, with an operator-visible
diagnostic and memory disabled — R3): unique `(bot, chat, thread)`; `role` in
`{team-private, team-shared, partner}`; `principal` required for
`team-private`/`partner` and forbidden for `team-shared`; principal kind must
match role; non-empty numeric `senders`; no scope readable by two kinds of
principal; no partner scope in any other channel's read set; slug format and
uniqueness per Q4; every referenced scope declared.

`registry_digest = "memreg:v1:" + sha256(canonicalJson(registry)).slice(0,16)`
uses the existing `lib/canonical-json.js` contract, reproduced by a
cross-language golden fixture in memoryd. It is for audit, protocol
compatibility, and registry reload only; it is not provider-session identity.

Principal identity comes from this snapshot and nowhere else (R4). The router never
reads a display name, a username, a model output, or conversation content to
decide who a channel belongs to; a channel with no `principal` entry for a role
that requires one is inconsistent, not "probably Ivan". Slugs are immutable once
a scope holds committed records: the service refuses to open a scope directory
whose recorded identity differs from the registry's, which turns an accidental
re-slug into a fail-closed startup error rather than a silent scope merge.

#### Policy derivation

The settled contract, mechanized. This table is the whole of R5–R12 and the
only place read/write policy is expressed.

| role | read scopes | write destinations | classify? |
| --- | --- | --- | --- |
| `team-private` (principal P) | `[P, general]` (+ `legacy_*` where `readableBy` contains P) | one of `[P]` or `[general]` | yes |
| `team-shared` | `[general]` | `[general]` | no |
| `partner` (principal T) | `[T]` | `[T, general]` (dual write, same normalized content) | no |
| unmapped / inconsistent | `[]` — recall off | `[]` — capture off | n/a |

Two easy implementation mistakes the table is written to prevent. First, the
scope is keyed by **principal, not by channel**: a person's DM and every
private group assigned to them resolve to the same `p_*` scope, so a fact
learned in one is recallable in the other (R7). Second, `team-private` is the
only role that classifies at all — `team-shared` writes every safe candidate to
general with no classification step (R9), and `partner` writes the identical
normalized content to both destinations with no shareability judgement (R11).
Classification is therefore a *routing* decision inside one role (R6), never a
gate on whether to store.

`memory_identity = "memory:v1:" + sha256(canonicalJson([schema_version,
bot, chat, thread, principal_id, role, senders.sorted(), readScopes.sorted(),
writeScopes.sorted(), referencedScopeDefinitions])).slice(0,16)`. The full
registry digest and kill-switch state are deliberately excluded, so unrelated
registry edits and operational disables do not destroy provider sessions.

#### Provider-neutral seams

| seam | file | change |
| --- | --- | --- |
| registry bootstrap | `lib/memory/client.js` | fetch one normalized, immutable registry snapshot from an attested `memoryd`; never read the protected registry file directly |
| policy resolution | `polygram.js` `handleMessage` | derive one frozen `MemoryPolicySnapshot` per turn from that snapshot before prompt assembly; carry it to capture |
| recall injection | `lib/prompt.js` `buildPrompt` | accept `polygramMemory` string; render between history and `<polygram-info>`; extend the `polygramInfo` security clause to name `<polygram-memory>` |
| recall assembly | `polygram.js` `formatPrompt` | call `lib/memory/recall.js` with the snapshot; never throw into the turn |
| consumed-source evidence | Orchestra process result | SDK, CLI, and Codex results expose `consumedSourceMessageIds` for the complete primary/queued/folded/steered inbound set |
| capture trigger | provider-neutral delivery finalizer | generalize the current Codex finalizer semantics; enqueue once only after every backend's reply/file delivery is durably settled |
| session identity | `lib/db/sessions.js` | add `memory_identity` to both spawn-identity field sets |

#### Memory service interface

Versioned, length-bounded line-delimited JSON over two Unix sockets. The data
socket accepts only the exact systemd-launched Polygram `MainPID`, verified by
UID, PID, executable, invocation ID, and cgroup. A same-UID provider child is
rejected. If a target host cannot prove that identity, scoped memory fails
closed there. The root-only admin socket is separate and is reached only by a
`sudo` operator CLI. No request ever names a collection or filesystem path.

| op | request | response | notes |
| --- | --- | --- | --- |
| `registry_snapshot` | `{protocol_version, bot_name}` | `{registry_digest, snapshot}` | bootstrap only; normalized routing data, never the protected file or secrets |
| `open_recall` | `{protocol_version, policy_identity, turn_id, ttl_ms}` | `{ticket, expires_ts}` | short-lived, recall-only; rejects stale binding or disabled scopes |
| `recall` | `{protocol_version, ticket, query, k, char_budget}` | `{records:[{record_id, scope_ordinal, text, score}]}` | fails closed; never widens beyond authorized read scopes |
| `enqueue_capture` | `{protocol_version, delivery_turn_id, policy_identity, telegram_context, source_messages[], delivered_messages[]}` | `{job_id, receipt, deduped}` | persists the complete sanitized visible-text job before acknowledging; work continues asynchronously inside `memoryd` |
| `capture_status` | `{protocol_version, receipt}` | `{job_id, state, error_code}` | optional reconciliation of a service-accepted job; never accepts a Polygram DB row as authorization |
| `bind_session` | `{protocol_version, session_key, provider_namespace, provider_session_id, policy_identity}` | `{session_receipt}` | called after a fresh spawn; receipt is bound to the exact tuple in protected state |
| `verify_session` | `{protocol_version, session_receipt, exact_tuple}` | `{valid}` | required before every persisted or live-process resume; stale/missing/copied receipt forces a fresh provider session |

Admin operations (`controls`, `tombstone`, `verify`, `rebuild`, `backup`, and
`restore`) exist only on the root-owned admin socket. Every frame has a hard
size cap and protocol version. Peer identity is rejected before JSON parsing.
Extraction, destination planning, staging, activation, retries, and tombstone
reconciliation are internal service operations, not capabilities handed to
Polygram or provider processes.

#### Data model — Polygram ledger (migration `019-scoped-memory.sql`)

Delivery evidence and an opaque service receipt only. No registry bindings,
controls, candidate/destination rows, content hashes, memory text, queries, or
snippets live in the child-writable Polygram database.

```sql
CREATE TABLE memory_capture_outbox (
  delivery_turn_id TEXT PRIMARY KEY,
  bot_name         TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_thread_id TEXT NOT NULL DEFAULT '',
  session_key      TEXT NOT NULL,
  provider_namespace TEXT NOT NULL,
  provider_session_id TEXT,
  provider_attempt_id TEXT,
  policy_identity  TEXT NOT NULL,
  service_job_id   TEXT,
  service_receipt  TEXT,
  state            TEXT NOT NULL CHECK(state IN (
    'pending','accepted','settled','quarantined','failed')),
  last_error_code  TEXT,
  created_ts       INTEGER NOT NULL,
  updated_ts       INTEGER NOT NULL,
  settled_ts       INTEGER
);
CREATE INDEX idx_memory_outbox_state
  ON memory_capture_outbox(state, updated_ts);

CREATE TABLE memory_capture_messages (
  delivery_turn_id TEXT NOT NULL
    REFERENCES memory_capture_outbox(delivery_turn_id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  telegram_message_id TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  PRIMARY KEY(delivery_turn_id, direction, telegram_message_id)
);

ALTER TABLE agent_runtime_sessions ADD COLUMN memory_identity TEXT;
ALTER TABLE agent_runtime_sessions ADD COLUMN memory_session_receipt TEXT;
ALTER TABLE sessions              ADD COLUMN memory_identity TEXT;
ALTER TABLE sessions              ADD COLUMN memory_session_receipt TEXT;
```

The outbox row and its exact inbound/outbound message-ID set are committed in
the same transaction as delivery settlement. A row without a `service_receipt`
is never replayed into `memoryd`; this prevents a same-UID child from forging a
pending row and waiting for Polygram to act as a deputy. A lost response is
safe: the service already owns and reconciles the idempotent
`delivery_turn_id`; Polygram reports the local receipt as unknown. At boot,
Polygram may poll only rows that already contain a memoryd-issued receipt;
receipt-less rows become locally `failed` without a service call.

#### Data model — memory service storage

```text
/var/lib/shumabit-memory/            0700 shumabit-memory
  state.sqlite3                      registry, controls, jobs, candidates,
                                     destinations, visibility, tombstones
  scopes/
    general/
      records/<record_id>.md         indexed, recallable
      records/<record_id>.json       provenance sidecar (never indexed)
      staged/<record_id>.md          written, NOT indexed, NOT recallable
      tombstones/<record_id>.json
    person-p_7f3a1c/ …
    partner-pt_a91b2c/ …
    legacy-legacy_ivan/records/…     read-only, frozen at cutover
  index/                             memsearch state (per-scope, see U1)
  backups/<scope_id>/<ts>.tar.zst
```

Memsearch remains the semantic backend (R24): general UMI, each person, each
partner, and the frozen legacy corpus each get their own Markdown source
directory **and** their own collection. No scope shares a source path or a
collection with another, which is what makes per-scope backup, rebuild, and
tombstone reapplication possible at all (R28).

The `.md` body contains **only the normalized declarative fact** — one fact
per record, no front matter — so the semantic index never embeds identifiers.
All provenance lives in the protected state DB and sidecar: `record_id`,
`logical_record_id`, `scope_id`, keyed content digest, classification,
`job_id`, `candidate_id`, `sibling_record_ids`, exact source/delivery Telegram
message IDs, provider namespace, timestamps, and schema version. Recall joins
only records whose logical record is `active`; partner siblings become active
in one protected DB transaction after every Markdown body and index entry is
ready. This satisfies R22/R27 without retaining transcripts or exposing a
dictionary-testable raw content hash to provider children.

Memoryd does not make its data socket ready at boot until it has reconciled
every active logical record against durable Markdown bodies, indexes, and
tombstones. A host crash after activation therefore repairs or rebuilds every
required sibling before any recall request can observe the logical record.
Backup generations use the same consistency boundary: a manifest-bound SQLite
online snapshot/export plus its exact bodies and sidecars. Restore targets an
offline staging root and keeps records inactive until sibling/tombstone
reconciliation, index rebuild, and `verify` all succeed.

#### Recall sequencing

```text
inbound turn (gated, dispatched)
  → resolveMemoryPolicy(config, attested registry snapshot,
                        bot, chat, thread, senderId)
      unmapped | sender not allowlisted | inconsistent → snapshot{enabled:false}
                                                          + memory-recall-skipped
  → memoryd.open_recall revalidates binding + authoritative controls → ticket
  → memoryd.recall(query = secret-suppressed inbound text, k, budget)
      timeout 1200ms | error | unknown scope → inject NOTHING (fail closed)
  → dedup by record content_hash across scopes, keep highest score
  → cap to 8 records / 2000 chars, drop whole records
  → buildPrompt renders <polygram-memory scopes="2" items="5"> … </polygram-memory>
  → provider turn proceeds unchanged
```

Recall never blocks the turn on failure and never falls back to another
collection (R16). The scope ordinal in the response is positional
(`scope_ordinal: 0|1`), so the rendered block cannot leak which scope a fact
came from beyond "one of the ones you were already allowed to read".

#### Capture sequencing and crash reconciliation

```text
provider-neutral finalizeResultDelivery() → disposition 'delivered'
  A. settle       atomically store delivery_turn_id + the complete Orchestra
                  consumedSourceMessageIds + delivered Telegram message IDs
                  and settle the handler; no memory text is stored here
  B. enqueue      sanitize every visible text/caption at all secret tiers;
                  bounded memoryd.enqueue_capture call outside the reply path
                  service persists the idempotent job before acknowledging
                  failure never changes an already-delivered reply to an error
  C. extract      memoryd repeats all-tier suppression before the approved
                  processor; bounded retries are allowed only before a valid
                  candidate set has been persisted; first valid immutable set
                  wins and repeated job IDs return that stored result
  D. plan         derive destinations from the current protected registry;
                  partner ⇒ two linked siblings; team-private ⇒ classification;
                  team-shared ⇒ general; rejected/failure ⇒ no destination
  E. activate     revalidate binding, sender, and authoritative controls;
                  write every Markdown body and index entry hidden, then mark
                  the logical record active in one state-DB transaction
  F. settle       service job terminal; Polygram may poll by opaque receipt
```

Crash matrix — `memoryd` owns reconciliation after B; Polygram never replays a
receipt-less row as authorization:

| crash point | authoritative state | reconciliation |
| --- | --- | --- |
| after A, before service acceptance | Polygram `pending`, no receipt | mark local capture failed; never replay from DB |
| service persisted job, response lost | memoryd job exists, Polygram receipt unknown | memoryd completes; duplicate live enqueue dedupes by `delivery_turn_id` |
| processor fails before valid result | memoryd `extracting` | bounded retry with the same job; no candidate is visible |
| crash after valid candidates persist | memoryd `extracted` | resume planning; never call the processor again |
| one partner sibling prepared | logical record inactive | prepare missing sibling; neither is recallable |
| all siblings prepared, before activation | logical record inactive | one DB transaction marks the logical record active |
| crash during/after index mutation | visibility marker authoritative | rebuild/repair index, then activate; recall filters inactive records |
| host crash after activation | active marker + durable bodies | boot gate repairs every sibling/index before opening the data socket |
| retries exhausted | any nonterminal state | remove hidden artifacts, mark failed, emit bounded telemetry |

Bounded retries: five attempts, exponential backoff 5s→10m, then `failed` plus
a `memory-capture-failed` event. This is not global exactly-once execution:
the achievable contract is at-most-one accepted candidate set and idempotent
logical activation. A `failed` job never leaves a recallable half-record.

There is one explicit at-most-once loss window: if Polygram crashes after it
durably settles Telegram delivery but before memoryd accepts B, that delivered
turn is not captured. Boot marks the receipt-less row failed and emits
telemetry. Replaying it would require treating the same-UID child-writable DB
as proof of delivery; preparing jobs before delivery would instead let DB
tampering confirm content that was never delivered. Release 1 chooses the
safer bounded loss over either false authority. Removing the window would
require a separately designed trusted Telegram-delivery broker/transaction,
which is outside this memory feature.

#### Session-scope invalidation

`memory_identity` is written onto the provider-session row at spawn and joins
`SPAWN_IDENTITY_FIELDS` and `CODEX_SPAWN_IDENTITY_FIELDS`. Because those tables
are child-writable, identity comparison alone is not an authorization proof.
After each fresh provider spawn, memoryd issues an opaque receipt bound to
`{session_key, provider_namespace, provider_session_id, policy_identity}`.
Before every persisted-session or already-live-process resume, Polygram asks
memoryd to verify the exact tuple. Missing, stale, copied, or rewritten
receipts force a fresh provider session before recall is injected.

Consequences:

- Remapping a channel, changing its principal, changing its sender allowlist,
  or changing a referenced scope definition changes that binding's
  `memory_identity` → the stored Claude and Codex sessions for that channel
  are dropped and re-spawned before the next turn. Unrelated registry edits do
  not change it.
- Memoryd reconciliation quarantines any non-terminal capture job whose
  `policy_identity` no longer matches its current binding, so queued work from
  the old mapping cannot commit under the new one (R33/F5/AE14).
- Toggling a kill switch changes nothing about session identity (D7).
- A same-UID provider child rewriting either session table cannot relabel an
  old provider session as current; it cannot mint the matching protected
  receipt. Nulling the row can only force a safe fresh spawn.

#### Secret suppression and injection defence

- **Before the socket, before the extraction processor, and before every
  write**, text passes an extraction-specific all-tier sanitizer. Unlike the
  current chat-display default in `lib/secret-detect.js`, low-tier forms such
  as `password: ...` are redacted here rather than merely flagged. Any secret
  hit remaining in an extracted candidate rejects that whole candidate.
- Suppression therefore runs twice: Polygram's pass keeps raw secrets off the
  socket, and memoryd's pass keeps them out of the processor and store even if
  a future client regresses. The test fixture covers high, medium, and low
  tiers at both boundaries.
- Recall output is `xmlEscape`d and rendered inside `<polygram-memory>`, which
  is added to the existing `polygramInfo` security clause listing untrusted
  containers.
- Extraction rejects instruction-shaped candidates (imperatives addressed to a
  future agent, destination or scope requests, tool-control text) — R35/AE15 —
  and the rejection is a `reject` classification, not a silent drop, so it is
  countable in telemetry.

#### Extraction and classification contract

Backend-independent, versioned, and identical for Claude- and Codex-backed
turns. Input is bounded to the visible delivered text/captions and the complete
set of visible consumed inbound text/captions reported by Orchestra, each
capped at 4000 characters and all-tier suppressed. File bytes, local paths,
tool output, hidden provider context, and full transcripts are never capture
input. Output is a strict JSON schema:

```json
{"candidates": [
  {"fact": "string (<=280 chars, declarative, self-contained)",
   "classification": "private | general | reject",
   "confidence": "high | medium | low"}
]}
```

Mapping to R38: `private` → person scope; `general` → general; `reject` → no
write; a valid low-confidence `general`/`private` judgement defaults to
`general`, as required by the product contract; processor timeout, malformed
JSON, schema violation, or refusal is `failure` → **nothing is written**.
Mixed-sensitivity candidates are instructed to be `private`. `team-shared`
and `partner` turns skip classification (R9/R11) and use extraction only.

The processor is an explicit release-gate decision, not an implementation
default. Before U3, the same labelled fixture is run against (a) a fixed
Anthropic extractor and (b) one viable local extractor. Ivan approves the
processor and its data boundary; the schema and memoryd interface remain the
same either way.

#### Configuration surface

```json
{
  "memory": {
    "enabled": false,
    "socketPath": "/run/shumabit-memory/memoryd.sock",
    "recall": { "maxRecords": 8, "maxChars": 2000,
                "timeoutMs": 1200, "perScopeK": 6 },
    "capture": { "maxCandidates": 5, "enqueueTimeoutMs": 1000 }
  }
}
```

The protected registry path, processor credentials, retry schedule, and admin
socket belong to the memoryd unit/environment, not bot config. Everything
defaults off. `config.example.json` gains a commented block. No `/config`
surface and no release-1 deep-recall flag or dark handler (Scope Boundaries).

#### Telemetry and error codes

Events, all with opaque scope IDs, counts, and bounded codes only — never
text, queries, snippets, or stderr (R30): `memory-registry-loaded`,
`memory-registry-invalid`, `memory-recall-injected`, `memory-recall-skipped`,
`memory-recall-failed`, `memory-capture-enqueued`, `memory-capture-extracted`,
`memory-capture-committed`, `memory-capture-quarantined`,
`memory-capture-failed`, `memory-scope-invalidated`,
`memory-tombstone-applied`.

Error codes: `MEMORY_REGISTRY_UNMAPPED`, `MEMORY_REGISTRY_INCONSISTENT`,
`MEMORY_REGISTRY_CHANGED`, `MEMORY_SENDER_UNAUTHORIZED`,
`MEMORY_SCOPE_UNKNOWN`, `MEMORY_RECALL_TIMEOUT`, `MEMORY_RECALL_UNAVAILABLE`,
`MEMORY_TICKET_EXPIRED`, `MEMORY_PEER_REJECTED`, `MEMORY_KILLSWITCH_OFF`,
`MEMORY_EXTRACTION_FAILED`, `MEMORY_CLASSIFY_INVALID`, `MEMORY_WRITE_FAILED`,
`MEMORY_PUBLISH_INCOMPLETE`, `MEMORY_REVALIDATION_FAILED`.

### Files and Callers

| repository / file | change | callers affected |
| --- | --- | --- |
| `polygram` `migrations/019-scoped-memory.sql` | new | `runMigrations` at boot |
| `lib/memory/registry.js` | new — validate memoryd snapshot, binding digest | boot, doctor, policy |
| `lib/memory/policy.js` | new — pure policy table + snapshot | `polygram.js`, capture |
| `lib/memory/client.js` | new — versioned socket client, recall tickets, capture enqueue | recall, capture |
| `lib/memory/recall.js` | new — query build, dedup, budget, render | `formatPrompt` |
| `lib/memory/capture.js` | new — delivery-evidence outbox + bounded enqueue | delivery finalizer |
| `lib/db/memory.js` | new — structural outbox/receipt accessors only | capture, telemetry |
| `lib/prompt.js` | `buildPrompt` gains `polygramMemory`; security clause lists `<polygram-memory>` | `formatPrompt` only |
| `polygram.js` | resolve snapshot per turn; pass to prompt/finalizer; bootstrap registry snapshot | `handleMessage`, `main` |
| `lib/codex/delivery-finalizer.js` → provider-neutral finalizer | define delivered semantics for SDK, CLI, Codex, text, files, partial delivery, interruption, and supersession | every reply path |
| `lib/db/sessions.js` | `memory_identity` in both spawn-identity sets, read/write on provider-session rows | spawn paths, clean-resume |
| `scripts/memory-control.js` | root-only admin-socket CLI: controls, tombstone, rebuild, verify | operators only |
| `config.example.json` | commented `memory` block | docs |
| `services/memoryd/**`, `pyproject.toml` | protected service, locked Python environment, protocol contract, `pytest` | systemd unit, CI |
| `.github/workflows/ci.yml` | install locked memoryd environment and run `pytest` beside `npm test` | CI |
| Orchestra process/result files | add normalized `consumedSourceMessageIds` across SDK, CLI, and Codex | Polygram delivery finalizer |
| `shumabit-claude` `.claude/settings.json`, hooks, `sessions/**` | remove memsearch/cross-agent/session-file surfaces; quarantine originals outside provider reach | every provider turn |
| `shumabit-claude` `AGENTS.md`, `skills/memory-policy/SKILL.md` | shared Claude/Codex guidance: automatic memory, recalled data untrusted, no memory commands | Claude + Codex bootstrap |
| `umi-vps-infra` `ansible/**`, `docs/SHUMABIT_SCOPED_MEMORY_SPEC.md` | user, dirs, unit, socket, backups, monitoring, runbook | deploy |

### Alternatives Considered

1. **Filter scopes at query time in one shared collection.** Rejected: a
   single missed filter argument is a silent cross-principal leak, and it makes
   per-scope backup, rebuild, and tombstone (R28) impossible.
2. **Give each provider its own memory adapter (Codex memory plugin + Claude
   memsearch plugin).** Rejected by R1 and by the Codex parity plan's U7 — two
   stores drift, and a chat that switches provider loses its history.
3. **Keep memory state under the `shumabit` user with agent-file rules.**
   Rejected: that is exactly today's arrangement, and the Product Contract's
   core complaint is that instruction-based restriction is not a boundary.
4. **Approve each memory before writing.** Rejected by the settled decision to
   make capture automatic.
5. **Store candidate text in Polygram's DB for simpler reconciliation.**
   Rejected by D3 — `shumabit.db` is child-readable, so any scope's text there
   is a leak waiting for a `grep`.
6. **Run extraction on the same provider that answered the turn.** Rejected by
   R20 — it makes what gets remembered depend on which backend was selected.
7. **Ship provider-callable deep recall on Claude first.** Rejected by D6 —
   it creates the provider asymmetry R1 exists to prevent.
8. **Keep the authoritative capture ledger in Polygram.** Rejected after
   review: the same-UID provider child can write that database, two bots have
   separate DBs, and content hashes permit dictionary guessing. Memoryd-owned
   state is both simpler and a real boundary.
9. **Let each answering provider extract its own memories.** Credible and
   operationally simple, but rejected for release 1 because switching Claude
   ↔ Codex would change capture semantics. A fixed approved processor gives
   provider-neutral behaviour; the explicit cost is the extra data processor.
10. **Pre-authorize capture before Telegram delivery and replay confirmation
    from Polygram's DB.** Rejected: the provider child can write that DB, so it
    could confirm a prepared but undelivered result. A privileged service that
    both sends Telegram and records delivery could close the transaction, but
    moving bot credentials/delivery into memoryd is disproportionate scope.

### Risks and Mitigations

| risk | mitigation |
| --- | --- |
| memsearch cannot isolate N collections, or concurrent write+query corrupts the index | U1 is a release gate (R32); the per-scope-file fallback must rerun and pass the entire U1 matrix before adoption |
| Creating the first least-privilege Unix identity on the host breaks an existing unit | U10 lands ahead of runtime activation, is Ansible-managed, changes no existing unit's user, and is verified by a forced cross-owner restart test before any memory traffic |
| Classifier sends a genuinely private fact to `general` | Contract-settled (uncertainty defaults to general). Mitigate the *blast radius*: mixed-sensitivity ⇒ private, secret suppression is deterministic and pre-classifier, and G3 measures private-recall on a labelled fixture set before rollout |
| Extraction adds a second provider for some chats | U1 compares fixed Anthropic and viable local extraction on identical fixtures; U3 is blocked until Ivan approves the processor and data boundary |
| Recall crowds the turn or slows it | Hard caps (8 records / 2000 chars / 1200ms) and fail-closed on timeout; soak watches turn latency percentiles |
| Removing legacy session files loses hand-written working context | Freeze/hash/quarantine originals; rely on existing provider session/history continuity, and migrate no non-Ivan file silently |
| Partner dual-write leaves one copy visible | Protected logical-record visibility is the recall authority; both siblings activate in one state-DB transaction after preparation, proven by crash injection |
| Same-UID provider child calls memoryd directly | Mandatory exact Polygram MainPID/invocation/cgroup attestation; a host that cannot prove it cannot enable scoped memory |
| Same-UID provider child rewrites a persisted provider-session row | Memoryd-bound session receipt is verified for the exact session/policy tuple before every DB or live-process resume; tampering forces a fresh session |
| Polygram and service disagree after restore | Service DB is authoritative; encrypted per-scope backup + root-only `verify` reconcile bodies, indexes, visibility, and tombstones before enabling recall |
| Legacy corpus contains old secrets or colliding filenames | Originals are immutable/quarantined; a sanitized derived corpus is imported by source path+hash, never basename overwrite, and secret sentinels must be absent |
| Protocol/version skew during deploy | Locked Python environment and coordinated quiesced bundle deploy; hard fail closed on protocol mismatch, with rollback restoring the prior Polygram+memoryd pair |

## Implementation Units

### U1. Release-gate spikes

**Goal:** retire the four unknowns that can invalidate the architecture before
production code depends on it. **Repository:** `polygram`, sanitized fixtures
only. Prove: (a) memsearch collection isolation, concurrent query/write,
delete, rebuild, and negative sentinels; if a per-scope-file fallback is used,
rerun the same complete matrix; (b) exact Polygram `MainPID`/invocation/cgroup
attestation rejects a same-UID provider child on the actual Linux host; (c)
crash-injected partner preparation plus logical activation never exposes one
sibling; (d) fixed Anthropic and one viable local extractor are scored on the
same labelled fixture, including all secret tiers and adversarial instructions.
Also tamper both Polygram session tables from a same-UID process and prove a
missing, stale, or tuple-copied session receipt forces a fresh session.
Record pinned API calls, numeric results, processor data boundary, and the
recommended processor. U3 is blocked until Ivan approves that choice.
**Estimate:** 3–4 d.

### U2. Scope registry and policy router

**Goal:** turn Telegram identity into an authorized scope set, deterministically.
**Files:** `lib/memory/registry.js`, `lib/memory/policy.js`,
`tests/memory-registry.test.js`, `tests/memory-policy.test.js`.
**Approach:** pure validation/derivation of a memoryd-supplied immutable
snapshot; full registry digest for audit, binding-specific `memory_identity`
for session drift; unmapped or inconsistent inputs disable memory.
**Tests (TDD):** every table row; every validation failure; sender not in
allowlist; guest added mid-conversation; conflicting person/partner mapping;
duplicate slug; slug containing a Telegram ID; legacy scope readable only by
its listed principal; digest stability under key reordering.
**Estimate:** 2–3 d.

### U3. `memoryd` — scoped memory service

**Goal:** the only component that touches memory bytes.
**Files:** `services/memoryd/**`, locked `pyproject.toml`, protected state DB,
and service tests. **Approach:** versioned/capped AF_UNIX protocol; mandatory
exact-peer attestation; separate root admin socket; memoryd-owned registry,
controls, capture ledger, candidate set, destinations, visibility, tombstones,
and reconciliation; short recall tickets; idempotent capture enqueue; all-tier
suppression; approved fixed processor; per-scope memsearch adapter; inactive
preparation followed by atomic logical activation; encrypted backup and
root-only restore/verify. Use a coordinated quiesced Polygram+memoryd release;
hard fail closed on protocol mismatch rather than building speculative N/N-1.
**Tests:** every operation and frame limit; wrong UID/PID/executable/invocation/
cgroup; same-UID child; ticket expiry/widening; first-valid extraction
checkpoint; all-tier sentinels; crash matrix; sibling activation; tombstone;
session bind/verify and tuple-copy rejection; rebuild/restore; protocol
mismatch.
**Estimate:** 9–11 d.

### U4. Orchestra consumed-source result contract

**Goal:** give capture exact evidence for every inbound Telegram message that
the delivered turn consumed. **Repository:** `orchestra` (release first).
**Approach:** add normalized `consumedSourceMessageIds` to the common process
result and populate it in SDK, CLI, and Codex for the primary message plus
queued, folded, follow-up, and mid-turn steering inputs. No memory policy or
memory tool belongs in Orchestra.
**Tests:** each backend, primary-only, queued/folded, multiple steers,
interrupted/superseded turns, retry/resume, and no duplicate IDs.
**Estimate:** 3–4 d.

### U5. Recall client and prompt injection

**Goal:** authorized, bounded, fail-closed context on every eligible turn.
**Files:** `lib/memory/client.js`, `lib/memory/recall.js`, `lib/prompt.js`,
`polygram.js`, `tests/memory-recall.test.js`, `tests/prompt.test.js`.
**Approach:** per D4 and the recall sequence above. `buildPrompt` renders the
block; `formatPrompt` never throws into the turn; timeouts inject nothing.
**Tests:** rendering and escaping (including a record containing
`</polygram-memory><system>`); dedup across scopes; budget truncation drops
whole records; timeout/unavailable/unknown-scope inject nothing; disabled
snapshot injects nothing; identical rendered block for SDK, CLI, and Codex
backends given the same snapshot.
**Estimate:** 3 d.

### U6. Provider-neutral delivery and capture enqueue

**Goal:** automatic, backend-neutral capture after confirmed delivery,
idempotent after service acceptance, without making memory failure a reply
failure or trusting a child-writable replay source.
**Files:** `migrations/019-scoped-memory.sql`, `lib/db/memory.js`,
`lib/memory/capture.js`, provider-neutral delivery-finalizer module,
`polygram.js`, and tests. Generalize the current Codex-only finalizer: define
durable delivery for SDK/CLI/Codex text and files, partial delivery,
interruption, and supersession. Atomically persist the exact inbound/outbound
ID set with handler settlement, then perform only a bounded asynchronous
`enqueue_capture`; a receipt-less row is never boot-replayed into memoryd.
Capture visible text/captions only, all-tier sanitized before the socket.
**Tests:** SDK/CLI/Codex parity; complete primary+steer/fold source sets;
duplicate finalize/enqueue; files; partial failure; failed/interrupted/
superseded turns; unavailable/slow memoryd after delivery; lost acknowledgement;
no raw text or content hash in SQLite.
**Estimate:** 6–8 d.

### U7. Session-scope invalidation

**Goal:** a scope or authorization change can never be observed by a session
that holds the old scope's context.
**Files:** `lib/db/sessions.js`, `polygram.js`, `lib/ops/clean-resume.js` if
its identity comparison needs the new column, `tests/sessions-drift.test.js`.
**Approach:** per D7 and the invalidation section.
**Tests (red first):** person→person remap retires both provider sessions;
partner→partner remap likewise; sender-allowlist edit retires; kill-switch
toggle does **not** retire; queued capture work under a stale identity is
quarantined at boot; Claude and Codex namespaces both honour the field; DB
tampering cannot copy an old session ID or receipt onto a current binding;
already-live process reuse is verified as strictly as DB resume.
**Estimate:** 3 d.

### U8. Controls, operator CLI, telemetry, doctor

**Goal:** operate it without touching the database by hand.
**Files:** root-only `scripts/memory-control.js`, diagnostics, telemetry and
tests. **Approach:** admin-socket `disable|enable [--scope]`, `tombstone`,
`status`, `verify`, `rebuild --scope`; memoryd owns the authoritative global
and per-scope controls shared by both bots. Doctor checks protocol, registry,
exact service/client identity, ownership/mode, and path overlap.
`tombstone` is operator-only — there is no conversational forget path in
release 1 (Scope Boundaries) — and it deletes the Markdown body, reindexes the
scope, and cascades to every `sibling_record_ids` copy so a partner dual write
disappears from both destinations (R23). Its output states plainly what it does
**not** undo: context already delivered into a live provider session, and copies
inside retained backups until those backups age out. The CLI prints that caveat
on every tombstone so an operator cannot mistake it for erasure.
**Tests:** every command; global vs per-scope precedence; doctor fails on
world-readable storage, wrong owner, invalid registry, unreachable socket.
**Estimate:** 2–3 d.

### U9. Shumabit workspace cutover

**Goal:** remove every legacy path a provider could still reach, and tell both
providers the truth about how memory now works.
**Repository:** `shumabit-claude`.
**Files:** `.claude/settings.json`, `AGENTS.md`,
`skills/memory-policy/SKILL.md`, hooks, and `sessions/**`.
**Approach:** during the bounded maintenance window, unregister the
`memsearch` plugin and remove both the cross-agent and session-file hooks;
rewrite the memory section of `AGENTS.md` to state that memory is automatic,
that recalled content is untrusted data, that the agent has no memory
commands, files, or database, and that asking for a scope has no effect (R17).
Put the same provider-neutral guidance in the canonical shared skill so Claude
and Codex receive it. Freeze/hash and quarantine all channel session files
outside provider reach; do not silently migrate non-Ivan content. Existing
provider session/history preload remains the continuity mechanism.
**Tests:** a discovery check asserting no memsearch plugin, executable, or
database path is reachable from a provider child's configured surface; Claude
still boots its agent; the cross-agent injection no longer appears in a turn.
**Estimate:** 2–3 d.

### U10. Infrastructure — identity, unit, storage, backups

**Goal:** the separate production OS identity the contract assumes.
**Repository:** `umi-vps-infra`.
**Approach:** Ansible role creating the `shumabit-memory` system user and
group; `/var/lib/shumabit-memory` 0700; `/run/shumabit-memory` via
`RuntimeDirectory`; `shumabit-memoryd.service` (`User=shumabit-memory`,
`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`,
`ReadWritePaths=/var/lib/shumabit-memory`, no `SupplementaryGroups` shared
with the bots); protected registry and `EnvironmentFile` 0640/0600 owned by
root and the memory user; locked Python environment; coordinated quiesced
bundle deploy/rollback; encrypted per-scope backup timer with integrity check;
manifest-bound authority snapshot plus linked-scope bodies; root-only offline
restore with inactive records and verify-before-enable; backups retained at
most 90 days, shorter than the 400-day
tombstone retention; netdata
alarms for service-down, socket-unreachable, capture-failure rate, and
recall-timeout rate; documentation per R31 in
`docs/SHUMABIT_SCOPED_MEMORY_SPEC.md` (topology, ownership, backup/restore,
security boundary and its explicit limits, monitoring, rollback) with no
secret values.
**Tests:** the isolation spec's forced cross-owner restart test still passes;
a `shumabit`-shell probe cannot read any path under
`/var/lib/shumabit-memory`; the unit survives reboot.
**Estimate:** 4–5 d.

### U11. Legacy corpus freeze and migration

**Goal:** the legacy corpus becomes an Ivan-only read-only source and nothing
else (R26/R36).
**Approach:** in the bounded maintenance window, freeze and hash immutable
originals from every legacy source; never move or rewrite them in place. Build
an all-tier sanitized derived corpus, preserving source path+hash so the 14
verified overlapping/different daily filenames cannot overwrite one another;
index only that derived corpus into Ivan's read-only legacy scope. Quarantine
original stores, indexes, backups, and session files outside provider reach.
**Tests:** secret/adversarial sentinels absent from derived/indexed data;
Ivan-only positive/negative scope matrix; collision count and hashes preserved;
old paths unreachable; manifest re-verification.
**Estimate:** 3–4 d.

### U12. Staged rollout, canary, soak

**Goal:** turn it on one scope at a time with a rollback that never destroys
data.
**Sequence:** see Rollout below.
**Estimate:** 3 d of work spread over ~2 weeks of soak.

## Dependencies and Critical Path

```text
U1 gates ───────────────> U3 memoryd ───────────┬─> U5 recall ───────┐
U10 infra ──────────────> U3 runtime            └─> U6 capture ─┐    │
U2 registry/policy ─────> U5, U6, U7                           ├─> U12 rollout
U4 Orchestra contract ───────────────────────────> U6 capture ┤    │
U6 capture ──────────────────────────────────────> U7/U8 ──────┤    │
U9 workspace + U11 sanitized legacy ──────────────────────────┴────┘
```

**Critical path:** max(U1, U10) → U3 → U6 → max(U7, U8) → U12, with U4
required before U6 closes. U2 and U4 can start in parallel; U9/U11 wait for
the new surfaces but precede rollout. Sequential critical-path engineering is
about 25–30 days; calendar time also includes controlled cutover and soak.

| unit | repo | estimate | blocks |
| --- | --- | --- | --- |
| U1 gates | Polygram/spikes | 3–4 d | U3, processor approval |
| U2 registry/policy | Polygram | 2–3 d | U5–U7 |
| U3 memoryd | Polygram | 9–11 d | U5, U6, U8, U11 |
| U4 source-set contract | Orchestra | 3–4 d | U6 |
| U5 recall | Polygram | 3 d | U12 |
| U6 capture/finalizer | Polygram | 6–8 d | U7, U8, U12 |
| U7 invalidation | Polygram | 3 d | U12 |
| U8 controls/ops | Polygram | 2–3 d | U12 |
| U9 workspace | `shumabit-claude` | 2–3 d | U12 |
| U10 infra | `umi-vps-infra` | 4–5 d | U3 runtime, U12 |
| U11 legacy | workspace/infra | 3–4 d | U12 |
| U12 rollout | operations | 3 d (+ soak) | — |

Totals: **43–54 engineer-days**: Polygram **28–35**, Orchestra **3–4**,
Shumabit workspace **2–3**, infrastructure **4–5**, legacy migration **3–4**,
and rollout **3**. One engineer is roughly **9–11 working weeks plus soak**;
two engineers with the safe parallelism above are roughly **5–7 calendar
weeks plus the final soak**. These are estimates, not verified facts.

## Migration and Cutover

Ordered. The destructive-looking legacy transition is one bounded maintenance
window; it is not spread across normal message handling.

1. **Land and provision dark.** Release the coordinated Polygram+memoryd
   protocol pair with `memory.enabled: false`; provision U10 identity, locked
   environment, protected registry/storage, encrypted backups, monitoring,
   and root admin socket. Apply migration 019; verify doctor and peer rejection.
2. **Preload the disabled registry.** Memoryd loads every binding with global
   recall and capture off; Polygram can fetch the snapshot, but injects and
   captures nothing.
3. **Start the maintenance window.** Stop Telegram intake first and drain or
   explicitly quarantine in-flight turns. Then disable legacy memsearch,
   cross-agent hooks, daily writers, `MEMORY.md`, and session-file injection.
   A writer is never left active against a corpus already considered frozen.
4. **Freeze, sanitize, and import U11.** Hash immutable originals by source
   path+content, build the sanitized derived Ivan-only corpus, collision-test,
   index it, and quarantine originals/indexes/backups/session files outside
   provider reach. Abort and restore the old bundle if any sentinel or manifest
   gate fails.
5. **Explicitly retire affected provider sessions.** A daemon restart alone
   is insufficient because sessions persist. Delete/retire all non-Ivan
   sessions that could hold legacy cross-scope context and any session whose
   new binding identity differs; verify unrelated authorized sessions follow
   the stated invalidation policy.
6. **Restart with scoped memory still disabled.** Resume intake only after
   storage unreadability, legacy-path absence, session retirement, protocol,
   and full negative-sentinel checks pass.
7. **Canary Ivan's private channel.** Enable recall, then capture after 24h and
   the applicable gates. Next enable one team-shared group, then one partner
   channel, each only after its matrix and soak threshold passes.

Before step 3, rollback is the previous bundle. During steps 3–6, rollback
restores the frozen originals and old configured paths from the manifest while
intake remains stopped. After scoped capture begins, rollback disables scoped
memory but never deletes records produced during the canary.

## Rollout and Rollback

**Pre-registered rollout gates** (each must pass before the next scope):

- **G1 backend/security spike:** the complete U1 matrix passes under the chosen
  memsearch topology; zero cross-scope sentinel returns; every same-UID
  non-MainPID probe is rejected; all crash points expose either every required
  sibling or none. Concurrent-write recall p95 is ≤2× idle p95 and remains
  within the 1200ms turn budget. Same-UID session-table tampering never reuses
  an old session under a current binding.
- **G2 host/doctor:** doctor is clean; probes from the `shumabit` shell and a
  real Claude/Codex child cannot read storage/registry/backups or call either
  socket; protocol mismatch fails closed.
- **G3 processor:** at least 200 labelled candidate fixtures, including ≥50
  private, ≥25 secret/instruction adversarial, and every low/medium/high secret
  tier: 0 raw-secret egress/write, 0 labelled critical-private→general leaks,
  ≥95% extraction precision, ≥95% routing accuracy, and ≥98% private-item
  recall. Ivan approves the measured processor and data boundary.
- **G4 behaviour:** the full positive/negative scope matrix passes through SDK,
  CLI, and Codex, including primary+queued/folded/steered source sets, provider
  switches, files, interruption, restart, and binding-only session retirement.
- **G5 recovery:** every capture/activation/backup-restore crash case passes;
  first valid extraction is never rerun; no half-visible logical record; all
  tombstones are applied before restored data can be indexed or recalled.
- **G6 canary:** at least 48h and 50 eligible delivered turns in the current
  canary scope, zero secret/cross-scope/session-retirement violations, zero
  unreconciled activation failures, capture failure <1%, recall timeout <1%,
  and provider-turn p95 latency regression <10% versus the preceding 7-day
  same-bot/time-of-day baseline.

**Rollback ladder**, cheapest first:

1. `memory-control disable --scope <id>` — one scope, immediate, no restart,
   no session churn.
2. `memory-control disable` (global) — all recall and capture off, immediate.
3. `config.memory.enabled: false` + bot restart — router out of the turn path
   entirely.
4. Restore the previous coordinated Polygram+memoryd release pair; migration
   019's tables remain and are simply unused by the older Polygram binary.
5. **Security containment:** stop intake, disable the affected scope(s),
   quarantine their non-terminal capture work, and retire every Claude/Codex
   persisted or live session whose read set intersects those scopes before
   intake resumes. Use this rung for a suspected privacy or authorization
   leak; ordinary performance rollback deliberately keeps sessions.

Restoring direct legacy memory paths is permitted only inside the stopped-intake
maintenance-window rollback described above, before any scoped-memory canary.
After service resumes, the emergency rollback keeps those unsafe paths
quarantined and falls back to provider session/history continuity only.

Rollback **never deletes scoped records**. Anything captured during a trial
stays in its scope, unrecallable while disabled, and is available if memory is
re-enabled. Provider sessions are not cleared by ordinary rollback; the
security-containment rung clears the affected set because already injected
context cannot be removed from a live provider session.

## Verification Contract

### Automated

- Polygram: new `memory-registry`, `memory-policy`, `memory-recall`,
  `memory-capture`, `memory-control`,
  `sessions-drift` suites, plus updated `prompt`, `doctor`, and
  provider-neutral delivery-finalizer suites; then full `npm test`.
- Orchestra: common result-contract and SDK/CLI/Codex tests prove the complete
  `consumedSourceMessageIds` set for primary, queued, folded, follow-up, and
  steered input before publishing the dependency Polygram consumes.
- `memoryd`: `pytest` suite covering every socket op, auth rejection, staging
  and publication atomicity, tombstone cascade, rebuild equivalence, and
  processor failure modes; `.github/workflows/ci.yml` installs the locked
  environment and runs it alongside `npm test`.
- Cross-scope **negative sentinel matrix** as a first-class test: for every
  (channel role × scope) pair that must not be readable, a planted sentinel is
  asserted absent.
- `git diff --check` in every changed repository. No skipped test is reported
  as a pass.

### Real-runtime gates

- U1's memsearch isolation, concurrency, delete, rebuild, and negative-sentinel
  proofs against the deployed backend (R32).
- Socket peer rejection from a non-Polygram process at the same uid.
- Exact MainPID/executable/invocation/cgroup acceptance from the real systemd
  Polygram process, plus fail-closed behaviour where any proof is absent.
- Storage unreadability probe from a `shumabit` shell and from inside a real
  provider child.
- Same-UID tampering of both session tables, including current-identity rewrite
  and cross-row receipt copying, always forces a fresh provider session.
- Crash injection at each boundary in the crash matrix, with a
  real service and a real database.
- Round-trip provider neutrality: capture under Claude, recall under Codex, and
  the reverse, in the same chat, across a daemon restart.

### Production canary

Ivan's private channel first: a durable fact is captured without any command;
it is recalled on a later turn; a raw-secret sentinel is captured nowhere; an
infrastructure identifier lands in the private scope only; the legacy sentinel
is recallable there and nowhere else; provider switch preserves both
directions; `/config`, model switching, steering, and reply delivery are
unchanged.

Then one team-shared group (general-only reads; every safe fact to general),
then one partner channel (partner-only reads; dual write with linked
provenance; crash-and-retry leaves exactly one copy per destination).

### Telemetry watchlist during soak

Recall timeout and capture failure remain below G6; zero
`MEMORY_SENDER_UNAUTHORIZED` in mapped channels; zero
`MEMORY_PUBLISH_INCOMPLETE` surviving reconciliation; zero secret sentinels in
any sink; turn-latency p95 remains within G6; no unexpected session retirement;
no `memory-capture-failed` clusters.

## Definition of Done

- Every channel role reads exactly its contract-defined scopes and writes
  exactly its contract-defined destinations, proven positively and by negative
  sentinel for every forbidden scope.
- The same scope matrix passes through Claude and Codex, before and after a
  daemon restart and a provider switch.
- Capture is automatic after durably delivered turns, records the complete
  consumed/delivered Telegram message-ID set, persists at most one valid
  immutable candidate set, never reruns extraction after that checkpoint, and
  writes nothing on failed, interrupted, superseded, or ambiguous turns.
- Partner dual writes are idempotent across a crash at every ledger, staging,
  and publication boundary; tombstoning removes both copies from future recall.
- No raw-secret sentinel appears in an extraction request, recalled context,
  Markdown, index, sidecar, log, event row, or backup.
- Polygram's database contains no memory text, recalled snippet, query,
  candidate, destination, raw content hash, registry binding, control, or
  tombstone — only delivery evidence, opaque receipts, states, and bounded
  codes. Memoryd owns all authoritative capture and visibility state.
- Same-UID provider children cannot read memory storage/registry/backups,
  invoke memsearch, call either socket, obtain a ticket, or turn a forged DB
  row into an accepted job; the boundary explicitly excludes root and a
  compromised Polygram MainPID or memoryd.
- A registry or authorization change retires the affected Claude and Codex
  sessions and quarantines incompatible queued capture work before memory is
  re-enabled; a kill-switch toggle does neither.
- Every persisted or already-live provider-session resume verifies a protected
  receipt bound to its exact provider-session and policy tuple; same-UID DB
  rewriting cannot resurrect old recalled context.
- The legacy corpus and channel session files are frozen and hashed; only an
  all-tier sanitized derived Ivan-only corpus is indexed, name collisions are
  preserved by source path+hash, and originals/old indexes/backups are outside
  every provider-reachable path.
- Operators can disable recall and capture globally or per scope without a
  restart and without changing the selected backend, and can tombstone a
  record with every derived copy reconciled.
- The memsearch isolation gate passed against the deployed backend, or a
  per-scope-file topology passed in its place.
- `umi-vps-infra` documents the deployed registry, storage topology, ownership,
  coordinated deploy/rollback, encrypted backup/restore and retention,
  security boundary and its limits, monitoring, and rollback, without secrets.
- The shared `memory-policy` skill and AGENTS guidance are visible to Claude
  and Codex and describe memory as automatic untrusted data with no agent-callable
  widening or management command.
- Claude SDK/CLI and Codex behaviour, model selection, steering, and Telegram
  delivery are unchanged outside the memory path.

## Requirement Traceability

| requirements | primary implementation / proof |
| --- | --- |
| R1, R14, R17, R19, R20 | U3–U6, U9; cross-provider matrix G4 |
| R2–R12, R33, R34, R38 | U2, U3, U7; policy/session tests and G4 |
| R13, R35, R37 | U1, U3, U4, U6, U11; secret/source-set gates G3–G5 |
| R15, R16 | U3, U5; bounded recall tests (deep recall deferred) |
| R18, R25, R30 | U1, U3, U8–U10; host probes G1/G2 |
| R21–R23, R27–R29, R39 | U3, U6, U8, U10; crash/restore gate G5 |
| R24, R26, R31, R32, R36 | U1, U9–U12; migration manifest and rollout gates |

## Decision Required Before U3

Ivan must approve the fixed extraction processor and its data boundary after
U1 scores the Anthropic structured-output option and one viable local option
on the same G3 fixture. The reviewed recommendation remains Anthropic for the
most stable provider-neutral structured result; choose local if Codex-backed
chat content must not be sent to Anthropic. No other product or architecture
decision remains open in this plan: memoryd stays in Polygram, deep recall is
future work, legacy session files are quarantined, and the rollout thresholds
above are fixed.
