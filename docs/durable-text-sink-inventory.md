# Durable text-sink inventory and the pre-write secret boundary

Scope: every durable text sink in polygram that is reachable from inbound
Telegram content or provider (Claude/Codex) output, and what the pre-write
boundary does — or deliberately does not do — about each one.

**Status.** Every Polygram-owned durable sink inventoried here is covered,
including the state of an *open* interactive question — see the last section
for how, and for the limits that remain: the provider's own session storage is
outside this boundary, detection is deterministic shape matching only, and one
orphaned-row bug (DQ3) is deliberately left for its own fix.

The boundary itself is three pure functions in `lib/secret-detect.js` —
`sanitizeForDurableWrite` (text), `sanitizeDurableStructured` (values, before
serialization) and `sanitizeDurableJsonText` (a serialized document, parsed
back first) — plus the typed telemetry schema in
`lib/db/event-detail-schema.js`, applied inside `lib/db.js` and the two stores
at the moment of the write. Callers keep their own value, so the live provider
turn always receives the original text; only the stored copy is masked.

## Detection policy

| Tier | Rules | After-the-fact cleanup (`redactText`) | Pre-write boundary |
| --- | --- | --- | --- |
| high | provider key shapes, private key blocks, `Bearer <token>` | redact | mask |
| medium | JWT | redact | mask |
| low | `kv-secret` (`password: …`, `--token …`), `prose-secret` (`my password is …`) | flag only | mask unless the value is allowlisted |

A declared value is captured in whichever of its three shapes it appears:
double-quoted, single-quoted, or unquoted up to a safe delimiter (`,`, `;`,
closing bracket, end of line). An unquoted multi-word value is ambiguous —
"password: correct horse battery" could be a passphrase or a word followed by
prose — and is read as the passphrase, because over-masking a stored copy is
recoverable and under-masking a credential is not. There is no minimum length:
`password=abc` is a credential too. What keeps ordinary vocabulary readable is
`DURABLE_VALUE_ALLOWLIST`, matched against the first word of the value
("password: required for the staging box" survives whole). `correct` is
deliberately not on that list.

Detection is deterministic shape and keyword matching. Prose that never names
a credential — "the thing I told you about yesterday still opens the box" — is
not detectable here and is not claimed to be. The background sweep
(`lib/db/secret-sweep.js`) and the agent-reported `redact_secret` path remain
behind this boundary as defense-in-depth, and any consumer that publishes
these rows onward must re-check rather than trust them.

**Structured values are sanitized before serialization, never after.**
`JSON.stringify` escapes the quotes around a declared value, and the escaped
form no longer looks like a quoted value to the detector; masking a serialized
document can also splice across its delimiters. Every JSON-valued column
therefore goes through `sanitizeDurableStructured` (or is parsed back into one
by `sanitizeDurableJsonText`), which walks plain objects and arrays, returns a
new value, and DROPS anything that is neither a primitive nor a plain
container — a Date, a Map, a class instance, a function, or a BigInt, which
has no JSON form and would otherwise make the whole document throw at
serialization and lose the write silently.

### Key-aware masking: scope and direction

A structured payload usually declares the credential in the KEY, where the
value carries no `password:` prefix for the text rules to find:
`{"password":"hunter2"}` is as much a declaration as `password: hunter2`.
`isCredentialKey` matches a key by suffix after case and separators are
removed and one trailing plural is folded, against a fixed list of credential
nouns — so `DB_PASSWORD`, `apiKey`, `x-api-key`, `client_secret` and
`passphrase` count, while `cache_key`, `sort_key` and `keyboard` do not: `key`
alone is not a credential noun.

The scope is deliberately narrow and worth stating plainly:

- **Strings only.** A credential-named field holding a number (`{"pin":1234}`)
  is not masked; masking it would change the JSON type, and this boundary does
  not rewrite types.
- **Context is inherited.** `{"password":{"value":"…"}}` and
  `{"credentials":[…]}` wrap the same claim, so every string leaf below a
  credential key is masked. That over-masks a benign sibling under such a key
  — a deliberate direction, because the stored copy is recoverable from the
  live turn while an unmasked credential is not. A pagination cursor named
  `next_token` is masked for the same reason.
- **Allowlisted markers survive** the inherited context, so
  `{"password":{"value":"required"}}` and an already-masked placeholder stay
  readable.
- **Keys are only rewritten when they themselves carry a detectable signal**
  (a payload keyed by a token, an assignment used as a field name). Ordinary
  keys are left exactly as written so shapes stay recognizable.

None of this is recognition of arbitrary secrets. It recognizes declared
shapes — a credential noun in a key, or a declaration in text — and nothing
else.

## Covered sinks

| Sink | Column / target | Reached from | Notes |
| --- | --- | --- | --- |
| `insertMessage` | `messages.text`, `messages.error` | `record-inbound.js` (`msg.text`/`msg.caption`), rich-send's own sent row | Also the edit upsert path |
| `insertOutboundPending` | `messages.text` | `lib/telegram/api.js` — every tracked bot reply | |
| `updateOutboundText` | `messages.text` | streamed reply finalization | |
| `setMessageText` | `messages.text` | voice combined transcript | |
| `markOutboundFailed` | `messages.error` | Telegram API failures | Masked, then truncated on a placeholder boundary |
| `setAttachmentTranscription` | `attachments.transcription` | voice transcript JSON | Parsed and sanitized structurally |
| `insertAttachment` | `attachments.name` | user-supplied filename | |
| `markAttachmentFailed` | `attachments.download_error` | download failures | Masked, then truncated on a placeholder boundary |
| `insertTurnMetric` | `turn_metrics.error` | turn failure text, which can echo provider output | |
| `insertChatToolDecision` | `chat_tool_decisions.input_pattern` | persisted always-allow/deny rules | See consequences |
| `issueCode` | `pair_codes.note`, and the `pairings.note` copy made from it | operator-typed note | |
| `approvals.issue` | `pending_approvals.tool_input_json` | provider tool input | Structural; see consequences |
| `questions.issue` | `pending_questions.questions_json` | the agent's questions | Audit copy, read back by nothing |
| `questions.issue` / `updateState` | `pending_questions.state_json` | the agent's questions and the user's answers | Sanitized questions plus markers; the exact values are live-only. See the last section |
| `questions.resolve` | `pending_questions.state_json` | terminal transition | Masks whatever remains, for text no rule flagged |
| `logEvent` | `events.detail_json` | ~200 polygram call sites plus Orchestra's direct `db.logEvent` | Typed schema, then masking |
| `messages_fts` | FTS5 index | insert/update triggers on `messages` | Mirrors `messages.text`; covered by assertion |

## Telemetry: a typed schema, not a name allowlist

A field-name allowlist is not enough on its own: names like `error` or
`reason` are permanent invitations to log a message body under an approved
name. So `lib/db/event-detail-schema.js` gives every field a **type** — id,
token, code, int, number, bool, digest, bounded id array, counter map, or a
named nested shape — and a value that does not satisfy its type is dropped.
There is no free-text type. A field carrying `undefined` is absence, not a
loss, and is not reported. Non-plain values (Date, Map, class instance,
function, BigInt) are dropped. What comes back about a rejection is a
`dropped_field_count` always, and the field's NAME only when that name belongs
to the schema's own closed vocabulary — see the consequences below.

Fields that carried prose are absent from the schema entirely and are dropped
wherever they are logged, **including from Orchestra**: `error`, `message`,
`path`, `old_value`, `value`, `topics`, `stderr_tail`, `pane_tail`,
`excerpt_head`, `text`, `text_preview`, `original`, `note`, `name`. Orchestra
keeps everything else under its own names — `turn_id`, `session_key`,
`backend`, `reason`, `phase`, `tmux_name`, `error_name`, `errCode`, the
`*_len`/`*_count`/`*_ms` families and the `*_hash` digests — which is why the
schema lists them explicitly rather than only polygram's.

`trigger` is kept and typed as a token: producers use it for a cause label
('boot', 'auto'), and the type rejects the user's own phrasing that once rode
in on that name. `name` is not kept — a filename is often a single token, so
typing alone would not stop it.

Producers that were passing content now pass a signal:

| Event | Was | Now |
| --- | --- | --- |
| `compact-command` | the full `/compact` line | `msg_id`; recovery joins the stored row |
| `abort-requested` (Claude and Codex paths) | `trigger` (user's stop phrasing), `busy_probe.pane_tail` | `text_len`; probe booleans without the pane |
| `handler-error` | `error`, `stderr_tail`, `stack` | `error_class`, `error_len`, `stderr_len`, `code`, `cause_code` |
| `telegram-api-error`, `rich-*`, `inject-fail`, `hook-tail-error` | redacted message text | `error_code` / `error_class` / `error_len` |
| `sessions-json-malformed` | `path`, `quarantined_to` | `quarantined: true`, `error_class` |
| `wedged-session-detected` | 200 chars of the wrapped reply | `text_len` |
| `canned-reply-suppressed` | the suppressed reply | `original_len` |
| `session-reload/reset-command`, `pair-code-issued`, `compact-*` | typed line, operator note, display name | command verb, `noticed` flag, `user_id` |

The secret sweep's own summary (`scanned`, `redactedMsgs`, `redactions`,
`flagged`, `ruleCounts`, `dryRun`, `reachedCap`, `remaining`) is preserved:
every field is a count, a flag or a per-rule counter map, none derived from a
secret's value.

## Secret-derived correlation

`secret_redactions.sha256` held an unsalted digest of each redacted value.
Framed as "audit without storing the secret", it is in fact a correlation
handle for the secret: anyone with a candidate value can confirm it appeared
and join every place it appeared. Migration 020 drops the index and the
column, which removes every digest already stored; a test seeds a populated
v19 database and asserts both audit rows survive with no fingerprint left.
No digest of a value is computed anywhere at runtime any more — `redactText`
records rule, tier and length only.

**Downgrading past schema 20 is not supported.** The column and its values are
gone by design; a rollback to a build expecting `secret_redactions.sha256`
would have to re-add the column empty, and the historical digests are
unrecoverable. That is the intended one-way door, not an oversight.

`pending_approvals.tool_input_digest` is no longer secret-derived either: it
is taken over the masked input, and a row whose input WAS masked gets a random
per-row identity instead (see below).

## Deliberately not covered, and why

| Sink | Reason |
| --- | --- |
| `pending_approvals.reason` | Operator-typed deny reason and internal status strings, written only by polygram's own resolve path. |
| Downloaded attachment files under the inbox directory | File payloads, not text sinks. A credential inside an uploaded document is not addressed by this boundary. |
| Claude session JSONL transcripts (read by the CLI backend, rewritten by `lib/rewind/fork.js`) and the temporary prompt file in `lib/process/claude-environment.js` | Provider-owned storage of the live turn. Masking there would mask the turn itself. |
| `scripts/split-db.js` bulk row copy | An operator tool that moves already-stored history between per-bot DB files verbatim. It belongs to historical cleanup, not to the pre-write boundary. |
| `secret_redactions.length` | Coarse, non-joining metadata retained for audit. |
| Process stdout / daemon logs | Content-free by convention (lengths and identifiers); error strings can still echo content there. Not enforced by code, and now the ONLY place a failure message survives. |
| Codex operational tables, `sessions`, `config_changes`, `turn_metrics` (except `error`), `polling_state` | Content-free by schema design — identifiers, states, counters and timestamps. |

## Consequences worth knowing

- Recovery paths replay the **stored** text: boot replay re-prompts from
  `messages.text`, dropped-outbound redelivery sends the stored body, and
  orphaned-`/compact` recovery re-pushes the recovered line. That line is
  sanitized on read from BOTH sources — the message row and the legacy event
  copy — because rows written before this boundary existed still hold raw
  text, and those are the oldest and most likely to be replayed. Before that line
  is fired at a live session it is normalized and validated
  (`normalizeCompactCommand`), so a mention-suffixed command becomes its plain
  form and anything that is not a compact command is refused and surfaced
  instead. Historical events that still carry the line in their detail remain
  recoverable, sanitized on the way out.
- History and context preload read stored rows, so previous turns reach the
  agent masked. The current turn does not.
- A persisted always-allow/always-deny rule whose pattern carried a credential
  stops matching that input. The call returns to a human approval prompt; it
  is never auto-allowed. (Separately, `lib/handlers/approvals.js` builds that
  pattern from `row.tool_input`, a field the stored row does not have — it is
  `tool_input_json` — so the persist path throws today and is caught. That is
  a pre-existing defect in the always-rule flow, untouched here because fixing
  it changes authorization behavior.)
- Approval dedupe is fail-closed. Two different credentials mask to the same
  text, so a digest of the masked input would let one operator decision
  authorize a different command. A sanitized row therefore gets a random
  per-row identity and skips legacy reuse; dedupe by the provider's stable
  `tool_use_id` is unaffected, and an unchanged input still dedupes normally.
- Telemetry that hits a field outside the typed schema is written with the
  field removed, a `dropped_field_count`, and — only for names from the
  schema's own closed vocabulary — a `dropped_fields` list. An unknown key is
  not echoed back: keys can be caller-controlled (a payload spread from a map
  keyed by user data puts arbitrary text in the key position), so an unknown
  name is content, not a diagnostic. Adding a new event field means adding it
  to the schema — that friction is the point. Failure *messages* now live only
  in the process log.
- Orchestra writes into this sink directly and names some fields in camel case
  (`sessionKey`, `turnId`, `totalCost`, `newCost`, `queueCap`,
  `turnTimeoutMs`, `drainedPendings`, `pinnedSkipped`, `callback`). Those are
  listed in the schema under their real names rather than asking an external
  package to rename anything. `active` is a live-process count and `files` is
  the inbox sweep's file count — both typed as integers, which is what the
  producers actually emit.
- The sweep also flags `prose-secret` hits, and scans rows already masked at
  write time; it neither restores nor re-wraps them.

## Open-question state: live-only, not durable

`pending_questions.state_json` is the live state machine for an **open**
question — every tap re-reads it, and the answers accumulate in it — so it once
held two things exactly: the agent's question array and the user's typed
answer. Both are now live-only.

The handler keeps one live question context per open ask, keyed by
`tool_call_id`, holding the exact question array, any flagged answer by
question index, and a terminal claim. The row keeps the sanitized questions
(in `state_json` as well as `questions_json`) and, for a flagged answer, a
marker with no answer text. Before the state machine renders a card or matches
an option the exact array is hydrated back, so the card, the keyboard and the
recorded label are byte-identical to before; before every write the sanitized
copy and the markers go back. Delivery resolves the payload from the live
values, so the provider still receives exactly what the user typed.

What is flagged is decided by `sanitizeForDurableWrite(...).changed`, the same
predicate and allowlist as the rest of this boundary: `password: required`
stays durable, `password: hunter2-fake-value` does not.

Nothing exact outlives the process. The live entry is dropped after a
successful delivery, and on cancellation, expiry, shutdown disposition, session
reset/retirement and delivery failure — a delivery failure for a row holding an
answer cancels rather than retries, because a retry lease means keeping the
credential in memory until the sweep fires. At boot, rows carrying a marker are
cancelled at an awaited barrier before replay, redelivery, provider recovery,
polling or inbound admission; they are never answered from a marker and never
replayed.

Honest limits:

- **The provider's own storage is outside this boundary.** Once the exact
  answer is delivered, the Claude CLI may write it into its native session
  JSONL under `~/.claude/projects/`. That is unavoidable while the provider
  receives the exact answer, and Polygram neither owns nor masks it.
- **A restart loses the answer on purpose.** Polygram cancels the orphaned
  question and posts a notice; it does not make the provider ask again. The
  assistant may ask again only on a later resumed or new turn.
- **A socket write is not proof of consumption.** The notice is worded to hold
  whether or not an earlier answer reached the provider.
- **Detection is deterministic shape matching only.** An answer no rule flags
  is still durable until the terminal mask.
- **DQ3 remains open**: an unmarked leftover `pending` row can still consume a
  later message as an answer to a dead tool call. That is a separate bug with
  its own fix, deliberately untouched here.
