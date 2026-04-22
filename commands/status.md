---
description: Show polygram daemon health — running bots, IPC sockets, recent events.
---

You are asked to report the current health of the polygram Telegram daemon.

Do these checks, in order, using the Bash tool, and summarise the results in
a short Markdown table (one row per bot):

1. **Which bots are supervised by launchd.** Run:
   ```
   launchctl list | grep -i polygram || echo "no LaunchAgents loaded"
   ```
   Parse the output. Each line `<PID>\t<exit>\t<label>` is one bot
   (e.g. `com.polygram.my-bot`). The PID column tells you whether it is
   running; `-` means loaded but not currently running.

2. **Is each bot's Unix socket alive?** For every bot you identified, run:
   ```
   node ~/polygram/scripts/ipc-smoke.js <bot-name>
   ```
   Interpret the result:
   - `ping: {"id":null,"ok":true,"pong":true,"bot":"<bot>"}` → socket alive
   - `ERR: connect ECONNREFUSED` → socket stale (polygram not actually
     serving despite plist being loaded)
   - `ERR: ENOENT` → socket missing (polygram never got that far at boot)

3. **Recent events in each bot's DB.** For every bot, run:
   ```
   sqlite3 ~/polygram/<bot>.db "SELECT ts, kind, detail_json FROM events ORDER BY ts DESC LIMIT 5;"
   ```
   Call out anything that looks like an error (`-fail`, `-error`,
   `crashed-mid-send`, `poll-stalled`, `approval-sweep-failed`).

4. **Summarise.** A two-line per-bot summary, plus an overall verdict at
   the bottom (✅ healthy / ⚠️ degraded / ❌ broken).

If the user's polygram install is not at `~/polygram`, they may have set
`POLYGRAM_HOME` or a custom path. Ask them to point you at it rather than
guessing.
