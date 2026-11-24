# Jump links on communication cards

Status: v2.1, 2026-11-24. Phase P1 (polygram 0.50.0) is implemented with this
spec; phase A2 (agent-org) is not. It covers
polygram's mailbox mirror cards and agent-org's task cards. Three independent
reviews have been folded in (feasibility, simplicity and scope, failure modes
and privacy); see the [review log](#review-log).

Builds on [`MAILBOX.md`](./MAILBOX.md),
[`RICH_MAILBOX_CARDS_SPEC.md`](./RICH_MAILBOX_CARDS_SPEC.md) and
[`UNIVERSAL_MAILBOX_SPEC.md`](./UNIVERSAL_MAILBOX_SPEC.md).

## Problem

A card in one topic says that something happened in another topic, for
example "❓ Question · general → music". The reader cannot get there from the
card: they have to find the other topic by hand and scroll to the matching
card. Ivan approved these links:

1. **Names.** Each session name in a polygram mirror card's header links to
   its Telegram topic.
2. **Twin cards.** A sender card links to the card in the target's topic. An
   answer card links to the question card, where the target's work continues
   below it.
3. **Notion.** An agent-org task message links to the task in Notion.
4. **Notices.** A delivery notice links to the original question card.
5. **agent-org situations.** In agent-org's events, the reader can jump to the
   specific message on the other side, not only to its topic.

Cross-bot links (the personal assistant ↔ UMI topics) are designed here but
not built. Orca sessions show a name without a link.

**Rule throughout:** a link that cannot be proven to point to the right place
is left out.

## What exists today

### polygram 0.49.1

- **No card ids are kept.** In `lib/mailbox/service.js`, `mirror()` starts the
  target post and the sender post at the same time. `post()` discards the
  `sendRichCard` result.
- **Card shape.** `renderRichMirror` returns one blockquote with two children:
  - a header paragraph: an icon, a bold event word, then
    ` · from → to · from <origin>`;
  - a closed `details`.

  `renderMirror` is the HTML fallback: a bold header line and an expandable
  blockquote. Both are pure functions of the stored row.
- **Sending.** `sendRichCard` sends with `strictDestination`. When a topic has
  vanished, the send throws rather than falling back to General
  (`lib/telegram/api.js:402`). The send returns a `Message`. The rich sender
  only *logs* `rich-send-thread-mismatch` when the echoed `message_thread_id`
  differs from the requested one (`lib/telegram/rich-send.js:200`).
- **Every outbound card is recorded in `messages`** with its `source`: rich
  sends through `insertSentRow`, HTML sends through
  `insertOutboundPending` + `markOutboundSent`. The row stores the
  *requested* thread.
- **Notices have no card.** `notify()` submits an external job to the asker.
  The only Telegram trace is the asker's own report text.
- **`ref`.** `mailbox_submit` stores an opaque `ref` and shows it only in the
  untrusted payload. agent-org passes the Notion task id there.
- **Link previews.** Rich bubbles ignore `linkPreview: false`, because
  `sendRichMessage` is outside the method list at `lib/telegram/api.js:242`.
  The HTML fallback does disable previews.
- **Reply context.** When a person replies to a rich card, its URL nodes stay
  in the reply context, within a 500 UTF-16-unit link budget. agent-org relies
  on the Notion URL surviving there.

### agent-org (deployed build afe18c4, verified on the VPS by file hashes)

- **Task anchors** (`lib/anchors.js`) are agent-org's own cards, posted
  through polygram's IPC `send` with `source: "agent-org"`.
  - `post()` returns `chatLink(topic, message_id)`, which is built from
    config without checking where the card landed.
  - `created()` posts the creator's card first and the target's second. It
    then writes the last successful one to Chat, so if the target's post
    fails, Chat gets the creator's card.
- **The Notion Tasks "Chat" property** holds the latest anchor's link.
  agent-org writes it and never reads it back.
- **The Org state marker holds no anchor ids**; its fields are
  `c, s, k, at, run, via, own, cm`.
- **`ref` is `task.id`** (a dashed Notion UUID) on the dispatch, nudge, final
  and comment-relay submits.
- **One tick** runs schedule, promote, dispatch, review, final, stall,
  comments, then calendar, in that order (`lib/tick.js:516`).
- **UMI's config.**
  - Two roles (production, cmo) live in a forum's General topic; the other
    eleven have threads.
  - `reviewNotify` is unset.
  - polygram mirrors with `"both"`.

## Telegram link formats

These are taken from <https://core.telegram.org/api/links> ("Message links"
and "Forum topics"):

| Target | Link |
|---|---|
| Message in a private supergroup (General, or a plain supergroup) | `https://t.me/c/<channel>/<msg>` |
| Message in a forum topic | `https://t.me/c/<channel>/<thread>/<msg>` |
| Forum topic | `https://t.me/c/<channel>/<thread>`. The topic's id is the id of its creation message, and clients open the topic. |
| General topic | `https://t.me/c/<channel>/1`. Only in a forum: in a plain supergroup this opens message 1. |
| Plain supergroup as a chat | No documented link, so none is built. |
| Basic group (id not `-100…`), or a DM (positive id) | No message links exist, so none is built. |

- `<channel>` is the Bot API chat id without its `-100` prefix.
- Message ids are never reused within a supergroup.
- agent-org's General anchors have used `t.me/c/<chat>/<msg>` live since
  2026-11-14. The [live check](#test-plan) confirms the other forms.

## Decisions

### 1. Link builder

polygram gets `lib/telegram/links.js`, with two pure functions:

```js
topicLink({ chatId, threadId, forum })          // → string | null
messageLink({ chatId, threadId, messageId })    // → string | null
```

**Inputs.**

- `chatId` must match `^-100\d+$`. Anything else (a basic group, a DM, a
  malformed id) returns null.
- `threadId` is null or matches `^[1-9]\d*$`.
- `messageId` is a positive safe integer.
- Ids are compared and printed as strings, so a numeric echo matches a string
  config value.

**Topic links.**

- With a thread: `t.me/c/<ch>/<thread>`.
- Without a thread: `t.me/c/<ch>/1`, but only when `forum === true`.
  Otherwise null.

**Message links.**

- With a thread: `t.me/c/<ch>/<thread>/<msg>`.
- Otherwise: `t.me/c/<ch>/<msg>`.

**Forum status** for a General link comes from Telegram, not from the config
heuristic `isForumChat`. polygram calls `bot.api.getChat` only when a card
would name a General session, once per chat, and caches the answer for the
life of the process, as the reaction allowlist already does. It does not go
through `tg()`, which would record an outbound row. A card waits at most 3
seconds for the answer. A failure or a timeout means "not known to be a
forum", so the General name renders as plain text; it is remembered for 5
minutes, so the cards after it do not wait again.

Every link is `https://` and is built from digits alone. The inputs describe a
destination, not a bot, so a peer's card can use the same builder later.
agent-org needs only its existing `chatLink`, plus the landed-location check
described in [agent-org changes](#agent-org-changes-a2).

### 2. Record where the target card landed

Migration `029` (`SCHEMA_VERSION` 29):

```sql
-- The message link of the mirror card posted in the target's topic, so later
-- cards (the sender's, the answer's, a notice) can link to it.
ALTER TABLE mailbox_messages ADD COLUMN target_card TEXT;
-- A system sender's jump link, kept only once proven (decision 6).
ALTER TABLE mailbox_messages ADD COLUMN link TEXT;
```

**Only the target side is stored.** Every later link points at a target card:

- the sender card's `↗ open` points at the target card posted moments before
  it, in the same chain;
- `↗ question` points at the ask's target card;
- the cross-bot phase reads the target card too.

Nothing links to a sender card or a notice card.

`UNIVERSAL_MAILBOX_SPEC.md` planned `029` for its cross-zone layer. Migrations
are numbered in the order they ship, so that layer takes the next number.

**A card's location is "verified"** when all of these hold:

- the result has a positive safe-integer `message_id`;
- `String(result.chat?.id)` equals the requested chat;
- `String(result.message_thread_id ?? '')` equals `String(threadId ?? '')`.

This is the same receipt proof `lib/telegram/api.js` already applies to
recorded deliveries (`requireRecording`). A card is never a reply, so an echoed
thread can only be the topic.

Only a verified card gets a link, built from the result. Anything else is
logged and links nowhere. Because the link records where the card actually
landed, a later config change never moves it.

### 3. Mirror order: target card first, then sender card

Every card (target, sender copy, notice) goes through one in-order queue,
started after commit, so `send`, `reply` and `submit` return at once and each
topic reads in commit order, as it did when posts were issued in call order.

1. Post the target card. If its location is verified, write `target_card`.
2. In `"both"` mode, post the sender card. If step 1 verified a location, the
   sender card carries `↗ open` to it. This holds even if writing
   `target_card` failed.

A failed target post is logged as it is today, and the sender card is still
posted, without the twin link. A step that fails for any reason is logged by
its code and the queue moves on. The sender card waits one Telegram round
trip; that delay is the price of its link. Cards are never edited.

### 4. Links on each card

| Message | Card and topic | Names | Extra links |
|---|---|---|---|
| ask / tell A → B | target, in B | A and B link to their topics | none: the sender card does not exist yet |
| ask / tell A → B | sender, in A (`"both"`) | same | `↗ open` → the target card in B |
| reply B → A | target, in A | B and A | `↗ question` → the ask's `target_card` in B |
| reply B → A | sender, in B (`"both"`) | same | `↗ open` → the reply's target card in A |
| system tell → B | target, in B | the system name stays plain; B links | `↗ Notion` (decision 5), `↗ open` (decision 6) |
| notice about ask A → B | notice, in A (decision 7) | A and B | `↗ question` → the ask's `target_card` in B |

**Name links.**

- They follow the message's canonical address in the live config:
  `sessionAt(address)` gives the session's `{chatId, threadId}`.
- The visible text is the label stored with the message, so the name is the
  one the session had when the message was sent. The link still opens the
  session the message actually went to.
- A session that is no longer configured, a system sender and an Orca
  address all render as plain text.

**Cross-chat links.**

- In a **roles** bot, any link may point into another chat of the same bot.
  The operator chose each role's chat.
- In an **open** bot, every Telegram link on a card (names, twin, question)
  is kept only when it points into the card's own chat. An open bot may span
  unrelated chats, such as partner groups, so their ids must not appear in
  each other's cards.

**Errors** while computing any link (a missing chat entry, a failed
`getChat`, a database read) render the card without that link, and never
block it.

### 5. Notion link from `ref`, opt-in per system sender

A new key, `mailbox.notionRefs`, lists the system senders whose `ref` is a
Notion page id. Default: none. Each entry must also be in `systemSenders`.
UMI's config sets `["agent-org"]`.

For a message from such a sender, a `ref` that is a dashed UUID, or 32 hex
digits, renders `↗ Notion` → `https://www.notion.so/<32 lowercase hex>`. That
is exactly the URL agent-org's own cards already use. Any other `ref` renders
nothing, and agent-org needs no change for this link.

### 6. Optional `link` on `mailbox_submit`, kept only when proven

`link` is a string. After the key lookup, for a new message only, polygram
keeps it only when it names a message this bot sent for that sender:

- it parses as one of the two `messageLink` shapes;
- its chat and thread are a configured role's topic, so a link can never
  point into a chat no role lives in;
- a `messages` row exists with this `bot_name`, `direction = 'out'` and
  `status = 'sent'`, the same `chat_id`, `thread_id` and `msg_id`, and
  `source` equal to the system sender's name.

A database error during the check drops the link the same way.

A link that fails the check is logged (`mailbox-link-dropped`), and the message
is accepted without it, because `link` is display data.

- **No new error code.**
- **Not part of the idempotency hash.** A retry with a different `link`
  returns the original receipt, and the stored `link` stands.
- **Never sent to the receiving role**, in either the task or the payload.
- **Rendered** as `↗ open`.

A forged or mistaken submit therefore cannot put an outside URL, another
bot's chat, or a message the sender never posted into a card.

**Where a message landed.** A strict rich send (every card) now records the
thread Telegram echoed back, not the one requested, so a card a server
dropped into General can never prove a topic link.

**Residual risk.** A send that is not strict, such as an IPC `sendMessage`,
may retry into General when its topic is gone, and its row keeps the deleted
topic. A link to it opens the right message id in a topic that no longer
exists, never a different message. agent-org links only its rich cards, which
are strict.

**Who can mint a provable link.** Any process holding the IPC secret can send
through IPC with any `source` and then submit as that sender. That gains
nothing new: such a caller can already post into the bot's chats and submit
as the sender. The role-topic rule keeps the link inside a role's topic.

### 7. Notice card (new)

Notices have no Telegram card today, so item 4 needs one.

- **When it is posted.** `notify()` returns whether it created the notice job.
  If it did and `mirror` is not `false`, polygram posts one card in the
  asker's topic after commit. `"target"` mode posts it too, because the asker
  is that notice's target.
- **What it shows.** It uses the uniform shape, rendered by a new
  `renderNoticeCard` and `renderNoticeCardHtml`:

  ```
  ⚠️ No answer · general → music · ↗ question
  ▸ <the ask's summary>          (details: polygram's fixed reason sentence)
  ```

- **The event word** depends on the reason:

  | Event word | Reason |
  |---|---|
  | `No answer` | the turn ended without a reply |
  | `Undelivered` | the delivery failed or was interrupted |
  | `Uncertain` | the delivery outcome is unknown |
  | `Answer undelivered` | `reply-undelivered` or `reply-uncertain` |

- **Details.** They never contain an agent's text.
- **Failure.** The card is best effort: a failed post is logged, and the notice
  job is unaffected.

## Rendering

The links are added inside the header paragraph. Each card is still **one
blockquote with exactly two children: the header paragraph, then the closed
details.**

**Rich** (`renderRichMirror(row, links)`):

```
[ '❓ ', {bold:'Question'}, ' · ', {url:'general', …}, ' → ', {url:'music', …},
  ' · from Ivan', ' · ', {url:'↗ question', …} ]
```

**HTML fallback** (`renderMirror(row, links)`):

```html
❓ <b><a href="…">general</a> asks <a href="…">music</a> · from Ivan</b> · <a href="…">↗ question</a>
<blockquote expandable>…</blockquote>
```

- **`links`** is `{from, to, extra: [{label, url}]}`. The service computes it,
  so the envelope stays a pure function of its inputs. `extra` always has the
  same order: `↗ Notion`, then `↗ open` or `↗ question`.
- **Rich and HTML in step.** Both link the same names and carry the same
  `extra` links in the same order. A test extracts the URLs from both formats
  and compares them. The fallback keeps its older wording ("asks",
  "answered").
- **Budget.** The visible header (names, origin and link labels) keeps the
  512 UTF-16-unit cap. A header that would exceed it renders as it does today,
  with no links, so a label is never cut. URLs are entity data and do not
  count toward Telegram's 4096-unit text limit.
- **Escaping.** `href` values are digits and fixed hosts. They still go
  through `escapeHtml`.
- **Reply context.** A card has at most four links (about 250 UTF-16 units),
  so a person's reply keeps every URL within the 500-unit budget.
- **Link previews.** The live check confirms that a `t.me/c` URL node in a
  rich card adds no preview. agent-org's rich cards with Notion links have run
  without complaint since 2026-11-14. If a preview does appear, drop the
  `extra` links from rich cards; that does not block the name links.
- **Older messages.** A message stored before this release has no
  `target_card` and no `link`. A card that refers to it, such as an answer or a
  notice, gets name links but no `↗ question`. Cards already posted are never
  touched.

## Per-situation table

Phase P1 is polygram 0.50.0; phase A2 is agent-org 0.2.0. "Notion" marks a
link that already exists.

| # | Situation (agent-org code) | Card, where it is posted | Links → targets | Data source | Phase |
|---|---|---|---|---|---|
| 1 | Role A creates a task for role B (`tasks create --to`, `anchors.created`) | A1 `➡️ Handed over · A → B`, in A's topic, posted first | Notion; **B's name** → B's topic. B1 does not exist yet, and A gets B's exact card at #9. | `topics[B]`; a General B also needs its forum status proven | A2 |
| 2 | same | B1 `📌 New task · B`, in B's topic; Chat := B1 | Notion; **`↗ from A`** → A1. B's name is the card's own topic, so it stays plain. | A1's verified link, from `post()` in the same call | A2 |
| 3 | Task for a person (`--for`), or for oneself | one `📌 New task` card, in A's topic | Notion only: there is no other side | none | none |
| 4 | Dispatched, first round or rework (`tick` dispatch → submit) | polygram mirror `📨 Message · agent-org → B`, in B's topic | **B's name** → its topic; **`↗ Notion`** | live config; `ref` = task id + `notionRefs` | P1 |
| 5 | Nudge (`stall`) | polygram mirror, in B's topic | **name**; **`↗ Notion`** | as #4 | P1 |
| 6 | Comment relayed from Notion (human origin) | polygram mirror `… · from Ivan`, in B's topic | **name**; **`↗ Notion`** | as #4 | P1 |
| 7 | Submitted for review (`tasks submit`) | `👀 Ready for review · B`, in B's topic; Chat := it | Notion only. B's name is the card's own topic, so it stays plain. | none | none |
| 8 | Review ping (`reviewPing`) | Notion comment; a `reviewNotify` card only if configured (unset in UMI) | Notion only; see [deferred](#deferred) | none | none |
| 9 | Done / final: the creator role is told (`final` → submit) | polygram mirror `📨 Message · agent-org → A`, in A's topic | **name**; **`↗ Notion`**; **`↗ open`** → B's latest card, normally Ready for review with B's result above it | `ref`; `link` = Chat, sent only if it lies in B's configured topic and proven by polygram (decision 6) | P1 renders, A2 sends |
| 10 | Done anchor (`announce(done)`) | `🏁 Done · B`, in B's topic; Chat := it | Notion only. B's name is the card's own topic, so it stays plain. A person task's Done card sits in the creator's topic and names people, who have no topic. | none | none |
| 11 | Blocked follow-up promoted (`promote`) | `📌 New task`, in B's topic | Notion only; see [deferred](#deferred) | none | none |
| 12 | Created while blocked (backlog) | as #1–#2 | as #1–#2 | as #1–#2 | A2 |
| 13 | Planning (`plan-apply`; run tasks enter ToDo) | `📌 New task`, in each step's role topic | Notion only; see [deferred](#deferred) | none | none |
| 14 | A scheduled run's first steps (`schedule`) | `📌 New task` | Notion only: there is no other side | none | none |
| 15 | Calendar Missed (`calendarTick`) | `⚠️ Missed`, in the event role's topic (or ops) | Notion event only: there is no Telegram other side | none | none |
| 16 | Process updated, needs attention, or save incomplete (`say`) | notice card | Notion process only | none | none |
| 17 | Refused, or stalled | Notion comments only, no card | none | none | none |
| 18 | Role ask, tell or reply (polygram) | see [decision 4](#4-links-on-each-card) | names, `↗ open`, `↗ question` | `target_card` | P1 |
| 19 | No-answer, undelivered or uncertain notice (polygram) | new notice card, in the asker's topic | names; `↗ question` | the ask's `target_card` | P1 |

**Why #1–#2 link from B to A, not the other way.** This differs from the
mailbox rule (target first, sender card links to the twin) for three reasons:

- agent-org already posts A1 first, and cards are never edited.
- The reader who needs the exact message is in B, looking for the point where
  A created the task. That point sinks quickly in A's topic, while B's topic
  is where the latest work is.
- A message link works for General roles too. A topic link to a General
  role needs its forum status proven first, so a creator such as cmo could get
  no link at all.

A's reader gets B's exact card at #9.

### Deferred

These are considered and left out of A2:

- **#8, review ping.** The link would sit only on the `reviewNotify` card,
  which UMI does not configure, so it would be dead code. If `reviewNotify` is
  turned on, add `↗ <role>` → B's Ready-for-review card.
- **#11, blocker link.**
  - Each tick promotes before it finalizes. A promoted follow-up therefore
    usually sees the blocker's Chat on its Ready-for-review card, not its Done
    card.
  - agent-org cannot prove a Chat value without polygram.
  - The Notion link already shows "Blocked by".
- **#13, plan link.** The planning task's Chat cannot be proven either, and
  the plan itself is written in the planning task, which the Notion link
  reaches.

## agent-org changes (A2)

- **Landed-location check.** `post()` returns a link only when the sent
  message's `chat.id` and `message_thread_id` match the topic. For General,
  both must be absent; ids are compared as strings. This is the same check as
  polygram's decision 2. Anything else returns null.
- **Clickable role names.** A role name in a card's context links to that
  role's topic, as on polygram's mirror cards. Today that is B in A1's
  `A → B`.
  - A role whose topic has a `threadId` links to `t.me/c/<ch>/<thread>`.
  - A role in a General topic (no `threadId`) links to `t.me/c/<ch>/1` only
    when the chat is proven to be a forum. agent-org learns that from
    `result.chat.is_forum` on the replies to its own sends into that chat, and
    keeps it in memory. Until then, and for any chat it cannot prove, the name
    stays plain.
  - A role with no configured topic, or a name that is the card's own topic,
    stays plain.
  - `card()` accepts `context` as a string or as parts, where a part is a
    string or `{text, url}`. The rich text and the HTML fallback link the same
    parts.
- **`card()`** gains an optional `jump: {text, url}`.
  - It renders in the existing link line, after the Notion link
    (`<title> · ↗ from ops`), with the same `<a>` in the HTML fallback.
  - The Notion URL stays the first URL, so a person's reply still carries the
    task identity.
  - The jump label's length counts toward `used`, so the body still fits.
- **`anchors.created`** passes A1's link to B1 as `↗ from <creator>`. Chat is
  set to B1 only. If B1 failed, Chat is left as it was, so it never holds the
  creator's card.
- **`final`** reads `task.chat`. It passes the link only when the link parses
  as a `chatLink` of `topics[task.agent]`, with ids compared as strings, which
  keeps a reassigned task's stale Chat out. Polygram proves the rest.
- **`polygram-ipc.js`.** The unknown-field fallback learns `link`. An older
  polygram then takes the message without it, and the outcome says
  `linkDropped`.
- `package.json` goes 0.1.0 → 0.2.0. The README's anchors section lists the
  new links.

agent-org stores nothing new and needs no IPC to read polygram's card ids.

## Failure modes

| Situation | Behaviour |
|---|---|
| The target post failed, or its location was not verified | The sender card has no `↗ open`; later replies and notices have no `↗ question`. |
| A reply is mirrored before the ask's card post has settled (rare: the target must finish a whole turn first) | No `↗ question`. |
| A restart between commit and post | No card and no `target_card`, as today. |
| The `target_card` write fails | Logged. The sender card still links; later cards do not. |
| A rich send returns no message id, and the HTML fallback posts a second card | This already exists. The recorded link is the HTML card, which is in the right place. |
| A card or topic deleted later | The link opens the chat, and Telegram reports the message or topic as missing. Ids are never reused, so it never opens another message. |
| A role moved to another topic | Name links follow the live config to the role's current home. Recorded card links stay where those cards are. |
| A role renamed or removed; a session unconfigured | Old addresses no longer resolve, so those names render as plain text. Card links still work. |
| A chat migrated (new `-100` id) | Old links keep the old id and stop opening. New cards use the new id. |
| A General chat whose forum status is not confirmed | No General topic link. Message links still work. |
| Notion Chat edited by a person, or stale after a reassignment | The `topics[task.agent]` check, then polygram's `messages` proof. Either failure omits the link. |
| A forged `mailbox_submit` | Its `link` is dropped unless it names a message the sender really sent. `↗ Notion` comes only from senders in `notionRefs`. |
| An older polygram under a newer agent-org | `link` is dropped through the unknown-field fallback. |

## Privacy

- **Who can open a link.** Only members of the linked chat. Anyone else sees
  the label, which the card already shows, plus numeric ids that grant
  nothing.
- **P1 never links across bots.**
  - Names come from the bot's own config.
  - `target_card` comes from the bot's own sends.
  - `link` must name the bot's own message.

  A UMI card can never point into shumorobot, and the reverse cannot happen
  either.
- **Cross-chat links inside one bot** appear only in a roles bot, where the
  operator placed each role. An open bot links only within the card's own
  chat (decision 4). DMs can never be linked.
- **agent-org** links only to its own verified cards in its configured topics,
  and to Notion.

## Later phases (design only)

**Cross-bot cards** (UNIVERSAL_MAILBOX_SPEC phase 2):

- The UMI daemon includes its own stored `target_card` in the peer reply to a
  personal ask. The link comes from the stored row, never from the agent's
  reply text.
- The Mac re-parses that link with the same grammar. It renders the link on
  the personal side (General) only when its chat is one of the chats the
  `peers` config names for UMI.
- The Mac never sends its own chat, topic or message ids to the VPS. UMI cards
  name the personal assistant in plain text.
- Personal may see UMI, and Ivan is a member of both.

**Expired asks.** When ask expiry lands, the notice card gains the event word
`Expired`.

**Orca.** Name only; Orca sessions have no Telegram link.

## Phasing and versions

| Phase | Ships | Version | Depends on |
|---|---|---|---|
| P1 | polygram: `links.js`; migration 029; ordered mirror with `target_card`; name links; `↗ open` / `↗ question`; `notionRefs` and `↗ Notion`; proven `mailbox_submit.link`; the notice card; MAILBOX.md | polygram **0.50.0** (a feature, so MINOR) | none. UMI's config adds `notionRefs` at deploy. |
| A2 | agent-org: the landed-location check, `↗ from A` on B1, Chat only from B1, `link` on `final` | agent-org **0.2.0** (a feature, so MINOR) | Deploys on its own. Against polygram < 0.50.0, the final's `↗ open` is dropped. |
| later | cross-bot links; deferred #8, #11, #13 | with universal mailbox phase 2, or on demand | |

Each phase deploys on its own, and a production deploy needs Ivan's go. A
later fix in either phase is a PATCH.

## Alternatives rejected

- **Editing the target card to add the twin link.** Ivan does not want edits,
  and the rich edit path is another place for things to fail.
- **Posting the mailbox sender card first.** The target card would wait on the
  sender post, and the target's topic is where the work happens.
- **A `mailbox_cards` table recording both sides.** Nothing reads a sender
  card's location, so one column holds everything that is read.
- **Storing card ids rather than the link.** A stored link is what every
  consumer reads, and the builder's forms are fixed by Telegram.
- **A URL template for `ref`.** There is one sender, it uses Notion, and a
  dashed UUID needs a second placeholder.
- **Refusing a bad `link` with a new error code.** That costs a public code
  and a retry path in agent-org for display data. Dropping the link is safe
  under the rule.
- **Free-form `link` URLs.** That would put arbitrary hosts into
  staff-visible cards.
- **Treating `isForumChat` as proof of a forum** for the General link `/1`.
  It is a config heuristic. `getChat` is the source of truth.
- **Storing the creator's card (A1) in the Org state marker**, so dispatches
  and Done cards could link back to A. A dispatch usually follows B1, which
  already links to A1. This would add a marker field and a Notion write.
- **An IPC op that returns polygram's card ids to agent-org.**
  - agent-org links only to its own cards and to Notion.
  - The mirror is posted asynchronously after commit, so a receipt could
    carry the card id only by waiting.
  - If a need appears, a read-only lookup op is the extension point.
- **Rendering a name as plain text when its stored label differs from the
  live one.** The link follows the canonical address to the session the
  message actually involved, so it is right even when the label is old.
- **A timeout on the sender card's wait.** Telegram's own retry caps already
  bound it, and a late sender card harms nothing.

## Test plan

Write each behaviour test-first: red, then green.

### polygram unit tests

**`links.js`**

- Topic links: a topic; General with `forum: true`; General with
  `forum: false` or unknown, which gives null.
- Message links with and without a thread.
- Null for: a basic group, a DM, a malformed id, thread `0` or text, and an
  unsafe message id.
- A string thread matches a numeric echo.

**Verified location**

- The chat or thread echo differs: nothing is recorded.
- `chat` or `message_id` is missing: nothing is recorded.

**Envelope**

- Rich and HTML carry the same URLs in the same order (extracted from both).
- The two-children shape is unchanged.
- A header over the cap renders without links.
- Escaping is unchanged.
- `↗ Notion` appears only for a sender in `notionRefs` whose `ref` is a Notion
  id.
- The notice card renders for every reason.

**Service**

- The target card is posted before the sender card, and the sender card links
  to the verified target.
- A failed target post still posts the sender card, without the twin link.
- A failed `target_card` write still gives the sender card its link.
- A reply card links to the ask's `target_card`, and has no link without one.
- An open bot does not link a session in another chat; a roles bot does.
- A link error renders the card without that link.
- `getChat` failure or `is_forum: false` gives no General link.
- Notice cards: one per created notice job, none when `mirror: false`, and
  they are posted in `"target"` mode too.
- Duplicates and refusals post nothing.

**`mailbox_submit.link`**

- Kept when a matching `messages` row exists from that source.
- Dropped and logged for:
  - a wrong source;
  - a wrong thread;
  - an outside host;
  - another chat;
  - a topic-shaped link with no matching row;
  - junk.

  The message is accepted in every case.
- A retry with a different link returns the original receipt, and the stored
  link is unchanged.
- The link never reaches the task or the payload.

**Config**

- `notionRefs` must be a subset of `systemSenders`; otherwise boot fails.

**Migration**

- A v28 database upgrades to v29 with both columns, and existing rows are
  untouched.
- A fresh database gets both columns.

**Existing tests that change on purpose**

- `tests/mailbox-mirror.test.js` pins exact card output at lines 54, 69, 88,
  102, 167, 186 and 209. Its fixture uses chat `-1001` with threads 11 and 12,
  so name links appear in those cards.
- The fixture's `tg` stub must also return `chat` and `message_thread_id`.
- `tests/mailbox-store.test.js:40` lists the columns after `slice(16)`.
- `user_version === 28` is pinned in `tests/db.test.js:44` and
  `tests/mailbox-store.test.js:38,54,80`.

### agent-org unit tests

- `post()` returns null when the echo does not match the topic, including
  General.
- `card()` with `jump` in both formats: the Notion URL comes first, and the
  budget still holds.
- `created` gives B1 A1's link. When B1 fails, Chat is not written.
- `final` passes `link` only for a Chat in `topics[task.agent]`, with string
  and number ids both handled.
- The unknown-field fallback drops `link`.
- Role names in a card's context link to threaded topics; a General role links
  only after a send into that chat returned `chat.is_forum: true`; an unknown
  topic or the card's own topic stays plain; rich and HTML link the same
  parts.

### Gates

Run `npm test` in both repos. The real-Claude spike gates are not affected;
report them as skipped.

### Live check

Run after deploy, on one home topic pair: shumorobot General ↔ Music.

1. General asks Music. The Music card's names open General and Music, which
   checks the General `/1` link.
2. Music answers. The General answer card's `↗ question` opens the Music
   question card, which checks the `/<thread>/<msg>` form.
3. Force a no-answer notice. Its `↗ question` opens the same card.
4. Check on desktop and on iOS, and note any link preview.
5. If shumorobot's bot API server cannot send rich messages, the same steps
   cover the HTML fallback.

Then watch one UMI pair in `"both"` mode, without driving it:

- the ask sender card's `↗ open` opens the target card in the other forum;
- an agent-org dispatch card's `↗ Notion` opens the task.

After A2, watch:

- one `tasks create --to` pair, for B1's `↗ from A`;
- one final, for `↗ open` to B's card.

**Proof of persistence:** read `target_card` and `link` back from the database
and compare them with the real message ids.

## Review log

Three read-only reviewers reviewed v1 independently, each through one lens.

### Folded in

**Feasibility**

- A two-part link is also a valid General message link, so it cannot be
  refused as a "topic link". The `messages` proof covers it instead.
- agent-org must check where a card landed before it builds a link.
- The blocker's Chat usually is not its Done card, because each tick promotes
  before it finalizes. #11 is now deferred.
- The test plan names the existing tests that change on purpose, and the stub
  fields they need.
- `isForumChat` throws on a missing chat. Link errors never block a card.
- Check `result.chat.id` and a safe-integer `message_id`.
- Link the sender card from the verified location, not from the stored row.
- `notify()` returns whether it created the job. The notice renderer is named,
  and so is its posting in `"target"` mode.
- Validate `link` after the key lookup.
- Drop #8, which is dead in UMI.
- Compare ids as strings in agent-org.
- Count the jump label toward the `card()` budget.

**Simplicity and scope**

- One `target_card` column replaces the `mailbox_cards` table with sides.
- No `MAILBOX_INVALID_LINK`: a bad link is dropped and logged.
- #8 dropped; #11 and #13 deferred, with reasons.
- agent-org topic links and `topicLink` removed from v2. The coordinator
  later restored clickable role names in agent-org cards, under the same
  proof rules as polygram's names.
- The ordering choice at #1–#2 is stated explicitly.
- The notice card is named as an addition, and `Expired` moved to later
  phases.
- Decision 8 folded into the rejected alternatives.
- Dev-time narration removed.

**Failure modes and privacy**

- Chat is checked against the assignee's own topic, and `created()` no longer
  falls back to the creator's card.
- The agent-org echo check.
- `link` must name a real message the sender sent (`messages` row).
- The General link needs `getChat` `is_forum`, not the config heuristic.
- Ids are normalized to strings for the echo.
- Link errors never block a card.
- Cross-chat links only in roles bots.
- `notionRefs` opt-in.
- The duplicate HTML card is documented.
- The cross-bot link comes from the stored row, never from the agent's text.

### Declined, with reasons

- **Require `is_topic_message === true` on the receipt** (failure modes).
  Nothing in the codebase reads that field, and `api.js` already proves a
  destination by the message id, chat and thread echo alone. A card is never
  a reply, so an echoed thread can only be its topic. Requiring a field the
  rich server might omit would quietly disable every link.
- **Merge the no-change rows of the table** (simplicity). The brief asks for
  every situation to be listed. The rows are kept and kept short.
- **Plain-text names when the stored and live labels differ** (failure
  modes). The link follows the canonical address, so it opens the session the
  message involved. Hiding it would remove a correct link.
- **A 10-second timeout on the sender card** (failure modes). Telegram's retry
  caps already bound the wait, and a late display card is harmless.
- **Flip agent-org's creation order** so that A1 links to B1 (simplicity, one
  of two options it offered). The other option was taken instead: keep the
  order and state why. B's reader needs the exact message, and a message link
  works for General roles such as cmo, which creates many tasks.
- **Read the blocker from `runsDone` rather than `getTask`** (feasibility).
  This is moot while #11 is deferred.

### Code review of P1 (polygram 0.50.0)

Three read-only reviewers checked the P1 diff: correctness, failure modes and
wrong-link risk, and tests. None found a wrong link in the main paths.

**Folded in:**

- **Cards in commit order.** Every card goes through one in-order queue.
  Per-message chains had let an answer reach the asker's topic before the
  asker's copies of earlier messages. A failed step is logged by its code,
  and the queue moves on.
- **The chain never rejects.** The destination is resolved inside the post's
  `try`.
- **`getChat` is bounded.** It waits at most 3 seconds, and a failure or
  timeout is remembered for 5 minutes. A slow Bot API could otherwise hold
  cards for up to three minutes.
- **Strict rich sends record the landed thread** in the outbound history, so
  `sentBy` can no longer prove a topic link to a card that landed in General.
- **A DM or basic-group card no longer logs "landed outside".** `landedAt` is
  a separate check from building the link.
- **`proveLink` is tightened.**
  - A link must point into a role's topic.
  - A database error drops the link instead of refusing the submit.
  - The log line names `mailbox-link-dropped`.
- The HTML notice card shows the ask's summary.
- A detached comment in `rules.js` was moved back to its function.
- **Tests:**
  - `getChat` failure and timeout, with card counts;
  - the live `bot.api.getChat` default, called as a method;
  - a notice card for an undelivered answer;
  - the posted-once guard;
  - a failed question lookup costing only that link;
  - the header-cap boundary at 512 and 513;
  - a DM card with no link and no warning;
  - the mirror stub now echoes `chat` and the thread, so twin and question
    links are pinned;
  - the reply-order test asserts one global commit order again.

**Declined:**

- **Expiring the cached forum answer after an hour.** If a forum turns its
  topics off, polygram's topic sessions break anyway, and a restart probes
  again. The reaction allowlist caches the same way.
- **Clearing the thread on the non-strict thread fallback in `api.js`.** That
  is the general send path, outside this feature. The residual risk above is
  a deleted topic, never a different message.
- **A test that injects a database error into `sentBy`.** The guard is a
  plain `try`, and a test would need a database proxy for one line.
