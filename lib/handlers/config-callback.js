/**
 * Inline-keyboard callback handler for the /model and /effort cards.
 *
 * When a user taps a button on the config card, this routes:
 *   1. validate the new value;
 *   2. mutate chatConfig in-place + persist via db.logConfigChange;
 *   3. apply the change live to the running SDK Query via
 *      pm.applyFlagSettings (effort) or pm.setModel (model);
 *   4. re-render the card with the new ✓ marker;
 *   5. acknowledge the button press with a context-aware toast.
 *
 * SDK pm applies the change live — no kill, no respawn. Pre-cleanup
 * the CLI pm path used requestRespawn (drain queue + kill subprocess)
 * for /model + /effort; that's gone with the CLI pm.
 */

'use strict';

const { toTelegramHtml } = require('../telegram/format');

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

function createHandleConfigCallback({
  config,
  db,
  dbWrite,
  pm,
  getSessionKey,
  formatConfigInfoText,
  buildConfigKeyboard,
  botName,
  logger = console,
} = {}) {
  if (!config) throw new TypeError('config required');
  if (!db) throw new TypeError('db required');
  if (typeof dbWrite !== 'function') throw new TypeError('dbWrite required');
  if (!pm) throw new TypeError('pm required');
  if (typeof getSessionKey !== 'function') throw new TypeError('getSessionKey required');
  if (typeof formatConfigInfoText !== 'function') throw new TypeError('formatConfigInfoText required');
  if (typeof buildConfigKeyboard !== 'function') throw new TypeError('buildConfigKeyboard required');
  if (!botName) throw new TypeError('botName required');

  return async function handleConfigCallback(ctx) {
    const data = ctx.callbackQuery?.data || '';
    const m = String(data).match(/^cfg:(model|effort):(\S+)$/);
    if (!m) return;
    const setting = m[1];
    const value = m[2];

    const chatId = String(ctx.callbackQuery.message?.chat?.id || '');
    const chatConfig = config.chats[chatId];
    if (!chatConfig) {
      await ctx.answerCallbackQuery({ text: 'Chat not configured', show_alert: true }).catch(() => {});
      return;
    }
    if (!config.bot?.allowConfigCommands) {
      await ctx.answerCallbackQuery({ text: 'Config commands disabled', show_alert: true }).catch(() => {});
      return;
    }

    const validValues = setting === 'model' ? MODEL_OPTIONS : EFFORT_OPTIONS;
    if (!validValues.includes(value)) {
      await ctx.answerCallbackQuery({ text: `Invalid ${setting}` }).catch(() => {});
      return;
    }

    const oldValue = chatConfig[setting];
    if (oldValue === value) {
      await ctx.answerCallbackQuery({ text: `Already ${value}` }).catch(() => {});
      return;
    }

    chatConfig[setting] = value;
    const cmdUserId = ctx.callbackQuery.from?.id || null;
    const cmdUser = ctx.callbackQuery.from?.first_name || ctx.callbackQuery.from?.username || null;
    dbWrite(() => db.logConfigChange({
      chat_id: chatId, thread_id: null, field: setting,
      old_value: oldValue, new_value: value,
      user: cmdUser, user_id: cmdUserId, source: 'inline-button',
    }), `log ${setting} change`);

    // Graceful application to the topic's session. SDK pm applies live
    // via setModel / applyFlagSettings; chatConfig is already updated
    // on disk above so a missing live session still picks up the new
    // value on its next cold spawn.
    const callbackThreadId = ctx.callbackQuery.message?.message_thread_id?.toString() || null;
    const callbackSessionKey = getSessionKey(chatId, callbackThreadId, chatConfig);
    let applied = false;
    if (setting === 'effort') {
      applied = await pm.applyFlagSettings(callbackSessionKey, { effortLevel: value });
    } else if (setting === 'model') {
      applied = await pm.setModel(callbackSessionKey, value);
    }
    const anyActive = !applied;

    // Re-render the card with the new ✓ marker. Detect original card
    // type (model-only / effort-only / both) by counting rows in the
    // existing reply_markup so the user sees the same layout they
    // tapped into.
    const existingRows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.length || 0;
    const showRow = existingRows >= 2 ? 'all' : setting;
    const newInfo = formatConfigInfoText(chatConfig, showRow, chatId);
    const newKeyboard = buildConfigKeyboard(chatConfig, showRow);
    try {
      const { text: html, parseMode } = toTelegramHtml(newInfo);
      await ctx.editMessageText(html, {
        reply_markup: newKeyboard,
        ...(parseMode && { parse_mode: parseMode }),
      });
    } catch (err) {
      logger.error?.(`[${botName}] config-card edit failed: ${err.message}`);
    }

    const ackText = anyActive
      ? `${setting} → ${value} — switching when finished`
      : `${setting} → ${value}`;
    await ctx.answerCallbackQuery({ text: ackText }).catch(() => {});
  };
}

module.exports = {
  createHandleConfigCallback,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
};
