# U23 S0 — Codex hook trust characterization findings

> **Provenance of this copy (added by the copy; everything below is verbatim).**
> Durable Polygram-side copy of the reviewed Orchestra artifact
> `docs/2026-08-17-001-u23-hook-trust-characterization-findings.md`, produced on
> the Orchestra branch `spike/codex-hook-trust-characterization` based on
> `origin/main` `3b0587a`.
>
> - **Orchestra source:** `sha256:617691cdfd2647c4160bc90dc70877eb757a0ad2538fa939c2bb641e4e1c7236`.
>   Strip this banner block and the remainder hashes to exactly that value.
> - **This local copy's** digest is recorded in the consuming plan's header note
>   rather than here — a file cannot carry its own hash without invalidating it
>   on every edit, and a stale self-hash is worse than none.
>
> The spike code it describes lives in that Orchestra worktree and is **not**
> committed there; this document is the durable record. Scope: characterization
> on `aarch64-apple-darwin` only — **no released-production gate has run.**
> Consumed by
> `docs/plans/2026-08-16-002-feat-codex-hook-trust-discovery-plan.md`.

Date: 2026-08-17
Repository: Orchestra, branch `spike/codex-hook-trust-characterization`, based on
`origin/main` = `3b0587a` ("feat(codex): tolerate hook lifecycle notifications", #52).
Scope: characterization spike, focused tests, and this sanitized artifact only.

**Recommendation: `CONTINUE`** — every S0 decision was measured, the highest-risk
unknown resolved favourably, and no measurement invalidates the amendment plan's
approach. **Twelve** statements in the plan are contradicted by evidence and must
be corrected before the production design is written (section 4); one of them
(4.10) changes a security conclusion, so section 4 is not optional polish.

No production request was added, no protocol schema was changed, no production
app-server API was touched, no package version moved, no release worktree was
touched, and nothing was committed, published, or deployed.

## 1. Containment and provenance

| Property | Value |
| --- | --- |
| Codex under test | pinned 0.145.0, `aarch64-apple-darwin` |
| Binary attestation | `attestPinnedCodexBinary` against `resolveCodexTargetPin()` — **passed**, `pinnedBinaryAttested: true` |
| Protocol pin | unchanged; `lib/codex/protocol-schema.json` not edited |
| Homes | per-run isolated `CODEX_HOME`, `mkdir` 0700 + explicit `chmod 0700`, verified `isolatedHomeMode0700: true` |
| Credentials | none. `auth.json` absent in every lane; the loopback Responses provider declares `requires_openai_auth = false`, read back from the config actually written (`providerRequiresAuth: false`) |
| Network | loopback only. No hosted provider, no egress, no credential created, copied, read, or printed |
| Scratch | per-run root under a caller-supplied non-temporary probe root, removed in a `finally`; `probeRootRemoved: true`, root verified empty after every run |
| Process cleanup | owned process group enumerated and drained per raw session; `strayProcessCount: 0` after every run |
| Output | booleans, closed enums, counts, digests. **Nothing else leaves the run.** Host paths, rendered hook commands and config keys necessarily *exist* on disk — they are the manifest and config the app-server has to read — but only inside the per-run mode-0700 scratch root, which is removed in a `finally`. They are never emitted, never retained past the frame that projects them, and never written anywhere outside that root. Hook stdin is parsed in place: the prompt, workspace and transcript path reach no file at all |

The generated-schema facts below were read from the pinned binary's own
`app-server generate-json-schema --experimental` bundle, produced into a
disposable home. They are marked **[schema]**; everything else is **[observed]**
on a live turn.

## 2. What ran

Three new/edited spike surfaces, driven from a checkout:

```sh
node scripts/spikes/codex-hook-trust-s0.mjs \
  --binary /absolute/versioned/path/to/codex \
  --probe-root /absolute/non-temporary/probe-root \
  [--runtime /absolute/path/to/node]   # defaults to the invoking runtime
```

`--runtime` exists because the runtime is itself an attested artifact and must
be a canonical, owner-or-root, non-group-writable file under an equally tight
parent chain. A package-manager-installed Node frequently sits under a
group-writable prefix and is correctly refused, which would otherwise make the
documented command non-reproducible depending on which `node` happened to be
first on `PATH`.

Lanes, all against the pinned binary and the loopback provider:

- **Lane A** — three-event manifest (`SessionStart`, `UserPromptSubmit`, `Stop`),
  `[features] hooks = true`. Wire-param matrix → untrusted inventory → user-layer
  read → trust render → trusted inventory (twice, separate sessions) → user-layer
  read (twice) → a real turn on the production `CodexAppServerClient` → mid-session
  manifest mutation → a second turn in the same session → a third turn in a fresh
  session.
- **Lane B** — structurally equivalent to Lane A, differing only in that
  `[features] hooks = true` is absent. It is deliberately *not* byte-identical:
  each lane has its own root, so its capture directory, rendered commands, hook
  hashes and trust stanzas all differ. What is held constant is the manifest's
  shape and event set, not its bytes.
- **Three boundary lanes** — `preSpawn`, `postStart`, `postThread`. Each starts
  with manifest content A on disk while the trust stanza pins content B, and
  swaps A→B at one point in the startup sequence (section 3, E6c).
- **Render check lane** — a second lane root, used only to prove the command
  renderer is a pure function of its descriptor.

Nineteen app-server launches per run, each preceded by a fresh artifact
attestation. The final tree was run three times end to end at ~11s each; every
verdict, including the duration buckets, was identical across them.

### Deviation from the plan's section 5, stated plainly

The plan says S0 "is a reviewed extension of that file" — the checked-in release
gate `scripts/spikes/codex-app-server-hook-probe.mjs`. It is instead a **sibling
module that imports every hardened primitive from that file**: bounded raw
framing, the owned-process-group teardown, the loopback provider, the closed-enum
discipline, and the failure taxonomy.

The reason is concrete, not stylistic. The release gate's `EXPECTED_HOOK_EVENTS`
is a frozen two-event set threaded through its evidence shape, its
CONTINUE/STOP contract, and twenty of its tests. S0 characterizes three events.
Widening that constant would have silently redefined the gate that certifies
PR #52. The gate's contract is asserted unchanged by a test in the new suite, and
the gate was re-run live after the two additive edits below and still returns
`CONTINUE` with zero failed checks.

Two additive edits were made to the shared file, both covered by new tests:

1. `startLoopbackProvider` is exported.
2. A rejected JSON-RPC response now carries its **numeric** `error.code` on the
   rejection. Without it, "the method is not allowed" and "the params shape was
   refused" are indistinguishable, which is exactly what E2 has to separate. The
   peer's `message` and `data` are still discarded with the frame.

## 3. Verified facts

### E1 — the user-layer config object with trust state present · **RESOLVED, favourable**

This was the plan's "single highest-risk unknown". It resolves in favour of the
design.

- **[observed]** With trust state written, the `config/read` **user layer** config
  object is *exactly* the parse of what was written. The probe builds its owned
  config as a JS object model, renders TOML from that same model, and compares the
  canonical-JSON digest of the model against the digest of the returned layer:
  `userLayerEqualsWrittenObjectModel: true`, both with and without trust state.
- **[observed]** No defaults are injected into the layer. Top-level key count is 12
  without trust and 13 with it (`hooks` added); `userLayerUnexpectedTopLevelKeyCount: 0`.
- **[observed]** The layer's `hooks` table contains exactly one key, `state`
  (`userLayerHooksUnexpectedTableKeyCount: 0`). It holds exactly the three
  predeclared entries (`userLayerHooksStateKeysEqualPredeclared: true`), each with
  exactly `{enabled, trusted_hash}` and nothing else.
- **[observed]** The **eleven event arrays** U21 VF5 saw appear only in the
  **effective** config, not in the layer: `effectiveHooksTableKeyCount: 12`
  (`state` plus eleven event arrays) with trust present, `effectiveHooksPresent: false`
  without it. VF5's observation was about the effective config and does not
  threaten the layer digest.
- **[observed]** `userLayerDigestStableAcrossSessions: true` — two independent
  app-server sessions over identical bytes produce the identical layer digest.
- **[observed]** Two layers are returned, of types `user` and `system`
  (`unrecognizedLayerCount: 0`). A consumer comparing "the layer" must select the
  `user` layer by type, not by position.
- **[observed]** Writing the trust stanza changes the owned config file digest
  (`configDigestChangedByTrustRender: true`), confirming U21 VF8's re-pin
  requirement.

**Consequence:** `validateProjectedLayers` comparing the user layer's
`configSha256` against a digest of Polygram's own object model is sound, provided
`buildOwnedConfig` mirrors the rendered TOML exactly. The trusted-rendering
approach is not invalidated.

### E2 — wire params · **RESOLVED**

**[schema]** `HooksListParams` declares one optional property, `cwds: string[]`,
documented as "When empty, defaults to the current session working directory".
There is no required field and no cursor.

**[observed]** Six forms issued against one live session:

| Form sent | Verdict | Entries | Hooks | Entry cwd |
| --- | --- | --- | --- | --- |
| params key **omitted** | **rejected**, JSON-RPC `-32600` (invalid request) | – | – | – |
| `{}` | accepted | 1 | 3 | equals the session cwd |
| `{cwds: []}` | accepted | 1 | 3 | equals the session cwd |
| `{cwds: [ownedCwd]}` | accepted | 1 | 3 | equals the owned cwd |
| `{cwds: [foreignCwd]}` | accepted | 1 | 3 | equals the **requested foreign** cwd |
| `{cwds: [ownedCwd, foreignCwd]}` | accepted | 2 | 6 | one entry per requested cwd |

- Every accepted response's top-level key set is exactly `{data}`
  (`responseKeysAreDataOnly: true`).
- `errors` and `warnings` were empty on every entry in every form.

**Freeze the exact-single-owned-cwd form**, `{"required": ["cwds"], "optional": [],
"stateChanging": false}` with params pinned to `{cwds: [ownedCwd]}`. It is
accepted, it yields exactly one entry, and the omitted form is rejected outright
so the `"params": "omitted"` schema variant is dead.

**One caveat the plan should absorb.** `cwds` does **not** filter which hooks are
returned — the same three user-level hooks came back for a foreign cwd. What it
does is select which cwd each entry is *reported against*, and the response
**echoes the requested cwd back**. So "the projector requires the returned `cwd`
to equal the owned cwd" is a correct pin against a malformed or reordered
response, but it is a tautology when the request named that cwd, and it is not
independent evidence that the response was scoped. Say so in the spec rather than
implying the check proves scoping.

### E3 — cardinality and paging · **NOT CLAIMED**

No paging or cardinality bound is asserted. What was observed: one entry per
requested cwd, three hooks per entry, and a response envelope carrying only
`data`. **[schema]** `HooksListResponse` declares only `data` and no cursor.
Neither observation bounds behaviour at a larger hook count, and this run does not
attempt to.

### E4 — is `[features] hooks = true` required? · **RESOLVED: no**

A/B with the manifest's shape, event set and trust state **structurally**
constant. The two lanes are not byte-identical and cannot be: each lane root
produces its own capture directory, so its commands, hashes and stanzas differ.
What varies deliberately is one table.

| Lane | Hooks listed | All `trusted` after render | Distinct events fired on a turn |
| --- | --- | --- | --- |
| `[features] hooks = true` present | 3 | yes | 3 |
| flag absent | 3 | yes | 3 |

`requiredForDiscovery: false`, `requiredForExecution: false`. This confirms U21
VF1 (`hooks` is a stable, default-on feature) and shows the memsearch installer's
write of that flag is unnecessary.

**Do not render `[features] hooks = true`.** Every stanza rendered has to be
mirrored in `buildOwnedConfig` and moves the owned-config digest; this one buys
nothing.

### E5 — exact `key` derivation · **RESOLVED**

**[observed]** For all three events the key is exactly
`<sourcePath>:<snake_case_event>:<i>:<j>` with `i = j = 0`:

| Event | Snake token | `i` | `j` | Template match |
| --- | --- | --- | --- | --- |
| `SessionStart` | `session_start` | 0 | 0 | yes |
| `UserPromptSubmit` | `user_prompt_submit` | 0 | 0 | yes |
| `Stop` | `stop` | 0 | 0 | yes |

`sourcePath` equalled the manifest path on every entry. `displayOrder` was 0, 1, 2
in manifest declaration order — it is a display ordinal, **not** either key index,
and must not be confused with them. Polygram can predeclare these keys.

### E6 — fire-time vs list-time re-validation · **RESOLVED: neither, and the boundary is `thread/start`**

Three experiments. The first two answer the original question; the third — added
after review pointed out that the first two only bracket the boundary loosely —
locates it.

**(a) Mid-session mutation.** With a live session already running, the manifest
was rewritten so every hook command pointed at a second capture directory. The
next turn in that same session fired **2 hooks from the pre-mutation command**
(`sameSessionAfterMutationOldPathCount: 2`) and **0 from the mutated one**. The
turn completed normally. Verdict: `sameSessionContentSource: 'thread-start-snapshot'`.
(This experiment alone only shows the content was fixed *before* the mutation;
(c) is what locates the fixing point, and the term is named for that result.)

**(b) Fresh session over the mutated manifest.** All three hooks reported
`trustStatus: 'modified'`, **no hook ran at all** (0 captures on either path),
and the turn still completed cleanly.

**(c) Boundary location.** Trust is content-addressed, so only one of two
manifest contents can ever run under a given stanza — which makes a clean
bisection possible. Three lanes each start with content **A** on disk while the
trust stanza pins content **B**, then swap A→B at one point in the startup
sequence. If B runs, the swap beat the snapshot; if nothing runs, A was
snapshotted and is `modified`.

| Swap point | Did the swapped-in content run? |
| --- | --- |
| before `client.start()` (process spawn) | **yes** — control |
| after `start()`/`initialize`, before `thread/start` | **yes** |
| after `thread/start`, before `turn/start` | **no** |

`snapshotBoundary: 'during-thread-start'`, identical across every run. The label
is deliberately narrow: `postStart` swaps after `initialize` and **before the
`thread/start` request**, `postThread` swaps **after the `thread/start`
response**, so the evidence brackets the fixing point *inside* `thread/start`
and claims nothing wider. **The manifest content a session will execute is fixed at `thread/start`,
not at process spawn and not at fire time.**

**This corrects a conclusion the previous revision of this document drew.** It
previously said the window "runs from last attestation to session start, and
per-session-start verification closes it". That is wrong in a way that matters:

- The plan's section 4.6 places its verification "after `initialize` and before
  any `thread/start`" — which is **before** the snapshot, not after it. A
  manifest replaced between the verification response and `thread/start` is the
  copy the session goes on to use.
- What still bounds that window is content-addressed trust, not the
  verification: a swap to content whose hash is not in the stanza is `modified`
  and refuses to run, as experiment (b) shows. The verification call does not
  add a guarantee here; the trust stanza does.
- The exposure that trust does **not** bound is the artifact body. The hash
  binds the command string, which names the recorder's *path* — not the bytes
  at that path. That window runs until the hook actually fires and is not
  closed by anything measured here (section 6).

So: verification before `thread/start` is worth doing — it catches a manifest
that is already wrong — but **it must not be described as closing the race**,
and this document no longer does.

### E7 — real ordering · **RESOLVED; the earlier duration claim is withdrawn**

Two independent pieces of evidence, because one alone would not carry the claim.

**Code ordering (deterministic, `tests/codex-process.test.js`).** A new test drives
`CodexProcess` with a stub client that returns the `turn/start` response and then
withholds `turn/started` until the checkpoint has been observed. It proves the
durable `turn-accepted` checkpoint is awaited **after** the `turn/start` response
is validated and **before** the `turn/started` confirmation is awaited. Reordering
the production code makes the test deadlock rather than merely disagree — see
section 8 for the RED run.

**Live ordering (observed).** Wall-clock readings on one host clock, reported as
closed verdicts and duration buckets; no raw reading is emitted. Ties would
report `ambiguous`; none occurred. Ordering is derived **only** when the turn's
identities all agree — the `turn/start` response id, the `turn/started` id, the
`turn/completed` id, and the `turn_id` on every hook's stdin
(`turnIdentity.allConsistent: true`, gated). Each turn keeps its own record, so
an ordering can never be assembled from two turns' events.

```
thread/start response
  → SessionStart hook
  → turn/start response
  → turn/started notification
  → UserPromptSubmit hook
  → Stop hook
  → turn/completed notification
```

- `sessionStartVsThreadStartResponse: after` — `SessionStart` fires *after* the
  `thread/start` response returns, not during it.
- `turnStartedNotificationVsTurnStartResponse: after`.
- `userPromptSubmitStrictlyBeforeTurnAccepted: false` and
  `stopStrictlyBeforeTurnAccepted: false`. Both hooks fire after the `turn/start`
  response, hence after the point at which the checkpoint is **initiated**.
- Hook stdin `turn_id` equalled the app-server turn id for both
  `UserPromptSubmit` and `Stop`, and `SessionStart` carried **no** `turn_id`. U21
  VF16 and the plan's section 8 negative both hold, now for the exact three-event
  set.

**Withdrawn: the "10–100ms durable budget".** The previous revision of this
document reported that margin. It was measured with a recorder that stamped its
observation *after* draining stdin, so it timed the writer, not the hook's entry.
The recorder now stamps at entry, and the margin was remeasured.

The remeasured margin between the `turn/start` response and the
`UserPromptSubmit` hook is **`10-100ms` in three of five runs and `100ms-1s` in
two**, on an otherwise-idle host against a loopback provider. It is
load-dependent and should be read as *tens to hundreds of milliseconds*, not as
a bound. Do not plan against a specific figure; plan against the ordering fact.

**The ordering fact, stated at the strength the evidence supports.** The live
readings bound the hooks against the checkpoint's *initiation*, not its *durable
completion*. The checkpoint completes when the consuming sink returns, and both
hooks fire within a window of that order of magnitude. So the plan's section 4.8
clause is live rather than hypothetical: a hook **can** fire before the
`turn-accepted` checkpoint is durably usable if the sink is slow. Per section
4.8, **U15 owns it**; U23 is not blocked by it. U15 must not assume the
checkpoint is readable when `UserPromptSubmit` fires, and should fail closed with
a content-free counter, as U21 D3 anticipated.

### Decision 7 — the exact `HookMetadata` instance shape · **RESOLVED, plan is wrong**

**[schema]** Required: `currentHash`, `displayOrder`, `enabled`, `eventName`,
`handlerType`, `isManaged`, `key`, `source`, `sourcePath`, `timeoutSec`,
`trustStatus` — eleven fields. Optional/nullable: `additionalContextLimit`,
`command`, `matcher`, `pluginId`, `statusMessage` — **five**.

**[observed]**, identical on all three hooks in both the untrusted and trusted
inventories:

| Field | Value |
| --- | --- |
| `handlerType` | `command` |
| `source` | `user` |
| `isManaged` | `false` |
| `enabled` | **`true`, including while `trustStatus` is `untrusted`** |
| `timeoutSec` | `600` |
| `displayOrder` | 0, 1, 2 in manifest order |
| `currentHash` | matches `sha256:[a-f0-9]{64}` |
| `sourcePath` | equals the manifest path |
| `command` | byte-equal to the rendered command |
| unknown fields | 0 |
| optional field **keys present** | all five, on every entry |
| optional fields **non-null** | `command` only |

Two corrections fall out, both in section 4 below. The one to flag hardest:
**`enabled` is `true` while the hook is `untrusted` and will not run.** `enabled`
is a configuration flag, not a run predicate. A verifier that checked only
`enabled` would report a healthy manifest for hooks that never execute — the exact
silent-capture-stops failure the plan exists to prevent. Requiring
`trusted` **and** `enabled`, as section 4.6 already does, is correct and must not
be relaxed.

### Decision 8 — `system-runtime` target receipt and command byte stability · **RESOLVED**

**Target receipt, `aarch64-apple-darwin`** (this host's Node v24.4.0, arm64 darwin):

| Property | Value |
| --- | --- |
| `sha256` | `ea82308c4772253263227877abbe298205c5b5d454927300628a63dd71bcb7d5` |
| `nlink` | 1 |
| symlink | no |
| canonical path | yes |
| owner | the invoking user (not root) |
| group/world writable | no |
| owner-executable | yes |
| mode `0700` | **no** — and correctly not required |
| canonical parent chain safe | yes |
| satisfies the `system-runtime` rule | yes |

The `shipped-artifact` receipt for the checked-in recorder is
`bcb6b58c35db1bcbfae395e22f72046f81b949ec0472df84709c206630bc50d7` (nlink 1, not a
symlink, canonical, owner-owned, not group/world writable, safe parent chain,
**not** owner-executable).

Both rules now include the **canonical parent chain**: every ancestor directory
must be owned by root or by the invoking user and must not be group- or
world-writable unless it is sticky. A tight file under a loose directory is not
protected, because the directory permits wholesale replacement of the file. Both
real chains on this host pass; a deliberately `0777` intermediate directory is
rejected by a test.

**Command stability.** The renderer is a pure function of
`{runtime.path, artifacts[].path, argv}` and rendered byte-identically on repeat
(`commandRenderIsDeterministic: true`). A descriptor naming an unattested path
cannot be rendered at all. Reported `currentHash` values were identical across two
independent app-server sessions over unchanged content
(`currentHashStableAcrossSessions: true`), which is the stability property that
actually matters: a rendered `trusted_hash` stays valid across restarts.

Per-event command digests are **not** durable receipts — they include the capture
directory and so are run-scoped. The durable receipts are the two artifact digests
above.

**And a digest pinned once is not a guarantee.** The hook hash binds the command
string, which names the recorder's path rather than its contents, so an artifact
swapped after attestation runs with trust intact. Both pinned artifacts are
therefore re-read and re-compared immediately before **every** child launch
(`appServerLaunchesAttested === appServerLaunchesIntended`, 19 of 19 on the final
run, gated). That closes the window up to
launch and no further — see section 6.

### Decision 9 — do the trust stanza and manifest survive a turn? · **RESOLVED: yes**

Sampled immediately before and immediately after a turn that actually fired all
three hooks: `configDigestUnchangedAcrossTurn: true`,
`hooksManifestDigestUnchangedAcrossTurn: true`. Codex does not rewrite either file
during a turn. The claim is gated on captures existing, so a turn that fired
nothing cannot report vacuous stability.

### Incidental confirmations

- No `hook/*` notification reached the production delivered sink in any lane
  (`deliveredHookMethodCount: 0`), and every turn reached `turn/completed` with an
  assistant item and `faultCategory: 'none'`. PR #52's fix holds for the three-event
  set, not only the gate's two.
- The release gate itself was re-run after the shared-file edits: `CONTINUE`,
  zero failed checks, exit 0.

## 4. Corrections to the amendment plan

Fold these in before the second spec review. Each contradicts a specific
statement. **4.10 and 4.11 were added after the boundary experiment and the
recorder-clock fix; 4.10 replaces a security conclusion this document itself
previously drew.**

1. **§3.1 V5 — `command` is not a required field.** The pinned `HookMetadata`
   lists it as optional and nullable. V5's required set must lose `command`, and
   its optional set becomes five fields.
2. **§4.2.2 — "for the U23 fixture every optional field is expected absent, so the
   map is empty" is false.** All five optional keys are *present* on every entry;
   four are `null` and `command` is non-null. The `expectedOptional` model must
   distinguish **key absent** from **key present with a null value**, or the U23
   fixture fails closed on its own hooks. `command` also needs a defined position:
   it is already covered by the descriptor's `commandSha256`, so it must be
   excluded from `expectedOptional` rather than declared twice.
3. **§4.4 — do not render `[features] hooks = true`.** E4 shows it is required for
   neither discovery nor execution. The plan already conditions it on S0; S0 says no.
4. **§4.1 — freeze `{cwds: [ownedCwd]}` and delete the "omitted" variant.** Omitted
   params is rejected with `-32600`. Add the caveat from E2 that the response
   echoes the requested cwd, so the equality check is a pin, not proof of scoping.
5. **§4.6 — drop `owner-executable` from the `shipped-artifact` rule** for an
   artifact executed *through* an attested runtime. The recorder is passed to Node
   as an argument and needs no exec bit; demanding one would force a pointless
   permission. Keep owner match, no symlink, `nlink === 1`, not group/world
   writable, digest match.
6. **§4.6 residual race — the window ends at `thread/start`, not at session
   start.** A mid-session replacement is not executed, but the boundary sits at
   `thread/start`: content swapped in after `initialize` and before
   `thread/start` *is* the copy the session uses (E6c). Rewrite the window as
   "last attestation → `thread/start`".
7. **§4.8 / E7 — the hook-before-checkpoint race is real; do not attach a
   number to it.** Hooks fire after the `turn/start` response by tens to
   hundreds of milliseconds, load-dependent, against a loopback provider.
   Record the ordering and the race; do not record a budget figure.
8. **§3.1 V14 — the stale-`PATH` hazard is understated by one version.** On this
   host `PATH` now resolves a bare `codex` to **0.147.0**, not 0.146.1. The hazard
   is unchanged; the version in the plan is out of date.
9. **Add a normative statement that `enabled` is not a run predicate.** It is
   `true` on untrusted hooks. Only `trusted` **and** `enabled` means "will run".

10. **§4.6 — verification before `thread/start` does not close the race, and the
    plan must not imply that it does.** The plan places its trust verification
    "after `initialize` and before any `thread/start`". E6c shows the manifest
    snapshot happens *at* `thread/start`, so that verification runs strictly
    inside the window it is meant to close. What actually bounds the window is
    content-addressed trust — a swap to unstanza'd content is `modified` and
    refuses to run. Keep the verification (it catches an already-wrong manifest)
    and restate its guarantee honestly.
10a. **§4.6 — the artifact-body race must be an explicit acceptance in the
    production spec, not an omission.** The hook hash binds the command string,
    which names the artifact's path; the bytes at that path are bound by
    nothing. Prelaunch attestation closes the window up to the app-server
    launch and no further. The spec must either state that the residual
    launch-to-fire window is accepted, or bind the artifact body by some
    mechanism this run does not provide. Silence is not an option, because the
    failure is silent: a swapped body runs with trust intact.
11. **§4.2 — a per-entry harvest of `key` and `currentHash` is unsafe; require an
    exact whole-inventory match first.** The plan's rule 1/2 already demand exact
    one-to-one matching, but an implementation that collects a key and hash per
    entry as it goes will happily harvest them from a foreign, duplicated, or
    tampered entry that carries two well-typed strings. Make it normative that
    **no** trust value is produced unless the entire inventory matched: cardinality,
    per-event uniqueness, key derivation, source path, handler type, source,
    `isManaged`, command digest, hash form, required fields, and zero unknown
    fields. This spike had that defect and it is fixed (section 8.3).

## 5. Unresolved unknowns

Explicitly not measured. None of these blocks U23, but none may be asserted.

- **The Linux target receipt.** S0 ran only on `aarch64-apple-darwin`. The
  `x86_64-unknown-linux-musl` `system-runtime` receipt is unmeasured, so per the
  plan's own rule that target cannot enable hooks until its gate runs.
- **Cardinality and paging at scale.** Section 3, E3.
- **User-layer exactness for config shapes this run did not write.** The object
  model exercised strings, booleans, integers, nested tables, and one inline
  table. Arrays, floats, datetimes, and dotted keys are untested; if
  `buildOwnedConfig` grows one, E1 must be re-measured for that shape.
- **The window between child launch and the moment a hook fires.** Artifacts are
  re-attested immediately before launch, and the manifest is fixed at
  `thread/start`; nothing here measures whether an artifact body swapped after
  that point still executes. It almost certainly does — the hash never bound the
  body — but that is inference, not measurement. Section 6.
- **Whether a manifest can be *un*-trusted mid-session.** E6c swapped validly
  trusted content *in* at three points. The reverse — replacing a running
  session's manifest with content that is trusted under a different stanza — was
  not exercised.
- **Non-`command` handler types.** `prompt` and `agent` exist in the pinned type
  and were not exercised.
- **Populated `matcher` / `pluginId` / `statusMessage`.** All null here, so the
  digest-comparison branch of `expectedOptional` has no live coverage.
- **Whether `hooks/list` requires `initialize` first.** Every session initialized
  before calling it.
- **Any hosted-provider behaviour.** Loopback only, by construction.
- **Hook stdout semantics.** The recorder writes nothing to stdout. Whether a hook
  that *does* write stdout can influence the turn was not probed.

## 6. Residual risks carried forward

- **The checkpoint-durability race** of section 3, E7 — owned by U15.
- **The artifact-body window, which trust does not bind at all.** The hook hash
  binds the command string, and the command string names the recorder's *path*.
  Replacing the bytes at that path leaves the hash, the trust stanza and the
  manifest all valid and changes what executes. This spike closes the window up
  to child launch by re-attesting every pinned artifact immediately beforehand
  (section 8.3), but **nothing measured here closes the window between launch and
  the moment a hook fires**. Any production design must either accept this
  explicitly or bind the artifact body some other way.
- **The manifest window ends at `thread/start`** (E6c), not at spawn and not at
  verification. Bounded by content-addressed trust, not by the verification call.
- Trust is content-addressed over the rendered command string, which embeds
  absolute paths. Any path change (deploy layout, runtime upgrade, capture root)
  invalidates every hash and lands the home in S-drift. This is the plan's
  section 11 operator reprovision, and E5/E6 confirm there is no self-healing path.
- A Codex pin bump may move the key derivation, the hash, or the metadata shape.
  E5's derivation is confirmed for 0.145.0 only.

## 7. Recommendation

**`CONTINUE`.** Proceed to fold these findings into the amendment plan and run the
second multi-agent spec review, with the **twelve** corrections in section 4
applied first. Specifically:

- E1 clears the blocking risk: the trusted-rendering approach survives, and
  `buildOwnedConfig` can mirror the rendered TOML exactly.
- E2 freezes the schema entry as `{cwds: [ownedCwd]}`.
- E4 removes a stanza from both renderings.
- E5 lets Polygram predeclare all three keys.
- E6 **relocates** the residual race: the manifest is fixed at `thread/start`, so
  the verification the plan places before `thread/start` sits inside the window
  rather than closing it. What bounds the window is content-addressed trust.
- E7 confirms the ordering and hands the checkpoint-durability race to U15. It
  does **not** quantify that race: the duration figure from the previous
  revision was a measurement artefact and is withdrawn, and the remeasured
  margin is reported as a load-dependent range, not a budget.

Nothing measured invalidates the design, and E1 — the one unknown that could
have — resolves in its favour. But the corrections are not all cosmetic: 4.10
replaces a security conclusion, and 4.6/4.7 change what the plan may claim about
the residual race.

## 8. Verification evidence

### 8.0 What "CONTINUE" now means, and what it meant before

The probe's gate originally derived `CONTINUE` from one predicate: that no
decision label remained in `unmeasured`. That is a completeness-of-*attempt*
check, not a completeness-of-*evidence* check, and it let an unattested binary,
a credential-free failure, a faulted turn, missing captures, a null enum, a
surviving process or an unremoved scratch root all exit 0.

The gate is now **28 named closed predicates** evaluated over the *projected*
evidence, so a value that collapsed to null in projection fails rather than
reading as a clean absence. `CONTINUE` requires `unmeasured` empty **and**
`failedChecks` empty; both conditions are reported in the envelope, along with
the full `checks` map. Every check name is drawn from a frozen list, so
`failedChecks` cannot carry peer-derived text.

Three of the predicates exist because "the decision was attempted" hid three
different failures: an **unrecognized decision label** used to be filtered out
of `unmeasured` and vanish; **auxiliary lanes** (the fresh session, the
feature-flag control, each boundary lane) used to contribute conclusions without
being held to the characterization lane's bar; and **launch attestation** used
to report success if a single guard had ever run. All three now fail closed.

**Consequence for anything read from an earlier revision of this document:** the
`CONTINUE` results reported before this change were produced under the weaker
gate. They are not evidence that the safety and completeness properties held —
they were simply never tested. Every result quoted in this revision comes from
runs under the 28-check gate, and each is re-stated from those runs rather than
carried over.

### 8.1 Baseline

An initial `npm test` in this worktree failed 8 suites with `EPERM mkdtemp` on
paths under `$HOME`. That run was **invalid setup**, not a failure: the worktree
had no `node_modules`, and the run was additionally sandboxed. Recorded here so it
is not mistaken for a regression.

Valid baseline, after `npm ci` (106 packages), unsandboxed:

```
ℹ tests 1265   ℹ pass 1246   ℹ fail 0   ℹ skipped 19
```

The 19 skips are pre-existing capability gates in `tests/process-contract.test.js`
(`# SKIP channels-protocol N/A`, `# SKIP codex-capability N/A`). The count is
unchanged after this work.

### 8.2 RED → GREEN

Every behaviour change below was driven by a test written first and observed
failing against the unfixed code.

**(a) The `turn-accepted` ordering test.** Characterizing existing production
behaviour, then proven non-tautological by reordering the production code: a
single `await pending.turnReady.promise;` inserted before the checkpoint in
`lib/process/codex-process.js`.

```
RED  ✖ turn-accepted is checkpointed after the turn/start response and before the turn/started await
     AssertionError: turn-accepted must be durable before turn/started is awaited
     + actual 'not-checkpointed'   - expected 'checkpointed'
GREEN ✔ same test (3.9ms)
```

`lib/process/codex-process.js` was restored byte-for-byte (`git diff` empty)
before the green run and is unmodified in the final tree.

**(b) The JSON-RPC error-code carry.** Test-first against the pristine shared probe:

```
RED  ✖ a rejected request carries its numeric code and none of the peer text
     ✖ a rejection without a usable numeric code reports no code rather than a guess
     ℹ pass 0   ℹ fail 2
GREEN ✔ both   ℹ pass 2   ℹ fail 0
```

**(c) The envelope-leakage tests**, proven non-tautological by two mutations of
the projector, each reverted:

```
projectShape made to spread its source →
  RED ✖ the envelope drops unapproved keys at every nesting level
asEnum / asDigest made to pass values through →
  RED ✖ an out-of-enum value becomes null instead of being echoed into the envelope
  RED ✖ a content-bearing envelope is refused rather than printed
```

**(d) The gate, and every hardening below it.** 18 adverse tests were written
against the unfixed spike and observed failing together:

```
ℹ tests 53   ℹ pass 35   ℹ fail 18
✖ a complete, safe measurement is the only thing that reaches CONTINUE
✖ adverse evidence stops the gate instead of exiting clean
✖ every declared gate check is exercised by at least one adverse case
✖ an unmeasured decision and a failed check both stop the gate independently
✖ an exactly matching inventory is trustable and yields one hash per descriptor
✖ an inventory that is not an exact match yields no trustable hash at all
✖ rendering trust from an untrustable inventory is refused before any turn
✖ an unsafe artifact is refused, not merely reported
✖ an artifact under a group-writable parent is unsafe however safe the file is
✖ an artifact swapped after attestation is caught by re-attestation before launch
✖ capture ingestion validates each file before it reads a byte of it
✖ capture ingestion bounds file count and bytes before parsing
✖ a turn whose started id disagrees with its response is reported inconsistent
✖ each turn keeps its own outcome instead of being overwritten by the next
✖ a failed client close fails the lane rather than being absorbed
✖ a child that cannot be proved retired fails the lane
✖ the recorder stamps its observation before it drains stdin
✖ the manifest snapshot boundary is classified from where new content stops running
```

After the fixes: `ℹ tests 65   ℹ pass 65   ℹ fail 0`.

Twenty-one further tests were added across the review rounds that followed, of
which **twenty were observed failing before their fix**: boundary-lane health
and monotonic classification, lane-health predicates, per-turn typed assistant
correlation, the required launch guard, launch-count parity and the frozen
launch count, unrecognized decision labels, fixture-field pinning, the exact
fixture timeout, the exact modified-inventory predicate, the discovery-envelope
validator, the second same-session turn's own record, the fresh-session
inventory, the boundary label, the completion-deadline leak,
absence-vs-observed-false in the ordering booleans, the injected
prevalidation-to-open capture swap, and recorder overflow. The twenty-first — a
symlinked capture — passed on arrival because the pre-existing name check
already caught it; it is kept, and the injected-swap regression that did **not**
pass on arrival is what covers the actual race.

**38 adverse tests in total were written before their fix and observed
failing** (18 in the first round, 20 across the later ones).

The adverse table drives **67 distinct evidence mutations** through the gate, each
asserting both `gate === 'STOP'` and the specific named check. A further test
asserts that **every** declared check is covered by at least one adverse case, so
a check that could never fire cannot be added silently.

Two tests changed meaning as a result and were updated deliberately, not
loosened: the single-entry inventory case now asserts `trustable: false` and an
empty trust list (it previously asserted a harvested hash), and the
unapproved-key leakage case now injects its sentinel into an otherwise-complete
entry so it tests leakage rather than incidentally tripping completeness.

### 8.3 Defects found and fixed

Thirteen, all in this spike's own code, all found by review or by the new gate.

1. **E7 compared two different turns.** `runTurn` reused one set of timing slots,
   so the second turn overwrote the first turn's readings. Fixed by keeping a
   record per turn; the reported ordering changed as a result.
2. **The response id was compared against the wrong notification.**
   `turnStartResponseMatchesStarted` was computed from the `turn/completed` id, so
   a turn whose `turn/started` disagreed with its response reported as consistent.
   Now the response is compared against `turn/started` and `turn/completed`
   separately, and ordering is only derived when both agree and every hook's
   `turn_id` matches.
3. **The recorder stamped its observation after draining stdin**, timing the
   writer rather than the hook's entry and inflating every derived margin. The
   stamp moved to process entry; the margin was remeasured and the earlier
   "10–100ms" claim withdrawn (E7).
4. **Trust values were harvested per entry.** `splitHookInventory` collected a key
   and hash from any entry carrying two well-typed strings, so a foreign,
   duplicated or tampered hook could contribute a trust stanza. It now produces
   trust values **only** when the whole inventory is an exact one-to-one match,
   and `trustStateFromInventory` is the single path from inventory to stanza —
   it throws otherwise, before any turn runs.
5. **Attestation described rather than enforced.** `attestArtifact` reported
   `satisfiesKindRule` and no caller checked it. There is now an enforcing
   `attestArtifactStrict`, the rule includes the canonical **parent chain**
   (every ancestor owned by root or self and not group/world-writable unless
   sticky), and `verifyPinnedArtifacts` re-reads both artifacts immediately
   before every **app-server** launch — because the hook hash binds the
   command's *path*, not the bytes at it. This is prelaunch attestation of the
   app-server, not of the hook subprocess: the artifact-body window between
   launch and hook fire stays open (section 6).
6. **Cleanup and capture ingestion were weak.** Client-close failure is now a
   lane failure with its own `closeClean` fact; child retirement is proved
   against the client's **pid and process group** with SIGKILL escalation rather
   than a command-text match; and capture files are validated for name pattern,
   regular-file type, no symlink, `nlink === 1`, owner, mode `0600`, file count,
   per-file bytes and aggregate bytes **before** any byte is read.

7. **Auxiliary lanes voted without being checked.** The boundary lanes, the
   fresh session and the feature-flag control fed conclusions on the strength of
   "it did not throw". A lane that faulted also produces no captures, which is
   indistinguishable from "the swapped-in content did not run" — so the boundary
   could have been mis-located by a broken lane. Every production lane now has
   to clear the same bar (completed, identity-consistent, assistant-producing,
   fault-free, clean close, child retired), and a boundary lane that fails it
   abstains rather than voting.
8. **Launch attestation reported presence, not parity.** The fact was
   `reattestations > 0`, and one helper (`measureParamForms`) was never guarded
   at all. Every app-server launch helper now requires its guard as an argument
   — an unguarded call throws rather than launching — and the emitted fact is
   `intended === attested` with both counted centrally. On the final run that is
   **19 of 19**. The name was also narrowed: this is *app-server prelaunch*
   attestation, and it says nothing about the window between launch and the
   moment a hook fires.
9. **The whitelist pinned identity but not the fields that decide execution.**
   Nonzero key indices, an unexpected `trustStatus`, `enabled: false`, a wrong
   `displayOrder`, a non-integer timeout, or a populated `matcher` /
   `pluginId` / `statusMessage` / `additionalContextLimit` all passed. A hook
   that will not run is not a hook whose hash should be rendered into a trust
   stanza, so every fixture-defining field — including the exact
   present-but-null optional shape — is now pinned before an inventory is
   trustable.
10. **Capture validation re-resolved the path it had checked.** An `lstat`
    followed by `readFileSync` of the same name is a race. Each capture is now
    opened once with `O_NOFOLLOW`, validated by `fstat` **on that descriptor**
    (type, `nlink`, owner, mode, size) and read from it. A regression injects a
    swap between the name check and the open.
11. **The recorder accepted a valid prefix of an oversized payload.** On
    exceeding its 256 KiB bound it destroyed stdin and returned what it had
    already buffered, so a well-formed opening object followed by an arbitrary
    tail parsed cleanly and yielded a turn id. Overflow is now tracked and the
    payload rejected whole.
12. **A completed turn left its 45-second deadline armed.** `wait(...).then(throw)`
    cannot be cancelled, so every successful turn held a live timer that kept
    the event loop alive until it fired. Natural exit was *delayed* by roughly
    the deadline, not prevented. The deadline is now cancellable and cancelled
    in a `finally`; a regression drives a stub session in a child process and
    asserts prompt natural exit. Wall clock per live run went from ~52s to ~11s.
13. **Absence read as an observed `false`.** The two
    `…StrictlyBeforeTurnAccepted` booleans projected through `asBool`, so a
    missing value became `false` and passed the completeness check. They are
    nullable now, and the check demands an actual boolean.

The credential-free reader defect from the previous revision also stands: the
release gate's reader matches a bare TOML key while this rendering quotes every
key, so `providerRequiresAuth` silently returned `null`. A quoted-key-tolerant
reader was added, and the gate now **fails** on a null rather than reporting it.

**The new gate immediately earned its keep.** The first live run under it
returned `STOP` with `failedChecks: ['snapshotBoundaryLocated']` — the boundary
experiment's control lane had not run, because `manifestB` was read *after*
re-provisioning had already overwritten it, making the swap a no-op. Under the
old gate that run would have exited 0 with a null boundary.

### 8.4 Focused test runs

```
<node> --test --test-concurrency=1 tests/codex-hook-trust-s0.test.js
  ℹ tests 75   ℹ pass 75   ℹ fail 0   ℹ skipped 0
```

Run under **two different runtimes** — the repo shell's ordinary `node` (26.5,
installed under a group-writable prefix) and the pinned safe runtime (24.4.0
under an owner-only chain) — and the TAP output was compared line for line:
**identical results line for line, 0 `not ok` in either.**

That comparison exists because an earlier revision of this suite asserted that
the *ambient* `process.execPath` satisfies the `system-runtime` rule. It does
not, on a machine whose `node` sits under a group-writable prefix — and it
should not; the rule is working. The suite now attests controlled fixtures
(a root-owned shared binary, an owner-owned one under a verified-safe chain, and
one under a deliberately group-writable prefix) instead of whatever runtime
happens to be executing it. **The strict ambient check stays where it belongs:
the live probe, via `--runtime`.**

Run **without** `--test-force-exit`. `tests/codex-hook-trust-s0.test.js`,
`tests/codex-process.test.js` and `tests/codex-hook-probe.test.js` each exit 0
without it, so no new handle leak was introduced and none is being concealed.
The whole-repo `npm test` in 8.5 retains the repository's standard force-exit;
these focused runs are what make the leak claim testable.

### 8.5 Full suite

```
npm test   (node --test --test-force-exit --test-concurrency=1 tests/*.test.js)
  ℹ tests 1343   ℹ suites 69   ℹ pass 1324   ℹ fail 0   ℹ skipped 19
```

Run under both runtimes — the repo shell's ordinary `node` and the pinned safe
one — with identical totals. Net change from baseline: +78 tests, +78 passing,
skips unchanged at 19. This invocation keeps the repository's standard
`--test-force-exit`; the changed suites are additionally run without it (8.7).

**One flake, pre-existing, not introduced here.** `tests/codex-hook-probe.test.js`
→ "the raw session fails closed on malformed bytes that arrive during teardown"
failed once during an intermediate run
(`assert.ok(error, 'teardown-time garbage must fail the session')`, actual `null`).
It is a load-dependent timing test: it spawns a grandchild that writes to an
inherited stdout ~250ms after its parent exits. Characterized deliberately:

- current tree, 20 sequential repetitions → **0 failures**
- **pristine** shared probe (edits stashed), 20 repetitions in parallel → **1 failure**
- pristine, 10 sequential repetitions → 0 failures

It reproduces without these changes and only under parallel load, so it is a
pre-existing flake in that test's timing assumption, not a regression. It is not
fixed here — out of S0's scope — but it is on the record, and it is the reason
the suite figure above is quoted from two clean consecutive runs rather than one.

### 8.6 Live probe

Under the 28-check gate, against the pinned 0.145.0 binary on Darwin:

```
gate: CONTINUE   unmeasured: []   failedChecks: []   exit 0   stderr empty
```

Invoked with an explicitly pinned safe runtime:

```sh
/absolute/safe/node scripts/spikes/codex-hook-trust-s0.mjs \
  --binary /absolute/versioned/path/to/codex \
  --probe-root /absolute/non-temporary/probe-root \
  --runtime /absolute/safe/node
```

Three consecutive passing runs on the final tree, each **~11s** wall clock, with
**19 of 19** app-server launches prelaunch-attested against a frozen expected
count. Every verdict identical
across them, including the duration buckets. Digests differ by construction,
since the rendered command embeds a per-run capture directory.

Earlier revisions of this run took ~52s. The difference was a leaked 45-second
completion deadline (8.3), not measurement: a successful turn left its timer
armed, so the event loop stayed alive until that timer fired. The run still
exited naturally — it was delayed by roughly the deadline, not prevented from
exiting.

The release gate `scripts/spikes/codex-app-server-hook-probe.mjs` was re-run after
the shared-file edits: `gate: CONTINUE`, `failedChecks: []`, exit 0.

### 8.7 Process cleanup

Three independent facts, all gated:

- `closeClean: true` — the production client's `close()` returned without error;
  a failure now fails the lane rather than being absorbed.
- `childRetired: true` — the client's own child **pid** was probed with
  `kill(pid, 0)` and its **process group** enumerated until empty, with a
  `SIGKILL` escalation to the group. This is structural, not a command-text match.
- `strayProcessCount: 0` — a final sweep of the process table found nothing
  referencing the probe root.

`probeRootRemoved: true`, and the supplied probe root was verified empty by
directory listing after every run.

**Where force-exit is and is not used.** The live probe uses none: it exits on
its own once its deadlines are cancelled and its children are retired. Neither
do the changed suites — `tests/codex-hook-trust-s0.test.js`,
`tests/codex-process.test.js` and `tests/codex-hook-probe.test.js` each exit 0
when run **without** `--test-force-exit`, which is what makes the leak claim
mean anything. The whole-repo `npm test` keeps the repository's standard
`--test-force-exit`; that predates this work and is unchanged by it, which is
precisely why the changed suites are also run without it.

## 9. Changed paths

| Path | Change |
| --- | --- |
| `scripts/spikes/codex-hook-trust-s0.mjs` | **new** — the S0 characterization, its 28-check gate, and the hardening in 8.3 |
| `scripts/spikes/u23-hook-recorder.mjs` | **new** — checked-in content-free Node hook recorder |
| `tests/codex-hook-trust-s0.test.js` | **new** — 75 focused tests, including 67 adverse gate mutations |
| `scripts/spikes/codex-app-server-hook-probe.mjs` | modified — export `startLoopbackProvider`; carry the numeric JSON-RPC error code on a rejection (+11 / −3) |
| `tests/codex-hook-probe.test.js` | modified — 2 tests for the error-code carry |
| `tests/codex-process.test.js` | modified — 1 test pinning the `turn-accepted` ordering |
| `docs/2026-08-17-001-u23-hook-trust-characterization-findings.md` | **new** — this document |

The runtime is itself an attested artifact, so the documented invocation accepts
`--runtime /absolute/path/to/node`. A package-manager-installed Node commonly
sits under a group-writable prefix and is correctly refused by the strict
attestation; pass a runtime whose canonical parent chain is owned by root or the
invoking user and is not group- or world-writable. The invoking runtime is the
default, never a requirement.

Not touched: `lib/codex/protocol-schema.json`, any production `lib/` source,
`package.json`, `package-lock.json`, any release worktree. Nothing committed,
tagged, pushed, published, or deployed. `node_modules/` was installed via `npm ci`
and is untracked. `lib/process/codex-process.js` was temporarily edited to
demonstrate a RED and restored byte-for-byte; it carries no change in the final
tree.

Receipts from the final run (`aarch64-apple-darwin`, Node v24.4.0):
`system-runtime` `ea82308c4772253263227877abbe298205c5b5d454927300628a63dd71bcb7d5`,
`shipped-artifact` `bcb6b58c35db1bcbfae395e22f72046f81b949ec0472df84709c206630bc50d7`.

---

STATUS: DONE
WHAT: Ran the bounded U23 S0 characterization on pinned Codex 0.145.0 (Darwin, credential-free, loopback-only) and repaired it across five independent review rounds. CONTINUE is now 28 closed completeness/safety predicates rather than "no decision left unattempted"; trust values come only from an exact whole-inventory match that pins every fixture-defining field; artifact attestation is enforcing, covers the canonical parent chain, and re-runs before every one of the 19 app-server launches (parity-counted, not presence-counted); client-close failure, pid/pgid retirement and auxiliary-lane health all fail the lane; capture files are opened O_NOFOLLOW and validated on the descriptor they are read from; the recorder stamps its clock at entry and rejects an overflowed payload whole; per-turn identity and a typed, turn-correlated agentMessage gate the ordering; a completed turn cancels its deadline (run wall clock 52s → 11s); and a bounded three-lane experiment locates the manifest snapshot at thread/start. 38 adverse tests were written first and observed failing; 67 evidence mutations drive the gate. Full suite 1343 tests / 1324 pass / 0 fail / 19 pre-existing skips under both the ordinary repo runtime and a pinned safe one; focused 75/75 identical across both; three consecutive live runs CONTINUE with 28/28 checks and 19/19 prelaunch-attested launches.
NEED: Nothing to unblock S0. Two conclusions changed from earlier revisions and must be read before the design is written: verification before thread/start does NOT close the manifest race (section 4.10), and the "10-100ms durable budget" figure is withdrawn as a measurement artefact (section 3, E7). Twelve plan corrections in section 4 still need folding in. The x86_64-unknown-linux-musl runtime receipt still has to be measured on the VPS. The window between child launch and hook fire remains open and unmeasured (section 6) — the hook hash never bound the artifact body.
NEXT: Fold sections 3-6 into `docs/plans/2026-08-16-002-feat-codex-hook-trust-discovery-plan.md`, re-run the multi-agent spec review, then open the Orchestra PR for the local-manifest hook verification request with the frozen `{cwds: [ownedCwd]}` params form.
