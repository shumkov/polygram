/**
 * Tests for progressive rich-message streaming in streamer.js.
 *
 * Uses a fake clock/schedule harness (same pattern as streaming-
 * integration.test.js) so throttle timing is deterministic.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');

function makeHarness({
  toRichPayload,
  richMaxLen,
  maxLen = 4096,
  onRichUpgrade,
  editReturns,
  sendReturns,
  preserveIntermediateBubbles,
  logger,
} = {}) {
  const sent = [];
  const edits = []; // each entry: string OR { rich:true, blocks }
  let nextId = 1000;
  let now = 0;
  const timers = [];

  // The send callback takes the same payload shapes as edit: a plain string,
  // or a rich open when the first qualifying chunk already renders as
  // structure. sendReturns lets a test model a server that answers a rich
  // open with a plain bubble ({ wentRich: false }).
  const send = async (payload) => {
    const id = nextId++;
    sent.push({ id, payload });
    return sendReturns
      ? sendReturns(id, payload, sent.length - 1)
      : { message_id: id };
  };
  // editReturns: optional (msgId, payload) => value|undefined — lets a
  // test simulate lib/telegram/rich-edit.js's {result, wentRich} contract
  // (e.g. a fallback-to-plain resolving with wentRich:false) without
  // needing the real network/classifier stack. Default `undefined`
  // models edit callbacks that do not report whether the payload landed as rich.
  const edit = async (msgId, payload) => {
    edits.push({ msgId, payload });
    return editReturns ? editReturns(msgId, payload) : undefined;
  };

  const streamer = createStreamer({
    send, edit,
    minChars: 1, throttleMs: 500, maxLen,
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
    logger: logger || { log: () => {}, error: () => {}, warn: () => {} },
    toRichPayload,
    ...(richMaxLen != null && { richMaxLen }),
    ...(onRichUpgrade && { onRichUpgrade }),
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

  return { streamer, sent, edits, advance };
}

// A bubble OPENS rich as soon as its first chunk renders as structure, so a
// test about the plain→rich EDIT transition has to start from prose. The
// trailing paragraph keeps the list out of partial mode's held-back tail,
// which is what makes the growth render rich on a mid-stream flush.
const PLAIN_OPENER = 'Report incoming.';
const RICH_GROWTH = `${PLAIN_OPENER}\n\n- [ ] task\n\nAnd more after it.`;

describe('streamer — progressive rich streaming (integration with real toTelegramRichBlocks)', () => {
  test('plain content never produces a rich edit', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('Just plain prose, no structure here at all.');
    await h.advance(500);
    for (const e of h.edits) assert.equal(typeof e.payload, 'string');
  });

  test('a checklist mid-stream upgrades the live edit to rich blocks', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('Working on it.'); // initial send — always plain
    await h.advance(500);
    // The checklist must NOT be the trailing block here — partial:true
    // mode (correctly) holds back the trailing top-level block on every
    // mid-stream flush, since it could still be incomplete. Appending a
    // paragraph after the list is what
    // makes the list block eligible to actually appear in THIS flush,
    // rather than being the (correctly) held-back tail.
    await h.streamer.onChunk('Working on it.\n\n- [ ] step one\n\nMore context after.');
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.ok(last, 'expected at least one edit');
    assert.equal(typeof last.payload, 'object');
    assert.equal(last.payload.rich, true);
    assert.ok(Array.isArray(last.payload.blocks));
    // Assert the checklist contents and checkbox state, not merely that
    // some rich blocks were emitted.
    const list = last.payload.blocks.find((b) => b.type === 'list');
    assert.ok(list, 'expected a list block in the upgraded rich payload');
    assert.equal(list.items[0].has_checkbox, true);
    assert.ok(h.streamer.isRichMode);
  });

  test('a checklist as the trailing (possibly-incomplete) block is correctly held back until finalize', async () => {
    // Companion to the test above: confirms the held-back-tail behavior
    // itself, not just that SOME edit happens. Mid-stream, the checklist
    // (as the last block) must be ABSENT; at finalize (partial:false) it
    // must be present. This pins partial-mode safety at the streamer
    // integration boundary.
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    const body = 'Working on it.\n\n- [ ] step one';
    await h.streamer.onChunk('Working on it.');
    await h.advance(500);
    await h.streamer.onChunk(body);
    await h.advance(500);
    const midStream = h.edits[h.edits.length - 1];
    if (midStream && typeof midStream.payload === 'object') {
      const list = midStream.payload.blocks.find((b) => b.type === 'list');
      assert.equal(list, undefined, 'the trailing checklist must be held back mid-stream, not shown incomplete');
    }
    const result = await h.streamer.finalize(body);
    assert.equal(result.finalEditOk, true);
    const final = h.edits[h.edits.length - 1];
    assert.equal(typeof final.payload, 'object');
    const finalList = final.payload.blocks.find((b) => b.type === 'list');
    assert.ok(finalList, 'the checklist must appear once finalize() runs with partial:false');
    assert.equal(finalList.items[0].has_checkbox, true);
  });

  test('a blockquote mid-stream upgrades the live edit to rich blocks', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('Heads up.');
    await h.advance(500);
    // Trailing paragraph keeps the blockquote out of the held-back tail.
    await h.streamer.onChunk('Heads up.\n\n> this caveat matters\n\nMore prose after.');
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.equal(typeof last.payload, 'object', 'blockquote content must trigger a rich edit');
    assert.ok(last.payload.blocks.some((b) => b.type === 'blockquote'));
    assert.ok(h.streamer.isRichMode);
  });

  test('a divider mid-stream upgrades the live edit to rich blocks', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('Section one.');
    await h.advance(500);
    await h.streamer.onChunk('Section one.\n\n---\n\nSection two starts here.');
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.equal(typeof last.payload, 'object', 'a divider must trigger a rich edit');
    assert.ok(last.payload.blocks.some((b) => b.type === 'divider'));
    assert.ok(h.streamer.isRichMode);
  });

  test('onRichUpgrade fires exactly once on the plain→rich transition', async () => {
    let upgrades = 0;
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onRichUpgrade: () => { upgrades++; } });
    await h.streamer.onChunk('plain start');
    await h.advance(500);
    await h.streamer.onChunk('plain start\n\n- [ ] now a task');
    await h.advance(500);
    await h.streamer.onChunk('plain start\n\n- [ ] now a task\n- [x] and another');
    await h.advance(500);
    assert.equal(upgrades, 1);
  });

  test('once rich, growing content keeps producing rich edits (no downgrade)', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    // Trailing paragraph on both ticks so the list is inside the rendered
    // tree rather than the held-back tail, and the growth is visible.
    await h.streamer.onChunk('# Report\n\n- [ ] a\n\ntail.');
    await h.advance(500);
    await h.streamer.onChunk('# Report\n\n- [ ] a\n- [ ] b\n- [ ] c\n\ntail.');
    await h.advance(500);
    assert.ok(h.edits.length >= 1, 'the growth must produce an edit for this to mean anything');
    for (const e of h.edits) {
      assert.equal(typeof e.payload, 'object', 'every edit after the upgrade must stay rich');
    }
    const list = h.edits[h.edits.length - 1].payload.blocks.find((b) => b.type === 'list');
    assert.equal(list.items.length, 3, 'the completed items appended in place');
  });

  test('identical rich block trees do not re-trigger an edit (no-op guard)', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# same heading'); // structure already — opens rich
    await h.advance(500);
    await h.streamer.onChunk('# same heading — grown'); // changed tree → rich edit #1
    await h.advance(500);
    const editCountAfterUpgrade = h.edits.length;
    assert.ok(editCountAfterUpgrade >= 1);
    await h.streamer.onChunk('# same heading — grown'); // identical latestText as last edit
    await h.advance(500);
    assert.equal(h.edits.length, editCountAfterUpgrade, 'no structural change → no extra edit');
  });
});

describe('streamer — the bubble OPENS rich', () => {
  // The preview used to stream PLAIN for the whole turn and convert to the
  // rich document in one jump at finalize — a table sat as literal Markdown
  // pipes for as long as the turn ran. A bubble whose first qualifying chunk
  // already renders as structure opens rich, and every later flush appends
  // completed blocks to a document that was rich from its first frame.
  const OPEN_BODY = '# Report\n\n- [ ] one\n\nand prose after.';

  test('the first qualifying chunk opens the bubble rich instead of sending plain text', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk(OPEN_BODY);
    const open = h.sent[0].payload;
    assert.equal(typeof open, 'object', 'the preview must not start life as plain text');
    assert.equal(open.rich, true);
    assert.equal(open.phase, 'open');
    assert.equal(open.sourceText, OPEN_BODY);
    assert.ok(open.blocks.some((b) => b.type === 'heading'));
    assert.ok(h.streamer.isRichMode);
  });

  test('the rich open seeds the dedup key, so an unchanged flush edits nothing', async () => {
    // Without the seed the next flush sees no rich state and re-sends the
    // very tree already on screen — and, worse, a flush that renders plain
    // would overwrite the rich document with a plain edit.
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk(OPEN_BODY);
    await h.advance(500);
    await h.streamer.onChunk(OPEN_BODY);
    await h.advance(500);
    assert.deepEqual(h.edits, [], 'nothing changed shape — nothing to edit');
    assert.ok(h.streamer.isRichMode);
    assert.ok(h.streamer.currentRichBlocks.some((b) => b.type === 'heading'));
  });

  test('a bubble that opens rich never fires the plain→rich upgrade event', async () => {
    let upgrades = 0;
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      onRichUpgrade: () => { upgrades++; },
    });
    await h.streamer.onChunk(OPEN_BODY);
    await h.advance(500);
    await h.streamer.onChunk('# Report\n\n- [ ] one\n- [x] two\n\nand prose after.');
    await h.advance(500);
    await h.streamer.finalize('# Report\n\n- [ ] one\n- [x] two');
    assert.equal(upgrades, 0,
      'there was no plain shape to flip; counting this turns the metric into noise');
  });

  test('a send that downgrades the rich open leaves the streamer PLAIN', async () => {
    // The capability latch can trip on this very first call. Believing the
    // bubble is rich would have the next flush edit a plain message with a
    // payload it thinks is already on screen.
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      sendReturns: (id) => ({ message_id: id, wentRich: false }),
    });
    await h.streamer.onChunk(OPEN_BODY);
    assert.equal(h.streamer.isRichMode, false);
    assert.equal(h.streamer.currentText, OPEN_BODY);
  });

  test('after a downgraded open, the first rich edit IS a genuine upgrade', async () => {
    let upgrades = 0;
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      onRichUpgrade: () => { upgrades++; },
      sendReturns: (id) => ({ message_id: id, wentRich: false }),
    });
    await h.streamer.onChunk(OPEN_BODY);
    await h.advance(500);
    await h.streamer.onChunk('# Report\n\n- [ ] one\n- [x] two\n\nand prose after.');
    await h.advance(500);
    assert.equal(upgrades, 1, 'this bubble really did change shape');
    assert.equal(typeof h.edits[h.edits.length - 1].payload, 'object');
  });

  test('the rich open carries the plain bubble a downgrading caller has to send instead', async () => {
    // A refused rich open falls back to a plain send, and the plain path has
    // the SMALLER cap — so it needs the truncated text, not the rich source
    // it could not deliver.
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, maxLen: 60, richMaxLen: 32768 });
    const body = `# Report\n\n${'x'.repeat(500)}\n\nand prose after.`;
    await h.streamer.onChunk(body);
    const open = h.sent[0].payload;
    assert.equal(open.sourceText, body, 'rich content is never char-truncated');
    assert.equal(open.plainText.length, 60);
    assert.ok(open.plainText.endsWith('...'));
  });

  test('a first chunk past the RICH cap opens plain, truncated to the plain cap', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, maxLen: 4096, richMaxLen: 1000 });
    await h.streamer.onChunk(`# Report\n\n${'x'.repeat(5000)}\n\ntail.`);
    assert.equal(typeof h.sent[0].payload, 'string');
    assert.equal(h.sent[0].payload.length, 4096);
    assert.equal(h.streamer.isRichMode, false);
  });

  test('a rich-opened bubble finalizes in place — one bubble, same id', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    const body = '# Report\n\n- [ ] one\n- [x] two';
    await h.streamer.onChunk(OPEN_BODY);
    await h.advance(500);
    const result = await h.streamer.finalize(body);
    assert.equal(result.streamed, true);
    assert.equal(result.finalEditOk, true);
    assert.equal(result.overflow, false);
    assert.equal(result.msgId, h.sent[0].id);
    assert.equal(h.sent.length, 1, 'the opened bubble IS the reply');
  });
});

describe('streamer — rich streaming edge cases (mock toRichPayload)', () => {
  test('content past richMaxLen is NOT sent as rich mid-stream (falls back to plain)', async () => {
    const bigButRich = () => ({ usedRich: true, blocks: [{ type: 'paragraph', text: 'x'.repeat(40000) }] });
    const h = makeHarness({ toRichPayload: bigButRich, richMaxLen: 32768 });
    await h.streamer.onChunk('x'.repeat(100)); // initial plain send
    await h.advance(500);
    await h.streamer.onChunk('x'.repeat(40000)); // grown past richMaxLen
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.ok(last, 'expected at least one edit');
    assert.equal(typeof last.payload, 'string', 'over richMaxLen must not attempt a rich edit');
  });

  test('toRichPayload throwing falls back to the plain path without crashing', async () => {
    const throwing = () => { throw new Error('boom'); };
    const h = makeHarness({ toRichPayload: throwing });
    await h.streamer.onChunk('some content that would normally be checked for richness');
    await h.advance(500);
    await h.streamer.onChunk('some content that would normally be checked for richness, now grown');
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.ok(last, 'expected at least one edit');
    assert.equal(typeof last.payload, 'string');
  });

  test('toRichPayload returning usedRich:false stays on the plain path', async () => {
    const neverRich = () => ({ usedRich: false, blocks: [] });
    const h = makeHarness({ toRichPayload: neverRich });
    await h.streamer.onChunk('anything');
    await h.advance(500);
    await h.streamer.onChunk('anything grown');
    await h.advance(500);
    const last = h.edits[h.edits.length - 1];
    assert.ok(last, 'expected at least one edit');
    assert.equal(typeof last.payload, 'string');
  });

  test('forceNewMessage resets rich mode — the next bubble starts plain', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk('# Heading triggers rich'); // initial plain send
    await h.advance(500);
    await h.streamer.onChunk('# Heading triggers rich — grown'); // first edit upgrades to rich
    await h.advance(500);
    assert.ok(h.streamer.isRichMode);
    h.streamer.forceNewMessage();
    assert.equal(h.streamer.isRichMode, false);
  });

  test('two back-to-back turns do not share rich state', async () => {
    let upgrades = 0;
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onRichUpgrade: () => { upgrades++; } });

    // Turn 1: goes rich.
    await h.streamer.onChunk(PLAIN_OPENER); // initial send, plain
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH); // upgrade to rich
    await h.advance(500);
    assert.ok(h.streamer.isRichMode, 'turn 1 should be rich');
    assert.equal(upgrades, 1);
    const editsAfterTurn1 = h.edits.length;

    h.streamer.forceNewMessage(); // new bubble for turn 2 (same streamer instance)
    assert.equal(h.streamer.isRichMode, false, 'turn 2 starts plain, not inheriting turn 1');

    // Turn 2: IDENTICAL content to turn 1's final rich state. If
    // currentRichJson leaked across turns, the no-op guard (json ===
    // currentRichJson) would wrongly suppress this edit.
    await h.streamer.onChunk(PLAIN_OPENER); // initial send for the NEW bubble
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH); // same content as turn 1
    await h.advance(500);

    assert.ok(h.streamer.isRichMode, 'turn 2 should independently reach rich mode');
    assert.equal(upgrades, 2, 'onRichUpgrade must fire again for the new bubble, not stay at 1');
    assert.ok(h.edits.length > editsAfterTurn1, 'turn 2 must produce its own edit, not be suppressed as a false no-op');
  });

  test('many onChunk calls within one throttle window collapse to a single rich edit', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk(PLAIN_OPENER); // initial send
    await h.advance(500);
    const editsBefore = h.edits.length;
    // Simulate token-by-token streaming: many onChunk calls with NO
    // advance() between them — the debounce (pendingEdit guard) should
    // collapse them to one flush when the throttle window is finally
    // advanced, not one edit per chunk.
    const growing = RICH_GROWTH;
    for (let i = 1; i <= growing.length; i++) {
      await h.streamer.onChunk(growing.slice(0, i));
    }
    await h.advance(500);
    const editsAfter = h.edits.length;
    assert.equal(editsAfter - editsBefore, 1, 'many chunks in one throttle window must collapse to exactly one edit');
    assert.equal(typeof h.edits[h.edits.length - 1].payload, 'object', 'the single collapsed edit should reflect the final (rich) state');
  });

  test('a thrown rich edit is retried by finalize when the block tree is unchanged', async () => {
    let attempts = 0;
    // Structure only once a heading appears, so the bubble opens plain and
    // the first rich payload reaches Telegram as the EDIT this test is about.
    const renderRich = (text) => (text.startsWith('#')
      ? { usedRich: true, blocks: [{ type: 'heading', text, size: 1 }] }
      : null);
    const h = makeHarness({
      toRichPayload: renderRich,
      editReturns: () => {
        attempts++;
        if (attempts === 1) throw new Error('ETIMEDOUT');
        return { result: { message_id: 1 }, wentRich: true };
      },
    });
    const body = '# Final report';
    await h.streamer.onChunk('Draft in progress');
    await h.streamer.onChunk(body);
    await h.advance(500);

    assert.equal(h.streamer.isRichMode, false, 'a failed edit must not be recorded as delivered');
    const result = await h.streamer.finalize(body);
    assert.equal(result.finalEditOk, true);
    assert.equal(h.edits.length, 2, 'finalize must retry the payload that failed during streaming');
  });

  test('a thrown plain edit is retried by finalize when the text is unchanged', async () => {
    let attempts = 0;
    const h = makeHarness({
      toRichPayload: () => null,
      editReturns: () => {
        attempts++;
        if (attempts === 1) throw new Error('ETIMEDOUT');
        return undefined;
      },
    });
    const body = 'plain final text';
    await h.streamer.onChunk('plain draft');
    await h.streamer.onChunk(body);
    await h.advance(500);

    const result = await h.streamer.finalize(body);
    assert.equal(result.finalEditOk, true);
    assert.equal(h.edits.length, 2, 'finalize must retry text that was never accepted');
  });

  test('turning rich text off changes an already-rich bubble back to plain', async () => {
    let enabled = true;
    const toRichPayload = (text) => enabled
      ? { usedRich: true, blocks: [{ type: 'heading', text, size: 1 }] }
      : null;
    const h = makeHarness({ toRichPayload });
    await h.streamer.onChunk('# Draft');
    await h.streamer.onChunk('# Rich report');
    await h.advance(500);
    assert.equal(h.streamer.isRichMode, true);

    enabled = false;
    await h.streamer.onChunk('# Plain report');
    await h.advance(500);
    assert.equal(typeof h.edits.at(-1).payload, 'string');
    assert.equal(h.streamer.isRichMode, false, 'the delivery tracker must match the plain bubble on screen');
  });

  test('a rich-editor plain fallback clears earlier rich state and the latch applies immediately', async () => {
    let latched = false;
    let richAttempts = 0;
    const toRichPayload = (text) => latched
      ? null
      : { usedRich: true, blocks: [{ type: 'heading', text, size: 1 }] };
    const h = makeHarness({
      toRichPayload,
      editReturns: (_msgId, payload) => {
        if (typeof payload === 'string') return undefined;
        richAttempts++;
        if (richAttempts === 1) return { result: { message_id: 1 }, wentRich: true };
        latched = true;
        return { result: { message_id: 1 }, wentRich: false };
      },
    });
    await h.streamer.onChunk('# Draft');
    await h.streamer.onChunk('# Rich report');
    await h.advance(500);
    await h.streamer.onChunk('# Falls back to plain');
    await h.advance(500);
    assert.equal(h.streamer.isRichMode, false, 'a successful plain fallback replaces the earlier rich payload');

    await h.streamer.onChunk('# Stays plain');
    await h.advance(500);
    assert.equal(richAttempts, 2, 'the capability latch must suppress later rich attempts in the same turn');
    assert.equal(typeof h.edits.at(-1).payload, 'string');
    assert.equal(h.streamer.isRichMode, false);
  });

  test('edits are serialized so an older rich edit cannot land after newer plain text', async () => {
    let enabled = true;
    let releaseFirst;
    let editCalls = 0;
    const firstEdit = new Promise((resolve) => { releaseFirst = resolve; });
    const h = makeHarness({
      toRichPayload: (text) => enabled
        ? { usedRich: true, blocks: [{ type: 'heading', text, size: 1 }] }
        : null,
      editReturns: () => {
        editCalls++;
        return editCalls === 1 ? firstEdit : undefined;
      },
    });
    await h.streamer.onChunk('# Draft');
    await h.streamer.onChunk('# Slow rich edit');
    const firstFlush = h.advance(500);
    await Promise.resolve();

    enabled = false;
    await h.streamer.onChunk('# Newer plain edit');
    const secondFlush = h.advance(500);
    await Promise.resolve();
    const callsBeforeRelease = h.edits.length;

    releaseFirst({ result: { message_id: 1 }, wentRich: true });
    await Promise.all([firstFlush, secondFlush]);
    assert.equal(callsBeforeRelease, 1, 'the plain edit must wait for the in-flight rich edit');
    assert.equal(h.edits.length, 2);
    assert.equal(typeof h.edits[1].payload, 'string');
    assert.equal(h.streamer.isRichMode, false);
  });

  test('an edit from a superseded bubble cannot overwrite the new bubble state', async () => {
    let releaseEdit;
    const pendingEdit = new Promise((resolve) => { releaseEdit = resolve; });
    const h = makeHarness({
      // Heading-only structure, so the second bubble's prose opens plain —
      // which is the state the superseded edit must not overwrite.
      toRichPayload: (text) => (text.startsWith('#')
        ? { usedRich: true, blocks: [{ type: 'heading', text, size: 1 }] }
        : null),
      editReturns: () => pendingEdit,
    });
    await h.streamer.onChunk('# First draft');
    await h.streamer.onChunk('# Slow first bubble');
    const oldFlush = h.advance(500);
    await Promise.resolve();

    h.streamer.forceNewMessage();
    await h.streamer.onChunk('Second bubble is plain so far');
    assert.equal(h.streamer.isRichMode, false);

    releaseEdit({ result: { message_id: 1 }, wentRich: true });
    await oldFlush;
    assert.equal(h.streamer.currentText, 'Second bubble is plain so far');
    assert.equal(h.streamer.isRichMode, false, 'the completed old edit belongs to the superseded bubble');
  });
});

describe('streamer — rich finalization limits', () => {
  test('a mid-size rich reply (over plain 4096 cap, under rich 32768 cap) finalizes RICH, not overflow', async () => {
    // A structured body between the plain and rich limits must use the
    // larger rich-message cap.
    const midSize = '# Report\n\n' + 'x'.repeat(6000);
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, maxLen: 4096, richMaxLen: 32768 });
    await h.streamer.onChunk(midSize);
    await h.advance(500);
    const result = await h.streamer.finalize(midSize);
    assert.equal(result.overflow, false, 'must NOT overflow against the plain 4096 cap');
    assert.equal(result.finalEditOk, true);
    const last = h.edits[h.edits.length - 1];
    assert.equal(typeof last.payload, 'object');
  });

  test('a reply exceeding even the RICH 32768 cap still overflows (discard + redeliver plain)', async () => {
    const huge = '# Report\n\n' + 'x'.repeat(40000);
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, richMaxLen: 32768 });
    await h.streamer.onChunk(huge.slice(0, 100)); // go live with something small first
    await h.advance(500);
    const result = await h.streamer.finalize(huge);
    assert.equal(result.overflow, true);
    assert.equal(result.finalEditOk, false);
  });

  test('rich overflow still resolves accepted photos for discard-redelivery rescue', async () => {
    const rescueEntry = {
      kind: 'photo',
      media: { source: '/validated/overflow.png', fingerprint: 'fp' },
      caption: 'Overflow result',
    };
    let finalResolutionCalls = 0;
    const toRichPayload = (text, opts) => {
      const payload = toTelegramRichBlocks(text, opts);
      if (!opts.partial) {
        finalResolutionCalls += 1;
        payload.rescueEntries = [rescueEntry];
      }
      return payload;
    };
    const body = `# Report\n\n${'x'.repeat(5000)}\n\n![Overflow result](/validated/overflow.png)`;
    const h = makeHarness({ toRichPayload, richMaxLen: 1000 });
    await h.streamer.onChunk('# Report');
    await h.advance(500);

    const result = await h.streamer.finalize(body);

    assert.equal(result.overflow, true);
    assert.equal(finalResolutionCalls, 1, 'final overflow must run one partial:false resolution pass');
    assert.deepEqual(result.rescueEntries, [rescueEntry]);
    assert.equal(h.edits.some((call) => call.payload?.rich), false,
      'overflow resolution collects accepted media but must not attempt a rich edit');
  });

  test('plain content overflows against the plain 4096 cap', async () => {
    const longPlain = 'plain prose, no structure. '.repeat(200); // no rich trigger
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, maxLen: 4096 });
    await h.streamer.onChunk(longPlain.slice(0, 50));
    await h.advance(500);
    const result = await h.streamer.finalize(longPlain);
    assert.equal(result.overflow, true);
  });

  test('a short rich reply finalizes with no extra edit when already matching (no-op)', async () => {
    const short = '- [ ] one task';
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks });
    await h.streamer.onChunk(short); // the first chunk is already structure — opens rich
    await h.advance(500);
    await h.streamer.onChunk(short); // unchanged — nothing to edit
    await h.advance(500);
    const editCountBeforeFinalize = h.edits.length;
    assert.ok(h.streamer.isRichMode, 'the bubble must already be in rich mode before this assertion is meaningful');
    const result = await h.streamer.finalize(short); // same body — should be a no-op
    assert.equal(result.finalEditOk, true);
    assert.equal(h.edits.length, editCountBeforeFinalize, 'body already matches the last rich edit — no-op');
  });

  test('finalize on a never-live (short, under minChars) turn returns streamed:false regardless of richness', async () => {
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, richMaxLen: 32768 });
    // minChars defaults high enough in normal use; force idle by never calling onChunk.
    const result = await h.streamer.finalize('- [ ] never went live');
    assert.equal(result.streamed, false);
  });
});

describe('streamer — wentRich fallback contract', () => {
  // A rich edit that internally falls back to plain (lib/telegram/rich-
  // edit.js, capability/content error) RESOLVES normally — it doesn't
  // throw. wentRich distinguishes that result from a genuine rich send,
  // preventing a false upgrade event and stale rich-state no-ops.

  test('a fallback-to-plain flush does NOT fire onRichUpgrade', async () => {
    let upgrades = 0;
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      onRichUpgrade: () => { upgrades++; },
      editReturns: () => ({ result: { message_id: 1 }, wentRich: false }),
    });
    await h.streamer.onChunk(PLAIN_OPENER);
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH);
    await h.advance(500);
    assert.equal(upgrades, 0, 'onRichUpgrade must not fire for a bubble that actually rendered plain');
  });

  test('a fallback-to-plain flush does NOT mark the streamer as rich mode', async () => {
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      editReturns: () => ({ result: { message_id: 1 }, wentRich: false }),
    });
    await h.streamer.onChunk(PLAIN_OPENER);
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH);
    await h.advance(500);
    assert.equal(h.streamer.isRichMode, false, 'the bubble is actually plain — isRichMode must reflect that');
  });

  test('after a fallback, a later flush with identical content is retried', async () => {
    let editCalls = 0;
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      // First rich attempt falls back; every subsequent attempt succeeds
      // as genuinely rich (simulates a transient content-error that
      // clears, e.g. a one-off Telegram hiccup).
      editReturns: () => {
        editCalls++;
        return editCalls === 1
          ? { result: { message_id: 1 }, wentRich: false }
          : { result: { message_id: 1 }, wentRich: true };
      },
    });
    const body = RICH_GROWTH;
    await h.streamer.onChunk(PLAIN_OPENER);
    await h.advance(500);
    await h.streamer.onChunk(body); // 1st rich attempt -> falls back
    await h.advance(500);
    const editsAfterFallback = h.edits.length;
    assert.equal(h.streamer.isRichMode, false);

    // The fallback sent plain text, so identical rich content must not
    // be suppressed by the rich no-op guard.
    await h.streamer.onChunk(body + ' '); // trivial growth to guarantee a new onChunk is processed
    await h.streamer.onChunk(body); // back to the exact same content as the failed attempt
    await h.advance(500);
    assert.ok(h.edits.length > editsAfterFallback, 'a retry with the same content that previously fell back must still produce an edit, not be silently dropped');
    assert.ok(h.streamer.isRichMode, 'the retry succeeded as rich — state must reflect that now');
  });

  test('a genuine rich success (wentRich:true) still fires onRichUpgrade exactly once', async () => {
    let upgrades = 0;
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      onRichUpgrade: () => { upgrades++; },
      editReturns: () => ({ result: { message_id: 1 }, wentRich: true }),
    });
    await h.streamer.onChunk(PLAIN_OPENER);
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH);
    await h.advance(500);
    assert.equal(upgrades, 1);
    assert.ok(h.streamer.isRichMode);
  });

  test('a caller that does not participate in the contract (bare resolve, no wentRich field) is treated as success — backward compatible', async () => {
    // This is the shape every OTHER test in this file uses (editReturns
    // omitted -> edit() resolves undefined) — confirms that default
    // remains treated as rich success for simple test doubles.
    let upgrades = 0;
    const h = makeHarness({ toRichPayload: toTelegramRichBlocks, onRichUpgrade: () => { upgrades++; } });
    await h.streamer.onChunk(PLAIN_OPENER);
    await h.advance(500);
    await h.streamer.onChunk(RICH_GROWTH);
    await h.advance(500);
    assert.equal(upgrades, 1);
    assert.ok(h.streamer.isRichMode);
  });

  test('finalize: a fallback-to-plain still reports finalEditOk:true (content DID land, just plain)', async () => {
    const h = makeHarness({
      toRichPayload: toTelegramRichBlocks,
      editReturns: () => ({ result: { message_id: 1 }, wentRich: false }),
    });
    const body = RICH_GROWTH;
    await h.streamer.onChunk(body.slice(0, 5));
    await h.advance(500);
    const result = await h.streamer.finalize(body);
    assert.equal(result.finalEditOk, true, 'the fallback delivered the content — this is not a failure needing discard+redeliver');
    assert.equal(h.streamer.isRichMode, false, 'but the streamer must know the final bubble is actually plain');
  });
});

describe('streamer — media resolution across the streaming→finalize boundary', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createRichMediaResolver } = require('../lib/telegram/rich-media');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamer-media-'));
  const okPng = path.join(tmp, 'a.png');
  fs.writeFileSync(okPng, Buffer.alloc(64, 1));
  const resolver = createRichMediaResolver({ allowedRoots: [tmp] });
  const toRichPayload = (text, opts) => toTelegramRichBlocks(text, { ...opts, resolveMedia: resolver });

  test('finalize resolves media placeholders to envelope blocks; the dedup key differs from the streamed tick', async () => {
    const h = makeHarness({ toRichPayload });
    const body = `# Report\n\n![shot](${okPng})\n\ntail text here`;
    await h.streamer.onChunk('# Report');        // initial plain send
    await h.advance(500);
    await h.streamer.onChunk(body);              // streaming flush: partial:true → placeholder
    await h.advance(500);
    const mid = h.edits[h.edits.length - 1];
    assert.equal(typeof mid.payload, 'object');
    const midJson = JSON.stringify(mid.payload.blocks);
    assert.ok(!midJson.includes('"source"'), 'the resolver must not run during streaming (no envelope leak)');
    assert.ok(midJson.includes('📎'), 'the streamed tick shows a media placeholder, not an upload');

    const result = await h.streamer.finalize(body);
    assert.equal(result.finalEditOk, true);
    const final = h.edits[h.edits.length - 1];
    const photo = final.payload.blocks.find((b) => b.type === 'photo');
    assert.ok(photo, 'finalize must emit a real photo block');
    assert.equal(photo.photo.media.source, fs.realpathSync(okPng));
    assert.notEqual(JSON.stringify(final.payload.blocks), midJson,
      'finalize dedup key must differ from the placeholder tick, or the edit is suppressed as a no-op');
  });
});

describe('streamer — steered intermediate-bubble media seals', () => {
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function sealPayload(text, { partial }) {
    if (partial) {
      return {
        usedRich: true,
        blocks: [{ type: 'paragraph', text: `🖼 ${text}` }],
      };
    }
    const media = { source: `/validated/${text}.png`, fingerprint: `fp:${text}` };
    return {
      usedRich: true,
      blocks: [{ type: 'photo', photo: { type: 'photo', media } }],
      rescueEntries: [{ kind: 'photo', media, caption: text }],
    };
  }

  test('force boundary seals the old media placeholder without mutating the new bubble', async () => {
    const renderCalls = [];
    const h = makeHarness({
      toRichPayload: (text, opts) => {
        renderCalls.push({ text, ...opts });
        return sealPayload(text, opts);
      },
      sendReturns: (id, _text, index) => ({
        message_id: id,
        _hadReplyAnchor: index === 0,
      }),
    });

    await h.streamer.onChunk('bubble-a');
    await h.streamer.onChunk('bubble-a-media');
    await h.advance(500);
    const oldId = h.sent[0].id;
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');

    assert.equal(h.streamer.msgId, h.sent[1].id, 'the next bubble detaches synchronously');
    await h.streamer.drainSeals();

    const seal = h.edits.find((call) => call.payload?.phase === 'seal');
    assert.ok(seal, 'the force boundary must produce one seal edit');
    assert.equal(seal.msgId, oldId);
    assert.equal(seal.payload.sourceText, 'bubble-a-media');
    assert.equal(seal.payload.hadReplyAnchor, true);
    assert.ok(seal.payload.blocks.some((block) => block.type === 'photo'));
    assert.ok(renderCalls.some((call) => call.text === 'bubble-a-media' && call.partial === false));
    assert.equal(h.streamer.msgId, h.sent[1].id);
    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-b' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
  });

  test('force boundary skips a final tree with no accepted media', async () => {
    const h = makeHarness({
      toRichPayload: (text, { partial }) => ({
        usedRich: true,
        blocks: [{ type: 'paragraph', text: partial ? `🖼 ${text}` : text }],
        ...(!partial && { rescueEntries: [] }),
      }),
    });

    await h.streamer.onChunk('bubble-a');
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    await h.streamer.drainSeals();

    assert.equal(h.edits.some((call) => call.payload?.phase === 'seal'), false);
    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-b' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
  });

  test('seal waits for an old placeholder edit so it cannot overwrite materialized media', async () => {
    const oldEdit = deferred();
    let editCount = 0;
    const h = makeHarness({
      toRichPayload: sealPayload,
      editReturns: (_msgId, payload) => {
        editCount += 1;
        if (editCount === 1) return oldEdit.promise;
        return { result: { message_id: 1 }, wentRich: payload?.rich === true };
      },
    });

    await h.streamer.onChunk('bubble-a');
    await h.streamer.onChunk('bubble-a-media');
    const oldFlush = h.advance(500);
    await Promise.resolve();
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    await Promise.resolve();

    assert.equal(h.edits.length, 1, 'seal must remain behind the in-flight placeholder edit');
    oldEdit.resolve({ result: { message_id: 1 }, wentRich: true });
    await oldFlush;
    await h.streamer.drainSeals();

    assert.equal(h.edits.length, 2);
    assert.equal(h.edits[1].payload.phase, 'seal');
    assert.equal(h.edits[1].msgId, h.sent[0].id);
    assert.equal(h.streamer.msgId, h.sent[1].id);
    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-b' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
  });

  test('a pending initial send is sealed after its late message id arrives', async () => {
    const firstSend = deferred();
    const h = makeHarness({
      toRichPayload: sealPayload,
      sendReturns: (id, _text, index) => index === 0
        ? firstSend.promise
        : { message_id: id, _hadReplyAnchor: false },
    });

    const oldChunk = h.streamer.onChunk('bubble-a-media');
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    const activeId = h.streamer.msgId;

    firstSend.resolve({ message_id: h.sent[0].id, _hadReplyAnchor: true });
    await oldChunk;
    await h.streamer.drainSeals();

    const seal = h.edits.find((call) => call.payload?.phase === 'seal');
    assert.equal(seal.msgId, h.sent[0].id);
    assert.equal(seal.payload.hadReplyAnchor, true);
    assert.equal(h.streamer.msgId, activeId, 'late old send completion must not replace the active id');
    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-b' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
  });

  test('seal jobs drain in force-boundary order when the first seal is slow', async () => {
    const firstSeal = deferred();
    const sealSources = [];
    const h = makeHarness({
      toRichPayload: sealPayload,
      editReturns: (_msgId, payload) => {
        if (payload?.phase !== 'seal') return undefined;
        sealSources.push(payload.sourceText);
        return payload.sourceText === 'bubble-a' ? firstSeal.promise : undefined;
      },
    });

    await h.streamer.onChunk('bubble-a');
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    await Promise.resolve();
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-c');
    await Promise.resolve();

    assert.deepEqual(sealSources, ['bubble-a'], 'seal B must wait behind slow seal A');
    firstSeal.resolve({ result: { message_id: 1 }, wentRich: true });
    await h.streamer.drainSeals();
    assert.deepEqual(sealSources, ['bubble-a', 'bubble-b']);
    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-c' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
  });

  test('terse mode archives a late initial send and never seals it', async () => {
    const firstSend = deferred();
    const h = makeHarness({
      preserveIntermediateBubbles: false,
      toRichPayload: sealPayload,
      sendReturns: (id, _text, index) => index === 0
        ? firstSend.promise
        : { message_id: id },
    });

    const oldChunk = h.streamer.onChunk('bubble-a-media');
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    firstSend.resolve({ message_id: h.sent[0].id, _hadReplyAnchor: true });
    await oldChunk;
    await h.streamer.drainSeals();

    assert.deepEqual(h.streamer.getArchived(), [h.sent[0].id]);
    assert.equal(h.edits.some((call) => call.payload?.phase === 'seal'), false);
    assert.equal(h.streamer.msgId, h.sent[1].id);
  });

  test('seal failures are source-free, non-fatal, and drained by flushDraft', async () => {
    const errors = [];
    const h = makeHarness({
      toRichPayload: sealPayload,
      editReturns: (_msgId, payload) => {
        if (payload?.phase === 'seal') {
          throw new Error('failed for /validated/private-shot.png');
        }
        return undefined;
      },
      logger: {
        log: () => {},
        warn: () => {},
        error: (message) => errors.push(message),
      },
    });

    await h.streamer.onChunk('private-shot');
    h.streamer.forceNewMessage();
    await h.streamer.onChunk('bubble-b');
    await h.streamer.flushDraft();

    assert.deepEqual(h.streamer.currentRichBlocks, [{ type: 'paragraph', text: '🖼 bubble-b' }],
      'the new bubble opened rich and shows its own content, untouched by the seal');
    assert.equal(h.streamer.msgId, h.sent[1].id);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].includes('/validated/private-shot.png'), false);
  });

  test('finalize and discard wait for outstanding seals', async () => {
    for (const terminal of ['finalize', 'discard']) {
      const slowSeal = deferred();
      let terminalSettled = false;
      const h = makeHarness({
        toRichPayload: sealPayload,
        editReturns: (_msgId, payload) => payload?.phase === 'seal'
          ? slowSeal.promise
          : undefined,
      });
      await h.streamer.onChunk(`bubble-a-${terminal}`);
      h.streamer.forceNewMessage();
      await h.streamer.onChunk(`bubble-b-${terminal}`);
      await Promise.resolve();

      const terminalPromise = terminal === 'finalize'
        ? h.streamer.finalize(`bubble-b-${terminal}`)
        : h.streamer.discard();
      terminalPromise.then(() => { terminalSettled = true; });
      await Promise.resolve();
      assert.equal(terminalSettled, false, `${terminal} must wait for the seal chain`);

      slowSeal.resolve({ result: { message_id: 1 }, wentRich: true });
      await terminalPromise;
      assert.equal(terminalSettled, true);
    }
  });
});
