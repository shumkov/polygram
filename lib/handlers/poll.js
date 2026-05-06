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
  async function pollBot(bot) {
    await bot.init();
    bot._setBotUsername(bot.botInfo.username);
    logger.log?.(`[${botName}] Bot @${bot.botInfo.username} ready`);

    await bot.api.deleteWebhook();

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
    let running = true;
    bot._lastPollTs = Date.now();
    bot._stop = () => { running = false; };

    while (running) {
      try {
        const updates = await bot.api.getUpdates({
          offset,
          timeout: 25,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
        });
        bot._lastPollTs = Date.now();

        for (const update of updates) {
          offset = update.update_id + 1;
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
        if (updates.length > 0) {
          dbWrite(() => db.savePollingOffset(botName, updates[updates.length - 1].update_id),
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

  return { pollBot, startPollWatchdog };
}

module.exports = {
  createPollLoop,
  POLL_STALL_MS,
};
