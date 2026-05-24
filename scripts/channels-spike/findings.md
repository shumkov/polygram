# Phase 0 spike findings

Captured during the spike run. Updates here feed back into `docs/0.11.0-channels-driver-plan.md`.

## Run metadata

- Date: 2026-05-24
- Claude binary: `~/.local/share/claude/versions/2.1.142`
- Bridge node version: v24.4.0
- Operator: headless (claude `-p` + `--input-format stream-json` + `--verbose`)
- Bridge: `scripts/channels-spike/phase0-bridge.mjs` with `SPIKE_FAST=1` (timeline 1.5s/6s/12s)
- Session id: `80aa25dd-57cd-4958-adb4-6df8d9379709`
- Cost: ~$0.28

## Headless runner caveat

`claude -p` / `--input-format stream-json` was used because no interactive operator was available. Two of the six Phase 0 questions are fundamentally untestable in `-p` mode (see "Untestable headlessly" below). An interactive operator run is still required to close those.

## Capability declaration

- ✅ Claude accepts `experimental.claude/channel` — `phase0-bridge` appears in the init system message's `mcp_servers` list
- ✅ Claude accepts `experimental.claude/channel/permission` — no rejection on startup
- ✅ No warnings on startup
- Evidence (system init message):

```json
{"subtype":"init","model":"claude-opus-4-7","session_id":"80aa25dd-...","mcp_servers":["…","phase0-bridge","…"]}
```

## `--mcp-config` + `--channels server:NAME` wiring

- ✅ **Works as designed.** The inline `mcp-config.json` registering `phase0-bridge` resolves the `server:phase0-bridge` reference in `--channels`. No `plugin:` prefix or marketplace entry required during the research-preview dev flow.
- Caveat: `--mcp-config` is variadic (`<configs...>`) so it must be passed LAST in the arg list or other flags get gobbled. Recipe:
  ```sh
  claude --channels server:phase0-bridge \
         --dangerously-load-development-channels \
         --strict-mcp-config \
         [other flags...] \
         --mcp-config path/to/config.json
  ```
- Update plan's ChannelsProcess.start() spawn-args to reflect arg ordering.

## Tool naming

- ✅ **Confirmed:** Bridge declares tool as `reply`; Claude refers to it as **`mcp__phase0-bridge__reply`**.
- Format: `mcp__<server-name>__<tool-name>`
- Implication: if Claude is reasoning about the reply tool in chain-of-thought, it will use the prefixed name. Bridge `instructions:` should mention the prefixed name explicitly so Claude doesn't get confused. Plan's bridge `instructions:` string needs an update.
- Evidence: Claude's `ToolSearch` query: `{"query":"phase0-bridge reply"}` → result `{"tool_name":"mcp__phase0-bridge__reply"}`

## Notification method names

- ⚠️ **Not directly observable from headless run.** Bridge called `mcp.notification({ method: 'notifications/claude/channel', ... })` three times (logged) but no `<channel>` tag appeared in Claude's transcript. Method name MAY be correct — what failed is that `-p` mode didn't trigger turns from the notifications (see next section). Cannot rule out method name being wrong without an interactive run.

## Channel notification delivery in `-p` mode (NEW FINDING)

- ❌ **Channel notifications do NOT auto-trigger new turns in `-p` mode.** The bridge successfully pushed all three notifications. Claude completed its initial 2 turns (system → ToolSearch+reply with "Ready. Standing by") and then idled until stdin closed at 25s — never processing the channel notifications.
- Bridge log confirms all 3 pushes succeeded:
  ```
  [bridge] {"kind":"push","test_id":"T1-simple"}
  [bridge] {"kind":"push","test_id":"T2-perm"}
  [bridge] {"kind":"push","test_id":"T3-compact"}
  ```
- Claude transcript shows zero subsequent turns or `<channel>` tag injections.
- **Implication for polygram:** This is fine for polygram's intended usage — ChannelsProcess always launches `claude` interactively in tmux, never with `-p`. But it's worth a one-line note in the plan: "Channels driver requires interactive claude — `-p` mode does not auto-trigger turns from channel notifications. ChannelsProcess uses tmux which always launches interactive."
- Possible alternative explanation: protocol shapes are wrong (method name, capability key, etc.) and notifications silently dropped. Cannot disambiguate without an interactive run.

## Untestable headlessly (need interactive operator)

1. **Notification round-trip (T1):** confirms whether `notifications/claude/channel` + `<channel>` tag format actually delivers to Claude's context.
2. **Permission relay (T2):** `permission_request` notification format + verdict round-trip. Headless run with `--print` disables interactive permission gates, and our run never reached Bash invocation anyway.
3. **Compaction race (T3):** requires manually typing `/compact` mid-turn in the TUI.

These three remain open. Run interactively per the README before declaring Phase 0 complete.

## Bridge lifecycle (verified)

- ✅ Bridge starts as stdio child of claude — `[bridge] startup pid=26227 node=v24.4.0`
- ✅ Bridge handles `ListTools` request — `[bridge] list_tools`
- ✅ Bridge exits cleanly on stdin close — `[bridge] stdin event=end`
- The `process.stdin.on('end' / 'close', exit)` handlers are working as the adversarial review predicted necessary.

## Decisions / plan updates

- [x] **Update plan's spawn-args ordering:** `--mcp-config` MUST come last (variadic flag gobbles subsequent args). Document in ChannelsProcess.start() sketch.
- [x] **Update bridge `instructions:` string:** reference the tool by its prefixed name `mcp__polygram-bridge__reply` (or however we name it) so Claude's reasoning doesn't drift.
- [x] **Add note to plan:** ChannelsProcess always launches interactive claude (no `-p`). Channel notifications do not auto-trigger turns in non-interactive mode.
- [x] **Add risk:** If Anthropic ever changes the `mcp__<server>__<tool>` naming format, the `instructions:` string becomes a fragile coupling. Low likelihood, low impact, just note it.
- [ ] **STILL OPEN — needs interactive run:** verify notification method names, observe `<channel>` tag format in Claude's transcript, verify permission_request shape, test compaction race. Run `./scripts/channels-spike/run.sh` (TUI mode) and append observations here.

## Phase 0 exit criteria status (after interactive tmux run)

- ✅ Capability names confirmed (claude accepted both capability keys)
- ✅ `--mcp-config` + dev-channel flag wiring proven (correction: in dev mode use `--dangerously-load-development-channels server:NAME`, NOT `--channels` — see flag-semantics note)
- ✅ Tool naming format confirmed (`mcp__<server>__<tool>`)
- ✅ Bridge stdio lifecycle verified (startup + clean exit on EOF)
- ✅ **Round-trip msg confirmed** — all 3 channel notifications arrived; Claude called `reply` for all 3 with correct chat_id passthrough
- ✅ **Compaction handled cleanly** — `/compact` completed without disturbing the channel; session continues to receive events post-compact
- ⚠️ Permission relay (T2-perm scenario) — **NOT YET TESTED.** Project settings auto-approved Bash, so `permission_request` never fired. Needs a focused test with a tool the project hasn't pre-approved.
- ⚠️ Compaction race during a live pending notification — **NOT TESTED.** Bridge was idle during /compact in this run.

**Phase 0 substantially complete.** Two narrow follow-ups (permission relay + true compaction race) are best done as integration tests inside Phase 1.

## Interactive tmux run — 2026-05-24

Cost: ~$0.60 (xhigh effort). Method: `tmux new-session -d ... claude ...` with output captured via `tmux capture-pane`, bridge stderr piped to `/tmp/spike-bridge.log` via mcp-config wrapper.

### Argument syntax corrections (Phase 0 spike findings — must land in plan)

1. **`--dangerously-load-development-channels` IS the channel-entry flag in dev mode.** It takes entries directly: `--dangerously-load-development-channels server:phase0-bridge`. Do NOT also pass `--channels` — claude treats the next arg as a channel entry and rejects e.g. `--strict-mcp-config` as malformed:
   ```
   --dangerously-load-development-channels entries must be tagged: --strict-mcp-config
   ```
2. **`--no-session-persistence` is `--print`-mode only** — rejected in interactive mode with "Error: --no-session-persistence can only be used with --print mode."
3. **`--mcp-config` is variadic.** Must come LAST in the arg list or it eats subsequent flags. Already in plan.
4. **`--strict-mcp-config` is safe to keep** for isolation.
5. **No `tee` pipe on claude stdout.** Piping triggers print-mode auto-switch ("when stdout is not a TTY, e.g. piped or redirected output") and the session dies with "Input must be provided through stdin or as a prompt argument."

Working interactive invocation:
```sh
tmux new-session -d -s phase0-spike -c <worktree> -x 200 -y 50 \
  "<pinned-claude-bin> --strict-mcp-config \
                       --dangerously-load-development-channels server:phase0-bridge \
                       --mcp-config /tmp/spike-mcp-headless.json"
# then handle the trust dialog + dev-channel confirmation dialog via tmux send-keys Enter
```

### Channel notification format (as rendered in TUI)

The TUI displays inbound channel notifications as:
```
← phase0-bridge: <content first line, ellipsized>
```
The `←` arrow distinguishes them from `❯` user input. The full content arrives in Claude's context as a `<channel ...>` tag per the docs, but the TUI summarizes inline.

### Tool-call shape (observed verbatim from bridge log)

```json
{"kind":"tool_call","name":"reply","args":{"chat_id":"T1-simple","text":"got T1"}}
{"kind":"tool_call","name":"reply","args":{"chat_id":"T2-perm","text":"ran `echo hello-from-T2`, stdout: `hello-from-T2`"}}
{"kind":"tool_call","name":"reply","args":{"chat_id":"T3-compact","text":"ack T3"}}
```

Claude correctly echoed back the `chat_id` from inbound `meta.test_id` (we mapped test_id→chat_id in the prompt instructions, and Claude followed it without drift). This validates the bridge's plan to pass `chat_id` verbatim from inbound→outbound.

### Compaction observation

`/compact` ran from 0% → 100% (~30s) with no disruption to the running channel. After compaction completed:
```
❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)
     Tip: You have access to Opus 1M with 5x more context
```
Channel listener remained active (`Listening for channel messages from: server:phase0-bridge` still present in TUI banner). No new notifications were pushed mid-compact in this run, so the queueing-during-compact behavior remains a doc claim, not a measured outcome.

### Misleading warning (worth a note in risk register)

Claude shows this line in the TUI banner even when the channel works perfectly:
```
server:phase0-bridge · no MCP server configured with that name
```
Benign — the bridge spawns, notifications flow, tool calls return. Probably a race during MCP server registration vs. channel binding. Worth a one-line risk-register note so future debuggers don't waste time on it.

### `permission_request` notification — open

Claude ran `Bash` for the T2 test without triggering any permission_request through the bridge. Two possible causes:
1. Auto-mode (`⏵⏵`) was on by default in this session; auto-mode pre-approves all suggested tool uses.
2. The polygram-0.11.0 worktree's project settings allow Bash freely (Claude Code's per-directory permission cache).

Disambiguation requires a focused follow-up run with: auto-mode off (verified via `shift+tab` cycle showing manual mode) + a tool the directory has NEVER approved (e.g. `Write` to a path outside the worktree). Defer to Phase 1 integration test.
