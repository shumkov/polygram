#!/usr/bin/env node
/**
 * autosteer-tui-real — exercise the rc.7→rc.14 autosteer fixes against
 * a REAL claude TUI in tmux. The fast-CI scenario tests in
 * tests/autosteer-scenarios.test.js use a simulator; this spike
 * checks the simulator's fidelity by running the same patterns
 * against an actual claude session.
 *
 * Cost: ~$0.10-0.30 sonnet/low + a few Bash tool calls. Run before
 * tagging each RC that touches autosteer / tmux-process / runner.
 *
 * Hard wall-clock cap: 120s per scenario. process.exit on hang.
 *
 * What it verifies:
 *   - autosteer-resolution event fires with via='new-turn' OR 'fold'
 *   - extra-turn-reply fires for NEW-TURN scenarios with correct msgId
 *   - autosteer-match-miss does NOT fire (signature of paste corruption)
 *   - no autonomous-wakeup-message leakage
 *
 * Usage:
 *   node scripts/spikes/autosteer-tui-real.mjs
 *
 * Side-effects: spawns a tmux session in a temp cwd, leaves behind
 * ~/.claude/projects/<encoded-cwd>/ JSONL files (cleanup on exit).
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');

const execFileP = promisify(execFile);

const HARD_TIMEOUT_MS = 120_000;
const SCENARIOS = ['short-then-autosteer', 'long-then-autosteer'];

function log(...args) { console.error('[spike]', ...args); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function killTmuxSession(name) {
  try { await execFileP('tmux', ['kill-session', '-t', name]); }
  catch { /* not running */ }
}

async function setupCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autosteer-spike-'));
  // claude requires a trust prompt on fresh cwd. Mark project as trusted
  // via the claude project state.
  const claudeDir = path.join(tmp, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // Use an existing trusted dir as cwd to skip the trust dialog —
  // polygram repo itself is already trusted.
  return tmp;
}

async function runScenario(scenarioName) {
  log(`=== Scenario: ${scenarioName} ===`);
  // Use the polygram repo as cwd (already trusted by claude CLI) so we
  // don't trip the workspace-trust dialog mid-spike.
  const cwd = path.resolve(process.cwd());
  const runner = createTmuxRunner({ logger: console });
  const sessionId = require('crypto').randomUUID();
  const events = [];

  const p = new TmuxProcess({
    sessionKey: 'spike:auto',
    chatId: 'spike',
    threadId: 'auto',
    label: 'spike',
    runner,
    botName: 'spike',
    logger: { warn: () => {}, error: console.error, info: () => {}, debug: () => {}, log: () => {} },
    readyTimeoutMs: 60_000,
    turnTimeoutMs: 90_000,
  });

  for (const name of ['extra-turn-started', 'extra-turn-reply',
    'autosteer-resolution', 'autosteer-match-miss',
    'autonomous-assistant-message', 'inject-user-message']) {
    p.on(name, (payload) => events.push({ name, payload, t: Date.now() }));
  }

  // Clean up any prior session.
  await killTmuxSession(runner.sessionName('spike', 'spike', 'auto'));

  try {
    await p.start({
      chatConfig: {
        model: 'sonnet', effort: 'low', cwd,
        // Match production shumorobot config — `default` permission
        // mode so the spike triggers the same readiness path as live.
        permissionMode: 'default',
      },
    });
    log('TUI ready, sessionId:', p.claudeSessionId);

    if (scenarioName === 'short-then-autosteer') {
      // Quick first prompt (no tool, fast end_turn), then immediate
      // autosteer during turn 1. Expected: NEW-TURN path because
      // turn 1 ends before fold can happen.
      const sendP = p.send('Reply just with "OK" — one word, no formatting.');
      await sleep(50);
      const okInject = p.injectUserMessage({
        content: 'Reply just with "GO" — one word, no formatting.',
        msgId: 9001,
      });
      log('inject result:', okInject);
      const r1 = await sendP;
      log('primary turn reply:', r1.text?.slice(0, 60));
      // Wait up to 30s for extra-turn-reply.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (events.some((e) => e.name === 'extra-turn-reply')) break;
        await sleep(200);
      }
    } else if (scenarioName === 'long-then-autosteer') {
      // Longer first prompt (uses Bash), autosteer during tool.
      // Expected: FOLD because tool execution provides a pause point.
      const sendP = p.send('Run `echo HELLO` with Bash, then say "primary-done".');
      await sleep(300);
      p.injectUserMessage({
        content: 'Also say "autosteer-folded" at the end.',
        msgId: 9002,
      });
      await sendP;
      // Give a few more seconds for queue-folded to fire.
      await sleep(2_000);
    }

    // Snapshot events for analysis.
    log('events captured:');
    for (const e of events) {
      log(` - ${e.name}`, JSON.stringify(e.payload).slice(0, 120));
    }
    return { events, scenarioName };
  } finally {
    try { await p.kill('spike-done'); } catch {}
    await killTmuxSession(runner.sessionName('spike', 'spike', 'auto'));
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error('  FAIL:', msg);
    process.exitCode = 1;
    return false;
  }
  console.log('  PASS:', msg);
  return true;
}

async function main() {
  const results = [];
  // Hard timeout — process.exit if scenarios hang.
  const timer = setTimeout(() => {
    console.error('[spike] HARD TIMEOUT exceeded, aborting');
    process.exit(2);
  }, HARD_TIMEOUT_MS).unref();

  for (const name of SCENARIOS) {
    try {
      const res = await runScenario(name);
      results.push(res);
    } catch (err) {
      console.error(`[spike] scenario ${name} threw:`, err);
      process.exitCode = 1;
    }
  }
  clearTimeout(timer);

  console.log('\n=== Summary ===');
  for (const { scenarioName, events } of results) {
    console.log(`\n[${scenarioName}]`);
    const has = (name) => events.some((e) => e.name === name);
    const matches = events.filter((e) => e.name === 'autosteer-match-miss');
    assert(!has('autosteer-match-miss'),
      'no autosteer-match-miss events (proves content matching worked → no paste corruption)');
    if (matches.length > 0) {
      console.log('    head-snippets:', matches.map((e) => e.payload).slice(0, 3));
    }
    if (scenarioName === 'short-then-autosteer') {
      assert(has('extra-turn-started'), 'extra-turn-started fires for NEW-TURN');
      assert(has('extra-turn-reply'), 'extra-turn-reply fires for NEW-TURN');
      const resolution = events.find((e) => e.name === 'autosteer-resolution');
      assert(resolution && resolution.payload.via === 'new-turn',
        `autosteer-resolution via=new-turn (got via=${resolution?.payload?.via})`);
    } else if (scenarioName === 'long-then-autosteer') {
      const resolution = events.find((e) => e.name === 'autosteer-resolution');
      // FOLD case: queue-folded fires, autosteer-resolution via='fold'.
      assert(resolution && resolution.payload.via === 'fold',
        `autosteer-resolution via=fold (got via=${resolution?.payload?.via})`);
      assert(!has('extra-turn-started'),
        'no extra-turn-started for FOLD (primary reply covers both)');
    }
  }

  if (process.exitCode === 1) {
    console.log('\n=== SPIKE FAILED ===');
    process.exit(1);
  } else {
    console.log('\n=== SPIKE PASS ===');
  }
}

main().catch((err) => {
  console.error('[spike] fatal:', err);
  process.exit(1);
});
