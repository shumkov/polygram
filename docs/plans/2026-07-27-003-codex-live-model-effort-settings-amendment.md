---
title: Codex Per-Turn Model and Reasoning-Effort Settings - Amendment
type: feat
date: 2026-07-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
amends: 2026-07-26-001-feat-codex-app-server-steering-plan.md
execution: code
---

# Codex Per-Turn Model and Reasoning-Effort Settings - Amendment

> **v2 (2026-07-27, post-Opus review)** — adopts per-turn overrides as
> the only product mechanism for U7a. The reviewed hybrid added an
> experimental settings RPC for idle observability but created normal-path
> notification races, needless turn gating, and a second mutation-recovery
> protocol. `thread/settings/update` remains a bounded compatibility
> characterization, not an allowlisted production method. Also clarifies
> turn-start notification matching, schema-generation flags, durable enum
> reuse, beta-busy UI, positive projection, and Claude/cwd regression tests.

> **v1 (2026-07-27)** — replaces the original assumption that a Codex
> model/effort pair is immutable for the lifetime of a provider thread. The
> pinned app-server supports future-turn setting updates without replacing the
> thread, and every `turn/start` can carry the selected pair. This amendment is
> retained in this revision note as the reviewed hybrid draft. It is
> superseded by v2's narrower product path. Neither revision authorizes a
> commit, publication, deployment, or production change.

## Decision

Polygram will treat the Codex model and reasoning effort as mutable,
catalog-validated settings of one durable chat/topic session. A normal
`/model` or `/effort` change will not replace the app-server child, rotate the
Orchestra generation, or create a new Codex thread.

For every Codex turn, Orchestra will include the currently selected complete
`{ model, effort }` pair on `turn/start`. This stable request is the primary
and sufficient application mechanism. A warm process receives the desired
pair as a local in-memory settings update serialized with turn admission; it
does not send a separate app-server settings mutation.

The experimental `thread/settings/update` method will be characterized in the
pinned compatibility spike but will not be added to the production RPC
allowlist in U7a. If later product needs require changing a loaded thread's
idle upstream settings before any turn starts, that method needs a separate
scope and gate.

If a turn is active, it continues under the pair with which it started.
Steering remains part of that active turn and therefore uses that same pair.
The new selection applies to the next turn. This is the same user-facing
boundary OpenClaw exposes: a selection made during active work does not
retarget inference already in progress.

Process replacement remains required for runtime and security identity
changes such as Claude ↔ Codex, binary/schema, authentication deployment,
`CODEX_HOME`, workspace, permission profile, sandbox/approval policy, MCP
capabilities, owned config layers, or allowlisted environment.

## Review Record

The existing Opus 5 xhigh plan-review session reviewed v1 against the pinned
schema and current local U2-U7 implementation. Verdict:
**agree with must-fixes; prefer per-turn-only**.

| Finding | Resolution in v2 |
| --- | --- |
| A `turn/start` override may emit `thread/settings/updated`; matching only an in-flight settings RPC would fault a normal turn. | Accept attach/observed/admitting/active turn pairs and add an ordering trace to G-MODEL-1. |
| Gating turns on an experimental idle-settings RPC contradicts the sufficient per-turn fallback and can turn cosmetic sync failure into chat outage. | Remove the RPC from the product path and make per-turn override primary. |
| The experimental schema evidence was not reproducible without its generation flag. | Pin the exact `--experimental` command and assert all three experimental methods in the generated compatibility fixture. |
| “No migration” is safe only while existing delivery/recovery CHECK values are reused. | State the exact enum reuse contract for any later settings-RPC plan and require a migration for new states. |
| Mixed return/throw API and no-live/beta-busy conflation weaken callers. | Use a discriminated result and separate `not-loaded` from `daemon-busy`. |
| Claude copy, cwd identity, and positive `turn/start` projection need explicit regression guards. | Add dedicated tests for all three. |
| Hybrid wording treated per-turn override as both fallback and primary. | Make it unambiguously primary and record the hybrid as rejected. |

## Pre-flight Reality Checks

### Verified facts

| Fact | Evidence | Consequence |
| --- | --- | --- |
| Pinned `codex-cli 0.145.0` includes the experimental `thread/settings/update` request when schemas are generated with the experimental flag. Its `model` and `effort` fields override subsequent turns. | `codex app-server generate-json-schema --experimental --out <dir>` produces `ThreadSettingsUpdateParams.json`; reviewed [app-server README at `95637f7`](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/app-server/README.md). | The endpoint is credible for a later idle-settings feature, but U7a does not need to expose it. |
| An accepted update returns `{}`. `thread/settings/updated` carries the full effective settings only when they actually change. | Pinned generated request/notification schemas; reviewed upstream [thread settings tests at `95637f7`](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs). | Success needs explicit response/notification correlation; a no-op update may have no new notification. |
| `turn/start.model` and `turn/start.effort` override the current turn and subsequent turns. | Pinned `TurnStartParams.json`; reviewed [protocol source at `95637f7`](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/app-server-protocol/src/protocol/v2/turn.rs). | Sending the selected pair on every turn prevents a stale resumed default from choosing the wrong model. |
| `thread/settings/update` is experimental, while `turn/start` model/effort overrides are in the already used stable turn contract. | Pinned generated schema and official app-server documentation. | U7a uses per-turn overrides only and leaves the experimental request unwired. |
| OpenClaw persists a per-session model override immediately. During active work it can restart only before any user-visible text/tool evidence; otherwise the current attempt finishes and the new model applies later. It does not retarget an inference already in progress. | Reviewed OpenClaw `9b17119`: [model override persistence](https://github.com/openclaw/openclaw/blob/9b171190f24ed46fc2a54ae6d1a42af419aa790e/src/sessions/model-overrides.ts), [live switch resolver](https://github.com/openclaw/openclaw/blob/9b171190f24ed46fc2a54ae6d1a42af419aa790e/src/agents/live-model-switch.ts), [restart safety gate](https://github.com/openclaw/openclaw/blob/9b171190f24ed46fc2a54ae6d1a42af419aa790e/src/agents/embedded-agent-runner/run/attempt-normalization.ts), and [recovery boundary](https://github.com/openclaw/openclaw/blob/9b171190f24ed46fc2a54ae6d1a42af419aa790e/src/agents/embedded-agent-runner/run/attempt-recovery.ts). | Polygram should promise “next turn,” not “the active turn changes model.” It need not copy OpenClaw's attempt-restart optimization. |
| The local implementation currently sends model/effort only on the first fresh turn, resumes without overrides, rejects `setModel`/`applyFlagSettings`, and validates model/effort as part of immutable trusted policy. | Current local `@shumkov/orchestra` package and Polygram handlers/tests. | The existing controlled-replacement behavior is an implementation gap, not an app-server limitation. |

### Estimates and design judgments

- Per-turn override is preferred because it makes the selected pair
  transactional with the next turn and adds no experimental product method.
- It is not necessary to copy OpenClaw's “restart a clean active attempt”
  optimization. Polygram's deterministic boundary is easier to explain:
  current turn unchanged, next turn updated.
- Effective model/effort is operational state, not a security boundary.
  Unexpected permission, workspace, approval, auth, environment, or profile
  drift still fails closed.
- Immediate idle upstream synchronization is not a first-milestone product
  need. It does not justify response/notification correlation or a second
  mutation-recovery path.

## Goals

- Preserve one Codex thread ID and its history across model/effort changes.
- Preserve one healthy app-server generation across ordinary setting changes.
- Make the selected model/effort durable per chat/topic and validate the pair
  against the authenticated pinned runtime catalog.
- Apply a model switch and any required effort remap atomically to the next
  admitted turn.
- Make the active-turn versus next-turn timing visible and truthful.
- Prevent a queued or concurrent turn from starting with a stale pair.
- Preserve every existing Claude SDK/CLI model and effort behavior.

## Non-goals

- Retargeting an already running Codex inference.
- Interrupting or replaying an active turn merely to change its model.
- Copying OpenClaw's clean-attempt restart optimization.
- Exposing `thread/settings/update` or any of its arbitrary fields such as cwd,
  permissions, sandbox policy, collaboration mode, personality, service tier,
  or approval policy in the U7a product path.
- Adding `/model default`, `/effort default`, aliases, favorites, or a general
  provider-neutral settings framework in this correction.
- Changing the one-live-native-Codex-generation beta limit.
- Changing model availability, entitlement, or subscription semantics.

## Invariants

1. The selected pair is always one authenticated catalog model plus an effort
   supported by that exact model.
2. A model change that invalidates the current effort chooses the catalog's
   authenticated default effort and displays that adjustment before success.
3. Model and effort are sent together on `turn/start`; no intermediate
   unsupported pair is observable.
4. A settings change never changes the model of the active turn.
5. A later turn never starts until its selected pair is captured and included
   in that `turn/start`.
6. Model/effort changes do not change `threadId`, `generationId`, cwd,
   permission profile, approval policy, auth deployment, or MCP capability.
7. `thread/settings/update` remains outside the production allowlist in U7a.
   The existing `turn/start` projection admits only owned `threadId`, input,
   correlation ID, model, and effort; all other upstream optional fields
   remain rejected.
8. Claude continues to use its existing `setModel` and
   `applyFlagSettings` behavior and messages.
9. A protocol ambiguity is never described to the user as “applied.”
10. Stored model/effort metadata cannot invalidate or delete an otherwise
    compatible Codex provider thread.

## Architecture

### Split static policy from dynamic settings

`CodexProcess` currently treats all observed thread settings as one immutable
trusted policy. Split that concept:

```text
StaticSecurityPolicy (immutable for one process generation)
  binary/schema + CODEX_HOME + auth deployment
  cwd/workspace + owned config/layers
  permission profile + sandbox + approval/reviewer
  command/web network + MCP + allowlisted environment

DynamicThreadSettings (mutable for one provider thread)
  model
  effort
```

Every `thread/settings/updated` notification is still fully projected and
validated. Static fields must exactly match `StaticSecurityPolicy`. Dynamic
fields are observational and must match one of:

- the pair captured from the attached thread result;
- the last observed thread pair;
- the pair captured for a `turn/start` being admitted; or
- the active turn's admitted pair.

This accepted-target set handles the normal
`turn/start` → `thread/settings/updated` path even when the notification
precedes the `turn/start` response. Any other pair is a protocol fault. A
static mismatch enters the existing security/containment path.

Model provider remains `openai` and is validated as static protocol identity.
The desired model/effort pair is validated against the current authenticated
catalog. A previously stored observed pair may disappear from the current
catalog without becoming a security incident; no new turn may select it.

### Desired, observed, and active-turn state

Each live Codex process tracks three distinct values:

```text
desiredSettings
  Latest durable Polygram selection for the chat/topic.

observedThreadSettings
  Last full app-server thread pair observed from attach or notification.
  It does not choose or gate the next model and may lag desiredSettings until
  the next turn starts, but unexplained values remain a protocol-integrity
  signal.

activeTurnSettings
  Pair captured when the current turn/start was admitted.
  Null while no turn is active.
```

The distinction is visible in status/config output:

- idle: `Selected for next turn: B/high`;
- active after a change: `Current turn: A/high · next turn: B/xhigh`;
- no warm process and daemon available:
  `Selected for this chat's next session: B/xhigh`;
- no warm process while another chat owns the beta's sole Codex generation:
  `Selected: B/xhigh · this chat is not loaded; its next message may be busy`;
- static-policy failure: existing unavailable/containment wording, not a
  model-setting message.

Only `desiredSettings` is durable. It already lives in Polygram's
chat/topic configuration and config-change audit. Observed and active-turn
state are reconstructed when the app-server starts/resumes; no migration is
needed solely for this amendment.

### Orchestra API

Keep the Claude-facing methods and their boolean contracts unchanged. Add one
Codex-capable atomic local operation rather than applying a model and an
adjusted effort through two independent calls:

```js
await pm.selectModelSettings(sessionKey, {
  model,
  effort,
});

// Live Codex process:
{
  outcome: "updated-live",
  threadId,
  generationId,
  currentTurn: null | { model, effort },
  nextTurn: { model, effort },
}

// This chat has no loaded process and the daemon lease is available:
{
  outcome: "not-loaded",
  nextTurn: { model, effort },
}

// Another chat owns the beta's one live Codex generation:
{
  outcome: "daemon-busy",
  nextTurn: { model, effort },
}

// The selected session cannot accept local setting changes:
{
  outcome: "unavailable",
  reason: "wrong-runtime" | "quiescing" | "containment" | "stale-generation",
  nextTurn: { model, effort },
}
```

Use a discriminated return for expected runtime/lifecycle states, matching the
existing `steerTurn` convention. Reserve throws for malformed inputs,
programming errors, and unexpected internal failures.

`ProcessManager.selectModelSettings` participates in the same per-session
start/replacement gate. It never spawns and never sends app-server traffic.
For a live Codex process it atomically replaces `desiredSettings` under the
turn-admission/settings gate. `CodexProcess` validates the pair again against
the preflight catalog snapshot before accepting it.

The legacy `setModel` and `applyFlagSettings` methods remain untouched for
Claude. Polygram must not implement the Codex model-remap case as two calls to
those methods.

### App-server protocol contract

Keep `thread/settings/update` outside Orchestra's curated production
client-method allowlist.

Generate the pinned compatibility bundle with the exact command:

```sh
codex app-server generate-json-schema --experimental --out <dir>
```

A fixture assertion requires that generated bundle to contain
`thread/settings/update`, `thread/backgroundTerminals/list`, and
`thread/backgroundTerminals/clean`. The curated production allowlist still
contains only the two terminal-control methods from that experimental set.

Remove `firstTurnSettingsSent`. Every `turn/start` includes the pair captured
from `desiredSettings` when that turn is admitted. Keep the projection
positive:

```text
required: threadId, input
optional: clientUserMessageId, model, effort
denied: cwd, approvalPolicy, approvalsReviewer, sandboxPolicy,
        personality, serviceTier, and every unknown field
```

`thread/settings/updated` is already delivered because thread attach and
`turn/start` overrides can emit it. Extend the handler to validate the
complete static security policy and match the dynamic pair against the
attach/observed/admitting/active accepted-target set above. G-MODEL-1 records
whether `turn/start` emits the notification and its ordering relative to the
response and `turn/started`.

No new state-changing settings request exists in the product path, so there
is no settings mutation attempt or recovery ledger. If a later plan wires
`thread/settings/update`, its attempts must reuse the existing
`prepared → write-attempted → response-observed` delivery values, settle into
existing `settled`/`cancelled`/`ambiguous` recovery values with
`terminal_status = NULL`, or add an explicit SQLite table-rebuild migration
before introducing any new CHECK-enumerated state.

### Serialization and race rules

One process-local gate orders:

- thread attach;
- local `selectModelSettings`;
- construction and write admission of every `turn/start`; and
- quiesce/retirement.

It does not delay `turn/steer`, because steering belongs to the already
admitted active turn and cannot change its model.

Polygram continues to serialize config commands under the per-session intent
lock. Within that lock it:

1. resolves the exact chat/topic write scope;
2. refreshes/validates the catalog pair, with authenticated catalog reuse
   bounded to 15 minutes;
3. writes model plus any effort remap to config atomically;
4. records both audit rows;
5. calls `selectModelSettings`; and
6. reports the returned timing honestly.

No queued turn can cross between steps 3 and 5 because its `turn/start`
admission waits on the process settings gate. Concurrent `/model` and
`/effort` commands serialize; the later durable selection wins. A turn already
admitted before the local update is the active turn and retains its captured
pair. Notifications are fenced by process object identity, `generationId`,
`threadId`, and admitted-turn identity.

Every warm `getOrSpawn` also reconciles the complete durable pair through the
same process settings gate before returning the generation. This is the
dispatch-time fail-closed backstop if the best-effort live update after
persistence threw: no later turn may start from the old in-memory pair merely
because the process identity still matches. Status projects the warm
generation's actual `nextTurn` separately from the durable desired pair and
shows any mismatch until this reconciliation succeeds.

### Lifecycle flows

#### No live process

Persist and audit the selected pair. Do not spawn a process merely to apply a
setting. If another chat owns the beta's only generation, say that this chat
is not loaded and its next message may still be busy.

#### Fresh thread

Use the selected model in `thread/start`, attest static policy, observe the
initial thread settings, then include both selected model and effort on the
first `turn/start`.

#### Resumed thread

Resume by durable `threadId` with no arbitrary config override. Attest static
policy, observe the resumed settings without requiring them to equal the
current selection, and include the selected pair on the first `turn/start`.
Resume never drops history because a prior stored model differs.

#### Warm idle thread

Update local `desiredSettings` and acknowledge
`selected for next turn: B/xhigh`. Preserve thread and generation.

#### Warm active thread

Retain `activeTurnSettings`, update local `desiredSettings`, and acknowledge:
`current turn unchanged; next turn B/xhigh`. The active turn and any accepted
`turn/steer` remain on `activeTurnSettings`. Queue draining captures the new
pair before constructing the next `turn/start`.

#### Daemon restart after a saved but unapplied selection

The durable desired pair wins. Resume the thread, re-attest static policy, and
include the pair on the first admitted `turn/start`. There is no settings RPC
to replay or reconcile.

## Failure Semantics

| Failure | Durable selection | Warm process | Next turn |
| --- | --- | --- | --- |
| Catalog validation fails | Unchanged | Unchanged | Unchanged |
| Config persistence fails | Unchanged; command fails | No local process change | Unchanged |
| No live process, daemon available | New pair retained | None | Next start uses new pair |
| No live process, daemon busy | New pair retained | Another chat remains owner | Next message may receive the existing beta busy result |
| Live local update succeeds | New pair retained | Desired pair changes; active pair does not | Next admitted turn uses new pair |
| Live process is quiescing/failed/stale | New pair retained; report selected but not loaded into that process | Existing lifecycle handling applies | That process accepts no later turn; a future safe spawn reads durable selection |
| Unexpected dynamic settings notification | New pair retained; report protocol failure | Existing protocol-fault path applies | No unsafe continuation |
| Static settings mismatch | New pair retained | Existing security/containment path applies | No turn until lifecycle permits |
| Model disappears after selection | Retain and show unavailable until user selects a valid pair | Do not silently downgrade | The next admission after the 15-minute catalog bound (or an earlier explicit refresh) blocks and refreshes the catalog |

A desired pair is user configuration, not an external mutation whose delivery
must be reconciled. The local operation determines only which pair a warm
process captures on its next `turn/start`; the turn request itself retains the
existing durable request/replay contract.

## Security Boundaries

- The `turn/start` outbound projection owns the thread ID. Callers cannot
  choose another thread.
- In addition to existing input/correlation fields, only `model` and `effort`
  are accepted for this change. `cwd`, permissions, `sandboxPolicy`,
  approvals, reviewer, collaboration mode, personality, service tier,
  summary, and every unknown field are denied locally.
- `thread/settings/update` remains denied by the product method allowlist.
- Model/effort changes never change the static spawn-profile fingerprint or
  bypass its re-attestation.
- `thread/settings/updated` continues to carry a full static-policy
  attestation. A model change cannot normalize away a permission/profile
  mismatch.
- Catalog entries are scoped to the exact authenticated runtime identity and
  invalidated on auth, schema, binary, or config drift.
- Logs and audit rows contain only model/effort slugs, result class, and
  generation/thread identifiers under existing redaction policy—never
  credentials or raw protocol payloads.

## Implementation Delta

### Orchestra

- Record the exact `--experimental` schema-generation command and assert that
  the generated compatibility bundle contains all three characterized
  experimental methods. Keep `thread/settings/update` out of the production
  allowlist.
- Split `expectedThreadPolicy` into immutable static security policy and
  mutable desired/observed/active-turn model settings.
- Replace `firstTurnSettingsSent` with desired/observed/active-turn state.
- Add the process-local settings/turn-admission gate.
- Implement local `CodexProcess.selectModelSettings` and
  `ProcessManager.selectModelSettings` with a discriminated result.
- Include selected model/effort on every `turn/start`.
- Extend notification matching to accept the admitting/active turn pair and
  preserve full static-policy validation.
- Positively project the changed `turn/start` shape and reject every unrelated
  optional setting.
- Preserve current Claude interfaces and tests unchanged.

### Polygram

- Remove Codex model/effort from `CODEX_SPAWN_IDENTITY_FIELDS`; retain them as
  informational session metadata.
- Replace “controlled replacement on your next message” with the returned
  current-turn/next-turn status.
- Have slash commands and config callbacks call one atomic Codex settings
  method with model plus effort.
- Make config persistence failure fail visibly rather than claiming a durable
  selection.
- Show selected/observed/active-turn state in `/config` and status without
  implying that an idle upstream mutation occurred.
- Distinguish not-loaded from daemon-busy under the one-generation beta.
- Keep topic-over-chat-over-bot resolution and authenticated catalog
  validation unchanged.
- Bound authenticated catalog reuse to 15 minutes. If a refreshed capability
  set changes, retire the idle warm generation through the controlled path
  before spawning from the new branded receipt.
- Reconcile the durable pair again on every warm turn admission and expose a
  durable-versus-live mismatch in `/config`.
- Do not alter Claude model/effort paths.

## Tests

### Deterministic Orchestra tests

- Generated experimental schema contains settings update plus both terminal
  methods, while the production client allowlist excludes settings update.
- `turn/start` projects exactly thread/input/correlation/model/effort and
  rejects cwd, approvals, reviewer, sandbox, personality, service tier, and
  every unknown field.
- A settings notification matching attach, observed, admitting, or active
  turn state is accepted in each ordering; wrong thread/generation/static
  policy or an unknown dynamic pair fails closed.
- Warm idle and active local updates preserve `threadId`, `generationId`, child
  identity, and conversation state.
- Active turn retains its captured pair; steering does not adopt a future
  pair; the next queued turn does.
- Two settings changes and a racing turn start serialize and the final durable
  pair wins.
- Every `turn/start` includes the current selected pair.
- Warm `getOrSpawn` applies its exact requested pair before returning and
  fails closed when the generation does not accept it.
- Updated-live, not-loaded, daemon-busy, quiescing, containment, and
  stale-generation produce distinct discriminated outcomes.
- Static security drift still enters containment; a valid dynamic change does
  not.
- A future settings-RPC implementation cannot add a new delivery/recovery
  CHECK-enum state without an explicit migration.
- Existing Claude contract assertions remain byte-for-byte equivalent where
  fixtures permit.

### Deterministic Polygram tests

- `/model` validates the selected model and atomically remaps effort when
  required.
- `/effort` validates against the selected model.
- Chat/topic config and audit changes persist before the local warm-process
  selection update.
- No live process reports “selected for this chat's next session.”
- Daemon-busy reports that this chat is not loaded and its next message may
  still be rejected by the beta limit.
- Idle warm process reports selected for next turn without replacement.
- Active process reports old current-turn and new next-turn pairs.
- A quiescing/failed process retains the durable selection without claiming
  that process accepted it; that process cannot admit later work.
- Concurrent command/button updates serialize and do not cross topic/session
  boundaries.
- Model/effort changes do not delete a stored Codex thread or mutate Claude
  namespace/config.
- Codex spawn identity remains exactly cwd; removing model/effort cannot
  accidentally remove cwd.
- `/config` distinguishes selected, observed, active-turn, not-loaded, and
  unavailable states.
- Expired catalog drift exercises the production spawn-context path: the old
  generation retires once, the branded replacement resumes the persisted
  thread, and only that replacement admits the next turn.
- Explicit Claude-path snapshots prove its SDK/CLI model/effort timing copy is
  unchanged.

### Real pinned-runtime gate

Before merging the correction:

1. start a thread under model/effort A;
2. characterize experimental update to B while idle, including response and
   full effective-settings behavior, without adding it to the product
   allowlist;
3. characterize a no-op experimental update and notification behavior;
4. characterize an experimental update during a long active turn and prove
   that turn is not restarted;
5. separately use the product path to select C locally, start the next turn,
   and verify the pair is carried/applied by `turn/start`;
6. record whether that `turn/start` emits `thread/settings/updated`, its full
   payload, and ordering relative to the response and `turn/started`;
7. restart app-server, resume the same `threadId`, and complete
   another turn;
8. race local selection against turn admission/queue drain; and
9. verify the production client rejects `thread/settings/update`.

The spike records content-free IDs/settings only and runs against the exact
pinned binary, schema, service identity, `CODEX_HOME`, permission profile, and
launcher.

## Compatibility Gate

**G-MODEL-1: turn override and experimental-settings characterization**

PASS requires the pinned real runtime to:

- use the selected pair supplied on `turn/start`;
- preserve the thread across idle, active, and resumed selections;
- leave the active turn uninterrupted;
- document settings-notification payload/order caused by turn overrides; and
- characterize the experimental update endpoint without exposing it.

Failure of `turn/start` overrides stops U7a and requires a plan revision.
Failure or drift of `thread/settings/update` is recorded but does not block
the per-turn product path and never causes process/thread replacement.

## Alternatives Considered

### Per-turn overrides only

Chosen. It avoids one experimental product method and makes the selected pair
transactional with the next turn.

### Hybrid settings update plus per-turn override

Rejected for U7a after Opus review. Its only added benefit is upstream
idle-settings observability. It requires response/notification correlation,
no-op semantics, a settings mutation ledger, and special ambiguity handling;
it can also fault on the normal notification emitted by a turn override unless
the admitted-turn pair is modeled. The endpoint remains characterized for a
future product need.

### Replace the process but resume the same thread

Rejected for normal changes. It adds stop/containment cost and resource churn
without changing the active turn. It is only a lifecycle recovery tool after
a genuine process fault.

### Create a new Codex thread

Rejected. It discards conversational continuity for a setting the protocol
explicitly supports changing.

### Restart a clean active attempt like OpenClaw

Rejected for the first implementation. It requires proving no text, tool,
delivery, or side effect escaped and replaying the attempt safely. The benefit
is small compared with the duplicate-effect and UX complexity; the next-turn
boundary is deterministic.

## Estimate and Sequencing Delta

Add U7a after the locally implemented U2-U7 core and before U8 canary:

| Work | Orchestra B/L/W | Polygram B/L/W | Combined B/L/W |
| --- | ---: | ---: | ---: |
| Pinned compatibility spike and fixture assertion | 0.5/1/1.5 | 0/0/0 | 0.5/1/1.5 |
| Process settings state, projection, notification matching, tests | 0.5/1/1.5 | 0/0/0 | 0.5/1/1.5 |
| Config/UI/session-drift wiring and tests | 0/0/0 | 1/1/2 | 1/1/2 |
| **U7a total** | **1/2/3** | **1/1/2** | **2/3/5** |

The critical path becomes U7 → U7a → U8. The worst case assumes an
unexpected turn-override notification ordering or local turn-admission race.
It does not include wiring the experimental settings method, a CLI bump,
package publication, deployment, or soak time.

## Definition of Done

- The same `threadId`, process child, and `generationId` survive a normal
  model/effort change.
- Current-turn and next-turn settings are separately observable and correctly
  messaged.
- Every new turn carries the selected catalog-valid pair.
- Fresh/resumed threads use the selected pair on their first new turn without
  requiring the prior stored pair to match.
- Model/effort no longer participate in Codex session invalidation or static
  security identity.
- `thread/settings/update` remains outside the production allowlist; the
  changed `turn/start` projection cannot alter unrelated settings.
- A local selection never produces a false upstream “applied”
  acknowledgement or a stale-model next turn.
- A failed post-persistence live update remains visible and is reconciled
  before any later warm turn starts.
- The real pinned-runtime gate and all Orchestra/Polygram tests pass.
- Claude SDK/CLI behavior remains unchanged.
