/**
 * Integration tests for the 0.7.0 streaming flow.
 *
 * These wire together:
 *   - createStreamer (lib/stream-reply.js) with finalize/discard
 *   - chunkMarkdownText (lib/telegram-chunk.js)
 *   - deliverReplies (lib/deliver.js)
 *
 * Without spinning up polygram.js (which requires DB + grammy + config).
 * They model the new handleMessage flow:
 *
 *   await streamer.flushDraft()
 *   const fin = await streamer.finalize(body)
 *   if (fin.finalEditOk) → preview is final, done.
 *   if (fin.overflow || !fin.finalEditOk) → discard + deliverReplies.
 *
 * Cases covered:
 *   - Short reply: finalEditOk:true, no follow-up sends.
 *   - Long reply: overflow:true, discard fires, all chunks delivered.
 *   - Edit fails (parse error): finalEditOk:false, discard + redeliver.
 *   - Discard fails (Telegram delete failure): redeliver still happens.
 *   - msg-10794 regression: 8.4KB body, multiple chunks, none mid-token.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamer } = require('../lib/telegram/streamer');
const { chunkMarkdownText } = require('../lib/telegram/chunk');
const { deliverReplies } = require('../lib/telegram/deliver');

const TG_MAX_LEN = 4096;

function silent() { return { log: () => {}, error: () => {}, warn: () => {} }; }

// Harness: streamer with mocked send/edit/deleteMessage tracking everything.
function makeIntegrationHarness({
  editFailsAtFinal = false,
  editFailsDuringStream = false,
  deleteFails = false,
} = {}) {
  const sent = [];
  const edits = [];
  const deletes = [];
  let nextId = 1000;
  let now = 0;
  const timers = [];

  // Streamer's send/edit
  const send = async (text) => {
    const id = nextId++;
    sent.push({ id, text });
    return { message_id: id };
  };
  const edit = async (msgId, text) => {
    edits.push({ msgId, text });
    if (editFailsDuringStream && edits.length === 1) {
      throw new Error("Bad Request: can't parse entities: dummy");
    }
    if (editFailsAtFinal && text.length > 30) {
      // Heuristic: the FINAL edit is the longest one
      throw new Error("Bad Request: can't parse entities: dummy");
    }
  };
  const deleteMessage = async (msgId) => {
    deletes.push(msgId);
    if (deleteFails) throw new Error('message to delete not found');
  };

  // deliverReplies's send (simulates tg() returning sequential msg_ids)
  const tgSend = async (bot, method, params) => {
    const id = nextId++;
    sent.push({ id, text: params.text, threadId: params.message_thread_id, replyTo: params.reply_parameters?.message_id });
    return { message_id: id };
  };

  const streamer = createStreamer({
    send, edit, deleteMessage,
    minChars: 30, throttleMs: 500, maxLen: TG_MAX_LEN,
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
    logger: silent(),
  });

  // Simulate the new handleMessage finalize path.
  async function finishTurn(body, { replyToMessageId = 99 } = {}) {
    await streamer.flushDraft();
    const fin = await streamer.finalize(body);
    if (!fin.streamed) {
      // Never went live — the polygram non-streamed path would call
      // deliverReplies with chunkMarkdownText(body).
      const chunks = chunkMarkdownText(body, TG_MAX_LEN);
      const r = await deliverReplies({
        send: tgSend, bot: {}, chatId: '1', chunks,
        replyToMessageId, logger: silent(),
      });
      return { fin, redelivered: true, sent: r.sent, failed: r.failed };
    }
    if (fin.finalEditOk) return { fin, redelivered: false };
    // Overflow OR edit failed — discard preview + redeliver.
    await streamer.discard();
    const chunks = chunkMarkdownText(body, TG_MAX_LEN);
    const r = await deliverReplies({
      send: tgSend, bot: {}, chatId: '1', chunks,
      replyToMessageId, logger: silent(),
    });
    return { fin, redelivered: true, sent: r.sent, failed: r.failed };
  }

  return {
    streamer, sent, edits, deletes, nextId, finishTurn,
    advance: (ms) => {
      now += ms;
      const due = timers.filter((t) => t.fireAt <= now);
      for (const t of due) {
        const i = timers.indexOf(t);
        if (i !== -1) timers.splice(i, 1);
        return t.fn();
      }
    },
  };
}

describe('streaming-integration: short reply (preview-becomes-final)', () => {
  test('short body: preview becomes the final reply, no extra sends', async () => {
    const h = makeIntegrationHarness();
    await h.streamer.onChunk('initial chunk crossed minChars');
    const body = 'the actual final answer here, fits in one bubble';
    const r = await h.finishTurn(body);
    assert.equal(r.fin.streamed, true);
    assert.equal(r.fin.finalEditOk, true);
    assert.equal(r.redelivered, false);
    // ONE sendMessage (the streamer's initial), one final edit.
    // No additional sends, no deletes.
    assert.equal(h.sent.length, 1);
    assert.equal(h.deletes.length, 0);
    // Final edit applied.
    const finalEdit = h.edits[h.edits.length - 1];
    assert.equal(finalEdit.text, body);
  });
});

describe('streaming-integration: long reply (overflow → discard + redeliver)', () => {
  test('body > maxLen: discard fires, deliverReplies sends all chunks', async () => {
    const h = makeIntegrationHarness();
    await h.streamer.onChunk('streaming partial content here');
    // Build a body bigger than maxLen.
    const body = ('long line ' + 'x'.repeat(80) + '\n').repeat(80);
    assert.ok(body.length > TG_MAX_LEN);
    const r = await h.finishTurn(body);
    assert.equal(r.fin.streamed, true);
    assert.equal(r.fin.overflow, true);
    assert.equal(r.fin.finalEditOk, false);
    assert.equal(r.redelivered, true);
    // Discard called.
    assert.equal(h.deletes.length, 1);
    // Multiple chunks delivered via deliverReplies.
    assert.ok(r.sent.length >= 2, 'expected multi-chunk redeliver, got ' + r.sent.length);
    assert.equal(r.failed.length, 0);
  });
});

describe('streaming-integration: edit fail (parse error) → discard + redeliver', () => {
  test('final edit fails: discard fires, deliverReplies sends body', async () => {
    const h = makeIntegrationHarness({ editFailsAtFinal: true });
    await h.streamer.onChunk('streaming partial content here');
    const body = 'short final reply that fits in a single bubble but final edit fails';
    const r = await h.finishTurn(body);
    assert.equal(r.fin.streamed, true);
    assert.equal(r.fin.finalEditOk, false);
    assert.equal(r.fin.overflow, false);
    // Discard called.
    assert.equal(h.deletes.length, 1);
    // Body delivered (single chunk since under maxLen).
    assert.ok(r.sent.length >= 1);
  });
});

describe('streaming-integration: discard fails (delete-message error)', () => {
  test('delete-message failure does not block redelivery', async () => {
    const h = makeIntegrationHarness({ editFailsAtFinal: true, deleteFails: true });
    await h.streamer.onChunk('streaming partial content here');
    const body = 'final body that needs redelivery';
    const r = await h.finishTurn(body);
    assert.equal(r.fin.finalEditOk, false);
    // Discard was attempted (deletes recorded but threw).
    assert.equal(h.deletes.length, 1);
    // Redeliver still ran.
    assert.ok(r.sent.length >= 1, 'redeliver should still happen');
  });
});

describe('streaming-integration: msg-10794 regression', () => {
  test('8.4KB markdown reply with bold markers chunks correctly without mid-token splits', async () => {
    const h = makeIntegrationHarness();
    await h.streamer.onChunk('Initial streaming preamble of the assistant response, growing as we go');
    // Build the body that triggered msg-10794: a long P&L-style reply
    // with many `**bold:**` markers.
    const body = [
      "Now I have everything I need. Here's the analysis:",
      '',
      '## Summary',
      '',
      '**Revenue:** strong | **Margin:** healthy | **Net:** negative',
      '',
    ];
    for (let s = 0; s < 35; s++) {
      body.push(`### Section ${s}`);
      body.push('');
      body.push('Lorem ipsum **bold marker** mid-text ' + 'word '.repeat(70));
      body.push('');
      body.push('- **Bullet bold:** content here padded out for length');
      body.push('- More **inline** bold and **another** marker plus extra');
      body.push('');
      body.push('**Total:** 30K + 14,400 + 5,000 = ~49,400 THB/month');
      body.push('');
    }
    const finalBody = body.join('\n');
    assert.ok(finalBody.length > 4 * TG_MAX_LEN, 'body must span multiple chunks');

    const r = await h.finishTurn(finalBody);
    assert.equal(r.fin.overflow, true, 'expected overflow path');
    // Discard fired.
    assert.equal(h.deletes.length, 1);
    // All chunks delivered, no failures.
    assert.equal(r.failed.length, 0);
    assert.ok(r.sent.length >= 2);

    // Critical: every delivered chunk must have BALANCED ** markers.
    // If any chunk has odd count, our markdown→HTML would generate
    // unmatched <b> / </b> tags — the bug that caused msg-10794.
    for (const s of h.sent) {
      const text = s.text;
      if (typeof text !== 'string' || !text.includes('**')) continue;
      const count = (text.match(/\*\*/g) || []).length;
      assert.equal(
        count % 2, 0,
        `chunk has unbalanced ** markers (${count}): ${text.slice(0, 100)}…`,
      );
    }

    // The first delivered chunk should have reply_parameters
    // (anchoring to the user's question), subsequent ones shouldn't.
    const tgSends = h.sent.filter((s) => s.replyTo != null || s.threadId != null || s.text.length > 50);
    // Find the FIRST tg-style send (post-discard).
    const tgSendsAll = h.sent.slice(1); // skip streamer's initial
    if (tgSendsAll.length > 0) {
      assert.equal(tgSendsAll[0].replyTo, 99, 'first redelivered chunk should reply_to user msg');
      for (let i = 1; i < tgSendsAll.length; i++) {
        assert.equal(tgSendsAll[i].replyTo, undefined, `chunk ${i+1} should NOT reply_to`);
      }
    }
  });
});

describe('streaming-integration: short non-streamed reply (under minChars)', () => {
  test('reply too short to stream: deliverReplies handles it directly', async () => {
    const h = makeIntegrationHarness();
    // No onChunk above minChars — streamer stays idle.
    const r = await h.finishTurn('tiny');
    assert.equal(r.fin.streamed, false);
    assert.equal(r.redelivered, true);
    // Single chunk delivered (the body is short).
    assert.equal(r.sent.length, 1);
    // No streamer sends, no edits, no deletes.
    assert.equal(h.edits.length, 0);
    assert.equal(h.deletes.length, 0);
  });
});
