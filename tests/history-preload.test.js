/**
 * Tests for lib/history-preload.js — SessionStart hook factory that
 * preloads polygram-DB history into a fresh Query.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeSessionStartHook, buildHistoryBlock, _formatRow } = require('../lib/history-preload');
const { open } = require('../lib/db');

let tmpDir;
let db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-preload-test-'));
  db = open(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.raw.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: insert messages into polygram's messages table directly via
// the db wrapper. Schema: direction='in'|'out', user is the sender
// display name (or bot identity for outbound). attachments / voice
// live on a separate table — not exercised by the preload.
function seedMessages(chatId, msgs) {
  for (const m of msgs) {
    db.insertMessage({
      chat_id: String(chatId),
      thread_id: m.thread_id ?? null,
      msg_id: m.msg_id,
      direction: m.direction || 'in',
      ts: m.ts,
      user: m.user || (m.direction === 'out' ? 'shumobot' : 'Ivan Shumkov'),
      user_id: m.user_id || null,
      text: m.text || '',
      reply_to_id: m.reply_to_id ?? null,
      bot_name: m.bot_name || 'shumabit',
      source: m.source || 'telegram',
      session_id: null,
      model: null,
      effort: null,
      turn_id: null,
      status: null,
      error: null,
      cost_usd: null,
    });
  }
}

describe('makeSessionStartHook — fresh sessions inject history', () => {
  test('source=startup with messages → returns additionalContext with <polygram-history>', async () => {
    const chatId = '12345';
    seedMessages(chatId, [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'hello' },
      { msg_id: 2, ts: 1_700_000_001_000, direction: 'out', user: 'shumobot', text: 'hi back' },
    ]);
    const hook = makeSessionStartHook({ db, chatId, since: null });
    const result = await hook({ source: 'startup' });
    assert.equal(result.continue, true);
    assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.match(ctx, /<polygram-history/);
    assert.match(ctx, /Ivan: hello/);
    assert.match(ctx, /shumobot: hi back/);
  });

  test('source=clear (post /new) ALSO injects history', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'pre-reset message' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', since: null });
    const result = await hook({ source: 'clear' });
    assert.match(result.hookSpecificOutput.additionalContext, /pre-reset message/);
  });

  test('history skill hint is included in the additionalContext', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'hi' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', since: null });
    const result = await hook({ source: 'startup' });
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.match(ctx, /skills\/history\/scripts\/query\.js/);
    assert.match(ctx, /recent <chat_id>/);
    assert.match(ctx, /search <term>/);
  });

  test('chronological order — oldest preloaded message first', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'oldest' },
      { msg_id: 2, ts: 1_700_000_001_000, user: 'Ivan', text: 'middle' },
      { msg_id: 3, ts: 1_700_000_002_000, user: 'Ivan', text: 'newest' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', since: null });
    const result = await hook({ source: 'startup' });
    const ctx = result.hookSpecificOutput.additionalContext;
    const oldestPos = ctx.indexOf('oldest');
    const middlePos = ctx.indexOf('middle');
    const newestPos = ctx.indexOf('newest');
    assert.ok(oldestPos > -1 && middlePos > -1 && newestPos > -1);
    assert.ok(oldestPos < middlePos);
    assert.ok(middlePos < newestPos);
  });
});

describe('makeSessionStartHook — skips on resume / compact', () => {
  test('source=resume → returns continue:true with NO additionalContext', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: Date.now(), user: 'Ivan', text: 'hi' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', since: null });
    const result = await hook({ source: 'resume' });
    assert.deepEqual(result, { continue: true });
  });

  test('source=compact → returns continue:true with NO additionalContext', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: Date.now(), user: 'Ivan', text: 'hi' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', since: null });
    const result = await hook({ source: 'compact' });
    assert.deepEqual(result, { continue: true });
  });
});

describe('makeSessionStartHook — empty / boundary cases', () => {
  test('chat with NO history → returns continue:true (no preload)', async () => {
    const hook = makeSessionStartHook({ db, chatId: 'never-talked-here', since: null });
    const result = await hook({ source: 'startup' });
    assert.deepEqual(result, { continue: true });
  });

  test('honours the limit option — preloads at most N', async () => {
    const msgs = [];
    for (let i = 1; i <= 30; i++) {
      msgs.push({
        msg_id: i,
        ts: 1_700_000_000_000 + i * 1000,
        user: 'Ivan',
        text: `msg-${i}`,
      });
    }
    seedMessages('12345', msgs);
    const hook = makeSessionStartHook({ db, chatId: '12345', limit: 5, since: null });
    const result = await hook({ source: 'startup' });
    const ctx = result.hookSpecificOutput.additionalContext;
    // Only the last 5 should appear
    assert.match(ctx, /msg-26/);
    assert.match(ctx, /msg-30/);
    assert.equal(ctx.includes('msg-25'), false);
  });

  test('thread_id filter only includes messages from that thread', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, thread_id: 't1', user: 'Ivan', text: 'in-thread' },
      { msg_id: 2, ts: 1_700_000_001_000, thread_id: 't2', user: 'Ivan', text: 'other-thread' },
    ]);
    const hook = makeSessionStartHook({ db, chatId: '12345', threadId: 't1', since: null });
    const result = await hook({ source: 'startup' });
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.match(ctx, /in-thread/);
    assert.equal(ctx.includes('other-thread'), false);
  });
});

describe('makeSessionStartHook — telemetry + error safety', () => {
  test('logEvent fires "history-preloaded" on non-empty injection', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: Date.now(), user: 'Ivan', text: 'hi' },
    ]);
    const events = [];
    const hook = makeSessionStartHook({
      db,
      chatId: '12345',
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });
    await hook({ source: 'startup' });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'history-preloaded');
    assert.equal(events[0].detail.chat_id, '12345');
    assert.equal(events[0].detail.row_count, 1);
  });

  test('logEvent does NOT fire when no rows preloaded', async () => {
    const events = [];
    const hook = makeSessionStartHook({
      db,
      chatId: 'empty-chat',
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });
    await hook({ source: 'startup' });
    assert.equal(events.length, 0);
  });

  test('hook never throws — DB error returns continue:true', async () => {
    // Construct a broken db whose .raw returns a stub that throws on query.
    const broken = {
      raw: {
        prepare: () => { throw new Error('db gone'); },
      },
    };
    const hook = makeSessionStartHook({ db: broken, chatId: '12345' });
    const result = await hook({ source: 'startup' });
    assert.deepEqual(result, { continue: true });
  });

  test('logEvent throwing does NOT break the hook', async () => {
    seedMessages('12345', [
      { msg_id: 1, ts: Date.now(), user: 'Ivan', text: 'hi' },
    ]);
    const hook = makeSessionStartHook({
      db,
      chatId: '12345',
      logEvent: () => { throw new Error('logger blew up'); },
    });
    const result = await hook({ source: 'startup' });
    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /<polygram-history/);
  });
});

describe('makeSessionStartHook — input validation', () => {
  test('throws when db is missing', () => {
    assert.throws(() => makeSessionStartHook({ chatId: '1' }), /db/);
  });

  test('throws when chatId is missing', () => {
    assert.throws(() => makeSessionStartHook({ db }), /chatId/);
  });
});

describe('formatRow — transcript line shape', () => {
  test('inbound (direction=in) uses user field', () => {
    const line = _formatRow({
      ts: 1_700_000_000_000,
      direction: 'in',
      user: 'Ivan Shumkov',
      text: 'hello',
    });
    assert.match(line, /Ivan Shumkov: hello/);
    assert.match(line, /^\[2023-/);                      // ISO timestamp prefix
  });

  test('outbound (direction=out) uses user or bot_name', () => {
    const line = _formatRow({
      ts: 1_700_000_000_000,
      direction: 'out',
      bot_name: 'shumabit',
      text: 'hi',
    });
    assert.match(line, /shumabit: hi/);
  });

  test('reply_to_id surfaces as [reply→#N]', () => {
    const line = _formatRow({
      ts: 1_700_000_000_000,
      direction: 'in',
      user: 'Ivan',
      reply_to_id: 42,
      text: 'response',
    });
    assert.match(line, /\[reply→#42\]/);
  });

  // attachments / voice flags live on a separate JOINed table so
  // the preload doesn't surface them; covered separately by the
  // attachments tests.

  test('text is truncated at 600 chars', () => {
    const longText = 'x'.repeat(900);
    const line = _formatRow({
      ts: 1_700_000_000_000,
      direction: 'in',
      user: 'Ivan',
      text: longText,
    });
    // Pull out the part after "Ivan: " — should be ≤ 600 chars
    const after = line.split('Ivan: ')[1] || '';
    assert.ok(after.length <= 600);
  });

  test('whitespace is collapsed (single line per message)', () => {
    const line = _formatRow({
      ts: 1_700_000_000_000,
      direction: 'in',
      user: 'Ivan',
      text: 'line1\n\n\nline2\t\ttabs',
    });
    assert.equal(line.includes('\n'), false);
    assert.match(line, /line1 line2 tabs/);
  });
});

describe('buildHistoryBlock — rc.52 inline preload', () => {
  test('returns formatted polygram-history block when messages exist', () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'hello' },
      { msg_id: 2, ts: 1_700_000_001_000, direction: 'out', user: 'shumobot', text: 'hi' },
    ]);
    const block = buildHistoryBlock({ db, chatId: '12345', since: null });
    assert.match(block, /<polygram-history /);
    assert.match(block, /chat_id="12345"/);
    assert.match(block, /preloaded="2"/);
    assert.match(block, /Ivan: hello/);
    assert.match(block, /shumobot: hi/);
    assert.match(block, /<\/polygram-history>/);
  });

  test('returns empty string when no messages exist', () => {
    const block = buildHistoryBlock({ db, chatId: 'empty-chat' });
    assert.equal(block, '');
  });

  test('excludes the message we are about to send (excludeMsgId)', () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'first message' },
      { msg_id: 2, ts: 1_700_000_001_000, user: 'Ivan', text: 'about-to-send message' },
    ]);
    const block = buildHistoryBlock({ db, chatId: '12345', excludeMsgId: 2, since: null });
    assert.match(block, /first message/);
    assert.doesNotMatch(block, /about-to-send/);
    assert.match(block, /preloaded="1"/);
  });

  test('thread_id filter scopes per-topic', () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'thread-A msg', thread_id: 'A' },
      { msg_id: 2, ts: 1_700_000_001_000, user: 'Ivan', text: 'thread-B msg', thread_id: 'B' },
    ]);
    const blockA = buildHistoryBlock({ db, chatId: '12345', threadId: 'A', since: null });
    assert.match(blockA, /thread-A msg/);
    assert.doesNotMatch(blockA, /thread-B msg/);
    assert.match(blockA, /thread_id="A"/);
  });

  // Cross-topic bleed fix (2026-06-09 Shumabit@UMI incident): a message in the
  // GENERAL topic (null thread) of an isolateTopics chat must NOT preload other
  // threads' history. Pre-fix `recent()` only filtered when threadId was truthy,
  // so the null/General case pulled the WHOLE chat across all topics — a "Yes" in
  // General got fed another topic's plan and acted on it.
  test('isolateTopics: General topic (null thread) does NOT pull other threads', () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'hire-topic plan', thread_id: '2251' },
      { msg_id: 2, ts: 1_700_000_001_000, user: 'Ivan', text: 'general-topic chatter', thread_id: null },
    ]);
    const block = buildHistoryBlock({ db, chatId: '12345', threadId: null, isolateTopics: true, since: null });
    assert.match(block, /general-topic chatter/);
    assert.doesNotMatch(block, /hire-topic plan/, 'General must NOT see thread 2251 — no cross-topic bleed');
  });

  test('isolateTopics false: chat-wide session still preloads all threads (unchanged)', () => {
    seedMessages('12345', [
      { msg_id: 1, ts: 1_700_000_000_000, user: 'Ivan', text: 'thread-X msg', thread_id: 'X' },
      { msg_id: 2, ts: 1_700_000_001_000, user: 'Ivan', text: 'general msg', thread_id: null },
    ]);
    const block = buildHistoryBlock({ db, chatId: '12345', threadId: null, isolateTopics: false, since: null });
    assert.match(block, /thread-X msg/);
    assert.match(block, /general msg/);
  });

  test('returns empty when db is missing or chatId missing (defensive)', () => {
    assert.equal(buildHistoryBlock({}), '');
    assert.equal(buildHistoryBlock({ db, chatId: '' }), '');
  });

  test('row count visible in preloaded= attr (operator forensics)', () => {
    seedMessages('12345', Array.from({ length: 5 }, (_, i) => ({
      msg_id: i + 1, ts: 1_700_000_000_000 + i * 1000, user: 'Ivan', text: 'm' + i,
    })));
    const block = buildHistoryBlock({ db, chatId: '12345', since: null });
    assert.match(block, /preloaded="5"/);
  });
});
