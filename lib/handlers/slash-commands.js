/**
 * Slash command dispatcher.
 *
 * Polygram supports these chat commands (gated on
 * config.bot.allowConfigCommands except /pair which is its own auth):
 *
 *   /context         — on-demand SDK context-usage report
 *   /compact [hint]  — manual SDK compaction with optional preserve hint
 *   /reload          — close+respawn Query, preserves session_id
 *   /new, /reset     — fresh session (resetSession clears session_id)
 *   /model X         — switch model (X ∈ opus|sonnet|haiku)
 *   /effort X        — switch effort (X ∈ low|medium|high|xhigh|max)
 *   /pair-code …     — admin: issue a pairing code
 *   /pairings        — admin: list active pairings
 *   /unpair <user>   — admin: revoke pairings for a user
 *   /pair <code>     — claim a pairing code (open, code is the auth)
 *
 * Returns true when the message was a recognized command (caller
 * short-circuits handleMessage); false otherwise.
 *
 * Why a single factory: each handler shares the same runtime
 * context (config, db, dbWrite, pm, pairings, sendReply, logEvent,
 * etc.) and they're naturally co-located by command-style anyway.
 * Splitting into one-file-per-command would 5× the wiring without
 * gain.
 */

'use strict';

const { getConfigWriteScope } = require('../session-key');
const {
  configuredRuntimeValue,
  formatCodexSettingsOutcome,
  getCodexCatalogEfforts,
  getCodexCatalogModels,
  isCodexRuntimeView,
  resolveCodexEffortForModel,
} = require('./config-ui');

function createSlashCommands({
  config,
  db,
  dbWrite,
  pm,
  pairings,
  parsePairingTtl,
  contextHintShown,
  formatContextReply,
  getClaudeSessionId,
  getOrSpawnForChat,
  parsePairCodeArgs,
  modelVersionsDesc,
  resolveRuntimeView = null,
  intentLock,
  saveConfig = () => {},
  botName,
  logEvent,
  // Narrow async hook: retire the question state of a session whose process
  // this command is retiring. A callback, so this module never learns the
  // question store.
  retireQuestionSession = null,
  logger = console,
} = {}) {

  return async function dispatchSlashCommand(ctx) {
    const {
      text, msgId, sessionKey, chatId, threadIdStr, chatConfig,
      cmdUser, cmdUserId, label, sendReply,
    } = ctx;
    // Commands are logged by their recognized verb, never by the typed line:
    // the arguments are message content and telemetry stays content-free.
    const commandVerb = () => String(text || '').trim().split(/\s+/)[0] || null;
    const botAllowsCommands = !!config.bot?.allowConfigCommands;

    // /context — route through pm.getContextUsage(sessionKey) so the
    // call works for both SDK and tmux backends (the latter computes
    // from JSONL message.usage). Pre-0.10.0-P0.2 this reached into
    // entry.query.getContextUsage directly, which silently said "No
    // active session yet" on tmux even when the chat was alive.
    if (botAllowsCommands && text === '/context') {
      if (typeof resolveRuntimeView === 'function') {
        try {
          const runtimeView = await resolveRuntimeView({
            sessionKey,
            chatId,
            threadId: threadIdStr,
          });
          if (isCodexRuntimeView(runtimeView)) {
            await sendReply(
              'Codex context usage reporting is not supported yet; the active Codex thread was unchanged.',
            );
            return true;
          }
        } catch (error) {
          logger.error?.(
            `[${label}] /context runtime view failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          await sendReply(
            'Context status is temporarily unavailable; the active session was not changed.',
          );
          return true;
        }
      }
      if (!pm.has(sessionKey)) {
        await sendReply('📚 No active session yet — send a message first, then /context.');
        return true;
      }
      try {
        const u = await pm.getContextUsage(sessionKey);
        await sendReply(formatContextReply(u));
      } catch (err) {
        if (err?.code === 'UNSUPPORTED_OPERATION' || err?.code === 'NOT_IMPLEMENTED_YET') {
          await sendReply('📚 Context info not available yet — send a message first, then /context.');
          return true;
        }
        logger.error?.(`[${label}] /context failed: ${err.message}`);
        await sendReply(`📚 Couldn't fetch context info: ${err.message}`);
      }
      return true;
    }

    // /compact [hint] — manual SDK compaction. Push the literal
    // "/compact ..." into the input controller; SDK parses leading
    // "/" as a slash command and triggers compaction. If session
    // was LRU-evicted but DB has a saved session_id, auto-spawn
    // with --resume so /compact has something to work with.
    if (botAllowsCommands && text.startsWith('/compact')) {
      if (typeof resolveRuntimeView === 'function') {
        let runtimeView;
        try {
          runtimeView = await resolveRuntimeView({
            sessionKey,
            chatId,
            threadId: threadIdStr,
          });
        } catch (error) {
          logger.error?.(
            `[${label}] /compact runtime view failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          await sendReply(
            'Compaction status is temporarily unavailable; the active session was not changed.',
          );
          return true;
        }
        if (isCodexRuntimeView(runtimeView)) {
          await sendReply(
            'Codex thread compaction is not supported yet; the active Codex thread was unchanged.',
          );
          return true;
        }
      }
      let entry = pm.get(sessionKey);
      if (!entry) {
        const savedSessionId = getClaudeSessionId(db, sessionKey);
        if (!savedSessionId) {
          await sendReply('🗜️ No conversation to compact yet. Send a message first, then /compact.');
          return true;
        }
        try {
          entry = await getOrSpawnForChat(sessionKey);
        } catch (err) {
          logger.error?.(`[${label}] /compact spawn-resume: ${err.message}`);
          await sendReply(`🗜️ Couldn't load session for compaction: ${err.message}`);
          return true;
        }
        if (!entry) {
          await sendReply('🗜️ Session not loadable (config missing).');
          return true;
        }
        logEvent('compact-spawn-resumed', {
          chat_id: chatId, thread_id: threadIdStr, session_key: sessionKey,
          resumed_session_id: savedSessionId,
        });
      }
      if (!entry || typeof entry.fireUserMessage !== 'function') {
        await sendReply('🗜️ Session not ready for /compact.');
        return true;
      }
      try {
        // 0.10.0 P0.3 fix: route through Process.fireUserMessage so
        // SDK (push to inputController) and tmux (paste to TUI) both
        // handle the slash command. Pre-0.10.0-P0.3 reached into
        // entry.inputController.push directly — broken on tmux.
        const ok = entry.fireUserMessage(text);
        if (!ok) {
          await sendReply('🗜️ Session not ready for /compact.');
          return true;
        }
        logEvent('compact-command', {
          chat_id: chatId, thread_id: threadIdStr, session_key: sessionKey,
          text_len: text.length,
          // The id of the inbound message carrying the hint. Boot-time orphan
          // recovery joins it back to the stored row to re-push silently; the
          // hint itself is message content and never enters telemetry.
          msg_id: msgId ?? null,
          user_id: cmdUserId,
        });
        const hasHint = text.length > '/compact'.length + 1;
        await sendReply(hasHint ? '🗜️ Compacting with your hint…' : '🗜️ Compacting…');
      } catch (err) {
        logger.error?.(`[${label}] /compact push: ${err.message}`);
        await sendReply(`🗜️ Couldn't trigger compact: ${err.message}`);
      }
      return true;
    }

    // /reload — close+respawn Query while PRESERVING session_id.
    // Difference vs /new:
    //   /new    → resetSession clears session_id → fresh conversation
    //   /reload → kill closes Query, session_id preserved → same
    //              conversation continues with fresh agent/skill code
    if (botAllowsCommands && text === '/reload') {
      let runtimeView = null;
      if (typeof resolveRuntimeView === 'function') {
        try {
          runtimeView = await resolveRuntimeView({
            sessionKey,
            chatId,
            threadId: threadIdStr,
          });
        } catch (error) {
          logger.error?.(
            `[${label}] /reload runtime view failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          await sendReply(
            'Runtime status is temporarily unavailable; the active session was not changed.',
          );
          return true;
        }
      }
      const codex = isCodexRuntimeView(runtimeView);
      if (pm.has(sessionKey)) {
        try {
          await pm.kill(sessionKey);
        } catch (err) {
          logger.error?.(`[${label}] kill on /reload: ${err.message}`);
          await sendReply(
            codex
              ? '🔄 Couldn’t reload Codex because cleanup was not proven; the active Codex thread may be unchanged.'
              : '🔄 Couldn’t reload Claude; the active session may be unchanged.',
          );
          return true;
        }
        // The process that owned any open question is gone; retire its state.
        // Ordered after the kill so a refused reload leaves the still-live
        // interaction intact.
        await retireQuestionSession?.(sessionKey);
      } else {
        // No process to retire, but an open question has nothing to deliver to
        // either.
        await retireQuestionSession?.(sessionKey);
      }
      logEvent('session-reload-command', {
        chat_id: chatId, command: commandVerb(),
        user_id: cmdUserId,
      });
      await sendReply(
        codex
          ? '🔄 Reloaded Codex. The next message resumes the same Codex thread with a fresh runtime.'
          : '🔄 Reloaded. Next message picks up the conversation with fresh skills/agents.',
      );
      return true;
    }

    // /new + /reset + /clear — fresh session (all synonyms)
    if (botAllowsCommands && (text === '/new' || text === '/reset' || text === '/clear')) {
      let runtimeView = null;
      if (typeof resolveRuntimeView === 'function') {
        try {
          runtimeView = await resolveRuntimeView({
            sessionKey,
            chatId,
            threadId: threadIdStr,
          });
        } catch (error) {
          logger.error?.(
            `[${label}] ${text} runtime view failed: `
              + `${error?.code || error?.name || 'unknown'}`,
          );
          await sendReply(
            'Runtime status is temporarily unavailable; the active session was not changed.',
          );
          return true;
        }
      }
      const codex = isCodexRuntimeView(runtimeView);
      let drained = 0;
      try {
        // A fresh session retires the process that owns any open question.
        // Deliberately before the reset: if the reset then fails, the safe
        // outcome is still that nothing exact was kept.
        await retireQuestionSession?.(sessionKey);
        const r = await pm.resetSession(sessionKey, { reason: text.slice(1) });
        drained = r?.drainedPendings ?? 0;
      } catch (err) {
        logger.error?.(`[${label}] resetSession ${text}: ${err.message}`);
        await sendReply(
          codex
            ? '✨ Couldn’t start a fresh Codex thread because cleanup was not proven; the prior Codex thread may be unchanged.'
            : '✨ Couldn’t start a fresh Claude session; the prior session may be unchanged.',
        );
        return true;
      }
      contextHintShown.delete(sessionKey);
      logEvent('session-reset-command', {
        chat_id: chatId, command: commandVerb(), drained_pendings: drained,
        user_id: cmdUserId,
      });
      await sendReply(
        codex
          ? '✨ Started a fresh Codex thread.'
          : '✨ Started a fresh session.',
      );
      return true;
    }

    // SDK pm applies model/effort changes live via setModel /
    // applyFlagSettings — no respawn. Returns whether there was a
    // live session to push the change into; chatConfig is updated
    // either way (next cold spawn picks it up).
    const applyConfigChange = async (setting, value) => {
      let applied = false;
      if (setting === 'effort') {
        applied = await pm.applyFlagSettings(sessionKey, { effortLevel: value });
      } else if (setting === 'model') {
        applied = await pm.setModel(sessionKey, value);
      }
      return { anyActive: !applied };
    };

    // cli can't hot-swap model/effort live (they are spawn-time --model /
    // --effort flags). The change is persisted to chatConfig and applies when
    // the session next (re)spawns — getOrSpawn's reload-on-drift makes that the
    // user's NEXT message, conversation preserved (--resume). So give an honest
    // suffix per backend instead of the misleading "I'll switch when I finish".
    // (Pre-fix this checked backendName === 'channels', but 0.12.0 renamed the
    // cli backend 'channels' → 'cli', so it never fired and every cli user got
    // the wrong message — Review F#10 regression.)
    const cliAwareSuffix = (anyActive) => {
      const liveBackend = typeof pm.getBackend === 'function' ? pm.getBackend(sessionKey) : null;
      if (liveBackend === 'cli') {
        const proc = typeof pm.get === 'function' ? pm.get(sessionKey) : null;
        return proc && proc.inFlight
          ? ' — applies after this turn (conversation kept)'
          : ' — applies on your next message (conversation kept)';
      }
      // cli but cold (no live proc): the next message cold-spawns with the new flag.
      if (!liveBackend && (chatConfig.pm || config.bot?.pm) === 'cli') {
        return ' — applies on your next message';
      }
      // SDK: applied live (anyActive false) or no live session to push into.
      return anyActive ? ' — I\'ll switch when I finish' : '';
    };

    // /model X
    if (botAllowsCommands && text.startsWith('/model ')) {
      const newModel = text.slice(7).trim();
      const releaseIntent = await intentLock.acquire(sessionKey);
      let replyText;
      try {
        let runtimeView = null;
        if (typeof resolveRuntimeView === 'function') {
          try {
            runtimeView = await resolveRuntimeView({
              sessionKey,
              chatId,
              threadId: threadIdStr,
            });
          } catch (error) {
            logger.error?.(
              `[${label}] /model runtime view failed: `
                + `${error?.code || error?.name || 'unknown'}`,
            );
            replyText = 'Model settings are temporarily unavailable.';
          }
        }
        if (!replyText) {
          const codex = isCodexRuntimeView(runtimeView);
          const validModels = codex
            ? getCodexCatalogModels(runtimeView).map((entry) => entry.model)
            : ['opus', 'sonnet', 'haiku'];
          if (!validModels.includes(newModel)) {
            replyText =
              `Unknown model. Use: ${validModels.join(', ')
                || 'no authenticated models available'}`;
          } else {
            const { scope: wScope, threadId: wThread } =
              getConfigWriteScope(chatConfig, threadIdStr);
            const configField = codex ? 'codexModel' : 'model';
            const oldModel = wScope[configField] != null
              ? wScope[configField]
              : chatConfig[configField] != null
                ? chatConfig[configField]
                : codex ? runtimeView.model : chatConfig[configField];
            const snapshots = new Map([
              [configField, {
                present: Object.hasOwn(wScope, configField),
                value: wScope[configField],
              }],
              ['codexEffort', {
                present: Object.hasOwn(wScope, 'codexEffort'),
                value: wScope.codexEffort,
              }],
            ]);
            let effortAdjustment = null;
            let nextEffort = null;
            if (codex) {
              const oldEffort = wScope.codexEffort != null
                ? wScope.codexEffort
                : chatConfig.codexEffort != null
                  ? chatConfig.codexEffort
                  : runtimeView.effort;
              nextEffort = resolveCodexEffortForModel(
                runtimeView,
                newModel,
                oldEffort,
              );
              if (nextEffort == null) {
                replyText =
                  'Selected model has no authenticated default effort.';
              } else if (nextEffort !== oldEffort) {
                effortAdjustment = {
                  oldValue: oldEffort,
                  newValue: nextEffort,
                };
              }
            }
            if (!replyText) {
              wScope[configField] = newModel;
              if (effortAdjustment) {
                wScope.codexEffort = effortAdjustment.newValue;
              }
              try {
                await saveConfig();
              } catch (error) {
                for (const [field, snapshot] of snapshots) {
                  if (snapshot.present) wScope[field] = snapshot.value;
                  else delete wScope[field];
                }
                logger.error?.(
                  `[${botName}] /model saveConfig failed: ${error.message}`,
                );
                replyText =
                  "Couldn't save the model selection; nothing changed.";
              }
            }
            if (!replyText) {
              const auditRows = [{
                  chat_id: chatId, thread_id: wThread, field: 'model',
                  old_value: oldModel, new_value: newModel,
                  user_id: cmdUserId, source: 'command',
                }];
              if (effortAdjustment) {
                auditRows.push({
                    chat_id: chatId,
                    thread_id: wThread,
                    field: 'effort',
                    old_value: effortAdjustment.oldValue,
                    new_value: effortAdjustment.newValue,
                    user: cmdUser,
                    user_id: cmdUserId,
                    source: 'command',
                });
              }
              if (codex) {
                try {
                  db.logConfigChanges(auditRows);
                } catch (error) {
                  for (const [field, snapshot] of snapshots) {
                    if (snapshot.present) wScope[field] = snapshot.value;
                    else delete wScope[field];
                  }
                  let rollbackFailed = false;
                  try {
                    await saveConfig();
                  } catch (rollbackError) {
                    rollbackFailed = true;
                    logger.error?.(
                      `[${botName}] /model config rollback failed: `
                        + rollbackError.message,
                    );
                  }
                  logger.error?.(
                    `[${botName}] /model audit failed: ${error.message}`,
                  );
                  replyText = rollbackFailed
                    ? "Couldn't audit the model selection; the live process "
                      + 'was unchanged, but persisted config needs attention.'
                    : "Couldn't audit the model selection; nothing changed.";
                }
              } else {
                dbWrite(() => {
                  for (const row of auditRows) db.logConfigChange(row);
                }, 'log model change');
              }
            }
            if (!replyText) {
              let settingsResult = null;
              let anyActive = false;
              if (codex) {
                try {
                  settingsResult = await pm.selectModelSettings(sessionKey, {
                    model: newModel,
                    effort: nextEffort,
                  });
                } catch (error) {
                  logger.error?.(
                    `[${label}] Codex /model live selection failed: `
                      + `${error?.code || error?.name || 'unknown'}`,
                  );
                  settingsResult = {
                    outcome: 'live-status-unknown',
                    nextTurn: { model: newModel, effort: nextEffort },
                  };
                }
              } else {
                ({ anyActive } = await applyConfigChange('model', newModel));
              }
              const catalogEntry = codex
                ? getCodexCatalogModels(runtimeView)
                  .find((entry) => entry.model === newModel)
                : null;
              const ver = codex
                ? catalogEntry?.displayName || newModel
                : (modelVersionsDesc && modelVersionsDesc[newModel])
                  || newModel;
              const suffix = codex
                ? formatCodexSettingsOutcome(settingsResult)
                : cliAwareSuffix(anyActive);
              const effortNote = effortAdjustment
                ? `; Effort → ${effortAdjustment.newValue}`
                : '';
              replyText =
                `Model → ${newModel} (${ver})${effortNote}${suffix}`;
            }
          }
        }
      } finally {
        releaseIntent();
      }
      await sendReply(replyText);
      return true;
    }

    // /effort X
    if (botAllowsCommands && text.startsWith('/effort ')) {
      const newEffort = text.slice(8).trim();
      const releaseIntent = await intentLock.acquire(sessionKey);
      let replyText;
      try {
        let runtimeView = null;
        if (typeof resolveRuntimeView === 'function') {
          try {
            runtimeView = await resolveRuntimeView({
              sessionKey,
              chatId,
              threadId: threadIdStr,
            });
          } catch (error) {
            logger.error?.(
              `[${label}] /effort runtime view failed: `
                + `${error?.code || error?.name || 'unknown'}`,
            );
            replyText = 'Effort settings are temporarily unavailable.';
          }
        }
        if (!replyText) {
          const codex = isCodexRuntimeView(runtimeView);
          const topicConfig = threadIdStr
            ? chatConfig?.topics?.[threadIdStr]
            : null;
          const currentModel = configuredRuntimeValue(
            chatConfig,
            topicConfig,
            runtimeView,
            'model',
          );
          const validEfforts = codex
            ? getCodexCatalogEfforts(runtimeView, currentModel)
            : ['low', 'medium', 'high', 'xhigh', 'max'];
          if (!validEfforts.includes(newEffort)) {
            replyText =
              `Unknown effort. Use: ${validEfforts.join(', ')
                || 'no authenticated efforts available'}`;
          } else {
            const { scope: wScope, threadId: wThread } =
              getConfigWriteScope(chatConfig, threadIdStr);
            const configField = codex ? 'codexEffort' : 'effort';
            const oldEffort = wScope[configField] != null
              ? wScope[configField]
              : chatConfig[configField] != null
                ? chatConfig[configField]
                : codex ? runtimeView.effort : chatConfig[configField];
            const snapshot = {
              present: Object.hasOwn(wScope, configField),
              value: wScope[configField],
            };
            wScope[configField] = newEffort;
            try {
              await saveConfig();
            } catch (error) {
              if (snapshot.present) wScope[configField] = snapshot.value;
              else delete wScope[configField];
              logger.error?.(
                `[${botName}] /effort saveConfig failed: ${error.message}`,
              );
              replyText =
                "Couldn't save the effort selection; nothing changed.";
            }
            if (!replyText) {
              const auditRow = {
                chat_id: chatId, thread_id: wThread, field: 'effort',
                old_value: oldEffort, new_value: newEffort,
                user_id: cmdUserId, source: 'command',
              };
              if (codex) {
                try {
                  db.logConfigChanges([auditRow]);
                } catch (error) {
                  if (snapshot.present) wScope[configField] = snapshot.value;
                  else delete wScope[configField];
                  let rollbackFailed = false;
                  try {
                    await saveConfig();
                  } catch (rollbackError) {
                    rollbackFailed = true;
                    logger.error?.(
                      `[${botName}] /effort config rollback failed: `
                        + rollbackError.message,
                    );
                  }
                  logger.error?.(
                    `[${botName}] /effort audit failed: ${error.message}`,
                  );
                  replyText = rollbackFailed
                    ? "Couldn't audit the effort selection; the live process "
                      + 'was unchanged, but persisted config needs attention.'
                    : "Couldn't audit the effort selection; nothing changed.";
                }
              } else {
                dbWrite(
                  () => db.logConfigChange(auditRow),
                  'log effort change',
                );
              }
            }
            if (!replyText) {
              let settingsResult = null;
              let anyActive = false;
              if (codex) {
                try {
                  settingsResult = await pm.selectModelSettings(sessionKey, {
                    model: currentModel,
                    effort: newEffort,
                  });
                } catch (error) {
                  logger.error?.(
                    `[${label}] Codex /effort live selection failed: `
                      + `${error?.code || error?.name || 'unknown'}`,
                  );
                  settingsResult = {
                    outcome: 'live-status-unknown',
                    nextTurn: { model: currentModel, effort: newEffort },
                  };
                }
              } else {
                ({ anyActive } = await applyConfigChange(
                  'effort',
                  newEffort,
                ));
              }
              const suffix = codex
                ? formatCodexSettingsOutcome(settingsResult)
                : cliAwareSuffix(anyActive);
              replyText = `Effort → ${newEffort}${suffix}`;
            }
          }
        }
      } finally {
        releaseIntent();
      }
      await sendReply(replyText);
      return true;
    }

    // Admin-only pairing commands — chat must match config.bot.adminChatId.
    // allowConfigCommands alone is NOT sufficient: that flag gates
    // /model and /effort which only affect the current chat. Pairing
    // issues cross-chat trust and must be narrowed further.
    const adminChatId = config.bot?.adminChatId ? String(config.bot.adminChatId) : null;
    const isAdminChat = adminChatId && String(chatId) === adminChatId;

    if (botAllowsCommands && text.startsWith('/pair-code')) {
      if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return true; }
      const issuerId = cmdUserId;
      if (!issuerId) { await sendReply('No user id on request'); return true; }
      const args = parsePairCodeArgs(text);
      try {
        const out = pairings.issueCode({
          bot_name: botName,
          chat_id: args.chat || null,
          scope: args.scope || 'user',
          issued_by_user_id: issuerId,
          ttlMs: args.ttl ? parsePairingTtl(args.ttl) : undefined,
          note: args.note || null,
        });
        logEvent('pair-code-issued', {
          bot: botName, by: issuerId, scope: out.scope,
          chat_id: out.chat_id,
          // The note is operator-typed text; record only that one was given.
          noticed: Boolean(out.note),
        });
        const ttlLabel = args.ttl || '10m';
        const chatLabel = out.chat_id ? `chat ${out.chat_id}` : 'the chat where it is redeemed';
        await sendReply(
          `Code: ${out.code}\nexpires: ${ttlLabel}\nscope: ${out.scope} (${chatLabel})${out.note ? `\nnote: ${out.note}` : ''}\n\nShare with user:\n/pair ${out.code}`,
        );
      } catch (err) {
        await sendReply(`Could not issue code: ${err.message}`);
      }
      return true;
    }

    if (botAllowsCommands && text.startsWith('/pairings')) {
      if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return true; }
      const rows = pairings.listActive(botName);
      if (!rows.length) { await sendReply('No active pairings.'); return true; }
      const lines = rows.map((r) => {
        const chat = r.chat_id ? `chat ${r.chat_id}` : 'any chat';
        const granted = new Date(r.granted_ts).toISOString().slice(0, 16).replace('T', ' ');
        const note = r.note ? ` — ${r.note}` : '';
        return `• user ${r.user_id} — ${chat} — ${granted}${note}`;
      });
      await sendReply(`Active pairings (${rows.length}):\n${lines.join('\n')}`);
      return true;
    }

    if (botAllowsCommands && text.startsWith('/unpair ')) {
      if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return true; }
      const arg = text.slice(8).trim();
      const targetId = parseInt(arg, 10);
      if (!Number.isFinite(targetId)) {
        await sendReply('Usage: /unpair <user_id>');
        return true;
      }
      const n = pairings.revokeByUser({ bot_name: botName, user_id: targetId });
      logEvent('pair-revoked', {
        bot: botName, user_id: targetId, by: cmdUserId, count: n,
      });
      await sendReply(n
        ? `Revoked ${n} pairing(s) for user ${targetId}.`
        : `No active pairings for user ${targetId}.`);
      return true;
    }

    // /pair <CODE> — open to anyone, no admin gate (the code IS the auth).
    if (text.startsWith('/pair ') && !text.startsWith('/pair-code') && !text.startsWith('/pairings')) {
      if (!cmdUserId) { await sendReply('No user id on request'); return true; }
      const code = text.slice(6).trim();
      const res = pairings.claimCode({
        code, claimer_user_id: cmdUserId,
        chat_id: chatId, bot_name: botName,
      });
      logEvent('pair-claim-attempt', {
        bot: botName, user_id: cmdUserId, chat_id: chatId,
        ok: res.ok, reason: res.reason,
      });
      if (res.ok) {
        const chatLabel = res.chat_id ? `chat ${res.chat_id}` : 'this chat';
        await sendReply(`Paired. You can use me in ${chatLabel}.${res.note ? `\n(${res.note})` : ''}`);
        return true;
      }
      // Collapse failure reasons into "invalid or expired" to
      // prevent enumeration. The pair-claim-attempt event above
      // logs the precise reason for operator audit.
      const userMsg = res.reason === 'rate-limited'
        ? 'Too many attempts. Try again later.'
        : 'That code is invalid or expired.';
      await sendReply(userMsg);
      return true;
    }

    return false;
  };
}

/**
 * Normalize a stored line into the exact `/compact [hint]` form, or return
 * null when it is not a compact command at all.
 *
 * Boot-time recovery re-pushes a stored line into a live session, so the line
 * has to be proven to BE a compact command first: an arbitrary message, or a
 * different command, must never be fired at the agent as if the user had
 * asked to compact. Telegram also delivers group commands with the bot's
 * username attached (`/compact@bot hint`), which the agent's own parser does
 * not accept — that suffix is stripped here.
 */
function normalizeCompactCommand(text) {
  if (typeof text !== 'string') return null;
  const match = /^\/compact(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const hint = (match[1] || '').trim();
  return hint ? `/compact ${hint}` : '/compact';
}

module.exports = { createSlashCommands, normalizeCompactCommand };
