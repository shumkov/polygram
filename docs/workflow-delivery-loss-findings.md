# Workflow completion delivery loss — production findings

**Status:** root cause confirmed; fixes implemented in open PRs, not merged or deployed

**Investigated:** 2026-07-24

**Incident:** Shumabit@UMI, topic 37, 2026-07-23

## Executive summary

The Workflow completed normally. Its result reached the parent Claude session, the
parent read and processed it, and the parent produced a substantive final answer.
Telegram delivery was never attempted.

The loss requires two conditions:

1. Claude emits the autonomous completion as ordinary inline assistant text instead
   of calling `mcp__polygram-bridge__reply`.
2. The CLI adapter receives the resulting `Stop` while it has no pending polygram
   turn. It records the Stop internally but has no fallback that forwards
   `last_assistant_message` as an autonomous message.

Both conditions occurred in the incident. The first is encouraged by a direct prompt
conflict: Orchestra's persistent channels prompt says inline output is invisible and
the reply MCP tool is mandatory, while every polygram user prompt says “Just reply
with text” and “Do NOT use Telegram MCP tools” in
[`lib/prompt.js`](../lib/prompt.js). The second is a deterministic gap in
`@shumkov/orchestra@0.4.2`.

This also explains the later false claim that the report had been posted. The
undelivered inline answer is present in Claude's own transcript as an assistant
message, so Claude sees evidence that it answered even though Telegram never saw it.

This is not specific to forum topics, and it was not caused by a restart, a closed
bridge, a Telegram API failure, or a missing Workflow result. The cited Ivan-DM
comparison was not an automatic-delivery success: its autonomous result was also
lost, and the visible report and media were sent only after the user asked for them.

## Delivery path

### What Workflow actually does

The Workflow tool returns immediately to the launching turn and continues in the
background. On completion, Claude Code adds a `<task-notification>` to the parent
session and starts a later parent turn. It does not call polygram's IPC endpoint and
does not directly send to Telegram.

This matches Claude Code's documented model: a background result reaches Claude as a
completion notification in a later turn. The SDK exposes the same event explicitly
as `TaskNotificationMessage`.

Sources:

- [Claude Code background-subagent lifecycle](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)
- [Claude Agent SDK `TaskNotificationMessage`](https://code.claude.com/docs/en/agent-sdk/python)

### CLI/channels delivery

For a CLI-backed chat, Orchestra's appended system prompt establishes the correct
contract:

- stdout/TUI text is invisible to the Telegram user;
- all user-visible output must use `mcp__polygram-bridge__reply`.

When that tool is called, `CliProcess._dispatchToolCall()` invokes polygram's
[`channels-tool-dispatcher.js`](../lib/process/channels-tool-dispatcher.js). The
dispatcher immediately sends through the shared Telegram pipeline, using the
process's stored `chatId` and `threadId`. This path remains available after the
launching turn resolves, so a reply-tool call is a valid out-of-turn delivery.

After a successful out-of-turn reply call, Orchestra emits
`autonomous-assistant-message` with `alreadyDelivered:true`. Polygram's
[`onAutonomousAssistantMessage`](../lib/sdk/callbacks.js) logs that event and avoids
sending a duplicate.

There is no corresponding event when an autonomous CLI turn emits only inline text.
On `Stop`, Orchestra applies the `last_assistant_message` fallback only to a pending
turn. With zero pending turns, the Stop produces no deliverable callback.

### IPC is a separate path

[`lib/handlers/ipc-send.js`](../lib/handlers/ipc-send.js) and the bundled
[`polygram-send` skill](../skills/polygram-send/SKILL.md) provide an independent
Unix-socket path for cron jobs, generated files, and explicit out-of-band sends.
Workflow does not invoke this path automatically. No IPC send occurred in either
reproduced Workflow completion.

The skill text also reflects the same stale contract as `lib/prompt.js`: it says
normal inline text is automatically delivered and tells the agent not to use the
Telegram MCP tool. That advice is correct for an SDK turn but conflicts with CLI
channels mode.

### SDK contrast

`SdkProcess` directly emits `autonomous-assistant-message` when an assistant message
arrives with no pending head. Polygram's existing callback then resolves the
chat/topic and sends it through the normal pipeline. The structural hole is therefore
specific to the CLI adapter.

There were no Workflow calls in `umi-assistant.db` during the available window, and
every production Workflow sample was `backend:"cli"`, so there is no production
Workflow sample with which to validate the SDK path.

## Incident trace

All times below are VPS local time (UTC+7).

| Time | Evidence |
|---|---|
| 23:16:13 | `Workflow` `PreToolUse`; its tool result returned in 32 ms, confirming background launch rather than completion. |
| 23:16:21 | The launching turn stopped. |
| 23:16:23 | Polygram resolved the launching turn. |
| 23:38:39 | The parent JSONL received the Workflow `<task-notification>` with an output-file path. |
| 23:38:43–23:40:00 | The parent acknowledged completion inline, read the result, and persisted the report externally. |
| 23:40:15 | The parent produced a 1,917-character final inline answer. It made zero reply-MCP calls. |
| 23:40:15 | `Stop` fired with no pending polygram turn. No outbound message row was created. |
| 23:55:39 | The user asked for progress. |
| 23:55:53 | A normal pending turn let the Stop fallback deliver Claude's inline claim that the report had appeared above. |
| 23:56:29 | After correction, Claude called `mcp__polygram-bridge__reply`; the dispatcher sent the real result successfully. |

The completion therefore survived end to end through Workflow, its output file, the
parent context, and Claude's synthesis. The sole missing edge was parent-output to
Telegram.

## Why the main alternatives do not fit

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Daemon restart during completion | Ruled out | The service started at 18:51:49, stayed up through the 23:38–23:40 completion, and next stopped at 00:43:00. |
| Launch-turn-close race broke the bridge | Ruled out as the trigger | Out-of-turn reply calls are designed to dispatch with no pending turn. The same session successfully called reply at 23:56. |
| Telegram API/send failure | Ruled out | There was no pending or failed outbound row because the dispatcher was never invoked. |
| Topic/thread correlation | Ruled out | A different isolated UMI topic delivered successfully; failures also occurred in the non-topic Ivan DM. The dispatcher supplies `threadId` from session state rather than asking Workflow to reconstruct it. |
| Workflow failed or lost its result | Ruled out | The completion notification arrived, the output was read, and a full inline final answer was recorded. |
| Claude merely forgot to summarize | Ruled out | The transcript contains the substantive final summary at the completion boundary. |

## The “working” Ivan-DM comparison

The DM run launched at 21:59:46 and its autonomous completion cycle ran from
22:15:07 to 22:17:11. That cycle used `Read`, `Write`, and `Bash`, produced about
2,300 characters of inline assistant text, made zero reply-tool calls, and created
zero outbound rows.

The user then said that nothing had been shown. Only after that prompt did the
session deliver text and four images through the channels dispatcher, followed by a
normal completion message.

It is the same failure shape as topic 37. The later manual recovery made the overall
interaction look successful.

## Production prevalence

Two retention details matter:

- `hook-lag-sample` is a diagnostic event and is pruned after 14 days by
  [`lib/db/events-retention.js`](../lib/db/events-retention.js), so a nominal
  30-day DB query cannot recover all 30 days of Workflow launch hooks.
- Claude JSONL transcripts remain available for the full requested period and were
  scanned separately for task notifications and reply-tool use.

Results:

| Measure | Result |
|---|---:|
| Workflow completion cycles found in 30-day JSONL scan | 7 |
| Completion cycles with a reply-tool call | 4 |
| Completion cycles with substantive inline text but no reply-tool call | 3 |
| Automatic-completion loss rate | **3/7 (43%)** |
| Retained launch runs in DB events | 6 runs / 7 `Workflow` calls |
| Retained launch runs with a lost completion | **3/6 (50%)** |
| Distinct affected scopes | 2: Ivan DM and UMI topic 37 |
| Exact “already posted” → user-correction pairs in 30-day message search | 1 |
| Workflow calls in `umi-assistant.db` | 0 |
| Backend for every observed Workflow call | `cli` |

The three lost completions were not empty acknowledgements: their autonomous cycles
contained roughly 2.1K, 4.4K, and 2.3K characters of inline assistant text.

The exact hallucination/correction wording is rarer than the underlying loss. Only
the reported topic-37 incident matched the searched “already sent/posted above”
claim followed by a contradicting user message.

### Other asynchronous tools

The 30-day JSONL scan found 18 background `Agent` task notifications:

- 2 completion cycles called the reply tool;
- 16 did not;
- 15 of those 16 emitted inline assistant text.

This proves the same transport condition is broader than Workflow. It does **not**
mean 16 user-visible reports were lost: several notifications are intermediate
fan-in steps where only a later aggregate result should be sent. Determining an
`Agent` failure rate requires reconstructing the user-visible intent of each
multi-agent run, which was outside the narrow incident query. The adapter-level risk
is nevertheless the same.

That ambiguity also identifies the safety boundary for a deterministic fallback.
A structural, content-free scan of the same 30-day transcripts found:

- all 7 Workflow calls had a later `<task-notification>` whose
  `<tool-use-id>` matched the originating Workflow tool-use id;
- no Workflow call lacked that matching completion notification;
- 77 other task notifications did not match a Workflow tool call;
- for every Workflow completion, the terminal assistant `end_turn` could be traced
  through JSONL parent UUIDs to the matching notification as its nearest user-text
  ancestor;
- genuine notifications carried native internal provenance
  `origin.kind:"task-notification"`, `promptSource:"system"`, and
  `isSidechain:false`; notification-shaped text without that record provenance is
  not authoritative.

This gives Orchestra a fail-closed eligibility test: rescue only a terminal final
whose transcript ancestry proves it was synthesized from a completed Workflow.
An ordinary user message, an Agent fan-in notification, missing ancestry, or schema
drift must not trigger the fallback.

## Root cause

The root cause is a contract mismatch plus a missing deterministic fallback.

1. Polygram and Orchestra disagree about how CLI output is delivered.
   `lib/prompt.js` supplies a recent per-message instruction to reply inline and
   avoid Telegram MCP tools, while Orchestra's persistent channels prompt requires
   the reply MCP tool.
2. Claude follows those contradictory instructions nondeterministically. In this
   sample it used the reply tool for four Workflow completions and ordinary inline
   text for three.
3. Orchestra has a normal-turn fallback for inline `last_assistant_message`, but no
   equivalent for a no-pending autonomous cycle.
4. The lost inline answer remains in Claude's transcript. On a later check-in,
   Claude interprets its own transcript as proof that the user received the answer,
   masking the delivery gap with a confident false claim.

## Why the fix is cross-package

A prompt-only change is small but not a reliable fix. It removes one source of
confusion, yet delivery would still depend on model compliance with a tool-call
contract. The production failures demonstrate that this cannot be the only guard.

The deterministic fix belongs in `@shumkov/orchestra`, which is a separate package
and owns CLI cycle/Stop attribution. It must also solve duplicate suppression and
interim-reply semantics. Polygram then needs a dependency bump and an integration
test. This crosses the turn-lifecycle boundary and was therefore implemented and
reviewed as a separate Orchestra change rather than a speculative patch in this
repository.

Claude Code 2.1.211 later added improved background-result reporting, specifically
waiting for real completion instead of fabricating results. That may reduce the
false-claim behavior, but it does not remove polygram's obligation to deliver an
inline autonomous result. Polygram is pinned to 2.1.173, and the repository's
documented CLI-upgrade gate correctly forbids an incidental version bump.

Source: [Claude Code changelog, 2.1.211](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2111)

## Recommended design

Implement the deterministic fallback in Orchestra, with prompt alignment as a
defense-in-depth companion:

1. At terminal Stop, capture the transcript boundary and prove structurally that
   the final's nearest user-text ancestor is a natively sourced task notification
   whose tool-use id identifies a Workflow call on the same mainline transcript.
   Fail closed for Agent fan-in, user-authored XML, queue echoes, ordinary user
   turns, malformed or ambiguous ancestry, and final mismatch.
2. Derive suppression from delivery receipts on that exact notification→final
   ancestry. Pair channels reply/edit tool-use blocks with their MCP tool results.
   Extend the bridge receipt to distinguish `delivery:"sent"` from
   `delivery:"replayed"` and carry the original opaque attempt id through
   timeout/error and dedup replay. A successful direct-send final reply suppresses
   fallback. A replay suppresses only when it links to the earlier timed-out attempt
   with matching arguments on the same ancestry; a prior-branch replay cannot.
   Successful direct or linked interim/edit text suppresses only a
   normalized-identical final. Missing/unknown receipt schema fails closed. Do not
   treat process-memory state, an unlinked cache hit, or an earlier cycle's success
   as proof. If Stop arrives after a bridge timeout but before the matching
   dispatcher settles, wait only for that causally named attempt; success
   suppresses, failure rescues, and missing post-restart state fails closed.
3. Snapshot the pending count before emitting the synchronous `stop-hook`; a
   normal pending listener can finalize inside that emit, and checking only the
   post-listener count would misclassify it as autonomous.
4. If the cycle is Workflow-qualified and no successful delivery suppresses it,
   emit `autonomous-assistant-message` with `alreadyDelivered:false`. Let
   polygram's existing callback route it through the shared Telegram pipeline
   using the session key, including its topic.
5. Prevent idle/LRU eviction while a validated reply/edit dispatch or transcript
   qualification is pending. Invalidate deferred transcript decisions on close,
   kill, reset, and bridge teardown. Log only content-free reasons, hashes,
   lengths, and counts.
6. Make polygram's per-message prompt backend-aware: retain inline-output guidance
   for SDK, but restate the reply-MCP contract for CLI. Explicitly say that
   transcript text is not proof of user-visible delivery; without a successful
   reply receipt, send the result now rather than claiming it was already posted.
   Update the bundled `polygram-send` guidance to match.

Required regression tests:

- reproduced Workflow shape: matching notification ancestry + no pending turn +
  inline final + Stop emits exactly one undelivered autonomous message;
- Agent notification, user-authored XML, wrong provenance, ordinary user input,
  malformed ancestry, and final mismatch fail closed;
- a successful same-branch reply receipt followed by Stop does not double-send;
- a prior-cycle success cannot suppress the Workflow completion;
- a completed-content cache replay is visibly distinct from a direct send and
  cannot suppress by itself;
- a same-branch slow-send timeout and retry share a causal attempt id, preventing a
  duplicate when Telegram received the original send;
- a timeout without retry waits only for its matching live/recent dispatcher
  outcome;
- successful delivery survives resume because its receipt is in the transcript;
- interim reply or edit followed by distinct inline final still delivers the final;
- `stopHookActive:true` does not deliver a premature answer;
- ordinary pending-turn fallback remains unchanged;
- ProcessManager does not evict a process with a validated dispatch or transcript
  decision in flight;
- the polygram callback delivers to the originating isolated topic;
- a real-Claude spike on pinned 2.1.173 covers background Workflow completion with
  no user follow-up.

This needs a reviewed cross-package spec before implementation, especially around
cycle identity when a real user message arrives during an autonomous completion.

## Changes made

The production DB and transcript queries were read-only. Temporary query scripts
were removed from both the worktree and the VPS after use. No production data,
configuration, package, or service state was changed.

The deterministic Workflow delivery contract is implemented in
[Orchestra PR #7](https://github.com/shumkov/orchestra/pull/7). The Claude
`2.1.220` readiness prerequisite and pin are split into
[Orchestra PR #8](https://github.com/shumkov/orchestra/pull/8) and
[Orchestra PR #9](https://github.com/shumkov/orchestra/pull/9).
[Polygram PR #27](https://github.com/shumkov/polygram/pull/27) contains the
fail-closed 21-cell compatibility, delivery, privacy, and acceptance gates.

The authoritative old/candidate matrix passed 21/21, the focused gate suite passed
146/146, the full Polygram suite passed with zero failures and 13 explicit skips,
and the Polygram Linux CI job passed. The Orchestra delivery and readiness PRs also
have green CI. All changes remain open for review: nothing has been merged,
published, tagged, or deployed.
