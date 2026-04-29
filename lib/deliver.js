/**
 * Chunked reply delivery primitive.
 *
 * `deliverReplies` is the polygram analog of OpenClaw's `deliverReplies` —
 * a small loop over already-chunked text that sends each chunk as its own
 * Telegram message via the `send()` wrapper from lib/telegram.js (which
 * does write-before-send, HTML→plain fallback, and MESSAGE_NOT_MODIFIED
 * swallowing).
 *
 * Polygram's old code path inlined a `for (chunk of chunkText(rest))` loop
 * inside polygram.js with an ad-hoc `tg()` call. That worked, but mixed
 * delivery concerns into the streaming-finalize logic, and made testing
 * the multi-message path painful. With this primitive, the new
 * "preview-becomes-final" flow in handleMessage (Phase 5) just calls:
 *
 *   await deliverReplies({ bot, chatId, threadId, chunks, replyToMessageId, ... })
 *
 * — and gets back `{ sent, failed }` arrays of message_ids per chunk.
 *
 * Behavior:
 *   - Sends `chunks[0]` first with `reply_parameters` (so the answer
 *     visually anchors to the user's question). Subsequent chunks omit
 *     `reply_parameters` — chaining replies would clutter the chat.
 *   - On chunk failure, logs and continues to the next chunk. We'd
 *     rather deliver partial content than abort the whole reply.
 *   - Empty input returns `{ sent: [], failed: [] }` immediately.
 */

async function deliverReplies({
  bot,
  send, // (bot, method, params, meta) → res — usually createSender(db, logger)(...) or tg
  chatId,
  threadId = null,
  chunks,
  replyToMessageId = null,
  meta = {},
  logger = console,
}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { sent: [], failed: [], results: [] };
  }
  // 0.7.1: results[] preserves correspondence with chunks[] — results[i]
  // describes what happened to chunks[i]. sent[]/failed[] are projections
  // for back-compat with callers that already use them; they no longer
  // ambiguously mean "the i-th success/failure" vs "chunk i's outcome".
  const results = [];
  const sent = [];
  const failed = [];
  for (let i = 0; i < chunks.length; i++) {
    const params = {
      chat_id: chatId,
      text: chunks[i],
    };
    if (threadId != null) params.message_thread_id = threadId;
    if (i === 0 && replyToMessageId != null) {
      // allow_sending_without_reply: long turns give the user time to
      // delete their original message; without this flag Telegram
      // rejects with MESSAGE_NOT_FOUND and the whole reply is lost.
      params.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
    }
    try {
      const res = await send(bot, 'sendMessage', params, meta);
      const msgId = res?.message_id ?? null;
      results.push({ index: i, status: 'ok', messageId: msgId });
      sent.push(msgId);
    } catch (err) {
      logger.error?.(`[deliver] chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
      results.push({ index: i, status: 'fail', error: err.message });
      failed.push({ index: i, error: err.message });
      // Keep going — partial delivery is better than total loss. Caller
      // should inspect failed.length and surface a warning to the user
      // (see polygram.js handleMessage's stream-redeliver event log).
    }
  }
  return { sent, failed, results };
}

module.exports = { deliverReplies };
