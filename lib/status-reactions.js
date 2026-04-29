/**
 * Status-reaction state machine.
 *
 * Goal: give users a silent, non-intrusive progress signal during a turn.
 * Telegram bot reactions are delivered quietly (no notification), update
 * in place, and one emoji per message. Perfect for state like
 * "thinking → coding → web → done".
 *
 * The state machine below translates Claude's stream-json event stream
 * into a small set of states, each mapped to an emoji. The caller
 * (usually polygram's handleMessage) holds a ReactionManager instance
 * and calls setState() at transition points.
 *
 * Design choices:
 *   - We pick emojis from Telegram's default-available set so groups
 *     that haven't customised `available_reactions` still work. Callers
 *     can pass an allowlist probed from getChat().available_reactions
 *     for groups that have — we fall back through a chain for each
 *     state until we find an allowed one.
 *   - Rate-limit changes to every 800ms (Telegram allows ~1/s per
 *     message). Intermediate states are dropped.
 *   - Terminal states (DONE/ERROR/TIMEOUT) always flush, ignoring
 *     throttle, so the user sees the final outcome.
 *   - On abort or cleanup we clear the reaction entirely rather than
 *     leaving a stale "thinking" emoji.
 */

// Ordered fallback chains — first emoji is the preferred one; follow-ups
// are progressively safer. All endings in this list are in Telegram's
// default available reactions as of 2026-04.
const STATES = {
  QUEUED:      { label: 'queued',      chain: ['👀', '🤔']       },
  THINKING:    { label: 'thinking',    chain: ['🤔']             },
  CODING:      { label: 'coding',      chain: ['👨‍💻', '✍', '🤔'] },
  WEB:         { label: 'web',         chain: ['⚡', '🔥', '🤔']  },
  TOOL:        { label: 'tool',        chain: ['🔥', '🤔']       },
  WRITING:     { label: 'writing',     chain: ['✍', '🤔']        },
  // 0.8.0-rc.11: terminal "your follow-up was incorporated into the
  // in-flight turn" state. Used by polygram's autosteer block when a
  // mid-turn user message is buffered for the next PostToolBatch
  // injection.
  AUTOSTEERED: { label: 'autosteered', chain: ['✍', '👀']        },
  DONE:        { label: 'done',        chain: ['👍']             },
  ERROR:       { label: 'error',       chain: ['🤯', '🤔']       },
  STALL:       { label: 'stall',       chain: ['🥱', '🤔']       },
  TIMEOUT:     { label: 'timeout',     chain: ['😨', '🤯']       },
};

// Terminal states bypass throttle, disarm stall promotion, and the
// reactor stays at this emoji until explicitly cleared. AUTOSTEERED
// is included so setState('AUTOSTEERED') flushes immediately
// (matters because the autosteer code path returns from
// handleMessage right after — we don't want the apply to be
// scheduled-and-cancelled by reactor.stop in the outer finally).
const TERMINAL_STATES = new Set(['DONE', 'ERROR', 'TIMEOUT', 'AUTOSTEERED']);
const DEFAULT_THROTTLE_MS = 800;
// 0.7.4 (item A): after this long with no setState() call (Claude is
// silently chugging on a long tool / model latency), auto-flip to STALL
// (🥱) so the user has a visible cue that the bot is alive but slow.
// 10s matches OpenClaw's "yawn after 10s of nothing".
const DEFAULT_STALL_MS = 10_000;
// 30s without a heartbeat is "we're worried" territory — promote to
// TIMEOUT (😨) so the user knows it might be stuck. Distinct from the
// pm's 5-minute hard idle timeout, which actually rejects the turn.
const DEFAULT_FREEZE_MS = 30_000;

// Tool name → state classifier. Case-insensitive substring match so we
// don't have to enumerate every existing or future tool. Order matters:
// WEB checks first because "WebFetch" contains "fetch" but should map
// to ⚡, not whatever the generic fetcher gets. Skill-prefixed tools
// (e.g. "mcp__plugin_playwright_playwright__browser_click") are still
// caught by the substring check.
//
// 0.7.4 (item C): pre-fix, anything not exactly matching a tiny regex
// (e.g. WebSearch_v2, custom Bash variants, MCP-namespaced tools) fell
// through to generic TOOL (🔥), losing the more-specific signal. The
// substring match recovers the right state for both built-ins and most
// MCP/skill tools without listing them by name.
function classifyToolName(name) {
  if (typeof name !== 'string' || !name) return 'TOOL';
  const n = name.toLowerCase();
  if (n.includes('web') || n.includes('fetch') || n.includes('browser') || n.includes('search')) return 'WEB';
  // WRITING before CODING: "TodoWrite" contains both "todo" and "write" —
  // we want it to land at ✍ (WRITING), not 👨‍💻 (CODING).
  if (n.includes('todo') || n.includes('task') || n.includes('skill')) return 'WRITING';
  if (n.includes('read') || n.includes('write') || n.includes('edit')
      || n.includes('bash') || n.includes('grep') || n.includes('glob')
      || n.includes('notebook')) return 'CODING';
  return 'TOOL';
}

// 0.7.4 (item J): generic, almost-universally-available fallbacks. Used
// when a group's `available_reactions` allowlist excludes every emoji in
// a state's preferred chain. Better to show *some* reaction (e.g. 👍 for
// "done" in a group that only allows thumbs) than to silently emit
// nothing and leave the user wondering whether the bot is alive.
const GENERIC_FALLBACKS = ['👍', '👀', '🔥'];

/**
 * Resolve the best-available emoji from a chain given an allowlist.
 * If allowlist is null/undefined, assume default-available set and
 * return the first entry.
 */
function resolveEmoji(chain, allowlist) {
  if (!allowlist) return chain[0];
  const allowed = allowlist instanceof Set ? allowlist : new Set(allowlist);
  for (const emoji of chain) {
    if (allowed.has(emoji)) return emoji;
  }
  for (const emoji of GENERIC_FALLBACKS) {
    if (allowed.has(emoji)) return emoji;
  }
  // Nothing in the chain or generic set is allowed — signal "no
  // reaction possible".
  return null;
}

/**
 * Create a reaction manager for a single turn.
 *
 * @param {object} deps
 * @param {(emoji: string|null) => Promise<void>} deps.apply   invoked with the
 *     resolved emoji when state changes. `null` means "clear reaction".
 * @param {string[]|Set<string>|null} [deps.availableEmojis]  allowlist probed
 *     from getChat().available_reactions. Null/undefined = assume defaults.
 * @param {number} [deps.throttleMs]  minimum ms between non-terminal changes.
 * @param {(msg: string) => void} [deps.logError]
 */
function createReactionManager({
  apply,
  availableEmojis = null,
  throttleMs = DEFAULT_THROTTLE_MS,
  stallMs = DEFAULT_STALL_MS,
  freezeMs = DEFAULT_FREEZE_MS,
  logError = () => {},
} = {}) {
  if (typeof apply !== 'function') throw new Error('apply function required');
  let currentState = null;
  let currentEmoji = null;
  let lastFlushTs = 0;
  let lastSetStateTs = 0;
  let pendingTimer = null;
  let stallTimer = null;
  let freezeTimer = null;
  let stopped = false;
  // 0.8.0-rc.11: serialize Telegram setMessageReaction calls. Without
  // this, multiple flush()es race at the network layer because each
  // calls `await apply(emoji)` from a separate stack — Telegram
  // processes them in arbitrary order and the FINAL visible state is
  // whichever apply landed last. Symptom: 👀 stuck on autosteered
  // messages when the QUEUED apply landed AFTER our explicit ✍ apply.
  // Chaining all applies through `applyChain` guarantees they're sent
  // to Telegram in setState() invocation order.
  let applyChain = Promise.resolve();
  // States the auto-stall path may transition to. Once we've already
  // shown STALL or TIMEOUT we don't downgrade or rearm — only an
  // explicit setState() call (Claude resumed) can move us forward.
  const STALL_PROMOTABLE = new Set(['THINKING', 'CODING', 'WEB', 'TOOL', 'WRITING']);

  const flush = async (stateName) => {
    if (stopped && !TERMINAL_STATES.has(stateName)) return;
    const spec = STATES[stateName];
    if (!spec) return;
    const emoji = resolveEmoji(spec.chain, availableEmojis);
    if (emoji === currentEmoji) return;
    currentEmoji = emoji;
    lastFlushTs = Date.now();
    // Chain through applyChain so concurrent flushes are sent to
    // Telegram serially in invocation order. Returning the chain
    // promise lets callers await this specific flush completing.
    const myApply = applyChain.then(async () => {
      try {
        await apply(emoji);
      } catch (err) {
        logError(`reaction apply failed (${stateName} → ${emoji}): ${err?.message || err}`);
      }
    });
    applyChain = myApply;
    return myApply;
  };

  const clearStallTimers = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
  };

  const armStallTimers = () => {
    clearStallTimers();
    if (stopped) return;
    if (!STALL_PROMOTABLE.has(currentState)) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // Re-check state at fire time — caller may have advanced past a
      // promotable state in the interim.
      if (stopped || TERMINAL_STATES.has(currentState)) return;
      if (!STALL_PROMOTABLE.has(currentState)) return;
      flush('STALL');
    }, stallMs);
    stallTimer.unref?.();
    freezeTimer = setTimeout(() => {
      freezeTimer = null;
      if (stopped || TERMINAL_STATES.has(currentState)) return;
      flush('TIMEOUT');
    }, freezeMs);
    freezeTimer.unref?.();
  };

  const setState = (stateName) => {
    if (stopped) return;
    if (!STATES[stateName]) return;
    currentState = stateName;
    lastSetStateTs = Date.now();

    // Terminal states flush immediately, bypassing throttle, and
    // disarm any pending stall promotion.
    if (TERMINAL_STATES.has(stateName)) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      clearStallTimers();
      return flush(stateName);
    }

    // Any explicit setState resets the stall clock — Claude clearly is
    // doing *something*. Re-arm only if the new state is promotable
    // (no point arming over QUEUED/STALL/TIMEOUT itself).
    armStallTimers();

    const elapsed = Date.now() - lastFlushTs;
    if (elapsed >= throttleMs) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      return flush(stateName);
    }
    // Inside throttle window: schedule for the soonest safe flush.
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        flush(currentState);
      }, throttleMs - elapsed);
      pendingTimer.unref?.();
    }
  };

  const clear = async () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    clearStallTimers();
    if (currentEmoji == null) return;
    currentEmoji = null;
    // Same applyChain serialization as flush — clear() is a state
    // transition, just to "no emoji". Without chaining, a clear()
    // racing with a pending apply (e.g. THINKING flush in flight)
    // could land BEFORE that apply, leaving the emoji visible.
    const myApply = applyChain.then(async () => {
      try { await apply(null); }
      catch (err) { logError(`reaction clear failed: ${err?.message || err}`); }
    });
    applyChain = myApply;
    return myApply;
  };

  const stop = () => {
    stopped = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    clearStallTimers();
  };

  return {
    setState,
    clear,
    stop,
    // Introspection for tests:
    get currentState() { return currentState; },
    get currentEmoji() { return currentEmoji; },
  };
}

module.exports = {
  createReactionManager,
  classifyToolName,
  resolveEmoji,
  STATES,
  TERMINAL_STATES,
  DEFAULT_THROTTLE_MS,
  DEFAULT_STALL_MS,
  DEFAULT_FREEZE_MS,
  GENERIC_FALLBACKS,
};
