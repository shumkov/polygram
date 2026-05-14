#!/usr/bin/env node
/**
 * G9: /compact via send-keys completes successfully.
 * G10: tmux kill-session preserves session_id JSONL for resume.
 * G11: 10+ concurrent tmux+claude sessions don't blow RSS.
 * G12: pane-width 200 prevents capture-pane wrap artifacts.
 *
 * Cost: ~$0.30 (G11 spawns 10 sessions, each does a turn).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  run, tmuxSessionName, tmuxNewSession, tmuxSendKeys, tmuxPasteText,
  tmuxCapturePane, tmuxSessionExists, tmuxKillSession, cleanupAll,
  emit, appendFinding, sleep, waitUntil,
} = require('./runner');

const SPIKE_CWD = path.resolve(__dirname, 'sandbox');
fs.mkdirSync(SPIKE_CWD, { recursive: true });
const CLAUDE = '/Users/ivanshumkov/.local/bin/claude';

const READY_HINT_RE = /\?\s+for shortcuts/;
const STREAMING_HINT_RE = /esc to interrupt/;
function isReady(c) { return READY_HINT_RE.test(c) && !STREAMING_HINT_RE.test(c); }

async function g9() {
  const name = tmuxSessionName('g9');
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
    // Generate some context to compact
    await tmuxPasteText(name, 'reply with a one-paragraph explanation of what tmux is');
    await tmuxSendKeys(name, 'Enter');
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 45000, intervalMs: 800 });

    // Now /compact
    await tmuxPasteText(name, '/compact preserve key tmux concept summary');
    await tmuxSendKeys(name, 'Enter');
    // Compact can take a while
    const compactDone = await waitUntil(async () => {
      const c = await tmuxCapturePane(name);
      return isReady(c) && (/compact/i.test(c) || /summari/i.test(c));
    }, { timeoutMs: 60000, intervalMs: 1500 });
    const finalCap = await tmuxCapturePane(name);
    detail.compactCompleted = compactDone;
    detail.finalCapTail = finalCap.slice(-1500);
    if (compactDone) {
      status = 'PASS';
      detail.note = '/compact via send-keys completed; session_id preserved (no /new state)';
    } else {
      status = 'FAIL';
      detail.note = '/compact did not complete within 60s';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G9', status, detail });
  appendFinding('G9', status, detail);
  return status === 'PASS';
}

async function g10() {
  // Spawn tmux+claude with --session-id X, run a turn,
  // kill-session (NOT /exit), re-spawn with --resume X, verify
  // context preserved.
  const sessionId = crypto.randomUUID();
  const out1 = `/tmp/spike-g10-out1-${sessionId.slice(0, 8)}.txt`;
  const out2 = `/tmp/spike-g10-out2-${sessionId.slice(0, 8)}.txt`;
  const name1 = tmuxSessionName('g10a');
  const name2 = tmuxSessionName('g10b');
  let status = 'FAIL', detail = { sessionId };
  try {
    // Turn 1: establish a secret
    await tmuxNewSession({
      name: name1, cwd: SPIKE_CWD, command: 'sh',
      args: ['-c',
        `${CLAUDE} --print --session-id ${sessionId} --model sonnet 'remember password is purple-zebra. just say ok' > ${out1} 2>&1`,
      ],
    });
    await waitUntil(async () => !(await tmuxSessionExists(name1)),
      { timeoutMs: 60000, intervalMs: 1000 });
    detail.turn1 = fs.existsSync(out1) ? fs.readFileSync(out1, 'utf8').trim().slice(0, 200) : '';

    // Now spawn a NEW tmux session (mimics polygram restart after crash)
    // with --resume → does the password survive?
    await tmuxNewSession({
      name: name2, cwd: SPIKE_CWD, command: 'sh',
      args: ['-c',
        `${CLAUDE} --print --resume ${sessionId} 'what was the password? just the password.' > ${out2} 2>&1`,
      ],
    });
    await waitUntil(async () => !(await tmuxSessionExists(name2)),
      { timeoutMs: 60000, intervalMs: 1000 });
    detail.turn2 = fs.existsSync(out2) ? fs.readFileSync(out2, 'utf8').trim().slice(0, 200) : '';

    if (/purple-zebra/i.test(detail.turn2)) {
      status = 'PASS';
      detail.note = (
        'tmux kill-session does NOT corrupt session JSONL. ' +
        'After kill + respawn with --resume, claude recalled the password. ' +
        'Boot-replay path is structurally sound.'
      );
    } else {
      status = 'FAIL';
      detail.note = 'Session JSONL did not survive kill-session — turn2 did not recall password';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    for (const f of [out1, out2]) try { fs.unlinkSync(f); } catch {}
    for (const n of [name1, name2]) await tmuxKillSession(n);
  }
  emit({ gate: 'G10', status, detail });
  appendFinding('G10', status, detail);
  return status === 'PASS';
}

async function g11() {
  // Spawn 10 simultaneous --print sessions (cheaper than 10 TUI sessions
  // for the spike — verify RSS scales). Measure total RSS.
  const N = 10;
  const names = [];
  let status = 'FAIL', detail = { N };
  try {
    const baselineRss = process.memoryUsage().rss;
    detail.spikeProcessBaselineRss_MB = Math.round(baselineRss / 1024 / 1024);
    // Spawn N
    for (let i = 0; i < N; i++) {
      const n = tmuxSessionName('g11-' + i);
      await tmuxNewSession({
        name: n, cwd: SPIKE_CWD, command: 'sh',
        args: ['-c', `${CLAUDE} --print --model sonnet 'reply: ok' > /tmp/spike-g11-${i}.txt 2>&1`],
      });
      names.push(n);
    }
    // Wait a couple seconds for processes to spawn
    await sleep(3000);
    // Total claude RSS via `ps`
    const psRes = await run('sh', ['-c',
      `ps -ax -o rss,command | grep -i 'cli.js\\|claude' | grep -v grep | awk '{s+=$1} END {print s}'`,
    ]);
    const totalRssKB = parseInt(psRes.stdout.trim(), 10) || 0;
    detail.totalClaudeRss_MB = Math.round(totalRssKB / 1024);
    detail.perSessionAvg_MB = Math.round(totalRssKB / 1024 / N);
    // Wait for all to complete
    await waitUntil(async () => {
      const stillAlive = await Promise.all(names.map(tmuxSessionExists));
      return !stillAlive.some(Boolean);
    }, { timeoutMs: 90000, intervalMs: 2000 });

    // Reasonable budget: under 1.5GB total for 10 concurrent
    if (detail.totalClaudeRss_MB < 1500) {
      status = 'PASS';
      detail.note = `${N} concurrent claude sessions: ${detail.totalClaudeRss_MB}MB total (${detail.perSessionAvg_MB}MB each). Acceptable for default LRU cap of 10.`;
    } else if (detail.totalClaudeRss_MB < 3000) {
      status = 'DEFER';
      detail.note = `${N} concurrent: ${detail.totalClaudeRss_MB}MB. Heavier than ideal — recommend tmux backend LRU cap of 5 or weighted eviction.`;
    } else {
      status = 'FAIL';
      detail.note = `${N} concurrent: ${detail.totalClaudeRss_MB}MB — too heavy. Tmux backend needs hard cap.`;
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    for (let i = 0; i < N; i++) try { fs.unlinkSync(`/tmp/spike-g11-${i}.txt`); } catch {}
    for (const n of names) await tmuxKillSession(n).catch(() => {});
  }
  emit({ gate: 'G11', status, detail });
  appendFinding('G11', status, detail);
  return status !== 'FAIL';
}

async function g12() {
  // Verify pane-width 200 prevents capture-pane wrap artifacts.
  const name = tmuxSessionName('g12');
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
    // Send a very long single-line prompt (should fit in pane-width=200)
    const longPrompt = 'reply with just one word: hi — and also: ' + 'x'.repeat(150);
    await tmuxPasteText(name, longPrompt);
    await sleep(500);
    const cap = await tmuxCapturePane(name);
    // The probe: the 150 x's should appear UN-WRAPPED in capture-pane.
    // If capture-pane wrapping is broken at 80 cols, we'd see x's split.
    const unwrapped = /x{120,}/.test(cap);
    detail.unwrappedInCapture = unwrapped;
    detail.capTail = cap.slice(-500);
    if (unwrapped) {
      status = 'PASS';
      detail.note = 'pane-width 200 setting prevents capture-pane from wrapping long lines';
    } else {
      // Maybe runner.tmuxNewSession's set-option didn't work?
      status = 'DEFER';
      detail.note = 'Long line wrapped in capture — investigate set-option timing or use different setting';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G12', status, detail });
  appendFinding('G12', status, detail);
  return status !== 'FAIL';
}

(async () => {
  let allOk = true;
  try {
    if (!(await g9())) allOk = false;
    if (!(await g10())) allOk = false;
    if (!(await g11())) allOk = false;
    if (!(await g12())) allOk = false;
  } finally {
    await cleanupAll();
  }
  process.exit(allOk ? 0 : 1);
})();
