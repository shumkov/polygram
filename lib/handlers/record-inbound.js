/**
 * Record an inbound Telegram message + its attachments to SQLite.
 *
 * Atomic: message + N-attachment writes wrapped in
 * `db.raw.transaction` so a crash mid-write can't leave a message
 * row with zero (or partial) attachment rows that boot-replay
 * would silently treat as "no media."
 *
 * Edit-safe: Telegram fires recordInbound again for edited_message
 * events (same chat_id + msg_id). If attachments already exist,
 * we skip the attachment-insert pass — re-inserting would duplicate
 * rows AND reset download_status back to 'pending', losing the
 * local_path we already fetched.
 *
 * Best-effort: dbWrite swallows errors; recordInbound never
 * throws. Late-arriving inbounds during shutdown (after db.raw.close())
 * are explicitly short-circuited at the top.
 */

'use strict';

function createRecordInbound({
  db,
  dbWrite,
  config,
  botName,
  extractAttachments,
} = {}) {
  return function recordInbound(msg) {
    if (!db) return;
    const chatId = msg.chat.id.toString();
    const threadId = msg.message_thread_id?.toString() || null;
    const user = msg.from?.first_name || msg.from?.username || null;
    const attachments = extractAttachments(msg);
    const chatConfig = config.chats[chatId];
    const ts = (msg.date || Math.floor(Date.now() / 1000)) * 1000;

    // Atomic message + attachments write. db.raw.transaction
    // collapses N+1 fsyncs into one commit — perf win for media
    // groups (7-attachment album: 8 sync writes → 1).
    const writeInbound = db.raw.transaction(() => {
      db.insertMessage({
        chat_id: chatId,
        thread_id: threadId,
        msg_id: msg.message_id,
        user,
        user_id: msg.from?.id || null,
        text: msg.text || msg.caption || '',
        reply_to_id: msg.reply_to_message?.message_id || null,
        direction: 'in',
        source: 'polygram',
        bot_name: botName,
        model: chatConfig?.model || null,
        effort: chatConfig?.effort || null,
        ts,
      });

      if (!attachments.length) return;
      // Look up the just-inserted message row id so attachments
      // can FK to it. lastInsertRowid is unreliable across the
      // upsert path; explicit lookup is cheap and always correct.
      const messageId = db.getInboundMessageId({ chat_id: chatId, msg_id: msg.message_id });
      if (!messageId) return;
      // Edit-safety: skip if attachments already persisted.
      if (db.getAttachmentsByMessage(messageId).length > 0) return;
      for (const att of attachments) {
        db.insertAttachment({
          message_id: messageId,
          chat_id: chatId,
          msg_id: msg.message_id,
          thread_id: threadId,
          bot_name: botName,
          file_id: att.file_id,
          file_unique_id: att.file_unique_id,
          kind: att.kind,
          name: att.name,
          mime_type: att.mime_type,
          size_bytes: att.size,
          ts,
        });
      }
    });

    dbWrite(() => writeInbound(), `insert inbound ${chatId}/${msg.message_id}`);
  };
}

module.exports = { createRecordInbound };
