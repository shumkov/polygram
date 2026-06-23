# Lost-Stop wedge — recover the answer instead of timing out

> **SUPERSEDED (2026-06-24) by `docs/stop-grace-cancel-race-spec.md`.** Forensics on the
> exact field incident showed the premise here is wrong: the Stop hook is NOT lost — it
> arrives (2ms lag), begins an attributed grace, and a `pane-thinking` heartbeat *cancels*
> that grace 39ms later, orphaning the no-reply turn. The real fix (shipped 0.17.5) is the
> rung-2 backstop for a no-reply turn that captured a Stop, not a transcript/pane rescue.
> Kept for investigation history; do not build the design below.

**Status:** superseded · CLI/channels backend (`lib/process/cli-process.js`
`_pollMidTurnDialogs` + finalizer). Field-confirmed by Ivan (shumabit@UMI root topic,
2026-06-23).

## Problem

A turn where Claude ends WITHOUT calling the reply tool AND the Stop hook is lost gets
**stuck**: Claude has returned to an idle prompt with its answer rendered in its
terminal, but polygram has no resolution signal. Its only mid-turn pane watchdog
(`_pollMidTurnDialogs`, the `cli-mid-turn-unknown-prompt` branch, `cli-process.js:3907-3925`)
is **telemetry-only** — it logs every 30s and takes no action. So the turn dangles
until the **60-min idle ceiling** fires → the user gets *"⏱ This one went quiet with no
progress, so I stopped waiting."* **Claude's actual answer is lost.**

## Evidence (shumabit.db, UMI group root topic, 2026-06-23)

The Chrome-debug-over-tailnet conversation. Trace:
```
17:50:43  turn starts (folded with prior autosteered msgs incl. the Tailscale ACL paste)
17:53:11  cli-mid-turn-unknown-prompt — excerpt_head:
          "Next step — let's actually prove it. On your Mac (shumabook), I'll have you
           launch an isolated Chrome with the debug port, then I connect from the VPS
           over the tailnet and read a logged-in page."
17:53:11 → 18:03:01  cli-mid-turn-unknown-prompt ×18 (every ~30s, same idle pane)
18:03:06  turn-timeout (reason=idle, 3600000ms) → "⏱ went quiet"
```
Claude **produced a real, useful answer** (logged in the pane excerpt) — it was never
delivered. No `cli-turn-resolved-by-stop` for the turn (Stop hook lost); zero outbound
replies; reactor 🤔→🤓 (thought) then 🥱→😨 (stalled). The pane at timeout was just the
idle input bar (`⏵⏵ bypass permissions on …`), `streaming:false`.

## Root cause

1. Claude ended a turn without a reply-tool call — its answer is in the transcript /
   TUI, not delivered.
2. The Stop hook (which resolves a no-reply turn AND rescues `last_assistant_message`
   via the Stop-fallback, `_resolveTurnDelivery` `:1989`) never fired.
3. The mid-turn pane watchdog is passive — no recovery action.
→ The turn waits the full idle ceiling (60 min) and the answer is dropped.

## Design — active recovery on the idle-prompt wedge

In `_pollMidTurnDialogs` (the existing 5s pane poll during a turn), add a recovery path:
when the turn is UNRESOLVED and Claude is **idle at the prompt** for N consecutive polls
(~15-30s) — i.e. `!STREAMING_HINT_RE.test(pane)` (no "esc to interrupt"), the idle input
bar present, AND it's safe — RESOLVE the turn and DELIVER Claude's answer.

**Gating (don't resolve prematurely):**
- `_openQuestions.size === 0` (the poll already early-returns on this) — a question wait
  is legitimate idle.
- `_pendingSubagentStarts.length === 0` — a sub-agent run is legitimate work-in-flight
  (the 0.17.2 defer already holds these; don't fight it).
- No final reply already in flight (`!_turnHasFinalReply`) — a replied turn finalizes
  via the existing rungs.
- N **consecutive** idle polls (a counter reset on any streaming/activity), so a brief
  inter-step idle (Claude pausing between tools — which shows "esc to interrupt" anyway)
  cannot trigger it.

**Answer source (reliable → fragile):**
1. **Transcript JSONL (primary).** The path is derivable WITHOUT the Stop hook:
   `~/.claude/projects/<cwd-mangled>/<claudeSessionId>.jsonl` (`cli-process.js:668, 881`).
   Read the last assistant message(s) produced since `pending.startedAt`; deliver as the
   reply. This is the same clean source the Stop-fallback would have used — structured,
   not scraped.
2. **Captured pane (fallback).** If the transcript is unavailable/unreadable, strip the
   TUI chrome from the captured pane and deliver the last assistant block. Fragile
   (wrapping/markdown) — best-effort only.
3. **Last resort.** If neither yields substantive text distinct from any interim status,
   resolve with a short *"didn't finish — resend"* (so the user isn't stuck on silence).

**Delivery:** route through the existing `_resolveTurnDelivery` / a finalize so the
interim-aware + consumed-ack logic (0.17.1) still applies; deliver `alreadyDelivered:false`
since the reply tool never sent it. Log a `cli-idle-prompt-rescued` event.

Net: the 60-min dead-air + dropped answer becomes a **~20s resolution that delivers what
Claude actually said.** Recovers exactly the lost Chrome/tailnet answer above.

## Open questions (for review)

1. **Why is the Stop hook lost?** This rescue is a backstop; understanding the lost-Stop
   root cause (hook-stream death, a non-clean Claude exit, the folded-autosteer turn) may
   point at a more fundamental fix. Worth a parallel investigation.
2. **Idle-prompt detection precision.** Is `!STREAMING_HINT_RE` + the input-bar present a
   reliable "Claude is done" signal, or can Claude sit at the bar mid-work (e.g. waiting
   on a slow tool that stopped printing "esc to interrupt")? Tune N + the bar regex.
3. **Transcript "since turn start" boundary.** How to read only THIS turn's last assistant
   message from the JSONL (timestamp ≥ `pending.startedAt`? last-N entries?) without
   re-delivering an OLDER message — especially for a folded/autosteered multi-message turn.
4. **Double-delivery race.** If the lost Stop hook lands LATE (after the rescue), the
   stop-grace must not re-deliver. Idempotent `_finalizeTurn` (`pendingTurns.delete`) +
   marking the turn resolved must cover it.
5. **Cost.** Reading the transcript every poll is wasteful — only read on the resolve
   decision (after N idle polls), not every poll.

## Failure modes / invariants

- **No premature resolve:** the N-consecutive-idle + not-streaming + no-question +
  no-sub-agent gate must hold; a turn that's about to continue shows streaming/activity
  and resets the counter.
- **No double-deliver:** rescue routes through the single idempotent finalize; a late
  Stop hook no-ops.
- **Anti-regression:** a normally-resolving turn (reply + Stop, or activity-quiet) never
  reaches the rescue — it's gated on unresolved + idle + no-final-reply.
- **Bounded:** if the transcript read fails, fall back to "resend" — never hang.

## Test / verification plan

- **Wedge repro (unit):** drive a turn with no reply + no Stop + a fake pane (idle bar)
  + a fake transcript containing an assistant message → after N idle polls polygram
  resolves and delivers the transcript message (NOT "⏱ went quiet"), logs
  `cli-idle-prompt-rescued`.
- **No premature resolve:** a streaming pane ("esc to interrupt") never triggers; a brief
  idle (< N polls) then streaming resets the counter.
- **Excluded states:** open question / in-flight sub-agent → no rescue.
- **Late Stop:** a Stop hook arriving after the rescue does not double-deliver.
- **Transcript-unavailable fallback:** no transcript → "didn't finish — resend", not hang.
- **Real-claude E2E (if feasible):** a prompt that makes Claude answer in-pane without the
  reply tool is hard to force deterministically; rely on the unit repro for red→green.
