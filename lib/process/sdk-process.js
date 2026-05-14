/**
 * SdkProcess — adapter over the existing `lib/sdk/process-manager.js`
 * implementation, exposing the abstract `Process` interface.
 *
 * Phase 1 implementation choice:
 *
 * Rather than extract the per-entry guts from the current 1178-line
 * `ProcessManagerSdk` class into a new SdkProcess class (a risky
 * refactor of subtle event-handler logic), we write SdkProcess as a
 * thin adapter that wraps a single sessionKey's interactions with a
 * shared underlying `ProcessManagerSdk` instance.
 *
 * What this buys us:
 *   - Zero behavior change risk for the SDK code path
 *   - All 1618 existing tests still apply to the underlying pm
 *   - The abstraction layer ships immediately — Phase 2 can build
 *     TmuxProcess against the same Process contract
 *   - Future cleanup phase (post-tmux soak) replaces this adapter
 *     with a true per-Process extraction
 *
 * The shared underlying pm is provided by the factory (see polygram.js
 * wiring). Multiple SdkProcess instances share one pm; each is bound
 * to its sessionKey and forwards methods through.
 *
 * Lifecycle events on the underlying pm fire as constructor callbacks
 * (onInit, onStreamChunk, etc.) — the factory routes those to the
 * right SdkProcess instance via sessionKey lookup, which re-emits
 * them on its EventEmitter for the generic ProcessManager to forward.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.2
 */

'use strict';

const { Process, UnsupportedOperationError } = require('./process');

class SdkProcess extends Process {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey
   * @param {string|null} opts.chatId
   * @param {string|null} opts.threadId
   * @param {string} opts.label
   * @param {object} opts.sdkPm    — the shared underlying ProcessManagerSdk instance
   */
  constructor({ sessionKey, chatId, threadId, label, sdkPm }) {
    super({ sessionKey, chatId, threadId, label });
    this.backend = 'sdk';
    if (!sdkPm) throw new TypeError('SdkProcess: sdkPm required');
    this._sdkPm = sdkPm;
    this._spawnContext = null;
  }

  // SDK Process is the lightweight default — cost=1.
  get cost() { return 1; }

  // ─── State proxies — read from the underlying pm entry ───────────

  get closed() {
    const entry = this._sdkPm.get(this.sessionKey);
    return !entry || entry.closed;
  }
  set closed(_v) { /* read-only proxy — underlying pm controls this */ }

  get inFlight() {
    const entry = this._sdkPm.get(this.sessionKey);
    return !!(entry && entry.inFlight);
  }
  set inFlight(_v) { /* read-only proxy */ }

  get pendingQueue() {
    const entry = this._sdkPm.get(this.sessionKey);
    return entry ? entry.pendingQueue : [];
  }
  set pendingQueue(_v) { /* read-only proxy — abstract base ctor writes []; we ignore */ }

  get claudeSessionId() {
    const entry = this._sdkPm.get(this.sessionKey);
    return entry ? entry.sessionId : null;
  }
  set claudeSessionId(_v) { /* read-only proxy */ }

  // ─── Required Process methods ────────────────────────────────────

  async start(ctx) {
    this._spawnContext = ctx;
    // getOrSpawn on the underlying pm — it'll spawn an entry, run
    // its iteration loop, fire the lifecycle callbacks the factory
    // routed to forward to THIS instance's EventEmitter.
    await this._sdkPm.getOrSpawn(this.sessionKey, ctx);
  }

  async send(prompt, opts) {
    return this._sdkPm.send(this.sessionKey, prompt, opts);
  }

  async kill(_reason) {
    const entry = this._sdkPm.get(this.sessionKey);
    if (!entry) return;
    // Underlying pm has its own _closeEntry / iteration-loop teardown.
    // Pull the entry out and let its iteration cleanup handle the
    // rest (matches today's behaviour exactly).
    try {
      if (entry.query?.close) entry.query.close();
    } catch {}
    try {
      if (entry.inputController?.close) entry.inputController.close();
    } catch {}
    // The pm's _runIteration finally block will call procs.delete()
    // when the iterator exits. Wait for it with a timeout (matches
    // queryCloseTimeoutMs in the current pm).
    const queryCloseTimeoutMs = this._sdkPm.queryCloseTimeoutMs || 5000;
    if (entry.iteratePromise) {
      await Promise.race([
        entry.iteratePromise.catch(() => {}),
        new Promise((r) => setTimeout(r, queryCloseTimeoutMs)),
      ]);
    }
    // Belt-and-braces: ensure deletion if iteration didn't.
    if (this._sdkPm.has?.(this.sessionKey)) {
      this._sdkPm.procs?.delete(this.sessionKey);
    }
  }

  // ─── Optional async methods — delegate to underlying pm ──────────

  async interrupt() {
    return this._sdkPm.interrupt(this.sessionKey);
  }

  async setModel(model) {
    return this._sdkPm.setModel(this.sessionKey, model);
  }

  async applyFlagSettings(settings) {
    return this._sdkPm.applyFlagSettings(this.sessionKey, settings);
  }

  async setPermissionMode(mode) {
    return this._sdkPm.setPermissionMode(this.sessionKey, mode);
  }

  async resetSession(opts) {
    return this._sdkPm.resetSession?.(this.sessionKey, opts) || { closed: true, drainedPendings: 0 };
  }

  async getContextUsage() {
    const entry = this._sdkPm.get(this.sessionKey);
    if (!entry?.query?.getContextUsage) {
      throw new UnsupportedOperationError('getContextUsage', this.backend);
    }
    return entry.query.getContextUsage();
  }

  // ─── Optional sync hot-path — NEVER throws (R1-F1) ───────────────

  drainQueue(code = 'INTERRUPTED') {
    return this._sdkPm.drainQueue(this.sessionKey, code);
  }

  injectUserMessage(opts) {
    return this._sdkPm.injectUserMessage(this.sessionKey, opts) || false;
  }

  steer(text, opts) {
    return this._sdkPm.steer(this.sessionKey, text, opts) || false;
  }
}

module.exports = { SdkProcess };
