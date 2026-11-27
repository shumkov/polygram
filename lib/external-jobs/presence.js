'use strict';

// What a chat shows while a job turn runs: typing, and on the card the job
// came from (a mailbox message's or a notice's card in the job's own chat)
// the status reactions a human message gets, ending 👍 so a silent turn still
// shows that it finished. Display only: nothing here may fail the job or
// change its delivery state, so every step is guarded and every Telegram
// error is logged and dropped.

const { startTyping } = require('../telegram/typing');
const { createReactionManager, STATES } = require('../telegram/reactions');
const { applyReactionToMessages } = require('../telegram/album-reactions');
const { classifyTurnEndError } = require('../error/classify');

// How long a job waits for the chat's reaction allowlist before it uses the
// default set. The answer is cached per chat, so only a chat's first job asks.
const ALLOWLIST_TIMEOUT_MS = 2000;

const sameThread = (a, b) => String(a ?? '') === String(b ?? '');
// A turn ended from outside (a stop, a /reload, a shutdown, a closed
// process) clears the card, as a stopped human turn does.
const ENDED_FROM_OUTSIDE = new Set(['INTERRUPTED', 'KILLED', 'PROCESS_CLOSED']);
// What a lookup that did not answer in time returns.
const UNKNOWN = Symbol('allowlist unknown');
const errorText = (error) => error?.code || error?.name || 'Error';

function createJobPresence({ bot, tg, botName, getAllowlist = async () => null, allowlistTimeoutMs = ALLOWLIST_TIMEOUT_MS,
  typingIntervalMs = undefined, logEvent = () => {}, logger = console }) {
  const event = (kind, detail) => { try { logEvent(kind, detail); } catch { /* Telemetry is best effort. */ } };
  // The chat's allowed reactions, null for all, or UNKNOWN when the chat
  // does not answer in time or the lookup fails.
  async function allowlist(chatId) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => getAllowlist(chatId)),
        new Promise((resolve) => { timer = setTimeout(resolve, allowlistTimeoutMs, UNKNOWN); timer.unref?.(); }),
      ]);
    } catch { return UNKNOWN; } finally { clearTimeout(timer); }
  }

  // `card` is null for a job without one, else a promise of the card's landed
  // message ({ chatId, threadId, messageId }) or null. The card may still be
  // posting: reactions wait for it and land in order. Resolves a handle whose
  // `context` rides the turn (the same `typing` and `reactor` fields a human
  // turn's context has), whose `begin` runs when the turn's prompt is sent and
  // whose `end` runs when the turn settles. Never rejects; begin and end never
  // throw.
  async function prepare(job, { card = null } = {}) {
    const { chatId, threadId, sessionKey } = job.target;
    const label = `[external-jobs] ${job.requestId}`;
    const fail = (what, error) => logger.error?.(`${label} ${what}: ${errorText(error)}${error?.description ? ` ${error.description}` : ''}`);
    let reactor = null;
    // A finished turn shows 👍; where 👍 is not allowed the reactor would fall
    // back to 👀, which reads as "queued", and where that is unknown a
    // refused 👍 would leave the working face behind, so the card is left
    // bare instead.
    let doneAllowed = true;
    if (card) {
      // Only a card in the job's own chat and topic.
      const landed = Promise.resolve(card)
        .then((at) => (at && String(at.chatId) === String(chatId) && sameThread(at.threadId, threadId) ? at : null), () => null);
      // The face the card should show now, and the one it shows. A card that
      // lands late gets its current face, not every face it missed.
      let wanted = null;
      let shown = null;
      try {
        const answer = await allowlist(chatId);
        const available = answer === UNKNOWN ? null : answer;
        doneAllowed = answer !== UNKNOWN && (!available || new Set(available).has(STATES.DONE.chain[0]));
        reactor = createReactionManager({
          apply: async (emoji) => {
            const at = await landed;
            if (!at || emoji !== wanted || emoji === shown) return;
            await applyReactionToMessages({ tg, bot, chatId: at.chatId, msgIds: [at.messageId], emoji, botName });
            shown = emoji;
          },
          availableEmojis: available,
          logError: (line) => logger.error?.(`${label} card reaction: ${line}`),
          onStateChange: ({ fromState, toState, fromEmoji, toEmoji, source, ts }) => {
            wanted = toEmoji;
            void landed.then((at) => event('reactor-state', { chat_id: chatId, msg_id: at?.messageId ?? null, session_key: sessionKey,
              request_id: job.requestId, from_state: fromState, to_state: toState, from_emoji: fromEmoji, to_emoji: toEmoji, source, ts }));
          },
        });
      } catch (error) { fail('card reaction unavailable', error); reactor = null; }
    }
    let typing = null;
    let begun = false;
    let ended = false;
    return {
      context: {
        ...(reactor ? { reactor } : {}),
        // A question to a person pauses typing until it is answered.
        typing: { pause: () => typing?.pause?.(), resume: () => typing?.resume?.() },
      },
      begin() {
        if (begun || ended) return;
        begun = true;
        try {
          typing = startTyping({ bot, chatId, ...(threadId == null ? {} : { threadId: Number(threadId) }),
            ...(typingIntervalMs ? { intervalMs: typingIntervalMs } : {}),
            logger: { error: (line) => logger.error?.(`${label} typing: ${line}`) },
            onEvent: (e) => event(e.kind, { bot: botName, chat_id: e.chat_id, request_id: job.requestId, ...(e.detail || {}) }) });
        } catch (error) { fail('typing unavailable', error); }
        try { reactor?.setState('THINKING'); } catch (error) { fail('card reaction failed', error); }
        event('job-presence', { request_id: job.requestId, session_key: sessionKey, card: reactor !== null });
      },
      // The card's last face: 👍 for a finished turn, report or not; 🤯 for a
      // failed one. A turn whose send rejected ends as a human turn's does
      // (😨 for a timeout, 🤯 for another error), and one stopped from
      // outside or untracked shows none. Neither call waits for Telegram. An
      // end before the turn began closes the handle without showing anything.
      end(outcome, error = null) {
        if (ended) return;
        ended = true;
        if (!begun) return;
        try { typing?.(); } catch (stopError) { fail('typing stop failed', stopError); }
        if (!reactor) return;
        try {
          const last = outcome === 'succeeded' ? (doneAllowed ? 'DONE' : null)
            : outcome === 'failed' ? 'ERROR'
              : outcome === 'unknown' && error && !ENDED_FROM_OUTSIDE.has(error.code) ? classifyTurnEndError(error).reactorState : null;
          if (last) void reactor.setState(last);
          else void reactor.clear();
        } catch (reactionError) { fail('card reaction failed', reactionError); }
        try { reactor.stop(); } catch (stopError) { fail('card reaction stop failed', stopError); }
      },
    };
  }
  return { prepare };
}

module.exports = { createJobPresence, ALLOWLIST_TIMEOUT_MS };
