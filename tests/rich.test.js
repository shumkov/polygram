const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  needsRichRendering,
  toTelegramRichBlocks,
  resolveRichTextEnabled,
  isRichCapabilityError,
  isRichContentError,
} = require('../lib/telegram/rich');

describe('resolveRichTextEnabled — topic → chat → bot → default precedence', () => {
  test('defaults to false with no config anywhere', () => {
    const config = { chats: {}, bot: {}, defaults: {} };
    assert.equal(resolveRichTextEnabled(config, '123'), false);
  });

  test('config.defaults.richText sets the fleet-wide default', () => {
    const config = { chats: {}, bot: {}, defaults: { richText: true } };
    assert.equal(resolveRichTextEnabled(config, '123'), true);
  });

  test('config.bot.richText overrides defaults', () => {
    const config = { chats: {}, bot: { richText: true }, defaults: { richText: false } };
    assert.equal(resolveRichTextEnabled(config, '123'), true);
  });

  test('chat-level richText overrides bot-level', () => {
    const config = {
      chats: { 123: { richText: true } },
      bot: { richText: false },
      defaults: { richText: false },
    };
    assert.equal(resolveRichTextEnabled(config, '123'), true);
  });

  test('topic-level richText overrides chat-level', () => {
    const config = {
      chats: { 123: { richText: false, topics: { 5: { richText: true } } } },
      bot: {},
      defaults: {},
    };
    assert.equal(resolveRichTextEnabled(config, '123', '5'), true);
  });

  test('an unrelated topic falls through to the chat-level value, not the topic default', () => {
    const config = {
      chats: { 123: { richText: true, topics: { 5: {} } } },
      bot: {},
      defaults: {},
    };
    assert.equal(resolveRichTextEnabled(config, '123', '5'), true);
  });

  test('non-boolean values at a tier are treated as unset, not coerced', () => {
    const config = {
      chats: { 123: { richText: 'yes' } }, // hand-edited garbage
      bot: {},
      defaults: { richText: true },
    };
    assert.equal(resolveRichTextEnabled(config, '123'), true);
  });
});

describe('needsRichRendering — the content-adaptive gate', () => {
  test('plain prose does not trigger rich', () => {
    assert.equal(needsRichRendering('Just a normal reply with **bold** and a [link](https://x.com).'), false);
  });

  test('empty / non-string input does not trigger rich', () => {
    assert.equal(needsRichRendering(''), false);
    assert.equal(needsRichRendering(null), false);
    assert.equal(needsRichRendering(undefined), false);
  });

  test('a task-list item triggers rich', () => {
    assert.equal(needsRichRendering('- [ ] do the thing'), true);
    assert.equal(needsRichRendering('- [x] done'), true);
  });

  test('a markdown table triggers rich', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    assert.equal(needsRichRendering(md), true);
  });

  test('a <details> block triggers rich', () => {
    assert.equal(needsRichRendering('<details><summary>More</summary>hidden</details>'), true);
  });

  test('a heading triggers rich', () => {
    assert.equal(needsRichRendering('# Report\n\nSome text'), true);
    assert.equal(needsRichRendering('### Subsection'), true);
  });

  test('a bare bullet list (no checkboxes) does NOT trigger rich', () => {
    assert.equal(needsRichRendering('- item one\n- item two'), false);
  });

  test('a single dash in prose does not false-positive as a task item', () => {
    assert.equal(needsRichRendering('This - that, and more.'), false);
  });

  test('a blockquote triggers rich', () => {
    assert.equal(needsRichRendering('> a quoted aside'), true);
    assert.equal(needsRichRendering('Some text.\n\n> caveat here\n\nMore text.'), true);
  });

  test('a bare ">" with no following content does not false-positive as a blockquote', () => {
    assert.equal(needsRichRendering('score > 5 and rising'), false);
    assert.equal(needsRichRendering('>'), false);
  });

  test('a divider (---) on its own line triggers rich', () => {
    assert.equal(needsRichRendering('Section one.\n\n---\n\nSection two.'), true);
    assert.equal(needsRichRendering('***'), true);
    assert.equal(needsRichRendering('___'), true);
  });

  test('a single dash line does not false-positive as a divider', () => {
    assert.equal(needsRichRendering('-'), false);
    assert.equal(needsRichRendering('--'), false);
  });
});

describe('needsRichRendering — fenced code blocks never count as structure', () => {
  // Content inside a fence renders literally, so Markdown-looking text
  // there cannot be a structural signal for rich rendering.
  test('a shell comment ("# ...") inside a fenced code block is not a heading', () => {
    const md = '```bash\n# download the model (~140MB)\ncurl -O https://example.com/model\n```';
    assert.equal(needsRichRendering(md), false);
  });

  test('a "- [ ]" pattern inside a fenced code block is not a task item', () => {
    const md = '```markdown\n- [ ] example task syntax\n```';
    assert.equal(needsRichRendering(md), false);
  });

  test('a table-separator-looking line inside a fenced code block is not a table', () => {
    const md = '```\n| a | b |\n|---|---|\n```';
    assert.equal(needsRichRendering(md), false);
  });

  test('a REAL heading immediately after a code fence still triggers rich', () => {
    const md = '```js\nconst x = 1;\n```\n\n# Real Heading';
    assert.equal(needsRichRendering(md), true);
  });

  test('a REAL heading immediately before a code fence still triggers rich', () => {
    const md = '# Real Heading\n\n```js\nconst x = 1;\n```';
    assert.equal(needsRichRendering(md), true);
  });

  test('tilde fences (~~~) are also scoped out', () => {
    const md = '~~~\n# not a heading\n~~~';
    assert.equal(needsRichRendering(md), false);
  });

  test('a would-be closing fence with trailing content does not close the block', () => {
    // "```extra" after the opening fence is still inside the code block
    // per CommonMark (info strings are opener-only) — a naive "any 3+
    // backticks toggles" scan would treat this as closing and then see
    // the real-looking heading below as outside the fence.
    const md = '```\ncode\n```extra\n# not actually reachable as a heading either way, but the fence must still be open here';
    assert.equal(needsRichRendering(md), false, 'the whole thing is still one open code block per CommonMark — nothing outside it to trigger on');
  });

  test('a genuine heading AFTER a properly-closed fence (even with an info string on the close-looking line) still triggers', () => {
    const md = '```\ncode\n```\n\n# Real Heading';
    assert.equal(needsRichRendering(md), true);
  });

  test('a shorter closing marker than the opener does not close the fence', () => {
    // Opened with 4 backticks, "closed" with 3 — per CommonMark the
    // closer must have >= the opener's length, so this is still open.
    const md = '````\n# not a heading, fence opened with 4 backticks\n```\nstill inside\n````';
    assert.equal(needsRichRendering(md), false);
  });

  test('an unterminated fence still scopes out everything after it (safe default)', () => {
    const md = 'intro\n```\n# not a heading, fence never closes';
    assert.equal(needsRichRendering(md), false);
  });

  test('content with no backtick or tilde at all skips the fence scan entirely (fast path)', () => {
    assert.equal(needsRichRendering('# Just a heading, no code anywhere'), true);
  });

  test('a ">" quote-looking line inside a fenced code block is not a blockquote', () => {
    const md = '```\n> not a real blockquote, just quoted shell output\n```';
    assert.equal(needsRichRendering(md), false);
  });

  test('a "---" divider-looking line inside a fenced code block is not a divider', () => {
    const md = '```\n---\n```';
    assert.equal(needsRichRendering(md), false);
  });
});

describe('needsRichRendering — ReDoS guard', () => {
  test('pathological input does not hang the gate', () => {
    const evil = '-'.repeat(50000) + '|'.repeat(50000);
    const start = Date.now();
    needsRichRendering(evil);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `gate took ${elapsed}ms on adversarial input — possible ReDoS`);
  });

  test('long line with no match terminates quickly', () => {
    const evil = 'a'.repeat(200000);
    const start = Date.now();
    needsRichRendering(evil);
    assert.ok(Date.now() - start < 500);
  });
});

describe('toTelegramRichBlocks — block shapes', () => {
  test('plain prose returns usedRich:false and no blocks', () => {
    const r = toTelegramRichBlocks('just prose');
    assert.equal(r.usedRich, false);
    assert.deepEqual(r.blocks, []);
  });

  test('heading maps to a heading block with clamped size', () => {
    const r = toTelegramRichBlocks('# Title\n\n####### too deep');
    const headings = r.blocks.filter((b) => b.type === 'heading');
    assert.equal(headings[0].text, 'Title');
    assert.equal(headings[0].size, 1);
  });

  test('checkbox list item sets has_checkbox/is_checked', () => {
    const r = toTelegramRichBlocks('- [ ] pending\n- [x] done');
    const list = r.blocks.find((b) => b.type === 'list');
    assert.ok(list, 'expected a list block');
    assert.equal(list.items[0].has_checkbox, true);
    assert.equal(list.items[0].is_checked, undefined);
    assert.equal(list.items[1].has_checkbox, true);
    assert.equal(list.items[1].is_checked, true);
  });

  test('plain bullet items (no checkbox present anywhere) omit has_checkbox', () => {
    const r = toTelegramRichBlocks('# heading forces rich\n\n- a\n- b');
    const list = r.blocks.find((b) => b.type === 'list');
    assert.equal(list.items[0].has_checkbox, undefined);
  });

  test('ordered list items get a numeric value', () => {
    const r = toTelegramRichBlocks('# h\n\n3. third\n4. fourth');
    const list = r.blocks.find((b) => b.type === 'list');
    assert.equal(list.items[0].value, 3);
    assert.equal(list.items[1].value, 4);
  });

  test('table maps header + rows to cells, header row flagged', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const r = toTelegramRichBlocks(md);
    const table = r.blocks.find((b) => b.type === 'table');
    assert.equal(table.cells[0][0].text, 'a');
    assert.equal(table.cells[0][0].is_header, true);
    assert.equal(table.cells[0][0].align, 'left');
    assert.equal(table.cells[0][0].valign, 'top');
    assert.equal(table.cells[1][0].text, '1');
    assert.equal(table.cells[1][0].is_header, undefined);
    assert.equal(table.cells.length, 3); // header + 2 data rows
  });

  test('table preserves supported horizontal alignment on every row', () => {
    const md = '| left | middle | right |\n| :--- | :---: | ---: |\n| a | b | c |';
    const table = toTelegramRichBlocks(md).blocks.find((b) => b.type === 'table');
    for (const row of table.cells) {
      assert.deepEqual(row.map((cell) => cell.align), ['left', 'center', 'right']);
      assert.deepEqual(row.map((cell) => cell.valign), ['top', 'top', 'top']);
    }
  });

  test('fenced code maps to a pre block with literal text', () => {
    const r = toTelegramRichBlocks('# h\n\n```js\nconst x = 1;\n```');
    const pre = r.blocks.find((b) => b.type === 'pre');
    assert.match(pre.text, /const x = 1;/);
  });

  test('blockquote maps to nested blocks', () => {
    const r = toTelegramRichBlocks('# h\n\n> quoted line');
    const bq = r.blocks.find((b) => b.type === 'blockquote');
    assert.ok(bq);
    assert.equal(bq.blocks[0].type, 'paragraph');
    assert.match(bq.blocks[0].text, /quoted line/);
  });

  test('horizontal rule maps to a divider block', () => {
    const r = toTelegramRichBlocks('# h\n\n---\n\nafter');
    assert.ok(r.blocks.some((b) => b.type === 'divider'));
  });

  test('<details> maps to a details block with summary + nested blocks', () => {
    const r = toTelegramRichBlocks('<details><summary>Click me</summary>\n\nhidden text\n\n</details>');
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    assert.equal(details.summary, 'Click me');
    assert.equal(details.is_open, false);
    assert.match(details.blocks[0].text, /hidden text/);
  });

  test('<details> without a summary gets the required fallback label', () => {
    const r = toTelegramRichBlocks('<details>hidden text</details>');
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    assert.equal(details.summary, 'Details');
  });

  test('blank-line <details> with an empty summary gets the required fallback label', () => {
    const r = toTelegramRichBlocks('<details><summary>   </summary>\n\nhidden text\n\n</details>');
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    assert.equal(details.summary, 'Details');
    assert.match(details.blocks[0].text, /hidden text/);
  });

  test('prose on the line after </details> (no blank line) is not dropped', () => {
    // marked folds "</details>\ntrailing prose" into ONE html token (an
    // HTML block runs until a blank line), so the close-token scan must
    // emit the content after the close tag, not skip the whole token.
    const md = '<details>\n<summary>Logs</summary>\n\nlog content here\n\n</details>\nAnd here is my conclusion.';
    const r = toTelegramRichBlocks(md);
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    const flat = JSON.stringify(r.blocks);
    assert.match(flat, /And here is my conclusion\./, 'content after </details> must survive');
  });

  test('text after a single-token <details>...</details> is not dropped', () => {
    const r = toTelegramRichBlocks('<details><summary>S</summary>hidden</details>Trailing conclusion.');
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    assert.match(JSON.stringify(r.blocks), /Trailing conclusion\./);
  });

  test('content preceding </details> inside the close token stays in the details body', () => {
    // "<hr>\nnote text\n</details>" arrives as one html token; the note
    // text before the close tag belongs inside the collapsible body.
    const md = '<details>\n<summary>S</summary>\n\nbody\n\n<hr>\nnote text\n</details>';
    const r = toTelegramRichBlocks(md);
    const details = r.blocks.find((b) => b.type === 'details');
    assert.ok(details);
    assert.match(JSON.stringify(details.blocks), /note text/);
  });

  test('two <details> blocks in one html token both render', () => {
    const r = toTelegramRichBlocks('<details><summary>A</summary>one</details><details><summary>B</summary>two</details>');
    const all = r.blocks.filter((b) => b.type === 'details');
    assert.equal(all.length, 2);
    assert.equal(all[0].summary, 'A');
    assert.equal(all[1].summary, 'B');
  });

  test('non-details raw HTML is stripped to plain text, never passed through', () => {
    const r = toTelegramRichBlocks('# h\n\n<div class="x"><script>alert(1)</script>hello</div>');
    const flat = JSON.stringify(r.blocks);
    assert.doesNotMatch(flat, /<script/);
    assert.doesNotMatch(flat, /<div/);
  });

  test('inline formatting is flattened to plain text', () => {
    const r = toTelegramRichBlocks('# h\n\nSome **bold** and a [link](https://x.com) here.');
    const para = r.blocks.find((b) => b.type === 'paragraph' && /bold/.test(b.text));
    assert.equal(para.text, 'Some bold and a link here.');
  });

  test('adversarial inline content renders as literal plain text with no link scheme', () => {
    // Pin the complete flattened text so no link target or URL scheme can
    // survive in any emitted block.
    const r = toTelegramRichBlocks('# h\n\nPayload: <b>injected</b> & [x](javascript:alert(1))');
    const para = r.blocks.find((b) => b.type === 'paragraph' && /Payload/.test(b.text));
    assert.doesNotMatch(para.text, /javascript:/i, 'the dangerous URL scheme must never survive into block text');
    // Literal "<b>...</b>" characters surviving AS TEXT is fine and
    // expected — this field is a plain JSON string Bot API treats as
    // opaque content, never re-parsed as HTML or Markdown
    // by this pipeline or (per the design) by Telegram's rich-block
    // schema. Pin the exact value so that assumption stays visible and
    // any drift in plainTextOf's link/html handling is caught exactly.
    assert.equal(para.text, 'Payload: <b>injected</b> & x');
  });
});

describe('toTelegramRichBlocks — partial mode (progressive streaming)', () => {
  test('holds back the trailing top-level block when partial:true', () => {
    const md = '# Title\n\nFirst paragraph.\n\nSecond paragraph.';
    const full = toTelegramRichBlocks(md, { partial: false });
    const partial = toTelegramRichBlocks(md, { partial: true });
    assert.equal(partial.blocks.length, full.blocks.length - 1);
    assert.deepEqual(partial.blocks, full.blocks.slice(0, -1));
  });

  test('does not drop the only block when partial:true and just one exists', () => {
    const md = '# Only Heading';
    const partial = toTelegramRichBlocks(md, { partial: true });
    assert.equal(partial.blocks.length, 1);
  });

  test('growing text sequence never produces a malformed (missing-required-field) block', () => {
    const growing = [
      '# Report',
      '# Report\n\n| a | b',
      '# Report\n\n| a | b |\n| - | -',
      '# Report\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    ];
    for (const chunk of growing) {
      const { blocks } = toTelegramRichBlocks(chunk, { partial: true });
      for (const b of blocks) {
        assert.ok(b.type, `block missing type in chunk: ${chunk}`);
        if (b.type === 'table') {
          for (const row of b.cells) assert.ok(Array.isArray(row));
        }
      }
    }
  });
});

describe('isRichCapabilityError — endpoint-missing errors latch', () => {
  test('matches a method-not-found style message', () => {
    assert.equal(isRichCapabilityError({ description: 'Bad Request: method "sendRichMessage" not found' }), true);
  });
  test('matches a method-not-found response from a server without rich-message support', () => {
    assert.equal(isRichCapabilityError({ error_code: 404, description: 'Not Found: method not found' }), true);
  });
  test('matches unknown-parameter rejections on editMessageText', () => {
    assert.equal(isRichCapabilityError({ description: 'Bad Request: unknown parameter "rich_message"' }), true);
    assert.equal(isRichCapabilityError({ description: 'Bad Request: unsupported field rich_message' }), true);
    assert.equal(isRichCapabilityError({ description: 'Bad Request: rich_message is not supported' }), true);
  });
  test('matches a 404 status', () => {
    assert.equal(isRichCapabilityError({ error_code: 404, description: 'Not Found' }), true);
  });
  test('does NOT match a content/limit error', () => {
    assert.equal(isRichCapabilityError({ description: 'RICH_MESSAGE_BLOCKS_TOO_MANY' }), false);
  });
  test('does NOT match a transient 5xx/network error (must not latch)', () => {
    assert.equal(isRichCapabilityError({ description: 'Internal Server Error', error_code: 500 }), false);
    assert.equal(isRichCapabilityError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }), false);
  });
  test('null/undefined safe', () => {
    assert.equal(isRichCapabilityError(null), false);
    assert.equal(isRichCapabilityError(undefined), false);
  });
});

describe('isRichContentError — per-message rejections fall back, never latch', () => {
  test('matches RICH_MESSAGE_* rejection reasons', () => {
    assert.equal(isRichContentError({ description: 'RICH_MESSAGE_BLOCKS_TOO_MANY' }), true);
    assert.equal(isRichContentError({ description: 'RICH_MESSAGE_TABLE_COLS_TOO_MANY' }), true);
  });
  test('does NOT match a capability error', () => {
    assert.equal(isRichContentError({ description: 'method not found' }), false);
  });
  test('does NOT match a transient 5xx/network error', () => {
    assert.equal(isRichContentError({ description: 'Internal Server Error', error_code: 500 }), false);
  });
  test('null/undefined safe', () => {
    assert.equal(isRichContentError(null), false);
  });
});
