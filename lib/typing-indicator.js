/**
 * Typing indicator with circuit breaker.
 *
 * Problem: sendChatAction('typing') is called every 4s while a turn is in
 * flight. If the bot was removed from a chat, blocked by a user, or the
 * chat was deleted, the API returns 401 Forbidden. The naive `.catch(()=>{})`
 * that polygram had before meant we'd keep hammering the API for the
 * duration of the (already-doomed) turn — hundreds of failed requests that
 * chip away at rate-limit budget and drown real signal in logs.
 *
 * Fix (mirrors OpenClaw's createTelegramSendChatActionHandler pattern):
 * per-chat circuit breaker with exponential backoff. After N consecutive
 * 401s we suspend for this chat entirely — no more typing pings until the
 * next successful turn resets the counter.
 *
 * State is per-chat so one dead chat doesn't silence the bot everywhere.
 * We keep it in-memory (not DB-persisted) — restart clears and we'll find
 * out again the first time we try; the cost of being re-wrong is just a
 * handful of 401s, not worth persisting.
 */

const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_MAX_CONSECUTIVE_401 = 10;
const DEFAULT_MAX_BACKOFF_MS = 300_000; // 5 min — matches OpenClaw

// Shared state keyed by chat_id. Exported via resetChatTypingState() for tests.
const chatState = new Map();

function getState(chatId) {
  let s = chatState.get(chatId);
  if (!s) {
    s = { failures: 0, suspendedUntil: 0 };
    chatState.set(chatId, s);
  }
  return s;
}

function isAuthFailure(err) {
  const code = err?.error_code ?? err?.status;
  const desc = err?.description || err?.message || '';
  return code === 401 || code === 403 || /Forbidden|Unauthorized|bot was blocked|chat not found/i.test(desc);
}

// Exponential backoff: 1s, 2s, 4s, 8s, …, capped at maxBackoffMs.
function backoffDelay(failures, maxBackoffMs) {
  const ms = Math.min(maxBackoffMs, 1000 * Math.pow(2, Math.max(0, failures - 1)));
  return ms;
}

/**
 * Start the typing-indicator loop for a chat. Returns a stop function.
 *
 * @param {object} deps
 * @param {import('grammy').Bot} deps.bot
 * @param {string|number} deps.chatId
 * @param {string} [deps.threadId]
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.maxConsecutive401]
 * @param {number} [deps.maxBackoffMs]
 * @param {object} [deps.logger] - { error, log } — default console
 * @param {(evt: {kind: string, chat_id: string, detail?: object}) => void} [deps.onEvent]
 *     Hook for polygram's `events` DB log.
 */
function startTyping({
  bot, chatId, threadId,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxConsecutive401 = DEFAULT_MAX_CONSECUTIVE_401,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  logger = console,
  onEvent = null,
} = {}) {
  const key = String(chatId);
  const opts = threadId ? { message_thread_id: threadId } : {};
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const s = getState(key);
    if (s.suspendedUntil > Date.now()) return;
    try {
      await bot.api.sendChatAction(chatId, 'typing', opts);
      // Success — reset failure counter.
      if (s.failures > 0) {
        onEvent?.({ kind: 'typing-recovered', chat_id: key, detail: { after_failures: s.failures } });
      }
      s.failures = 0;
      s.suspendedUntil = 0;
    } catch (err) {
      if (!isAuthFailure(err)) {
        // Other errors (network blip, 500, etc.): don't open the circuit.
        // Let the next tick try again. Log once at high verbosity.
        logger.error?.(`[typing] ${key}: ${err?.description || err?.message}`);
        return;
      }
      s.failures += 1;
      if (s.failures >= maxConsecutive401) {
        // Circuit fully open — suspend for the maxBackoffMs window; won't
        // try again until then. Successful turns (or a subsequent tick past
        // the suspend window) will test the waters.
        s.suspendedUntil = Date.now() + maxBackoffMs;
        onEvent?.({ kind: 'typing-suspended', chat_id: key, detail: {
          failures: s.failures, suspend_ms: maxBackoffMs,
        } });
        logger.error?.(`[typing] ${key}: ${s.failures} consecutive auth failures; suspending ${maxBackoffMs / 1000}s`);
      } else {
        // Partial open — back off for an exponentially growing window.
        s.suspendedUntil = Date.now() + backoffDelay(s.failures, maxBackoffMs);
      }
    }
  };

  // Fire once immediately, then every intervalMs.
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}

function resetChatTypingState(chatId) {
  if (chatId == null) chatState.clear();
  else chatState.delete(String(chatId));
}

function getChatTypingState(chatId) {
  return chatState.get(String(chatId));
}

module.exports = {
  startTyping,
  resetChatTypingState,
  getChatTypingState,
  isAuthFailure,
  backoffDelay,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_401,
  DEFAULT_MAX_BACKOFF_MS,
};
