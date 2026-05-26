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
  botName,
  logEvent,
  logger = console,
} = {}) {

  return async function dispatchSlashCommand(ctx) {
    const {
      text, sessionKey, chatId, threadIdStr, chatConfig,
      cmdUser, cmdUserId, label, sendReply,
    } = ctx;
    const botAllowsCommands = !!config.bot?.allowConfigCommands;

    // /context — route through pm.getContextUsage(sessionKey) so the
    // call works for both SDK and tmux backends (the latter computes
    // from JSONL message.usage). Pre-0.10.0-P0.2 this reached into
    // entry.query.getContextUsage directly, which silently said "No
    // active session yet" on tmux even when the chat was alive.
    if (botAllowsCommands && text === '/context') {
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
          // rc.65: store full text so boot-time orphan recovery can
          // silently re-push after a deploy interrupted compaction.
          text,
          user: cmdUser, user_id: cmdUserId,
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
      if (pm.has(sessionKey)) {
        try { await pm.kill(sessionKey); }
        catch (err) { logger.error?.(`[${label}] kill on /reload: ${err.message}`); }
      }
      logEvent('session-reload-command', {
        chat_id: chatId, command: text,
        user: cmdUser, user_id: cmdUserId,
      });
      await sendReply('🔄 Reloaded. Next message picks up the conversation with fresh skills/agents.');
      return true;
    }

    // /new + /reset — fresh session
    if (botAllowsCommands && (text === '/new' || text === '/reset')) {
      let drained = 0;
      try {
        const r = await pm.resetSession(sessionKey, { reason: text.slice(1) });
        drained = r?.drainedPendings ?? 0;
      } catch (err) {
        logger.error?.(`[${label}] resetSession ${text}: ${err.message}`);
      }
      contextHintShown.delete(sessionKey);
      logEvent('session-reset-command', {
        chat_id: chatId, command: text, drained_pendings: drained,
        user: cmdUser, user_id: cmdUserId,
      });
      await sendReply('✨ Started a fresh session.');
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

    // /model X
    if (botAllowsCommands && text.startsWith('/model ')) {
      const newModel = text.slice(7).trim();
      if (['opus', 'sonnet', 'haiku'].includes(newModel)) {
        const oldModel = chatConfig.model;
        chatConfig.model = newModel;
        dbWrite(() => db.logConfigChange({
          chat_id: chatId, thread_id: threadIdStr, field: 'model',
          old_value: oldModel, new_value: newModel,
          user: cmdUser, user_id: cmdUserId, source: 'command',
        }), 'log model change');
        const { anyActive } = await applyConfigChange('model', newModel);
        const ver = (modelVersionsDesc && modelVersionsDesc[newModel]) || newModel;
        // Review F#10: channels backend can't apply model/effort changes
        // live — its setModel/applyFlagSettings throw UNSUPPORTED_OPERATION,
        // pm.setModel returns false → `anyActive` is true → user saw the
        // misleading "I'll switch when I finish" message. Now we detect
        // the channels backend explicitly and give an honest answer:
        // settings are persisted to chatConfig and take effect on the next
        // /reset or /new (channels lacks an in-place re-init path).
        const backendName = typeof pm.getBackend === 'function' ? pm.getBackend(sessionKey) : null;
        const suffix = backendName === 'channels'
          ? ` — applies on next /reset (channels)`
          : (anyActive ? ` — I'll switch when I finish` : '');
        await sendReply(`Model → ${newModel} (${ver})${suffix}`);
      } else {
        await sendReply(`Unknown model. Use: opus, sonnet, haiku`);
      }
      return true;
    }

    // /effort X
    if (botAllowsCommands && text.startsWith('/effort ')) {
      const newEffort = text.slice(8).trim();
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(newEffort)) {
        const oldEffort = chatConfig.effort;
        chatConfig.effort = newEffort;
        dbWrite(() => db.logConfigChange({
          chat_id: chatId, thread_id: threadIdStr, field: 'effort',
          old_value: oldEffort, new_value: newEffort,
          user: cmdUser, user_id: cmdUserId, source: 'command',
        }), 'log effort change');
        const { anyActive } = await applyConfigChange('effort', newEffort);
        // Review F#10: channels backend can't apply model/effort changes
        // live — its setModel/applyFlagSettings throw UNSUPPORTED_OPERATION,
        // pm.setModel returns false → `anyActive` is true → user saw the
        // misleading "I'll switch when I finish" message. Now we detect
        // the channels backend explicitly and give an honest answer:
        // settings are persisted to chatConfig and take effect on the next
        // /reset or /new (channels lacks an in-place re-init path).
        const backendName = typeof pm.getBackend === 'function' ? pm.getBackend(sessionKey) : null;
        const suffix = backendName === 'channels'
          ? ` — applies on next /reset (channels)`
          : (anyActive ? ` — I'll switch when I finish` : '');
        await sendReply(`Effort → ${newEffort}${suffix}`);
      } else {
        await sendReply(`Unknown effort. Use: low, medium, high, xhigh, max`);
      }
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
          chat_id: out.chat_id, note: out.note,
        });
        const ttlLabel = args.ttl || '10m';
        const chatLabel = out.chat_id ? `chat ${out.chat_id}` : 'any chat';
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
        const chatLabel = res.chat_id ? `chat ${res.chat_id}` : `every chat ${botName} is in`;
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

module.exports = { createSlashCommands };
