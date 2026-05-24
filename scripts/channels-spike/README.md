# Channels Phase 0 spike

Throwaway. Verifies the Claude Code Channels protocol shapes the
`docs/0.11.0-channels-driver-plan.md` design depends on. Not production code.

## What we're verifying

1. Capability declaration: does claude accept `experimental.claude/channel` and `experimental.claude/channel/permission` keys?
2. Notification method names: is `notifications/claude/channel` actually what claude listens on?
3. `--mcp-config` + `--channels server:NAME` wiring: does the inline-MCP-config registration resolve `server:` references?
4. Tool call shape: when claude calls our `reply` tool, do the params match our declared `inputSchema`?
5. Permission relay: does `notifications/claude/channel/permission_request` actually fire when claude tries `Bash`?
6. Compaction race: what happens to a pending channel notification when `/compact` runs mid-turn?

## Setup (one-time)

```sh
cd scripts/channels-spike
npm install
```

This installs `@modelcontextprotocol/sdk` and `zod` isolated to the spike directory.
Production `package.json` stays untouched until Phase 1.

## Run

From the worktree root:

```sh
./scripts/channels-spike/run.sh
```

In a second terminal:

```sh
tail -F ~/.claude/debug/*.txt | grep '\[bridge\]'
```

The bridge pushes three test notifications to claude on a timer (T1 at 3s, T2 at 10s, T3 at 25s after startup) and logs every inbound MCP message as `[bridge] ...` JSON lines.

## Manual test plan

| # | Action | Expected log lines | Phase 0 question answered |
|---|---|---|---|
| 1 | Wait 3s after startup | `[bridge] push test_id=T1-simple` then `[bridge] tool_call name=reply args={chat_id:"T1-simple",text:"got T1"}` | (1)(2)(4) capability + notification + tool shape work |
| 2 | Wait 10s | `[bridge] push test_id=T2-perm` then either `[bridge] permission_request {...}` (good — relay works) OR claude refuses Bash without prompting (bad — relay not triggered for our channel) | (5) permission relay works |
| 3 | Wait 25s, then immediately type `/compact` in claude terminal | T3-compact notification + observe whether T3 arrives before, during, or after compaction. Note any drops. | (6) compaction race behavior |
| 4 | Type into claude terminal: a free-text message asking it to reply via the reply tool | Verify the bridge does NOT receive this — only outbound replies through the tool | sanity check that channel and terminal are separate input paths |

## Capturing findings

After the run, append observations to `findings.md` in this directory.
Each finding goes into the plan doc or the risk register depending on what we learn.

## Exit criteria for Phase 0

Per the plan:
- Round-trip msg works (at least T1 confirms text + tool round-trip) ✓ or ✗
- Compaction race documented (test 3 above) ✓ or ✗
- Capability names confirmed (T1 alone confirms this — if claude rejects our capability declaration, the bridge never sees inbound) ✓ or ✗

If all three pass → proceed to Phase 1 with confidence the plan's protocol assumptions are correct.
If any fail → update the plan doc with the actual shape before Phase 1.

## Cleanup

The spike is throwaway. After Phase 1 lands, delete this whole directory:

```sh
rm -rf scripts/channels-spike
```
