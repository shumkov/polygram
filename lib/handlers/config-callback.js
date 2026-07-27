/**
 * Inline-keyboard callback handler for the /model and /effort cards.
 *
 * When a user taps a button on the config card, this routes:
 *   1. validate the new value;
 *   2. mutate chatConfig in-place + persist via db.logConfigChange;
 *   3. apply the change live to Claude via its legacy methods, or select one
 *      complete Codex pair for the next turn via pm.selectModelSettings;
 *   4. re-render the card with the new ✓ marker;
 *   5. acknowledge the button press with a context-aware toast.
 *
 * SDK pm applies the change live — no kill, no respawn. Pre-cleanup
 * the CLI pm path used requestRespawn (drain queue + kill subprocess)
 * for /model + /effort; that's gone with the CLI pm.
 */

'use strict';

const { toTelegramHtml } = require('../telegram/format');
const { resolveRichTextEnabled } = require('../telegram/rich');
const { getTopicConfig, getConfigWriteScope } = require('../session-key');
const {
  configuredRuntimeValue,
  formatCodexSettingsOutcome,
  getCodexCatalogEfforts,
  getCodexCatalogModels,
  isCodexRuntimeView,
  resolveCodexEffortForModel,
  withCodexSettingsOutcome,
} = require('./config-ui');

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
  resolveRuntimeView = null,
  intentLock,
  saveConfig = () => {},
  botName,
  logger = console,
} = {}) {

  return async function handleConfigCallback(ctx) {
    const data = ctx.callbackQuery?.data || '';
    const m = String(data).match(/^cfg:(model|effort|richtext):(\S+)$/);
    if (!m) return;
    const setting = m[1];
    const value = m[2];
    // richText is stored as a boolean so inherited configuration can
    // distinguish an explicit false value from an unset value.
    const isRichText = setting === 'richtext';
    const parsedValue = isRichText ? value === 'on' : value;

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

    const callbackThreadIdEarly = ctx.callbackQuery.message?.message_thread_id?.toString() || null;
    const callbackSessionKey = getSessionKey(
      chatId,
      callbackThreadIdEarly,
      chatConfig,
    );
    const releaseIntent = await intentLock.acquire(callbackSessionKey);
    let intentHeld = true;
    const releaseConfigIntent = () => {
      if (!intentHeld) return;
      intentHeld = false;
      releaseIntent();
    };
    let runtimeView = null;
    try {
      if (typeof resolveRuntimeView === 'function') {
        try {
          runtimeView = await resolveRuntimeView({
            sessionKey: callbackSessionKey,
            chatId,
            threadId: callbackThreadIdEarly,
          });
        } catch (error) {
          logger.error?.(
            `[${botName}] config-callback runtime view failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: 'Configuration is temporarily unavailable',
            show_alert: true,
          }).catch(() => {});
          return;
        }
      }
      const codex = isCodexRuntimeView(runtimeView);
      let currentModel = null;

      if (isRichText) {
        if (value !== 'on' && value !== 'off') {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({ text: 'Invalid richtext value' })
            .catch(() => {});
          return;
        }
      } else {
        const topicConfig = getTopicConfig(chatConfig, callbackThreadIdEarly);
        currentModel = configuredRuntimeValue(
          chatConfig,
          topicConfig,
          runtimeView,
          'model',
        );
        const validValues = codex
          ? setting === 'model'
            ? getCodexCatalogModels(runtimeView).map((entry) => entry.model)
            : getCodexCatalogEfforts(runtimeView, currentModel)
          : setting === 'model' ? MODEL_OPTIONS : EFFORT_OPTIONS;
        if (!validValues.includes(value)) {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({ text: `Invalid ${setting}` })
            .catch(() => {});
          return;
        }
      }

      // Write to the scope the card belongs to: a topic card targets THAT topic
      // (so Music ≠ General), a chat-level card the chat root. Resolving the
      // thread BEFORE the already-set check so "Already X" compares against the
      // topic's effective value, not the chat root (2026-06-12 bug).
      const { scope: writeScope, threadId: writeThreadId } =
        getConfigWriteScope(chatConfig, callbackThreadIdEarly, {
          allowNonIsolatedTopic: setting === 'richtext',
        });
      // The persisted camel-case key differs from the lowercase callback
      // label used alongside model and effort.
      const configField = isRichText
        ? 'richText'
        : codex
          ? setting === 'model' ? 'codexModel' : 'codexEffort'
          : setting;
      const oldValue = isRichText
        ? resolveRichTextEnabled(config, chatId, callbackThreadIdEarly)
        : (
          writeScope[configField] != null
            ? writeScope[configField]
            : chatConfig[configField] != null
              ? chatConfig[configField]
              : codex ? runtimeView[setting] : chatConfig[configField]
        );
      const snapshots = new Map([
        [configField, {
          present: Object.hasOwn(writeScope, configField),
          value: writeScope[configField],
        }],
      ]);
      if (codex && setting === 'model') {
        snapshots.set('codexEffort', {
          present: Object.hasOwn(writeScope, 'codexEffort'),
          value: writeScope.codexEffort,
        });
      }
      let effortAdjustment = null;
      let selectedEffort = setting === 'effort' ? value : null;
      if (codex && setting === 'model') {
        const oldEffort = writeScope.codexEffort != null
          ? writeScope.codexEffort
          : chatConfig.codexEffort != null
            ? chatConfig.codexEffort
            : runtimeView.effort;
        const nextEffort = resolveCodexEffortForModel(
          runtimeView,
          value,
          oldEffort,
        );
        if (nextEffort == null) {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: 'Selected model has no authenticated default effort',
            show_alert: true,
          }).catch(() => {});
          return;
        }
        selectedEffort = nextEffort;
        if (nextEffort !== oldEffort) {
          effortAdjustment = { oldValue: oldEffort, newValue: nextEffort };
        }
      }
      if (oldValue === parsedValue) {
        releaseConfigIntent();
        await ctx.answerCallbackQuery({ text: `Already ${value}` })
          .catch(() => {});
        return;
      }

      writeScope[configField] = parsedValue;
      if (effortAdjustment) {
        writeScope.codexEffort = effortAdjustment.newValue;
      }
      try {
        await saveConfig();
      } catch (error) {
        for (const [field, snapshot] of snapshots) {
          if (snapshot.present) writeScope[field] = snapshot.value;
          else delete writeScope[field];
        }
        logger.error?.(
          `[${botName}] config-callback saveConfig failed: ${error.message}`,
        );
        releaseConfigIntent();
        await ctx.answerCallbackQuery({
          text: `Couldn't save ${setting}; nothing changed`,
          show_alert: true,
        }).catch(() => {});
        return;
      }
      const cmdUserId = ctx.callbackQuery.from?.id || null;
      const cmdUser = ctx.callbackQuery.from?.first_name
        || ctx.callbackQuery.from?.username
        || null;
      const auditRows = [{
          chat_id: chatId, thread_id: writeThreadId,
          // The audit schema intentionally keeps provider-neutral field names.
          field: isRichText ? configField : setting,
          old_value: oldValue, new_value: parsedValue,
          user: cmdUser, user_id: cmdUserId, source: 'inline-button',
        }];
      if (effortAdjustment) {
        auditRows.push({
            chat_id: chatId,
            thread_id: writeThreadId,
            field: 'effort',
            old_value: effortAdjustment.oldValue,
            new_value: effortAdjustment.newValue,
            user: cmdUser,
            user_id: cmdUserId,
            source: 'inline-button',
        });
      }
      if (codex && !isRichText) {
        try {
          db.logConfigChanges(auditRows);
        } catch (error) {
          for (const [field, snapshot] of snapshots) {
            if (snapshot.present) writeScope[field] = snapshot.value;
            else delete writeScope[field];
          }
          let rollbackFailed = false;
          try {
            await saveConfig();
          } catch (rollbackError) {
            rollbackFailed = true;
            logger.error?.(
              `[${botName}] config-callback rollback failed: `
                + rollbackError.message,
            );
          }
          logger.error?.(
            `[${botName}] config-callback audit failed: ${error.message}`,
          );
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: rollbackFailed
              ? `Couldn't audit ${setting}; live process unchanged, `
                + 'persisted config needs attention'
              : `Couldn't audit ${setting}; nothing changed`,
            show_alert: true,
          }).catch(() => {});
          return;
        }
      } else {
        dbWrite(() => {
          for (const row of auditRows) db.logConfigChange(row);
        }, `log ${configField} change`);
      }

      // Graceful application to the topic's session. Claude keeps its
      // existing live SDK calls. Codex receives one complete pair; expected
      // lifecycle states are reported by a discriminated outcome.
      const callbackThreadId = callbackThreadIdEarly;
      let applied = false;
      let settingsResult = null;
      if (codex && !isRichText) {
        const selectedModel = setting === 'model' ? value : currentModel;
        try {
          settingsResult = await pm.selectModelSettings(callbackSessionKey, {
            model: selectedModel,
            effort: selectedEffort,
          });
        } catch (error) {
          logger.error?.(
            `[${botName}] config-callback Codex selection failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          settingsResult = {
            outcome: 'live-status-unknown',
            nextTurn: {
              model: selectedModel,
              effort: selectedEffort,
            },
          };
        }
        runtimeView = withCodexSettingsOutcome(runtimeView, settingsResult);
      } else if (!codex && setting === 'effort') {
        applied = await pm.applyFlagSettings(
          callbackSessionKey,
          { effortLevel: value },
        );
      } else if (!codex && setting === 'model') {
        applied = await pm.setModel(callbackSessionKey, value);
      }
      const anyActive = !applied;
      releaseConfigIntent();

      // Re-render the card with the new ✓ marker. Detect original card
      // type (model-only / effort-only / both) by counting rows in the
      // existing reply_markup so the user sees the same layout they
      // tapped into.
      const existingRows =
        ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.length || 0;
      const showRow = existingRows >= 2 ? 'all' : setting;
      const _cbTopicCfg = getTopicConfig(chatConfig, callbackThreadId);
      const effectiveRichText = resolveRichTextEnabled(
        config,
        chatId,
        callbackThreadId,
      );
      const newInfo = await formatConfigInfoText(
        chatConfig,
        showRow,
        codex ? callbackSessionKey : chatId,
        _cbTopicCfg,
        effectiveRichText,
        runtimeView,
      );
      const newKeyboard = buildConfigKeyboard(
        chatConfig,
        showRow,
        _cbTopicCfg,
        effectiveRichText,
        runtimeView,
      );
      try {
        const { text: html, parseMode } = toTelegramHtml(newInfo);
        await ctx.editMessageText(html, {
          reply_markup: newKeyboard,
          ...(parseMode && { parse_mode: parseMode }),
        });
      } catch (err) {
        logger.error?.(`[${botName}] config-card edit failed: ${err.message}`);
      }

      // Rich delivery changes immediately, but its authoring hint changes
      // on the next session spawn; surface both timings in the acknowledgement.
      const ackText = isRichText
        ? (
          parsedValue
            ? 'Rich text → on (delivery live; agent authors for it next session)'
            : 'Rich text → off'
        )
        : codex
          ? (
            `${setting} → ${value}`
            + (
              effortAdjustment
                ? `; effort → ${effortAdjustment.newValue}`
                : ''
            )
            + formatCodexSettingsOutcome(settingsResult)
          )
          : (
            anyActive
              ? `${setting} → ${value} — switching when finished`
              : `${setting} → ${value}`
          );
      await ctx.answerCallbackQuery({ text: ackText }).catch(() => {});
    } finally {
      releaseConfigIntent();
    }
  };
}

module.exports = {
  createHandleConfigCallback,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
};
