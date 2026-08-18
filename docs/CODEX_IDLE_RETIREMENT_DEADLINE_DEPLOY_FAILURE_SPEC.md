# Codex idle-retirement deadline and failed-deploy reconciliation

Status: APPROVED — production evidence collected and design reviewed on
2026-08-17; Ivan explicitly approved the final bridge-only ordinary-deploy
boundary on 2026-08-18.

## Problem

Polygram 0.38.5 is live locally, but its deployment transaction stopped at
`replacement-observed` because the retiring 0.38.4 daemon persisted a
crash-like shutdown instead of a clean one. This is not the earlier
`shutdown-persistence-fallback` incident.

The exact content-free production trace is:

- deploy journal: request `4602a0e7-cfc8-4650-96f7-6dfc2a5ce0e6`, old daemon
  `01c52997-9526-4cab-ad59-660874408aed` / PID 18554, new daemon
  `d8d54878-f620-42d6-8ac3-027077eeed78` / PID 14050;
- events 32436–32439: `shutdown-drain(clean=false,
  shutdown_reason=clean-retirement-failed, continuation_authorized=true,
  resume_intents_recorded=0)` → exact old `polygram-stop` → exact new
  `polygram-start` → exact new `polygram-admission-open`;
- Codex checkpoints 841–844: `thread/backgroundTerminals/clean`
  `request-prepared` → `request-write-attempted` → `containment-entered` →
  `containment-cleanup-completed`, with closed fault provenance
  `CODEX_RPC_TIMEOUT` / `rpc-timeout` and reason `stop-cleanup-failed`;
- the generation's prior `turn-terminal(completed)` was checkpoint 839 at
  2026-08-16T15:47:52.021Z. Cleanup started at
  2026-08-17T04:45:11.800Z, 46,639,779 ms (12.96 h) later;
- the new daemon is running Polygram 0.38.5, admission opened, current busy is
  zero, and the durable Codex daemon lease is clear. No success receipt exists.

Orchestra 0.10.17 and 0.10.18 both compute an interrupt control deadline as:

```js
controlDeadlineOverride
  ?? pending?.deadlineAt
  ?? this.lastTerminal?.deadlineAt
  ?? (Date.now() + interruptTimeoutMs + cleanupTimeoutMs)
```

`lastTerminal` is retained after an ordinary foreground turn settles to
`Idle`. Therefore an idle generation can reuse a many-hours-old turn deadline.
The deploy cleanup mutation then receives a 1 ms timeout, becomes
outcome-unknown, enters containment, and forces crash-like shutdown.

The new daemon cannot repair the retiring daemon: the shutdown runs the old
installed Orchestra. A shell-side clear-lease observation cannot close the
race to restart acceptance. The bridge must use a gate already enforced by the
immutable 0.38.5 daemon itself.

## Goals

1. Give an idle Codex generation a fresh bounded retirement budget while
   preserving the original turn deadline for active or background-owned work.
2. Record an OS-successful but clean-proof-failed local deployment as an exact
   terminal failure, never as success.
3. Keep every ordinary local deploy blocked by that failed journal. Permit
   only the dedicated foreground bridge to advance to a later version after
   the failure and current daemon witness are re-proven.
4. Keep foreground canaries and VPS rollout blocked for the failed version.
5. Reconcile the existing 0.38.5 journal without another restart, then bridge
   to the fixed release by composing two already-shipped facts: durable proof
   that one controlled foreground message reached an accepted, recent Codex
   turn, and daemon-owned authorization that the same foreground handler is
   the sole live target when shutdown closes admission.

## Non-goals

- Treating a crash-like drain as a clean deploy or creating continuation
  authority from it.
- Retrying the original restart request.
- Relaxing containment for an ambiguous cleanup mutation.
- Automatically replaying or redispatching user messages.
- Deploying to the VPS in this incident.
- Changing background-work postponement policy.

## Chosen design

### 1. Orchestra: select a deadline owned by the current lifecycle state

Introduce one explicit `backgroundOwner` record containing the exact owned
terminal turn ID and deadline. It is created only from either:

- the exact current pending's durable terminal plus a non-empty background
  registry observation; or
- an idle-thread `status=active` notification when an exact `lastTerminal`
  exists, its deadline is still live, and it is promoted as the owner before
  state changes.

An active notification with no exact live terminal owner enters containment;
it cannot manufacture background ownership from a state label. Background
settlement, its watchdog, and interrupt all consume the same immutable owner.
Successful cleanup clears it.

In `CodexProcess._interrupt`, capture `priorState` as today and select the
deadline in this order:

1. an explicit `controlDeadlineOverride`;
2. `pending.deadlineAt` while a current turn/start is owned;
3. the exact `backgroundOwner.deadlineAt` only while `priorState` is
   `BackgroundWorking` or `BackgroundSettling`, rejecting missing/mismatched
   ownership into containment;
4. otherwise a fresh `Date.now() + interruptTimeoutMs + cleanupTimeoutMs`.

The change is deliberately conditional, not `Math.max(old, fresh)`:
background cleanup remains bounded by the original turn budget and must not
gain extra time merely because shutdown began. `Idle`, `Stopped`, and other
states with no owned pending/background work do not inherit historical turn
deadlines.

No terminal history is cleared. `lastTerminal` continues to support exact
history and the guarded promotion of later provider background status; it no
longer supplies an interrupt deadline by itself.

### 2. Deploy skill: exact negative proof for clean-retirement failure

Add a read-only verifier mode for one exact interval `(L, F]`. It accepts only
this four-row lifecycle sequence:

1. one `shutdown-drain` with exact old daemon/PID and bot,
   `clean=false`, `shutdown_reason=clean-retirement-failed`,
   `restart_trigger=deploy-ipc`, `continuation_authorized=true`,
   `resume_intents_recorded=0`, and the exact restart request ID;
2. one exact old `polygram-stop`;
3. one exact new `polygram-start`;
4. one exact new `polygram-admission-open`.

The query includes all closed lifecycle kinds, is bounded by the frozen
cursor, and caps returned rows at expected count + 1. It requires the SQLite
`json_type` of every security-relevant field: `false`/`true` for Boolean JSON,
`integer` for PIDs/counts, and `text` for tokens/IDs. It rejects
Boolean/integer lookalikes, nulls, duplicates, reordering, extra
drain/fallback rows, malformed details, or identity drift. It never selects or
prints message bodies or raw detail JSON.

Routine recovery first tries the existing positive proof. If that cannot
qualify and the journal is already `replacement-observed`, it freezes `F` and
requires, in order:

- the exact negative lifecycle proof above;
- current daemon busy count zero;
- the existing final local witness for release/version/new instance/PID and
  no later closed lifecycle event after `F`.

Only then one constrained finalizer reopens and revalidates the same journal,
re-runs the exact frozen interval proof, busy-zero sample, and final witness,
then atomically writes:

```text
phase = lifecycle-failed
failure_code = clean-retirement-failed
upper_cursor = F
```

The finalizer has no standalone/raw state-mutation CLI. It exits nonzero and
creates no success receipt, continuation intent, restart request, or
redispatch.

### 3. Failed journal semantics

The routine `lifecycle-failed` journal shape gets a closed typed schema and
secure single-snapshot reader before it can carry authority; this does not
rewrite unrelated legacy-activation journal formats. Terminalization and
bridge adoption require an owner-only 0600 regular file opened with `O_NOFOLLOW`,
a fixed size bound, exact key set/types/phase invariants, and inode stability
through atomic replacement. Partial/corrupt/extra-field records, symlinks,
wrong modes, and inode drift fail without mutation.

`lifecycle-failed` is terminal evidence for reconciliation and audit. It is
not authority for an ordinary deployment, even when the requested version is
different. Only the dedicated foreground bridge may consume it after
revalidating the frozen failure and the unchanged current daemon witness.

- Every ordinary local deploy remains an error and performs no restart.
- A foreground canary remains blocked because the deploy journal is not
  `complete`.
- VPS rollout remains blocked because the local journal is not `complete`.
- Only the bridge may replace the failed journal, and only after the terminal
  failure validator re-runs the exact `(L, F]` proof, busy-zero check, release
  identity, and final witness. Any drift keeps the journal blocking.
- After the bridge's exact lifecycle and foreground outcome proof passes, its
  constrained adoption transaction writes the standard `complete` record;
  durable events retain the failed deployment's audit trail.

The existing 0.38.5 reconciliation enters through the normal recovery path.
Because its phase is already `replacement-observed`, it cannot dispatch or
retry the old restart request.

### 4. Bridge release through a recent accepted turn and foreground authorization

Release Orchestra 0.10.19 with the deadline fix, then Polygram 0.38.6 pinned to
that exact dependency. A passive lease snapshot and the foreground token are
each insufficient alone. The bridge composes durable provider-attempt evidence
with the daemon-owned foreground authorization already present in 0.38.5:

1. reconcile the 0.38.5 journal to exact `lifecycle-failed` without restart;
2. stage and verify immutable 0.38.6, but do not restart;
3. require the authenticated 0.38.5 daemon busy count to be zero, then create a
   bridge journal before asking Ivan to send one controlled, long-running
   Codex canary prompt in the configured chat/topic. Resolve the daemon's config
   path only from the authenticated loaded launchd definition: use the exact
   loaded `POLYGRAM_CONFIG` environment value when present, otherwise use the
   exact loaded `WorkingDirectory/config.json`. An independent
   `POLYGRAM_LOCAL_CONFIG` bridge override is forbidden. The journal stores the
   securely read resolved file's absolute path, owner/mode/device/inode/size/
   mtime/ctime fingerprint, SHA-256, and resolved chat-level `maxTurnMs`. It also
   stores the exact old PID's kernel process-start floor from a closed,
   locale-fixed `ps` projection and the exact authenticated `polygram-start`
   row for that daemon/PID. Resolve one positive operator Telegram user ID from
   the same loaded bot config. Accept only a positive safe integer or its
   canonical base-10 digit string. Reject booleans, floats, signs, whitespace,
   exponents, leading zeroes, overflow, and every other type/form. A present
   invalid `operatorUserId` fails closed and never falls back;
   a valid `operatorUserId` wins, otherwise only a valid positive private
   `adminChatId` is accepted. Missing, negative, or ambiguous operator identity
   rejects the bridge;
4. from the production DB in `query_only` mode, select no bodies and prove
   exactly one post-baseline inbound/runtime selection and exactly one bound
   `turn/start` attempt for that Telegram source, operator user ID, and session.
   The attempt must
   have a non-null provider thread and turn, `delivery_state=response-observed`,
   `response_outcome=result`, `recovery_state=active`, and
   `terminal_status IS NULL`. It must also have exactly one `turn-accepted`
   checkpoint bound to the same generation, attempt, provider thread, and turn
   ID; the result-shaped attempt row alone is not acceptance authority;
5. resolve the effective chat `maxTurn` with the same precedence as Polygram.
   Re-read the config through `O_NOFOLLOW`, require the complete fingerprint
   and digest to remain unchanged, and require the stored resolution to match.
   Before each proof and restart dispatch, re-read and authenticate the loaded
   launchd definition and require the same `POLYGRAM_CONFIG`/working-directory
   derivation to resolve to the journal's exact path. The bridge accepts no
   separate helper-selected config path.
   The config ctime must be strictly earlier than the conservative whole-second
   floor of the old process's kernel start time, and that same process-start
   value and daemon start row must revalidate. The start row binds the exact
   daemon instance and PID; installed-release/IPC attestation separately binds
   version and code integrity. Since 0.38.5 always loads config
   after process creation, this proves the fingerprinted bytes existed before
   the daemon that admitted the turn and are the bytes in its in-memory config;
   Require the journal creation time to precede the message and attempt, and
   require the current time plus the full old Orchestra interrupt+cleanup
   budget and a fixed safety margin to be strictly below
   `journal.created_at + maxTurnMs`. Re-run this bounded proof immediately
   before target binding and again immediately before restart dispatch;
6. bind the exact active source through the existing foreground-canary token,
   atomically switch `current` to 0.38.6, then send the existing
   `deploy_restart` request with that foreground expectation.

The immutable 0.38.5 foreground protocol does **not** bind a Codex generation,
provider turn, or deadline. Its narrower role is to revalidate that the exact
controlled Telegram source is the daemon's sole active handler, durably log
that authorization, and synchronously call `shutdown()`. `shutdown()` sets
`isShuttingDown` and stops polling before yielding, so another inbound cannot
enter after acceptance.

The durable accepted-turn proof supplies the missing deadline fact. The
canary journal exists before the message can be admitted, so the turn's
`pending.startedAt` is no earlier than `journal.created_at` and its
`deadlineAt = startedAt + maxTurnMs` is no earlier than the verifier's bounded
lower limit. Once an exact turn/start result is durably accepted, every
non-contained old-process state that can reach retirement has a safe deadline:

- the exact canary is still current, so `pending.deadlineAt` wins;
- it has terminalized, so that same fresh deadline is in `lastTerminal`;
- the Codex process was replaced, so the replacement has no inherited stale
  terminal and the old implementation selects its fresh default budget.

An attempt that becomes durability-blocked, ambiguous, or contained does not
meet the bridge success contract. The retirement remains fail-closed.

After replacement, the bridge accepts exactly one of two content-free outcomes
for the authorized source:

1. one eligible snapshot, intent, claim, attestation, literal continuation,
   settled Telegram delivery, and clean-resume success for the exact turn; or
2. the source reached `handler_status=replied` with settled Telegram delivery
   before the old stop, and the interval contains zero snapshot/intent/claim/
   continuation events for that source.

Both outcomes require the positive clean lifecycle interval, no negative
resume event, no replay notice event/source, no replay-on-boot noticed count,
and the final destination witness. A terminal turn without either delivered
reply or exact continuation is a failed bridge, not success.

This is a bridge-only extension of the foreground-canary transaction, not an
ordinary deploy retry. Its authority is hard-coded to the one reviewed incident:
the failed source is exactly 0.38.5 and the destination is exactly 0.38.6. A
different source or destination fails before metadata, staging, or transport.
The destination metadata and immutable local release must both declare exact
`@shumkov/orchestra@0.10.19`; any other dependency version fails before
staging, switch, or restart transport.
The failed deploy journal remains byte-identical while
the canary transaction records a closed destination release identity,
previous `current` target, and explicit stage/switch/dispatch/replacement/proof
phases. It is accepted only when the prior deploy journal is the fully
revalidated 0.38.5 `lifecycle-failed` record and the destination is exactly
immutable 0.38.6. It cannot target VPS or become a generic restart
option. Its journal and receipt bind both the retiring and destination
versions.

Before `current` changes, failure needs no rollback. The runner durably enters
its pre-dispatch switch-recovery phase before atomically renaming `current`, so
a crash on either side of the rename is recoverable from the same phase. Before
`dispatch-possible`, recovery may restore the exact old link only while the
exact old daemon/PID/version is still the authenticated live owner. After
`dispatch-possible`, an exact authenticated `accepted=false` response from that
same old daemon also proves non-acceptance and permits the same guarded rollback.
That rollback ends in a distinct terminal post-dispatch phase which never
authorizes another bridge request. If the exact rejection is received but its
journal transition cannot be persisted, the same invocation still disarms
`current` under the exact old-owner and failed-authority proofs; the durable
`dispatch-possible` attempt remains blocked and is never resent. An IPC error,
old-daemon death, accepted response, or any replacement observation is
ambiguous/accepted: the request is never retried, the link is never restored,
and recovery only observes the exact request and daemon lifecycle.

Only after the destination lifecycle, one of the two exact foreground outcome
proofs, final witness, and receipt are durable does a constrained adoption
transaction replace the failed deploy journal with a standard `complete`
journal for 0.38.6. A crash between receipt publication and adoption is
idempotently recoverable from those same proofs.

If the first bridge reaches a clean 0.38.6 replacement but the controlled
source proves neither allowed outcome, terminalize that bridge attempt as
`proof-failed`, leave the fixed version live, and stop. Do not adopt, roll
back, resend, or manufacture a second request. The original failed journal no
longer independently authorizes a retry because its recorded 0.38.5 current
witness has intentionally been superseded. `--new-attempt` is deliberately
unsupported and rejects before state access or transport; enabling it requires
a separately reviewed authority design. Dormant predecessor/no-switch schema
fields remain fail-closed and confer no dispatch authority.

Existing bridge recovery selects and validates its durable local journal and
immutable staged release before any registry access. Registry metadata and
staging are required only when creating the first bridge journal; a
post-dispatch recovery, receipt publication, or adoption never depends on npm
availability.

If the canary is absent, lacks exact accepted-turn evidence or enough deadline
headroom, has a competitor, or any source/session/provider identity drifts,
the bridge rejects before shutdown whenever possible. It does not fall back to
an ordinary restart. The 0.38.6 daemon carries the permanent fix for future
deploys.

## Alternatives rejected

- **Clear `lastTerminal` on idle:** changes ownership/history semantics and
  risks breaking exact terminal/background reconciliation.
- **Always grant a fresh deadline:** extends active/background work past its
  original budget and weakens containment.
- **Use `max(oldDeadline, freshDeadline)`:** has the same unsafe extension for
  background-owned work.
- **Mark 0.38.5 complete or delete its journal manually:** falsely certifies a
  clean lifecycle and could unblock VPS/canary gates.
- **Retry the 0.38.5 restart:** the request is one-shot and the old daemon is
  gone; another restart cannot repair its evidence.
- **Mutate the staged 0.38.5 package:** violates immutable release identity and
  the deploy witness.
- **Clear-lease shell preflight:** observation-only and races a new Codex
  generation before restart acceptance.
- **Foreground authorization alone:** it binds a Telegram handler before or
  after provider work and does not prove a Codex generation, turn, or fresh
  deadline.
- **Idle qualification plus a prior turn:** qualification proves the Codex
  process is idle, but it does not close Telegram handler admission; a newly
  admitted message can exist before it reaches ProcessManager.
- **Stop the local Bot API for the bridge:** it could freeze new Telegram
  delivery, but expands the incident to a companion service and drops direct
  alert sends during the gap. The accepted-turn plus foreground-authorization
  composition supplies the needed invariant without that outage.
- **External SQLite write-lock bridge:** violates the production DB
  query-only rule and can deadlock synchronous shutdown DB writes.
- **External signal/launchd bridge:** has no exact continuation authority and
  reintroduces the user-visible crash-replay behavior this work exists to
  remove.
- **Treat any crash-like shutdown as terminal:** too broad. Only the exact
  request-bound clean-retirement failure shape is admitted.

## Failure modes

- Negative proof ambiguous or malformed: retain `replacement-observed` and
  stop.
- Authorized replacement changed, busy became nonzero, or final witness
  drifted: retain the blocking journal and stop.
- Crash during terminal transition: atomic rename yields either the old
  recoverable journal or the complete `lifecycle-failed` record.
- Same-version retry: fail before dispatch.
- Either a source other than 0.38.5 or a destination other than 0.38.6,
  including recovery and adoption: fail before metadata, staging, or transport.
- Different-version ordinary deploy: fail before metadata, staging, or
  transport. It cannot consume or replace `lifecycle-failed`.
- Attempted VPS/canary on a failed local version: fail before transport.
- Bridge target changes or freshness expires before dispatch: reject and stop;
  restore the link only under the exact old-owner/authenticated-non-acceptance
  rules above. No fallback restart.
- Old daemon dies after the destination switch: never restore or resend;
  observe the new owner and exact lifecycle, and leave the bridge incomplete
  unless its full proof independently qualifies.
- Authorized turn terminalizes during handoff: require either exact delivered
  pre-stop reply or the exact continuation chain. Anything else terminalizes
  the bridge proof as `proof-failed`; no automatic or `--new-attempt` recovery
  is authorized by this release.
- Orchestra cleanup remains genuinely outcome-unknown after the deadline fix:
  unchanged containment and crash-like shutdown behavior.
- Exact authenticated rejection: restore the old link once and retain a
  terminal non-retryable bridge record. If rejection journaling fails, restore
  the old link in the same invocation and leave the durable dispatch marker
  blocked.
- Registry unavailable during recovery: use the journal-bound local immutable
  release; do not contact npm and do not delay receipt adoption.

## Test and verification plan

### Orchestra (red first)

1. Complete an ordinary foreground turn, settle the process to `Idle`, and
   inject an expired historical deadline. The cleanup handler throws
   `CODEX_RPC_TIMEOUT` only when it receives the old 1 ms budget. This is red
   on 0.10.18 (containment) and green after the fix (fresh bounded timeout,
   exact stopped state); do not rely on `FakeClient` enforcing timeouts.
2. Prove `BackgroundWorking` and `BackgroundSettling` send the exact original
   owner deadline and do not gain a fresh budget. Missing/mismatched owner and
   stale unsolicited `status=active` enter containment. A valid late active
   status binds the exact live `lastTerminal`, arms its watchdog, and cleans.
3. Retain active-turn, preparation-race, cancellation-reason, containment, and
   ProcessManager clean-restart suites.

### Deploy skill (red first)

4. Reproduce production event IDs 32436–32439 as a real SQLite fixture and
   require exact negative qualification without exposing detail JSON.
5. Independently mutate clean flag, shutdown reason, authorization, intent
   count, request ID, every old/new identity field, order, duplicates, extra
   lifecycle kinds, and every Boolean/integer/text/null JSON type confusion;
   each must reject. Include a sentinel unexpected detail value whose bytes
   never appear on stdout/stderr.
6. Runner recovery from `replacement-observed` must perform zero restart
   writes, require busy zero + final witness, atomically terminalize, exit
   nonzero, and remain byte-identical on rerun.
7. Use a test-only dependency-injected filesystem seam (not a production env
   flag) to pause before rename and after rename/before directory fsync. Prove
   pre-rename recovery, post-rename recovery, fsync order, secure temporary
   residue handling, and byte-identical reruns.
8. Same-version retry, different-version ordinary deploy, foreground canary,
   and VPS rollout all remain blocked. Only the dedicated bridge may consume
   the failed journal after full terminal-failure revalidation; drift blocks
   it before transport.
9. Exercise the real final witness and real SQLite with only launchd/PID/IPC
   identity seams stubbed.

### Bridge

10. Reproduce an exact foreground Codex target on 0.38.5 and require the real
    ledger shape: unique post-baseline source/selection, exact session/source
    `turn/start`, non-null thread/turn, response-observed result, active
    recovery, null terminal status, and exactly one `turn-accepted` checkpoint
    bound to the same generation/attempt/thread/turn. Missing, duplicated, or
    mismatched acceptance checkpoints; prepared/write-attempted, terminal,
    error, ambiguous, wrong-source/session/generation, duplicates, a message or
    attempt predating the journal, and insufficient remaining deadline
    headroom all reject. Config inode/content/timestamp drift and a changed
   `maxTurn` resolution also reject. When launchd supplies an exact absolute
   `POLYGRAM_CONFIG` path, the verifier accepts and fingerprints that path even
   if it differs from the historical helper default; it rejects any independent
   helper-selected bridge config path, any change to the loaded launchd
   definition/path, and any unresolved/non-absolute config path. A
    config ctime at/after the kernel process
    start, changed process-start projection, or mismatched authenticated daemon
    start row rejects. Include both counterexamples: (a) a daemon booted with a
    short turn limit but the same disk path was later replaced by a stable
    longer-limit file, and (b) launchd supplied `POLYGRAM_CONFIG=A` while the
    helper tries to fingerprint stable longer-limit file B. The test uses the
    launchd-derived configured `maxTurn`, not a hard-coded production default.
11. Prove the monotonic bridge cases on the old implementation: dispatch while
    the exact turn is current selects its fresh pending deadline; terminalize
    it before dispatch and retirement selects the same fresh `lastTerminal`
    deadline; replace the process and retirement selects a fresh default.
    Durability-blocked/contained transitions remain failures. The same
    `deploy_restart` acceptance synchronously closes admission before another
    target can enter.
12. Reject a target whose Telegram `user_id` is not the exact operator derived
    from the frozen loaded config. Accept only a positive safe integer or
    canonical digit string. Reject missing, negative, zero, boolean, float,
    signed, whitespace, exponent, leading-zero, overflow, and invalid-present
    `operatorUserId` values without falling back to `adminChatId`.
13. Prove the bridge rejects any source other than 0.38.5, destination other
    than 0.38.6, or destination Orchestra other than 0.10.19 before its
    applicable metadata/staging, switch, or IPC boundary.
14. Inject crashes before and after the `current` rename and prove the durable
    write-ahead phase restores the old link once with zero restart calls.
15. Inject authenticated `accepted=false` followed by journal-transition
    failure. `current` is restored to the exact old link, disarming the
    destination; the dispatch marker remains
    non-retryable, and no second IPC request is possible. A normally persisted
    authenticated rejection ends in a distinct terminal phase that also blocks
    reinvocation.
16. Recover `receipt-published` and `adopted` journals with registry access
    poisoned; local proof and adoption must still complete without metadata or
    staging calls. A `proof-failed` journal remains non-authorizing because the
    original 0.38.5 witness has been superseded, and must fail before those
    calls as well.
17. Prove both accepted post-replacement outcomes through real SQLite and the
    installed Orchestra: one exact continuation chain, or one exact delivered
    pre-stop reply with zero continuation chain. Natural terminal without a
    delivered reply, negative resume evidence, replay notice evidence, or any
    other mixture fails. A rerun creates neither a second restart nor a second
    continuation.
18. Crash at every current-switch, dispatch, authenticated rejection,
    replacement, receipt, and adoption seam. Authenticated non-acceptance may
    restore the old link; ambiguous/accepted/dead-old-daemon states never
    restore or resend and cannot manufacture a complete deploy record.
    Separately prove a clean replacement plus foreground proof failure leaves
    0.38.6 live, records no receipt/adoption, and keeps `--new-attempt`
    fail-closed before state access or dispatch.

### Polygram/release

19. Pin exact Orchestra 0.10.19 in package and lock files; verify the installed
    package contains the state-owned deadline selection.
20. Run complete Orchestra and Polygram suites under exact Node 24.4.0, report
    every skip, and independently review both diffs.
21. Add bounded assertions that reconciliation and bridge intervals contain no
    `replay-notice-sent` and no `replay-on-boot.noticed_count > 0`, without
    querying bodies.
22. In production, reconcile 0.38.5 without restart; verify terminal failure,
    no receipt, and unchanged daemon identity. Run the exact foreground bridge
    to local-only 0.38.6. Require clean drain → stop → start → admission, exact
    continuation or delivered-pre-stop proof, no notice evidence, and final
    witness. Do not touch VPS.

## Definition of done

- The expired-idle-deadline regression is red on 0.10.18 and green on the fix.
- Active/background deadline containment remains unchanged.
- The 0.38.5 failed journal is terminalized from exact evidence without a
  restart, cannot certify canary or VPS rollout, and cannot authorize an
  ordinary same- or different-version deploy.
- 0.38.6 deploys locally through one clean daemon-owned restart authorized by
  the exact foreground target and preceded by bounded durable proof that its
  Codex turn was accepted recently enough to refresh every reachable old-code
  retirement deadline.
- The resulting local journal is `complete`; lifecycle proof and final witness
  pass; no generic restart notice is emitted for the bridge deployment.
