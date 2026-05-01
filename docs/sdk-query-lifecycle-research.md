# SDK Query lifecycle: when does `result` fire?

Pinned: `@anthropic-ai/claude-agent-sdk@0.2.123` (claudeCodeVersion: 2.1.123).
All file:line citations are against the bundled `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` and the type-definitions file `sdk.d.ts` shipped with that version.

> **TL;DR**
> `result` is **NOT** a per-user-input event. It is emitted by the Claude Code CLI subprocess once per "Stop" of the agent loop — i.e. once the assistant produces an assistant message whose `stop_reason === 'end_turn'` (or another terminal stop reason) AND no hook/scheduler arranges another model turn. As long as the agent keeps tool-using or the `PostToolBatch` hook keeps returning `additionalContext`, the loop continues and **no** `result` is emitted. Pushing a second `SDKUserMessage` onto the input AsyncIterable while a turn is in flight does NOT terminate the current turn; whether it produces a separate `result` depends on the message's `priority` / `shouldQuery` flags and whether the CLI is currently inside a model loop.

---

## 0. Mental model

The SDK we install in `node_modules` is **a transport shim**, not the agent loop. It does three things:

1. Spawn a `claude` CLI subprocess in stream-JSON mode.
2. Pipe `SDKUserMessage` JSON lines from our `AsyncIterable` to the subprocess's stdin (`Query.streamInput`, sdk.mjs line 62, ~offset 274211).
3. Pipe stream-JSON lines back from the subprocess's stdout to our `for await (… of query)` loop (`Query.readMessages` + `Query.readSdkMessages`, sdk.mjs line 59 (offset 263785) and line 61 (offset 274211)).

`result`, `assistant`, `system`, `stream_event`, `compact_boundary`, etc. messages all originate inside the **CLI binary**, not inside the SDK process. The SDK simply forwards them. This means:

- `result`-event semantics are owned by the CLI subprocess, not the JS SDK.
- The SDK's TS types (sdk.d.ts) describe the protocol but the timing rules live in CLI internals we cannot read directly.
- The SDK adds **one** policy on top: if `isSingleUserTurn === true` (set when `query()` was called with a string prompt), the SDK closes stdin (`transport.endInput()`) on the **first** `result`. With an `AsyncIterable` prompt we use, this flag is `false` and stdin stays open across multiple `result` events. (sdk.mjs line 59, offset 270697 — `if(this.isSingleUserTurn) … this.transport.endInput()`; sdk.mjs line 106 ~offset 663873, `if(typeof J==="string")X.write(…)` else `streamInput(J)`; sdk.mjs line 106 ~offset 666263 `setIsSingleUserTurn(!0)` only on string-prompt path.)

So for polygram (long-lived `AsyncIterable` per chat), every `result` we observe is a CLI-driven loop-exit signal, and the same `Query` will continue yielding more messages afterward as new user messages get pushed.

---

## 1. Verified facts about the Query lifecycle

### F1. The Query factory `query()` does NOT distinguish input modes the way you'd expect — but it sets one flag.

**Location:** sdk.mjs line 106, function `y7$` (renamed `query`).

```js
// sdk.mjs line 106 (offset ~663873)
function yK($,X,J,W){
  if(typeof J==="string")
    X.write(w$({type:"user",session_id:"",message:{role:"user",content:[{type:"text",text:J}]},parent_tool_use_id:null})+`\n`);
  else
    $.streamInput(J).catch((Q)=>W.abort(Q))
}
```

**Implication:** `query({ prompt: 'a string' })` writes one user line then never reads more from a JS-side stream. `query({ prompt: asyncIterable })` consumes the iterable forever via `streamInput` (sdk.mjs line 62, offset 274211) — every `for await` value is JSON-stringified and written to the subprocess's stdin. The SDK never enforces a per-user-message → per-result mapping; it only forwards bytes both directions.

`isSingleUserTurn` is set to `true` only when a `WarmQuery` is given a string prompt (sdk.mjs line 106 ~offset 666263: `if(typeof O==="string") K.setIsSingleUserTurn(!0)`). For the regular `query()` function with a string, the same path is reachable indirectly. With an `AsyncIterable` it stays `false`.

### F2. The Query class `j9` has a `readMessages` loop that watches for `type === 'result'` but does NOT terminate iteration on it.

**Location:** sdk.mjs line 59, class `j9`, method `readMessages` (offset starts ~263785; the result-handling branch is at ~270697).

```js
// sdk.mjs line 59, ~offset 270697 (whitespace + minified-name renaming applied)
if($.type==="result"){
  if(this.transcriptMirrorBatcher) await this.transcriptMirrorBatcher.flush();
  this.lastErrorResultText = $.is_error
    ? ($.subtype==="success" ? $.result : $.errors.join("; "))
    : void 0;
  this.firstResultReceived = !0;
  if(this.firstResultReceivedResolve) this.firstResultReceivedResolve();
  if(this.isSingleUserTurn) {
    S$("[Query.readMessages] First result received for single-turn query, closing stdin");
    this.transport.endInput();
  }
}
// then unconditionally:
this.inputStream.enqueue($);
```

**Implication:**
- A `result` event is enqueued like any other message and surfaced through the public async generator.
- Iteration only ends when the **subprocess closes its stdout** (the upstream `for await (let $ of this.transport.readMessages())` loop terminates), not on `result`. Cleanup is in the same method's `finally` branch — it runs only when the input stream signals done.
- For string-prompt queries, the SDK calls `endInput()` after the first `result`, which causes the CLI subprocess to exit, which terminates iteration. For our AsyncIterable usage, neither the SDK nor the CLI closes the channel after a `result`; the CLI just goes idle waiting for the next stdin line.

### F3. The public async iterator on `Query` is a passthrough.

**Location:** sdk.mjs line 61, `readSdkMessages`:

```js
async*readSdkMessages(){
  try{ for await (let $ of this.inputStream) yield $; }
  finally{ await this.cleanup(); }
}
```

So `for await (const msg of query)` in polygram yields every line the subprocess emits, including all `result`s, until the subprocess exits.

### F4. `Query.interrupt()` is a control-channel request — pure RPC to the subprocess.

**Location:** sdk.mjs line 61, ~offset 274211+:

```js
async interrupt(){ await this.request({subtype:"interrupt"}) }
```

The SDK does NOT generate a synthetic `result` locally. The CLI subprocess decides what to do when it sees `subtype:"interrupt"`. Empirically (and per `SDKResultError.subtype` enum in sdk.d.ts:3121), interrupt produces a `result` with `subtype: 'error_during_execution'` and `stop_reason: null`-ish — but this is a runtime behaviour of the CLI we cannot read from sdk.mjs alone.

> **Type-side hint.** sdk.d.ts:5337-5339 defines `TerminalReason` for the `result.terminal_reason` field as `'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long' | 'image_error' | 'model_error' | 'aborted_streaming' | 'aborted_tools' | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred' | 'max_turns' | 'completed'`. No `'interrupted'` value. Comment: "Unset when the loop was bypassed (local slash command) or interrupted externally". So `interrupt()` is the second case — likely surfaced as `aborted_streaming` or `aborted_tools` (or no `terminal_reason` at all on the result), depending on what the agent was doing. **Needs runtime verification**.

### F5. `SDKResultMessage` always has `num_turns` populated and is a discriminated union.

**Location:** sdk.d.ts:3119-3160.

```ts
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;
export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number; duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;          // <- the AGENT-LOOP-LEVEL stop reason
    total_cost_usd: number; usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    uuid: UUID; session_id: string;
};
export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    /* ... */
    num_turns: number;
    stop_reason: string | null;
    /* ... */
    terminal_reason?: TerminalReason;
};
```

So when we get a `result`, `num_turns` tells us how many CLI-loop turns happened and `terminal_reason` (if set) tells us why the loop exited. `stop_reason` is a **string** but is most likely one of the `BetaStopReason` values (see F7) — the type widens to `string` because the CLI passes through whatever the API said.

### F6. Per-assistant-message `stop_reason` lives at `SDKAssistantMessage.message.stop_reason` and uses the BetaStopReason union.

**Location:** sdk.d.ts:2334-2341 + the import `import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'` at sdk.d.ts:1.

```ts
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;          // <-- has .stop_reason
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID; session_id: string;
};
```

`@anthropic-ai/sdk/.../messages.d.ts:1312`:

```ts
export type BetaStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'compaction'
  | 'refusal'
  | 'model_context_window_exceeded';
```

### F7. PostToolBatch hook contract.

**Location:** sdk.d.ts:1888-1906.

```ts
/**
 * Hook input for the PostToolBatch event. Fired once after every
 * tool call in a batch has resolved, before the next model request.
 * PostToolUse fires per-tool and may run concurrently for parallel
 * tool calls; PostToolBatch fires exactly once with the full batch.
 */
export declare type PostToolBatchHookInput = BaseHookInput & {
    hook_event_name: 'PostToolBatch';
    tool_calls: PostToolBatchToolCall[];
};

export declare type PostToolBatchHookSpecificOutput = {
    hookEventName: 'PostToolBatch';
    additionalContext?: string;
};
```

The doc comment is the load-bearing line: **"fired once after every tool call in a batch has resolved, before the next model request"**. So PostToolBatch happens between the assistant's `tool_use` block and the agent's next API call — the hook can inject `additionalContext` that the model sees on that next call. The `additionalContext` becomes part of the next user-turn in the API conversation; it does NOT cause an extra `result`.

The PostToolBatch hook fires **only on tool-using turns**. polygram already documents this ([lib/autosteer-buffer.js:34-37](../lib/autosteer-buffer.js#L34)): "tool-less turns (Claude answers without firing a tool) — the hook never fires, so a queued message would be lost". This matches the spike at [scripts/spikes/post-tool-batch.mjs:25-39](../scripts/spikes/post-tool-batch.mjs#L25) which validated marker-injection.

### F8. `priority`/`shouldQuery` on SDKUserMessage are advisory hints to the CLI scheduler.

**Location:** sdk.d.ts:3479-3498.

```ts
export declare type SDKUserMessage = {
    type: 'user';
    message: MessageParam;
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    /** When false, the message is appended to the transcript without
     *  triggering an assistant turn. It will be merged into the next
     *  user message that does query. */
    shouldQuery?: boolean;
    timestamp?: string; uuid?: UUID; session_id?: string;
};
```

This is the contract that the CLI binary understands. `shouldQuery: false` ⇒ "do not start a new turn; concat into next prompt". `priority: 'now'` ⇒ "process as soon as possible" (used by polygram for steer + autosteer follow-ups, see lib/process-manager-sdk.js:823-829).

> **Caveat from polygram history:** the comment at lib/autosteer-buffer.js:6-9 records that pushing a `priority:'now'` `SDKUserMessage` while the assistant is mid-`tool_use` block triggers the CLI's `m87` transcript-shape gate and emits a `result` with `subtype: 'error_during_execution'`. So in-flight pushes are unsafe; out-of-band injection via the PostToolBatch hook's `additionalContext` is the safe alternative. Documented again at lib/process-manager-sdk.js:807-822.

### F9. Stream-input mode supports many control RPCs but they are all "request" / "response" — none of them produce a synthetic `result`.

**Location:** sdk.mjs line 61, after `interrupt()`:

```js
async setPermissionMode($){ await this.request({subtype:"set_permission_mode",mode:$}) }
async setModel($){ await this.request({subtype:"set_model",model:$}) }
async setMaxThinkingTokens($){ await this.request({subtype:"set_max_thinking_tokens",max_thinking_tokens:$}) }
async applyFlagSettings($){ await this.request({subtype:"apply_flag_settings",settings:$}) }
async getSettings(){ return (await this.request({subtype:"get_settings"})).response }
async rewindFiles($,X){ /* … */ }
async cancelAsyncMessage($){
  return (await this.request({subtype:"cancel_async_message",message_uuid:$})).response.cancelled
}
```

`cancelAsyncMessage(uuid)` is interesting: doc-comment in sdk.d.ts:2386-2391 says "Drops a pending async user message from the command queue by uuid. No-op if already dequeued for execution." — i.e. you can rescind a buffered user message, but again no synthetic `result`.

### F10. The V2 `SDKSession.stream()` does treat `result` as a stop-iteration signal — but `Query` itself does NOT.

**Location:** sdk.mjs line 64, `class mz` `stream()` method (offset ~286364).

```js
async*stream(){
  if(!this.queryIterator) this.queryIterator = this.query[Symbol.asyncIterator]();
  while(!0){
    let{value:$,done:X} = await this.queryIterator.next();
    if(X) return;
    if($.type==="system" && $.subtype==="init") this._sessionId=$.session_id;
    if(yield $, $.type==="result") return;          // <-- stops iter on FIRST result
  }
}
```

So **if** polygram ever migrates to the V2 `unstable_v2_createSession` API, the `stream()` iterator returns to the caller after the first `result`, and a second iteration call would be needed. Polygram uses the older `query()` path (`process-manager-sdk.js:41` `const { query } = require(...)`) and iterates the Query directly, so this V2 behaviour does NOT apply to us today.

---

## 2. Result-event firing matrix

For polygram (`AsyncIterable` input, `isSingleUserTurn === false`):

| Trigger / state                                                          | Does `result` fire?                            | Citation                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| Assistant emits text and `stop_reason='end_turn'`, no further loop work  | YES — `subtype:'success'`                      | F2 + F5                                                    |
| Assistant emits `tool_use` blocks                                        | NO — agent loop runs the tool, then continues  | F6 (BetaStopReason='tool_use' is not terminal)             |
| `tool_use` resolved, PostToolBatch returns `additionalContext`           | NO — context is folded into next API call      | F7; sdk.d.ts:1889                                          |
| `tool_use` resolved, PostToolBatch returns nothing, model answers + ends | YES — when the next assistant message ends_turn| F2 + F7                                                    |
| Hit `maxTurns`                                                           | YES — `subtype:'error_max_turns'`              | sdk.d.ts:3121                                              |
| Hit `maxBudgetUsd`                                                       | YES — `subtype:'error_max_budget_usd'`         | sdk.d.ts:3121                                              |
| `Query.interrupt()` called mid-tool                                      | YES (CLI emits a `result`, subtype TBD)        | F4; **needs runtime verification** for exact subtype       |
| `Query.interrupt()` called between turns (idle)                          | Likely no-op or no `result`                    | F4; **needs runtime verification**                         |
| `Query.close()` called                                                   | NO synthetic result; iteration ends via stdout EOF + cleanup | sdk.mjs line 64 ~offset 286590 + line 59 readMessages cleanup |
| Push `SDKUserMessage` with `shouldQuery:false` mid-turn                  | NO new `result` for that message; merged into next user-turn | F8; sdk.d.ts:3489-3491                                     |
| Push `SDKUserMessage` with `priority:'now'` mid-tool-use                 | YES — but CLI emits `subtype:'error_during_execution'` (m87 gate) | lib/autosteer-buffer.js:6-9 historical note              |
| Push `SDKUserMessage` between turns (CLI idle)                           | YES — counts as new turn → result on completion | (architectural inference; matches polygram FIFO usage)     |
| `pause_turn` stop reason (long-running streaming)                        | UNKNOWN — `pause_turn` exists in BetaStopReason but its mapping to result isn't documented in sdk.d.ts | **needs runtime verification**                          |
| `compaction` stop reason                                                 | NO — auto-compact emits `compact_boundary` system message; agent continues | sdk.d.ts:2356-2375                                         |
| `refusal` stop reason                                                    | YES — assistant ends, no more loop iterations  | inference                                                  |

---

## 3. stop_reason event flow for a tool-using turn

Stream of SDK events for **one** user input that produces a Bash tool call and a final answer (with PostToolBatch returning empty `additionalContext`):

```
1. {type:'user', ...}                       ← echo of our pushed SDKUserMessage
2. {type:'assistant', message:{
     content:[{type:'text', text:'Running...'},
              {type:'tool_use', name:'Bash', input:{...}}],
     stop_reason:'tool_use'}}                ← FIRST assistant message; loop continues
3. {type:'user', message:{
     content:[{type:'tool_result', tool_use_id:'...', content:'...'}]}}
4. {type:'system', subtype:'PostToolBatch', ...}    ← (only present if includeHookEvents)
                                              ← hook callback runs in JS, returns
                                                additionalContext (empty in this scenario)
5. {type:'assistant', message:{
     content:[{type:'text', text:'I ran the command and...'}],
     stop_reason:'end_turn'}}                ← SECOND assistant message; this terminates loop
6. {type:'result', subtype:'success',
     stop_reason:'end_turn',                 ← reflects the FINAL assistant message
     terminal_reason:'completed',
     num_turns:2, ...}                        ← num_turns=2 (one initial + one post-tool)
```

If the hook returns `additionalContext`, replace step 5 with another `tool_use`/`tool_result` cycle (step 5/6 repeat with different content) — and `result` is delayed indefinitely as long as additional context keeps arriving.

The `stop_reason` on each `SDKAssistantMessage.message` is the API-level Beta stop reason. The CLI uses this to decide whether to keep looping:

- `tool_use` → run tools, optionally fire PostToolBatch hook, then call API again.
- `end_turn` → emit `result` (unless a `Stop` hook intervenes).
- `max_tokens` → likely emit `result` with `subtype:'error_during_execution'` or continue with a follow-up call. **needs runtime verification**.
- `pause_turn` → API-side hint that the model wants to be re-prompted after a wait; CLI behaviour **needs runtime verification**.
- `stop_sequence` → emit `result`.
- `compaction` → triggers a compact_boundary; loop continues. (sdk.d.ts:2356-2375.)
- `refusal` → emit `result`.
- `model_context_window_exceeded` → likely `subtype:'error_during_execution'`.

Each individual `assistant` event fires regardless; only the **last** one before the loop exits maps to the `result`'s `stop_reason`.

---

## 4. PostToolBatch + additionalContext behaviour — explicit answer

> **Question.** When the hook returns `additionalContext`, does the SDK
> (a) treat it as a new user-message-equivalent that REQUIRES the agent to keep looping (no result event), OR
> (b) inject it as side context and let the agent decide whether to end_turn anyway?

**Answer: (b) with a strong nudge toward keep-looping.**

The doc comment at sdk.d.ts:1889 states that PostToolBatch fires "before the next model request". The hook's `additionalContext` becomes part of the next prompt to the model on a request the CLI was **already going to make** (because the assistant just finished a `tool_use` and the loop continues). The agent then decides on that next API call whether to:
- emit more `tool_use` blocks (loop continues),
- emit text + `end_turn` (loop exits → `result`),
- or any other stop_reason.

So the hook is NOT a forcing function. It's a context injection whose *effect* on the loop is whatever the model decides. In practice, when polygram injects `<channel source="user-followup">…instructions…</channel>` (lib/autosteer-buffer.js:71-75), the model is highly likely to treat the new content as actionable and either tool-use or text-respond — but if the new content is "ignore this" the model can `end_turn` immediately.

**This validates polygram's autosteer design.** The single-turn-absorbs-N-messages observation in production is the natural consequence of a model that, every time it finishes a tool batch, sees "by the way, here's another follow-up — work on it" and chooses to keep tool-using.

Empirical evidence in-repo:
- [scripts/spikes/post-tool-batch.mjs](../scripts/spikes/post-tool-batch.mjs) confirms the marker injected via `additionalContext` reached the model and was incorporated. The spike's invariant: "marker present in reply" (PASS).
- [docs/0.8.0-phase0-findings.md](./0.8.0-phase0-findings.md) Phase 0 gates 1, 2, 9 (PASS), gates 6/7 (DEFER) — gate 6 is the steer-mid-tool semantic that landed as the autosteer mechanism in rc.9.

**Corollary.** There is no `additionalContext`-induced `result`. As long as the hook keeps returning non-empty `additionalContext` and the model keeps tool-using, the SDK consumer sees:

```
…assistant(tool_use) → user(tool_result) → assistant(tool_use) → user(tool_result) → …
```

with NO `result` event in between. Only when (a) the hook returns no additionalContext AND (b) the model emits a non-tool-use stop reason do we get a `result`. This is the production behaviour described in the question.

---

## 5. Interrupt-based fix viability

> **Question.** Can we use `Query.interrupt()` between visible replies to force a `result` boundary so polygram's "user turn vs SDK turn" mismatch is bounded?

**Mechanism (verified):** `interrupt()` sends `{type:'control_request', request:{subtype:'interrupt'}}` to the CLI subprocess (F4). The CLI handles it server-side. The control protocol comment at sdk.d.ts:2608-2613 describes it as "Interrupts the currently running conversation turn."

**Likely effect (needs runtime verification):**
1. CLI aborts the in-flight model request and any in-flight tool calls.
2. CLI emits a `result` whose `subtype` is `'error_during_execution'` (only error subtype that fits) and whose `terminal_reason` is one of `'aborted_streaming' | 'aborted_tools'` per sdk.d.ts:5339.
3. Subsequent pushed `SDKUserMessage`s start a fresh loop and produce a new `result` on completion.

**Viability for polygram's "bound the user-turn vs SDK-turn drift" goal:** PARTIALLY VIABLE.

Pros:
- `interrupt()` is the cleanest documented way to force the CLI out of an in-progress agent loop.
- Polygram's existing `pm.interrupt()` (lib/process-manager-sdk.js:721-731) is wired to it and used today by `/stop` and turn-timeout (line 627-643).
- After the `result` lands, polygram's `_handleEvent` already resolves the head pending with the interrupted result (lib/process-manager-sdk.js:485-560).

Cons / caveats:
1. `interrupt()` causes a `subtype !== 'success'` result. polygram's transient-retry path (lib/process-manager-sdk.js:486-525) checks `isTransientHttpError` and won't retry on aborts, but the surrounding code treats `subtype !== 'success'` as "error" in metrics and the user-visible reply is whatever the assistant had emitted before the interrupt landed. If the assistant was streaming text when interrupted, the user sees a partial answer; if it was mid-tool-use, the assistant text might be empty or fragmentary.
2. The CLI's `m87` transcript-shape gate from lib/autosteer-buffer.js:6-9 historically also fired `error_during_execution` for malformed in-flight pushes. Distinguishing "interrupt" from "transcript malformed" at the result level requires reading `terminal_reason`, which is optional and may be unset.
3. Interrupting in the middle of a `tool_use` leaves a "dangling" tool_use in the transcript that the next user message must avoid feeding back as plain text (otherwise we re-trigger m87). This is gate 7 in sdk-spike (DEFER, "requires running Bash + interrupt + resume; manual verification recommended" — line 226-229).
4. There is no SDK-level `result` subtype dedicated to "user-induced interrupt" (compare gate-7 to the OpenClaw bridge which has explicit "cancel" semantics). We're piggybacking on `error_during_execution`.

**Recommended interrupt-based design (if we go this way):**
- After every visible-reply opportunity (e.g. assistant text emitted with newline boundary, or every PostToolBatch fire), check if the autosteer buffer has anything queued AND it's been > N seconds since the user's last message.
- If yes, `await query.interrupt()`. Wait for the resulting `result` (will arrive with non-success subtype). Treat this `result` as "soft turn boundary" — resolve any pending Telegram visible-typing reactions, then push the buffered follow-ups as a fresh SDKUserMessage.
- Cost: a second API turn, more tokens.
- Risk: dangling tool-use (gate 7); needs runtime verification of how the CLI handles a fresh user message after a mid-tool-use interrupt.

**Alternative (lower-risk):** Don't interrupt; instead, after PostToolBatch drains the buffer, set a watchdog timer in pm-sdk. If no new SDK message arrives within N seconds AND the autosteer buffer was non-empty during the last drain AND we have visible-reply backlog, surface a synthetic "still working on it" Telegram message. Doesn't bound the SDK turn but bounds the *user-visible silence*. Avoids gate-7 risk entirely.

---

## 6. Multi-turn input — how does the SDK handle a second pushed message during an in-flight turn?

**Question.** When we push a second `SDKUserMessage` into the input AsyncIterable, does the SDK process it as a new turn or append it to the active turn's context?

**Answer: it depends on `priority` + `shouldQuery` and on the CLI's current state.**

What the SDK does (verified):
- `streamInput` (sdk.mjs line 62 ~offset 274211) writes each message to subprocess stdin as a stream-JSON line. No buffering, no batching, no SDK-side gating. Pushes happen in `for await` order.
- The SDK does NOT decide whether the message is a new turn vs. side context. That decision is made by the CLI subprocess based on the message's `priority`, `shouldQuery`, and the CLI's own scheduler state.

What the CLI does (per F8 + lib/autosteer-buffer.js comments):
- `shouldQuery: false` → message is appended to the transcript and merged into the next user prompt that does `shouldQuery: true` (or no flag, default true). No separate `result`.
- `priority: 'now'`, mid-tool-use → m87 gate fires → `result` with `subtype:'error_during_execution'`.
- `priority: 'now'`, between turns → starts a new turn → produces a fresh `result` on completion.
- Default flags, between turns → FIFO queued, processed when CLI is idle → produces a fresh `result` on completion.

This is consistent with polygram's pm-sdk pendingQueue design: one pending per pushed user message, expecting a 1:1 mapping with `result` events. **The mapping breaks** when:
- The hook keeps absorbing context (no result fires for many user-equivalent inputs), OR
- An m87 gate event collapses two pushes into one `result`.

---

## 7. Other implementations — chat-application patterns

I did not find OpenClaw source files (`pi-embedded-helpers-CNhhELVT.js`, `~/.claude/agents/openclaw*`) on this machine — they don't exist in `/Users/ivanshumkov/Projects/shumkov/polygram` nor in the user's home Claude config. The reference would need to come from elsewhere (a personal vault, an Anthropic internal tool).

What I found in-repo regarding chat-app patterns:

- `polygram.js:875+` `buildSdkOptions(sessionKey, ctx)` — the canonical "one Query per chat" wiring, including the PostToolBatch hook (line 928-975).
- `lib/process-manager-sdk.js:9-37` — design notes for "one Query per active sessionKey, held for the chat lifetime"; explicitly references "Phase 0 gate 1 PASS — long-lived input AsyncIterable works".
- `lib/autosteer-buffer.js:1-37` — the autosteer mechanism that resolves the "user sends mid-turn" UX. The design note at line 5-9 explicitly calls out the failed approach (`priority:'now'` push) and the working approach (PostToolBatch + additionalContext + `<channel>` framing).
- The polygram-design.md (`docs/polygram-design.md`) likely has more — not loaded here for token budget.

Public Anthropic docs on the SDK's intended use: not fetched (sandbox blocks docs.anthropic.com). What's in the SDK README would be the authoritative reference; recommend fetching `https://docs.anthropic.com/en/api/agent-sdk/typescript` and the SDK-Typescript repo on GitHub if a deeper survey is needed.

---

## 8. Known unknowns / what would need a spike

For each unknown, I list a minimal test snippet polygram could ship at `scripts/spikes/`.

### U1. `interrupt()`'s exact result subtype + terminal_reason

**Question.** What `subtype` and `terminal_reason` does the CLI emit on `interrupt()` mid-tool, mid-text, and between turns?

**Snippet** (`scripts/spikes/interrupt-result-shape.mjs`):
```js
import { query } from '@anthropic-ai/claude-agent-sdk';
function makeInputController() { /* same as sdk-spike.js:67-89 */ }

async function probe(scenario, midAction) {
  const { iter, push, close } = makeInputController();
  push({ type:'user', message:{ role:'user', content:'Run `sleep 5` via Bash, then say hello.' } });
  const q = query({ prompt: iter, options: {
    model:'claude-haiku-4-5', effort:'low',
    permissionMode:'bypassPermissions', allowDangerouslySkipPermissions:true,
    cwd:'/tmp', maxBudgetUsd:0.05,
  }});
  let result, sawAssistantText = false;
  const pump = (async () => {
    for await (const m of q) {
      if (m.type==='assistant' && m.message?.content?.some(b=>b.type==='text')) sawAssistantText=true;
      if (m.type==='result') { result=m; break; }
    }
  })();
  await midAction(q, () => sawAssistantText);
  await pump; close();
  console.log(`[${scenario}] subtype=${result.subtype} stop_reason=${result.stop_reason} ` +
              `terminal_reason=${result.terminal_reason} num_turns=${result.num_turns}`);
}

await probe('mid-tool',  async (q) => { await new Promise(r=>setTimeout(r,2000)); await q.interrupt(); });
await probe('mid-text',  async (q,seen) => { while(!seen()) await new Promise(r=>setTimeout(r,50)); await q.interrupt(); });
await probe('post-result', async () => {});  // baseline
```

### U2. Does interrupt-then-push cause m87 / dangling tool_use 400?

**Question.** Phase 0 gate 7 (sdk-spike.js:226-229) was DEFERRED. Does pushing a fresh user message after `interrupt()` (mid-tool) cleanly start a new turn, or does the CLI return a transcript-shape error?

**Snippet** (`scripts/spikes/interrupt-then-push.mjs`):
```js
// 1. push msg-A that runs `sleep 5`
// 2. wait 2s, interrupt()
// 3. wait for result-A (expect subtype !== 'success')
// 4. push msg-B (a plain question)
// 5. iterate; expect a clean result-B with subtype='success'
// 6. record both result.subtype values + any new error patterns
```

### U3. PostToolBatch with `additionalContext` AND `priority:'now'` push at the same time

**Question.** If we BOTH return `additionalContext` from PostToolBatch AND push a `shouldQuery:false` user message via inputController in the same window, do they both reach the model in the next API call, or does one overwrite the other?

This matters for option (b) in the fix proposal — if we want to inject AND have a knob to force-end-turn, we need to know whether the channels coexist.

**Snippet** (`scripts/spikes/dual-injection.mjs`):
```js
// PostToolBatch hook returns additionalContext='<channel>marker-A</channel>'
// AND on the same boundary, push {type:'user', message:{...marker-B...}, shouldQuery:false}
// Run a 3-tool prompt; check final assistant text for both markers
```

### U4. `pause_turn` and `max_tokens` behavior in CLI loop

**Question.** When the API returns `stop_reason:'pause_turn'` or `stop_reason:'max_tokens'`, does the CLI re-prompt automatically (loop continues) or emit `result`?

**Snippet** — harder to provoke; would need a long-output prompt that hits `max_tokens` or a model that supports `pause_turn` (Sonnet 4.5+). Defer until needed.

### U5. Long-running PostToolBatch hook (slow `additionalContext` computation)

**Question.** The hook in lib/autosteer-buffer.js is fast (in-memory drain). What's the timeout if the hook awaits something slow? sdk.d.ts:733-740 mentions `HookCallbackMatcher` has an optional `timeout`, but the global default timeout isn't documented in the .d.ts.

**Action.** Read `HOOK_EVENTS` constant (sdk.d.ts:721) + check `SDKHookCallbackMatcher` (sdk.d.ts:2877+) for the timeout default. **Needs source-side spelunking.**

### U6. Behavior if PostToolBatch returns `continue:false`

**Question.** sdk.d.ts:733 shows hook callback returns include `continue?: boolean`. If `continue:false`, does the agent loop terminate immediately and emit a `result` with `terminal_reason:'hook_stopped'`?

`TerminalReason` (sdk.d.ts:5339) lists both `'stop_hook_prevented'` AND `'hook_stopped'`. They likely correspond to (a) Stop hook returned continue:false, vs. (b) some-other-hook returned continue:false. **Needs runtime verification** — could be a clean force-end-turn primitive for polygram if `continue:false` works on PostToolBatch.

**Snippet** (`scripts/spikes/hook-continue-false.mjs`):
```js
// PostToolBatch hook returns { continue: false }
// Expect: result with subtype='error_during_execution' (or success?), terminal_reason='hook_stopped'
// If clean: this might be option (c) in the fix proposal — a force-end-turn that
// doesn't go through interrupt() and avoids the dangling-tool-use class of bug.
```

This is the most promising spike to run next: if `continue:false` from PostToolBatch produces a clean turn boundary without the m87/dangling-tool-use risks of `interrupt()`, polygram could use it as a "turn budget exceeded, end now" primitive.

### U7. What happens when `Query.return()` or `Query.throw()` is called?

**Location:** sdk.mjs line 59 (offset 267577 region):
```js
async return($){ return await this.cleanup(), this.sdkMessages.return($) }
async throw($){ return await this.cleanup(), this.sdkMessages.throw($) }
```

This is a less-known way to terminate iteration. polygram's `for await` loop ends cleanly if we call `entry.query.return()`. Does the CLI subprocess get notified? — `cleanup()` calls `transport.close()` which kills the subprocess (sdk.mjs line 105 ~offset 655374 process kill path). So `return()` is closer to a hard kill than a graceful end-turn. Don't use as a turn boundary.

---

## Appendix A. Quick file:line index

| Subject                                              | sdk.d.ts                | sdk.mjs                                          |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------ |
| `Query` interface                                    | 2017–2223               | class `j9` line 59 (offset 267577)               |
| `query()` factory                                    | 2225–2228               | function `y7$` line 106 (offset ~664364)         |
| `streamInput`                                        | 2202–2208               | line 62 (offset ~274211)                         |
| `readMessages` (transport)                           | —                       | line 59 (offset 263785)                          |
| `readSdkMessages` (passthrough)                      | —                       | line 61 (offset ~274211)                         |
| Result-message handling (`isSingleUserTurn` branch)  | —                       | line 59 (offset ~270697)                         |
| `interrupt()` request                                | 2027                    | line 61 (offset ~274211+ after `readSdkMessages`)|
| V2 `SDKSession.stream()` (early-exit on result)      | 3168–3183               | line 64 (offset ~286364)                         |
| `SDKResultMessage` discriminated union               | 3119–3160               | —                                                |
| `SDKAssistantMessage` + BetaMessage import           | 1, 2334–2341            | —                                                |
| `BetaStopReason` enum                                | (peer dep messages.d.ts:1312) | —                                          |
| `TerminalReason` enum                                | 5337–5339               | —                                                |
| `PostToolBatchHookInput` + spec output               | 1888–1906               | —                                                |
| `SDKUserMessage` (priority/shouldQuery)              | 3479–3498               | —                                                |
| `SDKControlInterruptRequest`                         | 2608–2613               | —                                                |

---

## Appendix B. polygram in-repo references

| File                                           | Lines       | Why                                                           |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `lib/process-manager-sdk.js`                   | 9–37        | Architecture notes: one Query per chat, FIFO pending queue    |
| `lib/process-manager-sdk.js`                   | 305–310     | `query({ prompt: inputController.iter, options })` call site  |
| `lib/process-manager-sdk.js`                   | 346–366     | Iteration loop (`for await of entry.query`)                   |
| `lib/process-manager-sdk.js`                   | 485–560     | `result` handling + transient retry                           |
| `lib/process-manager-sdk.js`                   | 627–643     | `fireTimeout` calls `query.interrupt()` on idle/wall-clock   |
| `lib/process-manager-sdk.js`                   | 803–841     | `steer()` — `priority:'now', shouldQuery:false` push pattern  |
| `lib/autosteer-buffer.js`                      | 1–37        | Autosteer design doc; m87 gate explanation                    |
| `lib/autosteer-buffer.js`                      | 71–75       | `<channel source="user-followup">` framing                    |
| `lib/autosteer-buffer.js`                      | 105–141     | `makePostToolBatchHook()` callback                            |
| `polygram.js`                                  | 928–975     | Hook wiring into `buildSdkOptions`                            |
| `polygram.js`                                  | 2496–2538   | Autosteer dispatch decision                                   |
| `scripts/spikes/post-tool-batch.mjs`           | full file   | Empirical PASS for additionalContext marker injection         |
| `scripts/spikes/tool-less-drain.mjs`           | full file   | Tool-less turn drain spike (companion mechanism)              |
| `scripts/sdk-spike.js`                         | 157–185     | gate 2: N=5 messages → 5 result events FIFO (PASSED)          |
| `scripts/sdk-spike.js`                         | 226–229     | gate 7: interrupt-mid-tool deferred                           |
| `docs/0.8.0-phase0-findings.md`                | full file   | Phase 0 spike results table                                   |
