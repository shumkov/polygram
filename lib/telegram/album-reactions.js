/**
 * album-reactions — apply one status reaction to every message of a Telegram
 * album (the anchor + its siblings), so a multi-file send shows the same emoji
 * on each item instead of only the first.
 *
 * Background: Telegram delivers an album as N separate messages sharing a
 * media_group_id; polygram coalesces them into ONE turn anchored on the first.
 * The status reactor therefore only ever reacted to that anchor, leaving the
 * sibling files with no visible reaction (the rc.16 observation). This mirrors
 * the reactor's emoji onto the siblings.
 *
 * Semantics:
 *   - The ANCHOR (first id) is awaited so a failure surfaces to the reactor's
 *     own error handling (same as the single-message path).
 *   - SIBLINGS are best-effort: a failure on one must not drop the anchor's
 *     reaction or the other siblings (and must not throw — reactions are
 *     cosmetic). They also can't share the anchor's fate of being retried.
 *   - Calls are sequential to respect Telegram's setMessageReaction rate limit
 *     (~5/s/chat) — an album is ≤10 items so this stays well within budget.
 */

'use strict';

/**
 * @param {object}   opts
 * @param {Function} opts.tg        async (bot, method, params, meta) => any
 * @param {*}        opts.bot
 * @param {string}   opts.chatId
 * @param {number[]} opts.msgIds    [anchor, ...siblings] — anchor first
 * @param {string|null} opts.emoji  emoji to set, or null/'' to clear
 * @param {string}   [opts.botName]
 */
async function applyReactionToMessages({ tg, bot, chatId, msgIds, emoji, botName } = {}) {
  const reaction = emoji ? [{ type: 'emoji', emoji }] : [];
  const ids = Array.isArray(msgIds) ? msgIds : [];
  for (let i = 0; i < ids.length; i++) {
    const params = { chat_id: chatId, message_id: ids[i], reaction };
    const meta = {
      source: i === 0 ? 'status-reaction' : 'status-reaction-album-sibling',
      botName,
    };
    if (i === 0) {
      await tg(bot, 'setMessageReaction', params, meta);          // anchor: surface failure
    } else {
      await tg(bot, 'setMessageReaction', params, meta).catch(() => {});  // siblings: best-effort
    }
  }
}

module.exports = { applyReactionToMessages };
