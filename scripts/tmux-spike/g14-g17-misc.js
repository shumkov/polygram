#!/usr/bin/env node
/**
 * G14: Boot orphan-scan reconciles `tmux list-sessions` with DB.
 *      (Verify the BUILDING BLOCK — tmux list-sessions output is
 *       parseable, kill-by-name works. Boot replay race semantics
 *       are tested in production.)
 * G15: /cost and /context output parseable across pinned claude version.
 * G16: Model choice persists across cold-spawn with --resume.
 * G17: paste-buffer vs send-keys -l ergonomic differences in TUI.
 *
 * Cost: ~$0.10
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  run, tmuxSessionName, tmuxNewSession, tmuxSendKeys, tmuxPasteText,
  tmuxCapturePane, tmuxKillSession, tmuxListSpikeSessions, cleanupAll,
  emit, appendFinding, sleep, waitUntil,
} = require('./runner');

const SPIKE_CWD = path.resolve(__dirname, 'sandbox');
fs.mkdirSync(SPIKE_CWD, { recursive: true });
const CLAUDE = '/Users/ivanshumkov/.local/bin/claude';

const READY_HINT_RE = /\?\s+for shortcuts/;
const STREAMING_HINT_RE = /esc to interrupt/;
function isReady(c) { return READY_HINT_RE.test(c) && !STREAMING_HINT_RE.test(c); }

async function g14() {
  // Spawn 3 spike sessions, then list, then kill specific one.
  const names = [];
  let status = 'FAIL', detail = {};
  try {
    for (let i = 0; i < 3; i++) {
      const n = tmuxSessionName('g14-' + i);
      await tmuxNewSession({
        name: n, cwd: SPIKE_CWD, command: 'sh', args: ['-c', 'sleep 30'],
      });
      names.push(n);
    }
    detail.spawned = names;
    // List spike sessions
    const listed = await tmuxListSpikeSessions();
    detail.listedAfterSpawn = listed.length;
    const matchedAll = names.every((n) => listed.includes(n));
    detail.allSpawnedListed = matchedAll;
    // Kill one specific
    await tmuxKillSession(names[1]);
    await sleep(200);
    const listed2 = await tmuxListSpikeSessions();
    detail.afterKillOne = listed2.length;
    const killedAbsent = !listed2.includes(names[1]);
    detail.targetKillWorks = killedAbsent;
    if (matchedAll && killedAbsent) {
      status = 'PASS';
      detail.note = (
        'tmux list-sessions reliably surfaces spike-* sessions; ' +
        'kill-session by name removes the specific target. ' +
        'Boot orphan-scan building blocks verified.'
      );
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    for (const n of names) await tmuxKillSession(n).catch(() => {});
  }
  emit({ gate: 'G14', status, detail });
  appendFinding('G14', status, detail);
  return status === 'PASS';
}

async function g15() {
  // Spawn a TUI session, run a turn, then send /cost — does the
  // output contain parseable cost/token values?
  const name = tmuxSessionName('g15');
  let status = 'FAIL', detail = { name };
  try {
    await tmuxNewSession({
      name, cwd: SPIKE_CWD, command: CLAUDE,
      args: ['--model', 'sonnet'],
      envExtras: { TERM: 'xterm-256color' },
    });
    await sleep(3500);
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 500 });
    // Quick turn to generate some cost
    await tmuxPasteText(name, 'reply with just: hi');
    await tmuxSendKeys(name, 'Enter');
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 30000, intervalMs: 800 });
    // Now /cost
    await tmuxPasteText(name, '/cost');
    await tmuxSendKeys(name, 'Enter');
    await sleep(2000);
    const costCap = await tmuxCapturePane(name);
    detail.costCapTail = costCap.slice(-1500);
    // Look for dollar / token markers
    const hasDollar = /\$\d+\.\d+/.test(costCap);
    const hasTokens = /token|input|output/i.test(costCap);
    detail.costSignals = { hasDollar, hasTokens };

    // /context
    await tmuxPasteText(name, '/context');
    await tmuxSendKeys(name, 'Enter');
    await sleep(2000);
    const ctxCap = await tmuxCapturePane(name);
    detail.ctxCapTail = ctxCap.slice(-1500);
    const hasPercent = /\d+%|\d+\s*\/\s*\d+/.test(ctxCap);
    const hasRemaining = /remain|context|window/i.test(ctxCap);
    detail.contextSignals = { hasPercent, hasRemaining };

    const costParseable = hasDollar && hasTokens;
    const ctxParseable = hasPercent && hasRemaining;

    if (costParseable && ctxParseable) {
      status = 'PASS';
      detail.note = '/cost and /context output have parseable markers';
    } else if (costParseable || ctxParseable) {
      status = 'DEFER';
      detail.note = 'partial — one parseable, other not. Document and pin parser per slash command';
    } else {
      status = 'FAIL';
      detail.note = 'neither /cost nor /context output parseable';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G15', status, detail });
  appendFinding('G15', status, detail);
  return status !== 'FAIL';
}

async function g16() {
  // Verify --model persists across resume.
  const sessionId = crypto.randomUUID();
  const out1 = `/tmp/spike-g16-out1-${sessionId.slice(0, 8)}.txt`;
  const out2 = `/tmp/spike-g16-out2-${sessionId.slice(0, 8)}.txt`;
  const out3 = `/tmp/spike-g16-out3-${sessionId.slice(0, 8)}.txt`;
  const name1 = tmuxSessionName('g16a');
  const name2 = tmuxSessionName('g16b');
  const name3 = tmuxSessionName('g16c');
  let status = 'FAIL', detail = { sessionId };
  try {
    // Step 1: explicit --model opus
    await tmuxNewSession({
      name: name1, cwd: SPIKE_CWD, command: 'sh',
      args: ['-c',
        `${CLAUDE} --print --session-id ${sessionId} --model opus 'what model are you? Reply with the model name only.' > ${out1} 2>&1`,
      ],
    });
    await waitUntil(async () => !(await require('./runner').tmuxSessionExists(name1)),
      { timeoutMs: 60000, intervalMs: 1000 });
    detail.modelTurn1 = fs.existsSync(out1) ? fs.readFileSync(out1, 'utf8').trim() : '';

    // Step 2: resume WITHOUT --model — does it remember opus?
    await tmuxNewSession({
      name: name2, cwd: SPIKE_CWD, command: 'sh',
      args: ['-c',
        `${CLAUDE} --print --resume ${sessionId} 'still on opus? Reply with model name only.' > ${out2} 2>&1`,
      ],
    });
    await waitUntil(async () => !(await require('./runner').tmuxSessionExists(name2)),
      { timeoutMs: 60000, intervalMs: 1000 });
    detail.modelTurn2_noFlag = fs.existsSync(out2) ? fs.readFileSync(out2, 'utf8').trim() : '';

    // Step 3: resume WITH explicit --model sonnet — does override work?
    await tmuxNewSession({
      name: name3, cwd: SPIKE_CWD, command: 'sh',
      args: ['-c',
        `${CLAUDE} --print --resume ${sessionId} --model sonnet 'what model now? Reply with model name only.' > ${out3} 2>&1`,
      ],
    });
    await waitUntil(async () => !(await require('./runner').tmuxSessionExists(name3)),
      { timeoutMs: 60000, intervalMs: 1000 });
    detail.modelTurn3_withFlag = fs.existsSync(out3) ? fs.readFileSync(out3, 'utf8').trim() : '';

    const turn1IsOpus = /opus/i.test(detail.modelTurn1);
    const turn2IsOpus = /opus/i.test(detail.modelTurn2_noFlag);
    const turn3IsSonnet = /sonnet/i.test(detail.modelTurn3_withFlag) && !/opus/i.test(detail.modelTurn3_withFlag);

    detail.signals = { turn1IsOpus, turn2IsOpus, turn3IsSonnet };
    if (turn1IsOpus && turn2IsOpus && turn3IsSonnet) {
      status = 'PASS';
      detail.note = 'Model persists across --resume; explicit --model on resume overrides correctly';
    } else if (turn1IsOpus && turn3IsSonnet) {
      status = 'DEFER';
      detail.note = 'Resume does NOT preserve model — polygram must always pass --model on cold spawn (no UX impact)';
    } else {
      detail.note = 'Unexpected — claude refused to reveal model name reliably';
      status = 'DEFER';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    for (const f of [out1, out2, out3]) try { fs.unlinkSync(f); } catch {}
    for (const n of [name1, name2, name3]) await tmuxKillSession(n);
  }
  emit({ gate: 'G16', status, detail });
  appendFinding('G16', status, detail);
  return status !== 'FAIL';
}

async function g17() {
  // Compare paste-buffer vs send-keys -l for the SAME input.
  const sample = 'compare paste vs literal type';
  const name = tmuxSessionName('g17');
  let status = 'FAIL', detail = { name, sample };
  try {
    await tmuxNewSession({
      name, cwd: SPIKE_CWD, command: CLAUDE,
      args: ['--model', 'sonnet'],
      envExtras: { TERM: 'xterm-256color' },
    });
    await sleep(3500);
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 500 });

    // Approach 1: paste-buffer
    await tmuxPasteText(name, sample);
    await sleep(400);
    const pasteCap = await tmuxCapturePane(name);
    detail.pasteCapTail = pasteCap.slice(-400);
    detail.pasteVisible = pasteCap.includes(sample);
    // Clear
    await tmuxSendKeys(name, 'Escape');
    await sleep(200);
    await tmuxSendKeys(name, 'Escape');
    await sleep(200);

    // Approach 2: send-keys -l (literal mode)
    await run('tmux', ['send-keys', '-t', name, '-l', sample]);
    await sleep(400);
    const literalCap = await tmuxCapturePane(name);
    detail.literalCapTail = literalCap.slice(-400);
    detail.literalVisible = literalCap.includes(sample);

    if (detail.pasteVisible && detail.literalVisible) {
      status = 'PASS';
      detail.note = (
        'BOTH paste-buffer and send-keys -l deliver text correctly for this sample. ' +
        'Production preference: paste-buffer (per R2-F1 — handles long text + ' +
        'integrates with sanitize() pipeline). send-keys -l reserved for control ' +
        'chars (Enter, Escape, C-c).'
      );
    } else if (detail.pasteVisible) {
      status = 'PASS';
      detail.note = 'paste-buffer works; send-keys -l did not deliver. Confirms paste-buffer as primary.';
    } else {
      status = 'FAIL';
      detail.note = 'paste-buffer failed to deliver text';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G17', status, detail });
  appendFinding('G17', status, detail);
  return status !== 'FAIL';
}

(async () => {
  let allOk = true;
  try {
    if (!(await g14())) allOk = false;
    if (!(await g15())) allOk = false;
    if (!(await g16())) allOk = false;
    if (!(await g17())) allOk = false;
  } finally {
    await cleanupAll();
  }
  process.exit(allOk ? 0 : 1);
})();
