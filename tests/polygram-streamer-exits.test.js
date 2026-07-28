'use strict';

/**
 * Structural test: every turn-completion exit in handleMessage settles the live
 * preview through the shared helper.
 *
 * Why structural rather than behavioral: handleMessage closes over the bot,
 * db, tg, reactor and streamer factories, the codex controller, and a dozen
 * other runtime deps — there is no seam to drive it through end to end. But the
 * property at stake is exactly the kind a source-level check can hold: the bug
 * class here is an exit that returns without settling, leaving a half-written
 * bubble stranded in the chat forever. Historically there were five such exits
 * and each had invented its own answer (or none).
 *
 * So this test asserts, per exit, that a `finishStreamer(...)` call appears
 * between the exit's own anchor and its `return` — and that the total number of
 * call sites hasn't shrunk, which is what catches a deletion.
 *
 * Run: node --test tests/polygram-streamer-exits.test.js
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

/** Source between an exit's anchor and the first `return;` after it. */
function exitBlock(anchor) {
  const start = SRC.indexOf(anchor);
  assert.notEqual(start, -1, `anchor not found in polygram.js: ${anchor}`);
  const end = SRC.indexOf('return;', start);
  assert.notEqual(end, -1, `no return after anchor: ${anchor}`);
  return SRC.slice(start, end);
}

// Anchor → what that exit is. Each is a distinct way a turn can be over.
const EXITS = [
  ["if (codexDispatchDecision === 'duplicate') {", 'codex duplicate dispatch'],
  ["if (['ambiguous', 'unavailable'].includes(codexDispatchDecision)) {", 'codex ambiguous/unavailable dispatch'],
  ['if (steered.autosteered) {', 'autosteer fold (streamer built before the steer decision)'],
  ["if (result.text === 'NO_REPLY') {", 'explicit agent silence'],
  ['if (!result.text) {', 'tool-only completion + empty-response fallback'],
  ['if (result.alreadyDelivered) {', 'CLI turn whose replies were delivered during the turn'],
];

describe('handleMessage turn-completion exits', () => {
  for (const [anchor, what] of EXITS) {
    test(`settles the preview: ${what}`, () => {
      assert.match(
        exitBlock(anchor),
        /await finishStreamer\(/,
        `the "${what}" exit returns without settling the live preview — a half-written `
        + 'bubble would be stranded in the chat',
      );
    });
  }

  test('the NO_REPLY exit is the one that discards rather than delivers', () => {
    // Every other exit delivers an undelivered draft. Explicit silence is the
    // single case where the draft is thrown away on purpose, so it must pass
    // the reason through — a bare finishStreamer() there would publish text the
    // agent decided not to send.
    assert.match(exitBlock("if (result.text === 'NO_REPLY') {"), /finishStreamer\('no-reply'\)/);
  });

  test('the success fall-through settles too (a solo sticker skips the finalize block)', () => {
    const idx = SRC.indexOf('await finishStreamer();\n    await mediaContext.flushPartialDeliveryWarning');
    assert.notEqual(idx, -1,
      'the final success path must settle the preview before it returns');
  });

  test('no exit was quietly dropped', () => {
    const sites = SRC.match(/await finishStreamer\(/g) || [];
    assert.ok(
      sites.length >= EXITS.length + 1,
      `expected at least ${EXITS.length + 1} finishStreamer call sites, found ${sites.length}`,
    );
  });

  test('the helper delegates to the shared rule rather than reimplementing it', () => {
    const start = SRC.indexOf('const finishStreamer = async (');
    assert.notEqual(start, -1);
    const body = SRC.slice(start, start + 900);
    assert.match(body, /reconcileStreamer\(streamer, deliveredTexts/);
    assert.match(body, /persistBubbleText\(/,
      'a finalized bubble must also bring its transcript row up to date');
  });

  test('error and abort paths keep the drafted body instead of blanking it', () => {
    // finalize('') REPLACED whatever had streamed with an empty bubble: the
    // user watched a partial answer appear, then get wiped by the very failure
    // that was supposed to leave it standing.
    assert.doesNotMatch(SRC, /streamer\.finalize\(''/);
    assert.match(SRC, /streamer\.finalize\(null\)\.catch/);
    assert.match(SRC, /streamer\.finalize\(null, errorSuffix/);
  });
});
