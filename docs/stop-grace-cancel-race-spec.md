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
