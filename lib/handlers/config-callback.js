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
const { getTopicConfig, getConfigWriteScope } = require('../session-key');

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
  saveConfig = () => {},
  botName,
  logger = console,
} = {}) {

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

    // Write to the scope the card belongs to: a topic card targets THAT topic
    // (so Music ≠ General), a chat-level card the chat root. Resolving the
    // thread BEFORE the already-set check so "Already X" compares against the
    // topic's effective value, not the chat root (2026-06-12 bug).
    const callbackThreadIdEarly = ctx.callbackQuery.message?.message_thread_id?.toString() || null;
    const { scope: writeScope, threadId: writeThreadId } =
      getConfigWriteScope(chatConfig, callbackThreadIdEarly);
    const oldValue = writeScope[setting] != null ? writeScope[setting] : chatConfig[setting];
    if (oldValue === value) {
      await ctx.answerCallbackQuery({ text: `Already ${value}` }).catch(() => {});
      return;
    }

    writeScope[setting] = value;
    // Persist to config.json so the change survives a restart — without this,
    // every /model tap was lost on the next deploy (2026-06-12). Best-effort:
    // never let a disk hiccup swallow the in-memory change + live application.
    try { saveConfig(); }
    catch (err) { logger.error?.(`[${botName}] config-callback saveConfig failed: ${err.message}`); }
    const cmdUserId = ctx.callbackQuery.from?.id || null;
    const cmdUser = ctx.callbackQuery.from?.first_name || ctx.callbackQuery.from?.username || null;
    dbWrite(() => db.logConfigChange({
      chat_id: chatId, thread_id: writeThreadId, field: setting,
      old_value: oldValue, new_value: value,
      user: cmdUser, user_id: cmdUserId, source: 'inline-button',
    }), `log ${setting} change`);

    // Graceful application to the topic's session. SDK pm applies live
    // via setModel / applyFlagSettings; chatConfig is already updated
    // on disk above so a missing live session still picks up the new
    // value on its next cold spawn.
    const callbackThreadId = callbackThreadIdEarly;
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
    // Re-render with per-topic overrides resolved (topic > chat), so the agent
    // line doesn't flip back to the chat-level default after a button tap —
    // mirrors the /model command card (polygram.js). getTopicConfig returns {}
    // for the chat-level card.
    const _cbTopicCfg = getTopicConfig(chatConfig, callbackThreadId);
    const newInfo = formatConfigInfoText(chatConfig, showRow, chatId, _cbTopicCfg);
    const newKeyboard = buildConfigKeyboard(chatConfig, showRow, _cbTopicCfg);
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
