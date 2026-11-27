'use strict';

/**
 * Agents refer to Telegram messages by link, never by a bare number.
 *
 * "The files are in message 3497" is something nobody can click. The display
 * hint every bot, chat and backend gets states the rule and the link formats,
 * and gives the current chat's link base, so the agent only appends the
 * message id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPolygramDisplayHint } = require('../lib/telegram/display-hint');

test('the hint states the rule and the link formats', () => {
  const hint = buildPolygramDisplayHint(false, { chatId: '-1004462674958', threadId: '1306' });
  assert.match(hint, /give its link, never a bare number/i);
  assert.match(hint, /https:\/\/t\.me\/c\/<id>\/<thread>\/<message>/);
  assert.match(hint, /https:\/\/t\.me\/c\/<id>\/<message>/);
  assert.match(hint, /a topic `https:\/\/t\.me\/c\/<id>\/<thread>`/);
  assert.match(hint, /without its -100 prefix/);
});

test('a forum topic gets its own message-link base', () => {
  const hint = buildPolygramDisplayHint(true, { chatId: '-1004462674958', threadId: '1306' });
  assert.match(hint, /Links here: https:\/\/t\.me\/c\/4462674958\/1306\/<message id>/);
});

test('a supergroup without topics gets the chat-level base', () => {
  const hint = buildPolygramDisplayHint(true, { chatId: -1004462674958, threadId: null });
  assert.match(hint, /Links here: https:\/\/t\.me\/c\/4462674958\/<message id>/);
});

test('a private chat is told links do not exist there', () => {
  const hint = buildPolygramDisplayHint(true, { chatId: '123456789', threadId: null });
  assert.doesNotMatch(hint, /Links here:/);
  assert.match(hint, /There are no message links in this chat: quote the message instead\./);
  assert.doesNotMatch(hint, /reply_to/, 'the reply tool has no reply_to parameter to point at');
});

test('a basic group (no -100 prefix) gets no invented link either', () => {
  const hint = buildPolygramDisplayHint(false, { chatId: '-4012345', threadId: null });
  assert.doesNotMatch(hint, /Links here:/);
  assert.match(hint, /no message links in this chat/i);
});

test('a mailbox session is told to point at roles and messages elsewhere by the links the mailbox gave', () => {
  const at = { chatId: '-1004462674958', threadId: '1306' };
  const hint = buildPolygramDisplayHint(true, { ...at, mailbox: true });
  assert.match(hint, /another role or topic, give its `link` from the mailbox directory/);
  assert.match(hint, /a message elsewhere, give the link the mailbox gave for it/);
  assert.doesNotMatch(buildPolygramDisplayHint(true, at), /mailbox/i, 'a session without the mailbox hears nothing of it');
  assert.equal(buildPolygramDisplayHint(true, { ...at, mailbox: true }), hint, 'the same inputs build the same hint');
});

test('every place polygram builds a session\'s hint uses the one builder, so they never drift', () => {
  // The spawn context and the factory's resolver must build the SAME hint, or
  // every message is drift and a respawn; the SDK path must agree with them.
  // So polygram builds it in one function, and each site calls only that.
  const polygram = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
  const builds = [...polygram.matchAll(/buildPolygramDisplayHint\(/g)];
  assert.equal(builds.length, 1, 'polygram.js builds the hint in exactly one place');
  const builder = /function sessionDisplayHint\(chatId, threadId\) \{\n([\s\S]*?)\n\}/.exec(polygram)?.[1] ?? '';
  assert.match(builder, /buildPolygramDisplayHint\(/, 'that place is sessionDisplayHint');
  assert.match(builder, /\{ inlineMedia: true, chatId, threadId: threadId \|\| null, mailbox: /, builder);
  assert.match(polygram, /displayHint: sessionDisplayHint\(chatId, threadId \|\| null\),/, 'the spawn context');
  const injected = [...polygram.matchAll(/displayHint: sessionDisplayHint,/g)];
  assert.equal(injected.length, 2, 'the factory resolver and the SDK options both take it');
  assert.match(polygram, /createBuildSdkOptions\(\{[^}]*displayHint: sessionDisplayHint,/);
});

test('the SDK options use the hint builder they are given', () => {
  const { createBuildSdkOptions } = require('../lib/sdk/build-options');
  const seen = [];
  const build = createBuildSdkOptions({ config: { defaults: {}, bot: {}, chats: { '-1004462674958': {} } }, botName: 'test', childHome: '/tmp/x',
    makeCanUseTool: () => async () => ({ behavior: 'allow' }), logEvent: () => {}, logger: { log() {}, warn() {}, error() {} },
    processEnv: { PATH: '/usr/bin', HOME: '/tmp' },
    displayHint: (chatId, threadId) => { seen.push([chatId, threadId]); return '## The one hint'; } });
  const out = build('-1004462674958:1306', { chatConfig: { cwd: '/tmp' }, chatId: '-1004462674958', threadId: '1306', label: 'x', existingSessionId: null });
  assert.deepEqual(seen, [['-1004462674958', '1306']]);
  assert.match(out.systemPrompt.append, /## The one hint/);
});
