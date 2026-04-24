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

class ProcessManager {
  constructor({
    cap = DEFAULT_CAP,
    spawnFn,
    db = null,
    logger = console,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    onInit = null,        // (sessionKey, event, entry) → void
    onResult = null,      // (sessionKey, event, entry, pending) → void
    onClose = null,       // (sessionKey, code, entry) → void
    onStreamChunk = null, // (sessionKey, partialText, entry) → void — routes to pendingQueue[0]
    onToolUse = null,     // (sessionKey, toolName, entry) → void — routes to pendingQueue[0]
    onRespawn = null,     // (sessionKey, reason, entry) → void — fires after graceful drain-and-kill
  } = {}) {
    if (!spawnFn) throw new Error('spawnFn required');
    this.cap = cap;
    this.spawnFn = spawnFn;
    this.db = db;
    this.logger = logger;
    this.killTimeoutMs = killTimeoutMs;
    this.onInit = onInit;
    this.onResult = onResult;
    this.onClose = onClose;
    this.onStreamChunk = onStreamChunk;
    this.onToolUse = onToolUse;
    this.onRespawn = onRespawn;
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
      if (!evicted) throw new Error('LRU full: all processes in-flight');
    }
    return this._spawn(sessionKey, spawnContext);
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
      this._killAndNotifyRespawn(sessionKey, reason).catch(() => {});
      return { killed: true, queued: 0 };
    }
    return { killed: false, queued: entry.pendingQueue.length };
  }

  async _killAndNotifyRespawn(sessionKey, reason) {
    const entry = this.procs.get(sessionKey);
    await this.kill(sessionKey);
    if (this.onRespawn && entry) {
      try { this.onRespawn(sessionKey, reason, entry); }
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
        if (this.onStreamChunk) {
          const added = extractAssistantText(event);
          if (added) {
            head.streamText = head.streamText
              ? `${head.streamText}\n\n${added}`
              : added;
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
        head.resolve({
          text: event.result || '',
          sessionId: event.session_id,
          cost: event.total_cost_usd,
          duration: event.duration_ms,
          error: event.subtype === 'success' ? null : (event.error || event.subtype),
        });
        // Activate next head or settle idle state.
        if (entry.pendingQueue.length > 0) {
          entry.pendingQueue[0].activate();
        } else {
          entry.inFlight = false;
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
            this._killAndNotifyRespawn(sessionKey, reason).catch(() => {});
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

      entry.pendingQueue.push(pending);
      entry.inFlight = true;

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

module.exports = { ProcessManager, DEFAULT_CAP, extractAssistantText };
