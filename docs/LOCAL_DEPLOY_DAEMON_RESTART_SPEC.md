# Local daemon-owned deploy restart

Status: REVIEWED DRAFT 2026-08-05 — release-blocking amendment discovered
during the 0.38.x preflight. Independent launchd, scope, and failure/security
reviewers passed the revised design after their must-fixes were incorporated.
Implementation and production activation require Ivan's explicit alignment.

Scope: Polygram's content-free daemon identity and IPC readiness contract, the
canonical `polygram-deploy` skill, the local shumorobot launchd contract,
Polygram's launchd example, and the matching host documentation. The reviewed
active-turn retirement behavior is unchanged; only its lifecycle metadata and
release/activation path are extended. Background-work preservation remains
postponed.

## Problem

The deploy-survival runtime authorizes continuation only when the running
daemon accepts an authenticated `deploy_restart` IPC request. The VPS half of
the canonical release helper uses that path and verifies request-bound
lifecycle evidence. The local half does not: after mutating the live global npm
tree it runs `launchctl kickstart -k`, which stops the old process externally.
That path never authorizes continuation.

The loaded shumorobot plist adds a second incompatibility. Its `KeepAlive`
dictionary has `Crashed=true` and `SuccessfulExit=false`. Under
`launchd.plist(5)`, that restarts only after an unsuccessful exit. Polygram's
accepted deploy restart exits zero, so launchd will not create its replacement.

The first draft assumed the existing systemd lifecycle identity could prove a
local replacement. It cannot. `invocation_id` comes only from systemd's
`INVOCATION_ID`; launchd does not provide one, and production launchd lifecycle
rows therefore have no invocation identity. It also assumed a zero-busy sample
was an admission barrier and that an in-place npm install could not affect the
old process. Neither is true: busy is advisory, and the old daemon may resolve
later-spawned bridge or supervisor files after npm has changed them on disk.

## Goals and invariants

- A routine local deploy is authorized by the old daemon exactly once; no
  external signal or launchctl kill is used.
- The old daemon closes admission and persists any eligible foreground
  continuation intent before it exits.
- launchd owns replacement after a clean exit through unconditional
  `KeepAlive=true`.
- Installing a candidate package never mutates the running daemon's release
  tree.
- Every boot has a content-free identity that can be joined across launchd,
  authenticated IPC, the PID file, and lifecycle rows.
- Any missing or malformed restart acknowledgement is ambiguous. The helper
  never retries it and reconciles only the original request.
- Success is bounded by a fixed event high-water mark and a final live witness;
  a later replacement cannot hide behind an earlier valid start.
- Local release and foreground Claude/Codex canaries finish before any partner
  VPS package mutation.
- Validation reads lifecycle fields, counts, and identities only. It never
  selects or prints message bodies, session keys, provider thread/turn IDs, or
  event paths.
- VPS service ordering and Water/tmux isolation remain unchanged.

## Chosen design

### 1. Give every daemon boot a durable process identity

Generate one random UUID `daemon_instance_id` before database or IPC startup.
Record it and `process.pid` on `polygram-start`, `shutdown-drain`,
`polygram-stop`, and `polygram-admission-open`. Keep systemd's existing
32-hex `invocation_id` as an additional supervisor identity; do not redefine or
fake it on macOS.

Add an authenticated, read-only IPC identity operation returning only:

```json
{
  "bot": "shumorobot",
  "pid": 12345,
  "daemon_instance_id": "<uuid>",
  "package_version": "0.38.1",
  "main_realpath_sha256": "<sha256>"
}
```

The unauthenticated `ping` remains a liveness probe for compatibility but is
not deployment proof. The helper accepts readiness only when the authenticated
identity matches the launchd PID, owner PID file, bot name, and lifecycle
instance. The version and real-main-path hash bind the process to the expected
immutable release without returning or printing a filesystem path. Instance
IDs and hashes may be compared internally; normal success output is counts and
booleans.

### 2. Install immutable, versioned local release trees

Move local deployment ownership from an npm-mutated global package to a
versioned runtime root, on one filesystem:

```text
~/.local/share/polygram/runtime/
  releases/<version>/          # npm global-style prefix; immutable after use
  current -> releases/<version>
  deploy-state.json            # 0600, content-free recovery journal
```

Use the exact Node binary in the trusted plist and its sibling npm to install
the registry package into a fresh temporary prefix under `releases/`. Rebuild
and load `better-sqlite3`, verify Polygram's exact version, verify the exact
Orchestra pin and installed resolution/integrity, then rename the completed
tree into place. A candidate is never launched from a partial directory.

The plist runs Node with
`runtime/current/lib/node_modules/polygram/polygram.js`. Node's normal
non-`--preserve-symlinks-main` resolution binds the process and its `__dirname`
derived child artifacts to the real versioned release. Atomically changing the
`current` symlink therefore changes the next boot without changing the old
daemon's code or later child paths. Retain at least the immediately previous
release tree; garbage collection is outside this change.

Do not rely on that default implicitly. The plist and effective launchd
environment must exclude `NODE_OPTIONS` values that enable
`--preserve-symlinks` or `--preserve-symlinks-main`, and authenticated identity
must return the SHA-256 of the daemon's real main-module path for comparison to
the staged release. `runtime/current`, its target, and every
`releases/<version>` component must resolve inside the owner-controlled runtime
root. A release destination must be a real directory, never a symlink. If the
version already exists, reuse it only after its recorded registry integrity and
installed tree fully reverify; otherwise fail without overwriting it.

The helper writes a 0600 content-free transaction journal before switching
`current`. It records version/integrity, old PID and instance, event cursors,
restart request ID, and the last completed phase. It contains no chat/session
identity. A rerun resumes or reconciles the recorded transaction; it never
generates a second request after the dispatch boundary.

Rollback is deliberately bounded:

- Before a restart request is dispatched, the helper may atomically restore
  the previous `current` target; the live process was never changed.
- After dispatch, it never starts the previous release automatically. The new
  process may have committed a database migration. Polygram migrations are
  transactional, but a committed higher schema is not proof that old code is
  compatible. Recovery is roll-forward to the fully verified candidate unless
  an operator separately proves schema compatibility and authorizes rollback.
- A failed staging install leaves the old tree, symlink, loaded job, and daemon
  untouched. A failed new boot leaves the previous tree retained and fails
  loudly with the journal preserved.

### 3. Validate the exact launchd contract before mutation

The canonical local job is exactly
`gui/<uid>/com.polygram.shumorobot`, loaded from exactly
`~/Library/LaunchAgents/com.polygram.shumorobot.plist`. Overrides are allowed
only if every derived object still agrees; a caller cannot provide a plist and
silently target the hard-coded canonical label.

Before staging or switching a release, require all of the following:

- plist `Label` is the target label;
- `ProgramArguments` is exactly Node, the stable `current` entry, `--bot`, and
  `shumorobot`, with no extra or unhandled `--db` argument;
- `WorkingDirectory` is the expected `~/.polygram` data directory;
- the Node realpath and npm realpath belong to the same installation prefix;
- the loaded launchd job path, program, complete arguments, and working
  directory equal the plist;
- launchd's positive PID equals the PID file and authenticated IPC identity;
- the installed stable target is a complete verified release; and
- routine steady-state deployment sees effective unconditional KeepAlive.

Revalidate the same contract after replacement. Plist parsing and launchctl
output parsing must be bounded and fail closed; raw job output, IPC paths, and
secrets are never echoed.

These are the steady-state pre-mutation requirements. The one-time activation
cannot satisfy them before reload because its live definition intentionally is
the legacy global-tree/crash-only job. Section 5 defines the only allowed
transition contract; routine mode must reject it.

### 4. Routine local deploy transaction

The steady-state transaction is:

1. Verify the exact loaded launchd/runtime contract and authenticated old
   identity. Treat the aggregate busy count as advisory scheduling only.
2. Capture the old instance/PID and a safe lifecycle cursor.
3. Stage and completely validate the new immutable release.
4. Persist the transaction journal, then atomically switch `current`.
5. Generate one restart UUID, persist `dispatch-possible` before any socket
   call, and call authenticated `deploy_restart` once.
6. Accept an acknowledgement only if it echoes that request and the captured
   old PID. Treat handler rejection, timeout, cut socket, or malformed output
   alike as ambiguous; do not retry.
7. Reconcile the original request while launchd creates a different positive
   PID. Require the new authenticated instance, PID file, and launchd PID to
   agree.
8. After admission opens, capture a fixed upper event cursor. Between the two
   cursors require exactly one ordered authorized drain, old stop, new start,
   and new admission for the expected request/instances. Reject any second
   start, stop, or admission in that bounded interval.
9. Perform a final witness after verification: reread launchd PID and loaded
   definition, PID file, authenticated IPC identity, `current` target, and the
   database cursor. Any later lifecycle transition invalidates success.

Only then mark the journal complete. A proof miss leaves it available for
bounded diagnosis/recovery and blocks every later rollout phase.

### 5. One-time migration from the current crash-only/global job

The currently running Polygram 0.37.2 daemon has neither `daemon_instance_id` nor
the corrected active-turn retirement order. No procedure can retroactively
give that process those guarantees. The one-time boundary is therefore an
explicit, operator-approved compatibility activation, not a claimed smooth
deploy.

The activation sequence is:

1. Enter transition mode only when every legacy predicate matches: no prior
   activation receipt exists; the installed package is exactly 0.37.2; the
   loaded job has the canonical label and plist path, exact old NVM global
   entry, exact `--bot shumorobot` argv and working directory, positive launchd
   PID equal to the PID file, authenticated legacy IPC, and the exact
   crash-only `Crashed=true`/`SuccessfulExit=false` definition. Persist this
   one-time eligibility in the journal. Any mismatch fails closed.
2. Stage and validate the first versioned release and a temporary new plist
   completely. Record the exact legacy canonical-plist fingerprint and retain
   that file for abort recovery; do not change the loaded definition or stable
   target yet.
3. Confirm an operator-coordinated quiet window. The zero-busy sample reduces
   risk but is explicitly not called an admission fence; a turn admitted before
   the old daemon receives IPC could still be interrupted by the old bug.
4. Capture the old launchd PID/cursor and persist the recovery journal. Switch
   `current` to the complete candidate and reverify it, atomically replace the
   canonical plist with the validated file, and journal
   `new-plist-on-disk/legacy-definition-loaded`. Bootstrap later uses only that
   canonical path, never the temporary path. Then cross `dispatch-possible` and
   issue the old daemon's authenticated `deploy_restart` once. Its
   acknowledgement PID and request ID bind the old side; the old lifecycle rows
   are accepted without a nonexistent instance ID only in this transition mode.
5. Once the captured old PID is confirmed gone, restore availability even if
   its lifecycle qualification failed: `bootout` only the confirmed-stopped
   legacy definition and `bootstrap` the canonical validated
   unconditional-KeepAlive plist. Never bootout a live daemon. An invalid or
   missing old lifecycle proof still marks activation failed, preserves the
   journal, and blocks all canaries/VPS; it does not leave the bot down.
6. Require the new package's instance ID, launchd/PID-file/authenticated-IPC
   agreement, admission, exact loaded definition, and fixed-upper-cursor proof.
7. Immediately exercise a zero-work authenticated restart under the new code.
   A second distinct instance/PID and exact lifecycle proof are the behavioral
   evidence that clean KeepAlive replacement works; `launchctl print` alone is
   not accepted as KeepAlive proof.

There is an unavoidable one-time helper-owned availability gap after the old
clean stop and before the new plist is bootstrapped. Recovery examines four
journaled states: old canonical plist/old loaded definition; new canonical
plist/old loaded definition; stopped legacy definition; and already bootstrapped
new definition. If the helper dies in the gap, rerunning activation completes
`bootout`/`bootstrap` without resending IPC. Availability recovery is independent
of release qualification. The runbook also records the exact manual bootstrap
recovery. This residual risk must be accepted before activation.

Persisting `dispatch-possible` necessarily creates a smaller uncertainty
window: the helper may die after the durable write but before the socket send.
On rerun, if the exact old PID is still alive and no matching lifecycle appears
after bounded observation, stop in `dispatch-uncertain/no-effect`. Do not send.
An operator must explicitly authorize aborting that transaction: verify the
same old legacy witness, atomically restore the exact fingerprinted legacy
canonical plist and pre-transaction `current` state, revalidate that the loaded
job still matches it, retire the journal as no-effect, then start a new
transaction with a new request. This is the only allowed second attempt, and
the audit retains both request IDs.

After the new zero-work KeepAlive proof, atomically write a permanent activation
receipt containing the new package/integrity and instance proof. Transition
mode requires the receipt to be absent and becomes unreachable once it exists;
later malformed or fieldless lifecycle rows can never re-enable the legacy
verifier.

### 6. Split local qualification from partner VPS rollout

Replace the all-in-one production mutation with explicit phases:

- `--local-only`: verify/publish the exact release if needed, stage it, activate
  or routinely restart shumorobot, and record the local lifecycle proof. It
  cannot mutate the VPS.
- local foreground canary mode: bind a configured chat name, selected provider,
  package version, event baseline, daemon instance, and restart request. It
  waits for the intended active foreground turn, performs the same one-shot
  restart, and writes a 0600 content-free pass receipt only after one eligible
  snapshot, one intent, one claim, exact attestation, one successful logical
  continuation, and zero fallback/replay notices. It prints booleans and
  counts, not identifiers or bodies.
- aged-warm Codex canary mode: write a distinct same-version receipt only when
  metadata binds an unrelated Codex generation that was continuously warm and
  idle for at least six hours, had no active turn or background ownership, and
  was retired while a second exact Codex session passed foreground
  continuation.
- `--vps-only`: require the exact published version plus same-version passing
  local Claude, foreground Codex, and aged-warm Codex receipts before checking
  the split-owner topology or mutating the shared VPS tree. Then retain the
  existing Shumabit-first,
  UMI-Assistant-second daemon-owned IPC flow and Water/tmux invariants.

The active-turn design's aged-warm-session canary remains a release
qualification: an unrelated Codex session must have been warm and idle for at
least six hours while a second session is the foreground continuation target.
If that gate is not yet mature, the local release may remain installed for the
observation window, but the partner VPS phase remains blocked.

### 7. Release integration

Orchestra 0.10.15 is already published from reviewed main through the signed
tag and GitHub OIDC. Integrate the Polygram implementation onto current 0.38.0
main, preserve the unrelated rich-text changes, and release the next patch.
Install Orchestra from the clean registry, verify the exact manifest/lockfile
resolution and integrity, then run both full suites before tagging Polygram.

## Alternatives rejected

- **Keep `launchctl kickstart -k`:** it bypasses deploy authorization and is the
  local interruption path being fixed.
- **Use the zero-busy sample as an activation gate:** a message can be admitted
  after the sample. Only daemon-owned admission closure is a correctness fence.
- **Mutate the current global npm tree after closing admission:** this narrows
  the race but still couples package integrity and recovery to a live tree;
  versioned staging is simpler to prove and retains a known-good artifact.
- **Retain the crash-only plist and have the helper start the replacement:** a
  helper crash after clean exit leaves the service down on every deploy.
- **Exit nonzero for intentional deploys:** it falsifies crash classification
  and conflates deliberate continuation authorization with failure.
- **Reload a live launchd job:** bootout/kickstart is an external stop and can
  interrupt a newly admitted turn. Reload is limited to the already-stopped
  one-time transition.
- **Spawn launchctl from Polygram:** application code should not replace its
  supervisor or own host-specific service definitions.
- **Trust unauthenticated ping or the first matching admission:** neither binds
  socket ownership to the launchd process, and a later crash/restart can create
  a false pass.
- **Retry only selected IPC failures:** today's client cannot prove whether a
  rejected-looking transport outcome reached the daemon. Treating every
  unvalidated acknowledgement as ambiguous gives one safe rule.

## Failure modes and recovery

- Contract mismatch before mutation: fail without staging or changing state.
- Candidate install/native/dependency verification failure: remove only the
  never-activated temporary prefix; the old immutable daemon remains owner.
- Helper death before IPC dispatch: old daemon remains active; journaled rerun
  stops at the dispatch-uncertain/no-effect gate if the durable boundary was
  crossed; only explicit operator abort may retire it and permit a new request.
- Any unvalidated IPC acknowledgement: never retry; reconcile the stored
  request, old instance/PID, and lifecycle.
- Old daemon remains alive without the exact authorized drain: fail with the
  old owner in place.
- Routine old daemon exits but no new launchd PID appears: fail loud and retain
  the journal; diagnose/repair forward from the verified release.
- One-time helper dies after old stop: bot is down until journal recovery
  completes bootstrap; never issue a second restart request.
- Legacy old PID exits with invalid lifecycle proof: bootstrap the already
  validated new job for availability, preserve the failed qualification, and
  block canaries/VPS.
- New daemon boot-loops or never admits: do not automatically roll back across
  a possibly committed schema migration. Stop rollout and repair/roll forward;
  an old-release rollback requires separate schema proof and approval.
- Replacement PID, PID file, authenticated identity, release target, loaded
  definition, or lifecycle disagree: fail and block VPS.
- A second lifecycle transition occurs before the final witness: invalidate the
  earlier proof and fail.
- Any retirement/ingress uncertainty remains crash-like with zero usable
  intents, as specified by the active-turn design.

## Test and verification plan

All behavior-changing bug tests are written first and observed failing against
the unfixed sources, then passing after the implementation.

1. Daemon identity tests prove one valid per-boot UUID/PID is present on all
   four lifecycle events, systemd invocation identity remains unchanged, and
   authenticated IPC identity rejects missing/bad secrets.
2. Shell contract tests reject local `kickstart -k`, in-place global install,
   incomplete plist/loaded-job matches, mismatched PID witnesses, unverified
   dependencies, a second restart request, and VPS mutation before local gates.
3. Staging tests cover partial install, native load failure, atomic switch,
   previous-tree retention, helper death before/after switch, and no mutation
   of the old real release path. Reject path/symlink escape, a release symlink,
   mismatched reused integrity/tree, and symlink-altering `NODE_OPTIONS`; an old
   probe resolving a bridge/supervisor after `current` flips must remain in its
   old real tree.
4. Journal tests cover every dispatch boundary, ambiguous response recovery,
   helper death between one-time stop/bootstrap, and idempotent bootstrap
   completion without IPC retry. They also cover the
   dispatch-possible-before-send death window and explicit no-effect abort.
5. Lifecycle verifier tests use a fixed upper cursor and reject wrong request,
   wrong old/new instance, duplicate start/admission, a second replacement
   before proof, or any later transition before the final witness.
6. Plist tests require unconditional `KeepAlive=true`; `plutil -lint` passes.
   Definition fixtures cover exact label/path/program/full argv/cwd matching.
7. Canary-verifier tests prove provider/name/request/version binding, one
   logical success, zero notices, and content-free output for Claude and Codex.
   A separate receipt test requires the unrelated generation's six-hour age,
   continuous idle state, zero active/background ownership, and same-version
   foreground Codex proof; `--vps-only` rejects its absence.
8. Full shared-skill tests, `bash -n`, Node syntax checks, and shared-skill
   frontmatter validation pass with every skip reported.
9. Polygram and Orchestra full suites pass after current-main integration and
   exact registry dependency installation, with every skip reported.
10. One-time activation and immediate zero-work restart both pass their
    bounded lifecycle/final-witness checks. A fixture where the old process
    exits after an invalid drain still restores availability while failing
    qualification, and transition mode cannot be re-entered after its permanent
    receipt.
11. Foreground local Claude, Codex, and aged-warm Codex canaries pass before
    `--vps-only` can mutate either partner package tree.
12. Shumabit and UMI Assistant then pass their existing ordered proofs while
    Water and every protected tmux owner remain unchanged.

## Definition of done

- Routine local deploys never externally kill a live Polygram daemon or mutate
  its release tree.
- Clean accepted IPC deploys are automatically replaced by launchd.
- Local lifecycle proof is bound to the daemon instance, PID, request, release,
  fixed event interval, and final live witness.
- Exact foreground Claude and Codex sessions each resume once, receive one
  literal continuation, produce one logical result, and emit no generic restart
  notice.
- Local qualification finishes before either VPS package tree changes.
- Local, Shumabit, and UMI Assistant require daemon-owned, request-bound
  authorized lifecycle proof.
- The tagged Polygram artifact contains the exact published Orchestra 0.10.15
  dependency.
- Background preservation remains postponed and is not claimed.
