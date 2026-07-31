# Deploy and restart without losing unrelated agent sessions

Status: IMPLEMENTED AND REVIEWED in code for independent runtime ownership,
Claude and Codex containment, and dual-provider clean-restart continuation.
Release, production activation, the controlled OOM trials, and the reboot proof
remain to be completed.

Live tmux adoption and detached/background-work preservation are postponed
unless production telemetry shows they are genuinely needed.

Scope: Polygram, Water, `@shumkov/orchestra`, and `umi-vps-infra`.

## 1. Outcome

Routine operations must satisfy three separate guarantees:

1. **Owner isolation:** restarting or deploying one application does not restart
   another application or a shared tmux owner.
2. **Turn recovery:** a deliberate restart can continue one provably
   interrupted foreground turn without replaying the original user message.
3. **Resource containment:** a runaway provider process tree is killed within
   its own bounded cgroup instead of exhausting the VPS or taking unrelated
   owners with it.

These are independent claims. Passing one does not imply the others.

## 2. Current production state

### Complete

- Polygram Shumabit, Polygram UMI Assistant, and Water have independent systemd
  services.
- Polygram, Water, and operator tmux servers have independent owners and named
  sockets.
- The legacy `shumabit-sessions.service` and `start-sessions.sh` owner are
  decommissioned and are not a rollback path.
- Restarting Shumabit leaves UMI Assistant, Water, and every tmux owner
  unchanged.
- Restarting Water leaves both Polygram bots and every tmux owner unchanged.
- Polygram records signal-time busy state, exposes an IPC busy check, fences
  reply-bearing delivery, and persists clean/crash shutdown disposition.
- Water has a bounded shutdown barrier and crash-safe inbound handoff.
- Claude CLI processes launched by Polygram, Water, and the managed operator
  path enter transient scopes under the user-manager `claude.slice`.
- The aggregate slice and each Claude scope have finite memory, swap, and task
  limits.
- Claude CLI and native Codex clean-restart resume/continue are implemented
  behind independent rollout flags. Production still has only Claude enabled
  for Shumabit until this release is activated.
- Native Codex app-server/tool-process containment is wired through the same
  attested session launcher and pinned in `@shumkov/orchestra` 0.10.13.

### Remaining

- Release and production activation of the reviewed Claude+Codex path.
- One controlled low-limit OOM proof for each provider launch seam.
- One real VPS reboot proof after the final Claude+Codex topology is installed.
- A real eligible production resume success for each enabled backend.

### Intentionally postponed

- Keeping a Claude tmux session alive across the daemon restart.
- Reconnecting a Channels bridge to a surviving session.
- Preserving detached shells, subagents, scheduled wakeups, native background
  terminals, or other background work across restart.
- A session broker.

The postponed work is reconsidered only if telemetry repeatedly shows a
foreground turn exceeding the bounded recovery design or users materially lose
background work during deploys.

## 3. Runtime ownership

The final owner graph is:

```text
system manager
├── polygram-shumabit.service
├── polygram-umi-assistant.service
├── water.service
├── polygram-tmux.service
├── water-tmux.service
└── shumabit-admin-tmux.service

user manager
└── claude.slice  # installed agent workload slice
    ├── run-*.scope  # Claude CLI process tree
    └── run-*.scope  # Codex app-server and tool process tree
```

The existing production slice is named `claude.slice`. Renaming it is not
required for correctness and would add migration risk; documentation may call it
the agent workload slice while retaining the installed unit name.

Application daemons and tmux servers remain outside the workload slice.
Resource containment is not a same-UID security boundary.

## 4. Restart contract

### 4.1 Cross-owner restart

A deploy command targets exactly one application service. It must not:

- restart either other application;
- restart a tmux owner;
- invoke the retired legacy unit;
- kill the default operator tmux server;
- run a broad `pkill`, `kill-server`, or process-name sweep.

For a Polygram deploy, the helper requests a one-shot clean restart through that
bot's IPC. The daemon immediately starts its own shutdown from that request;
the helper does not arm the daemon and then send a separate signal. The
`Restart=always` unit starts the replacement process, and the helper proves the
old PID is gone and the new PID is ready. This causally distinct path applies to
continuation intents only; direct operator restarts and host reboot do not
carry it. Water remains governed only by its shutdown barrier.

Before and after a restart, record PID/start-time witnesses for every unrelated
service and tmux owner.

### 4.2 Foreground turns

Polygram stops intake, fences reply-bearing Telegram delivery, and retires its
provider processes through exact backend-specific shutdown. The clean marker
and any one-shot continuation intents are committed only after the old process
and delivery boundaries are closed.

The exact Claude and Codex continuation rules live in
`RESUME_CONTINUE_SPEC.md`.

Water drains its owned foreground work up to its configured deadline. It does
not implement provider resume/continue.

### 4.3 Background work

Background work is not adopted across a restart. A turn with active or
unresolved background ownership is not eligible for automatic continuation.
The user receives a clear notice rather than an unsafe claim that the work was
preserved.

## 5. Native Codex containment parity

### 5.1 Problem

The current scope launcher is applied at the Claude CLI launch seam. Codex uses
a different seam:

```text
Polygram
  └── Orchestra CodexAppServerClient
      └── Node app-server supervisor (process-group leader)
          └── pinned `codex app-server`
              └── command/tool descendants
```

The Codex app-server and its descendants therefore are not currently covered by
the production per-session cgroup claim.

Wrapping the outer Node supervisor with the Claude launcher is rejected. The
supervisor relies on being the detached process-group leader and signals its own
group during verified teardown. An outer synchronous wrapper would change that
identity and weaken cleanup proof.

### 5.2 Chosen seam

Keep the Node supervisor as the detached process-group leader. Give it an
optional, attested session-launcher path and have it spawn:

```text
session-scope-launcher /absolute/pinned/codex app-server --strict-config --stdio
```

instead of spawning the pinned Codex binary directly.

This keeps:

- binary attestation against the real Codex executable;
- the supervisor's process-group leadership;
- stdin/stdout/stderr backpressure;
- exact group shutdown and empty-group proof;
- the app-server and all of its tool descendants in one transient scope.

The small Node supervisor remains outside the workload scope. It is bounded by
the owning Polygram service and is not the memory-risk workload.

The canonical launcher path and file fingerprint become part of the Codex
static runtime receipt and spawn-profile identity. The launcher must be a
regular non-symlink file under a root-owned, non-writable canonical ancestor
chain. Orchestra repeats that attestation immediately before every spawn, not
only at daemon preflight. A missing, replaced, mutable, non-root-owned, or
writable launcher fails the spawn; there is no uncontained fallback. Root
compromise is outside this same-UID containment threat model.

Enabling containment intentionally changes the Codex spawn-profile ID because
the launcher becomes part of the attested profile. Existing provider rows are
replaced through the normal generation transition before the Codex resume flag
is enabled; the rollout must not reinterpret an old receipt as the new profile.

On non-systemd hosts the launcher is absent and current direct spawning remains
supported. Production Linux requires it.

### 5.3 Launcher and preflight

Reuse the installed synchronous `systemd-run --user --scope` mechanism. Do not
use `--wait`; systemd 255 rejects it with `--scope`, and scope execution is
already synchronous.

The production preflight must prove separately:

- Claude: a harmless CLI-seam process enters
  `user@1000.service/claude.slice/run-*.scope`;
- Codex: the supervisor remains outside the slice while its launched child
  enters one exact scope under the slice;
- effective `MemoryHigh`, `MemoryMax`, `MemorySwapMax`, `TasksMax`, and
  `OOMPolicy` match approved values;
- the pinned Codex binary and a child it spawns are in the same scope;
- no production-managed Claude or Codex workload PID is unmanaged.

The wrapper filename may remain `claude-session-scope` for compatibility.
Renaming or adding aliases is documentation cleanup, not a prerequisite.

## 6. Controlled OOM proof

This proof uses disposable low-limit scopes. It never lowers production limits
and never allocates memory inside a production chat session.

Run two trials:

1. **Claude launch seam:** start a deterministic allocator through the same
   launcher path used by CLI sessions.
2. **Codex launch seam:** start a deterministic fake app-server/child allocator
   through the exact supervisor-plus-launcher path used by Codex.

For each trial:

- create a uniquely named disposable slice/scope with a deliberately low
  `MemoryMax`;
- start an allocator that blocks without allocating and has a bounded
  self-termination watchdog;
- record unrelated service and tmux PID/start-time witnesses;
- from an independent controller, prove the allocator and every descendant are
  in only that disposable scope and that its effective `MemoryMax`,
  `MemorySwapMax`, `TasksMax`, and `OOMPolicy` equal the disposable test
  values;
- release the allocator only after every cgroup and limit assertion passes;
- cross the low limit and observe an OOM kill for that scope;
- prove the owning test harness terminates and the scope is collected;
- prove Polygram Shumabit, Polygram UMI Assistant, Water, all three tmux owners,
  and the production workload slice remain unchanged;
- record cgroup `memory.events` deltas and unit result without message content or
  opaque session identifiers.

Passing the synthetic trial proves the containment mechanics and exact launch
seams. A separate steady-state fleet scan proves real production provider PIDs
use those seams.

Fixture-level classification tests also combine child OOM with daemon shutdown:
OOM before candidate capture and during retirement, plus the finer
delivery-drain and interrupt boundaries, must remain crash-like and persist no
continuation intent even when a catchable daemon signal follows.

## 7. Reboot proof

Run only after Claude and Codex containment plus both clean-resume gates are
installed.

Before reboot:

- verify every independent service and tmux owner is enabled and healthy;
- verify the legacy unit and script are absent;
- record versions, unit files, enabled state, PID/start-time witnesses, bot IPC
  health, tmux sockets, active scope count, and production cgroup limits;
- ensure no queued delivery, unresolved Water handoff, or Codex reconciliation
  action is active;
- start one disposable, side-effect-free foreground turn for each enabled
  provider without issuing a clean-continuation authorization.

After reboot, within one bounded observation window:

- the lingering user manager and workload slice become available;
- all three tmux owners start on their exact sockets;
- both Polygram services and Water start once and remain healthy;
- one poller/receiver owns each external token/ingress;
- no legacy unit appears;
- new Claude and Codex test sessions enter independent scopes;
- daemon and tmux PIDs remain outside the workload slice;
- effective limits equal the approved values;
- IPC health and one harmless end-to-end message per enabled provider pass
  through disposable, side-effect-free test identities;
- clean-restart intents are not fabricated by the reboot;
- both disposable foreground turns receive conservative reboot recovery with
  no literal `continue`;
- no automatic original-message replay or duplicate reply occurs.

A reboot failure does not restore the legacy topology. Repair the independent
owner or ordering defect in place.

## 8. Gates

| Gate | Done signal |
|---|---|
| Owner topology | six exact independent owners active; legacy owner absent |
| Restart isolation | restart either app; every unrelated witness unchanged |
| Claude containment | every managed Claude workload PID in a bounded scope |
| Codex containment | every managed Codex app-server/tool PID in a bounded scope |
| Claude clean resume | exact session, one `continue`, one final, zero duplicates |
| Codex clean resume | exact thread/turn, one `continue`, one final, zero duplicates |
| Controlled OOM | both disposable launch-seam trials kill only their own scope |
| Reboot | owners, sockets, pollers, scopes, limits, and health reconstruct once |

## 9. Failure handling

| Failure | Handling |
|---|---|
| One app deploy touches another owner | stop rollout; restore exact independent units |
| Missing tmux owner/socket | fail app preflight; do not auto-create under daemon |
| Scope launcher unavailable | fail provider preflight; never spawn uncontained |
| Provider retirement uncertain | crash-like shutdown; no continuation intent |
| Reply delivery uncertain | no retry; uncertainty notice |
| Codex containment cleanup uncertain | retain exact generation fence |
| Disposable OOM affects unrelated witness | fail the containment claim and investigate |
| Reboot ordering race | fix dependency/readiness contract in independent topology |

## 10. Definition of done

- Polygram, Water, and all tmux owners remain independently supervised.
- The legacy owner stays absent.
- Claude and native Codex foreground turns each have bounded, independently
  gated clean-restart continuation.
- Claude and native Codex workload trees each enter bounded per-generation
  scopes with no uncontained production fallback.
- Both disposable OOM trials pass without changing unrelated witnesses.
- The real reboot proof reconstructs the final topology and health.
- Infrastructure docs and both Claude/Codex deploy/control skills describe the
  same final system.
- Live adoption and background-work preservation remain postponed.
