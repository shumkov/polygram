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
   * Hand the result to claude FIRST (guarded), then mark the row terminal. On
   * write-back failure: leave the row pending (the timeout sweep recovers it) and
   * return false — NEVER resolved-but-hung. Returns true when claude was answered.
   */
  function finalize(row, result, status = 'answered') {
    let delivered;
    try {
      delivered = answerQuestion?.(row.session_key, row.tool_call_id, result);
    } catch (e) {
      logger.error?.(`[${botName}] answerQuestion failed for ${row.tool_call_id}: ${e.message}`);
      return false;   // threw → leave the row pending; the timeout sweep recovers it
    }
    // A *false* return is a silent no-op (session gone / no live bridge), NOT a
    // throw. Surface it loudly and still resolve: a dead session can never be
    // delivered, so leaving it pending would have the 30s sweep re-strip +
    // re-answer it forever. The rare live-proc-but-unwritable-bridge case is
    // backstopped by the bridge's own 20-min answer ceiling.
    if (delivered === false) {
      logger.error?.(`[${botName}] answerQuestion undelivered (session gone / no bridge) for ${row.tool_call_id}`);
      logEvent('question-answer-undelivered', { session_key: row.session_key, tool_call_id: row.tool_call_id });
    }
    questions.resolve(row.id, status);
    return true;
  }

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
        try { answerQuestion?.(sessionKey, toolCallId, { cancelled: true, error: 'failed to render question' }); } catch (e2) {
          logger.error?.(`[${botName}] renderAsk fallback answer failed for ${toolCallId}: ${e2.message}`);
        }
      }
      return null;
    }
  }

  // ── a `q:<id>:<token>:<action>` button tap ─────────────────────────
  async function handleQuestionCallback(ctx) {
    const data = ctx.callbackQuery?.data || '';
    const m = String(data).match(/^q:(\d+):([^:]+):(.+)$/);
    if (!m) return;
    const id = parseInt(m[1], 10);
    const token = m[2];
    const actionStr = m[3];

    const row = questions.getById(id);
    if (!row) { await ack(ctx, 'This question expired.', true); return; }
    if (!tokensEqual(row.callback_token, token)) {
      logEvent('question-token-mismatch', { id, from_user: ctx.from?.id });
      await ack(ctx, 'Bad token.', true); return;
    }
    if (row.status !== 'pending') { await ack(ctx, `Already ${row.status}.`, true); return; }

    // Respondent authorization: first tapper claims the question; others rejected.
    const auth = questions.claimOrCheck(id, ctx.from?.id);
    if (!auth.ok) {
      logEvent('question-foreign-responder', { id, from_user: ctx.from?.id, owner: row.from_id });
      await ack(ctx, 'This question is for someone else.', true); return;
    }

    const state = JSON.parse(row.state_json);
    const res = Q.applyTap(state, Q.parseAction(actionStr));
    const msgId = (JSON.parse(row.message_ids_json || '[]'))[0];

    if (res.kind === 'reject') { await ack(ctx, res.message, true); return; }

    if (res.kind === 'toggled') {
      questions.updateState(id, res.state, false);
      const view = Q.renderCurrent(res.state, `q:${id}:${token}`);
      await tg(bot, 'editMessageReplyMarkup', {
        chat_id: row.chat_id, message_id: msgId, reply_markup: view.reply_markup,
        ...(row.thread_id && { message_thread_id: row.thread_id }),
      }, { source: 'question-edit', botName })
        .catch((e) => logger.error?.(`[${botName}] toggle re-render failed (q ${id}): ${e.message}`));
      await ack(ctx);
      return;
    }

    if (res.kind === 'awaiting-other') {
      questions.updateState(id, res.state, true);
      await strip(row.chat_id, msgId, row.thread_id, 'Send your answer as a message.');
      await ack(ctx, 'Type your answer ↓');
      return;
    }

    // advanced — record + receipt, then next question or finish.
    await advance(ctx, row, res, false);
  }

  // ── a typed message while a question is open (Other / nudge) ────────
  async function tryConsumeAsAnswer({ sessionKey, fromId, text }) {
    try {
      const row = questions.getOpenForSession(sessionKey);
      if (!row) return { consumed: false };
      // Only an in-progress free-text capture diverts typed messages. A question
      // awaiting a BUTTON tap does not swallow ordinary chatter (review: do not eat
      // every group member's message for the whole question lifetime).
      if (!row.awaiting_other) return { consumed: false };
      // /stop, /new and other commands are never consumed as a free-text answer.
      if (/^\/(stop|new|reset|cancel|abort)\b/i.test(String(text || '').trim())) return { consumed: false };
      // Identity: only the claimed owner supplies the free-text answer.
      const auth = questions.claimOrCheck(row.id, fromId);
      if (!auth.ok) {
        tg(bot, 'sendMessage', { chat_id: row.chat_id, text: 'Please answer the open question above first.',
          ...(row.thread_id && { message_thread_id: row.thread_id }) }, { source: 'question-nudge', botName })
          .catch((e) => logger.error?.(`[${botName}] question nudge failed: ${e.message}`));
        return { consumed: true };
      }
      const state = JSON.parse(row.state_json);
      const res = Q.applyFreeText(state, text);
      if (res.kind !== 'advanced') return { consumed: false };
      await advance({ from: { id: fromId } }, row, res, true);
      return { consumed: true };
    } catch (e) {
      // Never throw out of the message dispatcher: a store/parse error here must
      // degrade to "not an answer" so the user's message still reaches normal
      // dispatch instead of being silently dropped.
      logger.error?.(`[${botName}] tryConsumeAsAnswer failed: ${e.message}`);
      return { consumed: false };
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

  // ── timeout sweep / external cancel ────────────────────────────────
  async function expireQuestion(row, { status = 'timeout', message = 'This question timed out.' } = {}) {
    const ids = JSON.parse(row.message_ids_json || '[]');
    if (ids[0]) await strip(row.chat_id, ids[0], row.thread_id, message);
    const result = status === 'cancelled' ? { cancelled: true } : { timedout: true };
    finalize(row, result, status);
    logEvent('question-expired', { session_key: row.session_key, tool_call_id: row.tool_call_id, status });
  }

  // shared: record an advanced result, post a receipt, then next-Q or resolve.
  async function advance(ctx, row, res, fromText) {
    const msgId = (JSON.parse(row.message_ids_json || '[]'))[0];
    if (!fromText) {
      await strip(row.chat_id, msgId, row.thread_id, `✓ ${res.receipt}`);
      await ack(ctx, 'Recorded');
    }

    if (res.done) {
      questions.updateState(row.id, res.state, false);
      // Answer claude FIRST (guarded), THEN mark answered. If the write-back
      // throws, leave the row pending → the timeout sweep recovers it.
      if (!finalize(row, Q.assemble(res.state), 'answered')) {
        logEvent('question-answer-writeback-failed', { session_key: row.session_key, tool_call_id: row.tool_call_id });
        return;
      }
      logEvent('question-answered', { session_key: row.session_key, tool_call_id: row.tool_call_id });
      return;
    }
    // next question → new message; on send failure, don't strand claude.
    const nextMsgId = await sendCurrent(row, res.state);
    if (nextMsgId == null) {
      finalize(row, { cancelled: true, error: 'failed to deliver the next question' }, 'cancelled');
      logEvent('question-send-failed', { session_key: row.session_key, tool_call_id: row.tool_call_id, phase: 'next', q_index: res.state.qIndex });
      return;
    }
    questions.updateState(row.id, res.state, false);
    questions.setMessageIds(row.id, [nextMsgId]);
  }

  function ack(ctx, text, alert = false) {
    if (!ctx || typeof ctx.answerCallbackQuery !== 'function') return Promise.resolve();
    return ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined).catch(() => {});
  }

  return { renderAsk, handleQuestionCallback, tryConsumeAsAnswer, expireQuestion, isAwaitingOtherFrom };
}

module.exports = { createQuestionHandlers };
