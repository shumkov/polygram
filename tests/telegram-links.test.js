'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { topicLink, messageLink, parseMessageLink, landedAt } = require('../lib/telegram/links');

// A wrong link is worse than none: a reader who follows it lands somewhere
// unrelated. Every case that cannot be proven right must return null.

test('a forum topic links by its thread, with the -100 prefix stripped', () => {
  assert.equal(topicLink({ chatId: '-1004292131077', threadId: '732' }), 'https://t.me/c/4292131077/732');
  assert.equal(topicLink({ chatId: -1004292131077, threadId: 732 }), 'https://t.me/c/4292131077/732', 'numeric ids give the same link');
});

test('General links to message 1 only in a chat proven to be a forum', () => {
  assert.equal(topicLink({ chatId: '-1004462674958', threadId: null, forum: true }), 'https://t.me/c/4462674958/1');
  // In a plain supergroup, /1 opens the group's first message, not a topic.
  assert.equal(topicLink({ chatId: '-1004462674958', threadId: null, forum: false }), null);
  assert.equal(topicLink({ chatId: '-1004462674958', threadId: null }), null, 'unknown forum status gives no link');
});

test('basic groups, DMs and malformed ids have no links', () => {
  for (const chatId of ['-5492080337', '68861949', '-100', '-100abc', '', null, undefined, '-1001x23']) {
    assert.equal(topicLink({ chatId, threadId: '7' }), null, String(chatId));
    assert.equal(topicLink({ chatId, threadId: null, forum: true }), null, String(chatId));
    assert.equal(messageLink({ chatId, threadId: null, messageId: 5 }), null, String(chatId));
  }
  for (const threadId of ['0', '-3', 'x', '7/8', '1.5']) {
    assert.equal(topicLink({ chatId: '-1001', threadId }), null, threadId);
    assert.equal(messageLink({ chatId: '-1001', threadId, messageId: 5 }), null, threadId);
  }
});

test('a message links through its thread, or straight to the chat without one', () => {
  assert.equal(messageLink({ chatId: '-1004292131077', threadId: '732', messageId: 991 }), 'https://t.me/c/4292131077/732/991');
  assert.equal(messageLink({ chatId: '-1004292131077', threadId: null, messageId: 991 }), 'https://t.me/c/4292131077/991');
  for (const messageId of [0, -1, 1.5, '991', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(messageLink({ chatId: '-1004292131077', threadId: null, messageId }), null, String(messageId));
  }
});

test('a message link parses back to its chat, thread and message', () => {
  assert.deepEqual(parseMessageLink('https://t.me/c/4292131077/732/991'), { chatId: '-1004292131077', threadId: '732', messageId: 991 });
  assert.deepEqual(parseMessageLink('https://t.me/c/4292131077/991'), { chatId: '-1004292131077', threadId: null, messageId: 991 });
  for (const url of ['http://t.me/c/1/2', 'https://t.me/c/1', 'https://t.me/c/1/2/3/4', 'https://t.me/someone/5', 'https://evil.example/c/1/2',
    'https://t.me/c/1/0', 'https://t.me/c/1/2?single', ' https://t.me/c/1/2', 'https://t.me/c/1/99999999999999999999', 42, null]) {
    assert.equal(parseMessageLink(url), null, String(url));
  }
});

test('a receipt proves a card landed only where it was sent', () => {
  const sent = { message_id: 991, chat: { id: -1004292131077 }, message_thread_id: 732 };
  assert.equal(landedAt(sent, { chatId: '-1004292131077', threadId: '732' }), true, 'a numeric echo matches string config ids');
  assert.equal(landedAt({ message_id: 5, chat: { id: -1004462674958 } }, { chatId: '-1004462674958', threadId: null }), true,
    'General has no thread on either side');
  assert.equal(landedAt({ message_id: 5, chat: { id: 68861949 } }, { chatId: '68861949', threadId: null }), true,
    'a DM card landed where it was sent, though it can have no link');
  // A dropped topic lands the card in General: a link would point at the wrong place.
  assert.equal(landedAt({ message_id: 5, chat: { id: -1004292131077 } }, { chatId: '-1004292131077', threadId: '732' }), false);
  assert.equal(landedAt({ ...sent, message_thread_id: 733 }, { chatId: '-1004292131077', threadId: '732' }), false);
  assert.equal(landedAt({ ...sent, chat: { id: -1009999999999 } }, { chatId: '-1004292131077', threadId: '732' }), false);
  assert.equal(landedAt({ message_id: 991 }, { chatId: '-1004292131077', threadId: null }), false, 'no chat in the receipt');
  assert.equal(landedAt({ chat: { id: -1004292131077 } }, { chatId: '-1004292131077', threadId: null }), false, 'no message id');
  assert.equal(landedAt(null, { chatId: '-1004292131077', threadId: null }), false);
});
