/**
 * The live-preview bubble across every shape a turn can take.
 *
 * One rule governs all of it: a live preview ALWAYS consumes the next
 * non-interim reply, and a new bubble is sent only when no preview is live. The
 * failure it exists to prevent is the user seeing their answer twice — once
 * growing in the preview, once again as a fresh bubble underneath — and its
 * mirror image, a half-written bubble stranded forever because the turn ended
 * somewhere nobody thought to clean up.
 *
 * Run: node --test tests/live-preview.test.js
 */
'use strict';

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const {
  createStreamerRegistry,
  createDeliverTextFactory,
  reconcileStreamer,
  isCoveredByDelivered,
  resolveStreamPreviewEnabled,
} = require('../lib/telegram/live-preview');

/** A fake Telegram that records what the user would actually see. */
function fakeTelegram({ failEdit = false } = {}) {
  const tg = {
    nextId: 100,
    sent: [],        // bubbles created
    edits: [],       // {msgId, text}
    deleted: [],     // msgIds removed
    send: async (text) => {
      const message_id = tg.nextId++;
      tg.sent.push({ message_id, text });
      return { message_id };
    },
    edit: async (msgId, payload) => {
      if (msgId == null) throw new Error('editMessageText: message_id is required');
      if (failEdit) throw new Error('Bad Request: can\'t parse entities');
      tg.edits.push({ msgId, text: payload });
    },
    deleteMessage: async (msgId) => { tg.deleted.push(msgId); },
  };
  return tg;
}

/** Bubbles the user is left looking at, in order, with their final text. */
function visibleBubbles(tg) {
  return tg.sent
    .filter((s) => !tg.deleted.includes(s.message_id))
    .map((s) => {
      const lastEdit = [...tg.edits].reverse().find((e) => e.msgId === s.message_id);
      return { message_id: s.message_id, text: lastEdit ? lastEdit.text : s.text };
    });
}

function harness({ failEdit = false, maxLen = 4096, interim = false } = {}) {
  const tg = fakeTelegram({ failEdit });
  const events = [];
  const rows = [];
  const streamer = createStreamer({
    send: tg.send,
    edit: tg.edit,
    deleteMessage: tg.deleteMessage,
    minChars: 5,
    throttleMs: 0,
    maxLen,
    logger: { error: () => {}, warn: () => {} },
  });
  const registry = createStreamerRegistry();
  const deliveredTexts = [];
  const release = registry.register('chat:1', { streamer, chatId: '1', deliveredTexts });
  const makeDeliverText = createDeliverTextFactory({
    registry,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    persistBubbleText: (chatId, msgId, text) => rows.push({ chatId, msgId, text }),
    logger: { error: () => {} },
    botName: 'testbot',
  });
  const deliver = (opts = {}) => makeDeliverText({
    sessionKey: 'chat:1', chatId: '1', threadId: null, interim, ...opts,
  });
  return { tg, events, rows, streamer, registry, deliveredTexts, release, deliver, makeDeliverText };
}

// ─── §5 turn-shape matrix ──────────────────────────────────────────

describe('turn shapes', () => {
  test('stream… → reply that fits: ONE bubble, finalized in place', async () => {
    const h = harness();
    await h.streamer.onChunk('The answer begins');
    await h.streamer.onChunk('The answer begins and continues');

    const out = await h.deliver()({ text: 'The answer begins, continues, and ends.' });

    assert.equal(out.handled, true, 'the reply must not create a second bubble');
    assert.deepEqual(out.sent, [100]);
    assert.equal(h.tg.sent.length, 1);
    assert.deepEqual(visibleBubbles(h.tg), [
      { message_id: 100, text: 'The answer begins, continues, and ends.' },
    ]);
    assert.equal(h.events.find((e) => e.kind === 'stream-preview-consumed').detail.msg_id, 100);
  });

  test('stream… → reply that fits: the transcript row is brought up to the final body', async () => {
    // The row was written by the INITIAL send — the first fragment. Without
    // this the transcript keeps a torso of every streamed answer.
    const h = harness();
    await h.streamer.onChunk('Partial fragment');
    await h.deliver()({ text: 'The whole answer, all of it.' });
    assert.deepEqual(h.rows, [{ chatId: '1', msgId: 100, text: 'The whole answer, all of it.' }]);
  });

  test('stream… → reply too long for one bubble: preview deleted, chunked path takes over', async () => {
    const h = harness({ maxLen: 60 });
    await h.streamer.onChunk('A long answer starting here');

    const out = await h.deliver()({ text: 'x'.repeat(500) });

    assert.equal(out.handled, false, 'the pipeline must fall through to chunked delivery');
    assert.deepEqual(h.tg.deleted, [100], 'no stale half-answer left above the chunks');
    assert.deepEqual(visibleBubbles(h.tg), []);
    assert.equal(
      h.events.find((e) => e.kind === 'stream-preview-redelivered').detail.reason, 'overflow',
    );
  });

  test('stream… → reply whose final edit fails: preview deleted, chunked path takes over', async () => {
    const h = harness({ failEdit: true });
    await h.streamer.onChunk('A draft that cannot be edited');

    const out = await h.deliver()({ text: 'The final answer.' });

    assert.equal(out.handled, false);
    assert.deepEqual(h.tg.deleted, [100],
      'an unreliable bubble must not stand in for the answer');
    assert.equal(
      h.events.find((e) => e.kind === 'stream-preview-redelivered').detail.reason, 'edit-failed',
    );
  });

  test('stream-only → turn ends with no reply at all: the draft is delivered, not stranded', async () => {
    const h = harness();
    await h.streamer.onChunk('Everything I managed to write');

    const res = await reconcileStreamer(h.streamer, h.deliveredTexts, {
      logEvent: (kind, detail) => h.events.push({ kind, detail }),
    });

    assert.equal(res.action, 'finalized');
    assert.deepEqual(visibleBubbles(h.tg), [
      { message_id: 100, text: 'Everything I managed to write' },
    ]);
    assert.deepEqual(h.tg.deleted, []);
    assert.ok(h.events.some((e) => e.kind === 'stream-orphan-finalized'));
  });

  test('stream-only → NO_REPLY: the draft is deleted, honoring the explicit silence', async () => {
    const h = harness();
    await h.streamer.onChunk('Something I started writing');

    const res = await reconcileStreamer(h.streamer, h.deliveredTexts, {
      reason: 'no-reply',
      logEvent: (kind, detail) => h.events.push({ kind, detail }),
    });

    assert.equal(res.action, 'discarded');
    assert.deepEqual(h.tg.deleted, [100], 'a half-written draft is not consent to speak');
    assert.equal(
      h.events.find((e) => e.kind === 'stream-orphan-discarded').detail.reason, 'no-reply',
    );
  });

  test('reply → stream → turn ends: an undelivered draft is finalized, a covered one is deleted', async () => {
    // Undelivered: the draft says something no reply carried.
    const a = harness();
    await a.deliver()({ text: 'A first answer.' });
    await a.streamer.onChunk('A second thought nobody delivered');
    const undelivered = await reconcileStreamer(a.streamer, a.deliveredTexts, {});
    assert.equal(undelivered.action, 'finalized');
    assert.equal(a.tg.deleted.length, 0);

    // Covered: the draft repeats what the reply already delivered.
    const b = harness();
    await b.streamer.onChunk('The complete answer text');
    await b.deliver()({ text: 'The complete answer text' });
    // A trailing snapshot after the consuming reply opens a fresh preview.
    await b.streamer.onChunk('The complete answer text');
    const covered = await reconcileStreamer(b.streamer, b.deliveredTexts, {
      logEvent: (kind, detail) => b.events.push({ kind, detail }),
    });
    assert.equal(covered.action, 'discarded', 'the user must not read the answer twice');
    assert.equal(
      b.events.find((e) => e.kind === 'stream-orphan-discarded').detail.reason, 'covered-by-reply',
    );
  });

  test('stream → interim → stream → reply: order preserved, interim keeps its own bubble', async () => {
    const h = harness();
    await h.streamer.onChunk('Working on it, here is what I have');

    // The interim status must NOT consume the preview it appears under.
    const interimOut = await h.deliver({ interim: true })({ text: 'Looking into that now…' });
    assert.equal(interimOut.handled, false, 'an interim status is not the turn answer');

    // The next snapshot opens a NEW preview, which lands BELOW the interim
    // bubble the pipeline delivered — order stays truthful.
    await h.streamer.onChunk('Now here is the real answer forming');
    const finalOut = await h.deliver()({ text: 'Here is the real answer.' });

    assert.equal(finalOut.handled, true);
    assert.deepEqual(finalOut.sent, [101], 'consumed the SECOND preview, not the first');
    assert.equal(h.tg.sent.length, 2, 'two previews; the interim itself is the pipeline\'s bubble');
    assert.deepEqual(visibleBubbles(h.tg).map((b) => b.text), [
      'Working on it, here is what I have',
      'Here is the real answer.',
    ]);
  });

  test('no preview live: the reply falls through to normal delivery untouched', async () => {
    const h = harness();
    const out = await h.deliver()({ text: 'A short answer with no streaming behind it.' });
    assert.equal(out.handled, false);
    assert.deepEqual(h.tg.sent, [], 'the strategy must not invent a bubble');
  });

  test('a session with no registered streamer gets no strategy at all', () => {
    const h = harness();
    assert.equal(h.makeDeliverText({ sessionKey: 'chat:other', chatId: '9' }), null);
  });

  test('a released registration stops being found (a later turn cannot reuse it)', () => {
    const h = harness();
    h.release();
    assert.equal(h.makeDeliverText({ sessionKey: 'chat:1', chatId: '1' }), null);
  });
});

// ─── reconciliation details ────────────────────────────────────────

describe('reconcileStreamer', () => {
  test('is a no-op when nothing is live', async () => {
    const h = harness();
    const res = await reconcileStreamer(h.streamer, [], {});
    assert.equal(res.action, 'none');
    assert.deepEqual(h.tg.sent, []);
    assert.deepEqual(h.tg.deleted, []);
  });

  test('is a no-op on a null streamer', async () => {
    assert.equal((await reconcileStreamer(null, [], {})).action, 'none');
  });

  test('leaves an over-long draft standing rather than destroying the only copy', async () => {
    const h = harness({ maxLen: 40 });
    await h.streamer.onChunk('y'.repeat(200));
    const res = await reconcileStreamer(h.streamer, [], {
      logEvent: (kind, detail) => h.events.push({ kind, detail }),
    });
    assert.equal(res.action, 'finalize-failed');
    assert.deepEqual(h.tg.deleted, [], 'deleting would leave the user with nothing');
    assert.equal(h.events.find((e) => e.kind === 'stream-orphan-finalize-failed').detail.overflow, true);
  });

  test('coverage is whitespace-insensitive and works either direction', () => {
    assert.equal(isCoveredByDelivered('the  answer\n', ['The reply said: the answer, in full']), true);
    assert.equal(isCoveredByDelivered('the full answer text', ['the full answer']), true,
      'a reply trimmed slightly shorter still covers the draft');
    assert.equal(isCoveredByDelivered('something else entirely', ['the answer']), false);
    assert.equal(isCoveredByDelivered('   ', ['anything']), true, 'nothing to lose');
    assert.equal(isCoveredByDelivered('a draft', []), false, 'no replies means nothing covered it');
  });
});

// ─── per-chat edit cadence ─────────────────────────────────────────

describe('per-chat throttle scaling', () => {
  test('liveCount counts only live previews, and only in that chat', async () => {
    const registry = createStreamerRegistry();
    const mk = async (chatId, key, goLive) => {
      const tg = fakeTelegram();
      const s = createStreamer({
        send: tg.send, edit: tg.edit, minChars: 5, throttleMs: 0,
        logger: { error: () => {} },
      });
      registry.register(key, { streamer: s, chatId });
      if (goLive) await s.onChunk('enough text to go live');
      return s;
    };
    await mk('1', 'chat:1:topicA', true);
    await mk('1', 'chat:1:topicB', true);
    await mk('1', 'chat:1:topicC', false);   // idle — costs the chat nothing
    await mk('2', 'chat:2', true);           // different chat

    assert.equal(registry.liveCount('1'), 2);
    assert.equal(registry.liveCount('2'), 1);
    assert.equal(registry.liveCount('3'), 0);
  });

  test('the edit interval scales with the number of live previews in the chat', async () => {
    // Telegram's limits are per chat, so three busy topics must cost the chat
    // roughly what one does — otherwise the chat 429s and the sleep stalls a
    // turn against the tool-ack timeout.
    const registry = createStreamerRegistry();
    const delays = [];
    let now = 0;
    let scheduled = null;
    const tg = fakeTelegram();
    const streamer = createStreamer({
      send: tg.send,
      edit: tg.edit,
      minChars: 5,
      throttleMs: () => 1000 * Math.max(1, registry.liveCount('1')),
      clock: () => now,
      schedule: (fn, ms) => { delays.push(ms); scheduled = fn; return 1; },
      cancel: () => { scheduled = null; },
      logger: { error: () => {} },
    });
    // Drain whatever the fake timer holds, the way a real timer eventually would.
    const runScheduled = async () => {
      if (!scheduled) return;
      const fn = scheduled; scheduled = null;
      await fn();
    };
    registry.register('chat:1:topicA', { streamer, chatId: '1' });
    await streamer.onChunk('enough text to go live');

    await streamer.onChunk('more text');
    assert.equal(delays.at(-1), 1000, 'one live preview → the base interval');
    await runScheduled();

    // Two more topics in the same chat go live.
    for (const key of ['chat:1:topicB', 'chat:1:topicC']) {
      const other = createStreamer({
        send: fakeTelegram().send, edit: async () => {}, minChars: 5, throttleMs: 0,
        logger: { error: () => {} },
      });
      registry.register(key, { streamer: other, chatId: '1' });
      await other.onChunk('enough text to go live');
    }

    // Clock held still, so the scheduled delay IS the throttle interval.
    delays.length = 0;
    await streamer.onChunk('yet more text');
    assert.equal(delays.at(-1), 3000, 'three live previews → three times the interval');
  });
});

// ─── per-chat opt-in ───────────────────────────────────────────────

describe('resolveStreamPreviewEnabled', () => {
  const cfg = (extra) => ({ chats: { 5: { topics: { 7: {} } } }, ...extra });

  test('defaults to off', () => {
    assert.equal(resolveStreamPreviewEnabled(cfg(), '5', null), false);
    assert.equal(resolveStreamPreviewEnabled(null, '5', null), false);
  });

  test('honors topic > chat > bot > defaults precedence', () => {
    assert.equal(resolveStreamPreviewEnabled(
      { defaults: { streamPreview: true }, chats: {} }, '5', null), true);
    assert.equal(resolveStreamPreviewEnabled(
      { bot: { streamPreview: true }, chats: {} }, '5', null), true);
    assert.equal(resolveStreamPreviewEnabled(
      { bot: { streamPreview: true }, chats: { 5: { streamPreview: false } } }, '5', null), false);
    assert.equal(resolveStreamPreviewEnabled(
      { chats: { 5: { streamPreview: false, topics: { 7: { streamPreview: true } } } } }, '5', '7'), true);
  });
});
