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

// 0.12 interactive questions: the FULL round-trip against real claude — claude
// calls the `ask` tool, the daemon emits 'question-asked' (no TUI widget, no
// wedge), we hand the answer back via writeQuestionAnswer, and claude continues
// with the selection. This validates the bridge `ask` CallTool + question_answer
// transport + the daemon emit/keep-alive end-to-end (the part unit tests can't).
test('e2e: real claude — ask tool round-trip (question emitted, answer flows back)', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-ask-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  const asked = [];
  let chosenLabel = null;

  const proc = new CliProcess({
    sessionKey: 'e2e-ask:1', chatId: '987654323', threadId: null, label: 'e2e-ask',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  // When claude asks, answer it: pick the first option + hand it back to the tool.
  proc.on('question-asked', (ev) => {
    asked.push(ev);
    const q = ev.questions?.[0];
    if (!q || !Array.isArray(q.options) || !q.options.length) return;
    chosenLabel = q.options[0].label;
    proc.writeQuestionAnswer(ev.toolCallId, { answers: [{ header: q.header || '', selected: [chosenLabel] }] });
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    const result = await proc.send(
      'Use the `mcp__polygram-bridge__ask` tool to ask me ONE question: "Cats or dogs?" with exactly two '
      + 'options labelled "Cats" and "Dogs". After I answer, reply (via the reply tool) with EXACTLY: '
      + '"You picked: <the label I chose>".',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );

    assert.ok(asked.length >= 1, `claude must call the ask tool. asked=${JSON.stringify(asked).slice(0, 200)}`);
    assert.ok((asked[0].questions?.[0]?.options?.length || 0) >= 2, 'the question carried its options');
    assert.equal(asked[0].toolCallId && typeof asked[0].toolCallId, 'string');

    const replyText = replies.join(' ') + ' ' + (result?.text || '');
    assert.ok(chosenLabel, 'we recorded a chosen label');
    assert.match(
      replyText, new RegExp(chosenLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `claude must continue and confirm the chosen label "${chosenLabel}" after the answer flowed back. replyText=${replyText.slice(0, 200)}`,
    );
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// 0.13 edit_message: the FULL round-trip against real claude — claude sends a
// status via `reply`, READS the message_id we return through the bridge, then
// calls `edit_message` with that SAME id. Validates the new bridge behavior
// (reply returns {ok,message_id}; edit_message routes through the dispatcher) —
// the parts unit tests can't cover (the bridge .mjs CallTool + tool_ack id surfacing).
test('e2e: real claude — edit_message round-trip (reply returns id, edit targets it)', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-edit-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const REPLY_MSG_ID = 7777;          // the id we hand back from the fake reply
  const replies = [];
  const edits = [];                   // { messageId, text }

  const proc = new CliProcess({
    sessionKey: 'e2e-edit:1', chatId: '987654324', threadId: null, label: 'e2e-edit',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text, messageId }) => {
      if (toolName === 'reply') { replies.push(text); return { ok: true, message_id: REPLY_MSG_ID }; }
      if (toolName === 'edit_message') { edits.push({ messageId, text }); return { ok: true, message_id: messageId }; }
      return { ok: false, error: `unexpected tool ${toolName}` };
    },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    // The plumbing (reply returns id → claude reads it → edit targets it) is 100%
    // reliable; what's NOT reliable is claude's DISCRETION to make the 2nd tool call
    // — it sometimes replies and ends the turn. Since this test proves the round-trip,
    // retry past that coin-flip (each send is a fresh turn) and fail only if claude
    // never edits across all attempts.
    let result = null;
    for (let attempt = 1; attempt <= 3 && edits.length === 0; attempt++) {
      result = await proc.send(
        'This is a test of the edit_message tool. Send a placeholder via '
        + '`mcp__polygram-bridge__reply` with text "one moment" — it returns a message_id. '
        + 'Then deliver your real and ONLY answer by calling `mcp__polygram-bridge__edit_message` '
        + 'with that EXACT message_id and text "EDIT-DONE-4242". The placeholder is NOT your answer; '
        + 'the edit is. You must call edit_message before ending your turn.',
        { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
      );
    }

    assert.ok(replies.length >= 1, `claude must reply. replies=${JSON.stringify(replies).slice(0, 200)}`);
    assert.ok(edits.length >= 1, `claude must call edit_message within 3 attempts. edits=${JSON.stringify(edits).slice(0, 200)} result=${JSON.stringify(result).slice(0, 200)}`);
    // The crux: every edit targets the id surfaced through the bridge reply ack —
    // proves claude read the returned message_id and used it. (Repeated/progressive
    // edits to one id are covered deterministically in cli-process-dispatch.test.js;
    // asserting an exact multi-edit SEQUENCE against real claude is flaky — the turn
    // can resolve between steps.)
    for (const e of edits) {
      assert.equal(Number(e.messageId), REPLY_MSG_ID, `every edit targets reply's id (${REPLY_MSG_ID}). got ${JSON.stringify(edits)}`);
    }
    assert.match(edits[edits.length - 1].text, /EDIT-DONE-4242/, `the edit carries the new text. edits=${JSON.stringify(edits).slice(0, 200)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// 0.13 edit_message FAILURE path against real claude: a failed edit (daemon returns
// ok:false) must surface to claude as a tool error and let the turn COMPLETE — never
// hang (edit_message is a fast ack, not a blocking await like `ask`). The fake
// dispatcher fails the edit; claude should see the error and still finish with a reply.
test('e2e: real claude — failed edit_message does not hang the turn (clean error)', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-editfail-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  let editAttempts = 0;

  const proc = new CliProcess({
    sessionKey: 'e2e-editfail:1', chatId: '987654325', threadId: null, label: 'e2e-editfail',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => {
      if (toolName === 'reply') { replies.push(text); return { ok: true, message_id: 321 }; }
      if (toolName === 'edit_message') { editAttempts++; return { ok: false, error: 'message to edit not found' }; }
      return { ok: false, error: `unexpected tool ${toolName}` };
    },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    // The turn resolving at all (within the timeout) IS the no-hang assertion.
    const result = await proc.send(
      'Call `mcp__polygram-bridge__reply` with "hi" to get a message_id, then call '
      + '`mcp__polygram-bridge__edit_message` with message_id 321 and text "update". '
      + 'If the edit fails, just call `reply` once more with text "EDIT-FAILED-OK" and stop.',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );

    assert.ok(editAttempts >= 1, 'claude attempted the edit');
    assert.ok(replies.length >= 1, `the turn completed with at least one reply (no hang). replies=${JSON.stringify(replies).slice(0, 200)} result=${JSON.stringify(result).slice(0, 200)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// rc.26 regression guard. The bg-work visibility feature (rc.23) silently never
// fired in prod for SIX rc's because BACKGROUND_SHELL_RE was anchored on
// "auto mode on", while every shumorobot session runs "⏵⏵ bypass permissions on".
// A captured-string unit test fixes the regex, but only a REAL claude in
// bypass-permissions mode proves the mode line renders the way the regex expects.
// This spawns real claude, launches a real run_in_background shell, and asserts
// the probe detects it AND bg-work-status fires — the exact path that was dead.
test('e2e: real claude — bg-shell probe detects a detached shell in bypass-permissions mode', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  // Fresh temp cwd — the startup gate navigates the "trust the files in this
  // folder" dialog (triggers include name:'trust'). Safe to rm in finally (ours).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-bg-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };

  const bgStatusEvents = [];
  const proc = new CliProcess({
    sessionKey: 'e2e-bg:1',
    chatId: '987654322',
    threadId: null,
    label: 'e2e-bg',
    tmuxRunner: createTmuxRunner(),
    botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async () => ({ ok: true }),
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
  proc.on('bg-work-status', (e) => bgStatusEvents.push(e));

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    // Launch a REAL detached background shell that outlives the turn. Explicit
    // about run_in_background so claude detaches it (vs blocking the turn on it).
    await proc.send(
      'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 60. '
      + 'Do not wait for it. Then reply with exactly the single word: STARTED',
      {
        timeoutMs: 120_000,
        maxTurnMs: 150_000,
        context: { streamer: noopStreamer, reactor: noopReactor, threadId: null },
      },
    );

    // Turn resolved; the `sleep 60` shell is now detached and the mode line
    // should read "⏵⏵ bypass permissions on · 1 shell · …". Poll the REAL probe
    // — this is the assertion that the mode-independent regex matches real
    // claude's bypass-mode TUI (the rc.26 fix). Allow a few seconds for the TUI
    // to render the shell count after the Bash launches.
    let probe = { live: false, count: 0 };
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      probe = await proc.hasLiveBackgroundWork();
      if (probe.live) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(
      probe.live, true,
      `the bg-shell probe MUST detect the detached shell in bypass-permissions mode (mode-independent regex). last probe=${JSON.stringify(probe)}`,
    );
    assert.ok(probe.count >= 1, `parsed shell count must be ≥1: ${JSON.stringify(probe)}`);

    // End-to-end visibility: _pollBackgroundWork (idle, pendingTurns===0) must
    // emit bg-work-status 'running' so callbacks.js can post "⏳ Working in the
    // background…". The pong watchdog may have already emitted it on its own tick;
    // a manual call here makes the assertion deterministic. Either way the event
    // must be present.
    await proc._pollBackgroundWork();
    const running = bgStatusEvents.find((e) => e.state === 'running');
    assert.ok(
      running,
      `bg-work-status 'running' MUST be emitted once a real bg shell is detected (the dead-since-rc.23 path). events=${JSON.stringify(bgStatusEvents)}`,
    );
    assert.ok(running.count >= 1, `the running event carries the shell count: ${JSON.stringify(running)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});
