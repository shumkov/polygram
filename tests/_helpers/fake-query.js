/**
 * fakeQuery — test harness for `lib/process-manager-sdk.js`.
 *
 * Replaces the `fakeProc` (EventEmitter + PassThrough + raw stream-json
 * lines) used by the original pm tests. The new pm consumes typed
 * `SDKMessage` events from an `AsyncGenerator`, so the harness has to
 * BE that AsyncGenerator AND record the input messages pm pushes via
 * `streamInput()`.
 *
 * Per v4 plan §6.5.6.
 *
 * Usage:
 *
 *   const fq = makeFakeQuery();
 *   const pm = new ProcessManagerSdk({
 *     spawnFn: () => fq.query,        // pm calls spawnFn() and gets back the Query
 *     ...
 *   });
 *   const entry = await pm.getOrSpawn('chat-1');
 *
 *   // Test pushes typed SDKMessage events; pm's iteration loop
 *   // observes them.
 *   fq.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });
 *
 *   const promise = pm.send('chat-1', 'hi');
 *   await new Promise(r => setImmediate(r));
 *
 *   fq.emitEvent({
 *     type: 'assistant',
 *     message: {
 *       id: 'msg-1',
 *       usage: { input_tokens: 10, output_tokens: 5 },
 *       content: [{ type: 'text', text: 'hi back' }],
 *     },
 *   });
 *   fq.emitEvent({
 *     type: 'result', subtype: 'success',
 *     session_id: 'sess-1', total_cost_usd: 0.001, duration_ms: 50,
 *     result: 'hi back',
 *     usage: { input_tokens: 10, output_tokens: 5,
 *              cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
 *   });
 *
 *   const result = await promise;
 *   assert.equal(result.text, 'hi back');
 *
 *   // Inspect what pm pushed (e.g. retry idempotency tests):
 *   assert.deepEqual(fq.pushedMessages, [{ type: 'user', message: { ... } }]);
 *
 *   // Or wait on side-effects via the emitter:
 *   fq.on('userPushed', msg => { ... });
 */

'use strict';

const { EventEmitter } = require('events');

function makeFakeQuery() {
  const emitter = new EventEmitter();
  const pushedMessages = [];                  // captured user messages pm sent via streamInput
  const yieldQueue = [];                      // outgoing iterator queue (events tests pushed)
  let consumerResolve = null;                 // outstanding next() promise
  let closed = false;
  let interrupted = false;
  let modelChanged = null;
  let permissionModeChanged = null;
  let flagSettingsApplied = null;

  // Test-side: simulate SDK emitting a typed SDKMessage to the pm.
  function emitEvent(msg) {
    if (closed) return;
    if (consumerResolve) {
      const r = consumerResolve;
      consumerResolve = null;
      r({ value: msg, done: false });
    } else {
      yieldQueue.push(msg);
    }
    emitter.emit('event', msg);
    if (msg.type) emitter.emit(`event:${msg.type}`, msg);
  }

  function emitEnd() {
    closed = true;
    if (consumerResolve) {
      const r = consumerResolve;
      consumerResolve = null;
      r({ value: undefined, done: true });
    }
  }

  function emitThrow(err) {
    if (consumerResolve) {
      const r = consumerResolve;
      consumerResolve = null;
      r(Promise.reject(err));
    } else {
      // queue a sentinel that next() will throw on
      yieldQueue.push({ __throw: err });
    }
  }

  // Consumer side: pm does `for await (const msg of query)`.
  const query = {
    [Symbol.asyncIterator]() { return query; },
    async next() {
      if (yieldQueue.length) {
        const v = yieldQueue.shift();
        if (v && v.__throw) throw v.__throw;
        return { value: v, done: false };
      }
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve, reject) => {
        consumerResolve = (r) => {
          if (r && typeof r.then === 'function') r.then(resolve, reject);
          else resolve(r);
        };
      });
    },
    async return() {
      closed = true;
      return { value: undefined, done: true };
    },
    async throw(err) {
      closed = true;
      throw err;
    },

    // SDK Query methods pm calls:

    async streamInput(asyncIterable) {
      // pm's contract: pm gives us an AsyncIterable that yields
      // SDKUserMessages. We consume it so user messages are recorded.
      // pm pushes onto the iterable via its inputController.
      for await (const msg of asyncIterable) {
        pushedMessages.push(msg);
        emitter.emit('userPushed', msg);
      }
    },

    async interrupt() {
      interrupted = true;
      emitter.emit('interrupted');
    },

    async close() {
      closed = true;
      emitter.emit('closed');
      if (consumerResolve) {
        const r = consumerResolve;
        consumerResolve = null;
        r({ value: undefined, done: true });
      }
    },

    async setModel(model) {
      modelChanged = model;
      emitter.emit('modelChanged', model);
    },

    async setPermissionMode(mode) {
      permissionModeChanged = mode;
      emitter.emit('permissionModeChanged', mode);
    },

    async setMaxThinkingTokens(n) {
      emitter.emit('maxThinkingTokensSet', n);
    },

    async applyFlagSettings(settings) {
      flagSettingsApplied = settings;
      emitter.emit('flagSettingsApplied', settings);
    },

    async getContextUsage() {
      // Return a reasonable default; tests can override by reassigning
      // before the call.
      return query._contextUsage || {
        percentage: 0.42,
        totalTokens: 84_000,
        maxTokens: 200_000,
      };
    },
  };

  return {
    query,
    emitEvent,
    emitEnd,
    emitThrow,
    pushedMessages,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    get interrupted() { return interrupted; },
    get closed() { return closed; },
    get modelChanged() { return modelChanged; },
    get permissionModeChanged() { return permissionModeChanged; },
    get flagSettingsApplied() { return flagSettingsApplied; },
  };
}

module.exports = { makeFakeQuery };
