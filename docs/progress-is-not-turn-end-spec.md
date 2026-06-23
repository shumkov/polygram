# Progress is not the end of work — deliver the result, don't drop it

**Status:** spec v2 (post 4-reviewer pass) · **Cut 1 + B3 BUILT + tested**
(A1/A2/B1/B4 + B3); **B2 dropped** (Ivan: not needed) · CLI/channels backend.
Field-confirmed by Ivan (shumabit@UMI, "conversion" topic, 2026-06-22).
Tests: `cli-process-finalizer-ladder.test.js` L9/L9b/L9c/L9d (deterministic
red→green for the dropped-answer fix), `status-reactions.test.js` +
`sdk-callbacks.test.js` (B3 reactor work-in-flight + wiring),
`e2e-channels-real-claude.test.js` "interim status then a delivered final answer"
(real-claude integration).

## Target behavior (user's words)

> "It's fine it's saying 'I'm doing something' — but that shouldn't be seen as the
> end of work. We should see the work progressing, whatever time it takes, and then
> it replies the result."

A status ("⏳ doing X…") is good and stays. It must NOT count as the turn's answer.
The turn keeps running, stays visibly alive, and the result is delivered — **without
the user having to prod.**

## Evidence (isolated trace, thread 2251 "conversion", 2026-06-22 UTC)

```
15:58:45  BOT  ← "📱 Loading your real product page… Give me a couple min…"  (STATUS reply)
15:58:50  reaction 👨‍💻 (sub-agent runs)
16:00:51  subagent-done                       ← the work FINISHED (answer was produced)
16:01:58  cli-turn-resolved-by-stop → reaction REMOVED  ← turn ends; only the STATUS delivered
   ⟶ 19 min dead air
16:21:06  USER → "how is it going?"            ← prod
16:21:24  BOT  ← "Both answered with data…"    ← real answer, 18s later (it already existed)
```

The answer was **produced** (it came back in 18s once prodded) and then **dropped** —
not "never generated." That makes this primarily a delivery bug, not a re-prompt problem.

## Root cause (two layers)

1. **Claude ended the turn after the status reply** (its Stop hook fired). The prompt
   already says "send a status, then a fresh final reply" (`cli-process.js:771-792`) but
   **never forbids ending a turn on a status** — so Claude stopped.
2. **polygram dropped the produced answer.** A status and a real answer are both `reply`
   tool calls pushed to `pending.replies` (`:1470`) — indistinguishable. With
   `replies.length ≥ 1`, `_finalizeTurn` sets `alreadyDelivered = hadReplyToolCalls`
   (`:1948`) and the Stop-fallback rescue is skipped (`usedStopFallback` needs *no* reply
   text, `:1933`). So the real answer in `last_assistant_message` is never delivered —
   the **same drop hole** `docs/0.13-consumed-ack-stop-fallback-drop-spec.md` closed for
   the consumed-ack case, now via the interim-reply case.

   **Plus a second collision (found in review):** a status reply makes `replies.length > 0`,
   which **disqualifies the turn from the 0.16 busy-aware extension** — `_checkpointAbsolute`
   force-resolves any replied turn (`:2382-2385`) instead of extending a still-working one.
   So the status doesn't just look done — it actively cancels the "keep a working turn alive"
   machinery.

## Plan — Cut 1 (the fix) and what's deferred

### Cut 1 — ship this (closes the incident, low risk)

**A2 — prompt rule (the root-cause behavioral lever).** Harden `cli-process.js:771-792`:
a status reply is a *mid-turn* update — you MUST deliver the result as a final (non-status)
reply in the SAME turn, and you must NEVER end a turn on a status. A status with no
following result is a broken promise. (One paragraph; targets "Claude stops after a status.")

**A1 — `interim:true` on the reply tool (fail-safe signal).** Add an optional `interim`
boolean to the reply schema (`channels-bridge.mjs:313-329`; no protocol change — the zod
`args` is `.passthrough()`). Claude sets it on a status. **Fail-safe default: a reply
WITHOUT the flag is treated as FINAL** (today's behavior) — so if Claude forgets the flag,
no regression; if Claude sets it, we get the fix. (Do NOT invert to interim-by-default —
that moves the error budget onto the common quick-answer path.)

**B1 — interim-aware finalize/resolve, at ALL sites.** Track `pending.hasFinalReply`
(a non-interim reply landed). An interim reply pushes to `replies` for delivery bookkeeping
but does NOT count as the turn's answer. Apply this at **every** finalize/resolve site, not
just one: `_finalizeTurn` (`:1948`), activity-quiet (`:1761`, `:1794`), and the absolute
checkpoint (`:2382`) — so an interim-only turn (a) is not marked `alreadyDelivered`/done and
(b) is NOT force-resolved by `_checkpointAbsolute` but **rides the existing 0.16 busy-aware
extension** (keeps working, fires the existing one-time "⏳ still working" `turn-extended`
ping, `:2417-2425`). This reuses the tested keep-alive path instead of inventing a new one.

**B4 — deliver the produced-but-undelivered answer.** When a turn finalizes with replies
that are ALL interim AND a substantive `last_assistant_message` exists that differs from the
delivered status text, deliver it via the Stop-fallback path. Reuse the existing
`consumedCoversFallback` text-mismatch discriminator (`:1946-1947`). **Deliver the FINAL
text only** — never re-join the already-delivered interim bubbles, or they re-send. This is
the load-bearing fix: in the incident the answer existed; B4 delivers it with no prod.

Anti-hang for Cut 1 is unchanged: it relies on the **existing** 0.16 ceilings (idle, absolute
busy-aware, hard-max) — Cut 1 adds no new chain/loop, it only lets an interim-only turn use
the same extension a tool-only working turn already uses, bounded by the same `turnHardMaxMs`.

### Deferred — DO NOT build yet (measure first)

**B2 — auto-continue (synthetic re-prompt).** Only helps the *residual* case A2 doesn't fix:
Claude stops AND produced no answer text (so B4 has nothing to deliver). Reviews found it
carries serious bugs as sketched — the loop guard, idle ceiling, and hard-max are all
**per-turn** while auto-continue spans **multiple turns** (fresh `turnId`/`startedAt`/`pending`
each continue → every bound resets → unbounded loop + defeated ceilings); it must acquire
`intentLock` and cancel on a real user message to avoid autosteer collisions; and a synthetic
"finish the work" prompt risks visible artifacts (re-greet, double-answer) in a partner topic.
**Gate on telemetry:** after A2+B4 ship, count turns that finalize interim-only with an
*empty* `last_assistant_message`. Build B2 only if that rate is non-trivial — and then with
explicit **chain-level** state (chain id, chain wall-clock, continue-cap=1), `intentLock`,
default-off.

**B3 — reactor keepalive (frozen reaction during quiet sub-agent runs).** A real but
SEPARATE bug: the incident's dead air was the turn *ending* (reaction cleared), which Cut 1
fixes; B3 is about a *working* reaction freezing (SUBAGENT state isn't in `STALL_PROMOTABLE`
so `heartbeat()` can't hold it and the stall/freeze timer fires over 👾 — `reactions.js:235/450`;
typing already self-sustains via `typing.js:123`, so only the reaction needs work). Ship as
its own reactor-freeze change after Cut 1.

## Must-fix details folded in (from review)

- B1 interim-awareness at **all four** finalize/resolve sites (`:1761`, `:1794`, `:1948`, `:2382`).
- The `_checkpointAbsolute` replied-turn branch (`:2382`) must treat interim-only as
  *unreplied/working* so the turn rides the busy-aware extension (this is the bridge to the
  user's separate timeout complaint).
- B4 delivers the **final text only**; `alreadyDelivered=false` path in polygram.js
  (`~:1414/1424`) then delivers `result.text` exactly once (guarded by `if (parsed.text)`),
  with the interim bubbles already on screen — no double-send.
- A1 is **fail-safe (final-by-default)**; B4's text-mismatch heuristic backstops a forgotten flag.
- Interim replies still carry `consumed_turn_ids` (fold contract, `:762-769`).
- Foreign/autonomous cycles (no attributed pending) untouched — gate on `seen||replied` (`:2919`).

## Test / verification plan (real-claude E2E = the proof)

Extend `tests/e2e-channels-real-claude.test.js`: a prompt that makes Claude post an
`interim:true` status, run a sub-agent >5s, then (under A2) deliver the result in the SAME
turn. Assert:
1. The status is delivered AND marked interim (not counted as the answer).
2. The turn is NOT finalized-as-done on the status; the reaction is NOT cleared while work
   continues; the turn rides the busy-aware extension (not force-resolved at the checkpoint).
3. **The final result is delivered with NO second user message** — the exact regression the
   trace shows (a prod was required). Goes green on A2+B1+B4 alone; **no B2 needed.**
Unit pins: interim-only turn → `hasFinalReply=false` → not `alreadyDelivered`; B4 delivers the
Stop-fallback answer (final-only) when prior replies were all interim; `_checkpointAbsolute`
extends (not resolves) an interim-only working turn.
