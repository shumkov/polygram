# Typing should stop when the bot finishes, not when the lifecycle catches up

**Status:** spec · v2 (narrowed after review) · `lib/feedback/session-feedback.js` +
`lib/sdk/callbacks.js`. Field-confirmed (shumabit Ivan DM `68861949`, 2026-06-26).

> **Review outcome (3-persona: feasibility / adversarial / scope).** The v1 design — a
> general "activity-idle timer" driving typing pause/resume off the process activity
> surface — was **rejected**. It (a) reintroduced the stuck-on bug: `_noteActivity` is
> process-wide and turn-agnostic, so a sibling turn / autosteer / pane-thinking / another
> turn's sub-agent would revive a quiet turn's typing; (b) didn't even fix the headline
> incident — the autonomous-cycle typing isn't on the activity surface, and session-shared
> activity has the *same* conflation; (c) required replacing typing.js's single `paused`
> boolean with an owner-set (a plain boolean can't take two pause-writers safely). All
> three reviewers converged on the narrowed, **delivery-based** fix below.

## Problem

The "typing…" indicator keeps spinning after the bot has visibly finished. The egregious,
field-confirmed case is the **autonomous self-check cycle**: its typing is torn down by
`endCycle`, fired from the Process `'idle'` event (`callbacks.js:339`) = `pendingTurns→0`
— a **session-level** edge. A later turn starting before the session idles delays it.

## Evidence (shumabit.db, Ivan DM 68861949, 2026-06-26)

```
07:03:47  autonomous-cycle-visuals start   → session typing on (anchor=∅, typing only)
07:06:57  msg #30734 out "✅ Done — all 17 comments processed"   (answer delivered)
07:11:38  msg #30735 in  "check comments"   (Ivan — new turn, same session)
07:16:41  autonomous-cycle-visuals end      → endCycle → typing off   (774s; ~10 min
          PAST the delivered answer — held alive by the 07:11 follow-up's session activity)
```

(A second, minor surface — the per-turn ~18s typing tail before finalization — is
**out of scope**; see below.)

## Root cause

The cycle's typing teardown (`endCycle`) keys on *session* idle, not on *the cycle's own
completion*. So it conflates with any later turn and waits for the whole session to settle.

## Design — stop the cycle's typing at its own delivery

Stop the autonomous cycle's **typing** when the cycle delivers its answer — the
`onAutonomousAssistantMessage` callback (`callbacks.js:210`), which fires once per
delivered autonomous message (all three delivery paths: already-delivered :227, helper
:275, legacy :296). The anchor 🤔 and entry teardown stay on `endCycle` (unchanged).

- **`lib/feedback/session-feedback.js`** — add `stopCycleTyping(sessionKey)`: if there's
  an active cycle entry not already typing-stopped, call its `stop()` (tears down the
  typing loop) and set an idempotency flag; **leave the entry** so `endCycle` still clears
  the anchor + logs end. Emit `autonomous-cycle-visuals {state:'typing-stopped'}`.
- **`lib/sdk/callbacks.js` `onAutonomousAssistantMessage`** — after `if (!text) return;`
  (line 218), `sessionFeedback?.stopCycleTyping(sessionKey)`.

**Why delivery, not activity** (the v1 trap): a delivery-based stop is immune to the
shared-session conflation — a later turn's activity is irrelevant; we stop on the cycle's
*own* output. No process activity coupling, no proc-wide revive, no second pause-writer.

### Trace through the fix
Cycle delivers at 07:06:57 → `onAutonomousAssistantMessage` → `stopCycleTyping` → typing
loop torn down at ~07:06:57. `endCycle` still fires at 07:16:41 (Process idle) and clears
the (absent) anchor + entry — but the *visible* typing already stopped at delivery.

## Explicitly OUT of scope (per review)

- **General activity-idle typing** — reintroduces proc-wide stuck-on (adversarial F1); the
  whole reason v1 was rejected.
- **The per-turn ~18s tail** — bounded and minor; a *correct* fix needs per-turn activity
  attribution, which is the same stuck-on hazard. Not worth the risk for 18s.
- **typing.js `paused`-boolean → owner-set refactor** — only needed if a second
  *pause*-writer is added. This fix STOPS the cycle typing (full teardown), it does not add
  a second pause source, so the boolean stays single-writer and safe.
- **SDK-specific work** — both incidents were cli; `onAutonomousAssistantMessage` is
  backend-shared, so SDK rides the same fix with no extra code.

## Failure modes / invariants

- **Multi-message cycle:** a cycle that posts "working…" then later "done" stops typing at
  the *first* message. Acceptable — the user has visible text; if the cycle was anchored,
  the 🤔 reaction (kept until `endCycle`) remains the durable "still working" signal; there
  is no autonomous-typing *resume* by design, so no flicker.
- **Idempotent:** `stopCycleTyping` twice (multi-delivery) → second is a no-op
  (`typingStopped` guard). `endCycle` after → `entry.stop()` idempotent, anchor clear,
  entry delete — unchanged.
- **No leak / no teardown change:** `stopCycleTyping` does NOT remove the entry;
  `endCycle`/`onClose` remain the sole entry teardown, so no path is left dangling.
- **Unknown session:** `stopCycleTyping('999')` with no active entry → no-op.

## Test / verification plan (TDD — `tests/p4-session-feedback.test.js`)

1. **stopCycleTyping stops typing before endCycle (the fix):** `startAutonomousCycle` →
   typing actions accrue → `stopCycleTyping` → actions plateau (BEFORE any `endCycle`).
   Red pre-fix: no such method / typing runs until `endCycle`.
2. **endCycle still works after stopCycleTyping:** anchored cycle → `stopCycleTyping` →
   `endCycle` → 🤔 cleared, entry removed, no throw.
3. **Idempotent + unknown:** double `stopCycleTyping`; `stopCycleTyping` on unknown
   session is a no-op.
4. **Callbacks wiring:** `onAutonomousAssistantMessage` (a delivered message) calls
   `sessionFeedback.stopCycleTyping(sessionKey)`.
- **Prod soak:** the gap between an `autonomous-wakeup-message` and the cycle's typing
  going quiet collapses from minutes to ~0; `autonomous-cycle-visuals {state:'typing-stopped'}`
  appears at delivery time, before the `end` event.

Related: `docs/0.13-channels-lifecycle-design.md` (D3 session feedback),
`docs/stop-grace-cancel-race-spec.md` (0.17.5).
