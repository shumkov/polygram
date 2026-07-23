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

const { CliProcess } = require('@shumkov/orchestra');
const { createTmuxRunner } = require('@shumkov/orchestra');

// Same resolution as polygram.js boot: point orchestra at polygram's vendored
// claude-bin dir BEFORE resolving. Bare resolvePinnedClaudeBin points at
// claude's own version store, which claude's auto-pruner empties — the spawn
// then dies instantly (TMUX_SESSION_GONE in ~8ms, no pane content).
if (!process.env.ORCHESTRA_CLAUDE_VENDOR_DIR) {
  process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = path.join(os.homedir(), '.local', 'share', 'polygram', 'claude-bin');
}
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('@shumkov/orchestra').claudeBin;

function resolvePinnedClaudeBin() {
  const r = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION, { logger: console });
  if (!r.ok) throw new Error(`pinned claude bin unavailable: ${r.reason}`);
  return r.path;
}

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
    // NEVER rm this cwd: it is NOT a temp dir — it's Rekordbox's own data
    // directory (the git repo that once lived there moved to
    // ~/Projects/shumkov/engineering-music-curation; the path now belongs to
    // the Rekordbox app on this case-insensitive filesystem). An earlier
    // version of this test rmSync'd it in this finally, which would have
    // deleted the operator's music library.
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

// 0.12 interactive questions — the RENDER path against real claude (the blind
// spot in the ask round-trip above, which answers via writeQuestionAnswer and
// never exercises renderAsk → the Telegram card). This drives the FULL
// production wiring: real claude calls `ask` → the daemon emits 'question-asked'
// → the REAL createQuestionHandlers.renderAsk renders the card through a
// capturing `tg` → we assert the Telegram sendMessage actually carries an
// inline_keyboard with a tap-button per option + a q:<id>:<token>:opt:<i>
// callback_data. This is the "buttons show in Telegram" guarantee that no other
// test covers (unit tests cover renderCurrent in isolation; this proves the
// real question-asked payload flows through renderAsk into a real keyboard).
test('e2e: real claude — ask renders a Telegram inline keyboard with a button per option', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const Database = require('better-sqlite3');
  const { createQuestionStore } = require('../lib/questions/store');
  const { createQuestionHandlers } = require('../lib/handlers/questions');

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-askkbd-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };

  // Real migrated DB + real question store (migration 012 = pending_questions).
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-askkbd-db-'));
  const rawDb = new Database(path.join(dbDir, 't.db'));
  rawDb.pragma('journal_mode = WAL');
  const migDir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    rawDb.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  const questionStore = createQuestionStore(rawDb);

  // Capturing `tg` — records every Telegram call the handler makes (the card
  // send carries reply_markup) and hands back a fake message_id so renderAsk's
  // sendCurrent treats the send as successful and persists message_ids.
  const tgCalls = [];
  let fakeMsgId = 9000;
  const tg = async (_bot, method, params /* , meta */) => {
    tgCalls.push({ method, params });
    return { message_id: ++fakeMsgId, date: Math.floor(Date.now() / 1000) };
  };

  const replies = [];
  const askedEvents = [];
  let renderErr = null;

  const proc = new CliProcess({
    sessionKey: 'e2e-askkbd:1', chatId: '987654340', threadId: null, label: 'e2e-askkbd',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  // The EXACT production wiring: createQuestionHandlers with the real store +
  // the capturing tg; answerQuestion late-bound to the proc so claude continues.
  const questionHandlers = createQuestionHandlers({
    questions: questionStore, tg, bot: {}, botName: 'e2etest',
    logEvent: () => {},
    answerQuestion: (sk, tc, result) => proc.writeQuestionAnswer(tc, result),
    logger: { error: (...a) => console.error('[e2e:qh]', ...a) },
  });

  // Production path: 'question-asked' → renderQuestion → renderAsk (renders the
  // keyboard). Then hand an answer back so claude finishes the turn.
  proc.on('question-asked', async (ev) => {
    askedEvents.push(ev);
    try {
      await questionHandlers.renderAsk({
        sessionKey: ev.sessionKey, chatId: ev.chatId, threadId: ev.threadId,
        turnId: ev.turnId, toolCallId: ev.toolCallId, questions: ev.questions,
      });
    } catch (e) { renderErr = e; }
    const q = ev.questions?.[0];
    const label = q?.options?.[0]?.label || 'Cats';
    proc.writeQuestionAnswer(ev.toolCallId, { answers: [{ header: q?.header || '', selected: [label] }] });
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    await proc.send(
      'Use the `mcp__polygram-bridge__ask` tool to ask me ONE question: "Cats or dogs?" with exactly two '
      + 'options labelled "Cats" and "Dogs". After I answer, reply (via the reply tool) with EXACTLY: '
      + '"You picked: <the label I chose>".',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );

    assert.equal(renderErr, null, `renderAsk must not throw: ${renderErr && renderErr.stack}`);
    assert.ok(askedEvents.length >= 1, `claude must call the ask tool. asked=${JSON.stringify(askedEvents).slice(0, 200)}`);

    // THE CRUX: the Telegram card sent for the question MUST carry an inline
    // keyboard with a tap-button per option — this is "buttons show in Telegram."
    const cardSends = tgCalls.filter((c) => c.method === 'sendMessage' && /Cats or dogs/i.test(c.params.text || ''));
    assert.ok(cardSends.length >= 1,
      `renderAsk must send the question as a Telegram sendMessage. tgCalls=${JSON.stringify(tgCalls).slice(0, 400)}`);
    const kb = cardSends[0].params.reply_markup && cardSends[0].params.reply_markup.inline_keyboard;
    assert.ok(Array.isArray(kb) && kb.length >= 1,
      `the question card MUST carry an inline_keyboard (the tap buttons). reply_markup=${JSON.stringify(cardSends[0].params.reply_markup)}`);
    const buttons = kb.flat();
    assert.ok(buttons.length >= 2,
      `there must be a tap-button per option (≥2 for Cats/Dogs). buttons=${JSON.stringify(buttons)}`);
    for (const b of buttons) {
      assert.ok(typeof b.text === 'string' && b.text.length > 0, `button has a label: ${JSON.stringify(b)}`);
      assert.match(b.callback_data, /^q:\d+:[A-Za-z0-9_-]+:(opt:\d+|submit|other)$/,
        `button has a valid q:<id>:<token>:action callback_data: ${JSON.stringify(b)}`);
    }
    const labels = buttons.map((b) => b.text).join(' | ');
    assert.match(labels, /Cats/i, `the option labels render on the buttons: ${labels}`);
    assert.match(labels, /Dogs/i, `the option labels render on the buttons: ${labels}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { rawDb.close(); } catch {}
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// progress-is-not-turn-end (conversion-topic incident, 2026-06-22): claude posts
// a status ("give me a couple min"), does multi-step work, then must DELIVER the
// result in the SAME turn — not end on the promise. Validates the hardened prompt
// (status ≠ turn end) + the `interim:true` flag end-to-end against real claude:
// a status reply is marked interim, and a substantive final answer still arrives,
// with NO second user message. docs/progress-is-not-turn-end-spec.md
test('e2e: real claude — interim status then a delivered final answer (no prod needed)', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-interim-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];   // { text, interim }

  const proc = new CliProcess({
    sessionKey: 'e2e-interim:1', chatId: '987654350', threadId: null, label: 'e2e-interim',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text, interim }) => {
      if (toolName === 'reply') replies.push({ text, interim: interim === true });
      return { ok: true, message_id: 100 + replies.length };
    },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    const result = await proc.send(
      'Do this as ONE turn: first send a brief interim status reply (set interim:true) like '
      + '"Working on it…". Then run a couple of Bash commands (e.g. `echo step1`, `echo step2`). '
      + 'Then deliver your FINAL answer as a normal reply (interim omitted) that ends with EXACTLY '
      + 'the token: RESULT-DELIVERED-7788.',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );

    const finals = replies.filter((r) => !r.interim);
    const interims = replies.filter((r) => r.interim);
    const allText = replies.map((r) => r.text).join(' | ') + ' | ' + (result?.text || '');
    assert.ok(interims.length >= 1,
      `claude must mark the status reply interim:true. replies=${JSON.stringify(replies).slice(0, 300)}`);
    assert.ok(finals.length >= 1,
      `claude must deliver a FINAL (non-interim) reply, not end on the status. replies=${JSON.stringify(replies).slice(0, 300)}`);
    assert.match(allText, /RESULT-DELIVERED-7788/,
      `the real result must be delivered in the same turn — no prod. got: ${allText.slice(0, 300)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// 0.13 D1 (P1): the reply-then-ask shape against REAL claude — the prod bug-#2
// flow that was previously untested (the ask E2E above answers synchronously,
// so the WAIT never spans the old reply-quiet window). Claude replies FIRST,
// then asks; we hold the answer ~8s — far past the pre-D1 finalize point
// (reply-quiet 2s + stop-grace 2s; prod question 23745077 resolved 21ms after
// the ask). Pre-D1 the turn is long gone when the answer lands: the
// question-resume re-arm no-ops (pendingQueue empty) and the post-answer reply
// orphans to the autonomous path. Under D1 the open question suspends the
// finalizer, so the turn is STILL PENDING at answer time and the final reply
// binds to it.
test('e2e/D1: reply-then-ask — turn survives a delayed answer; final reply binds to the turn', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-d1ask-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  let pendingAtAnswerTime = null;
  let questionResumedFired = false;

  const proc = new CliProcess({
    sessionKey: 'e2e-d1ask:1', chatId: '987654329', threadId: null, label: 'e2e-d1ask',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
  proc.on('question-resumed', () => { questionResumedFired = true; });

  // Delay the answer well past the pre-D1 finalize point, then record whether
  // the turn is still pending at the moment the answer is handed back.
  proc.on('question-asked', (ev) => {
    const q = ev.questions?.[0];
    const label = q?.options?.[0]?.label || 'Yes';
    setTimeout(() => {
      pendingAtAnswerTime = proc.pendingTurns.size;
      proc.writeQuestionAnswer(ev.toolCallId, { answers: [{ header: q?.header || '', selected: [label] }] });
    }, 8_000);
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    const result = await proc.send(
      'Do this in order: (1) FIRST send a short reply (via the reply tool) saying exactly "Step one done.". '
      + '(2) THEN use the `mcp__polygram-bridge__ask` tool to ask me ONE question: "Proceed?" with options '
      + '"Yes" and "No". (3) AFTER my answer arrives, send a final reply saying exactly "Step two done.".',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );

    assert.equal(pendingAtAnswerTime, 1,
      'D1: the turn must STILL be pending when the delayed answer lands — pre-D1 it finalized ~4s into the wait');
    assert.equal(questionResumedFired, true, 'question-resumed fired on the real answer');
    const all = replies.join(' | ') + ' | ' + (result?.text || '');
    assert.match(all, /Step two done/i,
      `the post-answer reply must bind to the SAME turn (not orphan to the autonomous path). got: ${all.slice(0, 300)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// 0.13 D2 (P3): the Tier 2C fold-acknowledgment contract against REAL claude.
// A mid-cycle inject FOLDS into the trigger's combined reply (P0 spike: no own
// UPS, incidental echo = trigger-only) — the consumed_turn_ids field on OUR
// reply tool schema is the only reliable fold signal. Asserts the model
// actually sets it when instructed by the system prompt, the folded entry
// resolves, and NO drop (= no redelivery) is declared.
test('e2e/D2: inject-fold — consumed_turn_ids acknowledges the fold; zero input-dropped', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-d2fold-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  let dropped = null;

  const proc = new CliProcess({
    sessionKey: 'e2e-d2fold:1', chatId: '987654331', threadId: null, label: 'e2e-d2fold',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
    dropConfirmMs: 8_000,
  });
  proc.on('input-dropped', (p) => { dropped = p; });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    const sendP = proc.send(
      'Run `sleep 10` via Bash. Then send ONE reply that answers BOTH this message and any '
      + 'follow-up channel messages you received during the sleep.',
      { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
    );
    await new Promise((r) => setTimeout(r, 5_000));   // mid-sleep
    const injected = proc.injectUserMessage({
      content: 'Mid-turn follow-up: what is 7+5? Include the answer in your reply.',
      priority: 'next', msgId: 77, source: 'autosteer',
    });
    assert.equal(injected, true);
    const injectedId = [...proc.inputLedger.keys()].find((k) => proc.inputLedger.get(k).source === 'autosteer');

    await sendP;
    // give the drop-confirm window time to (wrongly) fire if the ack failed
    await new Promise((r) => setTimeout(r, 12_000));

    const entry = proc.inputLedger.get(injectedId);
    assert.ok(['resolved', 'seen'].includes(entry?.state),
      `the folded inject must be acknowledged (consumed_turn_ids) or seen — got state=${entry?.state}. `
      + `replies=${replies.join(' | ').slice(0, 200)}`);
    assert.equal(dropped, null, 'a FOLD must never be declared dropped (the A1 base-rate inversion)');
    assert.match(replies.join(' '), /12/, 'the fold was actually answered in the combined reply');
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

// 2026-06-11 dropped-"4" fix (docs/0.13-resume-dialog-fix-spec.md A1+A2).
// Prod incident: claude answered "2+2" with the single character "4"; the
// parse layer classified it as a solo-emoji reaction (\p{Emoji} matches
// digits) and the dispatcher dropped it with no reaction target — the user
// got NOTHING. This E2E runs the REAL dispatcher pipeline (real parse +
// sanitize + chunk + process-agent-reply) against a real claude reply,
// asserting a text bubble reaches the fake Telegram sink.
test('e2e: real claude — single-digit reply survives the full dispatcher pipeline as TEXT', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 180_000,
}, async () => {
  const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
  const { parseResponse } = require('../lib/telegram/parse');
  const { sanitizeAssistantReply } = require('../lib/telegram/sanitize-reply');
  const { chunkMarkdownText } = require('../lib/telegram/chunk');

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-digit-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };

  const tgCalls = [];   // every method the pipeline would hit Telegram with
  const fakeSend = async (_bot, method, params) => {
    tgCalls.push({ method, params });
    return { message_id: 4242 };
  };
  const dispatcher = createChannelsToolDispatcher({
    bot: {},   // unused by the fake send
    send: fakeSend,
    chunkText: chunkMarkdownText,
    deliverReplies: async ({ chunks, replyToMessageId }) => {
      for (const c of chunks) tgCalls.push({ method: 'sendMessage', params: { text: c, reply_to_message_id: replyToMessageId } });
      return { sent: [4242], failed: [] };
    },
    parseResponse,
    sanitizeAssistantReply,
    logger: { warn: () => {}, error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
  });

  const proc = new CliProcess({
    sessionKey: 'e2e-digit:1', chatId: '987654329', threadId: null, label: 'e2e-digit',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: dispatcher,
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });
    await proc.send(
      'What is 2+2? Reply via the reply tool with EXACTLY one character: the answer digit. '
      + 'No words, no punctuation — the single digit only.',
      { timeoutMs: 120_000, maxTurnMs: 150_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null, sourceMsgId: 31337 } },
    );

    const texts = tgCalls.filter(c => c.method === 'sendMessage').map(c => c.params.text);
    assert.ok(
      texts.some(t => /4/.test(t)),
      `the digit reply MUST arrive as a TEXT bubble (pre-fix it became a dropped "reaction"). tgCalls=${JSON.stringify(tgCalls).slice(0, 400)}`,
    );
    const reacted = tgCalls.filter(c => c.method === 'setMessageReaction');
    assert.equal(reacted.length, 0,
      `a digit must never go out as a reaction: ${JSON.stringify(reacted)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// 2026-06-12 cancel-cheap (docs/0.13-cancel-efficiency-and-delete-trigger-spec.md).
// The whole point of the tiered cancel: an interrupted turn must leave claude
// WARM — the next message reuses the same process (no kill, no --resume, no
// resume-death-race exposure) — and a cancelled mid-turn autosteer must never
// be re-delivered by the drop sweep (the review's BLOCKER, live).
test('e2e: real claude — cancel mid-turn is cheap (warm reuse, no respawn) and re-delivers nothing', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 240_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-cancel-'));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];
  const droppedInputs = [];
  let spawnCount = 0;

  const realRunner = createTmuxRunner();
  const countingRunner = {
    ...realRunner,
    spawn: async (o) => { spawnCount += 1; return realRunner.spawn(o); },
  };

  const proc = new CliProcess({
    sessionKey: 'e2e-cancel:1', chatId: '987654331', threadId: null, label: 'e2e-cancel',
    tmuxRunner: countingRunner, botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true, message_id: 1 }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
  proc.on('input-dropped', (e) => droppedInputs.push(e));

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });
    assert.equal(spawnCount, 1, 'precondition: exactly one spawn');
    const sessionIdAtStart = proc.claudeSessionId;

    // A genuinely long turn, so the cancel lands mid-work.
    const longTurn = proc.send(
      'Count slowly from 1 to 200, thinking carefully about each number. Then reply with the full list.',
      { timeoutMs: 120_000, maxTurnMs: 150_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null, sourceMsgId: 41 } },
    );
    longTurn.catch(() => {});

    // Give claude time to pick the turn up, steer a follow-up in (the
    // BLOCKER's setup: a mid-turn autosteer the user then cancels)…
    await new Promise(r => setTimeout(r, 12_000));
    proc.injectUserMessage({
      content: 'also tell me a joke about numbers',
      priority: 'next', msgId: 42, source: 'autosteer',
    });
    await new Promise(r => setTimeout(r, 2_000));

    // …then CANCEL (what /stop now does on the common path).
    await proc.interrupt();
    const result = await longTurn;
    assert.equal(result.metrics.resultSubtype, 'interrupted',
      `the cancelled turn resolves as interrupted, got: ${JSON.stringify(result.metrics)}`);

    // THE COST ASSERTION — the spec's whole point: the next message runs in
    // the SAME claude process. No second spawn, same session id, no --resume.
    const followUp = await proc.send(
      'Reply with exactly the single word: WARM',
      { timeoutMs: 120_000, maxTurnMs: 150_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null, sourceMsgId: 43 } },
    );
    const replyText = replies.join(' ') + ' ' + (followUp?.text || '');
    assert.match(replyText, /WARM/i, `follow-up answered after the cancel. replies=${JSON.stringify(replies).slice(0, 200)}`);
    assert.equal(spawnCount, 1,
      'NO respawn after an interrupt-cancel — the warm proc serves the next turn (kill would have spawned again)');
    assert.equal(proc.claudeSessionId, sessionIdAtStart, 'same claude session — conversation kept without --resume');

    // The BLOCKER, live: the cancelled autosteer must not be re-delivered.
    // The follow-up turn's finalize ran the drop sweep; give the confirm
    // window time to fire if it (wrongly) armed.
    await new Promise(r => setTimeout(r, 25_000));
    assert.deepEqual(droppedInputs, [],
      'the CANCELLED autosteer input must never be declared dropped → re-delivered');
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});
