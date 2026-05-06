/**
 * Tests for lib/stream-reply.js
 * Run: node --test tests/stream-reply.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/stream-reply');
const { extractAssistantText } = require('../lib/process-manager-sdk');

const silent = { error: () => {} };

function makeHarness({ minChars = 30, throttleMs = 500, deleteMessageImpl = null, editImpl = null, preserveIntermediateBubbles } = {}) {
  const sent = [];
  const edits = [];
  const deletes = [];
  let now = 0;
  const timers = [];

  const s = createStreamer({
    send: async (text) => {
      const id = 100 + sent.length;
      sent.push({ id, text });
      return { message_id: id };
    },
    edit: editImpl || (async (msgId, text) => {
      edits.push({ msgId, text });
    }),
    deleteMessage: deleteMessageImpl || (async (msgId) => {
      deletes.push(msgId);
    }),
    minChars,
    throttleMs,
    ...(preserveIntermediateBubbles !== undefined && { preserveIntermediateBubbles }),
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
    logger: silent,
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

  return { s, sent, edits, deletes, advance, timers, tick: (ms) => { now += ms; } };
}

describe('extractAssistantText', () => {
  test('pulls plain text from content blocks', () => {
    const out = extractAssistantText({
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    assert.equal(out, 'hello');
  });

  test('joins multiple text blocks with blank line', () => {
    const out = extractAssistantText({
      message: { content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ] },
    });
    assert.equal(out, 'one\n\ntwo');
  });

  test('skips tool_use blocks — they are noise to chat users', () => {
    const out = extractAssistantText({
      message: { content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    });
    assert.equal(out, 'checking');
  });

  test('tool_use-only events produce empty output', () => {
    const out = extractAssistantText({
      message: { content: [
        { type: 'tool_use', name: 'Bash' },
        { type: 'tool_use', name: 'Read' },
      ] },
    });
    assert.equal(out, '');
  });

  test('no content or malformed event returns empty', () => {
    assert.equal(extractAssistantText({}), '');
    assert.equal(extractAssistantText(null), '');
    assert.equal(extractAssistantText({ message: {} }), '');
  });

  test('trailing colon followed by invisible tool_use → ellipsis', () => {
    const out = extractAssistantText({
      message: { content: [
        { type: 'text', text: 'Checking this:' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    });
    assert.equal(out, 'Checking this…');
  });

  test('trailing colon + whitespace normalised', () => {
    assert.equal(
      extractAssistantText({ message: { content: [{ type: 'text', text: 'Doing this: \n' }] } }),
      'Doing this…',
    );
  });

  test('mid-sentence colons are untouched', () => {
    assert.equal(
      extractAssistantText({ message: { content: [{ type: 'text', text: "Here's the plan: step 1, step 2." }] } }),
      "Here's the plan: step 1, step 2.",
    );
  });

  test('double colon (code / emoticons) is preserved', () => {
    assert.equal(
      extractAssistantText({ message: { content: [{ type: 'text', text: 'use Foo::Bar::' }] } }),
      'use Foo::Bar::',
    );
  });

  test('normal endings (. ! ?) unchanged', () => {
    for (const s of ['Done.', 'Got it!', 'Ready?']) {
      assert.equal(
        extractAssistantText({ message: { content: [{ type: 'text', text: s }] } }),
        s,
      );
    }
  });
});

describe('streamer idle → live transition', () => {
  test('stays idle below threshold', async () => {
    const h = makeHarness({ minChars: 30 });
    await h.s.onChunk('short');
    assert.equal(h.s.state, 'idle');
    assert.equal(h.sent.length, 0);
  });

  test('crosses to live at threshold and sends initial message', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('hello world from claude');
    assert.equal(h.s.state, 'live');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].text, 'hello world from claude');
    assert.equal(h.s.msgId, 100);
  });
});

describe('streamer live edits are throttled', () => {
  test('first post-live chunk schedules a throttled edit', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 500 });
    await h.s.onChunk('first chunk of text');
    await h.s.onChunk('first chunk of text\n\nsecond chunk');
    assert.equal(h.edits.length, 0, 'edit not fired yet');
    await h.advance(600);
    assert.equal(h.edits.length, 1);
    assert.match(h.edits[0].text, /second chunk/);
  });

  test('rapid chunks coalesce into one edit per throttle window', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 500 });
    await h.s.onChunk('initial abc');
    await h.s.onChunk('initial abc + one');
    await h.s.onChunk('initial abc + two');
    await h.s.onChunk('initial abc + three');
    await h.advance(600);
    assert.equal(h.edits.length, 1);
    assert.match(h.edits[0].text, /three/);
  });
});

describe('streamer finalize', () => {
  test('no streaming happened: finalize reports streamed=false', async () => {
    const h = makeHarness({ minChars: 30 });
    await h.s.onChunk('tiny');
    const r = await h.s.finalize('tiny');
    assert.equal(r.streamed, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.edits.length, 0);
  });

  test('live: finalize performs last edit with final text', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 500 });
    await h.s.onChunk('first chunk streaming');
    const r = await h.s.finalize('the complete final answer here');
    assert.equal(r.streamed, true);
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].text, 'the complete final answer here');
  });

  test('finalize cancels a pending throttled edit', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 500 });
    await h.s.onChunk('first chunk streaming');
    await h.s.onChunk('first chunk streaming plus more');
    // Don't advance — finalize should fire the last edit itself.
    const r = await h.s.finalize('FINAL ANSWER');
    assert.equal(r.streamed, true);
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].text, 'FINAL ANSWER');
  });

  test('errorSuffix appends warning to final edit', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('some partial answer here');
    await h.s.finalize('partial answer so far', { errorSuffix: 'stream interrupted' });
    assert.match(h.edits[h.edits.length - 1].text, /stream interrupted/);
  });

  test('truncates to maxLen on send and edit', async () => {
    const h = makeHarness({ minChars: 10 });
    const big = 'x'.repeat(5000);
    await h.s.onChunk(big);
    assert.equal(h.sent[0].text.length, 4096);
    assert.ok(h.sent[0].text.endsWith('...'));
  });

  test('finalize is idempotent', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('content that crosses threshold');
    const r1 = await h.s.finalize('final');
    const r2 = await h.s.finalize('final');
    assert.equal(r1.streamed, true);
    assert.equal(r2.streamed, false, 'second finalize is a no-op');
  });
});

// ─── 0.7.0: rich finalize result + new methods ─────────────────────

describe('streamer finalize — finalEditOk / overflow signals (0.7.0)', () => {
  test('idle → finalize: streamed=false, finalEditOk=false, overflow=false', async () => {
    const h = makeHarness({ minChars: 100 });
    await h.s.onChunk('short');  // below minChars
    const r = await h.s.finalize('still short');
    assert.equal(r.streamed, false);
    assert.equal(r.finalEditOk, false);
    assert.equal(r.overflow, false);
  });

  test('live → finalize fits: finalEditOk=true, overflow=false', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('streaming start text here');
    const r = await h.s.finalize('the complete final answer here');
    assert.equal(r.streamed, true);
    assert.equal(r.finalEditOk, true);
    assert.equal(r.overflow, false);
    assert.equal(r.finalText, 'the complete final answer here');
  });

  test('live → finalize body > maxLen: streamed=true, finalEditOk=false, overflow=true', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('initial streamed text');
    // Caller passes the FULL final text; if it exceeds maxLen, finalize
    // signals overflow back so caller can discard + redeliver.
    const huge = 'x'.repeat(5000);
    const r = await h.s.finalize(huge);
    assert.equal(r.streamed, true);
    assert.equal(r.finalEditOk, false);
    assert.equal(r.overflow, true);
    assert.equal(r.finalText, huge);
    // Critical: NO edit was attempted — leaves the bubble in its
    // last-streamed state so the caller can discard cleanly.
    // (One initial send, NO edits.)
    assert.equal(h.edits.length, 0);
  });

  test('live → finalize edit fails: finalEditOk=false, overflow=false', async () => {
    let editCallCount = 0;
    const h = makeHarness({
      minChars: 10,
      editImpl: async () => {
        editCallCount += 1;
        throw new Error("Bad Request: can't parse entities: x");
      },
    });
    await h.s.onChunk('initial streamed text');
    const r = await h.s.finalize('the final answer');
    assert.equal(r.streamed, true);
    assert.equal(r.finalEditOk, false);
    assert.equal(r.overflow, false);
    // Edit was attempted (and failed).
    assert.equal(editCallCount, 1);
  });

  test('live → finalize body matches currentText: finalEditOk=true with no edit call', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('exact same content');
    // Pass the SAME text — no edit needed.
    const r = await h.s.finalize('exact same content');
    assert.equal(r.streamed, true);
    assert.equal(r.finalEditOk, true);
    // No edit because content is unchanged.
    assert.equal(h.edits.length, 0);
  });
});

describe('streamer.discard()', () => {
  test('deletes the bubble and transitions to finalized', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('streaming content');
    assert.equal(h.s.state, 'live');
    assert.ok(h.s.msgId != null);
    const r = await h.s.discard();
    assert.equal(r.deleted, true);
    assert.equal(r.msgId, 100);
    assert.equal(h.s.state, 'finalized');
    assert.equal(h.s.msgId, null);
    assert.deepEqual(h.deletes, [100]);
  });

  test('idle → discard: no-op (no bubble to delete)', async () => {
    const h = makeHarness({ minChars: 100 });
    const r = await h.s.discard();
    // State was idle (never went live). No deletion to perform.
    assert.equal(h.deletes.length, 0);
  });

  test('discard cancels pending edit timer', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 1000 });
    await h.s.onChunk('first chunk live');
    await h.s.onChunk('first chunk live plus more');  // schedules a delayed edit
    assert.equal(h.timers.length, 1);
    await h.s.discard();
    assert.equal(h.timers.length, 0, 'pending edit should be cancelled');
  });

  test('deleteMessage failure is non-fatal — discard still finalizes', async () => {
    const h = makeHarness({
      minChars: 10,
      deleteMessageImpl: async () => {
        throw new Error('message to delete not found');
      },
    });
    await h.s.onChunk('streaming content');
    const r = await h.s.discard();
    assert.equal(r.deleted, false);
    // Still transitioned to finalized; caller should redeliver
    // independently of whether the bubble actually went away.
    assert.equal(h.s.state, 'finalized');
  });

  test('subsequent finalize after discard returns streamed=false', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('streaming');
    await h.s.discard();
    const r = await h.s.finalize('whatever');
    assert.equal(r.streamed, false);
  });
});

describe('streamer.forceNewMessage()', () => {
  test('next onChunk creates a new bubble', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('first turn content');
    assert.equal(h.s.msgId, 100);
    h.s.forceNewMessage();
    assert.equal(h.s.state, 'idle');
    assert.equal(h.s.msgId, null);
    await h.s.onChunk('second turn content');
    // Second send fires; new message_id assigned.
    assert.equal(h.sent.length, 2);
    assert.equal(h.s.msgId, 101);
  });

  test('forceNewMessage cancels pending edit but does NOT delete the old bubble', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 1000 });
    await h.s.onChunk('first chunk live');
    await h.s.onChunk('first chunk live plus more');
    h.s.forceNewMessage();
    // No delete called — old bubble stays intact for caller to manage.
    assert.equal(h.deletes.length, 0);
    assert.equal(h.timers.length, 0);
  });

  test('forceNewMessage from idle is a no-op', async () => {
    const h = makeHarness({ minChars: 100 });
    h.s.forceNewMessage();
    assert.equal(h.s.state, 'idle');
    assert.equal(h.sent.length, 0);
  });
});

describe('streamer.flushDraft()', () => {
  test('drains pending edit before returning', async () => {
    const h = makeHarness({ minChars: 10, throttleMs: 1000 });
    await h.s.onChunk('first chunk live');
    await h.s.onChunk('first chunk live plus more');
    assert.equal(h.timers.length, 1);
    assert.equal(h.edits.length, 0);
    await h.s.flushDraft();
    assert.equal(h.timers.length, 0);
    assert.equal(h.edits.length, 1, 'pending edit fired during flushDraft');
  });

  test('no-op when nothing pending', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('content here');
    await h.s.flushDraft();  // nothing scheduled
    assert.equal(h.edits.length, 0);
  });
});

describe('streamer.archive()', () => {
  test('returns current msgId snapshot', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('streaming content');
    const snap = h.s.archive();
    assert.equal(snap.msgId, 100);
    assert.match(snap.currentText, /streaming/);
  });

  test('idle archive returns null msgId', async () => {
    const h = makeHarness({ minChars: 100 });
    const snap = h.s.archive();
    assert.equal(snap.msgId, null);
  });
});

// 0.7.2: forceNewMessage tracks superseded bubbles for end-of-turn cleanup
describe('streamer.getArchived() — rc.44 preserveIntermediateBubbles default true', () => {
  // rc.44: preserve intermediate "thinking out loud" bubbles by default.
  // Pre-rc.44 (0.7.2 → rc.43) forceNewMessage pushed the live bubble's
  // msgId onto archived[] so polygram could delete it at turn-end —
  // resulting in only the final answer's bubble being visible. Users
  // wanted the full reasoning trail visible (Ivan DM 2026-05-01).
  // The DEFAULT now preserves; opt-in to old behaviour with
  // preserveIntermediateBubbles: false.

  test('initial state: archived is empty', () => {
    const h = makeHarness({ minChars: 10 });
    assert.deepEqual(h.s.getArchived(), []);
  });

  test('forceNewMessage does NOT archive by default (rc.44 preserve)', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('first message text streaming');
    assert.equal(h.s.msgId, 100);
    h.s.forceNewMessage();
    assert.deepEqual(h.s.getArchived(), [],
      'rc.44 default: previous bubble preserved, not archived');
  });

  test('multiple forceNewMessage calls leave archived empty by default', async () => {
    const h = makeHarness({ minChars: 10 });
    await h.s.onChunk('first message text streaming');
    h.s.forceNewMessage();
    await h.s.onChunk('second message text streaming');
    h.s.forceNewMessage();
    await h.s.onChunk('third message text streaming');
    assert.deepEqual(h.s.getArchived(), []);
  });

  test('forceNewMessage from idle is a no-op (no bubble to track)', () => {
    const h = makeHarness({ minChars: 100 });
    h.s.forceNewMessage();
    assert.deepEqual(h.s.getArchived(), []);
  });

  test('getArchived returns a copy (caller can mutate without affecting internal state)', async () => {
    const h = makeHarness({ minChars: 10, preserveIntermediateBubbles: false });
    await h.s.onChunk('first message text streaming');
    h.s.forceNewMessage();
    const snap1 = h.s.getArchived();
    snap1.push(999);
    const snap2 = h.s.getArchived();
    assert.deepEqual(snap2, [100]);
  });
});

describe('streamer.getArchived() — rc.44 preserveIntermediateBubbles=false (opt-out)', () => {
  // Verifies the pre-rc.44 / 0.7.2 behaviour is still available
  // for chats / bots that prefer the "only final answer visible"
  // partner-facing UX.

  test('forceNewMessage pushes msgId to archived when preserve=false', async () => {
    const h = makeHarness({ minChars: 10, preserveIntermediateBubbles: false });
    await h.s.onChunk('first message text streaming');
    assert.equal(h.s.msgId, 100);
    h.s.forceNewMessage();
    assert.deepEqual(h.s.getArchived(), [100]);
  });

  test('multiple forceNewMessage calls accumulate when preserve=false', async () => {
    const h = makeHarness({ minChars: 10, preserveIntermediateBubbles: false });
    await h.s.onChunk('first message text streaming');
    h.s.forceNewMessage();
    await h.s.onChunk('second message text streaming');
    h.s.forceNewMessage();
    await h.s.onChunk('third message text streaming');
    assert.deepEqual(h.s.getArchived(), [100, 101]);
  });

  test('forceNewMessage from idle does NOT push even with preserve=false', () => {
    const h = makeHarness({ minChars: 100, preserveIntermediateBubbles: false });
    h.s.forceNewMessage();
    assert.deepEqual(h.s.getArchived(), []);
  });

  test('preserve=true (explicit) matches the default: empty archived', async () => {
    const h = makeHarness({ minChars: 10, preserveIntermediateBubbles: true });
    await h.s.onChunk('first message text streaming');
    h.s.forceNewMessage();
    assert.deepEqual(h.s.getArchived(), []);
  });
});

// rc.67: transformText option pre-processes every chunk BEFORE the
// streamer commits it via send/edit. polygram passes
// stripInlineTags(...) so [sticker:NAME] / [react:EMOJI] never reach the
// bubble or the messages.text DB row, removing the leak path observed at
// msg 205 (Shumabit@UMI :24, 2026-05-05 11:30) where finalize's no-op
// branch left a streamed bubble with the literal tag visible.
describe('createStreamer — transformText option (rc.67)', () => {
  function makeHarnessWithTransform({ transformText, minChars = 10 } = {}) {
    const sent = [];
    const edits = [];
    let now = 0;
    const timers = [];

    const s = createStreamer({
      send: async (text) => {
        const id = 100 + sent.length;
        sent.push({ id, text });
        return { message_id: id };
      },
      edit: async (msgId, text) => { edits.push({ msgId, text }); },
      minChars,
      throttleMs: 500,
      transformText,
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
      logger: silent,
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

    return { s, sent, edits, advance };
  }

  test('initial send receives transformed text — bubble never sees raw tag', async () => {
    const h = makeHarnessWithTransform({
      transformText: (t) => t.replace(/\[sticker:working\]/g, '').trim(),
    });
    await h.s.onChunk('On it — adding ฿ prefix, rebuilding, uploading. [sticker:working]');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].text, 'On it — adding ฿ prefix, rebuilding, uploading.');
    assert.doesNotMatch(h.sent[0].text, /\[sticker:/);
  });

  test('subsequent edits receive transformed text', async () => {
    const h = makeHarnessWithTransform({
      transformText: (t) => t.replace(/\[react:[^\]]+\]/g, '').trim(),
    });
    await h.s.onChunk('Working on it');
    await h.s.onChunk('Working on it — almost done [react:👍]');
    await h.advance(1000);
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].text, 'Working on it — almost done');
    assert.doesNotMatch(h.edits[0].text, /\[react:/);
  });

  test('finalize body is transformed too — currentText match becomes a no-op', async () => {
    // The leak scenario: agent emits the WHOLE reply in one chunk with a
    // tag at the end. Without transformText the streamer sends raw text,
    // and finalize's body-vs-currentText comparison is the wrong axis (it
    // compares cleaned-vs-raw which differs even though the user already
    // sees raw). With transformText, both sides are clean, finalize takes
    // the no-op branch CORRECTLY because the bubble truly is final.
    const stripTags = (t) => t.replace(/\[sticker:working\]/g, '').trim();
    const h = makeHarnessWithTransform({ transformText: stripTags, minChars: 1 });
    await h.s.onChunk('Done [sticker:working]');
    const fin = await h.s.finalize('Done');
    assert.equal(fin.streamed, true);
    assert.equal(fin.finalEditOk, true);
    assert.equal(h.edits.length, 0);
    assert.equal(h.sent[0].text, 'Done');
  });

  test('finalize transforms its finalText argument too (defense in depth)', async () => {
    // If a caller accidentally passes raw text to finalize (regression in
    // polygram.js), transformText still scrubs it before the edit. This
    // is the belt-and-suspenders guarantee: even with one site forgetting
    // to strip, the bubble stays clean.
    const stripTags = (t) => t.replace(/\[sticker:working\]/g, '').trim();
    const h = makeHarnessWithTransform({ transformText: stripTags });
    await h.s.onChunk('Done [sticker:working] streaming text long enough');
    const fin = await h.s.finalize('Done [sticker:working] final body');
    assert.equal(fin.streamed, true);
    assert.doesNotMatch(fin.finalText, /\[sticker:/);
    if (h.edits.length > 0) {
      assert.doesNotMatch(h.edits[h.edits.length - 1].text, /\[sticker:/);
    }
  });

  test('omitting transformText defaults to identity — back-compat', async () => {
    const h = makeHarnessWithTransform({});
    await h.s.onChunk('Plain text without any tags');
    assert.equal(h.sent[0].text, 'Plain text without any tags');
  });

  test('transformText returning empty under minChars keeps streamer idle', async () => {
    // If the entire chunk was just a tag, transformed text is empty.
    // Streamer should NOT send a blank bubble — it stays idle. Caller
    // (polygram.js) handles the empty-text-only-sticker case via the
    // non-streamed path with parsed.stickers.
    const h = makeHarnessWithTransform({
      minChars: 10,
      transformText: (t) => t.replace(/\[sticker:working\]/g, '').trim(),
    });
    await h.s.onChunk('[sticker:working]');
    assert.equal(h.sent.length, 0, 'streamer sent a bubble for empty transformed text');
    assert.equal(h.s.state, 'idle');
  });

  test('transformText is applied on each onChunk — no double-strip drift', async () => {
    let calls = 0;
    const stripTags = (t) => {
      calls += 1;
      return t.replace(/\[sticker:working\]/g, '').trim();
    };
    const h = makeHarnessWithTransform({ transformText: stripTags });
    await h.s.onChunk('First chunk text long enough');
    await h.s.onChunk('First chunk text long enough plus [sticker:working] more');
    await h.advance(1000);
    assert.ok(calls >= 2, 'transformText should run on each onChunk');
    if (h.edits.length > 0) {
      assert.doesNotMatch(h.edits[h.edits.length - 1].text, /\[sticker:/);
    }
  });

  test('msg 205 reproduction — full flow', async () => {
    const stickerMap = { working: 'CAACAgIAAxkBAAEworking' };
    const { stripInlineTags } = require('../lib/parse-response');
    const h = makeHarnessWithTransform({
      transformText: (t) => stripInlineTags(t, { stickerMap }),
    });
    const raw = 'On it — adding ฿ prefix, rebuilding, uploading, and sending. [sticker:working]';
    await h.s.onChunk(raw);
    assert.equal(h.sent.length, 1);
    assert.doesNotMatch(h.sent[0].text, /\[sticker:/);
    assert.equal(
      h.sent[0].text,
      'On it — adding ฿ prefix, rebuilding, uploading, and sending.',
    );
    const fin = await h.s.finalize(
      'On it — adding ฿ prefix, rebuilding, uploading, and sending.',
    );
    assert.equal(fin.finalEditOk, true);
    assert.equal(h.edits.length, 0);
  });

  test('[react:👍] gdocs reply — full flow, no edit needed at finalize', async () => {
    const { stripInlineTags } = require('../lib/parse-response');
    const h = makeHarnessWithTransform({
      transformText: (t) => stripInlineTags(t, { stickerMap: {} }),
    });
    const raw = 'Done. The main addition is a Safe Rewrite Workflow section.\n\n[react:👍]';
    await h.s.onChunk(raw);
    assert.doesNotMatch(h.sent[0].text, /\[react:/);
    const fin = await h.s.finalize(
      'Done. The main addition is a Safe Rewrite Workflow section.',
    );
    assert.equal(fin.finalEditOk, true);
    assert.equal(h.edits.length, 0);
  });
});
