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

test('every place polygram builds the hint passes the chat and topic', () => {
  // The spawn context and the factory's resolver must build the SAME hint, or
  // every message is drift and a respawn; the SDK path builds its own.
  const polygram = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk', 'build-options.js'), 'utf8');
  const calls = [...polygram.matchAll(/buildPolygramDisplayHint\(\n[^\n]*\n\s*(\{[^}\n]*\})/g)].map((m) => m[1]);
  assert.equal(calls.length, 2, calls.join('\n---\n'));
  for (const call of calls) assert.match(call, /\{ inlineMedia: true, chatId, threadId(?:: threadId \|\| null)? \}/, call);
  assert.match(sdk, /\{ inlineMedia: true, chatId, threadId \}/);
});
