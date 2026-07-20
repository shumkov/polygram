# Handle Anthropic-disabled Claude access instead of a silent 10-minute wedge

**Status:** BUILT + code-reviewed (correctness, reliability, test-coverage
passes on the diff, in addition to the pre-implementation spec review below)
+ tests green (2435 pass, 0 fail). `@shumkov/orchestra` published `0.4.0`
with the real `AUTH_DISABLED` detection while this was in progress (confirmed
via `npm view`/package inspection — matches the contract this spec assumed);
`package.json` bumped to `^0.4.0` and Layer 4 became a real version-floor
contract test instead of a `test.todo` placeholder. Not pushed / no PR opened
— branch `fix/auth-disabled-handling`, pending Ivan's decision on next steps.

**Code review found one real bug beyond the pre-implementation spec review:**
the pre-existing rc.55 replay-failure block in `lib/handlers/dispatcher.js`
is a second unconditional `if`, gated on `isReplay` but not on `err.code` —
without an explicit exclusion, an `AUTH_DISABLED` failure on a replayed
message (boot-replay after a restart) fell through into it and sent the user
a hardcoded "interrupted, please resend" reply, contradicting the "chat is
never told" contract. Fixed with `&& err.code !== 'AUTH_DISABLED'` on that
guard, TDD red→green with a dedicated regression test. See Layer 3.1 for the
full write-up.

## Problem

When Anthropic disables Claude Code / subscription access on an account (e.g.
non-payment), the `claude` CLI does not return an HTTP 401/403. It streams a
policy-string message — something like *"disabled Claude subscription
access… enable (Claude Code) access… use an Anthropic API key instead"* — as
if it were ordinary output. Nothing in the CLI-backend pipeline recognizes
that string, so the turn just sits there until the idle-ceiling timeout fires
(`err.code === 'TURN_TIMEOUT'` or `'TURN_MAX_EXCEEDED'`, ~10 minutes later),
and `lib/error/classify.js` maps that to the generic **"⏱ went quiet"** reply.
The user waits 10 minutes for a message that doesn't explain what actually
happened, and nothing tells the operator the account is disabled — every
topic on every affected bot wedges identically until someone notices by hand.

This is distinct from the OAuth-refresh-token-expiry case this repo already
handles (`checkClaudeAuthHealth`, see `docs/claude-auth-detection-spec.md`,
merged in PR #12): that's an *expired* token, detected for free by reading
`~/.claude/.credentials.json` before a turn even starts. This is Anthropic
*actively disabling* access, which has no file-readable precondition — it
only surfaces as text streamed mid-turn, after the subprocess has already
been spawned.

This repo shares the orchestra session engine with the sibling `water`
(WhatsApp) repo, so the same account-disable event can take both bots down
at the same moment. A sibling agent is fixing the shared root cause in
orchestra; a second sibling agent is doing the consumer-side port to `water`.
This spec covers the consumer-side port to this repo (polygram/Telegram).

## The `AUTH_DISABLED` contract

Orchestra's `lib/process/cli-process.js` (branch `fix/auth-disabled-detection`,
worktree `~/Projects/shumkov/orchestra.fix-auth-disabled-detection`, not yet
merged/published) will detect the fatal disabled-access signature **as soon
as it streams** and reject the in-flight turn immediately with:

```js
Object.assign(new Error('...'), { code: 'AUTH_DISABLED' })
```

This mirrors the existing `TURN_TIMEOUT` / `TURN_MAX_EXCEEDED` rejection
pattern — a thrown error with a typed `.code`, not a pattern-matched message.
Both `water` and this repo build against the same contract: *"a turn can
reject with `err.code === 'AUTH_DISABLED'`."*

### Where the rejection surfaces in this repo

Confirmed by reading the current turn-error flow (`polygram.js` `handleMessage`,
`lib/handlers/dispatcher.js` `dispatchHandleMessage`):

1. `handleMessage`'s turn-send `try` block (`polygram.js:1737` catch) branches
   on `err.code` via `classifyTurnEndError` for the streamer-suffix / reactor
   decision (this already runs generically for any `err.code`, no changes
   needed there — `AUTH_DISABLED` isn't a timeout, so it falls into the
   existing "not a timeout → reactorState ERROR" branch, which is fine), then
   **re-throws** (`polygram.js:1779`).
2. The re-thrown error propagates to `dispatchHandleMessage`'s own
   `.catch((err) => {...})` in `lib/handlers/dispatcher.js:179` — the single
   place every unhandled turn error lands, already home to the analogous
   `TMUX_SESSION_GONE` / `CHANNELS_DIALOG_TIMEOUT` / `BRIDGE_DISCONNECTED`
   code-specific side effects (poison-clear, auto-resume, etc.) and the final
   `errorReplyText(err)` → chat-reply gate.

So `dispatcher.js`'s catch is the one integration point for all of Layer 3
(operator notify, logs, heartbeat counter) — no new call site needed in
`polygram.js` itself beyond wiring the new dependencies through
`createDispatcher(...)`.

## Layer 1 — `lib/error/classify.js`

Add a `CODES.AUTH_DISABLED` entry, matching the shape/style of the existing
`AUTH_EXPIRED` entry, but with `userMessage: null` — an Anthropic-side
billing/policy outage isn't the user's problem to see, and telling every chat
"Claude is disabled" would leak an internal/billing detail to end users across
every bot this repo runs. The operator (not the chat) gets told, via Layer 3.

```js
// AUTH_DISABLED: Anthropic has disabled Claude Code / subscription access on
// this account (e.g. non-payment) — orchestra's cli-process.js detects the
// streamed policy-string signature and rejects the turn immediately (see
// docs/AUTH_DISABLED_HANDLING_SPEC.md) instead of letting it wedge for 10
// minutes into a generic TURN_TIMEOUT. Distinct from AUTH_EXPIRED (a token
// refresh problem, user-recoverable by re-login): this is an infra/billing
// condition on our end, so userMessage is null — the operator gets notified
// (dispatcher.js), the chat does not.
AUTH_DISABLED: {
  kind: 'authDisabled',
  userMessage: null,
  isTransient: false,
  autoRecover: null,
},
```

Because `errorReplyText()` in `dispatcher.js` already treats a `null`
`userMessage` as "suppress the reply" (existing mechanism, used today for
`INTERRUPTED`), no extra branching is needed to keep this out of the chat —
it falls out of the existing generic path for free.

## Layer 3.1 — Operator notification

This repo has no separate escalator module — it *is* the thing `water`'s own
`lib/ops/escalate.js` calls into (via `lib/ipc/client.js` → this repo's
`lib/ipc/server.js`) to get a Telegram message delivered. This repo already
sends Telegram messages directly (`tg(bot, 'sendMessage', ...)`).

**Correction from spec review (feasibility pass):** the admin-DM field is
**`config.bot.approvals.adminChatId`**, not the top-level `config.bot.adminChatId`.
Verified against `lib/handlers/approvals.js:84-85` (`config.bot?.approvals`,
gated on `apprCfg.adminChatId`) and `approvals.js:133` (`chat_id:
apprCfg.adminChatId`) — that's the one place in this repo that actually sends
an admin-facing Telegram DM today. The top-level `config.bot.adminChatId`
(`gate-inbound.js:90,151`, `slash-commands.js:267`) is used only for
admin-*identity* comparisons (deciding whether a sender is the operator), never
to address a `sendMessage` call. `config.example.json` confirms these are two
distinct keys. So this spec is establishing a **new** admin-DM call site on the
existing `approvals.adminChatId` field — not reusing an existing send —
because that field is the only one already wired to Telegram delivery.
(AUTH_EXPIRED, the closest analog, was spec'd to DM the admin in the 0.8.0
plan but that part was never actually implemented — it only logs +
replies in the user's own chat today, so there's no other precedent to point
to.) No new escalator framework; one direct `tg(bot, 'sendMessage', {chat_id:
config.bot?.approvals?.adminChatId, ...})` call in `dispatcher.js`'s catch.

### Dedupe / re-arm

Per spec requirement: fire once per outage window, re-arm when a turn next
succeeds. A tiny new stateful module, `lib/ops/auth-disabled-gate.js`:

```js
function createAuthDisabledGate({ now = Date.now } = {}) {
  let armed = true;      // true = next failure should notify
  let count = 0;         // total AUTH_DISABLED occurrences (heartbeat counter)
  let lastAt = null;

  function noteFailure() {
    count += 1;
    lastAt = now();
    if (!armed) return false;
    armed = false;
    return true; // caller should notify
  }
  function noteSuccess() { armed = true; }
  function snapshot() { return { count, lastAt, armed }; }

  return { noteFailure, noteSuccess, snapshot };
}
module.exports = { createAuthDisabledGate };
```

- `noteFailure()` always increments the counter (so the heartbeat counter — see
  Layer 3.3 — reflects true occurrence volume even while deduped), but only
  returns `true` (→ send the DM) the first time since the last success.
- `noteSuccess()` re-arms.
- One gate instance per bot process, constructed as module-scope `const` in
  `polygram.js` (same pattern as `autoResumeTracker`/`contextHintShown` at
  `polygram.js:602-603` — no runtime config needed to build it, so it's a
  plain top-level `const`, not a deferred `let` assigned in `main()`).

**Corrections from spec review (reliability + feasibility passes) —
both the re-arm trigger and the DI wiring in the original draft were unsafe:**

1. **Re-arm granularity was too broad.** The original draft re-armed on *any*
   `handleMessage(...)` resolving cleanly — but `handleMessage` also resolves
   cleanly for slash commands (`/model`, `/config`, `/new`, …), unconfigured
   chats, and other early-returns that never touch Claude at all
   (`polygram.js:738`, `805-824`). During a real `AUTH_DISABLED` outage, any
   user running `/config` in any chat would silently re-arm the gate, so the
   very next real failure re-pages the operator even though the outage never
   actually recovered ("flapping"). **Fix:** re-arm only at the point a Claude
   turn genuinely succeeds — inside `handleMessage` itself, in the existing
   `else` branch after `if (result.error) {...} else {...}` (`polygram.js`
   ~line 1319, the branch that already handles a real, non-error result).
   Slash commands and other early-returns never reach that branch, so they
   can't falsely clear an ongoing outage.
2. **The `.then()` hook risked misrouting successful turns into the failure
   path.** `dispatchHandleMessage` is fire-and-forget everywhere it's called
   (`lib/handlers/gate-inbound.js:138,194` call it with no `await`/`.then`/
   `.catch`), so nothing in the real call graph catches a rejection from
   `dispatchHandleMessage`'s own promise chain. Chaining `.then(() =>
   authDisabledGate.noteSuccess())` **before** the existing `.catch(...)` at
   `dispatcher.js:179` meant: if `noteSuccess()` ever threw, standard Promise
   semantics route that rejection into the *next* `.catch()` in the chain —
   i.e. the same failure-handling block used for real turn errors. That would
   mark a genuinely successful turn's DB status `'failed'`
   (`dispatcher.js:191-198`) and send the user a bogus "something went wrong"
   reply on top of the real answer they already received. Moving the rearm
   call out of `dispatcher.js` entirely (into `handleMessage`'s own success
   branch, point 1 above) removes this risk at the source — there's no longer
   a `.then()` in the dispatch chain at all.
3. **`authDisabledGate.noteFailure()` had no defensive guard.** Because
   `AUTH_DISABLED` is account-wide, a real outage means *every* chat's next
   turn hits this same branch in a short window. If `authDisabledGate` were
   ever `undefined` (a missing DI param at some call site), an unguarded
   `.noteFailure()` throws — and since `dispatchHandleMessage` is
   fire-and-forget (point 2), that's an unhandled rejection on *every*
   concurrent chat, all within seconds of each other. `polygram.js:2393-2395`
   documents a storm circuit breaker that panics the whole process
   (`exit(2)`) when the same message fires >100× in 5s — turning one missing
   wiring bug into a full outage worse than the one being fixed. **Fix:**
   `noteFailure()` is called inside a `try/catch` in `dispatcher.js` (never
   let the gate itself become a new failure mode), *and* `createDispatcher`'s
   destructured signature gives `authDisabledGate` a default value
   (`authDisabledGate = createAuthDisabledGate()`, matching the existing
   `chunkBudget = 4096` / `startupRetryDelayMs = STARTUP_RETRY_DELAY_MS`
   default-param precedent at `dispatcher.js:57,60`) so a forgotten DI param
   degrades to "always notify, never dedupe" instead of throwing.

### Wiring into `dispatcher.js`

New DI param on `createDispatcher(...)`: `authDisabledGate = createAuthDisabledGate()`
(defaulted, per correction #3 above). No new param needed for the DM send
itself — `tg`, `botName`, and `config` are already injected.

In `dispatchHandleMessage`'s catch, alongside the existing `err.code`
special-cases (`TMUX_SESSION_GONE` poison-clear etc., which already run
unconditionally before the `wasAborted`/`isReplay`/`isShuttingDown` reply-
gating section):

```js
if (err.code === 'AUTH_DISABLED') {
  logger.error?.(`[auth] (${botName}) Claude access DISABLED by Anthropic — turn rejected immediately instead of wedging; check the account/billing.`);
  logEvent('auth-disabled', {
    chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
    error: err.message?.slice(0, 500),
  });
  let shouldNotify = false;
  try {
    shouldNotify = authDisabledGate.noteFailure();
  } catch (gateErr) {
    logger.error?.(`[auth] authDisabledGate.noteFailure failed: ${gateErr.message}`);
  }
  if (shouldNotify) {
    const adminChatId = config.bot?.approvals?.adminChatId;
    if (adminChatId) {
      tg(bot, 'sendMessage', {
        chat_id: adminChatId,
        text: `🚫 Claude Code access appears DISABLED for this account (Anthropic-side, e.g. non-payment) — turns are failing instead of replying. Check the Anthropic account/billing. (bot: ${botName})`,
      }, { source: 'auth-disabled-notify', botName }).catch((notifyErr) => {
        logger.error?.(`[auth] operator notify failed: ${notifyErr.message}`);
      });
    } else {
      logger.error?.(`[auth] AUTH_DISABLED fired but no config.bot.approvals.adminChatId configured — operator was not notified`);
    }
  }
}
```

This block runs **unconditionally**, independent of `wasAborted` /
`isReplay` / `isShuttingDown` — the account-disabled condition is real
regardless of what else was happening to this particular message, and the
existing `errorReplyText(err)` gate further down already suppresses the
chat-facing reply on its own (via `userMessage: null` from Layer 1), so there
is no risk of double-handling.

Re-arm hook (relocated to `polygram.js`'s `handleMessage`, per correction #1):

```js
} else {
  // AUTH_DISABLED re-arm: only a genuine, non-error turn result counts as
  // "recovered" — slash commands and other early-returns in this function
  // never reach this branch, so they can't falsely clear an ongoing outage.
  try { authDisabledGate.noteSuccess(); } catch (e) { console.error(`[auth] authDisabledGate.noteSuccess failed: ${e.message}`); }
  // ... existing rc.10 success-path logic (context hint, etc.) unchanged below
```

**Implementation note:** the actual insertion point (as implemented) sits a
few lines later than shown above — right after `const chatCtxHint = ...` and
before the `rc.59` comment, not immediately after `} else {`. A pre-existing
structural regression test (`tests/polygram-success-path-order.test.js`,
rc.10) asserts the success branch's `} else {` is immediately followed by the
`rc.10: reactor.clear()` comment block with no intervening `{`/`}` — my
try/catch's braces broke that regex when placed literally first. Semantics
are unaffected (the rearm only needs to run somewhere in the unconditional
success branch, not at any specific line), so it moved a few statements down
to the next comment-free gap instead.

`authDisabledGate` must be in scope for both `handleMessage` (top-level
function, `polygram.js:736`) and the `createDispatcher(...)` call site
(inside `main()`, `polygram.js:2198`+) — the module-top-level `const`
declared alongside `autoResumeTracker` satisfies both without needing a
deferred `let`.

**Call-site reminder:** the real `createDispatcher({...})` invocation at
`polygram.js:2703-2712` must add `authDisabledGate` to the object literal —
easy to miss among ~15 other DI params in the same call. The default from
correction #3 makes a miss non-fatal (falls back to a gate with no shared
dedupe history — effectively "always notify"), but the wiring should still be
added explicitly; see the test-plan note below for how this is covered.

4. **(Found in code-diff review, not the pre-implementation pass) The
   pre-existing rc.55 replay-failure block leaked a chat reply for
   AUTH_DISABLED on replayed messages.** A few lines below the AUTH_DISABLED
   block, `dispatcher.js` has an older, unrelated `if (isReplay &&
   !wasAborted && !isShuttingDown) { tg(bot, 'sendMessage', {... "This turn
   was interrupted..."}) }` — added for rc.55, gated purely on replay status,
   never on `err.code` or `classifyError`. Both blocks are independent,
   unconditional `if`s in the same catch, so an `AUTH_DISABLED` failure on a
   `_isReplay: true` message (boot-replay after a restart) hit AUTH_DISABLED's
   own block (operator notified, no reply) *and then fell through* into the
   rc.55 block, which sent the hardcoded reply anyway — regardless of
   `classify.js` mapping `userMessage: null`. **Fix:** added `&& err.code !==
   'AUTH_DISABLED'` to the rc.55 guard. This is the one place in the whole
   change where "no extra branching is needed, it falls out of the existing
   generic path for free" (as originally claimed in Layer 1) was **not**
   quite true — the generic path is `errorReplyText(err)` at the very bottom
   of the catch; this earlier, unrelated replay-specific block bypasses that
   entirely and had to be excluded explicitly.

## Layer 3.2 — Logs

Two log surfaces, both firing on **every** occurrence (not deduped — dedupe
only gates the operator DM, not visibility in logs/DB):

1. `console.error('[auth] ...')` — matches the `[auth]` prefix convention
   established by `checkClaudeAuthHealth` in `polygram.js` (`grep '\[auth\]'
   polygram.js`), so an operator grepping logs for `[auth]` sees both related
   conditions together.
2. `db.logEvent('auth-disabled', {...})` — same `logEvent` mechanism used for
   `auth-expired` / `auth-expiring`, queryable via the existing events table
   the same way.

## Layer 3.3 — Heartbeat / Netdata visibility

**This is the gap.** Unlike `water` (`lib/ops/heartbeat.js` →
`heartbeat.json` → `/healthz` → Netdata httpcheck, plus a full
`sla-watchdog.js`/`transport-watchdog.js` stack), this repo has **zero**
existing health-check/heartbeat/Netdata infrastructure — its `ops/` directory
is unrelated (launchd plist templates for local Mac process supervision, not
production health signals; this repo runs on shumabit/umi-assistant's VPS via
systemd). Confirmed by grep: no `http.createServer`/`express` anywhere in
this repo — there is no listener to hang a `/healthz` route on, unlike
`water`'s wuzapi-adjacent HTTP server.

Scope, deliberately proportionate to the actual ask ("an authDisabled outage
becomes Netdata-visible the same way water's will be" — not "build water's
full ops stack"):

New `lib/ops/heartbeat.js`, minimal file-only equivalent of water's pattern
(no `/healthz` endpoint, since there's no HTTP server to serve it from):

```js
function createHeartbeat({ dataDir, authDisabledGate, intervalMs = 60_000, now = Date.now }) {
  const file = path.join(dataDir, 'heartbeat.json');
  let timer = null;

  function snapshot() {
    const gate = authDisabledGate.snapshot();
    return { ts: now(), authDisabled: gate.count, authDisabledLastAt: gate.lastAt };
  }

  function beat() {
    const snap = snapshot();
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, file); // atomic
    } catch (err) {
      // Best-effort (matches water's heartbeat.js) — must never throw into the
      // interval timer or affect a turn. Logged (water's version doesn't) because
      // this file's whole purpose is surfacing a silent failure; a heartbeat that
      // can go silently stale defeats that purpose the same way the bug it's
      // meant to catch does.
      console.error(`[auth] heartbeat write failed: ${err.message}`);
    }
    return snap;
  }

  function start() { beat(); timer = setInterval(beat, intervalMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); }

  return { start, stop, beat, snapshot, file };
}
```

- Written to `<DATA_DIR>/heartbeat.json` (`DATA_DIR = process.cwd()`,
  `polygram.js:135` — each bot process's own working directory, mirroring
  water's per-instance `dataDir` convention: shumabit and umi-assistant each
  get their own file since they're separate processes/directories).
- Wired in `polygram.js` main() next to the existing `runAuthCheck` boot +
  30-min-interval pattern: instantiate once, `start()` on boot.
  `authDisabledGate` and the heartbeat instance are both module-scope,
  created before `createDispatcher(...)` so the gate can be passed in.
- **Explicitly out of scope for this repo's PR:** wiring `heartbeat.json`
  into an actual Netdata alert (a `netdata_watch_units` / custom
  filecheck-or-cron-parses-JSON entry, analogous to water's
  `netdata_httpchecks` entries for `127.0.0.1:8090/healthz`). That's a
  VPS-side ops/ansible change outside this repo — this PR only builds the
  code-side signal (the file + the counter). Flagged here so it isn't lost.

**Scope objection raised in review, kept anyway — flagging for sign-off:**
the scope-simplicity reviewer argued this whole layer should be cut/deferred
from this PR: nothing in this repo or its deployment reads `heartbeat.json`
on merge day (the Netdata wiring is explicitly out of scope, per above), and
the same data is already durably queryable via Layer 3.2's `db.logEvent`.
That's a fair simplicity argument on its own — but building this now is an
explicit, direct ask ("Ivan explicitly wants this new condition visible in
Netdata for this repo too, not just water... Build the minimal equivalent...
Keep scope proportionate... just enough that an authDisabled outage becomes
Netdata-visible"), not something this spec invented speculatively. Kept as
specified; noting the objection rather than silently overriding either the
review or the ask.

## Layer 4 — orchestra dependency contract note

`tests/orchestra-dependency-contract.test.js` exists because polygram calls
`checkClaudeAuthHealth` **unconditionally** on the hot path — if the
installed `@shumkov/orchestra` doesn't export it, every message silently
throws. `AUTH_DISABLED` is different in kind: it's not a function export to
`typeof`-check, it's a *behavioral* contract (orchestra's `cli-process.js`
rejects with a specific `err.code` under a specific streamed-text condition).
There's nothing static to assert against the installed package today.

Add a `test.todo(...)` in the same file, documenting the gap loudly rather
than silently:

```js
test.todo(
  'AUTH_DISABLED: once @shumkov/orchestra ships cli-process.js disabled-access '
  + 'detection (branch fix/auth-disabled-detection), add a contract test here '
  + '— e.g. feed cli-process.js a synthetic disabled-account stream and assert '
  + 'the rejected turn carries err.code === "AUTH_DISABLED". See '
  + 'docs/AUTH_DISABLED_HANDLING_SPEC.md.'
);
```

This repo's own logic (classify.js, the gate, the operator notify, the
heartbeat) does not depend on the real package landing — it's built and
tested against a stubbed rejection (`Object.assign(new Error(...), {code:
'AUTH_DISABLED'})`) exactly like the existing `TURN_TIMEOUT` tests already
do. `test.todo` is a live reminder, not a blocker: it always reports (never
silently passes as if done), but never fails CI.

## Test plan (TDD-for-bug-fixes: red → green per change)

| File | What | Red-state proof |
|---|---|---|
| `tests/error-classify.test.js` | `AUTH_DISABLED` → `kind: 'authDisabled'`, `userMessage: null`, `isTransient: false`, `autoRecover: null` | Before the `CODES` entry exists, `classify({code:'AUTH_DISABLED'})` falls through to `kind: 'unknown'` with a non-null generic message — test written first, run, confirmed failing on that assertion, then the `CODES` entry added. |
| `tests/auth-disabled-gate.test.js` (new) | `noteFailure()` → `true` once, `false` on repeat until `noteSuccess()`; `count` increments on every call regardless of dedupe; `snapshot()` shape; repeated `noteFailure()`/`noteSuccess()` calls never throw for any input shape (the gate is meant to be safe by construction — dispatcher's try/catch around it is defense-in-depth, not a substitute) | Module doesn't exist yet — `require` fails until written test-first against the intended shape. |
| `tests/auth-disabled-heartbeat.test.js` (new) | `beat()` writes valid JSON with `authDisabled`/`authDisabledLastAt` reflecting the gate's `snapshot()`; atomic write (temp+rename); `start()`/`stop()` timer lifecycle; a write failure (mock `fs.writeFileSync` to throw) is caught, logged via `console.error`, and does not throw out of `beat()` | Same — module doesn't exist yet. |
| `tests/handlers-dispatcher.test.js` (extend) | AUTH_DISABLED, using a real `createAuthDisabledGate()` instance (not just a stub, so dedupe/rearm-adjacent behavior is exercised for real): (a) first occurrence notifies operator via `tg(...)` targeting `config.bot.approvals.adminChatId`, (b) second occurrence (same gate instance, no intervening `noteSuccess()`) does NOT re-notify, (c) `logEvent('auth-disabled', ...)` fires on **every** occurrence even when the DM is deduped, (d) no chat-facing reply is ever sent for this code (relies on `classifyError` stub returning `userMessage: null`), (e) missing `config.bot.approvals.adminChatId` logs a warning and does not throw, (f) a `authDisabledGate` whose `noteFailure()` throws is caught — `dispatchHandleMessage` still runs its normal terminal-status/logging steps and does not crash, (g) omitting `authDisabledGate` from `createDispatcher(...)`'s options uses the default (no-op-safe) gate instead of throwing | Extend the existing `fixture()` helper with a real gate + assertion hooks; write assertions against the not-yet-existing DI param/branch/default, run, confirm failure, then implement. |
| Re-arm (`polygram.js` `handleMessage` success branch) | **No dedicated unit test** — `handleMessage` has no unit harness today (same limitation noted in `docs/claude-auth-detection-spec.md`'s own test-plan section: "huge closure"). Coverage comes from: (1) `auth-disabled-gate.test.js` already proves `noteSuccess()` re-arms correctly in isolation, (2) code review confirms the call is placed in the non-error `else` branch only (not reachable from slash-command/early-return paths), (3) manual smoke on deploy, mirroring the AUTH_EXPIRED precedent's own "manual expired-auth smoke on deploy." | N/A — explicitly flagged as a coverage gap rather than silently assumed covered, per Rule 11. |
| `polygram.js:2703-2712` `createDispatcher(...)` call-site wiring | Adding `authDisabledGate` to the real call. | **No automated test** — `polygram.js` has side effects on import (starts the bot), so there's no cheap way to assert the real call site without a full-process integration test, which is out of proportion here. Covered by code review + the default-param safety net (correction #3) making a miss non-fatal rather than by a test. |

All new/changed tests run via the existing `npm test` (`node --test
tests/*.test.js`). `node_modules` isn't currently installed in this worktree
— `npm install` runs once before the first test pass.

## Alternatives considered

- **Pattern-match the streamed policy string in `classify.js` PATTERNS**
  (like `imageProcess`/`billing` do), instead of relying on orchestra's
  `err.code`. Rejected: the whole point of the parallel orchestra fix is to
  catch this **as the text streams**, before the 10-minute wedge — a
  `classify.js` pattern only helps *after* the message already reached the
  classifier, which for this bug is only true once `TURN_TIMEOUT` already
  fired (i.e., it wouldn't fix the actual production bug, just relabel it
  once it's already 10 minutes late). Keeping `classify.js`'s `AUTH_DISABLED`
  case as a typed-code short-circuit (matching `AUTH_EXPIRED` /
  `BRIDGE_DISCONNECTED` /  etc.) is consistent with how every other
  polygram-internal/backend-specific condition is already modeled in this
  file.
- **A new escalator framework mirroring water's `lib/ops/escalate.js`**
  (quiet hours, severity levels, `ipcBot` targeting). Rejected as
  disproportionate: this repo has direct Telegram access and a single
  operator (`config.bot.approvals.adminChatId`); water needs the indirection
  because it doesn't send Telegram itself. One `AUTH_DISABLED` condition
  doesn't justify severity levels or quiet-hours suppression — this is the
  kind of thing you want to know about immediately, any time of day (mirrors
  `water`'s own "CRITICAL always pages" rule for its escalator).
- **Per-chat dedupe instead of per-process** — rejected: `AUTH_DISABLED` is
  an account-wide condition (Anthropic disabled the CLI's access entirely),
  not scoped to one chat/session; per-chat dedupe would spam the operator
  once per active chat on the same outage.
- **Time-based re-notify cooldown (e.g. "page again every 30 min while still
  failing") instead of success-based re-arm** — rejected: `AUTH_DISABLED` is a
  durable, binary condition that only clears when the operator fixes it
  out-of-band (Anthropic billing/policy), not something that resolves on its
  own after some interval. A cooldown would need an arbitrary interval and
  would either re-page about a condition the operator already knows and can't
  fix any faster (too short) or stay silent well past actual recovery (too
  long). Event-based re-arm — "notify once, go quiet until proof of recovery"
  — pages exactly once per real outage. (Re-arm is scoped to genuine Claude-
  turn success specifically, not just any `handleMessage` resolution — see
  Layer 3.1 correction #1 — so unrelated bot traffic like slash commands
  during an outage can't falsely trigger a "recovered" re-arm.)
- **HTTP `/healthz` endpoint** — rejected for this PR: no HTTP server exists
  in this repo to hang a route on (`apiRoot` is an external companion
  process, not this repo's own listener). File-only heartbeat matches the
  actual infra and is the same primitive water's Netdata wiring polls
  underneath its `/healthz` wrapper anyway.

## Failure modes

- `authDisabledGate`/`heartbeat` write failures are all best-effort
  (try/catch, matching every other logging/telemetry path in this repo) —
  they must never themselves crash a turn or block the reply-suppression
  path that's the actual point of Layer 1.
- If `config.bot.approvals.adminChatId` is unset, the operator DM is skipped
  (logged loudly instead) rather than throwing — mirrors `approvals.js`'s
  existing `if (!apprCfg || !apprCfg.adminChatId)` guard.
- If `authDisabledGate` itself misbehaves (missing DI param, or `noteFailure`/
  `noteSuccess` throwing), it must never crash `dispatchHandleMessage` or
  misroute a successful turn into the failure-reply path — see Layer 3.1
  corrections #1–#3 (relocated re-arm, try/catch around `noteFailure`,
  defaulted DI param). This was the most severe class of issue found in spec
  review: a naive dedupe hook could turn a single missing wiring param into a
  full-process crash (via the existing storm circuit breaker,
  `polygram.js:2393-2395`) or double-reply users on successful turns — both
  worse than the 10-minute wedge this change exists to fix.
- If the DM send itself fails (Telegram API error), it's caught and logged;
  the gate stays disarmed until the next success either way (we don't retry
  the notify — the loud `[auth]` log + `auth-disabled` event + heartbeat
  counter are the durable signals; the Telegram DM is best-effort UX on top).
