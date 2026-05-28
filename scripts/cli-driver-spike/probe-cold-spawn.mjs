#!/usr/bin/env node
/**
 * cli-driver-spike/probe-cold-spawn.mjs — Phase 0 follow-up investigation.
 *
 * Validates the hypothesis from 0.3.A:
 *   "Cold-spawn flake — when handshake → user_msg-rx gap is <50ms,
 *    claude's MCP server registration for polygram-bridge hasn't completed,
 *    so the bridge's mcp.notification() gets silently dropped."
 *
 * Compares two scenarios:
 *   Run A: send user_msg immediately after start() (no delay)
 *   Run B: send user_msg with 500ms delay after start()
 *
 * Hypothesis says: Run A flakes occasionally; Run B is reliable.
 *
 * Three trials each. Pass = all six runs succeed; otherwise we surface
 * the flake distribution.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { CliProcess }   = require('../../lib/process/cli-process.js');
const { createTmuxRunner }  = require('../../lib/tmux/tmux-runner.js');
const { writeHookFiles }    = require('../../lib/process/hook-settings.js');

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

async function oneTrial({ label, postStartDelayMs }) {
  const sessionKey = `cli-probe-${label}-${Date.now()}`;
  const outDir = path.join(os.tmpdir(), sessionKey);
  fs.mkdirSync(outDir, { recursive: true });

  const { settingsPath } = writeHookFiles({
    botName: 'cli-spike',
    sessionId: sessionKey,
    hooksDir: outDir,
  });

  const realRunner = createTmuxRunner({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const wrapped = wrapRunner(realRunner, settingsPath);

  const proc = new CliProcess({
    sessionKey, chatId: '-9999999999', threadId: null, label: 'probe',
    tmuxRunner: wrapped, botName: 'cli-spike', claudeBin: CLAUDE_BIN,
    toolDispatcher: async () => ({ ok: true }),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    turnQuietMs: 2000,
    turnTimeoutMs: 30_000,   // tight: if it's going to flake, it'll flake fast
  });

  let succeeded = false;
  let error = null;
  const tStart = Date.now();
  try {
    await proc.start({
      cwd: process.cwd(),
      model: 'sonnet',
      effort: 'low',         // cheapest possible
      permissionMode: 'bypassPermissions',
    });
    const tHandshakeDone = Date.now();
    if (postStartDelayMs > 0) {
      await new Promise((r) => setTimeout(r, postStartDelayMs));
    }
    const tSendStart = Date.now();
    const result = await proc.send('Reply with the single word OK.', {
      context: { chatId: '-9999999999', user: 'probe', sourceMsgId: 1 },
    });
    const tSendDone = Date.now();
    succeeded = (typeof result?.text === 'string' && result.text.length > 0);
    return {
      label, postStartDelayMs, succeeded,
      handshake_ms: tHandshakeDone - tStart,
      delay_ms:     tSendStart - tHandshakeDone,
      send_ms:      tSendDone - tSendStart,
      total_ms:     tSendDone - tStart,
      replyText:    result?.text?.slice(0, 100),
    };
  } catch (err) {
    error = err.message;
    return {
      label, postStartDelayMs, succeeded: false, error,
      elapsed_ms: Date.now() - tStart,
    };
  } finally {
    await proc.kill('probe-done').catch(() => {});
  }
}

async function main() {
  console.log('=== cli-driver-spike probe-cold-spawn.mjs ===\n');
  console.log('Hypothesis: handshake → user_msg-rx gap <50ms ⇒ flake.');
  console.log('Run A (no delay) vs Run B (500ms delay), 3 trials each.\n');

  const trials = [];

  for (const i of [1, 2, 3]) {
    console.log(`--- A-${i} (no delay) ---`);
    const r = await oneTrial({ label: `A-${i}`, postStartDelayMs: 0 });
    trials.push(r);
    console.log(JSON.stringify(r, null, 2));
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const i of [1, 2, 3]) {
    console.log(`--- B-${i} (500ms delay) ---`);
    const r = await oneTrial({ label: `B-${i}`, postStartDelayMs: 500 });
    trials.push(r);
    console.log(JSON.stringify(r, null, 2));
    await new Promise((r) => setTimeout(r, 1000));
  }

  const A = trials.filter((t) => t.label.startsWith('A-'));
  const B = trials.filter((t) => t.label.startsWith('B-'));

  const summary = {
    A_no_delay: {
      total: A.length,
      succeeded: A.filter((t) => t.succeeded).length,
      failed: A.filter((t) => !t.succeeded).length,
    },
    B_500ms_delay: {
      total: B.length,
      succeeded: B.filter((t) => t.succeeded).length,
      failed: B.filter((t) => !t.succeeded).length,
    },
  };

  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));

  const hypothesisSupported =
    summary.A_no_delay.failed > 0 &&
    summary.B_500ms_delay.failed === 0;
  console.log(`\nhypothesis_supported: ${hypothesisSupported}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.stack || err.message);
  process.exit(2);
});
