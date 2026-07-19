'use strict';

/**
 * Drop-redeliverer (0.13 D2 → D4 glue, docs/0.13-channels-lifecycle-design.md §3 D2).
 *
 * Consumes CliProcess's 'input-dropped' event — a ledgered input that was
 * confirmed dropped (never seen at pickup, never acknowledged via
 * consumed_turn_ids, not superseded, with the ack contract observed in the
 * cycle) — and redelivers it ONCE through the unified D4 tail.
 *
 * Eligibility (design's redelivery constraints):
 *   - `primary` and `autosteer` sources only: both reconstruct from the
 *     inbound DB row (recordInbound persisted the raw message), so the
 *     redelivered turn re-formats through the NORMAL prompt path — no stored
 *     prompt text, no double-formatting, events stay content-free (L13).
 *   - `edit-fold` / `system` / `inject` park as telemetry
 *     (input-dropped-no-redeliver): an edit correction has its own
 *     re-delivery path, and system pushes are never auto-re-executed.
 *
 * The D4 tail then enforces: once-only, _isReplay, the D5 gate at tier
 * 'redelivery' (an abort/admin-shaped drop is never auto-re-executed), the
 * visible 👀 ack, and dispatch. Supersession was already decided ledger-side.
 */

function createDropRedeliverer({ db, redeliver, logEvent = () => {}, logger = console } = {}) {
  if (typeof redeliver !== 'function') throw new TypeError('drop-redeliver: redeliver required');

  return async function onInputDropped(sessionKey, payload = {}) {
    try {
      const { chatId, msgId, source, turnId } = payload;
      if (source !== 'primary' && source !== 'autosteer') {
        logEvent('input-dropped-no-redeliver', {
          chat_id: chatId ?? null, msg_id: msgId ?? null, source: source ?? null,
          turn_id: turnId ?? null, reason: 'source-not-redeliverable',
        });
        return;
      }
      if (msgId == null) {
        logEvent('input-dropped-no-redeliver', {
          chat_id: chatId ?? null, source, turn_id: turnId ?? null, reason: 'no-msg-id',
        });
        return;
      }
      const row = db.getMessage(String(chatId), Number(msgId));
      if (!row) {
        logEvent('input-dropped-no-redeliver', {
          chat_id: chatId, msg_id: msgId, source, turn_id: turnId ?? null, reason: 'no-db-row',
        });
        return;
      }
      // Reconstruct the boot-replay way: enough of a grammy Message for the
      // normal prompt/attachment path to re-run from the persisted row.
      const reconstructed = {
        chat: { id: Number(chatId), type: String(chatId).startsWith('-') ? 'supergroup' : 'private' },
        message_id: Number(msgId),
        from: { id: row.user_id, first_name: row.user },
        text: row.text || '',
        date: Math.floor((row.ts || Date.now()) / 1000),
        ...(row.thread_id && { message_thread_id: Number(row.thread_id) }),
        ...(row.reply_to_id && { reply_to_message: { message_id: row.reply_to_id } }),
      };
      // Persisted attachments ride _mergedAttachments (boot-replay parity):
      // the native photo/voice fields can't be restored from the DB, and
      // without this an attachment-only drop is blocked by the presence
      // gate while a text+media drop silently loses its attachments.
      const attRows = db.getAttachmentsByMessage?.(row.id) || [];
      if (attRows.length) {
        reconstructed._mergedAttachments = attRows.map((a) => ({
          kind: a.kind, name: a.name, mime_type: a.mime_type,
          size: a.size_bytes, file_id: a.file_id, file_unique_id: a.file_unique_id,
        }));
      }
      await redeliver({ chatId: String(chatId), msg: reconstructed, source: 'drop' });
    } catch (err) {
      logger.error?.(`[drop-redeliver] ${err?.message || err}`);
    }
  };
}

module.exports = { createDropRedeliverer };
