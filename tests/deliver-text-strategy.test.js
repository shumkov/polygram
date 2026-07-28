'use strict';

/**
 * How the channels dispatcher builds a `deliverText` strategy for each reply.
 *
 * The seam's own behavior — ordering against redaction/sanitize, once-ness,
 * decline and rewrite, throwing strategies — lives in
 * tests/process-agent-reply-strategy.test.js. What is pinned HERE is the
 * dispatcher's half: that the per-call context a strategy needs actually
 * reaches it (sessionCwd, the interim flag, the turn id — each of which exists
 * only inside a dispatch), that a bubble a strategy delivered is editable
 * afterwards, and that this module never imports what must be injected.
 *
 * Run: node --test tests/deliver-text-strategy.test.js
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createChannelsToolDispatcher, buildAllowedRoots,
} = require('../lib/process/channels-tool-dispatcher');
const { parseResponse } = require('../lib/telegram/parse');
const { sanitizeAssistantReply } = require('../lib/telegram/sanitize-reply');
const { chunkMarkdownText } = require('../lib/telegram/chunk');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

describe('dispatcher wiring', () => {
  function dispatcherHarness({ makeDeliverText = null } = {}) {
    const factoryArgs = [];
    const delivered = [];
    const dispatcher = createChannelsToolDispatcher({
      bot: {},
      send: async () => ({ message_id: 1 }),
      chunkText: chunkMarkdownText,
      deliverReplies: async ({ chunks }) => {
        delivered.push([...chunks]);
        return { sent: chunks.map((_, i) => ({ message_id: 500 + i })), failed: [] };
      },
      parseResponse,
      sanitizeAssistantReply,
      makeDeliverText: makeDeliverText
        ? (args) => { factoryArgs.push(args); return makeDeliverText(args); }
        : null,
      logger: quietLogger,
    });
    return { dispatcher, factoryArgs, delivered };
  }

  test('the factory receives the per-call context a strategy cannot get anywhere else', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', threadId: '7', toolName: 'reply',
      text: 'hi there', sessionCwd: '/work', interim: true, turnId: 'turn-9',
    });
    assert.deepEqual(h.factoryArgs, [{
      sessionKey: 'chat:1', sessionCwd: '/work', chatId: '1', threadId: '7',
      interim: true, turnId: 'turn-9',
      // Passed, not rebuilt by the strategy: the roots this reply's files:
      // are validated against are the roots its media may upload from.
      // (What they contain is buildAllowedRoots's business — pinned in
      // channels-tool-dispatcher.test.js; that the two SIDES agree is pinned
      // behaviorally in channels-tool-dispatcher-rich.test.js.)
      allowedRoots: buildAllowedRoots({ sessionKey: 'chat:1', sessionCwd: '/work' }),
    }]);
  });

  test('interim defaults to false rather than undefined', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'hi there',
    });
    assert.equal(h.factoryArgs[0].interim, false);
  });

  test('a factory returning null leaves delivery on the default path', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'plain reply',
    });
    assert.deepEqual(h.delivered, [['plain reply']]);
    assert.deepEqual(res, { ok: true, message_id: 500 });
  });

  test('a claiming strategy supplies the message_id the agent gets back', async () => {
    const h = dispatcherHarness({
      makeDeliverText: () => async () => ({ handled: true, sent: [4242], failed: [] }),
    });
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'consumed by the preview',
    });
    assert.deepEqual(h.delivered, []);
    assert.deepEqual(res, { ok: true, message_id: 4242 });
  });

  test('a bubble the strategy delivered becomes editable by that session', async () => {
    // Ownership is what gates edit_message; without it the agent gets an id it
    // is then forbidden from using.
    const h = dispatcherHarness({
      makeDeliverText: () => async () => ({ handled: true, sent: [4242], failed: [] }),
    });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'consumed by the preview',
    });
    const edit = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'edit_message',
      messageId: 4242, text: 'a status update',
    });
    assert.deepEqual(edit, { ok: true, message_id: 4242 });
  });

  test('no factory at all: byte-identical to the pre-seam dispatcher', async () => {
    const h = dispatcherHarness();
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'plain reply',
    });
    assert.deepEqual(h.delivered, [['plain reply']]);
    assert.deepEqual(res, { ok: true, message_id: 500 });
  });

  test('the dispatcher never requires the delivery modules itself', () => {
    // rich-media.js requires this module; a direct require here would close a
    // cycle. Everything arrives by injection.
    const src = require('node:fs').readFileSync(
      require.resolve('../lib/process/channels-tool-dispatcher'), 'utf8',
    );
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of requires) {
      assert.ok(
        !/rich|live-preview|streamer/.test(r),
        `dispatcher must not require ${r} — inject it instead`,
      );
    }
  });
});
