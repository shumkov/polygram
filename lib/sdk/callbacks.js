/**
 * Factory for the SDK pm's lifecycle callbacks.
 *
 * polygram.js wires this at boot via createSdkCallbacks(deps); the
 * returned object is spread into ProcessManagerSdk's constructor as
 * `{ onInit, onClose, onStreamChunk, onToolUse,
 *    onAssistantMessageStart, onAutonomousAssistantMessage,
 *    onCompactBoundary }`.
 *
 * Each callback is a thin glue layer: pm-sdk emits a typed event,
 * polygram's callback decides what to persist (db / events) and
 * what to surface to the user (telegram).
 *
 * Why factory: callbacks need polygram-runtime context (db, config,
 * bot, BOT_NAME, tg, logEvent, dbWrite, classifyToolName, announce,
 * shouldAnnounce, contextHintShown, extractAssistantText, getChatIdFromKey,
 * getThreadIdFromKey). Closing over them at boot keeps each callback's
 * runtime signature compatible with pm-sdk's contract.
 */

'use strict';

function createSdkCallbacks({
  db,
  dbWrite,
  config,
  bot,
  botName,
  tg,
  logEvent,
  classifyToolName,
  announce,
  shouldAnnounce,
  contextHintShown,
  extractAssistantText,
  getChatIdFromKey,
  getThreadIdFromKey,
  logger = console,
} = {}) {
  if (!db) throw new TypeError('db required');
  if (typeof dbWrite !== 'function') throw new TypeError('dbWrite required');
  if (!config) throw new TypeError('config required');
  if (!botName) throw new TypeError('botName required');
  if (typeof tg !== 'function') throw new TypeError('tg required');
  if (typeof logEvent !== 'function') throw new TypeError('logEvent required');
  if (typeof classifyToolName !== 'function') throw new TypeError('classifyToolName required');
  if (typeof announce !== 'function') throw new TypeError('announce required');
  if (typeof shouldAnnounce !== 'function') throw new TypeError('shouldAnnounce required');
  if (!(contextHintShown instanceof Set)) throw new TypeError('contextHintShown (Set) required');
  if (typeof extractAssistantText !== 'function') throw new TypeError('extractAssistantText required');
  if (typeof getChatIdFromKey !== 'function') throw new TypeError('getChatIdFromKey required');
  if (typeof getThreadIdFromKey !== 'function') throw new TypeError('getThreadIdFromKey required');

  return {
    onInit: (sessionKey, event, entry) => {
      dbWrite(() => db.upsertSession({
        session_key: sessionKey,
        chat_id: entry.chatId,
        thread_id: entry.threadId,
        claude_session_id: event.session_id,
        agent: config.chats[entry.chatId]?.agent || null,
        cwd: config.chats[entry.chatId]?.cwd || null,
        model: config.chats[entry.chatId]?.model || null,
        effort: config.chats[entry.chatId]?.effort || null,
      }), `upsert session ${sessionKey}`);
    },

    onClose: (sessionKey, code, entry) => {
      logger.log?.(`[${entry.label}] Process exited (code ${code})`);
      logEvent('process-close', { chat_id: entry.chatId, session_key: sessionKey, code });
    },

    onStreamChunk: (sessionKey, partial, entry) => {
      // Route to the head pending's per-turn streamer. In the
      // concurrent-pending model, only the HEAD is the turn Claude
      // is actively emitting events for.
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) s.onChunk(partial).catch(() => {});
      // Heartbeat the reactor so long text generation doesn't trip
      // the 10s STALL → 🥱 / 30s TIMEOUT → 😨 promotion.
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
    },

    onToolUse: (sessionKey, toolName, entry) => {
      const head = entry.pendingQueue?.[0];
      const r = head?.context?.reactor;
      if (r) r.setState(classifyToolName(toolName));
      // Subagent announce: when Claude uses Task to spawn a subagent,
      // post a brief informational message. Per-chat 30s debounce
      // prevents announce-storms in tool-heavy turns.
      const chatCfg = config.chats[entry.chatId] || {};
      const optOut = chatCfg.announceSubagents != null
        ? chatCfg.announceSubagents === false
        : config.bot?.announceSubagents === false;
      if (toolName === 'Task' && !optOut) {
        if (shouldAnnounce(entry.chatId)) {
          announce({
            send: (b, method, params, m) => tg(b, method, params, m),
            bot, chatId: entry.chatId,
            threadId: head?.context?.threadId ?? null,
            text: '🤖 Spawning subagent…',
            meta: { botName, source: 'subagent-announce' },
            logger: { error: (m) => logger.error?.(`[${entry.label}] ${m}`) },
          });
        }
      }
    },

    // Each new top-level assistant message gets its own bubble.
    // When Claude emits text, then tool_use, then more text in a NEW
    // assistant message, the previous bubble's content stays visible
    // as a "thinking out loud" intermediate; the new message starts
    // fresh below.
    onAssistantMessageStart: (sessionKey, entry) => {
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) s.forceNewMessage();
      // Heartbeat at every assistant-message boundary too. A long
      // thinking phase (effort=high, 30+s before first chunk) doesn't
      // fire onStreamChunk; without this, the freeze timer could
      // expire while the model is "still thinking but about to speak".
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
    },

    // rc.47: autonomous wakeup forwarding. Fires when an SDK
    // assistant message arrives with no head pending — typical
    // ScheduleWakeup case where the agent self-fires without an
    // inbound user message. Best-effort send: failures are logged
    // but don't propagate.
    onAutonomousAssistantMessage: (sessionKey, msg /* , entry */) => {
      try {
        const text = extractAssistantText(msg);
        if (!text) return;
        const chatId = getChatIdFromKey(sessionKey);
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        if (!bot) {
          logger.error?.(`[${botName}] autonomous wakeup: bot not ready, dropping ${text.length} chars`);
          return;
        }
        const params = {
          chat_id: chatId,
          text,
          ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
        };
        // Don't await — keep the pm-sdk event loop unblocked.
        tg(bot, 'sendMessage', params,
          { source: 'autonomous-wakeup', botName }).catch((err) => {
            logger.error?.(`[${botName}] autonomous wakeup send failed: ${err.message}`);
          });
        logEvent('autonomous-wakeup-message', {
          chat_id: chatId,
          session_key: sessionKey,
          thread_id: threadIdRaw,
          text_len: text.length,
        });
      } catch (err) {
        logger.error?.(`[${botName}] autonomous wakeup handler: ${err.message}`);
      }
    },

    // SDK auto-compaction observability. Fires when SDK emits
    // SDKCompactBoundaryMessage. Surfaces a quiet system status note
    // to the chat so the user knows the bot is busy reorganising
    // context. ON by default; set per-chat or per-bot
    // `announceCompact: false` to silence.
    onCompactBoundary: async (sessionKey, msg, entry) => {
      // Clear the contextHint once-per-cycle gate. After compaction,
      // context drops below threshold; if it climbs back up the next
      // cycle should fire a fresh hint.
      contextHintShown.delete(sessionKey);

      const chatCfg = config.chats[entry.chatId] || {};
      const optOut = chatCfg.announceCompact != null
        ? chatCfg.announceCompact === false
        : config.bot?.announceCompact === false;
      if (optOut) return;
      const threadId = entry.threadId || undefined;

      // Word the message based on what actually happened. Pre-rc.62
      // every event read as "💭 Catching up…" — but compact_boundary
      // fires AFTER compaction completes, leaving users confused
      // when nothing followed. Now: distinguish manual vs auto and
      // surface the compression ratio.
      const meta = msg?.compact_metadata || {};
      const trigger = meta.trigger;        // 'manual' | 'auto'
      const preTokens = meta.pre_tokens;
      const postTokens = meta.post_tokens;
      const durationMs = meta.duration_ms;
      const fmtTok = (n) => {
        if (n == null) return null;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(n);
      };
      const ratio = (preTokens && postTokens)
        ? `${fmtTok(preTokens)} → ${fmtTok(postTokens)}` : null;
      const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : null;
      const stats = [ratio, duration].filter(Boolean).join(', ');

      let text;
      if (trigger === 'manual') {
        text = stats
          ? `✅ Compacted (${stats}). Ready for your next message.`
          : `✅ Compacted. Ready for your next message.`;
      } else {
        text = stats
          ? `💭 Auto-compacted (${stats}). Continuing…`
          : `💭 Auto-compacted. Continuing…`;
      }

      try {
        await tg(bot, 'sendMessage', {
          chat_id: entry.chatId,
          text,
          ...(threadId ? { message_thread_id: threadId } : {}),
        }, { source: 'compact-boundary', botName });
      } catch (err) {
        logger.error?.(`[${entry.label}] compact-boundary post: ${err.message}`);
      }
    },
  };
}

module.exports = { createSdkCallbacks };
