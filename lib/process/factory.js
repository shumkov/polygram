/**
 * Process factory — chooses + constructs the right Process subclass
 * per session, based on chat / topic / bot config.
 *
 * Backends:
 *   - 'sdk'      → SdkProcess      (default; long-lived SDK Query, per-token API)
 *   - 'tmux'     → TmuxProcess     (claude TUI in tmux, subscription-priced)
 *   - 'channels' → ChannelsProcess (claude TUI in tmux + structured IO via Channels
 *                                   MCP protocol, subscription-priced; 0.11.0)
 *
 * Backend selection precedence:
 *   topicConfig.pm > chatConfig.pm > config.bot.pm > 'sdk'
 *
 * Per-backend wiring requirements:
 *   tmux     — tmuxRunner + botName
 *   channels — tmuxRunner + botName + toolDispatcher + claudeBin
 *
 * If a backend is configured but its wiring is missing, we log a loud
 * warning and fall back to SDK so the daemon stays up (R2-F7 — never
 * silent-fail config).
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 * @see docs/0.11.0-channels-driver-plan.md
 */

'use strict';

const { SdkProcess } = require('./sdk-process');
const { TmuxProcess } = require('./tmux-process');
const { ChannelsProcess } = require('./channels-process');

/**
 * @param {object} opts
 * @param {object} opts.config            — runtime config object
 * @param {Function} opts.spawnFn          — buildSdkOptions (SDK backend only)
 * @param {object} [opts.db]               — for SdkProcess._logEvent + clearSessionId
 * @param {object} [opts.logger]
 * @param {number} [opts.queueCap]
 * @param {number} [opts.queryCloseTimeoutMs]
 * @param {object} [opts.tmuxRunner]       — required when ANY chat routes to 'tmux' or 'channels'
 * @param {string} [opts.botName]          — required when ANY chat routes to 'tmux' or 'channels'
 * @param {object} [opts.pollScheduler]    — shared PollScheduler instance.
 *   When provided, all TmuxProcess instances share ONE setInterval for
 *   their polling loops (one timer regardless of how many in-flight
 *   tmux chats). Falls back to per-instance setTimeout when omitted.
 * @param {Function} [opts.toolDispatcher] — required when ANY chat routes to 'channels'.
 *   async ({sessionKey, chatId, threadId, toolName, text, files}) => {ok, error?}.
 *   Called when Claude's reply (or react/edit_message) tool fires inside a
 *   ChannelsProcess. Polygram supplies the actual Telegram-send wiring.
 * @param {string} [opts.channelsClaudeBin] — absolute path to pinned claude binary;
 *   required when ANY chat routes to 'channels'.
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
  toolDispatcher = null,
  channelsClaudeBin = null,
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

    if (choice === 'channels') {
      const missing = [];
      if (!tmuxRunner) missing.push('tmuxRunner');
      if (!botName) missing.push('botName');
      if (typeof toolDispatcher !== 'function') missing.push('toolDispatcher');
      if (!channelsClaudeBin) missing.push('channelsClaudeBin');
      if (missing.length) {
        logger.warn?.(
          `[${label}] config requests pm:'channels' but ${missing.join(', ')} not wired; ` +
          `falling back to SdkProcess. Pass these to createProcessFactory.`,
        );
      } else {
        return new ChannelsProcess({
          sessionKey, chatId, threadId, label,
          tmuxRunner,
          botName,
          claudeBin: channelsClaudeBin,
          toolDispatcher,
          logger,
          db,                  // Parity P1: telemetry parity with sdk/tmux
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
 *
 * Review AC3: unknown `pm` values (typos like `'channel'` singular) used to
 * silently fall through to 'sdk' with no warning — violates R2-F7 "never
 * silent-fail config". Now logs a warn and falls back to the default.
 */
const VALID_BACKENDS = new Set(['sdk', 'tmux', 'channels']);

function pickBackend({ config, chatId, threadId, logger = console } = {}) {
  if (!chatId) return 'sdk';
  const chatCfg = config?.chats?.[chatId];
  const topicCfg = threadId && chatCfg?.topics?.[threadId];
  const picked = topicCfg?.pm || chatCfg?.pm || config?.bot?.pm || 'sdk';
  if (!VALID_BACKENDS.has(picked)) {
    logger.warn?.(
      `[factory] unknown pm value '${picked}' for chat=${chatId} thread=${threadId ?? ''}; ` +
      `falling back to 'sdk'. Valid: ${[...VALID_BACKENDS].join(', ')}.`,
    );
    return 'sdk';
  }
  return picked;
}

module.exports = { createProcessFactory, pickBackend };
