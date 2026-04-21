/**
 * LRU-bounded warm process pool.
 *
 * - No idle timeout: processes die only via eviction or graceful kill.
 * - Never evict an in-flight process.
 * - Graceful SIGTERM, then SIGKILL after 3 s fallback.
 * - If `--resume <id>` fails on spawn, clear the session_id so the next
 *   message spawns fresh.
 *
 * All I/O (spawn, db) is injected for testability.
 */

const { createInterface } = require('readline');

const DEFAULT_CAP = 10;
const DEFAULT_KILL_TIMEOUT_MS = 3000;

/**
 * Pull text from a stream-json `assistant` event.
 * Claude Code emits one event per assistant step; each carries a
 * `message.content[]` of blocks. Text blocks have `{type:'text', text:'…'}`;
 * tool_use blocks we summarise inline so the user sees what Claude is doing.
 */
function extractAssistantText(event) {
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'tool_use' && b.name) {
      parts.push(`_Calling \`${b.name}\`…_`);
    }
  }
  return parts.join('\n\n').trim();
}

class ProcessManager {
  constructor({
    cap = DEFAULT_CAP,
    spawnFn,
    db = null,
    logger = console,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    onInit = null,       // (sessionKey, event) → void (system init)
    onResult = null,     // (sessionKey, event) → void (turn result)
    onClose = null,      // (sessionKey, code) → void
    onStreamChunk = null,// (sessionKey, partialText, entry) → void (per assistant event)
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

  /**
   * Return existing entry or spawn a new one. Evicts LRU if at capacity.
   * Throws if at capacity and all entries are in-flight.
   */
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
    if (entry.pending) {
      const { reject } = entry.pending;
      entry.pending = null;
      reject(new Error('Process killed'));
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
      pending: null,
      lastUsedTs: Date.now(),
      inFlight: false,
      closed: false,
      sessionId: ctx.existingSessionId || null,
      chatId: ctx.chatId || null,
      threadId: ctx.threadId || null,
      label: ctx.label || sessionKey,
      // Stream accumulator — cleared at each turn start (on send()).
      streamText: '',
    };

    rl.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); }
      catch { this.logger.error(`[${entry.label}] non-JSON: ${line.slice(0, 200)}`); return; }

      if (event.type === 'system' && event.subtype === 'init') {
        entry.sessionId = event.session_id;
        if (this.onInit) this.onInit(sessionKey, event, entry);
      }
      if (event.type === 'assistant' && this.onStreamChunk && entry.pending) {
        const added = extractAssistantText(event);
        if (added) {
          entry.streamText = entry.streamText
            ? `${entry.streamText}\n\n${added}`
            : added;
          try { this.onStreamChunk(sessionKey, entry.streamText, entry); }
          catch (err) { this.logger.error(`[${entry.label}] onStreamChunk: ${err.message}`); }
        }
      }
      if (event.type === 'result' && entry.pending) {
        const { resolve } = entry.pending;
        entry.pending = null;
        entry.inFlight = false;
        if (this.onResult) this.onResult(sessionKey, event, entry);
        resolve({
          text: event.result || '',
          sessionId: event.session_id,
          cost: event.total_cost_usd,
          duration: event.duration_ms,
          error: event.subtype === 'success' ? null : (event.error || event.subtype),
        });
      }
    });

    proc.on('close', (code) => {
      entry.closed = true;
      if (entry.pending) {
        const { reject } = entry.pending;
        entry.pending = null;
        entry.inFlight = false;
        reject(new Error(`Process exited (code ${code})`));
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
      if (entry.pending) {
        const { reject } = entry.pending;
        entry.pending = null;
        entry.inFlight = false;
        reject(err);
      }
      this.procs.delete(sessionKey);
    });

    this.procs.set(sessionKey, entry);
    return entry;
  }

  send(sessionKey, prompt, { timeoutMs = 600_000 } = {}) {
    return new Promise((resolve, reject) => {
      const entry = this.procs.get(sessionKey);
      if (!entry || entry.closed) return reject(new Error('No process for session'));
      if (entry.pending) return reject(new Error('Process busy'));
      // Race: proc may have emitted 'close' between getOrSpawn and send, in
      // which case entry.closed is true but handlers could still be draining.
      // Also guard against a destroyed/ended stdin pipe explicitly — writing
      // to a closed pipe would either throw EPIPE or silently buffer.
      if (!entry.proc.stdin || entry.proc.stdin.destroyed || !entry.proc.stdin.writable) {
        return reject(new Error('Process stdin not writable'));
      }

      entry.inFlight = true;
      entry.lastUsedTs = Date.now();
      entry.pending = { resolve, reject };
      entry.streamText = '';

      const timer = setTimeout(() => {
        if (entry.pending) {
          entry.pending = null;
          entry.inFlight = false;
          reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);

      const wrappedResolve = entry.pending.resolve;
      const wrappedReject = entry.pending.reject;
      entry.pending.resolve = (r) => { clearTimeout(timer); wrappedResolve(r); };
      entry.pending.reject = (e) => { clearTimeout(timer); wrappedReject(e); };

      try {
        entry.proc.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: prompt },
        }) + '\n');
      } catch (err) {
        entry.pending = null;
        entry.inFlight = false;
        clearTimeout(timer);
        reject(err);
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
