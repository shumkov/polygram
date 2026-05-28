# cli-driver-spike — Phase 0 validation

Validates that polygram's planned CliProcess driver (0.12) works as designed: claude TUI running with the channels MCP bridge **and** hook ndjson observability injected via `--settings`, simultaneously.

## What it proves

Per [`docs/0.12.0-cli-driver-plan.md`](../../docs/0.12.0-cli-driver-plan.md) Phase 0:

| Step | Validates |
|---|---|
| 0.1 | All six hook events fire alongside `--dangerously-load-development-channels`. Channel notifications still arrive. |
| 0.2 | Hook payloads parse cleanly via `lib/process/hook-event-tail.js` `normalizeHookEvent` — no `unknown` types. `tool_input` populated for MCP tools (`mcp__polygram-bridge__reply`). |
| 0.3 | `SubagentStop` fires for `Agent` tool spawns. **`PreToolUse` fires for tools called INSIDE subagent context** (SEC-05 from review). |
| 0.4 | Hook lag from turn-start to event arrival is comparable to rc.42 (median 14ms / p95 22ms). |
| 0.5 | (research, not code) — see [`../../docs/0.12.0-r2-evidence.md`](../../docs/0.12.0-r2-evidence.md). |

Exit gate: all four steps PASS. If any fail, design loops back to Phase 0.7 (JSONL + hooks dual-stream fallback).

## Layout

```
scripts/cli-driver-spike/
├── README.md                    this file
├── run.mjs                      main spike driver — wraps ChannelsProcess + hook injection
├── validate-payloads.mjs        0.2: parses captured ndjson against normalizeHookEvent
├── validate-subagent.mjs        0.3: triggers Agent tool spawn, validates Pre/Post events
└── measure-lag.mjs              0.4: instruments turn-start → first-event latency
```

## Cost

Per the 0.11 channels spike precedent (~$0.30 headless, ~$0.60 interactive): expect $1–2 in claude credits total across all four runs.

## Running

```bash
# from polygram-0.12.0/ worktree root:
node scripts/cli-driver-spike/run.mjs              # 0.1
node scripts/cli-driver-spike/validate-payloads.mjs # 0.2 (depends on 0.1 output)
node scripts/cli-driver-spike/validate-subagent.mjs # 0.3
node scripts/cli-driver-spike/measure-lag.mjs      # 0.4
```

Each script writes a structured findings JSON next to the spike + a human-readable summary to stdout. After all four PASS, aggregate into [`../../docs/0.12.0-phase0-spike-findings.md`](../../docs/0.12.0-phase0-spike-findings.md) per the plan's exit gate.
