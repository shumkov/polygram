/**
 * What the turn-completion exits DELIVER and STORE, driven through the real
 * live-preview seam rather than stopping at streamer state.
 *
 * Two properties that only show up on the far side of that seam:
 *
 *   1. A refused snapshot must not become the answer. Every exit that has no
 *      reply to deliver falls back to `streamer.latestText`, and that value is
 *      then written to the transcript — so what the guard refuses decides what
 *      the user is left holding, not just what the bubble shows.
 *   2. The composing marker is presentation. It may reach a bubble; it may
 *      never reach a stored row, by any exit.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');
const { composingMarker, COMPOSING_MARKER_TEXT } = require('../lib/telegram/composing-marker');
const {
  createStreamerRegistry, createDeliverTextFactory, createTurnSettler, reconcileStreamer,
} = require('../lib/telegram/live-preview');

function makeRig({ maxLen = 4096, rich = false, marker = true } = {}) {
  const sent = [];
  const edits = [];
  const deleted = [];
  const stored = [];
  const redelivered = [];
  let nextId = 700;
  let now = 0;
  const timers = [];

  const streamer = createStreamer({
    send: async (payload) => { const id = nextId++; sent.push({ id, payload }); return { message_id: id }; },
    edit: async (msgId, payload) => { edits.push({ msgId, payload }); },
    deleteMessage: async (msgId) => { deleted.push(msgId); },
    minChars: 1,
    throttleMs: 500,
    maxLen,
    clock: () => now,
    schedule: (fn, delay) => { const t = { fn, fireAt: now + delay }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    logger: { log: () => {}, error: () => {}, warn: () => {} },
    ...(rich && { toRichPayload: toTelegramRichBlocks }),
    ...(marker && { toComposingMarker: () => composingMarker() }),
  });

  const persistBubbleText = (chatId, msgId, text) => { stored.push({ chatId, msgId, text }); };

  async function advance(ms) {
    now += ms;
    for (const t of timers.filter((x) => x.fireAt <= now)) {
      const i = timers.indexOf(t);
      if (i !== -1) timers.splice(i, 1);
      await t.fn();
    }
  }

  return { streamer, sent, edits, deleted, stored, redelivered, advance, persistBubbleText };
}

const A = 'Первый раздел готов.\n\nВторой раздел готов.\n\nТретий начат';
// Longer, but the first two settled sections are gone — the shape the guard exists to refuse.
const REFUSED = 'Третий раздел дописан полностью.\n\nЧетвёртый раздел тоже готов и довольно длинный.';

describe('a refused snapshot never becomes the delivered answer', () => {
  test('the orphan-finalize exit delivers and stores the last ACCEPTED text', async () => {
    const rig = makeRig({ marker: false });
    await rig.streamer.onChunk(A);
    await rig.advance(500);
    await rig.streamer.onChunk(REFUSED);
    await rig.advance(500);

    const res = await reconcileStreamer(rig.streamer, [], { reason: null });

    assert.equal(res.action, 'finalized');
    assert.equal(res.text, A,
      'the refused snapshot dropped two sections the reader had already read — it must not be the answer');
    assert.ok(!res.text.includes('Четвёртый'));
  });

  test('the settler writes that same text to the transcript', async () => {
    const rig = makeRig({ marker: false });
    const settle = createTurnSettler({
      streamer: rig.streamer,
      deliveredTexts: [],
      persistBubbleText: rig.persistBubbleText,
      chatId: '-100',
    });

    await rig.streamer.onChunk(A);
    await rig.advance(500);
    await rig.streamer.onChunk(REFUSED);
    await rig.advance(500);
    await settle(null);

    assert.equal(rig.stored.length, 1);
    assert.equal(rig.stored[0].text, A, 'the stored row must match the bubble, not the refused draft');
  });

  test('a refusal does not strand the draft when the model recovers', async () => {
    // The anchor stays on the last accepted snapshot, so a later snapshot that
    // genuinely extends it resumes — and THAT is what the exit delivers.
    const rig = makeRig({ marker: false });
    await rig.streamer.onChunk(A);
    await rig.advance(500);
    await rig.streamer.onChunk(REFUSED);
    await rig.advance(500);
    const recovered = `${A}той секции.\n\nЧетвёртый раздел.`;
    await rig.streamer.onChunk(recovered);
    await rig.advance(500);

    const res = await reconcileStreamer(rig.streamer, [], { reason: null });
    assert.equal(res.text, recovered);
  });
});

describe('the composing marker never crosses the persistence seam', () => {
  const carriesMarker = (v) => JSON.stringify(v).includes(COMPOSING_MARKER_TEXT);

  test('a consumed reply stores the reply text, marker-free', async () => {
    const rig = makeRig();
    const registry = createStreamerRegistry();
    const deliveredTexts = [];
    registry.register('s1', { streamer: rig.streamer, chatId: '-100', deliveredTexts });
    const makeDeliverText = createDeliverTextFactory({
      registry, persistBubbleText: rig.persistBubbleText, logger: { error: () => {} },
    });

    await rig.streamer.onChunk('Начало ответа.');
    await rig.advance(500);
    assert.ok(rig.edits.some((e) => carriesMarker(e.payload)), 'precondition: the bubble showed it');

    const deliverText = makeDeliverText({ sessionKey: 's1', chatId: '-100', threadId: null, interim: false });
    const out = await deliverText({ text: 'Начало ответа. И конец.' });

    assert.equal(out.handled, true);
    assert.ok(rig.stored.length > 0);
    for (const row of rig.stored) assert.ok(!carriesMarker(row.text));
    assert.equal(rig.stored[rig.stored.length - 1].text, 'Начало ответа. И конец.');
  });

  test('the quiet/error finalize exit stores marker-free text', async () => {
    const rig = makeRig();
    const settle = createTurnSettler({
      streamer: rig.streamer,
      deliveredTexts: [],
      persistBubbleText: rig.persistBubbleText,
      chatId: '-100',
    });

    await rig.streamer.onChunk('Что-то написал.');
    await rig.advance(500);
    await settle(null);

    assert.ok(rig.stored.length > 0);
    for (const row of rig.stored) assert.ok(!carriesMarker(row.text));
  });

  test('the overflow/redelivery exit hands the chunked path marker-free text', async () => {
    const rig = makeRig({ maxLen: 200 });
    const handed = [];
    const settle = createTurnSettler({
      streamer: rig.streamer,
      deliveredTexts: [],
      persistBubbleText: rig.persistBubbleText,
      chatId: '-100',
      redeliver: async (text) => { handed.push(text); return true; },
    });

    const long = 'я'.repeat(500);
    await rig.streamer.onChunk(long);
    await rig.advance(500);
    await settle(null);

    assert.equal(handed.length, 1, 'an over-cap draft must reach the chunked path');
    assert.ok(!carriesMarker(handed[0]));
    assert.equal(handed[0], long, 'and it must be the whole answer, not the truncated view');
    for (const row of rig.stored) assert.ok(!carriesMarker(row.text));
  });

  test('a detached bubble is left marker-free and its row is marker-free', async () => {
    const rig = makeRig();
    await rig.streamer.onChunk('Первое сообщение.');
    await rig.advance(500);
    const detachedId = rig.streamer.msgId;

    rig.streamer.forceNewMessage();
    await rig.streamer.onChunk('Второе сообщение.');
    await rig.streamer.drainSeals();

    const last = rig.edits.filter((e) => e.msgId === detachedId).pop();
    assert.ok(last && !carriesMarker(last.payload), 'the finished bubble must not still claim to be writing');
    for (const row of rig.stored) assert.ok(!carriesMarker(row.text));
  });

  test('rich: every payload the seam stores is marker-free', async () => {
    const rig = makeRig({ rich: true });
    const settle = createTurnSettler({
      streamer: rig.streamer,
      deliveredTexts: [],
      persistBubbleText: rig.persistBubbleText,
      chatId: '-100',
    });

    await rig.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await rig.advance(500);
    await rig.streamer.onChunk('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');
    await rig.advance(500);
    await settle(null);

    assert.ok(rig.stored.length > 0);
    for (const row of rig.stored) assert.ok(!carriesMarker(row.text));
    const finalEdit = rig.edits[rig.edits.length - 1];
    assert.ok(!carriesMarker(finalEdit.payload), 'and the final frame drops it too');
  });
});
