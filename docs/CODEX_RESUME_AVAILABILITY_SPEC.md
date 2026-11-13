# Codex resume availability

Production base: Polygram 0.46.3 (`66315bd`), Orchestra 0.12.2 (`80eec231`).

## Incident and intended behavior

One saved August Codex thread was selected for resume from a new workspace home
where it has no persisted thread. The resume RPC returned an error before any
turn; its exact upstream code/message was not retained. Containment then caused
two later requests to report model-settings failure. No turn or steer was sent.
The thinking reactions therefore do not establish a separate steering defect.

Check a saved thread in the actual selected home before attempting attachment.
Never automatically replace a missing conversation, replay a failed message,
change selected model/effort, or copy history/auth. Preserve existing ownership
quarantine. A user can explicitly choose `/new` only after cleanup is proven.

## Chosen correction

Orchestra adds only metadata-only `thread/read {threadId, includeTurns:false}`
to its pinned protocol subset. Before `thread/resume`, CodexProcess performs
that read through its already-started client, after hook verification, before
any mutation checkpoint/write. Validate exact thread ID, cwd and metadata shape;
leave active provider/policy enforcement to the existing resume response checks
(historical provider/model/effort can differ). Discard preview, readState and
history. A source-backed exact missing
thread error is normalized to a fixed safe category using the requested ID;
opaque error text stays private. Missing context produces a dedicated error,
closes the unmutated client using existing verified startup-close behavior,
and leaves the stored pointer untouched. Other errors remain errors, with no
fallback. Strict resume performs the same read and never starts fresh.

The existing process manager must report containment/durability/ambiguous
ownership errors before trying to apply warm model settings to a fenced
generation. No ownership release is added by this correction.

The actual contained-resume regression also exposed an existing identity bug:
before successful attachment, `providerSessionId` is null but `attachingThreadId`
is known. The two containment checkpoints must carry that attaching ID, matching
the controller's existing exact-owner check. Today cleanup emits null and the
controller rejects it. Correct the payload rather than weakening the verifier;
normal transport closure and durable cleanup still must succeed. Containment
entered while attaching and before a provider thread is accepted uses the same
attachment-failure category, including direct transport/notification faults;
accepted-thread and active-turn fault categories remain unchanged.
Failed-generation settlement must also preserve a provider pointer belonging to
a prior generation: failed attachment never admitted a turn that superseded it.
Keep existing exact thread/provider checks, but preserve the provider pointer
when settlement is for `thread-attach-outcome-unknown`: no turn was admitted by
that startup failure. The provider row generation is a separate persistence epoch,
not the app-server generation. Other settlement behavior remains unchanged.
Explicit `/new` remains the action that discards the old association.

Polygram maps missing context to a precise notice. Add to its existing `/new`,
`/reset` and `/clear` flow a clear of only `codex:app-server` after successful supported
cleanup. If containment cleanup is pending, await the existing bounded cleanup
promise outside the manager lifecycle gate. Then use existing manager-gated
`getModelSettingsStatus` as the barrier behind its exact cleanup-close handler;
require `not-loaded` before reset for this contained path. Healthy processes
still use normal reset retirement. After reset, require `not-loaded` and an
absent or `clear` durable Codex lease before clearing the pointer.
The exact existing frozen cleanup receipt is the only contained close that can
release that manager ownership. A no-process reset result alone is insufficient.
A failed cleanup or persisted quarantine leaves the pointer and reports failure.
The existing per-session intent lock spans runtime resolution through reset and
pointer clear/readback, excluding concurrent input or configuration changes.
No pointer is removed on ordinary input,
reload, refusal or unknown outcome. Rollout files, generation/attempt/checkpoint
history and other provider namespaces remain untouched.

## Alternatives

- Comparing the entire spawn profile would discard usable history on ordinary
  static changes and does not prove local thread availability.
- Scanning rollout filenames or Codex's SQLite schema adds storage coupling and
  can miss compressed/archived threads. Use the supported pinned read API.
- Home columns/migration registries or automatic fresh fallback add unnecessary
  state or silently lose context. Neither is needed.
- Treating every attachment RPC error as safe would weaken unknown-outcome
  fencing. The pre-read avoids the mutation for known missing context instead.

## Verification and limits

Reproduce missing `thread/read` and `thread/resume` on isolated exact 0.167.2
without any provider turn. Regression RED/GREEN: missing saved thread never
reaches resume/start/turn; matching metadata permits resume despite changed
model/effort; ID/cwd drift and unknown errors fail closed; unsafe read
options cannot be sent. Failed-generation followups retain the ownership error.
Exercise explicit `/new` using real manager/process/controller seams: pending
containment cannot clear a pointer, verified cleanup permits clear and the next
request starts fresh; unrelated providers and incident history remain intact.
Run focused tests and required CI, with independent spec and actual-diff review.

Patch versions: Orchestra 0.12.3 then Polygram 0.47.1, exact dependency. Runtime
and Claude pins unchanged. No production diagnostics, recovery, provider calls
or replay in this task. The current quarantined production incident is not
automatically repaired by this patch. Coordinator owns helper deployment.

Official API: https://learn.chatgpt.com/docs/app-server ; exact source:
`openai/codex` tag `rust-v0.167.2`, `app-server-protocol/src/protocol/v2/thread.rs`
(`ThreadReadParams`/`ThreadReadResponse`) and
`app-server/src/request_processors/thread_processor.rs` (`thread_read_response_inner`).

Independent scope and safety reviews accepted the amended lifecycle barrier and
historical-provider handling. Exact Darwin ARM64 0.167.2 no-turn reproduction
(SHA256 `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0`)
with all network denied produced `-32600 thread not loaded: <requested ID>` on
read and `-32600 no rollout found for thread id <requested ID>` on resume. This
confirms the local missing-thread shape; production's raw upstream reason was
not retained and is not claimed proven.
