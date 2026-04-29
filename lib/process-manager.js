/**
 * LRU-bounded warm process pool with FIFO pending queue per process.
 *
 * Each `entry` owns ONE claude subprocess. Messages sent via `send()` are
 * appended to `entry.pendingQueue` and their prompt is written to the
 * subprocess stdin. Claude processes stdin in FIFO order and emits one
 * `result` event per turn. Each result resolves the oldest pending
 * (queue head).
 *
 * Timers (idle + wall-clock) are only armed for the HEAD of the queue —
 * the turn Claude is currently working on. When the head is shifted,
 * the next pending becomes head and its timers arm fresh. This avoids
 * the footgun of "pending #2's timer started ticking when its stdin
 * was written, but Claude spent 5 minutes on pending #1 first → #2
 * times out before Claude sees it".
 *
 * Timer fire rejects ONLY that pending (policy: don't kill the whole
 * subprocess, other in-flight work is probably fine). If the subprocess
 * is truly stuck, its head pending will time out repeatedly.
 *
 * The `onStreamChunk` and `onToolUse` callbacks pass the live `entry` so
 * callers can inspect `entry.pendingQueue[0]` to route output to the
 * correct turn's streamer / reactor / source message.
 *
 * All I/O (spawn, db) is injected for testability.
 */

const { createInterface } = require('readline');

const DEFAULT_CAP = 10;
const DEFAULT_KILL_TIMEOUT_MS = 3000;
// 0.7.6 (item H): hard cap on per-session pending queue depth.
// Pre-fix, a chat with rapid-fire user messages (or a stuck Claude that
// stops emitting `result`) could grow pendingQueue unbounded — each
// pending holds a streamer + reactor + timers, so a runaway client
// could exhaust memory or burn API quota for ack reactions on every
// dropped message. 50 is generous (a normal turn never queues more
// than a handful) but safely bounded.
const DEFAULT_QUEUE_CAP = 50;

/**
 * Pull user-visible text from a stream-json `assistant` event.
 * See header for colon-normalisation / tool_use-filter rationale.
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

// 0.7.6 (item F): sum the four canonical usage counters across a Map of
// per-message usage objects. Each map value is the LAST-SEEN usage for
// that message id (Anthropic emits cumulative totals within a message);
// summing across map values gives the turn-wide totals.
//
// Defensive against missing fields — older claude versions may not
// always emit cache_*_input_tokens.
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

class ProcessManager {
  constructor({
    cap = DEFAULT_CAP,
    queueCap = DEFAULT_QUEUE_CAP,
    spawnFn,
    db = null,
    logger = console,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    onInit = null,        // (sessionKey, event, entry) → void
    onResult = null,      // (sessionKey, event, entry, pending) → void
    onClose = null,       // (sessionKey, code, entry) → void
    onStreamChunk = null, // (sessionKey, partialText, entry) → void — routes to pendingQueue[0]
    onToolUse = null,     // (sessionKey, toolName, entry) → void — routes to pendingQueue[0]
    onAssistantMessageStart = null, // (sessionKey, entry) → void — fires when a NEW top-level assistant message begins (after a previous one ended). Used by polygram.js to call streamer.forceNewMessage() so each assistant message gets its own bubble.
    onRespawn = null,     // (sessionKey, reason, entry) → void — fires after graceful drain-and-kill
    onQueueDrop = null,   // 0.7.6: (sessionKey, droppedPending, entry) → void — fired when a pending is dropped because pendingQueue exceeded queueCap. Polygram uses this to surface a warning on the dropped message.
  } = {}) {
    if (!spawnFn) throw new Error('spawnFn required');
    this.cap = cap;
    this.queueCap = queueCap;
    this.spawnFn = spawnFn;
    this.db = db;
    this.logger = logger;
    this.killTimeoutMs = killTimeoutMs;
    this.onInit = onInit;
    this.onResult = onResult;
    this.onClose = onClose;
    this.onStreamChunk = onStreamChunk;
    this.onToolUse = onToolUse;
    this.onAssistantMessageStart = onAssistantMessageStart;
    this.onRespawn = onRespawn;
    this.onQueueDrop = onQueueDrop;
    this.procs = new Map();
  }

  has(sessionKey) {
    return this.procs.has(sessionKey);
  }

  get(sessionKey) {
    return this.procs.get(sessionKey);
  }

  size() {
    return this.procs.size;
  }

  keys() {
    return Array.from(this.procs.keys());
  }

  async getOrSpawn(sessionKey, spawnContext) {
    const existing = this.procs.get(sessionKey);
    if (existing && !existing.closed) {
      existing.lastUsedTs = Date.now();
      return existing;
    }
    if (this.procs.size >= this.cap) {
      const evicted = await this.evictLRU();
      if (!evicted) {
        // All sessions are in-flight — wait for one to drain, then retry.
        // Waiters are held in `this._lruWaiters` FIFO and signalled when any
        // pending queue empties (see _maybeSignalLruWaiter).
        await this._awaitLruSlot();
        // After waking, try the whole path again — the evictLRU may now
        // succeed, or an existing session may have been spawned for this key.
        return this.getOrSpawn(sessionKey, spawnContext);
      }
    }
    return this._spawn(sessionKey, spawnContext);
  }

  // Hold a promise pair per waiter. _maybeSignalLruWaiter shifts the oldest
  // waiter when a slot might have freed up. Each waiter has its own timer
  // that rejects with 'LRU wait timeout' if no slot appears in time.
  _awaitLruSlot({ timeoutMs = 5 * 60_000 } = {}) {
    if (!this._lruWaiters) this._lruWaiters = [];
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const idx = this._lruWaiters.indexOf(waiter);
        if (idx !== -1) this._lruWaiters.splice(idx, 1);
        this._logEvent('lru-wait-timeout', { cap: this.cap, queued_waiters: this._lruWaiters.length });
        reject(new Error(`LRU wait timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      waiter.timer = timer;
      this._lruWaiters.push(waiter);
      this._logEvent('lru-wait', { cap: this.cap, queued_waiters: this._lruWaiters.length });
    });
  }

  _maybeSignalLruWaiter() {
    if (!this._lruWaiters || this._lruWaiters.length === 0) return;
    // Only signal if there's actually capacity now (a session went idle
    // or closed). Otherwise keep waiters sleeping for the next chance.
    let hasIdle = false;
    for (const v of this.procs.values()) {
      if (!v.inFlight) { hasIdle = true; break; }
    }
    if (!hasIdle && this.procs.size >= this.cap) return;
    const w = this._lruWaiters.shift();
    clearTimeout(w.timer);
    w.resolve();
  }

  async evictLRU() {
    let victim = null;
    for (const [k, v] of this.procs) {
      if (v.inFlight) continue;
      if (!victim || v.lastUsedTs < victim.entry.lastUsedTs) {
        victim = { key: k, entry: v };
      }
    }
    if (!victim) {
      this._logEvent('lru-full', { cap: this.cap });
      return false;
    }
    this._logEvent('evict', { session_key: victim.key, chat_id: victim.entry.chatId });
    await this.kill(victim.key);
    return true;
  }

  /**
   * Request a graceful respawn (e.g. because /model or /effort changed).
   * If the queue is empty, kill now; otherwise mark the entry so it kills
   * itself when the last pending resolves. Next send() respawns fresh
   * with whatever config spawnFn reads at that moment.
   *
   * onRespawn fires with `wasDrained=true` ONLY when we waited for an
   * in-flight turn to finish before swapping. The immediate-kill case
   * (queue empty at request time) calls onRespawn with `wasDrained=false`
   * so callers can decide whether to post a user-visible confirmation
   * (which is redundant noise when the user wasn't waiting on a turn).
   */
  requestRespawn(sessionKey, reason = 'config-change') {
    const entry = this.procs.get(sessionKey);
    if (!entry || entry.closed) return { killed: false, queued: 0 };
    entry.needsRespawn = reason;
    this._logEvent('respawn-requested', {
      session_key: sessionKey,
      chat_id: entry.chatId,
      reason,
      queued: entry.pendingQueue.length,
    });
    if (entry.pendingQueue.length === 0) {
      // Queue empty — kill immediately, fire onRespawn after close.
      this._killAndNotifyRespawn(sessionKey, reason, false).catch(() => {});
      return { killed: true, queued: 0 };
    }
    return { killed: false, queued: entry.pendingQueue.length };
  }

  async _killAndNotifyRespawn(sessionKey, reason, wasDrained) {
    const entry = this.procs.get(sessionKey);
    await this.kill(sessionKey);
    if (this.onRespawn && entry) {
      try { this.onRespawn(sessionKey, reason, entry, wasDrained); }
      catch (err) { this.logger.error(`[pm] onRespawn: ${err.message}`); }
    }
  }

  async kill(sessionKey) {
    const entry = this.procs.get(sessionKey);
    if (!entry) return;
    this.procs.delete(sessionKey);
    try { entry.proc.kill('SIGTERM'); } catch {}
    await new Promise((resolve) => {
      if (entry.closed) return resolve();
      const timer = setTimeout(() => {
        try { entry.proc.kill('SIGKILL'); } catch {}
        resolve();
      }, this.killTimeoutMs);
      entry.proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
    // Reject all pendings in the queue (if any survived the 'close' handler).
    while (entry.pendingQueue.length > 0) {
      const p = entry.pendingQueue.shift();
      p.clearTimers?.();
      p.reject(new Error('Process killed'));
    }
  }

  async killChat(chatId) {
    const prefix = String(chatId);
    const targets = [];
    for (const key of this.procs.keys()) {
      if (key === prefix || key.startsWith(prefix + ':')) targets.push(key);
    }
    for (const key of targets) await this.kill(key);
  }

  async shutdown() {
    const keys = Array.from(this.procs.keys());
    for (const key of keys) await this.kill(key);
  }

  _spawn(sessionKey, ctx = {}) {
    const proc = this.spawnFn(sessionKey, ctx);
    const rl = createInterface({ input: proc.stdout });
    const entry = {
      sessionKey,
      proc,
      rl,
      pendingQueue: [],
      lastUsedTs: Date.now(),
      inFlight: false,
      closed: false,
      needsRespawn: null,
      sessionId: ctx.existingSessionId || null,
      chatId: ctx.chatId || null,
      threadId: ctx.threadId || null,
      label: ctx.label || sessionKey,
    };

    rl.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); }
      catch { this.logger.error(`[${entry.label}] non-JSON: ${line.slice(0, 200)}`); return; }

      // Fix A: ANY stream-json event counts as Claude activity. Reset the
      // idle timer on the HEAD pending (the turn Claude is working on),
      // regardless of event type. Subagent runs emit `user`-type
      // tool_result events between the parent's assistant events — those
      // previously did NOT reset the timer, causing false timeouts during
      // long subagent work.
      const head = entry.pendingQueue[0];
      if (head) head.resetIdleTimer?.();

      if (event.type === 'system' && event.subtype === 'init') {
        entry.sessionId = event.session_id;
        if (this.onInit) this.onInit(sessionKey, event, entry);
      }

      if (event.type === 'assistant' && head) {
        // 0.7.0 (Phase F): detect message_id transitions to split bubbles
        // per top-level assistant message. Each Anthropic stream-json
        // 'assistant' event carries event.message.id; the same id across
        // events means cumulative updates to the same message, a new
        // id means a new message (typically after a tool-result cycle).
        const messageId = event.message?.id;
        const added = extractAssistantText(event);
        // 0.7.4 (item B): first sign Claude is doing real work on this
        // pending. Fire onFirstStream ONCE, regardless of whether the
        // assistant message has text or only tool_use blocks (some turns
        // emit tool_use first with no preamble).
        if (added || (Array.isArray(event.message?.content)
            && event.message.content.some((b) => b?.type === 'tool_use'))) {
          head.fireFirstStream?.();
        }
        // 0.7.6 (item F): accumulate usage + counters for turn telemetry.
        // The `result` event carries total_cost_usd + duration_ms but NOT
        // a usage breakdown; usage lives on each assistant.message.usage.
        // Anthropic emits cumulative totals per assistant message id
        // (so within a single message the last usage seen wins; across
        // distinct messages they sum).
        const usage = event.message?.usage;
        if (usage) {
          if (messageId != null && head.lastUsageMessageId === messageId) {
            // same message, replace running totals for this message
            head.usageByMessage.set(messageId, usage);
          } else {
            head.lastUsageMessageId = messageId;
            head.usageByMessage.set(messageId, usage);
          }
        }
        if (Array.isArray(event.message?.content)) {
          for (const b of event.message.content) {
            if (b?.type === 'tool_use') head.toolUseCount++;
          }
        }
        if (added) {
          // Pre-0.7.0 we did `streamText = streamText + '\n\n' + added`,
          // which DUPLICATED text on every update because `added` is
          // the cumulative full text-so-far of the current assistant
          // message (not a delta). 0.7.0 REPLACES instead — the new
          // text is already cumulative — and uses messageId boundaries
          // to fire onAssistantMessageStart for each new top-level
          // assistant message. The streamer responds by force-creating
          // a fresh bubble, so each assistant message gets its own.
          const isNewMessage = head.lastAssistantMessageId != null
            && messageId != null
            && head.lastAssistantMessageId !== messageId
            && head.streamText
            && head.streamText.length > 0;
          if (isNewMessage && this.onAssistantMessageStart) {
            try { this.onAssistantMessageStart(sessionKey, entry); }
            catch (err) { this.logger.error(`[${entry.label}] onAssistantMessageStart: ${err.message}`); }
          }
          if (messageId != null) head.lastAssistantMessageId = messageId;
          head.streamText = added;
          if (this.onStreamChunk) {
            try { this.onStreamChunk(sessionKey, head.streamText, entry); }
            catch (err) { this.logger.error(`[${entry.label}] onStreamChunk: ${err.message}`); }
          }
        }
        if (this.onToolUse) {
          const blocks = event.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === 'tool_use' && b.name) {
                try { this.onToolUse(sessionKey, b.name, entry); }
                catch (err) { this.logger.error(`[${entry.label}] onToolUse: ${err.message}`); }
              }
            }
          }
        }
      }

      if (event.type === 'result' && head) {
        entry.pendingQueue.shift();
        head.clearTimers();
        if (this.onResult) this.onResult(sessionKey, event, entry, head);
        // 0.7.6 (item F): sum usage across distinct assistant messages
        // (each message id seen got its last-known usage stored; sum the
        // map values). Yields a single-row metric summary the caller
        // can persist via db.insertTurnMetric().
        const usageTotals = sumUsage(head.usageByMessage);
        head.resolve({
          text: event.result || '',
          sessionId: event.session_id,
          cost: event.total_cost_usd,
          duration: event.duration_ms,
          error: event.subtype === 'success' ? null : (event.error || event.subtype),
          metrics: {
            inputTokens: usageTotals.input_tokens,
            outputTokens: usageTotals.output_tokens,
            cacheCreationTokens: usageTotals.cache_creation_input_tokens,
            cacheReadTokens: usageTotals.cache_read_input_tokens,
            numAssistantMessages: head.usageByMessage.size,
            numToolUses: head.toolUseCount,
            resultSubtype: event.subtype || null,
          },
        });
        // Activate next head or settle idle state.
        if (entry.pendingQueue.length > 0) {
          entry.pendingQueue[0].activate();
        } else {
          entry.inFlight = false;
          // An entry just went idle → an LRU waiter might be able to run now.
          this._maybeSignalLruWaiter();
          // Graceful drain-and-respawn: if caller asked for a respawn
          // (e.g. /model change) and we just emptied the queue, kill now
          // and fire onRespawn so the caller can post confirmation.
          if (entry.needsRespawn) {
            const reason = entry.needsRespawn;
            entry.needsRespawn = null;
            this._logEvent('respawn-draining', {
              session_key: sessionKey,
              chat_id: entry.chatId,
              reason,
            });
            // wasDrained=true: this path runs after the queue emptied
            // naturally (an in-flight turn finished), so the user was
            // waiting and the confirmation message is meaningful.
            this._killAndNotifyRespawn(sessionKey, reason, true).catch(() => {});
          }
        }
      }
    });

    proc.on('close', (code) => {
      entry.closed = true;
      entry.inFlight = false;
      while (entry.pendingQueue.length > 0) {
        const p = entry.pendingQueue.shift();
        p.clearTimers?.();
        p.reject(new Error(`Process exited (code ${code})`));
      }
      this.procs.delete(sessionKey);
      // A slot freed up → maybe an LRU waiter can run now.
      this._maybeSignalLruWaiter();
      if (code !== 0 && ctx.existingSessionId && this.db?.clearSessionId) {
        this._logEvent('resume-fail', { session_key: sessionKey, session_id: ctx.existingSessionId, code });
        try { this.db.clearSessionId(sessionKey); } catch (err) {
          this.logger.error(`[${entry.label}] clearSessionId failed: ${err.message}`);
        }
      }
      if (this.onClose) this.onClose(sessionKey, code, entry);
    });

    proc.on('error', (err) => {
      this.logger.error(`[${entry.label}] proc error: ${err.message}`);
      entry.closed = true;
      entry.inFlight = false;
      while (entry.pendingQueue.length > 0) {
        const p = entry.pendingQueue.shift();
        p.clearTimers?.();
        p.reject(err);
      }
      this.procs.delete(sessionKey);
    });

    this.procs.set(sessionKey, entry);
    return entry;
  }

  /**
   * Append a turn to the queue. The returned promise resolves when Claude
   * emits a `result` event for this turn (they emerge in stdin-write
   * order). The underlying stdin write happens synchronously inside this
   * call — the caller should have already serialised writes across
   * sessions via an external lock if order matters.
   *
   * Options:
   *   timeoutMs — idle timer between Claude events (default 10min)
   *   maxTurnMs — wall-clock ceiling from "activate" time (default 30min)
   *   context   — opaque object stored on the pending (polygram puts
   *               streamer, reactor, sourceMsgId here for its own use)
   */
  send(sessionKey, prompt, {
    timeoutMs = 600_000,
    maxTurnMs = 30 * 60_000,
    context = {},
  } = {}) {
    return new Promise((resolve, reject) => {
      const entry = this.procs.get(sessionKey);
      if (!entry || entry.closed) return reject(new Error('No process for session'));
      if (!entry.proc.stdin || entry.proc.stdin.destroyed || !entry.proc.stdin.writable) {
        return reject(new Error('Process stdin not writable'));
      }
      // If this entry is awaiting respawn, refuse new sends — the caller
      // should wait for the respawn to complete (which happens when the
      // current queue drains).
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
        // 0.7.6 (item F): per-turn telemetry accumulators. usageByMessage
        // collects each assistant message's last-seen usage; we sum
        // across messages at result time (each id is summed once, not
        // per stream chunk, since usage in stream-json is cumulative
        // *within* a message — last-seen-per-message wins).
        usageByMessage: new Map(),
        lastUsageMessageId: null,
        toolUseCount: 0,
        // 0.7.4 (item B): set true when the first stream event (assistant
        // text or tool_use) arrives for this pending. Fires
        // `context.onFirstStream` once. Used by polygram to flip the
        // status reaction QUEUED → THINKING when Claude actually starts
        // producing output, not when the pending becomes queue head
        // (which can be ~hundreds of ms before the first token).
        firstStreamFired: false,
      };

      pending.fireFirstStream = () => {
        if (pending.firstStreamFired) return;
        pending.firstStreamFired = true;
        try { context?.onFirstStream?.(); }
        catch (err) { this.logger.error(`[${entry.label}] onFirstStream: ${err.message}`); }
      };

      const fireTimeout = (reason) => {
        // Only act if we're still the head; if we've been shifted/killed
        // already, this is a stale callback.
        if (entry.pendingQueue[0] !== pending) return;
        this._logEvent('turn-timeout', {
          session_key: sessionKey,
          chat_id: entry.chatId,
          reason,
        });
        // Remove from queue, reject. Per Q1 policy: don't kill the
        // subprocess — later pendings might still be fine.
        entry.pendingQueue.shift();
        pending.reject(new Error(reason));
        // Activate next head if any, else idle.
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
        // Give callers a hook so they can transition user-visible state
        // (e.g. status reaction "👀 queued" → "🤔 thinking") the moment
        // Claude actually starts this pending, not the moment it arrived.
        try { context?.onActivate?.(); }
        catch (err) { this.logger.error(`[${entry.label}] onActivate: ${err.message}`); }
      };

      pending.resetIdleTimer = () => {
        if (!activated) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = armIdle();
        pending.idleTimer = idleTimer;
      };

      // 0.7.6 (item H): enforce per-session queue cap. Drop the OLDEST
      // non-active pending (index 1 — index 0 is the in-flight head and
      // killing it mid-turn would corrupt Claude's state). The dropped
      // pending's promise rejects so its handler (polygram.js) can
      // surface a "couldn't keep up — message dropped" warning to the
      // user. We drop AFTER pushing the new pending so the cap means
      // "at most queueCap pendings live", not "refuse to enqueue past N".
      // Refusing the new write would lose the most recent message —
      // usually the one the user actually cares about — whereas
      // dropping the oldest preserves recency at the cost of a stale
      // queued turn that the user has likely moved past anyway.
      entry.pendingQueue.push(pending);
      entry.inFlight = true;
      while (entry.pendingQueue.length > this.queueCap) {
        // Splice at index 1 to leave the active head intact.
        const dropped = entry.pendingQueue.splice(1, 1)[0];
        if (!dropped) break;
        dropped.clearTimers?.();
        const dropErr = new Error(
          `queue overflow: dropped (queue cap ${this.queueCap})`,
        );
        dropErr.code = 'QUEUE_OVERFLOW';
        this._logEvent('queue-overflow-drop', {
          session_key: sessionKey,
          chat_id: entry.chatId,
          queue_len: entry.pendingQueue.length,
          source_msg_id: dropped.context?.sourceMsgId ?? null,
        });
        if (this.onQueueDrop) {
          try { this.onQueueDrop(sessionKey, dropped, entry); }
          catch (err) { this.logger.error(`[${entry.label}] onQueueDrop: ${err.message}`); }
        }
        dropped.reject(dropErr);
      }

      // If we're the only pending, activate immediately. Otherwise wait
      // until the preceding pending is shifted out.
      if (entry.pendingQueue.length === 1) pending.activate();

      try {
        entry.proc.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: prompt },
        }) + '\n');
      } catch (err) {
        const idx = entry.pendingQueue.indexOf(pending);
        if (idx !== -1) entry.pendingQueue.splice(idx, 1);
        if (entry.pendingQueue.length === 0) entry.inFlight = false;
        pending.reject(err);
      }
    });
  }

  _logEvent(kind, detail) {
    if (!this.db?.logEvent) return;
    try { this.db.logEvent(kind, detail); }
    catch (err) { this.logger.error(`[pm] logEvent ${kind} failed: ${err.message}`); }
  }
}

module.exports = {
  ProcessManager,
  DEFAULT_CAP,
  DEFAULT_QUEUE_CAP,
  extractAssistantText,
  sumUsage,
};
