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
  QUEUED:   { label: 'queued',   chain: ['👀', '🤔']       },
  THINKING: { label: 'thinking', chain: ['🤔']             },
  CODING:   { label: 'coding',   chain: ['👨‍💻', '✍', '🤔'] },
  WEB:      { label: 'web',      chain: ['⚡', '🔥', '🤔']  },
  TOOL:     { label: 'tool',     chain: ['🔥', '🤔']       },
  WRITING:  { label: 'writing',  chain: ['✍', '🤔']        },
  DONE:     { label: 'done',     chain: ['👍']             },
  ERROR:    { label: 'error',    chain: ['🤯', '🤔']       },
  STALL:    { label: 'stall',    chain: ['🥱', '🤔']       },
  TIMEOUT:  { label: 'timeout',  chain: ['😨', '🤯']       },
};

const TERMINAL_STATES = new Set(['DONE', 'ERROR', 'TIMEOUT']);
const DEFAULT_THROTTLE_MS = 800;

// Tool name → state classifier. Case-insensitive contains for tool names
// that share a category (Read/Write/Edit are all "coding"; WebFetch +
// WebSearch are "web"; everything else is generic TOOL).
function classifyToolName(name) {
  if (typeof name !== 'string' || !name) return 'TOOL';
  if (/^(Web)/i.test(name)) return 'WEB';
  if (/^(Bash|Read|Write|Edit|NotebookEdit|Glob|Grep)$/.test(name)) return 'CODING';
  if (/^(TodoWrite|Task)$/.test(name)) return 'WRITING';
  return 'TOOL';
}

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
  // Nothing in the chain is allowed — signal "no reaction possible".
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
  logError = () => {},
} = {}) {
  if (typeof apply !== 'function') throw new Error('apply function required');
  let currentState = null;
  let currentEmoji = null;
  let lastFlushTs = 0;
  let pendingTimer = null;
  let stopped = false;

  const flush = async (stateName) => {
    if (stopped) return;
    const spec = STATES[stateName];
    if (!spec) return;
    const emoji = resolveEmoji(spec.chain, availableEmojis);
    if (emoji === currentEmoji) return;
    currentEmoji = emoji;
    lastFlushTs = Date.now();
    try {
      await apply(emoji);
    } catch (err) {
      logError(`reaction apply failed (${stateName} → ${emoji}): ${err?.message || err}`);
    }
  };

  const setState = (stateName) => {
    if (stopped) return;
    if (!STATES[stateName]) return;
    currentState = stateName;

    // Terminal states flush immediately, bypassing throttle.
    if (TERMINAL_STATES.has(stateName)) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      return flush(stateName);
    }

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
    if (currentEmoji == null) return;
    currentEmoji = null;
    try { await apply(null); }
    catch (err) { logError(`reaction clear failed: ${err?.message || err}`); }
  };

  const stop = () => {
    stopped = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
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
};
