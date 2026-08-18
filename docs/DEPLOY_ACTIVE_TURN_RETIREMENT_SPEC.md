# Immediate active-turn retirement on an authorized deploy

Status: APPROVED 2026-08-05. Implemented and independently code-reviewed.
Local verification is complete; package release, clean dependency-pin
verification, production activation, and canaries remain pending.

Scope: Telegram admission and shutdown ordering in Polygram, plus
per-session clean-retirement ordering in Orchestra. Background-work
preservation remains postponed. Codex fault telemetry is a separate diagnostic
deliverable in `CODEX_RETIREMENT_FAULT_TELEMETRY_SPEC.md`.

## Problem and production proof

The released deploy-survival contract says an authenticated `deploy-ipc`
restart stops intake, fences reply-bearing delivery, captures the exact active
turn, retires the provider, and only then awaits handler settlement. Production
does not execute that order.

`polygram.js` first waits up to `SHUTDOWN_DRAIN_MS` (30 seconds) for handlers to
finish naturally. Only afterward does it call `prepareCleanRetirement()`, which
starts the delivery fence and ProcessManager retirement. An authorized turn can
therefore finish, emit output, or fail before its retirement candidate is
captured.

That third outcome occurred in the controlled Shumabit Codex canary on
2026-08-03. The inbound arrived at `14:12:22.000Z`, selected Codex at
`14:12:22.894Z`, and durably accepted `turn/start` at `14:12:23.062Z`. The
authenticated restart was accepted while the turn was active. Polygram spent
27,377 ms in the pre-retirement drain. At `14:12:50.551Z`, before any
`turn/interrupt` request was prepared, the generation entered
`cross-thread-notification` containment. The handler failed, the process
closed, and later retirement found no active candidate. The authorized drain
was crash-like with zero intents. The replacement became ready and emitted no
generic restart notice, but the user's turn was interrupted rather than
continued.

The authorization was real; the authorized resume path was not reached in
time. This is separate from the stale-Claude/direct-restart false-notice bug
fixed and released in v0.37.2.

Review found three additional instances of the same ordering problem:

- `bot._stop()` only flips a loop flag. A `getUpdates` batch that returns after
  shutdown currently continues dispatching every update in that batch.
- shutdown sequentially awaits every open question's Telegram card edit and
  answers the old provider before starting clean retirement.
- Orchestra's `ProcessManager.retireForCleanRestart()` waits for every
  session's admitted lifecycle gate before it captures any session. An
  unrelated slow spawn can therefore delay capture of an already-active turn.

Moving only the 30-second loop would leave all three races.

## Goals

- Once an authenticated deploy restart is accepted, admit no later Telegram
  update into the old daemon.
- Begin the delivery fence and each eligible session's retirement without a
  natural-handler grace period or an unrelated session's lifecycle delay.
- Capture a normal foreground Claude or Codex turn before awaiting its handler
  settlement.
- Preserve the 30-second natural drain for ordinary signals and other
  non-authorizing stops.
- Preserve fail-closed retirement, exact-provider identity, one-shot intent,
  and all-or-nothing persistence rules.
- Prove exact continuation without printing message content or provider/session
  identifiers.

## Non-goals and honest exceptions

- Detached shells, subagents, scheduled work, and native background terminals
  remain unsupported across deploys.
- An interactive `ask` wait is not an exact-continuation case. Its question card
  has already produced reply-bearing output, so shutdown retains the current
  cancellation plus visible recovery behavior rather than pretending it is
  safe to continue invisibly.
- A provider turn that already emitted reply-bearing output remains ineligible.
- Direct `systemctl restart`, reboot, OOM, and ordinary signals do not authorize
  continuation.
- Cross-thread containment and outcome-unknown mutation policy are not relaxed.
- Partial continuation when any process retirement is unverified remains out
  of scope.
- This stage does not claim the whole smooth-deploy project complete if the
  production-representative aged-warm-process gate still fails.

## Chosen design

### 1. Make Telegram polling stop at an exact admission boundary

Define admission as the check immediately before `bot.handleUpdate(update)`.
The manual poll loop will:

1. Recheck its running flag immediately after `getUpdates` returns and before
   every item in the returned batch.
2. Never call `handleUpdate` for an item after `_stop()` has closed admission.
3. Persist the polling offset only through the last prefix item actually handed
   to `handleUpdate`, using a checked/throwing critical DB write rather than the
   best-effort `dbWrite()` wrapper.
4. Leave the unhandled suffix beyond the saved offset so the replacement daemon
   receives it normally and exactly once.

An item already inside `handleUpdate` when shutdown begins is already admitted;
the delivery and ProcessManager fences below govern any later side effect.
Expose a poll-quiescence promise so shutdown can start provider retirement
immediately, then join the admitted item and persist its handled-prefix offset
before handler settlement and DB close. The poll loop must not acknowledge an
unhandled item merely because it was present in a fetched batch.

If the critical prefix-offset commit fails, latch a poll-persistence failure,
make shutdown crash-like, and persist no continuation intents. The replacement
may receive the admitted prefix again (at-least-once failure semantics), but the
uncommitted suffix is never silently lost. “Exactly once” applies only after the
checked prefix commit succeeds; a storage failure is surfaced, not disguised as
a clean deploy.

### 2. Remove question-network waits from the pre-retirement path

Add a shutdown-specific question disposition; do not weaken normal question
expiry's answer-before-terminal invariant.

This new disposition applies only to `continuationAuthorized === true`. For
every question already open when an authorized shutdown starts, it will:

- initiate the existing cancellation card edit so it is registered with the
  delivery barrier;
- synchronously mark the question row cancelled without answering or resuming
  the old provider; and
- return the card-edit promise without awaiting network completion.

After all card edits are registered, authorized shutdown starts
`prepareCleanRetirement()`. Its delivery fence drains those already-admitted
edits while ProcessManager retirement starts concurrently. Thus a slow question
edit in one chat cannot delay candidate capture in another. The delivery drain
still must settle before clean persistence or DB close.

Question-owning sessions remain ineligible because their prior/card output is
real. The old provider is retired, not resumed by a synthetic cancellation
answer. This preserves safety and makes the user-visible exception explicit.

For ordinary signals, retain the existing `expireQuestion()` behavior: answer
the old provider with cancellation and await the card edit before the bounded
natural drain. This gives the blocked ask its existing opportunity to settle
naturally and keeps non-authorizing behavior unchanged.

Media groups already admitted to the buffer are synchronously removed from the
live buffer, coalesced, and marked for replay before the retirement transaction
starts. This work performs no provider or Telegram network call.

### 3. Split authorized deploys from legacy natural draining

After polling admission is closed and the synchronous ingress dispositions
above are registered:

- `continuationAuthorized === true` calls `prepareCleanRetirement()`
  immediately, with no legacy natural-handler wait.
- every non-authorizing shutdown keeps the existing bounded 30-second natural
  drain before clean process teardown.

The authorized flow is:

```text
authenticated deploy request
  -> close Telegram admission at the batch-item boundary
  -> register question cleanup; disposition buffered media synchronously
  -> fence reply delivery + freeze ProcessManager admission
  -> capture each active candidate without unrelated-session delay
  -> exact provider interrupt/retirement
  -> await handler and admitted-delivery settlement
  -> atomically persist clean marker + eligible intents
  -> exit; systemd starts the replacement
```

No second interrupt or resume mechanism is added.

### 4. Remove cross-session waiting before Orchestra candidate capture

`ProcessManager.retireForCleanRestart()` will atomically close every public
entry point that can append a lifecycle gate before taking its session union.
This includes spawn/get-or-create, kill, expected-process retirement, and model
settings status/selection paths. `_withLifecycleGate()` must reject external
post-fence admission; if clean retirement needs a gated internal operation, it
uses a private retirement-only path that callers cannot invoke. Retirement is
then coordinated per session:

- take the union of currently published process sessions and lifecycle-gate
  sessions after admission closes;
- for a session with no admitted lifecycle gate, capture and retire its current
  process immediately;
- for a session with an admitted gate, observe only that same session's gate
  settlement, then retire the process it published or left current regardless
  of whether the gate fulfilled or rejected; and
- run those per-session retirement tasks concurrently, so one session's slow
  spawn/replacement cannot delay another session's active-turn capture.

A process published by an already-admitted gate remains in the retirement set.
Each task preserves its gate failure while still attempting retirement. The
method does not return until every session task settles, and returns no
snapshots if either an admitted gate or retirement failed. Existing strict
backend retirement, Codex exact-turn matching, and all-or-nothing failure
remain unchanged. A regression must attempt every public gate-creating
operation after the fence and prove none can create a post-union process.

### 5. Preserve persistence and final evidence ordering

Eligible intents and the clean marker are committed only after:

- reply-bearing delivery is fenced and drained;
- every warm process is retired with verified backend evidence; and
- every dispatcher-owned handler settles.

`prepareCleanRetirement()` must join rather than abandon branches on failure:
start delivery drain and ProcessManager retirement together; observe both
settlements; perform fallback ProcessManager teardown if verified retirement
failed; join poll admission and then dispatcher handlers; and only then return
snapshots or throw the clean-retirement failure. Question-card promises are
part of the delivery drain. Crash-like persistence and DB close therefore never
race an unobserved retirement, delivery, ingress, or handler branch.

Preserve the existing OOM gate. An OOM observation skips clean retirement and
intent construction, performs ordinary ProcessManager teardown, then joins
question delivery, poll quiescence, and dispatcher handlers before crash-like
persistence and DB close—even when the original request was an authorized
deploy.

Recompute `in_flight` after retirement and handler settlement. Keep
`in_flight_at_signal` as the original pre-shutdown sample. Existing
`shutdown-drain.elapsed_ms` continues to mean legacy natural-drain time: it is
zero on the authorized path and retains the measured bounded wait on ordinary
signals. Retirement duration is not mislabeled as natural drain time.

An unrelated broken warm process can still fail the whole clean transaction.
That is safer than introducing partial ownership. Production has already shown
this blocker once, so the rollout includes an aged-warm-process gate and does
not declare smooth deploy complete unless it passes or yields a separately
specified causal fix.

## Alternatives rejected

- **Capture, then retain the 30-second grace:** unsafe because output and
  terminal state can change after capture.
- **Use a shorter grace:** any positive pre-fence window has the same race.
- **Await question cancellation first:** a Telegram request or provider answer
  can delay or change the candidate before retirement.
- **Wait every lifecycle gate globally:** lets an unrelated cold spawn erase an
  otherwise eligible active candidate.
- **Suppress the restart notice:** hides genuine ineligible or ambiguous work
  without preserving it.
- **Persist partial intents:** requires a new ownership model proving failed old
  processes cannot deliver or mutate after replacement.
- **Bundle Codex diagnostic telemetry:** it explains independent provider
  failures but does not fix this ordering; it has its own schema, privacy, and
  release gates.

## Failure modes

| Failure | Result |
|---|---|
| Fetched update is beyond the admitted prefix | Left beyond saved offset; replacement receives it |
| Critical polling-offset commit fails | Crash-like, zero intents; at-least-once prefix redelivery is explicit |
| Question card edit is slow or fails | Retirement still starts; delivery proof must settle or shutdown is crash-like |
| Active turn already produced output | Ineligible; visible recovery policy remains |
| Same-session lifecycle admission is unresolved | That session waits for its own gate; other sessions retire immediately |
| Any retirement or handler settlement is unverified | Crash-like shutdown; zero intents |
| OOM or provider containment occurs | Crash-like shutdown; zero intents |
| IPC response is cut | Reconcile exact request/service generation; never retry |
| Persistence fails | Crash disposition clears intents; replacement does not continue |
| Background ownership is active | Existing ineligible/notice behavior |

## Test and verification plan

### Red-to-green regressions

1. **Production symptom:** an authorized deploy with an active handler must
   start the delivery/process retirement barrier before that handler can settle.
   The current caller ordering must fail this test.
2. **Pending poll:** call `_stop()` while `getUpdates` is pending; a returned
   update must not reach `handleUpdate` and its offset must remain unacknowledged.
3. **Partial batch:** trigger restart while update 1 is handled; update 2 must
   never enter the old daemon, and only update 1's prefix offset may persist.
   Inject a prefix-offset write failure and prove shutdown is crash-like, no
   intent is committed, and the unacknowledged prefix/suffix remain recoverable.
4. **Question isolation:** an unrelated hanging question-card edit must be
   registered before the fence but must not delay capture/interrupt of an
   eligible active turn. The question row becomes cancelled without calling
   `pm.answerQuestion`. The question-owning session itself must produce no
   continuation intent, regardless of whether prior output or unresolved
   question state wins its ineligibility classification.
5. **Signal compatibility:** an ordinary signal still performs the bounded
   natural drain before retirement, uses existing provider-answering question
   expiry, and never creates continuation intents.
6. **Final counters:** authorized `in_flight` is sampled after retirement and
   settlement; `in_flight_at_signal` remains sampled before mutation.
7. **Per-session Orchestra gates:** an unrelated hanging lifecycle gate must
   not delay candidate capture/interrupt in an eligible session. A process
   published by an admitted same-session gate must still be retired before the
   all-or-nothing method returns, even when that gate rejects; the rejection is
   preserved and the method returns no snapshots.
8. **Failure joining:** a rejected delivery or retirement branch still joins
   the other branch, fallback teardown, poll quiescence, and handler settlement
   before crash-like persistence and DB close.
9. **OOM precedence:** authorized deploy plus a positive OOM observation joins
   question delivery, poll quiescence, ProcessManager teardown, and handlers,
   then records zero intents and a crash-like shutdown.
10. **Elapsed semantics:** authorized deploy reports zero legacy drain time;
    ordinary signal reports its actual bounded natural-drain duration.

All bug tests must be observed red on the unfixed sources and green after the
fix. Run the full Orchestra and Polygram suites and report every skip.

### Release and production gates

1. Ship the separately reviewed content-free Codex fault telemetry before the
   next active Codex production canary, so another provider failure is not
   opaque.
2. Use a name-bound, provider-bound, restart-request-bound metadata verifier.
   It may compare exact IDs internally but prints only booleans and counts—no
   message bodies, session keys, provider thread/turn IDs, or paths.
3. Idle authenticated restart: exact authorized drain, zero notices, unrelated
   service/tmux generations unchanged.
4. Foreground Codex turn: one eligible retirement snapshot, one intent, exact
   strict-resume attestation, one logical continuation result (regardless of
   Telegram chunk count), and zero restart notices.
5. Foreground Claude CLI turn after Ivan explicitly selects Claude: the same
   one-intent/one-continuation/one-result/zero-notice proof.
6. Repeat while a different Codex session has been continuously warm and idle
   for at least six hours, with no active turn or background ownership, and a
   second session is the foreground continuation target. If unrelated cleanup
   fails, stop: smooth deploy remains open and the telemetry selects the next
   causal fix.
7. Never retry an ambiguous restart.

## Definition of done for this stage

- Authorized deploys have no legacy pre-retirement drain, post-stop poll-batch
  admission, pre-retirement question-network wait, or unrelated-session
  lifecycle-gate wait.
- Ordinary shutdown behavior and continuation authorization boundaries remain
  unchanged.
- Normal foreground Claude and Codex canaries each prove exact resume, one
  continuation result, and zero restart notices.
- The aged-warm-process gate passes; otherwise this ordering stage is complete
  but the overall smooth-deploy goal explicitly remains open.
- Interactive questions and background work remain disclosed exceptions.
