# Local daemon-owned deploy restart

Status: AMENDMENT UNDER REVIEW 2026-08-11 — real-host preflight corrected the
compatibility baseline and the dispatch-uncertainty policy. Implementation is
being re-reviewed; production activation requires Ivan's explicit alignment.

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
- One owner-only local transaction lock serializes recovery, local deployment,
  local receipt qualification, and the complete partner VPS rollout.
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

The helper also holds one host-native advisory lock from before journal
recovery through local completion. `--vps-only` takes the same lock before
authenticating the local daemon and receipts and retains it through the VPS
rollout. A second helper fails before it can create, replace, or qualify a
transaction; a VPS rollout cannot consume a local proof while another helper
changes the local daemon beneath it.

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
- every local IPC call explicitly binds `~/.polygram/.ipc`, independent of the
  helper's repository working directory;
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

The currently running Polygram 0.38.0 daemon has neither `daemon_instance_id` nor
the corrected active-turn retirement order. No procedure can retroactively
give that process those guarantees. The one-time boundary is therefore an
explicit, operator-approved compatibility activation, not a claimed smooth
deploy.

This baseline is grounded in the 2026-08-11 read-only host preflight. The NVM
global package reports 0.38.0 and its package metadata was installed at
23:50:28 local time on 2026-08-10; the loaded launchd PID started three seconds
later from that exact global entry. Its latest start row is from the
pre-identity schema, its canonical plist still has the exact crash-only
predicates, and no activation receipt exists. The earlier 0.37.2 assumption is
therefore stale, not a safe production gate.

The activation sequence is:

1. Enter transition mode only when every legacy predicate matches: no prior
   activation receipt exists; the installed package is exactly 0.38.0; the
   loaded job has the canonical label and plist path, exact old NVM global
   entry, exact `--bot shumorobot` argv and working directory, positive launchd
   PID equal to the PID file, and authenticated legacy IPC. Require the exact
   crash-only `Crashed=true`/`SuccessfulExit=false` predicates in the canonical
   on-disk plist and require the loaded snapshot not to advertise effective
   unconditional KeepAlive. Current `launchctl print` does not reproduce the
   nested crash-only dictionary, so the helper must not claim that the loaded
   output alone proves those two nested values. Persist this one-time
   eligibility in the journal. Any mismatch fails closed.
2. Stage and validate the first versioned release and a temporary new plist
   completely. Record the exact legacy canonical-plist fingerprint and retain
   that file for recovery evidence; do not change the loaded definition or
   stable target yet.
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
Silence cannot distinguish that case from a request the daemon accepted before
entering a slow or unbounded clean drain: process retirement can wait on
provider and delivery fences before the first request-bound lifecycle row is
durable. Therefore a time-based “no effect” observation never authorizes
rollback, journal retirement, or a second request. Reruns reconcile only the
stored request. If the old PID remains and no matching lifecycle appears, fail
closed with the journal retained. Automated abort requires a future positive,
durable daemon acceptance/status protocol; the pre-identity 0.38.0 process
cannot provide one for this one-time activation.

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
  metadata binds an unrelated Codex generation that remained the same live,
  idle generation for at least six hours, had no active turn or background
  ownership, and was retired while an exact foreground Claude session passed
  continuation. Foreground Codex continuation remains a separate receipt.
- `--vps-only`: require the exact published version plus same-version passing
  local Claude, foreground Codex, and aged-warm Codex receipts before checking
  the split-owner topology or mutating the shared VPS tree. Hold the local
  transaction lock across that qualification and the complete rollout. Then
  retain the existing Shumabit-first,
  UMI-Assistant-second daemon-owned IPC flow and Water/tmux invariants.

For each VPS bot, IPC responsiveness is only an early boot witness. Admission
opens after awaited clean-resume recovery, so lifecycle qualification retries
the same request within a bounded window while reasserting the exact systemd
invocation and PID on every attempt. It never sends a second restart request.

The active-turn design's aged-warm-session canary remains a release
qualification. The daemon's single Orchestra `ProcessManager` deliberately
permits only one live native Codex generation, so two simultaneously warm
Codex sessions are not a representable production state. The aged-warm gate
therefore reproduces the actual cross-provider blocker: one unrelated Codex
session remains warm and
idle for at least six hours while a Claude session is the foreground
continuation target. The separate foreground-Codex receipt proves the Codex
resume path without weakening the daemon-wide ownership fence. If the
aged-warm gate is not yet mature, the local release may remain installed for
the observation window, but the partner VPS phase remains blocked.

The aged-warm proof needs two content-free observations, at least six hours
apart, from the same daemon instance and the same live Codex generation. Both
must report idle state, zero active turns, zero pending delivery work, and an
empty background-terminal registry. Orchestra maintains a monotonic
per-generation activity epoch, incremented synchronously before every admitted
send/steer and whenever provider background ownership becomes active. The
epoch must be unchanged between observations, and durable generation metadata
must also show no turn attempt, reservation, checkpoint, or state transition.
This closes the pre-checkpoint turn-start failure case that database evidence
alone cannot observe.

The first observation is a standalone authenticated read. The second is not:
the helper passes the expected generation digest and activity epoch with its
one `deploy_restart` request, and Orchestra repeats the read-only observation
inside clean retirement after daemon-wide lifecycle admission is closed but
before any process is retired. Polygram records a content-free
`clean-restart-qualification-observed` event for that fenced result. Its exact,
closed schema contains the restart-request digest, old daemon instance, package
version, observation time, generation digest, expected and observed activity
epochs, enum-only state, the same readiness/background counts, an exact-match
boolean, and a bounded outcome code. It contains no raw provider error or
identity field. Require exactly one request/instance-matching event in the
fixed lifecycle interval and bind the receipt to that event cursor. A mismatch
does not retry the request or reopen admission; the restart proceeds safely but
the aged-warm gate fails. The result must show exact zero-work Codex retirement
and no Codex continuation intent while the bounded foreground-Claude lifecycle
and the generation's terminal retirement bind the idle process to that restart.

To make those observations exact, add a lifecycle-fenced, read-only Orchestra
inspection method. It validates that the selected generation is still current
and idle, calls `thread/backgroundTerminals/list` without cleaning or otherwise
mutating provider state, and checks the exact process, lease, generation,
lifecycle, and activity epoch again after the asynchronous read. A nonzero
count or non-null pagination cursor is nonempty. Expose that
method through an authenticated Polygram IPC operation that accepts no
chat/session selector. The daemon-wide single live Codex generation is the
only possible target. Its exact, closed response schema contains bot, daemon
instance, package version, observation time, a SHA-256 generation digest,
bounded monotonic activity epoch, enum-only process state, and the active-turn,
pending-delivery, background-owner, and background-terminal counts/booleans.
It never returns a
chat/session identity, raw generation, provider handle, thread ID, command,
working directory, or filesystem path. Unknown fields, incomplete pagination,
generation/lifecycle drift, and unsanitized provider failures all fail with a
bounded code.

The helper compares the generation digest across observations and against the
internally hashed durable generation. Its 0600 receipt includes the digest,
activity epoch, daemon instance, package version, observation times/cursors,
exact counts, and the foreground-Claude receipt/restart-request digest it
qualifies. The receipt
schema is closed and versioned; file presence or a same-version string alone is
never sufficient.

Foreground qualification also records one content-free
`clean-resume-continuation-dispatched` event from the existing `onDispatched`
boundary. It carries the existing content-free correlation tuple (`bot`,
`session_key`, `source_message_id`, `policy_version`) plus enum-only `provider`
and `command_kind=continue`; it never carries prompt or reply content. The
canary requires exactly one matching tuple in the ordered
claim/attestation/dispatch/success chain and rejects interleaved or duplicate
dispatches. That chain is bounded by the one request-bound lifecycle interval,
proving the production run crossed the hard-coded literal `continue` dispatch
once instead of inferring it from terminal success alone.

### 7. Release integration

Orchestra 0.10.16 is published from reviewed main through a signed tag and
GitHub OIDC. It contains the read-only qualification inspection,
per-generation activity-epoch instrumentation, and the admission-closed
pre-retirement qualification hook/result. Pin that exact published version in
Polygram. Integrate the Polygram implementation onto current 0.38.0 main,
preserve the unrelated rich-text changes, and release the next patch.
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
- **Abort after a quiet timeout:** the daemon may have accepted the request but
  still be waiting in an unbounded provider or delivery fence before emitting
  request-bound lifecycle evidence. Absence over time is not proof of no
  effect; only a future positive durable acceptance/status protocol can make
  that transition safe.

## Failure modes and recovery

- Contract mismatch before mutation: fail without staging or changing state.
- Candidate install/native/dependency verification failure: remove only the
  never-activated temporary prefix; the old immutable daemon remains owner.
- Helper death around IPC dispatch: old daemon may remain active; once the
  durable boundary was crossed, a journaled rerun reconciles the original
  request only. Lifecycle silence cannot authorize retry or rollback, so an
  unresolved request remains fail-closed pending positive forensic evidence.
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
   completion without IPC retry. They also prove the
   dispatch-possible-before-send window exposes no time-based abort or second
   request, and concurrent helpers cannot acquire the same transaction lock.
5. Lifecycle verifier tests use a fixed upper cursor and reject wrong request,
   wrong old/new instance, duplicate start/admission, a second replacement
   before proof, or any later transition before the final witness. Delayed
   admission fixtures prove local and VPS qualification retry evidence, not
   restart dispatch, while continuously binding the same process generation.
6. Plist tests require unconditional `KeepAlive=true`; `plutil -lint` passes.
   Definition fixtures cover exact label/path/program/full argv/cwd matching,
   including the production crash-only loaded format without a generic
   `keepalive` property.
7. Canary-verifier tests prove provider/name/request/version binding, one
   literal-continuation dispatch, one logical success, zero notices, and
   content-free output for Claude and Codex. A separate receipt test requires
   two same-daemon/same-generation observations at least six hours apart, no
   intervening generation activity, continuous idle state, zero
   active/background ownership, and same-version foreground Claude proof;
   `--vps-only` rejects its absence. Orchestra tests prove the background
   registry inspection is read-only and fails if the process generation or
   lifecycle/activity epoch changes during the observation. They also prove a
   pre-checkpoint send failure increments the epoch, background activation
   invalidates an observation, and the final observation runs after global
   admission closure but before the first process retirement.
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
- Local qualification cannot change concurrently with a receipt-gated VPS
  rollout because both phases hold the same host-native transaction lock.
- Local, Shumabit, and UMI Assistant require daemon-owned, request-bound
  authorized lifecycle proof.
- The tagged Polygram artifact contains the exact reviewed follow-up Orchestra
  patch that adds the qualification inspection, monotonic activity-epoch
  fence, and admission-closed pre-retirement qualification result.
- Background preservation remains postponed and is not claimed.
