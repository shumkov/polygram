---
title: Provider-Neutral Scoped Memory for Shumabit - Plan
type: feat
date: 2026-07-31
revised: 2026-08-18
topic: shumabit-scoped-memory
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-session
execution: code
---

# Provider-Neutral Scoped Memory for Shumabit - Plan

> **Readiness: implementation-ready.** The approved prerequisite units can be
> implemented now. Memory feature enablement and canary rollout remain blocked
> until the routing/auth, Orchestra, durable-storage, capture, recall, cleanup,
> and Linux gates named below pass.

## Goal Capsule

- **Objective:** Let the same UMI knowledge survive Claude/Codex switching while
  enforcing exact member, team-group, partner, and secret-storage boundaries.
- **MVP:** Ivan's UMI member DM on Claude CLI and Codex, with own-private plus
  general recall and automatic staged capture. A work fact is physically
  duplicated to own-private and general; a personal-sensitive fact is private
  only; a mixed fact is split at fact level.
- **Capture:** Keep memsearch's native extraction unchanged and in-session on
  the already-authorized provider subscription. It writes only to non-recallable
  owner-only staging. A trusted publisher performs deterministic secret
  rejection, the separate personal-sensitivity routing/splitting pass, policy
  checks, stable fact identity, and journal/index publication.
- **Recall:** Use the generic U14 scoped recall transport. Plugin-native recall
  is forbidden because the model can select collections and read journal files
  directly.
- **Stop conditions:** Do not implement the memory feature, enable a canary, or
  call the design production-safe until the exact U14/U23 release proof, U24,
  U25 inventory, U26 cleanup, U27 capture handoff, and U16a pass. An
  operational routing/classification failure queues the staged item for
  bounded retry; it never silently chooses general or private.
- **Authority:** The exact policy in this document and the user's settled
  decisions supersede contradictory text in the prior draft. U21/U22/U16a
  findings are evidence, not permission to widen scope.

---

## Product Contract

### Summary

Memory is an optional capability bound to authenticated Telegram context. The
provider session may receive the original live turn, but it cannot choose a
memory scope, publish a record, or recall through provider-owned filesystem
paths. Polygram owns identity and eligibility; the trusted publisher owns
publication; the generic recall transport owns bounded reads.

The native hook can briefly echo a secret into staging before publication
validation. That is an acknowledged transient-storage window, not a claim of
zero storage. Staging must be non-recallable, owner-only, bounded by size/count
and TTL, excluded from backups/logs/telemetry, and deleted after publish or
reject; crash residue is removed by TTL and startup sweeps.

### Problem Frame

The current memsearch integrations provide useful automatic extraction but one
unscoped provider-local store. The current Polygram SQLite path also persists
raw message text before the existing background sweep or agent-reported
redaction can act. Both facts matter: memory needs scoped authorization and
publication controls, while recognized credential/auth cases—including
known-shape, key/value, and deterministic prose-form cases—need sanitization
before any durable SQLite/FTS insertion. The live provider turn may retain the original
text; the durable transcript and memory journals may not.

### Settled policy matrix

| Context | Reads | Accepted writes | Classification rule |
| --- | --- | --- | --- |
| UMI member DM | Own private + general UMI | Work fact, including semantic uncertainty, to own private **and** general; personal-sensitive fact to own private only | Work/general includes infrastructure identifiers, security findings, incidents, access procedures, non-secret access metadata, and member-DM semantic uncertainty. The narrow personal blacklist is private only. |
| Mixed fact in member DM | Own private + general UMI | Useful work consequence to both; sensitive reason/detail to private only | Split at fact level. Do not publish one mixed bullet to general merely because it contains a useful work consequence. |
| UMI team group | General UMI only | General UMI only | No member personal guard; semantic uncertainty is general. |
| Partner assistant group | That partner memory only | Partner memory **and** general UMI for every accepted non-secret fact | Do not apply the team-member personal guard. Partner cannot read the general copy. |
| Unmapped/unauthorized context | None | None | No memory tools, no staging capture, and normal chat continues. |

The personal blacklist is deliberately narrow: compensation/payroll/equity,
HR/performance/disciplinary/candidate evaluations, health/medical, family or
relationship/private-life matters, personal legal/financial matters, and
explicit private/confidential instructions. In a member DM, semantic
uncertainty defaults to work/general and therefore writes to both own-private
and general; team-group uncertainty remains general-only. Operational
uncertainty means the classifier, provider, schema, or
retry machinery failed; it stages/queues and retries rather than selecting a
destination.

Literal credential/auth values are rejected everywhere in memory publication.
Private memory is not a password manager. Non-secret facts about work
infrastructure and access remain eligible under the matrix.

### Policy precedence

For every memory destination decision, apply these layers in order:

1. **Authorization and context:** resolve the authenticated role and context
   first. Unauthorized/unmapped contexts get no tools, no staging, and no
   writes. Team groups are general-only; partner groups read partner memory
   and dual-write every accepted non-secret fact.
2. **Secret decision:** before any destination or SQL write, mask an actual or
   unresolved key/value credential value for durable storage and reject it from
   memory. Prose-form credential fixtures and known-shape fixtures are also
   rejected when the deterministic detector marks them as suspected or
   unresolved. A small deterministic allowlist preserves obvious non-secret
   vocabulary such as `password: required`. This is a new fail-safe policy;
   the current detector does not already provide it.
3. **Member-DM sensitivity:** only an authorized member DM invokes the narrow
   personal-sensitivity router. Explicit-private instructions and the narrow
   personal blacklist can select private-only there. They never override the
   team-group general-only rule or the partner group's unconditional
   partner-plus-general write.

The deterministic secret decision is a storage/publication safety boundary.
Personal sensitivity remains a model judgment within the member-DM layer: the
zero-leak fixture is a release gate, not a mathematical guarantee. The
publisher must veto explicit-private instructions and every obvious narrow
blacklist cue before accepting a router result; this veto is not a general
allowlist and must not turn semantic uncertainty into private. Arbitrary prose
with no detectable secret signal cannot be mathematically recognized as a
secret; the product rule still rejects every literal credential/auth value that
is recognized.

### Versioned role/context matrix

The single fixture `tests/fixtures/scoped-memory-role-context-matrix.v1.json`
is the authoritative negative-test matrix. Every row names allowed reads,
allowed writes, forbidden reads, forbidden writes, and whether tools/staging
exist.

| Fixture | Context | Allowed reads | Allowed writes | Forbidden reads | Forbidden writes | Tools/staging |
| --- | --- | --- | --- | --- | --- | --- |
| `member-dm-work-v1` | Authorized UMI member DM | Own private, general | Work part to own private + general | Other member, any partner, raw paths/collections | Other private, partner, arbitrary destination | Recall/capture allowed; own staging only |
| `member-dm-personal-v1` | Authorized UMI member DM | Own private, general | Personal part to own private | General copy of personal part, other principals | General, other private, partner | Recall/capture allowed; own staging only |
| `member-dm-mixed-v1` | Authorized UMI member DM | Own private, general | Work part to both; sensitive part private | Sensitive part in general; other principals | Sensitive part general, other principals | Recall/capture allowed; own staging only |
| `team-group-v1` | Authorized UMI team group | General only | General only | Any private/partner scope | Private, partner, destination selected from content | Recall/capture allowed; group staging only |
| `partner-group-v1` | Authorized partner assistant group | That partner only | Partner + general | General read, team private, other partner | Private-only routing, other partner | Recall/capture allowed; partner staging only |
| `unmapped-v1` | Unmapped context | None | None | Every memory scope/path | Every memory destination | No tools and no staging |
| `unauthorized-v1` | Wrong sender/audience/role | None | None | Every memory scope/path | Every memory destination | No tools and no staging |

### Requirements

#### Identity and eligibility

- R1. Memory behavior and data are provider-neutral; Claude/Codex switch the
  same binding and scopes, not a provider-specific store.
- R2. Polygram derives eligibility from exact bot, chat, topic, numeric sender,
  configured binding, and audience authorization. Names, model output, and
  message content never select a binding.
- R3. Unmapped, disabled, contradictory, unauthorized, or audience-unknown
  context has no memory tools and no capture. A memory-bearing warm/persisted
  session and its queued work are retired before normal no-memory handling.
- R4. A binding names one typed principal: team member, UMI team, or partner.
  Principal type cannot change in place.
- R5. A UMI member DM reads exactly that member's private scope plus general
  UMI. Team groups read general only. Partner groups read only their partner.

#### Destination policy and identity

- R6. A non-secret UMI work fact captured in a member DM is classified as
  general work and publishes to both that member's private scope and general
  UMI. Infrastructure identifiers, security findings, incidents, access
  procedures, and non-secret access metadata remain in this work category.
- R7. A personal-sensitive fact matching the narrow blacklist publishes to the
  member-private scope only. In an authorized member DM, semantic uncertainty
  is treated as work/general and publishes to both own-private and general; it
  does not become private by guesswork.
- R8. A mixed fact is split into useful work consequence and sensitive
  reason/detail. The work consequence publishes to both member-private and
  general; the sensitive part publishes private only. One source bullet may
  not be copied wholesale to general when its sensitive detail is separable.
- R9. Team-group capture writes general only, regardless of an in-content
  request to store privately.
- R10. Every accepted non-secret partner fact publishes idempotently to that
  partner scope and general UMI. The team-member personal guard is not applied
  to partner groups.
- R11. Every extracted source fact has a stable `source_fact_id`. Each routed
  part has a deterministic `part_id` derived from source identity, part kind,
  normalized content, and policy epoch. Exact copies of one part across
  destinations share the `part_id`; distinct work and sensitive parts never
  merge. The content digest is deterministic and non-secret.
- R12. Publication idempotency is destination-aware: `(part_id, destination)`
  is the physical idempotency key, while recall de-duplicates exact copies by
  `part_id` before ranking, limits, and injection. A source replay cannot
  duplicate a successful destination or merge a distinct part.

#### Secrets and trust boundaries

- R13. Literal credential/auth values are rejected from memory publication and
  never enter private or general journals/indexes. Actual or unresolved
  key/value credential values are masked before durable storage as well. The
  trusted publisher checks again even if staging or an earlier boundary
  sanitized text; any detector result marked suspected or unresolved is
  quarantined and not published.
- R14. The new durable-boundary policy must mask a value such as
  `password: hunter2` before SQLite/FTS and reject that fact from memory. A
  small deterministic allowlist leaves obvious non-secret vocabulary such as
  `password: required` intact. This is new policy; `lib/secret-detect.js`
  currently flags low-tier `kv-secret` rather than enforcing this distinction.
  Durable rows and FTS contain no raw credential. The live provider turn may
  still receive the original message.
- R15. The existing background sweep and agent-reported redaction remain
  defense-in-depth and incident cleanup. Neither is the primary durable-storage
  boundary.
- R16. Native staging may contain an echoed secret briefly, but staging is
  owner-only, non-recallable, bounded, excluded from backups/logs/telemetry,
  and deleted after publication/rejection or bounded TTL/startup cleanup. Each
  producer enforces a receipt deadline within the 15-minute staging lifetime;
  a 24-hour receipt tombstone refuses late writes, including after directory
  cleanup.
  The detached handoff has explicit incomplete, completed, claimed, terminal,
  startup-recovery, and late-writer states; a writer after rejection cannot
  recreate a terminal item.
- R17. The gateway/publisher, not Claude, Codex, an agent file, or a skill,
  maps opaque bindings to readable scopes and write destinations.
- R18. Provider children cannot read scoped source/index paths or invoke a
  publisher endpoint outside the bound dispatcher. The real deployment must
  prove the claimed staging-only write and scope-bounded read boundary.
- R18a. Deployed publisher artifacts, units, configuration, and executed
  package inputs are root-owned/provider-unwritable and digest-allowlisted.
  Repository checkouts are source only, never an execution path.

#### Recall and runtime behavior

- R40. Generic `recall` accepts only a text query of at most 2 KiB; the gateway
  owns scopes, ranking, at most five results, and a 12 KiB total result.
- R41. The model cannot pass collection, path, principal, destination, or scope
  arguments. Plugin-native recall is not an allowed fallback.
- R42. The active model may call recall when context would help; it never
  decides what is saved.
- R43. Capture is automatic and requires no model-invoked `remember` call.
- R44. Recall is turn-bound and revalidates the binding digest immediately
  before result injection. Stale or replaced calls return nothing.
- R45. Claude CLI and Codex use the same generic recall schema in MVP. Claude
  SDK is full-parity work, not an MVP gate.
- R46. Memory timeout, malformed response, or index failure cannot turn a
  successful Telegram reply into a failed chat. A per-turn circuit breaker
  prevents retry loops.
- R47. Recall returns data-only records with fact identity, source binding,
  source role, timestamp, and record ID. Content is untrusted.
- R48. Tools are registered from authorized configuration, while transient
  gateway health is checked inside each call.

#### Capture, routing, publication, and lifecycle

- R59. Memsearch native extraction remains unchanged, in-session, on the
  already-authorized Claude/Codex subscription. No replacement extractor, no
  extraction-prompt retune, and no second extraction path are introduced.
- R60. The native hook has no publisher endpoint and writes only to its own
  per-binding staging area. Staging is absent from all recall views.
- R60a. Staging is owner-only, non-recallable, mode-restricted, size/count
  bounded, excluded from backup/log/telemetry, and removed after publish/reject
  or TTL/startup cleanup.
- R61. Publication validates receipt and policy epoch, sanitizes/rejects secrets
  before journals/indexes, runs the personal-sensitivity routing/splitting pass
  when the binding needs it, resolves destinations, and commits/indexes only
  after all required checks pass.
- R61a. Every fanout role, including MVP member DM, uses one durable outbox /
  destination ledger with captured policy epoch, per-destination state, retry
  count, and terminal reason. Retries select missing destinations only; partial
  state is visible and repairable. Before zero commits, a policy-epoch change
  rejects the item. After any partial commit, publication stops all new writes,
  records terminal `partial-policy-change`, exposes written destinations for
  compensating removal/operator repair, and never completes under a new epoch.
  Automatic retry is allowed only while the captured epoch remains current.
- R61b. Exactly one valid routing result is durably persisted under
  `(receipt, source_fact_id, policy_epoch)` before fanout. Retries reuse that
  result and never reroute. A lost response or late divergent second result is
  quarantined as an operational failure and cannot publish.
- R62. Each turn receives an immutable receipt bound to binding, provider
  namespace, session, turn, and policy epoch. The provider session cannot forge
  it.
- R63. Eligibility is revalidated before each physical commit and before recall
  injection. Before zero commits, an epoch change rejects pending capture; after
  partial publication, the R61a `partial-policy-change` terminal state stops
  new writes and exposes compensating repair. No role completes under a new
  epoch.
- R64. Capture is best-effort, not exactly-once, but durable per-destination
  state is an MVP requirement. Stable `{source_fact_id, part_id, destination}`
  identity makes retries idempotent and exposes partial fanout.
- R65. A logical source fact may produce one physical part or several parts and
  several authorized destination copies. Recall de-duplicates exact copies by
  `part_id`, never distinct parts merely because they share a source fact.
- R66. A root/operator-owned projection is the only authorization source.
  Ordinary chat/topic configuration may opt out but cannot enable memory or
  widen a binding.
- R67. The deployed authorization path is provider-unwritable. If deployment
  cannot guarantee this, rollout remains blocked.
- R68. A routing process that cannot prove exact runtime/auth/model identity,
  returns malformed output, times out, or exhausts bounded retries stages the
  item and retries. It never silently chooses general or private.
- R69. The routing pass is narrow personal-sensitivity detection/splitting after
  unchanged native extraction. It prefers one fixed cheap router for both
  source backends, using an already-authorized subscription only if U24 proves
  the exact process/auth boundary and no commercial API key is needed.
- R70. Before memory activation, every legacy unscoped memory writer, injector,
  recall path, and session/corpus loading path is disabled or excluded for
  memory-enabled bindings. No legacy path may be re-enabled as an implicit
  rollback.
- R71. The old corpus is Ivan-private, read-only, receives no new writes, and
  is unavailable to every other principal through recall or staging.
- R72. Backup and restore preserve scope ownership and destination isolation:
  private, general, partner, legacy, staging, and telemetry data cannot cross
  principals or become newly recallable after restore.

### User flows

1. Ivan's member DM recalls own-private and general facts through generic U14;
   exact destination copies collapse to one `part_id`, while distinct mixed
   parts remain separate.
2. A member-DM work fact, including an infrastructure identifier, is extracted
   unchanged, routed as work/general, and published to both own-private and
   general. A personal-sensitive fact is private only.
3. A mixed fact is split so the useful work consequence reaches both scopes and
   the sensitive reason/detail reaches private only.
4. A team group reads/writes general only. A partner group reads only its
   partner scope while each accepted non-secret fact also gets a general copy;
   the partner never sees that general copy through recall.
5. A recognized credential/auth value, including a known-shape, key/value, or
   deterministic prose-form case, is sanitized before SQLite/FTS; an echoed
   secret in native staging is rejected by the publisher and appears in no
   memory journal/index. Audit telemetry contains no plaintext. Arbitrary prose
   with no detectable signal is not claimed to be universally recognizable.
6. A malformed or timed-out routing pass leaves the staged item queued for
   bounded retry. No destination is selected by fallback.
7. A binding/audience change retires warm and persisted provider sessions and
   rejects stale queued work before another memory-enabled turn.

### Acceptance examples

- AE1. A member DM finds own-private and general sentinels, but no other member
  or partner sentinel.
- AE2. A member-DM work fact is present in both authorized scopes; a personal
  blacklist fact is absent from general; a mixed fact has only its useful work
  consequence in general.
- AE3. A team-group request to store privately still produces general-only
  capture. A partner fact produces identical partner/general copies, but a
  partner search returns only the partner copy; both fanout states are durable.
- AE4. Recall arguments containing paths, collections, principal IDs, or extra
  fields are rejected; plugin-native recall is not installed or usable.
- AE5. `password: hunter2` is masked before every durable sink and rejected
  from memory, while `password: required` remains intact under the allowlist.
  A known-shape secret in inbound text is absent from the durable message row
  and FTS, and a publisher-seen secret is absent from every journal/index.
- AE6. Staging is not recallable by its producing session or any other
  principal, and it is removed after publish/reject or TTL cleanup.
- AE7. Replaying one source fact creates no duplicate `(part_id, destination)`
  ledger entry; recall returns one result for exact cross-scope copies and does
  not merge distinct mixed parts.
- AE8. In a member DM, semantic uncertainty routes as work/general to both
  own-private and general. Malformed output, timeout, or routing-auth failure
  queues/retries and never chooses a destination.
- AE9. Claude-to-Codex and Codex-to-Claude recall/capture preserve the same
  binding and negative-sentinel matrix.
- AE10. Enabling Codex hooks does not fault a turn after the reviewed Orchestra
  release accepts and drops `hook/started` and `hook/completed`; the hook's
  `turn_id` equals the app-server `turn/started` id, and U14 proves the
  model-visible generic recall mechanism for both source backends.

### Success criteria

- Zero private-to-general leaks in the pre-registered routing spike and Ivan
  canary; mixed facts are split at fact level.
- Every accepted partner fact has both physical copies with one source/part
  identity and destination-aware ledger state, and partner recall never
  exposes the general copy.
- No recognized credential/auth value—including known-shape, key/value, or
  deterministic prose-form cases—reaches any inventoried durable sink, a
  private/general journal, or an index. Native staging's transient exception is
  bounded and observable only through content-free telemetry; arbitrary prose
  with no detectable signal is not claimed to be universally recognizable.
- Claude CLI and Codex pass the same positive/negative scope matrix and can
  switch providers without changing ownership.
- The corrected G1 gate passes all five production-style Linux runs with the
  unchanged 2x concurrent/idle p95 ratio and 1200 ms absolute budget, using a
  known embedding boundary and separate-process writer. The existing 5/5
  same-process failure and the process-split diagnostic are not a pass.
- Normal chat remains healthy when memory is disabled, unavailable, or queued
  for routing retry.

### Scope boundaries

#### Narrow MVP

- Ivan's UMI member DM only.
- Claude CLI and Codex only, after the reviewed Orchestra prerequisite.
- Own-private/general recall through U14 and automatic staged capture.
- Work-to-both, personal-private-only, and mixed-fact split policy.
- Deterministic durable-input secret sanitization and publisher re-rejection.
- No partner/group enablement and no Claude SDK transport.

#### Full-parity boundary

- UMI team groups, partner assistant groups, partner/general dual-write,
  partial-write repair, one additional person, audience observability,
  backup/restore isolation, and Claude SDK transport.
- Full parity does not relax secret rejection, fact identity, recall
  de-duplication, or operational retry semantics.

#### Deferred to follow-up work

- Exactly-once capture, conversational delete/forget, memory UI, transcript
  drill-down, or legacy automatic reclassification. Durable per-destination
  capture state and retry of missing destinations are MVP requirements, but
  global exactly-once semantics remain out of scope.
- A managed-provider extraction path or any new commercial credential. It is an
  alternative requiring a new decision if U24 cannot prove the authorized
  subscription boundary; it is not silently substituted.

---

## Planning Contract

Product Contract preservation: unchanged.

### Corrected existing-code findings

These are top findings that correct or narrow claims in the previous plan.

1. `lib/handlers/record-inbound.js` chooses `msg.text || msg.caption` and calls
   `db.insertMessage` inside the durable SQLite transaction without sanitizing
   the text. `lib/db.js`'s `insertMessage` passes `row.text` directly to the
   prepared `INSERT`; the external-content FTS insert trigger indexes it in the
   same write. The previous plan did not identify this as a primary boundary.
2. `migrations/014-secret-redactions.sql` adds only the
   `secret_redactions` audit table and `messages.secret_scanned_at`. It does not
   sanitize inserts. `lib/db/secret-sweep.js` is a later bounded/background
   scan, and its default configuration is disabled with dry-run enabled when
   enabled. `db.redactSecretInChat` is also a later agent-reported cleanup over
   recent inbound rows. Both are defense-in-depth, not pre-insertion protection.
3. `lib/secret-detect.js` currently auto-redacts only high/medium tiers and
   flags the low `kv-secret` rule because it can false-positive on prose such as
   `password: required`. The new durable boundary must define the deterministic
   known-shape policy explicitly and preserve non-secret prose; it must not
   claim the current detector already rejects every raw credential.
4. The current pinned Orchestra schema is in
   `node_modules/@shumkov/orchestra/lib/codex/protocol-schema.json`, not
   `lib/codex/protocol-schema.json` in this repository. Orchestra 0.10.14 lacks
   `hook/started` and `hook/completed` in its dropped-notification set, so the
   U21 failure is real. Separately, `lib/codex/binary.js` already rejects PATH
   lookup and requires a canonical absolute pinned Codex binary. The plan must
   test that existing guarantee for the memory hook rather than describe it as
   absent.
5. `lib/codex/runtime-profile.js` currently renders the owned Codex config but
  has no trusted hook-hash state. Rendering those hashes and re-pinning the
  resulting owned-config digest is new work; it must not be delegated to the
  memsearch installer because Polygram rejects installer-modified config.
6. `migrations/014-secret-redactions.sql` records an unsalted SHA-256
  correlation value. That is secret-derived metadata, not harmless telemetry:
  the implementation must remove it unless correlation is demonstrated as
  necessary, or replace it with a versioned keyed HMAC outside provider-child
  access and migrate existing plain hashes.

### Verified evidence

- U21: native capture binding passed for Claude/Codex; Codex inline hooks run
  under the pinned app-server; plugin-native recall failed the scope boundary;
  hook `turn_id` equals the app-server `turn/started` id; Orchestra 0.10.14
  faults on `hook/started` and `hook/completed`. U21 is therefore not a broad
  feasibility unknown: it is a known external release prerequisite plus U14.
- U22: the frozen same-pass label extension preserved extraction parity and
  format, but produced 10 known private-to-general leaks, all disclosure
  directed. It is rejected. Do not retune, resurrect, or call it a viable
  default.
- U16a: the unchanged same-process harness failed G1 in all five runs. The
  separate-process writer diagnostic identified the artifact but did not pass
  G1; the production Linux ONNX gate has not run. The effective VPS provider is
  unknown from local evidence; upstream's ONNX default is not proof of live host
  configuration.
- U13: public record-level deletion was proven only for directory-configured
  scopes; the checked-in finding still says the Codex dynamic-tools evidence
  is in progress. Installed Orchestra 0.10.14 has no executable Codex generic
  recall surface. U14 therefore needs an exact mechanism, owning repository,
  reviewed Orchestra release/consumer pin, and one model-visible Claude-CLI /
  Codex proof before U17 or U19 may start.

### Key technical decisions

- KTD1. Keep unchanged native extraction in-session on the existing
  subscription (session-settled: user-directed — preserve current automatic
  extraction quality and avoid a new credential). Its only durable destination
  is owner-only staging.
- KTD2. Use generic U14 recall and forbid plugin-native recall (session-settled:
  user-directed after U21 — plugin instructions expose collection/path choice,
  bypass result caps, and can read staging).
- KTD3. Put trust at the publisher: sanitize/reject before journal/index,
  validate receipt and policy epoch, route/split, assign stable fact identity,
  and fan out only to authorized destinations. The provider session has no
  publisher endpoint.
- KTD4. Reject the U22 same-pass destination label (evidence-settled — 10
  disclosure-directed leaks and run-to-run instability). No prompt retune or
  same-pass successor is planned.
- KTD5. The smallest automatic successor is unchanged native extraction
  followed by a separate narrow personal-sensitivity routing/splitting pass,
  using an already-authorized subscription and a cheap fixed model only if U24
  proves the exact process/auth boundary. This is routing, not replacement
  extraction. U24 is a gate, not a production-safety claim.
- KTD6. Keep semantic and operational uncertainty distinct: semantic
  uncertainty is general; malformed output, timeout, auth ambiguity, or retry
  failure stages/queues and retries without a destination.
- KTD7. Use `source_fact_id` for the extracted source, deterministic `part_id`
  for each routed part, and `(part_id, destination)` for physical idempotency.
  Exact destination copies share a part and recall de-duplicates by `part_id`;
  distinct mixed parts never merge.
- KTD8. Treat the Orchestra hook-notification schema/release/pin as a separate
  reviewed prerequisite. Polygram must consume the exact release; no memory
  Codex canary runs on Orchestra 0.10.14.
- KTD9. Enforce secrets twice: a new deterministic durable-boundary policy
  masks actual or unresolved key/value credential values before SQLite/FTS and
  rejects them from memory, then the publisher rejects/sanitizes again before
  journals/indexes. A small allowlist preserves `password: required`; the
  current detector does not already implement this. Existing sweep and agent
  redaction remain defense-in-depth.

### High-level technical design

```mermaid
sequenceDiagram
  participant T as Telegram
  participant P as Polygram
  participant A as Claude/Codex turn
  participant S as Owner-only staging
  participant R as Narrow router
  participant W as Trusted publisher
  participant M as Scoped journals/indexes
  participant Q as Generic recall U14

  T->>P: inbound message (original text retained for live turn)
  P->>P: sanitize known-shape secret before SQLite/FTS INSERT
  P->>A: original live turn
  A->>S: unchanged native extraction, per-turn receipt
  S->>W: drain staged entry; secret check again
  W->>R: only team-member facts needing sensitivity routing
  R-->>W: private/general split, or queue on operational failure
  W->>M: publish source_fact_id/part_id to ledger destinations
  A->>Q: text-only recall query
  Q->>M: scope-bound search, merge duplicate part_id copies
  M-->>Q: bounded data-only results
  Q-->>A: results after binding revalidation
```

The native hook may briefly hold an echoed secret in staging. That is the only
planned transient exception; it is never recallable and is removed on every
terminal path. The router never replaces extraction and never gets to widen a
binding. Partner dual-write is unconditional and bypasses the member
personal-sensitivity guard.

### Alternatives rejected

1. **U22 same-pass label:** rejected after the pre-registered failure. It leaked
   10 private facts, split one subject across destinations, and varied on
   identical input. No retune is authorized.
2. **Broad post-extraction private/general classifier:** rejected as larger than
   the needed successor. U24 is narrow personal-sensitivity routing/splitting
   only, after unchanged extraction, with a fixed cheap model if feasible.
3. **Plugin-native recall:** rejected by U21 because the model can choose a
   collection, set result limits, bypass search, and read source files.
4. **Sweep-only or agent-reported redaction:** rejected as the primary boundary
   because both act after SQLite/FTS insertion. They remain useful cleanup and
   defense-in-depth.
5. **Managed-provider extraction:** rejected as the default because it adds a
   commercial credential, new cost centre, and a replacement capture path.
6. **Replacement extractor or model-invoked `remember`:** rejected; native
   extraction remains the quality baseline and capture is automatic.

### Assumptions and deferred questions

- The exact process/auth boundary for the cheap fixed router is unresolved
  until U24. Codex CLI 0.145 is an attested rejected candidate because it
  cannot prevent built-in tool use; the accepted candidate must prove the
  pinned Claude CLI, exact observed Haiku model, first-party subscription auth,
  facts from both source-backend policies, and no commercial API key.
- The effective embedding provider on the UMI VPS is unresolved. The corrected
  U16a gate must record the actual boundary or deliberately pre-stage and pin
  the upstream ONNX default before measuring; it must not infer live state from
  versioned repositories.
- Whether separate processes may open the same scope's Milvus-Lite file
  concurrently remains a U16 storage-design question. If unsupported, the
  publisher/index architecture must change before estimates are treated as
  final.
- The remaining risk that a model misses personal context in arbitrary prose
  is an explicit sync decision: the bounded zero-leak fixture and deterministic
  vetoes are required gates, but they are not a mathematical guarantee of
  perfect semantic classification.

---

## Implementation Units

Unit IDs remain stable. U13, U21, and U22 are evidence/spike history; U23-U27
are new prerequisites or gates and do not renumber existing units.

| U-ID | Title | Files/target | Depends on |
| --- | --- | --- | --- |
| U13 | Feasibility gates | `docs/2026-08-06-u13-findings.md` | — |
| U21 | Plugin integration evidence | `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md` | U13 |
| U22 | Same-pass label evidence | `docs/2026-08-11-u22-destination-label-findings.md` | U21 |
| U16a | Corrected G1 latency gate | `scripts/spikes/memsearch-isolation/`, findings | U13 |
| U23 | Orchestra hook-notification release prerequisite | Orchestra release plus Polygram pin/config consumption | U21 |
| U24 | Narrow routing/auth/schema spike | new versioned spike and findings doc | U21, U22, U23 |
| U25 | Durable text-sink inventory and secret boundary | Polygram text sinks, FTS, telemetry, migrations/tests | U13 |
| U27 | Detached native-capture handoff gate | disposable real Claude/Codex capture and staging state machine | U21, U23 |
| U15 | Polygram binding/session/receipt | `lib/memory/`, `lib/codex/`, session lifecycle tests | U23, U24, U16a |
| U16 | Staging/publisher/ledger/registry | memory publisher, staging, `umi-vps-infra`, redaction/runbook tests | U15, U24, U25, U16a, U27 |
| U14 | Generic scoped recall transport | pending mechanism spike, Orchestra release, Polygram pin/consumption, protocol tests | U21, U23 |
| U17 | Recall client/released consumption | `lib/memory/provider-client.js`, `lib/memory/tools.js`, integration tests | U14, U15, U16 |
| U18 | Shared skill and legacy cutover | `shumabit-claude` skill/config and Polygram session gate | U16, U17 |
| U26 | Historical durable-sink cleanup gate | bounded inventory/sanitize/rebuild/verify runbook | U18, U25 |
| U19 | Ivan DM MVP canary | rollout artifacts and real-runtime evidence | U18, U26, U16a, U27 |
| U20 | Full parity rollout | SDK, groups, partners, backups, audience controls | U19 |

### U13. Feasibility gates (spent)

- **Goal:** Preserve the deletion evidence and record the unresolved generic
  Codex recall evidence without overstating it.
- **Requirements:** R11, R40, R44, U14 prerequisite.
- **Files:** `docs/2026-08-06-u13-findings.md`, existing spike artifacts.
- **Verification:** Treat public record-level deletion as valid only for
  directory-configured scopes. The checked-in finding says dynamic-tools
  evidence is in progress; it is not a PASS. Installed Orchestra 0.10.14 has
  no executable Codex generic-recall surface, so U14 must name the mechanism,
  owning repository, reviewed Orchestra release and consumer pin, and prove
  one model-visible Claude-CLI/Codex recall turn before U17 or U19 starts.

### U21. Plugin integration evidence (evidence complete; delivery blocked by U23)

- **Goal:** Record the actual native hook and recall boundaries.
- **Requirements:** R59, R60, R62, R66.
- **Files:** `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md`.
- **Approach:** Keep inline hooks; bind capture through a wrapper reading the
  hook payload; use `MEMSEARCH_DIR` for staging; do not install plugin-native
  recall skills. Codex hooks execute, but Orchestra 0.10.14 faults on the two
  hook notifications.
- **Test scenarios:** Evidence already covers Claude/Codex capture binding,
  staging containment, hook trust discovery, receipt correlation, and the
  plugin-native recall negative result.
- **Verification:** U21 is not a PASS. U23 must prove the released Orchestra
  process survives a full hook-enabled turn.

### U22. Same-pass destination label (rejected evidence)

- **Goal:** Preserve the failed pre-registration and prevent accidental
  resurrection.
- **Requirements:** R6-R8, R59, R69.
- **Files:** `docs/2026-08-11-u22-destination-label-findings.md`.
- **Approach:** No retune and no same-pass label. Extraction parity was clean,
  but G-PRIV failed with 10 disclosure-directed leaks and instability.
- **Test scenarios:** The frozen 12-turn, 3-repetition corpus remains the
  evidence; no second arm is authorized.
- **Verification:** Mark the same-pass hypothesis rejected, not pending.

### U16a. Corrected G1 latency gate (blocker)

- **Goal:** Prove the unchanged latency thresholds under the scheduler and
  embedding boundary the design actually uses.
- **Requirements:** The unchanged 2x/1200 ms G1 thresholds and the corrected
  U16a host/provider, process-writer, cross-process, and five-run gate.
- **Files:** `scripts/spikes/memsearch-isolation/`,
  `docs/2026-08-11-u16a-memsearch-latency-findings.md`.
- **Owner:** Polygram spike owner owns the harness and evidence; the
  `umi-vps-infra`/VPS operator owns host access, provider confirmation,
  busy/owner checks, cleanup, and the Linux run window.
- **Runnable pieces:** (A) confirm the host/provider boundary and stage the
  approved model; (B) correct the process-writer harness and capture overlap
  evidence; (C) run a same-scope cross-process storage check; (D) run the
  five-run production-class Linux gate with owner/busy/cleanup attestations.
  A and B may run in parallel; C follows B; D follows A, B, and C.
- **Approach:** Keep the 2x ratio, 1200 ms absolute budget, sample count, and
  oracles. The unchanged same-process harness failed 5/5; the process split
  diagnosed that artifact but did not pass the production Linux ONNX gate.
  Record the actual provider/model boundary or leave it explicitly unknown;
  upstream ONNX defaults are not proof of the live host.
- **Verification:** Every one of five consecutive Linux runs passes both
  thresholds, the writer overlaps the measurement window, same-scope access
  is proven, and the operator attestations are attached. Until then G1 remains
  open and memory feature enablement stays blocked.

### U23. Orchestra hook-notification release prerequisite (blocker)

- **Amendment plan (governing):**
  `docs/plans/2026-08-16-002-feat-codex-hook-trust-discovery-plan.md` in the
  `polygram.scoped-memory-u23-consumption` worktree. **Both multi-agent spec
  review rounds are complete and it is `implementation-ready`**, with its
  decision history recorded in its frontmatter. It **governs U23's Approach,
  Files, Test scenarios, and Verification** — wherever it and the text below
  differ, it wins.
- **S0 characterization: COMPLETE, `CONTINUE` (2026-08-17) —
  `aarch64-apple-darwin` only, and characterization only.** It ran against the
  pinned Codex binary with a loopback provider on a spike-owned home;
  **neither released-production live gate has run on either target.**
  Findings: `docs/2026-08-17-001-u23-hook-trust-characterization-findings.md`
  in that same worktree. Load-bearing results: the user-layer digest risk is
  cleared; the `hooks/list` params form is frozen to `{cwds: [ownedCwd]}`;
  `[features] hooks = true` is not required; the `key` derivation is confirmed
  for all three events; **the manifest a session executes is fixed at
  `thread/start`, so verification before `thread/start` does not close that
  race**; the hook-before-checkpoint race is live and **owned by U15**; and the
  earlier "10-100 ms" durable-budget figure is **withdrawn** as a measurement
  artefact. Unmeasured: the `x86_64-unknown-linux-musl` runtime receipt; whether
  `thread/resume` snapshots as `thread/start` does; and whether a post-
  `thread/start` `hooks/list` reflects the bound snapshot.
- **Goal:** Make Codex hooks survivable under the exact pinned Orchestra path.
- **Requirements:** R45, R59, R62, AE10.
- **Dependencies:** U21.
- **Files:** Orchestra's reviewed `lib/codex/protocol-schema.json` source in
  its own repository/release; Polygram's exact dependency/pin and protocol
  receipt; `lib/codex/runtime-profile.js`, `lib/codex/binary.js`, and focused
  tests in this repository.
- **Approach:** Add `hook/started` and `hook/completed` to the Orchestra
  dropped-notification set, review and release Orchestra, then consume the
  exact released version. Render trusted hook hashes in Polygram's owned Codex
  config and re-pin the owned-config digest; never run the memsearch installer
  against Polygram's byte-exact config. Use the absolute pinned Codex path
  already enforced by `lib/codex/binary.js`; the wrapper must pass that path,
  never resolve `codex` from PATH. Mint/lookup receipts by the app-server
  `turn/started` id and require equality with hook stdin `turn_id`.
  **Superseded in four respects by the amendment plan and S0:** (a) rendering
  trusted hashes additionally requires a reviewed Orchestra internal,
  manifest-bound hook verifier, because no allowed surface reports a hook's
  `currentHash`; (b) U23 proves `turn/started.id === hook.turn_id` and the
  observed ordering from **existing** checkpoint evidence and builds **no**
  receipt mint/lookup machinery — that stays U15's; (c) hook commands are
  rendered from typed descriptors with attested runtime/artifact paths rather
  than shell text; (d) **production executed inputs must satisfy the
  R18a-grounded artifact boundary** — a root/operator-owned immutable versioned
  tree with a digest manifest, service-unwritable ancestors, versioned command
  paths, and every transitive executed input attested (including `stop.sh`
  before U15 may exec it). Enablement fails closed where that boundary cannot
  be installed.
- **Test scenarios:** A credential-free app-server turn with trusted hooks
  produces no Orchestra protocol fault; the control without hooks remains
  unchanged; changing a hook changes its trusted hash/config digest; a wrapper
  using a PATH-selected binary is rejected; `turn/started.id === hook.turn_id`.
- **Verification:** The reviewed Orchestra release is consumed by Polygram,
  its exact pin/protocol digest is self-consistent, and the hook-enabled Codex
  turn completes before any memory implementation proceeds.

### U24. Narrow routing/auth boundary spike (blocker)

- **Status (2026-08-20):** Before the retry amendment, the reviewed Node 24
  harness and adjacent secret/memory tests passed 127/127. After the amendment,
  the focused suite passed 28/28 and the adjacent six-file suite passed 92/92.
  The deterministic single-retry amendment is implemented, red-to-green
  tested, and independently reviewed. The corrected
  native-executable VPS shape gate passed. The one authorized full gate
  stopped with 108 accepted, 20 pre-model quarantined, two destination-free
  terminal operational errors, zero mismatches, zero privacy flags, two
  recovered retries, and two confirmed-cleanup timeout retries exhausted.
  Exact model identity, projection/arithmetic checks, and 20/20 injected fault
  outcomes passed. U24 remains blocked by operational timeout/process-boundary
  reliability, not a privacy or model-identity failure. The reviewed follow-up
  timeout characterization then ran once from exact commit `d37de69` and
  stopped safely after its first 7.3-second call with
  `diagnostic-failure / invalid-envelope`. Process close, transient-unit
  inactivity, empty cgroup, durable checkpointing, and scratch cleanup were
  all confirmed. Its content-free receipt proves that one JSON candidate was
  observed, but cannot distinguish invalid/trailing JSON from a valid envelope
  whose required duration or turn-count fields failed the diagnostic contract.
  A reviewed five-category discriminator was then committed as exact commit
  `dfd2fc2` and staged from an immutable seven-file archive. After fresh
  approval, its one changed VPS campaign stopped safely after the first
  8.0-second call with
  `diagnostic-failure / invalid-envelope-turn-count`; process close,
  transient-unit inactivity, empty cgroup, durable checkpointing, and scratch
  cleanup again passed. This rules out the other four discriminator classes as
  the selected failure but intentionally does not retain whether `num_turns`
  was missing, malformed, or a different integer. Do not rerun any unchanged
  gate or diagnostic. The pinned-CLI `num_turns` investigation, reviewed
  positive-safe-integer turn-evidence contract, v2 receipt implementation, and
  local verification are complete. U24 remains blocked pending a signed
  immutable changed commit, fresh approval using the reviewed outer-invocation
  accounting terms, and one bounded VPS campaign whose evidence is folded back
  into this plan.
- **Goal:** Decide whether the smallest successor to U22 is safe enough to
  implement: unchanged native extraction followed by a separate narrow
  personal-sensitivity routing/splitting pass.
- **Requirements:** R6-R8, R13, R59, R68, R69, AE2, AE8.
- **Dependencies:** U21, U22, U23.
- **Files:** new versioned spike harness and findings document; use synthetic
  fixtures and existing provider/runtime test helpers where possible.
- **Approach:** Prefer one fixed cheap subscription-backed router for both
  source backends. The capability review rejected Codex CLI 0.145 as the
  router because it exposes built-in tools and has no preventive equivalent
  of Claude CLI's `--tools ""`; post-hoc tool-event rejection would be too late.
  Use the fixed vendored Claude CLI/Haiku invocation for facts extracted from
  either Claude or Codex sessions. Record the exact pinned Codex binary and
  ChatGPT login as the rejected-candidate evidence, but do not send routing
  facts to it. Feed only
  extracted facts on stdin and accept schema-only stdout: no tools, MCP, or
  filesystem access. Record the exact binary, model, auth source, process
  boundary, runtime identity, and proof that no commercial API key is used.
  Keep native extraction unchanged. Deterministic secret rejection precedes
  routing. The publisher deterministically vetoes explicit-private
  instructions and every obvious narrow-blacklist cue before accepting a
  router result. A valid closed result is exactly one of `work`, `personal`,
  or `mixed`. Meaning that is uncertain but has no personal-sensitive cue is
  `work`, matching the member-DM default that dual-writes to own-private and
  general; a separate uncertainty label would add nondeterminism without
  changing a destination.
  Unknown fields, missing coverage, overlap, empty parts, invalid
  categories, malformed output, timeout, or process failure are operational
  errors that select no destination. The reviewed gate retries a closed set of
  eligible errors exactly once, only after confirmed process cleanup where a
  process is involved; it projects only the terminal result and emits one
  destination-free queue-request intent if the retry exhausts. This gate
  receipt is not a durable production queue; U15/U16 own that implementation.
- **Closed result schema:** stdout is exactly
  `{category, parts}` with no additional fields. `category` is the enum above;
  every part is exactly `{kind, text}`, where `kind` is `work` or `sensitive`
  and `text` is non-empty. For `work` and `personal`, the model supplies the
  category/kind only and the publisher retains the original sanitized source
  fact rather than model-rewritten text. `mixed` has exactly one of each as
  exact, non-overlapping source spans; the only permitted uncovered interior
  connector is the closed corpus delimiter `because` or `after`. The router
  returns no destination, scope, principal, confidence, identity, or
  secret value; the publisher derives all of those.
- **Corpus and repetitions:** Pre-register 26 extracted facts: 8 ordinary work,
  8 narrow-blacklist personal (including explicit-private instructions),
  4 mixed, 2 uncertain-but-non-private work, 2 key/value or known-shape secret
  cases, and 2 prose-form credential cases. Run five
  repetitions through the one fixed Claude-CLI/Haiku router for both source
  backend policies (130 route cases), plus four injected fault classes at five
  repetitions through the same routing boundary (20 operational cases).
  Include exact runtime, observed model, and first-party subscription-auth
  evidence in the findings, plus the Codex no-tool-disable rejection evidence.
  U24 tests routing/auth/schema behavior only;
  physical publication identity and idempotency belong to U16.
- **Verification:** The bounded zero-leak gate must pass with zero
  private-to-general leaks on the fixture, 100% valid coverage and
  non-overlapping parts for accepted cases, 100% deterministic veto of
  explicit-private/obvious-blacklist categories, 100% suspected/unresolved
  secret quarantine, 100% uncertain-but-non-private work/general dual-write,
  and 100% terminal operational errors represented by a destination-free
  queue-request intent in the gate receipt. This is not a durable queue. Any
  unresolved process/auth boundary,
  model identity, or commercial-key ambiguity fails U24 and leaves memory
  feature enablement blocked; do not call an existing subscription invocation
  production-safe. Residual semantic-miss risk remains an explicit sync
  decision even after the gate passes: no finite fixture proves perfect
  classification of arbitrary prose.

### U25. Durable SQLite/FTS secret boundary

- **Implementation status (2026-08-18; shipped):** The reviewed implementation
  landed as `27c8394` (`feat: enforce durable secret boundary`), is contained in
  `main`, and shipped in Polygram 0.38.9. The final pre-merge verification ran
  4,250 tests: 4,235 passed, 0 failed, and 15 were intentionally skipped;
  independent correctness, security/lifecycle, and testing/operability reviews
  reported no remaining must-fixes. U25 is complete. U26 remains a separate
  pre-canary historical-cleanup and verification gate.
- **Goal:** Inventory and protect every durable Polygram text sink reachable
  from inbound/provider content, while preserving the original live turn.
- **Requirements:** R13-R16, R68.
- **Dependencies:** U13; independent of routing.
- **Files:** `lib/secret-detect.js`, `lib/db.js`,
  `lib/handlers/record-inbound.js`, `lib/handlers/voice.js`,
  `lib/sdk/callbacks.js`, migrations only if audit/schema changes are required,
  and the relevant DB/handler/secret tests.
- **Pre-implementation inventory:** Enumerate every sink reachable from
  inbound/provider text before implementation: `recordInbound`, all
  `insert`/`upsert` paths, outbound-pending and final outbound updates,
  `db.setMessageText`, `attachments.transcription` from voice handling,
  external-content FTS and triggers, and raw event/detail telemetry including
  parse-error payloads. Search for additional durable text sinks and add them
  to the inventory rather than claiming full coverage prematurely.
- **Approach:** Sanitize known-shape secrets before each SQL write, including
  FTS-producing writes, and mask actual or unresolved key/value credentials
  while preserving only a small deterministic allowlist such as
  `password: required`. Reject the corresponding fact from memory. Use an
  allowlisted content-free telemetry schema; no raw inbound/provider content,
  secret-derived correlation, or transcript payload may enter event detail.
  Prefer eliminating secret-derived correlation metadata. If correlation is
  demonstrably required, use a versioned keyed HMAC held outside provider
  children with explicit access/retention and migrate or remove existing
  unsalted SHA-256 hashes. Sweep and agent-reported redaction remain later
  defense-in-depth, not the primary boundary.
- **Test scenarios:** Pair `password: hunter2` (masked before every durable
  sink and rejected from memory) with `password: required` (stored intact and
  not rejected), and add prose-form credential plus known-shape credential
  fixtures. Any suspected/unresolved result is quarantined. Cover inbound
  record, every insert/upsert/outbound/final text update, `setMessageText`,
  voice transcription JSON, raw event/detail telemetry, and FTS. Assert the
  live input remains original, durable rows and indexes contain no raw secret,
  telemetry matches the allowlist, arbitrary prose without a detectable signal
  is not presented as universally recognizable, and existing sweep/redaction
  tests still prove cleanup behavior.
- **Verification:** The inventory is complete or explicitly records unresolved
  sinks as a pre-implementation blocker; each inventoried sink has a test;
  known-shape raw credentials cannot reach SQLite, FTS, attachments, events,
  or memory journals/indexes.

### U27. Detached native-capture handoff gate (blocker)

- **Goal:** Prove the real native hook can complete the detached staging
  handoff without treating U21's binding-only evidence as end-to-end capture.
- **Requirements:** R16, R59-R63, R68.
- **Dependencies:** U21, U23.
- **Approach:** In a disposable, credential-safe environment, exercise both a
  Claude-CLI and Codex source turn through the actual stop-hook/worker path.
  Verify the bounded state machine specified in U16: private incomplete temp,
  atomic immutable completion envelope, publisher claim, one terminal marker,
  startup recovery, and late-writer-after-reject refusal. Capture no
  contentful telemetry and delete artifacts on every terminal path.
- **Verification:** The gate passes only with real memsearch capture evidence
  for both source backends and all state transitions; otherwise U27 fails and
  implementation/canary work remains blocked.

### U15. Polygram binding, session identity, and receipt delivery

- **Goal:** Bind memory authorization, staging, and per-turn receipts to both
  provider namespaces.
- **Requirements:** R1-R5, R17-R18a, R44, R60-R63, R66-R67.
- **Dependencies:** U23, U24, U16a.
- **Files:** `lib/runtime-config.js`, `lib/config.js`, `lib/memory/binding.js`,
  `lib/db/sessions.js`, session lifecycle callers, `lib/codex/runtime-profile.js`,
  `migrations/` next available schema version, and focused tests.
- **Approach:** Parse the root-owned projection, implement pure role/operation/
  sender/audience policy, add the memory/tool digest to Claude and Codex session
  identity, and persist only the external receipt reference. Build the wrapper
  and its receipt semantics **here**, on the trust, descriptor and artifact
  plumbing U23 proves — U23 builds no receipt mint/lookup path, so U15 must not
  be written as though one exists; U27 owns end-to-end handoff. Receipt minting
  is per turn, outside the provider, and best-effort, and must not assume the
  `turn-accepted` checkpoint is durably readable when `UserPromptSubmit` fires
  (S0 measured that race as live); fail closed with a content-free counter.
  The wrapper and every transitive input it executes, including `stop.sh`, must
  live inside the R18a artifact boundary U23 specifies. Retire sessions and
  queued work on binding/audience/tool drift. Do not let ordinary chat
  configuration enable or widen memory.
- **Test scenarios:** For MVP, run the member-DM, unmapped, and unauthorized
  rows and every allowed/forbidden read, write, tool, and staging cell in
  `tests/fixtures/scoped-memory-role-context-matrix.v1.json`, plus audience
  change, stale receipt, replayed receipt, cross-row receipt, model/effort-only
  change, binding/tool digest change, and a turn that completes before receipt
  arrival. Full team/partner rows are U20. All MVP cases produce the specified
  fail-closed behavior.
- **Verification:** Both provider session identities and the policy projection
  agree; stale/replayed receipts cannot publish; reply delivery is unaffected
  by missing capture receipts.

### U16. Staging, publisher, registry, and legacy isolation

- **Goal:** Implement the trusted memory boundary and publication projection.
- **Requirements:** R6-R8, R11-R18a, R60-R69; R9-R10 positive group/partner
  publication is U20.
- **Dependencies:** U15, U24, U25, U16a, U27.
- **Files:** memory publisher/staging implementation, `umi-vps-infra`
  registry/projections, storage/runbook/spec files, and publication/atomicity/
  isolation tests including existing `tests/scoped-memory-*` coverage.
- **Approach:** Implement the detached handoff state machine: a private
  incomplete temp entry is written with owner, receipt, policy epoch, size and
  expiry; every producer/detached worker carries and enforces a receipt
  deadline no later than the 15-minute staging lifetime. Completion atomically
  renames it to an immutable envelope; the publisher claims it; publication
  ends in one terminal published/rejected marker. A receipt tombstone remains
  for 24 hours, so a late writer or an expired receipt still refuses writes;
  cleanup after that retention window is also tested. Startup recovery reclaims
  abandoned claims and deletes expired incomplete entries. A late writer after
  reject is refused by the terminal marker and cannot recreate the envelope.
  Bound each entry to 256 KiB, 128 extracted parts, 1,024 entries per binding,
  and a 15-minute TTL; reject oversize/count overflow. Staging is owner-only,
  non-recallable, excluded from backups/logs/telemetry, and never provider-
  child writable outside the hook wrapper.
  Re-sanitize/reject before journals/indexes, then run U24 routing for
  member-DM facts. Persist exactly one accepted routing result under
  `(receipt, source_fact_id, policy_epoch)` before fanout; retries reuse it and
  never reroute, while a lost response or divergent late result is quarantined.
  Assign `source_fact_id` and deterministic `part_id` before fanout. Use one
  durable outbox/destination ledger for every fanout role, with captured policy
  epoch, destination state, retry count, and visible partial state; retry
  missing destinations only. Before zero commits, an epoch change rejects the
  item. After a partial commit, stop all new writes, mark terminal
  `partial-policy-change`, expose written destinations for compensating removal
  or operator repair, and never complete under a new epoch. Publish only the
  MVP member-DM work/personal/mixed/semantic-uncertain behavior here; positive team-group and
  partner-group publication is U20.
- **Test scenarios:** incomplete/complete atomicity, publisher claim,
  published/rejected terminal markers, startup recovery, receipt deadline,
  expired receipt, late writer after reject, late write after directory/tombstone
  cleanup, size/count/TTL bounds, staged secret, publisher re-sanitization,
  semantic/operational routing distinction, explicit-private and every obvious
  blacklist veto, member work/personal/mixed/semantic-uncertain destinations,
  unmapped/unauthorized denial, source/part identity, destination-aware retry de-duplication, lost
  response, divergent rerun quarantine, partial ledger repair, member policy
  change after first commit, projection mismatch, storage denial,
  directory-configured record redaction, and absence from backup/log/telemetry.
  Full-parity partner policy-change and partial-write tests are U20.
- **Verification:** No staging entry is recallable; no secret reaches journal
  or index; the MVP member policy and denial cases are exact; accepted routing
  is persisted once and never rerouted; exact copies share one `part_id` while
  distinct parts never merge; missing destinations retry without duplicating
  successes; epoch changes follow the terminal rule; the ledger schema is
  ready for U20 fanout without positively enabling those roles; unauthorized
  provider children cannot widen scope or alter publisher inputs.

### U14. Generic scoped recall transport (mandatory)

- **Goal:** Provide the only model-facing recall path for Claude CLI and Codex.
- **Requirements:** R40-R48, R65.
- **Dependencies:** U21 evidence and U23's exact reviewed Orchestra
  release/consumer pin; it does not depend on spent U13 dynamic-tools
  evidence.
- **Files:** reviewed Orchestra transport surfaces, `lib/process/`,
  `lib/codex/`, `lib/memory/provider-client.js`, and focused protocol tests.
- **Approach:** The exact Codex generic-recall mechanism is unresolved. U14
  owns a bounded transport-decision spike, selects and proves the mechanism,
  identifies its owning repository, owns the generic-recall Orchestra release
  boundary, and consumes that reviewed release through the exact Polygram pin;
  U23 remains the separate hook-notification release prerequisite. U14 also
  supplies the protocol self-consistency evidence. It then carries one
  text-only `recall` operation with client-owned deadline, cancellation,
  resume/stale-call handling, bounded result shape, immutable binding metadata,
  and per-turn circuit breaker. No write semantics, scope arguments,
  collection/path arguments, or plugin-native skills.
- **Test scenarios:** malformed/oversized/extra-field calls, scope-name
  injection, timeout, cancellation without optional server resolution,
  resumed-thread tool call, stale binding, five-result/12-KiB caps, duplicate
  `part_id` merge without distinct-part merge, and no-tool backward
  compatibility. One model-visible Claude-CLI and Codex turn must prove the
  released mechanism before U17/U19.
- **Verification:** The exact reviewed Orchestra release is consumed before
  production use; the one-turn Claude/Codex model-visible proof exists; the
  selected mechanism and owning repo are recorded; and memory outage cannot
  fail Telegram reply delivery. U14 remains an outstanding blocker until all
  four pieces pass: mechanism decision/spike, Orchestra release, Polygram
  pin/consumption, and Claude-CLI/Codex proof.

### U17. Recall client and released consumption

- **Goal:** Wire U14 to Polygram's per-turn binding and both MVP providers.
- **Requirements:** R40-R48, R44, R46-R47.
- **Dependencies:** U14, U15, U16.
- **Files:** `lib/memory/provider-client.js`, `lib/memory/tools.js`, provider
  registration/lifecycle callers, integration tests.
- **Approach:** Register generic recall only for authorized bindings, revalidate
  before injection, merge exact-copy `part_id` values without merging distinct
  parts, and return local unavailable
  results without retry loops. Consume released Orchestra, never a checkout,
  and require the exact pin/protocol self-consistency gate.
- **Test scenarios:** member two-scope recall, unmapped/unauthorized denial,
  provider switch, stale call, malformed response, timeout, duplicate copies,
  and memory-disabled session. Full group/partner matrix assertions are U20.
- **Verification:** Claude CLI and Codex expose identical bounded recall and
  no model-controlled scope/path selector.

### U18. Shared skill and global legacy cutover

- **Goal:** Remove unscoped writers/injectors only after replacement is dark and
  its extraction baseline is captured.
- **Requirements:** R1, R17, R43, R70-R71.
- **Dependencies:** U16, U17.
- **Files:** shared provider-neutral skill/config in `shumabit-claude`, Polygram
  session-context gate, legacy corpus relocation/runbook.
- **Approach:** Capture the old writer's baseline before disabling it. Then
  disable old unscoped Stop/recall hooks, `MEMORY.md`/daily injection,
  `chat-session.sh`, and Polygram `sessions/**` loading for memory-enabled
  bindings. Do not roll back by silently restoring the old writer.
- **Test scenarios:** baseline exists before cutover; old writer cannot write;
  reappearing `sessions/<key>.md` is not injected; relocated legacy data is
  Ivan-private read-only and receives no new writes.
- **Verification:** No unscoped path can write or inject shared memory; rollback
  leaves a deliberate no-memory interval rather than reopening the hole.

### U26. Historical durable-sink cleanup gate (pre-canary)

- **Goal:** Remove or mask pre-existing raw secrets from every inventoried
  durable sink before any canary, including FTS.
- **Requirements:** R13-R16 and the U25 inventory.
- **Dependencies:** U18, U25.
- **Approach:** Take a bounded full inventory of each in-scope SQLite text
  sink, attachment transcription, raw event/detail field, and FTS projection;
  sanitize under the approved boundary; rebuild and verify FTS; and fail
  closed if any scope is skipped, scan is partial, or residual raw secret is
  found. Migrate existing unsalted secret hashes to removal, or to the
  versioned keyed-HMAC scheme only if U25 proves correlation necessary. Record
  operator/calendar work separately from engineer-days; the
  `umi-vps-infra`/VPS operator schedules the maintenance window and attests
  owner, busy, backup, and cleanup state.
- **Verification:** The bounded inventory has complete coverage, sanitized
  counts reconcile, FTS rebuild/query verification passes, and a partial scan
  cannot be marked successful. No canary starts before this gate.

### U19. Ivan DM MVP canary

- **Goal:** Prove the narrow MVP in real Claude CLI/Codex runtime.
- **Requirements:** MVP subset R1-R8, R11-R18, R40-R48, R59-R69, AE1-AE2,
  AE4-AE10, plus the member-DM, unmapped, and unauthorized rows of the
  versioned role/context matrix. Positive team-group and partner-group
  publication is U20; the complete matrix remains the full contract.
- **Dependencies:** U14, U16, U17, U18, U26, U16a, U27.
- **Files:** rollout evidence and real-runtime gate artifacts.
- **Approach:** Enable Ivan's DM only. Pre-register 60 turns: 12 work, 8
  personal, 8 mixed, 4 semantic-uncertain, 4 secrets, 8 injected operational
  faults, and 16 provider-switch/negative-control turns. The 32 typed fact
  turns yield 32 accepted source facts (12 work + 8 personal + 8 mixed + 4
  uncertain), 40 routed parts (mixed contributes two), and 64 physical
  destination writes (work 24 + personal 8 + mixed 24 + uncertain 8). The
  4 secret, 8 fault, and 16 control turns are not accepted facts unless a
  fixture explicitly says so. Record 8 routing retries, 4 secret detections,
  and zero memory-attributable reply failures. Run a 24-hour dark test and
  then a 48-hour enabled soak with at least 100 additional turns;
  operator/calendar waits are not engineer-days.
- **Test scenarios:** Member-DM work/personal/mixed/semantic-uncertain rows,
  with semantic uncertainty writing to both own-private and general, plus unmapped and
  unauthorized denial cells in `scoped-memory-role-context-matrix.v1.json`;
  zero private-to-general leaks; no secret memory records; exact `part_id`
  recall de-duplication; missing-destination retry only; no chat failure from
  memory; and no unauthorized recall/capture. Team-group and partner-group
  positive publication is not a canary assertion and remains U20.
- **Verification:** Compare a paired frozen baseline on the same 24 useful
  turns: coverage no worse than baseline by 2 percentage points, unsupported
  claims no more than baseline plus 1 point, and no category below baseline by
  5 points. Disable immediately on any privacy leak, raw-secret residual,
  matrix violation, or memory-attributable reply failure; disable if an
  operational fault is not queued/retried as specified. Ivan accepts the
  usefulness comparison; otherwise the canary remains off.

### U20. Full parity and staged broader rollout

- **Goal:** Add the explicitly out-of-MVP contexts without changing policy.
- **Requirements:** R5, R9-R12, R45, R72.
- **Dependencies:** U19.
- **Files:** Claude SDK transport, group audience controls, partner routing,
  backup/restore/runbook/infrastructure artifacts, and their tests.
- **Approach:** Execute sequential enablement: (1) Claude SDK parity for 20
  member-DM facts and a 24-hour dark test; (2) UMI team groups for 20 accepted
  general facts and a 24-hour soak; (3) partner groups for 20 accepted
  non-secret facts, 40 expected destination writes, and a forced first-
  destination partial failure; (4) one additional member/audience for 10
  facts and a 24-hour soak; (5) two backup/restore isolation drills; then
  (6) a 48-hour rollout/ops soak with the complete matrix. Calendar soak time
  is excluded from engineer-days. Partner partial publication stops further
  partner enablement, marks the terminal partial state, and repairs/removes
  already-written destinations before resuming.
- **Sub-estimate audit:** SDK parity **1/2/3**, team group **1/2/3**, partner
  dual-write **2/3/5**, additional member/audience **1/1.5/2**,
  backup/restore **0.5/1/1**, and rollout/ops **0.5/0.5/1**; these sum to
  **6/10/15** engineer-days.
- **Test scenarios:** Every row in the complete versioned role/context matrix,
  group membership changes, partner cannot read general, every partner fact
  has both copies, repair of one missing destination does not duplicate the
  successful destination, SDK parity, restore isolation, and policy change
  after the partner's first commit.
- **Verification:** Enable stages only after the preceding fixture and exact
  denominator pass. Any privacy leak, recognized/raw secret residual, matrix
  violation, or memory-attributable reply failure is zero-tolerance and
  disables the stage; partner partial-write stop/repair is also mandatory.
  No full-parity feature widens the settled policy.

---

## Estimates and critical path

All estimates are engineer-days and are counted once. Spent evidence units are
shown as zero and excluded from remaining-work totals.

| Unit | Best | Likely | Worst | State |
| --- | ---: | ---: | ---: | --- |
| U13 | 0 | 0 | 0 | spent |
| U21 | 0 | 0 | 0 | evidence complete; U23 prerequisite remains |
| U22 | 0 | 0 | 0 | rejected; no retune |
| U16a-A | 1 | 2 | 3 | blocker: host/provider and model staging |
| U16a-B | 1 | 2 | 3 | blocker: process-writer correction |
| U16a-C | 1 | 2 | 4 | blocker: cross-process storage check |
| U16a-D | 1 | 2 | 4 | blocker: five-run Linux gate |
| U23 | 10 | 14 | 24 | blocker; **remaining** effort (elapsed `T23` = 8/11/19); spent S0 + spec reviews are **unmetered** and excluded |
| U24 | 3 | 5 | 8 | blocker |
| U25 | 0 | 0 | 0 | spent; merged and shipped in Polygram 0.38.9 |
| U27 | 1 | 2 | 4 | blocker |
| U15 | 4 | 6 | 10 | remaining; raised from 3/5/8 — U15 now builds, installs and proves the deterministic closure of the real wrapper plus `stop.sh` inside U23's protected tree |
| U16 | 8 | 13 | 20 | remaining; ledger and publisher |
| U14 | 4 | 7 | 12 | blocker: mechanism/release/pin/proof |
| U17 | 1 | 2 | 3 | remaining |
| U18 | 1 | 2 | 3 | remaining |
| U26 | 1 | 2 | 4 | pre-canary; operator wait separate |
| U19 | 2 | 3 | 4 | MVP canary |
| U20 | 6 | 10 | 15 | full parity |

- **U16a total work:** A+B+C+D = **4 / 8 / 14**; its elapsed recurrence is
  `max(A,B)+C+D = 3 / 6 / 11`.
- **MVP engineering total:** U16a + U23 + U24 + U25 + U27 + U15 + U16 +
  U14 + U17 + U18 + U26 + U19 = **39 / 64 / 106** engineer-days **remaining**
  (before recording U25 as spent: 42 / 69 / 114), plus registered
  dark/soak and operator/calendar waits.
- **Full parity total:** MVP + U20 = **45 / 74 / 121** remaining (before
  recording U25 as spent: 48 / 79 / 129), plus staged soaks and
  operator/calendar waits.
- **U23 re-derivation (not a delta).** U23 was re-estimated after its second
  spec review added an Orchestra verifier API with preflight/profile/factory/
  process plumbing, a per-`CODEX_HOME` provisioning state machine with crash
  recovery and direction-from-configuration, a locked rollback/admission
  procedure, cross-target gates, and — the largest addition — a **required
  production artifact-body boundary** delivered as a deterministic self-contained
  hook bundle with a generated digest manifest inside a root-owned immutable
  versioned tree. Components: Orchestra API/tests/release `O` = 2 / 3 / 5;
  Polygram renderer/state machine/attestation `P` = 3 / 4 / 7; U23 bundle +
  protected installer/manifest/version retention/runbook `H` = 2 / 3 / 5;
  landing the S0 harness + both-target gates/receipts/rollback `G` = 2 / 3 / 5;
  implementation code review and fold `R` = 1 / 1 / 2 → **10 / 14 / 24
  remaining effort**. Elapsed is smaller because `H` overlaps `O`+`P`:
  `T23 = max(O+P, H, W_host) + R + G` = **8 / 11 / 19** at `W_host` = 0.
  `W_host` is an unquantified operator/calendar wait for root-owned installation
  on the Mac and the VPS — registered, not converted to engineer-days. The
  earlier 2 / 4 / 6 predates all of this and is not carried forward.
- **Critical path uses remaining elapsed only**, since spent work adds no
  elapsed time: `T19` = **28 / 44 / 71** (was 20 / 34 / 53) and `T20` =
  **34 / 54 / 86** (was 26 / 44 / 68), using `T23` = 8 / 11 / 19 and
  U15 = 4 / 6 / 10.
- **Spent:** U13, U21, U22, and U25 contribute zero to all totals. U23's S0
  characterization and its two spec-review rounds are likewise spent — and
  **were not time-tracked**, so they are **unmetered**: excluded from remaining,
  carrying no actual best/likely/worst, and **not summed into any published
  "from zero" total**. A historical pre-S0 planning envelope of 2 / 3 / 4 exists
  for U23's characterization but is a forecast never reconciled against
  actuals, and is labelled as such wherever it appears.

The dependency graph is:

```text
U13 ───────────────→ U25 ───────────────→ U26 ───────┐
                                                     ├→ U19 → U20
U21 → U23 → U24 ───────┐                              │
                       ├→ U15 ────────────┐           │
U21/U23 → U27 ─────────┘                  ├→ U16 → U17 → U18 ─┘
U13 → U16a(A/B→C→D) ──────────────────────┘
U23 → U14 (parallel; exact release prerequisite)
```

For transparent topological recurrence, let `T(x)` be elapsed engineering
days and let `A/B/C/D` be U16a's four pieces:

```text
T16a = max(A,B) + C + D
T23  = max(O + P, H, W_host) + R + G     (U23 internals; W_host = registered wait)
T24  = T23 + U24
T14  = T23 + U14
T27  = T23 + U27
T25  = U25
T15  = max(T23, T24, T16a) + U15
T16  = max(T15, T25, T27, T24) + U16
T17  = max(T14, T16) + U17
T18  = max(T16, T17) + U18
T26  = max(T25, T18) + U26
T19  = max(T18, T26, T16a, T27, T17) + U19
T20  = T19 + U20
```

Evaluated independently on **remaining** work, the critical path to the MVP
canary is `T19` = **28 / 44 / 71** elapsed engineer-days; full parity is `T20` =
**34 / 54 / 86** (both raised by U23's re-derivation and U15's rise to
4 / 6 / 10; they read 20 / 34 / 53 and 26 / 44 / 68 at U23 = 1 / 2 / 3).
`T23` = `max(O+P, H, W_host) + R + G` = 8 / 11 / 19 at `W_host` = 0, so U23's
elapsed contribution is smaller than its 10 / 14 / 24 of effort; `W_host`, the
root-owned installation wait on both hosts, is registered separately and is not
counted as engineer-days. U23's spent S0 and spec reviews are unmetered and
excluded from elapsed time. U25 can start from U13 in parallel. U14 starts only after the exact
reviewed Orchestra release/consumer pin prerequisite, and U17/U19 cannot
start from the checked-in dynamic-tools finding alone. The Orchestra
release owner owns schema review, release, and its artifact; the Polygram
consumer owner owns dependency pin, config digest, and consumption proof, with
no duplicate estimate. No estimate assumes a managed-provider alternative.

---

## Verification Contract

### Automated repository verification

- `npm test` remains the baseline unit/integration layer.
- U25 first produces the complete durable-text-sink inventory, then tests
  pre-insertion sanitization at `recordInbound`, every generic
  `insert`/`upsert`, outbound pending/final text paths, `setMessageText`, voice
  transcription, raw event/detail telemetry, SQLite audit behavior, and FTS
  absence of known-shape raw secrets. Existing
  `tests/secret-detect.test.js`, `tests/secret-sweep.test.js`,
  `tests/redact-secret-in-chat.test.js`, `tests/db.test.js`, and
  `tests/handlers-record-inbound.test.js` remain in scope.
- Binding/session tests cover all roles, audience changes, receipt tamper/replay,
  policy/tool digest drift, and no-memory behavior.
- U14/U17 tests cover the released generic-recall mechanism, one model-visible
  Claude-CLI/Codex proof, malformed protocol input, deadlines, cancellation,
  resumed calls, stale calls, caps, `part_id` de-duplication, and reply-health
  isolation.
- Publisher tests cover the detached staging state machine and bounds, secret
  re-rejection, routing queue behavior, mixed splitting, policy TOCTOU,
  destination ledger partial/retry behavior, source/part identity, and
  content-free telemetry. No source-derived plain hash remains unless the
  versioned HMAC exception is justified and migrated.

### Pre-registered and real-runtime gates

- U23: credential-free hook-enabled Codex turn under the released Orchestra
  pin, with trusted hook hashes rendered in owned config and exact absolute
  binary path; `turn/started.id` equals hook `turn_id`; and every executed hook
  input sits inside the R18a artifact boundary. **Both targets are U23
  completion criteria** — `aarch64-apple-darwin` and
  `x86_64-unknown-linux-musl`, same checked-in gate command with per-target
  runtime/artifact-root/receipt. S0's characterization passed on Darwin only;
  **no released-production gate has run on either target**, and the Linux
  runtime receipt is unmeasured.
- U24: one fixed-router evaluation across Claude-CLI and Codex source turns,
  stdin-only facts, schema-only stdout, exact runtime/model/auth/process
  evidence, no commercial API key, zero private-to-general leaks on the
  fixture, mixed split, secret rejection, and malformed/timeout/retry queue
  behavior. The corrected shape gate passed. The single full run retained zero
  privacy/model-identity/projection failures but stopped on two exhausted
  confirmed-cleanup timeouts and exceeded the natural-retry budget, so this
  gate remains open and must not be rerun unchanged.
- U16a: host/provider confirmation and model staging, process-writer overlap,
  same-scope cross-process storage, then five production-class Linux runs with
  owner/busy/cleanup attestations. The existing same-process 5/5 failure and
  `proc-writer` diagnosis are not gates.
- U27: real detached native capture and every staging terminal/recovery state
  for both Claude-CLI and Codex; U26: complete historical inventory,
  sanitization, FTS rebuild/verification, and fail-closed partial scan.
- U16/U19: exact pinned Claude CLI and Codex versions, provider switching,
  member-DM work/personal/mixed behavior plus unmapped/unauthorized denial,
  staging non-recallability, legacy cutover, destination-ledger repair, and
  secret absence from every durable sink and memory store. U20 owns the
  complete team/partner role/context matrix and positive rollout assertions.

### Rollout gates

- Memory feature enablement remains blocked until U14's exact released recall
  proof, U23, U24, U25's complete inventory, U26, U27, and U16a pass and no
  launch-blocking auth/provider/storage unknown remains.
- Memory is default-off. Both policy projections and digests must match before
  tools or publisher work are enabled.
- The root-owned artifact/authorization path, staging containment, and exact
  Orchestra/Polygram pin self-consistency gates pass on the real host.
- The old unscoped writer is disabled only after the pre-cutover extraction
  baseline is captured and the replacement is dark-tested.
- Ivan's DM canary meets the pre-registered 60-turn denominator and 24-hour
  dark/48-hour soak measurements, has zero privacy/secret leaks, no
  memory-caused reply failures, no legacy writer activity, and an accepted
  objective usefulness comparison. Disable thresholds are immediate for any
  privacy leak, raw-secret residual, matrix violation, or memory-attributable
  reply failure; operational failures must remain within the registered
  queue/retry denominator.
- Any privacy violation disables memory globally and retires affected sessions;
  rollback never silently restores the unscoped writer.

---

## Definition of Done

- U23's reviewed Orchestra schema/release/pin prerequisite passes; Codex hooks
  no longer fault the pinned app-server, trusted hook hashes are rendered in
  owned config, and the absolute Codex binary pin is preserved.
- U24 proves the narrow separate routing/splitting pass or leaves the plan
  blocked. No same-pass label, broad classifier, deterministic general
  allowlist guarantee, or unverified existing-subscription invocation is
  shipped. Personal sensitivity remains model judgment; zero-leak fixtures are
  a gate, not a mathematical guarantee, so residual semantic
  misclassification risk is documented.
- U16a passes the corrected production Linux/embedding gate; the old
  same-process diagnostic is not presented as closure.
- Recognized deterministic credential/auth cases—including known-shape,
  key/value, and prose-form credential fixtures—are sanitized before every
  inventoried durable sink and FTS insertion, masked when actual or unresolved,
  rejected from memory, and rejected/sanitized again by the publisher before
  journals/indexes. Arbitrary prose with no detectable secret signal is not
  claimed to be universally recognizable. The narrow non-secret allowlist is
  tested in pair with real credential fixtures; sweep and agent-reported
  redaction remain defense-in-depth.
- Staging is owner-only, non-recallable, bounded, TTL-cleaned, deleted after
  terminal publication/rejection, and absent from contentful telemetry.
- MVP member-DM policy is exact: work and semantic-uncertain facts to both
  scopes, personal-sensitive private-only, mixed work consequence to both and
  sensitive detail private, operational failure queued/retried. Team-group and
  partner-group publication remains U20.
- Every source fact has a stable source identity, each routed part has a
  deterministic part identity, and destination-aware ledger state makes exact
  copies idempotent while recall returns one copy per part. The ledger is MVP
  for member-DM two-destination fanout and is reused/extended for U20 roles;
  team/partner publication is not enabled in MVP.
- U14 is the sole recall boundary; no plugin-native recall or model-selected
  scope/path survives cutover.
- The old unscoped writer and cross-session injectors are disabled after the
  baseline; rollback leaves an explicit no-memory interval.
- All required tests and real-runtime gates pass, no abandoned experimental
  code remains, and infrastructure documents the honest transient-staging and
  provider-isolation limits.

### Outstanding blocking gates

1. U14 — transport-decision spike, exact mechanism, Orchestra release,
   Polygram pin/consumption, and Claude-CLI/Codex proof.
2. U23 — reviewed Orchestra hook-notification schema/release/pin prerequisite.
3. U24 — bounded routing/auth/schema and zero-leak gate.
4. U25 — complete durable text-sink inventory and boundary.
5. U26 — pre-canary historical cleanup, FTS rebuild/verification, and
   fail-closed scan.
6. U27 — detached native-capture handoff gate.
7. U16a — corrected Linux/production-embedding G1 gate.

No product-policy decision is reopened in this revision. The settled policy
and rejection of U22 are recorded; the residual semantic-miss risk is the
explicit sync item and remains gated by U24's bounded zero-leak evidence.

---

## Sources and research

- `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md` — native
  capture pass, plugin-native recall rejection, Codex hook trust and receipt
  correlation, Orchestra 0.10.14 fault.
- `docs/2026-08-11-u22-destination-label-findings.md` — same-pass label fail:
  10 disclosure-directed private-to-general leaks; extraction parity pass.
- `docs/2026-08-11-u16a-memsearch-latency-findings.md` — unchanged G1 fail 5/5,
  process-split diagnosis, corrected gate, and unresolved host/provider.
- `migrations/014-secret-redactions.sql` — audit/high-water schema only; no
  pre-insert sanitation.
- `lib/secret-detect.js` — current high/medium auto-redaction and low-tier flag
  behavior.
- `lib/db/secret-sweep.js` — later background defense-in-depth sweep.
- `lib/handlers/record-inbound.js` — current raw-text inbound insertion path.
- `lib/handlers/voice.js` and `lib/sdk/callbacks.js` — durable transcription
  and raw parse-error/detail telemetry paths that must be included in U25's
  inventory.
- `lib/db.js`, `migrations/001-initial.sql`, `migrations/002-fix-fts-triggers.sql`
  — insert/update/FTS behavior and agent-reported redaction path.
- `tests/secret-detect.test.js`, `tests/secret-sweep.test.js`,
  `tests/redact-secret-in-chat.test.js`, `tests/db.test.js`, and
  `tests/handlers-record-inbound.test.js` — current behavior that U25 must
  preserve or intentionally extend.

No production/VPS/Telegram state was contacted by this revision. No
application code, configuration, migration, commit, push, deploy, or restart
was performed.
