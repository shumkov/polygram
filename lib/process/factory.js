/**
 * Process factory — chooses + constructs the right Process subclass
 * per session, based on chat / topic / bot config.
 *
 * Backends:
 *   - 'sdk'  → SdkProcess  (default; long-lived SDK Query)
 *   - 'tmux' → TmuxProcess (claude TUI hosted in a tmux session)
 *
 * Backend selection precedence:
 *   topicConfig.pm > chatConfig.pm > config.bot.pm > 'sdk'
 *
 * The tmux backend requires a `tmuxRunner` + `botName` to be passed
 * into createProcessFactory. If a tmux-routed chat is encountered
 * without those wired, we log a loud warning and fall back to SDK so
 * the daemon stays up (R2-F7 — never silent-fail config).
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 */

'use strict';

const { SdkProcess } = require('./sdk-process');
const { TmuxProcess } = require('./tmux-process');

/**
 * @param {object} opts
 * @param {object} opts.config            — runtime config object
 * @param {Function} opts.spawnFn          — buildSdkOptions (SDK backend only)
 * @param {object} [opts.db]               — for SdkProcess._logEvent + clearSessionId
 * @param {object} [opts.logger]
 * @param {number} [opts.queueCap]
 * @param {number} [opts.queryCloseTimeoutMs]
 * @param {object} [opts.tmuxRunner]       — required when ANY chat routes to 'tmux'
 * @param {string} [opts.botName]          — required when ANY chat routes to 'tmux'
 * @param {object} [opts.pollScheduler]    — shared PollScheduler instance.
 *   When provided, all TmuxProcess instances share ONE setInterval for
 *   their polling loops (one timer regardless of how many in-flight
 *   tmux chats). Falls back to per-instance setTimeout when omitted.
 * @returns {Function} processFactory(sessionKey, ctx) → Process
 */
function createProcessFactory({
  config,
  spawnFn,
  db = null,
  logger = console,
  queueCap,
  queryCloseTimeoutMs,
  tmuxRunner = null,
  botName = null,
  pollScheduler = null,
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
      if (!tmuxRunner || !botName) {
        logger.warn?.(
          `[${label}] config requests pm:'tmux' but tmuxRunner/botName not wired; ` +
          `falling back to SdkProcess. Pass {tmuxRunner, botName} to createProcessFactory.`,
        );
      } else {
        return new TmuxProcess({
          sessionKey, chatId, threadId, label,
          runner: tmuxRunner,
          botName,
          logger,
          pollScheduler,
        });
      }
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
 * Per-chat / per-topic backend choice. Phase 1 always returned 'sdk'.
 * Phase 2 honors topicConfig.pm / chatConfig.pm / config.bot.pm.
 */
function pickBackend({ config, chatId, threadId }) {
  if (!chatId) return 'sdk';
  const chatCfg = config?.chats?.[chatId];
  const topicCfg = threadId && chatCfg?.topics?.[threadId];
  return topicCfg?.pm || chatCfg?.pm || config?.bot?.pm || 'sdk';
}

module.exports = { createProcessFactory, pickBackend };
