# Stop-grace cancel race — a no-reply turn loses its only finalizer

**Status:** spec · not yet built · CLI/channels backend (`lib/process/cli-process.js`,
the D1 finalizer ladder). Field-confirmed by forensics (shumabit@UMI root topic,
2026-06-23). **Supersedes the root-cause section of `lost-stop-wedge-rescue-spec.md`** —
the Stop is NOT lost; it arrives and is killed by a grace-cancel race.

## Problem (one sentence)

A turn that ends with NO reply-tool call relies on its attributed **Stop grace** as
its *only* finalizer; when a `pane-thinking` heartbeat cancels that grace (the design's
"activity proves the Stop was stale" rule, mis-fired by the turn's own residual
streaming hint), the no-reply turn has nothing left and dangles to the 60-min idle
ceiling — the answer, already captured in `last_assistant_message`, is dropped.

## Evidence (shumabit.db, UMI group root topic, 2026-06-23)

The Chrome-debug-over-tailnet conversation. Root-session (`-1003369922517`, thread
null) turn `46965349`, traced from the events DB:

```
17:50:44.091  UserPromptSubmit hook (lag 5ms) + cli-ups-seen  → turn picked up (seen=true)
              reactor 🤔→🤨→🤓 (thinking, then deeper)        — claude working, no reply tool
17:53:06.133  hook-lag-sample  Stop  lag_ms:2                  ← the Stop FIRED, polygram got it
              (carrying last_assistant_message = the Chrome/tailnet answer)
              → _beginAttributedStopGrace: _stopHookData=info, 2s grace armed
17:53:06.172  cli-stop-grace-cancelled  turn 46965349  source:"pane-thinking"   ← +39ms, KILLED
17:53:11→18:03:01  cli-mid-turn-unknown-prompt ×18 (every ~30s, idle pane, NO further activity)
18:03:06  turn-timeout (reason=idle, 3600000ms) → "⏱ went quiet", answer dropped
```

Decisive facts:
- The hook stream was **healthy** (Stop lag = 2ms). This is **not** a hook-stream death
  / lost-Stop case — "self-heal the hook tail" would fix nothing here.
- The Stop **arrived and was attributed** (turn was `seen`). It began a real grace.
- `pane-thinking` cancelled the grace **39ms** later — the pane still carried
  "esc to interrupt" from the turn's *own* final render, racing the Stop.
- After the cancel, the root session noted **zero** further activity
  (`cli-mid-turn-unknown-prompt` does not call `_noteActivity`), so nothing re-armed.
- `last_assistant_message` (the answer) sat in `pending._stopHookData`, undelivered.

## Root cause — two defects that combine

1. **Weak signal cancels a real Stop.** `_noteActivity('pane-thinking')`
   (`cli-process.js:3849`) → `_cancelStopGrace` (`:1753`). `pane-thinking` is the pane
   heartbeat (`STREAMING_HINT_RE` = "esc to interrupt"), a liveness fallback that keeps
   a hook-silent pure-thinking turn off the idle ceiling. It lingers a few hundred ms
   after the real Stop fires, so it can cancel a correctly-attributed grace.
2. **The promised fallback doesn't exist for no-reply turns.** The grace-cancel design
   comment (`:3043-3045`) says *"…cancels — the turn falls back to rung 2."* But rung 2
   (`_armActivityQuiet` `:1779-1780`, `_activityQuietFinalize` `:1812-1813`) gates on
   `_turnHasFinalReply || (seen && consumedAck)`. A reply-less turn is **ineligible**, so
   it falls back to nothing — only the idle ceiling remains.

A no-reply turn therefore has exactly **one** finalizer (its own attributed Stop grace).
The moment a weak signal cancels that grace, the turn is orphaned.

## Why NOT "stop pane-thinking cancelling the grace"

The obvious one-liner — exclude `pane-thinking` from grace cancellation — **reintroduces
a real regression**. The grace+cancel exists to reject a *stale/foreign* Stop: a Stop
from a foreign claude cycle (lagged ndjson delivery, `/compact`, a ScheduleWakeup cycle)
can land on the single live pending and begin a grace; if the real turn is genuinely
working, its activity must cancel that foreign grace. When the real turn is mid-**pure
thinking** it fires NO hooks — its *only* activity signal is `pane-thinking`. Remove
`pane-thinking` as a canceller and a foreign Stop would finalize the live turn with
foreign text. So `pane-thinking` must stay a canceller.

## Design — fix defect #2 (give the no-reply turn the backstop it's promised)

Make a no-reply turn that has an **attributed Stop captured** (`pending._stopHookData`)
eligible for the rung-2 activity-quiet finalize — **but only while that Stop is still the
latest word**, i.e. no work hook has arrived since it was captured. Centralize it:

```js
/**
 * Eligible for the rung-2 activity-quiet finalize when the answer is already
 * captured where a finalize can deliver it:
 *   - a delivered FINAL reply (went out incrementally), OR
 *   - seen + consumed-acked (answer rode a sibling turn_id), OR
 *   - an attributed Stop captured the answer AND no work hook has fired since
 *     (claude is genuinely done, not resumed into more work). A resumed turn
 *     fires PreToolUse/etc. that bumps _lastHookEventAt past the capture; a
 *     still-streaming turn re-arms via pane-thinking. This is the rung-2 fallback
 *     the grace-cancel path promises but reply-less turns never had.
 * An interim-only turn with no captured answer stays ineligible (must keep working).
 */
_activityQuietEligible(pending) {
  if (this._turnHasFinalReply(pending)) return true;
  if (pending.seen === true && pending._consumedAcked === true) return true;
  if (pending._stopHookData
      && (this._lastHookEventAt || 0) <= (pending._stopHookDataAt || 0)) return true;
  return false;
}
```

`_stopHookDataAt` is stamped wherever `_stopHookData` is set (the Stop handler captures —
`_beginAttributedStopGrace` `:1836`, the deferred-refresh `:3061`, the legacy onStop
`:1935`). Stamp it `= this._lastHookEventAt` (the Stop's own hook time — those sites all
run synchronously inside `_handleHookEvent`'s `case 'Stop'`, after `_lastHookEventAt` is
set to the Stop's time at `:2876`). A small `_captureStopHookData(pending, info)` helper
sets both fields so no site drifts.

Both `_armActivityQuiet` and `_activityQuietFinalize` replace their inline eligibility
clause with `if (!this._activityQuietEligible(pending)) return;` (keeping their separate
`_openQuestions` / `_stopGracePending` / `_sawHookStream` gates unchanged).

**Why the hook-recency clause, and why it replaces a sub-agent gate.** The naive form
(`_stopHookData` set, full stop) prematurely finalizes a turn that fired its Stop early
(foreign/lagged cycle, or a boundary Stop) and then **resumed into a long silent tool**:
no streaming hint for >`activityQuietMs`, so pane-thinking never re-arms, and rung-2
delivers the **stale** captured text over a still-working turn. Claude resuming ALWAYS
emits a work hook (PreToolUse) that bumps `_lastHookEventAt` (`:2876-2879`, which also
shows Stop is deliberately NOT counted as work) — so `_lastHookEventAt <= _stopHookDataAt`
("nothing happened since the Stop") is the exact "claude is genuinely done" test. It also
**subsumes an explicit sub-agent gate**: a running sub-agent fires hooks after any
boundary Stop, so it fails the clause without needing the proc-wide
`_pendingSubagentStarts` counter — which avoids a leak where a lost `SubagentStop` sticks
the counter `>0` and permanently re-disables the rescue.

Add one telemetry marker so the soak can count rescues: when `_activityQuietFinalize`
finalizes a turn that qualified **only** via the new `_stopHookData` path (no final
reply, not consumed-acked), emit `cli-noreply-stop-rescued`
`{turn_id, last_hook_age_ms, text_len}`.

### Trace through the fix (the Chrome wedge)

```
17:53:06.172  pane-thinking cancels grace → _armActivityQuiet now ELIGIBLE (_stopHookData set)
              → 18s activity-quiet timer armed
17:53:06–24   no further activity for the root session (unknown-prompt doesn't note activity)
~17:53:24     _activityQuietFinalize → _resolveTurnDelivery (zero replies) →
              delivers last_assistant_message (the Chrome answer); emits cli-noreply-stop-rescued
```
60-min dead-air → ~18s resolution that delivers the real answer.

## Why this is safe (no regressions)

- **Foreign-Stop rejection preserved.** `pane-thinking` still cancels the grace. A
  foreign Stop on a still-streaming turn: grace cancelled, activity-quiet armed, but
  `pane-thinking` keeps firing every 5s → keeps **re-arming** (resetting) the 18s timer
  → never fires while the turn streams. The real turn's own Stop later refreshes
  `_stopHookData` and delivers.
- **No stale-text on a resumed turn (the audit's MEDIUM finding).** If a Stop captures
  text early and claude then **resumes into a long silent tool** (no streaming hint, so
  pane-thinking can't re-arm), the resume's PreToolUse hook bumps `_lastHookEventAt` past
  `_stopHookDataAt` → `_activityQuietEligible` returns false → rung-2 does NOT fire on the
  stale text. The turn keeps working; its real end-of-work Stop delivers the right answer.
- **Sub-agent work protected without a counter.** A running sub-agent emits work hooks
  after any boundary Stop → the hook-recency clause blocks rung-2 (same mechanism as
  above), so an in-flight sub-agent — even one silent on one long tool — can't trip a
  premature finalize. No dependency on `_pendingSubagentStarts`, so a lost `SubagentStop`
  can't stick a counter and permanently re-disable the rescue.
- **No double-deliver.** `_armActivityQuiet`/`_activityQuietFinalize` both early-return
  while `_stopGracePending`; a late grace fire and `_finalizeTurn` are idempotent
  (`pendingTurns.delete`). The activity-quiet and a re-armed grace cannot both deliver.
- **Still-working turns unaffected.** A seen-but-no-Stop, no-reply turn has no
  `_stopHookData` → stays ineligible → only the ceiling applies, exactly as today.
- **Interim-only strengthened, not broken.** An interim-only turn that then fires a Stop
  (no work hook after) becomes eligible and delivers its distinct final answer via
  `_resolveTurnDelivery`'s interim branch — consistent with 0.17.1.
- **Multi-pending caveat (accepted).** `_lastHookEventAt` is proc-wide, so in the rare
  case of two concurrent turns in one CliProcess, a sibling turn's hook can block this
  turn's rescue → it falls to the ceiling. That is the safe direction (slower, never a
  wrong/stale answer); not worth per-pending hook tracking for a rare path.

## Test / verification plan (TDD — red→green)

`tests/cli-process-finalizer-ladder.test.js` (real timers, small ms — model on the
existing L9e `:515` and L11 `:544`):

1. **Wedge repro (the headline red test).** Drive: pickup (seen) → no reply → Stop hook
   with `lastAssistantMessage` → `_noteActivity('pane-thinking')` **synchronously** (so
   the cancel lands before the grace fires) → `sleep(> activityQuietMs)` with NO further
   activity. **Before the fix:** `pendingTurns.size === 1` (orphaned). **After:** the turn
   finalizes, delivers `lastAssistantMessage`, emits `cli-noreply-stop-rescued`.
2. **Resume-into-tool does NOT finalize stale text (the audit's MEDIUM, second red).**
   Stop captures `ANSWER_A` → pane-thinking cancels grace → a **work hook** (e.g.
   PreToolUse) fires *after* the Stop → `sleep(> activityQuietMs)`. Assert NOT finalized
   on `ANSWER_A` (`_lastHookEventAt > _stopHookDataAt`); the turn still works; its later
   real Stop (`ANSWER_B`, no hook after) delivers `ANSWER_B`.
3. **Foreign-Stop on a streaming turn (regression guard).** Foreign Stop → keep firing
   `pane-thinking` every <`activityQuietMs` → timer keeps resetting → no finalize. Then
   the turn's own real Stop delivers the real (not foreign) text.
4. **Still-working no-Stop turn unaffected.** Seen, no reply, no Stop → ineligible → not
   armed (only the ceiling).
5. **No double-deliver on late grace.** Activity-quiet finalizes; a Stop arriving after
   no-ops (pending already deleted).

Real-claude E2E: the in-pane-answer-without-reply-tool path is hard to force
deterministically; rely on the unit repro for red→green, plus a VPS soak watcher counting
`cli-noreply-stop-rescued` vs `turn-timeout (reason=idle, zero-reply)`.

## Rollout

Patch bump (bug fix) → 0.17.5. shumabit/shumorobot. Soak metric: zero-reply
`turn-timeout` rate ↓ toward 0; `cli-noreply-stop-rescued` catching the wedges; no new
double-answer reports; no premature-finalize regressions.

Related: `docs/lost-stop-wedge-rescue-spec.md` (superseded root cause),
`docs/0.13-turn-wedge-autorecovery-spec.md`, `docs/progress-is-not-turn-end-spec.md`.

---

# Follow-up — the rung-2 rescue is defeated by a trailing `SubagentStop`

**Status:** BUILT · CLI/channels backend (`lib/process/cli-process.js`,
the `_handleHookEvent` work-hook counter — orphan-`SubagentStop` conditional). Tests L20-L22
in `tests/cli-process-finalizer-ladder.test.js` (L18 matched-case + L16 resume-guard stay
green). Field-confirmed by production forensics
(shumabit@UMI group "return" topic `-1003369922517:37`, 2026-06-29 18:48 Europe/Madrid),
with the loss corroborated against Claude's own session transcript.

## Problem (one sentence)

The rung-2 no-reply backstop this spec shipped (0.17.5) has **never once fired in
production** — `cli-noreply-stop-rescued = 0` across all of shumabit's history despite 73
`cli-stop-grace-cancelled` events — because a `SubagentStop` hook that *trails* the
attributed Stop bumps `_workHookSeq` past the Stop's snapshot, so `_activityQuietEligible`
rules the turn "claude resumed work" and the rescue stands down; the no-reply turn then
orphans to the idle ceiling exactly as before and the captured answer is dropped.

## Evidence (the "return"-topic incident, both sides)

User said "merged" → turn `3af907f5` (picked up 18:45:02, `seen=true`), **zero replies**.

Polygram side (events DB):
```
18:48:45  hook Stop fires        → _captureStopHookData: _stopHookDataSeq = _workHookSeq (=N)
18:48:45  cli-stop-grace-cancelled source:"pane-thinking"   ← grace killed (the race this spec fixes)
          → _armActivityQuiet armed (eligible at this instant: _workHookSeq N == _stopHookDataSeq N)
18:48:49  hook SubagentStop      → _workHookSeq = N+1  (a NON-Stop hook) AND _noteActivity re-arms idle ceiling
          → rung-2 fire re-checks _activityQuietEligible: N+1 != N → INELIGIBLE → stands down
18:48:49→18:58:20  cli-mid-turn-unknown-prompt ×20 (idle pane, no _noteActivity)
18:58:49  idle ceiling fires (18:48:49 + idle window, exact) → "⏱ went quiet", answer DROPPED
```

Claude side (transcript `7bb3ee2c-…jsonl`): Claude ran the full turn (checked PR #62/#63,
acknowledged "changing with js bad idea", stripped the JS, committed/pushed, re-synced
#63, verified the live site) and **produced a complete final assistant message at
18:48:44** ("Two things to flag: 1. JS removed — H1 can't change cleanly…") — one second
before the Stop. **No `Agent`/Task tool was used in this turn**, so the 18:48:49
`SubagentStop` was a *late / orphan* teardown hook, not this turn's work. There is no
Claude-side failure: it answered; polygram dropped the answer.

Systemic, not a one-off (shumabit, all-time):
- 73 `cli-stop-grace-cancelled`; **62 % (45)** have a `subagent-done` within 10 s *after*
  the cancel — the exact poison window.
- **46 %** of the last 200 stop-resolved turns have a `subagent-done` within 10 s after —
  trailing `SubagentStop` is a routine teardown artifact, not rare.
- `cli-noreply-stop-rescued = 0`; `turn-timeout = 66`.

## Root cause

`_handleHookEvent` (`cli-process.js` ~2956) splits hooks into "terminal" and "work":

```js
if (ev.type === 'Stop') {
  this._lastHookEventAt = Date.now();                 // terminal: not work, not activity
} else if (ev.type && ev.type !== 'parse-error' && ev.type !== 'unknown') {
  this._lastHookEventAt = Date.now();
  this._workHookSeq = (this._workHookSeq || 0) + 1;   // ← SubagentStop lands HERE
  this._noteActivity(`hook:${ev.type}`);              // ← and cancels an in-flight Stop grace
}
```

Only `Stop` is excluded. `SubagentStop` is *also* a terminal signal ("a sub-agent
finished") — the opposite of "claude resumed work" — yet it (1) increments `_workHookSeq`,
withdrawing rung-2 eligibility, and (2) calls `_noteActivity`, which `_cancelStopGrace`
would use to kill a legitimate attributed Stop grace (rung-1) the same way `pane-thinking`
does.

**But the classification is context-dependent (the spec-review correction).** A naive
"`SubagentStop` is always terminal" is *wrong* — and would break the existing L18 test
(`tests/cli-process-finalizer-ladder.test.js:641`). There are two distinct `SubagentStop`
shapes, distinguished by `_pendingSubagentStarts` at the moment the hook is processed
(i.e. before the switch-case splice at `:3076-3079`):

- **Matched** (`_pendingSubagentStarts.length > 0`): this cycle's sub-agent really
  finished. A *boundary* Stop can be captured while a sub-agent is in flight (the main
  agent's `Task` await is interrupted by a lagged/boundary Stop — `_beginAttributedStopGrace`
  defers on exactly this, `:1905-1927`). Here the captured text **is** stale and the
  `SubagentStop` legitimately withdraws rung-2 eligibility — *especially* for a **tool-less
  sub-agent** that emits no inner `PreToolUse`/`PostToolUse`, where `SubagentStop` is the
  only post-boundary signal. This must keep bumping `_workHookSeq` + noting activity. (L18.)
- **Orphan** (`_pendingSubagentStarts.length === 0`): a late / lagged / foreign teardown
  hook with **no matching in-flight start** — the production "return" incident. It is *not*
  this cycle's work and must be terminal: no `_workHookSeq` bump (else it withdraws a valid
  rescue), no `_noteActivity` (else it cancels a valid Stop grace).

So the **ordering argument is narrower** than first stated: a `SubagentStop` after the main
agent's *real terminal* Stop (no sub-agent in flight, count 0) is always lagged/foreign and
is correctly terminal; a `SubagentStop` after a *boundary* Stop (count > 0) is this turn's
real work completing and must still block. The discriminator is `_pendingSubagentStarts`.

**Empirical confirmation (shumabit, the incident's session):** at the "merged" Stop-capture
(18:48:45) `_pendingSubagentStarts` count was **0**; the 18:48:49 `SubagentStop` carried
`agent_type=""` with no matching start — a textbook orphan. Real sub-agents in that session
appear as `type="general-purpose"` start/done **pairs** (17:44→17:49, 18:01→18:04); orphan
`type=""` `SubagentStop`s (count never leaving 0) fire routinely after turns (~11 in the
17:40–18:49 window). Separately verified: sub-agent **inner** tool hooks DO reach this
stream and bump `_workHookSeq` (`lib/sdk/callbacks.js:582-587`, no agent_id filter in the
work branch) — so a *tool-using* in-flight sub-agent is already protected by its own
hooks; only the *tool-less* in-flight case relies on the matched-`SubagentStop` bump, which
this design preserves.

## Design — classify `SubagentStop` by whether a sub-agent is in flight

```js
if (ev.type === 'Stop') {
  this._lastHookEventAt = Date.now();
} else if (ev.type === 'SubagentStop' && !(this._pendingSubagentStarts?.length)) {
  // ORPHAN SubagentStop — a late/lagged/foreign teardown hook with no matching in-flight
  // start (the prod "return" incident: agent_type="", count 0). It is NOT this cycle's
  // work: terminal, like Stop. It must not bump the work-hook counter (the rung-2 no-reply
  // backstop reads a bump as "claude resumed", withdrawing the captured Stop's delivery)
  // nor count as activity (which would cancel a legitimate attributed Stop grace).
  this._lastHookEventAt = Date.now();
} else if (ev.type && ev.type !== 'parse-error' && ev.type !== 'unknown') {
  // Genuine work hooks (UserPromptSubmit / PreToolUse / PostToolUse) AND a MATCHED
  // SubagentStop (count > 0 — this cycle's sub-agent finishing; keeps withdrawing rung-2
  // eligibility on a boundary Stop, incl. a tool-less sub-agent — see L18).
  this._lastHookEventAt = Date.now();
  this._workHookSeq = (this._workHookSeq || 0) + 1;
  this._noteActivity(`hook:${ev.type}`);
}
```

The `switch (ev.type)` below is unchanged — `case 'SubagentStop'` still splices
`_pendingSubagentStarts` and emits `subagent-done` for the reactor; only the
activity/counter bookkeeping moves, and only for the orphan shape.

### Trace through the fix (the "return" incident — orphan, count 0)
```
18:48:45  Stop captures answer (_stopHookDataSeq = N); pane-thinking cancels grace, arms rung-2 (N==N)
18:48:49  SubagentStop, _pendingSubagentStarts empty → ORPHAN → terminal: seq stays N, grace untouched
~18:49:03 _activityQuietFinalize → eligible (N==N) → delivers "Two things to flag…",
          emits cli-noreply-stop-rescued
```
Idle-ceiling dead-air + dropped answer → ~18 s resolution that delivers what Claude said.

## Why this is safe (no regressions)

- **In-flight sub-agent still blocks the rescue — both shapes.** A *tool-using* sub-agent
  bumps `_workHookSeq` via its own inner `PreToolUse`/`PostToolUse` (verified on-stream); a
  *tool-less* sub-agent is covered by its **matched** `SubagentStop` still bumping. L18
  (matched, boundary Stop) stays green; L16's resume-into-tool guard (`PreToolUse`) is
  untouched.
- **Reviewer-2 foreign-grace-defer race handled.** `_beginAttributedStopGrace.fire()`
  re-arms while `_pendingSubagentStarts > 0`; the `SubagentStop` that drains that count is
  by definition **matched** → it still `_noteActivity`s (cancelling the deferred
  foreign/stale grace) AND bumps `_workHookSeq` (rung-2 ineligible) → the foreign text is
  neither grace-delivered nor rescue-delivered; the real Stop delivers. Only the *orphan*
  shape (count 0, never deferring) skips `_noteActivity`, where there is no deferred grace
  to protect.
- **Rung-1 for the orphan case (two-directional — the honest trade).** A trailing orphan
  `SubagentStop` no longer cancels an attributed Stop grace. For a *legitimate* grace this
  is the win (L22: rung-1 delivers). The counter-case: pre-fix, an orphan that chanced to
  land inside the 2 s grace window *incidentally* cancelled a **foreign/lagged** attributed
  Stop grace on a still-thinking `seen` turn; post-fix it doesn't, so in that narrow window
  a foreign answer can be rung-1-delivered where before it was rejected. LOW severity and
  largely pre-existing — that foreign-Stop rejection was best-effort anyway (pane-thinking
  ticks ~5 s, the grace fires at 2 s, so a pure-thinking turn is unprotected in that gap
  regardless). Accepted; the correct-for-legit-graces behavior is worth it.
- **No double-deliver.** Unchanged: `_armActivityQuiet`/`_activityQuietFinalize` early-return
  while `_stopGracePending`; `_finalizeTurn` is idempotent (`pendingTurns.delete`).
- **`_pendingSubagentStarts` defer (L11) unaffected** — that path keys on the start counter,
  which this design reads but does not mutate (the splice stays in the switch case).

### Residual limitation (accepted, noted)

The discriminator is `_pendingSubagentStarts.length`. If a prior cycle **lost** its
`SubagentStop`, a stale entry can stick the counter `> 0` (a pre-existing fragility the
0.17.5 spec already named), which would misclassify a later orphan as matched → bump → the
false timeout persists for that turn. This fix is a **strict improvement** over today (today
*every* `SubagentStop` bumps) and is no worse in the stuck-counter case. The stuck-counter
root cause is out of scope; a `_pendingSubagentStarts` reset on turn finalize is a candidate
follow-up.

## Rejected / deferred alternatives

- **Blanket "`SubagentStop` is terminal"** (the first draft): breaks L18 and reopens the
  tool-less in-flight stale-finalize regression (L16's failure mode). Rejected by review.
- **Eligibility-side fix** (special-case in `_activityQuietEligible`): spreads the
  SubagentStop special-case across read sites and leaves `_noteActivity` cancelling rung-1.
  The producer-side classification is one place.
- **Allowlist the work hooks** (bump `_workHookSeq` only on
  `UserPromptSubmit`/`PreToolUse`/`PostToolUse`): the structurally-correct class fix, but it
  *also* drops the matched-`SubagentStop` bump that L18 needs, so it can't stand alone here.
  Tracked as a follow-up if more terminal/passive hooks are shown to poison.
- **`Notification` (idle-attention variant)** (`cli-process.js:3190-3216`, `toolName` null):
  a *passive* signal that nonetheless `_noteActivity`s, resetting the idle ceiling — an
  "idle" hook cancelling the idle timeout. No production evidence yet (and bypassPermissions
  suppresses the permission variant); deferred, but named here. (`PreCompact`/`PostCompact`
  same lifecycle class. `SessionStart` is **not** in `KNOWN_EVENT_NAMES` → normalizes to
  `'unknown'` → already excluded; only relevant if upstream adds it.)

## Test / verification plan (TDD — red→green)

`tests/cli-process-finalizer-ladder.test.js`. Note L18/L19 are taken — the new test is
**L20**; existing L18 must stay green (it is the matched-`SubagentStop` guard).

1. **L20 — headline red→green (orphan).** Pickup (`seen`) → no reply → `Stop`
   (`lastAssistantMessage`) → `_noteActivity('pane-thinking')` (cancels grace, arms rung-2)
   → `_handleHookEvent({ type: 'SubagentStop' })` with `_pendingSubagentStarts` **empty** →
   `sleep(> activityQuietMs)`. **Before:** `pendingTurns.size === 1` (orphaned), no
   `cli-noreply-stop-rescued`. **After:** finalized, delivers `lastAssistantMessage`
   (`alreadyDelivered:false`), emits `cli-noreply-stop-rescued`.
2. **Existing L18 (matched) must stay green.** `_pendingSubagentStarts = [{agentType:'g'}]`,
   boundary `Stop`, pane-thinking cancel, `SubagentStop {agentType:'g'}` → eligibility
   withdrawn → NOT finalized on the boundary text; the real Stop delivers. (Pins the
   matched branch.)
3. **L16 regression guard (must stay green).** `PreToolUse` after the Stop → still
   ineligible → no stale finalize. Confirms genuine work hooks still bump.
4. **Reactor unaffected.** Assert an orphan `SubagentStop` still emits `subagent-done`
   (the switch case must keep running after the bookkeeping branch).
5. **Rung-1 protection (orphan).** An orphan `SubagentStop` during an undisturbed attributed
   Stop grace must NOT cancel it — the grace finalizes and delivers normally.

Real-claude E2E is hard to force deterministically; rely on the unit repros, plus a VPS
soak watcher: `cli-noreply-stop-rescued` should go from 0 → catching the wedges, and
zero-reply `turn-timeout` should fall.

## Rollout

Patch bump (bug fix). shumabit + shumorobot. Soak: `cli-noreply-stop-rescued > 0`,
zero-reply `turn-timeout` ↓; no new double-answer reports; no premature-finalize
regressions. (Mode B — the busy-aware single-probe absolute checkpoint, shumorobot Music
2026-06-28 — is tracked separately and out of scope here.)
