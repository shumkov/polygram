# Buttons owned by external IPC senders (`ext:` callbacks)

## Problem

An IPC sender such as agent-org posts cards through polygram and needs a
button on them whose press it can read later. Today an IPC send cannot keep a
keyboard on a rich card. The send path forwards only the destination and the
blocks, and its HTML fallback sends text alone. The IPC allowlist has no way to
remove a button afterwards. A press on such a button falls through to the tool
approval handler, which ignores data it does not recognize, so the presser's
client shows a spinner and the press is lost.

polygram's side is generic. It carries the keyboard, lets the owner edit it,
and records each press as a fact. It never decides what a press means. The
owner reads the presses and does all the interpretation.

## Sending a keyboard

- `sendMessage` (and every other plain IPC method) already passes `params`
  through to Telegram unchanged, `reply_markup` included. This stays as it is.
- `sendRichMessage` forwards `params.reply_markup` to the rich attempt **and**
  to its HTML fallback. The markup comes from `params`, not from `fallback`,
  so the two transports cannot carry different keyboards. `fallback` keeps its
  closed shape, `{text, parse_mode: "HTML"}`. The Bot API's `sendRichMessage`
  takes `reply_markup` like `sendMessage` does.
- On `sendRichMessage` only, a `reply_markup` that is present but is not a
  plain object is refused before anything is sent. It would otherwise be
  copied onto two transports. Plain methods leave the check to Telegram.

## Editing a keyboard

`editMessageReplyMarkup` joins the IPC allowlist. It is guarded the same way
as `editMessageText`: `chat_id` is required and must be a chat this bot owns,
and `inline_message_id` is refused. The owner uses it to remove the button,
with `reply_markup: {inline_keyboard: []}`, or to replace it.

Telegram's "message is not modified" becomes a synthetic success for this
method, as it already did for `editMessageText`. An owner can then retry a
removal on every pass, for example after a deploy fence refused the first
attempt, without a retry that follows an unseen success failing forever.

## A press

The `callback_query:data` dispatcher moves into `lib/handlers/callback-router.js`
unchanged, so its order can be tested. It still refuses a malformed or
inline-mode query first, with the "Stale or invalid button." toast. The new
`ext:` route comes before every other prefix. The existing prefixes (`cfg:`,
`cxr:`, `q:`, `mbx:`) cannot start with `ext:`, so they behave as before, and
anything else still reaches the tool-approval handler.

The `ext:` handler (`lib/handlers/ext-button.js`):

1. When the message's chat is not one this bot owns (`config.chats`), it toasts
   "Stale or invalid button.", logs `button-press-foreign-chat`, and stores
   nothing.
2. When the data is longer than 64 bytes, Telegram's own limit, it toasts
   "Stale or invalid button.", logs `button-press-oversized` with the byte
   count, and stores nothing. A forged query is not held to Telegram's limit
   by anything else.
3. Otherwise it inserts one row into `button_presses`, with
   `ON CONFLICT(callback_query_id) DO NOTHING`.
4. It answers at once. When the row is stored, or was already stored by an
   earlier delivery of the same update, the toast is `Received`. When the
   insert throws, the toast is `Not recorded, try again`, and it logs
   `button-press-not-recorded` with the error code.

The insert is synchronous (better-sqlite3) and runs before the answer, so the
toast always tells the truth about the row. It is called directly, never
through the best-effort `dbWrite` wrapper, which swallows the very error the
toast reports. Telemetry runs after the answer, and a failing event write
cannot stop or change the toast.

## Table

Migration `031-button-presses.sql`, schema version 31:

```sql
CREATE TABLE button_presses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  msg_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  callback_query_id TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_button_presses_chat_ts ON button_presses(chat_id, ts);
```

- `chat_id`, `thread_id` and `user_id` are decimal strings. A reader compares
  them as strings, and uses `IS` to compare a NULL thread.
- `thread_id` is the message's `message_thread_id`, or NULL.
- `user_id` is `callback_query.from.id`.
- `data` is the full `callback_data`.
- `ts` is the time polygram received the press, in ms since the epoch.
  Telegram gives a callback query no timestamp of its own.

`AUTOINCREMENT` keeps a row id from ever being reused in the live file, even
if rows are deleted later. It cannot help when the database is restored from
a backup, because the counter goes back with it. A reader's once-only claim
should therefore be keyed by `callback_query_id`, which Telegram makes
unique: `press:<callback_query_id>`. The migration only creates new objects,
so it applies cleanly to a live database and never touches existing rows.

Readers open the database read-only and query by `chat_id`, `ts >=` and a
`data` prefix. SQLite's `LIKE` ignores ASCII case and treats `_` and `%` as
wildcards. Filter with `substr(data, 1, length(?)) = ?`, and compare the
whole `data` exactly in code before a press counts.

## Retention

There is no sweep, and none is needed now. Rows come only from human presses
in the bot's own chats, at a few a day, and each row is about 150 bytes.
Deleting a row that a reader still needs, such as a press on a request that is
still open, would silently lose an approval. That is a worse failure than the
slow growth. If a high-volume owner ever appears, a sweep must keep every row
younger than the longest reader window. It can rely on `AUTOINCREMENT` so
that deleted ids are never reissued.

## Trust and logging

- Telegram warns that a client can send callback data that no button on the
  message carries. `data` is therefore untrusted, at most 64 bytes, and stored
  verbatim. `chat_id`, `msg_id`, `thread_id` and `user_id` come from Telegram
  itself. An owner must check the message id and the presser, not just the
  data.
- Any member of a chat the bot owns can add rows with forged queries. Only
  Telegram's rate limits and the 64-byte cap bound them. That is acceptable
  for the bot's own chats, and it is why the owner must check the presser.
- The stored row is the only place the payload lives. Events and console
  lines carry the chat id, message id, user id, an error code, a byte count,
  and the owner tag. The owner tag is the segment between `ext:` and the next
  `:`, logged only when it matches `[a-z0-9_-]{1,16}` and otherwise logged as
  `invalid`. They never carry the payload.

## Failure modes

| Case | Result |
|---|---|
| Insert throws (busy past `busy_timeout`, disk full, I/O error) | `Not recorded, try again`; `button-press-not-recorded` event; nothing stored; the user presses again. A missing table cannot happen at runtime: the statement is prepared at open, after the migrations, so boot fails first |
| The same update is delivered twice (same `callback_query_id`) | No second row; `Received`; the second answer usually fails and is ignored |
| `answerCallbackQuery` fails | The row is stored; the client's spinner times out; a second press is a new row, which the owner's once-only claim absorbs |
| The press is on a chat this bot does not own | "Stale or invalid button."; `button-press-foreign-chat` event; nothing stored |
| Inline-mode or malformed query | The existing refusal, unchanged |
| The button is on a deleted or inaccessible message (`date: 0`) | Stored with `thread_id` NULL. An owner whose topic has a thread id does not count it. In the General topic or a non-forum chat the thread is NULL anyway, so there the message id check does the work |
| A rich send lands but its receipt is lost, and the HTML fallback posts a second card | This is the existing trade-off of the rich send, and the change does not alter it. A press on the first card is stored, but its `msg_id` is not one the owner knows, so it does not count. The owner should hint when an approver's press names an open request from a message that is not one of its cards |
| Data longer than 64 bytes | "Stale or invalid button."; `button-press-oversized` event; nothing stored |
| polygram is down during the press | Telegram holds the update; it is stored on restart, with `ts` set to the receipt time |
| An `ext:` owner that nobody reads | Stored and toasted `Received`. polygram does not know owners; a sender that posts such buttons is expected to read them |
| `editMessageReplyMarkup` with the same markup | A synthetic success, so a retried removal settles |
| `editMessageReplyMarkup` during a deploy drain | Refused by the delivery fence as an IPC error; the owner retries on its next pass |
| A pre-change daemon (rollback) | It leaves the table in place: schema 31 ≥ 30, so it skips migrations. It leaves `ext:` presses unanswered, drops `reply_markup` on rich IPC sends, and refuses `editMessageReplyMarkup`. An owner's table preflight cannot see any of this, so roll the owner back first, or along with it. Deploy polygram before the owner |

## Alternatives rejected

- **Push each press to the owner over IPC.** That needs a subscriber registry,
  delivery retries and an offline queue. agent-org already reads polygram's
  database on a tick, and a durable table gives it the same model it uses for
  `messages`.
- **Record presses in `events`.** The events table is content-free by schema
  (it would drop `data`), has no unique key to absorb redelivery, and has its
  own retention.
- **Record presses as synthetic inbound `messages`.** That would leak button
  presses into transcripts and history preloads.
- **Register owner prefixes in config.** polygram has no use for the owner's
  name beyond a log tag, and the generic `ext:` prefix keeps it unaware of
  owners.

## Verification

Tests are written first and fail before each change:

- An `ext:` press on an owned chat stores one row and toasts `Received`.
- A redelivered press with the same `callback_query_id` stores nothing.
- A press on a foreign chat stores nothing and toasts the stale refusal.
- Data over 64 bytes stores nothing, and a throwing event write still lets
  the toast through.
- A failed insert toasts `Not recorded, try again` and logs the event without
  the payload.
- Non-`ext:` data still reaches its old handler, and inline-mode queries are
  still refused.
- `reply_markup` reaches both the rich send and its HTML fallback.
- `editMessageReplyMarkup` is allowed on an owned chat and refused on a
  foreign one, or with no chat id, and a repeated removal is a success.
- The migration applies on a v30 database that already has rows.

`npm test` covers all of it. A live check after deploy is still needed on the
fleet's Bot API server:
- Telegram accepts `reply_markup` on `sendRichMessage`.
- `editMessageReplyMarkup` can edit a rich message.
- A press on a rich card's button arrives with `message`, not
  `inline_message_id`, and with `message_thread_id` when the card is in a
  topic.

## Review

One independent read-only review covered feasibility against the code,
failure modes, security, scope, and fit with the owner's reader. It found no
must-fixes. These were folded in:
- The claim key is `callback_query_id`, since `AUTOINCREMENT` does not
  survive a backup restore.
- The exact-match guidance for `LIKE`.
- The duplicate-card failure row.
- The not-modified tolerance for markup edits.
- Answering before telemetry, and never through `dbWrite`.
- The 64-byte cap.
- The extra live checks.
- The rollback notes.
