'use strict';
/**
 * P0.5 spike: does claude's Esc-Esc rewind menu list BRIDGE-delivered messages
 * (channels backend) as checkpoints, and what text does it show? Drives the real
 * ChannelsBridgeServer + claude TUI like the E2E, then operates the rewind menu
 * via tmux send-keys + capture-pane. Run: node scripts/spikes/rewind-channels-spike.js
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../../lib/process/cli-process');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner');
const { resolvePinnedClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('../../lib/claude-bin');

const noopStreamer = { onChunk: async () => {}, forceNewMessage: () => {}, finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {} };
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (a) => { try { return cp.execSync(`tmux ${a}`, { encoding: 'utf8' }); } catch (e) { return `<tmux err: ${e.message}>`; } };
const cap = (s) => tmux(`capture-pane -t ${s} -p`);
const tail = (txt, n) => txt.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-rwspike-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  const proc = new CliProcess({
    sessionKey: 'rwspike:1', chatId: '987654399', threadId: null, label: 'rwspike',
    tmuxRunner: createTmuxRunner(), botName: 'rwspike',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true, message_id: replies.length }; },
    logger: { warn: () => {}, error: (...a) => console.error('[err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });
    const sess = proc.tmuxSession;
    console.log('=== TMUX SESSION:', sess, '===');
    const ctx = { streamer: noopStreamer, reactor: noopReactor, threadId: null };
    for (const [cw, ok] of [['APPLE', 'OK1'], ['BANANA', 'OK2'], ['CHERRY', 'OK3']]) {
      await proc.send(`Remember the codeword ${cw}. Reply with exactly: ${ok}`, { timeoutMs: 100_000, maxTurnMs: 120_000, context: ctx });
    }
    console.log('=== replies via bridge:', JSON.stringify(replies), '===');

    // Open the rewind menu on the bridge session's pane.
    tmux(`send-keys -t ${sess} C-u`); await sleep(1500);
    tmux(`send-keys -t ${sess} Escape Escape`); await sleep(3000);
    console.log('\n=== REWIND MENU (bridge session) ===');
    console.log(tail(cap(sess), 26));

    // Does the menu mention our codewords? (i.e. bridge messages = checkpoints)
    const menu = cap(sess);
    for (const cw of ['APPLE', 'BANANA', 'CHERRY']) {
      console.log(`menu lists ${cw}: ${menu.includes(cw)}`);
    }
    // leave the menu; don't actually rewind in this gating check
    tmux(`send-keys -t ${sess} Escape`); await sleep(800);
  } catch (e) {
    console.error('SPIKE ERROR:', e && e.stack || e);
  } finally {
    try { await proc.kill('spike-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
})();
