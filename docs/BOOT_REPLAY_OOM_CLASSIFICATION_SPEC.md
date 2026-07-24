# Boot replay: do not classify an OOM-driven service teardown as clean

Status: multi-agent reviewed; awaiting operator alignment before implementation

## Problem

Boot replay currently treats every shutdown that reaches polygram's
`SIGINT`/`SIGTERM`/`SIGHUP` handler as deliberate. The handler drains work,
marks unfinished inbound rows `replay-pending`, and writes a
`polling_state.clean_shutdown_at` marker. A fresh marker makes the next boot
skip all unanswered replay candidates and send the user-facing resend notice.

That inference is false under systemd. The production unit's effective runtime
properties are:

- `OOMPolicy=stop`
- `KillMode=control-group`
- `KillSignal=SIGTERM`

If the kernel OOM-kills any process in the unit, systemd records
`result=oom-kill` and cleanly terminates the remaining unit processes. Polygram
therefore receives a catchable signal even though the initiating event was a
crash.

This happened on 2026-07-21:

1. At 18:25:47 Asia/Bangkok, the kernel OOM-killed a Claude child in
   `shumabit-sessions.service`.
2. Polygram entered shutdown mode. The affected bridge disconnected, its
   handler failed, and the inbound row became `replay-pending`.
3. At 18:25:54, polygram logged `shutdown-drain {clean:true}` and
   `polygram-stop`.
4. At 18:30, the operator started the failed unit again.
5. Boot replay consumed the fresh clean marker, classified the restart as
   clean, skipped one unanswered candidate, and sent the resend notice.

The message had no completed `turn_metrics` row. Under the existing crash
contract it should have been re-dispatched automatically.

## Current condition tree

Boot replay runs only when the selected bot has at least one configured chat.

1. Resolve the candidate window:
   - `config.bot.replayWindowMs` when it is a positive integer; otherwise
   - `1.2 × max(maxTurn)` across configured chats/defaults, with a 3-minute
     floor and 2-hour cap; otherwise
   - the DB query's 3-minute default.
2. Consume the per-bot clean marker:
   - fresh, non-future marker no older than `2 × replayWindowMs` → clean;
   - missing, stale, future-dated, unreadable, or already consumed → crash.
3. Query inbound rows:
   - chat is currently configured;
   - `handler_status` is `dispatched`, `processing`, or `replay-pending`;
   - message timestamp is inside the candidate window;
   - ordered oldest first, capped at 100.
4. Remove rows with a successful `turn_metrics` row for the same
   `(chat_id, msg_id)` and mark those rows `replied`.
5. Classify:
   - crash → re-dispatch every remaining candidate through the normal
     redelivery gate as a fresh turn;
   - clean → do not re-dispatch; group notice-eligible candidates by
     `(chat_id, thread_id)`, send one notice per group, then mark that group's
     rows `replay-skipped`.
6. A clean-branch notice is eligible when:
   - empty text/attachment-only input → yes;
   - abort-shaped text → no;
   - text matching the admin-command or pair-claim regex → no;
   - all other text → yes.

Non-announceable clean candidates are still terminally skipped; they are only
silent. A failed notice leaves its group recoverable so a later marker-less
boot takes the crash path.

Rows already marked `failed` are not candidates. This matters during an OOM
teardown because a bridge error can race ahead of Node's shutdown signal: the
dispatcher currently writes `failed` whenever `isShuttingDown` is still false.

This is separate from `lib/db/auto-resume.js`. That mechanism handles a
no-activity timeout or bridge disconnect during normal operation, uses an
in-memory cooldown, and is explicitly disabled while shutdown is in progress
or for boot replay.

## Chosen approach

Keep the deliberate-restart policy, but override it when the current Linux
cgroup reports a new OOM kill during this polygram process's lifetime. This is
a targeted correction for an observed OOM failure, not a general proof of
operator intent. Unknown supervisor-induced handled stops retain today's clean
behavior; explicit deploy-intent arming remains the stronger general model if
another false-clean class is observed.

### OOM observation

Add a small Linux/cgroup-v2 observer that:

1. Reads `/proc/self/cgroup` and selects the `0::<path>` cgroup-v2 entry.
2. Converts the namespace-absolute membership path to a relative path beneath
   `/sys/fs/cgroup`, then uses a component-aware `path.relative` containment
   check. It rejects empty paths, NULs, `..` components, and deleted/malformed
   membership shapes. In particular, it must not pass the leading `/` directly
   to `path.resolve`, which would discard the fixed cgroup root.
3. Reads the `oom_kill` counter from the cgroup's read-only `memory.events`.
4. Parses one non-negative integer counter (using `BigInt`), rejecting
   duplicates, malformed values, negatives, and counter decreases.
5. Captures the resolved file path and baseline synchronously before startup
   can spawn or attach workload children, and before registering shutdown
   behavior that can persist a marker.
6. Re-reads that same captured file synchronously when the first shutdown
   signal arrives. A changed membership is not compared against the original
   baseline.

The kernel defines `memory.events:oom_kill` as the number of processes in the
cgroup killed by any OOM killer. The production process is in
`/system.slice/shumabit-sessions.service`, and the file is readable by the
unprivileged service user.

The observer is best-effort. It distinguishes `detected`, `unchanged`,
`unsupported`, and `unavailable`; unavailable results carry only a stable,
sanitized reason. macOS and cgroup v1 are expected unsupported environments
and preserve current behavior quietly. On Linux, a probe that should work but
cannot arm emits one bounded startup warning/event, and shutdown telemetry
records that the observer was unavailable rather than calling it "no OOM."
The shutdown path must never fail because diagnostics are unavailable.

By default `memory.events` is hierarchical, so a Claude child in a descendant
cgroup is visible. A cgroup-v2 mount using the `memory_localevents` option makes
it local-only. The killed Claude and polygram were verified in the same exact
production cgroup, so the confirmed case does not depend on hierarchy. A future
descendant-cgroup deployment using that mount option is unsupported and must be
validated operationally; it cannot be inferred from an unchanged counter
alone. The counter covers kernel OOM kills, not an arbitrary
userspace/systemd-oomd `SIGKILL`.

References:

- Linux cgroup v2 interface:
  https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
- systemd `OOMPolicy=stop` semantics:
  https://sources.debian.org/src/systemd/247.3-7%2Bdeb11u4/man/systemd.service.xml/#L2582
- systemd `KillMode=control-group` semantics:
  https://man7.org/linux/man-pages/man5/systemd.kill.5.html

### Shutdown persistence

The same observer is also available to the dispatcher. When a handler rejects,
it samples OOM evidence before choosing the terminal status:

- no OOM evidence and shutdown has not started → existing failure and
  auto-resume behavior, unchanged;
- shutdown already started → existing `replay-pending` behavior;
- a new OOM kill is already visible even though the shutdown signal has not
  arrived → treat that handler failure as shutdown for status and user-facing
  error/auto-resume gating, so the exact affected row becomes
  `replay-pending`.

This closes both possible event orders without broadly replaying historical
`failed` rows. It intentionally assumes the confirmed `OOMPolicy=stop`
environment: under a future `OOMPolicy=continue` deployment, observer
semantics and baseline advancement must be redesigned together with normal
auto-resume behavior.

At the first shutdown signal, latch the observation before any awaited drain
work:

- no new cgroup OOM kill → existing clean path, unchanged;
- new cgroup OOM kill → crash-like path:
  - drain as today;
  - atomically mark current inbound work `replay-pending`;
  - clear, rather than write, `clean_shutdown_at`;
  - log `shutdown-drain` with `clean:false`,
    `shutdown_reason:'cgroup-oom-kill'`, and the observed counter delta;
  - continue normal resource cleanup and `polygram-stop`.

Non-OOM shutdowns use stable low-cardinality reasons such as
`no-oom-delta`, `oom-observer-unsupported`, and
`oom-observer-unavailable`. No path, message text, or other content is logged.
The parsed counter stays a `BigInt` internally, but its delta is converted to a
decimal string before event logging so it is JSON-serializable without
precision loss.

Clearing the marker in the same transaction as replay marking protects the
small boot-time interval before the prior marker has been consumed. Merely
calling the existing `markReplayPending()` would leave a stale clean marker
possible in that interval.

On the next boot, the existing marker logic sees crash, and the existing
crash branch re-dispatches the unanswered row. The notice is not sent.

## Interface and files

- New focused module under `lib/ops/`:
  - parse a cgroup-v2 membership line;
  - parse `memory.events`;
  - capture baseline;
  - re-sample the captured path;
  - return a stable status plus `{ detected, delta }` without throwing.
- New shutdown-disposition seam under `lib/ops/`:
  - accept the latched OOM observation;
  - choose clean versus crash persistence;
  - return the stable telemetry fields used by `polygram.js`.
- `lib/db.js`:
  - add an atomic crash-shutdown recorder that marks live inbound rows
    `replay-pending` and clears the per-bot clean marker;
  - share the private status-update transaction machinery with the existing
    clean recorder instead of duplicating its query.
- `lib/handlers/dispatcher.js`:
  - sample the shared observer before error-status selection;
  - treat OOM evidence as shutdown for only the currently failing message.
- `polygram.js`:
  - construct the observer before workload startup;
  - sample it at first shutdown;
  - invoke the shutdown-disposition seam;
  - include the classification reason in shutdown telemetry.
- Focused tests for the observer, DB transaction, and shutdown persistence
  choice.

No Telegram copy, replay candidate rule, replay window, announceability rule,
or timeout auto-resume behavior changes.

## Alternatives considered

### Set `OOMPolicy=continue` in the VPS unit

This prevents one OOM-killed Claude child from taking down both bots and lets
the normal bridge-disconnect auto-resume path run. It is attractive operational
hardening, but it is not a safe one-line change for the current shared,
tmux-backed `Type=oneshot`, `RemainAfterExit=yes` unit with no `Restart=`.
Both bots and the admin Claude process live in that unit. If polygram or tmux,
rather than a Claude child, is the OOM victim, systemd can leave the unit
active/exited without relaunching the dead bot. A sound version needs
foreground, separately supervised services and a restart policy. It belongs in
`umi-vps-infra`, not an application bug-fix PR. It also does not correct
polygram's false "any handled signal implies operator intent" assumption on
hosts that retain `OOMPolicy=stop`.

Hold this for a separate infrastructure review.

### Set `OOMPolicy=kill` in the VPS unit

This one-line setting would kill the whole service cgroup after the first OOM.
Polygram would not run its shutdown handler, no new clean marker would be
written, and ordinary crash replay would normally follow. It is rejected as
the application fix because it forfeits the 30-second drain and all process
cleanup, abruptly kills both bots and the admin Claude process in the shared
unit, and leaves the handled-stop assumption broken on other
`OOMPolicy=stop` hosts.

### Infer intent from the signal name

Production deploys normally reach polygram through tmux teardown/SIGHUP. The
OOM incident proves an effective systemd `KillSignal=SIGTERM`, but
`ExecStop=tmux kill-server` runs before systemd signals remaining processes,
and the actual signal caught by polygram was not instrumented. Treating either
signal as a crash would regress legitimate direct systemd and launchd stops.
Signals describe the termination mechanism, not operator intent.

Rejected.

### Treat bridge disconnects during shutdown as crash evidence

Intentional tmux teardown also disconnects every bridge. This signal cannot
separate deploys from OOM-driven unit teardown.

Rejected.

### Auto-recover only work interrupted by this clean shutdown

A deliberate restart could avoid the resend step by durably distinguishing
rows newly interrupted by the current shutdown from older ambiguous
`replay-pending` rows—for example, with a dedicated status or shutdown
generation. On boot, only that exact set would be auto-recovered; older clean
candidates would retain today's notice policy, and successful `turn_metrics`
would still suppress duplicates.

This is a worthwhile follow-up if deploy-time interruptions remain common, but
it changes the clean-restart product contract, needs a schema/lifecycle change,
and requires separate duplicate-delivery validation. It is not required to fix
the confirmed OOM misclassification and is deliberately deferred.

### Require an explicit pre-restart arm from deploy tooling

This is the strongest semantic model: the deployer declares intent before
stopping the daemon. It requires coordinated protocol changes across the
release helper, systemd, launchd, and backward-compatible deployments. The
cgroup counter gives direct evidence for the confirmed production failure with
substantially less surface.

Deferred unless other supervisor-induced false-clean cases appear.

## Separate follow-up: Linux Claude-session containment

The two production OOMs also justify a separate capacity-containment change.
That work is related operationally but is not part of this boot-replay bug-fix
PR. Its design boundary is:

- polygram remains a cross-platform foreground daemon with no systemd imports
  or systemd-specific session semantics;
- Linux supervision, restart policy, cgroup layout, and memory limits live in
  `umi-vps-infra`;
- the existing one-process-per-bot model is retained;
- if per-session containment cannot be supplied entirely by deployment, add
  only a platform-neutral process-launcher seam to `@shumkov/orchestra`
  (default: execute the pinned Claude binary directly);
- spike deployment-only containment before adding that shared-package seam;
- the Linux deployment may supply an external launcher that creates a
  transient workload unit and then executes the same pinned binary while
  preserving argv as an array, working directory, environment, stdio/PTY,
  signals, and exit status;
- macOS launchd and ordinary/manual installations keep the direct launcher.

The infrastructure redesign should replace the current shared,
`Type=oneshot`/tmux-backed `shumabit-sessions.service` failure domain with
independently restartable foreground bot services. Admin Claude and other
heavyweight sessions should not share the bot-daemon cgroup. Each Claude
session workload unit must be a sibling outside every bot-service cgroup,
normally under a dedicated `polygram-sessions.slice`; bot daemons must live
outside that slice. Aggregate session limits belong on that dedicated slice,
not on an ancestor that also contains bots. This is a hard compatibility
invariant with this spec's OOM observer: hierarchical session OOM events must
not increment the bot daemon's observed cgroup counter.

Each session and all of its tool descendants should receive its own measured
`MemoryHigh`, `MemoryMax`, and optional `MemorySwapMax` policy, with aggregate
host/fleet protection and per-session peak/OOM telemetry. The follow-up spec
must decide whether the entire session is an indivisible OOM domain. If so, it
must require and verify `MemoryOOMGroup=yes` (or equivalent) so Claude and all
descendants are terminated together. A session-limit OOM must not stop either
polygram daemon, admin Claude, or unrelated sessions.

### Follow-up feasibility and acceptance gates

Before choosing transient services, scopes, or an orchestra launcher change,
run a Linux spike from the real unprivileged bot-service context. It must:

1. Choose and prove one authorization route for creating a sibling workload
   unit: the lingering user manager, a narrowly authorized system-manager
   transient unit, or a fixed privileged helper. Never assume a process inside
   a system service can move its child into a sibling cgroup.
2. Prove the pinned Claude binary identity and lifecycle parity through the
   launcher: exact argv, cwd, environment, interactive PTY/stdio, startup
   readiness, abort/signal propagation, exit status, resume, and cleanup.
3. Fail startup loudly when containment is configured but unit creation,
   authorization, limit application, or exec fails. Production must never
   silently fall back to an uncontained Claude process.
4. Use collision-safe, non-content-bearing unit names and reconcile normal,
   crashed, timed-out, and orphaned workload units.
5. Verify the target kernel/systemd resource controls and record representative
   per-session `memory.current`/peak data. Select high/max/swap limits with
   explicit host reserve so concurrent sessions at their allowed usage cannot
   starve systemd, SSH, Telegram, or the polygram daemons.
6. Induce an OOM in one synthetic session and prove: the whole intended session
   failure domain dies; another session, both bots, and admin Claude survive;
   the bot daemon's OOM observer does not increment; the affected turn follows
   the chosen normal-operation recovery contract; telemetry records the limit
   and peak; and no stale workload unit remains.
7. Kill a bot daemon, reboot the VPS, and run a normal deploy/abort cycle.
   Verify restart policy, session cleanup/recreation, and deploy tooling in all
   three cases.

Local `shumorobot` remains the first gate for platform-neutral code behavior,
but it cannot validate Linux cgroups. The Linux containment spike is therefore
a mandatory additional canary, not something inferred from the Mac result.

### Follow-up cutover and rollback

The future infra spec must define an executable staged rollout:

1. Land the reviewed infra spec, launcher spike, and disabled unit templates.
2. Run the synthetic Linux canary and make the final service names and commands
   real.
3. Update the operational skills with those verified commands before the first
   production bot switches; retain the old shared-unit commands explicitly as
   rollback-only.
4. Stop and disable the shared unit before starting replacements so two
   pollers never use one Telegram token.
5. Cut over and verify `shumabit` first, then partner-facing `umi-assistant`
   last, with named soak and abort thresholds.
6. Keep a tested rollback to the old unit/config until both soak gates pass.
   Include reboot recovery in the soak.
7. After the rollback window expires, remove legacy commands and update the
   host-level infrastructure index.

### Follow-up source of truth and operational documentation

The resource-containment design and resulting service topology belong in the
`umi-vps-infra` repository:

1. Write and review a dedicated session-containment spec under
   `umi-vps-infra/docs/`, then link it from that repository's
   `docs/INFRA_SPEC.md`. Ansible service templates and resource settings must
   implement that spec; manual VPS configuration must not become the source of
   truth.
2. After the Linux canary fixes the real names and commands, update the
   canonical `polygram-deploy` skill in the same cutover change, before the
   first production bot switches. It should keep the executable
   release/install/verification procedure, but refer to the UMI VPS infra spec
   for service ownership, restart topology, memory limits, and recovery
   semantics instead of duplicating architectural claims. Keep the old
   shared-unit path labelled rollback-only until the rollback window expires.
3. In that same cutover change, retire or replace
   `~/.claude/commands/shumabit-control.md`. It is a stale Claude-only command
   that still describes the pre-migration Mac, `shumabit@127.0.0.1`, and direct
   official Telegram-channel sessions. Replace it with a concise
   `shumabit-control` user-level skill whose verified operational commands
   follow the deployed infra and whose architectural reference is the UMI VPS
   infra spec.
4. Make the replacement skill canonical under
   `~/.claude/skills/shumabit-control/` and symlink it into
   `~/.codex/skills/shumabit-control`, following the shared-agent configuration
   convention rather than maintaining Claude/Codex copies.
5. Verify both Claude Code and Codex resolve the canonical symlinked skill.
6. After the deployed topology and rollback window settle, update
   `~/INFRASTRUCTURE.md`. That file remains the host-level index and should link
   to the UMI VPS spec rather than restating the full service design.

Skill/runbook edits happen after the canary makes infrastructure names and
commands real but before production cutover needs them. Updating them
speculatively before the canary would replace known-stale instructions with
unverified future instructions; waiting until after cutover would leave
operators without the verified recovery path during the riskiest window.

## Failure modes

- Polygram itself is OOM-killed during normal operation: no signal handler runs
  and no new clean marker is written, so marker-less crash recovery remains
  intact.
- There is a pre-existing early-startup window before boot consumes the prior
  lifecycle's marker. If the new polygram process is directly OOM-killed or
  `SIGKILL`ed inside that window, the following boot can still inherit the
  prior fresh marker. Polling has not started, so the dying process accepted no
  new Telegram work, but older candidates can still be classified clean. Moving
  marker consumption immediately after DB open is a separate lifecycle change;
  document and defer it rather than claiming this targeted handled-stop fix
  closes it.
- Another process in the same cgroup is OOM-killed and systemd stops the unit:
  the counter increases before polygram receives its stop signal, so shutdown
  is crash-like.
- A bridge failure reaches the dispatcher before the stop signal: its own
  observer sample marks that exact message `replay-pending`; the later shutdown
  clears the marker.
- The OOM counter cannot be read: preserve current clean-signal behavior and
  emit one bounded Linux availability signal. After the prior lifecycle's
  marker has been consumed, a marker-persistence failure still fails toward
  crash recovery; the early-startup exception above remains.
- A prior OOM occurred in a service configured to continue running, followed by
  a later deliberate stop in the same cgroup lifetime: this conservative
  design may classify that stop as crash-like and re-dispatch a candidate.
  Production uses `OOMPolicy=stop`, so an OOM immediately ends the cgroup
  lifetime. If polygram is later supported under `OOMPolicy=continue`, the
  observer should advance its baseline after handled OOM events.
- Cgroup path traversal or malformed membership: resolve beneath the fixed
  cgroup root and reject paths that escape it.

## Test and verification plan

Follow red-to-green TDD.

1. First perform a behavior-preserving extraction of the nested shutdown
   persistence choice into the focused seam, verified by the existing clean
   shutdown tests. The extracted seam initially retains today's
   always-clean-on-handled-signal behavior.
2. Add an unchanged-through-the-fix regression test named for the user-facing
   symptom. Using a real DB, the test sends an OOM observation through the same
   seam used by `polygram.js`, then consumes the marker, queries candidates,
   and executes replay. Assert the unanswered candidate calls `recover` once
   and never calls `sendNotice`.
3. Confirm that test is red against the extracted current behavior because the
   seam still records a clean marker; then implement the OOM branch and confirm
   the unchanged test is green.
4. Add a completed-turn candidate to the same test and prove it is not
   recovered, pinning the duplicate-reply boundary.
5. Add two dispatcher ordering tests:
   - shutdown is latched before `BRIDGE_DISCONNECTED`;
   - OOM evidence is visible before shutdown is latched.
   In both cases the exact current row becomes `replay-pending`, while an
   unrelated older `failed` row does not.
6. Add parser/observer tests with injected readers and cgroup root:
   - live cgroup-v2 shape `0::/system.slice/shumabit-sessions.service`;
   - exact positive resolved path
     `/sys/fs/cgroup/system.slice/shumabit-sessions.service/memory.events`;
   - `oom_kill` unchanged, increased, missing, malformed, and unreadable;
   - duplicate, negative, decreased, NUL, deleted, and traversal shapes;
   - resolved paths cannot escape `/sys/fs/cgroup`;
   - samples always re-read the captured path.
7. Add DB tests:
   - crash-shutdown atomically marks `dispatched`/`processing` rows
     `replay-pending`;
   - crash-shutdown clears a pre-existing clean marker;
   - per-bot isolation and polling offset remain intact;
   - a forced marker-clear failure rolls back the status update.
8. Preserve existing clean marker/disposition tests unchanged.
9. Run targeted replay/shutdown tests, then `npm test` with zero skipped or
   failed tests.
10. Review the implementation with independent correctness, Linux/systemd, and
   simplicity/failure-mode lenses before commit and PR.

## Success criteria

- The July 21 OOM sequence would result in
  `replay-on-boot {clean:false, recovered:1, noticed:0}`.
- The four version deploy restarts remain clean and silent unless they actually
  have candidates, in which case the existing resend notice remains unchanged.
- macOS launchd behavior is unchanged.
- No production message content is added to telemetry.
