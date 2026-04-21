---
description: Tail the last N lines of a polygram bot's launchd log.
argument-hint: <bot-name> [lines]
---

The user wants to see recent logs from a polygram bot.

Arguments:
- `<bot-name>` — required; the bot whose log to tail (matches `--bot` name,
  same as the launchd plist suffix `com.polygram.<bot-name>`).
- `[lines]` — optional; number of trailing lines (default 100).

Default log path is `~/polygram/logs/<bot-name>.log`. If the user uses a
custom `POLYGRAM_HOME`, ask first.

Steps:

1. Show the last N lines:
   ```
   tail -n {lines:-100} ~/polygram/logs/<bot-name>.log
   ```

2. Scan the output for notable patterns and surface them. Things worth
   flagging:
   - `[fatal]` or `Error:` lines
   - `409, waiting 3s` (Telegram conflict — another grammy instance?)
   - `poll-stalled` — watchdog event
   - `approval-sweep-failed` — sweeper died
   - `telegram-api-error` — delivery failure

3. If the file is empty or missing, check whether the bot is actually
   loaded (`launchctl list | grep com.polygram.<bot-name>`) and report
   that distinction — "bot not loaded" vs "bot running but silent".

Respond with:
- A code fence containing the raw tail (use Markdown triple-backticks)
- A short plain-English summary of anything notable
