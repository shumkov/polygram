'use strict';

/**
 * E2E — REAL claude channels round-trip.
 *
 * Every other test mocks the claude spawn, so none exercise the actual
 * `--dangerously-load-development-channels` bridge flow. That blind spot is
 * exactly how the rc.11 regression slipped through: claude prints a BENIGN
 * banner "server:polygram-bridge  no MCP server configured with that name" on
 * every healthy session, and a pane matcher false-killed live turns — invisible
 * to the mocked suite (the fake runner never produces that banner).
 *
 * This test spawns a REAL claude in tmux with the REAL ChannelsBridgeServer,
 * sends one user message through the channel, and asserts:
 *   1. claude replies through the bridge reply tool (channel round-trip works),
 *   2. NO 'bridge-disconnected' fires during the turn (the benign banner does
 *      NOT false-kill the session — the rc.14 regression guard).
 *
 * GATED: only runs with E2E_REAL_CLAUDE=1 (spawns real claude, needs the
 * pinned binary + a working subscription/keychain; not for CI). Run with:
 *   E2E_REAL_CLAUDE=1 node --test --test-force-exit tests/e2e-channels-real-claude.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../lib/process/cli-process');
const { createTmuxRunner } = require('../lib/tmux/tmux-runner');
const { resolvePinnedClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('../lib/claude-bin');

const RUN = process.env.E2E_REAL_CLAUDE === '1';

const noopStreamer = {
  onChunk: async () => {}, forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {},
};
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };

test('e2e: real claude channels round-trip — reply delivered, NO false bridge-disconnect', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  // Faithful repro: the EXACT Music-topic spawn (rekordbox cwd, music-curator
  // agent, isolateUserConfig) — the config that regressed. A fresh temp cwd
  // would hit claude's "trust this folder" dialog (untrusted), which the
  // startup gate doesn't navigate; rekordbox is already trusted, like prod.
  const cwd = '/Users/ivanshumkov/Music/rekordbox';
  const chatConfig = {
    agent: 'music-curation:music-curator',
    cwd,
    permissionMode: 'bypassPermissions',
    isolateUserConfig: true,
  };
  const replies = [];
  let bridgeDisconnected = false;

  const proc = new CliProcess({
    sessionKey: 'e2e-chan:1',
    chatId: '987654321',
    threadId: null,
    label: 'e2e-chan',
    tmuxRunner: createTmuxRunner(),
    botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => {
      if (toolName === 'reply') replies.push(text);
      return { ok: true };
    },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
  proc.on('bridge-disconnected', () => { bridgeDisconnected = true; });

  try {
    // start() spawns real claude, navigates the dev-channels confirmation
    // dialog via the startup gate, waits mcp-ready — the exact prod path.
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    const result = await proc.send('Reply with exactly the single word: PONGTEST', {
      timeoutMs: 120_000,
      maxTurnMs: 150_000,
      context: { streamer: noopStreamer, reactor: noopReactor, threadId: null },
    });

    const replyText = replies.join(' ') + ' ' + (result?.text || '');
    assert.match(
      replyText, /PONGTEST/i,
      `claude must deliver its reply through the channel bridge. replies=${JSON.stringify(replies)} result=${JSON.stringify(result).slice(0, 200)}`,
    );
    assert.equal(
      bridgeDisconnected, false,
      "the benign 'no MCP server configured' banner must NOT trigger a false bridge-disconnect mid-turn (rc.14 regression guard)",
    );

    // Turn-end observability premise: polygram resolves turns off hooks (the
    // 0.12 channels+hooks design), so the Stop hook MUST be written to the
    // ndjson. If this is empty, the whole hook pipeline is broken (the cause
    // of the 2026-06-02 stuck-turn) and no turn-resolution logic can work.
    const hookNdjson = proc._hookNdjsonPath;
    const hookContent = (hookNdjson && fs.existsSync(hookNdjson)) ? fs.readFileSync(hookNdjson, 'utf8') : '';
    assert.match(
      hookContent, /"hook_event_name"\s*:\s*"Stop"/,
      `the Stop hook MUST land in the ndjson (turn-end is observed via hooks, not the pane). ndjson=${hookNdjson} size=${hookContent.length}`,
    );
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});
