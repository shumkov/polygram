'use strict';

/**
 * What happens to a half-written preview when the turn ends.
 *
 * Two layers, because neither alone is enough:
 *
 *  1. An EXECUTABLE harness over the settler handleMessage actually uses. This
 *     is where the behavior is checked — delete the persist call, the
 *     redelivery escape, or the no-reply distinction and a test here fails.
 *  2. A source-level tripwire that every turn-completion exit routes through
 *     it. handleMessage closes over the bot, db, tg, reactor and codex
 *     controller and polygram.js runs main() on load, so there is no seam to
 *     drive the handler itself through; what a source check CAN hold is "no
 *     exit was added that forgets to settle", which is the bug class here
 *     (historically five exits, each with its own answer or none).
 *
 * The tripwire cannot prove the settlement works — that is layer 1's job — and
 * layer 1 cannot prove every exit calls it. Together they cover both.
 *
 * Run: node --test tests/polygram-streamer-exits.test.js
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createStreamer } = require('../lib/telegram/streamer');
const { createTurnSettler } = require('../lib/telegram/live-preview');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

// ─── layer 1: the settlement, executed ─────────────────────────────

function settlerHarness({ maxLen = 4096, enabled = true, redeliverOk = true } = {}) {
  const tg = { nextId: 500, sent: [], edits: [], deleted: [] };
  const rows = [];
  const events = [];
  const redelivered = [];
  const streamer = createStreamer({
    send: async (text) => {
      const message_id = tg.nextId++;
      tg.sent.push({ message_id, text });
      return { message_id };
    },
    edit: async (msgId, text) => {
      if (msgId == null) throw new Error('message_id required');
      tg.edits.push({ msgId, text });
    },
    deleteMessage: async (id) => { tg.deleted.push(id); },
    minChars: 5,
    throttleMs: 0,
    maxLen,
    logger: { error: () => {}, warn: () => {} },
  });
  const deliveredTexts = [];
  const settle = createTurnSettler({
    streamer,
    deliveredTexts,
    enabled,
    persistBubbleText: (chatId, msgId, text) => rows.push({ chatId, msgId, text }),
    redeliver: async (text) => { redelivered.push(text); return redeliverOk; },
    logEvent: (kind, detail) => events.push({ kind, detail }),
    chatId: '1',
    detail: { chat_id: '1' },
  });
  return { streamer, settle, deliveredTexts, tg, rows, events, redelivered };
}

describe('turn settlement (executed)', () => {
  test('an undelivered draft is delivered, and its transcript row follows', async () => {
    const h = settlerHarness();
    await h.streamer.onChunk('Everything the turn managed to write');

    const res = await h.settle();

    assert.equal(res.action, 'finalized');
    assert.deepEqual(h.tg.deleted, []);
    assert.deepEqual(h.rows, [
      { chatId: '1', msgId: 500, text: 'Everything the turn managed to write' },
    ]);
  });

  test('NO_REPLY deletes the draft — the one exit that must NOT deliver', async () => {
    const h = settlerHarness();
    await h.streamer.onChunk('Something the agent chose not to send');

    const res = await h.settle('no-reply');

    assert.equal(res.action, 'discarded');
    assert.deepEqual(h.tg.deleted, [500]);
    assert.deepEqual(h.rows, [], 'nothing was published, so no row to update');
  });

  test('a draft a reply already delivered is deleted, not repeated', async () => {
    const h = settlerHarness();
    h.deliveredTexts.push('The complete answer.');
    await h.streamer.onChunk('The complete answer.');

    const res = await h.settle();

    assert.equal(res.action, 'discarded');
    assert.deepEqual(h.tg.deleted, [500]);
  });

  test('an over-long draft is handed to the chunked path, whole', async () => {
    const h = settlerHarness({ maxLen: 50 });
    await h.streamer.onChunk('z'.repeat(300));

    const res = await h.settle();

    assert.equal(res.action, 'redelivered');
    assert.deepEqual(h.redelivered, ['z'.repeat(300)], 'the whole draft, not the truncation');
    assert.deepEqual(h.tg.deleted, [500]);
  });

  test('if that redelivery fails, the bubble stays — it is the only copy', async () => {
    const h = settlerHarness({ maxLen: 50, redeliverOk: false });
    await h.streamer.onChunk('z'.repeat(300));

    const res = await h.settle();

    assert.equal(res.action, 'finalize-failed');
    assert.deepEqual(h.tg.deleted, []);
  });

  test('nothing live: a no-op', async () => {
    const h = settlerHarness();
    const res = await h.settle();
    assert.equal(res.action, 'none');
    assert.deepEqual(h.tg.sent, []);
  });

  test('disabled for the chat: the preview is left exactly as the old code left it', async () => {
    // A chat without live previews has no `stream` tool, so nothing can be
    // holding a draft the pre-branch code would not have handled. Running the
    // new rule there would change settled behavior for chats that never asked.
    const h = settlerHarness({ enabled: false });
    await h.streamer.onChunk('a draft from the SDK stream path');

    const res = await h.settle();

    assert.equal(res.action, 'none');
    assert.deepEqual(h.tg.deleted, [], 'no new deletion behavior');
    assert.deepEqual(h.rows, [], 'no new row writes');
  });
});

// ─── layer 2: the tripwire ─────────────────────────────────────────

/** Source between an exit's anchor and the first `return;` after it. */
function exitBlock(anchor) {
  const start = SRC.indexOf(anchor);
  assert.notEqual(start, -1, `anchor not found in polygram.js: ${anchor}`);
  const end = SRC.indexOf('return;', start);
  assert.notEqual(end, -1, `no return after anchor: ${anchor}`);
  return SRC.slice(start, end);
}

const EXITS = [
  ["if (codexDispatchDecision === 'duplicate') {", 'codex duplicate dispatch'],
  ["if (['ambiguous', 'unavailable'].includes(codexDispatchDecision)) {", 'codex ambiguous/unavailable dispatch'],
  ['if (steered.autosteered) {', 'autosteer fold (streamer built before the steer decision)'],
  ["if (result.text === 'NO_REPLY') {", 'explicit agent silence'],
  ['if (!result.text) {', 'tool-only completion + empty-response fallback'],
  ['if (result.alreadyDelivered) {', 'CLI turn whose replies were delivered during the turn'],
];

describe('every turn-completion exit routes through the settler', () => {
  for (const [anchor, what] of EXITS) {
    test(`settles: ${what}`, () => {
      assert.match(
        exitBlock(anchor),
        /await finishStreamer\(/,
        `the "${what}" exit returns without settling the live preview — a half-written `
        + 'bubble would be stranded in the chat',
      );
    });
  }

  test('the NO_REPLY exit passes the reason that makes it discard', () => {
    assert.match(exitBlock("if (result.text === 'NO_REPLY') {"), /finishStreamer\('no-reply'\)/);
  });

  test('the success fall-through settles too (a solo sticker skips the finalize block)', () => {
    assert.ok(
      SRC.includes('await finishStreamer();\n    await mediaContext.flushPartialDeliveryWarning'),
      'the final success path must settle the preview before it returns',
    );
  });

  test('the error and abort exits settle through the rule when the turn delivered', () => {
    // finalize(null) publishes whatever the draft holds. On a turn that already
    // sent a reply that is the answer AGAIN — the duplicate the rule exists to
    // prevent. Only a turn that delivered nothing takes the direct finalize.
    const start = SRC.indexOf('const settleErrorExit = async (');
    assert.notEqual(start, -1, 'the error exits must share one settlement helper');
    const body = SRC.slice(start, start + 1400);
    assert.match(body, /deliveredTexts\.length > 0/);
    assert.match(body, /await finishStreamer\(\)/);
    assert.match(body, /streamer\.finalize\(null, errorSuffix/);
    assert.doesNotMatch(SRC, /streamer\.finalize\(''/, "'' blanks the bubble the user was reading");
  });

  test('no exit was quietly dropped', () => {
    const sites = SRC.match(/await finishStreamer\(/g) || [];
    assert.ok(
      sites.length >= EXITS.length + 1,
      `expected at least ${EXITS.length + 1} finishStreamer call sites, found ${sites.length}`,
    );
  });

  test('the settler is built from the shared rule, not reimplemented inline', () => {
    const start = SRC.indexOf('const finishStreamer = createTurnSettler({');
    assert.notEqual(start, -1, 'handleMessage must use the shared settler');
    const body = SRC.slice(start, start + 1200);
    assert.match(body, /enabled: streamPreviewEnabled/);
    assert.match(body, /persistBubbleText/);
    assert.match(body, /redeliver: async \(text\)/);
  });
});

// ─── default-off must be byte-identical ────────────────────────────

describe('a chat without live previews behaves as it did before the feature', () => {
  // The feature adds behavior in six places. Four are bug fixes that apply to
  // everyone (the streamer's initial-send race, finalize(null) semantics,
  // transcript-row truth, canned-string sanitizing on chunks). The other two
  // CHANGE behavior — the per-chat throttle scaling and the new settlement at
  // turn-completion exits — and must not touch a chat that never opted in.

  test('the throttle is passed through untouched when the feature is off', () => {
    const start = SRC.indexOf('throttleMs: streamPreviewEnabled');
    assert.notEqual(start, -1, 'the cadence must be gated on the feature');
    const body = SRC.slice(start, start + 500);
    assert.match(body, /: botCfg\.streamThrottleMs,/,
      'off → the configured value reaches the streamer unchanged, with no scaling');
    assert.match(body, /botCfg\.streamThrottleMs != null \? botCfg\.streamThrottleMs : DEFAULT_THROTTLE_MS/,
      'on → a configured 0 must still mean 0 (the streamer floors it), not the default');
  });

  test('a chat with the feature off registers no streamer at all', () => {
    // A registry entry would still be counted by every OTHER topic's throttle
    // scaling in the same chat.
    const start = SRC.indexOf('if (streamPreviewEnabled) {');
    assert.notEqual(start, -1);
    assert.match(SRC.slice(start, start + 400), /streamerRegistry\.register\(sessionKey/);
  });

  test('the settler is inert when the feature is off', async () => {
    const h = settlerHarness({ enabled: false });
    await h.streamer.onChunk('a draft the old code would have left alone');
    const before = { deleted: [...h.tg.deleted], rows: [...h.rows], events: [...h.events] };

    await h.settle();
    await h.settle('no-reply');

    assert.deepEqual(h.tg.deleted, before.deleted);
    assert.deepEqual(h.rows, before.rows);
    assert.deepEqual(h.events, before.events, 'not even an event fires for a chat that opted out');
  });
});
