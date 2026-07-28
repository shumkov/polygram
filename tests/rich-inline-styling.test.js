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

const {
  toTelegramRichBlocks, stripMediaMarkdown, flattenStyledBlocks, blocksAreStyled,
  _richTextOf: richTextOf,
} = require('../lib/telegram/rich');

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
      'Restock ',
      { type: 'code', text: 'SKU-118' },
      ' (',
      { type: 'bold', text: 'urgent' },
      ')',
    ]);
    assert.equal(list.items[0].has_checkbox, true, 'and it is still a checkbox item');
  });

  test('a task item renders one checkbox, not a checkbox and a marker', async () => {
    // The block carries has_checkbox, so a `[ ] ` left in the text would show
    // twice. The marker arrives in the FIRST string of a styled run, which is
    // where the flat path never had to look.
    const { blocks } = styled(REPLY);
    const list = blocks.find((b) => b.type === 'list');
    for (const item of list.items) {
      const head = item.blocks[0].text;
      const first = typeof head === 'string' ? head : head[0];
      assert.ok(!/^\[[ xX]\]/.test(first), `marker survived: ${JSON.stringify(head)}`);
    }
    assert.equal(list.items[1].is_checked, true, 'and a checked item is still checked');
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
  test('both gates count the stripped SOURCE, so styling cannot change what fits', async () => {
    // The contract, stated because it is not the only plausible one: both
    // length gates measure `stripMediaMarkdown(text).length` — the SOURCE
    // markdown, markers included — not the rendered text and not the JSON.
    // So `**bold**` costs 8 characters whether or not it renders as a node,
    // and a reply that fits flat fits styled. Anything else would make what
    // fits depend on a server capability, and the plain fallback is sized
    // from the same number.
    const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
    const { RICH_MAX_LEN } = require('../lib/telegram/rich');

    const at = (len) => {
      const head = '## H\n\n';
      return head + '**b** '.repeat(Math.floor((len - head.length) / 6))
        + 'x'.repeat((len - head.length) % 6);
    };
    assert.equal(at(RICH_MAX_LEN).length, RICH_MAX_LEN, 'fixture sits exactly on the cap');
    assert.equal(at(RICH_MAX_LEN + 1).length, RICH_MAX_LEN + 1);

    for (const stylingEnabled of [true, false]) {
      const sends = [];
      const factory = createRichDeliveryFactory({
        bot: {},
        sendRich: async (a) => { sends.push(a); return { wentRich: true, result: { message_id: 1 } }; },
        isRichTextEnabled: () => true,
        isInlineStylingEnabled: () => stylingEnabled,
        logger: { error: () => {} },
      });
      const deliver = (text) => factory({ chatId: '1', threadId: null })({ text });

      const fits = await deliver(at(RICH_MAX_LEN));
      assert.equal(fits.handled, true, `styling=${stylingEnabled}: exactly at the cap must still send`);

      const over = await deliver(at(RICH_MAX_LEN + 1));
      assert.equal(over.handled, false, `styling=${stylingEnabled}: one over the cap must decline`);
      assert.equal(sends.length, 1, 'and the over-cap reply never reached the sender');
    }
  });

  test('the streamer gate uses the same number for the same reason', () => {
    // streamer.js carries richMaxLen as its own default rather than importing
    // it (the module is deliberately dependency-free), so the two can drift
    // apart silently — and then a reply would render on one path and not the
    // other.
    const { RICH_MAX_LEN } = require('../lib/telegram/rich');
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'lib', 'telegram', 'streamer.js'), 'utf8');
    const declared = /richMaxLen\s*=\s*(\d+)/.exec(source);
    assert.ok(declared, 'streamer must declare its own richMaxLen default');
    assert.equal(Number(declared[1]), RICH_MAX_LEN,
      'the streamer default and the shared constant must be the same number');
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

    assert.equal(h.sends.length, 2, 'the experiment was run');
    assert.equal(isStyled(h.sends[1].blocks), false, 'and the second payload was the flat one');
    assert.equal(out.handled, false, 'the pipeline still delivers this plain');
    assert.equal(h.events.rejected, 0, 'no verdict from an inconclusive experiment');
  });

  test('a refusal that named a LIMIT is retried but never counted', async () => {
    // Flattening removes styling AND shrinks the payload. If the server said
    // "too long", the shrink explains the success — so retry (it may well be
    // what the reply needed) and record nothing. Otherwise two oversized
    // replies would disable styling for the process.
    const h = build({ outcomes: [{ wentRich: false, fallback: 'content-limit' }] });

    const out = await h.deliver(TABLE);

    assert.equal(h.sends.length, 2, 'still retried — delivery comes first');
    assert.equal(isStyled(h.sends[1].blocks), false);
    assert.equal(out.handled, true, 'and the retry landed');
    assert.equal(h.events.rejected, 0, 'but the shrink is a second variable, so no strike');
  });

  test('other failure classes do not trigger a flattened retry', async () => {
    // A capability error or a transport failure would fail identically
    // without styling; retrying would be a second doomed call on every reply.
    for (const fallback of ['capability', 'error', undefined]) {
      const h = build({ outcomes: [{ wentRich: false, fallback }] });
      const out = await h.deliver(TABLE);
      assert.equal(h.sends.length, 1, `fallback=${fallback} should not be retried`);
      assert.equal(isStyled(h.sends[0].blocks), true,
        'the attempt that WAS made carried styling — otherwise this passes by doing nothing');
      assert.equal(out.handled, false);
      assert.equal(h.events.rejected, 0);
    }
  });

  test('a styled send that lands records the evidence that ends a run', async () => {
    const h = build({ outcomes: [] });
    const out = await h.deliver(TABLE);
    assert.equal(out.handled, true);
    assert.equal(isStyled(h.sends[0].blocks), true, 'what landed was actually styled');
    assert.equal(h.events.accepted, 1);
    assert.equal(h.events.rejected, 0);
  });

  test('with styling off nothing is styled and nothing is retried', async () => {
    const h = build({ outcomes: [{ wentRich: false, fallback: 'content-error' }], stylingEnabled: false });

    const out = await h.deliver(TABLE);

    assert.equal(isStyled(h.sends[0].blocks), false);
    assert.ok(h.sends[0].blocks.some((b) => b.type === 'table'),
      'it still rendered rich — the flag removes styling, not structure');
    assert.equal(h.sends.length, 1, 'there is no styling to remove, so no experiment to run');
    assert.equal(out.handled, false);
    assert.equal(h.events.accepted, 0, 'an unstyled success is not evidence about styling');
  });
});

// ─── Bounds and the trust boundary ─────────────────────────────────────────

describe('what styling refuses to emit', () => {
  const styledText = (md) => styled(`# S\n\n${md}`).blocks[1].text;

  test('only http(s) destinations become link nodes', () => {
    // A typed url node hands Telegram a destination to make clickable. The
    // FLAT rendering never crossed that boundary — it discarded destinations
    // entirely — so "the plain path already emits <a href>" is not the right
    // baseline for what this path may hand over.
    for (const href of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x',
      'tg://resolve?domain=x', 'ftp://host/x']) {
      const out = styledText(`[click me](${href})`);
      assert.equal(out, 'click me', `${href} was emitted as a link node`);
    }
    assert.deepEqual(styledText('[click me](https://ok.example/)'),
      [{ type: 'url', text: 'click me', url: 'https://ok.example/' }]);
    assert.deepEqual(styledText('[click me](http://ok.example/)'),
      [{ type: 'url', text: 'click me', url: 'http://ok.example/' }]);
  });

  test('a rejected scheme keeps the text and loses only the link', () => {
    // The reader loses a hyperlink they could not safely have been given;
    // they do not lose the sentence.
    const out = styledText('see [the notes](file:///etc/passwd) for detail');
    assert.equal(out, 'see the notes for detail');
  });

  test('link labels stay strings until a probe says otherwise', () => {
    // url nodes were only ever probed with string text. Emitting a nested
    // label would be shipping one shape on the evidence of another.
    assert.deepEqual(styledText('[**bold** label](https://ok.example/)'),
      [{ type: 'url', text: 'bold label', url: 'https://ok.example/' }]);
  });

  test('node count per block is bounded, and the overflow is still readable', () => {
    // Telegram caps blocks and nesting; nothing caps nodes per block, and
    // agent output is influenced by content the agent read.
    const md = Array.from({ length: 500 }, (_, i) => `**b${i}**`).join(' ');
    const out = styledText(md);
    const nodes = out.filter((p) => typeof p === 'object');
    assert.equal(nodes.length, 200, 'capped');
    assert.ok(out.some((p) => typeof p === 'string' && p.includes('b400')),
      'and everything past the cap is still present as text');
  });

  test('nesting depth is bounded well below the API limit', () => {
    // marked reaches depth 38 from 25 emphasis markers; the documented limit
    // is 16. Nothing legible needs more than a handful.
    const md = `${'*'.repeat(25)}deep${'*'.repeat(25)}`;
    const depthOf = (v, d = 0) => (Array.isArray(v)
      ? Math.max(d, ...v.map((p) => depthOf(p, d)))
      : (v && typeof v === 'object' ? depthOf(v.text, d + 1) : d));
    assert.ok(depthOf(styledText(md)) <= 8, 'depth stays inside the ceiling');
    assert.ok(JSON.stringify(styledText(md)).includes('deep'), 'and the text survives');
  });
});

// ─── The flatten rung, shared by both paths ────────────────────────────────

describe('flattenStyledBlocks', () => {
  test('it produces exactly what an unstyled render would have', () => {
    // This is what makes the retry a controlled experiment: the payload that
    // goes out second differs from the one that was refused in exactly one
    // respect. Re-rendering the source could differ in others.
    const md = [
      '## H', '',
      'The **build** is green and `npm test` passes.', '',
      '- [ ] Restock `SKU-118` (**urgent**)', '',
      '| **a** | b |', '| --- | --- |', '| ~~c~~ | d |',
    ].join('\n');
    assert.deepEqual(flattenStyledBlocks(styled(md).blocks), flat(md).blocks);
  });

  test('it leaves everything that is not text alone', () => {
    const blocks = [{
      type: 'photo',
      photo: { type: 'photo', media: { source: '/tmp/x.png', fingerprint: 'fp' } },
      caption: { text: ['a ', { type: 'bold', text: 'b' }] },
    }];
    const out = flattenStyledBlocks(blocks);
    assert.deepEqual(out[0].photo, blocks[0].photo, 'media is untouched — nothing re-resolves');
    assert.equal(out[0].caption.text, 'a b');
  });

  test('blocksAreStyled sees styling wherever it hides', () => {
    assert.equal(blocksAreStyled(flat('## H\n\n**x**').blocks), false);
    assert.equal(blocksAreStyled([{ type: 'paragraph', text: 'plain' }]), false);
    assert.equal(blocksAreStyled([{ type: 'details', blocks: [{ type: 'paragraph', text: ['a', { type: 'bold', text: 'b' }] }] }]), true);
    assert.equal(blocksAreStyled([{ type: 'table', cells: [[{ text: ['a', { type: 'code', text: 'b' }] }]] }]), true);
    assert.equal(blocksAreStyled([{ type: 'list', items: [{ blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'x' }] }] }] }]), true);
  });
});

// ─── The streamer path honors the same invariant ───────────────────────────

describe('the streamer gets the rung too', () => {
  const { createRichEditor } = require('../lib/telegram/rich-edit');
  const { isRichContentError, isRichCapabilityError, isRichLimitError } = require('../lib/telegram/rich');

  const STYLED = [
    { type: 'heading', text: ['H ', { type: 'code', text: 'x' }], size: 2 },
    { type: 'paragraph', text: ['The ', { type: 'bold', text: 'build' }, ' is green.'] },
  ];

  function build({ failures = [], onStylingRejected = () => {}, onStylingAccepted = () => {} } = {}) {
    const calls = [];
    const edit = createRichEditor({
      tg: async (_bot, method, params, meta) => {
        calls.push({ method, params, source: meta?.source });
        const fail = failures.shift();
        if (fail) throw fail;
        return { message_id: 7 };
      },
      botName: 'testbot',
      logEvent: () => {},
      redactBotToken: (s) => s,
      isRichCapabilityError,
      isRichContentError,
      isRichLimitError,
      onStylingRejected,
      onStylingAccepted,
    });
    return { edit, calls };
  }

  const richCalls = (calls) => calls.filter((c) => c.params.rich_message);
  const plainCalls = (calls) => calls.filter((c) => c.params.text != null);

  test('a refused styled edit is retried unstyled before the bubble goes plain', async () => {
    // Streamer bubbles are edited repeatedly, so without this rung a server
    // that dislikes typed nodes would flatten EVERY bubble to plain text for
    // the process lifetime — losing headings and tables that had nothing to
    // do with the refusal.
    const h = build({ failures: [new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK')] });

    const out = await h.edit({
      bot: {}, chatId: '1', messageId: 7, blocks: STYLED, sourceText: 'H x\n\nThe build is green.',
    });

    assert.equal(out.wentRich, true, 'the bubble is still rich, just unstyled');
    assert.equal(richCalls(h.calls).length, 2, 'one styled attempt, one flat');
    assert.equal(plainCalls(h.calls).length, 0, 'and it never degraded to plain text');
    const retried = richCalls(h.calls)[1].params.rich_message.blocks;
    assert.equal(blocksAreStyled(retried), false);
    assert.deepEqual(retried, flattenStyledBlocks(STYLED),
      'the retry is the refused tree with the styling removed — nothing else changed');
  });

  test('the streamer feeds the SAME latch the reply tool does', async () => {
    // A verdict reachable from only one path lets the other keep authoring
    // payloads this server has already refused.
    const { createRichStylingLatch } = require('../lib/telegram/rich-styling-latch');
    let tripped = 0;
    const latch = createRichStylingLatch({ setUnsupported: () => { tripped += 1; } });

    for (let i = 0; i < 2; i++) {
      const h = build({
        failures: [new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK')],
        onStylingRejected: () => latch.recordStylingRejection(),
      });
      await h.edit({ bot: {}, chatId: '1', messageId: 7, blocks: STYLED, sourceText: 't' });
    }

    assert.equal(tripped, 1, 'two confirmed rejections from the streamer alone are a verdict');
  });

  test('a limit refusal is retried without becoming evidence', async () => {
    let rejected = 0;
    const h = build({
      failures: [new Error('Bad Request: RICH_MESSAGE_TOO_LONG')],
      onStylingRejected: () => { rejected += 1; },
    });

    const out = await h.edit({ bot: {}, chatId: '1', messageId: 7, blocks: STYLED, sourceText: 't' });

    assert.equal(out.wentRich, true);
    assert.equal(richCalls(h.calls).length, 2, 'still retried');
    assert.equal(rejected, 0, 'the payload also got smaller, so styling is not the only variable');
  });

  test('both shapes refused still degrades to plain, and records nothing', async () => {
    let rejected = 0;
    const h = build({
      failures: [
        new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK'),
        new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK'),
      ],
      onStylingRejected: () => { rejected += 1; },
    });

    const out = await h.edit({ bot: {}, chatId: '1', messageId: 7, blocks: STYLED, sourceText: 'the text' });

    assert.equal(out.wentRich, false);
    assert.equal(plainCalls(h.calls).length, 1, 'the bubble still gets its content');
    assert.equal(rejected, 0, 'the blocks were the problem, not the styling');
  });

  test('an unstyled payload never triggers the rung', async () => {
    let rejected = 0;
    const h = build({
      failures: [new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK')],
      onStylingRejected: () => { rejected += 1; },
    });

    await h.edit({
      bot: {}, chatId: '1', messageId: 7, sourceText: 'plain',
      blocks: [{ type: 'paragraph', text: 'nothing styled here' }],
    });

    assert.equal(richCalls(h.calls).length, 1, 'there is nothing to remove, so no second attempt');
    assert.equal(rejected, 0);
  });

  test('a styled edit that lands reports the healthy outcome', async () => {
    let accepted = 0;
    const h = build({ onStylingAccepted: () => { accepted += 1; } });
    await h.edit({ bot: {}, chatId: '1', messageId: 7, blocks: STYLED, sourceText: 't' });
    assert.equal(accepted, 1);
  });
});
