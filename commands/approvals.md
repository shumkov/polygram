---
description: List pending and recent approvals from a polygram bot's DB.
argument-hint: [bot-name]
---

Show the operator recent tool-call approvals, gated via the polygram
`PreToolUse` hook.

If no bot name was given, list configured bots from
`~/polygram/config.json` and ask which one.

For the chosen `<bot-name>`:

1. **Pending (awaiting a click):**
   ```
   sqlite3 ~/polygram/<bot-name>.db "SELECT id, requested_ts, tool_name, substr(tool_input_json, 1, 80) AS preview FROM pending_approvals WHERE status = 'pending' ORDER BY requested_ts DESC LIMIT 20;"
   ```

2. **Recent (last 24 h, all statuses):**
   ```
   sqlite3 ~/polygram/<bot-name>.db "SELECT id, status, decided_by_user, tool_name, substr(tool_input_json, 1, 80) AS preview FROM pending_approvals WHERE requested_ts > strftime('%s', 'now', '-1 day') * 1000 ORDER BY requested_ts DESC LIMIT 20;"
   ```

3. **Sweep-failed events in the last 7 days** (the sweeper itself dying
   is an ops alarm):
   ```
   sqlite3 ~/polygram/<bot-name>.db "SELECT ts, detail_json FROM events WHERE kind = 'approval-sweep-failed' AND ts > strftime('%s', 'now', '-7 days') * 1000 ORDER BY ts DESC LIMIT 5;"
   ```

Render two short Markdown tables. For pending rows, note how long they've
been waiting (`requested_ts` vs now). For resolved rows, show who decided
and when. Flag anything where `status = 'timeout'` — those tool calls
were auto-denied because no one acted in time.

If the DB doesn't exist at `~/polygram/<bot-name>.db`, check whether this
is a pre-cutover install still using a shared `bridge.db`; in that case
point the operator at `~/polygram/bridge.db` for the same query.
