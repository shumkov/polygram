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

## Phase 0 exit criteria status

- ✅ Capability names confirmed (claude accepted both capability keys)
- ✅ `--mcp-config` + `--channels server:NAME` wiring proven
- ✅ Tool naming format learned (`mcp__<server>__<tool>`)
- ✅ Bridge stdio lifecycle verified (startup + clean exit on EOF)
- ⚠️ Round-trip msg unverified — couldn't confirm `<channel>` tag delivery in headless mode
- ⚠️ Compaction race undocumented — needs interactive run

**Phase 0 partially complete. Interactive verification run required before unblocking Phase 1.**
