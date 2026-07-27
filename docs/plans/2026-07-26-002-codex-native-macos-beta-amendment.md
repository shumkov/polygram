---
title: Codex Native macOS Beta - Containment Contract Amendment
type: decision
date: 2026-07-26
status: accepted
accepted: 2026-07-26
amends: 2026-07-26-001-feat-codex-app-server-steering-plan.md
---

# Codex Native macOS Beta - Containment Contract Amendment

## Decision

Proceed with the JavaScript `codex app-server` backend as a native macOS
process for the first single-user beta. Keep the verified graceful stop
protocol, but do not claim that native macOS can prove every deliberately
daemonized descendant dead after app-server or transport loss.

Ivan approved continuing with the recommended native JavaScript/app-server
path. This amendment is folded into the main plan before U1b or U2 resumes.

## Why the plan needs an amendment

Verified against pinned Codex 0.145.0:

- `turn/steer` targets the active turn, preserves two accepted messages in
  order, affects the final response, and returns a distinguishable stale
  rejection after completion.
- `/stop` can interrupt the exact turn, reconcile a natural-terminal race,
  list and clean Codex-tracked background terminals, poll a fresh first page
  to empty, and stop the observed tracked command without tmux.
- After hard app-server loss, a replacement cannot rediscover the old
  terminal. The real PTY command escaped the app-server process group and
  POSIX session; the Codex `processId` is not an OS PID.
- The installed launchd contract only reaps processes that retain the job's
  process-group ID. It therefore does not repair that escape.
- A disposable Docker container did atomically reap a verified `setsid`
  descendant, including after attached-controller loss. This proves a strong
  boundary is possible, but it changes the command environment from native
  macOS to a maintained Linux image.
- Host-positive canaries under the pinned native permission profile found no
  command access to a same-user process argv, debugger sampling, a synthetic
  Keychain item, inherited descriptor contents, or local TCP, UDP, DNS, and
  Unix-socket listeners. The durable checker and tests must still preserve
  these gates.

The original plan combined two goals:

1. safe user-visible stop and retry behavior; and
2. hostile-job-style proof that no arbitrary daemon can survive.

The first is implementable natively. The second needs a container/VM,
privileged service-identity supervisor, or upstream OS-job surface.

## Chosen beta contract

### Healthy stop

For an accepted active turn, `/stop`:

1. quiesces the generation and gives every queued reservation/input a
   persisted stop-cancelled disposition before its handler resolves;
2. sends `turn/interrupt`;
3. reconciles only the exact matching `interrupted`, `completed`, or `failed`
   terminal, including a natural-completion race;
4. calls `thread/backgroundTerminals/clean`;
5. polls `thread/backgroundTerminals/list` from a fresh null cursor until the
   first page is empty with no `nextCursor`; and
6. durably commits the exact terminal reconciliation, accepted clean response,
   and fresh empty-registry observation as three separate checkpoints; and
7. retires the generation, releases workspace ownership, and emits stopped UI
   only after all three commits succeed.

Failure to persist any stop checkpoint enters daemon-wide
`ContainmentFailed` quarantine even when the upstream RPC itself succeeded.

The UI may report only: the Codex turn settled, tracked-terminal cleanup was
accepted, and the fresh registry was observed empty. Registry emptiness is not
process-death proof, so it must not claim tracked processes, a hostile child,
or a deliberately detached daemon were independently proved dead.
Detached/background servers are unsupported in the native beta.

### Containment-failed

Any of the following moves the generation to persisted
`ContainmentFailed`, using an exact reason code rather than a second
equivalent containment state:

- transport or app-server loss after a state-changing request was write
  attempted;
- cleanup/list failure or timeout;
- an unmatched interrupt/stale result;
- config/profile attestation drift during an accepted turn;
- a side-channel boundary failure discovered during an accepted generation;
  or
- shutdown before exact terminal and cleanup settlement.

Static side-channel, profile, launcher, or binary failures discovered before
the first state-changing request disable the Codex runtime before a turn; they
do not create per-generation ambiguity.

While containment has failed:

- do not auto-retry the prompt or steering input;
- persist a daemon-wide native-Codex quarantine before any replacement or
  boot replay;
- do not auto-resume, replace, evict, runtime-switch, or start another Codex
  generation anywhere in that daemon;
- do not report the generation stopped;
- clear misleading progress state and show a concise owner-facing
  diagnostic; and
- keep that quarantine until a later daemon boot on the same validated host
  observes a different kernel boot-session identity, proving the possible
  native descendants cannot have survived.

Request disposition and containment quarantine are separate:

- the owner may mark an ambiguous input incorporated or dismissed, or
  authorize exactly one new retry reservation after a duplicate-risk warning;
- none of those actions releases containment quarantine or workspace
  ownership; and
- the beta has no force-release. A host restart is required after a persisted
  containment failure before another native Codex generation can start.

Each owner action persists actor, time, selected action, reason, and the
immutable original attempt. The event ledger preserves the old generation,
thread, turn, Telegram message, write-attempted, response-observed, terminal,
cleanup, incident stable-host/boot-session identities, and ambiguity state.

The daemon records a validated stable host identity plus kernel boot-session
identity before its first state-changing Codex request. On every boot, before
replay or config-driven deletion/reset, it reconstructs quarantine from
durable unresolved `write-attempted`, active-turn, terminal-pending,
clean-pending, and empty-registry-pending records. A prepared-only row is
definitely not sent and does not create containment quarantine. If an
incident's stable host identity matches and its boot-session identity equals
the current boot, all Codex starts remain quarantined. A different
boot-session identity on that same host may release only containment
quarantine; it does not resolve input disposition. A database restored or
moved to a different host fails closed and requires an explicit audited
migration procedure; it never auto-releases quarantine. Missing, corrupt, or
unreadable host or boot identity also fails closed. Provider/chat reset and
row deletion paths cannot bypass this reconstruction or erase the immutable
incident ledger.

### Request delivery classification

Every state-changing app-server request durably records:

```text
prepared -> write-attempted -> response-observed
```

- `prepared`, including generation, request ID/method, thread/turn when known,
  source message, and timestamps, is committed before serialization.
- Conservative `write-attempted` is committed before calling the stream write.
- `response-observed` is committed before exposing success, advancing process
  state, or releasing a generation/workspace lock.
- Failure before committed `write-attempted` is `CODEX_RPC_NOT_SENT`.
- An explicit JSON-RPC success/error proves only that the RPC response was
  observed. It does not prove tool effects absent, terminal settlement,
  cleanup completion, or descendant death.
- EOF, timeout, write error, or protocol failure after `write-attempted` is
  `CODEX_RPC_OUTCOME_UNKNOWN`.
- If persistence fails before committed `write-attempted`, do not call the
  stream write. The request remains definitely not sent and the runtime fails
  closed until persistence is healthy; it does not create descendant
  containment ambiguity.
- Any failure after committed `write-attempted`, including failure to commit
  `response-observed`, is non-replayable and enters the same
  ambiguity/quarantine path.

Local stream buffering or a write callback is never server acceptance.
`clientUserMessageId` is correlation only. Absence from resumed history is not
proof that a request was unsent, and it never authorizes automatic retry.

## Required changes to the main plan

Before U2, fold these changes into the reviewed plan:

- Revise R11 and AE8 to the healthy-stop and `ContainmentFailed` contract
  above; remove native external-job verification from the first milestone.
- Revise KTD6 so a healthy native-beta generation may retire after exact
  terminal plus successful clean/empty-registry settlement, while
  `ContainmentFailed` keeps its generation and workspace ownership fenced
  until a different boot-session identity on the same validated host releases
  daemon-wide quarantine.
  Keep R9, R14-R16, KTD7, and the generation/effect ledger as hard
  requirements.
- Revise KTD11 so app-server interrupt/list/clean is the native graceful
  boundary, with strong arbitrary-descendant containment explicitly deferred.
- Keep the existing `ContainmentFailed` process state, add exact reason codes,
  daemon-wide quarantine, and same-host boot-session-fenced release before
  replacement.
- Revise R23 and AE15 from identical-workspace exclusion to one daemon-wide
  live native-Codex generation. U3 exposes the per-process lifecycle and
  settlement signals, U4 `ProcessManager` owns the in-memory global
  lease/mutex, and U5 persists and restores that lease before replay. Tests
  must reject a second generation even when it targets a different workspace.
- Revise U3 lifecycle transitions, U4 manager/factory ownership, U5 persisted
  attempts/quarantine/stable-host and boot-session identities, and U7
  stop/queue/replay behavior to use that one state. Clearing an input
  disposition never clears quarantine.
- Require U5/U7 to persist terminal-reconciled, clean-accepted, and
  empty-registry-observed checkpoints before retirement, workspace release, or
  stopped UI, and to reconstruct unresolved quarantine before boot replay or
  any provider/chat reset.
- Treat the negative daemonizing/app-server-loss trace as a documented native
  beta limitation, not a false claim that normal `/stop` is absent.
- Move container/VM or privileged service-identity containment to a separate
  estimated hardening plan before other users, other hosts, or broad
  enablement. The existing single-owner Telegram daemon running locally under
  launchd, with reboot-fenced incident recovery, is the permitted native beta.
- Keep Linux per-session systemd/cgroup containment in U10 rollout work.
- Define “stop safely” in the first-milestone Definition of Done as exact
  turn settlement plus tracked-terminal clean/list verification and
  fail-closed ambiguity handling.
- Enforce one live native-Codex generation across the whole daemon during the
  beta, restored from persistence before boot replay. A quarantined incident
  freezes every new Codex start until a different boot-session identity on the
  same validated host is observed.

## U1b completion update

U1b completed on 2026-07-26 for the direct native implementation path:
resource scaling, real effect-window/retry classification, pinned binary,
same-UID GUI bootstrap/auth, and immutable model/effort replacement-resume
all passed. This host has no configured session wrapper; wrapper behavior is
N/A, and a launchd-managed disposable plist lifecycle remains a rollout gate.

The integrated authenticated pinned-binary checker now passes protocol/schema,
config/profile provenance, same-user side channels, steering/stale, interrupt,
and tracked-terminal clean/list gates. Deterministic transport-disposition
tests pass for every classified state-changing request.

The original reviewed critical path remains `U1a → U1b → U2`; U1 is now
complete for the direct disabled-client path. U2 implements write-attempt
tracking and the line-delimited client
classification. U3 implements the generation/quarantine state and the
prohibition on automatic retry/replacement after ambiguous delivery.

## What blocks beta rollout, not the disabled U2 client

- Missing persistence/UI for `ContainmentFailed` reason codes and owner
  reconciliation.
- Unverified end-to-end launchd behavior under the actual daemon identity,
  including durable boot/quarantine reconstruction and rollback.
- A failed daemon-wide one-live-generation or persisted-quarantine restoration
  test.

The beta remains single-owner, opt-in, hosted by the existing local launchd
Telegram daemon, text-first, no MCP, no interactive approvals, and no claim of
hostile multi-tenant isolation.

Background and detached development servers are common coding workflows, not
an exotic hostile-only case. The opt-in warning must state that they are
unsupported in this native beta and may survive a hard app-server/transport
failure until the required host restart.

## Alternatives not chosen

### One Docker/OCI container per chat

This is the strongest demonstrated boundary and should be chosen if arbitrary
daemon death is non-negotiable. Docker Desktop on macOS runs containers in a
[lightweight Linux VM](https://docs.docker.com/desktop/features/networking/)
and exposes only explicitly shared/bind-mounted host files. It adds a pinned
Linux Codex image, Linux tool inventory, ChatGPT credential/state mounts,
workspace bind-mount semantics, egress policy, container-ID persistence and
boot reconciliation, and Docker availability/resource gates. It also loses
transparent access to native macOS tools. Do not introduce it as an invisible
launcher detail.

### Dedicated macOS service identity

A trusted privileged supervisor could make every Codex worker under one UID a
single global kill domain. It requires account lifecycle, separate auth,
workspace ACLs, PID/audit-token-safe enumeration, spawn freezing, and accepts
cross-chat termination. It is operationally larger and still not a native
per-session kernel job.

### Apple `container`

Apple's pre-1.0 [`container`](https://github.com/apple/container) tool provides
a lightweight VM per Linux container on Apple-silicon macOS 26. It is not
installed or validated on this host and has the same native-tool/image
boundary as Docker. Revisit after the beta if its per-container VM isolation
is worth the dependency.

Docker, Apple `container`, and dedicated-service-identity work contribute no
MVP tasks or dependencies. Any of them requires a separate reviewed and
estimated plan.

## Verification additions

- Deterministic fake transport tests for turn start and steer:
  cut before write, full line read with response lost, and timeout after read.
- Resume-correlation tests: zero matches stays unknown; one exact match is
  observed; duplicates or a steer match under the wrong turn fail closed.
- Authenticated native side-channel run with host-positive process, debugger,
  Keychain, descriptor, TCP, UDP, DNS, and Unix-socket canaries.
- Normal and natural-race stop traces continue to prove exact terminal,
  background clean, fresh-first-page empty, and tracked command exit.
- Hard-loss daemonizing trace must remain as a pinned negative regression
  fixture so later code cannot silently relabel the limitation as containment.

## Estimate and sequencing impact

Container implementation was not included in the accepted native JavaScript
path. The remaining U1a research stays inside its existing 3/6/11 combined
engineer-day gate. Durable daemon-wide quarantine, same-host boot-session
release, owner input reconciliation, and audit/UI add **1/2/4 engineer-days**:

- U3/U4 Orchestra lifecycle/global lease: **0/1/1**;
- U5 Polygram persistence/boot reconstruction: **1/1/2**; and
- U7 Polygram owner reconciliation/UI: **0/0/1**.

With this accepted amendment, the implementation-plan total changes from 66/126/230 to
**67/128/234 best/likely/worst engineer-days**. The corresponding U1-U10 total
changes from 58/111/203 to **59/113/207**. Repository U1-U10 totals become
**32/60/110 Orchestra** plus **27/53/97 Polygram**; full-program repository
totals become **34/65/119 Orchestra** plus **33/63/115 Polygram**. The
amendment must update the main plan and estimate tables together so repository
totals continue to add up.

If strong macOS containment is chosen instead, stop this path and re-estimate a
container milestone before U2. The generic containment spike is feasibility
evidence, not enough to price or approve that architecture.
