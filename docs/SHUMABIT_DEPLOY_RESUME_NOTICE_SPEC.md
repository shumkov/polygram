# Shumabit deploy-resume false notice

Status: APPROVED 2026-08-01. Implemented and independently code-reviewed;
release and production activation remain pending.

## Problem

Shumabit still posts the generic clean-restart notice:

> ↺ Restarted — I didn't auto-resume N message(s) you sent just before. If
> any still need a reply, send it again.

The deploy-session-survival contract is narrower than all clean restarts: only
an authenticated `deploy_restart` request may persist one-shot continuation
intents, and only for an exact provider turn that is active and eligible at
retirement. The generic notice handles ordinary unanswered replay candidates
that remain after continuation claims have been removed.

Success means:

- an accepted Claude/CLI autosteer follow-up never becomes an independent boot
  replay candidate;
- a routine Shumabit deploy is proven to have been authorized by daemon IPC;
- an eligible active provider turn still follows the existing exact
  resume-plus-`continue` path;
- genuinely ambiguous or ineligible primary work retains a visible safe
  fallback; and
- Codex linked-input settlement is not weakened or completed early.

## Findings

### How `N` is decided

`handleMessage` first marks fresh inbound work `dispatched`. On shutdown,
`recordShutdown` changes recent `dispatched`/`processing` rows to
`replay-pending`. At boot, exact continuation intents are claimed first and
their sources become `resume-attempted`, excluding them from ordinary replay.

The remaining replay candidates are deduplicated against successful
`turn_metrics`. On a clean restart, `classifyReplay` skips all unanswered
legacy/recoverable candidates and groups only announceable ones per chat/topic.
`polygram.js` sets `N` to the number of items in one such group. Therefore `N`
is neither the number of continuation intents nor the shutdown's in-flight
count.

### Code root cause: Claude autosteer lost its terminal transition

For Claude/Channels, `tryAutosteer` accepts a follow-up by injecting it into the
active provider turn and returns `{autosteered: true}`. `handleMessage` then
sets the terminal reaction and returns. The current return path never calls
`markReplied`, so the inbound row remains `dispatched` forever even after its
parent turn finishes.

This is a provider-ownership regression, not a new deploy-resume design choice.
Commit `a599d02` (`0.9.0-cleanup commit 25`) extracted autosteer but preserved
the existing `markReplied(); return;` behavior. Commit `7134fd0` (`feat: add
native Codex app-server sessions`) later combined Claude's immediate-ownership
path with Codex's deferred-settlement path and removed that exact
`markReplied()` call from the shared accepted branch. The same commit added a
structural test asserting that no `markReplied()` occurs after the shared
AUTOSTEERED reaction. That assertion is correct for Codex but over-broad for
Claude, and it codified the regression.

Codex is intentionally different. An accepted Codex steer owns a durable
dispatch reservation and linked-input row; the target turn plus Telegram
delivery settlement later changes the inbound to `replied` or `failed`.
Marking the shared autosteer branch replied unconditionally would prematurely
settle Codex and can break its exact linked-input transaction.

### Shumabit production evidence

The VPS DB was opened read-only with its installed `better-sqlite3` and
`PRAGMA query_only = ON`. Queries selected lifecycle metadata and counts only;
no message body was selected or printed. Journal queries were restricted to
service lifecycle, exit status, containment gate, and sudo audit lines.

At the reported 2026-08-01 01:39–01:41 UTC restart:

- sudo audit proves `/usr/bin/systemctl restart
  polygram-shumabit.service`; the daemon logged `Shutting down (signal)`, not
  `deploy-ipc`;
- shutdown was clean but had zero handlers in flight at signal time, marked one
  replay row, and recorded four retirement snapshots, all ineligible with
  `reason=no-active-turn`;
- the one recovered source had arrived at 01:25:22 UTC, 827,144 ms before
  shutdown, and its matching event was `autosteer` with `backend=cli`;
- there was no successful turn metric or direct outbound reply owned by that
  subordinate source before shutdown;
- the first replacement wrote one pending `boot-replay-notice` outbound row,
  then was stopped; this proves an attempted notice, not confirmed Telegram
  delivery. The following crash-classified boot recovered the original row as
  a fresh turn; and
- there were no `clean-resume-*` events in this epoch.

This candidate did not arrive in the shutdown drain window or after intent
capture. It was a 13-minute-old accepted autosteer follow-up whose DB lifecycle
never became terminal.

The pattern repeated at the 06:29 UTC restart:

- sudo audit again proves direct `systemctl restart`, and the daemon again
  logged `Shutting down (signal)`;
- the noticed row was one 43-minute-old Claude/CLI autosteer follow-up, still
  without its own turn metric or directly threaded outbound reply;
- it was too old for shutdown's 30-minute re-mark cutoff, so
  `replay_marked=0`, but it was still inside Shumabit's derived replay window
  and therefore remained a boot candidate; and
- boot confirmed `clean=true, skipped=1, noticed=1, total=1` and sent the
  notice.

The bot-scoped live config has both
`resumeInterruptedCliTurns=true` and
`resumeInterruptedCodexTurns=true`. The flags are not the cause.

Only one retained Shumabit journal entry since July 30 says
`Shutting down (deploy-ipc)`, at 2026-07-31 13:02:08 UTC. Its DB epoch was idle:
zero replay candidates, zero notices, and no continuation intent. Production
therefore does not show an authorized eligible continuation failing. It shows
that the notice incidents bypassed authorization and concerned a different,
stale subordinate-message class.

The 01:39 deployment also suffered separate availability failures: nine
`containment-release-gate: polygram-dependency` pre-start exits, one
`203/EXEC`, and a later `SIGBUS` core dump after a second direct restart. These
amplified the incident and caused crash replay after the first notice, but they
did not create the initial `N=1` candidate.

## Diagnosis: one bug or several

There are three separate issues:

1. **Primary notice bug:** the native-Codex integration removed Claude's inbound
   terminal transition while sharing the providers' accepted-steer branch.
   This creates false replay candidates and explains both observed `N=1`
   notices.
2. **Deploy-path misuse/guardrail gap:** both observed restarts were direct
   systemd restarts. They could not authorize continuation by design, yet the
   routine deploy tooling still exposes a supposedly one-time direct-transition
   switch and lifecycle proof does not record or require the restart trigger.
3. **Independent deployment availability incident:** containment-pin drift,
   an exec failure, and a SIGBUS crash produced a restart loop. This needs its
   own operational follow-up; suppressing the notice would not fix it.

There is also a latent shutdown-poll race: `_stop()` does not cancel an
outstanding `getUpdates`, so a batch can dispatch after shutdown begins. It was
reproduced deterministically during research, but it is not the cause of either
Shumabit notice because both source rows were tens of minutes old. Keep it as a
separate bug/spec rather than expanding this surgical fix.

## Chosen approach

### 1. Restore Claude autosteer ownership at acceptance

After a successful Claude/Channels `tryAutosteer`, synchronously transition
that inbound row from `dispatched` to `replied` before applying the terminal
AUTOSTEERED reaction and returning, restoring the pre-`7134fd0` contract. The
status means that Polygram accepted the follow-up as subordinate input owned by
the active turn; it must not later be replayed as independent primary work.

This seam must not use the global best-effort `dbWrite` wrapper. Add a narrow,
throwing DB operation whose conditional update is verified to change exactly
one Claude inbound row. A zero-row update or SQLite error is a typed operational
failure, not successful acceptance. Because the external injection has already
been accepted at that point, the failure path must never fall through to
primary dispatch or retry the input. It must omit the AUTOSTEERED success
reaction, emit body-free fatal telemetry, and surface the existing bounded
"may have been incorporated; wait before retrying" ambiguity notice. This is
an unavoidable post-acceptance failure seam without a provider idempotency key;
the implementation must expose it rather than claim durable ownership.

Do not use this immediate transition for Codex. Preserve its durable
reservation/linkage and let exact target-turn plus Telegram-delivery settlement
own the final status.

This is intentionally not a redesign of Channels autosteer reliability. A
separate documented issue covers the rare case where Channels accepts an
injection but fails to fold or promote it. Solving that requires provider turn
correlation; boot-replaying every accepted follow-up duplicates the normal fold
case and is unsafe.

### 2. Make deploy authorization part of the lifecycle proof

Generate an opaque restart request ID in the deploy client and include it in the
IPC envelope. Add bounded operational fields to `shutdown-drain`:

- `restart_trigger`: `deploy-ipc` or `signal`;
- `continuation_authorized`: boolean; and
- `resume_intents_recorded`: nonnegative aggregate count returned by the
  committed shutdown transaction, not the pre-transaction candidate count; and
- `restart_request_id`: the opaque IPC request ID for `deploy-ipc`, otherwise
  null.

No chat, session, message, or prompt data is needed. Update the deploy verifier
so routine mode requires `restart_trigger=deploy-ipc`,
`continuation_authorized=true`, and the exact request ID from the exact old
systemd invocation. This binds a response-cut recovery to the request that the
helper actually sent instead of accepting a concurrent/manual restart. Zero
recorded intents is valid for an idle deploy. A clean signal stop must not
satisfy routine deploy proof.

Remove the already-consumed `--first-ipc-transition` option, its parser/usage,
direct-transition function, mode branches, docs, and tests from the routine
production helper for both Shumabit and UMI Assistant as part of the activation
deliverable, before either service is restarted. The temporary old-daemon
compatibility described below is a distinct IPC-only path and can never invoke
`systemctl restart`. Any future pre-IPC bootstrap belongs in a separate
operator procedure that is gated to an exact old/non-activated service. Direct
`systemctl restart` remains an
emergency/operator action with ordinary signal semantics; if retirement
finishes it can still create a clean marker and use replay policy, while a
failed retirement/OOM remains crash-like. It can never authorize continuation
and is not advertised as a smooth deploy.

### 3. Roll out the proof in two stages

The first fixed deploy necessarily retires a v0.37.1 daemon, which cannot emit
the new request-bound lifecycle fields. Requiring those fields immediately
would strand the rollout between hosts. Keep activation and enforcement as
separate deliverables:

1. **Runtime activation:** ship the provider-specific Claude state fix plus
   daemon request-ID/lifecycle emission, remove the direct-transition option,
   and add a narrowly bounded fieldless-receipt compatibility allowance that
   can only send authenticated IPC. Restart each old Shumabit and UMI Assistant
   daemon through that IPC path. During this one explicit activation only,
   accept the fieldless old-daemon lifecycle record only when the helper
   received the matching old PID's positive IPC acknowledgement. If the
   response is cut, stop for operator investigation: do not accept a fieldless
   lifecycle record and do not retry the restart.
2. **Routine enforcement:** only after both split bot services run the
   field-capable build, remove the temporary fieldless-receipt compatibility
   allowance and require the exact request-bound lifecycle proof on every
   routine deploy.

Before activation, run a metadata-only preflight counting nonterminal Claude
autosteer rows in the effective replay window. Do not mutate production rows.
If the count is nonzero, postpone the cutover until the rows have settled or
aged out; otherwise the old daemon may legitimately emit one final false
notice while it is being replaced. A small poll-versus-shutdown race remains a
separate known limitation, so the first definitive zero-notice canary is the
next deploy after activation.

### 4. Keep continuation and fallback policy unchanged

Do not authorize ordinary signals, suppress all generic notices, broaden intent
eligibility, or replay an accepted provider input. Exact active primary turns
continue to use the existing one-shot intent and strict resume path. Genuine
ineligible/ambiguous primary candidates retain their visible notice.

## Alternatives rejected

- **Suppress the notice globally:** hides real unfinished work while leaving
  stale lifecycle state and crash replay intact.
- **Teach replay to look for historical `autosteer` events:** relies on event
  retention and repairs the state too late; terminalize at the owning dispatch
  decision instead.
- **Mark every provider autosteer replied in the shared branch:** violates
  Codex linked-input settlement and can turn ambiguity into false completion.
- **Add a new `incorporated` handler status:** adds a migration and updates
  every replay consumer for the old, already-documented `replied` contract.
- **Wait for Claude parent delivery before terminalizing:** needs durable
  subordinate-to-parent correlation that Channels does not expose reliably;
  that is the larger autosteer reliability project, not this regression fix.
- **Authorize SIGTERM/systemd restart:** removes the causal deploy-only security
  boundary and lets host shutdowns or unrelated operators dispatch `continue`.

## Failure modes

- If Claude injection returns false, fall through to the normal primary-turn
  path; do not mark replied.
- If the verified Claude terminal transition fails after injection acceptance,
  treat the input as accepted-but-persistence-ambiguous: do not apply the
  success reaction, do not primary-dispatch or retry it, emit typed body-free
  fatal telemetry, and tell the user to wait for the current turn before
  retrying. The ordinary dispatcher error path must not overwrite this contract
  with a replayable shutdown status.
- If Codex accepts a steer, keep it nonterminal until its existing exact linked
  settlement completes.
- If a routine deploy's IPC response is cut, use the existing no-retry
  generation reconciliation, but require a lifecycle receipt matching the
  request ID and old invocation; otherwise fail the rollout rather than
  accepting a signal restart.
- During the one-time old-daemon activation only, a positive IPC response is
  mandatory because the old lifecycle record cannot carry request proof.
- Containment-pin failure, `203/EXEC`, and `SIGBUS` are separately observed
  availability failures. Only the containment mismatch is currently
  diagnosed; this spec does not claim a causal chain or fix the other two.

## Verification plan

Implementation follows red-to-green TDD after sign-off:

1. Reproduce the production lifecycle: a fresh Claude/CLI inbound is marked
   `dispatched`, `tryAutosteer` accepts it, the handler returns, and clean boot
   classification produces one notice candidate. Confirm red on v0.37.1.
2. Replace the over-broad shared-branch structural assertion introduced by
   `7134fd0` with provider-specific tests. Prove Claude performs the strict
   terminal transition before AUTOSTEERED success, while Codex does not
   immediately complete its linked input.
3. Apply the Claude transition and prove the same row is `replied`, absent from
   replay candidates, and produces no generic notice.
4. Add counter-tests proving rejected Claude injection stays on the normal
   primary path and a thrown/zero-change terminal write produces no success
   reaction, no primary resend, typed telemetry, and the bounded ambiguity
   notice.
5. Preserve the Codex regression test proving accepted linked input remains
   nonterminal until exact target and Telegram delivery settlement, then
   becomes terminal once.
6. Add lifecycle/verifier fixtures: matching routine `deploy-ipc` passes with
   zero or more committed intents; clean `signal` fails; cut response plus the
   exact request-ID/old-invocation receipt passes without a second request;
   missing or mismatched fields fail. Test the one-time activation rule
   separately from steady-state enforcement.
7. Run focused replay, autosteer, clean-resume, IPC, Codex reservation, and
   deploy-skill suites, then the full Polygram suite with every skip reported.
8. Production canary: after activation, one idle IPC deploy must produce zero
   notices; then one controlled eligible Claude turn must show one intent, one
   claim, one literal `continue`, one final reply, and no generic notice. Codex
   remains a separate controlled gate.

Keep the runtime fix and deploy guardrail as separate commits/deliverables. The
direct restart did not create the stale candidate, and an IPC deploy would
still have announced a preexisting stale Claude row.

Ivan approved this approach on 2026-08-01. Production activation remains gated
on independent code review, release review, and the canary sequence above.
