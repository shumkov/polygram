'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createShouldHandle } = require('../lib/handlers/should-handle');

function makeShouldHandle({ chats = { 100: {} }, pairings = null, botName = 'bot' } = {}) {
  return createShouldHandle({
    getConfig: () => ({ chats }),
    getPairings: () => pairings,
    getBotName: () => botName,
  });
}

describe('shouldHandle — content presence', () => {
  test('text message in an allowed chat passes', () => {
    const sh = makeShouldHandle();
    assert.equal(sh({ chat: { id: 100, type: 'private' }, text: 'hi' }, {}, 'b'), true);
  });

  test('empty message (no text, caption, or media) is blocked', () => {
    const sh = makeShouldHandle();
    assert.equal(sh({ chat: { id: 100, type: 'private' } }, {}, 'b'), false);
  });

  test('native attachment-only message (photo, no caption) passes', () => {
    const sh = makeShouldHandle();
    assert.equal(sh({ chat: { id: 100, type: 'private' }, photo: [{}] }, {}, 'b'), true);
  });

  test('unlisted chat is blocked', () => {
    const sh = makeShouldHandle();
    assert.equal(sh({ chat: { id: 999, type: 'private' }, text: 'hi' }, {}, 'b'), false);
  });

  test('boot-replay reconstruction: attachment-only turn must pass the presence gate', () => {
    // A reconstructed replay/drop-redelivery message carries its persisted
    // attachments ONLY in _mergedAttachments — reconstruct() cannot restore
    // the native photo/document/voice fields. A voice note or caption-less
    // photo interrupted by a crash must still be recoverable, not blocked
    // as "empty" (the input-dropped-no-redeliver silent loss).
    const sh = makeShouldHandle();
    const reconstructed = {
      chat: { id: 100, type: 'private' },
      message_id: 5,
      from: { id: 1, first_name: 'U' },
      text: '',
      _mergedAttachments: [{ kind: 'voice', file_id: 'f', file_unique_id: 'u' }],
    };
    assert.equal(sh(reconstructed, {}, 'b'), true);
  });

  test('empty _mergedAttachments does not count as content', () => {
    const sh = makeShouldHandle();
    const msg = { chat: { id: 100, type: 'private' }, text: '', _mergedAttachments: [] };
    assert.equal(sh(msg, {}, 'b'), false);
  });
});

describe('shouldHandle — requireMention groups', () => {
  const chatCfg = { requireMention: true };

  test('group message without mention/reply/pairing is blocked', () => {
    const sh = makeShouldHandle({ chats: { '-100': {} } });
    const msg = { chat: { id: -100, type: 'supergroup' }, text: 'hello' };
    assert.equal(sh(msg, chatCfg, 'mybot'), false);
  });

  test('@mention passes', () => {
    const sh = makeShouldHandle({ chats: { '-100': {} } });
    const msg = { chat: { id: -100, type: 'supergroup' }, text: 'hey @mybot' };
    assert.equal(sh(msg, chatCfg, 'mybot'), true);
  });

  test('reply to the bot passes', () => {
    const sh = makeShouldHandle({ chats: { '-100': {} } });
    const msg = {
      chat: { id: -100, type: 'supergroup' },
      text: 'yes',
      reply_to_message: { message_id: 1, from: { username: 'mybot' } },
    };
    assert.equal(sh(msg, chatCfg, 'mybot'), true);
  });

  test('paired user bypasses requireMention', () => {
    const pairings = { hasLivePairing: () => true };
    const sh = makeShouldHandle({ chats: { '-100': {} }, pairings });
    const msg = { chat: { id: -100, type: 'supergroup' }, text: 'hello', from: { id: 7 } };
    assert.equal(sh(msg, chatCfg, 'mybot'), true);
  });

  test('paired user replying to a NON-bot user is still blocked (UMI 0.5.9 leak)', () => {
    const pairings = { hasLivePairing: () => true };
    const sh = makeShouldHandle({ chats: { '-100': {} }, pairings });
    const msg = {
      chat: { id: -100, type: 'supergroup' },
      text: 'Gotcha!',
      from: { id: 7 },
      reply_to_message: { message_id: 1, from: { username: 'teammate' } },
    };
    assert.equal(sh(msg, chatCfg, 'mybot'), false);
  });
});
