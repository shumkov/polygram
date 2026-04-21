/**
 * Tests for lib/stream-reply.js
 * Run: node --test tests/stream-reply.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/stream-reply');
const { extractAssistantText } = require('../lib/process-manager');

const silent = { error: () => {} };

function makeHarness({ minChars = 30, throttleMs = 500 } = {}) {
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
    edit: async (msgId, text) => {
      edits.push({ msgId, text });
    },
    minChars,
    throttleMs,
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

  return { s, sent, edits, advance, timers, tick: (ms) => { now += ms; } };
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

  test('summarises tool_use blocks inline', () => {
    const out = extractAssistantText({
      message: { content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    });
    assert.match(out, /checking/);
    assert.match(out, /Calling `Bash`/);
  });

  test('no content or malformed event returns empty', () => {
    assert.equal(extractAssistantText({}), '');
    assert.equal(extractAssistantText(null), '');
    assert.equal(extractAssistantText({ message: {} }), '');
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
