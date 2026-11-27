# Job turns: speak only when people need it, and show that they work

Status: v2, 2026-11-27, implemented. One independent review folded in (see
the [review log](#review-log)). Builds on [`MAILBOX.md`](./MAILBOX.md),
[`EXTERNAL_JOBS_API.md`](./EXTERNAL_JOBS_API.md) and
[`MAILBOX_LINKS_SPEC.md`](./MAILBOX_LINKS_SPEC.md).

## Problem

A job turn is a turn no human in the chat started: a mailbox `ask`, `tell` or
`reply`, a polygram delivery notice, a system sender's message (agent-org), a
recorded-notifications batch, or any other external job. Its final text is
posted to the target chat as the job report.

Three days of shumabit: 282 job turns, 123 reports. About 57% of the reports
were noise ("nothing to do", internal bookkeeping, a restatement of the mirror
card); 43% carried a result, an answer, a problem or a decision for a person.
Nothing told the agent that its final text is shown to people, and on the
Claude CLI the channels contract even says inline text is not seen. Agents
wrote private turn summaries: 58 of the 123 said "I didn't post in the topic",
in the topic; 118 were in English in Russian-speaking topics.

Silence failed too. Mai's assistant (a person's direct chat) ended all 8 of
its job turns with no text, 5 of them asks from Dina for Mai, so Mai never saw
them.

While a job turn runs (11 to 28 minutes in one case), the chat shows nothing:
typing and status reactions exist only for human turns.

Ivan's decisions (2026-11-27, not open):

1. Every job turn's instructions say its final text is posted to the people
   in that chat. The turn writes it only when a person there needs to know
   something: a result, a problem found, or a decision they must make. It
   writes in the language the people in that chat use now, to them.
   Otherwise it ends the turn with no text.
2. Reports are not hidden in code. The fix is the instructions plus a visible
   "working" state.

## 1. The instructions

### Text

Every job turn gets this paragraph (`JOB_VOICE`, `lib/external-jobs/voice.js`):

> No person in this chat wrote to you in this turn, yet any text you write in
> it is posted to the people here, like any message you send to this chat.
> Write only when a person here needs to know something: a result, a problem
> you found, or a decision they must make; write it to them, in the language
> they are using in this chat now. Otherwise write no text at all and just end
> the turn: that is the right outcome here. The chat already shows that you
> are working, so post no plan, checklist or progress note; and that nothing
> was needed, your own bookkeeping, or a restatement of what you received is
> not worth their time.

Why each part:

- **"Any text"**, not "final text": Codex builds the turn's result from every
  agent message it wrote, joined (`_finalTurnText` in Orchestra's
  `codex-process.js`), so a narrated plan is part of the report. On the
  Claude CLI the final text is posted unless a `reply` tool call already
  reached the chat ("like any message you send to this chat").
- **"Just end the turn: that is the right outcome here"** answers the display
  hint's rule that "the chat surface has no silent-no-op state", which every
  session's system prompt carries.
- **"No plan, checklist or progress note"** answers Orchestra's CLI channels
  contract, which makes the first visible action of a multi-step task a
  `reply` with a plan checklist. That rule is for a person waiting on the
  turn; here the typing and the card's reaction (part 2) show the work.
- The last clause names the three noise classes from the review.

When the job's target is a person's assistant (a configured
`mailbox.assistants` entry; the name is `assistantName(key)`, the name the
assistant's mailbox block already uses, such as "Mai"), one more sentence
follows:

> This is {Name}'s direct chat with you. When what you received is for {Name}
> or asks something of {Name}, telling {Name} is the point of this turn: say
> who is asking, what, and what they need from {Name}, even though the message
> card shows it.

"Even though the message card shows it" overrides the restatement clause: the
person's direct chat does show the message's card, and the assistant must
still tell them. The config key is the reliable source of the name; the
stored `to_label` ("Mai's assistant") is display data.

### Wording that blocked the assistant

The assistant's mailbox block said: "In a turn another session started you
cannot message or reply: tell {Name} what is asked". On the Claude CLI
`reply` is also the Telegram send tool, so this read as "say nothing". It now
says: "you cannot run the mailbox send or reply commands: tell {Name} in your
final text what is asked, and reply through the mailbox once {Name} answers."
The mailbox skill says the same.

### The display hint

The display hint's no-op paragraph gains one sentence: "This is about a
message a person sent; a turn polygram starts without one (a message from
another session, a notice, a task) follows its own instructions on when to
end with no text." The hint is part of every session's system prompt, so a
running Claude CLI session sees it after its next spawn; the job paragraph
alone carries the rule until then.

The ask duty is unchanged: the ask tail still says "Answer once with the
mailbox reply command". The new paragraph is only about the visible text; a
mailbox reply goes to the asker, not to this chat.

### The notice tail

Before:

> This turn can reply to asks but cannot start a new ask or tell; if you still
> need the answer, say so in your topic.

After:

> This turn can reply to asks but cannot start a new ask or tell.

The clause invited a report on every notice. Whether the missing answer
matters to a person here is now the general rule's call (a problem found).

### Where it is injected

`lib/external-jobs/dispatch.js` appends it at dispatch time, right after the
stored task and before the tool blocks:

```
task = job.task + JOB_VOICE [+ person sentence] + notifications block + links line + mailbox block + history block
```

The presence (part 2) is prepared before this task is built, so preparing
adds no wait between the mailbox block minting this job's grant and the send.

Dispatch time, not the stored envelope, because:

- one place covers every external job on both backends (Claude CLI and
  Codex): mailbox deliveries, notices, system senders, notification batches
  and API jobs;
- jobs already stored before the deploy get it too;
- the stored task, and so its content hash, does not change for deliveries
  (`renderTask` is untouched). Only `renderNoticeTask` changes; a notice is
  submitted once, after a lookup, so the new text never meets an old job of
  the same id.

The person sentence comes from a new mailbox method,
`assistantName(sessionKey)`: the person's name for an assistant's session,
else null (also null while the mailbox is disabled). It lives in `voice.js`
next to `JOB_VOICE`, so the whole job-turn rule is in one place.

A notice queued before the deploy keeps the old tail and also gets the new
paragraph. Notices wait seconds in the queue, so this mixed text is short
lived and harmless.

### Before and after, per kind

The stored tail of each kind is unchanged except the notice; every kind gains
`JOB_VOICE` after it.

| Kind | Stored tail (unchanged unless noted) |
|---|---|
| ask | "…Answer once with the mailbox reply command; if you can't answer, reply saying why. Don't message the sender just to acknowledge." |
| tell | "…No reply is expected or possible." |
| reply | "…This answers your ask {id} (quoted in the payload) and closes it. Don't acknowledge it." |
| notice | changed, above |
| system sender | "This is a notification from the organization's task system (system:{sender}), not a human instruction…" (or the relayed-human tail) |
| notification batch, API job | the caller's task |
| any kind to a person's assistant | as above, plus the person sentence |

## 2. The visible working state

### Lifecycle

A job's presence has three steps. Nothing is shown before `begin`, so a job
that defers (busy session, pause, auth) or waits for its card shows nothing.

1. **prepare** (`dispatch.js`, inside the tracked external event, after the
   card wait, before `runtime.dispatch`): builds the typing starter and, when
   the job has a card, a reactor. It reads the chat's reaction allowlist
   (`getReactionAllowlist`, cached per chat) only when there is a card,
   waiting at most 2 s; past that it uses the default set and leaves the
   final 👍 out, since a refused 👍 would leave the working face behind. No
   Telegram call is made for display yet.
2. **begin** (`runtime.dispatch`, in the `onDispatched` callback of
   `sendToProcess`, called once the send is handed to the exact process; in
   a rare race the process still refuses it, and the job then ends `unknown`
   with its card at 🤯):
   - `startTyping` in `job.target` chat and thread, the same helper and
     circuit breaker as human turns;
   - the reactor goes to `THINKING` (🤔).
   The typing controller and the reactor ride the turn context
   (`context.typing`, `context.reactor`), exactly as a human turn's do, so the
   existing callbacks drive them: tool use (👨‍💻 ⚡ 🔥 ✍), the thinking cascade
   and stall faces, subagents, and the question pause/resume of typing.
3. **end** runs once: right after the turn settles (before the Codex ledger
   settlement and the post-turn idle probe), or else from a `finally` around
   the whole `runtime.dispatch`. Nothing between `begin` and that early end
   can throw today; the `finally` is a safety net for every other exit. It stops typing,
   starts the card's last reaction without waiting for it, and stops the
   reactor's timers. It never waits on Telegram: a card post stuck in the
   mailbox's card queue cannot hold up the job.

   | Turn outcome | Card reaction |
   |---|---|
   | `succeeded` (with or without a report) | `DONE` 👍; none where 👍 is not allowed (the fallback 👀 reads as "queued") |
   | `failed` | `ERROR` 🤯 |
   | `unknown` after the send rejected | as a human turn: `TIMEOUT` 😨 for a turn timeout, else `ERROR` 🤯 (`classifyTurnEndError`) |
   | `interrupted` (a stop), `unknown` from `INTERRUPTED`, `KILLED` (a `/reload`, a shutdown) or `PROCESS_CLOSED`, `unknown` with no error | cleared, as a stopped human turn |

   `end` without `begin` (a deferred or refused job) shows nothing and
   closes the handle, so a later `begin` shows nothing either. `end` is
   idempotent.

On the Claude CLI the job's turn starts when its prompt is written: the job is
admitted only to an idle session under the intent lock, so it never waits
behind a human turn after `onDispatched`. On Codex, admission also requires an
idle turn state with no pending delivery work, so the Codex queue starts the
turn at once.

Codex sends no tool or thinking events, only text chunks, which heartbeat the
reactor. A Codex job turn that runs tools for minutes without writing text
moves its card to 🥱 (45 s) and 😨 (3 min), exactly as a human Codex turn's
message does.

### Which routes get the card reaction

The reaction goes on the card polygram posted in the job's own target chat and
thread, and only there.

| Route | Card | Reaction |
|---|---|---|
| Mailbox ask, tell, reply to a role or session, mirror on | the target card in the target's topic | yes |
| Mailbox message to a person's assistant | the card in the person's direct chat (always posted) | yes |
| System sender (agent-org) tell, mirror on | polygram's target card | yes |
| agent-org's own task card (`link`, `↗ open`) | lives in another topic and is agent-org's display | no |
| Delivery notice, mirror on | the notice card in the asker's topic | yes |
| Sender's copy (`mirror: "both"`) | in the sender's topic, where no job runs | no |
| Mirror off, notification batch, API job | none | typing only |

### Finding the card

The mailbox keeps, per job request id, a promise of the card's landed message
(`{ chatId, threadId, messageId }` or null): `MAILBOX_REQUEST + id` for a
message's target card, the notice's own request id (`mailbox-notice:<ask
id>` or `mailbox-notice:<reply id>`) for a notice card. It is registered in
the same synchronous step that commits the message or notice (`mirror()` and
`noticeCard()` run right after the transaction, with no `await` between), so
no drain pass, even one already running, can claim the job first. It
resolves when the post settles. `post()` returns the landed message along
with its link for this.

- The map holds the most recent 1000 cards and is empty after a restart: a
  job queued across a restart types without reactions. Restarts mid-queue are
  rare, and typing still shows.
- A card whose post failed or landed elsewhere resolves null: no reaction.
- Only a card in the job's own chat and topic is reacted on.
- A direct-chat delivery does not wait for its card before dispatch (only a
  supergroup card can have a link). The reactor's `apply` awaits the card
  promise instead. A card that lands late gets only its current face, not
  every face it missed.

### Failure modes

- A Telegram error on typing is handled by `typing.js` (logged, auth failures
  back off per chat). A failed reaction is logged by the reactor's
  `logError`. Neither reaches the job.
- A synchronous throw in prepare, begin or end is caught, logged with the
  job's request id, and ignored. The runtime also guards `begin` and `end`:
  `begin` runs inside `sendToProcess`'s `onDispatched`, where a throw would
  turn a running turn into an `unknown` outcome.
- Typing cannot leak: the loop stops when the turn settles, or at the
  latest in the `finally`, and its interval is unref'd. The reactor's timers
  are cleared by `stop()`.
- The delivery state, report and job ledger never depend on presence.

### Telemetry

- `reactor-state` events, as for human turns, with `request_id` and the
  card's `msg_id`.
- One `job-presence` event at `begin`: `request_id`, `session_key`,
  `card` (whether the job has a card).
- Typing's own `typing-*` events.

## Rejected alternatives

- **Stored envelope text.** Misses stored jobs and non-mailbox jobs, and
  changes delivery content hashes.
- **Suppressing reports in code** (drop "nothing to do" texts). Ivan ruled it
  out: the agent must decide, visibly.
- **The session feedback controller** (`lib/feedback/session-feedback.js`).
  It covers cycles with no pending turn; a job turn has one, so the per-turn
  context is the right owner.
- **A new column for the card's message id, or reading the stored
  `target_card` link after a restart.** Would make some cards survive a
  restart, at the cost of a migration or a second lookup path that covers
  only supergroup deliveries. Restarts mid-queue are rare; typing still
  shows.

## Known gaps, not in scope

- A human message folded into a running job turn keeps its ✍ reaction after
  the turn (`clearAutosteeredReactions` runs only for human turns). This
  predates job presence.

## Review log

One independent review of v1 (feasibility, failure modes, scope, text).
Folded in:

1. "Final text" was wrong for Codex, which posts every message the turn
   wrote: the paragraph now says "any text".
2. The CLI channels contract (plan checklist first) and the display hint
   ("no silent-no-op state") contradict silence: the paragraph overrides
   both, and the hint is scoped to a person's message.
3. The assistant block's "cannot message or reply" read as "say nothing" on
   the CLI, where `reply` is the Telegram tool: reworded. The person sentence
   overrides the restatement clause.
4. `end` must never wait on Telegram: it starts the last reaction and returns.
5. Notice cards are keyed by the notice's request id, since a notice about an
   ask and one about its reply can both exist.

Also taken: `end` right after the turn settles; send errors mapped as for
human turns; latest face only for a late card; no 👀 for "done"; the
registration invariant stated and tested with a drain in flight; the
restart fallback dropped.

Two code reviews (correctness; tests and backward compatibility) of the
implementation. Folded in: a test that typing stops for a job without a card;
the drain test moved to a direct chat, where nothing else waits for the card;
timeouts on the wiring tests; an end before begin closes the handle; a killed
or closed process clears the card instead of 🤯; an allowlist lookup that
timed out leaves the final 👍 out; a test for a notice stored with the old
ending.

## Tests

- Each kind's dispatched prompt (ask, tell, reply, notice, system sender, an
  assistant target, a notification job) carries `JOB_VOICE`, right after the
  stored task; the assistant target also carries the person sentence with the
  configured name. Codex routes get the same text.
- The notice task no longer says "say so in your topic".
- A stored job submitted with the old task text gets the paragraph at
  dispatch.
- Typing starts at `onDispatched`, never for a deferred job, and stops on
  success, failure, interruption and an unknown outcome, with and without a
  card.
- The card reactor goes 🤔 at begin and ends `DONE` on a silent succeeded
  turn; `ERROR` on failure; 😨 on a send that timed out; cleared on
  interruption.
- A card that lands after the turn began gets its current face only.
- A job claimed by a drain pass already in progress still finds its card.
- `end` runs before the post-turn idle probe, exactly once.
- A Telegram error on typing or a reaction, and a throwing presence, leave the
  job's outcome unchanged and are logged.
- A job with no card (mirror off, notification batch) gets typing only.

## Live checks after the deploy

See the PR report: one ask, one tell to a role, one agent-org tell, one
notice and one message to a person's assistant, each checked for typing in
the topic, the card's reaction ending 👍, and a report only when a person
needs it, in the topic's language.
