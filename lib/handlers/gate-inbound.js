'use strict';

/**
 * gateInbound — the ONE intake gate (0.13 D5, docs/0.13-channels-lifecycle-design.md §3 D4+D5).
 *
 * Pre-0.13, polygram had four gate depths (seam S11): the fresh-message chain in
 * dispatchRegularMessage, edit-redelivery's bare shouldHandle, the mid-turn edit
 * injector's none, and boot-replay's none. The divergences were themselves bugs:
 * an edit to "/stop" was injected into the very turn it tried to kill; an edit
 * during a free-text "Other" capture never became the answer; any group member's
 * bare "stop" aborted others' turns pre-gate.
 *
 * Every entry point now runs the same ordered chain, with a tier flag declaring
 * per stage whether it EVALUATES, EXECUTES side effects, or is SKIPPED:
 *
 *   stage            | fresh            | edit             | redelivery
 *   -----------------|------------------|------------------|--------------------------
 *   abort            | eval + execute*  | eval + execute*  | eval, never exec → blocked
 *   admin / pair     | eval + dispatch  | eval + dispatch  | eval, never exec → blocked
 *   rewind           | eval + execute   | skip             | skip
 *   question-consume | eval + execute   | eval + execute   | skip (already consumed once)
 *   shouldHandle     | evaluate         | evaluate         | evaluate
 *   final            | dispatch         | return 'pass'    | return 'pass'
 *
 *   * identity-gated: DM ‖ paired ‖ @mention ‖ reply-to-bot. Closes the
 *     pre-existing bystander-abort hole (abort ran before shouldHandle with
 *     zero identity checks — any group member's "stop" killed the in-flight
 *     turn) BEFORE the edit tier gains abort semantics.
 *
 * Return shape: { action: 'dispatched'|'handled'|'blocked'|'pass', stage?, reason? }
 *   dispatched — handed to dispatchHandleMessage (fresh final, admin stage)
 *   handled    — a stage consumed it (abort executed, question answered, rewind)
 *   blocked    — gate dropped it (caller logs; redelivery callers emit no-redeliver)
 *   pass       — edit/redelivery tiers: caller owns the next step
 *
 * Late-bound deps are getters (botUsername/mentionRe are assigned after bot
 * init; rewind/question handlers are wired late in main()) — the established
 * `let x = null; wired in main()` pattern, made explicit.
 */

const ADMIN_CMD_RE = /^\/(model|effort|config|pair-code|pairings|unpair|new|reset|context|compact)(\s|$)/;
const PAIR_CLAIM_RE = /^\/pair\s+\S+/;

function createGateInbound({
  config,
  getBotUsername,
  getMentionRe,
  pairings = null,
  isAbortRequest,
  handleAbortIfRequested,
  getRewindHandler = () => null,
  isRewindCommand = () => false,
  getQuestionHandlers = () => null,
  shouldHandle,
  getSessionKey,
  dispatchHandleMessage,
  bot,
  botName,
  logEvent = () => {},
  logger = console,
} = {}) {
  if (typeof shouldHandle !== 'function') throw new TypeError('gateInbound: shouldHandle required');
  if (typeof dispatchHandleMessage !== 'function') throw new TypeError('gateInbound: dispatchHandleMessage required');
  if (typeof getSessionKey !== 'function') throw new TypeError('gateInbound: getSessionKey required');

  /**
   * The abort identity gate: is this sender plausibly addressing the BOT
   * (vs a teammate)? DM ‖ paired ‖ @mention ‖ reply-to-bot. Mirrors the
   * shouldHandle signals but is evaluated BEFORE shouldHandle because abort
   * (deliberately) outranks the mention gate for addressed senders.
   */
  function isAddressedIdentity(msg, chatId) {
    if (msg.chat?.type === 'private') return true;
    const botUsername = getBotUsername?.() || '';
    const text = msg.text || msg.caption || '';
    if (botUsername && text.includes(`@${botUsername}`)) return true;
    if (botUsername && msg.reply_to_message?.from?.username === botUsername) return true;
    if (pairings && msg.from?.id
      && pairings.hasLivePairing({ bot_name: botName, user_id: msg.from.id, chat_id: chatId })) {
      return true;
    }
    // The operator owns the bot — their abort is never a bystander abort, so it
    // outranks the @mention/reply requirement even in a group. Without this, the
    // operator's bare "stop" in a group is silently abort-identity-blocked (prod:
    // chat -1003369922517, 2026-06-15). Same operator predicate /rewind uses
    // below: operatorUserId, else adminChatId ONLY when it's a user id — a
    // negative/group adminChatId never equals a positive sender id, so it grants
    // no bypass (fail-safe). Narrow: only the operator, not every group member.
    const opId = config.bot?.operatorUserId;
    const adminChatId = config.bot?.adminChatId;
    const operatorUid = opId != null ? Number(opId) : (adminChatId != null ? Number(adminChatId) : null);
    if (operatorUid != null && msg.from?.id != null && Number(msg.from.id) === operatorUid) return true;
    return false;
  }

  return async function gateInbound(msg, { tier = 'fresh' } = {}) {
    const chatId = msg.chat.id.toString();
    const chatConfig = config.chats[chatId];
    if (!chatConfig) return { action: 'blocked', stage: 'chat', reason: 'unconfigured chat' };

    const mentionRe = getMentionRe?.();
    const rawText = msg.text || '';
    const cleanText = mentionRe ? rawText.replace(mentionRe, '').trim() : rawText.trim();
    const threadId = msg.message_thread_id?.toString();
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);

    // ── abort ────────────────────────────────────────────────────────────
    if (typeof isAbortRequest === 'function' && isAbortRequest(cleanText)) {
      if (tier === 'redelivery') {
        // An auto-redelivered abort would execute in a context the user never
        // intended (their original "stop" targeted work long since settled).
        return { action: 'blocked', stage: 'abort', reason: 'abort-shaped content is never auto-re-executed' };
      }
      if (!isAddressedIdentity(msg, chatId)) {
        logEvent('abort-identity-blocked', {
          chat_id: chatId, msg_id: msg.message_id, user_id: msg.from?.id ?? null, tier,
        });
        return { action: 'blocked', stage: 'abort', reason: 'abort from unaddressed sender' };
      }
      const handled = await handleAbortIfRequested(msg, chatId, chatConfig, cleanText);
      if (handled) return { action: 'handled', stage: 'abort' };
      // The predicate matched but the handler declined (defensive) — fall through.
    }

    // ── admin command / pair claim ───────────────────────────────────────
    const botAllowsCommands = !!config.bot?.allowConfigCommands;
    const isAdminCmd = botAllowsCommands && ADMIN_CMD_RE.test(cleanText);
    const isPairClaim = PAIR_CLAIM_RE.test(cleanText);
    if (isAdminCmd || isPairClaim) {
      if (tier === 'redelivery') {
        return { action: 'blocked', stage: 'admin', reason: 'admin/pair-shaped content is never auto-re-executed' };
      }
      msg.text = cleanText;
      // 0.13 D5: through the dispatcher wrapper — the admin path gains
      // handler-error events, the in-flight counter, and terminal
      // handler_status on throw (pre-P2 it called bare handleMessage and
      // errors bubbled to grammy's bot.catch with the row left 'dispatched').
      dispatchHandleMessage(sessionKey, chatId, msg, bot);
      return { action: 'dispatched', stage: 'admin' };
    }

    // ── /rewind ── fresh only (an edited or replayed /rewind is nonsensical) ──
    if (tier === 'fresh') {
      const rewindHandler = getRewindHandler?.();
      if (rewindHandler && isRewindCommand(cleanText)) {
        try {
          // Operator identity: explicit operatorUserId, else the admin user — a PRIVATE
          // adminChatId equals that user's Telegram id. A group adminChatId (negative) is
          // not a user id → never matches a positive sender id → default-deny.
          const opId = config.bot?.operatorUserId;
          const adminChatId = config.bot?.adminChatId;
          const operatorUid = opId != null ? Number(opId) : (adminChatId != null ? Number(adminChatId) : null);
          const isOperatorIdentity = operatorUid != null && msg.from?.id != null && Number(msg.from.id) === operatorUid;
          const paired = pairings && msg.from?.id
            ? pairings.hasLivePairing({ bot_name: botName, user_id: msg.from.id, chat_id: chatId })
            : false;
          const accessMode = chatConfig?.rewindAccess === 'paired' ? 'paired' : 'operator';
          const rewindSafe = msg.chat?.type === 'private' || chatConfig?.isolateTopics === true;
          const r = await rewindHandler.tryConsume({
            sessionKey, chatId, threadId, msg, cleanText,
            botUsername: getBotUsername?.() || '',
            rewindSafe, isOperatorIdentity, paired, accessMode,
          });
          if (r.consumed) return { action: 'handled', stage: 'rewind' };
        } catch (err) {
          // The text IS a recognized /rewind — on an internal error, consume it
          // anyway; falling through would send "/rewind" to claude as a prompt.
          logger.error?.(`[${botName}] rewind tryConsume failed: ${err?.message || err}`);
          return { action: 'handled', stage: 'rewind', reason: 'consumed-on-error' };
        }
      }
    }

    // ── question-consume / ownsOpenOther ── fresh + edit; redelivery skips
    // (a replayed row already had its question-capture moment when fresh)
    const questionHandlers = tier !== 'redelivery' ? getQuestionHandlers?.() : null;
    const ownsOpenOther = questionHandlers
      ? questionHandlers.isAwaitingOtherFrom(sessionKey, msg.from?.id)
      : false;

    // ── shouldHandle (mention/pairing gate) ── all tiers
    if (!ownsOpenOther && !shouldHandle(msg, chatConfig, getBotUsername?.() || '')) {
      return { action: 'blocked', stage: 'shouldHandle' };
    }
    if (getBotUsername?.()) msg.text = cleanText;

    if (questionHandlers) {
      const r = await questionHandlers.tryConsumeAsAnswer({ sessionKey, fromId: msg.from?.id, text: cleanText });
      if (r.consumed) return { action: 'handled', stage: 'question-consume' };
    }

    // ── final ──
    if (tier !== 'fresh') return { action: 'pass', sessionKey, chatId, cleanText };
    dispatchHandleMessage(sessionKey, chatId, msg, bot);
    return { action: 'dispatched' };
  };
}

module.exports = { createGateInbound, ADMIN_CMD_RE, PAIR_CLAIM_RE };
