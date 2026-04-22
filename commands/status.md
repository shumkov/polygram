---
description: Show polygram daemon health — running bots, IPC sockets, recent events.
---

Report polygram health. Be mechanical: run exactly these commands in
order, parse their output, produce a single Markdown table.

## Commands to run (in this order, Bash tool)

```
# 1. Configured bots
jq -r '.bots | keys[]' ~/polygram/config.json

# 2. launchd supervision (may be empty — that's fine, tmux is also valid)
launchctl list 2>/dev/null | grep com.polygram || true

# 3. tmux supervision (may be empty — that's fine, launchd is also valid)
tmux list-windows -a 2>/dev/null | grep -Ei 'polygram|shumabit|umi-assistant' || true

# 4. Running Node processes (authoritative)
pgrep -fa 'polygram --bot' || true

# 5. IPC socket ping per bot — `polygram-ipc` is a bin installed by the
#    `polygram` npm package (polygram >= 0.3.2). It is NOT the same as
#    ipc-smoke.js. Do NOT look for ipc-smoke.js anywhere; it doesn't
#    exist as a loose file in the install.
polygram-ipc <bot1>
polygram-ipc <bot2>
# (etc, one per bot from step 1)

# 6. Recent events per bot
sqlite3 ~/polygram/<bot>.db "SELECT datetime(ts/1000, 'unixepoch'), kind FROM events ORDER BY ts DESC LIMIT 5"
```

## Interpretation rules

**Supervision is ✅ if ANY of these are true** (NOT all — any one is fine):
- launchd line matched in step 2
- tmux window matched in step 3
- **either counts as "supervised"** — tmux is a first-class supervisor
  for this project

**Supervision is ❌ (foreground) only when BOTH step 2 AND step 3 are empty**, yet step 4 shows the process running.

**Socket is ✅** if step 5 prints `ping: {"id":null,"ok":true,"pong":true,...}`.
**Socket is ❌** on `ECONNREFUSED` or `ENOENT`.

**Events healthy** unless step 6 shows any of:
`*-failed`, `*-error`, `crashed-mid-send`, `poll-stalled`, `approval-sweep-failed`.

## Verdict

- ✅ **healthy** — every bot: supervised (launchd OR tmux) + live socket + no error events
- ⚠️ **degraded** — every bot alive but at least one is true-foreground
  (neither launchd nor tmux), OR stale socket, OR recent error events
- ❌ **broken** — any bot has no live process or its socket is absent

## Output format

```
| Bot | Supervision | Socket | Errors (last 5) |
|-----|-------------|--------|-----------------|
| <bot1> | ✅ tmux | ✅ | clean |
| <bot2> | ✅ launchd | ✅ | clean |

Verdict: ✅ healthy
```

Do NOT speculate about ipc-smoke.js or any path that wasn't listed above.
If a command errors, print its stderr verbatim and move on.

If `~/polygram/config.json` doesn't exist, ask the user for their data
directory path before running anything else.
