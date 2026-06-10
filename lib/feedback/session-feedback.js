'use strict';

/**
 * Session-scoped feedback controller (0.13 D3,
 * docs/0.13-channels-lifecycle-design.md §3 D3).
 *
 * The per-turn reactor/typing pair lives in handleMessage's closure and dies
 * with the turn (ROOT C). D1 extended the turn to claude's real cycle end —
 * which closed the dead-air class for PRIMARY turns — but cycles with NO
 * pending turn still had zero feedback surface:
 *
 *   - autonomous/wakeup cycles (ScheduleWakeup, fireUserMessage self-checks):
 *     minutes of work with nothing visible until text lands;
 *   - an injected follow-up picked up as its OWN next cycle: its message sat
 *     with no indicator while claude worked it.
 *
 * This controller owns those: a session-level typing loop for the cycle's
 * duration, plus — when the InputLedger knows which message the cycle picked
 * up — a 🤔 anchored to that message, cleared at cycle end. Inputs are the
 * previously-unconsumed lifecycle edges: 'turn-start' (UPS) with no pending,
 * and 'idle'/'close' as the end signals (wired via lib/sdk/callbacks.js).
 *
 * Per-turn feedback (reactor cascade, streamer, waiting-on-user typing pause)
 * stays where it is — this controller deliberately covers only the
 * no-pending gap; it never touches a session that has a head pending.
 */

const { startTyping } = require('../telegram/typing');

function createSessionFeedback({
  bot,
  tg,
  getChatIdFromKey,
  getThreadIdFromKey,
  botName,
  typingIntervalMs = undefined,   // override for tests; default = typing.js default
  logEvent = () => {},
  logger = console,
} = {}) {
  const active = new Map();   // sessionKey → { stop, anchor: {chatId, msgId}|null }

  function startAutonomousCycle(sessionKey, { anchorMsgId = null } = {}) {
    if (active.has(sessionKey)) return;
    const chatId = getChatIdFromKey(sessionKey);
    if (!chatId || !bot) return;
    const threadIdRaw = getThreadIdFromKey?.(sessionKey);
    const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;

    const stop = startTyping({
      bot, chatId,
      ...(Number.isInteger(threadId) ? { threadId } : {}),
      ...(typingIntervalMs ? { intervalMs: typingIntervalMs } : {}),
      logger: { error: (m) => logger.error?.(`[${botName}] autonomous-typing: ${m}`) },
    });

    let anchor = null;
    if (anchorMsgId != null) {
      anchor = { chatId, msgId: Number(anchorMsgId) };
      tg(bot, 'setMessageReaction', {
        chat_id: chatId, message_id: anchor.msgId,
        reaction: [{ type: 'emoji', emoji: '🤔' }],
      }, { source: 'autonomous-cycle-anchor', botName }).catch(() => {});
    }

    active.set(sessionKey, { stop, anchor });
    logEvent('autonomous-cycle-visuals', {
      chat_id: chatId, session_key: sessionKey, state: 'start',
      anchor_msg_id: anchor?.msgId ?? null,
    });
  }

  function endCycle(sessionKey) {
    const entry = active.get(sessionKey);
    if (!entry) return;
    active.delete(sessionKey);
    try { entry.stop(); } catch { /* best-effort */ }
    if (entry.anchor && bot) {
      tg(bot, 'setMessageReaction', {
        chat_id: entry.anchor.chatId, message_id: entry.anchor.msgId, reaction: [],
      }, { source: 'autonomous-cycle-anchor-clear', botName }).catch(() => {});
    }
    logEvent('autonomous-cycle-visuals', {
      chat_id: entry.anchor?.chatId ?? getChatIdFromKey(sessionKey),
      session_key: sessionKey, state: 'end',
    });
  }

  return { startAutonomousCycle, endCycle };
}

module.exports = { createSessionFeedback };
