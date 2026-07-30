/**
 * The composing-tail marker on a growing preview bubble.
 *
 * A bubble that is still being written says so ("⏳ пишу дальше…"); a bubble
 * that is finished must never say it, not on the final frame and not on an
 * intermediate bubble left standing after the stream moved on. The marker is
 * presentation only: it is appended after the payload is planned, it never
 * enters the streamer's notion of the answer, and it is dropped — never the
 * content — when it would not fit the bubble's cap.
 *
 * Fake clock/schedule harness (same pattern as streamer-rich.test.js).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');
const {
  composingMarker, COMPOSING_MARKER_TEXT, COMPOSING_MARKER_SUFFIX,
} = require('../lib/telegram/composing-marker');

const MARKER = composingMarker();

function makeHarness({
  toRichPayload,
  toComposingMarker = () => composingMarker(),
  maxLen = 4096,
  richMaxLen,
  editReturns,
  preserveIntermediateBubbles,
} = {}) {
  const sent = [];
  const edits = [];
  let nextId = 1000;
  let now = 0;
  const timers = [];

  const streamer = createStreamer({
    send: async (payload) => {
      const id = nextId++;
      sent.push({ id, payload });
      return { message_id: id };
    },
    edit: async (msgId, payload) => {
      edits.push({ msgId, payload });
      return editReturns ? editReturns(msgId, payload) : undefined;
    },
    minChars: 1,
    throttleMs: 500,
    maxLen,
    clock: () => now,
    schedule: (fn, delay) => {
      const t = { fn, fireAt: now + delay };
      timers.push(t);
      return t;
    },
    cancel: (t) => {
      const i = timers.indexOf(t);
      if (i !== -1) timers.splice(i, 1);
    },
    logger: { log: () => {}, error: () => {}, warn: () => {} },
    ...(toRichPayload && { toRichPayload }),
    ...(richMaxLen != null && { richMaxLen }),
    ...(toComposingMarker !== undefined && { toComposingMarker }),
    ...(preserveIntermediateBubbles != null && { preserveIntermediateBubbles }),
  });

  async function advance(ms) {
    now += ms;
    const due = timers.filter((t) => t.fireAt <= now);
    for (const t of due) {
      const i = timers.indexOf(t);
      if (i !== -1) timers.splice(i, 1);
      await t.fn();
    }
  }

  const lastEdit = () => edits[edits.length - 1];

  return { streamer, sent, edits, advance, lastEdit };
}

const carriesMarker = (payload) => JSON.stringify(payload).includes(COMPOSING_MARKER_TEXT);

describe('composing marker — while the bubble is growing', () => {
  test('a partial rich edit ends with the marker block, content blocks untouched', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await h.advance(500);
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');
    await h.advance(500);

    const { blocks } = h.lastEdit().payload;
    assert.deepEqual(blocks[blocks.length - 1], MARKER.block,
      'the marker is the LAST element — a reader scanning down must hit it after the content');

    const content = toTelegramRichBlocks('# Отчёт\n\nПервый абзац.\n\nВторой абзац.', { partial: true });
    assert.deepEqual(blocks.slice(0, -1), content.blocks,
      'the planned content is delivered byte-identically; the marker is appended, not woven in');
  });

  test('a partial plain edit appends the marker after a blank line', async () => {
    const h = makeHarness();
    await h.streamer.onChunk('Начало ответа.');
    await h.advance(500);
    await h.streamer.onChunk('Начало ответа. И продолжение.');
    await h.advance(500);

    assert.equal(h.lastEdit().payload, `Начало ответа. И продолжение.${COMPOSING_MARKER_SUFFIX}`);
  });

  test('the marker is not on the opening frame — the open is the one verb that writes a transcript row', async () => {
    const h = makeHarness();
    await h.streamer.onChunk('Начало ответа.');
    assert.equal(h.sent[0].payload, 'Начало ответа.');
    assert.ok(!carriesMarker(h.sent[0].payload));
  });
});

describe('composing marker — the bubble must stop claiming it', () => {
  test('finalize renders without the marker (rich)', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await h.advance(500);
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');
    await h.advance(500);
    assert.ok(carriesMarker(h.lastEdit().payload), 'precondition: the live frame carried it');

    await h.streamer.finalize('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');
    assert.ok(!carriesMarker(h.lastEdit().payload), 'the finished answer must not claim to still be written');
  });

  test('finalize renders without the marker (plain)', async () => {
    const h = makeHarness();
    await h.streamer.onChunk('Начало.');
    await h.advance(500);
    await h.streamer.onChunk('Начало. Продолжение.');
    await h.advance(500);
    assert.ok(carriesMarker(h.lastEdit().payload));

    await h.streamer.finalize('Начало. Продолжение. Конец.');
    assert.equal(h.lastEdit().payload, 'Начало. Продолжение. Конец.');
  });

  test('finalize still edits when the body is unchanged but the marker is on screen', async () => {
    // The no-op branches exist so an already-correct bubble is not re-edited.
    // With a marker showing, the bubble is NOT already correct — suppressing
    // the edit here strands "⏳ пишу дальше…" on the final answer forever.
    const h = makeHarness();
    await h.streamer.onChunk('Ответ целиком.');
    await h.advance(500);
    await h.streamer.onChunk('Ответ целиком. Точка.');
    await h.advance(500);
    const editsBefore = h.edits.length;

    const fin = await h.streamer.finalize('Ответ целиком. Точка.');   // identical to what is displayed

    assert.equal(fin.finalEditOk, true);
    assert.equal(h.edits.length, editsBefore + 1, 'the marker-stripping edit must fire');
    assert.equal(h.lastEdit().payload, 'Ответ целиком. Точка.');
  });

  test('finalize still edits when the rich blocks are unchanged but the marker is on screen', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    const body = '# Отчёт\n\nПервый абзац.\n\nВторой абзац.\n\nТретий абзац.';
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await h.advance(500);
    await h.streamer.onChunk(body);
    await h.advance(500);
    const editsBefore = h.edits.length;

    // finalize renders with partial:false, so the held-back tail joins the
    // tree — but the marker alone would justify the edit regardless.
    await h.streamer.finalize(body);
    assert.ok(h.edits.length > editsBefore);
    assert.ok(!carriesMarker(h.lastEdit().payload));
  });

  test('a bubble detached mid-stream is sealed free of the marker (plain)', async () => {
    const h = makeHarness();
    await h.streamer.onChunk('Первое сообщение.');
    await h.advance(500);
    await h.streamer.onChunk('Первое сообщение. Ещё текст.');
    await h.advance(500);
    const detachedId = h.streamer.msgId;
    assert.ok(carriesMarker(h.lastEdit().payload), 'precondition: the bubble is showing the marker');

    // A new top-level assistant message opens a fresh bubble; the old one is
    // preserved on screen and will never be edited again by the stream.
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('Второе сообщение.');
    await h.streamer.drainSeals();

    const seal = h.edits.filter((e) => e.msgId === detachedId).pop();
    assert.ok(seal, 'the detached bubble must be sealed, or it claims forever that it is still being written');
    assert.equal(seal.payload, 'Первое сообщение. Ещё текст.');
  });

  test('a rich bubble detached mid-stream is sealed free of the marker', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# Первое\n\nАбзац.');
    await h.advance(500);
    await h.streamer.onChunk('# Первое\n\nАбзац.\n\nЕщё абзац.');
    await h.advance(500);
    const detachedId = h.streamer.msgId;
    assert.ok(carriesMarker(h.lastEdit().payload));

    h.streamer.forceNewMessage();
    await h.streamer.onChunk('# Второе\n\nДругой абзац.');
    await h.streamer.drainSeals();

    const seal = h.edits.filter((e) => e.msgId === detachedId).pop();
    assert.ok(seal, 'the detached rich bubble must be sealed too');
    assert.ok(!carriesMarker(seal.payload));
    assert.equal(seal.payload.phase, 'seal');
  });

  test('a detached bubble that never showed the marker is not re-edited', async () => {
    // The seal costs a Telegram edit. It is justified by a marker on screen,
    // not by detaching, and every SDK multi-message turn detaches.
    const h = makeHarness({ toComposingMarker: null });
    await h.streamer.onChunk('Первое сообщение.');
    await h.advance(500);
    await h.streamer.onChunk('Первое сообщение. Ещё текст.');
    await h.advance(500);
    const detachedId = h.streamer.msgId;
    const editsBefore = h.edits.filter((e) => e.msgId === detachedId).length;

    h.streamer.forceNewMessage();
    await h.streamer.onChunk('Второе сообщение.');
    await h.streamer.drainSeals();

    assert.equal(h.edits.filter((e) => e.msgId === detachedId).length, editsBefore);
  });
});

describe('composing marker — caps are measured on content', () => {
  test('rich: content at exactly the cap keeps its blocks and drops the marker', async () => {
    const richMaxLen = 400;
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, richMaxLen });

    // A trailing paragraph so the bulk paragraph is inside the rendered tree
    // rather than the held-back tail — otherwise the render is unchanged from
    // the open and there is no edit to measure.
    const head = '# Отчёт\n\n';
    const tail = '\n\nхвост.';
    const body = head + 'я'.repeat(richMaxLen - head.length - tail.length) + tail;
    assert.equal(body.length, richMaxLen);

    await h.streamer.onChunk('# Отчёт\n\nначало');
    await h.advance(500);
    await h.streamer.onChunk(body);
    await h.advance(500);

    const payload = h.lastEdit().payload;
    assert.equal(payload.rich, true, 'the content still renders rich — only the marker gives way');
    assert.ok(!carriesMarker(payload));
    assert.equal(payload.sourceText, body, 'content intact');
  });

  test('rich: the marker rides along when there is room for it', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, richMaxLen: 4000 });
    await h.streamer.onChunk('# Отчёт\n\nначало');
    await h.advance(500);
    await h.streamer.onChunk('# Отчёт\n\nначало\n\nи ещё абзац');
    await h.advance(500);
    assert.ok(carriesMarker(h.lastEdit().payload));
  });

  test('plain: content filling the bubble drops the marker, not a character of the answer', async () => {
    const maxLen = 200;
    const h = makeHarness({ maxLen });
    await h.streamer.onChunk('начало');
    await h.advance(500);
    const body = 'я'.repeat(maxLen);
    await h.streamer.onChunk(body);
    await h.advance(500);

    assert.equal(h.lastEdit().payload, body);
    assert.equal(h.lastEdit().payload.length, maxLen);
  });

  test('plain: an over-cap body is truncated as before and still drops the marker', async () => {
    const maxLen = 200;
    const h = makeHarness({ maxLen });
    await h.streamer.onChunk('начало');
    await h.advance(500);
    await h.streamer.onChunk('я'.repeat(maxLen * 2));
    await h.advance(500);

    const payload = h.lastEdit().payload;
    assert.equal(payload.length, maxLen);
    assert.ok(payload.endsWith('...'), 'the live-truncation contract is unchanged');
  });
});

describe('composing marker — it is presentation, never content', () => {
  test('the streamer state and every send stay free of it', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    const body = '# Отчёт\n\nПервый абзац.\n\nВторой абзац.';
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await h.advance(500);
    await h.streamer.onChunk(body);
    await h.advance(500);

    // latestText is what persistBubbleText writes to the transcript and what
    // the orphan-coverage check compares replies against.
    assert.ok(!h.streamer.latestText.includes(COMPOSING_MARKER_TEXT));
    assert.ok(!String(h.streamer.currentText).includes(COMPOSING_MARKER_TEXT));
    for (const s of h.sent) assert.ok(!carriesMarker(s.payload));

    // sourceText travels beside the blocks and is what a content-error
    // fallback re-renders as plain text.
    assert.equal(h.lastEdit().payload.sourceText, body);
  });

  test('with no marker configured the streamer behaves exactly as before', async () => {
    const h = makeHarness({ toComposingMarker: null, toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.');
    await h.advance(500);
    await h.streamer.onChunk('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');
    await h.advance(500);
    await h.streamer.finalize('# Отчёт\n\nПервый абзац.\n\nВторой абзац.');

    for (const e of h.edits) assert.ok(!carriesMarker(e.payload));
  });

  test('a throwing marker builder costs the marker, never the edit', async () => {
    const h = makeHarness({ toComposingMarker: () => { throw new Error('boom'); } });
    await h.streamer.onChunk('Начало.');
    await h.advance(500);
    await h.streamer.onChunk('Начало. Продолжение.');
    await h.advance(500);

    assert.equal(h.lastEdit().payload, 'Начало. Продолжение.');
  });
});

describe('composingMarker shapes', () => {
  test('styled emits a typed italic node; unstyled emits the same text flat', () => {
    assert.deepEqual(composingMarker({ styled: true }).block, {
      type: 'paragraph', text: [{ type: 'italic', text: COMPOSING_MARKER_TEXT }],
    });
    assert.deepEqual(composingMarker({ styled: false }).block, {
      type: 'paragraph', text: COMPOSING_MARKER_TEXT,
    });
  });

  test('the plain suffix is a separate italic line', () => {
    assert.equal(COMPOSING_MARKER_SUFFIX, `\n\n_${COMPOSING_MARKER_TEXT}_`);
  });
});
