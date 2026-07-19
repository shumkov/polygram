# Detect expired Claude auth instead of wedging silently

**Status:** BUILT + code-reviewed, **NOT YET DEPLOYABLE** · orchestra `lib/claude-bin.js`
(`checkClaudeAuthHealth`) + polygram `handleMessage` gate + boot/interval monitor.
Field-driven: shumabit@UMI, 2026-07-15. Blocked on the ORCHESTRA FIRST rollout step
below: the only `@shumkov/orchestra` version published to npm (0.2.0) does not export
`checkClaudeAuthHealth` yet — it exists solely as uncommitted work in the orchestra
source repo. `tests/orchestra-dependency-contract.test.js` pins this and fails until
orchestra publishes and this branch's dependency is bumped to that release.

## Problem

When the Claude CLI's OAuth **refresh token** ages out, `~/.claude/.credentials.json`
can no longer refresh the access token, and every `claude` invocation 401s
("OAuth access token has expired. Re-authenticate to continue."). On the CLI/channels
backend (all prod chats), that 401 fires **inside the claude subprocess** — it never
reaches polygram's error classifier. The turn fires `UserPromptSubmit` (ups-seen) then
produces no hooks, no reply, no Stop → polygram sees only "no progress" → the generic
idle-timeout **"⏱ went quiet"**. Every topic wedges identically; nothing says "auth."

Field incident (2026-07-15): shumabit's refresh token expired → **0 turns resolved in 6h**
across every topic; a fleet restart didn't help (auth isn't daemon state); the only signal
was a direct `claude -p` returning 401. `auth-expired` events = 0 (the classifier never ran).

## Why output-scanning does NOT work (research)

- **Pane scan is dead.** 72 pane captures across the wedge window contained the auth
  string **zero** times — claude flashes the error then returns to the idle input bar, so
  it's never on-screen when polygram captures (mid-turn or at timeout; the timeout pane was
  the empty `⏵⏵ bypass permissions` bar).
- **`/status` isn't headless** — "isn't available in this environment".
- **A `claude -p` probe costs tokens** (a real model turn every N min) — rejected.

## Design — a FREE credentials-file check

`~/.claude/.credentials.json` → `claudeAiOauth` carries two expiries: `expiresAt` (access
token; auto-refreshed) and **`refreshTokenExpiresAt`** — the hard limit. Reading that field
detects the exact failure with **no API call, no spawn**, and can warn ahead.

**orchestra `checkClaudeAuthHealth({home, now, warnWithinMs})`** → `{state, refreshTokenExpiresAt, msLeft, daysLeft}`:
- `expired` — `refreshTokenExpiresAt <= now`.
- `expiring` — within `warnWithinMs` (default 3d).
- `healthy` — else.
- `unknown` — file missing/unreadable or field absent (NEVER hard-refuse on a read error).

**polygram — two consumers:**
1. **Dispatch gate** (`handleMessage`, after slash-command dispatch, before the turn):
   on `expired`, log `[auth] Claude login EXPIRED …`, emit an `auth-expired` event, and
   **reply to the chat**: *"🔑 Claude login has expired and needs to be re-authenticated…"* —
   then return without spawning the doomed turn. Slash commands (no claude) still work;
   replays are skipped.
2. **Boot + 30-min monitor** — logs `[auth]` ERROR on `expired`, WARN on `expiring`
   (with `daysLeft`), emits `auth-expired`/`auth-expiring` events, so the operator sees it
   in the logs even with no traffic, days before it breaks.

## Tests / verification

- orchestra `tests/claude-bin.test.js`: 5 cases (healthy / expiring / expired / unknown-missing
  / unknown-no-field). All green.
- polygram: `handleMessage` has no unit harness (huge closure); the gate is verified
  **non-breaking** (the handleMessage-touching suites pass through on healthy creds) and the
  decision logic is covered by the orchestra tests. Manual expired-auth smoke on deploy.

## Rollout (ORCHESTRA FIRST — hard ordering)

`checkClaudeAuthHealth` lives in orchestra. polygram calls it, so **orchestra must publish
first**; deploying polygram against an orchestra that lacks the function would `TypeError`
on every message. Order: publish orchestra (minor) → bump polygram's `@shumkov/orchestra`
dep → release polygram → deploy (shumabit + umi-assistant). Soak: expired-auth now surfaces
as a `[auth]` log + a "🔑 re-authenticate" reply instead of a silent "⏱ went quiet".
