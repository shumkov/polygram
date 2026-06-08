/**
 * Interactive-question handlers (0.12 ask feature) — the integration glue between
 * the pure state machine (lib/questions/questions.js), the store
 * (lib/questions/store.js), Telegram, and the bridge answer write-back.
 *
 *   renderAsk            — claude called `ask`: issue a row, send the keyboard.
 *   handleQuestionCallback — a `q:` button tap: validate, mutate, advance/resolve.
 *   tryConsumeAsAnswer   — dispatcher hook: a typed message while a question is
 *                          open (free-text "Other", or a nudge for the wrong user).
 *
 * Security (per review): per-row 128-bit token in callback_data + claim-on-first-
 * tap respondent authorization + plain-text body (no parse_mode) for agent content.
 * Anti-wedge: every terminal path answers claude (answered/cancelled) so the tool
 * call never hangs.
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
    return tg(bot, 'editMessageText', {
      chat_id: chatId, message_id: msgId, text,
      ...(threadId && { message_thread_id: threadId }),
    }, { source: 'question-edit', botName }).catch(() => {});
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

  // ── claude called ask → render the first question ──────────────────
  async function renderAsk({ sessionKey, chatId, threadId = null, turnId = null, toolCallId, questions: qs }) {
    if (!Array.isArray(qs) || qs.length === 0) {
      // Nothing to ask — answer immediately so the tool doesn't hang.
      answerQuestion?.(sessionKey, toolCallId, { answers: [] });
      return null;
    }
    // One open question per session: cancel + unblock any prior open ask first.
    const prior = questions.getOpenForSession(sessionKey);
    if (prior) {
      questions.resolve(prior.id, 'cancelled');
      answerQuestion?.(sessionKey, prior.tool_call_id, { cancelled: true });
    }
    const state = Q.initState(qs);
    const row = questions.issue({
      bot_name: botName, session_key: sessionKey, chat_id: chatId, thread_id: threadId,
      turn_id: turnId, tool_call_id: toolCallId, questions: qs, state,
    });
    const msgId = await sendCurrent(row, state);
    questions.setMessageIds(row.id, msgId != null ? [msgId] : []);
    logEvent('question-asked', { session_key: sessionKey, chat_id: chatId, tool_call_id: toolCallId, count: qs.length });
    return row;
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
    if (!row) { await ctx.answerCallbackQuery({ text: 'This question expired.', show_alert: true }).catch(() => {}); return; }
    if (!tokensEqual(row.callback_token, token)) {
      logEvent('question-token-mismatch', { id, from_user: ctx.from?.id });
      await ctx.answerCallbackQuery({ text: 'Bad token.', show_alert: true }).catch(() => {}); return;
    }
    if (row.status !== 'pending') { await ctx.answerCallbackQuery({ text: `Already ${row.status}.`, show_alert: true }).catch(() => {}); return; }

    // Respondent authorization: first tapper claims the question; others rejected.
    const auth = questions.claimOrCheck(id, ctx.from?.id);
    if (!auth.ok) {
      logEvent('question-foreign-responder', { id, from_user: ctx.from?.id, owner: row.from_id });
      await ctx.answerCallbackQuery({ text: 'This question is for someone else.', show_alert: true }).catch(() => {}); return;
    }

    const state = JSON.parse(row.state_json);
    const res = Q.applyTap(state, Q.parseAction(actionStr));
    const msgId = (JSON.parse(row.message_ids_json || '[]'))[0];

    if (res.kind === 'reject') { await ctx.answerCallbackQuery({ text: res.message, show_alert: true }).catch(() => {}); return; }

    if (res.kind === 'toggled') {
      questions.updateState(id, res.state, false);
      const view = Q.renderCurrent(res.state, `q:${id}:${token}`);
      await tg(bot, 'editMessageReplyMarkup', {
        chat_id: row.chat_id, message_id: msgId, reply_markup: view.reply_markup,
        ...(row.thread_id && { message_thread_id: row.thread_id }),
      }, { source: 'question-edit', botName }).catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    if (res.kind === 'awaiting-other') {
      questions.updateState(id, res.state, true);
      await strip(row.chat_id, msgId, row.thread_id, 'Send your answer as a message.');
      await ctx.answerCallbackQuery({ text: 'Type your answer ↓' }).catch(() => {});
      return;
    }

    // advanced — record + receipt, then next question or finish.
    await advance(ctx, row, res);
  }

  // ── a typed message while a question is open (Other / nudge) ────────
  async function tryConsumeAsAnswer({ sessionKey, fromId, text }) {
    const row = questions.getOpenForSession(sessionKey);
    if (!row) return { consumed: false };
    // Wrong user → nudge, leave the question open.
    if (row.from_id != null && Number(row.from_id) !== Number(fromId)) {
      tg(bot, 'sendMessage', { chat_id: row.chat_id, text: 'Please answer the open question above first.',
        ...(row.thread_id && { message_thread_id: row.thread_id }) }, { source: 'question-nudge', botName }).catch(() => {});
      return { consumed: true };
    }
    if (!row.awaiting_other) return { consumed: false };   // a question is open but not in free-text mode — let normal flow nudge
    // claim if not yet (the typer becomes the owner)
    questions.claimOrCheck(row.id, fromId);
    const state = JSON.parse(row.state_json);
    const res = Q.applyFreeText(state, text);
    if (res.kind !== 'advanced') return { consumed: false };
    await advance({ from: { id: fromId } }, row, res, /* fromText */ true);
    return { consumed: true };
  }

  // shared: record an advanced result, post a receipt, then next-Q or resolve.
  async function advance(ctx, row, res, fromText = false) {
    const msgIds = JSON.parse(row.message_ids_json || '[]');
    const msgId = msgIds[0];
    // receipt on the question message (strip the keyboard)
    if (msgId && !fromText) await strip(row.chat_id, msgId, row.thread_id, `✓ ${res.receipt}`);
    if (!fromText) await ctx.answerCallbackQuery?.({ text: 'Recorded' }).catch(() => {});

    if (res.done) {
      questions.updateState(row.id, res.state, false);
      questions.resolve(row.id, 'answered');
      answerQuestion?.(row.session_key, row.tool_call_id, Q.assemble(res.state));
      logEvent('question-answered', { session_key: row.session_key, tool_call_id: row.tool_call_id });
      return;
    }
    // next question → new message
    const nextMsgId = await sendCurrent(row, res.state);
    questions.updateState(row.id, res.state, false);
    questions.setMessageIds(row.id, nextMsgId != null ? [nextMsgId] : []);
  }

  return { renderAsk, handleQuestionCallback, tryConsumeAsAnswer };
}

module.exports = { createQuestionHandlers };
