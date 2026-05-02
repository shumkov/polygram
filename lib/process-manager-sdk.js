/**
 * SDK-backed ProcessManager — `@anthropic-ai/claude-agent-sdk` Query
 * objects in place of `child_process.spawn('claude', ...)` and
 * stream-json line parsing.
 *
 * Public API matches `lib/process-manager.js` (the CLI version) so
 * polygram.js can swap implementations via env flag (POLYGRAM_USE_SDK=1).
 * Phase 4 deletes the CLI version after Phase 5 soak proves the SDK
 * version stable.
 *
 * Per v4 plan §6.5.7 (buildSdkOptions), §6.6 (ship-breaker
 * mitigations), Phase 0 spike findings (docs/0.8.0-phase0-findings.md).
 *
 * Architecture:
 *   - One Query per active sessionKey, held for the chat lifetime
 *     (Phase 0 gate 1 PASS — long-lived input AsyncIterable works).
 *   - inputController is the writable end of an
 *     AsyncIterable<SDKUserMessage>; pm.send() pushes user messages
 *     onto it; the SDK's streamInput() consumes from the other end.
 *   - iteratePromise is the for-await loop over the Query's
 *     AsyncGenerator output. Wrapped in try/catch (D7 commitment).
 *   - pendingQueue maps N user messages → N SDKResultMessage events
 *     in FIFO order (same as CLI version's stream-json model).
 *   - LRU eviction across the procs Map (cap = DEFAULT_CAP) — same
 *     behaviour as CLI version, with Query.close() instead of
 *     proc.kill().
 *
 * Decisions encoded:
 *   D1 streaming: subscribe to SDKAssistantMessage (cumulative)
 *   D2 long-lived Query per chat
 *   D3 /effort via applyFlagSettings — DELETE requestRespawn
 *   D5 Options.env SHADOW — buildSdkOptions enumerates everything
 *   D6 Query.close() is fast — 100ms shutdown timeout safe
 *   D7 killChat Promise.allSettled with 5s per-Query timeout
 *   D8 pm.drainQueue(errCode) owns drain logic
 *   D11 stdinLock dropped — SDK preserves FIFO at Query level
 */

'use strict';

const { query } = require('@anthropic-ai/claude-agent-sdk');
const { isTransientHttpError } = require('./error-classify');

const DEFAULT_CAP = 10;
const DEFAULT_QUEUE_CAP = 50;
const DEFAULT_LRU_WAIT_MS = 300_000;          // 5 min waiter timeout
const DEFAULT_QUERY_CLOSE_TIMEOUT_MS = 5000;  // per-Query close ceiling (D7)
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2500;
const MAX_TRANSIENT_RETRIES = 1;
// Idle/wall-clock per-pending; SDK has no built-in. Reset on the
// event allowlist (H13 mitigation): assistant, partial-assistant,
// tool-progress; NOT on api-retry or compact_boundary.
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_MAX_TURN_MS = 30 * 60_000;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Pull cumulative user-visible text from an SDKAssistantMessage.
 * Same shape as today's stream-json assistant events (per D1):
 * `event.message.content[]` with text blocks.
 *
 * Colon-suffix normalisation matches the CLI pm — turns
 * "Listing dependencies:" into "Listing dependencies…" so a
 * trailing assistant message doesn't read as half-formed.
 */
function extractAssistantText(event) {
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n').trim().replace(/([^:]):\s*$/, '$1…');
}

/**
 * Sum usage across distinct assistant message ids. Per D1 + Phase 0
 * gate 22, modelUsage is camelCase but result.usage is snake_case;
 * this helper sums the latter (matches CLI pm + 0.7.6 turn_metrics).
 */
function sumUsage(usageByMessage) {
  const out = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  for (const u of usageByMessage.values()) {
    if (!u) continue;
    if (Number.isFinite(u.input_tokens)) out.input_tokens += u.input_tokens;
    if (Number.isFinite(u.output_tokens)) out.output_tokens += u.output_tokens;
    if (Number.isFinite(u.cache_creation_input_tokens)) {
      out.cache_creation_input_tokens += u.cache_creation_input_tokens;
    }
    if (Number.isFinite(u.cache_read_input_tokens)) {
      out.cache_read_input_tokens += u.cache_read_input_tokens;
    }
  }
  return out;
}

/**
 * Create the writable-end-of-AsyncIterable that pm pushes user
 * messages onto. SDK's `query({ prompt: <this> })` consumes from the
 * read end via `for await`.
 *
 * Bounded by queueCap (D5). Push beyond cap drops the OLDEST queued
 * (non-yielded) message and rejects its associated pending — matches
 * 0.7.6 H semantics.
 */
function makeInputController({ queueCap = DEFAULT_QUEUE_CAP } = {}) {
  const queue = [];                          // pending SDKUserMessages awaiting consumer
  const waiters = [];                        // outstanding next() promises
  let closed = false;
  let dropCallback = null;                   // optional (oldestMessage) → void

  const iter = {
    [Symbol.asyncIterator]() { return iter; },
    next() {
      if (queue.length) {
        return Promise.resolve({ value: queue.shift(), done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    async return() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
      return { value: undefined, done: true };
    },
  };

  function push(msg) {
    if (closed) {
      throw Object.assign(new Error('input controller closed'),
                          { code: 'INPUT_CLOSED' });
    }
    if (waiters.length) {
      waiters.shift()({ value: msg, done: false });
      return;
    }
    queue.push(msg);
    while (queue.length > queueCap) {
      const dropped = queue.shift();
      if (dropCallback) {
        try { dropCallback(dropped); }
        catch { /* swallow; pm logs separately */ }
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift()({ value: undefined, done: true });
  }

  function onDrop(cb) { dropCallback = cb; }

  return { iter, push, close, onDrop, get size() { return queue.length; } };
}

// ─── ProcessManager ────────────────────────────────────────────────

/**
 * @anthropic-ai/claude-agent-sdk-backed ProcessManager. Implements
 * the canonical Pm interface (`lib/pm-interface.js`). Optional
 * methods exposed: `steer`, `setModel`, `applyFlagSettings`,
 * `setPermissionMode`, `drainQueue`, `interrupt`, `resetSession`.
 *
 * Optional methods NOT implemented (CLI pm has this): `requestRespawn`.
 * For mid-session config changes use `applyFlagSettings` (effort)
 * or `setModel`.
 *
 * @implements {import('./pm-interface.js').Pm}
 */
class ProcessManagerSdk {
  constructor({
    cap = DEFAULT_CAP,
    queueCap = DEFAULT_QUEUE_CAP,
    spawnFn,                                   // (sessionKey, ctx) → SdkOptions OR { query, inputController }
    db = null,
    logger = console,
    onInit = null,
    onResult = null,
    onClose = null,
    onStreamChunk = null,
    onToolUse = null,
    onAssistantMessageStart = null,
    // rc.47: fires when an SDK assistant message arrives with NO head
    // pending in entry.pendingQueue — i.e. an autonomous turn (typical
    // ScheduleWakeup case where the agent self-fires without a
    // corresponding pm.send). Polygram wires this to a Telegram-send
    // function that derives chat_id (always) and thread_id (when
    // isolateTopics) from the sessionKey via getChatIdFromKey /
    // getThreadIdFromKey, then forwards the text to the right chat/
    // topic. Pre-rc.47 these messages were silently dropped at the
    // `&& head` gate in _handleEvent. Subagent messages
    // (parent_tool_use_id != null) are still filtered upstream.
    onAutonomousAssistantMessage = null,
    onCompactBoundary = null,
    onQueueDrop = null,
    onThinking = null,
    queryCloseTimeoutMs = DEFAULT_QUERY_CLOSE_TIMEOUT_MS,
  } = {}) {
    if (!spawnFn) throw new Error('spawnFn required');
    this.cap = cap;
    this.queueCap = queueCap;
    this.spawnFn = spawnFn;
    this.db = db;
    this.logger = logger;
    this.queryCloseTimeoutMs = queryCloseTimeoutMs;
    this.onInit = onInit;
    this.onResult = onResult;
    this.onClose = onClose;
    this.onStreamChunk = onStreamChunk;
    this.onToolUse = onToolUse;
    this.onAssistantMessageStart = onAssistantMessageStart;
    this.onAutonomousAssistantMessage = onAutonomousAssistantMessage;
    this.onCompactBoundary = onCompactBoundary;
    this.onQueueDrop = onQueueDrop;
    this.onThinking = onThinking;
    this.procs = new Map();                    // sessionKey → entry
    this._lruWaiters = [];                     // [{ resolve, reject, timer }]
  }

  has(sessionKey) { return this.procs.has(sessionKey); }
  get(sessionKey) { return this.procs.get(sessionKey); }
  get size() { return this.procs.size; }
  keys() { return [...this.procs.keys()]; }

  // ─── Spawn / pool ────────────────────────────────────────────────

  async getOrSpawn(sessionKey, spawnContext) {
    if (this._shuttingDown) {
      throw new Error('shutdown');
    }
    const existing = this.procs.get(sessionKey);
    if (existing && !existing.closed) return existing;

    if (this.procs.size >= this.cap) {
      const evicted = this._evictLRU();
      if (!evicted) {
        // All entries in-flight — park.
        await this._awaitLruSlot();
        if (this._shuttingDown) throw new Error('shutdown');
        return this.getOrSpawn(sessionKey, spawnContext);
      }
    }

    return this._spawnEntry(sessionKey, spawnContext);
  }

  _evictLRU() {
    let oldest = null;
    let oldestKey = null;
    for (const [k, v] of this.procs.entries()) {
      if (v.inFlight) continue;
      if (!oldest || v.lastUsedTs < oldest.lastUsedTs) {
        oldest = v;
        oldestKey = k;
      }
    }
    if (!oldest) {
      this._logEvent('lru-full', { active: this.procs.size, cap: this.cap });
      return false;
    }
    this._logEvent('evict', { session_key: oldestKey });
    // Async tear-down with timeout (D6/D7).
    this._closeEntry(oldest, 'evict').catch(() => {});
    this.procs.delete(oldestKey);
    return true;
  }

  async _awaitLruSlot() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._lruWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this._lruWaiters.splice(idx, 1);
        this._logEvent('lru-wait-timeout', { wait_ms: DEFAULT_LRU_WAIT_MS });
        reject(new Error(`lru wait timed out after ${DEFAULT_LRU_WAIT_MS}ms`));
      }, DEFAULT_LRU_WAIT_MS);
      this._lruWaiters.push({ resolve, reject, timer });
      this._logEvent('lru-wait', { active: this.procs.size, cap: this.cap });
    });
  }

  _maybeSignalLruWaiter() {
    const w = this._lruWaiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(); }
  }

  _spawnEntry(sessionKey, spawnContext) {
    const spawnResult = this.spawnFn(sessionKey, spawnContext);
    // spawnFn may return either SdkOptions (production) or
    // { query, inputController } (test fakeQuery shortcut).
    let entryQuery, inputController;
    if (spawnResult && typeof spawnResult.next === 'function') {
      // It's already a Query instance (test path).
      entryQuery = spawnResult;
      inputController = makeInputController({ queueCap: this.queueCap });
      // Test path: feed pushed messages back via streamInput.
      // (fakeQuery's streamInput consumes the iter we hand it.)
      entryQuery.streamInput?.(inputController.iter).catch(() => {});
    } else if (spawnResult && spawnResult.query && spawnResult.inputController) {
      // Pre-built (test convenience).
      entryQuery = spawnResult.query;
      inputController = spawnResult.inputController;
    } else {
      // Production: spawnFn returned SdkOptions.
      inputController = makeInputController({ queueCap: this.queueCap });
      entryQuery = query({
        prompt: inputController.iter,
        options: spawnResult || {},
      });
    }

    const entry = {
      sessionKey,
      chatId: spawnContext?.chatId ?? null,
      label: spawnContext?.label ?? sessionKey,
      query: entryQuery,
      inputController,
      pendingQueue: [],
      sessionId: null,
      closed: false,
      inFlight: false,
      lastUsedTs: Date.now(),
      iteratePromise: null,
      needsRespawn: null,
    };

    inputController.onDrop((dropped) => {
      // Bound by queueCap; oldest non-active pending was the one
      // associated with this dropped message (head pending = active,
      // its msg was already consumed by SDK; the message we're
      // dropping is from a later pending).
      this._handleQueueDrop(entry, dropped);
    });

    entry.iteratePromise = this._runIteration(entry).catch((err) => {
      this.logger.error?.(`[${entry.label}] iteration crashed: ${err?.message || err}`);
      this._failAllPendings(entry, err);
    });

    this.procs.set(sessionKey, entry);
    return entry;
  }

  // ─── Iteration loop ──────────────────────────────────────────────

  async _runIteration(entry) {
    try {
      for await (const msg of entry.query) {
        await this._handleEvent(entry, msg);
        if (entry.closed) break;
      }
    } catch (err) {
      // SDK threw (AbortError, network, etc). Reject all pendings
      // with the error; emit onClose; clean up.
      this._failAllPendings(entry, err);
      if (this.onClose) {
        try { this.onClose(entry.sessionKey, err.code === 'AbortError' ? 0 : 1, entry); }
        catch (e) { this.logger.error?.(`[${entry.label}] onClose: ${e.message}`); }
      }
    } finally {
      entry.closed = true;
      entry.inFlight = false;
      this.procs.delete(entry.sessionKey);
      this._maybeSignalLruWaiter();
    }
  }

  async _handleEvent(entry, msg) {
    const head = entry.pendingQueue[0];

    // Reset idle timer on activity events (H13 allowlist).
    if (head && this._isActivityEvent(msg)) {
      head.resetIdleTimer?.();
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      entry.sessionId = msg.session_id || null;
      if (this.onInit) {
        try { this.onInit(entry.sessionKey, msg, entry); }
        catch (err) { this.logger.error?.(`[${entry.label}] onInit: ${err.message}`); }
      }
      return;
    }

    // rc.29: stream_event with content_block_start of type='thinking'.
    // Fires DURING extended-thinking phase, BEFORE any text or tool_use
    // content appears. Without this, polygram's reactor stays at QUEUED
    // (👀) for the full thinking duration (10+ s with effort=high),
    // then transitions THINKING → CODING in <1s when the model finally
    // emits text/tool. UX target: 👀 → 🤔 transition fires within
    // 100-500ms of pm.send, matching Claude Code CLI's "Thinking..."
    // spinner timing.
    //
    // Requires `includePartialMessages: true` in SdkOptions; without
    // it, this branch is unreachable (we never receive stream_event).
    if (msg.type === 'stream_event' && head && !head.thinkingFired) {
      const ev = msg.event;
      const isThinkingStart = ev?.type === 'content_block_start'
        && ev?.content_block?.type === 'thinking';
      if (isThinkingStart) {
        head.thinkingFired = true;
        if (this.onThinking) {
          try { this.onThinking(entry.sessionKey, entry); }
          catch (err) { this.logger.error?.(`[${entry.label}] onThinking: ${err.message}`); }
        }
      }
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      // D6 / §5: surface compaction boundary to caller. Sequencing
      // guarantee — we await this callback before processing the
      // next event so a fresh assistant message after boundary
      // routes to a new bubble cleanly.
      if (this.onCompactBoundary) {
        try { await this.onCompactBoundary(entry.sessionKey, msg, entry); }
        catch (err) { this.logger.error?.(`[${entry.label}] onCompactBoundary: ${err.message}`); }
      }
      this._logEvent('compact-boundary', {
        session_key: entry.sessionKey,
        trigger: msg.compact_metadata?.trigger ?? null,
        pre_tokens: msg.compact_metadata?.pre_tokens ?? null,
        post_tokens: msg.compact_metadata?.post_tokens ?? null,
      });
      return;
    }

    if (msg.type === 'assistant' && !head) {
      // rc.47: autonomous assistant message — no user-initiated
      // pm.send is in flight. Typical cause: ScheduleWakeup fired,
      // the agent emitted a self-driven response. Pre-rc.47 these
      // were silently dropped by the `&& head` gate. Now we route
      // them via onAutonomousAssistantMessage so polygram can
      // forward the text to the right Telegram chat/topic.
      if (msg.parent_tool_use_id != null) return;
      const text = extractAssistantText(msg);
      if (!text) return;
      if (this.onAutonomousAssistantMessage) {
        try { this.onAutonomousAssistantMessage(entry.sessionKey, msg, entry); }
        catch (err) { this.logger.error?.(`[${entry.label}] onAutonomousAssistantMessage: ${err.message}`); }
      }
      return;
    }

    if (msg.type === 'assistant' && head) {
      // Subagent filter (Phase 1 step 7): top-level only.
      if (msg.parent_tool_use_id != null) return;

      const messageId = msg.message?.id;
      const added = extractAssistantText(msg);
      const hasToolUse = Array.isArray(msg.message?.content)
        && msg.message.content.some((b) => b?.type === 'tool_use');

      // First-stream fires when ANY assistant content arrives (text or tool_use).
      if (added || hasToolUse) {
        head.fireFirstStream?.();
        head.firstAssistantSeen = true;
      }

      // Per-message-id usage (sum across at result time).
      if (messageId != null && msg.message?.usage) {
        head.usageByMessage.set(messageId, msg.message.usage);
      }

      // Tool-use accounting + onToolUse callback fan-out.
      if (hasToolUse) {
        for (const b of msg.message.content) {
          if (b?.type === 'tool_use') {
            head.toolUseCount++;
            if (this.onToolUse && b.name) {
              try { this.onToolUse(entry.sessionKey, b.name, entry); }
              catch (err) { this.logger.error?.(`[${entry.label}] onToolUse: ${err.message}`); }
            }
          }
        }
      }

      // rc.45: multi-segment same-bubble streaming.
      //
      // Pre-rc.45: every message-id transition fired
      // onAssistantMessageStart (= forceNewMessage on the streamer),
      // producing a fresh bubble per SDK assistant message even
      // though the user only sent one input. Tool-heavy turns
      // showed 2-6 bubbles per logical user-input cycle.
      //
      // rc.45: only fire onAssistantMessageStart when the user
      // STEERED (injectUserMessage set pendingSteerCausesNewBubble).
      // Otherwise, accumulate the prior segment's text into
      // priorMessagesText and append the new segment to it — same
      // bubble grows naturally. Same-message-id events (cumulative
      // streaming within a single SDKAssistantMessage) still
      // REPLACE the segment text; the carry-over only kicks in on
      // message-id TRANSITIONS.
      if (added) {
        const isNewMessage = head.lastAssistantMessageId != null
          && messageId != null
          && head.lastAssistantMessageId !== messageId
          && head.streamText
          && head.streamText.length > 0;
        if (isNewMessage) {
          if (head.pendingSteerCausesNewBubble) {
            // Steered: fire onAssistantMessageStart so the streamer
            // forceNewMessage's. Reset the prior carry-over so the
            // new bubble starts clean.
            if (this.onAssistantMessageStart) {
              try { await this.onAssistantMessageStart(entry.sessionKey, entry); }
              catch (err) { this.logger.error?.(`[${entry.label}] onAssistantMessageStart: ${err.message}`); }
            }
            head.priorMessagesText = '';
            head.pendingSteerCausesNewBubble = false;
          } else {
            // No steer: roll the just-finished segment's full text
            // into priorMessagesText so the new segment appends to it.
            head.priorMessagesText = head.streamText;
          }
        }
        if (messageId != null) head.lastAssistantMessageId = messageId;
        // Compose visible bubble text: carry-over (prior segments in
        // this bubble) + the current segment's cumulative text.
        head.streamText = head.priorMessagesText
          ? head.priorMessagesText + '\n\n' + added
          : added;
        if (this.onStreamChunk) {
          try { this.onStreamChunk(entry.sessionKey, head.streamText, entry); }
          catch (err) { this.logger.error?.(`[${entry.label}] onStreamChunk: ${err.message}`); }
        }
      }
      return;
    }

    if (msg.type === 'result' && head) {
      // Transient retry (D11 / 0.7.6 H): retry once if the turn
      // hit a 5xx/429 BEFORE producing any assistant content.
      const errSignal = msg.error || msg.subtype;
      const isError = msg.subtype !== 'success';
      const shouldRetry = isError
        && !head.firstAssistantSeen
        && head.transientRetries < MAX_TRANSIENT_RETRIES
        && head.prompt != null
        && isTransientHttpError({ message: errSignal, subtype: msg.subtype });
      if (shouldRetry) {
        head.transientRetries++;
        this._logEvent('transient-retry', {
          session_key: entry.sessionKey,
          chat_id: entry.chatId,
          attempt: head.transientRetries,
          subtype: msg.subtype,
          error: typeof errSignal === 'string' ? errSignal.slice(0, 200) : null,
        });
        // Reset accumulators; arm idle timer; sleep then re-push.
        head.usageByMessage = new Map();
        head.toolUseCount = 0;
        head.streamText = '';
        head.lastAssistantMessageId = null;
        head.resetIdleTimer?.();
        setTimeout(() => {
          if (entry.pendingQueue[0] !== head || entry.closed) return;
          try {
            entry.inputController.push({
              type: 'user',
              message: { role: 'user', content: head.prompt },
              parent_tool_use_id: null,
            });
          } catch (err) {
            entry.pendingQueue.shift();
            head.clearTimers();
            head.reject(err);
          }
        }, DEFAULT_TRANSIENT_RETRY_DELAY_MS);
        return;
      }

      // Normal resolution.
      entry.pendingQueue.shift();
      head.clearTimers();
      if (this.onResult) {
        try { this.onResult(entry.sessionKey, msg, entry, head); }
        catch (err) { this.logger.error?.(`[${entry.label}] onResult: ${err.message}`); }
      }
      const usageTotals = sumUsage(head.usageByMessage);
      head.resolve({
        text: msg.result || '',
        sessionId: msg.session_id,
        cost: msg.total_cost_usd,
        duration: msg.duration_ms,
        error: msg.subtype === 'success' ? null : (msg.error || msg.subtype),
        metrics: {
          inputTokens: usageTotals.input_tokens,
          outputTokens: usageTotals.output_tokens,
          cacheCreationTokens: usageTotals.cache_creation_input_tokens,
          cacheReadTokens: usageTotals.cache_read_input_tokens,
          numAssistantMessages: head.usageByMessage.size,
          numToolUses: head.toolUseCount,
          resultSubtype: msg.subtype || null,
        },
      });

      // Activate next head or settle idle.
      if (entry.pendingQueue.length > 0) {
        entry.pendingQueue[0].activate();
      } else {
        entry.inFlight = false;
        this._maybeSignalLruWaiter();
      }
      return;
    }
  }

  _isActivityEvent(msg) {
    if (!msg?.type) return false;
    if (msg.type === 'assistant') return true;
    if (msg.type === 'partial_assistant') return true;
    if (msg.type === 'stream_event') return true;
    if (msg.type === 'tool_progress') return true;
    if (msg.type === 'user') return true;       // tool_result bridge events
    return false;
  }

  // ─── Send ────────────────────────────────────────────────────────

  send(sessionKey, prompt, {
    timeoutMs = DEFAULT_IDLE_MS,
    maxTurnMs = DEFAULT_MAX_TURN_MS,
    context = {},
  } = {}) {
    return new Promise((resolve, reject) => {
      const entry = this.procs.get(sessionKey);
      if (!entry || entry.closed) {
        return reject(new Error('No process for session'));
      }
      if (entry.needsRespawn) {
        return reject(new Error(`Session awaiting respawn (${entry.needsRespawn})`));
      }

      entry.lastUsedTs = Date.now();

      let idleTimer = null;
      let maxTimer = null;
      let activated = false;

      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      };

      const pending = {
        resolve: (r) => { clearTimers(); resolve(r); },
        reject: (e) => { clearTimers(); reject(e); },
        clearTimers,
        startedAt: null,
        streamText: '',
        context,
        idleTimer: null,
        maxTimer: null,
        activated: false,
        usageByMessage: new Map(),
        lastUsageMessageId: null,
        toolUseCount: 0,
        firstStreamFired: false,
        prompt,
        transientRetries: 0,
        firstAssistantSeen: false,
        thinkingFired: false,                  // rc.29: extended-thinking → reactor THINKING
        // rc.45: multi-segment same-bubble streaming. priorMessagesText
        // accumulates the full text of completed assistant-message
        // segments in the SAME bubble. On message-id transition WITHOUT
        // a steer, the just-finished segment rolls into priorMessagesText
        // and the new segment's text appends to it (one bubble grows).
        // On message-id transition WITH a steer, priorMessagesText
        // resets and a new bubble starts. pendingSteerCausesNewBubble is
        // set by injectUserMessage; consumed + cleared on the next
        // message-id transition.
        priorMessagesText: '',
        pendingSteerCausesNewBubble: false,
      };

      pending.fireFirstStream = () => {
        if (pending.firstStreamFired) return;
        pending.firstStreamFired = true;
        try { context?.onFirstStream?.(); }
        catch (err) { this.logger.error?.(`[${entry.label}] onFirstStream: ${err.message}`); }
      };

      const fireTimeout = (reason) => {
        if (entry.pendingQueue[0] !== pending) return;
        this._logEvent('turn-timeout', {
          session_key: sessionKey,
          chat_id: entry.chatId,
          reason,
        });
        entry.pendingQueue.shift();
        // On idle/wall-clock fire: cancel SDK side first.
        entry.query.interrupt?.().catch(() => {});
        pending.reject(new Error(reason));
        if (entry.pendingQueue.length > 0) {
          entry.pendingQueue[0].activate();
        } else {
          entry.inFlight = false;
        }
      };

      const armIdle = () => setTimeout(
        () => fireTimeout(`Timeout: ${timeoutMs / 1000}s idle with no Claude activity`),
        timeoutMs,
      );

      pending.activate = () => {
        if (activated) return;
        activated = true;
        pending.activated = true;
        pending.startedAt = Date.now();
        idleTimer = armIdle();
        pending.idleTimer = idleTimer;
        maxTimer = setTimeout(
          () => fireTimeout(`Turn exceeded ${maxTurnMs / 1000}s wall-clock ceiling`),
          maxTurnMs,
        );
        pending.maxTimer = maxTimer;
        try { context?.onActivate?.(); }
        catch (err) { this.logger.error?.(`[${entry.label}] onActivate: ${err.message}`); }
      };

      pending.resetIdleTimer = () => {
        if (!activated) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = armIdle();
        pending.idleTimer = idleTimer;
      };

      // Push into queue, enforce queueCap.
      entry.pendingQueue.push(pending);
      entry.inFlight = true;
      while (entry.pendingQueue.length > this.queueCap) {
        const dropped = entry.pendingQueue.splice(1, 1)[0];
        if (!dropped) break;
        dropped.clearTimers?.();
        const dropErr = Object.assign(
          new Error(`queue overflow: dropped (queue cap ${this.queueCap})`),
          { code: 'QUEUE_OVERFLOW' },
        );
        this._logEvent('queue-overflow-drop', {
          session_key: sessionKey,
          chat_id: entry.chatId,
          queue_len: entry.pendingQueue.length,
          source_msg_id: dropped.context?.sourceMsgId ?? null,
        });
        if (this.onQueueDrop) {
          try { this.onQueueDrop(sessionKey, dropped, entry); }
          catch (err) { this.logger.error?.(`[${entry.label}] onQueueDrop: ${err.message}`); }
        }
        dropped.reject(dropErr);
      }

      if (entry.pendingQueue.length === 1) pending.activate();

      try {
        entry.inputController.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        });
      } catch (err) {
        const idx = entry.pendingQueue.indexOf(pending);
        if (idx !== -1) entry.pendingQueue.splice(idx, 1);
        if (entry.pendingQueue.length === 0) entry.inFlight = false;
        pending.reject(err);
      }
    });
  }

  // ─── Per-session control surface ─────────────────────────────────

  /**
   * Cancel the in-flight turn. Other queued pendings are NOT
   * auto-rejected (use drainQueue for that). Polygram's /stop
   * handler typically calls interrupt() then drainQueue().
   */
  async interrupt(sessionKey) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    try { await entry.query.interrupt?.(); }
    catch (err) {
      this.logger.error?.(`[${entry.label}] interrupt: ${err.message}`);
      return false;
    }
    this._logEvent('interrupt-applied', { session_key: sessionKey });
    return true;
  }

  /**
   * Reject every pending (head + queued) with a typed
   * `Error('drained:' + errCode)`. Encapsulates the drain inside
   * pm so polygram doesn't poke at pendingQueue (D8 / seam H).
   */
  drainQueue(sessionKey, errCode = 'INTERRUPTED') {
    const entry = this.procs.get(sessionKey);
    if (!entry) return 0;
    let count = 0;
    while (entry.pendingQueue.length > 0) {
      const p = entry.pendingQueue.shift();
      p.clearTimers?.();
      const err = Object.assign(new Error(`drained:${errCode}`), { code: errCode });
      try { p.reject(err); } catch { /* swallow */ }
      count++;
    }
    entry.inFlight = false;
    this._logEvent('drain-queue', { session_key: sessionKey, code: errCode, count });
    return count;
  }

  async setModel(sessionKey, model) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    try { await entry.query.setModel?.(model); return true; }
    catch (err) {
      this.logger.error?.(`[${entry.label}] setModel: ${err.message}`);
      return false;
    }
  }

  async setPermissionMode(sessionKey, mode) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    try { await entry.query.setPermissionMode?.(mode); return true; }
    catch (err) {
      this.logger.error?.(`[${entry.label}] setPermissionMode: ${err.message}`);
      return false;
    }
  }

  async applyFlagSettings(sessionKey, settings) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    try { await entry.query.applyFlagSettings?.(settings); return true; }
    catch (err) {
      this.logger.error?.(`[${entry.label}] applyFlagSettings: ${err.message}`);
      return false;
    }
  }

  /**
   * 0.8.0 Phase 2 step 1 — mid-turn steer. Pushes a user message
   * onto the inputController with priority: 'now' so the SDK
   * processes it ahead of any queued normal-priority messages.
   *
   * Phase 0 gate 6 was DEFER — exact "skip remaining sibling
   * tool_uses" semantic must be verified live. If the SDK doesn't
   * skip siblings on priority:'now', polygram-side `/steer` falls
   * back to interrupt() + push (slightly different UX but still
   * works — the in-flight tool batch finishes, then the steer
   * message is the next user turn).
   *
   * shouldQuery: true (default) → steer triggers an immediate
   * response. shouldQuery: false → "append context, don't trigger"
   * — useful when steer is informational only.
   *
   * Returns true if push succeeded; false if session not found or
   * input controller closed.
   */
  steer(sessionKey, text, { shouldQuery = false } = {}) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    try {
      // 0.8.0-rc.7 (per v4 plan §0 row 9 + Phase 2 step 1's original
      // shape): push with `shouldQuery: false` so the SDK appends to
      // the transcript without trying to terminate the in-flight turn.
      // The previous default `shouldQuery: true` triggered the CLI
      // binary's `m87` gate (transcript well-formedness check) which
      // emitted `result.subtype = error_during_execution` whenever a
      // plain-text user message arrived while the assistant was mid-
      // tool-use. With shouldQuery=false the message merges into the
      // next natural user turn — the in-flight tools complete first,
      // then the assistant sees the steered context.
      //
      // parent_tool_use_id is required by SDKUserMessage type
      // (sdk.d.ts:3479-3498). The SDK runtime checks `!== null` in
      // multiple places; omitting it falls through to wrong handling
      // branches. The SDK's own `mz.send()` and `pz` replay set it
      // to null explicitly.
      entry.inputController.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        priority: 'now',
        shouldQuery,
      });
      this._logEvent('steer', {
        session_key: sessionKey,
        chat_id: entry.chatId,
        should_query: shouldQuery,
        text_len: text?.length ?? 0,
      });
      return true;
    } catch (err) {
      this.logger.error?.(`[${entry.label}] steer: ${err.message}`);
      return false;
    }
  }

  /**
   * 0.8.0-rc.42 — native autosteer / queue. Push a user message
   * directly onto the SDK's input controller. The SDK manages
   * absorption / queueing per the `priority` hint:
   *   - 'now':   abort current turn (terminal_reason='aborted_streaming')
   *              and start a fresh turn for this message (verified U7
   *              spike 2026-05-01).
   *   - 'next':  absorb into current turn at next natural pause
   *              (between tool calls / after subagent return / etc.)
   *              — same UX as the deleted autosteer-buffer + PostToolBatch
   *              flow, but the SDK manages the queue. ONE result event
   *              for the whole chain.
   *   - 'later': queue for after current turn ends. SEPARATE result
   *              event per absorbed message. Clean per-msg lifecycle.
   *   - undefined: same as 'next'.
   *
   * Returns true on push success, false if no entry / closed.
   *
   * NOTE: this does NOT push a polygram pending into pendingQueue.
   * The message bypasses pm's per-pending bookkeeping (cost-row,
   * idle-timer, wall-clock cap) — those still attach to the
   * trigger pending of the in-flight turn. For 'later' priority,
   * the SDK will fire its own SDKResultMessage for the followup;
   * polygram's onResult only sees one of these per active pending.
   * Callers wanting per-msg accounting must use pm.send() instead.
   */
  injectUserMessage(sessionKey, { content, priority = 'next', shouldQuery, parent_tool_use_id = null } = {}) {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return false;
    if (typeof content !== 'string' || !content) {
      throw new TypeError('injectUserMessage: content (string) required');
    }
    try {
      const msg = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id,
      };
      if (priority !== undefined) msg.priority = priority;
      if (shouldQuery !== undefined) msg.shouldQuery = shouldQuery;
      entry.inputController.push(msg);
      // rc.45: signal the streamer to start a new bubble at the next
      // assistant-message-id transition. Without this flag,
      // _handleEvent would APPEND the post-steer assistant text into
      // the same bubble as the pre-steer text, hiding the user's
      // intervention. Only set when there's a head pending — if the
      // session is idle, the next pm.send will start a fresh bubble
      // anyway.
      const head = entry.pendingQueue?.[0];
      if (head) head.pendingSteerCausesNewBubble = true;
      this._logEvent('inject-user-message', {
        session_key: sessionKey,
        chat_id: entry.chatId,
        priority: priority ?? null,
        should_query: shouldQuery ?? null,
        text_len: content.length,
      });
      return true;
    } catch (err) {
      this.logger.error?.(`[${entry.label}] injectUserMessage: ${err.message}`);
      return false;
    }
  }

  /**
   * Forcibly reset a session: drain pendings, close Query, clear
   * sessionId in DB. Per v4 plan §6.5.2.
   */
  async resetSession(sessionKey, { reason = 'user-requested' } = {}) {
    const entry = this.procs.get(sessionKey);
    if (!entry) return { closed: false, drainedPendings: 0 };
    const drainedPendings = this.drainQueue(sessionKey, 'RESET_SESSION');
    const closed = await this._closeEntry(entry, reason);
    if (this.db?.clearSessionId) {
      try { this.db.clearSessionId(sessionKey); }
      catch (err) { this.logger.error?.(`[${entry.label}] clearSessionId: ${err.message}`); }
    }
    this.procs.delete(sessionKey);
    this._maybeSignalLruWaiter();
    this._logEvent('session-reset', {
      session_key: sessionKey, reason, drained_pendings: drainedPendings, closed,
    });
    return { closed, drainedPendings };
  }

  // ─── Kill / close ────────────────────────────────────────────────

  async kill(sessionKey) {
    const entry = this.procs.get(sessionKey);
    if (!entry) return;
    this.drainQueue(sessionKey, 'KILLED');
    await this._closeEntry(entry, 'kill');
    this.procs.delete(sessionKey);
    this._maybeSignalLruWaiter();
  }

  /**
   * Tear down every Query whose sessionKey starts with the given
   * chatId prefix. Used on Telegram chat→supergroup migration.
   * Promise.allSettled per D7 — one slow close doesn't block others.
   */
  async killChat(chatId) {
    const prefix = String(chatId);
    const matching = [];
    for (const [key, entry] of this.procs.entries()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) {
        matching.push({ key, entry });
      }
    }
    const results = await Promise.allSettled(matching.map(async ({ key, entry }) => {
      this.drainQueue(key, 'KILLCHAT');
      await this._closeEntry(entry, 'killChat');
      this.procs.delete(key);
    }));
    this._maybeSignalLruWaiter();
    return results.map((r, i) => ({
      sessionKey: matching[i].key,
      status: r.status,
      error: r.reason?.message,
    }));
  }

  /**
   * Race Query.close() against a timeout. Returns `true` if close
   * resolved cleanly; `false` if it timed out (entry still gets
   * removed from procs by caller). Per D7.
   */
  async _closeEntry(entry, reason) {
    if (entry.closed) return true;
    entry.closed = true;
    // Close the input controller so SDK's streamInput consumer
    // exits cleanly.
    try { entry.inputController.close(); }
    catch { /* swallow */ }
    let timedOut = false;
    const closeP = (async () => {
      try { await entry.query.close?.(); }
      catch (err) {
        this.logger.error?.(`[${entry.label}] query.close: ${err.message}`);
      }
    })();
    const timerP = new Promise((resolve) => setTimeout(() => {
      timedOut = true;
      resolve();
    }, this.queryCloseTimeoutMs));
    await Promise.race([closeP, timerP]);
    if (timedOut) {
      this._logEvent('evict-close-timeout', {
        session_key: entry.sessionKey, reason, timeout_ms: this.queryCloseTimeoutMs,
      });
    }
    return !timedOut;
  }

  async shutdown() {
    // Set flag FIRST so any LRU-waiter unparked by _closeEntry's
    // iteration-finally doesn't recurse into a fresh spawn (which
    // would leave an orphaned entry after `procs.clear()` below).
    // Reject parked waiters immediately so their getOrSpawn callers
    // unwind cleanly rather than racing the shutdown.
    this._shuttingDown = true;
    while (this._lruWaiters.length) {
      const w = this._lruWaiters.shift();
      clearTimeout(w.timer);
      w.reject(new Error('shutdown'));
    }
    const entries = [...this.procs.values()];
    await Promise.allSettled(entries.map((e) => {
      this.drainQueue(e.sessionKey, 'SHUTDOWN');
      return this._closeEntry(e, 'shutdown');
    }));
    this.procs.clear();
  }

  // ─── Helpers ────────────────────────────────────────────────────

  _failAllPendings(entry, err) {
    while (entry.pendingQueue.length > 0) {
      const p = entry.pendingQueue.shift();
      p.clearTimers?.();
      try { p.reject(err); } catch { /* swallow */ }
    }
    entry.inFlight = false;
  }

  _handleQueueDrop(entry, droppedMsg) {
    // The dropped message was a queued user message that hadn't yet
    // been consumed by the SDK. Find the corresponding pending and
    // reject it. (Pendings and pushed messages are 1:1 in order.)
    // We dropped from the FRONT of the input queue (oldest), which
    // corresponds to pendingQueue[1] (head=in-flight is index 0).
    if (entry.pendingQueue.length < 2) return;
    const dropped = entry.pendingQueue.splice(1, 1)[0];
    if (!dropped) return;
    dropped.clearTimers?.();
    const err = Object.assign(
      new Error(`queue overflow: dropped (queue cap ${this.queueCap})`),
      { code: 'QUEUE_OVERFLOW' },
    );
    this._logEvent('queue-overflow-drop', {
      session_key: entry.sessionKey,
      chat_id: entry.chatId,
      queue_len: entry.pendingQueue.length,
      source_msg_id: dropped.context?.sourceMsgId ?? null,
    });
    if (this.onQueueDrop) {
      try { this.onQueueDrop(entry.sessionKey, dropped, entry); }
      catch (err2) { this.logger.error?.(`[${entry.label}] onQueueDrop: ${err2.message}`); }
    }
    dropped.reject(err);
  }

  _logEvent(kind, detail) {
    if (!this.db?.logEvent) return;
    try { this.db.logEvent(kind, detail); }
    catch (err) { this.logger.error?.(`[pm-sdk] logEvent ${kind} failed: ${err.message}`); }
  }
}

module.exports = {
  ProcessManagerSdk,
  DEFAULT_CAP,
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUERY_CLOSE_TIMEOUT_MS,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  MAX_TRANSIENT_RETRIES,
  extractAssistantText,
  sumUsage,
  makeInputController,
};
