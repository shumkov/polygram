# Persist exact Codex runtime identity before turn admission

Status: revised after implementation review; awaiting operator alignment
(2026-08-16)

## Problem and production evidence

The first live 0.38.4 foreground Codex canary proved that the new clean
retirement handshake works, but the deploy still could not create a
continuation intent.

Content-free production evidence for that restart shows:

- the exact `turn/start` had one `clean-retirement-requested` marker;
- the turn finished `interrupted`, its recovery state became `cancelled`, and
  its Codex generation became `retired`;
- the retirement snapshots were produced before shutdown persistence;
- shutdown then recorded `shutdown-persistence-fallback`, with no
  `shutdown-drain`, resume intent, or boot resume;
- the authoritative `agent_runtime_sessions` row matched the retired Codex
  thread, cwd, and spawn profile, but both `model` and `effort` were null;
- `recordCleanShutdown()` rejected the mismatch between that incomplete row
  and the exact model/effort carried by the retirement snapshot.

The rejection is correct. A continuation intent must not be minted when the
authoritative provider identity does not match the process being retired.

The nulls come from Polygram's Codex `onInit` callback. It reads
`entry.model` and `entry.effort`, but Orchestra 0.10.17's real `CodexProcess`
does not expose those top-level fields. The accepted settings live in
`entry.desiredSettings`, and the exact requested settings are supplied as
`spawnContext.modelSettings`. The existing callback test used an artificial
entry with top-level fields, so it could not reproduce production.

There is a second, latent form of the same ownership bug. On a warm Codex
process, `ProcessManager.getOrSpawn()` can apply new model/effort settings with
`selectModelSettings()` without emitting another `init` event. Fixing only the
cold-init field names would leave the durable row stale after `/model` or
`/effort` changes and make a later clean deploy fail the same identity check.

This is distinct from both prior fixes:

1. 0.38.3 preserved deploy-owned interrupted delivery until exact retirement;
2. 0.38.4 preserved the foreground canary's configured-scope proof;
3. this change makes the durable provider row accurately describe the provider
   thread lineage and settings that Polygram is about to use.

## Required invariant

Before a Codex `turn/start` request can reach the app-server transport, one DB
transaction must durably record both:

- the exact request-prepared turn attempt; and
- the exact provider thread, cwd, admitted model/effort, backend, and spawn
  profile owned by that registered process.

The settings must be the ones frozen for this turn, not merely mutable
next-turn settings selected earlier. If validation or persistence fails, that
turn—including a strict-resume literal `continue`—must remain definitely
not-sent. Clean shutdown and clean resume keep their existing exact comparisons
and fail-closed behavior.

## Chosen approach

### 1. Stop treating Codex `init` as the settings authority

Remove provider-session persistence from the Codex branch of
`createSdkCallbacks().onInit`, while retaining an explicit early return so a
Codex event cannot fall through into Claude's legacy/session dual-write.
Claude's init persistence is unchanged.

The real Codex init event establishes a provider thread but does not contain
the model/effort admitted to a user turn. Persisting from that event is both too
early and incomplete. A newly initialized idle thread with no admitted work
does not need continuation authority yet.

### 2. Join provider identity to the existing prepared-turn transaction

Orchestra already freezes `pending.admittedSettings` and exposes them as
`proc.admittingTurnSettings` before it calls `_mutation('turn/start', ...)`.
`_mutation` must await Polygram's durable `request-prepared` checkpoint before
it can attempt the app-server write. This is the authoritative admission
boundary.

When the runtime controller receives `kind='request-prepared'` and
`method='turn/start'`, it must validate against the current registered process:

- the current session and process generation still own the controller record;
- `proc.current` is the unsettled head of `pendingQueue`, and the payload's
  attempt, source-message, and client-message IDs exactly match that pending
  turn and its context;
- the pending turn is still pre-write (`startDeliveryState='preparing'`);
- `proc.current.admittedSettings` is the same frozen model/effort pair as
  `proc.admittingTurnSettings`;
- process state is either the ordinary `StartingTurn`/open-admission state or
  the exact shutdown race in which that same pending turn is `Quiescing`,
  and settings admission is closed;
- payload thread equals the process's non-empty provider session ID;
- cwd and spawn-profile ID are non-empty and still match the prepared receipt;
- `admittingTurnSettings` contains the exact bounded model and effort frozen for
  this turn;
- the process is open and owns the current host/boot generation.

A single public DB operation,
`recordCodexTurnStartPrepared({ checkpoint, provider,
expectedProviderGenerationId })`, then
uses one synchronous better-sqlite3 transaction to:

1. require an already-active durable generation with an initialized matching
   thread and an active daemon lease for the same generation/host/boot;
2. validate the exact prepared checkpoint, generation session key, and
   `checkpoint.threadId === provider.provider_session_id` binding, plus exact
   `codex:app-server` / `codex` / `codex` namespace-provider-backend values;
3. upsert `agent_runtime_sessions` with that provider thread, cwd, model,
   effort, backend, and spawn-profile ID; and
4. record the existing `request-prepared` attempt/checkpoint.

For strict resume, `buildCodexSpawnContext` carries the already-validated
claim's `expectedGenerationId` as internal spawn metadata. Polygram's process
factory passes it once into `registerProcess`; the controller stores it on the
immutable generation record only when the created process itself has
`spawnOptions.resumePolicy='require-interrupted-turn'`. Normal callers cannot
opt into or out of this check.

The transaction reads the existing provider-session lineage token and full
tuple before the upsert and requires:

```text
token before === claimed token === token after
```

The full pre-upsert tuple must also equal the strict provider input. A missing,
changed, or rotated row aborts and rolls back the prepared attempt, so strict
continuation cannot silently detach from the claimed intent even if the row is
replaced after attestation but before literal `continue` is prepared.

Any validation or statement failure rolls back both records. The ordinary
`thread/start` or `thread/resume` initialization checkpoint remains unchanged:
it establishes the process generation and daemon lease, but it cannot persist
the provider row because a fresh thread ID is not known before that request.
The controller must reject a first-ever `turn/start`; only initialization
`thread/start` or `thread/resume` may activate a new generation and lease.

Idempotency is exact and non-destructive. The first call commits the provider
tuple and checkpoint together. An exact duplicate succeeds as a no-op only
while the current provider tuple still matches. If a newer admitted turn has
advanced that tuple, replaying the older prepared attempt rejects as stale and
changes neither record; it must never rotate the provider token backward.

The existing provider upsert rules preserve the provider-session lineage token when
the tuple is unchanged. They rotate it when a warm turn legitimately admits new
model/effort settings. Both happen atomically before that turn's transport
write. No value is inferred from mutable chat configuration or a retirement
snapshot.

No schema change, `getOrSpawn` wrapper, new continuation field, or relaxed
shutdown comparison is required. Implementation review did find one older
Orchestra ordering gap at this same admission boundary, described below. This
supersedes the earlier conclusion that no Orchestra change was required.

### 3. Preserve strict-resume ordering

Strict spawn and attestation do not write the provider row. A rejected or
malformed resume therefore cannot rotate its durable lineage token.

Only after exact resume attestation does Polygram send literal `continue`.
That send reaches the same `turn/start` prepared checkpoint, where the unchanged
provider tuple is committed with the new attempt before the app-server write.
The provider-session lineage token remains the one already bound to the claimed
intent.

### 4. Distinguish pre-preparation shutdown from a prepared cancellation

Orchestra currently labels a newly activated turn `startDeliveryState =
'preparing'` before awaiting Polygram's static-policy attestor. If shutdown
begins during that await, `interrupt()` classifies the turn as definitely not
sent and records `active-start-cancelled`. That checkpoint is invalid because
the corresponding `request-prepared` attempt does not exist yet. Polygram
correctly rejects it, but the rejection durability-blocks teardown and defeats
the clean deploy.

The gap predates this identity-persistence change, but the original design's
shutdown-during-attestation claim was wrong. Orchestra must represent one
explicit preparation handshake without weakening Polygram's ledger:

- a newly enqueued turn begins with `startDeliveryState='queued'`; `_pump`
  changes only the active head to `attesting` before starting policy
  attestation;
- after static-policy attestation succeeds, Orchestra rechecks exact turn-start
  admission, changes the state synchronously to `preparing`, and immediately
  starts `_mutation`'s `request-prepared` checkpoint;
- the existing delivery callback changes the state to `prepared` only after
  that checkpoint returns successfully;
- the start-disposition proof preserves `checkpoint-committed`,
  `checkpoint-not-committed`, and `checkpoint-unknown` instead of flattening
  every pre-write sink failure to one definitely-not-sent result.

The checkpoint sink contract is explicit across the package boundary. A
fulfilled `request-prepared` sink call means the consumer committed the
checkpoint. Polygram may reject with a bounded typed disposition
`not-committed` only when its synchronous validation rejects before the
transaction begins or the SQLite transaction proves rollback with no committed
mutation. An untyped rejection, timeout, lost acknowledgement, or any error
after the consumer cannot prove zero mutation is `checkpoint-unknown`.
Orchestra preserves that typed disposition and the original durability cause
on the pending turn. It must never manufacture rollback proof from a rejected
Promise: only `not-committed` may take the definite rejection branch; unknown
outcomes enter containment.

There is no await between the post-attestation admission check, the transition
to `preparing`, and checkpoint invocation. JavaScript therefore permits
shutdown to observe only one of two safe sides: still `attesting`, when no
checkpoint can have started, or `preparing`/later, when interruption must wait
for the exact disposition. This also covers the microtask window after the DB
commit but before `_mutation` runs its `onDeliveryState('prepared')` callback:
the visible state is still `preparing`, so interruption waits rather than
assuming the attempt is absent.

`interrupt()` sets `startCancellationRequested` first. An `attesting` turn is
rejected and removed without writing `active-start-cancelled`; there is no
durable attempt to cancel, and the new admission recheck prevents the delayed
attestor from creating one later. A `preparing` turn waits for the existing
start-disposition proof. A committed prepared attempt receives the existing
`active-start-cancelled` checkpoint. An explicitly rollback-proven rejection
keeps the original durability failure and writes no cancellation; commit/ack
ambiguity keeps the stronger containment fence. Neither failure is recast as
an unprepared local cancellation.

An accepted active head remains a valid clean-restart candidate when its
`pendingQueue` also contains exact untouched `queued` followers. Candidate
capture still requires the active head's accepted turn, identity, settings,
and source to match exactly, and rejects any follower that is active, settled,
already preparing, or lacks its source/client/attempt identity. The candidate
and continuation intent describe only the active head. Clean interruption
durably drains every waiting follower with `queued-send-cancelled` and the same
first-owner restart reason before settling the active turn. Failure to record
any queued cancellation fails retirement; it cannot silently mint the active
turn's continuation intent.

ProcessManager also passes its existing exact retirement reason into
`CodexProcess.interrupt()`. Both `active-start-cancelled` and
`queued-send-cancelled` persist that bounded reason. The authorized deploy path
therefore records `reason='clean-restart'`, while user `/stop`, timeout,
runtime-switch, ordinary shutdown, and other interruption owners remain
distinct. The first interrupt owns the reason for the cached interrupt promise;
later callers cannot relabel it.

This remains fail-closed: a turn with an unknown preparation outcome is never
treated as an unprepared cancellation, and a turn with a durable prepared
attempt is never discarded without its durable cancellation.

### 5. Replay a definitely-not-sent foreground message without a notice

Cancelling before preparation solves process teardown but is not enough for the
user. The inbound Telegram row can remain `replay-pending` with an exact Codex
runtime selection and either no dispatch reservation or a `reserved` /
`queue-authorized` reservation, but no turn attempt. Existing replay
classification defers that shape indefinitely; the message would receive
neither continuation nor a fresh dispatch.

The DB's write-before-provider-send invariant makes this absence positive
evidence. The safe shapes are deliberately exact:

- selection-only means one exact Codex runtime selection, no reservation, no
  attempt, and no linked input;
- reservation-only means exactly one matching `reserved` or
  `queue-authorized` reservation, no steer/target/primary/linked attempt;
- prepared-only means one matching `turn/start` attempt with
  `deliveryState='prepared'` and `recoveryState='prepared'`, no linked or
  conflicting evidence, and either no reservation or exactly one matching
  `queue-authorized` reservation with no steer/target ID; and
- deploy cancellation means one matching `turn/start` or synthetic
  `queued/send` attempt with `deliveryState='prepared'`,
  `recoveryState='cancelled'`, `turnId === null`, `terminalStatus === null`, no
  linked or conflicting evidence, and the matching `active-start-cancelled` or
  `queued-send-cancelled` checkpoint with validated exact cancellation
  provenance `reason='clean-restart'`. The same exact optional-reservation rule
  applies to the cancelled `turn/start` shape.

`request-write-attempted` is committed before Orchestra writes to the
app-server transport, so exactly `prepared` is positive no-write evidence;
every later or partially populated state remains ambiguous. The identical
cancellations under user stop, timeout, or any other reason remain skipped.
Linked, conflicting, or otherwise ambiguous evidence remains deferred.

`getReplayProviderRecovery()` must expose the real nested attempt, reservation,
and linked-input records plus a validated cancellation proof. That proof is
returned only when one exact attempt/generation is durably `prepared` then
`cancelled`, has the expected cancellation checkpoint kind, and its bounded
checkpoint detail contains exactly `reason='clean-restart'`; absent, malformed,
conflicting, or differently owned provenance is not clean-safe. Its structured
evidence grammar must explicitly admit the synthetic `queued/send` plus
`queued-send-cancelled` shape above. Every other `queued/send`, partial
cancellation, unsupported method, or cancellation from a non-prepared durable
state remains unknown/deferred rather than being generalized as safe.

`classifyCodexRecoveryEvidence` consumes that structured output while retaining
its existing flat input compatibility for callers and tests. It marks only the
four exact classes above as `cleanRestartSafe` recoveries. On a clean boot,
`classifyReplay` keeps these exact Codex recoveries in `recoverCodex`; it does
not fold them into the legacy skip-and-notice set. Other explicitly cancelled
work still skips, and any acceptance ambiguity still defers.

Safe classification is not itself permission to reuse an old reservation.
Reservation IDs are deterministic per Telegram input, while every old
reservation is bound to the retired process generation. The clean Codex
recoverer therefore uses one purpose-built transaction before dispatch:

`prepareCodexCleanReplay({ source, sessionKey, currentGeneration,
expectedEvidence, owner })`

The transaction re-reads—not trusts—the expected content-free evidence, then:

1. requires the exact inbound row to remain `replay-pending`, its runtime
   selection to remain Codex/session-exact, and the evidence fingerprint to be
   one of the four clean-safe shapes;
2. requires `currentGeneration` to be the current active Codex generation and
   daemon lease for the same session, host, and boot;
3. creates the deterministic reservation when none exists, or rebinds the one
   exact safe old reservation to `currentGeneration`; in both cases the result
   is `reserved` with null steer/target/settled fields; and
4. changes the inbound row to `replay-attempted` in the same transaction.

Any mismatch observed by the transaction rolls back both the reservation and
one-shot guard. Old turn attempts remain immutable; after commit, the inbound
guard makes the rearm a one-shot consume. A process-generation drift between
commit and handler admission follows the same rule as a crash in that window:
the row remains `replay-attempted`, the rebound reservation remains in its last
durable `reserved` or `queue-authorized` state, and the expected-process fence
allows no replacement process to receive it. There is no compensating rollback
or second automatic rearm. This intentionally retains the existing
redelivery-tail trade-off: a second crash or post-commit drift may leave the
input consumed and unanswered, but it never fabricates another provider send.

The recoverer runs the ordinary redelivery content gate before rearm. A blocked
abort/admin-shaped row is terminalized without rearming or executing it. After
a pass, the recoverer obtains an exact current Codex process, commits the
transaction, and passes the returned reservation receipt as trusted internal
metadata into the normal handler. The handler revalidates that the process,
generation, and reservation are still current, marks the reservation
`queue-authorized`, and attaches it to the ordinary `sendToProcess` and Telegram
delivery-finalizer path. Process drift fails before transport. The generic
redelivery premark is disabled for this path because the rearm transaction owns
the one-shot mark.

If the same session also owns a one-shot continuation intent, Codex replay waits
for that session's tracked clean-resume task before re-dispatch. The coordinator
must retain a terminal result for every scheduled intent instead of swallowing
errors into `undefined`: success resolves with its actual result; a thrown
resume is captured as an explicit failed result. The replay barrier proceeds
only when the expected result set is complete and every result is
`status='replied'`. A failed, skipped, thrown, undefined, or missing result
leaves the follow-up deferred before replay premark, replay guard, or transport;
it must not dispatch against a failed or durability-blocked process. After
success, the interrupted turn has continued and delivered first, so a
definitely-not-sent follow-up becomes a later exact Codex turn rather than
racing strict spawn or being injected twice. No message body enters lifecycle
telemetry.

This wait is session-scoped, not a boot-wide await. Before polling opens, boot
groups every safe saved follower by session in original Telegram order,
registers one barrier for that session, and schedules an ordered tracked chain:
continuation first, then each saved follower. Replay planning and polling
continue for unrelated sessions. The normal dispatcher awaits only its own
session's barrier, so ordinary fresh/edit/replay ingress cannot overtake the
saved chain.

The coordinator owns a private in-memory capability scoped to one exact saved
replay receipt. The barrier-owned handler must present that capability to
bypass its own session barrier; it is never serialized into a Telegram message,
accepted from caller input, or reusable by ordinary ingress. This prevents the
recovery chain from deadlocking on itself while keeping all external messages
behind it.

The barrier remains closed until every saved follower, in order, has either
passed the redelivery gate and reached the normal `onDispatched` admission point
or been terminally blocked by that gate. Once a follower is admitted, the
process queue owns its position and the chain advances to the next follower.
If follower N fails or drifts before admission, N remains in its exact
precommit-deferred or postcommit-consumed state, followers N+1 and later remain
deferred without rearm, and the chain stops. Once those dispositions are
durable, the coordinator releases the session barrier so ordinary ingress does
not deadlock; the current process's own durability and exact-process fences
still govern whether that fresh work can proceed. The recovery handlers remain
tracked through terminal delivery after admission. A continuation failure
likewise releases the barrier without rearming any saved follower.

## Failure modes

- **Missing or mismatched live identity/settings:** reject the prepared
  checkpoint; `_mutation` reports definitely-not-sent and no app-server write
  occurs.
- **Rollback-proven DB/checkpoint failure:** roll back the provider row and turn
  attempt, return the typed `not-committed` disposition, and admit no provider
  write. Pre-existing work, if any, is not reclassified by this failed caller.
- **Untyped checkpoint failure or acknowledgement loss:** do not claim the
  transaction rolled back; containment-fence the exact generation.
- **Shutdown before settings freeze:** settings admission closes and no prepared
  transaction occurs.
- **Shutdown during the static-policy wait:** interruption cancels the
  pre-preparation pending send without inventing an `active-start-cancelled`
  checkpoint. When the attestor later returns, the admission recheck prevents
  any prepared checkpoint or transport write. Boot safely re-dispatches the
  exact definitely-not-sent foreground input, without a restart notice.
- **Shutdown after preparation starts:** interruption waits for the exact
  disposition. A committed prepared attempt receives
  `active-start-cancelled`; a definite rejection remains durability-fenced and
  commit/ack ambiguity remains containment-fenced.
- **Same-session continuation plus unsent follow-up:** boot completes the
  tracked one-shot continuation before replaying the follow-up as a later turn;
  unrelated sessions and polling do not wait.
- **Same-session continuation failure:** leave the follow-up deferred without
  crossing its replay guard or dispatching into the failed process.
- **Replay rearm conflict or precommit process drift:** roll back the rebind and
  one-shot mark; do not cross provider transport.
- **Postcommit process drift:** retain the one-shot consumed row and last
  durable reservation state; the exact-process fence prevents transport to a
  replacement generation.
- **Crash after replay rearm:** the existing one-shot `replay-attempted` guard
  prevents another automatic send. This favors duplicate prevention over a
  second automatic retry.
- **User or timeout cancellation:** never reinterpret it as deploy-owned
  replay authority; cancelled work remains skipped.
- **Conflicting or ambiguous replay evidence:** defer without redispatch or a
  misleading proof of safety.
- **Shutdown after the prepared transaction:** the durable provider tuple and
  attempt already agree. If the later transport write is fenced, there is no
  active continuation candidate; if it succeeds, retirement sees the same
  admitted settings.
- **Strict attestation failure:** the provider row and lineage token remain
  unchanged because no `continue` turn was prepared.
- **Ordinary shutdown or crash:** gains no new continuation authority.
- **Clean-shutdown mismatch:** retains the existing crash-like fallback with
  zero intents.

## Alternatives rejected

### Relax `recordCleanShutdown()` identity checks

This would turn missing or stale provider metadata into continuation authority
and could resume the wrong settings or generation. The production rejection is
the safety mechanism working as designed.

### Read `entry.desiredSettings` only in `onInit`

That fixes cold spawn but misses warm model/effort changes, which do not emit
another init event.

### Persist immediately after `getOrSpawn`

`getOrSpawn` confirms mutable next-turn settings, not the settings frozen for a
specific queued turn. It also returns outside the manager's lifecycle gate.
Shutdown could begin before the later write/send, allowing an unadmitted new
setting to replace the provider row while retirement snapshots an older active
turn. Strict resume would also mutate the row before attestation. The prepared
turn checkpoint is later, exact, and already transport-fenced.

### Add a new Orchestra settings callback

It would require another cross-repo release and still leave Polygram to join
the callback to durable turn admission. The existing request-prepared
checkpoint already supplies that exact boundary.

### Allow `active-start-cancelled` to create a missing attempt in Polygram

This would make the durable ledger claim an admitted attempt that never passed
the preparation boundary. The correct owner of that distinction is Orchestra,
which knows whether its pre-transport checkpoint started and completed.

### Wait for the complete settings gate before interrupting

This makes shutdown latency depend on static-policy attestation and still
requires distinguishing attestation failure from a committed prepared attempt.
The explicit preparation states preserve the same proof without unnecessarily
holding shutdown open.

### Leave the pre-preparation Telegram input deferred

This prevents a duplicate but strands work that the ledger proves never
crossed the provider boundary. It also contradicts the smooth-deploy goal by
forcing the user to notice and resend. Exact clean-safe Codex replay is both
safer and less disruptive.

## Test and verification plan

Follow red to green for the production regression.

1. Replace the artificial Codex init fixture with the real Orchestra shape
   (no top-level model/effort) and prove Codex init performs zero provider writes
   and zero legacy Claude-session writes.
2. Unit-test the purpose-built DB transaction: an exact `turn/start` atomically
   writes the provider tuple and checkpoint; wrong session/thread/generation or
   a forced checkpoint conflict rejects and leaves both the provider row and
   attempt unchanged. Exercise rollback in both directions: a forced provider
   upsert failure leaves no prepared attempt, and a checkpoint conflict leaves
   the prior provider tuple untouched. Exact duplicate replay is a no-op while
   the tuple matches; replay after a newer admitted tuple rejects without
   reverting it. Wrong stable host, boot session, lease generation/status, and
   a pre-existing conflicting attempt must also leave both records unchanged.
3. Prove initial `thread/start`/`thread/resume` preparation creates the Codex
   generation and lease but no provider row; the first later `turn/start`
   creates the complete row. A first-ever `turn/start` is rejected.
4. Unit-test the runtime controller's current-process and
   `admittingTurnSettings` checks. A DB failure must propagate through the
   prepared checkpoint, leave the turn definitely not sent, transition the
   process to its existing `DurabilityBlocked` fence, and start no automatic
   retry. Stale attempt/source/client IDs, a non-head or settled pending turn,
   settings mismatch, closed process, wrong host/boot, non-current or
   non-durable generation, and durability-blocked owner all produce zero DB
   mutation and zero fake-transport writes.
5. In the real installed-Orchestra + real SQLite integration, change warm
   model/effort settings, admit the next turn, and prove the provider row and
   provider-session lineage token rotate at request preparation before the fake
   app-server observes `turn/start`. This must fail on current code because the
   row stays stale.
6. Reproduce the production failure end to end with the real Codex process
   shape: retire an active turn, build its resume intent, then call
   `recordCleanShutdown()`. Expected red is the exact `provider session changed`
   rejection, zero intents, and no clean-shutdown stamp; expected green is one
   exact intent and stamp.
7. Test strict resume twice: rejected attestation leaves the provider row/token
   unchanged and sends no turn; successful literal `continue` commits the same
   tuple at request preparation, proves inside that transaction that the
   claimed lineage token was preserved, then crosses the transport boundary.
   A forced prepared-transaction failure sends no `continue`, leaves the process
   durability-fenced, and starts no automatic retry. Replacing the provider
   lineage token after strict attestation but before preparation must likewise
   send no `continue` and durability-fence the process.
8. Add an Orchestra regression that pauses static-policy attestation, begins
   interruption before preparation, and uses a checkpoint sink that rejects
   cancellation of a missing attempt. Current Orchestra must fail with
   `CODEX_DURABILITY_FAILED` whose cause chain contains that exact invalid
   cancellation. Fixed Orchestra must complete interruption before the fake
   attestor is released, reject the send as interrupted, record neither
   `request-prepared` nor `active-start-cancelled`, and make zero `turn/start`
   writes. After teardown completes, release the attestor and prove there is no
   late checkpoint, transport write, state revival, current-process
   reattachment, or unhandled rejection.
9. Exercise three checkpoint-started orderings deterministically: a fulfilled
   checkpoint that commits after interruption receives exactly one
   `active-start-cancelled` and no `turn/start`; an explicitly typed
   `not-committed` rejection writes no cancellation and preserves the original
   durability cause; an untyped rejection, lost acknowledgement, or
   never-settled checkpoint reaches the unknown/containment branch rather than
   being mistaken for rollback-proven. Separately pin the
   commit-to-callback microtask gap by resolving the checkpoint and scheduling
   interruption before `_mutation`'s prepared callback; interruption must wait
   and still produce exactly one cancellation. Drive cancellation through
   ProcessManager and prove clean retirement emits exact
   `reason='clean-restart'` for both active and queued cancellation checkpoints;
   direct user interrupt and timeout cannot emit that value, and a later caller
   cannot relabel the cached first-owner interrupt reason.
10. With real SQLite, cover actual structured replay evidence for
   selection-only, exact reservation-only, exact prepared-only, cancelled
   `turn/start`, cancelled synthetic `queued/send`, linked, ambiguous, and
   conflicting Codex inputs. Assert the DB exposes a clean-restart cancellation
   proof only for one exact attempt/generation in
   `deliveryState='prepared'`/`recoveryState='cancelled'`, null turn and terminal
   status, expected checkpoint kind, and bounded `reason='clean-restart'`;
   missing/malformed/conflicting provenance, cancellation from any other
   durable state, unsupported or partial `queued/send`, and identical
   user-stop/timeout cancellations remain skipped or deferred. Exercise
   prepared/cancelled `turn/start` with no reservation and with exactly one
   matching `queue-authorized` reservation carrying no steer/target ID; every
   other reservation combination defers. On
   a clean restart, only the four exact safe shapes enter the dedicated Codex
   recoverer; none enters the restart notice group. If the same session has a
   continuation task, assert recovery runs strictly after a complete result
   set in which every result is `status='replied'`; failed, skipped, thrown,
   undefined, and missing results defer before replay premark, guard, or
   transport is crossed.
11. Test `prepareCodexCleanReplay` transactionally for every safe shape with
   and without an old reservation. It must rebind/create the deterministic
   reservation under the new active generation and mark the inbound
   `replay-attempted` together; stale evidence, wrong generation/lease,
   conflicting reservation, and forced writes roll back both. Drive the receipt
   through the real handler/dispatcher and new generation to prove the normal
   claim conflict is gone, reservation settlement still follows Telegram
   delivery, and no transport occurs before commit. Simulate a crash
   immediately after commit and prove the one-shot row is not selected again.
   Pin process drift before the transaction, after commit while the receipt is
   `reserved`, and after `queue-authorized`: precommit drift rolls back;
   postcommit drift remains consumed in the last durable state; none sends to a
   replacement process.
12. Test an active accepted turn with one or more exact queued followers.
   Candidate capture must still produce one intent for the active head; clean
   interruption must emit deploy-owned queued cancellations; boot must continue
   the head first, then rearm and dispatch each follower in order. User/timeout
   cancellation and any malformed follower remain ineligible. Prove a long
   continuation blocks only that session: unrelated recoveries complete and
   polling/admission open while its barrier is pending. With at least two saved
   followers, pause between admissions and inject fresh same-session input; the
   private barrier-owner capability lets only the exact recovery handlers pass,
   the fresh input stays behind both followers, and the barrier releases only
   after the full ordered chain is admitted. If follower N fails before
   admission, N+1 and later remain deferred and are never reordered; after
   those dispositions are fixed, the waiting fresh input is released rather
   than deadlocking the session.
13. Add a real installed-Orchestra + SQLite Polygram integration for the paused
   attestor race. It must instantiate the package exported from `node_modules`,
   assert the consumed exact Orchestra version, prove no prepared attempt or
   transport write, persist clean shutdown, and classify the exact source for
   clean-safe Codex redispatch without a notice. Add a complementary
   cancellation-bearing integration that proves installed Orchestra emits the
   exact deploy reason into SQLite and that this provenance—not a hand-seeded
   fixture—is what enables clean-safe redispatch.
14. Release the reviewed Orchestra change, consume its exact version in
   Polygram, and prove the installed dependency—not a source mock—carries the
   fixed ordering.
15. Run focused tests, the full suite, independent code review, and the local
   foreground Codex canary. The release is complete only when the canary records
   clean shutdown, boot resume, and a successful one-shot continuation receipt
   without the restart notice.

Background-work survival and the postponed aged-warm qualification remain out
of scope. Claude behavior and its rollout flag remain unchanged.
