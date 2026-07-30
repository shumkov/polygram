/**
 * polygram.js wiring for the append-only snapshot guard.
 *
 * The streamer refuses a snapshot that lost text the reader had already seen
 * and keeps the bubble on the last good one. That refusal is invisible from
 * the outside — the tool ack stays ok, because an error there buys a retry
 * loop rather than a better snapshot — so the event is the ONLY way model
 * misuse reaches the operator. These assertions pin the payload a soak query
 * would have to read.
 *
 * Source-text assertions, like polygram-rich-wiring.test.js: handleMessage is
 * not constructible in a unit test, and the alternative is no coverage of the
 * seam at all.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

describe('polygram append-only guard wiring', () => {
  test('the streamer is given the refusal callback', () => {
    assert.match(source, /onNonCumulativeSnapshot: \(\{ prevLen, newLen \}\) => \{/,
      'createStreamer must receive the callback, or refusals are silent');
  });

  test('the event carries what a soak query needs to attribute the misuse', () => {
    const start = source.indexOf('onNonCumulativeSnapshot:');
    assert.notEqual(start, -1);
    const wiring = source.slice(start, source.indexOf('},', start));

    assert.match(wiring, /logEvent\('stream-noncumulative'/);
    // chat + topic + turn identify WHICH conversation misbehaved; without the
    // turn id a burst of rows cannot be told from one turn repeating itself.
    assert.match(wiring, /chat_id: chatId/);
    assert.match(wiring, /thread_id: threadId/);
    assert.match(wiring, /turn_id: dispatchedTurnId/);
    // Every other polygram stream-* row carries it; a soak grouping by
    // conversation should not have to special-case this one.
    assert.match(wiring, /session_key: sessionKey/);
    // The two lengths are the evidence the snapshot GREW while losing text —
    // the property that makes this a contract violation and not a truncation.
    assert.match(wiring, /prev_len: prevLen/);
    assert.match(wiring, /new_len: newLen/);
  });

  test('the turn id is in scope before the streamer is built', () => {
    const declaration = source.indexOf('let dispatchedTurnId = null;');
    const streamerCreation = source.indexOf('const streamer = createStreamer({');
    assert.notEqual(declaration, -1, 'dispatchedTurnId must still be declared');
    assert.notEqual(streamerCreation, -1);
    assert.ok(declaration < streamerCreation,
      'declared after the streamer, the callback would close over a TDZ binding and throw on the first refusal');
    assert.equal((source.match(/let dispatchedTurnId = null;/g) || []).length, 1,
      'one declaration — a second would shadow it and the event would log null forever');
  });

  test('the dispatch still publishes the turn id onto that binding', () => {
    assert.match(source, /onTurnId: \(id\) => \{ dispatchedTurnId = id; \}/);
    assert.match(source, /getTurnId: \(\) => dispatchedTurnId/,
      'the reply-attribution path reads the same binding');
  });
});

describe('polygram composing-marker wiring', () => {
  test('the streamer is given the marker builder', () => {
    assert.match(source, /toComposingMarker: \(\{ blocks \}\) => composingMarker\(/,
      'without it the growing bubble never says it is still being written');
  });

  test('the marker matches the styling of the content it decorates', () => {
    // Not the latch: that says what the transport CAN carry. blocksAreStyled
    // reads the shape of what is actually being sent, and rich-edit records a
    // styling verdict for anything it calls styled — so a typed node on flat
    // content makes those verdicts (strike runs reset, flatten retries paid)
    // be about markup polygram injected rather than the agent's own.
    assert.match(source, /toComposingMarker: \(\{ blocks \}\) => composingMarker\(\{ styled: blocksAreStyled\(blocks \|\| \[\]\) \}\)/);
    assert.doesNotMatch(source, /composingMarker\(\{ styled: !richInlineStylingUnsupported \}\)/);
  });
});
