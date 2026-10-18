# Held notification recovery: draft decision

## Problem and evidence

Mac notification 95 is durably delivered. Its frozen batch owns external job 90, whose outcome is unknown after process loss. The consumer deliberately keeps its cursor at 93. The provider transcript records two copies of the same envelope enqueued at 09:15:24.939/.940 and dequeued at 09:15:26.332. UserPromptSubmit reached the hook file at 09:15:35.825, after watchdog escalation at 09:15:34.830 and process-loss reporting at 09:15:35.098. No subsequent assistant completion or tool invocation is recorded in the main transcript. Absence of those records does not prove no execution.

The previous Stop hook summary records the Polygram append hook taking 14.747 seconds. The delivery watchdog uses a ten-second window and currently sees bridge/hook activity but does not treat the observed queue records as activity. This is evidence of a false-silence race, not proof of the independent reason the process exited.

## Existing contracts

`notifications.finishBatch` advances only for a succeeded job. `consume` never resubmits an existing job. `store.unsettled` blocks admission until a live recovered process positively proves idle; absent processes do not suffice. An ordinary human turn already includes unread notification context, but cannot finish the held batch. Neither jobs nor notifications currently expose reconciliation.

## Alternatives and recommendation

1. Leave the hold and ask the operator to choose a disposition. Smallest immediate safe outcome; notification delivery continues, automatic processing remains blocked. No invented success, replay, or database edit.
2. Operator accepts the batch as processed. Smallest code surface, but knowingly skips successful processing and changes the cursor contract. Not recommended without explicit acceptance of that loss.
3. Explicitly request a fresh inspection attempt for this exact held batch. Recommended recovery design if the operator authorizes the new semantics. Preserve the original unknown job and frozen input. The new job judges fresh state and prior history; it does not claim the original execution succeeded. This is a new execution with possible tool effects: an instruction to avoid repeated actions or reports is a prompt constraint, not a technical guarantee.

Do not add an independent service or generic retry framework. Reuse the existing active_batch JSON to store one recovery job input/identity and the original held request ID; no new table is needed for one recovery lineage. Keep all original batch fields immutable; add replacement metadata under a separate recovery property. The external jobs service continues owning dispatch, admission, status, and execution receipts. Notification orchestration owns the link and cursor. Infra policy remains in the skill.

## Proposed interface and flow (requires policy decision)

An authenticated operator-only mutation names consumer ID and exact held request ID, plus a distinct idempotent recovery request ID. It accepts only a terminal nonsuccess held job, with unchanged consumer generation/target, and no conflicting replacement. Reuse the existing authenticated IPC trust boundary and operator authorization convention; select the exact operation surface before implementation. The caller explicitly acknowledges prior outcome uncertainty. A duplicate mutation naming the existing replacement identity returns it; a different replacement identity conflicts. Persist replacement input in active_batch before submitting through the existing jobs service, so restart retries cannot create an extra attempt. Never modify the original job outcome/report or replay its report parts.

Replacement task includes the original frozen notifications/checks, original unknown status/turn/request, and bounded relevant history. It requests fresh inspection and warns against replaying prior actions or duplicating reports. Positive live recovered-session idle evidence remains mandatory; no forced inactive marker. The service must provide an existing safe recovery/spawn path without sending the old input before it can establish that evidence; if unavailable, admission remains held rather than weakening containment.

Only success of the linked replacement can satisfy the consumer processing receipt. Cursor and wake revisions advance atomically using the original frozen max ID/wakes. Newer notifications remain unread. Failed/unknown replacement stays held; no automatic chain or retry. Status exposes original and replacement states, and never relabels original outcome as success. Exact persisted readback is required.

## Separate watchdog correction

Limit a candidate Orchestra fix to treating attributable queue activity for an outstanding turn as activity for the existing watchdog. Research the queue observer's enqueue/dequeue identity and timing before choosing a hook; anonymous dequeue cannot be attributed to an arbitrary turn. Do not change pins or edit vendored node_modules as a deliverable. If upstream source/release scope is unavailable, report this fix separately.

Focused regression: reproduce a written pending turn with no bridge/hook callbacks but an observed matching queued input; advance the watchdog twice. Current code must show rewrite/escalation (RED). Patched code must defer escalation while relevant progress remains recent (GREEN); unrelated/stale queue records must still permit the existing watchdog path. A single queue event must not suppress escalation forever. Test installation-specific provider wiring separately from the unit logic; do not claim operational reliability from a unit test alone.

## Verification and limits

Focused RED/GREEN for recovery: existing unknown job remains unknown; duplicate recovery creates exactly one job; identity/target/generation conflicts reject; cursor unchanged before replacement success and on replacement ambiguity; successful replacement consumes only original bound/max/wake revisions; restart between persistence/submission reuses identity; no report resend. Code review must inspect authorization and admission locks. Do not deploy or invoke the new mutation until its material semantics are aligned. Root should present alternative 1 versus 3 before implementation if existing authorization does not cover deliberate reinspection after unknown execution.

## Independent review checkpoint

Simplicity review recommends option 1 now and option 3 only after explicit alignment. Required preimplementation gates: name the actual authenticated operator surface, prove safe session recovery before new input, preserve original batch fields separately from replacement metadata, and make duplicate identity behavior exact. The watchdog hypothesis remains separate from the unproven process-exit cause.

Safety review agrees on option 1 pending a material operator decision. Before option 3 implementation: atomically compare the exact batch/generation/original job when adding a recovery identity; protect idle proof through existing admission locking and expected-process checks; freeze the complete replacement input/history before submission; test concurrent operators, human turns, process replacement and consumer reconfiguration. Duplicate enqueue copies are not independent progress. No direct reconciliation write or forced inactive marking is justified by the current evidence.

## Authorized implementation details (2026-10-18)

Ivan approved one deliberate fresh diagnostic recovery after the original unknown outcome and duplicate-effects caveat were explained. Implement `notification_reinspect` on the existing authenticated local IPC surface. Require closed input {consumerId,generation,requestId,recoveryRequestId,acknowledgeUnknown:true}. This is a privileged same-UID operational interface like existing job submission/restart, not an identity boundary against Claude children (which also possess the IPC secret); do not expose it in the agent notification tool or describe it as cryptographically operator-only.

Before persisting a recovery, call an internal jobs `prepareRecovery` primitive for the exact original job. It uses existing runtime session-recovery wait, per-session admission lock, native auth guard, getOrSpawnForChat and expected-process positive idle probe; it sends no task. On positive evidence the jobs service records original inactivity using its existing setter, preserving outcome, input and report. Normal dispatch still independently checks pause, route, expected process and idle under the same admission lock; no original input is replayed.

After the async probe, atomically reread/compare the exact generation, active_batch and original job state. Freeze a separate recovery property {input,originalRequestId} with a deterministic supplied recoveryRequestId, bounded original notification/check data, original unknown receipt and fresh bounded history. Original fields stay intact. Persist before submitting; consume selects recovery.input when present and uses the existing five preacceptance submission attempts. Duplicate same recovery identity returns status; different identity conflicts. Success of recovery advances using the original maxId/wake revisions but references the recovery request as the successful processing receipt. Status exposes both identities/outcomes. No automatic recovery link creation, no recovery chain, no report replay.

This iteration excludes Orchestra changes: the observed race needs upstream source/release and separate verification; a vendored edit would violate the pinned dependency contract. Live reinspection remains a bounded attempt, with ambiguity held rather than repeatedly retried.
