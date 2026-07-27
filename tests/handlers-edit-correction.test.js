'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createEditCorrectionInjector } = require('../lib/handlers/edit-correction');

function fixture(overrides = {}) {
  const calls = { inject: [], events: [] };
  const sessionKey = overrides.sessionKey || 'sk:100';

  const pmEntry = overrides.pmEntry === undefined
    ? { inFlight: true }
    : overrides.pmEntry;

  const pm = {
    has: () => pmEntry != null,
    get: () => pmEntry,
    injectUserMessage: (sk, args) => {
      calls.inject.push({ sk, ...args });
      return overrides.injectFails ? false : true;
    },
  };

  const db = {
    isInboundLive: () => overrides.live !== false,
  };

  const injector = createEditCorrectionInjector({
    pm,
    db,
    getSessionKey: () => sessionKey,
    config: {
      chats: overrides.chats || { '100': { name: 'TestChat' } },
      bot: overrides.bot || {},
    },
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    logger: { error: () => {} },
  });
  return { injector, calls };
}

function editMsg(overrides = {}) {
  return {
    message_id: 5,
    chat: { id: 100 },
    text: 'corrected text',
    edit_date: 1700000000,
    ...overrides,
  };
}

describe('createEditCorrectionInjector — happy path', () => {
  test('injects correction note when turn is in-flight + msg live', () => {
    const fx = fixture();
    const result = fx.injector(editMsg());
    assert.equal(result, true);
    assert.equal(fx.calls.inject.length, 1);
    assert.match(fx.calls.inject[0].content, /\[edit\] I corrected my previous message/);
    assert.match(fx.calls.inject[0].content, /corrected text/);
    assert.equal(fx.calls.inject[0].priority, 'next');
    assert.ok(fx.calls.events.some((e) => e.kind === 'message-edit-injected'));
  });

  test('uses caption when text missing', () => {
    const fx = fixture();
    fx.injector(editMsg({ text: undefined, caption: 'caption typo fix' }));
    assert.match(fx.calls.inject[0].content, /caption typo fix/);
  });
});

describe('createEditCorrectionInjector — skip gates', () => {
  test('Codex never uses the synchronous Claude edit injector while a turn is live', () => {
    const fx = fixture({
      pmEntry: {
        backend: 'codex',
        runtime: 'codex',
        generationId: 'generation-a',
        inFlight: true,
      },
    });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
    assert.equal(fx.calls.events.length, 0);
  });

  test('skipped when SDK session evicted (pm.has=false)', () => {
    const fx = fixture({ pmEntry: null });
    const result = fx.injector(editMsg());
    assert.equal(result, false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('skipped when session has no turn in flight', () => {
    const fx = fixture({ pmEntry: { inFlight: false } });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('skipped when handler_status is no longer dispatched/processing (turn done)', () => {
    const fx = fixture({ live: false });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('skipped when chat is unknown', () => {
    const fx = fixture({ chats: {} });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('skipped when edited text + caption are both empty (sticker/photo edit)', () => {
    const fx = fixture();
    assert.equal(fx.injector(editMsg({ text: undefined })), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('skipped when null/undefined editedMsg', () => {
    const fx = fixture();
    assert.equal(fx.injector(null), false);
    assert.equal(fx.injector(undefined), false);
  });

  test('skipped when injectUserMessage returns false (returns false, no event)', () => {
    const fx = fixture({ injectFails: true });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.events.filter((e) => e.kind === 'message-edit-injected').length, 0);
  });
});

describe('createEditCorrectionInjector — opt-out', () => {
  test('chat-level editCorrection=false disables injection', () => {
    const fx = fixture({ chats: { '100': { editCorrection: false } } });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('bot-level editCorrection=false disables injection (when chat does not override)', () => {
    const fx = fixture({
      chats: { '100': {} },
      bot: { editCorrection: false },
    });
    assert.equal(fx.injector(editMsg()), false);
    assert.equal(fx.calls.inject.length, 0);
  });

  test('chat-level editCorrection=true overrides bot-level disable', () => {
    const fx = fixture({
      chats: { '100': { editCorrection: true } },
      bot: { editCorrection: false },
    });
    assert.equal(fx.injector(editMsg()), true);
    assert.equal(fx.calls.inject.length, 1);
  });

  test('default (no config) → enabled', () => {
    const fx = fixture();
    assert.equal(fx.injector(editMsg()), true);
  });
});

describe('createEditCorrectionInjector — telemetry', () => {
  test('event detail captures session_key + msg_id + text_len', () => {
    const fx = fixture({ sessionKey: 'sk:abc' });
    fx.injector(editMsg({ text: 'hello world' }));
    const ev = fx.calls.events.find((e) => e.kind === 'message-edit-injected');
    assert.ok(ev);
    assert.equal(ev.detail.session_key, 'sk:abc');
    assert.equal(ev.detail.msg_id, 5);
    assert.equal(ev.detail.chat_id, '100');
    assert.equal(ev.detail.text_len, 11);
  });
});
