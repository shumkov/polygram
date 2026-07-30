/**
 * The streamer accepts a snapshot only if it EXTENDS the last accepted one.
 *
 * The `stream` tool's contract says snapshots are cumulative, but that is a
 * model-compliance contract. Production (topic 5639, turn 802281d2) saw
 * 724 chars/5 blocks -> 1,997/13 blocks -> 2,297/7 blocks: the third snapshot
 * was LONGER than the second and had dropped the first three sections. The
 * streamer rendered it faithfully and the user watched the top of the report
 * vanish mid-stream.
 *
 * Extension tolerates revision of the incomplete TAIL — in partial mode the
 * model is legitimately still rewriting the block it is part-way through.
 * What it does not tolerate is losing text the reader has already seen as
 * complete.
 *
 * Fake clock/schedule harness (same pattern as streamer-rich.test.js) so
 * throttle timing is deterministic.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer, committedPrefix } = require('../lib/telegram/streamer');

function makeHarness({ onNonCumulativeSnapshot, toRichPayload } = {}) {
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
    edit: async (msgId, payload) => { edits.push({ msgId, payload }); },
    minChars: 1,
    throttleMs: 500,
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
    ...(onNonCumulativeSnapshot && { onNonCumulativeSnapshot }),
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

  return { streamer, sent, edits, advance };
}

// The production shape: several sections the reader has already watched
// appear, plus a fourth still being written.
const SNAPSHOT_A = [
  '# Отчёт',
  '',
  '## 1. Введение',
  'Первый раздел целиком написан.',
  '',
  '## 2. Данные',
  'Второй раздел целиком написан.',
  '',
  '## 3. Анализ',
  'Третий раздел целиком написан.',
  '',
  '## 4. Вывод',
  'Начало четвёр',
].join('\n');

// Longer than A, but sections 1–3 are gone: only the tail survived. This is
// what production actually sent.
const SNAPSHOT_B = [
  '## 4. Вывод',
  'Четвёртый раздел теперь дописан полностью и стал заметно длиннее.',
  '',
  '## 5. Приложение',
  'Пятый раздел тоже написан, поэтому снапшот длиннее предыдущего.',
  '',
  '## 6. Ссылки',
  'И ещё немного текста, чтобы длина точно превысила предыдущий снапшот.',
].join('\n');

// A genuine continuation of A: everything A had, plus more.
const SNAPSHOT_C = `${SNAPSHOT_A}того раздела.\n\n## 5. Приложение\nПятый раздел.`;

describe('streamer — append-only snapshot guard', () => {
  test('production repro: a longer snapshot missing earlier sections is not rendered', async () => {
    assert.ok(SNAPSHOT_B.length > SNAPSHOT_A.length,
      'the repro only means something if B is LONGER than A — that is what made this bug invisible to a length check');

    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(SNAPSHOT_A);
    await h.advance(500);
    const editsAfterA = h.edits.length;

    await h.streamer.onChunk(SNAPSHOT_B);
    await h.advance(500);

    assert.equal(h.edits.length, editsAfterA,
      'the non-cumulative snapshot must not produce a telegram edit');
    assert.equal(h.streamer.latestText, SNAPSHOT_A,
      'the bubble keeps showing the last snapshot the reader actually saw');
    assert.equal(events.length, 1, 'the violation must be counted');
    assert.equal(events[0].prevLen, SNAPSHOT_A.length);
    assert.equal(events[0].newLen, SNAPSHOT_B.length);
  });

  test('after a violation the anchor is the last ACCEPTED snapshot, not the rejected one', async () => {
    const h = makeHarness();

    await h.streamer.onChunk(SNAPSHOT_A);
    await h.advance(500);
    await h.streamer.onChunk(SNAPSHOT_B);   // rejected
    await h.advance(500);

    // C extends A. If the guard had re-anchored on B, C would look like a
    // violation and streaming would be dead for the rest of the turn.
    await h.streamer.onChunk(SNAPSHOT_C);
    await h.advance(500);

    const last = h.edits[h.edits.length - 1];
    assert.ok(last, 'a snapshot that genuinely extends the last accepted one must resume editing');
    assert.equal(last.payload, SNAPSHOT_C);
    assert.equal(h.streamer.latestText, SNAPSHOT_C);
  });

  test('revising the incomplete trailing block is an extension, not a violation', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    const withPartialTail = 'Готовый абзац.\n\nВторой готовый абзац.\n\nНачал писать тре';
    // The model rewrote the sentence it was mid-way through — normal
    // partial-mode behaviour, and shorter than what came before it.
    const tailRewritten = 'Готовый абзац.\n\nВторой готовый абзац.\n\nТретий.';

    await h.streamer.onChunk(withPartialTail);
    await h.advance(500);
    await h.streamer.onChunk(tailRewritten);
    await h.advance(500);

    assert.equal(events.length, 0, 'tail revision must not trip the guard');
    assert.equal(h.streamer.latestText, tailRewritten);
    assert.equal(h.edits[h.edits.length - 1].payload, tailRewritten);
  });

  test('a cumulative append chain (the SDK shape) never trips the guard', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    let text = 'Начало ответа.';
    await h.streamer.onChunk(text);
    await h.advance(500);
    for (const added of ['\n\nВторой абзац.', ' Продолжение.', '\n\nТретий абзац.', '\n\n- пункт', '\n- ещё пункт']) {
      text += added;
      await h.streamer.onChunk(text);
      await h.advance(500);
    }

    assert.equal(events.length, 0);
    assert.equal(h.streamer.latestText, text);
  });

  test('text with no completed block yet — the guard abstains', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    // No blank line anywhere: the whole snapshot is one in-progress block,
    // which is exactly the case rich rendering emits as-is rather than
    // holding back. Nothing has been seen as COMPLETE, so nothing is pinned.
    await h.streamer.onChunk('Первая строка\nВторая строка');
    await h.advance(500);
    await h.streamer.onChunk('Совсем другой текст без пустых строк');
    await h.advance(500);

    assert.equal(events.length, 0);
    assert.equal(h.streamer.latestText, 'Совсем другой текст без пустых строк');
  });

  test('a violation before the bubble exists still protects the finalize body', async () => {
    const h = makeHarness();
    // minChars is 1 in the harness, so drive the idle case by failing the
    // send: the streamer reverts to idle while keeping latestText.
    const streamer = createStreamer({
      send: async () => { throw new Error('send failed'); },
      edit: async () => {},
      minChars: 1,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
    });

    await streamer.onChunk(SNAPSHOT_A);
    assert.equal(streamer.state, 'idle', 'the failed send must have reverted to idle');
    await streamer.onChunk(SNAPSHOT_B);

    assert.equal(streamer.latestText, SNAPSHOT_A,
      'finalize falls back to latestText — it must not become the truncated snapshot');
    void h;
  });

  test('one row per refusal, so a looping model is a GROUP BY away', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(SNAPSHOT_A);
    await h.advance(500);
    await h.streamer.onChunk(SNAPSHOT_B);
    await h.streamer.onChunk(`${SNAPSHOT_B}\n\nещё`);
    await h.advance(500);

    assert.equal(events.length, 2);
  });
});

describe('streamer — ticking a checkbox is not losing text', () => {
  // The display hint teaches this verbatim (lib/telegram/display-hint.js):
  // "use them when ... you will send an updated list with items checked off
  // as you complete them". That is a mid-document mutation of text the reader
  // has already seen, and a verbatim-prefix guard would refuse it — freezing
  // the preview for the rest of the turn on the exact feature polygram asks
  // the agent to use.
  const PENDING = 'Работаю над задачей.\n\n- [ ] шаг один\n- [ ] шаг два\n\nПочти готово.';

  test('a snapshot that only ticks an item off is accepted', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(PENDING);
    await h.advance(500);
    const ticked = 'Работаю над задачей.\n\n- [x] шаг один\n- [ ] шаг два\n\nПочти готово, остался второй шаг.';
    await h.streamer.onChunk(ticked);
    await h.advance(500);

    assert.equal(events.length, 0, 'ticking a box loses nothing — the item is still there, in place');
    assert.equal(h.streamer.latestText, ticked);
    assert.equal(h.edits[h.edits.length - 1].payload, ticked);
  });

  test('ticking every box at once is still accepted', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(PENDING);
    await h.advance(500);
    await h.streamer.onChunk('Работаю над задачей.\n\n- [x] шаг один\n- [x] шаг два\n\nГотово.');
    await h.advance(500);

    assert.equal(events.length, 0);
  });

  test('a snapshot that ticks a box AND drops a completed section is still refused', async () => {
    // The relaxation must not become an escape hatch: checkbox state is
    // exempt, the text around it is not.
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(PENDING);
    await h.advance(500);
    const editsBefore = h.edits.length;
    await h.streamer.onChunk('- [x] шаг один\n- [x] шаг два\n\nГотово, но вступление пропало.');
    await h.advance(500);

    assert.equal(events.length, 1);
    assert.equal(h.edits.length, editsBefore, 'the lost opening paragraph must still stop the render');
    assert.equal(h.streamer.latestText, PENDING);
  });

  test('a literal [x] in prose is not treated as a checkbox', async () => {
    // Only a task-list marker at the head of a list item is state; `[x]`
    // inside a sentence is content, and rewriting it IS losing text.
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Регексп [x] совпадает.\n\nВторой абзац.\n\nТретий начат');
    await h.advance(500);
    await h.streamer.onChunk('Регексп [ ] совпадает.\n\nВторой абзац.\n\nТретий абзац целиком.');
    await h.advance(500);

    assert.equal(events.length, 1, 'prose is prose — a changed character above the boundary is a rewrite');
  });
});

describe('committedPrefix', () => {
  test('is empty when nothing has been completed', () => {
    assert.equal(committedPrefix(''), '');
    assert.equal(committedPrefix('one line'), '');
    assert.equal(committedPrefix('line\nline'), '');
  });

  test('ends at the last blank line, keeping the separator', () => {
    assert.equal(committedPrefix('a\n\nb'), 'a\n\n');
    assert.equal(committedPrefix('a\n\nb\n\nc'), 'a\n\nb\n\n');
  });

  test('a trailing blank line commits everything before it', () => {
    assert.equal(committedPrefix('a\n\n'), 'a\n\n');
  });

  test('runs of blank lines resolve to the last one', () => {
    assert.equal(committedPrefix('a\n\n\nb'), 'a\n\n\n');
  });
});
