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
    assert.deepEqual(m.pmCalls[0], ['injectUserMessage', 'k', { content: 'follow-up', priority: 'next' }]);
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
