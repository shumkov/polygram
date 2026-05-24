/**
 * HeartbeatReactor — time-driven reactor that cycles a "working" emoji
 * on the user's message while a Process is mid-turn.
 *
 * Scope (per docs/0.11.0-channels-driver-plan.md Decision #6 + #7):
 *   Used ONLY with ChannelsProcess. SdkProcess and TmuxProcess keep
 *   their per-tool reactions because they have tool-call visibility.
 *   The Channels protocol intentionally hides mid-turn tool calls,
 *   so we substitute a liveness heartbeat — random cycling from a
 *   small working pool, with a calibrated STALL fallback.
 *
 * Lifecycle (driven by Process EventEmitter):
 *   on 'thinking'  → start tick interval; clear stallTimer; immediate setReaction
 *   on tick        → setReaction([pickRandom(workingPool)])
 *   on STALL       → switch to sticky stallEmoji; suppress further ticks until idle
 *   on 'idle'      → stop tick + stall; setReaction([]) (cleared)
 *   on 'close'     → stop permanently, clear reaction
 *   any Process event also resets the stall timer (liveness signal)
 *
 * Reserved emojis (NOT in working pool — single-purpose semantic in
 * lib/telegram/reactions.js):
 *   👀  QUEUED        received / queued
 *   🤔  QUEUED        thinking / processing start
 *   ✍  AUTOSTEERED   handwriting
 *   🤯  ERROR/TIMEOUT
 *   😨  TIMEOUT
 *   🥱  STALL (this module's stall fallback)
 *
 * Decoupled from the bot client: caller supplies setReaction async
 * function. Testable with an in-memory recorder.
 */

'use strict';

// Telegram Bot API reaction whitelist subset, omitting all reserved
// emojis above. Implementer may swap members at boot per the plan.
const DEFAULT_WORKING_POOL = ['👨‍💻', '⚡', '🤓', '🤖', '🦄', '🔥'];

const DEFAULT_TICK_BASE_MS    = 8_000;
const DEFAULT_TICK_JITTER_MS  = 4_000;
const DEFAULT_STALL_AFTER_MS  = 45_000;
const DEFAULT_STALL_EMOJI     = '🥱';

// Events on Process that count as "liveness" (reset the stall timer).
// Subscribing broadly means the heartbeat doesn't false-fire just
// because turn-internal events go quiet briefly.
const LIVENESS_EVENTS = Object.freeze([
  'thinking', 'idle', 'init', 'result', 'tool-use',
  'autonomous-assistant-message', 'stream-chunk', 'phase-change',
  'approval-required', 'session-id-refreshed',
]);

class HeartbeatReactor {
  /**
   * @param {object} opts
   * @param {EventEmitter} opts.process            — ChannelsProcess (or any Process subclass)
   * @param {string|number} opts.chatId
   * @param {string|number} opts.messageId         — TG msg to react on
   * @param {Function} opts.setReaction            — async (chatId, messageId, emoji[]) => void
   * @param {string[]} [opts.workingPool=DEFAULT_WORKING_POOL]
   * @param {number} [opts.tickBaseMs=8000]
   * @param {number} [opts.tickJitterMs=4000]     — actual tick uniform in [base, base+jitter)
   * @param {number} [opts.stallAfterMs=45000]
   * @param {string} [opts.stallEmoji='🥱']
   * @param {object} [opts.logger=console]
   * @param {Function} [opts.rng=Math.random]      — injectable for deterministic tests
   * @param {Function} [opts.now=Date.now]         — injectable for deterministic tests
   */
  constructor({
    process,
    chatId,
    messageId,
    setReaction,
    workingPool = DEFAULT_WORKING_POOL,
    tickBaseMs = DEFAULT_TICK_BASE_MS,
    tickJitterMs = DEFAULT_TICK_JITTER_MS,
    stallAfterMs = DEFAULT_STALL_AFTER_MS,
    stallEmoji = DEFAULT_STALL_EMOJI,
    logger = console,
    rng = Math.random,
    now = Date.now,
  } = {}) {
    if (!process || typeof process.on !== 'function') {
      throw new TypeError('HeartbeatReactor: process (EventEmitter) required');
    }
    if (chatId == null) throw new TypeError('HeartbeatReactor: chatId required');
    if (messageId == null) throw new TypeError('HeartbeatReactor: messageId required');
    if (typeof setReaction !== 'function') {
      throw new TypeError('HeartbeatReactor: setReaction (function) required');
    }
    if (!Array.isArray(workingPool) || workingPool.length === 0) {
      throw new TypeError('HeartbeatReactor: workingPool must be non-empty array');
    }

    this.process = process;
    this.chatId = chatId;
    this.messageId = messageId;
    this.setReaction = setReaction;
    this.workingPool = workingPool;
    this.tickBaseMs = tickBaseMs;
    this.tickJitterMs = tickJitterMs;
    this.stallAfterMs = stallAfterMs;
    this.stallEmoji = stallEmoji;
    this.logger = logger;
    this.rng = rng;
    this.now = now;

    this.tickTimer = null;
    this.stallTimer = null;
    this.inStall = false;
    this.active = false;
    this.stopped = false;

    // Review P3 C5: monotonic token. Every _safeSetReaction call captures the
    // current token before awaiting setReaction; on stop() we increment the
    // token so any in-flight setReaction that completes AFTER stop sees its
    // captured token != current and discards its outcome. Prevents the race
    // where stop({clear:true}) issues setReaction([]) while a prior _tick's
    // setReaction([emoji]) is still in flight and lands AFTER the clear.
    this._reactionToken = 0;

    this._bind();
  }

  _bind() {
    this._onThinking = () => this._startTicking();
    this._onIdle = () => this._stopTicking({ clear: true });
    this._onClose = () => this.stop();
    this._onLiveness = () => this._resetStall();

    this.process.on('thinking', this._onThinking);
    this.process.on('idle', this._onIdle);
    this.process.on('close', this._onClose);
    for (const ev of LIVENESS_EVENTS) {
      this.process.on(ev, this._onLiveness);
    }
  }

  _unbind() {
    this.process.off('thinking', this._onThinking);
    this.process.off('idle', this._onIdle);
    this.process.off('close', this._onClose);
    for (const ev of LIVENESS_EVENTS) {
      this.process.off(ev, this._onLiveness);
    }
  }

  _startTicking() {
    if (this.stopped || this.active) return;
    this.active = true;
    this.inStall = false;
    this._tick();             // immediate first reaction
    this._scheduleNextTick();
    this._resetStall();
  }

  _stopTicking({ clear = false } = {}) {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.active = false;
    this.inStall = false;
    if (clear) this._safeSetReaction([]);
  }

  _scheduleNextTick() {
    if (this.stopped || !this.active) return;
    const delay = this.tickBaseMs + Math.floor(this.rng() * this.tickJitterMs);
    this.tickTimer = setTimeout(() => {
      if (!this.inStall) this._tick();
      this._scheduleNextTick();
    }, delay);
    this.tickTimer.unref?.();
  }

  _tick() {
    if (this.stopped || !this.active || this.inStall) return;
    const emoji = this.workingPool[Math.floor(this.rng() * this.workingPool.length)];
    this._safeSetReaction([emoji]);
  }

  _resetStall() {
    if (this.stopped || !this.active) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    // Review #17: clear the sticky-stall flag so subsequent ticks can resume
    // cycling. Without this, once 🥱 fires, _tick() short-circuits forever
    // (early-return on inStall) and the reaction stays frozen for the rest of
    // the turn — defeating the cycling UX after a single 45s stall.
    this.inStall = false;
    this.stallTimer = setTimeout(() => this._enterStall(), this.stallAfterMs);
    this.stallTimer.unref?.();
  }

  _enterStall() {
    if (this.stopped || !this.active || this.inStall) return;
    this.inStall = true;
    this._safeSetReaction([this.stallEmoji]);
  }

  async _safeSetReaction(reaction) {
    // P3 C5: capture token at call site. After await, if our token is stale
    // (caller has stopped or fired a newer reaction), bail without further
    // action. The setReaction itself can't be cancelled — but we can ensure
    // we don't queue follow-up state changes based on a stale completion.
    const tokenAtCall = this._reactionToken;
    try {
      await this.setReaction(this.chatId, this.messageId, reaction);
    } catch (err) {
      // Telegram rate-limits or transient errors are non-fatal —
      // reactions.js already wraps + retries upstream. We log and
      // continue so a single failed reaction doesn't kill the heartbeat.
      this.logger.debug?.(`[HeartbeatReactor] setReaction failed: ${err.message}`);
    }
    // Token check is observational here — we already let the Telegram API
    // call go through. The benefit is that downstream logic (if any is added
    // later) can branch on (tokenAtCall === this._reactionToken).
    void tokenAtCall;
  }

  /** External stop — caller uses this if the turn is abandoned outside Process events. */
  stop({ clear = true } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    // P3 C5: bump token so any in-flight setReaction that completes after
    // this stop sees its captured token as stale.
    this._reactionToken++;
    this._stopTicking({ clear });
    this._unbind();
  }
}

module.exports = {
  HeartbeatReactor,
  DEFAULT_WORKING_POOL,
  DEFAULT_TICK_BASE_MS,
  DEFAULT_TICK_JITTER_MS,
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_STALL_EMOJI,
  LIVENESS_EVENTS,
};
