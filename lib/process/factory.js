/**
 * Process factory — chooses + constructs the right Process subclass
 * per session, based on chat / topic / bot config.
 *
 * Phase 1: SDK only.
 * Phase 2: tmux per chatConfig.pm === 'tmux'.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 */

'use strict';

const { SdkProcess } = require('./sdk-process');

/**
 * @param {object} opts
 * @param {object} opts.config        — runtime config object
 * @param {Function} opts.spawnFn      — buildSdkOptions
 * @param {object} [opts.db]           — for SdkProcess._logEvent + clearSessionId
 * @param {object} [opts.logger]
 * @param {number} [opts.queueCap]
 * @param {number} [opts.queryCloseTimeoutMs]
 * @returns {Function} processFactory(sessionKey, ctx) → Process
 */
function createProcessFactory({
  config,
  spawnFn,
  db = null,
  logger = console,
  queueCap,
  queryCloseTimeoutMs,
} = {}) {
  if (typeof spawnFn !== 'function') {
    throw new TypeError('createProcessFactory: spawnFn required');
  }

  return function processFactory(sessionKey, ctx) {
    const chatId = ctx?.chatId ?? null;
    const threadId = ctx?.threadId ?? null;
    const label = ctx?.label || sessionKey;

    const choice = pickBackend({ config, chatId, threadId });

    if (choice === 'tmux') {
      // Phase 2 hook. Not implemented in Phase 1.
      // For now fall back to SDK; once TmuxProcess ships, this branch
      // returns `new TmuxProcess({ sessionKey, chatId, threadId, label, runner, ... })`.
      logger.warn?.(`[${label}] config requests pm:'tmux' but TmuxProcess not shipped yet; falling back to SdkProcess`);
    }

    return new SdkProcess({
      sessionKey, chatId, threadId, label,
      spawnFn,
      db,
      logger,
      queueCap,
      queryCloseTimeoutMs,
    });
  };
}

/**
 * Per-chat / per-topic backend choice. Phase 1 always returns 'sdk'.
 * Phase 2 honors topicConfig.pm / chatConfig.pm / config.bot.pm.
 */
function pickBackend({ config, chatId, threadId }) {
  if (!chatId) return 'sdk';
  const chatCfg = config?.chats?.[chatId];
  const topicCfg = threadId && chatCfg?.topics?.[threadId];
  return topicCfg?.pm || chatCfg?.pm || config?.bot?.pm || 'sdk';
}

module.exports = { createProcessFactory, pickBackend };
