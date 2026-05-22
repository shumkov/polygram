#!/usr/bin/env node
/**
 * h1-hook-lag-diag — measures end-to-end lag from claude-CLI hook
 * firing to polygram receiving the event in-memory.
 *
 * Discovered during rc.36 Music soak: hook events landed in the
 * events DB minutes after the ndjson was written. The chain is
 *   helper writes line → LogTail picks it up → 'event' emitted →
 *   pm callback → logEvent → SQLite.
 * Need to bisect WHERE the lag lives so H2 (reactor wiring) can
 * trust the in-memory stream.
 *
 * Approach:
 *   1. Spawn a real TUI with H1 hook injection.
 *   2. Subscribe to `'hook-event'` on the process. Stamp `t_emit`
 *      (Date.now()) when each event lands in-memory.
 *   3. Send a prompt that fires N Bash tool calls (deterministic
 *      hook fire pattern: 1 UserPromptSubmit + N×Pre + N×Post + 1
 *      Stop).
 *   4. After settle, read the ndjson — each line carries
 *      `polygram_received_at_ms` (helper write time = ground-truth
 *      hook-fire time). Match in-memory events to ndjson lines by
 *      `(hook_event_name, tool_use_id || prompt-prefix)`.
 *   5. Print per-event:
 *        helper_write_ms = polygram_received_at_ms
 *        emit_lag_ms     = t_emit - helper_write_ms
 *      Report median, p95, max, and the per-event sequence so we
 *      see if lag is uniform (LogTail constant overhead),
 *      monotonically growing (queue backing up), or batchy (flush
 *      at turn-end).
 *
 * Cost: ~$0.05-0.10 (10 Bash tool calls on sonnet/low).
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');

const execFileP = promisify(execFile);
const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

async function killTmuxSession(name) {
  try { await execFileP('tmux', ['kill-session', '-t', name]); } catch {}
}

function ms(n) { return `${n.toString().padStart(6)} ms`; }

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

async function main() {
  const N_TOOLS = 6;
  const runner = createTmuxRunner({ logger: console });
  const cwd = path.resolve(process.cwd());
  const label = 'h1-lag';
  const tmuxName = runner.sessionName('spike', 'spike', label);
  await killTmuxSession(tmuxName);
  // Remove any leftover hook files from a prior run so the ndjson
  // we read at the end is JUST this run's events.
  const hooksDir = path.join(process.env.HOME, '.polygram', 'spike', 'hooks');
  try { fs.rmSync(hooksDir, { recursive: true, force: true }); } catch {}

  const p = new TmuxProcess({
    sessionKey: 'spike:h1-lag',
    chatId: 'spike',
    threadId: label,
    label: `spike-${label}`,
    runner,
    botName: 'spike',
    logger: SILENT,
    readyTimeoutMs: 60_000,
    turnTimeoutMs: 180_000,
  });

  // Record every in-memory hook-event arrival.
  const inmem = [];
  p.on('hook-event', (ev) => {
    inmem.push({
      t_emit: Date.now(),
      type: ev.type,
      toolName: ev.toolName,
      toolUseId: ev.toolUseId,
      receivedAtMs: ev.receivedAtMs,
      promptPrefix: ev.prompt ? ev.prompt.slice(0, 40) : null,
    });
  });

  await p.start({
    chatConfig: {
      model: 'sonnet', effort: 'low', cwd,
      permissionMode: 'bypassPermissions',
    },
  });

  // Deterministic hook fire pattern: N Bash tools + 1 final reply.
  console.log(`firing ${N_TOOLS} Bash tools…`);
  const t_send = Date.now();
  const res = await p.send(
    `Use the Bash tool ${N_TOOLS} times in a row to run \`date +%s%N\`. `
    + `After all ${N_TOOLS} calls, reply ONLY with "LAG_DONE".`,
  );
  const t_done = Date.now();
  console.log(`turn done in ${t_done - t_send} ms (reply=${JSON.stringify(res.text?.slice(0,40))})`);

  // Brief settle to let any trailing PostToolUse/Stop hooks land.
  await new Promise((r) => setTimeout(r, 1500));

  // Find the ndjson the daemon used for this spawn.
  const ndjsonPath = p._hookNdjsonPath;
  if (!ndjsonPath || !fs.existsSync(ndjsonPath)) {
    console.error(`FAIL: ndjson not found at ${ndjsonPath}`);
    await p.kill('spike-done');
    await killTmuxSession(tmuxName);
    process.exit(1);
  }

  // Parse ndjson for ground truth.
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  const ondisk = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  console.log('');
  console.log(`ndjson lines on disk: ${ondisk.length}, in-memory events received: ${inmem.length}`);
  if (ondisk.length !== inmem.length) {
    console.error(`MISMATCH: ${ondisk.length} on disk vs ${inmem.length} in-mem — lost events?`);
  }

  // Match in-memory events to ndjson by receivedAtMs (1:1 — helper
  // stamps unique ms-precision timestamps per write).
  const lags = [];
  console.log('');
  console.log('per-event lag (helper_write → in-mem emit):');
  console.log('  idx | type             | tool        | lag_ms');
  for (let i = 0; i < inmem.length; i++) {
    const e = inmem[i];
    const lag = e.t_emit - e.receivedAtMs;
    lags.push(lag);
    console.log(`  ${String(i).padStart(3)} | ${(e.type || '?').padEnd(16)} | ${(e.toolName || '-').padEnd(10)} | ${ms(lag)}`);
  }

  if (lags.length > 0) {
    console.log('');
    console.log('summary:');
    console.log(`  count    ${lags.length}`);
    console.log(`  min      ${ms(Math.min(...lags))}`);
    console.log(`  median   ${ms(median(lags))}`);
    console.log(`  p95      ${ms(p95(lags))}`);
    console.log(`  max      ${ms(Math.max(...lags))}`);
  }

  // Diagnosis hints.
  console.log('');
  if (lags.every((l) => l < 100)) {
    console.log('DIAGNOSIS: lag is <100 ms across the board — pipeline is healthy.');
  } else if (lags.every((l) => l < 1500)) {
    console.log('DIAGNOSIS: lag is <1500 ms — likely fs.watch fallback to 1 s safety-net poll.');
  } else if (lags.every((l) => Math.abs(l - lags[0]) < 500)) {
    console.log('DIAGNOSIS: uniform large lag — constant overhead somewhere (event loop block?).');
  } else if (lags[lags.length - 1] > lags[0] * 2) {
    console.log('DIAGNOSIS: lag GROWS over the turn — queue/buffer backing up.');
  } else {
    console.log('DIAGNOSIS: pattern unclear — inspect the per-event table above.');
  }

  await p.kill('spike-done');
  await killTmuxSession(tmuxName);
}

main().catch((err) => {
  console.error('SPIKE FAIL:', err);
  process.exit(1);
});
