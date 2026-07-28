/**
 * The per-chat override walk, in one place.
 *
 * Every boolean feature flag in polygram resolves the same way — topic, then
 * chat, then the active bot, then defaults, first explicit boolean wins — and
 * each one had grown its own copy of the walk. A copy that drifts (an `||`
 * where an `??` belongs, a missing tier) silently changes who has a feature on.
 */

'use strict';

const { getTopicConfig } = require('./session-key');

/**
 * @param {?object} config   — the runtime config (config.bot is already the active bot)
 * @param {string} key       — the flag's config key, e.g. 'richText'
 * @param {string|number} chatId
 * @param {?string|number} [threadId]
 * @returns {boolean} true only if some tier explicitly says true
 */
function resolveBoolOverride(config, key, chatId, threadId = null) {
  if (!config) return false;
  const chat = config.chats?.[String(chatId)] || null;
  const topicCfg = (chat && threadId != null) ? getTopicConfig(chat, String(threadId)) : null;
  const pick = (v) => (typeof v === 'boolean' ? v : undefined);
  const resolved = pick(topicCfg?.[key])
    ?? pick(chat?.[key])
    ?? pick(config.bot?.[key])
    ?? pick(config.defaults?.[key]);
  return resolved === true;
}

module.exports = { resolveBoolOverride };
