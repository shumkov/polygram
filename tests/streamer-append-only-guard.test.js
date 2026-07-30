/**
 * The streamer accepts a snapshot only if it EXTENDS the last accepted one.
 *
 * The `stream` tool's contract says snapshots are cumulative, but that is a
 * model-compliance contract: a model can send a LONGER snapshot that has
 * dropped its earlier sections, and rendering it wipes the top of a report
 * out from under someone reading it.
 *
 * What may change freely is whatever the reader has not seen settle — the
 * block a rich bubble is still holding back, the line a plain bubble is still
 * typing. What may not change is anything already on screen. So the pin comes
 * from the renderer's own account of what it drew, never from a guess about
 * where blocks begin.
 *
 * Fake clock/schedule harness (same pattern as streamer-rich.test.js) so
 * throttle timing is deterministic.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer, completeLines } = require('../lib/telegram/streamer');
const { toTelegramRichBlocks, partialVisibleExtent } = require('../lib/telegram/rich');

function makeHarness({ onNonCumulativeSnapshot, toRichPayload, minChars = 1 } = {}) {
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
    minChars,
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

  test('a plain bubble pins every complete line it displayed', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    // A plain render shows the WHOLE text — there is no held-back block — so
    // a line that reached the screen is a line that may not vanish.
    await h.streamer.onChunk('Первая строка\nВторая строка');
    await h.advance(500);
    await h.streamer.onChunk('Совсем другой текст без первой строки');
    await h.advance(500);

    assert.equal(events.length, 1);
    assert.equal(h.streamer.latestText, 'Первая строка\nВторая строка');
  });

  test('a plain bubble still lets the line being typed be rewritten', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Первая строка\nВторая стро');
    await h.advance(500);
    await h.streamer.onChunk('Первая строка\nВторая строка, переписанная целиком.');
    await h.advance(500);

    assert.equal(events.length, 0, 'the line in progress has not settled');
  });

  test('a single unfinished line pins nothing at all', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Начал писать');
    await h.advance(500);
    await h.streamer.onChunk('Начал заново, совсем иначе.');
    await h.advance(500);

    assert.equal(events.length, 0);
  });
});

describe('streamer — nothing is pinned before anything is drawn', () => {
  // Traced repro: a first snapshot shorter than streamMinChars pins a prefix
  // although NOTHING was rendered. The model revises its opening, every later
  // snapshot is refused against that stale pin, and the preview never opens
  // at all — zero sends, state stuck idle, for the whole turn.
  test('a snapshot below minChars pins nothing, so the preview can still open', async () => {
    const events = [];
    const h = makeHarness({ minChars: 30, onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Привет!\n\nСейчас');          // 15 chars, nothing sent
    await h.advance(500);
    assert.equal(h.sent.length, 0, 'precondition: below minChars, nothing was drawn');

    await h.streamer.onChunk('Здравствуйте!\n\nОдну минуту'); // revised opening, still short
    await h.advance(500);
    await h.streamer.onChunk('Здравствуйте!\n\nОдну минуту, сейчас всё посмотрю и отвечу.');
    await h.advance(500);

    assert.equal(events.length, 0, 'nothing was on screen, so nothing could be lost');
    assert.equal(h.sent.length, 1, 'the preview must still open once the text is long enough');
    assert.equal(h.streamer.state, 'live');
  });

  test('a failed initial send leaves nothing pinned', async () => {
    const events = [];
    const streamer = createStreamer({
      send: async () => { throw new Error('send failed'); },
      edit: async () => {},
      minChars: 1,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      onNonCumulativeSnapshot: (d) => events.push(d),
    });

    await streamer.onChunk(SNAPSHOT_A);
    assert.equal(streamer.state, 'idle', 'the failed send must have reverted to idle');
    await streamer.onChunk(SNAPSHOT_B);

    assert.equal(events.length, 0, 'the bubble never existed — there is nothing to protect');
    assert.equal(streamer.latestText, SNAPSHOT_B,
      'and the draft must track the model, or finalize delivers text it has moved past');
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

describe('streamer — a fence is pinned exactly when the reader can see it', () => {
  // The same source is a different promise depending on which renderer drew
  // it, which is why the pin has to come from the renderer rather than from
  // the shape of the text.
  const OPEN_FENCE_PLAIN = 'Вот решение.\n\n```js\nfunction f() {\n  const x = 1;\n\n  return x;';
  const OPEN_FENCE_RICH = '# Решение\n\n```js\nfunction f() {\n  const x = 1;\n\n  return x;';

  test('a plain-rendered fence is fully visible, so its body is pinned', async () => {
    const events = [];
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });

    // No rich trigger here: this renders as plain text and the reader is
    // looking at every line of the snippet.
    assert.equal(toTelegramRichBlocks(OPEN_FENCE_PLAIN, { partial: true }).usedRich, false,
      'precondition: this shape renders plain');

    await h.streamer.onChunk(OPEN_FENCE_PLAIN);
    await h.advance(500);
    // Dropping the fence lines the reader is looking at: the production wipe
    // shape, wearing a code block.
    await h.streamer.onChunk('Вот решение.\n\n```js\n  return x;\n}\n```\n\nГотово, всё работает как надо.');
    await h.advance(500);

    assert.equal(events.length, 1, 'lines on screen may not be dropped, fence or not');
    assert.equal(h.streamer.latestText, OPEN_FENCE_PLAIN);
  });

  test('a rich-rendered fence is held back, so its body is not pinned', async () => {
    const events = [];
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });

    const partial = toTelegramRichBlocks(OPEN_FENCE_RICH, { partial: true });
    assert.equal(partial.usedRich, true);
    assert.equal(partial.blocks.length, 1, 'precondition: only the heading is on screen');

    await h.streamer.onChunk(OPEN_FENCE_RICH);
    await h.advance(500);
    // Revising the snippet the renderer is still holding back.
    await h.streamer.onChunk('# Решение\n\n```js\nfunction f() {\n  const x = 42;\n\n  return x;\n}\n```\n\nГотово.');
    await h.advance(500);

    assert.equal(events.length, 0, 'nothing of the fence reached the screen, so nothing of it is pinned');
  });

  test('the heading above a held-back fence is still pinned', async () => {
    const events = [];
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk(OPEN_FENCE_RICH);
    await h.advance(500);
    await h.streamer.onChunk('```js\nfunction f() {\n  const x = 1;\n\n  return x;\n}\n```\n\nГотово.');
    await h.advance(500);

    assert.equal(events.length, 1, 'losing the displayed heading is still losing seen text');
  });

  test('CRLF text is guarded, not silently exempt', async () => {
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Первый абзац.\r\n\r\nВторой абзац.\r\n\r\nТретий нача');
    await h.advance(500);
    await h.streamer.onChunk('Второй абзац.\r\n\r\nТретий абзац целиком, и даже больше текста.');
    await h.advance(500);

    assert.equal(events.length, 1,
      'a \\r\\n document must not turn the guard off — lastIndexOf(\\n\\n) alone never matches it');
  });
});

describe('completeLines — the plain bubble\'s settled extent', () => {
  test('nothing is settled until a line ends', () => {
    assert.equal(completeLines(''), '');
    assert.equal(completeLines('one unfinished line'), '');
  });

  test('everything up to the last newline has settled', () => {
    assert.equal(completeLines('a\nb'), 'a\n');
    assert.equal(completeLines('a\nb\n'), 'a\nb\n');
  });
});

describe('the pin agrees with what the renderer drew', () => {
  // Every case here asserts the RENDERER's own account of what was visible,
  // then proves that mutating something visible is refused and mutating
  // something held back is accepted. A boundary guessed from the text —
  // blank lines, fences, anything — disagrees with the renderer in both
  // directions, and both directions are bugs: one freezes the preview, the
  // other lets it be wiped.
  const visibleSource = (src) => src.slice(0, partialVisibleExtent(src));

  const RICH_CASES = [
    {
      name: 'blocks separated by single newlines',
      src: '# One\n## Two\n## Three',
      mutateVisible: '# One\n## Changed\n## Three',
      extendHeldBack: '# One\n## Two\n## Three complete\n\nmore',
    },
    {
      name: 'table followed by prose',
      src: '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter the table\n\nstill writing',
      mutateVisible: '| a | b |\n| - | - |\n| 9 | 9 |\n\nafter the table\n\nstill writing more',
      extendHeldBack: '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter the table\n\nstill writing more',
    },
    {
      name: 'loose multi-paragraph list',
      src: '# Title\n\n- item one\n\n- item two\n\ntail para',
      mutateVisible: '# Title\n\n- item ONE\n\n- item two\n\ntail para extended',
      extendHeldBack: '# Title\n\n- item one\n\n- item two\n\ntail para extended',
    },
    {
      name: 'closed fence with an internal blank line',
      src: '# Title\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\ntail',
      mutateVisible: '# Title\n\n```js\nconst a = 99;\n\nconst b = 2;\n```\n\ntail extended',
      extendHeldBack: '# Title\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\ntail extended',
    },
    {
      name: 'tilde fence',
      src: '# Title\n\n~~~js\nconst a = 1;\n\nconst b = 2;\n~~~\n\ntail',
      mutateVisible: '# Title\n\n~~~js\nconst a = 99;\n\nconst b = 2;\n~~~\n\ntail extended',
      extendHeldBack: '# Title\n\n~~~js\nconst a = 1;\n\nconst b = 2;\n~~~\n\ntail extended',
    },
    {
      name: 'a literal triple backtick in prose',
      src: '# Title\n\nUse ``` to open a fence.\n\nstill writing',
      mutateVisible: '# Title\n\nUse ~~~ to open a fence.\n\nstill writing more',
      extendHeldBack: '# Title\n\nUse ``` to open a fence.\n\nstill writing more',
    },
  ];

  for (const c of RICH_CASES) {
    test(`${c.name}: a visible mutation is refused`, async () => {
      const events = [];
      const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });
      const seen = visibleSource(c.src);
      assert.ok(seen.length > 0, 'precondition: something was on screen');
      assert.ok(c.mutateVisible.slice(0, seen.length) !== seen,
        'precondition: this mutation really does change displayed source');

      await h.streamer.onChunk(c.src);
      await h.advance(500);
      await h.streamer.onChunk(c.mutateVisible);
      await h.advance(500);

      assert.equal(events.length, 1);
    });

    test(`${c.name}: revising what is held back is accepted`, async () => {
      const events = [];
      const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });

      await h.streamer.onChunk(c.src);
      await h.advance(500);
      await h.streamer.onChunk(c.extendHeldBack);
      await h.advance(500);

      assert.equal(events.length, 0);
    });
  }

  test('a trailing blank-line run may shrink', async () => {
    const events = [];
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('# Title\n\nfirst para\n\nsecond para\n\n\n');
    await h.advance(500);
    await h.streamer.onChunk('# Title\n\nfirst para\n\nsecond para\n\nthird');
    await h.advance(500);

    assert.equal(events.length, 0, 'losing a blank line loses nothing anyone was reading');
  });

  test('a ticked checkbox carrying an annotation is refused, deliberately', async () => {
    // normalizeTaskMarkers forgives the BOX. Text appended beside it is new
    // prose on a settled line, which is indistinguishable from a rewrite —
    // pinned as intended rather than tolerated by accident.
    const events = [];
    const h = makeHarness({ onNonCumulativeSnapshot: (d) => events.push(d) });

    await h.streamer.onChunk('Прогресс:\n- [ ] задеплоить\n- [ ] проверить\nещё пишу');
    await h.advance(500);
    await h.streamer.onChunk('Прогресс:\n- [x] задеплоить — готово в 14:03\n- [ ] проверить\nещё пишу дальше');
    await h.advance(500);

    assert.equal(events.length, 1,
      'the box is forgiven; an annotation appearing on a settled line is not');
  });
});
