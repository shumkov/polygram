# Codex sessions as full mailbox participants

Status: v3, 2026-11-24, implemented in polygram 0.51.0. Three independent spec
reviews (feasibility against the code, failure modes and security,
simplicity) and three code reviews (correctness and concurrency, silent
failures, tests) are folded in; see [Review log](#review-log). Phase 4 of
[`UNIVERSAL_MAILBOX_SPEC.md`](./UNIVERSAL_MAILBOX_SPEC.md). Builds on
[`MAILBOX.md`](./MAILBOX.md) and [`EXTERNAL_JOBS_API.md`](./EXTERNAL_JOBS_API.md).

## Problem

A Codex-backed session has an address but cannot take part in the mailbox:

- `receivable` in `lib/mailbox/addresses.js` is true only for `cli`, so a send
  to a Codex session is refused with `MAILBOX_BACKEND_UNSUPPORTED`, and
  `mayStart` in `lib/mailbox/service.js` gives it no grant or instructions;
- the external-jobs runtime (`lib/external-jobs/runtime.js`) admits only
  Claude CLI: the target resolver throws for other backends, and `dispatch`,
  `checkInactive` and `recoverInactive` need `backend === 'cli'` and a tmux
  busy probe.

Two live sessions run Codex: shumorobot's Orchestra topic (5), in an `open`
bot, and Ivan's DM in shumabit, a `roles` bot where the DM is not a role.
Ivan wants a Codex session to receive, send and reply as a Claude session
does, with the same safety.

## What Codex already provides (checked against the code)

- **Turn queue and state.** `CodexProcess.send()` queues the prompt and
  `_pump()` sets `inFlight = true` and `state = 'StartingTurn'`
  synchronously. A process with no turn is `Idle`, not `inFlight`, with no
  pending delivery work (`hasPendingDeliveryWork()`). Turns the app server
  starts on its own run in `BackgroundWorking`, possibly with
  `inFlight = false`. `/stop` interrupts and then kills the process.
- **Result.** A finished turn resolves `{runtime:'codex', text, error,
  metrics.resultSubtype, generationId, attemptId, providerSessionId,
  providerTurnId}` with `error` `null`, `'interrupted'` or `'failed'`. A
  turn cancelled before it was sent rejects with code `INTERRUPTED`; other
  faults reject with their own codes.
- **Ledger.** Every turn writes `codex_turn_attempts`; the Telegram source is
  nullable, and every step that needs it skips null. A completed turn waits
  in `terminal-pending` until the consumer calls `settleTelegramDelivery`.
  Until then a retirement of that generation (deploy, `/new`, runtime
  switch, eviction) waits for it, and after 30 s quarantines the daemon's
  Codex lease. An interrupted turn is cancelled by the stop itself.
- **One Codex generation per daemon.** A session that holds the lease keeps
  it until it is stopped, reset, evicted or retired; a spawn for another
  session throws `CODEX_DAEMON_GENERATION_BUSY` at once.
- **No-process status.** `pm.getModelSettingsStatus(sessionKey)` returns
  `not-loaded` (recovery ready, no process, no lease) or `daemon-busy`
  (another session holds the lease) without spawning anything.
- **Commands.** Every Codex session runs the `polygram-trusted` profile:
  filesystem `:root = write`, network on, `approval_policy = "never"`,
  `inherit = "none"` with `HOME`, `TMPDIR` and `PATH`. The daemon-secret
  roots, which include the IPC directory, only keep the workspace and the
  Codex home apart; they are not denied to commands. So a Codex shell can
  run the `msg.js` command, which carries the absolute node path, the
  script path and `POLYGRAM_IPC_DIR`, and read the 0600 secret, as a Claude
  session can.
- **Prompts.** Human prompts already pass through `formatPrompt`, which
  calls `noteHumanPrompt` and appends the mailbox instructions; job prompts
  get theirs in `lib/external-jobs/dispatch.js`.

## Decisions

### 1. Codex is an external-job backend

`JOB_BACKENDS = ['cli', 'codex']` in `lib/external-jobs/runtime.js` is the
one list the target resolver, the runtime, `external_jobs_info` (service and
the IPC default) and the mailbox address list read. SDK stays unsupported.

Mailbox deliveries are what this change is for and what is tested.
`external_job_submit` on a Codex route is admitted by the same path but
unverified. A notification consumer on a Codex route fails at boot: its tool
command carries no `POLYGRAM_IPC_DIR` and a Codex shell inherits no
environment, so the notification service resolves its destinations with
`backends: ['cli']`.

### 2. Admission: idle only

`dispatch` keeps its order (recovery wait, intent lock, pause, shutdown,
route, backend, busy, spawn, second check, send). One helper,
`isIdle(entry, backend)`, replaces the four busy probes:

- Claude CLI: `probeBusyState().busy === false`, as today;
- Codex: `!inFlight && state === 'Idle' && !hasPendingDeliveryWork()`.

Every `backend !== 'cli'` check compares with the selected backend instead.
The login gate becomes `needsAuth(backend)`, wired to
`needsNativeClaudeAuth(config.bot, backend)`, which is already false for
Codex. A spawn that throws (lease held elsewhere, recovery blocked, runtime
unavailable) defers, as today. The send is committed under the intent lock,
and `pm.send` makes the process `inFlight` synchronously, so a human message
that takes the lock next steers or queues into the job's turn, as into a
Telegram turn. A job never steers into a busy turn, on either backend.

### 3. The job turn and its outcome

`sendToProcess` is called exactly as today, with `sourceMsgId: null` and
`expectedProcess`. The outcome mapping gains one case: a rejection with code
`INTERRUPTED` (a turn cancelled before it was sent, as by `/stop` during
`StartingTurn`) is `interrupted`, not `unknown`. A result with
`error: 'interrupted'` is already `interrupted`, any other `error` is
`failed`, any other rejection stays `unknown`. The final text is the job
report; Codex has no channel acknowledgement.

### 4. Settle the Codex attempt as soon as the turn resolves

The runtime takes `settleResult(sessionKey, result, disposition)`;
polygram.js wires it to `codexRuntimeController.settleTelegramDelivery`,
which ignores a non-Codex result. Right after the turn resolves, before
anything else, the runtime settles `delivered` when `result.error == null`
and `failed` otherwise. A settlement error never changes the job's outcome;
it is logged by code and recorded as the event
`codex-external-job-settlement-failed` with the request, generation and
attempt ids, because the next retirement of that generation will wait on the
attempt and quarantine the lease.

`delivered` here means the job ledger took the result; the report's own
delivery is tracked by the job's `report_state`. Settling at once keeps a
deploy or `/new` from waiting on report delivery and quarantining the lease.
A failure inside settlement can still mark the generation durability-blocked
until restart, as for a Telegram turn.

### 5. Inactivity without a live process

After `/stop` a Codex session has no process, so the CLI rule "a missing
process proves nothing" would leave every later job queued until a human
writes. For Codex, when there is no live process and the session selects
Codex, `getModelSettingsStatus` answering `not-loaded` or `daemon-busy`
proves no turn of this session can run: the lease is released only after a
verified retirement, and a quarantined lease answers `containment`. The
status call waits on the session's lifecycle gate, which a spawn may hold for
minutes, and the drain checks jobs one at a time, so an answer slower than
1 s counts as no proof. A check that throws is logged once per job and code.

- `checkInactive`: a live process passes `isIdle`; otherwise the status proof.
- `recoverInactive` (unknown jobs, under the intent lock): the same proofs,
  with no spawn, so recovery never takes the lease.

### 6. Sending, grants and taint

`receivable` becomes "backend is in `JOB_BACKENDS`". In an `open` bot a Codex
session then gets a grant with every prompt, its `msg.js` command, a
directory entry with `canReceive: true`, and can be messaged; in a `roles`
bot a role on a Codex session passes the boot check. The grant rules stay
backend-agnostic: per prompt, a newer prompt (including one steered into a
running Codex turn) demotes the older grant, a turn the app server starts
on its own keeps the latest grant, and a tainted grant cannot start. Cards
and labels do not depend on the backend.

### 7. Approvals (option C)

The option C gate does not exist for Claude either: it is part of the
shared cross-zone layer, and nothing sets taint yet. So parity holds today.
The Codex carrier for the gate, its open questions and the rule that keeps a
Codex session from starting cross-zone messages until then are recorded in
`UNIVERSAL_MAILBOX_SPEC.md`, "Shared cross-zone layer".

## Failure modes

| Situation | Behaviour |
|---|---|
| Codex turn running | The job defers and retries on the next tick, submit or settle. |
| Human message during a job turn | Steers or queues into it through the existing dispatch reservation; the job's final text is the report. A steer needs CLIProxy v8.0.48 or later (older versions kill the turn). |
| `/stop` during a job turn | The job ends `interrupted` (also during `StartingTurn`), one notice; the next job runs on the status proof. The stop holds admission, which now covers Codex sessions. |
| Deploy or restart mid-turn | No clean-restart candidate (no source), so the turn is interrupted: the job ends `interrupted`, or `unknown` at boot; one notice, never a replay. |
| Ambiguous turn, or a fault rejection | `unknown`, "uncertain" notice, recovery by the status proof. `/config` already omits attempts with no Telegram message (14b58ea). |
| Containment or quarantined lease | Every Codex session of the daemon stops until restart; jobs defer and recovery waits. |
| CLIProxy error or expired credentials | The turn resolves `failed`; the asker gets "could not be answered". Unlike Claude's login gate it does not defer. |
| Another Codex session holds the lease | The spawn throws; the job defers. A job's spawn holds the lease just as a human message's spawn does, so other Codex sessions of the daemon refuse turns until it is released. |
| Session moved to SDK or its Codex scope disabled | A queued job is held by the route check; an unknown job's recovery keeps backing off, as on Claude. |

## Alternatives rejected

- **Steer mail into a busy Codex turn:** folds untrusted input into a human's
  turn and diverges from Claude.
- **A separate Codex runtime module:** the sequence is the same; only the
  idle proof, the login gate, the settlement and the no-process proof differ.
- **Spawn to prove inactivity, as on Claude:** takes the daemon's only lease
  and keeps it; the status proof answers without a process.
- **Settle after the report is delivered:** mirrors the Telegram path, but a
  held or slow report would make a deploy wait and quarantine the lease.
- **Retire a generation the automation spawned once its job ends:** new
  lifecycle code for a contention that no deployed bot has today (one Codex
  session on shumorobot; shumabit's DM is not in its mailbox).

## Live configuration (no code)

- **shumorobot Orchestra topic (5):** works after deploy with no config
  change. It is reachable as `orchestra` or `t5`, gets a grant in every
  prompt, and General can ask it.
- **Ivan's DM in shumabit:** a session that is not a role takes no part in a
  `roles` bot, on Claude or Codex. To include it, add a role whose route is
  `{"chatId":"68861949"}` and allow entries as wanted; as a role, `/stop` there
  only interrupts. That is Ivan's decision, not part of this change.

## Verification

### Unit tests

`tests/external-jobs-codex.test.js`, against the runtime with a fake Codex
entry:

1. the resolver accepts Codex and refuses SDK;
2. an idle Codex entry gets one send with `sourceMsgId: null`, `onSend`
   first, outcome `succeeded` with the text, and `settleResult(…,
   'delivered')` before `checkInactive`;
3. `inFlight`, `StartingTurn`, `Active`, `Settling`, `BackgroundWorking`,
   `BackgroundSettling`, `Quiescing`, `Stopped` and pending delivery work
   all defer with nothing sent;
4. an expired Claude login defers a CLI job and not a Codex job;
5. no process: spawn, prove idle, send; a spawn that throws defers;
6. `error: 'interrupted'`, an `INTERRUPTED` rejection, `error: 'failed'` and
   another rejection map to interrupted, interrupted, failed and unknown;
   settlement runs for results only, with the right disposition, and its
   error changes nothing;
7. `checkInactive` and `recoverInactive`: a live idle process passes, a busy
   one fails, no process passes only on `not-loaded` or `daemon-busy`, and
   recovery never spawns;
8. a live process of the other backend fails the job.

Existing tests that pin "Claude CLI only" are flipped in place:
`tests/mailbox-universal.test.js` (the Orchestra fixture gets a grant, a send
to it is accepted, `canReceive: true`) and `tests/external-jobs-ipc.test.js`
(`supportedBackends`). An SDK session keeps `MAILBOX_BACKEND_UNSUPPORTED`.

### Real-Codex spike (`scripts/spikes/codex-mailbox.mjs`)

Runs the pinned Codex binary under Orchestra's `CodexProcess` with the
production profile from `createCodexRuntimeProfileBuilder`
(`polygram-trusted`, `inherit = "none"`, the IPC directory as a
daemon-secret root) and a loopback Responses provider with a synthetic key:
no credentials and no model call. The provider scripts code-mode
`exec_command` calls with the `msg.js` command polygram injected. The daemon
side is the real mailbox, external-jobs runtime and IPC over a temp DB.
Checks: `directory` and an ask from a Codex turn; general's reply and ask
running as Codex job turns, with Codex replying through the job's command;
a job submitted during a Codex turn deferring until it ends; a superseded
command refused.

It runs on macOS here. Not covered: the Linux host, ledger settlement (the
spike's checkpoint sink is a no-op) and model behaviour.

### Live checks after deploy (each needs Ivan's go)

- shumorobot: General asks `orchestra`, which answers once; then the
  Orchestra topic asks General. Read back `mailbox_messages`, `external_jobs`
  and the job turn's `codex_turn_attempts` row (`settled`). Then `/stop`
  during a delivery and confirm the next message still arrives.
- shumabit DM: only after Ivan adds a role; otherwise confirm nothing changed.

## Rollout

polygram 0.51.0 (a feature). No migration, config change or Orchestra
release.

## Review log

Three read-only reviews of v1.

**Folded in:**

- Codex `/stop` kills the process, so a "missing process proves nothing"
  rule jams the session's queue (feasibility, security): decision 5's status
  proof, also replacing the recovery spawn.
- The single Codex lease is never released by idleness (feasibility,
  security): stated in the facts and failure modes; recovery no longer
  spawns.
- An unsettled attempt quarantines the lease on retirement (feasibility,
  security): settle right after the turn resolves.
- `/stop` during `StartingTurn` is a rejection (feasibility, security):
  `INTERRUPTED` maps to `interrupted`.
- The post-result turn id could throw and turn a known outcome into
  `unknown` (all three): dropped; it only fed display metadata.
- Decision 10 (`/config`) was already fixed by 14b58ea (feasibility): dropped.
- `isIdle(entry, backend)`, `needsAuth(backend)` and a direct
  `settleTelegramDelivery` wiring (simplicity); `hasPendingDeliveryWork()` in
  the idle proof (feasibility).
- Notifications on Codex are unverified, not promised (simplicity).
- The option C carrier moved to the universal spec, with the security
  review's additions: a start-time backend check (`/config` can switch a
  sender to Codex after boot), child-thread hooks, `disableAllHooks` and
  hook config the agent can write, `web_search = "live"`, hook time against
  `maxTurn`, and `newTurn` for Codex meaning `Idle && !inFlight`
  (simplicity, security).
- The spike section now matches the script; tests flip the existing
  fixtures instead of duplicating them; the IPC default and the refusal text
  read the shared list (feasibility, simplicity).

**Code review of the implementation (three read-only reviews):** no
correctness bug found. Folded in: the settlement-failure event with job and
attempt ids, logged at error level (silent failures, correctness); the 1 s
status timeout (correctness); notification consumers kept on the Claude CLI
so a Codex consumer fails loudly (correctness); one log line per job and
error code for a failing inactivity check (silent failures); tests for the
settle order, the re-read after the status call, recovery when the session
is paused or switched mid-proof, the production login rule in recovery, a
Codex role and an SDK role in a roles bot, the logged code, and source
checks of the polygram.js wiring (tests). Declined: recording each job's
backend so the Codex proof applies only to jobs that ran on Codex (silent
failures): a runtime switch through `/config` retires the Claude process
first, so only a config edit plus a restart during a Claude job reaches it,
and the Claude session would then be an orphan the tmux sweep owns; and
mapping `INTERRUPTED` only without a turn id (silent failures): Codex never
reports a turn id to the runtime, and Orchestra 0.12.x emits that code only
before a send; the spike re-checks the turn path on every Codex pin bump.

**Declined, with reasons:**

- Settle only after the report is delivered (security, MF3): a held or slow
  report would delay settlement past the 30 s retirement wait and quarantine
  every Codex session. Marking messages steered into the job turn as handled
  is the right deduplication anyway: they were incorporated, and their answer
  is the job's report.
- Classify more not-sent rejections (`QUEUE_OVERFLOW`, durability not-sent)
  as `failed` (security): they cannot happen for an idle-only send, or are
  durability faults that fence the generation; `unknown` stays the safe
  answer, as on Claude.
- Retire automation-spawned generations when idle (security): see
  Alternatives.
- Drop the spike (simplicity): it is the only proof that a real Codex shell,
  under the production profile, reaches the IPC socket and runs job turns,
  and it needs no credentials.
