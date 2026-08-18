---
title: Pending Question Secret Answers - Live-Only Delivery Plan
type: fix
date: 2026-08-16
revised: 2026-08-16
topic: pending-question-secret-answers
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-session
execution: code
---

# Pending Question Secret Answers - Live-Only Delivery Plan

> **Parent plan.** `docs/plans/2026-07-31-002-feat-shumabit-scoped-memory-plan.md`
> does **not** exist in this implementation worktree. It lives in the
> orchestration worktree (`polygram.codex-support-estimate`) at that path, and
> the version this plan was written against is
> `sha256:ec375446e1301e7b8164f1f39260f0f312c181ef1b2feb928a9b755d1533cae4`.
> Its U25 owns the durable-boundary requirement; this plan owns only the
> interactive-question path. The parent must be updated and made to cite this
> plan **on the orchestration branch** before U25 can be declared complete — no
> part of U25 is closed by merging this branch alone.

## Goal Capsule

- **Objective:** neither the user's answer nor the provider's question text is
  durably stored by Polygram in exact form when it carries a detected
  credential, while the live interaction stays byte-identical to today.
- **Boundary being claimed — and its limit.** The claim is
  *no Polygram-owned durable sink*, not universal non-persistence. Once the exact
  answer is delivered, the Claude CLI may write it into its own native session
  JSONL under `~/.claude/projects/`, which Polygram neither owns nor masks. That
  is unavoidable while the provider receives the exact answer, and it is an
  accepted external boundary, not a defect this plan can fix.
- **Blockers being closed:** two live sinks in `pending_questions` —
  `state_json.answers[]` (the recorded answer) and `state_json.questions` (the
  provider's question array, exact even though the `questions_json` column is
  masked).
- **Chosen shape:** one handler-local **live question context** holds everything
  exact for the lifetime of the process; both durable copies carry only
  sanitized text plus structural markers; a terminal claim guarantees one
  delivery. If the process dies first the exact text is gone: marked rows are
  cancelled with a notice.
- **Non-goals:** at-rest encryption, key management, durable exact replay,
  provider-protocol changes, synthetic continuation injection, the general
  stale-pending-row bug, and everything else in U25.

---

## Product Contract

### Verified current behavior

Read from `lib/questions/store.js`, `lib/questions/questions.js`,
`lib/handlers/questions.js`, `polygram.js`,
`migrations/012-pending-questions.sql` and the pinned Orchestra process code.

- **Durable fields.** `pending_questions` holds `questions_json`, `state_json`
  (`{questions, qIndex, answers[], toggles, awaitingOther}`), `message_ids_json`,
  `awaiting_other`, `from_id`, `callback_token`, `status`, `timeout_ts`. An
  answer is `{header, selected: [label…], other?}` — the labels are copied from
  the question's own options.
- **Both question copies are durable, only one is masked.** `issue()` masks the
  `questions_json` column, but `Q.initState(qs)` copies the same array into the
  state and `state_json` is written unmasked. Verified against a live DB: a
  question body reading `password: hunter2-fake-value` is masked in
  `questions_json` and exact in `state_json`.
- **The question array is load-bearing at runtime.** `Q.renderCurrent` builds the
  card from `state.questions[qIndex]`, and `Q.applyTap` records
  `opts[action.i].label` from the same array — so both the visible card and the
  recorded answer are derived from whichever copy the handler holds.
- **State machine.** Sequential, one question per Telegram message.
  `Q.applyTap` handles single-select (record + advance), multiSelect
  (toggle → Submit records + advances) and "Type my own" (sets `awaitingOther`).
  `Q.applyFreeText` records `{…, other}` after capping at `MAX_OTHER` (1000).
  `Q.assemble(state)` returns `{answers}`, the provider-facing payload.
- **Where an answer becomes durable.** Four `updateState` call sites in
  `lib/handlers/questions.js`: toggled (176), awaiting-other (188), done (278)
  and next-question (295). The done-path write happens **before** delivery, and
  an intermediate answer sits in `state_json` for the rest of the interaction.
- **Where it reaches the provider.** `advance()` → `finalize()` →
  `answerQuestion(session_key, tool_call_id, result)` → `pm.answerQuestion` →
  `CliProcess.writeQuestionAnswer` → `_writeToBridge` → the bridge server's
  `writeMessage`. The boolean it returns means "the socket write did not throw",
  **not** that the provider consumed the answer.
- **Nothing serializes delivery.** `advance()` awaits `strip`/`ack` before its
  done branch, so two concurrent taps — or a tap racing a typed answer — can
  both reach `finalize()` and call `answerQuestion` twice.
- **One backend only.** `question-asked` is emitted by `CliProcess` on an `ask`
  tool call; `ProcessManager.answerQuestion` requires `writeQuestionAnswer`,
  which `CodexProcess` does not implement. Neither the Codex path nor the SDK
  backend can raise or answer a question in the installed Orchestra.
- **Terminal masking already exists.** `resolve()` masks the retained
  `state_json` in one transaction; `issue()` masks `questions_json`. Neither
  covers the pending window.
- **Clean shutdown resolves open rows** (`beginShutdownDisposition` when a
  continuation is authorized, otherwise `expireQuestion(status:'cancelled')`).
- **A crash does not.** There is no boot reconciliation; the 30s sweep only fires
  past `timeout_ts` (24h). A leftover row keeps `awaiting_other`, so
  `tryConsumeAsAnswer` can swallow the user's next message into a dead tool call.
  That general bug is broader than this blocker and is recorded as DQ3.
- **Session retirement does not clear questions either.** `pm.resetSession`
  (`polygram.js:2480` auto-recover, `lib/handlers/slash-commands.js:280` for
  `/new` and `/reset`) closes the process without touching open rows; nothing in
  `lib/rewind/` or `lib/handlers/abort.js` does either.
- **The receipt is not a Polygram row.** `advance()` edits the card to
  `✓ <answer>` via `editMessageText`, which `METHODS_WITHOUT_MSG` excludes from
  transcript rows. Question telemetry is already content-free.

### Requirements

- **RQ1.** A recorded answer the sanitizer flags — a typed value or a selected
  option label — is never written to `pending_questions.state_json` in exact
  form: not on the done path, not on an intermediate question, not on a retry.
- **RQ2.** The provider receives the answer exactly: byte-identical to what
  `Q.applyTap`/`Q.applyFreeText` accepted (after the existing `MAX_OTHER` cap,
  which is out of scope). Masking or shortening the provider's copy is a defect.
- **RQ3.** Every exact copy Polygram owns before provider delivery exists only in
  the live question context and is dropped after a successful `answerQuestion`,
  and on cancellation, expiry, shutdown disposition, session reset/retirement,
  and delivery failure. Native provider persistence after delivery is governed by
  the Goal Capsule's boundary, not by this requirement.
- **RQ4.** The durable row records structural markers with no text. A marker is
  never serialized into a provider payload, a Telegram message, a log line, a
  thrown error, or an events row.
- **RQ5.** When the live context is missing (restart, session retired), Polygram
  delivers nothing upstream for a marked row: it cancels and posts a
  content-free notice. Handling is a returned refusal value, never a throw.
- **RQ6.** Mixed prompts work: unflagged answers stay durable and exact; only
  flagged fields are held live.
- **RQ7.** Both durable copies — the `questions_json` column and
  `state_json.questions` — carry only the sanitized question array. The exact
  array lives in the live question context for the process lifetime.
- **RQ8.** The flag predicate is `sanitizeForDurableWrite(value).changed` from
  `lib/secret-detect.js`, applied to the value the state machine accepted, so the
  existing allowlist applies unchanged. No new detector, and no claim that
  arbitrary prose is recognized.
- **RQ9.** A row carrying a marker is reconciled at boot before anything can act
  on it, and its notice is worded so it is true whether or not the answer reached
  the provider.
- **RQ10.** Existing terminal masking and the rest of the U25 boundary are
  unchanged and remain defense-in-depth for text the sanitizer does not flag.
- **RQ11.** At most one `answerQuestion` call is made per row: concurrent taps,
  a tap racing a typed answer, and duplicate completions all resolve to one
  delivery. A losing caller neither delivers, nor deletes, nor resurrects live
  values.
- **RQ12.** While the live context exists the rendered card and the state
  machine's option matching are byte-identical to today. After a restart the
  exact array is intentionally gone: marked rows cancel (RQ5), and an unmarked
  legacy row can only fall back to the sanitized copy.

### Acceptance examples

- **AQ1.** "Type my own" → the user types `password: hunter2-fake-value`. No such
  text appears in `state_json`; `answerQuestion` receives it exactly; the live
  context is empty afterwards.
- **AQ2.** Three questions; question 1 answered with a flagged value, 2–3 by
  button. `state_json` carries a marker for 1 and durable answers for 2–3
  throughout; the delivered payload has all three exact.
- **AQ3.** Flagged answer, then the process dies before the set completes. At
  boot the marked row is cancelled with the notice, nothing is delivered
  upstream, and no marker or placeholder is sent.
- **AQ4.** A benign answer (`sonnet please`, or `password: required`, which the
  allowlist covers) is untouched: durable, exact, no live entry.
- **AQ5.** A question whose body or option label contains
  `password: hunter2-fake-value` is masked in `questions_json` **and** in
  `state_json.questions`, while the card the user sees and the label the state
  machine matches remain exact.
- **AQ6.** Two taps land on the same final question in the same tick. One
  `answerQuestion` call is made; the other is a no-op that leaves the live
  context intact.

---

## Planning Contract

### Key technical decisions

- **KTDQ1.** Live-only delivery plus cancel-and-notify (session-settled:
  user-directed — chosen over at-rest encryption/key management and durable
  exact replay: the user approved live-only Polygram storage plus
  cancel-and-notify rather than durable exact secrets.)
- **KTDQ2.** One private `Map` inside `createQuestionHandlers` holds a **live
  question context** per open ask, following the waiter-map pattern
  `lib/handlers/approvals.js` already uses. Each entry owns three things and
  nothing else: the exact question array, flagged exact answers keyed by
  question index, and the terminal claim. Not a reusable module and not a
  Polygram-wide service — there is one consumer and the handler owns every
  terminal path.
- **KTDQ3.** Keyed by `tool_call_id`: the stable routing identity (`renderAsk`
  refuses a duplicate, `idx_pq_tool_call` indexes it). Answers inside an entry
  are keyed by question index, scoping each held value to one field.
- **KTDQ4.** `get`/peek semantics, not one-shot take: hydration repeats within a
  turn, and removal is a lifecycle decision rather than a read side effect.
  Entries are removed explicitly, never evicted — an implicit LRU would silently
  destroy another chat's pending answer. The structural bound is the number of
  simultaneously open asks (one per session, `idx_pq_open`) times one accepted
  answer per question index.
- **KTDQ5.** Markers are flags on the durable answer object
  (`{header, selected: [], secret_omitted: true}`) with no text field. They
  cannot read as an answer, and assembly is never handed one.
- **KTDQ6.** Hydration returns a discriminated result — `{ok: true, answers}` or
  `{ok: false, reason: 'live-answer-missing'}`. `advance()` handles the refusal
  by cancelling and posting the notice, so nothing reaches the dispatcher's outer
  catch and no error message can carry a value or a marker.
- **KTDQ7.** The predicate is `sanitizeForDurableWrite(value).changed` on the
  value the state machine accepted, so detection and delivery agree on one string
  and the allowlist decides the benign cases.
- **KTDQ8.** **Hydrate in, restore out.** The handler hydrates a transient state
  with the exact question array before `Q.applyTap`, `Q.applyFreeText`,
  `Q.renderCurrent`/`sendCurrent` and final assembly; before each of the four
  `updateState` call sites it restores the sanitized array and replaces any
  flagged recorded answer with its marker. Raw question text, option labels and
  flagged answers therefore have no path back into the row. Because
  sanitization only rewrites text the detector flags, the sanitized and exact
  arrays are byte-identical for ordinary questions.
- **KTDQ9.** A handler-owned terminal claim on the context entry is taken
  synchronously before any provider write; the check-and-set cannot interleave.
  The winner delivers and owns the terminal bookkeeping; a loser returns without
  touching live values. The claim is released only as part of definitive
  success, cancellation or delivery-failure handling. A crash loses it with the
  process, which is exactly what the marked-row boot reconciliation cancels —
  never replays.
- **KTDQ10.** On delivery failure the entry is cleared and the row cancelled with
  a notice. No retry lease: holding a secret longer to make a retry transparent
  trades the boundary for convenience.
- **KTDQ11.** Boot reconciliation touches **only** rows carrying a marker. The
  general orphaned-row bug is real and separate (DQ3); mixing them would widen
  this change past the blocker.
- **KTDQ12.** No Codex or SDK guard is built. The installed Orchestra has no path
  that could reach it, so a guard would be untestable scaffolding. Future Codex
  or SDK question support must adopt this same boundary when implemented.

### Deferred, nonblocking

- **DQ1.** The card receipt echoes the typed answer back into the chat. It is not
  a Polygram transcript row (`editMessageText` is excluded), and the same text is
  already in the chat as the user's own message, so masking it would be a UX
  change outside the settled policy. Out of scope.
- **DQ2.** `updateState` has no optimistic concurrency. KTDQ9's claim removes the
  duplicate-delivery race only; two **non-terminal** updates at the same question
  index (two toggles, or a toggle racing an awaiting-other transition) can still
  lose one. Pre-existing, unchanged, and not claimed fixed.
- **DQ3.** Follow-up, separate from this plan: a leftover `pending` row with
  `awaiting_other=1` can consume the user's next message as an answer to a dead
  tool call. Broader than the secret boundary; needs its own change. An unmarked
  legacy row reached that way falls back to the sanitized question array.

### Behavior change to sync with the user

After a restart or session retirement, Polygram cancels the orphaned question and
posts a notice. It does **not** make the provider ask again: nothing in the
current code owns or proves that, and the blocked `ask` call died with its
process. The user may see the assistant ask again only on a later resumed or new
turn, or may need to resend the original request. This is a visible change from
today's behavior, where the row lingers and the answer is stored.

---

## Implementation Units

### UQ1. Live question context and sanitized durable questions

- **Goal:** RQ7, RQ12, and the hydrate/restore discipline RQ1 depends on.
- **Files:**
  - `lib/handlers/questions.js`: the private context `Map`; store the exact
    array at `renderAsk` time; hydrate before `Q.applyTap` (170),
    `Q.applyFreeText` (218) and `renderCurrent`/`sendCurrent` (56, 177); restore
    the sanitized array before all four `updateState` sites (176, 188, 278, 295);
    fall back to the durable sanitized array when no context exists.
  - `lib/questions/store.js`: `issue()` persists the sanitized array in
    `state_json.questions` as well as in `questions_json`.
- **Tests (red first):**
  - `tests/questions-store.test.js`: a question body containing
    `password: hunter2-fake-value` is masked in **both** columns.
  - `tests/handlers-questions.test.js`: with a secret-bearing body and a
    secret-bearing option label, the rendered card text and keyboard are
    byte-identical to today; option matching selects the same option; the
    persisted state after **each** tap of a 1..N sequence contains only
    sanitized question text; after a simulated restart an unmarked row renders
    and matches from the sanitized copy without crashing.
  - `tests/durable-secret-boundary.test.js` (extend): real-DB assertion across
    the whole sequence that neither durable column holds the exact question.
- **Verification:** the live interaction is unchanged; neither durable copy
  carries exact provider question text.

### UQ2. Flagged answers held live

- **Goal:** RQ1–RQ4, RQ6, RQ8, RQ10.
- **Files:** `lib/handlers/questions.js` — apply the predicate to the accepted
  value from `applyTap`/`applyFreeText`, store the exact value in the context
  entry under its question index, write the marker instead, hydrate immediately
  before `Q.assemble` (281), and clear the entry after successful delivery, in
  `expireQuestion`, in `beginShutdownDisposition`, and on delivery failure;
  expose `discardSession(sessionKey)`. `polygram.js`: call `discardSession` at
  the auto-recover reset (`polygram.js:2480`) and the `/new` `/reset` path
  (`lib/handlers/slash-commands.js:280`), and clear all entries on shutdown.
- **Tests (red first):** flagged typed answer and flagged selected label both
  leave no exact text in the state passed to `updateState`; `answerQuestion`
  receives the accepted value byte-identical; the entry is gone afterwards; an
  allowlisted answer (`password: required`) and a plain answer stay durable; a
  value at the `MAX_OTHER` cap round-trips as the already-capped string; a
  missing live value cancels with the notice and delivers nothing; a throwing
  `answerQuestion` clears the entry and cancels; a mixed three-question prompt;
  cleanup on expiry, shutdown disposition and session reset; the marker never
  appears in a Telegram payload, a log line, a thrown error, or an events row.
- **Verification:** no flagged answer in the pending row; the provider payload is
  byte-identical to the accepted value.

### UQ3. Terminal claim and marked-row boot reconciliation

- **Goal:** RQ5, RQ9, RQ11.
- **Files:**
  - `lib/handlers/questions.js`: claim the context entry synchronously before any
    `answerQuestion`; release it only in definitive terminal handling; add
    `reconcileMarkedQuestionsAtBoot(rows)` — for rows whose state carries a
    marker, resolve the row, edit the card to the notice, never call
    `answerQuestion`, emit a content-free event.
  - `polygram.js`: an **awaited** barrier after the store and handlers exist
    (`polygram.js:4047`–`4055`) and before clean-restart replay, the redelivery
    tail, provider recovery / `getOrSpawnForChat`, the poll loop, and inbound
    admission (`polygram-admission-open`, `polygram.js:5413`).
  - `docs/durable-text-sink-inventory.md`: replace the open-blocker section with
    the delivered behavior, the provider-owned JSONL limit, and DQ3.
- **Notice wording** must hold whether or not the answer reached the provider:
  Polygram did not keep the sensitive answer, the question or turn was
  interrupted, and the user should wait for the assistant to ask again or resend
  the original request. It must not assert the answer was undelivered.
- **Tests (red first):** two concurrent taps on the final question produce one
  `answerQuestion` call, and the loser leaves the context intact; a duplicate
  completion after a resolved row delivers nothing; a marked row is reconciled
  before replay and inbound admission (assert ordering, not just end state); no
  upstream answer is attempted; the card shows the notice; the marker survives
  terminal masking with no text; an unmarked stale row is left alone (DQ3 is not
  in scope).
- **Verification:** exactly one delivery per row, and no marked row outlives its
  owning process unreconciled.

---

## Verification Contract

- Every unit lands **test-first**: add the regression test, run it, record the
  observed red output in the commit message, then implement and confirm green.
- Focused suites: `tests/handlers-questions.test.js`,
  `tests/questions-store.test.js`, `tests/questions.test.js`,
  `tests/durable-secret-boundary.test.js`, `tests/db.test.js`.
- One focused integration test exercising the real path: actual Polygram boot
  order through the reconciliation barrier, and delivery through the Orchestra
  bridge boundary rather than a stubbed `answerQuestion`, so neither the boot
  ordering nor the transport contract is asserted only against a mock.
- Required assertions, stated as behavior:
  - no flagged answer and no exact question text in either durable copy at any
    point, asserted against a real DB after every tap of a 1..N sequence;
  - the rendered card, keyboard and option matching are byte-identical while the
    live context exists;
  - the provider receives the accepted value byte-identical, exactly once per
    row under concurrent taps and duplicate completions;
  - the live context is empty after delivery, cancel, expiry, shutdown and
    session reset;
  - a marker never reaches a provider payload, a Telegram send, a log line, a
    thrown error, or a persisted event row;
  - an allowlisted or plain answer is unchanged end to end;
  - a marked row is reconciled before replay, redelivery and inbound admission;
    an unmarked row post-restart falls back to the sanitized copy.
- **Full-suite completion signal:** `npm test` run from a checkout path short
  enough for Unix-domain sockets, with **no unexplained failures**. This
  worktree's long path makes `tests/ipc-cli.test.js` fail on socket-path length;
  that limitation is recorded separately and is not a licence to accept failures
  in a normal run.

## Definition of Done

- Neither a flagged answer nor exact provider question text reaches
  `pending_questions` in either durable copy, and the live interaction — card,
  keyboard, option matching, delivered payload — is byte-identical to today.
- Every exact copy Polygram owns is dropped after successful delivery and on
  cancellation, expiry, shutdown disposition, session reset/retirement and
  delivery failure.
- Exactly one `answerQuestion` call is made per row under concurrent taps,
  racing typed answers and duplicate completions, and a losing caller changes
  nothing.
- A missing live value produces a returned refusal, a cancelled row and the
  content-free notice — never a throw, a placeholder, or an upstream marker.
- Marked rows are reconciled at an awaited boot barrier before replay,
  redelivery, provider recovery, polling and inbound admission.
- `docs/durable-text-sink-inventory.md` states the delivered behavior and the
  honest limits: detection is deterministic shape matching only; unflagged text
  is still durable until the terminal mask; the exact answer may persist in the
  Claude CLI's own session JSONL once delivered, which Polygram does not own;
  DQ2's non-terminal same-index race and DQ3's orphaned-row bug remain open.
- The provider-owned persistence limit and the no-automatic-re-ask behavior
  change are both stated in the parent plan's U25 section on the orchestration
  branch, with this plan cited, before U25 is declared complete.
