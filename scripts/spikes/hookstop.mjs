/**
 * U6: PostToolBatch hook returning `{ continue: false }` —
 *     does it produce a clean force-end-turn primitive?
 *
 * Hypothesis (from docs/sdk-query-lifecycle-research.md):
 * returning `{ continue: false }` from a PostToolBatch hook may
 * produce a clean `result` event with `terminal_reason:
 * 'hook_stopped'`. If so, polygram's autosteer contract fix
 * (rc.39) gets a clean primitive: when `MAX_ABSORBED` is hit,
 * have the hook stop the current SDK turn cleanly, then send the
 * next user message as a fresh `pm.send`. No `interrupt()` risks,
 * no userTurnInFlight bookkeeping.
 *
 * What we measure:
 *   1. Does `result` fire after the hook returns `{ continue: false }`?
 *   2. What is `result.subtype` and `result.terminal_reason`?
 *   3. Is the assistant's mid-text emitted before the stop preserved?
 *   4. After the stop, can we still push another input via
 *      streamInput AsyncIterable (does the Query stay alive)?
 *   5. Comparison: same prompt with `{ continue: true }` baseline.
 *
 * Cost: ~$0.01 (two short sonnet/medium turns). Requires Anthropic
 * auth (ANTHROPIC_API_KEY or active claude login).
 *
 * Usage:
 *   node scripts/spikes/hookstop.mjs
 *
 * Output: structured PASS/FAIL/DEFER block. Pipe to a file if you
 * want to keep it.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const TOOL_USING_PROMPT
  = 'Run `ls /tmp | head -2` and then `pwd`. After both tools, '
  + 'summarize what you saw in two sentences.';

// Capture every SDK message we see, with timestamps.
function makeRecorder() {
  const events = [];
  return {
    events,
    record(msg) {
      const t = Date.now();
      // Strip large fields for log readability.
      const slim = {
        t,
        type: msg.type,
        subtype: msg.subtype,
        stop_reason: msg.message?.stop_reason,
        terminal_reason: msg.terminal_reason,
        session_id: msg.session_id,
        text_chars: 0,
        tool_uses: 0,
      };
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'text') slim.text_chars += (b.text || '').length;
          if (b.type === 'tool_use') slim.tool_uses += 1;
        }
      }
      events.push(slim);
    },
  };
}

async function runScenario({ continueValue, label }) {
  console.log(`\n=== ${label}: hook returns { continue: ${continueValue} } ===`);
  const rec = makeRecorder();

  let hookFired = 0;
  const hookCallback = async () => {
    hookFired += 1;
    if (continueValue === false) {
      // Returning continue:false WITH a hookSpecificOutput is the
      // shape we want to test. Try it both with and without
      // additionalContext to see if the SDK behaves differently.
      return { continue: false };
    }
    return { continue: true };
  };

  // Use AsyncIterable input so the Query is "long-lived" — matches
  // polygram's pm-sdk usage. We push one user message, then wait
  // and see if we can push another after the result event lands.
  const inputController = (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: TOOL_USING_PROMPT },
      session_id: '',
      parent_tool_use_id: null,
    };
    // Pause indefinitely so the Query's input stream stays alive.
    // The for-await consumer will break out on result.
    await new Promise(() => {});
  })();

  const q = query({
    prompt: inputController,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: {
        PostToolBatch: [{ hooks: [hookCallback] }],
      },
      // Keep the run cheap.
      model: 'claude-sonnet-4-6',
    },
  });

  const t0 = Date.now();
  let resultMsg = null;
  let iteratorEnded = false;
  try {
    for await (const m of q) {
      rec.record(m);
      if (m.type === 'result') {
        resultMsg = m;
        // Don't break — observe whether the iterator naturally ends
        // OR keeps yielding. Some SDKs emit follow-up events post-
        // result (compaction notes, etc.).
      }
      // Defensive cap — if for some reason we never get a result,
      // bail after 60s wall-clock.
      if (Date.now() - t0 > 60_000) {
        console.log('!! 60s wall-clock cap hit — bailing out');
        break;
      }
    }
    iteratorEnded = true;
  } catch (err) {
    console.log('!! Query iterator threw:', err?.message || err);
  }

  const elapsed = Date.now() - t0;
  console.log(`hook fired: ${hookFired} time(s)`);
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`iterator ended: ${iteratorEnded}`);
  console.log(`result subtype: ${resultMsg?.subtype ?? '(no result emitted)'}`);
  console.log(`result.terminal_reason: ${resultMsg?.terminal_reason ?? '(none)'}`);
  console.log(`result.is_error: ${resultMsg?.is_error}`);
  console.log(`event count: ${rec.events.length}`);
  console.log('events (slim):');
  for (const ev of rec.events) {
    const dt = ev.t - t0;
    const bits = [
      `+${dt}ms`,
      ev.type,
      ev.subtype && `(${ev.subtype})`,
      ev.stop_reason && `stop_reason=${ev.stop_reason}`,
      ev.terminal_reason && `terminal_reason=${ev.terminal_reason}`,
      ev.text_chars && `${ev.text_chars} text-chars`,
      ev.tool_uses && `${ev.tool_uses} tool_use`,
    ].filter(Boolean);
    console.log(`  ${bits.join(' ')}`);
  }

  // Try interacting with the Query after result — can we push a new input?
  let postResultPushOk = null;
  if (resultMsg) {
    // Note: with our generator above we can't actually push more
    // (the generator is paused indefinitely). The real polygram
    // usage uses an inputController with a push() method. We test
    // that pattern in a second scenario if needed; here we just
    // observe whether the iterator yields anything else.
    postResultPushOk = 'NOT-TESTED (generator-paused-indefinitely)';
  }

  // Verdict for THIS scenario.
  const verdict = {
    label,
    hookFired,
    elapsed,
    iteratorEnded,
    gotResult: !!resultMsg,
    resultSubtype: resultMsg?.subtype ?? null,
    resultTerminalReason: resultMsg?.terminal_reason ?? null,
    resultIsError: resultMsg?.is_error ?? null,
    eventCount: rec.events.length,
  };
  return verdict;
}

(async () => {
  const baseline = await runScenario({
    continueValue: true,
    label: 'BASELINE',
  });
  const stopTest = await runScenario({
    continueValue: false,
    label: 'HOOK-STOP',
  });

  console.log('\n=== U6 SUMMARY ===');
  console.log(JSON.stringify({ baseline, stopTest }, null, 2));

  // Pass criteria for U6:
  //   1. The hook-stop scenario emits a `result` event (not just iterator end).
  //   2. The result has a clearly identifiable terminal_reason — ideally
  //      'hook_stopped' but ANY non-error subtype/terminal_reason is workable
  //      as long as it's distinguishable from interrupt/error/timeout.
  //   3. The hook fired ≥ 1 time (otherwise we didn't actually exercise it).
  //   4. The Query iterator ended cleanly (no thrown error).
  const u6Pass = stopTest.gotResult
    && stopTest.hookFired >= 1
    && stopTest.iteratorEnded
    && !stopTest.resultIsError;

  console.log('\nU6 verdict:', u6Pass ? 'PASS — hook-stop is a viable force-end-turn primitive' : 'FAIL — fall back to userTurnInFlight + stop_reason=end_turn detection (option d-hybrid pure)');
  console.log('Recommended terminal_reason check:', stopTest.resultTerminalReason ?? '(none — distinguish via subtype/heuristic)');
  process.exit(u6Pass ? 0 : 1);
})().catch((err) => {
  console.error('Spike threw at top level:', err);
  process.exit(2);
});
