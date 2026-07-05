'use strict';

/**
 * Tests for Findings #1, #2, #3 in 0.11.0-channels review.
 *
 * #1 — Dispatcher must route reply text through processAndDeliverAgentText
 *      (parseResponse + sanitizeAssistantReply + chunkMarkdownText +
 *      deliverReplies + inline sticker/reaction handling). Without this,
 *      `[sticker:NAME]` / `[react:EMOJI]` / `No response requested.` leak
 *      as literal text into the chat.
 *
 * #2 — CliProcess result.alreadyDelivered must be true so polygram.js
 *      post-pm.send pipeline does NOT redeliver the same text. Pre-fix:
 *      every channels turn delivers twice (dispatcher + post-pm.send).
 *
 * #3 — _recordReplyForPendingTurn must not auto-attribute when turn_id is
 *      omitted AND multiple turns are pending. Pre-fix: silently routes
 *      to the OLDEST pending turn, which cross-attributes Q2's answer to
 *      Q1's source message.
 *
 * These tests are written to be GREEN against the fixed dispatcher /
 * cli-process and RED against rc.9 HEAD.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');

const fakeBot = {};
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

// Capture deliverReplies invocations so tests can inspect what landed in Telegram.
function makeDeliverCapture() {
  const calls = [];
  const deliverReplies = async ({ chunks, chatId, threadId, replyToMessageId, meta }) => {
    calls.push({ chunks: [...chunks], chatId, threadId, replyToMessageId, meta });
    return {
      sent: chunks.map((_, i) => ({ message_id: i + 1 })),
      failed: [],
      results: [],
    };
  };
  return { deliverReplies, calls };
}

// Capture tg() calls so tests can verify sendSticker / setMessageReaction fired
// (the inline-sticker + reaction paths inside the helper).
function makeSendCapture() {
  const calls = [];
  const send = async (_bot, method, params, _meta) => {
    calls.push({ method, params });
    return { ok: true, result: { message_id: calls.length } };
  };
  return { send, calls };
}

// Minimal parseResponse stub matching the real shape (lib/telegram/parse.js):
// strips `[sticker:NAME]` and `[react:EMOJI]` tags, surfaces them in arrays.
function makeFakeParseResponse() {
  return function parseResponse(text) {
    const stickers = [];
    const reactions = [];
    let cleaned = String(text);
    cleaned = cleaned.replace(/\[sticker:([a-zA-Z0-9_-]+)\]/g, (_m, name) => {
      stickers.push({ name, fileId: `file-id-${name}` });
      return '';
    });
    cleaned = cleaned.replace(/\[react:(.+?)\]/g, (_m, emoji) => {
      reactions.push(emoji);
      return '';
    });
    return {
      text: cleaned.trim(),
      sticker: null,
      stickerLabel: null,
      stickers,
      reaction: null,
      reactions,
    };
  };
}

// Minimal sanitizeAssistantReply stub matching lib/telegram/sanitize-reply.js
function makeFakeSanitizer() {
  return function sanitizeAssistantReply(text) {
    const cannedPatterns = [/^No response requested\.?$/i];
    for (const pat of cannedPatterns) {
      if (pat.test(text.trim())) {
        return { text: '(canned reply suppressed)', replaced: true, original: text };
      }
    }
    return { text, replaced: false };
  };
}

// ─── Finding #1: pipeline integration ──────────────────────────────────────

test('F#1: dispatcher strips `[sticker:NAME]` tags from delivered text', async () => {
  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const { send, calls: sendCalls } = makeSendCapture();

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text], // passthrough — represents chunkMarkdownText
    deliverReplies,
    parseResponse: makeFakeParseResponse(),
    sanitizeAssistantReply: makeFakeSanitizer(),
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1',
    chatId: '12345',
    threadId: null,
    toolName: 'reply',
    text: 'Hello! [sticker:pumped]',
    files: null,
  });

  assert.equal(result.ok, true);
  // The sticker tag must NOT reach Telegram as literal text.
  const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
  assert.ok(
    !allDelivered.includes('[sticker:'),
    `Expected sticker tag stripped from delivered text. Got: ${JSON.stringify(allDelivered)}`,
  );
  // The sticker IS sent as a real sticker via tg(sendSticker).
  const stickerSent = sendCalls.some(
    c => c.method === 'sendSticker' && c.params?.sticker === 'file-id-pumped',
  );
  assert.ok(stickerSent, `Expected sendSticker(file-id-pumped). Calls: ${JSON.stringify(sendCalls)}`);
});

test('F#1: dispatcher swaps canned `No response requested.` via sanitizer', async () => {
  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const { send } = makeSendCapture();

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: makeFakeParseResponse(),
    sanitizeAssistantReply: makeFakeSanitizer(),
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1',
    chatId: '12345',
    threadId: null,
    toolName: 'reply',
    text: 'No response requested.',
    files: null,
  });

  assert.equal(result.ok, true);
  const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
  assert.ok(
    !/^No response requested\.?$/i.test(allDelivered),
    `Sanitizer should have replaced canned string. Got: ${JSON.stringify(allDelivered)}`,
  );
  assert.match(allDelivered, /suppressed/i, 'Expected canned-reply replacement marker');
});

test('F#1: dispatcher applies `[react:EMOJI]` reactions when target msg id present', async () => {
  const { deliverReplies } = makeDeliverCapture();
  const { send, calls: sendCalls } = makeSendCapture();

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: makeFakeParseResponse(),
    sanitizeAssistantReply: makeFakeSanitizer(),
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1',
    chatId: '12345',
    threadId: null,
    toolName: 'reply',
    text: 'Got it! [react:👍]',
    files: null,
    sourceMsgId: 999, // post-fix: dispatcher accepts inbound msg id for reactions
  });

  assert.equal(result.ok, true);
  const reactionCall = sendCalls.find(c => c.method === 'setMessageReaction');
  // When sourceMsgId is wired, reactions apply to it. When not wired (current),
  // this assertion drives the design: dispatcher needs to thread sourceMsgId.
  assert.ok(
    reactionCall,
    `Expected setMessageReaction call. sendCalls: ${JSON.stringify(sendCalls)}`,
  );
  assert.equal(reactionCall.params.reaction[0].emoji, '👍');
});

// ─── Finding #2: double-send short-circuit ─────────────────────────────────
//
// The double-send bug lives at the boundary between cli-process and
// polygram.js — cli-process resolves `result.text` = concat of replies,
// polygram.js then re-delivers it. We pin the contract via cli-process's
// _resolveTurn result shape.

function makeMinimalChannelsProc(extra = {}) {
  const { CliProcess } = require('@shumkov/orchestra');
  const events = [];
  const fakeDb = {
    logEvent: (kind, detail) => { events.push({ kind, detail }); },
  };
  const proc = new CliProcess({
    sessionKey: 'sess-1',
    chatId: '12345',
    tmuxRunner: { sendControl: async () => {} },
    botName: 'testbot',
    claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: fakeDb,
    ...extra,
  });
  return { proc, events };
}

test('F#2: cli-process _resolveTurn marks result.alreadyDelivered=true', async () => {
  // Contract: when CliProcess.send() resolves, the result must signal
  // that text has ALREADY been delivered by the dispatcher. polygram.js's
  // post-pm.send pipeline then short-circuits its own delivery branch.
  //
  // 0.12 Phase 1.7: _resolveTurn now schedules finalization via stopGraceMs
  // to wait for the Stop hook. Use stopGraceMs: 0 so the test sees the
  // synchronous resolution on the next tick.
  const { proc } = makeMinimalChannelsProc({ stopGraceMs: 0 });

  const turnId = 'turn-test';
  let resolvedResult = null;
  proc.pendingTurns.set(turnId, {
    resolve: (r) => { resolvedResult = r; },
    reject: () => {},
    replies: ['delivered text'],
    quietTimer: null,
    hardTimer: null,
    startedAt: Date.now(),
    _turnId: turnId,
  });

  proc._resolveTurn(turnId);
  // Wait one tick for the 0ms stopGraceTimer to fire _finalizeTurn.
  await new Promise(r => setTimeout(r, 5));

  assert.ok(resolvedResult, 'turn must have resolved');
  assert.equal(
    resolvedResult.alreadyDelivered,
    true,
    `result.alreadyDelivered should be true (signals polygram.js to skip post-pm.send delivery). Got: ${JSON.stringify(resolvedResult)}`,
  );
});

// ─── Finding #3: misattribution when turn_id omitted with multiple pending ─

test('F#3: reply with no turn_id + multiple pending turns does NOT auto-attribute', async () => {
  // Pre-fix: _recordReplyForPendingTurn falls back to OLDEST pending. If
  // Claude answers Q2 first without echoing turn_id, the answer cross-binds
  // to Q1's source message; Q2 then hangs until hardTimer (10 min).
  //
  // Post-fix: ambiguous routing logs an event and does NOT bind to either
  // pending turn. (We surface as event so forensics can audit drift.)
  const { proc, events } = makeMinimalChannelsProc();

  proc.pendingTurns.set('turn-A', {
    resolve: () => {}, reject: () => {},
    replies: [], quietTimer: null, hardTimer: null,
    startedAt: Date.now() - 1000,
  });
  proc.pendingTurns.set('turn-B', {
    resolve: () => {}, reject: () => {},
    replies: [], quietTimer: null, hardTimer: null,
    startedAt: Date.now(),
  });

  // Reply with NO turn_id (Claude omitted it)
  proc._recordReplyForPendingTurn('orphan reply', undefined);

  // Post-fix invariant: neither pending turn's replies array got the text.
  // Pre-fix bug: turn-A.replies would have ['orphan reply'].
  assert.deepEqual(
    proc.pendingTurns.get('turn-A').replies,
    [],
    'turn-A must not absorb the orphan reply',
  );
  assert.deepEqual(
    proc.pendingTurns.get('turn-B').replies,
    [],
    'turn-B must not absorb the orphan reply',
  );

  // Post-fix should emit an event so the orphan is visible in forensics.
  const orphanEvent = events.find(e =>
    /orphan|autonomous-assistant-message|ambiguous/.test(e.kind),
  );
  assert.ok(
    orphanEvent,
    `Expected orphan/ambiguous event. Got events: ${JSON.stringify(events)}`,
  );
});

// ─── 0.15: agent-flagged secret redaction through the dispatcher ────────────
//
// When the agent emits `[redact:<secret>]`, the dispatcher's deliverAgent path
// (processAndDeliverAgentText) must (a) keep the secret out of the delivered
// text and (b) call redactInbound(secret, {chat_id, thread_id}) so the stored
// inbound is wiped. Uses the REAL parseResponse so the extraction is exercised
// end-to-end (the fake stub above doesn't surface redactions[]).
const { parseResponse: realParseResponse } = require('../lib/telegram/parse');
const { sanitizeAssistantReply: realSanitize } = require('../lib/telegram/sanitize-reply');

test('0.15: dispatcher strips [redact:SECRET] from text AND calls redactInbound', async () => {
  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const { send } = makeSendCapture();
  const redactCalls = [];
  const redactInbound = (secret, ctx) => { redactCalls.push({ secret, ctx }); return { redacted: 1 }; };

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: realParseResponse,
    sanitizeAssistantReply: realSanitize,
    redactInbound,
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1',
    chatId: '12345',
    threadId: 77,
    toolName: 'reply',
    text: 'Done — wiped that key for you. [redact:sk-ant-secret123]',
    files: null,
    sourceMsgId: 5,
  });

  assert.equal(result.ok, true);
  const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
  assert.ok(!allDelivered.includes('sk-ant-secret123'), `secret leaked into delivered text: ${JSON.stringify(allDelivered)}`);
  assert.ok(!allDelivered.includes('[redact:'), 'redact marker leaked into delivered text');
  assert.equal(redactCalls.length, 1, 'redactInbound called exactly once');
  assert.equal(redactCalls[0].secret, 'sk-ant-secret123');
  assert.equal(redactCalls[0].ctx.chat_id, '12345');
  assert.equal(redactCalls[0].ctx.thread_id, 77);
});

test('0.15: dispatcher delivers normally + does NOT call redactInbound when no [redact:] marker', async () => {
  const { deliverReplies } = makeDeliverCapture();
  const { send } = makeSendCapture();
  const redactCalls = [];
  const redactInbound = (secret, ctx) => { redactCalls.push({ secret, ctx }); return { redacted: 0 }; };

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: realParseResponse,
    sanitizeAssistantReply: realSanitize,
    redactInbound,
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'just a normal reply', files: null, sourceMsgId: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(redactCalls.length, 0, 'redactInbound must not fire without a marker');
});

test('0.15: dispatcher emits secret-redact-requested-no-match when redaction matched 0 rows (fail-loud)', async () => {
  const { deliverReplies } = makeDeliverCapture();
  const { send } = makeSendCapture();
  const events = [];
  const logEvent = (kind, detail) => events.push({ kind, detail });
  // redactInbound reports nothing matched (secret older than window / paraphrased).
  const redactInbound = () => ({ redacted: 0 });

  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: (text) => [text], deliverReplies,
    parseResponse: realParseResponse, sanitizeAssistantReply: realSanitize,
    redactInbound, logEvent, logger: quietLogger,
  });

  await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'Wiped it. [redact:sk-ant-gone]', files: null, sourceMsgId: 5,
  });

  const miss = events.find((e) => e.kind === 'secret-redact-requested-no-match');
  assert.ok(miss, `expected fail-loud no-match event. Got: ${JSON.stringify(events.map((e) => e.kind))}`);
  assert.equal(miss.detail.requested, 1);
});

test('0.15: dispatcher without redactInbound wired still delivers (graceful no-op)', async () => {
  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const { send } = makeSendCapture();
  // redactInbound intentionally omitted — legacy/test callers.
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: (text) => [text], deliverReplies,
    parseResponse: realParseResponse, sanitizeAssistantReply: realSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'Done. [redact:sk-ant-xyz]', files: null, sourceMsgId: 5,
  });
  assert.equal(result.ok, true);
  const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
  // Even with no redactInbound, the marker is still stripped from the visible text.
  assert.ok(!allDelivered.includes('sk-ant-xyz'), 'marker must still be stripped even when redactInbound absent');
});
