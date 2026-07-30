# Codex Scope Enablement

Status: implemented, multi-agent reviewed, and tests green
Date: 2026-07-30

## Problem

Polygram currently renders a Codex runtime button in every chat where config
commands are enabled. Selecting it immediately runs an exact Codex preflight,
which requires a saved `codexModel`, `codexEffort`, and `cwd`. A chat without
those fields sees a misleading login/runtime error even when the Codex
deployment is healthy.

Codex is still a beta runtime with narrower product-tool and containment
behavior than Claude. It must be explicitly enabled for selected bot/chat
scopes. A hidden button alone is not an authorization boundary: old Telegram
keyboards and forged callback data can still reach the callback handler.

## Verified current behavior

- Boolean feature flags use one shared precedence rule in
  `lib/config-override.js`: topic, chat, active bot, defaults; the first
  explicit boolean wins. Malformed values are ignored and resolution
  continues downward; the result is true only when the first explicit boolean
  found is `true`.
- Runtime selection uses topic, chat, then bot `pm` in
  `lib/runtime-config.js`.
- `lib/handlers/config-ui.js` currently offers Codex on every full `/config`
  card.
- `lib/handlers/config-callback.js` accepts every known runtime before running
  preflight. It has no scope-authorization check.
- Codex model and effort values are resolved independently from topic, chat,
  bot, and defaults. Codex cwd resolves from topic, chat, and defaults.
- The authenticated Codex catalog is the source of truth for model/effort
  compatibility.
- Production Shumabit has a healthy Codex deployment. `Ivan DM` already has
  chat-scoped Codex model/effort. `Shumabit@UMI` has `isolateTopics: true` and
  currently lacks chat-scoped Codex model/effort.

## Product requirements

R1. Add an opt-in boolean `codexEnabled` flag with the established
topic → chat → bot → defaults precedence. A malformed tier is ignored; Codex
is disabled when the resolved value is not true.

R2. When disabled, Codex is absent from the runtime row of `/config`.

R3. When disabled, `/model` and `/effort` expose only the selected Claude
runtime's options. No separate flag parameter is added to those
provider-relative cards.

R4. A stale or forged `cfg:runtime:codex` callback is rejected before
preflight, persistence, audit writes, or process replacement.

R5. Runtime construction and dispatch must independently refuse `pm: "codex"`
when the effective flag is disabled. The observational descriptor may still
report the saved selection so `/config` can offer an escape to Claude, but no
Codex preflight, process, reservation, recovery, or send may cross the
authorization boundary.

R6. Claude SDK/CLI selection, sessions, callbacks, and model/effort behavior
remain unchanged.

R7. Enabling Codex does not select Codex. It only makes Codex selectable.
The existing `pm` selection continues to decide the active runtime.

R8. An enabled scope must have a complete Codex candidate:
`codexModel`, `codexEffort`, and `cwd`. Incomplete configuration fails before
changing `pm`, with the accurate message:

`Codex is enabled, but its model, effort, or workspace is not configured for this chat`

R9. The interactively selectable Codex model set is the intersection of the
authenticated catalog and Polygram's compact UI list:
`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Unknown or disallowed
interactive selections are hidden and rejected by both callback and slash
command paths.

This list is presentation and interactive-selection policy, not a runtime
security boundary. An operator-persisted model outside the compact list
remains valid when the authenticated catalog supports it. That preserves
direct configuration and avoids conflating account capability with the
limited Telegram row.

R10. Initial production rollout enables Codex only for:

- Shumabit `Ivan DM` (`68861949`);
- the whole Shumabit@UMI chat (`-1003369922517`), including its isolated
  topics.

No bot-wide or top-level Codex enablement is added.

## Chosen design

### 1. One canonical authorization resolver

Add `resolveCodexEnabled(config, chatId, threadId)` as a small named wrapper
over `resolveBoolOverride(config, "codexEnabled", ...)` in
`lib/runtime-config.js`, which already owns Codex runtime policy.

Add one `requireCodexEnabled(...)` helper that throws
`CODEX_SCOPE_DISABLED`. All enforcement boundaries call it. No caller
reimplements precedence.

### 2. UI filtering plus callback enforcement

The full `/config` card receives the effective flag and filters the Codex
runtime button when false. `/model` and `/effort` remain provider-relative,
so a valid disabled scope naturally shows only Claude choices without new
feature-flag wiring.

The callback handler recomputes the effective flag from the callback's chat
and thread. A disabled Codex callback returns:

`Codex is not enabled for this chat`

It performs no preflight, save, audit, or process operation.

### 3. Runtime enforcement

`resolveRuntimeDescriptor` remains observational and includes the effective
Codex flag with the saved runtime selection. That is required to render an
invalid saved `pm: "codex"` state and permit only a switch back to Claude.

Authorization is enforced at the roots that can cross a provider boundary:

- `resolveCodexRuntimeCandidate` before prospective preflight;
- `resolveRuntimeConfig` before constructing a selected Codex runtime;
- `resolvePromptBackend` before normal dispatch/recovery routing;
- the final Codex reservation/autosteer/send commitment, using a fresh check
  before any reservation or process interaction.

`resolveCodexRuntimeRequest` delegates to the candidate resolver and does not
duplicate the check.

This is fail-closed. A configuration containing `pm: "codex"` beneath an
effective false flag is invalid and must not launch or send to Codex. The full
config card renders only the Claude runtime action; selecting it repairs the
saved state without attempting Codex preflight.

Normal messages in that invalid state receive:

`Codex is not enabled for this chat`

Boot replay, normal-operation auto-resume, edit redelivery, and any
retry-authorized reconciliation recheck authorization. A disabled Codex
recovery is deferred per row with telemetry; it is never failed over to
Claude and cannot abort unrelated replay rows.

### 4. Compact interactive model list

Define the three product-visible Codex models beside the config UI policy.
Filter the authenticated catalog through it before rendering or accepting
interactive model changes. Authentication and supported-effort checks remain
authoritative. Runtime construction continues to accept an operator-saved
authenticated model outside this compact list.

The compact list is not a substitute for `codexEnabled`: one controls which
scopes may use Codex; the other controls which authenticated Codex models fit
the Telegram selection surface.

### 5. Existing actor policy

This feature does not broaden or narrow who may use config controls within an
already configured chat. Shumabit@UMI intentionally keeps the existing
`allowConfigCommands` actor boundary: any member who can use its current
runtime/model/effort controls can also select Codex once the chat is enabled.
Changing group operator authorization is separate work.

### 6. Production configuration

Set these chat-scoped values only:

```json
{
  "chats": {
    "68861949": {
      "codexEnabled": true,
      "codexModel": "gpt-5.6-sol",
      "codexEffort": "xhigh"
    },
    "-1003369922517": {
      "codexEnabled": true,
      "codexModel": "gpt-5.6-sol",
      "codexEffort": "xhigh"
    }
  }
}
```

Existing unrelated fields remain intact. The Shumabit@UMI values live at chat
scope so every isolated topic inherits a complete candidate while keeping its
own `pm` selection. No `defaults.codexModel`, `defaults.codexEffort`, or
bot-wide `codexEnabled` is introduced.

## Data flow

### Rendering

1. `/config`, `/model`, or `/effort` identifies chat and thread.
2. Polygram resolves `codexEnabled`.
3. It resolves the selected runtime view.
4. `/config` includes Codex only when enabled.
5. Model/effort buttons are derived from the selected provider and its
   compact interactive list.

### Selecting Codex

1. Callback shape and configured chat are validated.
2. The session intent lock is acquired.
3. `codexEnabled` is recomputed for the callback's exact chat/thread.
4. Disabled scopes stop here.
5. Enabled scopes resolve a complete candidate.
6. Exact Codex preflight runs.
7. Only after successful preflight does Polygram persist/audit `pm: "codex"`
   and replace the idle runtime.

### Sending a turn

1. Runtime resolution recomputes `codexEnabled`.
2. A disabled Codex selection fails with `CODEX_SCOPE_DISABLED`.
3. Immediately before Codex reservation/autosteer/send commitment, the
   effective flag is checked again.
4. Otherwise existing preflight, process, persistence, and recovery behavior
   is unchanged.

## Failure modes

- Missing flag: Codex is hidden and cannot be selected.
- Non-boolean flag: ignored at that tier; lower explicit booleans retain their
  existing precedence.
- Stale Codex keyboard: rejected without side effects.
- Enabled but incomplete candidate: explicit configuration error; `pm` and
  process stay unchanged.
- Interactive model outside the compact list: hidden and rejected by callback
  and slash-command selection.
- Enabled model absent from authenticated catalog: existing preflight mismatch
  error; no runtime switch.
- Flag revoked while `pm` remains Codex: no new Codex work is admitted. The
  full config card still offers the repair-only Claude action.
- Flag changes during preflight: runtime resolution rechecks before spawn;
  existing profile-mismatch rollback remains authoritative.
- Disabled Codex replay/auto-resume/edit-redelivery row: deferred with a
  scope-disabled reason; other rows continue.
- Old Codex reconciliation UI: recording incorporated/dismissed/retry
  authorization remains available to the existing operator, but authorization
  never itself dispatches a retry and later execution still rechecks the flag.

## Alternatives considered

### `enabledRuntimes: ["cli", "codex"]`

This generalizes to an arbitrary provider allowlist. It is rejected for now:
Claude is a stable baseline, only Codex needs beta authorization, and an array
introduces merge/precedence semantics that the existing boolean resolver does
not have.

### Hide Codex whenever model/effort are absent

This conflates authorization with configuration completeness. An operator
cannot distinguish “not allowed” from “allowed but misconfigured,” and a
forged callback can still reach preflight. Rejected.

### Global Codex model/effort defaults

This makes every chat a complete Codex candidate and obscures rollout scope.
It also contradicts the requested chat-only rollout. Rejected.

### UI-only filtering

Old Telegram keyboards remain actionable and direct config can still launch
Codex. Rejected as an incomplete security boundary.

## Implementation units

1. Scope policy

   - `lib/runtime-config.js`: `resolveCodexEnabled`,
     `requireCodexEnabled`, observational descriptor metadata, and
     fail-closed runtime/candidate enforcement.
   - `lib/prompt.js`: normal dispatch/recovery enforcement.
   - `tests/runtime-config.test.js`: precedence, default-off, malformed flag,
     enabled candidate, disabled persisted selection, and repair inspection.
   - `tests/prompt.test.js`: disabled Codex cannot select a prompt/dispatch
     backend.

2. Config UI and callbacks

   - `lib/handlers/config-ui.js`: filter the full-card runtime row and expose
     only the three compact interactive Codex models.
   - `lib/handlers/config-callback.js`: reject stale/forged disabled Codex
     callbacks before side effects; permit disabled Codex → Claude repair.
   - `polygram.js`: resolve and pass effective scope policy at command/card
     wiring points and recheck before Codex commitment.
   - `tests/handlers-config-ui.test.js`: hidden/visible rows and model
     filtering.
   - `tests/handlers-config-callback.test.js`: exact zero-side-effect rejection
     plus enabled success and repair-only Claude switch.
   - `tests/handlers-slash-commands.test.js`: disallowed Codex model cannot be
     selected interactively while an operator-saved authenticated model
     remains compatible.

3. User-facing errors and configuration docs

   - `lib/error/classify.js`: stable, non-authentication shapes for
     `CODEX_SCOPE_DISABLED` and `CODEX_RUNTIME_SELECTION_INCOMPLETE`.
   - `lib/handlers/config-callback.js`: map incomplete candidate configuration
     separately from authentication/preflight failures.
   - `config.example.json`: document default-off semantics and an explicit
     chat opt-in.
   - `tests/error-classify.test.js` and focused callback tests pin exact
     non-authentication text.

4. Recovery and revocation

   - `lib/handlers/replay-disposition.js` and its caller: handle disabled Codex
     recovery per row, defer it without cross-provider replay, and continue the
     mixed replay plan.
   - Auto-resume, edit redelivery, and retry execution use the same
     dispatch-time authorization gate.
   - Tests cover a mixed replay plan, revoked normal-operation recovery, and
     no reservation/injection/send after a fresh failed check.

5. Production rollout

   - First deploy and restart the default-off release with no flags present.
   - Verify an unrelated control chat hides and rejects Codex.
   - Apply only the two chat-scoped flags and complete Codex selections,
     preserving every unrelated production field.
   - Restart through the detected owning systemd topology only after the fleet
     is idle.
   - Verify both allowed chats show Codex; one unrelated chat still does not.
   - Switch one idle Shumabit@UMI topic Claude → Codex → Claude and verify a
     turn on each runtime.

## Test and verification plan

Regression tests must demonstrate red before implementation and green after:

1. A Claude `/config` card with no flag currently contains Codex; after the
   fix it does not.
2. A forged `cfg:runtime:codex` callback currently reaches preflight; after
   the fix it performs zero side effects.
3. A disabled `pm: "codex"` config currently resolves Codex; after the fix it
   remains inspectable for a Claude repair but every provider boundary throws
   `CODEX_SCOPE_DISABLED`.
4. A catalog containing extra models currently exposes them; after the fix it
   exposes only SOL/TERRA/LUNA and rejects an extra interactive selection
   through both button and slash-command paths.
5. A disabled Codex row currently risks escaping the replay loop; after the
   fix it is deferred without blocking a neighboring recoverable row.
6. Revoking the flag before final Codex commitment currently has no dedicated
   fence; after the fix it creates no reservation, injection, or send.

Then run:

- focused config/runtime/UI/callback/slash-command tests;
- `npm test`;
- static production doctor;
- exact redacted Codex preflight for an allowed scope;
- production UI checks in the two allowed chats and one denied control chat;
- idle runtime switch and one real turn in Shumabit@UMI;
- Claude health check after switching back.

## Sequencing and rollout boundary

This work must be implemented on top of commit `f016626` from
`feat/richtext-respawn-on-toggle`, or its merged equivalent, after that
branch's review. It must not edit `config-ui.js` concurrently against the
pre-simplification baseline.

Rollout is two-stage. No production config contains `codexEnabled` until the
supporting default-off release is proven running on every owning daemon;
older in-memory workers would ignore the flag while still rendering and
accepting Codex.

Normal revocation is prospective and idle-only:

1. wait until the affected scope has no active/queued turn;
2. atomically select Claude and set `codexEnabled: false` in the same config
   edit;
3. restart through the owning topology;
4. verify the warm Codex process/receipt is retired and new Codex work is
   rejected.

The dormant namespaced Codex thread is preserved for a later re-enable. An
emergency stop uses the existing stop/restart containment path; toggling this
flag is not an in-flight cancellation mechanism.

## Definition of done

- Codex is default-off and hidden outside explicitly enabled scopes.
- Stale/forged callbacks and direct runtime selection cannot bypass the flag.
- Disabled saved Codex selections can be repaired to Claude without admitting
  Codex work.
- Disabled Codex recovery is deferred per row and cannot block unrelated
  replay.
- Enabling does not change the selected runtime.
- Only SOL/TERRA/LUNA are offered for interactive Codex selection.
- Ivan DM and Shumabit@UMI can switch between Claude and Codex.
- An unrelated Shumabit chat cannot see or select Codex.
- Claude behavior and existing sessions remain unchanged.
