# Inbound rich messages reach the agent as text

## Problem

Bot API 10.1 added `Message.rich_message: RichMessage { blocks: RichBlock[],
is_rtl? }`. A rich message has no `text` and no `caption`; its content lives
only in the block tree. Polygram sends rich messages itself (`richText` is on
for the production bots), and the operator forwards rich messages, from
Polygram bots or any other bot, into Polygram chats.

Polygram's intake reads only `text`, `caption` and native media fields. That
causes two symptoms:

1. **Forwarded rich messages vanish.** `bot.on('message')` records the row
   with `text: ''` (`lib/handlers/record-inbound.js`). `shouldHandle`
   (`lib/handlers/should-handle.js`) sees no text, caption or attachment and
   returns false, so `gateInbound` returns `blocked/shouldHandle`. Nothing is
   dispatched, no reaction is set, and no reply is sent.
2. **Replies to the bot's own rich replies lose their context.** This is
   probably the more frequent case. `resolveReplyTo` takes the Telegram
   payload whenever `from` is set, and `buildReplyToBlock` reads only
   `text || caption`. So the agent gets an empty `<reply_to>`.

Production evidence (shumabit.db, 2026-10-09 → 2026-10-23): 190 of 1,390
inbound rows have empty text. Many of them have no attachment, and several come
in same-second bursts of 4–10 messages, which is what a multi-message forward
looks like. Polygram doesn't store the raw update, so the stored data can't show
which of those rows were rich messages rather than stickers or service
messages.

## Chosen approach

Normalize once, when a message enters the daemon. A new module,
`lib/telegram/rich-inbound.js`, exports:

- `richMessageToText(richMessage) → string`: renders the block tree to
  readable plain text with light markdown structure. It is pure: no time,
  locale or I/O. That matters because the edit path compares stored text with
  a fresh rendering.
- `normalizeRichInbound(msg) → msg`: when `msg.rich_message` is present and
  both `msg.text` and `msg.caption` are empty, set `msg.text` to
  `[rich message]\n` followed by the rendered text. The same applies to
  `msg.reply_to_message`. It mutates in place and returns `msg`.

`polygram.js` calls it in two places:

- `bot.on('message')`: right after the handler-level `if (!chatConfig)
  return;`, before the main `recordInbound`. The `/pair` onboarding branch
  above it handles only plain-text `/pair` claims from unconfigured DMs.
- `bot.on('edited_message')`: right after `if (!knownChat(chatId)) return;`,
  before `recordInbound`. `insertMessage` upserts `text = excluded.text`, so
  an unrendered edit event for a rich row would blank its stored text. That
  happens, for example, when a link preview loads. On this path the
  `reply_to_message` rendering has no effect, because edit redelivery
  rebuilds `<reply_to>` from the old stored text.

Why a single choke point: recording, the gate, the prompt, history preload,
the reply-to DB fallback, edit redelivery and boot replay already read
`msg.text` or the stored row's `text`. Normalizing before `recordInbound`
makes the stored row agree with every later reader, and replay after a crash
rebuilds the same text. Rewriting `msg.text` in place is already done by the
gate (`msg.text = cleanText`).

### The `[rich message]` header

Every rendered text starts with a fixed `[rich message]` line. Every
command-shaped matcher anchors at the start of the text or compares the whole
text:

- the `ABORT_SLASH_RE` pattern and the whole-message and first-sentence abort
  phrases;
- `ADMIN_CMD_RE`, `PAIR_CLAIM_RE`, `/automation` and `REWIND_RE`;
- `handleMessage`'s `text === '/config'`;
- the `startsWith('/…')` checks in `slash-commands.js`.

None of them can match derived content. Without the header, a collapsed
`details` block with an empty summary would put text the forwarder never saw,
such as `/new` or `/compact <hint>`, at position 0. The header also tells the
agent that the text was rendered from blocks.

Trade-off: a rich message that reads only "stop" is delivered as content and
doesn't abort a turn. Users type aborts as plain text, so this is acceptable.

### Bot senders

When `msg.from.is_bot` is set and there is no `sender_chat`, the top-level
message is left unrendered, so it stays dropped as it is today. Bot API 10.0 lets bots see some messages from
other bots in groups. AI bots reply in rich messages, so rendering them could
let two bots in a group answer each other in a loop of paid turns. A user
forwarding a bot's message is the sender, so forwards still render.
Anonymous admins and channel posts arrive from a placeholder bot account with
`sender_chat` set; a person wrote them, so they render. `reply_to_message` is
always rendered.

### Rendering rules

The output is plain text with only the markers an agent needs to see the
structure.

| Block | Output |
|---|---|
| `paragraph`, `footer` | rich text |
| `heading` | `#`×clamp(size,1,6) + space + text |
| `pre` | fenced code with `language` (whitespace and backticks stripped); the fence is longer than any backtick run inside the code |
| `divider` | `---` |
| `mathematical_expression` | `$$expr$$` |
| `anchor` | nothing |
| `list` | one line per item: `label`, a checkbox (`[ ]`/`[x]`) when present, then the item's blocks; nested lines indented two spaces |
| `blockquote`, `expandable_blockquote`, `pullquote` | content prefixed `> `, then `> — credit` |
| `collage`, `slideshow`, `details` | summary if any, inner blocks, caption if any |
| `table` | caption line, then one line per row, cells joined ` \| `; a `colspan` cell is padded so later cells stay under their headers (row spans aren't rebuilt) |
| `map` | `[map: lat,lon]`, then the caption |
| `buttons` | `[button: text]`, plus `(url)` when the button has a URL |
| media (`photo`, `video`, `animation`, `audio`, `document`, `voice_note`) | `[photo — not attached]`, `[document: name — not attached]`, …, then the caption. This differs from Polygram's own attachment summaries, so the agent doesn't think it has the file |
| unknown type with `text` / `blocks` / `items` / `caption` | rendered generically; otherwise `[type]` |

`RichText` is a string, an array (concatenated), or a typed node. A typed node
renders its `text`, with these exceptions:

| Node | Output |
|---|---|
| `custom_emoji` | `alternative_text` |
| `mathematical_expression` | `$expr$` |
| `button` | as in the block table |
| `anchor` | nothing |
| `url` | `[text](url)` when the URL differs from the visible text; the bare URL when the label is empty |

`date_time` renders its `text`, not the timestamp. Captions append
`— credit` when a credit is present. `thinking` blocks are only valid in
`sendRichMessageDraft` and can't arrive in a received message.

`flattenRichText` in `rich.js` is not reused. It keeps only the visible text,
which suits its job (the styling retry), but here link targets,
custom-emoji alt text and math expressions need to survive.

### Bounds

- **Depth.** Telegram allows 16 levels of nesting. The renderer counts a
  level for every block, inline node and wrapping array, so legal input can
  reach about 33 levels. The cap is 64: past it, the tree is malformed and
  nothing more is rendered for that branch.
- **Size.** Quote prefixes and list indents repeat per level, so legal input
  can render many times larger than it is. The output is capped at 32,768
  characters (Telegram's own rich-message budget), followed by a visible
  `[rich message truncated]` line. The cut uses `surrogateSafeCut` from
  `chunk.js`. A lone surrogate would be stored as U+FFFD, the stored text
  would then never match a fresh rendering, and every edit event would look
  like a change.
- **Errors.** If rendering throws anyway, `normalizeRichInbound` catches it,
  logs one line with the message id, and leaves the message untouched. That is
  today's behaviour, not worse.

## Alternatives rejected

1. **A `messageText(msg)` helper at every read site** (about 14
   `text || caption` sites across nine files). Every new reader would have to
   remember the helper, and the stored row, replay and history would each need
   their own call. That is more surface for the same result.
2. **Normalizing in the poll loop** (`lib/handlers/poll.js`, before
   `handleUpdate`). The poll loop is transport code: offsets, batching and the
   journal line. A content transform belongs where the message's domain
   handling starts, next to the gate's own `msg.text` rewrite. The wiring is
   proven by a source-section test, because nothing in the test suite drives
   `polygram.js`'s top-level handlers.
3. **A `_richRendered` flag that makes the gate skip the command stages.** It
   would have to be honoured in the gate, in `handleMessage` and in
   `slash-commands.js`. The header protects every start-anchored matcher
   without touching any of them.
4. **Downloading media embedded in rich blocks as attachments.** This is a
   real gap, but a larger change: download paths, size caps, the attachments
   table. Placeholders say the media exists and is not attached.

## Behaviour notes

- **Prompt path.** Fresh messages and `<reply_to>` go through `xmlEscape` and
  `<untrusted-input>` / `<reply_to>`. History preload escapes and caps its
  rows.
- **Edit paths.** The edit paths (`edit-correction.js:69`,
  `edit-redelivery.js:309`) inject the new text without `xmlEscape` or an
  `<untrusted-input>` wrapper. That already happens for plain-text edits
  today; see the follow-ups below.
- **Mention gate in groups.** A rich message passes `requireMention` on the
  same terms as text: a reply to the bot, `@bot` in the rendered text (which
  now includes link targets and collapsed text), or a paired sender.
- **Secret redaction.** The stored text goes through `durableText` and the
  background sweep, the same as typed text.
- **Unchanged messages.** Messages that already have `text` or `caption` are
  untouched. Rows stored before deploy keep their empty text, because there is
  no raw update to backfill from.
- **Journal.** `poll.js` now logs `(rich message)` instead of `(media)`, so a
  rich update is visible in the journal even when the gate blocks it.
- **Open free-text questions.** If the user who owns an open "Other" question
  sends a rich message, it now becomes the answer with its rendered content.
  Before, the gate skipped `shouldHandle` for that user and consumed an empty
  answer.

## Follow-ups (separate changes)

- `forward_origin` is dropped for every forward, plain or rich, so the agent
  never learns that a message was forwarded.
- `external_reply` (cross-chat replies) and `quote` (partial quotes) are
  ignored for every message.
- Media inside rich blocks isn't downloaded.
- The edit paths inject unescaped text, as described above.
- The admin-command gate stage has no sender check. On a bot with
  `allowConfigCommands`, any member of a configured group can send
  `/model X`, `/new` or `/compact <hint>`.
- `bot.on('message:migrate_to_chat_id')` never runs: `bot.on('message')`
  matches first and doesn't call `next()`.

## Test plan and red→green evidence

All of these are in `tests/rich-inbound.test.js` unless stated otherwise.

1. **Intake.** A forwarded rich-only message is normalized, then put through
   `shouldHandle` and `buildPrompt`. It passes the gate, and
   `<untrusted-input>` holds the heading, the paragraph with its link target,
   the checkbox items and the table row.
   - Red: with a no-op `normalizeRichInbound` (today's intake), it fails with
     "a rich-only forward must not be blocked as an empty message".
2. **Reply to the bot's own rich reply.** `<reply_to>` holds the rendered
   text.
3. **Stored row.** `createRecordInbound` with a real DB fixture stores the
   rendered text. A message rebuilt from that row, the way replay rebuilds it,
   passes `shouldHandle`.
4. **Commands.** A hidden `/new` in a collapsed `details`, plus "stop",
   `/model opus` and `/rewind`, are sent through the real `gateInbound` with
   the real abort and rewind matchers. Each takes the regular dispatch path.
   - Red: without the header, all four fail.
5. **Size and senders.**
   - A 15-deep quote with many newlines stays under the cap and ends with the
     truncation marker.
   - The cut never splits an emoji.
   - An empty-label URL renders once.
   - Another bot's rich message stays unrendered and blocked, but the message
     it replies to still renders.
   - An anonymous admin's message renders.
6. **Groups and questions.**
   - In a `requireMention` group, an unaddressed rich forward is blocked and
     a forward that mentions the bot is dispatched.
   - A rich message answering an open free-text question carries the
     rendered content.
   - An edit event re-renders the same text, so the stored row is unchanged.
7. **Wiring.** In each handler, `normalizeRichInbound` comes after the
   handler-level chat guard and before `recordInbound`.
   - Red: both tests fail against the HEAD (ceccadc) `polygram.js`.
   - In `tests/handlers-poll.test.js`, the `(rich message)` journal line
     fails against the HEAD `poll.js`.
8. **Renderer units.**
   - Every block type and the inline nodes.
   - Nested lists and checkboxes, credits, and multi-paragraph quotes.
   - Fence escaping, language sanitizing, `colspan`, and long button rows.
   - Media placeholders and unknown types.
   - Legal 16-level nesting, depth bombs that don't throw, and a logged
     render failure.
9. **Full suite.** `npm test` passes in full.

## Not proven by this change

- The exact payload a self-hosted `telegram-bot-api` delivers for a
  *forwarded* rich message. The types come from the Bot API reference, not
  from a captured update. After deploy, a forward shows `(rich message)` in
  the journal and should produce a reply.
- Whether each host's `telegram-bot-api` build includes the Bot API 10.3
  types (`buttons`, `expandable_blockquote`, `document`, the inline
  `button`). Where it doesn't, those rules are forward-compatible only.
