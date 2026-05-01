# Autosteer Contract Fix — Research & Recommendation

> **STATUS: SUPERSEDED by rc.42 (2026-05-01).** The d-hybrid /
> userTurnInFlight / MAX_ABSORBED design recommended below is NOT
> what shipped. The U7 spike (`scripts/spikes/native-queue.mjs`)
> verified that the SDK's native `priority: 'now' | 'next' | 'later'`
> on `SDKUserMessage` works without m87 rejection — the rc.9-era
> rejection that drove the autosteer-buffer + PostToolBatch detour
> is gone. polygram now uses `pm.injectUserMessage()` with native
> priority push. The buffer, the hook, the cap, and the hook-stop
> primitive plan are all deleted.
>
> This doc is kept for archaeological context: it documents WHY
> we built what we built, and the architectural mismatch we
> thought existed. The mismatch was real circa rc.9; the SDK
> evolved past it.
>
> See `scripts/spikes/native-queue.mjs` and `docs/u7-spike-result.txt`
> for the spike that obsoleted this plan.

> Status (original): research only. No code shipped. Implementation gated on review.
> Audience: ivanshumkov + future-me. Scope: polygram 0.8.0, SDK pm only.

---

## Executive summary

**What's broken.** Polygram treats *one SDK Query turn* (one `SDKResultMessage`) as the unit of "the bot is busy on the user's behalf". Under autosteer, that unit is no longer the right granularity. Every `PostToolBatch` drain feeds queued user follow-ups back into the same SDK turn via `additionalContext`; each absorption gives the agent more to do; the turn never reaches `end_turn`; the SDK never emits `result`; `entry.inFlight` never clears; every new user message takes the autosteer branch and gets ✍ instead of its own thinking turn. Production: chat 68861949, 2026-05-01 13:33→13:47, 4 user messages collapsed into 1 turn_metrics row (id 243, 243.4s, $1.82, 3 visible streamed replies).

**What rc.37 fixed (and didn't).** rc.37 wired `onDrained` so ✍ clears the *moment* a follow-up is absorbed. That makes the *visual* feel responsive again — but the underlying contract violation (one SDK turn ≠ one user-perceived turn) is untouched. Each additional follow-up still gets autosteered; each absorption still extends the same SDK turn; one turn_metrics row still bills 4 messages of work. Cost-attribution, abort semantics, idle-timeout semantics, and tool-only-completion fallback all still confuse "SDK turn" with "user turn".

**What to fix.** Treat `SDKAssistantMessage.message.stop_reason === 'end_turn'` as a **soft turn boundary**: it is the model's authoritative signal that *this* user-visible segment is a complete reply. Use it to split one SDK turn into multiple "logical turns" for inFlight/autosteer/cost-accounting purposes. Combine with a **drain-cap safety net** so a runaway tool loop with no end_turn gracefully degrades to FIFO queueing. Keep the buffer-and-PostToolBatch absorption mechanism — it's the *good* part of autosteer, and the user explicitly said don't disable it.

**Recommended fix.** Hybrid (option **d-hybrid** below): split inFlight per logical turn (signalled by `stop_reason==='end_turn'` after at least one assistant text segment), with a hard cap of `N=3` follow-ups absorbed per logical turn as a runaway breaker. ~120 lines of code; net-new tests; landed behind a kill-switch flag for one rc cycle, then on by default. No mechanism rebuild; the autosteer mechanism survives, gains a contract.

---

## SDK semantics — verified

> File paths below are absolute under
> `/Users/ivanshumkov/Projects/shumkov/polygram/node_modules/`.

### `SDKAssistantMessage` carries `stop_reason` per assistant message

`@anthropic-ai/claude-agent-sdk/sdk.d.ts:2334-2341`:

```ts
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;          // ← carries stop_reason
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
};
```

`@anthropic-ai/sdk/resources/beta/messages/messages.d.ts:977`:

```ts
stop_reason: BetaStopReason | null;
```

`messages.d.ts:1312`:

```ts
export type BetaStopReason =
  'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  | 'pause_turn' | 'compaction' | 'refusal'
  | 'model_context_window_exceeded';
```

Contract (from messages.d.ts:961-977):

- `'end_turn'` — model reached a *natural* stopping point.
- `'tool_use'` — model invoked one or more tools (and intends to continue after the SDK feeds tool_results back).
- `'pause_turn'` — long-running turn paused; can be continued by replaying the response.
- `'max_tokens'` / `'stop_sequence'` / `'refusal'` / `'model_context_window_exceeded'` — terminal in different ways.

In streaming mode this field is null in `message_start` and non-null otherwise. Polygram doesn't subscribe to `message_start`-level partials; it consumes whole `SDKAssistantMessage` events that carry the *final* `stop_reason` for that segment.

**Confirmation (lib/process-manager-sdk.js:432-481).** `head.streamText = added` is REPLACE not APPEND — each `SDKAssistantMessage` carries the complete BetaMessage for that segment, including the authoritative `stop_reason`. This is exactly the integration point we need.

### Distinguishing "complete reply" from "more tools coming"

Yes, fully distinguishable from each `SDKAssistantMessage` alone:

| `stop_reason`        | meaning                              | what SDK does next            |
|----------------------|--------------------------------------|-------------------------------|
| `'end_turn'`         | natural stop, segment is complete    | emit `result` shortly *unless* there are queued user inputs to absorb into the next assistant turn |
| `'tool_use'`         | model wants tools                    | run tools, fire `PostToolBatch`, send next API request |
| `'pause_turn'`       | server-paused, can resume            | emit `result` (or auto-resume internally per SDK semantics) |
| `'max_tokens'`       | budget exhausted                     | emit `result` with subtype error or success-truncated |
| `'refusal'`          | safety classifier intervention       | emit `result` with subtype error |
| `'compaction'`       | mid-turn compaction triggered        | continues post-compact_boundary |

**Critical:** `'end_turn'` after a non-empty text segment is the model's "I'm done answering" signal. It is generated regardless of what user input arrives next via PostToolBatch — the assistant emits stop_reason BEFORE we know whether more user text will be appended. So observing `'end_turn'` is reliable evidence that *this* segment was the closing reply for whatever set of user inputs the model had at that moment.

### When does `SDKResultMessage` (the `result` event) fire under a long-lived input AsyncIterable?

`sdk.d.ts:3138-3160` defines `SDKResultMessage`. The SDK emits exactly one `result` per `streamInput`-style turn. In the long-lived AsyncIterable model:

- Each `inputController.push(SDKUserMessage)` ultimately produces ONE `SDKResultMessage`.
- BUT: under autosteer, the model's inner agentic loop (text → tool_use → tool_result → text → tool_use → …) keeps running as long as `stop_reason='tool_use'` and there's another iteration's worth of work. `additionalContext` from PostToolBatch *doesn't* count as a new push to `streamInput` — it's smuggled in alongside the existing iteration's tool_results. The SDK considers the entire chain ONE turn from `streamInput`'s perspective: one user input → one result, even when 4 user messages contributed to that one chain.
- This is the contract violation. The 0.8.0 migration plan section §6.5 documents `pendingQueue maps N user msgs → N result events FIFO`, which is the model's expectation. PostToolBatch absorption silently breaks that 1:1 mapping by injecting user text WITHOUT pushing a new SDKUserMessage onto the input iterable. Net: 4 messages → 1 result.

**Empirical evidence.** Production trace 2026-05-01: msg 11853 dispatched at 13:33:25, ran ~14 min, absorbed msgs 11855/11856/11858 via autosteer, and `turn_metrics` row 243 records `num_turns=N` for that single chain (one DB row per `pm.send`). The two follow-up "user messages" 11855/11856/11858 were never `pm.send`'d — they only entered the buffer.

**Counter-test (rc.14 stale-drain).** `polygram.js:744-792` has the inverse case: when a turn produces ZERO tools (so PostToolBatch never fires), the buffer is left dirty and `drainStaleAutosteerBuffer` dispatches it as a *new* `pm.send` (= new pending = new result). That confirms: ONLY a new `pm.send` → new pending → new SDKResultMessage. Hook-injected text never births a new pending and never births a new result.

### Does `additionalContext` extend the *same* SDK turn?

Yes. `sdk.d.ts:1888-1899`:

```ts
/**
 * Hook input for the PostToolBatch event. Fired once after every tool call
 * in a batch has resolved, before the next model request. PostToolUse fires
 * per-tool ...; PostToolBatch fires exactly once with the full batch.
 */
export declare type PostToolBatchHookInput = ...;
export declare type PostToolBatchHookSpecificOutput = {
    hookEventName: 'PostToolBatch';
    additionalContext?: string;
};
```

"before the next model request" — additionalContext is concatenated with the upcoming message that already includes the tool_result blocks for the just-finished batch. The SDK does NOT split that into a new turn; it's one continuous agentic chain to the API. Confirmed by the spike result documented in lib/autosteer-buffer.js:18-23 — the marker was incorporated into "the assistant's final answer" of the same in-flight turn.

### Could the SDK emit `result` between tool batches?

Only if `stop_reason !== 'tool_use'` AND there are no more queued tool results to surface. Under autosteer, `stop_reason='end_turn'` would flip the SDK out of the agentic loop and into result emission — UNLESS the SDK chooses to auto-continue when `additionalContext` is non-empty in the same hook return. Reading sdk.d.ts in isolation, the type system doesn't tell us which semantic the SDK picked: PostToolBatch returning additionalContext after `stop_reason='end_turn'` is undefined behaviour by the type contract.

**Empirical evidence (live trace).** Production says: model emits `end_turn`-shaped reply text, hook drains buffer, agent proceeds to a NEW assistant message (visible as a new bubble in chat — that's the 3 streamed replies for one SDK turn). So either:
  (a) the model reached `end_turn`, the SDK saw additionalContext was non-empty and CONTINUED the turn (treats the additionalContext as new work), OR
  (b) the model reached `tool_use` 3 times in a row interleaved with text, and `end_turn` only fired on the very last iteration.

**Both cases are actionable for our fix:** if it's (a), our end_turn detector is the right boundary. If it's (b), the cap-at-N safety net catches it. The hybrid covers both.

### Stop hook — a third option

`sdk.d.ts:5247-5256`:

```ts
export declare type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;
    /**
     * Text content of the last assistant message before stopping. Avoids
     * the need to read and parse the transcript file.
     */
    last_assistant_message?: string;
};
```

The `Stop` hook fires when the agent decides to stop (i.e., when the SDK is about to emit `result`). It's a single fire-point per SDK turn — same granularity as `result` itself, *not* per-end_turn-segment. Useless as a turn-boundary detector for our purpose because it co-fires with `result`. Worth knowing it exists; we don't use it.

---

## Bug timeline analysis (Ivan DM 2026-05-01 13:33–13:47)

State machine notation:
- `S(inFlight)` = pm entry's `inFlight` flag for this sessionKey
- `B(n)` = autosteerBuffer size for this sessionKey
- `R(n)` = autosteeredRefs size for this sessionKey
- `Q(n)` = pendingQueue length on the entry
- `T(time)` = elapsed since msg 11853

```
T=0     msg 11853 arrives
        polygram.js:2451   willAutosteer = false (S=false)
        polygram.js:2458   reactor.setState('THINKING') → 🤔
        polygram.js:2545   sendToProcess → pm.send → entry.inFlight=true; Q=1
                           SDKUserMessage pushed onto inputController
        State: S=true, B=0, R=0, Q=1
        SDK starts API request

        ... tool_use loop A ...

        SDKAssistantMessage A1 (text + tool_use, stop_reason='tool_use')
        polygram.js:3608   onAssistantMessageStart → streamer.forceNewMessage
        polygram.js:3558   onStreamChunk → streamer renders text → bubble #1 visible
        Tools run.
        PostToolBatch hook fires → buffer empty → returns { continue: true }
                                  → no additionalContext

T~30   msg 11855 arrives (user follow-up)
        polygram.js:2451   willAutosteer = true (S=true, sdkPm, autosteer enabled)
        polygram.js:2457   reactor.setState('THINKING') SKIPPED (willAutosteer guard)
        polygram.js:2511   buffer.append(sessionKey, prompt) → B=1
        polygram.js:2515   autosteeredRefs.add → R=1
        polygram.js:2534   reactor.setState('AUTOSTEERED') → ✍
        polygram.js:2535   markReplied(); return
        State: S=true, B=1, R=1, Q=1

        ... tool batch A finishes ...

        PostToolBatch hook fires
        autosteer-buffer.js:108  hook callback runs
                                 drained = ['msg-11855-text']
                                 onDrained → clearAutosteeredReactions(sk)
                                          → setMessageReaction(11855, []) → ✍ cleared (rc.37)
                                          → R=0
                                 returns { continue: true,
                                           hookSpecificOutput: { ...,
                                             additionalContext: '<channel ...>...</channel>' } }
        SDK injects additionalContext into next API request alongside tool_result.
        State: S=true, B=0, R=0, Q=1

        Next API request includes msg 11855's text → model responds in NEW
        assistant message:

        SDKAssistantMessage A2 (text + tool_use, stop_reason='tool_use')
        polygram.js:3607   onAssistantMessageStart → streamer.forceNewMessage
                           → bubble #2 visible (msg 11857)
        Tools run.

T~120   msg 11856 arrives
        Same flow as 11855: append → ✍, B=1, R=1, S=true (still!)

        ... tool batch B finishes, hook drains 11856,
            ✍ clears immediately (rc.37 onDrained), R=0, B=0 ...

        SDKAssistantMessage A3 → bubble #3 visible (msg 11859)

T~600   msg 11858 arrives
        Same flow: append → ✍, B=1, R=1, S=true

        ... eventually tool batch C drains it, ✍ clears ...

        SDKAssistantMessage A4 → bubble #4 visible (msg 11860)

T=14m   stop_reason='end_turn' finally fires WITH no more queued additionalContext
        SDK emits SDKResultMessage (subtype='success')
        process-manager-sdk.js:485-559   onResult fires → pending.resolve
                                         entry.pendingQueue.shift() → Q=0
                                         entry.inFlight = false
        polygram.js:2618   reactor.clear() (already cleared on each ✍ via rc.37 onDrained)
        polygram.js:2622   clearAutosteeredReactions (no-op, R=0)
        polygram.js:2628   drainStaleAutosteerBuffer (no-op, B=0)
        polygram.js:2561   db.insertTurnMetric → ROW 243 (243.4s, $1.82,
                                                  num_turns=N, num_tool_uses=...)

        State: S=false, B=0, R=0, Q=0
```

### Annotations

**Why is this a contract bug, not a UX nuisance?**

1. **Cost accounting.** turn_metrics has 1 row, attributed to msg 11853. msgs 11855/11856/11858 contributed work and tokens but zero rows. Per-message billing, per-message latency analysis, per-message error attribution — all wrong.

2. **Abort grace.** If the user types `/stop` at T=10m, `pm.interrupt()` cancels the SDK turn. `head` is still pending 11853 (the only `pm.send` ever made). The interrupt rejects 11853 with INTERRUPTED → `markSessionAborted(sessionKey)` → 60s grace. msg 11855/11856/11858 had `markReplied()` called inline (polygram.js:2535), so DB sees them as 'replied'. From the user's perspective they "stopped" 4 messages of work, but only 11853's message_id is in the abort grace tracker; if any reply chunk lands in the next 60s, the suppression works. So far OK. But the `turn_metrics` row 243 STILL gets written when result fires after interrupt — except it's now the error-subtype row, attributed to 11853. msgs 11855/11856/11858: still zero rows. Forensic analysis after a stop is misleading.

3. **Idle-timeout.** `DEFAULT_IDLE_MS = 600_000` (10min). The pending's `resetIdleTimer` is wired to fire on every assistant/tool_progress/etc. event from the SDK (process-manager-sdk.js:563-571). Under autosteer the SDK is busy on a fresh batch every couple minutes, so the idle timer keeps resetting. **This is the only reason the 14-min run finished at all.** If the model had simply "thunk hard" with no tool_progress events for 10 min, the idle timer would have killed pending 11853 — forcibly aborting the entire stretch and tossing all 4 follow-ups. That edge case is not theoretical: a long Bash command with no progress output has been observed to trip the timer in adjacent failure modes.

4. **Wall-clock cap.** `DEFAULT_MAX_TURN_MS = 30 * 60_000` (30min). msg 11853's pending's maxTimer is armed at activate(). Under autosteer absorbing 8+ follow-ups, the chain CAN exceed 30 min and the maxTimer fires. The interrupt + reject happens against pending 11853, but msgs 11855/11856/… already replied 'replied' to the DB, the user sees a partial trace, and only msg 11853 gets the user-visible 30-min-ceiling error reply.

5. **Reactor heartbeat.** Per-turn reactor (the one created in handleMessage) is GC'd after `markReplied(); return` in the autosteer path. So follow-up reactors are dead. The trigger reactor (msg 11853's) is still live and getting heartbeat pulses from onStreamChunk for the entire 14-min stretch — its STALL/TIMEOUT timers reset on every chunk. The trigger msg's reaction goes 🤔 → CODING → … → cleared at T=14m. UX-wise, the user sees 11853's reaction churn for 14 minutes. Not broken, but ill-fitting once the visible reply for 11853 has long since been delivered.

---

## Option analysis

### Option (a) — Cap consecutive drains per SDK turn

**Mechanism.** Track a counter `head.absorbedCount` on the pending. On every PostToolBatch drain that returns `additionalContext`, increment. When `absorbedCount >= N`, the next autosteer-eligible message in handleMessage skips the autosteer branch (don't `buffer.append`); instead, fall through to `pm.send`, which queues a new pending behind the active one.

**Tuning N.** Production trace had 3 absorbed follow-ups; users have reported "5+ in a row" anecdotally. N=2 is too aggressive (legitimate "tweak in flight, then refine, then ask follow-up" workflows trip the cap). N=5 is too lax (still 5 messages collapsed into 1 turn). N=3 with hybrid end_turn detection is reasonable — most natural conversations don't hit the cap because end_turn triggers a logical-turn flip first; the cap only catches runaway tool loops with no end_turn.

**Trade-offs.**
- Pros: simple state machine, one counter, doesn't depend on parsing assistant message stop_reason.
- Cons: arbitrary N; no signal that aligns with user perception ("I just got a complete reply, my next message should be a fresh thing"); doesn't fix the cost-accounting / idle-timeout symptoms inside the cap window.
- New failure mode: when N is hit and the next msg falls through to `pm.send`, it queues behind the active pending. The active pending may still be running for many minutes. The user's "queued" msg sits at 👀/THINKING with no clear ETA. Worse than autosteer's ✍ for that message — autosteer feels live, FIFO queueing feels stuck.

**Code complexity.** ~15 lines in autosteer-buffer.js (counter + threshold) + ~10 lines in polygram.js (threshold check). Trivial.

**UX impact.** Mid-quality. The 1st follow-up to a runaway is still autosteered; the (N+1)th gets a different (worse) experience.

### Option (b) — End the turn on `stop_reason='end_turn'`

**Mechanism.** In pm-sdk's `_handleEvent` for `msg.type === 'assistant'`, after extracting `added`/`hasToolUse`, also extract `stopReason = msg.message?.stop_reason`. When `stopReason === 'end_turn'` AND we have non-empty `added` text, treat that segment as a "logical turn end": fire a synthetic onResult-like callback that flips `entry.inFlight=false` and resolves the pending's promise with the streamed text/cost-so-far, even though the SDK hasn't emitted the real `result` yet.

**Problem 1: pending lifecycle.** The pending is resolved exactly once. If we resolve early on end_turn, what happens when the SDK eventually emits the real `result`? `head` is no longer the pending we resolved (we shifted it). The current code's `if (msg.type === 'result' && head)` would see a different head (or undefined) and either silently drop the result or apply it to the wrong pending. Wrong.

**Problem 2: result metrics.** The SDKResultMessage carries authoritative `total_cost_usd`, `duration_ms`, `usage` aggregates, `permission_denials`, `terminal_reason`. Without it we don't have these. We'd be writing turn_metrics rows with placeholder cost/usage, which defeats the purpose of accurate per-message accounting.

**Problem 3: SDK's own state.** Resolving the pending early decouples polygram's view from the SDK's. If polygram thinks "turn done, accept new input," but the SDK is in the middle of processing additionalContext from the just-fired PostToolBatch, the next `pm.send` push lands on the inputController during a partly-consumed turn. The 0.7.x precedent (polygram.js:1041 — "Claude batches user messages written during in-flight turn into next turn") says this is exactly the m87-violating shape we worked around in rc.6/rc.7. Re-introducing it = relapse to error_during_execution rejections.

**Problem 4: max_tokens / refusal / model_context_window_exceeded.** These also signal "this segment is done" but in error-shaped ways. Are those user-visible turn ends? max_tokens — no, the user expects a follow-up "and the rest is …". refusal — kind of, but the model is refusing to answer, which is a half-broken state where the user's NEXT message should probably re-prompt to the same context. Not clear how to handle.

**Trade-offs.**
- Pros: precisely the right granularity for cost-accounting and inFlight-from-user-perspective.
- Cons: massive lifecycle surgery; can't get accurate cost/usage from end_turn alone (it's per-segment, not per-chain); risks reintroducing m87 violation; semantics for non-end_turn "done-ish" stop_reasons are murky.

**Code complexity.** Moderate-to-high. ~40-60 lines in pm-sdk plus rework of pending lifecycle. Tests rewrite required.

**Verdict: NOT RECOMMENDED in pure form.** Use stop_reason='end_turn' as a SIGNAL (option d below) but don't use it as the lifecycle boundary.

### Option (c) — Disable autosteer-via-hook entirely

**Off the table per user instruction.** Documented for completeness:

- Mechanism: skip `buffer.append` in handleMessage; every msg dispatches as its own `pm.send`. PostToolBatch hook stays empty (or removed).
- Loses: mid-turn correction, the "type a clarification while bot is busy and it gets incorporated mid-flow" feel.
- Gains: clean 1:1 user-msg ↔ pending ↔ result mapping. Simple.

This is the right answer if the user ever decides the cost/complexity of autosteer outweighs the UX. They've said no.

### Option (d-pure) — Visible-reply-as-soft-turn-boundary (no cap)

**Mechanism.** Same as (b) but DON'T touch the SDK pending lifecycle. Instead, decouple "user-perceived turn boundary" from "SDK pending boundary" with a per-entry `userTurnInFlight` flag that:

- Is set true in `pm.send` when a new pending is pushed (existing inFlight semantics).
- Is set true again when an autosteer follow-up is absorbed (`buffer.append`).
- Is set FALSE when an SDKAssistantMessage with `stop_reason='end_turn'` AND non-empty text is observed (a "complete user-visible reply landed").
- Is reset to true on the NEXT SDKAssistantMessage (the model is now responding to a *new* set of inputs the user can't yet see — that next reply isn't out yet).

The handleMessage autosteer gate switches from `entry.inFlight` to `entry.userTurnInFlight`. So:

- Right after a complete reply lands (end_turn segment): `userTurnInFlight=false` → next user msg takes the FRESH-TURN branch (THINKING reactor), even though the SDK Query is still chewing on its closing tokens / about to fire result.
- During a tool-use chain mid-reply: `userTurnInFlight=true` → next user msg autosteers (current behaviour).

**Trade-offs.**
- Pros: lifecycle surgery free. SDK pending still resolves on actual SDKResultMessage. Cost accounting still rolls up per-pending. No m87 risk. Surgical.
- Cons: still vulnerable to "model reaches end_turn for segment 1, autosteer feeds it, model goes back to tool_use forever, no more end_turn segments" — but in practice that's option (a)'s job to catch with a cap.
- Subtle: between end_turn and the next user msg, the SDK could already be processing an in-flight `additionalContext` that we drained. Pushing a fresh `pm.send` here re-encounters m87 — the SDK is mid-turn-from-its-perspective, not idle. **Mitigation:** when `userTurnInFlight=false` but `entry.inFlight=true` (logical end-of-segment, SDK still busy), the next msg is **buffered with shouldQuery semantics** like today's autosteer, BUT: it triggers no ✍ (instead the FRESH-TURN reactor, owned by handleMessage, paints THINKING on the user's msg). This requires a 3rd path between "fully fresh send" and "buffer + ✍ silently".

**Code complexity.** Moderate. New flag + state machine clarification + handleMessage branch refinement. Net additions: ~80 lines.

**UX impact.** Users perceive turn boundaries that match the model's own "I just answered you" moments. Reactor follows the user's mental model. Cost-accounting still wrong (1 row per chain) but at least the *visual contract* matches user perception.

### Option (d-hybrid) — Recommended

Combine d-pure with option (a)'s drain cap as a runaway breaker. Three components:

1. **`userTurnInFlight` flag** driven by stop_reason='end_turn' (d-pure mechanism).
2. **`absorbedCount` per pending** with `MAX_ABSORBED=3` (option a mechanism).
3. **`drainStaleAutosteerBuffer` repurposed**: when stop_reason='end_turn' lands and the buffer was non-empty (msgs arrived between the model's "I'm done" and the next assistant turn starting), dispatch the buffer remainder as a NEW `pm.send` on the next setImmediate — same path as the existing tool-less-turn drain.

The cap (component 2) protects against pathological cases where end_turn never fires (e.g., an agent that decides to keep tool-using forever because each absorbed follow-up extends its work). The flag (component 1) handles the common case (model finishes a reply, user types something, we want a fresh-feeling turn). Component 3 ensures we never silently lose buffered text when end_turn arrives between an autosteer absorb and a tool batch.

**Why this is the right shape:**

- Preserves mid-turn correction (the explicit user requirement).
- Restores 1:1 user-perceived-turn:reactor mapping.
- Cost-accounting becomes accurate over time as the cap forces fresh sends sooner under runaway conditions.
- The complexity lives in 3 well-bounded places (autosteer-buffer.js for cap, pm-sdk for stop_reason wiring, handleMessage for flag check).
- One kill-switch flag (`POLYGRAM_AUTOSTEER_HARD_CAP`) lets ops disable just the cap if it bites in practice; the soft-boundary (d-pure) part can ship without the cap if needed.

**Code complexity.** ~120 lines + tests. Manageable.

### Option (e) — Use `Query.interrupt()` after each visible reply

**Mechanism.** When stop_reason='end_turn' is observed mid-Query, call `entry.query.interrupt()` to forcibly end the SDK turn. The SDK emits a `result` (subtype likely 'success' since interrupt happens at a natural boundary). Polygram's onResult fires, the pending resolves, inFlight clears. Next user message starts a new pending → new turn → new pm.send.

**Why I considered it.** Closes the contract gap completely: 1 pm.send : 1 SDK turn : 1 user-visible reply. No flag-juggling.

**Why I rejected it.**

1. **Interrupt latency.** `entry.query.interrupt()` is async and not instant; the SDK has to gracefully cancel any in-flight tool runs (or hook callbacks). During the gap, follow-ups pile up in the buffer with no drainer. The next pm.send could race the interrupt-in-progress and the SDK could see the new SDKUserMessage push while still teardowning, m87 risk.

2. **Tool side-effects mid-batch.** If we interrupt right after end_turn, but the model emitted end_turn AFTER firing tool_use blocks that haven't run yet (which IS valid per the API — tool_use can co-occur with end_turn? actually no, but tool_use and tool_result ordering is a thing), we cancel pending tool runs. State corruption risk.

3. **Cost accounting still wrong WITHIN the segment.** The interrupt-induced result reports usage *up to interrupt*, which excludes the closing tokens that would have been part of a graceful end_turn. Less accurate than letting it run.

4. **Re-spawn churn.** Calling interrupt mid-turn frequently could destabilise the SDK's internal state. The CLI subprocess stays alive but its connection to the model API is recycled. Repeated interrupts have not been stress-tested in polygram.

5. **OpenClaw lineage.** OpenClaw's session.steer() = "skip remaining sibling tool_uses + inject as new user turn" — semantically what (e) tries to do — was identified in the migration plan §6.5 / table row 9 as NOT having a clean SDK equivalent. Phase 0 gate 6 explicitly DEFERRED testing it. We have no production confidence in interrupt-mid-turn-and-resume as a recurring pattern.

**Verdict: defer.** If d-hybrid proves insufficient in soak, (e) is the next step. Don't try to leapfrog.

### Option (f) — Remove the buffer; use SDK's own `streamInput` with priority hints

**Mechanism.** Per migration-plan-pitfalls (sdk_migration_pitfalls.md): "the SDK does NOT expose per-message priority fields in its public type." `priority: 'now'` is an OpenClaw artefact. Polygram's pm-sdk.steer() pushes it anyway (process-manager-sdk.js:826) — relying on the SDK runtime accepting unknown fields silently or honoring an undocumented internal contract. This is a latent landmine. Phase 0 gate 6 was DEFER. We do NOT want to lean further on this.

**Verdict: not viable today.** Even if it were, it'd require Phase 0 verification first.

---

## Recommended fix

### Architecture (d-hybrid)

#### 1. SDK pm: surface stop_reason

**File:** `/Users/ivanshumkov/Projects/shumkov/polygram/lib/process-manager-sdk.js`

Add a new callback `onAssistantStopReason` to ProcessManagerSdk's options. Fire it from `_handleEvent` after extracting the assistant message's stop_reason, but BEFORE the existing onStreamChunk so polygram can act on the boundary signal before the next chunk arrives:

```js
// in _handleEvent, inside the `if (msg.type === 'assistant' && head)` block,
// after computing `added` and `hasToolUse`:

const stopReason = msg.message?.stop_reason ?? null;

// ... existing usage/tool_use accounting ...

// rc.38: stop_reason boundary signal. Fire AFTER per-segment text has
// streamed (so the bubble is already painted) but BEFORE the next
// assistant message arrives. polygram uses this to flip the
// "user-perceived turn done" flag.
if (stopReason && this.onAssistantStopReason) {
  try {
    this.onAssistantStopReason(entry.sessionKey, stopReason, entry, head);
  } catch (err) {
    this.logger.error?.(`[${entry.label}] onAssistantStopReason: ${err.message}`);
  }
}
```

Constructor wiring: add `onAssistantStopReason = null` to the destructuring at line 200, store on `this`, no other changes. Pure additive.

#### 2. SDK pm: per-pending absorbed counter

**File:** same.

In the pending shape (process-manager-sdk.js:600-618), add `absorbedCount: 0`. Expose a method `pm.getAbsorbedCount(sessionKey)` returning `entry.pendingQueue[0]?.absorbedCount ?? 0` for handleMessage to consult. The COUNTER is incremented by autosteer-buffer.js's hook callback via a new `onAbsorb` callback on the pending — see component 3.

```js
const pending = {
  // ... existing fields ...
  absorbedCount: 0,
  // rc.38: helper hook for autosteer-buffer to bump on each
  // additionalContext drain. Not a polygram-facing API.
  bumpAbsorbed: () => { pending.absorbedCount += 1; },
};
```

And on `pm`:

```js
getAbsorbedCount(sessionKey) {
  const entry = this.procs.get(sessionKey);
  return entry?.pendingQueue?.[0]?.absorbedCount ?? 0;
}
```

#### 3. autosteer-buffer.js: cap-aware drain + bump

**File:** `/Users/ivanshumkov/Projects/shumkov/polygram/lib/autosteer-buffer.js`

Add an `onAbsorb` callback on the hook. Polygram passes a closure that calls `pm.getEntry(sessionKey).pendingQueue[0]?.bumpAbsorbed()`. Hook fires it after a successful drain:

```js
function makePostToolBatchHook({
  buffer, sessionKey, logEvent = null, chatId = null,
  logger = console, onDrained = null, onAbsorb = null,
} = {}) {
  // ... existing validation ...
  return async () => {
    try {
      const drained = buffer.drain(sessionKey);
      if (drained.length === 0) return { continue: true };
      const additionalContext = buffer.formatForHook(drained);

      if (typeof logEvent === 'function') { /* ... */ }

      // rc.38: bump the per-pending absorbed counter BEFORE onDrained,
      // so the cap check in polygram's onAssistantStopReason sees the
      // updated value if it fires concurrently.
      if (typeof onAbsorb === 'function') {
        try { onAbsorb(sessionKey, drained.length); }
        catch (err) {
          logger?.error?.(`[${sessionKey}] onAbsorb: ${err?.message || err}`);
        }
      }

      if (typeof onDrained === 'function') { /* ... existing ... */ }

      return { continue: true, hookSpecificOutput: { ... } };
    } catch (err) { /* ... */ }
  };
}
```

#### 4. polygram.js: userTurnInFlight flag + cap check

**File:** `/Users/ivanshumkov/Projects/shumkov/polygram/polygram.js`

A new module-scoped Map mirroring the existing `inFlightHandlers`:

```js
// rc.38: per-session "user-perceived turn in flight" flag. Distinct
// from pm's entry.inFlight (which tracks SDK pending lifecycle).
// userTurnInFlight=true means: from the user's POV, the bot owes
// them a complete reply for whatever they last sent. Flips false on
// stop_reason='end_turn' segments (the bot DID just complete a
// reply, even if the SDK Query keeps spinning to absorb the next
// queued follow-up). The autosteer gate consults THIS, not
// entry.inFlight, so a fresh user msg after a complete reply gets
// a fresh-turn experience.
const userTurnInFlight = new Map();   // sessionKey → boolean

function setUserTurnInFlight(sessionKey, v) {
  if (v) userTurnInFlight.set(sessionKey, true);
  else userTurnInFlight.delete(sessionKey);
}
function isUserTurnInFlight(sessionKey) {
  return userTurnInFlight.get(sessionKey) === true;
}
```

Wire in handleMessage's autosteer gate (line 2451 area):

```js
const willAutosteer = pm.has(sessionKey)
  && pm.get(sessionKey)?.inFlight
  && pm.isSdkFor(sessionKey)
  && isUserTurnInFlight(sessionKey)               // rc.38
  && pm.getAbsorbedCount(sessionKey) < MAX_ABSORBED  // rc.38
  && (chatConfig.autosteer != null
    ? chatConfig.autosteer !== false
    : config.bot?.autosteer !== false);
```

And in the explicit autosteer block at line 2508:

```js
const autosteerEnabled = chatAutosteer !== false
  && pm.isSdkFor(sessionKey);
if (autosteerEnabled && pm.has(sessionKey)) {
  const entry = pm.get(sessionKey);
  if (entry?.inFlight && isUserTurnInFlight(sessionKey)) {
    if (pm.getAbsorbedCount(sessionKey) >= MAX_ABSORBED) {
      logEvent('autosteer-cap-hit', {
        chat_id: chatId, msg_id: msg.message_id,
        cap: MAX_ABSORBED,
        absorbed: pm.getAbsorbedCount(sessionKey),
      });
      // FALL THROUGH to pm.send (queue behind active pending).
      // Reactor stays at 👀 (whatever state it was set to) until
      // pendingQueue.shift activates this msg's pending.
    } else {
      const ok = autosteerBuffer.append(sessionKey, prompt);
      // ... existing logic ...
      return;
    }
  }
}
```

Wire `onAssistantStopReason` callback in main() (around line 3540):

```js
onAssistantStopReason: (sessionKey, stopReason, entry, head) => {
  // rc.38: split SDK turn into user-perceived turns. end_turn
  // after non-empty text = "the bot just delivered a complete
  // reply"; flip flag false so next user msg gets a fresh turn.
  // Other stop_reasons we treat as terminal-but-the-SDK-may-
  // continue (max_tokens / refusal / pause_turn): also flip
  // false so the user can intervene.
  const isVisibleEnd = stopReason === 'end_turn'
    || stopReason === 'max_tokens'
    || stopReason === 'refusal'
    || stopReason === 'pause_turn'
    || stopReason === 'stop_sequence';
  if (isVisibleEnd) {
    setUserTurnInFlight(sessionKey, false);
    logEvent('user-turn-boundary', {
      chat_id: entry.chatId,
      session_key: sessionKey,
      stop_reason: stopReason,
    });
    // Drain any buffered follow-ups as a NEW pm.send. The SDK
    // pending will continue under entry.inFlight; the new send
    // queues behind it. When result fires, entry.inFlight clears
    // and the new pending activates. UX: user sees a complete
    // reply (just landed) + a fresh THINKING reactor on their
    // newest msg. No silent absorption.
    drainStaleAutosteerBuffer(sessionKey, entry.chatId, entry.threadId)
      .catch((err) => console.error(
        `[${BOT_NAME}] post-end_turn drain: ${err.message}`));
  }
  // tool_use / compaction / model_context_window_exceeded:
  // userTurnInFlight stays true. tool_use because the bot will
  // emit more text after the tool runs. compaction is mid-turn
  // and the next assistant message will continue. mcwe is fatal
  // and result will fire shortly with an error subtype.
},
```

Set userTurnInFlight=true on every `pm.send` in handleMessage (success path), and on every autosteer absorb:

```js
// Inside the autosteer-append branch (~line 2511):
const ok = autosteerBuffer.append(sessionKey, prompt);
if (ok) {
  setUserTurnInFlight(sessionKey, true);   // rc.38
  // ... existing ...
}

// Inside the pm.send path (~line 2545), set BEFORE sendToProcess:
setUserTurnInFlight(sessionKey, true);
const result = await sendToProcess(...);
// On success: also flip false in case stop_reason callback was missed
// (defensive — should already be false from the end_turn segment):
setUserTurnInFlight(sessionKey, false);
```

Wire `onAbsorb` into the hook factory call at polygram.js:928:

```js
const postToolBatchHook = makePostToolBatchHook({
  buffer: autosteerBuffer,
  sessionKey,
  chatId: ctx?.chatId ?? null,
  logEvent,
  logger: console,
  onDrained: (key) => { /* existing rc.37 ✍ clear */ },
  // rc.38: bump per-pending absorbed counter so the autosteer cap
  // gate sees up-to-date count without polygram-side bookkeeping.
  onAbsorb: (key, count) => {
    const entry = pm.get(key);
    const head = entry?.pendingQueue?.[0];
    if (head?.bumpAbsorbed) {
      for (let i = 0; i < count; i++) head.bumpAbsorbed();
    }
    // rc.38: autosteer absorb counts as "user-turn-in-flight" reset
    // — even if a previous end_turn segment flipped it false, the
    // new absorbed text is fresh user input and the bot owes a
    // reply. Re-set to true so a SECOND follow-up arriving before
    // the next end_turn segment still autosteers.
    setUserTurnInFlight(key, true);
  },
});
```

Constants block near the top of polygram.js:

```js
// rc.38: per-pending hard cap on PostToolBatch additionalContext
// absorptions. Above this, the next user msg falls through to
// pm.send (queued behind active pending) instead of autosteer.
// Caps runaway tool loops where stop_reason='end_turn' never
// fires. POLYGRAM_AUTOSTEER_HARD_CAP env var override; 0 disables.
const MAX_ABSORBED = (() => {
  const v = Number(process.env.POLYGRAM_AUTOSTEER_HARD_CAP);
  if (Number.isFinite(v) && v >= 0) return v;
  return 3;
})();
```

#### 5. Cleanup paths

`drainQueue`, `kill`, `_failAllPendings`, `interrupt`, `resetSession` should all clear `userTurnInFlight` for the sessionKey. Add to each:

```js
// In drainQueue (process-manager-sdk.js:738):
drainQueue(sessionKey, errCode = 'INTERRUPTED') {
  // ... existing ...
  // rc.38: also clear polygram's userTurnInFlight via callback if wired
  // (the callback is set by polygram in main()).
  if (this.onUserTurnReset) {
    try { this.onUserTurnReset(sessionKey, errCode); }
    catch { /* swallow */ }
  }
  return count;
}
```

OR (cleaner): polygram listens on an existing callback. The `onClose` callback fires for entry teardown — extend it to also clear userTurnInFlight. But onClose only fires when the entry teardown completes (Query closed). We need to clear earlier — on drain/kill/interrupt. Cleanest: add a tiny `onPendingRejected(sessionKey, code)` callback to ProcessManagerSdk that fires every time a pending is rejected. Polygram clears on it.

Or simpler: every site in polygram that calls drainQueue/interrupt/kill/resetSession explicitly calls `setUserTurnInFlight(sk, false)` afterwards. ~3-4 call-sites total. Less mechanism, more local.

#### Diff summary

| File | Lines added | Lines changed |
|---|---|---|
| lib/process-manager-sdk.js | ~25 | ~5 |
| lib/autosteer-buffer.js | ~10 | ~2 |
| polygram.js | ~80 | ~15 |
| **total** | **~115** | **~22** |

### Tests

#### A. New: tests/autosteer-cap.test.js

Verify the hard-cap path end-to-end on the buffer side:

```js
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAutosteerBuffer, makePostToolBatchHook } = require('../lib/autosteer-buffer');

describe('autosteer-buffer — onAbsorb callback (rc.38)', () => {
  test('onAbsorb fires with sessionKey and count after non-empty drain', async () => {
    const buf = createAutosteerBuffer();
    buf.append('s1', 'a'); buf.append('s1', 'b');
    const calls = [];
    const hook = makePostToolBatchHook({
      buffer: buf, sessionKey: 's1',
      onAbsorb: (k, n) => calls.push({ k, n }),
    });
    await hook();
    assert.deepEqual(calls, [{ k: 's1', n: 2 }]);
  });

  test('onAbsorb does NOT fire on empty drain', async () => {
    const buf = createAutosteerBuffer();
    const calls = [];
    const hook = makePostToolBatchHook({
      buffer: buf, sessionKey: 's1',
      onAbsorb: () => calls.push(1),
    });
    await hook();
    assert.equal(calls.length, 0);
  });

  test('onAbsorb fires BEFORE onDrained (ordering invariant)', async () => {
    const buf = createAutosteerBuffer();
    buf.append('s1', 'x');
    const seq = [];
    const hook = makePostToolBatchHook({
      buffer: buf, sessionKey: 's1',
      onAbsorb: () => seq.push('absorb'),
      onDrained: () => seq.push('drained'),
    });
    await hook();
    assert.deepEqual(seq, ['absorb', 'drained']);
  });

  test('onAbsorb throw is swallowed; hook still returns drained context', async () => {
    const buf = createAutosteerBuffer();
    buf.append('s1', 'hi');
    const errs = [];
    const hook = makePostToolBatchHook({
      buffer: buf, sessionKey: 's1',
      onAbsorb: () => { throw new Error('boom'); },
      logger: { error: (m) => errs.push(m) },
    });
    const r = await hook();
    assert.equal(r.continue, true);
    assert.match(r.hookSpecificOutput.additionalContext, /hi/);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /onAbsorb/);
  });
});
```

#### B. New: tests/process-manager-sdk-stop-reason.test.js

Drive a fakeQuery that emits SDKAssistantMessage with various `stop_reason` values; assert `onAssistantStopReason` callback fires with correct value. Use the existing fakeQuery test harness.

```js
test('SDKAssistantMessage with stop_reason=end_turn fires onAssistantStopReason', async () => {
  const seen = [];
  const pm = new ProcessManagerSdk({
    spawnFn: () => fakeQueryYielding([
      { type: 'system', subtype: 'init', session_id: 's' },
      makeAssistant('hello', 'end_turn'),
      makeResult('hello', 's'),
    ]),
    onAssistantStopReason: (sk, sr) => seen.push({ sk, sr }),
  });
  await pm.getOrSpawn('s1', { chatId: '1' });
  await pm.send('s1', 'hi');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sr, 'end_turn');
});

test('multi-segment turn fires onAssistantStopReason once per segment', async () => {
  const seen = [];
  const pm = new ProcessManagerSdk({
    spawnFn: () => fakeQueryYielding([
      { type: 'system', subtype: 'init', session_id: 's' },
      makeAssistant('partial', 'tool_use'),
      makeAssistant('more', 'tool_use'),
      makeAssistant('final', 'end_turn'),
      makeResult('final', 's'),
    ]),
    onAssistantStopReason: (sk, sr) => seen.push(sr),
  });
  await pm.getOrSpawn('s1', { chatId: '1' });
  await pm.send('s1', 'hi');
  assert.deepEqual(seen, ['tool_use', 'tool_use', 'end_turn']);
});

test('absorbedCount on pending bumps via bumpAbsorbed', async () => {
  // ... wire up a pending, call head.bumpAbsorbed() twice, assert
  //     pm.getAbsorbedCount(sk) === 2 ...
});
```

#### C. New: tests/autosteer-contract.test.js (integration-shaped)

Drive the full handleMessage gate logic with mock pm + buffer. Assert:

1. After end_turn segment fires onAssistantStopReason, `userTurnInFlight` is false.
2. Next user msg with `entry.inFlight=true` (SDK still spinning) takes the FRESH pm.send branch (THINKING reactor), NOT autosteer.
3. After absorbedCount hits MAX_ABSORBED, even mid-tool-use stop_reason segments don't allow further autosteer; the next msg falls through.
4. drainQueue clears userTurnInFlight.

#### D. Revise: tests/autosteer-hook.test.js

Add `onAbsorb` to the rc.37 onDrained describe block so the existing tests pass with the new field present. Add ordering and error-safety tests for onAbsorb.

#### E. Update: tests/process-manager-sdk.test.js

Add a regression test asserting that `pm.getAbsorbedCount` returns 0 when no pending exists, undefined session, and increments correctly.

### Soak plan

**rc.38-rc1 (kill-switch on, soft-boundary only):**

- `POLYGRAM_AUTOSTEER_HARD_CAP=0` (cap disabled)
- userTurnInFlight + onAssistantStopReason + drainStaleAutosteerBuffer-on-end_turn active
- Deploy to shumabit (Ivan's testing chats first per memory feedback_polygram_rollout_order)
- Watch for: events.table queries on `user-turn-boundary` event count vs. `result` event count. Ratio > 1 confirms multi-segment turns observed. Look for any new error class.
- Soak 24h. If no regressions → rc.38-rc2.

**rc.38-rc2 (cap enabled, default):**

- `MAX_ABSORBED=3` default
- Watch `autosteer-cap-hit` events.table count. Sub-1/day across all chats expected; if higher, the cap is too aggressive.
- Watch turn_metrics row-count rate vs. inbound message rate (should converge to ~1:1 over time).
- Soak 48h. If no regressions → rollout to umi-assistant.

**rc.38-rc3 (umi-assistant):**

- Same default. Partner-facing; per memory feedback_polygram_rollout_order, monitor closely for 72h.

**Rollback path:** `POLYGRAM_AUTOSTEER_HARD_CAP=0` env var disables the cap without redeploy. The userTurnInFlight flag has no kill-switch in the design above — it's a behavior change baked in. To preserve the rollback option, gate the flag check behind a second env: `POLYGRAM_AUTOSTEER_TURN_BOUNDARY=0` short-circuits to "always autosteer if entry.inFlight" (existing rc.37 behaviour). Add this; ~3 lines.

---

## Subtle bugs found en route

These are bugs in the existing rc.37 implementation that surfaced while reading the code. They are independent of the autosteer-contract fix and should be addressed alongside, not after.

### Bug 1 — `onDrained` race with `reactor.clear()` at turn-end (Severity: Low, present in rc.37)

**File:** lib/autosteer-buffer.js:122-125, polygram.js:2618 + 2622.

When `result` fires:
- polygram.js:2618 calls `reactor.clear()` — clears the trigger msg's reactor.
- polygram.js:2622 calls `clearAutosteeredReactions(sessionKey)` — clears the autosteeredRefs Map for the session.

If a final PostToolBatch hook fires AFTER `result` (theoretically possible if the SDK orders events oddly under interrupt or compaction), `onDrained` could call `clearAutosteeredReactions` against an already-cleared map. autosteered-refs.js:78-95 returns `0` cleanly, so harmless. But `buffer.drain` could return a non-empty array (a follow-up that arrived between the last drain and result) → the hook returns `additionalContext` to a turn that's about to terminate. SDK behaviour: undocumented. Could leak the user's text into the post-result void.

**Mitigation:** unlikely to fire in practice (SDK serialisation). But the post-end_turn drain in d-hybrid (component 3 above) addresses this by explicitly handling buffer remainder at end_turn.

### Bug 2 — `onDrained` throws AFTER hook returns (Severity: None today, watch under d-hybrid)

**File:** lib/autosteer-buffer.js:122-125.

The catch around `onDrained` swallows synchronous throws:

```js
if (typeof onDrained === 'function') {
  try { onDrained(sessionKey, drained.length); }
  catch (err) { logger?.error?.(`[${sessionKey}] onDrained: ${err?.message || err}`); }
}
```

But `onDrained` is `clearAutosteeredReactions` which returns a Promise (autosteered-refs.js:77-95). Synchronous-try doesn't catch async rejections; polygram.js:942-944 has its own `.catch(...)` to handle it:

```js
onDrained: (key) => {
  clearAutosteeredReactions(key).catch((err) => {
    console.error(`[${BOT_NAME}] autosteer-hook clearReactions: ${err.message}`);
  });
},
```

OK but fragile. If a future caller forgets the .catch or forgets the promise's rejection handler, an unhandledRejection will surface — polygram.js has a process-level handler so it won't crash, but it's noise. **Recommendation:** make the autosteer-buffer's catch await the callback if it returned a thenable:

```js
if (typeof onDrained === 'function') {
  try {
    const r = onDrained(sessionKey, drained.length);
    if (r && typeof r.then === 'function') {
      r.catch((err) => logger?.error?.(`[${sessionKey}] onDrained async: ${err?.message || err}`));
    }
  }
  catch (err) { logger?.error?.(`[${sessionKey}] onDrained: ${err?.message || err}`); }
}
```

Same for `onAbsorb` in d-hybrid.

### Bug 3 — autosteeredRefs cleanup leaks on error paths (Severity: Low, present in rc.37)

**File:** polygram.js error branches in handleMessage.

Search results: `clearAutosteeredReactions` is called in:
- polygram.js:2622 (success path)
- polygram.js:2681 (tool-only completion)
- polygram.js:3075 (abort-requested)

NOT called in:
- error path (polygram.js:2584-2612 — `if (result.error)`). After the error reaction is set and (if no text) `throw new Error(result.error)`, the autosteeredRefs for this session are NEVER cleared. Any ✍ reactions on follow-ups absorbed during the failed turn stay forever.
- empty-response fallback (polygram.js:2668-2727). Same issue.
- streamer overflow path (polygram.js:2756-2800). If a finalize fails after autosteers were absorbed, refs leak.

rc.37 partly papered over this by clearing ✍ at hook-drain time (onDrained) — but that's only AFTER a successful drain. ✍ that was set at autosteer-append time but BEFORE the next PostToolBatch fires (i.e., the buffer never drained because the turn errored before its first tool batch) leaks.

**Mitigation:** add `clearAutosteeredReactions` to every terminal exit in handleMessage (or wrap handleMessage in a try-finally). 5-line patch.

### Bug 4 — `entry.inFlight = true` set ONLY in `send()` — confirmed safe (Severity: None)

I checked. process-manager-sdk.js sets `entry.inFlight = true` at exactly one site: line 675 inside `send()`. It's cleared at lines 362, 556, 641, 708, 749, 961 (close finally, result handler, fireTimeout, send-error path, drainQueue, _failAllPendings). All correct. The `send()` setting at the top of the function (before queue manipulation, before activate) is a tiny race — if a concurrent caller also reads `entry.inFlight` between line 675 and line 697 (`if (entry.pendingQueue.length === 1) pending.activate();`), they'd see inFlight=true even before the pending activates. Single-threaded Node so it's only a logical race, not an instruction race. The handleMessage autosteer gate (line 2452) reads inFlight, but it does so as part of evaluating an inbound message — a fresh handler-context — and CAN'T be racing the same `pm.send`'s inner state because the same handleMessage is doing both. Cross-handler: if msg M2 arrives while M1's pm.send is mid-execution between 675 and the inputController.push, M2 evaluates willAutosteer=true (correct) and routes to autosteer. No bug.

### Bug 5 — Reactor created in handleMessage outlives its useful life (Severity: Low UX, present today)

**File:** polygram.js:2416-2428.

A reactor is created in every handleMessage invocation. For autosteer-absorbed messages (the path that hits `markReplied(); return` at 2535), the reactor's `setState('AUTOSTEERED')` is the LAST thing that happens to it. The reactor's internal timers (STALL/TIMEOUT) are still armed — they hold setTimeout handles that prevent GC of the closure for up to 10s/30s. Multiply by the autosteer absorption rate and there's a steady-state minor heap retention.

**Mitigation:** call `reactor.stop()` after the terminal `setState('AUTOSTEERED')` in the autosteer-append branch to cancel the timers and release the closure. Patch is one line.

### Bug 6 — `drainStaleAutosteerBuffer` dispatches a no-streamer turn into the queue (Severity: Low)

**File:** polygram.js:773-792.

`drainStaleAutosteerBuffer` calls `sendToProcess(sessionKey, followUpPrompt, { streamer: null, reactor: null, sourceMsgId: null })`. This pushes a new pending onto `entry.pendingQueue` (good). When that pending activates, the onStreamChunk callback in pm-sdk's iteration looks up `head.context.streamer` — gets `null` — and silently drops streaming. The result.text gets sent at the end as a plain bubble. OK.

But: the on-stream-chunk fan-out in polygram.js:3563 does `if (s) s.onChunk(...)` — fine. The on-tool-use callback does `if (r) r.setState(...)` — fine. The onAssistantMessageStart does `if (s) s.forceNewMessage()` — fine. All defensive null-guarded.

What's NOT guarded: the result handler in polygram.js's main onResult callback path (which actually doesn't exist as wired — onResult is mostly DB-side telemetry). The result.text -> sendMessage at polygram.js:781 is a FRESH send divorced from handleMessage's bubble pipeline. So the user gets an unstyled bubble with no streaming preview, no chunk-aware splitting (chunkMarkdownText not used). For replies > 4096 chars Telegram returns 400 and the bubble fails silently.

**Mitigation:** the d-hybrid post-end_turn drain (component 3) reuses this path. To be safe, route through `chunkMarkdownText` + `deliverReplies` and respect `parseResponse(...)` (so NO_REPLY / sticker / reaction directives still work). ~30 lines refactor. Address before d-hybrid ships.

### Bug 7 — `userTurnInFlight` would not survive boot replay (Severity: Note)

**File:** if d-hybrid lands as designed, the new userTurnInFlight Map is in-memory only. After polygram restart, all entries are gone. Boot replay re-dispatches inbound messages whose handler_status is 'replay-pending'. If the boot-replay re-dispatch fires while the SDK Query is still spinning up (it's a new pm.spawn after restart), entry.inFlight is briefly false (no pending) → autosteer gate fails → message goes through pm.send. That's the correct behaviour. Worth confirming in a boot-replay test.

---

## What this DOESN'T fix

1. **Cost accounting is still per-pending, not per-user-message.** Even with d-hybrid, when 3 messages are absorbed within MAX_ABSORBED, turn_metrics still records 1 row for the 3-message chain. The cap caps the worst case at 3, not 1. Truly per-message cost accounting requires either:
   - Splitting on stop_reason='end_turn' to multiple turn_metrics rows (synthesise per-segment cost from `usageByMessage`). Doable but requires pm-sdk to expose per-segment usage. Defer to rc.39.
   - Or rebuild autosteer to use per-message pm.send (option c, rejected by user).

2. **Idle-timeout semantics still per-SDK-turn.** A 14-min absorbing chain is one pending; one idle timer. If the agent stalls between segments, the user-perceived ETA is based on segment-progress, but the timer doesn't know. Future work: per-segment idle timer or replace with a per-userTurnInFlight wall-clock.

3. **Wall-clock cap (DEFAULT_MAX_TURN_MS=30min) still per-SDK-turn.** Same shape as #2. With MAX_ABSORBED=3 the worst case is reduced (turn can't grow indefinitely from autosteer alone) but a single message that legitimately spawns a 25-min agentic chain plus 3 absorbed follow-ups in the last 5 min could still exceed.

4. **Cross-pending interrupt semantics.** `/stop` calls interrupt() against the CURRENT pending — fine — and drainQueue rejects all queued pendings — fine. But if the user `/stop`s during an autosteer-cap-hit overflow (where msg M2 is pending behind M1, both their reactors live), the queued M2's reactor gets a generic "interrupted" reply. That's correct UX (M2 was queued behind a thing the user just killed) but the abort grace mark only covers M1's session; M2's reactor might fire ERROR → user sees 🤯 next to M2 even though they explicitly /stop'd. Edge case worth a separate test.

5. **Mid-segment user msgs while userTurnInFlight=true but absorbedCount<cap.** This is the ENTIRE happy autosteer path — design intent. No bug, just noting that d-hybrid doesn't change this flow at all.

6. **OpenClaw's "skip remaining sibling tool_uses" semantic.** Migration plan §6.5 row 9 marked DEFER; still deferred. d-hybrid doesn't address it. Future spike for /steer command if autosteer alone proves insufficient for power users.

7. **Absent SDK-side primitive for "force end of segment now".** If the SDK ever exposes a `Query.endTurnSoft()` (graceful interrupt without turn cancellation), all of d-hybrid simplifies. Watch SDK release notes; not a polygram fix.

---

## Verdict

The autosteer mechanism does NOT need to be rebuilt. Its core (PostToolBatch hook + `<channel source="user-followup">` framing) survives the spike test (autosteer-buffer.js:18-23) and provides genuine UX value. What needs to change is the *contract* between "SDK turn" and "user-perceived turn" — by treating `stop_reason='end_turn'` segments as soft turn boundaries and capping runaway absorption at N=3.

The fix is ~115 LOC + tests + a phased soak (shumabit → 24h → cap-on → 48h → umi-assistant per the rollout-order memory). Two env kill-switches preserve rollback. Six subtle bugs surface en route; address as a parallel patch series rather than a single mega-commit (per the commit-per-logical-change feedback).

After d-hybrid ships, the user-perceived contract is: **one user message → one user-perceived reply turn, even when the SDK's internal Query treats a chain of absorbed follow-ups as one turn**. The mechanism that enables mid-turn correction (the user's explicit requirement) survives intact.

If d-hybrid soaks cleanly for two weeks and turn_metrics rate still doesn't approach 1:1 with inbound message rate (because chains of 3 are still common), then we've proved that mid-turn correction is genuinely the dominant interaction pattern and per-segment cost-accounting becomes the next priority. That's rc.39 territory.
