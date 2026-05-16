'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

/**
 * rc.10 structural test — pins the reactor-clear-AFTER-delivery
 * ordering invariant in polygram.js's success path.
 *
 * Why a structural test: handleMessage in polygram.js has too many
 * closure-captured deps (bot, db, tg, reactor factories, streamer,
 * autosteeredRefs, ...) to mock for a true unit test. The bug Ivan
 * caught manually on 2026-05-15 was an ORDERING bug — clears fired
 * BEFORE delivery, so visually:
 *
 *   🤔/✍ visible during turn  →  reactions cleared (~JSONL result)
 *     →  1-3s of nothing       →  reply bubble lands
 *
 * rc.10 moved the clears to AFTER deliverReplies completes. This
 * test reads the source file and asserts that the success-path
 * (the `} else { ` branch around the post-turn reactor.clear() and
 * clearAutosteeredReactions() calls) puts both clears AFTER the
 * deliverReplies / streamer.finalize await sites.
 *
 * If a future refactor moves the clears back to the top of the
 * success branch, this test fires with a pointer to the regression.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const POLYGRAM_PATH = path.join(__dirname, '..', 'polygram.js');

function readHandleMessageSection() {
  // polygram.js is large; grab the success branch around the turn
  // completion. We anchor on the `try {` ... `await sendInlineStickers`
  // success-path slice. The clears MUST be inside this region.
  const src = fs.readFileSync(POLYGRAM_PATH, 'utf8');
  return src;
}

describe('polygram.js success-path ordering (rc.10)', () => {
  function findLineOf(src, needle, occurrence = 1) {
    const lines = src.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        count++;
        if (count === occurrence) return i + 1; // 1-indexed
      }
    }
    return -1;
  }

  test('reactor.clear() appears AFTER deliverReplies in the success path', () => {
    const src = readHandleMessageSection();
    // The success-path's `await deliverReplies` is the second (or
    // later) occurrence in handleMessage. The first is in the
    // streamer overflow path; the second is in the chunked-fallback
    // path. Either way, both come BEFORE the rc.10-deferred clears.
    // Find the LAST `await deliverReplies` in handleMessage — that's
    // the latest delivery point in the success path.
    const deliverLines = [];
    src.split('\n').forEach((line, i) => {
      if (line.includes('await deliverReplies')) deliverLines.push(i + 1);
    });
    assert.ok(deliverLines.length >= 1,
      'must find at least one `await deliverReplies` in handleMessage');
    const lastDeliverLine = deliverLines[deliverLines.length - 1];

    // The rc.10-deferred reactor.clear() is anchored by the marker
    // comment "rc.10: clear progress reactions AFTER..."
    const rc10MarkerLine = findLineOf(src, 'rc.10: clear progress reactions AFTER');
    assert.ok(rc10MarkerLine > 0,
      'rc.10 marker comment must exist — pins the deferred-clear location');

    assert.ok(rc10MarkerLine > lastDeliverLine,
      `rc.10 invariant: the deferred reactor.clear() block (line ${rc10MarkerLine}) must come AFTER the last \`await deliverReplies\` (line ${lastDeliverLine}). Otherwise the 🤔 / ✍ reactions disappear before the reply bubble lands and the user sees a silent gap (regression Ivan caught 2026-05-15).`);

    // Also assert no `reactor.clear()` call appears in the success
    // branch's TOP (right after the JSONL result event arrives,
    // before the streamer/deliverReplies awaits). The original
    // pre-rc.10 code put them at the very top of the `} else {`
    // success branch ~line 1086-1094; that region MUST now contain
    // only the rc.10 explanatory comment, NOT the inline clears.
    const successBranchRe = /else\s*\{[^}]*?rc\.10: reactor\.clear/m;
    assert.match(src, successBranchRe,
      'success branch should start with the rc.10 comment block (not the old inline clears) — verifies the pre-rc.10 inline clears were actually removed');
    // Also verify no `reactor.clear()` is the FIRST statement after the success-branch open
    const earlyClear = /else\s*\{\s*\n\s*reactor\.clear\(\)/m;
    assert.doesNotMatch(src, earlyClear,
      'reactor.clear() must NOT be the first statement of the success branch (that\'s the rc.10 regression shape — clear fires before delivery)');
  });

  test('clearAutosteeredReactions(sessionKey) is paired with the deferred reactor.clear() and appears after delivery', () => {
    const src = readHandleMessageSection();
    const deliverLines = [];
    src.split('\n').forEach((line, i) => {
      if (line.includes('await deliverReplies')) deliverLines.push(i + 1);
    });
    const lastDeliverLine = deliverLines[deliverLines.length - 1];
    // The deferred clearAutosteeredReactions has the rc.9-caveat
    // comment right above it. Anchor on that.
    const caveatLine = findLineOf(src, 'rc.9 caveat: TmuxProcess.extra-turn-started');
    assert.ok(caveatLine > 0, 'rc.9 caveat comment for deferred clearAutosteeredReactions must exist');
    assert.ok(caveatLine > lastDeliverLine,
      `clearAutosteeredReactions block (line ${caveatLine}) must come AFTER the last deliverReplies (line ${lastDeliverLine})`);
  });

  test('the success-path markReplied() comes AFTER the deferred reactor.clear()', () => {
    const src = readHandleMessageSection();
    const rc10MarkerLine = findLineOf(src, 'rc.10: clear progress reactions AFTER');
    // The markReplied() call that ends the success path is the one
    // that follows the rc.10 deferred clears. Find any markReplied
    // call AFTER the rc.10 marker.
    let endOfSuccessMarkRepliedLine = -1;
    const lines = src.split('\n');
    for (let i = rc10MarkerLine; i < lines.length; i++) {
      if (lines[i].includes('markReplied();')) {
        endOfSuccessMarkRepliedLine = i + 1;
        break;
      }
    }
    assert.ok(endOfSuccessMarkRepliedLine > rc10MarkerLine,
      'success-path markReplied() must come AFTER the rc.10 deferred clears, finalising the inbound row\'s status as the very last side-effect');
  });
});
