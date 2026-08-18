/**
 * Interactive-question handlers (0.12 ask feature) — the integration glue between
 * the pure state machine (lib/questions/questions.js), the store
 * (lib/questions/store.js), Telegram, and the bridge answer write-back.
 *
 *   renderAsk            — claude called `ask`: issue a row, send the keyboard.
 *   handleQuestionCallback — a `q:` button tap: validate, mutate, advance/resolve.
 *   tryConsumeAsAnswer   — dispatcher hook: a typed message while a question is
 *                          open (free-text "Other", or a nudge for the wrong user).
 *   expireQuestion       — timeout sweep / cancel: answer {timedout}/{cancelled}, strip.
 *   beginShutdownDisposition — cancel locally during provider retirement without
 *                          sending a synthetic answer into the retiring turn.
 *
 * Security (review): per-row 128-bit token in callback_data + claim-on-first-tap
 * respondent authz + plain-text body (no parse_mode) for agent content.
 *
 * Anti-hang invariant (review-hardened): claude's `ask` tool call must be answered
 * EXACTLY once and never hang. Therefore every terminal path hands the result to
 * claude *first* (guarded) and only then marks the row terminal — `finalize()`. If
 * the write-back THROWS, the row is LEFT pending so the timeout sweep can recover
 * with {timedout} (never resolved-but-hung). If the write-back is an undelivered
 * NO-OP (returns false — session gone / no live bridge), it is surfaced loudly and
 * the row is still resolved (a dead session can't be delivered; the bridge's own
 * 20-min ceiling backstops the rare live-proc case). A failed Telegram send is also
 * hang-safe: we answer {cancelled} rather than leaving a pending row with no
 * on-screen keyboard. renderAsk that throws BEFORE issuing a row answers {cancelled}
 * itself (no row exists for the sweep to find); tryConsumeAsAnswer never throws out
 * of the dispatcher (a store error degrades to "not an answer", never a dropped msg).
 */

'use strict';

const Q = require('../questions/questions');

// Shown when an answer cannot be delivered because the exact value is gone.
// It must be true both when the provider never received anything and when it
// received an earlier answer before the interruption.
const QUESTION_INTERRUPTED_NOTICE = 'This question was interrupted. Polygram did not keep your'
  + ' sensitive answer, so nothing was stored for a retry — wait for the assistant to ask again,'
  + ' or send your original request once more.';

// Corrections for a card left behind by a call that finished after the
// question was already settled. They state only what the durable status says:
// the answer itself belongs to the turn that delivered it, not to a late
// caller trying to reconstruct a receipt it overwrote.
const QUESTION_ANSWERED_NOTICE = 'This question was answered.';
const QUESTION_TIMED_OUT_NOTICE = 'This question timed out.';
const { tokensEqual } = require('../questions/store');

function createQuestionHandlers({
  questions,        // store (lib/questions/store.js)
  tg,
  bot,
  botName,
  logEvent = () => {},
  answerQuestion,   // (sessionKey, toolCallId, result) → write question_answer to the bridge
  logger = console,
} = {}) {

  /**
   * Live question context, one entry per open ask, keyed by tool_call_id (the
   * same identity the answer routes back on). It holds everything that must
   * not reach a durable row:
   *
   *   questions — the agent's exact question array. The row keeps a sanitized
   *               copy; this one is hydrated back before the state machine
   *               renders a card or matches an option, so the live interaction
   *               is unchanged.
   *   answers   — exact answers whose text carries a credential, keyed by
   *               question index. The row keeps a marker with no text.
   *   finalizing — the terminal claim. Taken synchronously before any provider
   *               write so concurrent taps produce exactly one answer.
   *
   * Entries are removed explicitly on every terminal path; nothing is evicted,
   * because evicting another chat's pending answer to make room would destroy
   * the only copy that exists. The bound is structural: one open question per
   * session, one held answer per question index.
   */
  const liveContexts = new Map();

  const contextFor = (toolCallId) => (toolCallId == null ? null : liveContexts.get(toolCallId) || null);

  function openContext(toolCallId, sessionKey, exactQuestions) {
    if (toolCallId == null) return null;
    const ctx = {
      sessionKey,
      questions: Array.isArray(exactQuestions) ? exactQuestions : null,
      answers: new Map(),
      finalizing: false,
    };
    liveContexts.set(toolCallId, ctx);
    return ctx;
  }

  const closeContext = (toolCallId) => { if (toolCallId != null) liveContexts.delete(toolCallId); };

  /**
   * Hold the newly recorded answer live when it is flagged. The row will get a
   * marker in its place; the exact value never leaves this process.
   *
   * The context is never created here. One that vanished mid-interaction was
   * disposed on purpose — the session was retired, or another path settled the
   * question — and recreating it would resurrect an owner that no terminal
   * path is tracking. Returns false when the answer needed holding and could
   * not be held, which the caller turns into a cancellation.
   */
  function holdIfFlagged(ctx, state) {
    const index = (state.answers?.length ?? 0) - 1;
    if (index < 0) return true;
    const answer = state.answers[index];
    if (!Q.answerIsFlagged(answer)) return true;
    if (!ctx) return false;
    ctx.answers.set(index, answer);
    return true;
  }

  /**
   * Forget everything exact for this question. `keepOwnership` leaves a
   * content-free tombstone that still blocks a second provider write — used
   * when the answer WAS delivered but the terminal bookkeeping failed, so the
   * row can stay pending without a duplicate delivery becoming possible.
   */
  function scrubContext(toolCallId, { keepOwnership = false } = {}) {
    if (toolCallId == null) return;
    const ctx = contextFor(toolCallId);
    if (!keepOwnership) { liveContexts.delete(toolCallId); return; }
    liveContexts.set(toolCallId, {
      sessionKey: ctx?.sessionKey ?? null,
      questions: null,
      answers: new Map(),
      finalizing: true,
    });
  }

  /**
   * Retire a session's question state. One operation for every path that
   * retires the process owning an open ask — a fresh session, a reload, an
   * auto-recover reset, a verified stop, a rewind: the open row is closed as
   * cancelled, its card is corrected, and every exact value held for that
   * session is dropped.
   *
   * Best effort by contract. Callers are mid-teardown and must not be made to
   * handle a failure here, so nothing is thrown; the scrub happens regardless
   * of what the row write did, because a retiring session's exact values have
   * nowhere left to go either way.
   */
  async function retireSession(sessionKey) {
    let row = null;
    try { row = questions.getOpenForSession(sessionKey); }
    catch (e) { logger.error?.(`[${botName}] question retire lookup failed: ${e.message}`); }
    // Drop the session's exact values first. Cancelling afterwards may install
    // an ownership tombstone if the row write fails, and that tombstone is the
    // only thing still blocking callbacks — a discard after it would delete it.
    discardSession(sessionKey);
    if (row) {
      const ids = (() => {
        try { return JSON.parse(row.message_ids_json || '[]'); } catch { return []; }
      })();
      try { await cancelWithoutLiveAnswer(row, ids[0]); }
      catch (e) { logger.error?.(`[${botName}] question retire failed for ${row.tool_call_id}: ${e.message}`); }
    }
  }

  /** Drop every live entry belonging to a session that is going away. */
  function discardSession(sessionKey) {
    for (const [toolCallId, ctx] of liveContexts) {
      if (ctx.sessionKey === sessionKey) liveContexts.delete(toolCallId);
    }
  }

  /** Drop everything; the process is stopping. */
  function discardAll() { liveContexts.clear(); }

  // Diagnostic seams: how much is being held right now. Counting is safe;
  // reading is not, so no accessor exposes a value.
  const liveAnswerCount = () => {
    let total = 0;
    for (const ctx of liveContexts.values()) total += ctx.answers.size;
    return total;
  };
  const liveContextCount = () => liveContexts.size;

  /**
   * The one path from state to the row. Every durable write goes through it so
   * the masking invariant cannot be forgotten at a new call site: sanitized
   * questions (the store enforces those too) and a marker for every answer the
   * context is holding.
   */
  function writeState(row, state, awaitingOther = false) {
    return questions.updateState(row.id, forDurableWrite(state, contextFor(row.tool_call_id)), awaitingOther);
  }

  /**
   * A durable write that cannot be completed ends the question rather than
   * throwing out of a Telegram callback: the exact values are already live,
   * and a caller that fails here must not leave them held with the row
   * half-advanced. Returns false once the question has been cancelled.
   */
  async function writeStateOrCancel(row, state, awaitingOther, msgId, { claimHeld = false } = {}) {
    try {
      writeState(row, state, awaitingOther);
      return true;
    } catch (e) {
      logger.error?.(`[${botName}] question state write failed for ${row.tool_call_id}: ${e.message}`);
      // Sealing locally would leave the agent's `ask` blocked on an answer that
      // is never coming. One cancellation goes out under terminal ownership —
      // it carries no state, only the fact that the question ended.
      if (claimHeld || claimTerminal(row)) {
        try { answerQuestion?.(row.session_key, row.tool_call_id, { cancelled: true }); }
        catch (err) { logger.error?.(`[${botName}] question cancel write-back failed for ${row.tool_call_id}: ${err.message}`); }
      }
      await cancelWithoutLiveAnswer(row, msgId);
      return false;
    }
  }

  /**
   * The state the state machine and the renderer see: the durable row with its
   * exact questions and exact held answers put back. Without a context (after a
   * restart, or once a session was retired) the durable copy is all there is,
   * which is deliberate — the exact text went with the process.
   */
  function hydrate(row, ctx) {
    const state = JSON.parse(row.state_json);
    if (!ctx) return state;
    return {
      ...state,
      questions: ctx.questions || state.questions,
      answers: (state.answers || []).map((answer, index) => (
        Q.isOmitted(answer) && ctx.answers.has(index) ? ctx.answers.get(index) : answer
      )),
    };
  }

  /**
   * The state the row may hold: sanitized questions (the store enforces this
   * too) and a marker in place of every answer being held live.
   */
  function forDurableWrite(state, ctx) {
    if (!ctx) return state;
    return {
      ...state,
      answers: (state.answers || []).map((answer, index) => (
        ctx.answers.has(index) ? Q.markOmitted(answer) : answer
      )),
    };
  }

  function strip(chatId, msgId, threadId, text) {
    if (msgId == null) return Promise.resolve();
    return tg(bot, 'editMessageText', {
      chat_id: chatId, message_id: msgId, text,
      ...(threadId && { message_thread_id: threadId }),
    }, { source: 'question-edit', botName })
      .catch((e) => logger.error?.(`[${botName}] question strip failed: ${e.message}`));
  }

  async function sendCurrent(row, state) {
    const view = Q.renderCurrent(state, `q:${row.id}:${row.callback_token}`);
    if (!view) return null;
    // PLAIN-TEXT (no parse_mode): option labels/descriptions are agent-authored.
    const sent = await tg(bot, 'sendMessage', {
      chat_id: row.chat_id, text: view.text, reply_markup: view.reply_markup,
      ...(row.thread_id && { message_thread_id: row.thread_id }),
    }, { source: 'question', botName }).catch((e) => {
      logger.error?.(`[${botName}] question send failed: ${e.message}`);
      return null;
    });
    return sent?.message_id ?? null;
  }

  /**
   * Hand the result to the agent, then mark the row terminal.
   *
   * Returns 'delivered' when the agent has the answer, 'settled' when another
   * caller already owned this row, and 'failed' when the answer did not get
   * through. Every failure scrubs: the context holds the exact question array
   * as well as any held answer, and neither may survive a question that can no
   * longer complete. A failure therefore cancels the row rather than leaving
   * it pending for a retry it could only serve from sanitized text.
   */
  function finalize(row, result, status = 'answered', { claimHeld = false } = {}) {
    // `claimHeld` is for a caller that already took the claim before its own
    // Telegram awaits; claiming twice would make it lose to itself.
    if (!claimHeld && !claimTerminal(row)) return 'settled';   // another caller is delivering
    // The row's own status is the lasting record of "already delivered": the
    // claim covers the in-flight window, and this covers a caller that started
    // before the winner resolved the row. Re-read it rather than trusting the
    // snapshot this caller has been holding across its awaits. The read is I/O
    // like any other: failing it after an answer was accepted would leave the
    // exact value held with the row still pending, so it fails the same way a
    // failed write-back does.
    let current;
    try {
      current = questions.getById(row.id);
    } catch (e) {
      logger.error?.(`[${botName}] question row read failed for ${row.tool_call_id}: ${e.message}`);
      return failWithoutDelivery(row);
    }
    if (current && current.status !== 'pending') {
      // Someone else settled this row and owns its cleanup. Only an empty
      // entry — one this claim just created — is ours to drop.
      if ((contextFor(row.tool_call_id)?.answers.size ?? 0) === 0) closeContext(row.tool_call_id);
      return 'settled';
    }
    let delivered;
    try {
      delivered = answerQuestion?.(row.session_key, row.tool_call_id, result);
    } catch (e) {
      logger.error?.(`[${botName}] answerQuestion failed for ${row.tool_call_id}: ${e.message}`);
      // Reported here, once, for every caller that can reach a write-back.
      logEvent('question-answer-writeback-failed', {
        session_key: row.session_key, tool_call_id: row.tool_call_id,
      });
      return failWithoutDelivery(row);
    }
    // A *false* return is a confirmed local non-delivery — the session is gone
    // or there is no live bridge. It is not success, and the row must not be
    // marked answered on the strength of a write that did not happen.
    if (delivered === false) {
      logger.error?.(`[${botName}] answerQuestion undelivered (session gone / no bridge) for ${row.tool_call_id}`);
      logEvent('question-answer-undelivered', { session_key: row.session_key, tool_call_id: row.tool_call_id });
      return failWithoutDelivery(row);
    }
    // Delivered. If the bookkeeping now fails, the exact values still go —
    // only the ownership tombstone stays, so the still-pending row cannot be
    // answered a second time.
    try {
      questions.resolve(row.id, status);
    } catch (e) {
      logger.error?.(`[${botName}] question resolve failed for ${row.tool_call_id}: ${e.message}`);
      scrubContext(row.tool_call_id, { keepOwnership: true });
      logEvent('question-resolve-failed', {
        session_key: row.session_key, tool_call_id: row.tool_call_id,
      });
      return 'delivered';
    }
    closeContext(row.tool_call_id);
    return 'delivered';
  }

  /** Nothing reached the agent: forget the exact values and close the row. */
  function failWithoutDelivery(row) {
    scrubContext(row.tool_call_id);
    try { questions.resolve(row.id, 'cancelled'); }
    catch (e) { logger.error?.(`[${botName}] question cancel failed for ${row.tool_call_id}: ${e.message}`); }
    return 'failed';
  }

  /**
   * The terminal claim. JavaScript runs this to completion, so the check and the
   * set cannot interleave: concurrent taps, a tap racing a typed answer, and a
   * duplicate completion all resolve to exactly one provider write. A losing
   * caller returns without touching the live values the winner still needs.
   */
  function claimTerminal(row) {
    const toolCallId = row?.tool_call_id;
    if (toolCallId == null) return true;
    // An entry created here carries the session, or retiring that session
    // could never reach it again.
    const ctx = contextFor(toolCallId) || openContext(toolCallId, row.session_key, null);
    if (ctx.finalizing) return false;
    ctx.finalizing = true;
    return true;
  }

  const releaseTerminal = (toolCallId) => {
    const ctx = contextFor(toolCallId);
    if (ctx) ctx.finalizing = false;
  };

  // ── claude called ask → render the first question ──────────────────
  async function renderAsk({ sessionKey, chatId, threadId = null, turnId = null, toolCallId, questions: qs }) {
    let row = null;
    try {
      // Idempotency: a bridge retry of the same tool_call_id must not double-render.
      if (questions.getByToolCallId(toolCallId)) return null;

      if (!Array.isArray(qs) || qs.length === 0) {
        try { answerQuestion?.(sessionKey, toolCallId, { answers: [] }); } catch (e) {
          logger.error?.(`[${botName}] answerQuestion(empty) failed: ${e.message}`);
        }
        return null;
      }
      // One open question per session: cancel + unblock any prior open ask first.
      const prior = questions.getOpenForSession(sessionKey);
      if (prior) {
        finalize(prior, { cancelled: true }, 'cancelled');
        const pIds = JSON.parse(prior.message_ids_json || '[]');
        if (pIds[0]) strip(prior.chat_id, pIds[0], prior.thread_id, 'This question was replaced.');
      }
      const state = Q.initState(qs);
      // The exact array goes to the live context; the row gets the sanitized
      // copy the store writes. Everything the user sees is rendered from the
      // exact one.
      openContext(toolCallId, sessionKey, qs);
      row = questions.issue({
        bot_name: botName, session_key: sessionKey, chat_id: chatId, thread_id: threadId,
        turn_id: turnId, tool_call_id: toolCallId, questions: qs, state,
      });
      const msgId = await sendCurrent(row, state);
      if (msgId == null) {
        // Couldn't deliver the keyboard — don't strand claude on a pending row.
        finalize(row, { cancelled: true, error: 'failed to deliver the question' }, 'cancelled');
        logEvent('question-send-failed', { session_key: sessionKey, tool_call_id: toolCallId, phase: 'first' });
        return null;
      }
      questions.setMessageIds(row.id, [msgId]);
      logEvent('question-asked', { session_key: sessionKey, chat_id: chatId, tool_call_id: toolCallId, count: qs.length });
      return row;
    } catch (e) {
      logger.error?.(`[${botName}] renderAsk failed for ${toolCallId}: ${e.message}`);
      // Anti-hang: a throw BEFORE the row was issued (store error, etc.) leaves
      // claude blocked with no row for the sweep to recover → answer {cancelled}
      // now. If the row WAS issued (throw in a later step), it is pending and the
      // timeout sweep will recover it with {timedout}.
      if (!row) {
        // The context was opened before the row existed, so a store that threw
        // leaves an entry keyed by a tool call no terminal path can ever reach.
        closeContext(toolCallId);
        try { answerQuestion?.(sessionKey, toolCallId, { cancelled: true, error: 'failed to render question' }); } catch (e2) {
          logger.error?.(`[${botName}] renderAsk fallback answer failed for ${toolCallId}: ${e2.message}`);
        }
      }
      return null;
    }
  }

  // ── a `q:<id>:<token>:<action>` button tap ─────────────────────────
  async function handleQuestionCallback(callbackCtx) {
    const data = callbackCtx.callbackQuery?.data || '';
    const m = String(data).match(/^q:(\d+):([^:]+):(.+)$/);
    if (!m) return;
    const id = parseInt(m[1], 10);
    const token = m[2];
    const actionStr = m[3];

    const row = questions.getById(id);
    if (!row) { await ack(callbackCtx, 'This question expired.', true); return; }
    if (!tokensEqual(row.callback_token, token)) {
      logEvent('question-token-mismatch', { id, from_user: callbackCtx.from?.id });
      await ack(callbackCtx, 'Bad token.', true); return;
    }
    if (row.status !== 'pending') { await ack(callbackCtx, `Already ${row.status}.`, true); return; }

    // Respondent authorization: first tapper claims the question; others rejected.
    const auth = questions.claimOrCheck(id, callbackCtx.from?.id);
    if (!auth.ok) {
      logEvent('question-foreign-responder', { id, from_user: callbackCtx.from?.id, owner: row.from_id });
      await ack(callbackCtx, 'This question is for someone else.', true); return;
    }

    // Captured before any Telegram await, so every later step can tell whether
    // the interaction it belongs to is still the live one.
    const captured = contextFor(row.tool_call_id);
    const state = hydrate(row, captured);
    const res = Q.applyTap(state, Q.parseAction(actionStr));
    const msgId = (JSON.parse(row.message_ids_json || '[]'))[0];

    if (res.kind === 'reject') { await ack(callbackCtx, res.message, true); return; }

    if (res.kind === 'toggled') {
      if (!await writeStateOrCancel(row, res.state, false, msgId)) return;
      const view = Q.renderCurrent(res.state, `q:${id}:${token}`);
      await tg(bot, 'editMessageReplyMarkup', {
        chat_id: row.chat_id, message_id: msgId, reply_markup: view.reply_markup,
        ...(row.thread_id && { message_thread_id: row.thread_id }),
      }, { source: 'question-edit', botName })
        .catch((e) => logger.error?.(`[${botName}] toggle re-render failed (q ${id}): ${e.message}`));
      // The keyboard edit can land after a retirement's notice, which would
      // make a closed question tappable again.
      if (isStale(row, captured)) {
        await settleInterrupted(row, msgId);
        return;
      }
      await ack(callbackCtx);
      return;
    }

    if (res.kind === 'awaiting-other') {
      if (!await writeStateOrCancel(row, res.state, true, msgId)) return;
      await strip(row.chat_id, msgId, row.thread_id, 'Send your answer as a message.');
      // An invitation to type is the one thing a retired question must not be
      // left showing, and the ack behind it would read as success.
      if (isStale(row, captured)) {
        await settleInterrupted(row, msgId);
        return;
      }
      await ack(callbackCtx, 'Type your answer ↓');
      return;
    }

    // advanced — record + receipt, then next question or finish.
    await advance(callbackCtx, row, res, false, captured);
  }

  // ── a typed message while a question is open (Other / nudge) ────────
  async function tryConsumeAsAnswer({ sessionKey, fromId, text }) {
    // Once the text has been accepted as this question's answer it stays
    // consumed. Letting a later failure report "not an answer" would send the
    // same text on as an ordinary turn — the one place it must never go.
    let acceptedAsAnswer = false;
    try {
      const row = questions.getOpenForSession(sessionKey);
      if (!row) return { consumed: false };
      // Only an in-progress free-text capture diverts typed messages. A question
      // awaiting a BUTTON tap does not swallow ordinary chatter (review: do not eat
      // every group member's message for the whole question lifetime).
      if (!row.awaiting_other) return { consumed: false };
      // /stop, /new and other commands are never consumed as a free-text answer.
      if (/^\/(stop|new|reset|clear|cancel|abort|reload)\b/i.test(String(text || '').trim())) return { consumed: false };
      // Identity: only the claimed owner supplies the free-text answer.
      const auth = questions.claimOrCheck(row.id, fromId);
      if (!auth.ok) {
        tg(bot, 'sendMessage', { chat_id: row.chat_id, text: 'Please answer the open question above first.',
          ...(row.thread_id && { message_thread_id: row.thread_id }) }, { source: 'question-nudge', botName })
          .catch((e) => logger.error?.(`[${botName}] question nudge failed: ${e.message}`));
        return { consumed: true };
      }
      const captured = contextFor(row.tool_call_id);
      const state = hydrate(row, captured);
      const res = Q.applyFreeText(state, text);
      if (res.kind !== 'advanced') return { consumed: false };
      acceptedAsAnswer = true;
      await advance({ from: { id: fromId } }, row, res, true, captured);
      return { consumed: true };
    } catch (e) {
      // Never throw out of the message dispatcher: a store/parse error BEFORE
      // the text was accepted degrades to "not an answer" so the message still
      // reaches normal dispatch. After acceptance it stays consumed.
      logger.error?.(`[${botName}] tryConsumeAsAnswer failed: ${e.message}`);
      return { consumed: acceptedAsAnswer };
    }
  }

  // Does `fromId` own an open free-text ("Other") capture for this session? The
  // dispatcher uses this to let the owner's typed answer bypass a group's mention
  // gate — only the claimed owner, never a bystander.
  function isAwaitingOtherFrom(sessionKey, fromId) {
    if (fromId == null) return false;
    try {
      const row = questions.getOpenForSession(sessionKey);
      return !!(row && row.awaiting_other && row.from_id != null && Number(row.from_id) === Number(fromId));
    } catch { return false; }
  }

  /**
   * Boot: a row whose state carries a marker was left behind by a process that
   * no longer exists, and the exact answer went with it. It is cancelled — not
   * replayed, because a socket write was never proof the provider consumed
   * anything, and not answered with the marker, which carries no answer at all.
   *
   * Only marked rows are touched. An ordinary leftover row is a separate
   * problem with its own fix.
   */
  async function reconcileMarkedQuestionsAtBoot(rows) {
    let reconciled = 0;
    for (const row of rows || []) {
      let marked = false;
      try {
        marked = (JSON.parse(row.state_json)?.answers || []).some(Q.isOmitted);
      } catch { marked = false; }
      if (!marked) continue;
      const ids = JSON.parse(row.message_ids_json || '[]');
      // Propagates: a marked row left pending must fail the boot fence rather
      // than be counted as reconciled.
      // eslint-disable-next-line no-await-in-loop
      await cancelWithoutLiveAnswer(row, ids[0], { propagate: true });
      reconciled += 1;
    }
    if (reconciled) logEvent('questions-reconciled-at-boot', { count: reconciled });
    return reconciled;
  }

  // ── timeout sweep / external cancel ────────────────────────────────
  async function expireQuestion(row, { status = 'timeout', message = 'This question timed out.' } = {}) {
    // Ownership first, and before any await: the sweep works from a snapshot
    // and can reach a row that has just been answered. A loser that edits the
    // card would replace a real answer's receipt with "timed out" and report
    // an expiry that never happened.
    if (!claimTerminal(row)) return;
    let fresh = null;
    try {
      fresh = questions.getById(row.id);
    } catch (e) {
      // Ownership is unproven, and unproven is not owned: proceeding would
      // overwrite whatever the real owner left on the card. Release the claim
      // so the next sweep can evaluate the row properly.
      logger.error?.(`[${botName}] question expiry read failed for ${row.tool_call_id}: ${e.message}`);
      releaseTerminal(row.tool_call_id);
      return;
    }
    if (fresh && fresh.status !== 'pending') {
      if ((contextFor(row.tool_call_id)?.answers.size ?? 0) === 0) closeContext(row.tool_call_id);
      return;
    }

    const ids = JSON.parse(row.message_ids_json || '[]');
    if (ids[0]) await strip(row.chat_id, ids[0], row.thread_id, message);
    const result = status === 'cancelled' ? { cancelled: true } : { timedout: true };
    // finalize owns the cleanup for the disposition it actually performed;
    // closing here as well would let a sweep that lost the claim, or arrived
    // after another path settled the row, clear state it never owned.
    // Only the caller that actually carried out the disposition reports it:
    // a row another path had already settled, or one whose write-back failed,
    // did not expire here.
    const outcome = finalize(row, result, status, { claimHeld: true });
    if (outcome !== 'delivered') return;
    logEvent('question-expired', { session_key: row.session_key, tool_call_id: row.tool_call_id, status });
  }

  function beginShutdownDisposition(row, {
    message = 'Bot is restarting — this question was cancelled.',
  } = {}) {
    const ids = JSON.parse(row.message_ids_json || '[]');
    const editing = ids[0]
      ? strip(row.chat_id, ids[0], row.thread_id, message)
      : Promise.resolve();
    questions.resolve(row.id, 'cancelled');
    closeContext(row.tool_call_id);
    logEvent('question-expired', {
      session_key: row.session_key,
      tool_call_id: row.tool_call_id,
      status: 'cancelled',
    });
    return editing;
  }

  /**
   * Record an advanced result, post a receipt, then move to the next question
   * or finish.
   *
   * `captured` is the live context this interaction started from, taken before
   * any Telegram await. Everything after an await re-checks it: a reset, a
   * retirement or a competing terminal path can dispose or replace the context
   * while this call is suspended, and such a caller must change nothing —
   * no persistence, no delivery, no receipt. The terminal claim is likewise
   * taken before the receipt, so two taps on different final options produce
   * one answer and one receipt rather than two of each.
   */
  async function advance(callbackCtx, row, res, fromText, captured) {
    const msgId = (JSON.parse(row.message_ids_json || '[]'))[0];
    if (isStale(row, captured)) return;

    // Hold before anything is written or shown: the marker that goes to the row
    // depends on it. A flagged answer with nowhere live to go cannot be stored
    // and cannot be delivered, so the question ends with the notice.
    if (!holdIfFlagged(captured, res.state)) {
      await cancelWithoutLiveAnswer(row, msgId);
      return;
    }
    const claimHeld = res.done ? claimTerminal(row) : false;
    if (res.done && !claimHeld) return;            // a competing final answer won

    if (!await writeStateOrCancel(row, res.state, false, msgId, { claimHeld })) return;

    // Visible receipt on the question card — for BOTH a button tap and a typed "Other"
    // answer. The typed-answer path used to skip this entirely, so a free-text answer (esp.
    // the LAST question) left the card frozen on "Send your answer as a message." with no
    // acknowledgment — "I answered and nothing happened" (prod: hire topic 2026-06-09).
    await strip(row.chat_id, msgId, row.thread_id, `✓ ${res.receipt}`);
    if (!fromText) await ack(callbackCtx, 'Recorded');   // callback-query ack — button taps only

    // The awaits above can span a reset, a reload or a retirement. Checked once
    // here, before the branch, because both continuations are wrong for a dead
    // interaction: the final one must not deliver, and the next question must
    // not be sent into a session that no longer exists.
    if (isStale(row, captured)) {
      await settleInterrupted(row, msgId);
      return;
    }

    if (res.done) {
      // Resolve the payload from the live values. A marker still standing here
      // means the exact answer went with a retired session or a dead process:
      // cancel and say so rather than send a placeholder upstream.
      const resolved = Q.resolveForDelivery(res.state);
      if (!resolved.ok) {
        await cancelWithoutLiveAnswer(row, msgId);
        return;
      }
      // Answer the agent FIRST, THEN mark answered. A failed write-back reports
      // itself from finalize, the one place every caller reaches; the card is
      // corrected here so a success receipt never stands over a failure.
      const outcome = finalize(row, resolved.result, 'answered', { claimHeld });
      if (outcome === 'failed') {
        await strip(row.chat_id, msgId, row.thread_id, QUESTION_INTERRUPTED_NOTICE);
        return;
      }
      if (outcome === 'settled') return;
      logEvent('question-answered', { session_key: row.session_key, tool_call_id: row.tool_call_id });
      return;
    }
    // next question → new message; on send failure, don't strand the agent.
    const nextMsgId = await sendCurrent(row, res.state);
    if (nextMsgId == null) {
      finalize(row, { cancelled: true, error: 'failed to deliver the next question' }, 'cancelled');
      logEvent('question-send-failed', { session_key: row.session_key, tool_call_id: row.tool_call_id, phase: 'next', q_index: res.state.qIndex });
      return;
    }
    // The send can outlive the interaction. The row must not adopt a card for
    // a question it will never ask, and the card that was just posted is the
    // one now needing the notice.
    if (isStale(row, captured)) {
      await settleInterrupted(row, nextMsgId);
      return;
    }
    questions.setMessageIds(row.id, [nextMsgId]);
  }

  /**
   * The interaction this call belonged to is gone, and it may have shown or
   * created something on the way out. Settle whatever it left behind against
   * the row as it stands now:
   *
   *   still pending  — this call closes it, with the notice on `msgId`.
   *   cancelled      — already closed; correct `msgId`, which may be a card
   *                    this call itself just posted or overwrote.
   *   answered/timed out — a legitimate winner owns that card. Leave it.
   *
   * `msgId` is deliberately a parameter: the card needing correction is not
   * always the row's own — a next-question send that landed after the
   * retirement created a new one.
   */
  async function settleInterrupted(row, msgId) {
    let fresh;
    try {
      fresh = questions.getById(row.id);
    } catch (e) {
      // A failed read is not a missing row. Without a status there is nothing
      // to correct TO, and guessing could overwrite a real answer's card, so
      // this caller does nothing at all.
      logger.error?.(`[${botName}] stale row read failed for ${row.tool_call_id}: ${e.message}`);
      return;
    }
    if (fresh && fresh.status === 'pending') {
      await cancelWithoutLiveAnswer(row, msgId);
      return;
    }
    // Already terminal: correct only the card, never the row, and say only
    // what the durable status supports — the receipt this call overwrote is
    // not reconstructable and must not be invented.
    await strip(row.chat_id, msgId, row.thread_id, terminalNoticeFor(fresh?.status));
  }

  function terminalNoticeFor(status) {
    if (status === 'answered') return QUESTION_ANSWERED_NOTICE;
    if (status === 'timeout' || status === 'expired') return QUESTION_TIMED_OUT_NOTICE;
    return QUESTION_INTERRUPTED_NOTICE;   // cancelled, or a row that is gone
  }

  /**
   * True when the live context this interaction started from is no longer the
   * one in place — disposed, or replaced by a newer ask on the same tool call.
   */
  function isStale(row, captured) {
    if (captured == null) return false;   // the interaction never had one
    return contextFor(row.tool_call_id) !== captured;
  }

  /**
   * The exact answer is gone and nothing may be sent in its place. The wording
   * has to hold whether or not an earlier answer reached the provider, because
   * a socket write is not proof the provider consumed it.
   */
  function cancelWithoutLiveAnswer(row, msgId, { propagate = false } = {}) {
    // The card edit is started but NOT awaited yet: yielding here would leave a
    // window where the row still reads pending with no context, which is
    // exactly the state an older callback needs to claim ownership and deliver.
    // Everything that closes the question happens synchronously first.
    const editing = strip(row.chat_id, msgId, row.thread_id, QUESTION_INTERRUPTED_NOTICE);
    let failure = null;
    try {
      questions.resolve(row.id, 'cancelled');
      scrubContext(row.tool_call_id);
    } catch (e) {
      failure = e;
      logger.error?.(`[${botName}] question cancel failed for ${row.tool_call_id}: ${e.message}`);
      // The row is still pending, so the block has to come from memory: a
      // content-free tombstone keeps the claim taken and holds nothing.
      scrubContext(row.tool_call_id, { keepOwnership: true });
    }
    logEvent('question-live-answer-missing', {
      session_key: row.session_key, tool_call_id: row.tool_call_id,
    });
    return editing.then(() => {
      // A Telegram callback must never throw — the dispatcher would treat the
      // user's own text as an ordinary turn. Boot is the opposite: a row it
      // could not cancel has to stop startup, so that caller asks to know.
      if (failure && propagate) throw failure;
    });
  }

  function ack(ctx, text, alert = false) {
    if (!ctx || typeof ctx.answerCallbackQuery !== 'function') return Promise.resolve();
    return ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined).catch(() => {});
  }

  return {
    renderAsk,
    handleQuestionCallback,
    tryConsumeAsAnswer,
    expireQuestion,
    beginShutdownDisposition,
    isAwaitingOtherFrom,
    reconcileMarkedQuestionsAtBoot,
    retireSession,
    discardSession,
    discardAll,
    liveAnswerCount,
    liveContextCount,
  };
}

module.exports = { createQuestionHandlers };
