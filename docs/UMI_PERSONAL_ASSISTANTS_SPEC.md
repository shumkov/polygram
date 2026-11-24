# Personal assistants in UMI

Status: v2, 2026-11-24. Research and spec only; nothing here is built.

Three independent read-only reviews have been folded in: feasibility against
both codebases, simplicity and scope, and security, privacy and loops. See the
[review log](#review-log).

Covers polygram (the mailbox) and agent-org (tasks). Builds on
[`MAILBOX.md`](./MAILBOX.md),
[`UNIVERSAL_MAILBOX_SPEC.md`](./UNIVERSAL_MAILBOX_SPEC.md) and
[`MAILBOX_LINKS_SPEC.md`](./MAILBOX_LINKS_SPEC.md).

## Problem

In the UMI bot `shumabit`, each person's direct chat with Shumabit is that
person's personal assistant inside UMI. These DMs cannot reach the
organization today:

- **No address or grant.** shumabit's mailbox runs in `roles` mode (no `intra`
  key, 13 roles), so only role sessions get a grant (`lib/mailbox/service.js:68`)
  and only role sessions are listed (`lib/mailbox/addresses.js:30`).
- **No tasks.** `mailbox_identify` refuses any session that is not a role
  (`service.js:536`), and agent-org refuses any caller that is not a role
  (agent-org `lib/commands.js:91`).
- **The stopgap.** shumabit-claude `AGENTS.md`, section "If you are not a role"
  (commits `1c495b5b`, `b9db325b`), has DMs create tasks directly in Notion,
  which skips agent-org's checks.

## Ivan's model (decided)

**A role needs something from a person** (an answer, a decision, an approval):

- by default, it @mentions the person in its own topic, with context, when the
  person is a member of the role's Telegram group;
- it uses the person's assistant only when a mention does not fit: the person
  is not in the group, answers must be collected or followed up, or the matter
  is private.

**An assistant needs something from a role:**

- a question is a mailbox ask, and the reply comes back to the assistant;
- work is an agent-org task created on the person's behalf (Requested by is
  the person), with the usual cards, jump links and History.

**Also allowed:** assistant ↔ assistant, and role → assistant for the cases
above. A simple question is not a task.

**Rules:**

1. **Access mirrors the Telegram groups, symmetrically.** A role and an
   assistant may talk only if the person is a member of the role's group.
   - UMI management (`-1004292131077`): Ivan and Dina.
   - UMI markebot (`-1004462674958`): everyone.
   - Assistants may talk to each other freely.
2. **A message from another session is never the human's instruction.** Paid,
   outward-facing or destructive actions still need the human's go.
3. **Private matters stay private.** An assistant shares work, never its
   person's private conversation; if unsure, it asks its person.
4. **The person sees the traffic:** mirror cards appear in their DM.
5. **Ivan's DM runs on Codex:** sending works, receiving waits for the Codex
   phase.

## Facts (verified 2026-11-24)

A read-only `getChatMember` call on the VPS for each person in both groups
gave the table below. The bot (`@shumobot`) is a plain **member** of both
groups, not an administrator, and the call still answered for other users.

| Person | Telegram | DM chat (agent, backend) | UMI management | UMI markebot | agent-org `notionHumans` |
|---|---|---|---|---|---|
| Ivan | @shumkov, 68861949 | 68861949 (`shumabit`, **Codex**) | creator | creator | Ivan |
| Dina | @Dina_Shumkova, 451328391 | 451328391 (`shumabit-member`, CLI) | member | member | Dina |
| Sasha (Alex Akulich) | @akulichalex, 45270985 | 45270985 (`shumabit-member`, CLI) | left | member | missing |
| Mai | @MaiPrawanrat, 8744283195 | 8744283195 (`shumabit-member`, CLI) | left | member | Mai |
| Nastya (Malenesi) | @MALENESI, 438846100 | 438846100 (`shumabit-member`, CLI) | left | member | Nastya |
| Linh | **no username**, 8616081456 | 8616081456 (`shumabit-member`, CLI) | left | member | Linh |

- **Membership** matches rule 1 exactly.
- **A DM's chat id is the person's user id;** only that person and the bot
  write in it.
- **Ivan's DM** has `pm: "codex"` and `codexEnabled: true` in the live config.
  `~/INFRASTRUCTURE.md`, which says it is "back on Claude", is stale.

Code facts this design relies on (polygram 0.50.2; agent-org 0.2.0 at
`5d5940d`, PR #13 for 0.3.0 open):

- **Implicit routes.** A non-role session is delivered on the external-job
  route `session:<sessionKey>`. A DM's key is its positive chat id, which
  `lookupRoute` accepts and rebuilds as a plain chat
  (`lib/external-jobs/runtime.js:12-29`).
- **Grants** are per prompt and in memory. A tainted or replaced grant cannot
  start, and it reports `maxDepth` to `identify` (`service.js:110-129`).
- **Taint.** Nothing calls `taint()` today. The taint clear happens in
  `formatPrompt` (`polygram.js:617`), outside the dispatch lock
  (`polygram.js:2081`).
- **The mailbox transaction is synchronous** (better-sqlite3, `service.js:60`).
  The IPC server awaits handler results (`lib/ipc/server.js:133`).
- **Codex.** Codex prompts pass through `formatPrompt` (`polygram.js:1554`).
  Target resolution and dispatch require the Claude CLI
  (`runtime.js:63`, `:131`), so a job toward Codex is refused at submit and
  rolls back the mailbox row.
- **Outbound links.**
  - The HTML path renders any link target (`lib/telegram/format.js:105-110`),
    including `tg://proxy`, `tg://login` and `tg://resolve`.
  - The rich path keeps only `http(s)` (`lib/telegram/rich.js:246`), so a
    `tg://user?id=` mention is lost in any reply with a list, a table or a
    heading.
  - Job reports go out as plain text (`lib/external-jobs/delivery.js:14-17`).
- **agent-org tasks.** `tasks create` writes Requested by as `role:<name>`.
  - `anchors.created()` posts A1 "➡️ Handed over" in the creator's topic and
    B1 "📌 New task" in the target's.
  - `final()` tells a `role:` creator the result (`lib/tick.js:414-446`).
  - Card facts never render Requested by (`lib/anchors.js:37-49`).

## Design

### 1. Addresses and config

A new optional key `mailbox.assistants` extends a `roles` bot. There is no new
`intra` mode, and roles keep their `allow` rules among themselves.

```json
"assistants": { "ivan": "68861949", "dina": "451328391", "sasha": "45270985",
                "mai": "8744283195", "nastya": "438846100", "linh": "8616081456" }
```

- **Stored address:** `session:<chatId>`, the form phase 1 already uses. Every
  existing helper understands it: `routeOf`, `sessionAt`, `notify`, receipts,
  `displayAddress` and the federation format check.
- **Label:** `<Key>'s assistant` ("Dina's assistant"), stored in `from_label`
  and `to_label`. Headers and cards already show the label for `session:`
  addresses (`envelope.js:15`).
- **What callers type:** the key (`dina`) or `person:<key>`. The latter is an
  input alias only: `resolveAddress` and `mailbox_submit`'s `to` accept it, and
  agent-org stores it as Requested by.
- **Who is listed.** With `rolesOnly`, `listSessions` lists the roles plus the
  assistants. Every other non-role chat (UMI Group topics, Shumabit@UMI, UMI
  Payments) still has no address and no grant.
- **Boot checks** (each failure fails boot):
  - the key matches `^[a-z][a-z0-9_-]*$` and is not a role name;
  - the chat is configured in `config.chats` with a positive id and is not a
    role's session;
  - each chat is listed once.

  The chat is checked against `config.chats` directly, not through
  `resolveTarget`, so Ivan's Codex DM passes.
- **Two definitions change:**
  - `mayStart`: a role, or an assistant on either backend;
  - `receivesMail` is `mayStart && receivable`, so a `/stop` in the Codex DM
    does not take the mailbox intent lock (`polygram.js:4523`).
- **Rollback.** 0.50.x refuses the unknown key (`rules.js:62`). Add the key
  only after 0.51.0 is deployed, and remove it before rolling back.

### 2. Access check: Telegram membership, refreshed in the background

The mailbox keeps a membership table for every pair of assistant and role
group: 6 people × 2 groups, so 12 entries. It refreshes the table with
`getChatMember` at boot and every 5 minutes.

- **Member** means a status of `creator`, `administrator` or `member`, or
  `restricted` with `is_member: true`. `left`, `kicked`, an error or a timeout
  all mean **not a member**.
- **Freshness.** An entry older than 10 minutes (two refreshes) counts as not a
  member. Before the first refresh after boot, nobody is a member.
- **Synchronous reads.** The checks in `send`, `reply`, `directory` and
  `identify` read the table, so they stay inside the synchronous transaction.
  A refusal says the person "cannot reach that role, or access is not confirmed
  yet; try again in a few minutes".
- **Logging.** Failures are logged as `mailbox-membership-unconfirmed`. The
  first refresh logs the table, which replaces a manual check.

Why Telegram and not a config map: a map is simpler, but it drifts the unsafe
way. A member who leaves keeps access until someone edits the config. Telegram
answers here without the bot being an admin. If that stops working, the errors
fail closed, and making the bot an admin fixes it.

### 3. Who may start and who may reply

| From \ To | Role R | Assistant of P | Assistant of Q |
|---|---|---|---|
| **Role S** | `allow` rules (unchanged) | P is a member of S's group | — |
| **Assistant of P** | P is a member of R's group | — | allowed |

**An assistant's mailbox actions need its person's own turn.** Starting an
ask or tell, replying to an ask, and `tasks create` are allowed only with the
assistant's current, untainted grant, which exists only in a turn its person
started (section 4).

- **A turn another session started** (a role's ask, another assistant's ask,
  an agent-org tell, a notice) is tainted. All it can do is talk to its person
  in the DM.
- **Collecting and following up.** A role asks Dina's assistant. The tainted
  turn tells Dina in her DM and ends, and the role gets the usual "No answer;
  it stays open" notice. Dina answers in her own turn, and the assistant
  replies. `open` lists the asks waiting for the caller's reply (`toAnswer`),
  so the ask id survives compaction.
- **Relays are blocked.** Mai's assistant cannot get Dina's assistant to ask
  prices, and a role's text cannot get an assistant to act, reply or create a
  task.
- **Unchanged:**
  - roles start and reply as today (nothing taints them);
  - depth and `perPairPerHour` (10) apply to assistants too;
  - `"*"` in `allow` never reaches an assistant;
  - the receivable check runs before the membership check, so a send to the
    Codex DM refuses without a lookup.

This is stricter than "assistants answer on their own": an assistant never
answers another session without its person. Open question 2 asks Ivan to
confirm it.

### 4. Grants and taint for assistant sessions

These rules make "only in its person's own turn" hold under races, restarts
and background work. They reuse the existing grant and taint code.

1. **Taint on every external-job prompt.** An assistant is tainted when any
   external job's prompt is sent into it, in `noteJobSend`, which already runs
   before the send (`runtime.js:149`) and copies the session's taint into the
   new grant (`service.js:88`).
2. **The person is the operator.** For an assistant session, the operator is
   the DM's person (`msg.from.id` equals the DM chat id, and the sender is not
   a bot), not the bot operator.
3. **Clear taint at dispatch, not at format time.** `formatPrompt` mints the
   human grant as pending. The dispatcher activates it inside the intent-lock
   section (`polygram.js:2081`), once it knows whether the message starts a new
   turn or is autosteered into a running one. Only a new turn clears taint.
   - This closes the race where a delivery's `onSend` has tainted the session,
     but `inFlight` is still false.
   - `UNIVERSAL_MAILBOX_SPEC.md` already planned this move for its cross-zone
     layer, and it is harmless for roles.
4. **Boot taints every assistant.** Taint lives in memory, and a CLI turn can
   survive a daemon restart.
5. **A grant ends with its turn.** When the turn that minted it ends, an
   assistant's grant can no longer start, reply or pass `identify` at depth 0
   (section 3); a folded message extends that turn.
   - Scheduled wakeups and background tasks therefore cannot act in the
     person's name after the turn.
   - A token copied from an idle session's transcript is useless.
   - The cost: a wakeup that should ask a role reminds the person instead, and
     the person says "go".

Consequence: a person whose message is folded into a running tainted turn
must write again after that turn ends. The refusal text tells the assistant to
say so.

### 5. What sessions see

**An assistant's prompt block** (English, like the existing blocks):

- who it is ("Dina's assistant"), and the `send`, `reply`, `directory` and
  `open` commands with this turn's token;
- in a turn Dina started, it may ask a role she can reach (`directory`), ask
  another person's assistant, reply to asks waiting for her (`open`), or create
  a task for a role (the `tasks` skill);
- in a turn another session started, it only tells Dina what is asked and
  waits for her;
- it shares work, never Dina's private conversation, and when unsure it asks
  Dina first.

**A role's prompt block** gains one line, with no list (no lookups on the prompt
path): "You may ask a person's assistant (`directory` lists those you can
reach) when a mention in your topic does not fit."

**The trusted header** is unchanged. The existing authority text already says
the message is not a human instruction or authorization, and the stored label
names "Dina's assistant".

**`directory`:**

- for an assistant: the roles its person can reach, and every other assistant;
- for a role: its allowed roles, plus the assistants of members of its group.

**`open`** adds `toAnswer`: the asks addressed to the caller that have no reply
yet (one new store query).

### 6. Cards and privacy

When an assistant is at either end of a message:

- **The DM card is always full** and is always posted, whatever the mirror mode
  (unless mirror is `false`). This is rule 4 for both the sender's copy and the
  target's copy.
- **A group-topic card is header-only:** for example
  "❓ Question · prices → Dina's assistant", with no body and no sender-chosen
  summary. Its details say "Shown in the person's DM."
- **Assistant ↔ assistant traffic** appears only in the two DMs.
- **Links.** Names in DM cards have no topic link, since a DM has no message
  links. Role names link their topic; the person is a member of that group by
  construction.

The receiving role's own final text still lands in its topic as the job
report, so the organization skill tells roles not to restate private content
there.

### 7. Codex: Ivan's DM

**Send only, in phase 1** (if the spike passes). This is a deliberate exception
to `UNIVERSAL_MAILBOX_SPEC.md` decision 9 ("a Codex session gets no grant"),
for assistants only.

- **Allowed:** `tell` to roles and assistants, and `tasks create`.
- **Refused:**
  - `ask` is refused with `MAILBOX_BACKEND_UNSUPPORTED` before anything is
    stored, because its reply's job would be refused at submit;
  - sends to the Codex DM are refused as today.
- **Why it is safe:** nothing can be delivered into the session (it cannot be
  asked and cannot ask), and notices exist only for asks.
- **Spike first:** from Ivan's Codex DM, both `msg.js` and agent-org's
  `tasks` CLI must work. The latter needs its config and the Notion token. If
  either fails, phase 1 ships without the Codex part, and Ivan's DM keeps no
  grant.
- **Waits for the Codex phase** (`UNIVERSAL_MAILBOX_SPEC.md` phase 4): asks
  from and to Ivan's assistant, replies, and agent-org finals. Until then he
  sees answers and 🏁 cards in the role topics; he is in both groups.

### 8. Mentions

**Mention forms:**

- A person with a username: plain `@username`, which works in any message.
- Linh: `[Linh](tg://user?id=8616081456)`, a `text_mention`.

Roles send mentions through the reply tool, because job reports are plain text
and keep a markdown link literal.

**The identity map** is a "People" table in the organization skill: name,
mention form, groups, and assistant. polygram does not need it.

**polygram fix (PATCH):**

- **Link targets.** Both renderers allow only `http(s)` and
  `tg://user?id=<digits>` link targets. The HTML path loses `tg://proxy`,
  `tg://login`, `tg://resolve` and every other scheme it lets through today.
- **The mention gate.** A reply with a `tg://user?id=<digits>` link and no media
  takes the HTML path (`needsRichRendering` returns false), so the mention
  survives a list. The gate no longer weakens link filtering, because both
  paths filter the same way.
- **Open check.** Whether a rich message turns a plain `@username` into a
  mention is unverified; the live check decides whether the gate covers it.

**Guidance for roles** (organization skill):

- **Mention by default.** Mention a person in your group in your topic: what
  you need, why, by when, and a link.
- **Use the assistant** (`ask person:<key>`) only when answers must be
  collected or followed up, or the matter is private. Do not restate private
  content in your topic.
- **Person not in your group:** neither a mention nor their assistant is
  allowed. Ask a role in a group they are in; management roles ask cmo. Never
  send management-only data there.

## agent-org: tasks from an assistant

**polygram `identify`, for an assistant token**, returns:

```json
{ "assistant": "dina", "chatId": "451328391", "depth": 0, "roles": ["ops", "…"] }
```

- `roles` is the set of roles whose group has the person as a confirmed member.
- `depth` is `maxDepth` for any grant that cannot act (tainted, replaced or
  ended).
- A role token returns `{role, depth}`, byte-identical to today.
- An older agent-org sees `role: undefined` and refuses, so it fails closed.
- agent-org's `lib/polygram-ipc.js` passes the new fields through.

**`tasks create` from an assistant:**

- **Only `--to <role>`.** `--for` gets a one-line refusal. The other write
  commands already refuse a caller without a role (`task.agent !== role`,
  `config.roles.includes(role)`); one test pins that.
- **The person must ask.** Requires `depth === 0`, which for an assistant
  means its person asked in this turn.
- **Reach.** `to` must be in `identify.roles`, which is the person's group
  access. `maxOpenPerRole` applies.
- **Status:** Backlog, or ToDo with `--this-week`, as for a role's task when a
  human asks.
- **Requested by:** `person:<key>`, next to the existing `role:<name>` form.
- **A1 "➡️ Handed over"** goes to the person's DM (`identify.chatId`), through a
  small DM variant of `post`, since `topicOf` knows only role topics. Its
  context is "Dina's assistant → prices". A DM has no message links, so B1
  gets no `↗ from` jump and History gets no ➡️ entry.
- **B1 "📌 New task"** goes to the role's topic with the context
  "prices · from Dina", passed in `created()`. Chat and History (PR #13) work as
  for any task from here on.
- **Reviewer:** unchanged (Reviewers, else Ivan). The assistant passes
  `--reviewer` when its person names one.

**On Done, `final()` tells a `person:<key>` creator** with `mailbox_submit`:
`to: "person:dina"`, `role: <task's role>`, and no origin.

- **polygram refuses the submit** unless the person is a member of that
  role's group. A Requested by forged in Notion can therefore only reach a
  member, who already sees the task's cards in the topic.
- **A refused origin.** `origin` to an assistant is refused
  (`MAILBOX_INVALID_ORIGIN`), so a relayed text never passes for the person.
- **The delivered turn is tainted.** It summarizes the result for the person
  and can do nothing else.
- **New permanent codes** in agent-org: `MAILBOX_UNKNOWN_ADDRESS`,
  `MAILBOX_NOT_ALLOWED` and `MAILBOX_BACKEND_UNSUPPORTED` (Ivan's DM until the
  Codex phase). The task is still marked final, and the refusal is reported.
- **An older polygram** answers `MAILBOX_UNKNOWN_ROLE`, which is already
  permanent.

## Safety: what this guarantees and what it does not

**Enforced by polygram and agent-org (tested):**

- an assistant starts, replies and creates tasks only in its person's own
  turn;
- a role and an assistant reach each other only when the person is a member of
  the role's group;
- no system sender can deliver into an assistant at depth 0;
- the DM sees every message its assistant sends or receives.

**Not enforced by this design.** These are pre-existing gaps that the design
depends on. `MAILBOX.md`'s "Not yet hardened" says to "run the mailbox only
among sessions you already trust with each other's topics":

- **Same OS user.** Every UMI agent runs as `shumabit` and can read the IPC
  secret. Any agent can therefore call `mailbox_submit` as agent-org, use IPC
  `send` into any chat, or copy another session's live token from its
  transcript while its turn runs.
- **The history skill reads every chat.** It scopes reads by cwd
  (`skills/history/scripts/query.js:81-95`), and every shumabit chat shares
  `/home/shumabit/shumabit-claude`. So each DM agent can already read every
  other DM's history today (open question 3).
- **Tools in tainted turns.** A member DM agent runs tools, so text in a tainted
  turn could steer one: Canva AI for Dina, for example. The gift-card flow is
  safe, because it needs a one-time code typed back by the person.
  Script-backed person privileges must check `identify` (phase 1
  precondition). The `UNIVERSAL_MAILBOX_SPEC.md` option C gate for tool calls
  in tainted turns is deferred.
- **Foreign text left in context** after a tainted turn reaches the person's
  next turn: the history preload, and a reply to a card. Mitigation: the
  person's own words are the authority. `AGENTS.md` tells assistants to restate
  the exact action and get the person's yes before any paid or outward-facing
  step.
- **Ivan's Codex DM** is never tainted. Content its own tools read can steer
  a task created in his name, as with the Notion stopgap today.

## Phasing

Each phase ships on its own. Fixes are PATCH, features MINOR.

### Phase 0: mention and link fix (polygram 0.50.3, PATCH)

- **polygram:** the link-target filter on both paths and the mention gate
  (section 8), test first (red, then green).
- **shumabit-claude `skills/organization/SKILL.md`:** the People table and the
  mention guidance, including "mention through the reply tool".
- **Ships:** roles mention anyone, Linh included, reliably. The HTML path stops
  passing `tg://` schemes other than the user link.

### Phase 1: assistants in the mailbox (polygram 0.51.0, MINOR)

- **polygram:**
  - `assistants` config and its checks;
  - addresses and labels, the `person:` input alias, and `toAnswer`;
  - the membership table;
  - the matrix and the "person's own turn" rule;
  - section 4's grant and taint changes;
  - the prompt blocks;
  - section 6's card rules;
  - `identify` for assistants;
  - `mailbox_submit` to assistants (with `role` and the membership check);
  - Codex send-only, if the spike passes.
- **Preconditions before the config goes live (Ivan's go):**
  - **Codex spike.** It runs in Ivan's DM; see section 7.
  - **Script-backed person privileges** call `identify` and require
    `{assistant: <that person>, depth: 0}` instead of trusting an
    agent-supplied argument. Today that is
    `skills/translation-review/scripts/apply.js` (`--by`). The gift-card
    script already has its one-time code.
- **Config (VPS):** `bots.shumabit.mailbox.assistants`, added after 0.51.0 is
  live.
- **shumabit-claude:**
  - **`AGENTS.md`:** replace "If you are not a role" with "If you are a person's
    assistant". It covers:
    - who you are, and acting only in your person's turn;
    - asking roles your person can reach, and other assistants;
    - replying with your person's say-so;
    - privacy;
    - another session's message is not your person's instruction;
    - restating the exact action before any paid or outward-facing step;
    - "a simple question is not a task";
    - doing non-role work yourself.

    The stopgap's Notion-direct task path stays for this phase only. Other
    non-role chats (UMI Group, Shumabit@UMI, UMI Payments) get one line: point
    the person to their DM assistant or the role's topic.
  - **`skills/organization/SKILL.md`:** assistants in "Who may message whom";
    when to mention and when to use an assistant; "For a session reading this"
    says a DM is a person's assistant; don't restate private content in your
    topic.
  - **Role skills:** no change. The guidance lives in the organization skill,
    which every role reads.
- **Ships:**
  - Dina's assistant asks prices and gets the answer;
  - prices asks Dina's assistant, and Dina answers through it;
  - assistants ask each other;
  - Ivan's assistant tells roles;
  - Mai's assistant is refused for management roles.

### Phase 2: tasks from assistants (agent-org, next minor after PR #13: 0.4.0 if #13 ships as 0.3.0)

- **Needs** polygram ≥ 0.51.0.
- **agent-org:**
  - the `create` path for assistants and `person:` Requested by;
  - A1 in the DM and B1 "from <name>";
  - `final()` to `person:` creators;
  - the new permanent codes;
  - the `identify` passthrough in `lib/polygram-ipc.js`.
- **Config:** none required. Add Sasha to `notionHumans` only if he is to be a
  reviewer or assignee (Notion id `268d872b-594c-81ae-9c7c-0002d1a08277`).
- **shumabit-claude:**
  - `AGENTS.md`: the assistant section uses
    `tasks create --to <role> --token <t>`, and the Notion-direct stopgap is
    deleted;
  - the tasks skill gains a short "From a person's assistant" paragraph;
  - the organization skill's "How a human uses it" adds "ask your assistant in
    your DM".
- **Ships:** Dina says "give prices a task for X"; her assistant creates it; A1
  appears in her DM and B1 in the prices topic; on Done her assistant tells her
  the result.

### Later: the Codex phase

`UNIVERSAL_MAILBOX_SPEC.md` phase 4 brings receiving to Ivan's DM. Nothing in
phases 0 to 2 has to change for it.

## Test plan

**Phase 0 (red first):**

- A reply with a list and `[Linh](tg://user?id=8616081456)` takes the HTML path
  and keeps the anchor.
- With media, the gate does not apply.
- `tg://resolve…`, `tg://proxy…` and `javascript:` targets are dropped on both
  paths.
- Each test fails on 0.50.2 and passes with the fix.

**polygram, phase 1:**

- **Config:**
  - each boot check fails boot;
  - the Codex DM passes;
  - in a roles bot with `assistants`, the UMI Group topics, Shumabit@UMI and
    UMI Payments still have no address and get no grant.
- **Matrix** (table-driven, member and not member):
  - every cell of section 3;
  - `"*"` never reaches an assistant;
  - a Codex `ask` is refused, a Codex `tell` is allowed, and a start to Codex
    refuses without a membership lookup.
- **Membership table:**
  - status mapping, including `restricted` with `is_member: false`;
  - an error, a timeout or a stale entry means not a member;
  - nobody is a member before the first refresh.
- **Person's own turn:**
  - a tainted, replaced or ended grant cannot start, reply or pass `identify`
    at depth 0;
  - each taint source taints: a mailbox ask, tell or reply, an agent-org tell,
    a notice;
  - taint survives a folded person message and a message that arrives while a
    delivery's `onSend` has run but `inFlight` is still false;
  - boot taints every assistant;
  - a wakeup after the turn cannot act;
  - roles are never tainted.
- **Delivery to DMs on the implicit route:**
  - an assistant's ask gets its reply in the DM;
  - a "No answer" notice reaches the DM;
  - `toAnswer` lists and drops asks.
- **Cards:**
  - assistant ↔ assistant posts in the two DMs only;
  - an assistant ↔ role message posts a full DM card and a header-only topic
    card;
  - in `mirror: "target"` the DM still gets its card.
- **`identify`:** an assistant gets `roles` from the table; the role response
  is byte-identical; the old agent-org's handling of an assistant token fails
  closed.
- **`mailbox_submit` to an assistant:**
  - accepted with `role` when the person is a member;
  - refused without `role`, for a non-member, with `origin`, or to the Codex
    DM;
  - the delivered turn is tainted.
- **Privileged scripts:** `apply.js` refuses a tainted turn's token and an
  assistant token for another person.

**agent-org, phase 2:**

- `create` from an assistant is refused:
  - at depth ≠ 0;
  - for a role outside `roles`;
  - with `--for`.
- It writes `person:dina`.
- A1 is posted to the DM with "Dina's assistant → prices"; B1 says
  "from Dina"; Chat points at B1; there is no ➡️ History entry.
- `final()` submits to `person:dina` with `role` and no origin.
- The new codes are permanent, and the task is still marked final.
- An assistant token is refused by `submit`, `edit`, `comment` and
  `plan-apply`.
- The existing suite passes unchanged.

**Live checks** (each deploy needs Ivan's go):

1. **Phase 0.** In UMI markebot, a role replies through the reply tool with a
   list and `tg://user?id=68861949`. Ivan is notified, and the outbound row is
   HTML. Check whether a rich message turns plain `@shumkov` into a mention.
2. **Phase 1, Ivan's DM.** Run the spike first. Then:
   - "tell prices: …" from his DM gives a full card in his DM and a header-only
     card in the prices topic;
   - an `ask` returns `MAILBOX_BACKEND_UNSUPPORTED`.
3. **Phase 1, Dina's DM** (with Dina's agreement):
   - Dina's question to prices gets its answer in her DM;
   - prices asks Dina's assistant: Dina is told in her DM, she answers, and
     the reply reaches prices;
   - the boot log's membership table matches the table above.
4. **Phase 2.** Ivan's or Dina's assistant creates a task for prices:
   - Requested by reads `person:…`, A1 is in the DM, and B1 is in the topic;
   - after Done, Dina's assistant gets the final; for Ivan, the refusal is
     logged.

## Alternatives rejected

- **A new `intra` mode.** The presence of `assistants` says the same, and
  `roles` bots without it are unchanged.
- **`person:` as the stored address.** `routeOf`, `sessionAt`, `notify`,
  `displayAddress`, `resolveAddress` and the federation format check all assume
  `role:` or `session:`. An input alias gives the same readability.
- **Each DM as a mailbox role.** agent-org would dispatch tasks to it, and
  allow lists would hard-code membership.
- **A config membership map.** It drifts the unsafe way when someone leaves.
- **A `getChatMember` call per send.** It is asynchronous inside a synchronous
  transaction, and a grant can change during the wait.
- **Telegram `chat_member` updates.** They need the bot to be an admin.
- **Depth only, without taint.** A folded person message resets depth to 0.
- **Taint cleared only once background work settles**
  (`UNIVERSAL_MAILBOX_SPEC.md`). Ending an assistant's grant with its turn is
  simpler and covers wakeups and copied tokens too.

## Open questions

1. **Rule 1 versus "the person is not in the group".** Ivan listed "not in the
   group" as a reason to use the assistant, but rule 1 forbids a role and a
   non-member's assistant from talking. The spec follows rule 1: management
   roles reach Mai, Linh, Nastya or Sasha through cmo. Confirm, or name the
   exception.
2. **Assistants answer only with their person's say-so.** The spec lets an
   assistant reply to a role or another assistant only in a turn its person
   started. This closes injected replies and leaks of management or private
   data through a member's assistant, but an assistant never answers on its
   own. The alternative, autonomous answers about work facts, would rely on
   prompt rules for privacy. Confirm the stricter default.
3. **History is readable across chats today.** This is pre-existing and not
   caused by this design. Every shumabit chat shares one cwd, so the `history`
   skill lets any DM agent read every other DM and every group. Fix it before
   phase 1, as a separate PATCH (scope reads to the caller's own chat, or give
   each DM its own cwd)? Recommended: yes.

## Review log

### Folded in

- **Feasibility:**
  - `person:` is an input alias; the stored address is `session:<chatId>`;
  - membership comes from a background-refreshed table, because the mailbox
    transaction is synchronous;
  - assistant chats are validated against `config.chats`, so the Codex DM
    passes boot;
  - `receivesMail` is `mayStart && receivable`;
  - the rollback note for the unknown key;
  - corrected link-filter claims, no gate when media is present, and "mention
    through the reply tool";
  - the `identify` passthrough in agent-org's IPC client, B1's context passed
    in `created()`, and a DM variant for A1;
  - the autonomous-turn claim is now backed by ending grants with their turn;
  - the header tail is dropped, which also keeps `renderTask` a pure function
    of the stored row;
  - the spike covers the `tasks` CLI;
  - the receivable check runs before membership.
- **Simplicity:**
  - `assistants` maps key to chat id, with the label from the key;
  - `unconfirmed` is cut;
  - no custom header tail;
  - Codex send-only is conditional on the spike and does not block 0.51.0;
  - the Codex open question is cut (rule 5 decides it);
  - the reviewer question is decided as unchanged;
  - no new agent-org refusal code (one test);
  - the agent-org version is stated as "next minor after #13";
  - the test plan is trimmed;
  - tests added for unaddressed non-role chats, DM notices, and the old
    agent-org failing closed;
  - the document is restructured with one copy of each "why".
- **Security:**
  - taint is cleared at dispatch under the intent lock;
  - boot taints every assistant;
  - an assistant's grant ends with its turn;
  - assistants reply only in their person's turn (open question 2);
  - group-topic cards are header-only for assistant traffic;
  - script-backed person privileges check `identify` (phase 1 precondition);
  - `final()` submits carry `role`, and polygram checks the person's membership
    against it;
  - the HTML path filters link targets like the rich path;
  - the "Not enforced" section states the pre-existing gaps, including the
    shared-cwd history read (open question 3);
  - assistants restate the exact action before any paid step.

### Declined, with reasons

- **Defer A1 in the DM** (simplicity). Ivan's model asks for the usual cards on
  a task an assistant creates, and the cost is one small DM variant of `post`
  plus `chatId` in `identify`.
- **Drop the `mirror: "both"` boot check entirely** (simplicity). Replaced, not
  dropped: an assistant's DM card is always posted whatever the mirror mode,
  so rule 4 does not depend on config.
- **An Org-state `by=` marker and `ownsTask` check before a `person:` final**
  (security). The membership check on `role` already limits a forged Requested
  by to people who see the task's cards anyway, and the delivered turn is
  tainted.
- **An idle probe before treating a person's message as a new turn**
  (security). Covered by deciding at dispatch, where the real autosteer
  decision is made, plus boot taint.
- **Inbound caps per assistant, a cap on starts per turn, and a task rate per
  assistant** (security, should-fix). Deferred. Starts and replies happen only
  in the person's own turns, and `maxOpenPerRole` caps tasks.
- **Dropping membership entries on `chat_member` updates** (security,
  should-fix). The bot is not an admin, so it gets no such updates; the
  10-minute window is accepted.
- **Mentions limited to known ids, and a cap on mentions per message**
  (security, should-fix). polygram has no people list. The look-alike risk
  (`[Ivan](tg://user?id=…)` pointing at someone else) is shown on tap, and is
  accepted.
- **A polygram-stamped prefix on DM text from mailbox turns** (security,
  should-fix). Deferred: the DM card for the incoming message is posted just
  before the assistant's text.
- **History-preload tagging and expanded DM card bodies** (security,
  should-fix). Deferred, as in `UNIVERSAL_MAILBOX_SPEC.md` Stage 2. The
  "restate the exact action" rule covers paid steps now.
- **The option C tool gate for tainted assistant turns** (security, residual).
  Deferred as non-architectural hardening (Ivan: don't over-engineer); listed
  under "Not enforced".
- **Shortening the live checks further** (simplicity). The fold check was
  dropped, but the Dina round trip stays: it is the only end-to-end proof of
  the collect flow.
