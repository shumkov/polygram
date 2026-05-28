#!/usr/bin/env node
/**
 * cli-driver-spike/probe-lag-baseline.mjs — Phase 0 follow-up investigation.
 *
 * Finding 0.4.A says hook lag is ~30x rc.42 baseline (426ms vs 14ms median).
 * The hypothesis: it's burst-contention from forking N helper subprocesses
 * close together, not steady-state lag.
 *
 * Compare:
 *   Run A: single Bash call (1 PreToolUse + 1 PostToolUse)
 *   Run B: six Bash calls (6 PreToolUse + 6 PostToolUse — same as measure-lag.mjs)
 *
 * Hypothesis says: Run A lag is comparable to rc.42 (median ~tens of ms);
 * Run B is burst-contention.
 *
 * If true: the lag is NOT a CliProcess flaw; it's a known characteristic of
 * the per-event helper-fork pattern that the tmux backend also has but
 * doesn't trigger as often.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { CliProcess }   = require('../../lib/process/cli-process.js');
const { createTmuxRunner }  = require('../../lib/tmux/tmux-runner.js');
const { writeHookFiles }    = require('../../lib/process/hook-settings.js');
const { createHookTail }    = require('../../lib/process/hook-event-tail.js');

const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || '/Users/ivanshumkov/.local/share/claude/versions/2.1.142';

function wrapRunner(realRunner, settingsPath) {
  return {
    ...realRunner,
    spawn: async (opts) => {
      const args = [...(opts.args || [])];
      args.splice(1, 0, '--settings', settingsPath);
      return realRunner.spawn({ ...opts, args });
    },
  };
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function oneTrial({ label, prompt, postStartDelayMs = 500 }) {
  const sessionKey = `cli-probe-lag-${label}-${Date.now()}`;
  const outDir = path.join(os.tmpdir(), sessionKey);
  fs.mkdirSync(outDir, { recursive: true });

  const { settingsPath, ndjsonPath } = writeHookFiles({
    botName: 'cli-spike',
    sessionId: sessionKey,
    hooksDir: outDir,
  });

  const emits = [];
  const tail = createHookTail({ path: ndjsonPath, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  tail.on('event', (ev) => emits.push({ t_emit: Date.now(), type: ev.type, toolName: ev.toolName, toolUseId: ev.toolUseId }));
  await tail.start();

  const realRunner = createTmuxRunner({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const wrapped = wrapRunner(realRunner, settingsPath);

  const proc = new CliProcess({
    sessionKey, chatId: '-9999999999', threadId: null, label: 'probe',
    tmuxRunner: wrapped, botName: 'cli-spike', claudeBin: CLAUDE_BIN,
    toolDispatcher: async () => ({ ok: true }),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    turnQuietMs: 2000,
    turnTimeoutMs: 60_000,
  });

  await proc.start({ cwd: process.cwd(), model: 'sonnet', effort: 'low', permissionMode: 'bypassPermissions' });
  await new Promise((r) => setTimeout(r, postStartDelayMs));
  await proc.send(prompt, { context: { chatId: '-9999999999', user: 'probe', sourceMsgId: 1 } });
  await new Promise((r) => setTimeout(r, 2000));
  await proc.kill('probe-done').catch(() => {});
  try { tail.close(); } catch {}

  // Correlate
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  const helper = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const lags = [];
  const used = new Set();
  for (const e of emits) {
    let m = -1;
    for (let i = 0; i < helper.length; i++) {
      if (used.has(i)) continue;
      if (helper[i].hook_event_name !== e.type) continue;
      if (e.toolUseId && helper[i].tool_use_id !== e.toolUseId) continue;
      m = i; break;
    }
    if (m === -1) continue;
    used.add(m);
    const lag = e.t_emit - helper[m].polygram_received_at_ms;
    if (Number.isFinite(lag)) lags.push({ type: e.type, lag });
  }

  return {
    label,
    sample: lags.length,
    median_ms: median(lags.map((l) => l.lag)),
    max_ms: Math.max(...lags.map((l) => l.lag)),
    per_type: Object.fromEntries(
      [...new Set(lags.map((l) => l.type))].map((t) => [
        t, median(lags.filter((l) => l.type === t).map((l) => l.lag))
      ]),
    ),
  };
}

async function main() {
  console.log('=== probe-lag-baseline.mjs ===');
  console.log('Hypothesis: lag is burst-contention from helper-fork serialization.\n');

  const A = await oneTrial({
    label: 'A-single',
    prompt: 'Run exactly ONE Bash command: `echo done`. Then reply with the word OK.',
  });
  console.log('Run A (single Bash):', JSON.stringify(A, null, 2));

  await new Promise((r) => setTimeout(r, 1000));

  const B = await oneTrial({
    label: 'B-burst',
    prompt: 'Run these six Bash commands one at a time: echo 1; echo 2; echo 3; echo 4; echo 5; echo 6. Then reply with the count.',
  });
  console.log('\nRun B (6-Bash burst):', JSON.stringify(B, null, 2));

  console.log('\n=== verdict ===');
  console.log(`single-call median:  ${A.median_ms} ms`);
  console.log(`6-burst median:      ${B.median_ms} ms`);
  console.log(`rc.42 baseline:      14 ms (tmux backend, observe-only)`);
  console.log('');
  if (A.median_ms < B.median_ms / 3) {
    console.log('hypothesis SUPPORTED: lag scales with burst size → fork-contention');
  } else {
    console.log('hypothesis NOT supported: lag is steady-state regardless of burst');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
