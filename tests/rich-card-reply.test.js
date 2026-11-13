'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReplyToBlock } = require('../lib/prompt');
const { normalizeRichInbound } = require('../lib/telegram/rich-inbound');

const card = (url, before = '', after = '') => ({ message_id: 42, from: { is_bot: true, first_name: 'Bot' }, rich_message: { blocks: [
  { type: 'blockquote', blocks: [
    { type: 'paragraph', text: before },
    { type: 'paragraph', text: [{ type: 'url', text: [{ type: 'bold', text: '🙂 Новые цены 🔥' }], url }] },
    { type: 'details', summary: 'More', is_open: false, blocks: [{ type: 'paragraph', text: after }] },
  ] },
] } });
const bodyOf = (block) => block.split('\n').slice(1, -1).join('\n')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

test('replying to a rich task card loses the Notion URL that identifies agent-org task', () => {
  const url = 'https://www.notion.so/0123456789abcdef0123456789abcdef';
  for (const normalized of [false, true]) {
    const replied = card(url, '🙂'.repeat(350), 'я'.repeat(900));
    if (normalized) normalizeRichInbound({ text: 'Do this', reply_to_message: replied });
    const body = bodyOf(buildReplyToBlock({ telegram: replied }));
    assert.ok(body.includes(`🙂 Новые цены 🔥 <${url}>`));
    assert.ok(body.length <= 500);
    assert.ok(body.isWellFormed());
    assert.equal(body.split(url).length - 1, 1, 'only the atomic target, no truncated Markdown URL');
  }
});

test('an oversized rich URL is omitted whole while a later fitting target survives', () => {
  const huge = `https://notion.so/${'x'.repeat(700)}`;
  const short = 'https://notion.so/real-task';
  const replied = card(huge, 'Start'.repeat(80), 'End'.repeat(100));
  replied.rich_message.blocks[0].blocks.push({ type: 'paragraph', text: [{ type: 'url', text: 'Task title', url: short }] });
  normalizeRichInbound({ text: 'Do this', reply_to_message: replied });
  const body = bodyOf(buildReplyToBlock({ telegram: replied }));
  assert.ok(body.includes(`<${short}>`));
  assert.ok(!body.includes('https://notion.so/xxx'), 'no partial oversized URL remains in surrounding text');
  assert.ok(body.includes('…'));
  assert.ok(body.length <= 500);
});

test('rich targets deduplicate with text_link entities and remain XML-escaped', () => {
  const url = 'https://notion.so/task?a=1&b=2';
  const replied = { ...card(url), text: 'title', entities: [{ type: 'text_link', offset: 0, length: 5, url }] };
  const block = buildReplyToBlock({ telegram: replied });
  assert.equal(bodyOf(block).split(url).length - 1, 1);
  assert.ok(block.includes('&lt;https://notion.so/task?a=1&amp;b=2&gt;'));
});

test('rich reply traversal tolerates malformed and excessively nested nodes', () => {
  const replied = card('https://notion.so/task');
  let nested = { type: 'url', text: 'Not visible', url: 'https://notion.so/too-deep' };
  for (let i = 0; i < 100; i++) nested = { type: 'bold', text: nested };
  replied.rich_message.blocks.push(null, { type: 'paragraph', text: [nested, { type: 'url', url: null, text: 'Still visible' }] });
  const body = bodyOf(buildReplyToBlock({ telegram: replied }));
  assert.ok(body.includes('<https://notion.so/task>'));
  assert.ok(!body.includes('too-deep'));
  assert.ok(body.includes('Still visible'));
});

test('a URL nested inside closed details survives truncation of the card body', () => {
  const replied = card('https://notion.so/task', 'x'.repeat(600), 'y'.repeat(600));
  replied.rich_message.blocks[0].blocks[2].blocks.push({ type: 'paragraph', text: [
    { type: 'italic', text: { type: 'url', text: 'Related task', url: 'https://notion.so/related' } },
  ] });
  normalizeRichInbound({ text: 'Follow up', reply_to_message: replied });
  const body = bodyOf(buildReplyToBlock({ telegram: replied }));
  assert.ok(body.includes('Related task <https://notion.so/related>'));
  assert.ok(body.includes('<https://notion.so/task>'));
  assert.ok(body.length <= 500);
});
