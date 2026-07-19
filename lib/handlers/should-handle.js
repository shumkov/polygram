/**
 * shouldHandle — the content-presence + chat-allowlist + mention/pairing
 * intake gate. Runs for every tier of the D5 unified gate (fresh, edit,
 * redelivery — see lib/handlers/gate-inbound.js).
 *
 * Extracted from polygram.js as a factory so the logic is unit-testable;
 * deps are getters because polygram wires config / pairings / BOT_NAME
 * at boot, after module load.
 */

'use strict';

function createShouldHandle({ getConfig, getPairings, getBotName } = {}) {
  return function shouldHandle(msg, chatConfig, botUsername) {
    const config = getConfig();
    // A replayed / drop-redelivered message is reconstructed from the DB and
    // carries its attachments ONLY in _mergedAttachments — the native
    // photo/document/voice fields can't be restored. Count them as content,
    // or every attachment-only turn (voice note, caption-less photo) becomes
    // unrecoverable after a crash: blocked here as "empty" before dispatch.
    const hasAttachment = !!(msg.document || msg.photo || msg.voice || msg.audio || msg.video)
      || (Array.isArray(msg._mergedAttachments) && msg._mergedAttachments.length > 0);
    if (!msg.text && !msg.caption && !hasAttachment) return false;
    const chatId = msg.chat.id.toString();
    if (!config.chats[chatId]) return false;

    if (chatConfig.requireMention && msg.chat.type !== 'private') {
      const text = msg.text || msg.caption || '';
      const isReplyToBot = msg.reply_to_message?.from?.username === botUsername;
      const hasMention = text.includes(`@${botUsername}`);
      // A reply targeting some other user (not the bot) is a strong signal
      // "this message is for that person, not me". Paired users normally
      // bypass requireMention, but not in this case — without the guard a
      // paired user saying "Gotcha!" to a teammate gets processed by the
      // bot just because the user is paired, which is what bit us in
      // UMI Group on 0.5.9 (bot leaked reasoning as a reply to "Gotcha!").
      const repliesToOtherUser = !!msg.reply_to_message
        && msg.reply_to_message.from?.username !== botUsername;
      // Paired users bypass requireMention — operator-trusted, no @ needed
      // every time. Skipped when they're replying to a non-bot user (above).
      const pairings = getPairings();
      const paired = !repliesToOtherUser && pairings && msg.from?.id
        ? pairings.hasLivePairing({ bot_name: getBotName(), user_id: msg.from.id, chat_id: chatId })
        : false;
      if (!isReplyToBot && !hasMention && !paired) return false;
    }

    return true;
  };
}

module.exports = { createShouldHandle };
