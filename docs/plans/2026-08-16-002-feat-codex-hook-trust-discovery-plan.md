---
title: Codex Hook Trust Discovery and U23 Consumption - Amendment Plan
type: feat
date: 2026-08-16
revised: 2026-08-17
topic: codex-hook-trust-discovery
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: parent-plan-u23
execution: code
status:
  s0_characterization: complete-continue-2026-08-17-darwin-only
  spec_reviews: two-complete
  decisions:
    - id: D-Q1
      question: fold the hook verifier into 0.10.18 or ship it in 0.10.19
      decision: fold into 0.10.18; a release carrying only PR #52 is not consumable
      date: 2026-08-17
    - id: D-Q2
      question: is the Orchestra estimate delta acceptable on the critical path
      decision: accepted; U23 re-derived in section 12
      date: 2026-08-17
    - id: D-Q3
      question: accept the artifact-body window or require body binding
      decision: >-
        REQUIRE production artifact-body binding (section 4.10). Root/operator-owned
        immutable versioned artifact tree, service-unwritable ancestor chain,
        versioned command paths, transitive executed inputs attested. Fail closed
        if the boundary cannot be installed. Owner-owned artifacts remain
        acceptable only for disposable characterization fixtures.
      date: 2026-08-17
    - id: D-Q4
      question: the turn-id correlation boundary
      decision: >-
        U23 proves equality and ordering from existing checkpoint evidence only and
        records no duration budget; receipt semantics stay U15's.
      date: 2026-08-17
    - id: D-Q5
      question: is the hooks-enabled rollback an operator runbook step
      decision: >-
        Yes, and it is now a specified admission-closing procedure (section 4.9)
        with tests, not a bare instruction.
      date: 2026-08-17
    - id: D-Q6
      question: Linux enablement inside U23 or deferred
      decision: >-
        Inside U23. Both targets are U23 completion criteria; target-specific
        dependencies are not split.
      date: 2026-08-17
---

# Codex Hook Trust Discovery and U23 Consumption - Amendment Plan

> **Parent plan.** `docs/plans/2026-07-31-002-feat-shumabit-scoped-memory-plan.md`.
> Its **U23** owns the Orchestra hook-notification release prerequisite and
> Polygram's exact consumption of it. This plan amends U23 only, and U23 cannot
> be declared complete by merging this branch alone.
>
> **Where the parent lives, and which copy is authoritative.** The canonical
> parent is in the orchestration worktree, where it carries the orchestration
> owner's own uncommitted edits and **must not receive this amendment**; it is
> byte-identical to the version this plan was written against,
> `sha256:fbae6c2f8c8b731393f6f354d3023b09c7a0990705b2b815c4256e8d1676ab6f`.
> The copy at that path **in this worktree** is that same working-tree version
> plus **only** the S0 status/evidence/estimate/ownership edits listed in
> section 12. Those edits reach the orchestration branch through its owner, not
> from here.
>
> **Supporting evidence.** U21 findings,
> `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md` in the
> orchestration worktree,
> `sha256:5a7e2a91021d7019301c28ab07140c897077fb4702ad6cb2e569e757b03a4307`.
> **S0 findings — reviewed, `CONTINUE`** —
> `docs/2026-08-17-001-u23-hook-trust-characterization-findings.md` in **this**
> worktree.
>
> - **Orchestra source:**
>   `sha256:617691cdfd2647c4160bc90dc70877eb757a0ad2538fa939c2bb641e4e1c7236`.
> - **Local copy, current:**
>   `sha256:8869449d2175db59172b575f856e9f7c85e2d8b2e69347fd57f0007940bcb431`.
>   It carried `sha256:3e2756930430cf61c36bce1337635d829c39b9871a1696766553782493f98d25`
>   before this revision corrected its provenance banner; the body is untouched.
> - **Verified relationship:** stripping the banner block from the local copy
>   reproduces the Orchestra source digest byte-for-byte. That is the check to
>   re-run if the copy is ever suspected of drift.

## 1. Goal capsule

- **Objective.** Make a hook-enabled Codex turn survivable *and verifiable*
  under an exact released Orchestra pin, on a boundary where every executed
  input is service-unwritable, so U15/U16 can be built on proven plumbing
  instead of an asserted one.
- **The amendment.** U23 as written assumes Polygram can render trusted hook
  hashes into its owned Codex config. It cannot: the value it must render is
  only obtainable from an app-server method Orchestra's pinned client does not
  allow, and no allowed surface reports hook trust status. This plan adds the
  smallest surface that closes that gap — one internal, manifest-bound verifier
  — plus the artifact boundary that makes a rendered hash mean something.
- **What U23 proves.** Trust plumbing, descriptor plumbing, artifact plumbing.
  Nothing about capture, staging, receipts, routing, publication, or recall.

## 2. Problem

Codex 0.145.0 hooks are **untrusted by default** and do not execute until a
content-addressed trust stanza is persisted in `config.toml` (U21 VF4):

```toml
[hooks.state."<CODEX_HOME>/hooks.json:user_prompt_submit:0:0"]
enabled = true
trusted_hash = "sha256:<currentHash of that hook entry>"
```

`currentHash` is computed by Codex over the hook's own content. Its algorithm is
undocumented and not reproducible outside the binary. It is reported by the
app-server method `hooks/list`, and by nothing else.

Three doors are shut:

1. **`hooks/list` is not in Orchestra's pinned request allowlist** (`account/read`,
   `config/read`, `configRequirements/read`, `initialize`, `model/list`,
   `permissionProfile/list`, `thread/backgroundTerminals/list`,
   `thread/backgroundTerminals/clean`, `thread/start`, `thread/resume`,
   `turn/start`, `turn/steer`, `turn/interrupt`). Anything else is rejected
   before it reaches the wire.
2. **`config/read` cannot substitute.** `projectEffectiveConfig` emits a fixed
   key set and drops `config.hooks` entirely.
3. **No runtime trust-granting path exists.** `config/batchWrite` is not in the
   allowlist, and `--dangerously-bypass-hook-trust` does not exist on
   `codex app-server` (U21 VF4).

And a fourth door, which S0 opened and this revision closes: **a trusted hash
binds the hook's command string, which names a path — never the bytes at that
path.** Without an ownership boundary under those paths, the trust stanza
certifies nothing about what actually executes.

## 3. Evidence

### 3.1 Verified before S0

- **V1. The hook-notification fix is merged and unreleased.** Orchestra
  `origin/main` = `3b0587a` (#52), merged 2026-08-16T10:48Z; npm
  `@shumkov/orchestra@0.10.17` was published 2026-08-16T09:32Z, 76 minutes
  earlier, and its tarball contains no `hook/started` / `hook/completed`.
- **V2. A 0.10.18 bump is staged but uncommitted** on `release/0.10.18`.
- **V3. Curating the allowlist does not move the Codex protocol pin.**
  `generatedProtocolV2CanonicalSha256` is unchanged at `1bc09ded…0938efb`;
  `protocol-schema.json` is explicitly a "curated positive production subset".
- **V4. `hooks/list` is real** and returns
  `{data: [{cwd, errors, warnings, hooks: [HookMetadata]}]}`. Read-only,
  `stateChanging: false`. **[schema]** `HooksListParams` declares one optional
  property, `cwds: string[]`; `HooksListResponse` declares only `data`.
- **V5. `HookMetadata` (S0-corrected).** **Required — eleven:** `currentHash`,
  `displayOrder`, `enabled`, `eventName`, `handlerType`, `isManaged`, `key`,
  `source`, `sourcePath`, `timeoutSec`, `trustStatus`. **Optional/nullable —
  five:** `additionalContextLimit`, **`command`**, `matcher`, `pluginId`,
  `statusMessage`. `command` is optional, not required; there is no `prompt`
  field. `trustStatus` ∈ `{managed, untrusted, trusted, modified}`.
- **V5a. Observed U23 fixture shape**, identical on all three hooks in both
  inventories: `handlerType: command`, `source: user`, `isManaged: false`,
  `timeoutSec: 600`, `displayOrder` 0/1/2 in manifest order, `sourcePath` equal
  to the manifest path, zero unknown fields, **all five optional keys present**,
  **only `command` non-null**.
- **V5b. `enabled` is not a run predicate.** S0 observed `enabled: true` while
  `trustStatus` was `untrusted` — a state in which the hook does not run.
- **V6. `command`, `sourcePath`, `key`, `statusMessage` carry sensitive free
  text.**
- **V7. Hook trust is content-addressed**, so the hook set and the owned config
  are version-coupled: editing `hooks.json` flips every entry to `modified`.
- **V8. Writing the trust stanza changes the pinned config digest** (U21 VF8,
  S0-confirmed).
- **V9. Polygram's owned config is byte-exact and self-defending**
  (`lib/codex/runtime-profile.js:583-609`), and never migrates or overwrites.
- **V10. The owned-config digest is compared against Codex's own parse**
  (`validateProjectedLayers:729-733`).
- **V11. `hooks.json` is unattested by Orchestra**
  (`attestPinnedCodexHome` covers only `config.toml` and `auth.json`).
- **V12. Turn identity is available at turn start, in this order.** The
  `turn-accepted` checkpoint is recorded **after** the `turn/start` response is
  validated and **before** the awaited `turn/started` confirmation
  (`lib/process/codex-process.js:1225-1256`), and Polygram persists it from
  `lib/codex/runtime-controller.js:1559`. No new Orchestra event is needed.
- **V13. Hook `turn_id` equals the app-server `turn/started` id** (U21 VF16,
  S0-confirmed for the three-event set).
- **V14. Hooks inherit the app-server process environment and the operator's
  full `PATH`** (U21 VF14), which on this host resolves a bare `codex` to
  **0.147.0** — U21 recorded 0.146.1 and the host has moved on, which is the
  point: an unpinned name follows the host. **U23's own fixture invokes no
  Codex at all** (it runs an attested Node runtime against a checked-in
  recorder), and U23's live gate drives the **pinned app-server**. The hazard
  this addresses is a *future* wrapper — U15's — resolving `codex` from `PATH`
  or nesting a second Codex inside a turn; the descriptor rules in 4.3 forbid
  both by construction.
- **V15. Orchestra's release gate is checked in but not shipped**
  (`files` = `index.js`, `lib/`, `docs/`, `README.md`).
- **V16. Polygram's pin-consistency chokepoint** is
  `tests/orchestra-dependency-contract.test.js:11`, pinning `0.10.17`.
- **V17. Orchestra releases are tag-driven with npm OIDC trusted publishing**
  (`.github/workflows/release.yml`, fires on `v*`, verifies tag == version).

### 3.2 S0-resolved (measured 2026-08-17, `aarch64-apple-darwin` only)

Detail and caveats: `docs/2026-08-17-001-u23-hook-trust-characterization-findings.md`.

- **E1 — user-layer exactness · RESOLVED, favourable.** The `config/read`
  **user layer** object is exactly the parse of what was written: no injected
  defaults, `hooks` table holding only `state`, holding exactly the three
  predeclared entries, each exactly `{enabled, trusted_hash}`. The eleven event
  arrays U21 VF5 saw exist only in the **effective** config. Layer digest stable
  across sessions. Two layers are returned (`user`, `system`) — select the
  `user` layer **by type, not position**. The blocking risk is cleared.
- **E2 — wire params · RESOLVED.** Omitted params is **rejected** (`-32600`).
  `{}`, `{cwds: []}`, `{cwds: [ownedCwd]}`, `{cwds: [foreignCwd]}` and two-cwd
  forms are accepted, one entry per requested cwd. **Caveat:** `cwds` does not
  filter which hooks are returned — the same user-level hooks came back for a
  foreign cwd — it selects which cwd each entry is *reported against*, and the
  response **echoes the requested cwd back**. A cwd equality check is a pin
  against a malformed response, **not** evidence of scoping.
- **E3 — cardinality and paging · NOT CLAIMED.**
- **E4 — `[features] hooks = true` · RESOLVED: not required** for discovery or
  execution. **Consequence this revision exploits: R-discovery and R-hooks-off
  are the same config bytes** (section 4.5).
- **E5 — `key` derivation · RESOLVED.** `<sourcePath>:<snake_case_event>:0:0`
  for all three events; `displayOrder` is a display ordinal, not a key index.
- **E6 — snapshot boundary · RESOLVED: the manifest a session executes is fixed
  *at* `thread/start`.** Three-lane bisection: swaps before `client.start()` and
  after `initialize`/before `thread/start` both run the swapped-in content; a
  swap after `thread/start` does not. Mid-session mutation ran the pre-mutation
  command; a fresh session over mutated content reported all three `modified`
  and ran nothing, turn still completing cleanly. **Measured for `thread/start`
  only — nothing was measured about `thread/resume`** (3.3).
- **E7 — real ordering · RESOLVED; no numeric budget.** `thread/start` response
  → `SessionStart` → `turn/start` response → `turn/started` →
  `UserPromptSubmit` → `Stop` → `turn/completed`. Both turn-scoped hooks fire
  after the `turn/start` response, hence after the checkpoint is *initiated* —
  the readings bound them against initiation, **not durable completion**. The
  "10–100 ms durable budget" is **withdrawn** as a measurement artefact.
- **Fixture receipts (Darwin) · RESOLVED.** `system-runtime`
  `sha256:ea82308c…bcb7d5` (Node v24.4.0, arm64), `shipped-artifact`
  `sha256:bcb6b58c…bc50d7`. The runtime is owner-owned and **not** `0700`, and
  correctly passes. Both rules require a safe **canonical ancestor chain**.
  Command rendering is deterministic; `currentHash` is stable across sessions.
  Per-event command digests are **run-scoped**, not durable receipts.
- **Turn survival · RESOLVED.** Config and manifest digests unchanged across a
  turn that fired all three hooks.

### 3.3 Unmeasured — must not be asserted

1. **`x86_64-unknown-linux-musl` runtime receipt.** Required for U23 completion
   (D-Q6); see 4.11 and 9.3.
2. **Whether `thread/resume` snapshots the manifest the way `thread/start`
   does.** E6 measured `thread/start` only. **This plan makes no resume-boundary
   claim**; verification is required before *either* (4.6).
3. **Whether a `hooks/list` issued *after* `thread/start` reflects the session's
   bound snapshot** or re-reads current disk. If it reflects the binding, a
   post-bind verification would be strictly stronger than the pre-start one. The
   implementation gate must either measure it (9.3, G-U23h) or record why
   pre-start verification is retained; **until then no claim is made that
   pre-start verification closes the snapshot window** (4.6).
4. The launch-to-fire window for artifact **bodies** — addressed structurally by
   4.10 rather than by measurement.
5. Cardinality/paging at scale; user-layer exactness for TOML shapes not written
   (arrays, floats, datetimes, dotted keys — re-measure E1 if `buildOwnedConfig`
   grows one); whether a manifest can be *un*-trusted mid-session; non-`command`
   handler types; populated `matcher`/`pluginId`/`statusMessage`; whether
   `hooks/list` requires `initialize` first; hosted-provider behaviour; hook
   stdout semantics.

## 4. Design

### 4.1 Orchestra: one internal, manifest-bound verifier — not a public request

`hooks/list` is **not** exposed as a generic client request. Adding a public raw
request would let any future caller pull raw hook metadata across the boundary;
the only thing Polygram needs is a yes/no per expected hook.

**Schema.** `lib/codex/protocol-schema.json` gains one `clientRequests` entry,
frozen by S0/E2 and reachable **only** from the internal verifier:

```json
"hooks/list": {
  "required": ["cwds"],
  "optional": [],
  "stateChanging": false,
  "internal": true
}
```

`projectRequestParams` pins the params to exactly `{cwds: [ownedCwd]}`; any
deviation is `CODEX_RPC_REJECTED`.

**`internal: true` is what makes the refusal mechanical rather than a
convention.** The public `request()` surface rejects **any** method whose schema
entry carries the flag, before params projection and before the wire, so the
generic call is refused by the same table that allows it; only `verifyHooks()`
may dispatch it, through an internal path that bypasses the public guard. A
future method can be made internal by adding one field, and no caller — present
or future — can reach `hooks/list` generically without editing the schema in a
reviewed change.

**Ownership and lifetime of the expected manifest.** The manifest is supplied at
client construction, deep-frozen there, and immutable for the client's life. It
cannot be passed per call, so a caller cannot narrow expectations mid-session.

```
new CodexAppServerClient({ …existing, hookManifest })
  hookManifest: null | Readonly<{
    ownedCwd:  string,                    // exact canonical owned cwd
    entries:   ReadonlyArray<HookDescriptor>   // 1..16, ordinal-indexed
  }>
```

```
HookDescriptor = Readonly<{
  ordinal:       number,   // 0..entries.length-1, strictly increasing, dense
  configKey:     string,   // exact expected HookMetadata.key, predeclared
  sourcePath:    string,   // exact expected sourcePath
  event:         string,   // closed enum, one of the pinned 11
  handlerType:   'command',
  source:        'user',
  isManaged:     false,
  displayOrder:  number,   // exact expected ordinal position
  timeoutSec:    number,   // exact expected value (600 for the U23 fixture)
  commandSha256: string,   // digest of the string rendered per 4.3
}>
```

`ordinal` replaces the previous `slot`: a dense closed integer index into the
frozen manifest, never caller-chosen text, so nothing peer-influenced or
free-form can ride back out on it.

**The verifier.**

```
client.verifyHooks({ phase }): Promise<ReadonlyArray<Readonly<{
  ordinal:     number,
  currentHash: string,        // /^sha256:[a-f0-9]{64}$/
  trustStatus: 'managed'|'untrusted'|'trusted'|'modified',
  enabled:     boolean,
}>>>
```

- `phase` ∈ `'discovery' | 'trusted'` (4.4).
- Returns exactly one element per descriptor, in manifest ordinal order.
- Throws `CodexAppServerError` on any deviation; **never** returns a partial or
  filtered result.
- No raw `key`, `sourcePath`, `command`, `statusMessage`, `errors`, `warnings`,
  `cwd` or unknown field crosses — as text, digest, or count. Error messages
  carry a code and a content-free label only.
- The raw response is discarded in the frame that produces the return value.

**Plumbing (explicit).**

| Surface | Change |
| --- | --- |
| `createCodexSpawnProfile` / `assertCodexSpawnProfile` | carry `hookManifest` and `hookArtifactsSha256`; both are part of profile identity |
| `preflightCodexRuntime` | when a manifest is present, run `verifyHooks({phase:'trusted'})` as part of preflight |
| `createProcessFactory` / `CodexProcess` | construct the client with the profile's frozen manifest; run verification at the phase points in 4.6 |
| `CodexAppServerClient` | holds the frozen manifest; exposes `verifyHooks`; refuses `hooks/list` via `request()` |

Polygram side: `lib/codex/runtime-profile.js` builds the manifest and renders
config; `lib/codex/runtime-controller.js` passes it into the spawn profile.

### 4.2 The U23 optional shape is hard-pinned, not generic

S0 measured every optional key **present**, four `null`, `command` non-null. The
verifier therefore requires exactly that, with no configurable machinery:

| Optional field | Required state |
| --- | --- |
| `command` | **present and non-null**, and `sha256(command) === descriptor.commandSha256` |
| `additionalContextLimit` | **present and `null`** |
| `matcher` | **present and `null`** |
| `pluginId` | **present and `null`** |
| `statusMessage` | **present and `null`** |

A missing `command`, a `null` `command`, a digest mismatch, or any of the other
four missing or non-null is a fail-closed error. The previous revision's
three-state `expectedOptional` map — with digest comparison for free-text
optionals — is **removed** along with its speculative tests: it had no live
coverage (S0 observed every free-text optional `null`) and no consumer.
**Populated `matcher` support belongs to U15**, if U15 ever needs it.

**Whole-inventory exactness (normative).** No trust value is produced from a
per-entry harvest. An implementation collecting a key and hash as it walks the
response will harvest them from a foreign, duplicated, or tampered entry
carrying two well-typed strings. Trust values are produced **only** if the
entire inventory matched: cardinality, per-event uniqueness, key derivation,
source path, handler type, source, `isManaged`, `displayOrder`, `timeoutSec`,
command presence and digest, hash form, the required-field set, the exact
optional shape above, the phase-appropriate `trustStatus`, `enabled`, and zero
unknown fields. Anything less yields **no** trust value — not a partial one —
and rendering from an untrustable inventory throws before any turn runs. S0's
spike had this defect and fixed it (findings 8.3 #4).

### 4.3 Typed command descriptors — no shell parsing, ever

A hook command is rendered from a typed descriptor and never parsed from
arbitrary shell text:

```
CommandDescriptor = Readonly<{
  runtime:   { path: string, kind: 'protected-runtime' },
  artifacts: ReadonlyArray<{ path: string, kind: 'protected-artifact' }>,
  argv:      ReadonlyArray<string>,      // exact ordered literals
}>
```

The rendered command is a deterministic function of
`{runtime.path, artifacts[].path, argv}`; `commandSha256` is the digest of that
rendering. Every path is attested (4.10) **before** the command is rendered; a
descriptor naming an unattested path cannot be rendered at all. `argv` carries
literals only — no interpolation, no environment expansion, no shell
metacharacters.

Two rejections are structural, not stylistic: **no `PATH`-resolved name** may
appear in any position, and **no nested Codex invocation** may appear — the
runtime is the attested runtime, and a Codex binary may appear only as an
attested artifact path if U15 later needs one.

### 4.4 Phase-specific trust

`trustStatus` alone is meaningless without knowing which phase we are in, and
`enabled` alone is meaningless in every phase (V5b).

| Phase | Required of **every** descriptor | Where |
| --- | --- | --- |
| `discovery` | `enabled === true` **and** `trustStatus === 'untrusted'` | once, before rendering R-trusted |
| `trusted` | `enabled === true` **and** `trustStatus === 'trusted'` | after rendering, and at **every** session launch |

Discovery demanding the *entire* exact inventory `untrusted` is deliberate: it
refuses to render from a partially-trusted, partially-modified, or already-
trusted state, any of which means the on-disk config is not what this process
believes it is. A `trusted` entry seen during `discovery`, or an `untrusted` /
`modified` / `managed` entry seen during `trusted`, is a wrong-phase failure —
`CODEX_HOOK_TRUST_UNVERIFIED` — not a retry.

### 4.5 Renderings and the provisioning state machine

**Two renderings only.** E4 removed the feature flag, so the discovery-phase
config and the hooks-off config are **the same bytes**:

- **R-hooks-off** — today's rendering, unchanged.
- **R-trusted** — R-hooks-off plus one `[hooks.state."<predeclared configKey>"]`
  stanza per descriptor, `enabled = true`, `trusted_hash = "<currentHash>"`,
  keys sorted.

The discovery *state* is therefore "R-hooks-off config **plus** an exact
`hooks.json` on disk" — not a third rendering. This is what makes the two-file
sequence safe: `hooks.json` is written **first**, and its presence beside a
hooks-off config is a valid, classifiable, recoverable state rather than the
drift hole the previous revision created.

**Ordering rules (normative).**
- Enabling: write `hooks.json` → (discovery state) → install R-trusted.
- Disabling/rollback: install R-hooks-off → (discovery state) → remove
  `hooks.json`.

Both directions pass through the same intermediate, so no reachable state has a
config trusting a manifest that is absent, and no reachable state is
unclassifiable. Reversing the order alone would not have achieved this — a
config-first write leaves stanzas pinning a manifest that does not yet exist;
what makes it safe is that the intermediate is a *named recoverable state*, not
merely a different order.

| State | Precondition | Action |
| --- | --- | --- |
| **S-absent** | no `config.toml`, no `hooks.json` | install R-hooks-off, write `hooks.json`, discover, install R-trusted |
| **S-hooks-off** | `config.toml` byte-equals R-hooks-off, `hooks.json` absent | **explicit opt-in required**; write `hooks.json` → S-discovery |
| **S-discovery** | `config.toml` byte-equals R-hooks-off **and** `hooks.json` byte-equals its rendering | **direction-dependent — see 4.5.1** |
| **S-trusted-candidate** | `config.toml` strictly parses as R-trusted, stanza keys exactly the predeclared set, byte-re-rendering from the parsed hashes reproduces the file, `hooks.json` byte-equals its rendering | single start, verify (`phase: 'trusted'`) |
| **S-drift** | anything else | **fail closed, never write**: `CODEX_OWNED_CONFIG_DRIFT` / `CODEX_OWNED_HOOKS_DRIFT`, section 11 procedure |

**Two-start discovery is reachable from exactly S-absent, S-hooks-off (opt-in)
and S-discovery — nowhere else.** Extraction failure in S-trusted-candidate is
**S-drift**, never a fall back to discovery: a trusted-looking file this process
did not write is never overwritten and never re-derived over.

#### 4.5.1 S-discovery is directionless on disk — configuration decides

S-discovery is reached from **both** directions: enabling stops there on its way
to R-trusted, and rollback stops there on its way to hooks-off. The bytes are
identical in both cases, so **the on-disk state cannot choose the direction**,
and a resumer that guesses will re-enable a home an operator just disabled.

The authority is the **frozen desired hooks state**, read under the same
canonical-`CODEX_HOME` lock that guards the sequence: the bot/chat memory
feature flag or deployment configuration, which is durable and survives restart.

| Desired state (read under the lock) | Action from S-discovery |
| --- | --- |
| **enabled** | discover (`phase: 'discovery'`), install R-trusted |
| **disabled** | remove `hooks.json`, finish at S-hooks-off, verify (4.9 step 6) |

The desired state is snapshotted once per sequence, under the lock, and the
whole sequence runs against that snapshot; it is never re-read mid-sequence, so
a flag flipped concurrently cannot split a run across two directions.

**Rollback therefore durably disables first, then mutates files** (4.9): the
configuration write and admission close precede any file change, so a crash at
any point leaves a home whose durable desired state already says "disabled" and
whose next prepare resumes rollback rather than re-enabling. Enabling has the
mirror property. **Identical bytes never choose direction implicitly.**

**Serialization is per canonical `CODEX_HOME`, not per session key.** The
contended resource is one directory shared by every session on the host, so a
session-keyed lock permits two sessions to provision the same home concurrently.
An exclusive lock is taken on the canonical `CODEX_HOME` (an `O_CREAT|O_EXCL`
lock file inside it, holder pid + boot id recorded, stale-holder detection by
liveness) for the whole classify → discover → install sequence. A second
provisioner for the same home waits or fails closed; it never proceeds on a
classification it did not take the lock for. Two different homes proceed in
parallel.

**Atomic install.** Each write goes to a temp in the same owner-only directory:
write → `fsync(file)` → `close` → `rename` → `fsync(dir)`. The rename is the
commit point; after it the file is re-read, byte-compared and re-attested. Stale
temps matching the exact prefix, owned by us, regular, unlinked, are removed at
entry; a temp that cannot be removed is a **STOP**.

**Crash recovery, by crash point** — every reachable post-crash state is one of
the five above:

| Crash point | Desired state | On-disk state | Next prepare |
| --- | --- | --- | --- |
| after temp write, before any rename | either | previous state + stale temp | temp removed at entry; reclassify |
| after R-hooks-off rename, before `hooks.json` | enabled | S-hooks-off | opt-in re-applies; writes `hooks.json` |
| **mid-enable**: after `hooks.json` rename, before discovery | **enabled** | **S-discovery** | resumes *forward*: discovers, installs R-trusted |
| **mid-enable**: after discovery, before R-trusted rename | **enabled** | **S-discovery** | re-discovers (hashes are never cached across processes), installs R-trusted |
| after R-trusted rename, before verification | enabled | S-trusted-candidate | single start, verifies |
| **mid-rollback**: after R-hooks-off rename, before `hooks.json` removal | **disabled** | **S-discovery** | resumes *backward*: removes `hooks.json`, verifies hooks-off |
| mid-rollback: after `hooks.json` removal, before final verification | disabled | S-hooks-off | re-verifies; admission stays closed |
| lock holder dies mid-sequence | either | whichever state was last committed | stale lock detected; reclassify and re-read the desired state under a fresh lock |

The two **S-discovery** rows are byte-identical on disk and resolve in opposite
directions purely from the durable desired state — which is why 4.5.1 exists.

**Not self-healing.** A hook-content, event-set, artifact, or Codex version
change makes `hooks.json` or its stanzas stop matching their rendering — that is
S-drift and the section 11 operator procedure, not an extra start.

### 4.6 Verification points, and what they do not close

When a spawn profile carries a manifest, `verifyHooks({phase:'trusted'})` runs:

1. after `initialize`, **before `thread/start` *or* `thread/resume`** — both,
   because a resumed thread executes hooks exactly as a fresh one does; and
2. before `turn/start`, so a long-lived session cannot drift between thread
   creation and its next turn.

**What this does.** It catches an already-wrong manifest, and it closes the
bypass a cached profile would otherwise create — a profile prepared while trust
was valid cannot start or resume a session after `hooks.json` changed.

**What this does not do.** S0/E6 located the snapshot **at `thread/start`**, so
the pre-start verification runs strictly *inside* the window it was once
described as closing. The previous revision's claim is withdrawn. The manifest
window is bounded by **content-addressed trust** — a swap to unstanza'd content
is `modified` and refuses to run — not by the verification call.

**Two honest gaps, both recorded in 3.3.** Whether `thread/resume` snapshots the
way `thread/start` does was **not measured**, so no resume-boundary claim is
made and verification is required before it regardless. Whether a `hooks/list`
issued *after* `thread/start` reflects the bound snapshot is unknown; if the
implementation gate (G-U23h) shows it does, a post-bind verification becomes
strictly stronger than the pre-start one and this section is revised. Until
measured, pre-start verification is retained on its own merits and **claims only
what is listed above**.

### 4.7 Attestation of hook material

`hooks.json` plus every path named by every command descriptor is attested by
canonical path: regular file, `nlink === 1`, not a symlink, digest equal to its
pinned value, **and a safe canonical ancestor chain** — every ancestor owned by
root or by the service user and not group- or world-writable unless sticky
(S0 8.3 #5). A tight file under a loose directory is not protected.

| `kind` | Ownership / mode rule | Digest source |
| --- | --- | --- |
| `protected-runtime` | 4.10 production rule; `0700` is **not** required and must not be demanded | per-target receipt (9.3) |
| `protected-artifact` | 4.10 production rule; **no exec bit required** (it is an argument to the runtime) | release manifest digest |
| *characterization fixture* | owner-owned, safe chain — **disposable spikes only, never production** (4.10) | run-scoped |

`hooks.json` keeps its own rule: owner match, mode `0600`, regular, no link,
content equal to its rendering.

Attested at five points: before the discovery start; before the final
verification start; after the final client closes; **at every real app-server
session spawn**; and as part of every rollback verification (4.9). The gate
asserts **parity** — every intended launch attested (S0: 19 of 19) — never mere
presence.

**Cached-profile validity.** `hookArtifactsSha256` — the digest over
`hooks.json` content **and** every attested runtime/artifact digest — is carried
on the prepared profile, is part of the cache key `prepareCodexRequest` computes
(`lib/codex/runtime-controller.js:478-486`), and is a spawn-time attestation
input. That is its consumer; it exists for no other reason.

### 4.8 Turn-id correlation boundary

U23 proves an ordering property and builds no mechanism.

- **In scope.** Using the checkpoint evidence Polygram **already** records
  (V12) plus the live gate's capture, prove hook stdin `turn_id` equals the
  `turn/started` id and the `turn/start` response id, and record the observed
  ordering (E7).
- **Out of scope.** No correlation record, lookup, store, keyspace, signing,
  epoch, single-use semantics, or staging.
- **The race is live, and it is U15's.** Both turn-scoped hooks fire after the
  `turn/start` response — after the checkpoint is *initiated*, but the readings
  bound them against initiation, not durable completion. So a hook **can** fire
  before the checkpoint is durably usable if the sink is slow. U15 must not
  assume the checkpoint is readable when `UserPromptSubmit` fires and should
  fail closed with a content-free counter (U21 D3).
- **No numeric budget is recorded**, deliberately: the earlier figure was a
  measurement artefact and the remeasured margin is load-dependent.

### 4.9 Rollback and admission closing

Disabling hooks on a home is a sequenced procedure, not a file deletion. In
order, each step verified before the next:

0. **Durably set the desired state to `disabled`** (4.5.1) and **close
   admission** for that `CODEX_HOME`: no new session may be prepared or spawned
   against a hook-enabled profile. This precedes every file mutation, so any
   crash from here on resumes *backward*.
1. **Acquire the canonical-`CODEX_HOME` exclusive lock** — the *same* lock
   provisioning uses (4.5). Rollback is a provisioning sequence; taking a
   different lock, or none, would let an in-flight enable install R-trusted onto
   a home being torn down.
2. **Retire every hook-enabled session** on the home — the existing retirement
   path — and their **process groups**.
3. **Verify nothing remains**: no live client child, no surviving descendant in
   the owned process groups, no hook process still executing. Failure here
   **stops** the rollback; a running session still holds a `thread/start`
   snapshot of the old manifest (E6).
4. **Durably install R-hooks-off** (atomic rename + `fsync`), reaching
   S-discovery.
5. **Remove `hooks.json`**, reaching S-hooks-off.
6. **Verify the hooks-off generation**: the on-disk config byte-equals the
   frozen R-hooks-off fixture (9.2), `hooks.json` is absent, and a fresh prepare
   classifies the home as S-hooks-off and issues **no** hook verification.
7. **Release the lock** — held unbroken across steps 1-6. Releasing early would
   reopen exactly the window the lock exists to close.

**Lock ordering, to keep this deadlock-free.** One lock per home, and the order
is fixed: **desired state and admission first, lock second, files third** — a
sequence never takes the lock and *then* waits on admission or configuration, so
there is no cycle between the two. No sequence holds two home locks at once; if
a future caller must touch several homes it acquires them in ascending canonical
path order and releases in reverse. Lock acquisition is bounded: a waiter either
gets the lock, times out and fails closed, or detects a stale holder (dead pid /
changed boot id) and reclaims it. Nothing blocks indefinitely, and no path
upgrades or re-enters a lock it already holds.

Wired into the runbook (section 11) and into tests (9.1 #26, #26a), including
the adverse case where a live session holds a snapshot at step 3, and the
rollback-versus-in-flight-provision race.

### 4.10 Production artifact-body binding — **required**

**Decision (D-Q3): U23 requires body binding. The previous revision's
"explicit acceptance" of the launch-to-fire window is withdrawn.**

The grounding is already in the parent: **R18a** requires deployed executed
inputs to be "root-owned/provider-unwritable and digest-allowlisted", with
"repository checkouts … source only, never an execution path", and **U21 D2**
specifies the wrapper as a **root-owned** script. Accepting a service-writable
executed body would have contradicted a requirement U23 is supposed to uphold.

**The boundary (smallest sufficient mechanism).**

1. **Immutable versioned artifact tree**, root/operator-owned, e.g.
   `<artifact-root>/<version>/…`, where `<artifact-root>` and every ancestor up
   to `/` are owned by root or the operator account and are **not writable by
   the service UID** (no group/world write, no service-UID ownership, no
   sticky-dir exception for the artifacts themselves).
2. **Root-owned digest manifest** in the version directory listing every
   executed input by relative path and SHA-256. The manifest is itself attested.
3. **Commands name versioned paths.** No `current` symlink, no unversioned
   alias, no path the service can redirect.
4. **Releases never overwrite in place.** A new version installs a new
   directory; an old version is removed only when no session references it.
5. **The protected closure is exact, small, and mechanically derived** — see
   4.10.1. A protected artifact that loads an unprotected dependency is not
   protected, so U23 removes the possibility of loading one rather than
   promising to chase it.
6. **Fail closed.** If the boundary cannot be installed — any ancestor writable
   by the service UID, any executed input outside the tree, any manifest
   mismatch — **hooks cannot be enabled on that host**. Codex itself is
   unaffected; only hook enablement is refused.

#### 4.10.1 The closure U23 can actually prove

"Every transitive executed input is attested" is only meaningful if the closure
is decidable. For arbitrary JavaScript it is not — `require` of a computed
name, a data file read and evaluated, a shelled-out helper — so U23 narrows the
claim to something a build step can prove.

**U23 ships and gates exactly one hook artifact: a deterministic, self-contained
bundle**, produced by a checked-in build step from checked-in sources, with
**no dynamic imports, no external JS or data loads, no shell sourcing, and no
child process execution**. It is one file. Rebuilding from the same sources
reproduces it byte-for-byte.

**Its protected closure is therefore exactly:**

1. the protected Node runtime,
2. that one bundle,
3. the root-owned digest manifest naming both.

**A deterministic manifest generator derives that closure** from the build
output — the manifest is *generated*, never authored by a caller. A
hand-maintained list is precisely how a transitive input goes unlisted, so the
generator is the authority and a manifest that does not match a regeneration is
rejected (9.1 #28).

**The explicit trusted boundary is the OS.** The root-owned dynamic loader and
shared libraries the runtime links against are trusted, not attested by U23:
they are already root-owned on both targets, and an attacker who can replace
them owns the host outright. Stating this is the point — an unstated OS
assumption is indistinguishable from an oversight.

**What U23 does *not* claim.** It does not prove a closure for arbitrary hook
code, and it does not attest the real memory wrapper, which does not exist yet.
**U15 owns building and installing the real wrapper plus `stop.sh` through this
same build step, and proving its generated closure, before memory can be
enabled** — a genuinely larger job than U23's single self-contained bundle,
because `stop.sh` shells out by nature and its inputs must be brought inside the
tree or the design must change. U15's estimate rises accordingly (section 12).

What U23 hands U15 is the **reusable protected-tree installer, manifest
generator, and attester**, proven end to end on one artifact — not a false proof
that arbitrary code is bounded.

**Explicitly not binding: digest-named files in a service-writable tree.** A
digest in the filename is a label, not a permission. If the service UID can
write the tree it can place, replace, or relink content there, and any
re-verification is the same TOCTOU we are trying to remove. Naming is not
ownership, and this plan does not accept it as such.

**Explicitly rejected alternative: same-fd verify-and-execute.** Opening the
artifact once, verifying the digest on that descriptor, and executing from the
same descriptor would close the window without an ownership boundary — but
**Codex spawns the hook, not Polygram**, so we do not control that exec. Getting
there would mean interposing a shim that Codex execs and that re-execs from a
verified fd, which is strictly more machinery, more privilege, and more surface
than making the tree unwritable. It is the larger alternative and it is rejected
for U23.

**Characterization fixtures are exempt, and only they.** S0's owner-owned
runtime and recorder are correct for a disposable spike in a mode-0700 scratch
root that is removed in a `finally`. Production enablement uses the boundary
above. The `kind` names in 4.7 (`protected-runtime`, `protected-artifact`) are
the production rule; a fixture is labelled as such and cannot be used to enable
hooks on a real home.

**Cost, stated plainly.** This adds host provisioning that Polygram does not own
end-to-end (section 13). It is why U23's estimate is re-derived in
section 12 rather than carried forward.

### 4.11 Hooks-off byte and call identity (hard requirement)

With the hooks option absent: rendering, digests, JS object model, provisioning
sequence, app-server start count, and the exact request set and order are
unchanged. No `hooks.json` is written; no hook verification is issued; no new
attestation runs.

**Asserted against checked-in frozen fixtures**, never against a moving branch.
The fixtures are captured from base commit **`f1a0eca`** by a checked-in
command:

```sh
node scripts/spikes/capture-hooks-off-fixtures.mjs \
  --out tests/fixtures/codex-hooks-off/ \
  --base f1a0eca
```

producing the config bytes, `ownedConfigSha256`, the user-layer digest, and the
ordered request sequence. A change intending to move the hooks-off rendering
updates the fixture in the same commit — which is exactly the review signal that
should be forced.

## 5. S0 — characterization spike (RAN 2026-08-17, `CONTINUE`)

**Status: complete — `aarch64-apple-darwin` only, and characterization only.**
Findings copied into this worktree (header note); results folded into 3.2/3.3
and section 4. **Neither released-production live gate has run, on either
target.** S0 drove the pinned Codex app-server against a loopback provider on
spike-owned homes; the released 0.10.18 pin, the production plumbing of 4.1, the
artifact boundary of 4.10, and Linux are all still unproven by execution.

**How it ran.** A **sibling module importing every hardened primitive** from the
checked-in release gate — bounded raw framing, owned-process-group teardown, the
loopback provider, closed-enum discipline, the failure taxonomy — rather than an
extension of that file, because the gate's `EXPECTED_HOOK_EVENTS` is a frozen
two-event set threaded through its evidence shape, its CONTINUE/STOP contract
and twenty of its tests, and S0 characterizes three. Widening it would have
silently redefined the gate certifying PR #52. The gate's contract is asserted
unchanged by a new test and was re-run live (`CONTINUE`, zero failed checks)
after two additive edits: exporting `startLoopbackProvider`, and carrying the
numeric JSON-RPC `error.code` on a rejection (without which "method not allowed"
and "params refused" are indistinguishable — exactly what E2 had to separate).
**The no-second-raw-transport constraint held.**

```sh
node scripts/spikes/codex-hook-trust-s0.mjs \
  --binary /absolute/versioned/path/to/codex \
  --probe-root /absolute/non-temporary/probe-root \
  [--runtime /absolute/path/to/node]
```

`--runtime` exists because the runtime is itself an attested artifact under a
strict ancestor chain; a package-manager Node under a group-writable prefix is
correctly refused, so without the flag the command would be non-reproducible.

**What `CONTINUE` certifies.** The gate was rebuilt mid-run: it originally
derived `CONTINUE` from "no decision left `unmeasured`", which is completeness of
*attempt*, and would have exited 0 through an unattested binary, a faulted turn,
missing captures, a surviving process, or an unremoved scratch root. It is now
**28 named closed predicates** over projected evidence, requiring both
`unmeasured` and `failedChecks` empty. **Any `CONTINUE` from an earlier revision
of the findings is not evidence.** The gate immediately returned `STOP` on
`snapshotBoundaryLocated`, catching a boundary lane whose swap was a no-op.

**Weight of the evidence.** 38 adverse tests written before their fix and
observed failing; 67 evidence mutations driving the gate; 13 defects fixed in
the spike's own code (per-entry trust harvesting, describing-not-enforcing
attestation, unhealthy auxiliary lanes voting, a recorder clock that inflated
every margin). Full suite 1343 / 1324 pass / 0 fail / 19 pre-existing skips
under two runtimes; focused 75/75; three consecutive live `CONTINUE` runs.

**What S0 did not do.** It did not run against a released Orchestra, did not
exercise the production plumbing of 4.1, did not touch Linux, and did not test
the artifact boundary of 4.10 — that boundary did not exist when it ran.

## 6. Sequence

**Normative ordering.** The **core integration path `O` → `P` → `R` → `G` is
strictly ordered**: the Orchestra work must be released before Polygram can
consume it, the implementation must exist before it can be reviewed, and the
gates must run last against the reviewed, released, installed whole.

**`H` and `W_host` are not in that path.** Both begin once the reviewed spec is
frozen — that is, now — and **run in parallel with `O` + `P`**:
`H` is the protected-bundle, manifest-generator and installer/attester work
(Polygram-owned); `W_host` is root-owned host provisioning (host-owner-owned).
Neither waits on the Orchestra release, and neither blocks it.

**`G` waits on all of them**: `O` + `P` complete and the release published, `H`
landed, `W_host` satisfied on both targets, and `R` done. `R` in turn starts
once `O` + `P`, `H` and `W_host` have all landed, because it reviews the
*integrated* change — reviewing the code before the installer and the boundary
exist would review half of it.

This is exactly `T23 = max(O + P, H, W_host) + R + G` (section 12); the earlier
"no parallel lane" wording described the S0-era sequence and no longer matches
the design, so it is withdrawn.

| Step | Lane | Owner | Starts after |
| --- | --- | --- | --- |
| 1. ~~S0 characterization~~ — **done** 2026-08-17, `CONTINUE`, Darwin | — | Polygram | — |
| 2. ~~Fold S0; both spec reviews~~ — **done**; decisions in frontmatter. **Spec freeze.** | — | Polygram | 1 |
| 3. **`H` — protected bundle and installer**: checked-in deterministic build step, manifest generator, protected-tree installer/attester, version retention, runbook (4.10, 4.10.1) | `H` | Polygram | 2 |
| 4. **`W_host` — host provisioning**: root-owned versioned tree with service-unwritable ancestors on Mac **and** VPS; pinned Codex 0.145.0 `x86_64-unknown-linux-musl` present and attestable; protected-runtime receipts measurable on both (13.1-13.3) | `W_host` | **host owner / `umi-vps-infra`** | 2 |
| 5. **`O` — Orchestra**: PR (schema entry with `internal: true`, params pin, frozen-manifest verifier, phase argument, plumbing 4.1, leakage and manifest-exactness tests, independently reviewed) → fold into 0.10.18 (D-Q1; do not publish the staged bump as-is) → release gates (suite green → version bump → merge → tag `v0.10.18` matching `package.json` → `release.yml` verifies tag == version, tests, publishes via npm OIDC under `latest`, GitHub Release) → post-publish tarball verification (9.3) | `O` | Orchestra | 2 |
| 6. **`P` — Polygram**: consumption gates (pin `package.json` + both lockfile positions → `npm ci` from a clean tree → dependency-contract assertions → **full `npm test`**), then implementation in section 4 order: descriptors and artifact attestation → `hooks.json` renderer → state machine, per-home lock, atomic install, direction-from-configuration → phase-specific verification wiring → rollback/admission | `P` | Polygram | 5 |
| 7. **`R` — implementation review and fold** of the integrated change | `R` | Polygram | 3, 4, 6 |
| 8. **`G` — live gates on both targets** (9.3), writing one atomic per-target gate receipt each | `G` | Polygram + host owner | 5, 7 |
| 9. **Parent-plan amendment** on the orchestration branch (section 12) | — | orchestration owner | 8 |

Steps 3, 4 and 5 all start from the spec freeze and proceed independently;
steps 6-9 are strictly ordered behind them as the table's *Starts after* column
states.

## 7. Alternatives rejected

- **A generic public `hooks/list` request.** Rejected for the internal
  manifest-bound verifier: a public raw request lets any future caller pull raw
  hook metadata across the boundary, when the only thing needed is a yes/no per
  expected hook.
- **Raw one-shot app-server session inside Polygram.** Bypasses the attested
  client boundary the whole Codex model rests on, and duplicates a transport
  Orchestra has hardened. **No raw Polygram transport exists in this design.**
- **Pinned constant `trusted_hash`.** Rejected including as a fallback: stale
  constants stop hooks silently while turns stay green. **No constant-hash
  fallback path exists anywhere here.**
- **Polygram recomputing Codex's hash.** Undocumented, unversioned, silently
  divergent on any bump.
- **Digest-named files in a service-writable tree** as body binding (4.10).
- **Same-fd verify-and-execute** (4.10) — larger, and Codex owns the exec.
- **Accepting the artifact-body window** — the previous revision's position,
  withdrawn as contrary to R18a and U21 D2.
- **Generic `expectedOptional` machinery** — no live coverage, no consumer.
- **`config/batchWrite`** — state-changing config mutation, far larger surface.
- **`--dangerously-bypass-hook-trust`** — does not exist on `codex app-server`.

## 8. U23 test manifest

Three events, one hook each — exactly U21's intended inline installer set.

| Config key | Event | Predeclared key suffix | `turn_id` on stdin |
| --- | --- | --- | --- |
| `SessionStart` | `sessionStart` | `:session_start:0:0` | **no** (S0) |
| `UserPromptSubmit` | `userPromptSubmit` | `:user_prompt_submit:0:0` | **yes** (S0) |
| `Stop` | `stop` | `:stop:0:0` | **yes** (S0) |

`SessionEnd` is not registered: it proved nothing U23 claims, and each event
costs a descriptor, an attestation, and a lifecycle assertion. Every hook
reported `timeoutSec: 600`, `handlerType: command`, `source: user`,
`isManaged: false`, `enabled: true`, `displayOrder` 0/1/2 — all pinned by the
manifest.

**Characterization fixture command** (disposable spike only — 4.10):

```
runtime:   { path: <absolute canonical Node>, kind: characterization fixture }
artifacts: [ { path: <absolute canonical checked-in recorder .js> } ]
argv:      [ <eventName>, <captureDir> ]
```

`argv` carries **both** the event name and the capture directory, matching what
S0 actually ran. The capture directory is per-run, which is precisely why
per-event command digests are **run-scoped and not durable receipts**; the
durable receipts are the runtime and recorder digests. The recorder must stamp
its observation **at process entry, before draining stdin** (stamping after
drains times the writer and inflated every derived margin) and must **reject an
overflowed payload whole** rather than parsing a valid prefix.

**Production wrapper (U15, not built or run here):** registered on `Stop` with
`UserPromptSubmit` as the receipt-arrival confirmation point, declared through
the same descriptor type with `protected-runtime` / `protected-artifact` paths
from the 4.10 tree. **U15 builds and installs it — and `stop.sh` — through the
U23 build step, and proves its generated closure (4.10.1) before memory can be
enabled.** U23 provides the descriptor type, the attestation rules, the
boundary, the installer/generator/attester, and the rejection of anything
unpinned; **U15 owns the wrapper's behaviour, its packaging and closure, and
receipt semantics; U27 owns end-to-end handoff.**

## 9. Verification

### 9.1 RED tests (each must fail before its change, in the stated way)

**Orchestra — staged separately:**

1. *Allowlist red.* The verifier's request is rejected today → passes only after
   the schema entry. Red: `CODEX_RPC_REJECTED`.
2. *Params-pin red.* Any deviation from `{cwds: [ownedCwd]}` is
   `CODEX_RPC_REJECTED`.
3. *Public-surface red.* `client.request('hooks/list', …)` is **refused** even
   after the schema entry; only `verifyHooks()` may reach it.
4. *Verifier red.* With the allowlist entry present and no verifier, a raw
   response is not reducible to the four-field return type. **Frozen fixtures**,
   not live peers.
5. *Leakage red.* Sentinels in `key`, `sourcePath`, `command`, `statusMessage`,
   `matcher`, `pluginId`, `additionalContextLimit`, `cwd`, `errors`, `warnings`
   appear nowhere in the return value, any thrown error, any event, any log.
6. *Ordinal red.* The result carries dense manifest ordinals only; no
   peer-derived or caller-free-form identifier can ride out on it, and an
   out-of-range or duplicated ordinal fails closed.
7. *Manifest exactness reds*, one each: extra hook, missing hook, duplicate key,
   foreign cwd, command-digest mismatch, `handlerType`/`source`/`isManaged`
   mismatch, wrong `displayOrder`, `timeoutSec ≠ 600`, nonzero key index,
   unknown field, non-empty `errors`, non-empty `warnings`.
8. *Optional-shape reds*: `command` **missing**; `command` **null**;
   `command` non-null but digest-mismatched; each of the other four **missing**;
   each of the other four **non-null**. Plus the positive: four `null` keys and
   a non-null `command` is the only accepted shape.
9. *Phase reds*: a `trusted` entry during `phase: 'discovery'` fails; an
   `untrusted`, `modified`, or `managed` entry during `phase: 'trusted'` fails;
   `enabled: false` fails in both phases; `enabled: true` + `untrusted` is
   accepted **only** in `discovery` (V5b's exact observed state).
10. *Whole-inventory reds*: a foreign, duplicated, or tampered entry yields **no**
    trust value; rendering from an untrustable inventory throws before any turn;
    a single-entry inventory is untrustable rather than partially harvested.
11. *Plumbing reds*: a profile carrying a manifest reaches `thread/start`
    without verification → fails; reaches **`thread/resume`** without
    verification → fails; reaches `turn/start` without verification → fails.
12. *Manifest immutability red*: the frozen manifest cannot be replaced or
    narrowed after client construction.

**Polygram — dependency assertions, one fact each:**

13. Declared/installed version is `0.10.18` (four positions).
14. `droppedServerNotifications` contains `hook/started` and `hook/completed`.
15. `clientRequests` contains the hook method with the frozen params form.
16. The exported verifier has the expected shape, and `hooks/list` is absent
    from the public request surface.

**Polygram — behaviour:**

17. Hooks-enabled prepare renders R-trusted with one stanza per descriptor, and
    `ownedConfigSha256` differs from R-hooks-off.
18. Mutating hook content changes the rendered `trusted_hash` and the
    owned-config digest (V7).
19. State machine, one test per state: S-absent, S-hooks-off (opt-in required;
    without opt-in nothing is written), S-discovery, S-trusted-candidate,
    S-drift (nothing written, no app-server spawn attempted).
20. Extraction failure in S-trusted-candidate is **S-drift**, not re-discovery;
    two-start discovery is unreachable from S-trusted-candidate and S-drift.
21. **Crash-boundary tests, one per row of 4.5's recovery table**, simulated by
    leaving the exact on-disk state and re-entering prepare — including the
    `hooks.json`-written-before-config boundary and the rollback intermediate.
21a. **Direction on restart (4.5.1)**: from byte-identical S-discovery, a
    restart with desired state **enabled** resumes forward to R-trusted, and a
    restart with desired state **disabled** resumes backward to hooks-off. A
    crash mid-enable and a crash mid-rollback are each driven end to end. An
    implementation that infers direction from the bytes fails both.
21b. Desired state is snapshotted once per sequence under the lock: flipping the
    flag mid-sequence cannot split a run across two directions.
22. **Per-home concurrency**: two concurrent provisioners for the **same**
    canonical `CODEX_HOME` serialize (the loser waits or fails closed, never
    proceeds on a stale classification); two **different** homes proceed in
    parallel; a stale lock from a dead holder is detected and reclaimed; a
    session-keyed lock would let the same-home case through, so the test must
    fail against that design.
23. Stale temp removed at entry; an unremovable temp is a STOP.
24. **Teardown reds**: close failure, latched fault, exit timeout, surviving
    descendant each STOP **before** R-trusted is written — asserted by the
    absence of the new config on disk. Late output from a closed child cannot
    influence the installed config.
25. `hooks.json` attestation: wrong mode, symlink, `nlink > 1`, wrong owner,
    content drift → `CODEX_OWNED_HOOKS_DRIFT`, at each of the five points.
26. **Rollback with live snapshots**: with a session live and holding a
    `thread/start` snapshot, rollback **stops** at the verify step; after
    retirement it proceeds, and the final state verifies as hooks-off
    (config byte-equals the frozen fixture, `hooks.json` absent, next prepare
    classifies S-hooks-off and issues no verification). Admission stays closed
    throughout.
26a. **Rollback versus in-flight provision**: a rollback starting while an
    enable is mid-sequence on the same home **waits for the same canonical-
    `CODEX_HOME` lock** and never interleaves — the enable either completes
    before rollback proceeds or is itself resumed backward from the durable
    disabled state. Asserted by the absence of an R-trusted config after both
    settle. An implementation that takes a different lock, no lock, or releases
    between steps fails this. A companion test asserts lock ordering holds
    (desired state and admission before the lock, never after) and that a
    bounded wait times out or reclaims a stale holder rather than blocking.
27. **Production artifact parent/file writability**: an artifact or runtime
    whose file **or any canonical ancestor** is writable by the service UID is
    refused; a root-owned tree with a service-writable intermediate directory is
    refused; a `0777` intermediate is refused; an unversioned or symlinked
    command path is refused; a digest-named file in a service-writable tree is
    **refused** (it is not binding).
28. **Bundle closure and manifest generation (4.10.1)**: the bundle rebuilds
    byte-for-byte from the same sources; a bundle containing a dynamic import,
    an external JS/data load, a shell source, or a child exec is **rejected by
    the build step**; the manifest is produced by the generator and a
    hand-edited or regeneration-mismatched manifest is refused; mutating any
    member of the generated closure — bundle or runtime — fails closed.
29. Descriptor rendering: rejects `codex`, `./codex`, any relative path, any
    `PATH`-resolved name, any nested Codex invocation, and any absolute path not
    in the attested set; `argv` entries with shell metacharacters, interpolation
    or control characters are rejected; `commandSha256` equals the digest of the
    rendering, never of hand-written text.
30. **Cached-profile bypass**: a profile prepared while trust was valid cannot
    start **or resume** a session after `hooks.json` changes. A companion test
    pins the **limit**: verification before `thread/start` does not detect a swap
    landing between it and the snapshot (4.6), so the suite does not overclaim.
31. **Mutation-after-prepare**: mutating `hooks.json` or any attested runtime or
    artifact between prepare and spawn invalidates the cached profile through
    `hookArtifactsSha256`.
32. **Both target-gate receipts validate**: the checked-in receipt parses
    against `u23-gate-result/v1`, carries an `aarch64-apple-darwin` **and** an
    `x86_64-unknown-linux-musl` entry, and each entry has
    `orchestraVersion === "0.10.18"`, a complete closed `gates` map all-`true`,
    `launches.intended === launches.attested`, `verdict: "CONTINUE"`,
    `exitCode: 0`, `stderrEmpty: true`, and digests matching what attestation
    computes on that host. **Adverse**: any absolute path, hostname, username or
    `recordedBy` field → rejected; a missing gate key → rejected; a
    `verdict: "STOP"` entry in the success file → rejected; a failing run writes
    **no** success receipt and emits the sanitized failure envelope instead. A
    missing or stale-target receipt refuses hook enablement on that target.
33. Turn-id evidence: the existing `turn-accepted` checkpoint carries the
    `turn/start` response id, ordered per V12. No new store; **no test asserts a
    duration bound**.

### 9.2 Regression gates (green before *and* after)

- **Hooks-off byte and call identity** against the checked-in frozen fixtures
  captured from base `f1a0eca` (4.11).
- Full `npm test` green in Polygram; full suite green in Orchestra.
- No new dependency, no schema migration, no DB state.

### 9.3 Final gates — executable and reproducible

**Deliverables — two checked-in scripts, both new files in this repository:**

| File | What it is |
| --- | --- |
| `scripts/spikes/capture-hooks-off-fixtures.mjs` | captures the frozen hooks-off fixtures of 4.11 from a named base commit |
| `scripts/spikes/u23-release-gate.mjs` | the post-release gate: a **parameterized landing of the reviewed S0 harness** |

`u23-release-gate.mjs` is not new work from nothing, but it is not free either.
The S0 harness it derives from (`codex-hook-trust-s0.mjs`, its recorder, and its
75-test suite) is **currently uncommitted, in an Orchestra spike worktree**.
Landing it means committing it into this repository, parameterizing the target,
runtime, artifact root and receipt path, replacing its characterization fixtures
with the protected-tree artifacts, and re-pointing its gate map at G-U23a…i.
That cost is carried explicitly in section 12's `G` row rather than assumed away
as "reuse".

**Post-release verification command** (run after publish, per target):

```sh
node scripts/spikes/u23-release-gate.mjs \
  --binary /absolute/versioned/path/to/codex \
  --probe-root /absolute/non-temporary/probe-root \
  --runtime /absolute/path/to/protected/node \
  --artifact-root /absolute/protected/artifact/root \
  --receipts docs/receipts/u23-gate-results.json \
  --target <aarch64-apple-darwin | x86_64-unknown-linux-musl>
```

Darwin (this Mac) and Linux (the VPS) run the **same** command with the target's
own `--runtime`, `--artifact-root` and `--target`. **Both targets are U23
completion criteria** (D-Q6); neither is deferred, and target-specific
dependencies are not split.

**The receipt is a gate result, not an artifact inventory.** A file listing
digests says only "these files were hashed"; what U23 completion needs is "every
check passed on this target, under this exact pin". So the receipt is written
**atomically, once, only after every check has succeeded** —
`docs/receipts/u23-gate-results.json`:

```json
{
  "schema": "u23-gate-result/v1",
  "targets": {
    "<target-triple>": {
      "codexCliVersion": "codex-cli 0.145.0",
      "codexBinarySha256": "<64 hex>",
      "orchestraVersion": "0.10.18",
      "protocolSchemaSha256": "<64 hex>",
      "runtime": { "id": "node", "sha256": "<64 hex>" },
      "artifacts": [ { "id": "<stable logical id>", "sha256": "<64 hex>" } ],
      "gates": { "G-U23a": true, "G-U23b": true, "G-U23c": true,
                 "G-U23d": true, "G-U23e": true, "G-U23f": true,
                 "G-U23g": true, "G-U23h": true, "G-U23i": true },
      "launches": { "intended": 0, "attested": 0 },
      "verdict": "CONTINUE",
      "exitCode": 0,
      "stderrEmpty": true,
      "recordedAt": "<ISO-8601 timestamp>"
    }
  }
}
```

Rules, all enforced by 9.1 #32:

- **Content-free.** Logical ids and digests only — **no absolute path, no
  hostname, no username, no `recordedBy`**. An operator handle is provenance the
  git history already carries, and it is the field most likely to leak an
  account name into a shared artifact.
- **`orchestraVersion` must be exactly `0.10.18`.** A receipt produced against
  any other version is invalid, which is what stops a gate run on a stale or
  local build from counting.
- **`gates` is a closed map over G-U23a…G-U23i.** Every key present, every value
  `true`. A missing key is a failure, not an omission.
- **`launches.intended === launches.attested`** — parity, never presence.
- **Atomic and success-only.** Written by temp + `fsync` + rename after the last
  check passes. **On `STOP`, no success receipt is written at all**; the run
  emits a separate sanitized failure envelope (verdict `STOP`, the same closed
  gate map with the failing keys `false`, `failedChecks` drawn from the frozen
  check-name list, and no peer-derived text) so a failure is diagnosable without
  ever being mistakable for a pass.
- Updated only by re-running the gate on that target and committing the
  regenerated entry in a reviewed change; **never hand-edited**.

**Gates:**

- **G-U23a.** Hook-enabled turn under the released 0.10.18 pin completes: no
  protocol fault, no `hook/*` delivered to any consumer, all three descriptors
  `trusted` + `enabled`.
- **G-U23b.** Hooks-off control turn unchanged: zero `hook/*`, identical config
  digest, identical request sequence.
- **G-U23c.** Hook stdin `turn_id` equals the `turn/started` and `turn/start`
  response ids; E7 ordering recorded; no duration asserted.
- **G-U23d.** Mutating `hooks.json` flips trust to `modified`, the profile
  refuses to start, and a cached profile cannot start **or resume**.
- **G-U23e.** Owned children fully retired; owned process group empty.
- **G-U23f.** Runs on **both** targets with that target's receipt validated.
- **G-U23g.** Launch attestation **parity** (`intended === attested`), not
  presence.
- **G-U23h.** Measure whether a `hooks/list` issued after `thread/start`
  reflects the bound session snapshot (3.3 #3). If it does, 4.6 is revised to
  add a post-bind verification; if it does not, or the answer is ambiguous, the
  gate records that and pre-start verification is retained on its stated,
  narrower merits.
- **G-U23i.** Artifact boundary holds on the target: the tree, every versioned
  command path, and every transitive input are service-unwritable with safe
  ancestors, and enablement **fails closed** on a deliberately loosened
  ancestor.

U23 is complete when 9.1 is green, 9.2 holds, and 9.3 passes **on both
targets**.

## 10. Scope — U23 vs the rest

**U23 owns:** the Orchestra internal verifier, its schema entry and params pin,
the frozen-manifest ownership model and plumbing; phase-specific trust; the
0.10.18 release and Polygram's exact pin/protocol-receipt consumption;
`hooks.json` rendering, provisioning, per-home serialization, atomic install and
crash recovery; typed command descriptors; artifact attestation **and the
production artifact-body boundary**; rollback/admission; the turn-id
equality/ordering proof; and both target gates.

**U23 does not own:**

- **U15** — the wrapper's behaviour and **receipt semantics** (minting, lookup,
  signing, epochs, single-use), memory binding and policy projection, session
  identity digests, staging roots, `MEMSEARCH_DIR` binding, memory DB schema,
  and the hook-vs-checkpoint durability race. **U15 does not depend on a
  U23-proven receipt implementation — U23 builds none.** What U23 hands U15 is
  trust, descriptor and artifact plumbing.
- **U27** — end-to-end detached capture handoff and the staging state machine.
- **U16** — publisher, destination ledger, registry, redaction, fanout.
- **U14 / U17** — generic scoped recall transport and client.
- **U24** — personal-sensitivity routing and its auth boundary.
- **U25 / U26** — durable secret boundary and historical cleanup.
- **Anything memsearch.** The vendor installer is never run against Polygram's
  byte-exact config (U21 VF6); `stop.sh` is not invoked in U23 — though 4.10
  requires it to live inside the protected tree before U15 may exec it.
- **Enabling memory anywhere.**

## 11. Upgrade, rollback, deployment

Files persist; only the absence of DB state is clean.

- **The known-state reprovision procedure**, referenced throughout: close
  admission and retire sessions (4.9 steps 1-3), back up `config.toml` outside
  `CODEX_HOME`, remove it and `hooks.json`, let startup reprovision from
  S-absent. Required wherever named below.
- **Hooks-off revert is simple:** pin back to `0.10.17`, revert, `npm ci`.
  Byte- and call-identity (4.11) means no hooks-off home changes. **Fleet-wide
  hooks-off is a predeploy attestation**, not an assumption: confirm no target
  home holds a `hooks.json` or trust stanza before deploying.
- **Hooks-enabled rollback is the 4.9 procedure**, not a file deletion.
- **Hook-content, event-set, and artifact upgrades** are the reprovision
  procedure: they make `hooks.json` or its stanzas stop matching their
  rendering, which is S-drift. Not self-healing.
- **Any path change** — deploy layout, runtime upgrade, **new artifact version
  directory**, capture root — invalidates every hash, because trust is
  content-addressed over a command string embedding absolute paths. Versioned
  artifact directories (4.10) make this a *planned* reprovision rather than a
  surprise.
- **Codex pin bumps** may move the key derivation, the hash, or the metadata
  shape — S0's derivation is confirmed **for 0.145.0 only** — so a bump requires
  re-running S0's decisions **and** reprovisioning every hooks-enabled home.
- **No automatic migration exists**; reprovision-from-known-state is the only
  supported transition until a separately reviewed migration exists.
- **Orchestra rollback:** the verifier is additive and read-only; a Polygram
  pinned to 0.10.17 cannot call it.

## 12. Parent-plan amendment

Applied to **this worktree's copy** of the parent; the canonical parent in the
orchestration worktree is untouched and receives these through its owner.

- U23 gains an **Amendment plan (governing)** pointer and an **S0
  characterization: COMPLETE, `CONTINUE` (2026-08-17, Darwin only,
  characterization only — no released-production gate has run)** block.
- U23's **Approach** gains the respects in which S0 and this plan supersede it:
  trust rendering additionally needs the reviewed internal verifier; U23 builds
  **no** receipt mint/lookup machinery; commands come from typed descriptors;
  and production executed inputs must satisfy the R18a-grounded artifact
  boundary.
- **U15's Approach** drops the wording making it depend on a "U23-proven hook
  wrapper/receipt path": U23 proves trust, descriptor and artifact plumbing;
  U15 owns wrapper and receipt semantics; U27 owns end-to-end handoff.
- The **U23 rollout gate** becomes per-target with **both** targets inside U23.
- **Estimates, re-derived** (not scaled from 2 / 4 / 6, which predated the
  production binding, the plumbing, and the deterministic bundle).

  **Spent work is unmetered.** S0 and the two spec-review rounds are done, but
  they were never time-tracked in engineer-days. Following the parent's own
  convention for spent units, they are **excluded from remaining totals**, and
  **no best/likely/worst actual is invented for them**. A historical pre-S0
  *planning* envelope of 2 / 3 / 4 exists and may be kept for context — but it
  is a forecast that was never reconciled against actuals, so it is **not** an
  actual and is **never** added to remaining to manufacture a "from zero" total.

| Row | Component | Best | Likely | Worst |
| --- | --- | ---: | ---: | ---: |
| `O` | Orchestra API, tests, release | 2 | 3 | 5 |
| `P` | Polygram renderer, state machine, attestation | 3 | 4 | 7 |
| `H` | Deterministic U23 bundle + protected installer, manifest generator, version retention, runbook | 2 | 3 | 5 |
| `G` | Landing/adapting the S0 harness + both-target gates, receipts, rollback | 2 | 3 | 5 |
| `R` | Implementation code review and fold | 1 | 1 | 2 |
| | **U23 remaining** | **10** | **14** | **24** |

  `R` is the **future implementation review** of the code this plan produces —
  not the spec reviews already completed, which are spent and unmetered.

- **Effort is not elapsed time.** `O` and `P` are sequential; `H` runs alongside
  them; the gates `G` need the release and the installed boundary; `R` reviews
  the code:

  ```text
  T23 = max(O + P, H, W_host) + R + G
  ```

  **`W_host` is an unquantified registered wait**, not engineer-days: the
  operator/calendar time to install the root-owned artifact tree on the Mac and
  the VPS (section 13). It is written into the formula so it cannot be silently
  dropped, and the numeric recurrence below **assumes `W_host` = 0**, which is
  the optimistic case, not a prediction.

  With `W_host` = 0: `T23` = **8 / 11 / 19** elapsed engineer-days against
  **10 / 14 / 24** of effort.

- **Parent rollups**, with U23 remaining 10 / 14 / 24 and U15 raised to
  4 / 6 / 10 (4.10.1):
  - **MVP engineering total, remaining: 42 / 69 / 114** (was 32 / 56 / 91 at
    U23 = 1 / 2 / 3).
  - **Full parity total, remaining: 48 / 79 / 129** (was 38 / 66 / 106).
  - **Critical path, remaining only:** `T19` = **28 / 44 / 71**,
    `T20` = **34 / 54 / 86** (were 20 / 34 / 53 and 26 / 44 / 68).
  - **No numeric from-zero total is published**, because the spent work behind
    it is unmetered. Publishing one would dress a forecast up as an actual.

## 13. Decisions and dependencies

All questions are decided; the frontmatter carries the decision history. What
remains are **dependencies**, not open questions:

1. **Host provisioning is not fully Polygram's to do — and it carries a
   calendar wait.** 4.10 requires a root/operator-owned versioned artifact tree
   on both the Mac and the VPS, with ancestors unwritable by the service UID.
   Polygram can attest and fail closed; it cannot create root-owned
   infrastructure. **This needs the `umi-vps-infra` / host owner on both
   targets.** It is registered as `W_host` in section 12's recurrence — an
   operator/calendar wait, deliberately not converted into engineer-days — and
   it is the one thing that can block U23 completion after all code is written.
2. **The pinned Codex 0.145.0 `x86_64-unknown-linux-musl` binary must be present
   and attestable on the VPS.** This is a **separate** dependency from the
   protected Node runtime receipt: the runtime is what executes the hook bundle,
   the Codex binary is what the gate drives, and each has its own digest and its
   own failure mode. Orchestra pins the Linux target receipt
   (`a2a05daf…1ce7be14`); if that exact binary is absent or unattestable on the
   VPS, the Linux gate cannot run and U23 cannot complete (D-Q6).
3. **The Linux protected-runtime receipt must be measured** before Linux
   enablement; inside U23 (D-Q6).
4. **`stop.sh` must be built and installed into the protected tree before U15
   can exec it.** Today memsearch is a vendor checkout — which R18a explicitly
   disallows as an execution path — and `stop.sh` shells out by nature, so its
   inputs must come inside the tree or that part of the design must change.
   U23 specifies the requirement and ships the installer, generator and
   attester; **U15 owns doing it** and cannot ship without it.
5. **G-U23h may reopen 4.6** in a strengthening direction only: if a post-bind
   `hooks/list` reflects the session's snapshot, the verification point moves and
   this section is revised. No decision is being deferred — the current design
   stands on its own and would only improve.
