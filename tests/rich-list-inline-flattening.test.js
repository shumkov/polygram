'use strict';

// Production repro (shumabit, first day of live rich rendering on the
// reply-tool path, 2026-07-29): inline markdown inside LIST ITEMS reached
// the chat as literal characters — "**«In stock»**" and
// "`snippets/inventory-status.liquid`" rendered with their markers —
// while the same constructs in top-level paragraphs flattened correctly.
//
// Cause: marked wraps each list item's inline run in a block-level 'text'
// token that CARRIES nested inline tokens, and plainTextOf's 'text'
// branch emitted t.text (the raw source, markers included) before the
// nested-token recursion could run. Paragraphs were immune because their
// children arrive as inline leaves directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toTelegramRichBlocks, _plainTextOf } = require('../lib/telegram/rich');

function collectText(blocks, out = []) {
  for (const b of blocks || []) {
    if (typeof b.text === 'string') out.push(b.text);
    if (Array.isArray(b.blocks)) collectText(b.blocks, out);
    if (Array.isArray(b.items)) {
      for (const it of b.items) collectText(it.blocks || [], out);
    }
    if (Array.isArray(b.cells)) {
      for (const row of b.cells) for (const c of row) if (typeof c.text === 'string') out.push(c.text);
    }
  }
  return out;
}

test('list items flatten bold and code spans instead of leaking markers', () => {
  const text = [
    '## Индикатор наличия',
    '',
    '- `snippets/inventory-status.liquid` умеет показывать зелёное **«In stock»** / оранжевое **«Low stock»**',
    '- на **плитках коллекций уже работает**',
    '- в `main-product.liquid` его нет',
  ].join('\n');
  const { blocks, usedRich } = toTelegramRichBlocks(text);
  assert.equal(usedRich, true);
  const texts = collectText(blocks).join('\n');
  assert.ok(texts.includes('snippets/inventory-status.liquid'), 'code-span content survives');
  assert.ok(texts.includes('«In stock»'), 'bold content survives');
  assert.ok(!texts.includes('**'), `bold markers leaked: ${texts}`);
  assert.ok(!texts.includes('`'), `code-span markers leaked: ${texts}`);
});

test('nested lists and blockquoted lists flatten the same way', () => {
  const text = [
    '> quoted intro',
    '',
    '- outer **bold**',
    '  - inner `code` and *italic*',
    '',
    '1. ordered with **markers**',
  ].join('\n');
  const { blocks } = toTelegramRichBlocks(text);
  const texts = collectText(blocks).join('\n');
  assert.ok(!/[*`]/.test(texts.replace(/\*(?!\*)/g, '')), `markers leaked: ${texts}`);
  assert.ok(texts.includes('inner code and italic'), 'nested item flattened');
  assert.ok(texts.includes('ordered with markers'), 'ordered item flattened');
});

test('a bare text token without nested tokens still emits its text', () => {
  assert.equal(_plainTextOf([{ type: 'text', text: 'plain leaf' }]), 'plain leaf');
});

test('task items never ship their [ ]/[x] markers alongside the real checkbox', () => {
  // Production repro 2026-07-29: every checklist rendered a checkbox AND
  // the literal marker ("[ ] first step"). The 0.24.1 flatten fix recurses
  // into the item's child tokens, which still CONTAIN the marker — marked
  // strips it only from the container's .text, the field the old code read.
  const { blocks } = toTelegramRichBlocks('## Plan\n\n- [ ] first step\n- [x] done step');
  const texts = collectText(blocks).join('\n');
  assert.ok(texts.includes('first step'));
  assert.ok(texts.includes('done step'));
  assert.ok(!/\[[ xX]\]/.test(texts), `marker leaked: ${texts}`);
  const list = blocks.find((b) => b.type === 'list');
  assert.equal(list.items[0].has_checkbox, true);
  assert.equal(list.items[1].is_checked, true);
});
