# Preserve Codex deploy ownership across delivery settlement

Status: independently reviewed, operator-approved, and implemented
(2026-08-16)

## Problem

An authorized deploy can durably interrupt and clean an exact Codex turn, yet
lose the continuation before the retirement snapshot is classified.

The foreground 0.38.2 production canary reproduced this race:

- the canary authorized one exact active Codex turn;
- `turn/interrupt` was prepared, written, and accepted;
- the exact source attempt reached durable terminal status `interrupted`;
- `stop-terminal-reconciled`, background cleanup acceptance, and a fresh empty
  background registry were all durably recorded;
- while that stop was still being retired, the Telegram handler processed the
  Codex result `{ error: 'interrupted' }` and recorded
  `telegram-delivery-failed`;
- the current delivery transition changed the source attempt from
  `clean-pending` to ordinary `settled` and classified its consumer outcome as
  failed;
- `settleCodexStoppedGeneration()` then found no unresolved interrupted target
  to claim as `stop-cancelled`, so the consumer verifier returned a generic
  retired disposition;
- Orchestra correctly rejected that weaker result as
  `retirement-binding-mismatch`; Polygram recorded zero continuation intents.

The handler error was the literal bounded value `interrupted`, not a provider
rejection. The old daemon completed a request-bound handoff and the replacement
opened admission. No clean-resume, replay-notice, or outbound message followed
because no continuation intent existed.

This is separate from the foreground-canary retry-gate bug. That gate is fixed;
this race is in the real Codex retirement ownership path that the newly
unblocked canary exercised.

## Required invariant

Delivery settlement may defer an interrupted Codex result only when an
operator deploy durably claimed that exact active turn before interruption
began. Neither the error string, `terminal-pending`, nor `clean-pending` is
sufficient proof:

- provider, timeout, and user-stop paths can also report `interrupted`;
- `turn/completed(interrupted)` can arrive before the `turn/interrupt` RPC
  response, while the source is still `terminal-pending`;
- both stop and background reconciliation currently produce `clean-pending`.

## Chosen approach

Add a fail-closed, exact pre-interrupt durability handshake between Orchestra
and Polygram.

### 1. Orchestra establishes ownership before interrupting

Extend `ProcessManager` with a synchronous Codex retirement preparer alongside
the existing post-stop retirement verifier. Polygram enables that preparer on
the per-call retirement options only when the shutdown was authenticated as an
authorized continuation deploy. Routine signals and other clean stops never
invoke it and retain their existing behavior.

During `retireForCleanRestart()`, after lifecycle admission is closed, lifecycle
gates are drained, and `captureCleanRestartCandidate()` returns one exact
candidate, Orchestra must:

1. call the preparer with the candidate's exact session, generation,
   attempt, provider session, provider turn, and source-message identities;
2. require an acknowledged result with the same complete binding;
3. only then call `proc.interrupt()` through strict retirement.

The preparer performs a synchronous better-sqlite3 transaction and returns its
acknowledgement in the same call stack. Orchestra rejects a Promise return; no
independent acknowledgement timer or asynchronous commit is permitted. If
preparation is missing, throws, returns asynchronously, or returns any
mismatched or partial binding, `retireForCleanRestart()` fails without sending
its primary deploy interrupt. The existing clean-shutdown helper may then run
ordinary fallback teardown, which can interrupt or close the process, but that
path is crash-like and can return no snapshot or continuation intent. A Codex
process with no eligible active candidate keeps the existing no-continuation
retirement path.

### 2. Polygram records one exact durable marker

The runtime controller's preparer validates that the candidate belongs to the
current registered Codex process, then calls a purpose-built DB transaction.
That transaction atomically validates the durable attempt and inserts or
accepts the marker, including:

- current host and boot ownership;
- current generation and session;
- `turn/start` method;
- exact attempt, provider session, provider turn, and source message;
- `delivery_state = 'response-observed'` and `response_outcome = 'result'`;
- `recovery_state = 'active'` and `terminal_status IS NULL`;
- an exact `turn-accepted` checkpoint for the same attempt and turn.

It then records an idempotent, content-free
`clean-retirement-requested` checkpoint for that exact attempt. An exact replay
succeeds as a no-op only while the attempt still satisfies the same live-state
predicate; a stale, terminal, `clean-pending`, or conflicting replay rejects.
This purpose-built path must not use the generic checkpoint early-return that
can acknowledge an existing row without revalidating current attempt state.

Preparation does not set the controller's existing `retirementRequested`
flag. That flag remains exclusive to the post-stop verifier because it enables
generation retirement. The durable checkpoint alone represents preparation.
No message body, prompt, response, filesystem path, or provider payload is
stored.

The marker is a durable authorization, not a continuation intent. A
continuation still requires the existing later proof: exact interrupted
terminal, successful stop reconciliation, fresh empty background registry,
healthy stopped generation, strict retirement binding, delivery fencing, and
the clean-shutdown intent transaction.

### 3. Failed delivery cannot steal a marked interrupted turn

For `telegram-delivery-failed`, the DB transaction continues to validate and
insert the exact delivery checkpoint. It defers ordinary consumer settlement
if and only if all of these are true in that same transaction:

- the attempt is `turn/start` for the exact generation and turn;
- terminal status is `interrupted`;
- recovery state is `terminal-pending` or `clean-pending`;
- the same attempt has the exact durable `clean-retirement-requested`
  checkpoint.

The source attempt, linked inputs, and dispatch reservation remain unchanged
for `settleCodexStoppedGeneration()` to claim atomically as `cancelled` with
the exact `stop-cancelled` result. A late delivery after the live record has
already retired continues to use the controller's cached exact
`stop-cancelled` acknowledgement without adding another checkpoint.

When a delivery checkpoint is deferred after the process is already healthy
and closed, `recordCodexDeliveryCheckpoint()` reports the deferral instead of
trying to retire an unresolved generation. The post-stop verifier remains the
only path that can claim the exact source and retire that generation.

All unmarked interruptions and all completed or failed terminals retain their
current delivery settlement behavior.

### 4. Existing continuation transaction remains authoritative

The handler may still finish its shutdown error path and mark the Telegram
message row failed/replay-pending. That row is not continuation authority.
After exact retirement succeeds, the existing clean-shutdown transaction
persists one one-shot continuation intent. Boot atomically claims it and marks
the exact source `resume-attempted` before strict Codex resume plus `continue`.

No new DB table or column is required. The change adds one allowlisted
checkpoint kind and one narrow Orchestra callback contract, so Orchestra must
be released and Polygram must consume that exact version before the canary is
repeated.

## Why this is safe

- Ownership is recorded before either valid Codex ordering: interrupt response
  before terminal notification, or terminal notification before interrupt
  response.
- A bare `interrupted`, `terminal-pending`, or `clean-pending` row is never
  trusted. Background reconciliation cannot manufacture the exact deploy
  marker.
- The preparer and verifier bind the same exact candidate; stale generation,
  wrong host/boot, conflicting duplicate, missing, or changed identity fails
  closed. An exact active replay is an acknowledged no-op.
- The marker alone cannot create an intent. Cleanup and strict retirement must
  still independently prove the exact stopped turn and zero unsafe delivery.
- Only the authenticated deploy path can request preparation. A routine signal
  cannot create deploy ownership or change delivery settlement.
- Preparation failure prevents the primary deploy interrupt. Existing fallback
  teardown may still interrupt or close the process, but it remains crash-like
  with zero snapshots and intents. A process crash or throw after the
  synchronous marker commit but before Orchestra observes the acknowledgement
  cannot authorize original-message redispatch or a continuation. Fallback may
  either exact-cancel and retire the target or leave it unresolved and fenced.
- The marker does not set the post-stop `retirementRequested` flag and cannot
  retire or remove the live controller record by itself.
- The existing one-shot intent transaction and boot claim remain the only
  authorization for `resume` plus `continue`.
- No user content or secret-bearing identifier is added to telemetry.

## Alternatives rejected

### Preserve every interrupted `terminal-pending` attempt

This confuses deploy interruption with provider, timeout, or user-stop
interruption and could resume work the user explicitly stopped.

### Infer ownership from `clean-pending`

This fixes the observed stop-response-first trace, but not the valid
terminal-notification-first trace. Background reconciliation also assigns the
same state, so it is not a unique ownership proof.

### Call a Polygram-only preparer before `retireForCleanRestart()`

Only Orchestra closes lifecycle admission, drains lifecycle gates, and captures
the exact process candidate. Preparing outside that boundary can mark a stale
or superseded process. The callback belongs inside the existing manager
retirement sequence.

### Use an asynchronous preparer with a timeout

The durable commit could win a race with the timeout while Orchestra observes
no acknowledgement. The required better-sqlite3 write is synchronous, so an
async contract adds an avoidable authority seam. The manager rejects Promise
returns instead.

### Accept generic `retired` as eligible

This would erase the exact interrupted-turn binding and could resume the wrong
or already-delivered work. Orchestra's strict predicate is correct.

### Reorder promises or suppress the handler error

Scheduling is not an ownership proof, and presentation changes do not persist
a continuation.

## Failure modes

| Condition | Result |
|---|---|
| routine signal or non-authorizing stop | no marker; existing retirement behavior |
| preparer throws, returns a Promise, or binding differs | primary retirement sends no interrupt; helper fallback is crash-like with zero snapshots/intents |
| terminal commits immediately before preparation | preparation rejects; primary retirement sends no interrupt |
| marker commits but callback throws before acknowledgement | zero snapshot/intent and no original redispatch; fallback may exact-cancel/retire or leave the generation fenced |
| exact marker + interrupted `terminal-pending` | record failed delivery; retain deploy ownership |
| exact marker + interrupted `clean-pending` | record failed delivery; retain deploy ownership |
| interrupted without exact marker | ordinary failed-delivery settlement |
| background-only `clean-pending` | ordinary failed-delivery settlement |
| completed or failed terminal | ordinary delivery settlement |
| exact stop and delivery proof succeed | source becomes `cancelled`; snapshot receives exact `stop-cancelled` binding |
| cleanup or verifier fails after preparation | no intent; accepted source remains fenced for recovery/quarantine |
| crash after marker but before stop settlement | no intent; boot does not redispatch provider-accepted source |
| crash after stop cancellation but before intent persistence | no intent; cancelled source is not redispatched |
| crash after atomic intent persistence | boot claims exactly one intent and marks source `resume-attempted` before continuation |

## Test and verification plan

Follow red-to-green TDD with deterministic barriers, not sleeps.

1. Add an integration regression test for the production ordering: pause after
   `stop-terminal-reconciled`, settle failed Telegram delivery while retirement
   is unresolved, then release cleanup. Current code must fail with
   `retirement-binding-mismatch`; fixed code must produce one exact eligible
   snapshot.
2. Add the reverse-order regression: emit and durably record
   `turn/completed(interrupted)`, hold the interrupt RPC response so no stop
   reconciliation exists yet, settle failed delivery, then release the
   response. It must reach the same exact eligible snapshot.
3. In both cases prove the exact marker precedes the deploy interrupt, the
   delivery checkpoint is retained, and only stopped-generation settlement
   changes the source, linked inputs, and reservation to their interrupted /
   cancelled outcomes.
4. Replay the same delivery checkpoint and prove idempotency. Retain the
   already-retired cached-acknowledgement case.
5. Add DB tests for:
   - unmarked interrupted `terminal-pending`;
   - background-reconciled `clean-pending` without the marker;
   - completed and failed terminals;
   - `turn-terminal(interrupted)` committed immediately before preparation;
   - stale, `clean-pending`, partial, or mismatched preparation bindings;
   - exact active preparation replay as an idempotent no-op, followed by
     rejection once that same attempt is terminal.
6. Prove routine signals never invoke the preparer. Prove preparer throw,
   Promise return, or mismatched acknowledgement happens before the primary
   `retireForCleanRestart()` interrupt. Through the full clean-shutdown helper,
   prove any fallback teardown remains crash-like with zero eligible snapshot
   or intent. At the outer shutdown layer, prove the primary preparation error
   remains authoritative even when fallback returns exact `stop-cancelled`:
   no snapshots are projected, persistence is crash-like, and intents recorded
   is zero. Simulate a marker commit followed by a throw and prove no original
   message redispatch after reopen.
7. Retain natural-completion plus failed-delivery and cleanup-failure cases.
8. Add crash/reopen seam tests:
   - after marker and deferred delivery, before stop settlement: no intent and
     no original-message redispatch;
   - after `stop-cancelled`, before intent persistence: no intent and no
     original-message redispatch;
   - after atomic intent persistence: exactly one boot claim, source marked
     `resume-attempted` before one continuation.
9. Run focused DB, controller, ProcessManager, and native Codex integration
   suites; full Orchestra and Polygram suites; dependency/deploy contracts; and
   the foreground-canary suite with every skip reported.
10. Independently review both package diffs for state-machine correctness,
    failure safety, simplicity, tests, and privacy.
11. Release Orchestra first, consume its exact version in Polygram, release and
    activate a new local Polygram version, then repeat the exact foreground
    Codex canary. Success requires one eligible snapshot, one intent, strict
    resume attestation, one `continue`, one completed logical result, and zero
    restart/replay notices.

Background work and the aged-warm-process gate remain postponed as previously
agreed. Claude production proof remains separate from this Codex-specific race.
