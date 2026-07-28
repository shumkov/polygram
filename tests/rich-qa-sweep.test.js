'use strict';

// Production QA sweep findings (2026-07-29, adversarial re-render of the
// rich-enabled chats' content shapes):
//  1. LOOSE task lists (blank line between items — the natural authoring
//     shape for items with explanations) leak their [ ]/[x] markers in
//     both styled and flat modes: marked routes loose-item content through
//     paragraph BLOCK tokens, bypassing the tight-list leader strip.
//  2. <details> summaries never flatten markdown — "**Логи** с `кодом`"
//     ships its markers literally into the summary chip.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');

function allTexts(blocks, out = []) {
  for (const b of blocks || []) {
    if (typeof b.text === 'string') out.push(b.text);
    else if (Array.isArray(b.text)) for (const n of b.text) out.push(typeof n === 'string' ? n : JSON.stringify(n));
    if (typeof b.summary === 'string') out.push(b.summary);
    if (Array.isArray(b.blocks)) allTexts(b.blocks, out);
    if (Array.isArray(b.items)) for (const it of b.items) allTexts(it.blocks || [], out);
  }
  return out;
}

for (const styled of [false, true]) {
  test(`loose task lists strip their markers (inlineStyling: ${styled})`, () => {
    const { blocks } = toTelegramRichBlocks(
      '- [ ] первый **шаг**\n\n- [x] второй `шаг`\n\n- [ ] третий',
      { inlineStyling: styled },
    );
    const joined = allTexts(blocks).join('\n');
    assert.ok(joined.includes('первый'), 'content survives');
    assert.ok(!/\[[ xX]\]/.test(joined), `marker leaked: ${joined}`);
    const list = blocks.find((b) => b.type === 'list');
    assert.equal(list.items[0].has_checkbox, true);
    assert.equal(list.items[1].is_checked, true);
  });
}

test('details summaries flatten markdown instead of leaking markers', () => {
  const { blocks } = toTelegramRichBlocks(
    '<details><summary>**Логи** с `кодом`</summary>\n\ntext body\n\n</details>',
  );
  const details = blocks.find((b) => b.type === 'details');
  assert.equal(details.summary, 'Логи с кодом', `got: ${details.summary}`);
});

test('details summaries flatten markdown on the split-token path too', () => {
  const { blocks } = toTelegramRichBlocks(
    '<details>\n<summary>**Логи** с `кодом`</summary>\n\nparagraph one\n\n</details>',
  );
  const details = blocks.find((b) => b.type === 'details');
  assert.equal(details.summary, 'Логи с кодом', `got: ${details.summary}`);
});
