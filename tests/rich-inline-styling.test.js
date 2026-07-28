'use strict';

/**
 * Inline styling inside rich blocks.
 *
 * Until now every block text field carried a flat string: bold, italic, code
 * spans and links were collapsed to their text content, so a chat with rich
 * rendering ON still showed `**In stock**` as plain words. This pins the
 * typed-node rendering that replaces it, and — just as load-bearing — the
 * cases that must NOT change.
 *
 * The shape comes from a live probe, not from the reference (which truncates
 * before the field tables): lowercase discriminators, `text` carrying either
 * a string or a nested array, and a run with nothing styled in it coming back
 * as a plain string rather than a one-element array.
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const { toTelegramRichBlocks, richTextOf, stripMediaMarkdown } = require('../lib/telegram/rich');

const styled = (md) => toTelegramRichBlocks(md, { inlineStyling: true });
const flat = (md) => toTelegramRichBlocks(md);

// ─── Production shape ──────────────────────────────────────────────────────

describe('the reply that prompted this', () => {
  // Ivan's report: an inventory answer whose emphasis and identifiers all
  // arrived as plain words. Kept whole rather than reduced to a unit fixture,
  // because what was wrong with it was the WHOLE reply reading flat.
  const REPLY = [
    '## Stock check',
    '',
    'The **In stock** count is `42` — see [the dashboard](https://shop.example/stock).',
    '',
    '- [ ] Restock `SKU-118` (**urgent**)',
    '- [x] Confirm the `SKU-990` delivery',
  ].join('\n');

  test('bold, code and links in a paragraph become typed nodes', async () => {
    const { blocks, usedRich } = styled(REPLY);
    assert.equal(usedRich, true);

    const paragraph = blocks.find((b) => b.type === 'paragraph');
    assert.ok(Array.isArray(paragraph.text), `expected typed nodes, got ${JSON.stringify(paragraph.text)}`);
    assert.deepEqual(paragraph.text, [
      'The ',
      { type: 'bold', text: 'In stock' },
      ' count is ',
      { type: 'code', text: '42' },
      ' — see ',
      { type: 'url', text: 'the dashboard', url: 'https://shop.example/stock' },
      '.',
    ]);
  });

  test('a heading keeps its styling too', async () => {
    const { blocks } = styled('## Deploy `polygram` now');
    assert.deepEqual(blocks[0], {
      type: 'heading',
      size: 2,
      text: ['Deploy ', { type: 'code', text: 'polygram' }, ' now'],
    });
  });

  test('the same reply is byte-identical when styling is off', async () => {
    // The whole feature has to be reversible on one flag, because that is
    // what the automatic fallback and the latch both do.
    const before = flat(REPLY);
    assert.ok(before.blocks.every((b) => typeof b.text !== 'object' || b.text == null));
    const paragraph = before.blocks.find((b) => b.type === 'paragraph');
    assert.equal(paragraph.text, 'The In stock count is 42 — see the dashboard.');
  });

  test('task list items carry their styling too', async () => {
    // Held back at first: one live run reported this field PRESERVED and an
    // identical repeat REJECTED. A paced run with the control passing
    // reported PRESERVED, so it ships on evidence rather than on the
    // optimistic reading of a contradiction.
    const { blocks } = styled(REPLY);
    const list = blocks.find((b) => b.type === 'list');

    assert.deepEqual(list.items[0].blocks[0].text, [
      '[ ] Restock ',
      { type: 'code', text: 'SKU-118' },
      ' (',
      { type: 'bold', text: 'urgent' },
      ')',
    ]);
    assert.equal(list.items[0].has_checkbox, true, 'and it is still a checkbox item');
  });

  test('a list item never ships its markers as literal characters', async () => {
    // marked wraps a list item's inline run in a 'text' token whose .text is
    // the RAW source and whose .tokens carry the parsed children. Taking the
    // former is how `**urgent**` reaches the chat verbatim — a trap the
    // flattener already had a branch for, and the styled walk has to as well.
    // A plain bullet list is not itself a rich trigger, so the heading is
    // scaffolding — what is under test is the ITEM.
    const { blocks } = styled('# S\n\n- Restock `SKU-118` (**urgent**)');
    const text = blocks.find((b) => b.type === 'list').items[0].blocks[0].text;
    const literal = JSON.stringify(text);
    assert.ok(!literal.includes('**') && !literal.includes('`'),
      `markers shipped as literal text: ${literal}`);
  });

  test('table cells carry it, header and body alike', async () => {
    const { blocks } = styled('| **a** | b |\n| --- | --- |\n| **bold** | `code` |');
    const table = blocks.find((b) => b.type === 'table');

    assert.deepEqual(table.cells[0][0].text, [{ type: 'bold', text: 'a' }]);
    assert.equal(table.cells[0][0].is_header, true);
    assert.deepEqual(table.cells[1][0].text, [{ type: 'bold', text: 'bold' }]);
    assert.deepEqual(table.cells[1][1].text, [{ type: 'code', text: 'code' }]);
    assert.equal(table.cells[0][1].text, 'b', 'an unstyled cell is still a plain string');
  });
});

// ─── richTextOf ────────────────────────────────────────────────────────────

describe('richTextOf', () => {
  // Inline styling is not itself a rich trigger (see the gate test below), so
  // a fixture needs a structural construct to render at all. The heading is
  // scaffolding; the paragraph under test is what is read back.
  const tokensOf = (md) => {
    const { blocks } = styled(`# Scaffold\n\n${md}`);
    return blocks.find((b) => b.type === 'paragraph')?.text;
  };

  test('styling alone does not make a reply rich', () => {
    // The gate is unchanged on purpose. Rich rendering uses document
    // typography, so pushing ordinary prose into it to pick up a bold run
    // would make every conversational answer look oversized — and the plain
    // path already renders **bold** and `code` as HTML. Styling improves
    // replies that were ALREADY rich; it does not recruit new ones.
    assert.equal(styled('Just prose with **bold** and `code`.').usedRich, false);
    assert.equal(flat('Just prose with **bold** and `code`.').usedRich, false);
  });

  test('an unstyled run is a plain string, not a one-element array', () => {
    // The streamer dedups payloads with JSON.stringify, so wrapping unstyled
    // text would re-send every bubble that had not changed. The length gate
    // and the plain fallback both read the flat text as well.
    assert.equal(tokensOf('Just an ordinary sentence.'), 'Just an ordinary sentence.');
  });

  test('adjacent plain runs coalesce instead of fragmenting', () => {
    // Without merging, marked's token stream turns one sentence into a node
    // per fragment — a payload that is correct and unreadable.
    assert.deepEqual(tokensOf('one **two** three four five'), [
      'one ', { type: 'bold', text: 'two' }, ' three four five',
    ]);
  });

  test('nesting is preserved, because ordinary markdown produces it', () => {
    // `**see `x`**` is not exotic; an agent writing a bolded identifier
    // writes it constantly.
    assert.deepEqual(tokensOf('**see `x` now**'), [
      { type: 'bold', text: ['see ', { type: 'code', text: 'x' }, ' now'] },
    ]);
  });

  test('italic maps, and emphasis inside bold survives both', () => {
    assert.deepEqual(tokensOf('*just italic*'), [{ type: 'italic', text: 'just italic' }]);
    assert.deepEqual(tokensOf('**bold *and italic***'), [
      { type: 'bold', text: ['bold ', { type: 'italic', text: 'and italic' }] },
    ]);
  });

  test('a link without a destination is not emitted as a link node', () => {
    // A url node with no url is a shape the server would have to guess at.
    assert.equal(richTextOf([{ type: 'link', href: '', text: 'label', tokens: [{ type: 'text', text: 'label' }] }]),
      'label');
  });

  test('images never become inline nodes', () => {
    // They are block-level media on this pipeline. An inline image node would
    // both break that and — before the destination fallback was removed —
    // print a local path.
    const out = richTextOf([
      { type: 'text', text: 'see ' },
      { type: 'image', href: '/Users/me/secret/shot.png', text: 'the shot', tokens: [] },
    ]);
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes('/Users/me'), out);
  });

  test('raw html is flattened, never carried as markup', () => {
    const out = richTextOf([{ type: 'html', raw: '<b>x</b>', text: '<b>x</b>' }]);
    assert.equal(typeof out, 'string');
  });

  test('strikethrough maps under the spelling the server accepted', () => {
    // The reference names no strikethrough node, so this one is probe-backed
    // rather than inferred: `strikethrough` round-tripped and `strike` was
    // refused, and a rejected spelling would cost the whole payload.
    assert.deepEqual(tokensOf('~~gone~~ but here'), [
      { type: 'strikethrough', text: 'gone' }, ' but here',
    ]);
  });

  test('an empty construct contributes nothing rather than an empty node', () => {
    assert.equal(richTextOf([{ type: 'strong', tokens: [] }]), '');
  });

  test('a line break inside a styled run stays a break', () => {
    assert.deepEqual(richTextOf([
      { type: 'text', text: 'a' }, { type: 'br' }, { type: 'strong', tokens: [{ type: 'text', text: 'b' }] },
    ]), ['a\n', { type: 'bold', text: 'b' }]);
  });
});

// ─── Interaction with everything already shipped ───────────────────────────

describe('styling does not disturb the rest of the pipeline', () => {
  test('the length gate measures the flattened text, whatever the styling', () => {
    // Styling must not change what fits: the gate sizes the PLAIN fallback,
    // and a reply that renders styled must render flat at the same length.
    const md = '## H\n\n' + '**bold** '.repeat(50);
    assert.equal(stripMediaMarkdown(md).length, md.length,
      'no media here, so the projection is identity — the gate sees the source length');
    const styledBlocks = styled(md).blocks;
    const flatBlocks = flat(md).blocks;
    assert.equal(styledBlocks.length, flatBlocks.length,
      'same structure either way — only the text representation differs');
  });

  test('a styled payload is stable across renders, so the streamer dedup holds', () => {
    // The streamer compares JSON.stringify of consecutive payloads to decide
    // whether to edit. An unstable key order or a fresh object identity per
    // render would make every tick look like a change.
    const md = 'The **build** is green and `npm test` passes.';
    assert.equal(
      JSON.stringify(styled(md).blocks),
      JSON.stringify(styled(md).blocks),
    );
  });

  test('partial mode still holds back the trailing block', () => {
    // The streamer's mid-stream contract, unchanged: the last top-level block
    // may be half-written, so it is withheld until the text moves past it.
    const md = '# Heading\n\nThe **build** is green.';
    const partial = toTelegramRichBlocks(md, { inlineStyling: true, partial: true });
    assert.equal(partial.blocks.length, styled(md).blocks.length - 1);
  });

  test('media markdown still renders as media, not as an inline node', () => {
    const md = '## Results\n\n![the chart](/tmp/x.png)';
    const { blocks } = toTelegramRichBlocks(md, {
      inlineStyling: true,
      resolveMedia: (ds) => ds.map(() => ({ kind: 'photo', media: { source: '/tmp/x.png' } })),
    });
    assert.ok(blocks.some((b) => b.type === 'photo'));
  });
});

// ─── The styling latch ─────────────────────────────────────────────────────

describe('rich-styling-latch', () => {
  const { createRichStylingLatch } = require('../lib/telegram/rich-styling-latch');

  test('one confirmed rejection is not a verdict', () => {
    // Two payloads, two moments, possibly a transient in between. Disabling a
    // feature for the process lifetime deserves more than one coincidence.
    let tripped = 0;
    const latch = createRichStylingLatch({ setUnsupported: () => { tripped += 1; } });
    assert.equal(latch.recordStylingRejection(), false);
    assert.equal(tripped, 0);
    assert.equal(latch.tripped, false);
  });

  test('two in a row are', () => {
    let tripped = 0;
    const latch = createRichStylingLatch({ setUnsupported: () => { tripped += 1; } });
    latch.recordStylingRejection();
    assert.equal(latch.recordStylingRejection(), true, 'the call that trips it says so, for a single log line');
    assert.equal(tripped, 1);
    assert.equal(latch.tripped, true);
  });

  test('a styled payload the server accepted clears the run', () => {
    // Otherwise two unrelated content errors, months apart, eventually
    // disable a feature that demonstrably works on this server.
    let tripped = 0;
    const latch = createRichStylingLatch({ setUnsupported: () => { tripped += 1; } });
    latch.recordStylingRejection();
    latch.recordHealthyOutcome();
    latch.recordStylingRejection();
    assert.equal(tripped, 0, 'the run was broken by proof that styling works here');
  });

  test('it trips once and stays tripped', () => {
    let tripped = 0;
    const latch = createRichStylingLatch({ setUnsupported: () => { tripped += 1; } });
    latch.recordStylingRejection();
    latch.recordStylingRejection();
    latch.recordStylingRejection();
    latch.recordHealthyOutcome();
    latch.recordStylingRejection();
    assert.equal(tripped, 1, 'one verdict, one log line, no re-arming');
    assert.equal(latch.tripped, true);
  });

  test('a throwing verdict callback does not un-trip the latch', () => {
    const latch = createRichStylingLatch({ setUnsupported: () => { throw new Error('log sink down'); } });
    latch.recordStylingRejection();
    assert.doesNotThrow(() => latch.recordStylingRejection());
    assert.equal(latch.tripped, true);
  });
});

// ─── The ladder: styled → flattened → plain ────────────────────────────────

describe('a styling rejection costs the styling, not the reply', () => {
  const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');

  const TABLE = '## H\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nThe **build** is green.';

  function build({ outcomes, stylingEnabled = true } = {}) {
    const sends = [];
    const events = { rejected: 0, accepted: 0 };
    const factory = createRichDeliveryFactory({
      bot: {},
      sendRich: async (args) => {
        sends.push(args);
        const next = outcomes.shift();
        return next ?? { wentRich: true, result: { message_id: 900 + sends.length } };
      },
      isRichTextEnabled: () => true,
      isInlineStylingEnabled: () => stylingEnabled,
      onStylingRejected: () => { events.rejected += 1; },
      onStylingAccepted: () => { events.accepted += 1; },
      logger: { error: () => {} },
    });
    const deliver = (text) => factory({ chatId: '1', threadId: null })({ text });
    return { deliver, sends, events };
  }

  const isStyled = (blocks) => JSON.stringify(blocks).includes('"type":"bold"');

  test('a refused styled payload is re-sent flattened, keeping the structure', async () => {
    // Losing every heading and table because one code span was unwelcome is
    // the worse trade — and the retry doubles as the experiment.
    const h = build({ outcomes: [{ wentRich: false, fallback: 'content-error' }] });

    const out = await h.deliver(TABLE);

    assert.equal(out.handled, true, 'the reply landed');
    assert.equal(h.sends.length, 2, 'exactly one retry');
    assert.equal(isStyled(h.sends[0].blocks), true, 'the first attempt carried styling');
    assert.equal(isStyled(h.sends[1].blocks), false, 'the retry did not');
    assert.ok(h.sends[1].blocks.some((b) => b.type === 'table'), 'and kept the table');
    assert.equal(h.events.rejected, 1, 'a confirmed styling rejection: refused styled, landed flat');
  });

  test('a retry that also fails says nothing about styling', async () => {
    // Both payloads were refused, so the blocks were the problem. Counting
    // this as evidence would disable styling over an unrelated content error.
    const h = build({
      outcomes: [
        { wentRich: false, fallback: 'content-error' },
        { wentRich: false, fallback: 'content-error' },
      ],
    });

    const out = await h.deliver(TABLE);

    assert.equal(out.handled, false, 'the pipeline still delivers this plain');
    assert.equal(h.events.rejected, 0, 'no verdict from an inconclusive experiment');
  });

  test('other failure classes do not trigger a flattened retry', async () => {
    // A capability error or a transport failure would fail identically
    // without styling; retrying would be a second doomed call on every reply.
    for (const fallback of ['capability', 'error', 'media-source-changed', undefined]) {
      const h = build({ outcomes: [{ wentRich: false, fallback }] });
      await h.deliver(TABLE);
      assert.equal(h.sends.length, 1, `fallback=${fallback} should not be retried`);
      assert.equal(h.events.rejected, 0);
    }
  });

  test('a styled send that lands records the evidence that ends a run', async () => {
    const h = build({ outcomes: [] });
    await h.deliver(TABLE);
    assert.equal(h.events.accepted, 1);
    assert.equal(h.events.rejected, 0);
  });

  test('with styling off nothing is styled and nothing is retried', async () => {
    const h = build({ outcomes: [{ wentRich: false, fallback: 'content-error' }], stylingEnabled: false });

    const out = await h.deliver(TABLE);

    assert.equal(isStyled(h.sends[0].blocks), false);
    assert.equal(h.sends.length, 1, 'there is no styling to remove, so no experiment to run');
    assert.equal(out.handled, false);
    assert.equal(h.events.accepted, 0, 'an unstyled success is not evidence about styling');
  });
});
