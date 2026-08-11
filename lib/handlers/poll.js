/**
 * Manual long-poll loop for Telegram updates + a watchdog for
 * stalled poll loops.
 *
 * Why manual instead of grammy's built-in `bot.start()`: we need
 * to (a) restore the polling offset from the DB on boot so a
 * restart doesn't re-process the backlog Telegram accumulated
 * during downtime, (b) persist the offset after each batch so a
 * crash mid-batch only risks re-processing the unacked updates,
 * (c) drive a stall watchdog that logs to events when the loop
 * hasn't ticked in 2 minutes (network flap / Telegram 5xx).
 *
 * Long-poll discipline: Telegram holds the connection up to 25s
 * waiting for updates. When something arrives it returns
 * immediately; empty windows cost ~0 local CPU. Median inbound
 * latency drops vs short-poll-every-1s.
 *
 * Allowed update types: message, edited_message, callback_query.
 * Polygram doesn't process channel posts, polls, etc. — gating
 * here trims server load + simplifies the dispatch.
 */

'use strict';

const POLL_STALL_MS = 120_000;

function createPollLoop({
  db,
  dbWrite,
  config,
  botName,
  isWellFormedMessage,
  getTopicName,
  logger = console,
} = {}) {
  let running = true;
  let pollStarted = false;
  let pollSettled = false;
  let lastAdmittedUpdateId = null;
  let resolvePollQuiescence;
  let rejectPollQuiescence;
  const pollQuiescence = new Promise((resolve, reject) => {
    resolvePollQuiescence = resolve;
    rejectPollQuiescence = reject;
  });
  pollQuiescence.catch(() => {});

  const settlePollSuccess = () => {
    if (pollSettled) return;
    pollSettled = true;
    resolvePollQuiescence({ lastAdmittedUpdateId });
  };
  const settlePollFailure = (error) => {
    if (pollSettled) return;
    pollSettled = true;
    rejectPollQuiescence(error);
  };
  const stopPolling = () => {
    running = false;
    if (!pollStarted) settlePollSuccess();
    return pollQuiescence;
  };
  const awaitPollSettlement = ({ timeoutMs } = {}) => {
    if (timeoutMs == null) return pollQuiescence;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`polling ingress did not settle within ${timeoutMs}ms`);
        error.code = 'POLL_SETTLEMENT_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([pollQuiescence, timeout])
      .finally(() => clearTimeout(timer));
  };

  async function pollBot(bot) {
    if (!running) return;
    pollStarted = true;
    bot._stop = stopPolling;
    try {
      await bot.init();
      if (!running) {
        settlePollSuccess();
        return;
      }
      bot._setBotUsername(bot.botInfo.username);
      logger.log?.(`[${botName}] Bot @${bot.botInfo.username} ready`);

      await bot.api.deleteWebhook();
      if (!running) {
        settlePollSuccess();
        return;
      }

      // Restore polling offset from DB so a restart doesn't re-process
      // the backlog Telegram accumulated while we were down.
      let offset = 0;
      try {
        const saved = db?.getPollingOffset?.(botName);
        if (saved && saved > 0) {
          offset = saved + 1;
          logger.log?.(`[${botName}] resuming polling from update_id ${saved}`);
        }
      } catch (err) {
        logger.error?.(`[${botName}] getPollingOffset failed: ${err.message}`);
      }
      bot._lastPollTs = Date.now();

      while (running) {
        try {
          const updates = await bot.api.getUpdates({
            offset,
            timeout: 25,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          });
          bot._lastPollTs = Date.now();
          if (!running) break;

          let batchLastAdmittedId = null;
          for (const update of updates) {
            if (!running) break;
            offset = update.update_id + 1;
            batchLastAdmittedId = update.update_id;
            lastAdmittedUpdateId = update.update_id;
            if (update.message && isWellFormedMessage(update.message)) {
              const m = update.message;
              const chatId = m.chat.id.toString();
              const chatConfig = config.chats[chatId];
              const threadId = m.message_thread_id?.toString();
              const topicName = threadId
                ? (chatConfig ? getTopicName(chatConfig, threadId) : threadId)
                : null;
              const chatLabel = chatConfig?.name || chatId;
              const label = topicName ? `${chatLabel}/${topicName}` : chatLabel;
              logger.log?.(`[${botName}] ← ${label}: ${(m.text || m.caption || '(media)').slice(0, 60)}`);
            }
            try {
              await bot.handleUpdate(update);
            } catch (err) {
              logger.error?.(`[${botName}] Handler error: ${err.message}`);
            }
          }
          // Persist offset after batch dispatch — only on non-empty
          // batches to avoid churning the row on every 25s idle poll.
          if (batchLastAdmittedId != null) {
            dbWrite(() => db.savePollingOffset(botName, batchLastAdmittedId),
              'save polling offset');
          }
          // No sleep on the success path: long-poll already blocks
          // up to 25s when idle.
        } catch (err) {
          if (!running) break;
          if (err.error_code === 409) {
            logger.log?.(`[${botName}] 409, waiting 3s...`);
            await new Promise((r) => setTimeout(r, 3000));
          } else {
            logger.error?.(`[${botName}] Poll error: ${err.message}`);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }

      if (lastAdmittedUpdateId != null) {
        try {
          await db.savePollingOffset(botName, lastAdmittedUpdateId);
        } catch (error) {
          const persistenceError = new Error(
            `failed to persist the shutdown polling offset: ${error.message}`,
            { cause: error },
          );
          persistenceError.code = 'POLL_OFFSET_PERSISTENCE_FAILED';
          throw persistenceError;
        }
      }
      settlePollSuccess();
    } catch (error) {
      settlePollFailure(error);
      throw error;
    }
  }

  /**
   * Watchdog: if the poll loop hasn't ticked in POLL_STALL_MS, log
   * an event so external monitoring (or `events` queries) can see
   * it. We don't exit here — launchd restarts the process on
   * death, but a stalled poll is usually transient.
   */
  function startPollWatchdog(bot, { logEvent } = {}) {
    let stalled = false;
    return setInterval(() => {
      const now = Date.now();
      const age = now - (bot._lastPollTs || 0);
      if (age > POLL_STALL_MS) {
        if (!stalled) {
          logger.error?.(`[${botName}] poll-stalled: no tick in ${Math.round(age / 1000)}s`);
          if (logEvent) logEvent('poll-stalled', { bot: botName, stall_ms: age });
          stalled = true;
        }
      } else if (stalled) {
        logger.log?.(`[${botName}] poll-recovered after stall`);
        if (logEvent) logEvent('poll-recovered', { bot: botName });
        stalled = false;
      }
    }, 30_000);
  }

  return {
    pollBot,
    startPollWatchdog,
    stopPolling,
    awaitPollSettlement,
  };
}

module.exports = {
  createPollLoop,
  POLL_STALL_MS,
};
