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

describe('Bug 2 — every streamed-reply success exit clears the reactor', () => {
  // Production incident 2026-05-18: a primary turn with folded
  // autosteers completed (result_subtype:success, error:null — DB
  // confirmed) and the combined reply WAS delivered, but the
  // primary's reactor stayed stuck at 🥱 STALL — no `reactor-state …
  // clear` event ever fired.
  //
  // Root cause: handleMessage's streamed-reply success branches
  // (streamer.finalize() finalEditOk, and the streamed-redeliver
  // overflow/edit-failed branch) each end with `markReplied(); return;`
  // — returning BEFORE the rc.10 deferred `reactor.clear()` at the
  // bottom of the handler. A turn that streamed its reply therefore
  // NEVER cleared the reactor. Normally a streaming turn keeps
  // calling setState (re-arming STALL so it never fires); this turn
  // went quiet mid-turn (background-shell hunting) → STALL fired at
  // 45s → then the streamed-final return skipped the clear.
  // `reactor.stop()` in the finally only kills timers — it does NOT
  // remove the visible emoji.
  //
  // The fix: each streamed-success early-return must clear the
  // reactor (and autosteered ✍) before returning, mirroring the
  // rc.10 deferred-clear block. Structural test — handleMessage is
  // not unit-testable (too many closure-captured deps); we read the
  // source and assert every streamed-success `return` is preceded by
  // a `reactor.clear()` since the branch's `sendInlineReactions()`.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'polygram.js'), 'utf8');
  const lines = src.split('\n');

  // The streamed-reply success branches each end with this trailing
  // pair. Find every `markReplied();` immediately followed by
  // `return;` that is inside the streamed block (after a
  // `streamer.finalize` / `streamer.discard` site).
  function streamedSuccessReturns() {
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*markReplied\(\);\s*$/.test(lines[i])) continue;
      if (!/^\s*return;\s*$/.test(lines[i + 1] || '')) continue;
      // Is this a STREAMED-branch return? The streamed branches log a
      // "| streamed" / "streamed-redeliver" console line just above.
      const ctx = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (/streamed/.test(ctx)) out.push(i + 1); // 1-indexed
    }
    return out;
  }

  test('the streamed-finalize and streamed-redeliver branches both exist', () => {
    const returns = streamedSuccessReturns();
    assert.ok(returns.length >= 2,
      `expected >=2 streamed-success early returns (finalEditOk + `
      + `streamed-redeliver), found ${returns.length}`);
  });

  test('each streamed-success early return is preceded by reactor.clear()', () => {
    const returns = streamedSuccessReturns();
    for (const lineNo of returns) {
      // Walk back from the `markReplied();` line to the branch's
      // `sendInlineReactions()` call (the common tail of every
      // streamed-success branch) and require a `reactor.clear()`
      // somewhere between them.
      let start = -1;
      for (let i = lineNo - 1; i >= 0 && i > lineNo - 30; i -= 1) {
        if (/sendInlineReactions\(\)/.test(lines[i])) { start = i; break; }
      }
      assert.ok(start >= 0,
        `streamed-success return at line ${lineNo} should have a `
        + `sendInlineReactions() in its tail`);
      const block = lines.slice(start, lineNo).join('\n');
      assert.match(block, /reactor\.clear\(\)/,
        `Bug 2: the streamed-success branch ending at line ${lineNo} `
        + `MUST call reactor.clear() before its markReplied(); return; — `
        + `otherwise a turn that streamed its reply leaves the reactor `
        + `stuck (the 2026-05-18 STALL incident).`);
      assert.match(block, /clearAutosteeredReactions\(/,
        `Bug 2: the streamed-success branch ending at line ${lineNo} `
        + `must also clear autosteered ✍ reactions before returning, `
        + `mirroring the rc.10 deferred-clear block.`);
    }
  });
});

describe('non-streamed completion drains media and bubble cleanup', () => {
  const src = readHandleMessageSection();
  const start = src.indexOf('// Not streamed (response too short');
  const end = src.indexOf('  } catch (err) {', start);
  const tail = src.slice(start, end);

  test('a short final segment flushes failures recorded by intermediate seals', () => {
    assert.match(tail, /await mediaContext\.flushPartialDeliveryWarning\(outMetaBase\)/,
      'the common completion tail must surface seal failures even when the final bubble never streamed');
    assert.match(tail, /if \(!mediaContext\.deliveryIncomplete\)\s*\{\s*reactor\.clear\(\)/,
      'the common tail must preserve the error reaction after an incomplete seal delivery');
  });

  test('a short final segment still deletes terse-mode archived bubbles', () => {
    assert.match(tail, /await cleanupArchivedBubbles\(\)/,
      'late archived IDs are drained before finalize returns streamed:false and must be cleaned up');
  });
});
