# Codex support estimate for Orchestra and Polygram

Status: research and estimation only
Date: 2026-07-25
Repositories examined:

- Polygram: `330dae0` on `investigate/codex-support-estimate` (`0.21.0`)
- Orchestra working checkout: `dc932a2` on `feat/claude-session-containment` (`0.4.3`)
- Orchestra compatibility baseline used by Polygram: tag `v0.5.0` / `b788efb`
- Installed Codex CLI: `codex-cli 0.145.0`

No application code, service configuration, or production state was changed during
this investigation.

Evidence labels used below:

- **Verified** — observed in the named repository/runtime snapshot or stated by
  an official upstream source.
- **Inference / recommendation** — an architectural conclusion drawn from those
  facts; it has not been implemented.
- **Estimate** — best/likely/worst engineering judgment, not measured delivery
  history or a commitment.

## Post-estimate validation update — 2026-07-26

Ivan subsequently chose JavaScript plus pinned `codex app-server`, with true
mid-turn steering and no Codex tmux or narrow SDK backend. The reviewed
implementation plan is
[`docs/plans/2026-07-26-001-feat-codex-app-server-steering-plan.md`](plans/2026-07-26-001-feat-codex-app-server-steering-plan.md).

Authenticated U1a validation passed named-profile containment, fresh-process
resume, ordered semantic steering, and definite stale steering. The initial
process-ownership stop was then narrowed by a verified protocol correction.
The official pinned contract says `turn/interrupt` does not terminate
background terminals. With `capabilities.experimentalApi = true`,
`thread/backgroundTerminals/list` observed the interrupted command and
`thread/backgroundTerminals/clean` accepted cleanup; a fresh first-page poll
reached empty and the observed synthetic PID died before its bounded natural
deadline. Stopping the Codex model
turn and cleaning a tracked terminal are therefore feasible without tmux.
Pinned source drains the terminal registry before non-confirming termination,
however, so list-empty and one PID observation do not prove arbitrary
daemonized descendants dead.

The revised durable authenticated U1a checker subsequently passed the
named-profile, ordered-steering, definite-stale, tracked-terminal stop,
deterministic hosted enforcement, same-user isolation, and transport
classification gates together.

A separate crash boundary remains verified: if app-server exits before clean,
a replacement can resume the thread but cannot rediscover or clean the old
terminal. The exposed `processId` is a random Codex-local handle, `osPid` is
null in 0.145.0, and the live macOS PTY command escaped both the app-server
process group and POSIX session. Ivan accepted this as an explicit native
macOS beta limitation rather than requiring container or privileged
per-session containment before U2. The accepted contract permits only one live
native Codex generation daemon-wide; an ambiguous hard loss persists a
daemon-wide quarantine that can be released only after the same stable host
reports a new kernel boot-session identity. U1b is complete and U2 may proceed
under the
[reviewed amendment](plans/2026-07-26-002-codex-native-macos-beta-amendment.md).

## Executive conclusion (verified facts plus recommendation)

There are three materially different meanings of “Codex support”:

1. **Codex CLI backend** — run the local Codex runtime, authenticated either with a
   ChatGPT subscription or an API key. This includes two integration surfaces:
   the higher-level TypeScript Codex SDK / `codex exec`, and the richer
   `codex app-server`.
2. **OpenAI API/SDK backend** — build and own an agent runtime around the OpenAI
   Responses API and OpenAI SDK. This requires API credentials and API billing;
   it is not a way to consume a ChatGPT subscription.
3. **Model-name passthrough** — add names such as `gpt-5.6-sol` to existing model
   selectors while continuing to invoke a Claude backend. This does not work:
   an Anthropic SDK or Claude CLI cannot execute an OpenAI model merely because
   its name is accepted by configuration.

The direct answer to the subscription question is **yes, with an important
classification caveat**:

- The official TypeScript package `@openai/codex-sdk` wraps the locally installed
  `codex` executable and exchanges JSONL with it. It can therefore use that
  executable’s cached ChatGPT authentication.
- `codex login status` on this host reports `Logged in using ChatGPT`.
- The authenticated `model/list` result from the installed runtime currently
  exposes `gpt-5.6-sol`, with `low`, `medium`, `high`, `xhigh`, `max`, and
  `ultra` reasoning efforts. It also exposes `gpt-5.6-terra` and other models.
- That result is a point-in-time account/runtime capability, not a permanent
  model contract. Polygram should query or validate the catalog rather than
  permanently assume that every account has Sol.

Thus a separate raw CLI/TUI integration is **not required merely to get ChatGPT
subscription access or Sol**. The Codex SDK is itself CLI-backed. However, the
SDK / `codex exec` surface is too narrow for all of Polygram’s interactive
behavior: approvals, in-turn user questions, same-turn steering, and detailed
lifecycle control require `codex app-server` or provider-specific compromises.

### Recommendation in one paragraph

The settled architecture is a provider-neutral runtime seam with a pinned
JavaScript `codex app-server` adapter, while preserving the current Claude SDK
and CLI paths unchanged. The earlier narrow Codex SDK option and Codex tmux
option are rejected. Use the verified graceful stop protocol: quiesce,
interrupt or reconcile an exact natural terminal, clean background terminals,
and poll a fresh first page until empty. For the native macOS beta, enforce one
live generation daemon-wide and persist a reboot-cleared quarantine after
ambiguous hard loss. Stronger per-session containment remains a later
architecture alternative, not a U2 blocker.

### Historical Rust timing analysis — superseded

The original estimate considered a narrow TypeScript SDK milestone followed by
a Node-versus-Rust decision. Ivan later rejected that branch and chose
JavaScript plus app-server, with no Codex SDK or tmux backend. The Rust analysis
later in this document is retained only as historical comparison data; it is
not a current recommendation or sequencing step.

## Research basis and baseline cautions

The investigation covered the applicable user-level and repository
`AGENTS.md` instructions, the host infrastructure documentation, all matching
`AGENTS.md` and `CLAUDE.md` files found in the two repository trees, current
source and tests, the installed CLI’s help and generated app-server schema, and
current official OpenAI documentation.

The originally checked-out Orchestra tree was not the exact source Polygram
consumes: Polygram pins `@shumkov/orchestra` `0.5.0`, while that checkout’s
package version was `0.4.3`. This was resolved for implementation planning:
`v0.5.0` / `b788efb` is the settled baseline, and U1a work uses an isolated
worktree from it. The older checkout remains read-only and is not an
implementation choice.

Approximate scale relevant to the estimate:

- Polygram: about 24.7k application lines and 138 test files.
- Orchestra: about 11.7k library lines and 19 test files.
- The Claude CLI process alone is several thousand lines and deliberately
  coupled to a pinned Claude TUI/JSONL format.

## What each possible backend really provides

| Candidate | Authentication / billing | Session runtime | Strengths | Material limitations |
| --- | --- | --- | --- | --- |
| Codex SDK / `codex exec` | ChatGPT login or API key through local Codex CLI | A new `codex exec` child per turn; durable Codex thread on disk | Official TypeScript wrapper, streaming JSONL, stable thread ID/resume, model and effort, local images, sandbox and approval policy, `AbortSignal` | No rich bidirectional approval/question callbacks or same-turn steering; cancellation aborts the turn process |
| Codex app-server | ChatGPT login or provisioned Codex credentials | Long-lived newline-delimited stdio process | Thread start/resume/fork, turn start/steer/interrupt, model discovery, approvals, granular events | Whole subcommand is labeled experimental; WebSocket transport is unsupported; several useful methods are separately experimental |
| OpenAI Responses API / Agents SDK | OpenAI API key and API billing | Runtime owned by Orchestra/Polygram | Stable HTTP APIs, hosted capabilities, no local CLI supervision | Does not consume a ChatGPT subscription; reproducing Codex’s harness, local execution, sandboxing, MCP, and session behavior becomes this project’s responsibility |
| Model-name passthrough | Whatever the existing Claude backend uses | Existing Claude process | Very small configuration change | Cannot run an OpenAI model; would fail or mislead users |

The TypeScript Codex SDK therefore belongs in category 1, not category 2.

## Current Codex surface (verified)

### Installed runtime

`codex-cli 0.145.0` currently provides:

- `codex exec` with JSONL output, model selection, sandbox and approval policy,
  output schemas, working-directory/additional-directory controls, and an
  ephemeral mode;
- `codex exec resume` using a durable session ID, name, or the last session;
- `codex app-server` over stdio, with unsupported WebSocket options;
- `codex mcp` for configuring MCP servers and `codex mcp-server` for exposing
  Codex as an MCP server.

The inspected generated app-server protocol contains methods not individually
marked experimental for:

- `thread/start`, `thread/resume`, and `thread/fork`;
- `turn/start`, `turn/steer`, and `turn/interrupt`;
- `model/list`;
- command/file-change approval requests;
- streamed thread, turn, item, error, usage, and status notifications.

The response exposes a stable thread ID and a session ID. The stable thread ID
is the value Polygram should persist and use for resume.

The following should not be part of the first production contract because they
are marked experimental in the current schema or docs:

- dynamic tools;
- app-server-provided `tool/requestUserInput`;
- generated TypeScript protocol bindings;
- WebSocket transport.

Background-terminal management is the deliberate exception: the first
milestone requires only the version-pinned `list` and `clean` methods because
official `turn/interrupt` explicitly leaves those terminals running.
Experimental negotiation enables the server's experimental protocol
generally, so separate outbound-method and inbound-request/notification
allowlists must fault every other experimental surface locally.

### Authentication and model discovery

Official Codex authentication supports ChatGPT login and API-key login. Cached
credentials can be stored in the Codex auth file or the OS credential store and
are refreshed by the CLI. Automation must protect that store as a secret.

For API-key automation, the non-interactive docs specifically describe
`CODEX_API_KEY` for `codex exec`. Do not assume every app-server authentication
path accepts that environment variable until a spike verifies it; a managed
`codex login --with-api-key`/credential-store flow may be required.

Model availability varies by runtime version, account, workspace, rollout, and
policy. The source of truth at runtime should be `model/list`; configuration may
allow an explicit override, but should fail loudly if an unavailable model is
selected.

## Current architecture findings (verified)

### Orchestra

Orchestra has a useful common shape but it is not yet provider-neutral:

- `Process` is an `EventEmitter` with required `start`, `send`, and `kill`
  operations plus optional interrupt, model, flags, permissions, reset,
  context, drain, injection, delivery, questions, and steering operations.
- `ProcessManager` owns one process per session key, concurrent spawn gates,
  capacity/LRU behavior, in-flight pinning, background/question/delivery state,
  and callback-to-event forwarding.
- The process factory currently selects only `sdk` or `cli`, with historical
  aliases. Unknown or incompletely wired CLI choices can fall back to the SDK;
  a requested Codex runtime must instead fail loudly.
- `SdkProcess` is a long-lived Claude Agent SDK query/input controller.
- `CliProcess` supervises a Claude TUI in tmux and parses undocumented Claude
  JSONL, queue operations, banners, and hooks.
- Several public properties and results are Claude-shaped:
  `claudeSessionId`, Claude result subtypes, cost/cache fields, stop reasons,
  and a large set of Claude/TUI callbacks.
- The contract test suite exercises the same scenarios against SDK and CLI,
  with capability-specific CLI skips. This is a strong starting point for a
  provider contract, provided capabilities become explicit.
- The v0.5 session containment hook wraps Claude CLI launches. Codex needs an
  equivalent launch policy, but must not be silently routed through assumptions
  specific to tmux or Claude’s home directory.

The Codex backend should be a new process implementation. Reusing or generalizing
the Claude tmux parser would couple two unrelated undocumented TUIs and produce
the worst maintenance profile.

### Polygram

Polygram assumes Claude more deeply than its top-level `pm` setting suggests:

- `pm` currently selects `sdk` or `cli`, with `channels`/`tmux` aliases.
- Model configuration is hardcoded to Claude’s `opus`, `sonnet`, and `haiku`;
  effort is common-looking but valid values and defaults are provider-specific.
- Backend choice also determines prompt delivery (`inline` versus tool-based).
  Provider, runtime implementation, and delivery mode need to become separate
  concepts.
- `sendToProcess` holds a per-session lock for the full turn. That naturally
  supports a serialized Codex SDK MVP.
- Autosteer assumes synchronous `injectUserMessage`; app-server steering is an
  asynchronous request with an expected turn ID.
- Session persistence uses `claude_session_id` and `pm_backend`. Callers assume
  the stored ID is always safe to resume through the selected backend.
- Boot replay, crash recovery, idle auto-resume, and bridge-disconnect recovery
  all feed back into this session identity and process factory.
- Result handling expects Anthropic usage/cache/cost fields and Claude result
  subtypes.
- Approvals and user questions already have durable Telegram UI/store layers.
  Those consumer-side components are reusable after normalizing provider
  requests.
- `channels-tool-dispatcher` contains reusable Telegram text/file/edit/react and
  file-root validation behavior. Its inbound protocol is Claude Channels
  specific and is not a drop-in Codex MCP server.
- `/compact` injects Claude slash input. `/rewind` edits/forks Claude’s
  undocumented session JSONL. Codex has `thread/compact/start` and
  `thread/fork`, but rewind requires a mapping from Telegram messages to Codex
  turn IDs.
- Error classification, telemetry, callbacks, copy, config UI, and tests contain
  Claude/TMUX-specific concepts.

The safest persistence design uses an explicit session namespace, conceptually:

```text
(polygram_session_key, session_namespace)
  -> provider_thread_id, last_runtime_id, metadata
```

`session_namespace` is distinct from provider and implementation. It must
preserve today’s deliberate Claude SDK/CLI/channels invalidation rules. Codex
SDK and app-server may share a namespace only after a bidirectional interop spike
proves that threads created by either surface resume correctly through the
other; until then they get separate namespaces. This permits a chat to switch
runtimes and later return to a compatible prior context without passing an
incompatible ID to another runtime.

A smaller alternative is one active provider pointer and a forced context reset
on every provider switch. That is acceptable for an MVP only if the reset is
explicit in UI and documented as destructive to conversational continuity.

## Recommended architecture (inference / recommendation)

### 1. Make runtime identity explicit

Use canonical runtime IDs such as:

- `claude-sdk`
- `claude-cli`
- `codex-sdk`
- `codex-app-server`

Keep existing `sdk`, `cli`, `channels`, and `tmux` inputs as aliases resolving to
the exact current Claude behavior. Do not redefine `sdk` to mean “the SDK for
whichever provider was most recently selected”; that would change existing
configuration silently.

A product-facing `codex` alias may resolve to the supported Codex implementation
chosen for a release. Persistence should store both the canonical runtime and
the compatible session namespace; runtime identity alone does not prove
transcript compatibility.

### 2. Normalize outcomes, retain capabilities

Add provider-neutral envelopes rather than forcing Codex into Claude result
objects:

```text
ProcessTurnResult
  runtime, providerSessionId, status
  output: text blocks / delivered-tool acknowledgements
  usage: provider-native plus normalized token counts where available
  error: category, retryability, provider details

ProcessCapabilities
  steer, interrupt, approvals, questions, files, tools
  compact, fork, backgroundWork, cost, historyResume, interruptedTurnRecovery
```

The public manager must retain compatibility accessors and the current
synchronous, non-throwing sentinel behavior of `injectUserMessage`, `steer`,
`drainQueue`, and `fireUserMessage` for Claude callers. Add a separate async
Codex-facing operation such as `steerTurn` (or report later RPC rejection by
event). New async operations may return typed capability errors. Unknown
runtimes must fail loudly; they must never fall back to Claude.

### 3. Separate process transport from Telegram tools

For the durable backend:

```text
Telegram / Polygram
        |
provider-neutral turn + tool DTOs
        |
Orchestra CodexProcess
        |
newline-delimited app-server protocol
        |
codex app-server ---- standard MCP ---- Polygram Codex tool bridge
```

Start with one app-server child per active Orchestra process/session. It matches
current LRU/ownership semantics and limits most process faults and routing errors
to one chat. It is **not** hostile multi-tenant isolation: children normally
share the service user, Codex auth/session store, and some filesystem visibility.
Stronger isolation requires separate OS identities or containers/worktrees.
Measure memory before committing: if one process per chat is too expensive, a
shared app-server supervisor is possible, but it makes capacity, crash recovery,
and routing substantially harder.

Controlled cancellation must use Codex's two separate lifecycle operations:
`turn/interrupt` settles the model turn, then
`thread/backgroundTerminals/clean` requests termination of its tracked
terminal processes. Orchestra should poll
`thread/backgroundTerminals/list` from a null cursor until the first page is
empty with no `nextCursor`; reaching the end of a paginated live snapshot is
not emptiness proof. Initialize experimental negotiation for only the
production need for `list` and `clean`, then locally allowlist inbound and
outbound protocol traffic. Do not log or persist terminal command, cwd,
handle, or OS-metadata fields.

This registry cleanup is not complete process-tree proof or a crash boundary.
Pinned source drains the registry before non-confirming termination, and if
app-server disappears first, 0.145.0 loses that registry entirely. Linux can
use a per-session cgroup/container. Strong macOS cleanup requires a container
or a per-session ephemeral identity plus a trusted supervisor able to
enumerate, kill, and reap the whole job unless upstream exposes durable cleanup
or an externally usable OS identity. A common service user, plain process
groups, POSIX sessions, and reconnect are insufficient.

For the fast MVP, `CodexSdkProcess` may instead invoke the TypeScript SDK per
turn. The provider-neutral session, result, and capability work remains reusable
if this adapter is later replaced by app-server.

### 4. Build a separate Codex MCP bridge

Do not retrofit Codex messages into the Claude Channels socket protocol. The
bounded recommended topology is a per-chat stdio MCP child launched for Codex,
forwarding to a Polygram-owned authenticated local RPC endpoint using a
per-session, per-process-generation credential. Polygram remains owner of
Telegram dispatch and durable question state. The bridge must bind calls to
chat/thread/turn/generation, time out and cancel with the turn, reconnect only
under a new generation, and invalidate pending `ask_user` calls when either side
dies. Reuse the existing dispatcher and file security helpers behind canonical
DTOs, not the Claude Channels wire format.

Text can initially be returned as the normal assistant final output. File
replies, reactions, edits, and explicit `ask_user` should enter the full-parity
scope through the MCP bridge. `ask_user` as a project MCP tool is preferable to
depending on app-server’s experimental built-in user-input method.

### 5. Pin runtime and protocol

The standalone `current` symlink can drift. Orchestra should own the compatible
protocol client/schema and accept an injected absolute `codexBin` plus the
existing containment/session launcher. Polygram’s deployment layer should
resolve and log the exact binary and fail clearly if it is missing. Every Codex
child must pass through configured crash containment before rollout; that
launcher is a fallback boundary, not a substitute for the normal
interrupt-plus-clean protocol. Run stable and experimental schema/golden-trace
compatibility gates before upgrades and pin the generated app-server schema
alongside the custom client.

## Original scope scenarios (historical estimates)

These scenarios preserve the basis for the engineer-day ranges. The Codex SDK
scenario is rejected; the app-server scenario is current only after U1a passes.

### Deliberately narrow fast MVP: Codex SDK / exec (rejected)

In scope:

- opt-in `codex-sdk` runtime; all current Claude defaults unchanged;
- current ChatGPT cached login and API-key-compatible CLI authentication;
- session-namespace-aware per-chat storage;
- stable Codex thread start/resume;
- one serialized turn at a time;
- streamed/final text replies;
- inbound local image input after current file validation;
- configured model and reasoning-effort selection, with a pinned allowlist and a
  clear runtime-unavailable error;
- `/stop` through `AbortSignal`;
- basic process/turn timeout, error normalization, clean restart, and boot replay
  only for inbound work known not to have started;
- capability-aware UI and a clear unsupported response.

Explicitly out of scope:

- live approvals;
- agent-initiated questions;
- same-turn autosteer;
- custom Telegram reply/file/react/edit tools;
- background shell supervision;
- `/compact` and `/rewind`;
- exact subscription cost reporting;
- behavioral equivalence to Claude hooks and autonomous callbacks.

This MVP is useful if the goal is “let a chat use Sol through my ChatGPT login
soon.” It is not the foundation for claiming full parity.

Thread resume here means restoring conversation history for a **new** turn. It
does not establish continuation of an in-progress turn after process death. If
a prior turn emitted output, ran a command, or may have delivered an external
effect, the MVP marks it interrupted/ambiguous and requires reconciliation or an
explicit user retry; it does not auto-submit the prompt again.

### Durable text MVP: Codex app-server

In scope:

- everything in the fast MVP except the SDK-specific turn runner;
- one supervised app-server child per active chat;
- explicit initialize/initialized handshake;
- thread start/resume and durable ID;
- turn start, event stream, normal completion, interruption, and recovery for a
  subsequent turn after child replacement;
- queued follow-up turns after the current turn;
- only methods not individually marked experimental in the inspected `0.145.0`
  schema plus the two terminal-control methods required for correct stop,
  within an overall experimental app-server surface;
- exact runtime/schema pinning and compatibility tests.

Still out of scope:

- custom MCP tools and file replies;
- approval round trips and persistent “always allow” policy;
- agent-initiated Telegram questions;
- same-turn steering;
- provider-neutral compact/rewind;
- user-facing background-terminal management beyond required stop cleanup, and
  experimental dynamic tools.

### Full practical parity

“Full” should mean that users can accomplish equivalent supported outcomes:

- per-chat resume and fault/routing isolation within the declared OS/auth-store
  boundary;
- safe queued and steered input;
- text and file delivery;
- tools through an authenticated, allowlisted MCP bridge;
- approvals and user questions through durable Telegram UI;
- interrupt and cancellation;
- useful status callbacks;
- retry/recovery without silent duplication;
- boot replay and normal-operation auto-resume;
- provider-aware model/effort/config UI;
- compact and fork; rewind only if a spike proves a safe Telegram-to-turn
  mapping, otherwise an explicit capability-disabled response;
- production pinning, telemetry, macOS/Linux operational hardening, and security
  controls. Windows is excluded from all estimates below.

It cannot mean reproduction of every Claude-internal event. Claude cache-cost
fields, Claude result subtypes/stop reasons, TUI queue folds, hook events,
ScheduleWakeup/autonomous workflow callbacks, and the exact Channels protocol
have no guaranteed Codex equivalent.

Approval/question UI state does not make an app-server request durable. Every
answer must be fenced by process generation, thread ID, turn ID, and request ID;
interrupt, timeout, child replacement, or bridge death expires the request and
late answers are ignored. “Always allow” maps only to an explicitly supported
Codex scope and never implies a broader grant.

## Parity map

| Area | Codex SDK / exec | Codex app-server target | Work or caveat |
| --- | --- | --- | --- |
| Per-chat sessions | Yes | Yes | Persist namespace, runtime, and provider thread ID |
| Spawn/resume/stable ID | Yes | Yes | Resume history for a new turn; cross-surface continuity requires an interop spike |
| Process supervision | Per-turn child | Long-lived child | Timeouts, stderr capture, explicit terminal cleanup, external crash containment, exit classification, LRU |
| MCP/tool bridge | CLI can load MCP, SDK has no live callback layer | Yes, standard MCP | New allowlisted bridge; existing Claude Channels wire format is not reusable |
| Text replies | Yes | Yes | Normalize streaming/final delivery with durable deduplication/retry fences |
| File replies | Not without a tool convention | Yes via MCP | Reuse file validation and Telegram dispatcher behind new DTO |
| Approvals | Policy only; no interactive callback | Command/file approval requests | Fence ephemeral requests by process generation, thread, turn, and request ID |
| User questions | No rich callback | Built-in method is experimental | Prefer a stable project `ask_user` MCP tool |
| Interrupt/cancel | Abort turn child | Quiesce, `turn/interrupt` or exact natural-terminal reconciliation, terminal `clean`, fresh-first-page empty poll, external job verification | Turn interruption alone intentionally leaves background terminals; registry emptiness does not prove arbitrary descendants dead |
| Queued follow-ups | Local serialization | Local queue + new turns | Keep ordering in Orchestra |
| Same-turn steer | No | `turn/steer` | If the expected-turn race is lost, enqueue once as a new turn using a local message ID |
| Callbacks/status | Item stream | Rich notifications | Map only useful canonical events; preserve native details |
| Errors/retries | JSONL/exit errors | Typed protocol/turn errors | Retry only before irreversible output/tool effects |
| Session isolation | CLI sandbox and cwd | CLI sandbox and cwd | Per-chat child gives fault/routing isolation; auth is normally per deployment identity |
| Persistence | Codex disk session + Polygram ID | Same | DB is routing truth, but missing/corrupt Codex session files must fail clearly |
| Boot replay | Limited | Limited | Replay only work known not to have started; fence ambiguous partial turns |
| Normal auto-resume | New exec resume | Thread resume/recreate child | Resume history for a later turn, not an in-progress turn |
| Model/effort | Explicit options | `model/list` + turn options | Dynamic validation; account-specific catalog |
| Credentials/env | ChatGPT cache or API key | Same, exact provisioning to verify | Protect auth store; scrub child env and logs |
| Cross-platform | Upstream distributions exist | Protocol is stdio-based | Only macOS was verified here; Linux is a rollout target to validate; Windows is excluded |
| Security boundary | Sandbox/approval policy | Sandbox + approvals + MCP allowlist | Shared OS user/auth is not multi-tenant isolation; default-deny dirs/network/tools |

## Concrete Orchestra changes

### Shared runtime contract

- Replace provider-specific identity at the contract boundary with
  `providerSessionId`, retaining `claudeSessionId` compatibility during
  migration.
- Add canonical runtime IDs and explicit capability descriptors.
- Normalize results, errors, usage, and lifecycle states while retaining a
  size-bounded, redacted provider-native payload for diagnostics.
- Preserve the current synchronous sentinel contract for Claude hot-path
  injection/drain/fire methods; add a separate async Codex turn-steering
  operation and failure event.
- Make new unsupported operations and unknown runtimes fail loudly without
  changing existing Claude sentinel returns.

### Codex SDK adapter (historical rejected option)

- Add a small `CodexSdkProcess` around `@openai/codex-sdk`.
- Lazy-load or inject the optional Codex dependency so Claude-only Orchestra
  consumers neither install nor initialize it; missing wiring fails without a
  Claude fallback.
- Serialize sends, create/resume threads, forward item events, expose final text
  and usage, and pass cancellation through `AbortSignal`.
- Constrain cwd, additional directories, sandbox, approval mode, environment,
  timeout, and output size.

This adapter is the optional fast path and may be retired after app-server
reaches the required scope; maintaining both indefinitely is not the default.

### Codex app-server adapter

- Add a newline-delimited stdio client using Codex app-server’s JSON-RPC-like
  request/response shapes: no `Content-Length` framing and no invented
  `jsonrpc` field. Drive it from the pinned generated schema and implement
  initialize/initialized lifecycle, request correlation, notification dispatch,
  server-request handling, timeout, cancellation, and malformed-output
  protection.
- Add `CodexProcess` thread/turn state, stable IDs, steering, interruption,
  subprocess supervision, bounded queues, and resume.
- Negotiate the experimental API because background-terminal list/clean are
  required, then enforce separate positive allowlists for outbound methods and
  inbound requests/notifications. Implement controlled stop as quiesce →
  interrupt or exact natural-terminal reconciliation → clean → bounded
  fresh-first-page empty polling → external per-session job verification; keep
  terminal metadata ephemeral and redacted.
- Own the compatible protocol schema and accept an injected absolute binary path
  and containment launcher.
- Before enabling this adapter, prove a per-session launcher/OS job boundary
  that owns and reaps daemonized descendants after both normal cleanup and
  app-server disappearance before cleanup.
  Ordinary app-server process-group/session ownership, reconnect-and-clean, and
  the Codex-local `processId` are now known to be insufficient.
- Measure the settled per-chat topology to confirm it is viable; otherwise stop
  for a separately reviewed shared-process redesign.

### Manager and tests

- Teach capacity/LRU/in-flight pinning about Codex lifecycle state.
- On every `getOrSpawn`, compare the requested canonical runtime with the warm
  process. A mismatch must drain/interrupt/kill and cold-spawn the requested
  runtime; dormant compatible session IDs remain in persistence.
- Ensure kill/interrupt/drain semantics do not leak a thread, child, or pending
  RPC.
- Extend the existing cross-backend contract suite using a capability matrix.
- Add fake app-server fixtures, protocol golden traces, crash/timeout/malformed
  event tests, and a real-runtime spike suite outside ordinary CI.

## Concrete Polygram changes

### Configuration and UI

- Separate canonical runtime/provider from delivery mode.
- Preserve existing `sdk`, `cli`, `channels`, and `tmux` behavior exactly.
- Add opt-in Codex runtime selection and provider-specific model/effort choices.
- For app-server, query/cache `model/list`; for the fast SDK path, use a pinned
  configured allowlist unless a separately budgeted catalog helper is added.
  In either case, surface runtime unavailability clearly.
- Treat Claude `agent` configuration and Codex profile/instructions as different
  concepts rather than pretending they map one-to-one.

### Persistence and migration

- Add session-namespace-keyed records carrying the provider thread ID and last
  runtime, and migrate existing
  `claude_session_id` values without resetting Claude chats.
- Record provider turn IDs and delivery state needed for deduplication,
  interruption, and future rewind/fork.
- Treat Polygram DB as routing authority while recognizing that Codex’s session
  files remain required runtime state. Missing/corrupt/moved Codex home must
  fail clearly rather than create an unrelated thread; define retention,
  backup, and cross-host migration policy before rollout.
- Include runtime in config-drift, reset, session feedback, and diagnostics.
- Preserve legacy DB accessors until all callers are migrated.

### Turn lifecycle and delivery

- Normalize Orchestra events/results before Telegram formatting and telemetry.
- Adapt per-session locking, autosteer, pending queues, `/stop`, timeout, retry,
  and auto-resume to capability-aware asynchronous behavior.
- Add exclusive thread/process-generation ownership so replaced children or
  overlapping daemons cannot send concurrently or emit accepted late events.
- Define durable deduplication and retry fences for partial assistant output and
  Telegram/MCP effects. Once an external effect may have occurred, do not retry
  automatically; mark the attempt ambiguous and require reconciliation or an
  explicit user retry.
- Treat auth/model errors, approval denial, and cancellation as non-retryable;
  honor server guidance for rate limits; retry transient process/protocol errors
  only before the durable side-effect fence.
- Reuse current streamer, Telegram delivery, question, approval, attachment, and
  file-security layers.

### Codex MCP bridge for full parity

- Expose a minimal standard MCP tool surface for text/file/reaction/edit and
  `ask_user`.
- Authenticate/bind the bridge per chat, validate tool schemas and file roots,
  cap payloads, reject cross-session calls, and invalidate pending calls on
  timeout, interrupt, bridge death, or process-generation change.
- Preserve the existing Claude Channels bridge unchanged.

### Commands, replay, errors, and observability

- Implement provider-specific compact/fork adapters; disable rewind until the
  Telegram-message-to-Codex-turn mapping is proven.
- Make boot replay and normal auto-resume dispatch only work known not to have
  started; mark partial/ambiguous Codex turns for reconciliation.
- Add Codex error classification without classifying OpenAI errors as Claude
  capacity/auth/TMUX failures.
- Add runtime/thread/turn identifiers, exit reason, protocol version, queue
  depth, approval latency, retry decision, and deduplication outcome to
  structured telemetry. Redact and size-bound provider-native payloads, command
  output, paths, prompts, auth, and secrets before persistence or logging.

## Dependencies, sequence, and critical path

The later product decisions superseded the original SDK/Rust branch described
elsewhere in this estimate. The current gated sequence is:

1. U1a proved the pinned stop sequence, named-profile enforcement, steering,
   same-user isolation, and transport classification.
2. Ivan accepted the native macOS beta contract: one live generation
   daemon-wide plus persisted reboot-cleared quarantine after ambiguous hard
   loss.
3. U1b completed model/effort, retry ownership, effect-window, resource, and
   direct-launch characterization.
4. Continue with the reviewed JavaScript app-server plan at U2; do not build the
   rejected SDK, tmux, or Rust alternatives in parallel.
5. Preserve Claude behavior and gate every later implementation unit as defined
   in the reviewed plan.

The current critical path is:

```text
U1 pass + accepted native beta contract
  -> U1b characterization complete
  -> app-server client and thread lifecycle
  -> partial-turn persistence/recovery integration
  -> durable deduplication and retry fencing
  -> approvals/questions
  -> production soak
```

More engineers can parallelize UI, fixtures, and MCP tools after the contract is
stable. They cannot safely parallelize around an undecided session identity,
process topology, or side-effect/retry contract.

## Engineer-day estimates (estimate)

These are hands-on engineer-days for an engineer familiar with Node, process
supervision, Telegram delivery, and both repositories. They include design
refinement, implementation, automated tests, review fixes, documentation, and
active rollout work. They exclude passive 24-hour soak time, external review
latency, a broad Orchestra consumer migration outside Polygram, and a Codex or
Claude upstream change during development. They assume the current macOS/Linux
deployment target; this investigation verified Codex locally only on macOS, and
Linux validation is included in rollout work. Windows support is excluded and
requires a separate OS-matrix spike and estimate.

Best/likely/worst are scenario bounds, not PERT values. Adding people will not
linearly reduce elapsed time because the critical-path phases are serial. The
tables in this original estimate predate the reviewed implementation plan and
remain historical scenario comparisons. The authoritative current budgets are
**35/66/121** engineer-days for U1-U7, **59/113/207** for U1-U10, and
**67/128/234** for full parity including the separately scoped
compact/fork/rewind follow-up. Confidence is medium-low for the first
milestone, low for parity, and very low / order-of-magnitude for Rust.

### Fast Codex SDK / exec MVP (historical rejected option)

| Phase | Orchestra B/L/W | Polygram B/L/W | Combined B/L/W |
| --- | ---: | ---: | ---: |
| Validate auth/model/resume/cancel and freeze scope | 1/2/3 | 1/1/2 | 2/3/5 |
| Runtime/result/capability seam and Codex SDK adapter | 4/6/10 | 1/2/4 | 5/8/14 |
| Provider-aware config, sessions, text delivery, replay | 0/1/2 | 4/6/10 | 4/7/12 |
| Contract/integration tests, canary controls, docs | 2/3/5 | 1/3/5 | 3/6/10 |
| **Total** | **7/12/20** | **7/12/21** | **14/24/41** |

### Direct Codex app-server text MVP

| Phase | Orchestra B/L/W | Polygram B/L/W | Combined B/L/W |
| --- | ---: | ---: | ---: |
| Runtime/auth/topology/protocol/recovery spikes | 2/4/7 | 1/2/4 | 3/6/11 |
| Provider-neutral runtime seam and compatibility | 3/5/9 | 1/3/5 | 4/8/14 |
| App-server client, CodexProcess, supervision, pinning | 6/10/18 | 0/1/2 | 6/11/20 |
| Config, session migration, text lifecycle, interrupt | 1/2/4 | 6/10/18 | 7/12/22 |
| Recovery, security, integration tests, canary/soak work | 2/4/7 | 3/6/10 | 5/10/17 |
| **Total** | **14/25/45** | **11/22/39** | **25/47/84** |

If the fast SDK MVP ships first, reaching the same app-server text milestone
should add approximately **12/26/47 days**, because session/config/result
normalization and many tests are reusable but the extra adapter and canary are
real work. The decision-comparable combined path is therefore about
**26/50/88 days**: slightly more than going directly to app-server, but with an
earlier usable Codex milestone.

### Full practical parity after the app-server text MVP

| Incremental phase | Orchestra B/L/W | Polygram B/L/W | Combined B/L/W |
| --- | ---: | ---: | ---: |
| MCP text/file/tool delivery, deduplication, retry fencing | 5/9/17 | 3/6/11 | 8/15/28 |
| Approval and user-question round trips | 4/7/13 | 4/7/13 | 8/14/26 |
| Steering, status, retries, crash/auto-resume semantics | 4/8/15 | 3/7/13 | 7/15/28 |
| Compact/fork/rewind mapping, UI, discovery, persistence | 2/5/9 | 6/10/18 | 8/15/27 |
| Security, macOS/Linux operations, scale, end-to-end rollout | 4/8/15 | 4/8/15 | 8/16/30 |
| **Incremental total** | **19/37/69** | **20/38/70** | **39/75/139** |

Direct app-server MVP plus full practical parity:

| Scope | Orchestra B/L/W | Polygram B/L/W | Combined B/L/W |
| --- | ---: | ---: | ---: |
| **Total through full practical parity** | **33/62/114** | **31/60/109** | **64/122/223** |

The likely value, roughly 122 engineer-days, should be treated as a program
rather than a feature. The largest variance comes from process topology,
approval/question behavior, partial-turn recovery, and safe Telegram tool-effect
fencing.

## Rust-port angle (historical alternative; not the current plan)

Ivan chose to stay in JavaScript for this work. The analysis and estimates in
this section are retained only as historical comparison data; they are not a
remaining implementation decision or a path to bypass U1a.

### Upstream feasibility

OpenAI’s Codex repository is predominantly Rust and app-server is implemented in
Rust, but its internal app-server crates are not a supported, versioned public
Rust client SDK. A separate Rust service can safely speak the documented
newline-delimited app-server JSON-RPC-like dialect using generated/pinned
schemas; importing Codex workspace-internal crates would couple Orchestra to
Codex repository internals.

Anthropic’s official Claude Agent SDK supports TypeScript and Python. For other
languages, Anthropic documents invoking the Claude CLI in print/JSON mode. That
does not provide a supported native Rust equivalent of Orchestra’s current
long-lived TypeScript SDK behavior.

Consequences:

- a **hybrid Rust stack** can preserve Claude SDK behavior through a small,
  versioned Node sidecar;
- a **fully native Rust stack** must either give up the Claude SDK backend,
  change its semantics to CLI print mode, or own an undocumented reimplementation
  with ongoing compatibility risk;
- the existing Claude tmux/TUI backend can be ported, but doing so reproduces its
  brittle parser and upgrade burden rather than eliminating them.

### Timing recommendation

| Timing | Verdict | Why |
| --- | --- | --- |
| Port everything before Codex work | Do not recommend | Both provider clients and the product contract change at once; Claude SDK has no supported Rust path; no golden cross-language oracle exists |
| Finish full Node Codex parity, then port | Do not recommend if the Rust decision is real | The app-server client, MCP bridge, lifecycle state machine, and recovery logic are built twice |
| Contract + spikes, optional fast SDK MVP, then Rust decision | Historical estimate path; not current | Retires protocol risks, but was superseded by the JavaScript app-server decision |
| Keep Node indefinitely | Credible alternative | Lowest migration risk; process supervision and SQLite/Telegram behavior already have substantial tests; Rust is justified only by explicit reliability/performance/operational goals |

### Staged Rust architecture

Use a language-neutral sidecar boundary first:

```text
Node Polygram
  <-> versioned local RPC
Rust Orchestra core + Codex app-server client
  <-> small Node Claude Agent SDK sidecar
  <-> existing/ported Claude CLI adapter
```

This is preferable to an N-API binding during migration because process crashes,
runtime upgrades, and language ownership remain isolated. If Polygram is later
ported to Rust, the same Orchestra core can become an in-process crate and the
RPC compatibility suite remains useful.

Orchestra is also a shared package, not only a Polygram detail. The estimate
does not include migrating or validating uninspected consumers such as Water.
A Rust sidecar needs either an npm compatibility client for them or a separate
consumer migration program.

### Rust order-of-magnitude estimate

These numbers are intentionally rougher than the Codex estimates. They assume
feature preservation, migration fixtures, and a hybrid Node sidecar for the
official Claude Agent SDK. The exact endpoint is:

- Rust Orchestra core and Polygram;
- Codex app-server **text MVP**, not full practical Codex parity;
- native Rust preservation of the current Claude CLI supervision/parser;
- Node sidecar preservation of the official Claude Agent SDK behavior.

The endpoint excludes Windows and migration/validation of Water or any other
Orchestra consumer. Full practical Codex parity in the Rust architecture must
be re-estimated after the contract/protocol spikes; the Node incremental
`39/75/139` estimate must not simply be added because substantial work overlaps.

| Rust phase | B/L/W engineer-days |
| --- | ---: |
| Language-neutral contract, trace recorder, golden cross-language suite | 8/15/27 |
| Rust Orchestra core and Codex app-server client | 35/60/105 |
| Node Claude SDK sidecar and compatibility adapter | 8/14/25 |
| Native Rust port of current Claude CLI supervision/parser | 30/50/90 |
| Rust port of Polygram Telegram, persistence, replay, delivery, and tests | 45/75/130 |
| Packaging, migrations, operations, security, soak | 15/25/45 |
| **Defined hybrid endpoint total** | **141/239/422** |

The first technical gate—only the language-neutral contract plus Rust
Orchestra/Codex core—arithmetically accounts for **43/75/132 days** in this
table, but is not a deployable milestone: it excludes local RPC packaging,
Polygram integration, and compatibility adapters for both Claude backends.
Keeping both current Claude implementations as Node sidecars is a credible
lower-cost variant, but its second sidecar/supervision boundary has not been
estimated and cannot be derived by merely subtracting the native Claude CLI row.

There is no defensible fixed estimate for reimplementing the Claude Agent SDK
natively in Rust while promising upstream parity. A planning allowance of an
additional **17/31/55 days over the Node-sidecar path** can fund an initial
protocol implementation, but it does not remove ongoing undocumented-protocol
risk and should not be presented as a supported end state.

## Important unknowns and blockers

1. **Complete command ownership.** The pinned stop sequence is proved for one
   tracked command: `turn/interrupt` settles the turn, background clean is
   accepted, a fresh first page becomes empty, and the observed PID exits
   before its natural deadline. This
   does not prove a daemonized descendant dead because pinned cleanup drains
   its registry before non-confirming termination. If app-server dies before
   clean, resume additionally loses the registry while the command remains
   alive. POSIX process groups/sessions, a common service user, reconnect, and
   the logical `processId` cannot provide the missing macOS boundary. U1a
   cannot pass until per-session external containment, an upstream surface, or
   an explicit weaker stop/crash contract is chosen and proved.
2. **App-server stability commitment.** The command is currently labeled
   experimental. OpenAI can change protocol behavior; exact runtime/schema
   pinning is mandatory.
3. **Per-chat process cost.** RSS, file descriptors, startup latency, and
   concurrent subscription limits have not been measured at production chat
   counts.
4. **Interrupted-turn recovery.** History resume for a new turn is established;
   continuation of an in-progress turn is not. Death during output, command,
   approval, or tool effects needs an empirical state matrix.
5. **External side effects.** Neither JSON-RPC nor Telegram provides end-to-end
   idempotency across a crash. Ambiguous attempts must default to no automatic
   retry, with reconciliation/manual retry.
6. **Approval persistence.** App-server request IDs are ephemeral. Codex scopes
   and “accept for session” semantics may not map to Polygram’s durable choices;
   generation fencing and stale-button expiry are mandatory.
7. **Question surface.** Built-in app-server user input is experimental; the MCP
   `ask_user` alternative must be proven not to deadlock a turn.
8. **Subscription operations.** ChatGPT login works interactively on this host,
   but headless credential provisioning, keyring access under launchd/VPS users,
   token refresh, concurrency/rate limits, and acceptable operational use must
   be verified per deployment identity.
9. **Model availability.** Sol is visible now, but availability and aliases can
   change independently of Polygram releases.
10. **Session-surface interoperability.** SDK-created and app-server-created
    threads may share underlying storage, but bidirectional resume has not been
    proven. Keep separate namespaces until the spike passes.
11. **Rewind semantics.** Codex fork support exists, but Polygram currently lacks
    a durable mapping from Telegram history to Codex turn IDs.
12. **Process descendants.** Interrupt plus verified terminal clean proves
    Codex's tracked terminal exited in the healthy trace. Killing app-server
    first does not prove command/MCP descendants exited; external crash
    containment and deliberately daemonizing descendants must still be measured
    on each target OS.
13. **Cross-platform target.** Only macOS Codex behavior was verified here.
    Linux distribution, process trees, credential store, sandbox, paths, and MCP
    transport remain rollout validation. Windows is outside the estimate.
14. **Rust scope.** A true port must state whether Water/other Orchestra
    consumers, production scripts, history data, and Claude CLI behavior are in
    scope. A fully native Claude SDK implementation is blocked on upstream
    support or an explicit acceptance of fragile internals.

## Small validation spikes

Each spike should end in a checked-in fixture/report, not only an oral result.

| Spike | Days | Question retired / pass criterion |
| --- | ---: | --- |
| Codex SDK subscription matrix | 1–2 | ChatGPT login and API-key modes can start/resume a thread, select Sol, stream, cancel, and refresh credentials under the actual service user |
| SDK/app-server thread interop | 1–2 | Threads created on each surface resume bidirectionally; otherwise retain separate session namespaces |
| App-server protocol harness | 2–3 | Initialize, start/resume, turn, steer, interrupt, terminal list/clean, approval, malformed event, and child restart work against the pinned stable+experimental schema; characterize but do not production-allowlist terminate |
| Process topology benchmark | 1–2 | Measure cold/warm latency, RSS, FDs, and one hosted-active generation; use 10/25 initialized-thread and local-command points only as lab process-cost proxies, then choose the supported live-generation limit |
| Crash/replay/process-tree matrix | 2–4 | Test tracked cleanup, a daemonizing descendant, and transport/app-server death before clean; kill before/during output, command, approval, and external effects; record fences, safe retry rule, per-session external containment, and orphan cleanup |
| MCP `ask_user` round trip | 1–2 | Per-chat MCP child/local RPC survives delayed response and expires correctly on interrupt, restart, bridge death, and timeout without cross-chat routing |
| File/tool security probe | 1–2 | Reject traversal, symlink escape, oversized payload, wrong session secret, unapproved network/tool, and environment leakage |
| Model/catalog drift probe | 0.5–1 | `model/list` availability/default effort is captured and an unavailable configured model fails clearly |
| Rust protocol proof | 3–5 | Minimal Rust client starts/resumes/interrupts a thread using a pinned generated schema without Codex internal crates |
| Claude SDK sidecar proof | 3–5 | Existing contract scenarios pass across Node RPC with bounded cancellation/backpressure overhead |

These are standalone spike bounds with shared-harness overlap; **do not add this
table to the implementation estimates**. Subscription/model work is included in
the fast-MVP validation row; auth/protocol/interop/topology work in the
app-server spike row; crash/replay in its recovery rows; MCP/security in
full-parity rows; and the Rust proofs in the Rust program. The Codex
subscription, interop, protocol, topology, and crash/replay spikes are on the
durable critical path. The Rust proofs precede a full-port commitment.

## Test strategy

### Automated layers

1. **Pure contract tests:** run the same provider-neutral lifecycle scenarios
   against fake Claude SDK, Claude CLI, Codex SDK, and Codex app-server drivers;
   skips must be capability-declared and reviewed.
2. **Protocol fixtures:** replay versioned app-server JSONL/server requests,
   including unknown notifications and additional fields, without a real CLI.
3. **State-machine/property tests:** queue ordering, cancellation races,
   reconnect, duplicate events, partial output, LRU pinning, deduplication, and
   retry fences.
4. **Persistence migration tests:** old `claude_session_id` rows retain context;
   namespaces cannot cross-resume; warm Claude→Codex→Claude switching spawns the
   requested runtime; downgrade/rollback behavior is known.
5. **Security tests:** cwd/additional-dir boundaries, symlinks, MCP authentication,
   tool allowlists, approval scope, environment scrubbing, payload caps, and log
   redaction.
6. **Polygram integration tests:** text, images, files, approvals, questions,
   edits, reactions, `/stop`, compact/fork, replay, and auto-resume through fake
   providers and Telegram.
7. **Real-runtime spike suite:** pinned Claude CLI, Claude SDK, Codex SDK, and
   Codex app-server. Keep it outside fast CI but mandatory for runtime bumps and
   releases.
8. **Negative lifecycle tests:** stale approval/question answers, stale process
   generations, schema mismatch at boot, auth expiry/revocation mid-turn, MCP
   bridge death, concurrent thread ownership, automatic provider failover
   rejection, and orphan descendant cleanup.

Claude’s existing tests are a non-regression gate. A Codex implementation must
not require editing expected Claude behavior merely to make a common test pass.
Add explicit legacy assertions for alias resolution, synchronous sentinel
behavior, and existing CLI/channels session invalidation.

### Rollout

1. Ship schema/config/persistence changes with Codex disabled and confirm no
   Claude session resets or behavioral drift.
2. Enable one development chat using a dedicated deployment/service identity’s
   Codex profile/auth store and strict sandbox; per-chat children do not normally
   have separate auth.
3. Canary on shumorobot only with an explicit runtime allowlist. Fallback to a
   prior Claude session is manual and applies only to subsequent turns; never
   auto-reroute an in-flight/ambiguous Codex prompt to another provider.
4. Soak at least 24 hours through the capabilities enabled for that milestone.
   The historical fast SDK MVP would have shown approvals/tools/questions as visibly disabled;
   their restart/timeout scenarios belong to app-server/full-parity rollout.
5. Expand by chat/account cohort, not by silently changing the default.
6. Keep `claude-sdk` and `claude-cli` rollback paths and their session records
   intact. A rollback changes the active runtime; it must not rewrite provider
   thread IDs.
7. Promote only after error, duplicate-delivery, stuck-turn, process RSS/FD,
   approval latency, and resume-success thresholds are defined and met.

## Credible alternatives

### Alternative A: stay Node and use Codex SDK only

This is the smallest useful change. It satisfies subscription-backed Sol,
per-chat text sessions, resume, and cancellation. It is credible if Telegram is
primarily a serialized chat UI and interactive approvals/tools can remain
unsupported. It is not credible to label it full Claude parity.

### Alternative B: OpenAI Responses API / Agents SDK

Build a provider adapter around the OpenAI API and own session history, MCP,
local command execution, approval, sandbox, retry, and tool semantics. This is
more appropriate when server-side API credentials, auditable API billing, and
no local Codex installation are requirements. It does not consume a ChatGPT
subscription and duplicates much of Codex’s agent harness, so it is not the
recommended route for the stated goal.

### Alternative C: expose Codex through MCP to Claude

Run Codex as an MCP tool invoked by Claude. This can be useful for delegation,
but the controlling session/model remains Claude. Stable Codex per-chat context,
user-visible approvals, direct interruption, usage, and model selection are
obscured. It does not satisfy “choose Codex or Claude for the session.”

### Alternative D: raw Codex TUI in tmux

This mirrors the current Claude CLI backend but adds dependence on a second
undocumented TUI, banner, input, queue, and session-log format. App-server exists
specifically for deep integrations and provides structured lifecycle methods.
Raw TUI automation is therefore not credible unless app-server is removed or
cannot meet a demonstrated requirement.

## Impossible, undocumented, or likely fragile

- An OpenAI/Codex model name cannot be executed through the Anthropic SDK or
  Claude CLI.
- A ChatGPT subscription is not OpenAI API credit; a pure API backend needs API
  credentials and billing.
- The TypeScript Codex SDK is not a standalone remote API client. It depends on
  the local Codex executable and its files/authentication.
- Literal parity for Claude-specific callbacks, cache/cost fields, stop reasons,
  hooks, TUI queues, and Channels behavior is impossible without redefining the
  contract around user outcomes.
- Exact monetary cost is not reliably derivable for subscription-backed turns;
  retain token usage where reported and label cost unavailable rather than
  fabricating it.
- App-server is an experimental command today. Some methods were not individually
  marked experimental in the inspected `0.145.0` schema, but none has a durable
  compatibility guarantee; the whole surface requires a hard pin and gate.
- App-server WebSocket transport is unsupported. Use stdio.
- Dynamic tools, built-in request-user-input, background-terminal management,
  and generated TypeScript bindings are currently experimental. The three
  terminal-control methods are nevertheless required for correct controlled
  stop and must be pinned and positively allowlisted.
- In Codex 0.145.0, a replacement app-server cannot rediscover a terminal
  orphaned by the old server, its logical `processId` is not an OS PID, and
  `osPid` is null. Stock reconnect or POSIX process-group/session signaling
  cannot provide strong macOS crash cleanup.
- The SDK/exec surface cannot support live bidirectional approval/question/steer
  parity.
- Importing internal Rust crates from the Codex monorepo is not a supported Rust
  SDK strategy.
- Reimplementing Claude Agent SDK semantics natively in Rust would depend on an
  undocumented protocol or changed behavior.
- Cross-provider `/rewind`, retries after side effects, and crash-time
  auto-resume are fragile until the validation spikes establish durable IDs and
  retry fences. End-to-end exactly-once Telegram/MCP effects are not available
  without an idempotency contract spanning every external consumer.

## Decisions Ivan needs to make

### Settled before U2

JavaScript, app-server, no Codex tmux/SDK backend, Orchestra `v0.5.0`,
immutable model/effort per provider thread, one native live generation
daemon-wide, and reboot-cleared quarantine after ambiguous hard loss are
settled choices. Stronger per-session containment can be reconsidered after
the native beta but is not a current U2 decision.

### Later product decisions

- whether Water/other Orchestra consumers are included and funded;
- whether macOS/Linux is sufficient or Windows needs a separate program.

## Official sources

- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Pinned 0.145 app-server interrupt and terminal-clean contract](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md#example-interrupt-an-active-turn)
- [Pinned 0.145 logical process-ID allocation](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/src/unified_exec/process_manager.rs)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
- [Anthropic Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Request for a supported Codex Rust SDK](https://github.com/openai/codex/issues/17949)
