/**
 * U7: Native SDK message queue via SDKUserMessage.priority — does
 *     pushing follow-ups directly onto streamInput work without our
 *     PostToolBatch + additionalContext detour?
 *
 * Background:
 *   Polygram's rc.9 autosteer was originally tried as
 *   `streamInput(SDKUserMessage{priority:'now', shouldQuery:false})`
 *   pushed onto the AsyncIterable mid-tool-use. The CLI binary's
 *   m87 gate rejected with `result.subtype = 'error_during_execution'`
 *   because the transcript shape (assistant ending in tool_use →
 *   next user message NOT being a tool_result) is malformed per
 *   Anthropic's API contract. We pivoted to PostToolBatch hook +
 *   additionalContext, which works.
 *
 *   But that test only covered priority='now'. The SDK type defines
 *   THREE values: 'now' | 'next' | 'later' (sdk.d.ts:3485). 'next'
 *   semantically means "queue for the next natural pause boundary"
 *   — exactly what we want. If the SDK handles this natively, we
 *   can DELETE autosteer-buffer.js, the PostToolBatch hook wiring,
 *   the rc.14 stale-drain helper, AND the upcoming MAX_ABSORBED
 *   cap, replacing all of it with a single
 *   `inputController.push(SDKUserMessage{priority:'next'})` call.
 *
 *   Claude Code itself uses native SDK queueing (per GitHub issue
 *   #49373 — queued messages flush at next LLM pause), so the
 *   behaviour is production-tested by Anthropic.
 *
 * Spike strategy:
 *   - Construct an AsyncIterable input controller we can push to
 *     mid-turn (the polygram-shaped pattern).
 *   - Send an initial tool-using prompt that takes a few seconds.
 *   - During the FIRST tool call, push a follow-up user message
 *     with priority='next' (and 'later' in a second run).
 *   - Observe: does it inject? When? With what shape?
 *   - Verify: does the agent actually incorporate the follow-up
 *     into its reply? (If yes: the queue mechanism works.)
 *
 * Also cover:
 *   - Default priority (no priority set): does it queue? FIFO?
 *     Or trigger m87?
 *   - shouldQuery=false: append-without-querying behaviour.
 *
 * Cost: ~$0.04 (4 short turns × sonnet/medium).
 *
 * Usage:
 *   node scripts/spikes/native-queue.mjs   # from polygram package root
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

const TOOL_USING_PROMPT
  = 'Run `ls /tmp | head -2` then `pwd` then `echo done`. After the '
  + 'last command, summarize what you saw in two sentences.';
const FOLLOWUP_MARKER = 'spike-marker-' + Math.random().toString(36).slice(2, 10);
const FOLLOWUP_TEXT
  = `Also include the verification token "${FOLLOWUP_MARKER}" verbatim `
  + 'in your final summary so we can confirm you saw this followup.';

// Build a manually-controllable AsyncIterable so we can push messages
// mid-turn from outside the for-await loop.
function makeInputController() {
  const queue = [];
  const waiters = [];
  let closed = false;
  return {
    push(msg) {
      if (closed) throw new Error('controller closed');
      if (waiters.length > 0) {
        waiters.shift()({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function runScenario({ priority, shouldQueryOnFollowup, label }) {
  log(`\n=== ${label}: followup priority=${JSON.stringify(priority)} shouldQuery=${shouldQueryOnFollowup} ===`);

  const input = makeInputController();
  // Seed the FIRST user message (the tool-using prompt).
  input.push({
    type: 'user',
    message: { role: 'user', content: TOOL_USING_PROMPT },
    parent_tool_use_id: null,
    session_id: '',
    uuid: randomUUID(),
  });

  const events = [];
  const t0 = Date.now();
  let toolBatchCount = 0;
  let followupPushed = false;
  let firstResultMsg = null;
  let secondResultMsg = null;

  const q = query({
    prompt: input,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      allowedTools: ['Bash'],
      model: 'claude-sonnet-4-6',
    },
  });

  // Hard wall-clock cap.
  const capTimer = setTimeout(() => {
    log(`!! ${label}: 90s cap hit — bailing out`);
    log(`!! events captured: ${events.length}`);
    process.exit(2);
  }, 90_000);

  let textCollected = '';
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
          if (b.type === 'tool_use') slim.tool_use = b.name;
        }
      }
      events.push(slim);
      log(`  +${dt}ms  ${m.type}${slim.subtype ? `:${slim.subtype}` : ''}`
        + `${slim.stop_reason ? ` stop=${slim.stop_reason}` : ''}`
        + `${slim.terminal_reason ? ` term=${slim.terminal_reason}` : ''}`
        + `${slim.is_error ? ' is_error=true' : ''}`
        + `${slim.tool_use ? ` tool=${slim.tool_use}` : ''}`
        + `${slim.text_chars ? ` text=${slim.text_chars}c` : ''}`);

      // Detect tool-result events (m.type === 'user' with tool_use_result).
      // After the FIRST tool batch fires, push our followup.
      if (!followupPushed && m.type === 'user' && m.tool_use_result !== undefined) {
        toolBatchCount += 1;
        if (toolBatchCount === 1) {
          followupPushed = true;
          const followup = {
            type: 'user',
            message: { role: 'user', content: FOLLOWUP_TEXT },
            parent_tool_use_id: null,
            session_id: '',
            uuid: randomUUID(),
          };
          if (priority !== undefined) followup.priority = priority;
          if (shouldQueryOnFollowup === false) followup.shouldQuery = false;
          log(`  >> pushing followup with priority=${JSON.stringify(priority)} shouldQuery=${shouldQueryOnFollowup}`);
          try {
            input.push(followup);
            log(`  >> push succeeded`);
          } catch (err) {
            log(`  >> push THREW: ${err?.message || err}`);
          }
        }
      }

      if (m.type === 'result') {
        if (firstResultMsg === null) firstResultMsg = m;
        else if (secondResultMsg === null) {
          secondResultMsg = m;
          break;  // exit after 2 results (one per turn) OR break after first if no 2nd comes
        }
        // If we got first result and didn't push a followup yet, time
        // to give up — the agent finished without us seeing tool_result.
        if (!followupPushed) {
          log(`  !! first result fired before we saw tool_result — closing`);
          break;
        }
      }
    }
  } catch (err) {
    log(`!! ${label} iterator threw: ${err?.message || err}`);
  }
  clearTimeout(capTimer);
  input.close();

  const elapsed = Date.now() - t0;
  const sawMarker = textCollected.includes(FOLLOWUP_MARKER);
  log(`  total elapsed: ${elapsed}ms`);
  log(`  followup pushed: ${followupPushed}`);
  log(`  first result subtype: ${firstResultMsg?.subtype ?? '(none)'}`);
  log(`  first result is_error: ${firstResultMsg?.is_error}`);
  log(`  second result subtype: ${secondResultMsg?.subtype ?? '(none — single turn)'}`);
  log(`  second result is_error: ${secondResultMsg?.is_error}`);
  log(`  text incorporated marker: ${sawMarker}`);

  return {
    label,
    elapsed,
    followupPushed,
    firstResultSubtype: firstResultMsg?.subtype ?? null,
    firstResultIsError: firstResultMsg?.is_error ?? null,
    firstResultTerminalReason: firstResultMsg?.terminal_reason ?? null,
    secondResultSubtype: secondResultMsg?.subtype ?? null,
    secondResultIsError: secondResultMsg?.is_error ?? null,
    markerInText: sawMarker,
    eventCount: events.length,
  };
}

(async () => {
  // Baseline: priority='now' — should fail with m87 per polygram
  // history. Confirms we're testing the same code path that failed
  // before. If THIS now passes, the SDK has changed since rc.9.
  const nowResult = await runScenario({
    priority: 'now',
    shouldQueryOnFollowup: undefined,
    label: 'PRIORITY-NOW',
  });

  // The interesting one: priority='next' = "queue at next pause".
  const nextResult = await runScenario({
    priority: 'next',
    shouldQueryOnFollowup: undefined,
    label: 'PRIORITY-NEXT',
  });

  // priority='later' = "queue at end".
  const laterResult = await runScenario({
    priority: 'later',
    shouldQueryOnFollowup: undefined,
    label: 'PRIORITY-LATER',
  });

  // No priority set: SDK default.
  const defaultResult = await runScenario({
    priority: undefined,
    shouldQueryOnFollowup: undefined,
    label: 'NO-PRIORITY (default)',
  });

  log('\n=== U7 SUMMARY ===');
  const all = { nowResult, nextResult, laterResult, defaultResult };
  log(JSON.stringify(all, null, 2));

  log('\nVerdict per scenario:');
  for (const [k, r] of Object.entries(all)) {
    const ok = r.followupPushed
      && (r.markerInText  // model saw and incorporated the followup
        || r.secondResultSubtype !== null);  // OR a second turn fired
    const failureMode = !r.followupPushed
      ? 'push threw'
      : r.firstResultIsError
        ? `first-result-error (${r.firstResultSubtype})`
        : !r.markerInText && r.secondResultSubtype === null
          ? 'silent-drop (followup never seen)'
          : 'PASS';
    log(`  ${k}: ${ok ? 'PASS' : 'FAIL'}  — ${failureMode}`);
  }

  log('\nIf any of next/later/default PASS, polygram should drop the');
  log('autosteer-buffer + PostToolBatch + MAX_ABSORBED machinery and');
  log('use native streamInput pushes instead.');
  process.exit(0);
})().catch((err) => {
  log('Spike threw at top level: ' + (err?.stack || err));
  process.exit(3);
});
