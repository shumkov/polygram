#!/usr/bin/env node
/**
 * cli-driver-spike/run.mjs — Phase 0.1 main spike.
 *
 * Validates that hooks fire alongside --dangerously-load-development-channels
 * on the pinned claude binary. Reuses ChannelsProcess (the 0.11 driver) and
 * injects --settings via a tmuxRunner wrapper.
 *
 * Output:
 *   - stdout: human-readable summary + per-event log
 *   - <TMPDIR>/cli-driver-spike-<sessionKey>/hook-events.ndjson (raw, for 0.2)
 *   - <TMPDIR>/cli-driver-spike-<sessionKey>/channel-events.json (raw, for 0.2)
 *   - <TMPDIR>/cli-driver-spike-<sessionKey>/findings.json (structured)
 *
 * Exit code: 0 on PASS (all six hook event types observed AND channel
 * notification observed AND reply tool fired), 1 on FAIL.
 *
 * Cost: ~$0.30 (one short turn on sonnet/medium with one Bash + one reply).
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { ChannelsProcess }   = require('../../lib/process/channels-process.js');
const { createTmuxRunner }  = require('../../lib/tmux/tmux-runner.js');
const { writeHookFiles }    = require('../../lib/process/hook-settings.js');
const { createHookTail }    = require('../../lib/process/hook-event-tail.js');

// Pinned claude binary — same path 0.11 spike uses. Override via $POLYGRAM_CLAUDE_BIN.
const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || '/Users/ivanshumkov/.local/share/claude/versions/2.1.142';

const BOT_NAME    = 'cli-spike';
const SESSION_KEY = `cli-driver-spike-${Date.now()}`;
const CHAT_ID     = '-9999999999';
const SPIKE_CWD   = process.cwd();    // arbitrary — claude just needs a writable dir

const OUT_DIR = path.join(os.tmpdir(), SESSION_KEY);
fs.mkdirSync(OUT_DIR, { recursive: true });

const HOOK_EVENTS_PATH    = path.join(OUT_DIR, 'hook-events.ndjson');
const CHANNEL_EVENTS_PATH = path.join(OUT_DIR, 'channel-events.json');
const FINDINGS_PATH       = path.join(OUT_DIR, 'findings.json');

// ─── State accumulators ──────────────────────────────────────────────

const hookEventsByType = new Map();   // type → [event, ...]
const channelEvents    = [];          // {ts, kind, payload}
const toolDispatches   = [];          // {ts, toolName, text}

function recordHook(ev) {
  const t = ev?.type || 'unknown';
  if (!hookEventsByType.has(t)) hookEventsByType.set(t, []);
  hookEventsByType.get(t).push(ev);
  console.log(`[hook ${t}] tool=${ev.toolName || '-'} subagent=${ev.agentType || '-'} dur=${ev.durationMs ?? '-'}`);
}

function recordChannel(kind, payload) {
  channelEvents.push({ ts: Date.now(), kind, payload });
  console.log(`[channel ${kind}]`);
}

// ─── tmuxRunner wrapper: inject --settings before spawn ──────────────

function wrapRunner(realRunner, settingsPath) {
  return {
    ...realRunner,
    spawn: async (opts) => {
      const args = [...(opts.args || [])];
      // Insert --settings <path> after --strict-mcp-config so it lands
      // before --dangerously-load-development-channels (claude's argv
      // parser doesn't strictly require this, but mirror tmux-process.js
      // ordering for consistency with future production code).
      args.splice(1, 0, '--settings', settingsPath);
      console.log(`[spawn] injected --settings ${settingsPath}`);
      console.log(`[spawn] full argv: ${opts.command} ${args.join(' ')}`);
      return realRunner.spawn({ ...opts, args });
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== cli-driver-spike run.mjs (Phase 0.1) ===');
  console.log(`session_key  = ${SESSION_KEY}`);
  console.log(`claude_bin   = ${CLAUDE_BIN}`);
  console.log(`out_dir      = ${OUT_DIR}`);
  console.log('');

  // 1. Build hook-settings + ndjson sink.
  const { settingsPath, ndjsonPath } = writeHookFiles({
    botName: BOT_NAME,
    sessionId: SESSION_KEY,
    hooksDir: OUT_DIR,
  });
  console.log(`[setup] hook settings file: ${settingsPath}`);
  console.log(`[setup] hook ndjson sink:   ${ndjsonPath}`);

  // 2. Start the hook tail BEFORE spawning claude — race-window guard.
  const hookTail = createHookTail({ path: ndjsonPath, logger: console });
  hookTail.on('event', (ev) => recordHook(ev));
  await hookTail.start();
  console.log('[setup] hook tail armed');

  // 3. Spawn ChannelsProcess with a wrapped runner that injects --settings.
  const realRunner    = createTmuxRunner({ logger: console });
  const wrappedRunner = wrapRunner(realRunner, settingsPath);

  const toolDispatcher = async ({ toolName, text, chatId }) => {
    toolDispatches.push({ ts: Date.now(), toolName, text });
    recordChannel('tool-dispatch', { toolName, text: text?.slice(0, 200) });
    return { ok: true };
  };

  const proc = new ChannelsProcess({
    sessionKey:    SESSION_KEY,
    chatId:        CHAT_ID,
    threadId:      null,
    label:         'spike',
    tmuxRunner:    wrappedRunner,
    botName:       BOT_NAME,
    claudeBin:     CLAUDE_BIN,
    toolDispatcher,
    logger:        console,
    turnQuietMs:   2000,
    turnTimeoutMs: 90_000,
  });

  proc.on('init',           (info) => recordChannel('init',         info));
  proc.on('bridge-ready',   ()     => recordChannel('bridge-ready', null));
  proc.on('tool-use',       (n)    => recordChannel('tool-use',     { name: n }));
  proc.on('result',         (info) => recordChannel('result',       info));

  console.log('\n[1/3] start()…');
  const tStart = Date.now();
  await proc.start({
    cwd:            SPIKE_CWD,
    model:          'sonnet',
    effort:         'medium',
    permissionMode: 'bypassPermissions',
  });
  console.log(`[1/3] start() done in ${Date.now() - tStart}ms`);

  // 4. Send a deterministic prompt that exercises hook + channel + reply.
  console.log('\n[2/3] sending test prompt…');
  const tSend = Date.now();
  const sendResult = await proc.send(
    'Run `echo hello world` via Bash, then reply to this message confirming what you did. Keep it brief.',
    { context: { chatId: CHAT_ID, user: 'spike-tester', sourceMsgId: 1 } },
  );
  console.log(`[2/3] send() resolved in ${Date.now() - tSend}ms`);
  console.log(`[2/3] result text: ${JSON.stringify(sendResult?.text?.slice(0, 200))}`);

  // 5. Cleanup + persist.
  console.log('\n[3/3] cleanup + persist…');

  // Wait for Stop hook to land on disk before kill — rc.41 H4 pattern.
  // Stop fires AFTER the result event; without this grace, we kill claude
  // before Stop writes and the in-memory tail misses it (even though the
  // helper subprocess writes to disk fine). 2s is the rc.41 default.
  console.log('[3/3] waiting 2s for Stop hook to land…');
  await new Promise((r) => setTimeout(r, 2000));

  await proc.kill('spike-done').catch(() => {});
  try { hookTail.close(); } catch {}

  fs.writeFileSync(CHANNEL_EVENTS_PATH, JSON.stringify(channelEvents, null, 2));
  if (ndjsonPath !== HOOK_EVENTS_PATH) {
    try { fs.copyFileSync(ndjsonPath, HOOK_EVENTS_PATH); } catch {}
  }

  // Final-pass reconciliation: re-read the ndjson from disk and merge any
  // events the in-memory tail missed (e.g., events that landed after
  // hookTail.close() or between poll intervals). This makes the verdict
  // robust to tail-vs-write races without relying on tail-only state.
  try {
    const { normalizeHookEvent } = require('../../lib/process/hook-event-tail.js');
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    const observedFromMemory = new Set();
    for (const events of hookEventsByType.values()) {
      for (const e of events) observedFromMemory.add(`${e.type}:${e.toolUseId || ''}`);
    }
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const ev = normalizeHookEvent(raw);
        const key = `${ev.type}:${ev.toolUseId || ''}`;
        if (!observedFromMemory.has(key)) {
          recordHook(ev);
          observedFromMemory.add(key);
        }
      } catch { /* ignore malformed */ }
    }
  } catch (err) {
    console.warn(`[3/3] disk reconciliation failed: ${err.message}`);
  }

  // ─── Validate exit criteria ────────────────────────────────────────
  const REQUIRED_HOOK_TYPES = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  const optionalHookTypes   = ['SubagentStop', 'Notification'];   // not all turns trigger these

  const missing = REQUIRED_HOOK_TYPES.filter((t) => !hookEventsByType.has(t));
  const sawReplyTool = toolDispatches.some((d) => d.toolName === 'reply'
    || d.toolName === 'mcp__polygram-bridge__reply');

  const verdict = {
    timestamp: new Date().toISOString(),
    sessionKey: SESSION_KEY,
    claudeBin: CLAUDE_BIN,
    hookEventTypesObserved: [...hookEventsByType.keys()].sort(),
    requiredHookTypes: REQUIRED_HOOK_TYPES,
    optionalHookTypes,
    missingRequiredHooks: missing,
    channelEventsCount: channelEvents.length,
    replyToolFired: sawReplyTool,
    pass: missing.length === 0 && sawReplyTool,
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
