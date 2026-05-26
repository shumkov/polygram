#!/usr/bin/env node
// channels-first-turn — isolate "first user message after fresh spawn is
// swallowed" bug observed live on shumorobot 2026-05-26.
//
// Spawns a real ChannelsProcess against a real claude TUI, sends ONE
// user_msg, watches for the reply tool to fire. Captures the pane every
// 2 seconds so we can SEE what claude does. Times out after 90s.
//
// Run:  node scripts/spikes/channels-first-turn.mjs
//
// Expected: claude calls the reply tool within ~10s and the script prints
//   the reply text.
//
// Observed (broken):  claude receives the channel message, does some
//   internal tool calls, goes idle without calling reply. Script times out.

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);

const { ChannelsProcess } = require('../../lib/process/channels-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');

const CLAUDE_BIN = '/Users/ivanshumkov/.local/share/claude/versions/2.1.142';
const SESSION_KEY = 'spike-first-turn-' + Date.now();
const CHAT_ID = '-9999999999';

const tmuxRunner = createTmuxRunner({ logger: console });

// Track every tool call from claude and dump it.
const toolDispatcher = async ({ toolName, text, chatId }) => {
  console.log(`\n[TOOL DISPATCH] ${toolName} → chat=${chatId} text=${JSON.stringify(text?.slice(0, 200))}`);
  return { ok: true };
};

const proc = new ChannelsProcess({
  sessionKey: SESSION_KEY,
  chatId: CHAT_ID,
  threadId: null,
  label: 'spike',
  tmuxRunner,
  botName: 'spike',
  claudeBin: CLAUDE_BIN,
  toolDispatcher,
  logger: console,
  turnQuietMs: 2000,
  turnTimeoutMs: 60_000,
});

let paneSnapshots = 0;
const dumpPane = () => {
  paneSnapshots++;
  const session = proc.tmuxSession;
  if (!session) return;
  try {
    const out = spawnSync('tmux', ['capture-pane', '-t', session, '-p', '-S', '-50'], { encoding: 'utf8' });
    console.log(`\n=== pane snapshot #${paneSnapshots} (${session}) ===\n${out.stdout || out.stderr}\n=== end snapshot ===\n`);
  } catch (err) {
    console.error(`pane capture failed: ${err.message}`);
  }
};

const cleanup = async () => {
  try { await proc.kill('spike-done'); } catch {}
  process.exit(0);
};

proc.on('init', (info) => console.log(`\n[EVENT init] session_id=${info.session_id} backend=${info.backend}`));
proc.on('bridge-ready', () => console.log(`\n[EVENT bridge-ready]`));
proc.on('bridge-disconnected', () => console.log(`\n[EVENT bridge-disconnected]`));
proc.on('tool-use', (name) => console.log(`\n[EVENT tool-use] name=${name}`));
proc.on('thinking', () => console.log(`\n[EVENT thinking]`));
proc.on('idle', () => console.log(`\n[EVENT idle]`));
proc.on('result', (info, extras) => console.log(`\n[EVENT result] subtype=${info.subtype} text=${JSON.stringify(extras?.streamText?.slice(0, 200))}`));

const main = async () => {
  console.log('=== channels-first-turn spike ===');
  console.log(`session_key=${SESSION_KEY}  chat_id=${CHAT_ID}`);
  console.log(`claude_bin=${CLAUDE_BIN}`);
  console.log(`tmp_dir=${process.env.TMPDIR}`);
  console.log('\n[1/3] start()…');
  const t0 = Date.now();
  await proc.start({
    cwd: process.cwd(),
    agent: null,        // bare claude, no agent
    model: 'sonnet',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    // Music-topic config: isolateUserConfig → strict-mcp-config + setting-sources project,local
    isolateUserConfig: true,
  });
  console.log(`\n[1/3] start() done in ${Date.now() - t0}ms`);

  // Snapshot the pane right after start
  dumpPane();

  console.log('\n[2/3] send()…');
  const promise = proc.send('Reply with the literal text: PONG. Nothing else.', {
    context: { user: 'spike', sourceMsgId: '1' },
  });

  // Snapshot every 5s while waiting for reply
  const interval = setInterval(dumpPane, 5000);

  try {
    const result = await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test-timeout 75s')), 75_000)),
    ]);
    clearInterval(interval);
    console.log('\n[2/3] send() result:');
    console.log(JSON.stringify({ text: result.text?.slice(0, 200), subtype: result.metrics?.resultSubtype }, null, 2));
  } catch (err) {
    clearInterval(interval);
    console.error(`\n[2/3] send() FAILED: ${err.message}`);
    dumpPane();
  }

  console.log('\n[3/3] cleanup');
  await cleanup();
};

main().catch(async err => {
  console.error(`\n[FATAL] ${err.stack || err.message}`);
  await cleanup();
});

// Safety net — kill the spike after 120s no matter what
setTimeout(() => {
  console.error('\n[HARD-CAP 120s] killing');
  cleanup();
}, 120_000).unref();
