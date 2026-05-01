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
 * Spike strategy:
 *   - Use a STRING prompt (not AsyncIterable) so the SDK runs one
 *     turn and exits cleanly. We're testing the hook-return shape,
 *     not the long-lived input pattern.
 *   - Run two scenarios back-to-back: BASELINE ({continue: true})
 *     vs HOOK-STOP ({continue: false}).
 *   - Compare the result events.
 *
 * Hard wall-clock cap: 60s per scenario. process.exit on any
 * unexpected hang.
 *
 * Cost: ~$0.02 of sonnet/medium tokens (two short turns).
 *
 * Usage:
 *   node scripts/spikes/hookstop.mjs   # from polygram package root
 *
 * Output goes to stderr unbuffered so we see live progress.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

function log(...args) {
  // stderr is line-buffered to ttys and unbuffered to pipes by node;
  // for our SSH-piped runs this gives us live progress.
  process.stderr.write(args.join(' ') + '\n');
}

const TOOL_USING_PROMPT
  = 'Run `ls /tmp | head -2` and then `pwd`. After both tools, '
  + 'summarize what you saw in two sentences.';

async function runScenario({ continueValue, label }) {
  log(`\n=== ${label}: hook returns { continue: ${continueValue} } ===`);

  let hookFired = 0;
  const hookCallback = async () => {
    hookFired += 1;
    log(`  [hook] fired (count=${hookFired}); returning { continue: ${continueValue} }`);
    return { continue: continueValue };
  };

  const events = [];
  const t0 = Date.now();

  const q = query({
    prompt: TOOL_USING_PROMPT,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // rc.39 spike: explicitly load NO user/project/local settings.
      // Otherwise the SDK picks up the runner's ~/.claude/settings.json
      // which on shumabit has tool restrictions baked in — the model
      // refuses to use Bash and the spike emits 33 chars of "I can't"
      // without ever firing the hook. Empty array = pristine session.
      settingSources: [],
      // Only allow Bash so the prompt can do `ls` + `pwd`.
      allowedTools: ['Bash'],
      hooks: {
        PostToolBatch: [{ hooks: [hookCallback] }],
      },
      model: 'claude-sonnet-4-6',
    },
  });

  // Race against a hard 60s cap. AbortController would be cleaner
  // but we don't know if SDK Query honours signal — for the spike,
  // process.exit on cap is fine.
  const capTimer = setTimeout(() => {
    log(`!! ${label}: 60s cap hit — bailing out`);
    log(`!! events captured so far: ${events.length}`);
    log(JSON.stringify(events, null, 2));
    process.exit(2);
  }, 60_000);

  let resultMsg = null;
  let textCollected = '';
  let toolCount = 0;
  try {
    for await (const m of q) {
      const dt = Date.now() - t0;
      const slim = {
        dt,
        type: m.type,
        subtype: m.subtype,
        stop_reason: m.message?.stop_reason,
        terminal_reason: m.terminal_reason,
        is_error: m.is_error,
      };
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'text') {
            textCollected += (b.text || '');
            slim.text_chars = (b.text || '').length;
          }
          if (b.type === 'tool_use') {
            toolCount += 1;
            slim.tool_use = b.name;
          }
        }
      }
      if (m.type === 'result') {
        slim.result_text_len = (m.result || '').length;
        slim.cost_usd = m.total_cost_usd;
      }
      events.push(slim);
      log(`  +${dt}ms  ${m.type}` + (slim.subtype ? `:${slim.subtype}` : '')
        + (slim.stop_reason ? ` stop=${slim.stop_reason}` : '')
        + (slim.terminal_reason ? ` term=${slim.terminal_reason}` : '')
        + (slim.tool_use ? ` tool=${slim.tool_use}` : '')
        + (slim.text_chars ? ` text=${slim.text_chars}c` : ''));
      if (m.type === 'result') {
        resultMsg = m;
        break;  // exit the for-await on result
      }
    }
  } catch (err) {
    log(`!! ${label} iterator threw: ${err?.message || err}`);
  }
  clearTimeout(capTimer);

  const elapsed = Date.now() - t0;
  log(`  hook fired: ${hookFired} time(s)`);
  log(`  total elapsed: ${elapsed}ms`);
  log(`  result subtype: ${resultMsg?.subtype ?? '(NO RESULT)'}`);
  log(`  result terminal_reason: ${resultMsg?.terminal_reason ?? '(none)'}`);
  log(`  result is_error: ${resultMsg?.is_error}`);
  log(`  text emitted (chars): ${textCollected.length}`);
  log(`  tool_use count: ${toolCount}`);
  if (textCollected.length > 0 && textCollected.length < 500) {
    log(`  text content: ${JSON.stringify(textCollected)}`);
  }

  return {
    label,
    hookFired,
    elapsed,
    gotResult: !!resultMsg,
    resultSubtype: resultMsg?.subtype ?? null,
    resultTerminalReason: resultMsg?.terminal_reason ?? null,
    resultIsError: resultMsg?.is_error ?? null,
    resultTextLen: resultMsg?.result?.length ?? 0,
    streamedTextLen: textCollected.length,
    toolCount,
    eventCount: events.length,
  };
}

(async () => {
  const baseline = await runScenario({ continueValue: true, label: 'BASELINE' });
  const stopTest = await runScenario({ continueValue: false, label: 'HOOK-STOP' });

  log('\n=== U6 SUMMARY ===');
  log(JSON.stringify({ baseline, stopTest }, null, 2));

  const u6Pass = stopTest.gotResult
    && stopTest.hookFired >= 1;

  log('\nU6 verdict: ' + (u6Pass
    ? 'PASS — hook-stop produces a result event'
    : 'FAIL — fall back to userTurnInFlight + stop_reason=end_turn (option d-hybrid pure)'));
  if (u6Pass) {
    log(`  result subtype: ${stopTest.resultSubtype}`);
    log(`  terminal_reason: ${stopTest.resultTerminalReason ?? '(distinguish via subtype + is_error heuristic)'}`);
    log(`  is_error: ${stopTest.resultIsError}`);
    log(`  baseline-vs-stoptest: hook fired ${baseline.hookFired} vs ${stopTest.hookFired},  text chars ${baseline.streamedTextLen} vs ${stopTest.streamedTextLen}`);
  }
  process.exit(u6Pass ? 0 : 1);
})().catch((err) => {
  log('Spike threw at top level: ' + (err?.stack || err));
  process.exit(3);
});
