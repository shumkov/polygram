# Content-free Codex retirement fault telemetry

Status: APPROVED 2026-08-05. Implemented and independently code-reviewed.
Local verification is complete; package release, clean dependency-pin
verification, production activation, and canaries remain pending.

Scope: Orchestra fault provenance and Polygram durable checkpoint projection.
This is a diagnostic deliverable, not a relaxation of containment and not the
functional deploy-ordering fix.

## Problem

Two controlled deploy canaries exposed independent Codex failures:

- a warm idle generation failed `thread/backgroundTerminals/clean`, but the
  state-changing request was wrapped as `CODEX_RPC_OUTCOME_UNKNOWN` before the
  immediate root fault was durably retained; and
- an active generation correctly contained `cross-thread-notification`, but the
  checkpoint did not retain the allowlisted notification method or the local
  process state that observed it.

The first request rejection can enter `stop-cleanup-failed` containment before
the app-client's later `onFault` handoff. Once CodexProcess is already in
`ContainmentFailed`, that later handoff does not replace the first checkpoint.
Adding fields only to `onFault` would therefore reproduce the production
observability loss.

The app client also counts stderr bytes cumulatively for the entire process
lifetime against a 64 KiB limit while retaining no stderr content. That is a
proven design concern and plausible hypothesis for an aged process, but it is
not a proven cause of either production failure.

## Goals

- Preserve a bounded root fault classification synchronously through an
  outcome-unknown mutation wrapper and whichever containment path wins first.
- Persist only closed-enum diagnostic fields; never copy arbitrary errors,
  stderr, provider payloads, paths, or identifiers.
- Make `containment-cleanup-completed` self-sufficient if the first containment
  checkpoint is unavailable.
- Deterministically identify or exclude cumulative-stderr failure in tests
  without claiming it caused production.

## Non-goals

- Accepting foreign-thread traffic or changing the one-fault containment
  threshold.
- Resuming an outcome-unknown mutation.
- Changing stderr lifetime/limit policy in this deliverable.
- Logging message text, stderr text, raw payloads, foreign IDs, workspace paths,
  or session keys.
- Fixing Polygram's authorized retirement ordering.

## Closed telemetry contract

The only new detail fields are:

| Field | Allowed values |
|---|---|
| `clientRootErrorCode` | `CODEX_PROTOCOL_ERROR`, `CODEX_TRANSPORT_ERROR`, `CODEX_PROCESS_EXITED`, `CODEX_PROCESS_ERROR`, `CODEX_RPC_TIMEOUT`, `CODEX_SINK_TIMEOUT`, `CODEX_PROCESS_CLOSE_TIMEOUT`, `CODEX_PROCESS_CLEANUP_UNVERIFIED`, or `unknown` |
| `clientFaultClass` | `stderr-limit`, `transport`, `protocol`, `process-exit`, `rpc-timeout`, `sink`, `cleanup`, or `unknown` |
| `notificationMethod` | `error`, `thread/status/changed`, `thread/settings/updated`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, or absent |
| `observedProcessState` | `Spawning`, `Initializing`, `AttachingThread`, `Idle`, `StartingTurn`, `Active`, `BackgroundWorking`, `BackgroundSettling`, `Settling`, `Quiescing`, `Stopped`, `Closing`, `Closed`, `FailedAmbiguous`, `RecoveryConflict`, `DurabilityBlocked`, `ContainmentFailed`, or `unknown` |

Raw Node/OS codes are not accepted as `clientRootErrorCode`. Polygram validates
the enums again at the DB boundary; unknown strings and arbitrary extra fields
are dropped. Existing owned checkpoint `threadId`/`turnId` remain because they
are required for durable ownership. The foreign notification's thread/turn IDs
and payload are never persisted.

## Chosen design

### 1. Capture provenance before mutation wrapping

At the app-client fault source, normalize the original fault synchronously
before `_rejectAll()` can replace it with `CODEX_RPC_OUTCOME_UNKNOWN`. Attach
the normalized `clientRootErrorCode` and `clientFaultClass` as own immutable
scalar fields on every mutation wrapper created by `_rejectAll()` and on the
later fault outcome. Classification is selected by code at the fault source; it
is never inferred from an arbitrary error message. The winning request-error
path reads those own fields directly. Any defensive cause lookup is cycle-safe
and capped at a fixed depth; an absent match becomes `unknown`.

CodexProcess extracts only those normalized fields from the immediate error or
its safe cause chain before entering containment. Thus a clean-request rejection
that wins the race carries the same provenance as the later `onFault` path.
It stores the result in an immutable provenance record separate from
`containmentError`, because a failed first checkpoint may replace the mutable
containment error. Cleanup evidence reads the immutable record.

### 2. Capture cross-thread detail before state transition

When the existing owned-thread comparison fails, record the delivered
notification's allowlisted method and the current local CodexProcess state
before changing it to `ContainmentFailed`. Preserve the existing owned
checkpoint identity; discard the foreign thread/turn IDs and all payload data.
Containment remains terminal.

### 3. Persist the safe fields at both durable boundaries

Extend Orchestra's containment detail and Polygram's explicit checkpoint
projection with the four closed fields above. Extend
`containment-cleanup-completed` with the same already-normalized provenance so
cleanup evidence remains diagnostic if the first checkpoint write failed.

The Polygram DB layer performs closed-enum validation rather than accepting any
string. No generic error-object serialization is introduced.

## Alternatives rejected

- **Enrich only `onFault`:** it can arrive after the first containment record
  and be ignored.
- **Persist `error.message`, stderr, or payload snippets:** unnecessary and can
  expose user/provider content.
- **Persist foreign IDs:** violates the isolation boundary and is not needed to
  classify the protocol event.
- **Treat cumulative stderr as the production cause:** current evidence cannot
  distinguish it from other pre-checkpoint faults.
- **Fix stderr policy at the same time:** behavior must follow evidence from the
  diagnostic fields, not a plausible guess.

## Tests and verification

1. Inject a root fault after a state-changing clean request's write checkpoint.
   The request remains `CODEX_RPC_OUTCOME_UNKNOWN`, containment remains
   mandatory, and the first persisted checkpoint has the normalized root
   code/class.
2. Cross the stderr limit gradually on a warm idle client after a
   `thread/backgroundTerminals/clean` request is write-attempted. Persist
   `clientFaultClass=stderr-limit` without stderr content; the all-process
   retirement returns no snapshots/intents.
3. Inject each allowlisted cross-thread notification method while the process
   is in a known pre-transition state. Persist only method + observed state,
   preserve owned checkpoint identity, and prove foreign IDs/payload are absent.
4. Force the first containment checkpoint to fail, then prove
   `containment-cleanup-completed` retains the same safe provenance.
5. Round-trip the four fields through Polygram's DB. Prove valid values survive
   and raw errors, arbitrary fields/strings, stderr, paths, session keys, and
   foreign IDs are dropped.
6. Run the full Orchestra and Polygram suites with all skips reported.

Production recurrence is conditional evidence, not a release gate. This
telemetry should ship before the next active Codex deploy canary.

## Definition of done

- Both production fault shapes have deterministic, content-free regression
  coverage.
- The first winning containment path and cleanup-completed evidence retain the
  same normalized provenance.
- Containment and all-or-nothing retirement semantics are unchanged.
- No unbounded or foreign data reaches durable lifecycle records.
