#!/usr/bin/env node
/**
 * cli-driver-spike/measure-lag.mjs — Phase 0.4.
 *
 * Measures end-to-end lag from hook FIRE (helper writes to ndjson) to
 * polygram receiving the event in-memory via LogTail. Same instrumentation
 * pattern as scripts/spikes/h1-hook-lag-diag.mjs (tmux backend) — adapted
 * for the CliProcess hybrid (channels bridge + hooks).
 *
 * Per-event measurement:
 *   helper_write_ms = polygram_received_at_ms   (helper stamps via Date.now)
 *   emit_lag_ms     = t_emit_in_memory - helper_write_ms
 *
 * Target: comparable to rc.42 production (median 14ms / p95 22ms).
 *
 * Prompt deliberately triggers ~6 PreToolUse + 6 PostToolUse to get
 * a useful sample size from one $0.10-$0.30 turn.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { ChannelsProcess }   = require('../../lib/process/channels-process.js');
const { createTmuxRunner }  = require('../../lib/tmux/tmux-runner.js');
const { writeHookFiles }    = require('../../lib/process/hook-settings.js');
const { createHookTail }    = require('../../lib/process/hook-event-tail.js');

const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || '/Users/ivanshumkov/.local/share/claude/versions/2.1.142';

const BOT_NAME    = 'cli-spike';
const SESSION_KEY = `cli-driver-spike-lag-${Date.now()}`;
const CHAT_ID     = '-9999999999';
const SPIKE_CWD   = process.cwd();

const OUT_DIR = path.join(os.tmpdir(), SESSION_KEY);
fs.mkdirSync(OUT_DIR, { recursive: true });
const FINDINGS_PATH = path.join(OUT_DIR, 'findings.json');

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs, p) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

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

async function main() {
  console.log('=== cli-driver-spike measure-lag.mjs (Phase 0.4) ===');
  console.log(`session_key  = ${SESSION_KEY}`);
  console.log(`out_dir      = ${OUT_DIR}\n`);

  const { settingsPath, ndjsonPath } = writeHookFiles({
    botName: BOT_NAME,
    sessionId: SESSION_KEY,
    hooksDir: OUT_DIR,
  });

  // Capture t_emit per event by stamping at the moment the tail emits.
  // We correlate to ndjson lines via (hook_event_name, tool_use_id || index).
  const emitRecords = [];   // {t_emit_ms, type, toolUseId, agentId, toolName}
  const hookTail = createHookTail({ path: ndjsonPath, logger: console });
  hookTail.on('event', (ev) => {
    emitRecords.push({
      t_emit_ms: Date.now(),
      type: ev.type,
      toolUseId: ev.toolUseId,
      agentId: ev.agentId,
      toolName: ev.toolName,
    });
  });
  await hookTail.start();

  const realRunner    = createTmuxRunner({ logger: console });
  const wrappedRunner = wrapRunner(realRunner, settingsPath);

  const proc = new ChannelsProcess({
    sessionKey:    SESSION_KEY,
    chatId:        CHAT_ID,
    threadId:      null,
    label:         'spike',
    tmuxRunner:    wrappedRunner,
    botName:       BOT_NAME,
    claudeBin:     CLAUDE_BIN,
    toolDispatcher: async () => ({ ok: true }),
    logger:        console,
    turnQuietMs:   3000,
    turnTimeoutMs: 180_000,
  });

  proc.on('init',         () => console.log('[channel init]'));
  proc.on('bridge-ready', () => console.log('[channel bridge-ready]'));
  proc.on('tool-use',     (n) => console.log(`[channel tool-use] ${n}`));
  proc.on('result',       (i) => console.log(`[channel result] ${i?.subtype}`));

  console.log('[1/3] start()…');
  await proc.start({
    cwd: SPIKE_CWD,
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'bypassPermissions',
  });
  console.log('[1/3] start() done\n');

  // Prompt: trigger many Bash calls back-to-back for a useful sample.
  console.log('[2/3] sending many-Bash prompt…');
  const prompt = `Run these six Bash commands one at a time (one per tool call), then reply with the count of how many you ran:\n` +
    `1. echo one\n2. echo two\n3. echo three\n4. echo four\n5. echo five\n6. echo six\n` +
    `Important: one Bash tool call per command, in sequence. Don't combine them.`;
  await proc.send(prompt, { context: { chatId: CHAT_ID, user: 'spike-tester', sourceMsgId: 1 } });
  console.log('[2/3] send() done\n');

  console.log('[3/3] waiting 2s for tail-races + Stop…');
  await new Promise((r) => setTimeout(r, 2000));
  await proc.kill('spike-done').catch(() => {});
  try { hookTail.close(); } catch {}

  // Parse the ndjson with polygram_received_at_ms timestamps and correlate
  // by (type, toolUseId) to in-memory emit timestamps.
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  const helperRecords = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  // Correlate: each emitRecord should match a helperRecord by hook_event_name
  // + tool_use_id. For events without tool_use_id (UserPromptSubmit, Stop),
  // match in disk-write order.
  const lagsByType = new Map();   // type → [emit_lag_ms, ...]
  const usedHelperIdx = new Set();
  for (const emit of emitRecords) {
    let matchIdx = -1;
    for (let i = 0; i < helperRecords.length; i++) {
      if (usedHelperIdx.has(i)) continue;
      const h = helperRecords[i];
      if (h.hook_event_name !== emit.type) continue;
      if (emit.toolUseId && h.tool_use_id !== emit.toolUseId) continue;
      matchIdx = i;
      break;
    }
    if (matchIdx === -1) continue;
    usedHelperIdx.add(matchIdx);
    const helperWriteMs = helperRecords[matchIdx].polygram_received_at_ms;
    if (!Number.isFinite(helperWriteMs)) continue;
    const lag = emit.t_emit_ms - helperWriteMs;
    if (!lagsByType.has(emit.type)) lagsByType.set(emit.type, []);
    lagsByType.get(emit.type).push(lag);
  }

  const allLags = [];
  for (const lags of lagsByType.values()) allLags.push(...lags);

  const verdict = {
    timestamp: new Date().toISOString(),
    sessionKey: SESSION_KEY,
    sampleSize: allLags.length,
    perType: Object.fromEntries(
      [...lagsByType.entries()].map(([t, ls]) => [t, {
        count: ls.length,
        median_ms: median(ls),
        p95_ms: pct(ls, 0.95),
        max_ms: Math.max(...ls),
      }]),
    ),
    aggregate: {
      count: allLags.length,
      median_ms: median(allLags),
      p95_ms: pct(allLags, 0.95),
      max_ms: allLags.length ? Math.max(...allLags) : NaN,
    },
    rc42Baseline: { median_ms: 14, p95_ms: 22 },
    // PASS if median ≤ 50ms and p95 ≤ 100ms (looser than rc42 since spike
    // environment differs from production soak; we want comparable order
    // of magnitude, not exact match).
    pass: allLags.length >= 6
      && median(allLags) <= 50
      && pct(allLags, 0.95) <= 100,
  };

  fs.writeFileSync(FINDINGS_PATH, JSON.stringify(verdict, null, 2));

  console.log('\n=== verdict ===');
  console.log(JSON.stringify(verdict, null, 2));
  console.log(`\nartifacts: ${OUT_DIR}`);
  process.exit(verdict.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.stack || err.message);
  process.exit(2);
});
