/**
 * Inline-keyboard callback handler for the /config, /model, and /effort cards.
 *
 * When a user taps a button on the config card, this routes:
 *   1. validate the new value;
 *   2. mutate and persist the scoped chat configuration;
 *   3. apply a setting live or strictly replace an idle selected runtime;
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
const { resolveRuntimeDescriptor } = require('../runtime-config');
const {
  configuredRuntimeValue,
  formatCodexSettingsOutcome,
  getCodexCatalogEfforts,
  getCodexCatalogModels,
  isCodexRuntimeView,
  RUNTIME_OPTIONS,
  resolveCodexEffortForModel,
  withCodexSettingsOutcome,
} = require('./config-ui');

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RUNTIME_OPTION_BY_BACKEND = new Map(
  RUNTIME_OPTIONS.map((option) => [option.backend, option]),
);
const BLOCKED_RUNTIME_STATES = new Set([
  'RecoveryConflict',
  'ContainmentFailed',
  'FailedAmbiguous',
  'DurabilityBlocked',
  'StartingTurn',
  'Active',
  'Settling',
  'BackgroundWorking',
  'BackgroundSettling',
  'Quiescing',
]);

function runtimeLabel(runtime) {
  // Only ever called for a runtime that has a button — the callback rejects
  // anything else as an invalid runtime before this point.
  return RUNTIME_OPTION_BY_BACKEND.get(runtime).label;
}

function runtimeSwitchBlocked(proc) {
  if (!proc || proc.closed) return false;
  try {
    return Boolean(
      proc.inFlight
      || proc.hasActiveBackgroundWork?.()
      || proc.hasOpenQuestions?.()
      || proc.hasPendingDeliveryWork?.()
      || BLOCKED_RUNTIME_STATES.has(proc.state),
    );
  } catch {
    return true;
  }
}

function createHandleConfigCallback({
  config,
  db,
  dbWrite,
  pm,
  getSessionKey,
  formatConfigInfoText,
  buildConfigKeyboard,
  resolveRuntimeView = null,
  prepareRuntimeSelection = null,
  discardRuntimeSelection = null,
  buildSpawnContext = null,
  intentLock,
  saveConfig = () => {},
  botName,
  logger = console,
} = {}) {

  return async function handleConfigCallback(ctx) {
    const data = ctx.callbackQuery?.data || '';
    const m = String(data).match(
      /^cfg:(model|effort|richtext|runtime):(\S+)$/,
    );
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
    let candidatePrepared = false;
    let runtimeSwitchCompleted = false;
    try {
      if (setting === 'runtime') {
        if (!RUNTIME_OPTION_BY_BACKEND.has(value)) {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({ text: 'Invalid runtime' })
            .catch(() => {});
          return;
        }
        const currentSelection = resolveRuntimeDescriptor({
          config,
          chatId,
          threadId: callbackThreadIdEarly,
          defaultPm: 'sdk',
          logger,
        });
        if (currentSelection.backend === value) {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: `Already ${runtimeLabel(value)}`,
          }).catch(() => {});
          return;
        }

        const currentProcess = typeof pm.get === 'function'
          ? pm.get(callbackSessionKey)
          : null;
        if (runtimeSwitchBlocked(currentProcess)) {
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: 'Wait for the current turn to finish before switching runtime',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        let candidateView = null;
        if (value === 'codex') {
          if (
            typeof prepareRuntimeSelection !== 'function'
            || typeof discardRuntimeSelection !== 'function'
          ) {
            releaseConfigIntent();
            await ctx.answerCallbackQuery({
              text: 'Codex is unavailable: runtime preflight is not configured',
              show_alert: true,
            }).catch(() => {});
            return;
          }
          try {
            candidateView = await prepareRuntimeSelection({
              sessionKey: callbackSessionKey,
              chatId,
              threadId: callbackThreadIdEarly,
              runtime: 'codex',
            });
            candidatePrepared = true;
          } catch (error) {
            logger.error?.(
              `[${botName}] Codex runtime selection preflight failed: `
                + `${error?.code || error?.name || 'unknown'}`,
            );
            releaseConfigIntent();
            await ctx.answerCallbackQuery({
              text: 'Codex is unavailable; check login and runtime diagnostics',
              show_alert: true,
            }).catch(() => {});
            return;
          }
        }

        const topicId = callbackThreadIdEarly == null
          ? null
          : String(callbackThreadIdEarly);
        const originalTopicsPresent = Object.hasOwn(
          chatConfig,
          'topics',
        );
        const originalTopics = chatConfig.topics;
        const originalTopicPresent = Boolean(
          topicId
          && chatConfig.topics
          && Object.hasOwn(chatConfig.topics, topicId)
        );
        const originalTopic = originalTopicPresent
          ? chatConfig.topics[topicId]
          : undefined;
        const { scope: writeScope, threadId: writeThreadId } =
          getConfigWriteScope(chatConfig, callbackThreadIdEarly);
        const pmSnapshot = {
          present: Object.hasOwn(writeScope, 'pm'),
          value: writeScope.pm,
        };
        const restoreSelection = () => {
          if (
            writeThreadId
            && originalTopicsPresent
            && chatConfig.topics !== originalTopics
          ) {
            chatConfig.topics = originalTopics;
            return;
          }
          if (
            writeThreadId
            && (
              typeof originalTopic === 'string'
              || !originalTopicPresent
            )
          ) {
            if (originalTopicPresent) {
              chatConfig.topics[writeThreadId] = originalTopic;
            } else {
              delete chatConfig.topics[writeThreadId];
            }
            if (!originalTopicsPresent) delete chatConfig.topics;
            return;
          }
          if (pmSnapshot.present) writeScope.pm = pmSnapshot.value;
          else delete writeScope.pm;
        };

        writeScope.pm = value;
        try {
          await saveConfig();
        } catch (error) {
          restoreSelection();
          logger.error?.(
            `[${botName}] runtime selection save failed: ${error.message}`,
          );
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: 'Could not save runtime; nothing changed',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        const cmdUserId = ctx.callbackQuery.from?.id || null;
        const cmdUser = ctx.callbackQuery.from?.first_name
          || ctx.callbackQuery.from?.username
          || null;
        const auditRow = {
          chat_id: chatId,
          thread_id: writeThreadId,
          field: 'pm',
          old_value: currentSelection.configuredPm,
          new_value: value,
          user: cmdUser,
          user_id: cmdUserId,
          source: 'inline-button',
        };
        try {
          db.logConfigChange(auditRow);
        } catch (error) {
          restoreSelection();
          let rollbackFailed = false;
          try {
            await saveConfig();
          } catch (rollbackError) {
            rollbackFailed = true;
            logger.error?.(
              `[${botName}] runtime audit rollback failed: `
                + rollbackError.message,
            );
          }
          logger.error?.(
            `[${botName}] runtime selection audit failed: ${error.message}`,
          );
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: rollbackFailed
              ? 'Could not audit runtime; persisted config needs attention'
              : 'Could not audit runtime; nothing changed',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        let replacementError = null;
        try {
          if (typeof buildSpawnContext !== 'function') {
            const error = new Error('runtime spawn-context builder unavailable');
            error.code = 'RUNTIME_SWITCH_UNAVAILABLE';
            throw error;
          }
          const spawnContext = await buildSpawnContext(
            callbackSessionKey,
            { mutateSessionOnDrift: false },
          );
          await pm.replaceRuntime(callbackSessionKey, spawnContext);
        } catch (error) {
          replacementError = error;
        }
        if (replacementError) {
          restoreSelection();
          let rollbackFailed = false;
          let rollbackAuditFailed = false;
          try {
            await saveConfig();
          } catch (rollbackError) {
            rollbackFailed = true;
            logger.error?.(
              `[${botName}] runtime replacement rollback failed: `
                + rollbackError.message,
            );
          }
          if (!rollbackFailed) {
            try {
              db.logConfigChange({
                ...auditRow,
                old_value: value,
                new_value: currentSelection.configuredPm,
                source: 'runtime-switch-rollback',
              });
            } catch (auditError) {
              rollbackAuditFailed = true;
              logger.error?.(
                `[${botName}] runtime rollback audit failed: `
                  + auditError.message,
              );
            }
          }
          logger.error?.(
            `[${botName}] runtime replacement failed: `
              + `${replacementError.code || replacementError.name || 'unknown'}`,
          );
          releaseConfigIntent();
          await ctx.answerCallbackQuery({
            text: rollbackFailed
              ? 'Runtime switch failed; persisted config needs attention'
              : rollbackAuditFailed
                ? 'Previous runtime restored; audit history needs attention'
                : 'Previous runtime selection restored; session may reconnect '
                  + 'on the next message',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        if (
          value !== 'codex'
          && typeof discardRuntimeSelection === 'function'
        ) {
          try {
            discardRuntimeSelection(callbackSessionKey);
          } catch (error) {
            logger.error?.(
              `[${botName}] retired Codex runtime receipt cleanup failed: `
                + `${error?.code || error?.name || 'unknown'}`,
            );
          }
        }
        runtimeSwitchCompleted = true;
        releaseConfigIntent();
        runtimeView = value === 'codex'
          ? candidateView
          : { runtime: 'claude', backend: value };
        if (runtimeView) {
          runtimeView = {
            ...runtimeView,
            backend: value,
            configuredPm: value,
            selectionSource: writeThreadId ? 'topic' : 'chat',
          };
        }
        const topicConfig = getTopicConfig(
          chatConfig,
          callbackThreadIdEarly,
        );
        const effectiveRichText = resolveRichTextEnabled(
          config,
          chatId,
          callbackThreadIdEarly,
        );
        try {
          const newInfo = await formatConfigInfoText(
            chatConfig,
            'all',
            callbackSessionKey,
            topicConfig,
            effectiveRichText,
            runtimeView,
          );
          const newKeyboard = buildConfigKeyboard(
            chatConfig,
            'all',
            topicConfig,
            effectiveRichText,
            runtimeView,
          );
          const { text: html, parseMode } = toTelegramHtml(newInfo);
          await ctx.editMessageText(html, {
            reply_markup: newKeyboard,
            ...(parseMode && { parse_mode: parseMode }),
          });
        } catch (error) {
          logger.error?.(
            `[${botName}] runtime config-card edit failed: ${error.message}`,
          );
        }
        await ctx.answerCallbackQuery({
          text: `Runtime → ${runtimeLabel(value)}`,
        }).catch(() => {});
        return;
      }

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
      //
      // Rich text follows session isolation like every other setting. Delivery
      // resolves it per message with the real thread, but the agent's authoring
      // hint is spawn-time state resolved with the SESSION's thread — which a
      // chat without isolateTopics collapses to null. A topic-level write there
      // would flip delivery while the hint never drifts: no respawn, and an ack
      // promising a change that never arrives.
      const { scope: writeScope, threadId: writeThreadId } =
        getConfigWriteScope(chatConfig, callbackThreadIdEarly);
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
      // Rich text has no per-topic scope in a chat whose topics share one
      // session: there is a single hint, so there can be a single value. Any
      // topics[tid].richText there was written by the pre-fix behavior and can
      // never be honored by the agent — but delivery resolves topic-first, so
      // it still shadows the chat value in its own topic. Clearing every one of
      // them is part of writing at chat level, not a separate cleanup.
      const clearStaleTopicRichText = () => {
        if (!isRichText || chatConfig?.isolateTopics === true) return [];
        const cleared = [];
        for (const [tid, topic] of Object.entries(chatConfig.topics || {})) {
          if (
            topic
            && typeof topic === 'object'
            && Object.hasOwn(topic, configField)
          ) {
            cleared.push({ threadId: String(tid), scope: topic, value: topic[configField] });
            delete topic[configField];
          }
        }
        return cleared;
      };
      const restoreTopicRichText = (cleared) => {
        for (const { scope, value } of cleared) scope[configField] = value;
      };
      // The user tapped one card; topics they never touched can change value
      // with it. Record which ones and what they held, so a config that moved
      // on its own is still explicable afterwards. Logged only once the sweep
      // is persisted — an event for a rolled-back sweep is worse than none.
      const logTopicRichTextSweep = (cleared) => {
        if (!cleared.length) return;
        dbWrite(() => {
          db.logEvent('config-topic-override-swept', {
            chat_id: chatId,
            field: configField,
            topics: cleared.map(({ threadId, value }) => ({
              thread_id: threadId,
              old_value: value,
            })),
          });
        }, 'log topic-override sweep');
      };

      if (oldValue === parsedValue) {
        // Nothing to write — but a stale override is exactly why this tap can
        // be a no-op, and leaving it keeps delivery and the session's hint
        // disagreeing. Normalize the scope and keep the value the ack states:
        // the chat level is the only place the shared session reads.
        const cleared = clearStaleTopicRichText();
        if (cleared.length) {
          const hadChatValue = Object.hasOwn(chatConfig, configField);
          const previousChatValue = chatConfig[configField];
          chatConfig[configField] = parsedValue;
          try {
            await saveConfig();
            logTopicRichTextSweep(cleared);
          } catch (error) {
            restoreTopicRichText(cleared);
            if (hadChatValue) chatConfig[configField] = previousChatValue;
            else delete chatConfig[configField];
            logger.error?.(
              `[${botName}] config-callback scope normalization failed: `
                + error.message,
            );
          }
        }
        releaseConfigIntent();
        await ctx.answerCallbackQuery({ text: `Already ${value}` })
          .catch(() => {});
        return;
      }

      const clearedTopicRichText = clearStaleTopicRichText();
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
        restoreTopicRichText(clearedTopicRichText);
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
      logTopicRichTextSweep(clearedTopicRichText);
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

      // Delivery changes immediately and the authoring hint follows on the
      // user's next message: a hint drift reloads the session (conversation
      // preserved), so there is no lag left worth a caveat.
      const ackText = isRichText
        ? `Rich text → ${parsedValue ? 'on' : 'off'}`
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
      if (candidatePrepared && !runtimeSwitchCompleted) {
        try {
          discardRuntimeSelection(callbackSessionKey);
        } catch (error) {
          logger.error?.(
            `[${botName}] Codex candidate discard failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
        }
      }
      releaseConfigIntent();
    }
  };
}

module.exports = {
  createHandleConfigCallback,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
};
