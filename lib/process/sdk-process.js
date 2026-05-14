/**
 * SdkProcess — one @anthropic-ai/claude-agent-sdk Query, wrapped as a
 * Process for the generic ProcessManager.
 *
 * Direct extraction of the per-entry guts from the pre-0.10.0
 * `lib/sdk/process-manager.js` ProcessManagerSdk class. What was
 * `entry.X` is now `this.X`; what was `pm.onInit(sessionKey, ...)`
 * is now `this.emit('init', ...)`.
 *
 * Architecture invariants (unchanged from the previous pm impl):
 *   D1 stream subscription: SDKAssistantMessage cumulative
 *   D2 long-lived Query per chat
 *   D3 /effort via applyFlagSettings (no respawn)
 *   D5 Options.env SHADOW — buildSdkOptions enumerates everything
 *   D6 Query.close() is fast — close timeout safe
 *   D7 killChat Promise.allSettled with timeout per Query
 *   D8 drainQueue(code) owns drain logic
 *   D11 stdinLock dropped — SDK preserves FIFO at Query level
 *
 * Phase 0 spike + audit findings preserved:
 *   R1-F1 hot-path: drainQueue / injectUserMessage / steer NEVER throw
 *   R1-F2 query.close() is synchronous void; await iteratePromise
 *   F-spike-1 — TmuxProcess uses --permission-mode acceptEdits (separate
 *               file, Phase 2); SdkProcess mirrors via Options.permissionMode
 *
 * cost = 1 (default SDK weight; tmux backend will override to 3).
 */

'use strict';

const { query } = require('@anthropic-ai/claude-agent-sdk');
const { Process, UnsupportedOperationError } = require('./process');
const { isTransientHttpError } = require('../error/classify');

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_QUEUE_CAP = 50;
const DEFAULT_QUERY_CLOSE_TIMEOUT_MS = 5000;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2500;
const MAX_TRANSIENT_RETRIES = 1;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_MAX_TURN_MS = 30 * 60_000;
const VISIBILITY_HEARTBEAT_MS = 30 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Pull cumulative user-visible text from an SDKAssistantMessage.
 * Same shape as today's stream-json assistant events (per D1):
 * `event.message.content[]` with text blocks. Colon-suffix
 * normalisation matches the CLI pm — "Listing deps:" → "Listing deps…"
 * so a trailing assistant message doesn't read as half-formed.
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
 * Sum usage across distinct assistant message ids.
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
 * Create the writable-end-of-AsyncIterable that send() / steer() /
 * injectUserMessage() push user messages onto. SDK's `query({ prompt:
 * <this> })` consumes from the read end via `for await`.
 *
 * Bounded by queueCap (D5). Push beyond cap drops OLDEST queued
 * (non-yielded) message; caller's onDrop handler rejects the
 * corresponding pending.
 */
function makeInputController({ queueCap = DEFAULT_QUEUE_CAP } = {}) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let dropCallback = null;

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
        try { dropCallback(dropped); } catch { /* swallow */ }
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

// ─── SdkProcess ────────────────────────────────────────────────────

class SdkProcess extends Process {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey
   * @param {string|null} opts.chatId
   * @param {string|null} opts.threadId
   * @param {string} opts.label
   * @param {Function} opts.spawnFn — (sessionKey, ctx) → SdkOptions OR { query, inputController } for test paths
   * @param {object} [opts.db] — used for _logEvent + clearSessionId on resetSession
   * @param {object} [opts.logger=console]
   * @param {number} [opts.queueCap]
   * @param {number} [opts.queryCloseTimeoutMs]
   */
  constructor({
    sessionKey, chatId, threadId, label,
    spawnFn,
    db = null,
    logger = console,
    queueCap = DEFAULT_QUEUE_CAP,
    queryCloseTimeoutMs = DEFAULT_QUERY_CLOSE_TIMEOUT_MS,
  } = {}) {
    super({ sessionKey, chatId, threadId, label });
    if (typeof spawnFn !== 'function') throw new TypeError('SdkProcess: spawnFn required');
    this.backend = 'sdk';
    this.spawnFn = spawnFn;
    this.db = db;
    this.logger = logger;
    this.queueCap = queueCap;
    this.queryCloseTimeoutMs = queryCloseTimeoutMs;

    // Underlying Query state
    this.query = null;
    this.inputController = null;
    this.iteratePromise = null;
    this.lastUsedTs = Date.now();

    // pendingQueue is inherited as [] from the abstract Process base.
    // claudeSessionId is inherited as null.
  }

  get cost() { return 1; }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async start(ctx) {
    const spawnResult = this.spawnFn(this.sessionKey, ctx);
    // spawnFn may return either SdkOptions (production) or
    // { query, inputController } (test fakeQuery shortcut), or a
    // ready Query instance directly.
    if (spawnResult && typeof spawnResult.next === 'function') {
      // Already a Query instance (test path).
      this.query = spawnResult;
      this.inputController = makeInputController({ queueCap: this.queueCap });
      this.query.streamInput?.(this.inputController.iter).catch(() => {});
    } else if (spawnResult && spawnResult.query && spawnResult.inputController) {
      this.query = spawnResult.query;
      this.inputController = spawnResult.inputController;
    } else {
      this.inputController = makeInputController({ queueCap: this.queueCap });
      this.query = query({
        prompt: this.inputController.iter,
        options: spawnResult || {},
      });
    }

    this.inputController.onDrop((dropped) => this._handleQueueDrop(dropped));

    // Run iteration in the background. When the SDK loop exits, we
    // mark closed, drain remaining pendings with err, fire 'close',
    // and `emit('idle')` so the pm can signal any parked LRU waiter.
    this.iteratePromise = this._runIteration().catch((err) => {
      this.logger.error?.(`[${this.label}] iteration crashed: ${err?.message || err}`);
      this._failAllPendings(err);
    });
  }

  async _runIteration() {
    try {
      for await (const msg of this.query) {
        await this._handleEvent(msg);
        if (this.closed) break;
      }
    } catch (err) {
      this._failAllPendings(err);
      this.emit('close', err.code === 'AbortError' ? 0 : 1);
    } finally {
      this.closed = true;
      this.inFlight = false;
      this.emit('idle');
    }
  }

  // ─── Event handler — the heart of the per-Process state machine ──

  async _handleEvent(msg) {
    const head = this.pendingQueue[0];

    if (head && this._isActivityEvent(msg)) {
      head.resetIdleTimer?.();
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      this.claudeSessionId = msg.session_id || null;
      this.emit('init', msg);
      return;
    }

    // rc.29: stream_event with content_block_start of type='thinking'.
    if (msg.type === 'stream_event' && head && !head.thinkingFired) {
      const ev = msg.event;
      const isThinkingStart = ev?.type === 'content_block_start'
        && ev?.content_block?.type === 'thinking';
      if (isThinkingStart) {
        head.thinkingFired = true;
        this.emit('thinking');
      }
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      // Sequence: await listeners before processing next event so a
      // fresh assistant message after boundary routes to new bubble.
      const listeners = this.listeners('compact-boundary');
      for (const fn of listeners) {
        try { await fn(msg); }
        catch (err) { this.logger.error?.(`[${this.label}] compact-boundary listener: ${err.message}`); }
      }
      this._logEvent('compact-boundary', {
        session_key: this.sessionKey,
        trigger: msg.compact_metadata?.trigger ?? null,
        pre_tokens: msg.compact_metadata?.pre_tokens ?? null,
        post_tokens: msg.compact_metadata?.post_tokens ?? null,
      });
      return;
    }

    if (msg.type === 'assistant' && !head) {
      // rc.47: autonomous assistant message — no pm.send in flight.
      if (msg.parent_tool_use_id != null) return;
      const text = extractAssistantText(msg);
      if (!text) return;
      this.emit('autonomous-assistant-message', msg);
      return;
    }

    if (msg.type === 'assistant' && head) {
      // Subagent filter: top-level only.
      if (msg.parent_tool_use_id != null) return;

      const messageId = msg.message?.id;
      const added = extractAssistantText(msg);
      const hasToolUse = Array.isArray(msg.message?.content)
        && msg.message.content.some((b) => b?.type === 'tool_use');

      if (added || hasToolUse) {
        head.fireFirstStream?.();
        head.firstAssistantSeen = true;
      }

      if (messageId != null && msg.message?.usage) {
        head.usageByMessage.set(messageId, msg.message.usage);
      }

      if (hasToolUse) {
        for (const b of msg.message.content) {
          if (b?.type === 'tool_use') {
            head.toolUseCount++;
            if (b.name) this.emit('tool-use', b.name);
          }
        }
      }

      // rc.45: multi-segment same-bubble streaming.
      if (added) {
        const isNewMessage = head.lastAssistantMessageId != null
          && messageId != null
          && head.lastAssistantMessageId !== messageId
          && head.streamText
          && head.streamText.length > 0;
        if (isNewMessage) {
          if (head.pendingSteerCausesNewBubble) {
            // Steered: fire assistant-message-start so streamer
            // forceNewMessage's.
            const listeners = this.listeners('assistant-message-start');
            for (const fn of listeners) {
              try { await fn(); }
              catch (err) { this.logger.error?.(`[${this.label}] assistant-message-start: ${err.message}`); }
            }
            head.priorMessagesText = '';
            head.pendingSteerCausesNewBubble = false;
          } else {
            head.priorMessagesText = head.streamText;
          }
        }
        if (messageId != null) head.lastAssistantMessageId = messageId;
        head.streamText = head.priorMessagesText
          ? head.priorMessagesText + '\n\n' + added
          : added;
        this.emit('stream-chunk', head.streamText);
      }
      return;
    }

    if (msg.type === 'result' && head) {
      // Transient retry: retry once if turn hit 5xx/429 BEFORE any
      // assistant content arrived.
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
          session_key: this.sessionKey,
          chat_id: this.chatId,
          attempt: head.transientRetries,
          subtype: msg.subtype,
          error: typeof errSignal === 'string' ? errSignal.slice(0, 200) : null,
        });
        head.usageByMessage = new Map();
        head.toolUseCount = 0;
        head.streamText = '';
        head.lastAssistantMessageId = null;
        head.resetIdleTimer?.();
        setTimeout(() => {
          if (this.pendingQueue[0] !== head || this.closed) return;
          try {
            this.inputController.push({
              type: 'user',
              message: { role: 'user', content: head.prompt },
              parent_tool_use_id: null,
            });
          } catch (err) {
            this.pendingQueue.shift();
            head.clearTimers();
            head.reject(err);
          }
        }, DEFAULT_TRANSIENT_RETRY_DELAY_MS);
        return;
      }

      // Normal resolution.
      this.pendingQueue.shift();
      head.clearTimers();
      this.emit('result', msg, head);
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

      if (this.pendingQueue.length > 0) {
        this.pendingQueue[0].activate();
      } else {
        this.inFlight = false;
        this.emit('idle');
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
    if (msg.type === 'user') return true;
    return false;
  }

  // ─── send ──────────────────────────────────────────────────────

  send(prompt, {
    timeoutMs = DEFAULT_IDLE_MS,
    maxTurnMs = DEFAULT_MAX_TURN_MS,
    context = {},
  } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('No process for session'));

      this.lastUsedTs = Date.now();

      let idleTimer = null;
      let maxTimer = null;
      let visibilityTimer = null;
      let activated = false;

      const armVisibilityTimer = () => {
        if (visibilityTimer) clearInterval(visibilityTimer);
        visibilityTimer = setInterval(() => {
          if (!this.pendingQueue.includes(pending)) {
            if (visibilityTimer) { clearInterval(visibilityTimer); visibilityTimer = null; }
            return;
          }
          const r = pending.context?.reactor;
          if (r && typeof r.heartbeat === 'function') {
            try { r.heartbeat(); } catch { /* defensive */ }
          }
        }, VISIBILITY_HEARTBEAT_MS);
        visibilityTimer.unref?.();
      };

      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        if (visibilityTimer) { clearInterval(visibilityTimer); visibilityTimer = null; }
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
        thinkingFired: false,
        priorMessagesText: '',
        pendingSteerCausesNewBubble: false,
        lastAssistantMessageId: null,
      };

      pending.fireFirstStream = () => {
        if (pending.firstStreamFired) return;
        pending.firstStreamFired = true;
        try { context?.onFirstStream?.(); }
        catch (err) { this.logger.error?.(`[${this.label}] onFirstStream: ${err.message}`); }
      };

      const fireTimeout = (reason) => {
        if (this.pendingQueue[0] !== pending) return;
        this._logEvent('turn-timeout', {
          session_key: this.sessionKey,
          chat_id: this.chatId,
          reason,
        });
        this.pendingQueue.shift();
        this.query.interrupt?.().catch(() => {});
        pending.reject(new Error(reason));
        if (this.pendingQueue.length > 0) {
          this.pendingQueue[0].activate();
        } else {
          this.inFlight = false;
          this.emit('idle');
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
        armVisibilityTimer();
        try { context?.onActivate?.(); }
        catch (err) { this.logger.error?.(`[${this.label}] onActivate: ${err.message}`); }
      };

      pending.resetIdleTimer = () => {
        if (!activated) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = armIdle();
        pending.idleTimer = idleTimer;
      };

      // Push into queue, enforce queueCap.
      this.pendingQueue.push(pending);
      this.inFlight = true;
      while (this.pendingQueue.length > this.queueCap) {
        const dropped = this.pendingQueue.splice(1, 1)[0];
        if (!dropped) break;
        dropped.clearTimers?.();
        const dropErr = Object.assign(
          new Error(`queue overflow: dropped (queue cap ${this.queueCap})`),
          { code: 'QUEUE_OVERFLOW' },
        );
        this._logEvent('queue-overflow-drop', {
          session_key: this.sessionKey,
          chat_id: this.chatId,
          queue_len: this.pendingQueue.length,
          source_msg_id: dropped.context?.sourceMsgId ?? null,
        });
        this.emit('queue-drop', dropped);
        dropped.reject(dropErr);
      }

      if (this.pendingQueue.length === 1) pending.activate();

      try {
        this.inputController.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        });
      } catch (err) {
        const idx = this.pendingQueue.indexOf(pending);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        if (this.pendingQueue.length === 0) this.inFlight = false;
        pending.reject(err);
      }
    });
  }

  // ─── Per-session control surface ────────────────────────────────

  async interrupt() {
    if (this.closed) return false;
    try { await this.query.interrupt?.(); }
    catch (err) {
      this.logger.error?.(`[${this.label}] interrupt: ${err.message}`);
      return false;
    }
    this._logEvent('interrupt-applied', { session_key: this.sessionKey });
    return true;
  }

  drainQueue(errCode = 'INTERRUPTED') {
    let count = 0;
    while (this.pendingQueue.length > 0) {
      const p = this.pendingQueue.shift();
      p.clearTimers?.();
      const err = Object.assign(new Error(`drained:${errCode}`), { code: errCode });
      try { p.reject(err); } catch { /* swallow */ }
      count++;
    }
    this.inFlight = false;
    this._logEvent('drain-queue', { session_key: this.sessionKey, code: errCode, count });
    return count;
  }

  async setModel(model) {
    if (this.closed) return false;
    try { await this.query.setModel?.(model); return true; }
    catch (err) {
      this.logger.error?.(`[${this.label}] setModel: ${err.message}`);
      return false;
    }
  }

  async setPermissionMode(mode) {
    if (this.closed) return false;
    try { await this.query.setPermissionMode?.(mode); return true; }
    catch (err) {
      this.logger.error?.(`[${this.label}] setPermissionMode: ${err.message}`);
      return false;
    }
  }

  async applyFlagSettings(settings) {
    if (this.closed) return false;
    try { await this.query.applyFlagSettings?.(settings); return true; }
    catch (err) {
      this.logger.error?.(`[${this.label}] applyFlagSettings: ${err.message}`);
      return false;
    }
  }

  steer(text, { shouldQuery = false } = {}) {
    if (this.closed) return false;
    try {
      this.inputController.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        priority: 'now',
        shouldQuery,
      });
      this._logEvent('steer', {
        session_key: this.sessionKey,
        chat_id: this.chatId,
        should_query: shouldQuery,
        text_len: text?.length ?? 0,
      });
      return true;
    } catch (err) {
      this.logger.error?.(`[${this.label}] steer: ${err.message}`);
      return false;
    }
  }

  injectUserMessage({ content, priority = 'next', shouldQuery, parent_tool_use_id = null } = {}) {
    if (this.closed) return false;
    if (typeof content !== 'string' || !content) {
      // R1-F1: hot path — never throw. Just refuse.
      return false;
    }
    try {
      const msg = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id,
      };
      if (priority !== undefined) msg.priority = priority;
      if (shouldQuery !== undefined) msg.shouldQuery = shouldQuery;
      this.inputController.push(msg);
      const head = this.pendingQueue?.[0];
      if (head) head.pendingSteerCausesNewBubble = true;
      this._logEvent('inject-user-message', {
        session_key: this.sessionKey,
        chat_id: this.chatId,
        priority: priority ?? null,
        should_query: shouldQuery ?? null,
        text_len: content.length,
      });
      return true;
    } catch (err) {
      this.logger.error?.(`[${this.label}] injectUserMessage: ${err.message}`);
      return false;
    }
  }

  async resetSession({ reason = 'user-requested' } = {}) {
    const drainedPendings = this.drainQueue('RESET_SESSION');
    const closed = await this._closeQuery(reason);
    if (this.db?.clearSessionId) {
      try { this.db.clearSessionId(this.sessionKey); }
      catch (err) { this.logger.error?.(`[${this.label}] clearSessionId: ${err.message}`); }
    }
    this._logEvent('session-reset', {
      session_key: this.sessionKey, reason, drained_pendings: drainedPendings, closed,
    });
    return { closed, drainedPendings };
  }

  async getContextUsage() {
    if (this.closed) throw new UnsupportedOperationError('getContextUsage', this.backend);
    if (typeof this.query?.getContextUsage !== 'function') {
      throw new UnsupportedOperationError('getContextUsage', this.backend);
    }
    return this.query.getContextUsage();
  }

  // ─── kill ──────────────────────────────────────────────────────

  async kill(reason = 'kill') {
    this.drainQueue('KILLED');
    await this._closeQuery(reason);
  }

  /**
   * Race Query.close() against the close timeout. Returns true if
   * close resolved cleanly; false if it timed out. Per D7.
   */
  async _closeQuery(reason) {
    if (this.closed) return true;
    this.closed = true;
    try { this.inputController?.close(); } catch { /* swallow */ }
    let timedOut = false;
    const closeP = (async () => {
      try { await this.query?.close?.(); }
      catch (err) {
        this.logger.error?.(`[${this.label}] query.close: ${err.message}`);
      }
    })();
    const timerP = new Promise((resolve) => setTimeout(() => {
      timedOut = true;
      resolve();
    }, this.queryCloseTimeoutMs));
    await Promise.race([closeP, timerP]);
    if (timedOut) {
      this._logEvent('evict-close-timeout', {
        session_key: this.sessionKey, reason, timeout_ms: this.queryCloseTimeoutMs,
      });
    }
    this.emit('close', timedOut ? 1 : 0);
    return !timedOut;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  _failAllPendings(err) {
    while (this.pendingQueue.length > 0) {
      const p = this.pendingQueue.shift();
      p.clearTimers?.();
      try { p.reject(err); } catch { /* swallow */ }
    }
    this.inFlight = false;
  }

  _handleQueueDrop(droppedMsg) {
    // The dropped message was a queued user message not yet consumed
    // by SDK. Find the corresponding pending and reject it.
    // (Pendings and pushed messages are 1:1 in order; we dropped
    // from the FRONT, which corresponds to pendingQueue[1] —
    // head=in-flight is index 0.)
    if (this.pendingQueue.length < 2) return;
    const dropped = this.pendingQueue.splice(1, 1)[0];
    if (!dropped) return;
    dropped.clearTimers?.();
    const err = Object.assign(
      new Error(`queue overflow: dropped (queue cap ${this.queueCap})`),
      { code: 'QUEUE_OVERFLOW' },
    );
    this._logEvent('queue-overflow-drop', {
      session_key: this.sessionKey,
      chat_id: this.chatId,
      queue_len: this.pendingQueue.length,
      source_msg_id: dropped.context?.sourceMsgId ?? null,
    });
    this.emit('queue-drop', dropped);
    dropped.reject(err);
  }

  _logEvent(kind, detail) {
    if (!this.db?.logEvent) return;
    try { this.db.logEvent(kind, detail); }
    catch (err) { this.logger.error?.(`[sdk-process] logEvent ${kind} failed: ${err.message}`); }
  }
}

module.exports = {
  SdkProcess,
  extractAssistantText,
  sumUsage,
  makeInputController,
  // Constants exposed for tests + the pm
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUERY_CLOSE_TIMEOUT_MS,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  MAX_TRANSIENT_RETRIES,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_TURN_MS,
};
