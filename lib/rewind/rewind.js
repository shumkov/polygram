'use strict';

/**
 * `/rewind` command — P1 (0.13). Reply to a message with `/rewind` to rewind the
 * conversation to just before it. P1 ships the plumbing: detect → gate (operator +
 * message-ownership, per the 2026-06-09 security review) → defer to turn-end → confirm.
 * The actual transcript fork is the **injected `executeRewind`** — P2 provides the real
 * one (see docs/0.13-rewind-design.md, B-safe). P0.6 proved the fork mechanism works.
 *
 * Scope boundary the confirmation states out loud: a rewind reverts the CONVERSATION,
 * not real-world side-effects (Drive files, Sheets, emails already created persist).
 */

// `/rewind` or `/rewind@botname`, alone on the line (no args).
const REWIND_RE = /^\/rewind(?:@\w+)?\s*$/i;

// Backstop for a deferred rewind whose proc emits neither 'idle' nor 'close'. Above the 30-min
// absolute turn cap so a legitimately long in-flight turn finishes (emitting 'idle') first.
const DEFER_TIMEOUT_MS = 31 * 60 * 1000;

function isRewindCommand(text) {
  return REWIND_RE.test(String(text || '').trim());
}

/**
 * Validate a `/rewind` request. Returns { ok, reason }. Gate order:
 *   1. must reply-to a message (the rewind target M)
 *   2. the chat must be rewind-SAFE — a DM or an isolate-topics group. A shared (non-isolated)
 *      group runs ONE session across all topics, so a rewind there would blast every topic and
 *      user; refuse it. (Caller computes `rewindSafe`.)
 *   3. access policy: the operator/admin is always allowed; any *paired* user is allowed ONLY
 *      when the chat opted in with `rewindAccess: 'paired'`. Default ('operator') is operator-only
 *      — NOT "any paired user" (the security-review degradation when operatorUserId was unset).
 *   4. M must be the sender's OWN message or one of the bot's own bubbles — never another user's
 *      (else an allowed user could rewind to anyone's message).
 *
 * @param {object} a
 * @param {object} a.msg
 * @param {string} a.botUsername
 * @param {boolean} a.rewindSafe          chat is a DM OR an isolateTopics group (caller computes)
 * @param {boolean} a.isOperatorIdentity  sender is operatorUserId or the admin user (caller computes)
 * @param {boolean} a.paired              sender has a live pairing in this chat
 * @param {'operator'|'paired'} [a.accessMode='operator']
 */
function gateRewindRequest({ msg, botUsername, rewindSafe, isOperatorIdentity, paired, accessMode = 'operator' } = {}) {
  const reply = msg?.reply_to_message;
  if (!reply) return { ok: false, reason: 'reply to the message you want to rewind to, then send /rewind' };
  if (!rewindSafe) {
    return { ok: false, reason: "rewind isn't available in a shared group chat — turn on per-topic isolation (isolateTopics) so a rewind only affects one topic, not everyone" };
  }
  const allowed = !!isOperatorIdentity || (accessMode === 'paired' && !!paired);
  if (!allowed) {
    return { ok: false, reason: accessMode === 'paired' ? 'only paired members can rewind this chat' : 'only the operator can rewind this chat' };
  }
  const fromId = reply.from?.id;
  const isBotMsg = !!botUsername && reply.from?.username === botUsername;
  const isOwnMsg = fromId != null && msg.from?.id != null && Number(fromId) === Number(msg.from.id);
  if (!isBotMsg && !isOwnMsg) {
    return { ok: false, reason: 'you can only rewind to your own messages or mine' };
  }
  return { ok: true };
}

function previewOf(text) {
  const first = String(text || '').split('\n')[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : (first || '(no text)');
}

/**
 * @param {object} deps
 * @param {object} deps.pm           — ProcessManager (uses pm.get(sessionKey) + proc 'idle')
 * @param {Function} deps.tg         — tg(bot, method, params, meta) sender
 * @param {object} deps.bot
 * @param {string} deps.botName
 * @param {(req) => Promise<{ok:boolean,error?:string,droppedCount?:number}>} deps.executeRewind
 *        — the transcript fork (P2). Injected; P1 wires a stub.
 * @param {Function} [deps.logEvent]
 * @param {object} [deps.logger]
 */
function createRewindHandler({ pm, tg, bot, botName = 'bot', executeRewind, logEvent = () => {}, logger = console } = {}) {
  if (typeof executeRewind !== 'function') throw new TypeError('createRewindHandler: executeRewind required');

  function ack(chatId, threadId, text) {
    return tg(bot, 'sendMessage', { chat_id: chatId, text, ...(threadId && { message_thread_id: threadId }) },
      { source: 'rewind', botName })
      .catch((e) => logger.error?.(`[${botName}] rewind ack failed: ${e.message}`));
  }

  async function run(req) {
    let result;
    try {
      result = await executeRewind(req);
    } catch (e) {
      logger.error?.(`[${botName}] rewind execute threw for ${req.sessionKey}: ${e.message}`);
      result = { ok: false, error: e.message };
    }
    if (result && result.ok) {
      const n = result.droppedCount;
      await ack(req.chatId, req.threadId,
        `⏪ Rewound to: «${previewOf(req.target.text)}»` + (n != null ? ` — ${n} message(s) dropped.` : '.') +
        (result.warning ? `\n⚠️ ${result.warning}` : '') +
        `\nNote: anything I already created (files, Sheets, emails) still exists — say the word to reverse it.`);
      logEvent('rewind-done', { session_key: req.sessionKey, target_msg_id: req.target.msg_id });
    } else {
      await ack(req.chatId, req.threadId, `↩️ couldn't rewind — ${(result && result.error) || 'unknown error'}`);
      logEvent('rewind-failed', { session_key: req.sessionKey, target_msg_id: req.target.msg_id, error_code: (result && result.error) ? 'rewind-failed' : null });
    }
  }

  // Defer to turn-end: a rewind kills+resumes the session, so it must never run mid-turn. If a
  // turn is in flight, run on the proc's next 'idle'. If the proc is torn down first — 'close'
  // or 'session-reset' (kill / LRU evict / bridge disconnect / model change), none of which
  // emit 'idle' — tell the operator instead of leaving them hanging after the "queued" ack
  // (Finding D). DEFER_TIMEOUT_MS backstops a proc that somehow emits neither (it sits above
  // the 30-min absolute turn cap, so a legitimately long turn still completes first).
  function schedule(req) {
    const proc = pm && typeof pm.get === 'function' ? pm.get(req.sessionKey) : null;
    if (proc && proc.inFlight) {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        proc.removeListener('idle', onIdle);
        proc.removeListener('close', onDead);
        proc.removeListener('session-reset', onDead);
      };
      const onIdle = () => { if (settled) return; settled = true; cleanup(); run(req).catch(() => {}); };
      const onDead = () => {
        if (settled) return; settled = true; cleanup();
        ack(req.chatId, req.threadId, "↩️ couldn't rewind — the session ended before the turn finished. Reply /rewind again.");
        logEvent('rewind-deferred-lost', { session_key: req.sessionKey, target_msg_id: req.target.msg_id });
      };
      const timer = setTimeout(() => {
        if (settled) return; settled = true; cleanup();
        ack(req.chatId, req.threadId, "↩️ couldn't rewind — timed out waiting for the current turn to finish. Reply /rewind again.");
        logEvent('rewind-deferred-timeout', { session_key: req.sessionKey, target_msg_id: req.target.msg_id });
      }, DEFER_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      proc.once('idle', onIdle);
      proc.once('close', onDead);
      proc.once('session-reset', onDead);
      return 'deferred';
    }
    setImmediate(() => { run(req).catch(() => {}); });
    return 'now';
  }

  /**
   * Dispatcher hook. Returns { consumed }. Consumes any `/rewind` (valid → queued, invalid →
   * the operator is told why) so it never starts a normal turn.
   */
  async function tryConsume({
    sessionKey,
    chatId,
    threadId = null,
    msg,
    cleanText,
    runtime = 'claude',
    botUsername,
    rewindSafe,
    isOperatorIdentity,
    paired,
    accessMode,
  }) {
    if (!isRewindCommand(cleanText)) return { consumed: false };
    if (runtime === 'codex') {
      await ack(
        chatId,
        threadId,
        'Codex thread rewind is not supported yet; the active Codex thread was unchanged.',
      );
      return { consumed: true };
    }
    const gate = gateRewindRequest({ msg, botUsername, rewindSafe, isOperatorIdentity, paired, accessMode });
    if (!gate.ok) {
      await ack(chatId, threadId, `↩️ ${gate.reason}`);
      return { consumed: true };
    }
    const reply = msg.reply_to_message;
    const req = {
      sessionKey, chatId, threadId,
      target: { msg_id: reply.message_id, text: reply.text || reply.caption || '', ts: reply.date },
    };
    const when = schedule(req);
    await ack(chatId, threadId, when === 'deferred'
      ? '⏳ Rewind queued — I’ll run it the moment the current turn finishes.'
      : '⏪ Rewinding…');
    logEvent('rewind-requested', { session_key: sessionKey, target_msg_id: req.target.msg_id, when });
    return { consumed: true };
  }

  return { tryConsume };
}

module.exports = { isRewindCommand, gateRewindRequest, previewOf, createRewindHandler };
