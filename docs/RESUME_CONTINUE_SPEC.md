# Resume an interrupted turn after a clean restart

Status: RELEASED AND ACTIVE — Claude CLI and native Codex parity shipped in
Polygram 0.37.0 with `@shumkov/orchestra` 0.10.13 after independent
correctness, containment, and deploy-reliability review. Shumabit has both
provider flags enabled; UMI Assistant remains disabled for both. A natural
eligible production continuation for each enabled backend remains a rollout
observation before broader activation.

This is a bounded clean-restart feature. It does not preserve a live process,
replay the original user message, adopt a tmux session, or recover work after a
crash or OOM.

## 1. Problem

A deliberate Polygram restart can interrupt a long-running user turn. The
current Claude CLI path may resume the exact provider session and send one
literal `continue`, but native Codex is retired as an unsupported backend.
That leaves Codex users with a failed turn even when shutdown proved exactly
which durable thread and turn were interrupted.

The unsafe shortcuts are:

- replaying the original Telegram message, because the provider may already
  have accepted it or performed side effects;
- continuing whichever provider session happens to be current, because config
  or session ownership may have changed;
- preserving the old process, because that is live adoption and retains the
  duplicate-delivery and stale-owner races this design is meant to avoid.

The feature must prefer a visible recovery notice over any ambiguous automatic
action.

## 2. Goals and non-goals

### Goals

- Support clean-restart resume plus one tracked `continue` turn for both:
  - Claude CLI/Channels sessions;
  - native Codex app-server threads.
- Prove the old process and its reply-bearing Telegram deliveries are closed
  before persisting a one-shot recovery intent.
- Resume only the exact stored provider session/thread under unchanged
  spawn/security identity.
- For Codex, prove the exact interrupted turn is the last durable turn and the
  resumed thread is idle before dispatch.
- Use the normal backend delivery ledger for the continuation result.
- Never retry a continuation after its dispatch or delivery outcome becomes
  ambiguous.
- Keep rollout independently controllable for Claude and Codex.

### Non-goals

- Crash, OOM, SIGKILL, or host-loss recovery.
- Original-message replay.
- SDK-session continuation.
- Live tmux or app-server adoption.
- Preserving detached/background work across restart.
- Reconstructing an answer from partial model output.
- Resuming Codex containment failures or ambiguous provider mutations.

Live adoption and background-work preservation remain postponed until telemetry
shows they are genuinely needed.

## 3. Existing baseline

### 3.1 Claude CLI

Polygram and Orchestra already implement:

- a reply-bearing delivery barrier;
- exact CLI retirement snapshots;
- one-shot `clean_restart_resume_intents`;
- provider-session generation tokens;
- strict existing-session resume with explicit attestation;
- one tracked literal `continue`;
- at-most-once boot claims and notice-only fallback.

Production Shumabit has the Claude flag enabled. The real pinned-Claude gate
passed, but production has not yet naturally produced an eligible continuation;
observed unfinished turns were correctly rejected as `prior-output` or
`no-active-turn`.

### 3.2 Native Codex pre-implementation baseline

Codex already persists:

- an exact process generation and daemon lease;
- exact app-server thread, turn, and mutation-attempt IDs;
- request write/response checkpoints;
- terminal turn status;
- Telegram delivery settlement;
- exact stopped-generation and empty-background-registry proof.

Healthy shutdown interrupts the exact active turn, observes its terminal state,
cleans the background-terminal registry, closes the managed app-server process
group, and retires the exact durable generation. At that baseline the
ProcessManager then returned `unsupported-backend`, so no Codex clean-restart
intent could be created.

Abnormal Codex process-local recovery is a separate path. It intentionally
rotates to a fresh thread and never automatically resumes an outcome-unknown
turn. This spec does not weaken or reuse that path.

## 4. Chosen design

### 4.1 Common shutdown ordering

Automatic continuation requires a deploy-only restart request through the
existing bot IPC. Accepting that request atomically stops new admission, records
an in-memory authorized-restart reason, and starts the normal shutdown pipeline;
the daemon does not arm a timestamp and wait for a later signal. The owning
systemd unit uses `Restart=always`, so a successful self-shutdown starts the new
daemon. The deployment helper waits for the exact old PID to disappear and the
new PID to pass readiness.

An ordinary handled signal may still produce the existing clean-shutdown marker
for inbound replay classification, but it may not produce continuation intents
without the causally distinct IPC restart request.

This distinction is intentional:

- an authorized application deploy/restart may create continuation intents;
- a host shutdown/reboot, operator `systemctl restart`, crash-loop restart, or
  unrelated handled signal may not;
- the authorization is one-shot process-local state and cannot survive a crash;
- accepting the request does not make a failed retirement clean.

On an authorized deliberate stop:

1. Accept one deploy-only IPC restart request and start shutdown directly from
   that handler.
2. Stop accepting new updates.
3. Fence reply-bearing Telegram delivery and drain already admitted sends.
4. Freeze ProcessManager lifecycle admission.
5. For each process, capture the active-turn candidate before interrupting it.
6. Retire the exact process through its backend-specific verified path.
7. Await handler settlement.
8. Persist eligible one-shot intents and the clean-shutdown marker in one
   transaction.

If any retirement, persistence, or handler-settlement proof fails, record the
shutdown crash-like and persist no continuation intents.

An OOM or unexpected child death is always crash-like, even if systemd sends the
daemon a catchable stop signal afterward.

### 4.2 Common one-shot intent

Keep the existing table and add two nullable columns:

```sql
ALTER TABLE clean_restart_resume_intents
  ADD COLUMN interrupted_provider_turn_id TEXT;

ALTER TABLE clean_restart_resume_intents
  ADD COLUMN interrupted_spawn_profile_id TEXT;

ALTER TABLE clean_restart_resume_intents
  ADD COLUMN continuation_authorized INTEGER NOT NULL DEFAULT 0;
```

The existing fields remain:

- `bot_name`
- `session_key`
- `session_generation_id`
- `source_message_id`
- `shutdown_at`
- `policy_version`

`session_generation_id` is already globally unique. Record the generation token
from the snapshot's provider namespace. At claim time join the provider-session
row by `(session_key, generation_id)`, not by the currently hard-coded
`claude:channels` namespace. The matched row supplies the namespace and exact
provider session ID.

For Claude, both provider-control fields are null. For Codex both are required.
`continuation_authorized` is `1` only for an intent written from the
authenticated deploy IPC shutdown path. A pre-migration daemon cannot name the
new column, so its upgrade-restart rows receive the default `0` and are
tombstoned without continuation. Policy v2
understands both namespaces. Boot remains able to consume v1 Claude intents so
an authorized current-release restart can retain Claude compatibility without
trusting a legacy release's direct-restart intent.

The intent deliberately does not copy cwd, model, effort, agent, provider
session ID, Codex attempt ID, or process-generation metadata. Those remain in
their authoritative provider-session and Codex ledgers and are checked before
the intent is recorded. Duplicating them would create competing identity
records.

`interrupted_spawn_profile_id` is not a second copy of that identity. It is the
existing Orchestra SHA-256 receipt that binds the pinned Codex runtime,
protocol schema, executable, and full authenticated static profile. Codex
containment extends that static profile with the canonical launcher identity.
The complete clean-resume identity is:

```text
(namespace, provider-session generation, cwd, model, effort, spawn-profile ID)
```

The provider row remains authoritative for namespace, generation, cwd, model,
and effort. The intent binds the retired turn to its exact spawn-profile ID.
Before `thread/resume`, boot must prove that the current route resolves to the
same tuple. The newly prepared process must then expose that same branded
spawn-profile receipt. No field is inferred from mutable current configuration.

### 4.3 Claude eligibility and boot execution

After the common restart-authorization gate, Claude's backend-specific
eligibility and boot execution remain unchanged:

- only `claude:channels` / CLI;
- exact active source message;
- no prior or pending reply-bearing output;
- no active or unresolved background ownership;
- exact clean process retirement;
- unchanged session generation, agent, cwd, and Channels boundary;
- strict resume of the exact session, with no fresh fallback;
- one tracked literal `continue`.

The implementation may be generalized internally, but Claude's tested behavior
and rollout flag must not change.

### 4.4 Codex retirement candidate

Before interruption, `CodexProcess` exposes an immutable clean-restart candidate
only when all of the following are true:

- the process owns the current exact daemon generation and lease;
- one accepted `turn/start` is current;
- its attempt, thread, turn, source-message, and generation IDs are present;
- there are no queued primary sends, pending steers, or queued cancellations;
- no terminal result has already been returned;
- the thread is not in recovery-conflict, containment-failed,
  durability-blocked, or outcome-ambiguous state;
- no native background work or background settlement is active.

The candidate is not yet eligible. ProcessManager first checks the delivery
barrier for its exact session/source pair. Any prior or pending reply-bearing
Telegram operation makes the snapshot notice-only.

ProcessManager then performs the existing strict Codex retirement:

- interrupt the exact turn;
- require terminal status `interrupted`;
- require fresh empty-background-registry proof;
- close and prove the managed app-server group empty;
- commit exact durable retirement;
- clear only the matching in-memory lease.

The durable verifier returns the exact retired binding. ProcessManager compares
its generation, attempt, thread, turn, source message, terminal status, and
retirement disposition with the pre-interrupt candidate. A mismatch is
ineligible or fails retirement; it is never guessed.

The candidate's cwd, model, effort, and spawn-profile ID must also equal the
authoritative provider row before intent persistence. A successful runtime
settings transition commits the replacement provider row and generation before
admitting a turn under the new settings; it may not mutate those fields beneath
an active generation.

An interrupted turn that the handler settles as a failed delivery remains
eligible when the exact ledger still proves `terminal_status='interrupted'` and
the delivery barrier proves no Telegram reply was admitted. Settlement order
must not erase the retirement identity.

The eligible snapshot contains only what Polygram needs:

```js
{
  runtime: 'codex',
  namespace: 'codex:app-server',
  sessionKey,
  sourceMsgId,
  providerTurnId,
  cwd,
  model,
  effort,
  spawnProfileId,
  eligible: true
}
```

The snapshot's `spawnProfileId` must equal the durable retired generation
binding before Polygram persists the intent.

### 4.5 Codex strict resume attestation

At boot, an executable Codex claim must pass all common claim checks plus:

- the configured route still resolves to native Codex;
- no process is already registered for the session;
- the provider row is still `codex:app-server`;
- its generation token equals the intent token;
- its cwd and static runtime/security profile still match;
- its model, effort, and stored spawn-profile ID still match the current route;
- the exact stored thread ID is passed to `thread/resume`;
- the response reports that exact thread, `ephemeral=false`, and idle status;
- the returned turn history ends with the recorded interrupted turn ID and
  reports that turn as `interrupted`;
- no active or background work is reported.

The pinned Codex 0.145.0 protocol already returns bounded projected turn history
from `thread/resume`; no new `thread/read` surface is required. Orchestra's
validated projection must expose the returned `ephemeral` value to the strict
attestation rather than merely validating and discarding it.

CodexProcess exposes a strict resume attestation analogous to CLI:

```js
{
  namespace: 'codex:app-server',
  sessionId: exactThreadId,
  interruptedTurnId: exactTurnId,
  resumed: true,
  freshFallback: false,
  idle: true
}
```

Any mismatch retires that exact spawned process and sends the ordinary recovery
notice. If exact cleanup of the rejected spawn cannot be proved, boot stops
before polling begins.

### 4.6 The Codex continuation turn

After attestation, dispatch one literal `continue` through the normal
ProcessManager send path with the exact spawned process as a precondition.

The continuation is a new Codex `turn/start`; it is not a replay or
`turn/steer`. Its Codex attempt uses no Telegram-source binding because the
original input's attempt was already interrupted and settled. The recovery
coordinator retains the original source solely for:

- reply threading;
- delivery-barrier correlation;
- terminal clean-recovery ownership.

After Telegram delivery, finalize the Codex result through
`settleTelegramDelivery` before marking the clean-recovery source `replied`.
On delivery failure, settle the Codex attempt as failed before sending the
notice. Claude keeps its existing Channels delivery behavior.

If dispatch, provider completion, or Telegram delivery becomes ambiguous:

- do not retry;
- settle whatever exact durable state is safely known;
- show the uncertainty notice;
- mark the source `replay-skipped` only after that notice is delivered.

### 4.7 Rollout flags

Keep the shipped Claude flag:

```json
{ "resumeInterruptedCliTurns": true }
```

Add an independent default-off Codex flag:

```json
{ "resumeInterruptedCodexTurns": true }
```

Do not broaden the meaning of the existing Claude flag. Independent flags avoid
silently enabling an experimental app-server recovery path on deployments that
previously opted into Claude only.

Target rollout:

1. Unit and fake-app-server gates.
2. Real pinned-Codex gate on a disposable local profile.
3. Local shumorobot Codex canary.
4. Shumabit private Codex route.
5. UMI Assistant only after separate observed success.

## 5. Alternatives rejected

### Replay the original Telegram message

Rejected. Provider acceptance and tool side effects may already have occurred.

### Preserve or reconnect to the old process

Rejected for this feature. That is live adoption and keeps stale-owner,
duplicate-delivery, and background-work ambiguity. It remains postponed.

### Resume the most recent provider session without a one-shot intent

Rejected. A provider-session row proves context, not that shutdown interrupted
an unanswered source turn.

### Reuse abnormal Codex containment recovery

Rejected. Abnormal recovery intentionally rotates the provider thread because
the mutation outcome is unknown. Clean retirement has stronger evidence and a
different safety contract.

### One shared enable flag

Rejected for rollout. Existing Claude opt-in must not silently activate Codex.

### Add a second Codex-specific recovery table

Rejected. The existing intent table plus nullable Codex turn and spawn-profile
bindings, together with the existing Codex ledger, provide the needed ownership
without another state machine.

## 6. Failure modes

| Failure | Result |
|---|---|
| Ordinary signal or restart without the deploy IPC request | clean marker as applicable, but no continuation intents |
| Shutdown delivery fence cannot drain | crash-like shutdown; no intents |
| Codex turn start outcome is unknown | no intent; existing Codex ambiguity handling |
| Codex exact interrupt or empty-registry proof fails | retirement fails closed |
| App-server group close is unverified | Codex remains fenced; no clean marker |
| Prior/uncorrelated Telegram output exists | notice-only snapshot |
| Queued send, steer, or background work exists | notice-only snapshot |
| Provider row or generation changed | consume claim; recovery notice |
| Runtime/backend/cwd/security profile changed | consume claim; recovery notice |
| `thread/resume` falls back or reports active | retire exact spawn; recovery notice |
| Interrupted turn is not the resumed thread's last turn | retire exact spawn; recovery notice |
| Continuation dispatch outcome unknown | never retry; uncertainty notice |
| Telegram delivery outcome unknown | never retry; uncertainty notice |
| Recovery notice cannot be delivered | leave source `resume-attempted`; surface task failure |
| Crash/OOM instead of deliberate stop | ordinary conservative crash recovery only |

## 7. Verification

### 7.1 Regression-first tests

Before implementation, add tests that fail because Codex currently returns
`unsupported-backend` and strict resume rejects Codex. Record the red-to-green
transition in the implementation commit.

The deploy-restart tests must also fail first: today no IPC request causally
owns the self-shutdown and any handled shutdown signal can reach the
clean-intent persistence path.

### 7.2 Orchestra tests

- Eligible active Codex turn captures an exact candidate.
- Idle, queued, steering, background, terminal, ambiguous,
  containment-failed, or durability-blocked Codex states are ineligible.
- Delivery activity makes a candidate ineligible.
- Exact interrupt + empty registry + process-group close + durable verifier
  produces one eligible snapshot.
- Any identity mismatch or non-interrupted terminal fails closed.
- Strict resume attests exact idle thread and exact last interrupted turn.
- Strict resume exposes and rejects a missing or true `ephemeral` value.
- Fresh fallback, active status, changed thread, missing turn, or changed turn
  retires the spawned process.
- Active or unresolved Claude background ownership is notice-only.
- Claude retirement and strict-resume tests remain unchanged.

### 7.3 Polygram database tests

- v2 intents resolve provider rows by exact globally unique generation token.
- v1 Claude intents remain consumable.
- Codex intent requires a provider turn ID.
- Codex intent requires the retired spawn-profile ID and rejects any profile
  mismatch before spawning or resuming.
- Provider replacement, source mismatch, stale marker, and unsupported policy
  remain tombstoned.
- A failed transaction persists neither marker nor partial intents.
- Claim remains at-most-once across concurrent boots.
- Graceful host shutdown may retain its existing inbound clean-marker semantics
  without authorizing continuation.

### 7.4 Polygram lifecycle and delivery tests

- One eligible Claude and one eligible Codex session recover independently in
  the same boot.
- The deploy-only IPC request is one-shot and process-local, begins shutdown
  directly, and rejects any second request or new admission.
- An IPC response cut does not cause the helper to retry blindly; it resolves
  the old PID/new PID state before deciding whether the request took effect.
- SIGTERM, SIGINT, SIGHUP, and host shutdown produce no continuation intents.
- Codex sends one literal `continue`, never the original message.
- The continuation uses the exact spawned process.
- Codex delivery settles its exact attempt before the recovery source becomes
  `replied`.
- Delivery failure settles failed and never redispatches.
- Unknown continuation dispatch, provider completion, and Telegram delivery
  each produce the uncertainty notice and never redispatch in the current or a
  later boot.
- Crash-cut failpoints after claim, process spawn, continuation write, provider
  acceptance, provider completion, Telegram acceptance, delivery settlement,
  and notice delivery each prove zero second `continue` and zero duplicate
  reply after boot.
- An OOM before candidate capture and an OOM during exact retirement, each
  followed by the daemon stop signal, persist no continuation intent. Fake
  backend tests cover the finer delivery-drain, interrupt, and retirement
  boundaries.
- Backend/config drift is notice-only.
- Disabling either rollout flag affects only that backend.
- Polling does not begin before every claimed session has either dispatched or
  reached notice-only safety.

### 7.5 Real gates

For each pinned backend:

1. Start a long turn with a deterministic fixture.
2. Deliver no reply.
3. Trigger a deliberate supervised restart.
4. Prove the old process tree is gone.
5. Prove exact provider session/thread resume.
6. Observe exactly one literal `continue`.
7. Observe one final Telegram delivery and zero duplicates.
8. Prove the one-shot intent is consumed.

The Codex gate also proves the resumed thread's last turn is the exact
interrupted turn and that the new continuation attempt is durably settled.

For each backend, a counted side-effect fixture repeats the gate with
interruption before tool dispatch, while the tool is executing, after its
durable result but before model completion, and after partial model output.
Every safe cell must show one external mutation, one `continue`, and one final
Telegram reply. Any duplicate mutation blocks that backend's rollout rather
than being explained away as model behavior.

## 8. Definition of done

- Claude CLI and native Codex both have independently gated clean-restart
  resume/continue.
- Neither path replays the original message or preserves a live process.
- Codex abnormal containment recovery remains fresh-thread and no-auto-replay.
- Duplicate/ambiguous delivery always wins over automatic recovery.
- Full Orchestra and Polygram suites pass with no new skips.
- Real pinned-Claude and pinned-Codex gates each show one continue, one final
  reply, and zero duplicate delivery.
- Shumabit telemetry records at least one eligible success for each enabled
  backend before broader rollout.
- Live adoption and background-work preservation remain explicitly postponed.
