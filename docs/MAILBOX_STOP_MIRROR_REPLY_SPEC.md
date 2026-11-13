# Mailbox stop, readable mirror, and linked reply context

## Problem and evidence

An operator stop in a mailbox role topic currently persists the same destination pause as infrastructure automation. This stranded agent-org deliveries to prices after an intended single-turn interruption. Target mirrors expose transport metadata in their header, and reply-to context drops Telegram text_link targets used by human-readable task cards.

Existing seams: mailbox configuration resolves enabled roles through externalJobs.routes and exposes a session-to-role mapping internally; abort pause policy currently lives in polygram.js. The external-job runtime already settles aborted turns as interrupted, proves inactivity, and schedules the next queued job after settlement. Telegram API formatting respects an explicit parse_mode.

## A. Interrupt-only stop in enabled mailbox role sessions

Expose the existing mailbox session lookup as roleForSession(sessionKey), without creating tokens. The abort pause hook skips durable pause when that lookup returns a role; all remaining operator/destination checks and the locked durable pause remain unchanged. Mailbox disabled/absent means existing pause-on-stop behavior. An optional holdAutomationAdmission hook acquires the shared intentLock only for mailbox role sessions, before sampling process state; release it in finally after interruption, cleanup, and acknowledgement. This prevents a naturally settling old turn from admitting a new turn during the stop probes and having that new turn interrupted. Non-mailbox stops do not take this additional lock, because durable pause already acquires it.

Policy is destination-based: if another external-job route aliases a mailbox role session, mailbox interrupt-only semantics win for the whole session. A destination has one shared pause; there is no per-route pause to split. Dedicated infrastructure and recorded-notification sessions keep pause-on-stop. Explicit /automation pause still pauses every route sharing a role session; stop does not clear a pre-existing pause. /automation status continues reading the persisted session pause and actual counts.

Name the behavior interrupt-and-continue: the active job settles interrupted (or retains existing unknown/inactive safeguards when stopping cannot prove completion), is never retried, and any ask notice follows existing behavior. The next queued job becomes eligible after stop releases admission, settlement/report completion, and positive inactivity proof, through the existing scheduler. The operator sees the existing 👍 reaction for active stops; idle stops stay silent. No pause/resume message is added, and normal activity from the next job can begin immediately afterward. /automation status remains enabled unless an explicit pause already existed; enabled is the pause state, not proof of inactivity. If stopping destroys the process and leaves interrupted/inactive=false, the next job remains held until a current recovered process supplies positive idle evidence; the mailbox poller only recovers unknown jobs, so this change adds no automatic recovery for that pre-existing case. No new cooldown, queue withdrawal, automatic resume, or scheduler change.

Map both the legacy aborted flag and the pinned CliProcess result shape metrics.resultSubtype=interrupted to the interrupted external-job outcome. The CLI shape has error=null, so checking aborted alone would incorrectly report a stopped turn as succeeded.

Rejected alternatives: identify mailbox by route-name prefixes or sender identity (neither identifies the destination); exempt every automation destination (breaks infrastructure controls); add per-route pause (unnecessary architecture change).

## B. Human-readable target mirror

Render only the target mirror as explicit HTML. Tell: 📨 <b>agent-org → prices</b>; ask: ❓ <b>cmo asks direct</b>; reply: ↩️ <b>direct answered cmo</b>. Strip only leading role:/system: address prefixes; append · from NAME inside the bold header for stored origin_name. Put the stored already-redacted body in <blockquote expandable>...</blockquote>, escaped literally, preserving technical instructions inside the collapsed body rather than attempting to rewrite them. Agent-org tells remain mirrored, including mirror=both.

Escape all dynamic header/body text with the existing HTML escape helper. Bound decoded header + newline + body to 4096 UTF-16 units, then escape and wrap; HTML markup and entity expansion do not consume Telegram text budget. Reserve ellipsis space when cutting complete code points; never slice escaped HTML or split a surrogate pair. Bound a pathological header to 512 UTF-16 units because role ids have no length limit. Valid entity-heavy 3500-byte bodies remain complete. Retain one send per committed message, best-effort error handling, strictDestination, and sender-side 300-character plain mirror unchanged.

Server evidence: read-only VPS docker inspect reports running umi-telegram-bot-api image aiogram/telegram-bot-api:10.2, with host loopback port 8082; docker exec telegram-bot-api --version confirms Bot API 10.2. Both bots apiRoot in /home/shumabit/polygram/config.json are http://localhost:8082. Expandable support is confirmed, so use it without runtime probes, retries, or a new configuration flag. Suppress link previews to keep the card compact. Telegram HTML syntax and sendMessage limit: https://core.telegram.org/bots/api#html-style and https://core.telegram.org/bots/api#sendmessage.

Rejected alternatives: parse/render the agent prompt as Markdown (changes literal content and permits unwanted formatting); remove CLI instructions (no stable schema and loses what the role received); split cards or retry a mirror after an ambiguous failure (duplicates/noise); change sender mirrors (outside requested target send).

## C. Preserve text_link targets in reply context

For the canonical Telegram payload, extract valid text_link entities from entities for text, or caption_entities for caption. Entity offsets/lengths are UTF-16 units, matching JavaScript slice; validate finite integers, nonnegative ranges, and string URLs. Keep the existing head+tail text truncation for messages without links.

For linked replies append a compact Links section with one line per entity: linked words <URL>. Reserve the 500-UTF-16-unit context budget for complete URL entries before truncating surrounding text. The budget includes Links:, all separators, labels, delimiters, and omission markers. Prioritize fitting complete URLs over labels; bound each label to 64 units from the remaining space, then truncate surrounding text with the remaining budget. Shorten labels and surrounding text by complete code points, never URLs. A zero text budget yields no text; a one-unit budget yields at most an ellipsis. Skip an entry whose complete URL cannot fit, mark omitted content with an ellipsis, and continue trying later smaller entries. HTML/XML escape the final result using the existing boundary. This preserves targets even when their labels are in a discarded middle of the message. Do not add database entity storage or reconstruct targets absent from the fallback DB row.

Reserve omission-marker room while selecting URL entries whenever more candidates remain or one has already been omitted. A near-limit first URL must not evict all targets when a later short URL fits; a lone URL may use the entire budget.

## Failure modes and verification

- Regression named after the prices incident must fail before the fix, then pass; exercise the real abort pause closure against SQLite and mailbox configuration, not a separately reimplemented policy. Keep an infra-admin stop test, disabled mailbox, mixed aliases, explicit pause/status, existing pause, General/no-thread destinations, and idle stop coverage.
- Exercise active/queued mailbox jobs through abort plus external runtime/service: interrupted state, no retry, automatic next-job admission only after positive inactivity; unproven inactivity keeps the queue held.
- Mirror tests cover kind headers, origins, escaping, redaction, UTF-16/escaped size boundaries, one post, strict destination, duplicates, best effort, mirror modes, and unchanged sender posts.
- Linked reply test must fail before fix, then pass; cover emoji/Cyrillic offsets, caption entities, links in truncated middle, long/oversized URLs, multiple links, malformed entities, and XML injection.
- Run focused suites, then npm test. No real provider turn, Telegram send, release, or deployment is authorized by this task. Review spec before code and actual diff after code; review receipts and test counts go in the worker report.

## Independent spec review

Three read-only reviewers examined correctness/failure modes, simplicity/scope, and Telegram formatting. Accepted: hold mailbox admission throughout stop and release on errors; spell out operator reaction and next activity; document the interrupted/no-idle kill-path boundary; budget decoded mirror text rather than serialized HTML; handle reply budgets 0/1, safe Unicode cuts, and prioritize URLs over labels. No findings were declined.
