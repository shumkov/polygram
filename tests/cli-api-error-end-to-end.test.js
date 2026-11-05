'use strict';

/**
 * From claude's hook lines to the Telegram sends, with only tmux, the bridge
 * socket and Telegram faked.
 *
 * A real Orchestra CliProcess tails a real hook NDJSON file. The test appends
 * the lines the pinned claude CLI writes when a model request keeps failing
 * (UserPromptSubmit, then StopFailure instead of Stop). The failed turn's
 * rejection goes through Polygram's real dispatcher and classifier, and the
 * 'api-error' event goes through Polygram's real onApiError callback, wired
 * the way ProcessManager forwards it. What is asserted is what the user would
 * receive: exactly one message per waiting message, quoting it, in its topic.
 *
 * handleMessage is reduced to the CliProcess send, so its own error exit (the
 * preview's "stream interrupted" handling) is not on this path; that exit is
 * run in tests/cli-api-error-surfacing.test.js and its wiring is checked in
 * tests/polygram-streamer-exits.test.js. The dispatcher's error reply sets no
 * message_thread_id: quoting the message is what keeps it in the topic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess, CALLBACK_TO_EVENT } = require('@shumkov/orchestra');
const { createDispatcher } = require('../lib/handlers/dispatcher');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');
const { classify } = require('../lib/error/classify');
const { getChatIdFromKey, getThreadIdFromKey } = require('../lib/session-key');

const CHAT_ID = -1001234567890;
const THREAD_ID = 77;
const SESSION_KEY = `${CHAT_ID}:${THREAD_ID}`;
const quiet = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

async function waitFor(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-error-e2e-'));
  const ndjson = path.join(dir, 'hooks.ndjson');
  fs.writeFileSync(ndjson, '', { mode: 0o600 });
  const written = [];
  const sends = [];
  const tg = async (bot, method, params, meta) => {
    sends.push({ method, params, meta });
    return { message_id: 9000 + sends.length };
  };

  const proc = new CliProcess({
    sessionKey: SESSION_KEY,
    chatId: String(CHAT_ID),
    tmuxRunner: { sendControl: async () => {}, killSession: async () => {}, captureWide: async () => '' },
    botName: 'e2ebot',
    claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true, message_id: 1 }),
    logger: quiet,
    db: { logEvent: () => {} },
    turnTimeoutMs: 60_000,
    turnAbsoluteMs: 60_000,
  });
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: (obj) => { written.push(obj); } };
  proc.tmuxSession = 'orchestra-e2ebot-channels-apierr';
  proc._hookNdjsonPath = ndjson;
  proc._armHookTail();

  const callbacks = createSdkCallbacks({
    db: {}, dbWrite: () => {}, config: { chats: {} }, bot: {}, botName: 'e2ebot', tg,
    logEvent: () => {}, classifyToolName: () => 'TOOL', announce: () => {}, shouldAnnounce: () => false,
    contextHintShown: new Set(), extractAssistantText: () => '',
    getChatIdFromKey, getThreadIdFromKey,
    sessionFeedback: { endCycle: () => {}, startAutonomousCycle: () => {}, stopCycleTyping: () => {} },
    logger: quiet,
  });
  // As ProcessManager forwards it: fn(sessionKey, ...eventArgs, proc).
  proc.on(CALLBACK_TO_EVENT.onApiError, (...args) => callbacks.onApiError(proc.sessionKey, ...args, proc));

  const dispatcher = createDispatcher({
    config: { bot: {} },
    db: { setInboundHandlerStatus: () => {} },
    dbWrite: (fn) => { try { fn(); } catch {} },
    tg,
    botName: 'e2ebot',
    logEvent: () => {},
    handleMessage: (sessionKey, chatId, msg) => proc.send(msg.text, {
      context: { sourceMsgId: msg.message_id, threadId: msg.message_thread_id },
    }),
    sendToProcess: async () => { throw new Error('no automatic retry expected'); },
    classifyError: classify,
    isAutoResumable: () => false,
    abortGrace: { isRecent: () => false },
    autoResumeTracker: { isInCooldown: () => false, markAttempt: () => {}, clear: () => {} },
    chunkMarkdownText: (text) => [text],
    deliverReplies: async () => {},
    getIsShuttingDown: () => false,
    logger: quiet,
  });

  const appendHook = (raw) => fs.appendFileSync(ndjson, `${JSON.stringify({
    session_id: 'claude-sid', transcript_path: path.join(dir, 'claude-sid.jsonl'), cwd: dir,
    permission_mode: 'bypassPermissions', ...raw,
  })}\n`);
  const envelope = (turnId, msgId) => (
    `<channel source="orchestra-bridge" chat_id="${CHAT_ID}" user="u" msg_id="${msgId}" turn_id="${turnId}">hello</channel>`
  );
  const lastTurnId = () => written.filter((w) => w.kind === 'user_msg').pop()?.turn_id;
  const inbound = (messageId) => ({
    message_id: messageId,
    chat: { id: CHAT_ID, type: 'supergroup' },
    message_thread_id: THREAD_ID,
    text: `message ${messageId}`,
  });

  t.after(async () => {
    await proc.kill('test').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { proc, dispatcher, sends, appendHook, envelope, lastTurnId, inbound };
}

test('a turn claude ends with StopFailure gets exactly one reply, quoting the user\'s message', async (t) => {
  const { proc, dispatcher, sends, appendHook, envelope, lastTurnId, inbound } = setup(t);
  dispatcher.dispatchHandleMessage(SESSION_KEY, CHAT_ID, inbound(50), {});
  assert.ok(await waitFor(() => lastTurnId() != null), 'the turn reached claude');

  appendHook({ hook_event_name: 'UserPromptSubmit', prompt: envelope(lastTurnId(), 50), prompt_id: 'p-1' });
  appendHook({
    hook_event_name: 'StopFailure', prompt_id: 'p-1', error: 'server_error', error_details: '',
    last_assistant_message: 'API Error: 500 upstream unavailable (127.0.0.1:8318)',
  });

  assert.ok(await waitFor(() => sends.length >= 1), 'the user is answered without waiting for a ceiling');
  await new Promise((r) => setTimeout(r, 150));   // nothing else may follow
  assert.equal(sends.length, 1, 'one failed turn, one message');
  const [{ method, params, meta }] = sends;
  assert.equal(method, 'sendMessage');
  assert.equal(params.chat_id, CHAT_ID);
  assert.equal(params.reply_parameters.message_id, 50, 'it quotes the message, which keeps it in the topic');
  assert.equal(params.text, classify({ code: 'CLAUDE_API_ERROR', apiError: 'server_error' }).userMessage);
  assert.doesNotMatch(params.text, /127\.0\.0\.1|API Error: 500/, 'the gateway error text never reaches the chat');
  assert.equal(meta.source, 'error-reply');
  assert.equal(proc.pendingTurns.size, 0);
});

test('a follow-up autosteered into that turn gets its own single reply in the topic when its own cycle fails', async (t) => {
  const { proc, dispatcher, sends, appendHook, envelope, lastTurnId, inbound } = setup(t);
  dispatcher.dispatchHandleMessage(SESSION_KEY, CHAT_ID, inbound(50), {});
  assert.ok(await waitFor(() => lastTurnId() != null));
  const first = lastTurnId();
  appendHook({ hook_event_name: 'UserPromptSubmit', prompt: envelope(first, 50), prompt_id: 'p-1' });
  assert.ok(await waitFor(() => proc.pendingTurns.get(first)?.seen === true));

  // While claude retries, the user writes again; Polygram autosteers it in.
  assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 51, source: 'autosteer' }), true);
  const followUp = lastTurnId();
  appendHook({ hook_event_name: 'StopFailure', prompt_id: 'p-1', error: 'server_error' });
  assert.ok(await waitFor(() => sends.length === 1));

  // claude then runs the follow-up as its own query, which fails too.
  appendHook({ hook_event_name: 'UserPromptSubmit', prompt: envelope(followUp, 51), prompt_id: 'p-2' });
  appendHook({ hook_event_name: 'StopFailure', prompt_id: 'p-2', error: 'server_error' });
  assert.ok(await waitFor(() => sends.length >= 2), 'the follow-up is not left silent');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sends.length, 2, 'one message per waiting message');
  const [, { params }] = sends;
  assert.equal(params.chat_id, String(CHAT_ID));
  assert.equal(params.message_thread_id, THREAD_ID, 'in the topic, even if the follow-up was deleted meanwhile');
  assert.deepEqual(params.reply_parameters, { message_id: 51, allow_sending_without_reply: true });
  assert.equal(params.text, classify({ code: 'CLAUDE_API_ERROR', apiError: 'server_error' }).userMessage);
});
