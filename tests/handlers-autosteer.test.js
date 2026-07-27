/**
 * Tests for lib/handlers/autosteer.js — autosteer detection + dispatch.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAutosteerHandlers,
  isAutosteerEnabledFor,
  priorityFor,
} = require('../lib/handlers/autosteer');

function makeDeps(overrides = {}) {
  const events = [];
  const refs = [];
  const pmCalls = [];
  return {
    events, refs, pmCalls,
    deps: {
      config: { bot: {} },
      pm: {
        _inFlight: true,
        _hasKey: true,
        has(k) { return this._hasKey; },
        get(k) { return this._hasKey ? { inFlight: this._inFlight } : null; },
        injectUserMessage(k, opts) {
          pmCalls.push(['injectUserMessage', k, opts]);
          return true;
        },
      },
      autosteeredRefs: { add: (key, ref) => refs.push({ key, ref }) },
      logEvent: (kind, detail) => events.push({ kind, detail }),
      ...overrides,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function codexError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function makeCodexDeps(overrides = {}) {
  const events = [];
  const refs = [];
  const steerCalls = [];
  let entry = {
    backend: 'codex',
    runtime: 'codex',
    generationId: 'generation-a',
    inFlight: true,
    closed: false,
    state: 'Active',
    activeTurnId: 'turn-a',
  };
  const pm = {
    has: () => entry != null,
    get: () => entry,
    getBackend: () => entry?.backend ?? null,
    async steerTurn(sessionKey, prompt, opts) {
      steerCalls.push({ sessionKey, prompt, opts });
      return {
        outcome: 'accepted',
        generationId: 'generation-a',
        turnId: 'turn-a',
        attemptId: 'steer-attempt-a',
        targetAttemptId: 'turn-attempt-a',
      };
    },
  };
  Object.assign(pm, overrides.pm);
  return {
    events,
    refs,
    steerCalls,
    get entry() { return entry; },
    setEntry(next) { entry = next; },
    deps: {
      config: { bot: {} },
      pm,
      autosteeredRefs: { add: (key, ref) => refs.push({ key, ref }) },
      logEvent: (kind, detail) => events.push({ kind, detail }),
      ...overrides,
      pm,
    },
  };
}

describe('isAutosteerEnabledFor — opt-out logic', () => {
  test('default: enabled when no opt-out set', () => {
    assert.equal(isAutosteerEnabledFor({}, { bot: {} }), true);
  });

  test('chatConfig.autosteer=false disables', () => {
    assert.equal(isAutosteerEnabledFor({ autosteer: false }, { bot: {} }), false);
  });

  test('chatConfig.autosteer=true overrides bot opt-out', () => {
    assert.equal(isAutosteerEnabledFor({ autosteer: true }, { bot: { autosteer: false } }), true);
  });

  test('bot opt-out applies when chatConfig is silent', () => {
    assert.equal(isAutosteerEnabledFor({}, { bot: { autosteer: false } }), false);
  });

  test('chatConfig.autosteer null falls through to bot setting', () => {
    assert.equal(isAutosteerEnabledFor({ autosteer: null }, { bot: { autosteer: false } }), false);
  });
});

describe('priorityFor — mode mapping', () => {
  test('default mode → priority="next" (merge)', () => {
    assert.equal(priorityFor({}, { bot: {} }), 'next');
  });
  test('chatConfig.autosteerMode="queue" → priority="later"', () => {
    assert.equal(priorityFor({ autosteerMode: 'queue' }, { bot: {} }), 'later');
  });
  test('chatConfig.autosteerMode="merge" → priority="next"', () => {
    assert.equal(priorityFor({ autosteerMode: 'merge' }, { bot: {} }), 'next');
  });
  test('bot.autosteerMode applies when chatConfig silent', () => {
    assert.equal(priorityFor({}, { bot: { autosteerMode: 'queue' } }), 'later');
  });
});

describe('createAutosteerHandlers — factory contract', () => {
  test('returns object with willAutosteer + tryAutosteer', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    assert.equal(typeof h.willAutosteer, 'function');
    assert.equal(typeof h.tryAutosteer, 'function');
    assert.equal(typeof h.tryCodexAutosteer, 'function');
  });
});

describe('willAutosteer — pre-THINKING predicate', () => {
  test('returns false when pm has no session', () => {
    const m = makeDeps();
    m.deps.pm._hasKey = false;
    const h = createAutosteerHandlers(m.deps);
    assert.equal(h.willAutosteer('k', {}), false);
  });

  test('returns false when session exists but not in-flight', () => {
    const m = makeDeps();
    m.deps.pm._inFlight = false;
    const h = createAutosteerHandlers(m.deps);
    assert.equal(h.willAutosteer('k', {}), false);
  });

  test('returns true when in-flight + autosteer not opted out', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    assert.equal(h.willAutosteer('k', {}), true);
  });

  test('returns false when autosteer disabled in chat', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    assert.equal(h.willAutosteer('k', { autosteer: false }), false);
  });
});

describe('tryAutosteer — full dispatch', () => {
  test('not in flight → returns {autosteered:false}, no inject', () => {
    const m = makeDeps();
    m.deps.pm._inFlight = false;
    const h = createAutosteerHandlers(m.deps);
    const r = h.tryAutosteer({
      sessionKey: 'k', chatConfig: {}, chatId: '1',
      msg: { message_id: 1 }, prompt: 'hi',
    });
    assert.deepEqual(r, { autosteered: false });
    assert.equal(m.pmCalls.length, 0);
  });

  test('autosteer disabled → no inject', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    const r = h.tryAutosteer({
      sessionKey: 'k', chatConfig: { autosteer: false }, chatId: '1',
      msg: { message_id: 1 }, prompt: 'hi',
    });
    assert.deepEqual(r, { autosteered: false });
  });

  test('inject success → autosteered=true, ✍ ref recorded, telemetry emitted', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    const r = h.tryAutosteer({
      sessionKey: 'k', chatConfig: {}, chatId: '12345',
      msg: { message_id: 555 }, prompt: 'follow-up',
    });
    assert.equal(r.autosteered, true);
    assert.equal(r.priority, 'next');
    // rc.7: msgId is forwarded to pm.injectUserMessage so the tmux
    // backend can route an extra-turn reply back to the autosteered
    // Telegram message_id when the TUI dequeues the paste as a fresh
    // user turn. SDK backend ignores msgId — harmless extra field.
    assert.deepEqual(m.pmCalls[0],
      ['injectUserMessage', 'k', { content: 'follow-up', priority: 'next', msgId: 555, source: 'autosteer' }]);   // 0.13 D2: ledger source
    assert.equal(m.refs[0].key, 'k');
    assert.equal(m.refs[0].ref.msgId, 555);
    const evt = m.events.find((e) => e.kind === 'autosteer');
    assert.ok(evt);
    assert.equal(evt.detail.text_len, 9);  // "follow-up"
    assert.equal(evt.detail.priority, 'next');
  });

  test('inject failure → autosteered=false, no telemetry', () => {
    const m = makeDeps({
      pm: {
        has: () => true,
        get: () => ({ inFlight: true }),
        injectUserMessage: () => false,  // capacity / closed / etc.
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const r = h.tryAutosteer({
      sessionKey: 'k', chatConfig: {}, chatId: '1',
      msg: { message_id: 1 }, prompt: 'x',
    });
    assert.equal(r.autosteered, false);
    assert.equal(m.events.length, 0);
  });

  test('queue mode produces priority="later"', () => {
    const m = makeDeps();
    const h = createAutosteerHandlers(m.deps);
    const r = h.tryAutosteer({
      sessionKey: 'k', chatConfig: { autosteerMode: 'queue' }, chatId: '1',
      msg: { message_id: 1 }, prompt: 'x',
    });
    assert.equal(r.priority, 'later');
    const inject = m.pmCalls.find((c) => c[0] === 'injectUserMessage');
    assert.equal(inject[2].priority, 'later');
  });
});

describe('tryCodexAutosteer — accepted steering', () => {
  test('does not report or record acceptance before the RPC resolves', async () => {
    const rpc = deferred();
    const m = makeCodexDeps({
      pm: {
        steerTurn(sessionKey, prompt, opts) {
          m.steerCalls.push({ sessionKey, prompt, opts });
          return rpc.promise;
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    let settled = false;
    const pending = h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '12345',
      msg: { message_id: 555 },
      prompt: 'follow-up',
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(m.refs.length, 0);
    assert.equal(m.events.length, 0);

    rpc.resolve({
      outcome: 'accepted',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: 'steer-attempt-a',
      targetAttemptId: 'turn-attempt-a',
    });
    const result = await pending;

    assert.deepEqual(result, {
      autosteered: true,
      outcome: 'accepted',
      priority: 'next',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: 'steer-attempt-a',
      targetAttemptId: 'turn-attempt-a',
    });
    assert.deepEqual(m.steerCalls, [{
      sessionKey: 'k',
      prompt: 'follow-up',
      opts: { context: { sourceMsgId: 555 } },
    }]);
    assert.deepEqual(m.refs, [{
      key: 'k',
      ref: { chatId: '12345', msgId: 555 },
    }]);
    assert.equal(m.events[0].kind, 'autosteer');
    assert.equal(m.events[0].detail.backend, 'codex');
    assert.equal(m.events[0].detail.generation_id, 'generation-a');
    assert.equal(m.events[0].detail.turn_id, 'turn-a');
    assert.equal(m.events[0].detail.attempt_id, 'steer-attempt-a');
    assert.equal(m.events[0].detail.target_attempt_id, 'turn-attempt-a');
  });

  test('an accepted result without a durable steer attempt ID is ambiguous', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          return {
            outcome: 'accepted',
            generationId: 'generation-a',
            turnId: 'turn-a',
          };
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);

    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'ambiguous',
      queueOnce: false,
      priority: 'next',
      reason: 'accepted-without-durable-identifiers',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: null,
      targetAttemptId: null,
    });
    assert.equal(m.refs.length, 0);
    assert.equal(m.events.length, 0);
  });

  test('an accepted result with a mismatched generation is ambiguous', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          return {
            outcome: 'accepted',
            generationId: 'generation-b',
            turnId: 'turn-a',
            attemptId: 'steer-attempt-a',
            targetAttemptId: 'turn-attempt-a',
          };
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);

    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.queueOnce, false);
    assert.equal(result.generationId, 'generation-a');
    assert.equal(result.observedGenerationId, 'generation-b');
    assert.equal(m.refs.length, 0);
  });
});

describe('tryCodexAutosteer — fallback classification', () => {
  test('definite no-active-turn rejection is queueable exactly once by the caller', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          return { outcome: 'queueable-not-active', turnId: 'turn-a' };
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'queue-once',
      queueOnce: true,
      priority: 'next',
      reason: 'not-active',
      generationId: 'generation-a',
      turnId: 'turn-a',
    });
    assert.equal(m.refs.length, 0);
  });

  test('safe not-sent failure on the same live generation is queueable once', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          throw codexError('CODEX_RPC_NOT_SENT');
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.equal(result.outcome, 'queue-once');
    assert.equal(result.queueOnce, true);
    assert.equal(result.reason, 'rpc-not-sent');
  });

  test('not-sent failure after the generation starts quiescing is not queueable', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          m.entry.state = 'Quiescing';
          throw codexError('CODEX_RPC_NOT_SENT');
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.queueOnce, false);
    assert.equal(result.reason, 'quiescing');
  });

  test('transport-unknown failure is ambiguous and never autoqueued', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          throw codexError('CODEX_RPC_OUTCOME_UNKNOWN');
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'ambiguous',
      queueOnce: false,
      priority: 'next',
      reason: 'rpc-outcome-unknown',
      generationId: 'generation-a',
      errorCode: 'CODEX_RPC_OUTCOME_UNKNOWN',
    });
    assert.equal(m.refs.length, 0);
  });

  test('quiescing or explicitly unavailable work is never autoqueued', async () => {
    const m = makeCodexDeps({
      pm: {
        async steerTurn() {
          m.entry.state = 'Quiescing';
          return { outcome: 'unavailable', reason: 'quiescing' };
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'unavailable',
      queueOnce: false,
      priority: 'next',
      reason: 'quiescing',
      generationId: 'generation-a',
    });
    assert.equal(m.refs.length, 0);
  });

  test('queue mode bypasses turn/steer and requests one ordinary queued send', async () => {
    const m = makeCodexDeps();
    const h = createAutosteerHandlers(m.deps);
    const result = await h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: { autosteerMode: 'queue' },
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'queue-once',
      queueOnce: true,
      priority: 'later',
      reason: 'queue-mode',
      generationId: 'generation-a',
      turnId: 'turn-a',
    });
    assert.equal(m.steerCalls.length, 0);
  });
});

describe('tryCodexAutosteer — ordering and generation fences', () => {
  test('two steers retain caller serialization and accepted identifier order', async () => {
    const firstRpc = deferred();
    const secondRpc = deferred();
    const m = makeCodexDeps({
      pm: {
        steerTurn(sessionKey, prompt) {
          m.steerCalls.push({ sessionKey, prompt });
          return prompt === 'first' ? firstRpc.promise : secondRpc.promise;
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const invoke = (messageId, prompt) => h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: messageId },
      prompt,
    });
    let intentTail = Promise.resolve();
    const underIntentLock = (operation) => {
      const pending = intentTail.then(operation, operation);
      intentTail = pending.catch(() => {});
      return pending;
    };

    const firstPending = underIntentLock(() => invoke(1, 'first'));
    const secondPending = underIntentLock(() => invoke(2, 'second'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(m.steerCalls.map((call) => call.prompt), ['first']);

    firstRpc.resolve({
      outcome: 'accepted',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: 'steer-attempt-a',
      targetAttemptId: 'turn-attempt-a',
    });
    const first = await firstPending;
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(m.steerCalls.map((call) => call.prompt), ['first', 'second']);

    secondRpc.resolve({
      outcome: 'accepted',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: 'steer-attempt-b',
      targetAttemptId: 'turn-attempt-a',
    });
    const second = await secondPending;

    assert.deepEqual(
      [first.attemptId, second.attemptId],
      ['steer-attempt-a', 'steer-attempt-b'],
    );
    assert.deepEqual(m.refs.map((entry) => entry.ref.msgId), [1, 2]);
  });

  test('an acceptance from a replaced generation is ambiguous and never recorded', async () => {
    const rpc = deferred();
    const m = makeCodexDeps({
      pm: {
        steerTurn() {
          return rpc.promise;
        },
      },
    });
    const h = createAutosteerHandlers(m.deps);
    const pending = h.tryCodexAutosteer({
      sessionKey: 'k',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 1 },
      prompt: 'follow-up',
    });
    m.setEntry({
      ...m.entry,
      generationId: 'generation-b',
      activeTurnId: 'turn-b',
    });
    rpc.resolve({
      outcome: 'accepted',
      generationId: 'generation-a',
      turnId: 'turn-a',
      attemptId: 'steer-attempt-a',
      targetAttemptId: 'turn-attempt-a',
    });

    const result = await pending;

    assert.deepEqual(result, {
      autosteered: false,
      outcome: 'ambiguous',
      queueOnce: false,
      priority: 'next',
      reason: 'generation-changed',
      generationId: 'generation-a',
      observedGenerationId: 'generation-b',
    });
    assert.equal(m.refs.length, 0);
    assert.equal(m.events.length, 0);
  });
});
