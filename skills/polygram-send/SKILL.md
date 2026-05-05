---
name: polygram-send
description: Send messages, photos, documents, or stickers from a script (or from agent Bash) into the same Telegram chat the bot is in. Use when an agent or cron job needs to post a file, photo, or out-of-band text to a polygram chat — typically Xero invoices (PDF/.docx), generated reports, screenshots, or status pings tied to long-running work. Do NOT use for normal turn replies (those go through the agent's text reply, polygram delivers automatically). Do NOT use Telegram MCP — polygram-send is the supported path.
---

# polygram-send

Polygram exposes a per-bot Unix socket at `/tmp/polygram-<bot>.sock`. Authorized callers (same UID, with the per-bot secret) can send Telegram API methods through it. Polygram routes them to the live bot connection, logs them in the `messages` table, and applies markdown / chunking / dedup.

This is the **supported path** for any agent or script that needs to deliver a file or out-of-band message into a polygram-managed chat. Telegram MCP is **not** wired up; agents that try to call Telegram directly will hit auth or routing issues.

## When to use

- Agent generated a file (PDF, .docx, image, etc.) and the user asked for it in chat
- Cron job needs to post a status update to the relevant chat
- Long-running work needs an out-of-turn nudge (e.g. "build finished, here's the artifact")

## When NOT to use

- Your normal text reply to the user — return text from the turn, polygram delivers it through the streamed reply path. Don't double-send.
- Anything that needs the message attributed to "user" — IPC always sends as the bot.
- The Telegram MCP — explicitly NOT supported. Polygram blocks outbound message routing through anything other than its own bridge.

## Allowed methods

Polygram's IPC accepts (and only these):

```
sendMessage
sendPhoto
sendDocument
sendSticker
sendChatAction
editMessageText
setMessageReaction
```

Anything else → `method not allowed` rejection.

## Usage from Bash (one-liner pattern)

The lightest path is a `node -e` invocation that requires `polygram/lib/ipc-client`:

```bash
node -e '
const { tell } = require("/Users/shumabit/.npm-global/lib/node_modules/polygram/lib/ipc-client");
(async () => {
  const r = await tell("shumabit", "sendDocument", {
    chat_id: "-1003369922517",
    message_thread_id: 24,
    document: { source: "/absolute/path/to/invoice.docx" },
    caption: "Artisan April invoice — ฿3,562.00",
  }, { source: "agent:xero-invoice" });
  console.log(JSON.stringify(r));
})().catch(e => { console.error(e.message); process.exit(1); });
'
```

Replace `shumabit` with `umi-assistant` or `shumorobot` for the other daemons. The `polygram` package path is wherever it was installed globally (run `npm root -g` to confirm).

## Critical: how to pass `document` (and `photo`)

For **sendDocument** and **sendPhoto**, the `document` (or `photo`) field has THREE valid forms. Pass the wrong one and Telegram rejects.

### ✅ Local file path via `{ source: "/abs/path" }` — preferred

```js
document: { source: "/Users/shumabit/work/invoice.docx" }
```

This uses grammy's `InputFile` envelope. Polygram → grammy → multipart upload → Telegram. Works for any local file ≤50 MB. **Use this for any file you just generated.**

### ✅ Public HTTPS URL — for files already hosted publicly

```js
document: "https://cdn.example.com/invoice.pdf"
```

Telegram fetches the URL directly. Must be **publicly reachable from Telegram's servers** (i.e. a public CDN, S3 bucket, or hosted endpoint). NOT localhost. NOT IP addresses Telegram can't reach. NOT HTTP — must be HTTPS.

### ✅ Telegram `file_id` — for files Telegram has already seen

```js
document: "BAADAQADwAADBREAAVoQOnEZmRRJpmcE"
```

Re-use a file that polygram (or any bot) previously uploaded. Cheapest by far — no upload cost.

### ❌ Common failures

```js
// WRONG: localhost URL — Telegram can't reach your Mac
document: "http://localhost:8080/file.pdf"

// WRONG: HTTP (not HTTPS) URL — Telegram requires HTTPS for URL form
document: "http://cdn.example.com/file.pdf"

// WRONG: malformed port (double colon, alpha chars)
document: "http://host::8080/file.pdf"

// WRONG: bare path string (Telegram will treat as a URL and reject)
document: "/Users/shumabit/work/invoice.docx"
```

If you generated a file locally, ALWAYS use the `{ source: "/abs/path" }` form — never wrap it in a URL.

## Picking the right `chat_id` and `message_thread_id`

The chat the bot lives in is in `~/polygram/config.json` (shumabit-side) or `~/.polygram/config.json` (ivanshumkov-side). Each chat has:

- `chat_id` — the Telegram numeric ID (negative for groups, positive for DMs)
- `topics` — optional dict of `thread_id` → `{ name, ... }` (rc.48 form)

For threaded chats (where `chatConfig.isolateTopics === true` or topics are listed), pass `message_thread_id: <number>` to land in the right topic. Without it, the message goes to the chat's General topic.

**Don't hardcode thread IDs.** Read the current conversation's threadId from your invocation context, OR query the most recent inbound message in the relevant topic before sending. Hardcoding leaks state across deploys (the agent's view of "what topic we're in" can stale-bind to an old thread).

## Source label

Polygram tags every IPC send with a `source` string for forensics. Default is `cron:<scriptname>` if you don't pass one. **Always pass an explicit `source` from agent Bash** so it's visible in `messages.source` and forensic queries can attribute reliably:

```js
{ source: "agent:xero-invoice" }              // Xero workflow
{ source: "agent:rekordbox-import-summary" }  // music-curation outputs
{ source: "agent:status-ping" }               // generic out-of-turn update
```

Without an explicit source, the call shows up as `cron:unknown` and forensics can't tell whether it was a real cron job or an agent — which led to actual misdiagnosis on 2026-05-05 (rc.58 incident).

## Captions

`caption` accepts up to 1024 chars (vs 4096 for `sendMessage`). Polygram's lib/telegram-format.js handles markdown escape; agents passing markdown captions don't need to pre-escape.

For long descriptions, send the file with a short caption + follow up with a separate `sendMessage` for the full text. Don't try to cram a long description into the caption.

## Auth

The IPC socket validates a per-bot secret (`/tmp/polygram-<bot>.secret`, mode 0600, same UID readable). `tell()` reads it automatically. Cross-user / cross-UID calls fail at socket-permission level. Cross-bot calls fail at chat ownership check (`chat_id must belong to this bot`).

## Don't

- Don't call this for normal text replies. Just emit text from the turn — polygram delivers it.
- Don't use Telegram MCP.
- Don't pass localhost URLs to `document`/`photo`.
- Don't hardcode `message_thread_id` from previous sessions.
- Don't omit `source` from agent-triggered sends.
- Don't dedupe yourself — polygram's outbound dedupe + retry is already wired.

## Related

- IPC server: `lib/ipc-server.js` — handler registration, secret validation
- IPC client: `lib/ipc-client.js` — `tell()`, `call()`
- IPC method allowlist: `polygram.js` `IPC_SEND_ALLOWED_METHODS`
- Smoke test: `scripts/ipc-smoke.js`
