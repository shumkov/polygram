# Rich mailbox cards and reply links

## Problem and contract

An HTML expandable quotation still exposes several lines of a mailbox prompt.
The approved shared rich-cards contract uses one blockquote containing a header
and a closed `details` block. This implements the polygram half of that contract;
agent-org depends on rich IPC and intact Notion URL targets in reply context.

## Research and choice

The existing `createRichSender` already materializes rich blocks, records sent
messages and shares the process capability latch with streaming. Reuse that
instance, without styling retries. Direct `tg(sendRichMessage)` would bypass the
latch and transcript bookkeeping; converting Markdown back into rich blocks
would alter the literal, already-redacted mailbox body. The existing rich
inbound renderer understands blockquote, details and URL nodes. The contract
records a live-approved card on VPS Bot API 10.2; this work needs no server or
CLI pin change. HTML remains the compatibility path, not a server-version probe.

## Sending

Add `sendRichMessage` to the IPC allowlist. Accept the contract's `params`
(`chat_id`, optional `message_thread_id`, `rich_message.blocks`) and optional
`fallback: {text, parse_mode: "HTML"}`. Apply existing bot, chat ownership and
inline-address checks before either send; require chat_id for the rich method.
Validate a nonempty blocks array and a supplied fallback before sending. A
fallback cannot override the destination or carry extra send parameters.

```json
{"op":"send","method":"sendRichMessage","params":{"chat_id":"-1001","message_thread_id":142,"rich_message":{"blocks":[{"type":"blockquote","blocks":[{"type":"paragraph","text":["📌 ",{"type":"bold","text":"New task"}," · prices"]}]}]}},"fallback":{"text":"<blockquote><b>New task</b> · prices</blockquote>","parse_mode":"HTML"}}
```

The successful authenticated IPC response is
`{ok:true, result: Message, rich:true|false}`. Use the low-level IPC `call`
for this complete envelope; the existing `tell` convenience function still
returns only the Message and does not forward a fallback option.

A small shared adapter takes the existing rich sender, tg, destination, blocks
and optional HTML fallback. It makes one rich attempt and, on `wentRich:false`,
one HTML send. Both use `strictDestination:true`, preserving chat and topic;
fallback disables link previews. It returns `{result: Message, rich: boolean}`.
Without a fallback, rich failure becomes an IPC error. Reuse existing rich
failure classification and latch behavior: content failures do not disable rich,
capability failures can, and generic failures follow the sender's existing
fallback policy. The existing ambiguous-send/no-message-id duplication tradeoff
remains; this change adds no retries or additional fallback sends. Missing rich
dependency in an isolated caller behaves as unsupported.
Derive `sourceText` from the actual blocks with `richMessageToText`, independently
of the fallback, and pass it to the shared sender so a successful rich-only IPC
send persists readable transcript text. Verify the recorded row on that path.

## Summary storage and mirrors

Add nullable `mailbox_messages.summary` in migration 027. Only mailbox_send and
mailbox_submit accept `summary`; mailbox_reply continues to derive its summary.
A supplied summary is a nonblank string of at most 120 Unicode code points,
with control characters and Unicode line separators refused. Redact before
storage, hashing and mirroring, and revalidate after redaction. Absent summaries
stay NULL. Include supplied summaries in role duplicate and system idempotency
hashes, while preserving the exact old hashes when absent (including origin
hashes). Changing a summary under a system key conflicts; retrying an identical
request returns the stored receipt without another post. Summary is display
metadata only: never put it in the delivered task or payload.

Both target and sender mirrors use the same rich shape, exactly one top-level
blockquote with two children:

1. Paragraph: icon, bold Message/Question/Answer, then ` · from → to` and the
   optional ` · from origin`. Strip only the address prefixes. Cap the full
   header at 512 UTF-16 units without splitting a code point.
2. Closed details: supplied summary, otherwise the first nonempty body line
   shortened to 80 code points with an ellipsis; one paragraph containing the
   complete stored redacted body as a literal string.

The HTML fallback is the existing target HTML card, including escaping and its
4096 UTF-16-unit budget, for both destinations. Thus fallback deliberately keeps
the older heading wording and expandable quotation. No technical IDs or
commands are injected into the rich heading/summary. The expanded body still
contains exactly what the role received. Agent-org tells remain mirrored.
Posting remains best effort after commit, never from dispatch; mirror "both"
posts once in each eligible topic, and one post's failure cannot block the
other. System senders have no sender topic. No delivery or stop/pause change.

## Reply links

Extract URL nodes from the retained `reply_to_message.rich_message` tree,
including nested details/blockquote and nested inline styling, using bounded
traversal consistent with rich-inbound's depth limit. Preserve traversal order,
ignore empty/nonstring targets, and collect the rendered label. Merge these
with valid Telegram text_link entities (UTF-16 offsets), deduplicating targets.
For rich surrounding context, render a bounded copy of the tree with URL-node
targets removed, leaving their visible labels. Use this even when intake has
already populated `.text`, whose Markdown rendering contains URL targets.
Limit traversal to 64 levels and 32768 visited values; ignore malformed excess.
Feed all targets through the existing 500 UTF-16-unit whole-link budget:
`Links:\n<label> <URL>`, reserve complete URLs before labels and surrounding
text, skip a URL too large to fit, continue to smaller ones and signal omissions.
Never cut a URL or surrogate pair. Do not parse Markdown to recover targets.
Unchanged database fallback has no structured rich tree and remains text-only.

## Verification

TDD red then green: IPC rich send currently refused; summary currently unknown;
mirror currently HTML rather than closed rich details; reply to a rich task
card currently loses its URL under truncation. Cover capability latch reuse,
content rejection then healthy rich send, no fallback/error, ownership and
strict topic preservation, same-result shape, summary persistence/restart and
idempotency/redaction/validation, both mirrors and once-only delivery, literal
body, reply URL retention with Cyrillic/emoji and oversized earlier URLs.
Run focused tests then npm test; report skipped real-Claude gates explicitly.
No live sends, deployment or provider calls are needed to verify this change.

## Independent review

Three read-only reviews covered correctness/failure modes, simplicity/contract,
and Telegram/length handling. Incorporated: deterministic transcript sourceText
and persisted-row verification; label-only rich surrounding text even after
intake normalization; the existing 512-unit header bound. Clarified that a
leading blank line is skipped when deriving a summary so the collapsed card
has readable text. No findings declined; no shared contract change.
