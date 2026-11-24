'use strict';

// A role mentions a person who has no Telegram username (Linh) with a link to
// tg://user?id=<id>. The mention must reach Telegram as a text mention in any
// reply shape, and no other tg:// or non-web link target may reach Telegram as
// a clickable link: the agent's text is influenced by whoever talks to it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toTelegramHtml } = require('../lib/telegram/format');
const { needsRichRendering } = require('../lib/telegram/rich');

const LINH = '[Linh](tg://user?id=8616081456)';

describe('a mention link reaches Telegram as a text mention', () => {
  test('the HTML renderer keeps a tg://user link as an anchor', () => {
    const { text } = toTelegramHtml(`${LINH}, please confirm the ad budget.`);
    assert.match(text, /<a href="tg:\/\/user\?id=8616081456">Linh<\/a>/);
  });

  test('a reply with a list and a mention stays on the HTML path, so the mention survives', () => {
    // The rich renderer keeps only http(s) link nodes and would drop the
    // mention, so the gate must not choose rich for this reply.
    const reply = `${LINH}, two things before Friday:\n\n- the budget\n- the creatives`;
    assert.equal(needsRichRendering(reply), false);
  });

  test('a reply with a mention and an image still renders rich, because media needs the rich path', () => {
    const reply = `${LINH}, the new banner:\n\n![banner](/tmp/banner.png)`;
    assert.equal(needsRichRendering(reply), true);
  });

  test('a mention inside a code fence does not change the decision', () => {
    const reply = '- one\n- two\n\n```\n[Linh](tg://user?id=8616081456)\n```';
    assert.equal(needsRichRendering(reply), true);
  });

  test('a list without a mention still renders rich', () => {
    assert.equal(needsRichRendering('- one\n- two'), true);
  });
});

describe('only web links and person mentions become clickable', () => {
  for (const [name, href] of [
    ['tg://resolve', 'tg://resolve?domain=evil_bot'],
    ['tg://proxy', 'tg://proxy?server=1.2.3.4&port=443&secret=abc'],
    ['tg://login', 'tg://login?token=abc'],
    ['tg://user with an extra parameter', 'tg://user?id=1&x=2'],
    ['javascript:', 'javascript:alert(1)'],
    ['a relative path', 'README.md'],
  ]) {
    test(`${name}: the link keeps its label and loses its target`, () => {
      const { text } = toTelegramHtml(`Open [this](${href}) now`);
      assert.doesNotMatch(text, /<a\b/);
      assert.match(text, /Open this now/);
    });
  }

  test('an image with a non-web target renders its label without a link', () => {
    const { text } = toTelegramHtml('![shot](tg://proxy?server=1)');
    assert.doesNotMatch(text, /<a\b/);
    assert.match(text, /shot/);
  });

  test('http and https links are unchanged', () => {
    const { text } = toTelegramHtml('[a](http://example.com) [b](https://example.com/x?y=1)');
    assert.match(text, /<a href="http:\/\/example\.com">a<\/a>/);
    assert.match(text, /<a href="https:\/\/example\.com\/x\?y=1">b<\/a>/);
  });
});
