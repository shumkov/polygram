---
description: Show polygram daemon health — running bots, IPC sockets, recent events.
---

Report the health of the polygram Telegram daemon.

Do these checks with the Bash tool and summarise per-bot in a short
Markdown table. Cover launchd **and** tmux supervision — users run either.

### 1. Discover configured bots

Read bot names from `~/polygram/config.json` (or `$POLYGRAM_CONFIG`):

```
jq -r '.bots | keys[]' ~/polygram/config.json
```

### 2. Per bot, check supervisor + process

**a) LaunchAgent** — `launchctl list | grep com.polygram.<bot>`. If
present the bot is under launchd. PID `-` means loaded but not running.

**b) tmux** — `tmux list-windows -a 2>/dev/null | grep <bot>`. If
present the bot is running in a tmux pane (most common during testing).

**c) Process** — `pgrep -f "polygram --bot <bot>"`. Confirms the Node
process is actually alive regardless of supervisor.

Label supervision as:
- `launchd` — plist loaded
- `tmux` — window present
- `foreground` — alive but unsupervised (will die on logout/crash)
- `absent` — no process

### 3. IPC socket liveness

```
polygram-ipc <bot-name>
```

That's the `polygram-ipc` bin installed alongside the daemon. Interpret:
- `ping: {"ok":true,...}` — socket alive ✅
- `ERR: ECONNREFUSED` — socket stale (supervisor claims running, isn't serving)
- `ERR: ENOENT` — socket missing
- `command not found: polygram-ipc` — user has polygram < 0.3.2; tell
  them to `npm install -g polygram@latest`

### 4. Recent events

```
sqlite3 ~/polygram/<bot>.db "SELECT ts, kind FROM events ORDER BY ts DESC LIMIT 5;"
```

Flag anything ending in `-failed`, `-error`, `crashed-mid-send`,
`poll-stalled`, `approval-sweep-failed`.

### 5. Summarise

Compact Markdown table + overall verdict:

- ✅ **healthy** — every bot supervised, live socket, no recent errors
- ⚠️ **degraded** — running but not supervised (foreground) OR sweeper
  events present OR stale socket
- ❌ **broken** — any bot has no live process or no live socket

If the install isn't at `~/polygram/`, ask for the data-dir path rather
than guessing.
