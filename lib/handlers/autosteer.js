/**
 * Autosteer detection + dispatch.
 *
 * When a user types a follow-up message while the bot is mid-reply,
 * absorb it into the current turn instead of queueing a separate
 * response (OpenClaw-style "merge into active"). Saves a turn,
 * saves tokens, feels conversational.
 *
 * Two halves:
 *   - shouldAutosteer(sessionKey, chatConfig) — boolean predicate,
 *     used pre-THINKING to skip the 🤔 → ✍ flash.
 *   - tryAutosteer(...) — full dispatch: pm.injectUserMessage with
 *     priority hint ('next' for merge, 'later' for queue), records
 *     ✍ reaction ref, logs telemetry, sets reactor to AUTOSTEERED
 *     and returns true so caller short-circuits.
 *
 * Opt-out: chatConfig.autosteer === false (per-chat) or
 * config.bot.autosteer === false. Mode: chatConfig.autosteerMode
 * (or config.bot.autosteerMode) of 'merge' (default → priority='next')
 * or 'queue' (→ priority='later'); spike findings in
 * scripts/spikes/native-queue.mjs explain the difference.
 */

'use strict';

function isAutosteerEnabledFor(chatConfig, config) {
  return chatConfig.autosteer != null
    ? chatConfig.autosteer !== false
    : config.bot?.autosteer !== false;
}

function priorityFor(chatConfig, config) {
  const mode = chatConfig.autosteerMode != null
    ? chatConfig.autosteerMode
    : config.bot?.autosteerMode;
  return mode === 'queue' ? 'later' : 'next';
}

function createAutosteerHandlers({
  config,
  pm,
  autosteeredRefs,
  logEvent,
} = {}) {

  /**
   * Pre-THINKING predicate. Returns true when the upcoming message
   * will be autosteered (so the caller skips reactor.setState('THINKING')
   * to avoid the 🤔 → ✍ flash).
   */
  function willAutosteer(sessionKey, chatConfig) {
    if (!pm.has(sessionKey)) return false;
    if (!pm.get(sessionKey)?.inFlight) return false;
    return isAutosteerEnabledFor(chatConfig, config);
  }

  /**
   * Attempt to inject the user message into the in-flight turn.
   * Returns:
   *   - { autosteered: true, priority }  — caller marks reactor
   *     AUTOSTEERED + records ✍ ref + returns from handleMessage.
   *   - { autosteered: false }  — caller falls through to normal
   *     pm.send queue path.
   */
  function tryAutosteer({ sessionKey, chatConfig, chatId, msg, prompt }) {
    if (!isAutosteerEnabledFor(chatConfig, config)) return { autosteered: false };
    if (!pm.has(sessionKey)) return { autosteered: false };
    const entry = pm.get(sessionKey);
    if (!entry?.inFlight) return { autosteered: false };

    const priority = priorityFor(chatConfig, config);
    // rc.7: pass the autosteered msg_id through to the backend so the
    // tmux backend can route an extra-turn reply back to Telegram if
    // the TUI dequeues the paste as a fresh user turn (NEW-TURN path).
    // SDK backend ignores msgId — its PostToolBatch fold path
    // guarantees one combined reply via the primary pm.send.
    const ok = pm.injectUserMessage(sessionKey, {
      content: prompt,
      priority,
      msgId: msg.message_id,
    });
    if (!ok) return { autosteered: false };

    autosteeredRefs.add(sessionKey, { chatId, msgId: msg.message_id });
    logEvent('autosteer', {
      chat_id: chatId, msg_id: msg.message_id,
      text_len: prompt?.length ?? 0,
      priority,
    });
    return { autosteered: true, priority };
  }

  return { willAutosteer, tryAutosteer };
}

module.exports = {
  createAutosteerHandlers,
  isAutosteerEnabledFor,
  priorityFor,
};
