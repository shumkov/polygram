/**
 * TUI simulator for end-to-end autosteer scenario tests.
 *
 * Models the parts of claude TUI behaviour that polygram cares about:
 *   - Bracketed-paste input buffer (atomic per paste-buffer cmd).
 *   - Concurrent paste-buffer calls interleave their content if the
 *     runner does NOT serialize (regression check for rc.14's
 *     pasteAndEnter lock).
 *   - Enter submits the input buffer as a "user prompt" to the model.
 *   - If a turn is in flight when a paste arrives, the paste is
 *     queued in the TUI's internal queue.
 *   - On turn end, the queue is consumed: as attachment.queued_command
 *     if consumption happens "before" the final text (FOLD), or as
 *     a new top-level user message (NEW TURN).
 *
 * Scenario API:
 *   const sim = createTuiSimulator({ session, logPath });
 *   sim.scheduleReply(promptMatch, replyText, { delayMs, withTool? }); // primes the agent
 *   ... drive p.send / p.injectUserMessage from the test
 *   await sim.waitForIdle();
 *   sim.assertNoCorruption();
 *   sim.assertReplies([{ to: 1, text: /pattern/ }, ...]);
 *
 * The simulator writes real JSONL lines to logPath so TmuxProcess's
 * tail picks them up via its real LogTail. The runner it provides
 * records paste/Enter calls, applies queue logic, and triggers the
 * scheduled replies at the appropriate time.
 */

'use strict';

const fs = require('fs');
const { createAsyncLock } = require('../../lib/async-lock');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @param {object} opts
 * @param {string} opts.sessionName    tmux session name (for runner shape)
 * @param {string} opts.logPath        where to write JSONL events
 * @param {string} opts.sessionId      claude sessionId field for every JSONL line
 * @param {boolean} [opts.useLock=true] when false, pasteText calls go through
 *   the legacy non-locked path — used to demonstrate the rc.14 race.
 */
function createTuiSimulator({ sessionName, logPath, sessionId, useLock = true }) {
  // Internal state ─────────────────────────────────────────
  const pasteLog = [];          // [{op, text, t, callId}] — every recorded op
  const inputBuffer = { value: '' }; // current TUI input box (modeled)
  const scheduledReplies = [];  // [{ matcher, replyText, delayMs, withTool }]
  let turnInFlight = false;
  let queuePending = null;      // string queued during in-flight turn
  let queueWillFold = false;    // true → consume as queued_command, false → new user-msg
  let onAfterAgentTurn = null;  // callback to dequeue + write next user-msg

  // Lock for the "atomic paste+Enter" path. useLock=true mirrors the
  // production rc.14 runner; useLock=false models the broken pre-rc.14
  // path for regression testing.
  const inputLock = createAsyncLock();

  function nowMs() { return Date.now(); }

  function writeJsonl(obj) {
    fs.appendFileSync(logPath, JSON.stringify({ ...obj, sessionId }) + '\n');
  }

  function findScheduledMatch(text) {
    for (let i = 0; i < scheduledReplies.length; i++) {
      const s = scheduledReplies[i];
      if (s.matcher.test(text)) {
        scheduledReplies.splice(i, 1);
        return s;
      }
    }
    return null;
  }

  // The "real" submission path — runs the agent's turn for the given
  // text, writing JSONL events that TmuxProcess's tail will pick up.
  // Returns when the turn's terminal result event has been written.
  async function runAgentTurn(userText, { isAttachment = false, attachmentParent = null } = {}) {
    if (turnInFlight) {
      throw new Error('runAgentTurn called while another turn is in flight');
    }
    turnInFlight = true;
    try {
      // Write the user message (if not a fold-attachment, which is
      // logged separately).
      if (isAttachment) {
        writeJsonl({
          type: 'attachment',
          parentUuid: attachmentParent || 'parent',
          attachment: { type: 'queued_command', prompt: userText, commandMode: 'prompt' },
        });
      } else {
        writeJsonl({
          type: 'user',
          message: { role: 'user', content: userText },
        });
      }

      const sched = findScheduledMatch(userText);
      if (!sched) {
        // No scripted reply — agent emits an empty end_turn for
        // backwards-compat. Tests that don't schedule a reply for
        // a sent prompt are likely a setup bug.
        writeJsonl({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '<unscripted>' }], stop_reason: 'end_turn' },
        });
        await sleep(5);
        return;
      }

      await sleep(sched.delayMs || 5);

      if (sched.withTool) {
        // tool_use: this is NON-terminal (rc.11). Must NOT resolve
        // the turn by itself.
        writeJsonl({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: sched.withTool.name || 'Bash', input: sched.withTool.input || {} }],
            stop_reason: 'tool_use',
          },
        });
        await sleep(2);
        writeJsonl({
          type: 'user',
          message: {
            role: 'user',
            content: [{ tool_use_id: 't1', type: 'tool_result', content: sched.withTool.result || 'ok', is_error: false }],
          },
        });
        await sleep(2);
      }

      // Final terminal text.
      writeJsonl({
        type: 'assistant',
        message: { content: [{ type: 'text', text: sched.replyText }], stop_reason: 'end_turn' },
      });
      await sleep(2);

      // After this terminal event, if a paste was queued during the
      // turn, decide fold-vs-new-turn and emit the corresponding
      // JSONL. We emit AFTER a small delay so the agent's result has
      // a chance to land first.
      if (queuePending != null) {
        const dequeued = queuePending;
        queuePending = null;
        if (queueWillFold) {
          // FOLD path: log a 'queue-folded' attachment with the
          // pending prompt. The test sets queueWillFold beforehand.
          writeJsonl({
            type: 'attachment',
            attachment: { type: 'queued_command', prompt: dequeued, commandMode: 'prompt' },
          });
        } else {
          // NEW-TURN path: kick off another agent turn for the
          // dequeued content. We must release turnInFlight first
          // so runAgentTurn doesn't reject.
          turnInFlight = false;
          await sleep(2);
          await runAgentTurn(dequeued);
          return;  // runAgentTurn re-entered; outer finally is moot
        }
      }
    } finally {
      turnInFlight = false;
    }
  }

  // Runner methods — mirror the tmux-runner shape used by TmuxProcess.
  async function pasteText(name, text) {
    const callId = `p${pasteLog.length + 1}`;
    pasteLog.push({ op: 'paste', text, t: nowMs(), callId });
    // Simulate a brief tmux command latency.
    await sleep(5);
    // Mirror the real tmux-runner.pasteText: sanitize + \n → ' / '.
    // The TUI's input buffer always sees the oneLine form, and JSONL
    // queue-operation / user content records the same form.
    const sanitized = String(text || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    const oneLine = sanitized.replace(/\r?\n/g, ' / ');
    // The TUI buffer model: each pasteText REPLACES the input buffer
    // with the new content. In real tmux this is set-buffer + paste-
    // buffer — atomic from the TUI's perspective, IF serialised.
    inputBuffer.value = oneLine;
    return { sanitized, oneLine, stripped: text.length - sanitized.length };
  }

  async function sendControl(name, key) {
    const callId = `e${pasteLog.length + 1}`;
    pasteLog.push({ op: 'enter', t: nowMs(), callId });
    if (key !== 'Enter') return;
    await sleep(2);
    const submitted = inputBuffer.value;
    inputBuffer.value = '';
    if (!submitted) return;

    // If a turn is in flight, queue. Otherwise start a new turn.
    if (turnInFlight) {
      queuePending = submitted;
    } else {
      // Fire and forget — let the caller await idleness via waitForIdle.
      // We DON'T await the turn here so the test can drive more sends.
      runAgentTurn(submitted).catch((err) => {
        process.nextTick(() => { throw err; });
      });
    }
  }

  async function pasteAndEnter(name, text) {
    if (!useLock) {
      // Regression-mode: simulate the broken pre-rc.14 path. Just
      // calls pasteText + sendControl Enter without any lock. Used
      // by the test that proves the race exists.
      const res = await pasteText(name, text);
      await sendControl(name, 'Enter');
      return res;
    }
    const release = await inputLock.acquire(name);
    try {
      const res = await pasteText(name, text);
      await sendControl(name, 'Enter');
      return res;
    } finally {
      release();
    }
  }

  // Capture-pane: returns ready/streaming based on turnInFlight.
  let startReadyConsumed = false;
  async function captureWide() {
    if (!startReadyConsumed) {
      startReadyConsumed = true;
      return '? for shortcuts';
    }
    return turnInFlight
      ? 'PRELUDE\n? for shortcuts\nesc to interrupt'
      : '? for shortcuts';
  }

  async function waitForIdle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!turnInFlight && queuePending == null && inputBuffer.value === '') {
        // Give the JSONL tail a beat to catch up.
        await sleep(50);
        return;
      }
      await sleep(20);
    }
    throw new Error(`tui-simulator: waitForIdle timeout. turnInFlight=${turnInFlight}, queuePending=${queuePending != null}, inputBuffer=${inputBuffer.value.slice(0, 60)}`);
  }

  return {
    // Runner facade ─────────────────────────────────────────────
    runner: {
      spawn: async (opts) => { pasteLog.push({ op: 'spawn', t: nowMs(), opts }); },
      sendControl,
      pasteText,
      pasteAndEnter,
      captureWide,
      capturePane: async () => '? for shortcuts',
      sessionExists: async () => true,
      killSession: async () => {},
      listPolygramSessions: async () => [],
      setPaneReadOnly: async () => {},
      sessionName: () => sessionName,
      debugLogPath: () => `/tmp/tui-sim-${sessionName}.log`,
    },
    // Scenario API ─────────────────────────────────────────────
    /** Script a reply the agent will emit when it sees a prompt matching `matcher`. */
    scheduleReply(matcher, replyText, opts = {}) {
      scheduledReplies.push({ matcher, replyText, ...opts });
    },
    /** Mark the next queued paste's dequeue as FOLD (attachment.queued_command) instead of NEW-TURN. */
    nextQueueFolds() { queueWillFold = true; },
    nextQueueNewTurn() { queueWillFold = false; },
    waitForIdle,
    // Inspection ────────────────────────────────────────────────
    pasteLog,
    /** Returns true if any two pasteText calls' content interleaved at the JSONL level. */
    inputBufferState() { return inputBuffer.value; },
  };
}

module.exports = { createTuiSimulator };
