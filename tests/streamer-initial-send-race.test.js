/**
 * The initial-send race: `onChunk` flips the streamer to 'live' synchronously
 * but only learns the bubble's message_id once the send resolves. Anything that
 * acts on the bubble in that window — a finalize, a drain, a discard — used to
 * operate on msgId=null, so the message that landed a moment later became an
 * invisible orphan: real bubble in the chat, no handle to edit or delete it,
 * and the caller told "preview IS final" about a bubble still showing the first
 * 30 characters.
 *
 * The window is small on a healthy connection and wide open on a slow one —
 * which is exactly when a turn is most likely to end while a send is in flight.
 *
 * Run: node --test tests/streamer-initial-send-race.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamer } = require('../lib/telegram/streamer');

/**
 * A send that lands on a later macrotask. The delay matters: it puts the
 * resolution beyond any number of microtask hops, so a caller that merely
 * yields — rather than actually awaiting the send — reaches the bubble while
 * msgId is still null.
 */
function slowSend(messageId = 4242, delayMs = 10) {
  return {
    send: () => new Promise((resolve) => {
      setTimeout(() => resolve({ message_id: messageId }), delayMs);
    }),
  };
}

function recordingEdit(edits) {
  return async (msgId, payload) => {
    // The real editMessageText rejects a null message_id; a fake that quietly
    // accepted it would hide the whole bug.
    if (msgId == null) throw new Error('editMessageText: message_id is required');
    edits.push({ msgId, payload });
  };
}

test('finalize awaits the in-flight initial send and edits the real bubble', async () => {
  const edits = [];
  const streamer = createStreamer({
    send: slowSend(4242).send,
    edit: recordingEdit(edits),
    minChars: 5,
    logger: { error: () => {} },
  });

  // Chunk crosses minChars → initial send starts, and has not landed yet.
  const chunking = streamer.onChunk('a partial answer');
  assert.equal(streamer.state, 'live');
  assert.equal(streamer.msgId, null, 'precondition: the id is not known yet');

  // The turn ends while that send is still in flight.
  const fin = await streamer.finalize('a partial answer, now complete');
  await chunking;

  assert.equal(fin.msgId, 4242, 'finalize must resolve against the landed bubble');
  assert.equal(fin.finalEditOk, true);
  assert.deepEqual(edits.map((e) => e.msgId), [4242]);
  assert.equal(edits[0].payload, 'a partial answer, now complete');
});

test('flushDraft awaits the in-flight initial send', async () => {
  const edits = [];
  const streamer = createStreamer({
    send: slowSend(77).send,
    edit: recordingEdit(edits),
    minChars: 5,
    logger: { error: () => {} },
  });

  const chunking = streamer.onChunk('first draft text');
  await streamer.flushDraft();

  assert.equal(streamer.msgId, 77,
    'a drain that returns before the id is known cannot have drained anything');
  await chunking;
});

test('discard deletes the bubble whose send was still in flight', async () => {
  const deleted = [];
  const streamer = createStreamer({
    send: slowSend(99).send,
    edit: async () => {},
    deleteMessage: async (id) => { deleted.push(id); },
    minChars: 5,
    logger: { error: () => {}, warn: () => {} },
  });

  const chunking = streamer.onChunk('a draft the caller decides to drop');
  const res = await streamer.discard();
  await chunking;

  assert.deepEqual(deleted, [99], 'otherwise the bubble is stranded in the chat forever');
  assert.equal(res.msgId, 99);
  assert.equal(res.deleted, true);
});

test('a failed initial send still leaves finalize on the not-streamed path', async () => {
  // The reverse guard: awaiting the send must not turn a failed send into a
  // phantom "preview IS final" result.
  const streamer = createStreamer({
    send: async () => { throw new Error('429 too many requests'); },
    edit: async () => { throw new Error('edit must never be attempted'); },
    minChars: 5,
    logger: { error: () => {} },
  });

  await streamer.onChunk('a draft that never lands');
  const fin = await streamer.finalize('the complete answer');
  assert.equal(fin.streamed, false, 'caller must fall through to its normal send path');
  assert.equal(fin.msgId, null);
});
