'use strict';

// A reply that streams as a rich document can turn plain part way: a person
// mention (tg://user?id=…) only survives on the HTML path, so once one
// arrives the rich gate declines. If the stream then moves to a new bubble,
// the finished bubble must still end with all of its text, not with the
// last rich frame recorded before the mention arrived.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');
const { composingMarker } = require('../lib/telegram/composing-marker');

function makeHarness() {
  const sent = [];
  const edits = [];
  let nextId = 1000;
  let now = 0;
  const timers = [];
  const streamer = createStreamer({
    send: async (payload) => { const id = nextId++; sent.push({ id, payload }); return { message_id: id }; },
    edit: async (msgId, payload) => { edits.push({ msgId, payload }); },
    minChars: 1,
    throttleMs: 500,
    maxLen: 4096,
    clock: () => now,
    schedule: (fn, delay) => { const t = { fn, fireAt: now + delay }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    logger: { log: () => {}, error: () => {}, warn: () => {} },
    toRichPayload: toTelegramRichBlocks,
    toComposingMarker: () => composingMarker(),
  });
  async function advance(ms) {
    now += ms;
    for (const t of timers.filter((x) => x.fireAt <= now)) {
      const i = timers.indexOf(t);
      if (i !== -1) timers.splice(i, 1);
      await t.fn();
    }
  }
  return { streamer, sent, edits, advance };
}

// What the reader sees: a plain edit's text, or a rich edit's blocks (never
// its sourceText, which the reader does not see).
const textOf = (payload) => (typeof payload === 'string' ? payload : JSON.stringify(payload.blocks));

test('a bubble sealed after a mention turned it plain keeps all of its text', async () => {
  const h = makeHarness();
  const start = 'Two things before Friday:\n\n- the budget\n- the creatives';
  const full = `${start}\n\n[Linh](tg://user?id=8616081456), please confirm.`;

  await h.streamer.onChunk(start);
  await h.advance(600);
  await h.streamer.onChunk(full);
  const oldId = h.sent[0].id;
  h.streamer.forceNewMessage();
  await h.streamer.onChunk('Next part.');
  await h.streamer.drainSeals();

  const toOld = h.edits.filter((edit) => edit.msgId === oldId);
  assert.ok(toOld.length > 0, 'the finished bubble gets a final edit');
  const final = textOf(toOld[toOld.length - 1].payload);
  for (const part of ['Two things before Friday', 'the budget', 'the creatives', 'please confirm']) {
    assert.ok(final.includes(part), `the finished bubble still shows "${part}"`);
  }
});
