'use strict';

/**
 * The edit tool's rich strategy: decide, then edit.
 *
 * The split exists because the caller must know WHICH length cap applies
 * before anything reaches the network — a rich-eligible edit gets the rich
 * ceiling, everything else gets the plain one, and an over-cap edit has to
 * come back as an agent-actionable error rather than as Telegram's raw
 * "message is too long" after a rich attempt has already degraded.
 *
 * So plan() is pure: no network, no throw, and its `maxLen` names the ceiling
 * the CONTENT aimed at, not the one it happened to land in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRichEditStrategy } = require('../lib/telegram/rich-edit-dispatch');
const { RICH_MAX_LEN } = require('../lib/telegram/rich');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {} };
const CHECKLIST = '- [ ] fetch\n- [ ] parse\n- [ ] report';
const CHECKED = '- [x] fetch\n- [ ] parse\n- [ ] report';

function build(extra = {}) {
  const edits = [];
  const strategy = createRichEditStrategy({
    editRich: async (args) => { edits.push(args); return { result: { message_id: args.messageId }, wentRich: true }; },
    isRichTextEnabled: () => true,
    logger: quietLogger,
    ...extra,
  });
  return { strategy, edits };
}

const plan = (strategy, text, plainMaxLen = 4000) => strategy.plan({
  chatId: '1', threadId: null, text, plainMaxLen,
});

// ─── mode + cap resolution ────────────────────────────────────────────────

test('a chat that never opted into rich plans plain, at the plain cap, text untouched', () => {
  const { strategy } = build({ isRichTextEnabled: () => false });
  // Raw text, NOT the stripped body: a chat that asked for nothing must keep
  // the delivery it has always had, media markdown included.
  const out = plan(strategy, `${CHECKLIST}\n![shot](/tmp/a.png)`);
  assert.equal(out.mode, 'plain');
  assert.equal(out.maxLen, 4000);
  assert.match(out.text, /!\[shot\]\(\/tmp\/a\.png\)/);
});

test('a checklist in a rich chat plans rich, at the rich cap', () => {
  const { strategy } = build();
  const out = plan(strategy, CHECKED);
  assert.equal(out.mode, 'rich');
  assert.equal(out.maxLen, RICH_MAX_LEN);
  assert.ok(Array.isArray(out.blocks) && out.blocks.length > 0, 'blocks rendered');
  assert.equal(out.text, CHECKED, 'the plain fallback body travels with the plan');
});

test('ordinary prose in a rich chat stays plain — rich typography is for structure', () => {
  const { strategy } = build();
  const out = plan(strategy, 'Still working on it, about halfway through.');
  assert.equal(out.mode, 'plain');
  assert.equal(out.maxLen, 4000, 'plain content is bound by the plain cap, whatever the chat allows');
});

test('a tripped capability latch plans plain even for a checklist', () => {
  const { strategy } = build({ getRichKnownUnsupported: () => true });
  const out = plan(strategy, CHECKED);
  assert.equal(out.mode, 'plain');
  assert.equal(out.maxLen, 4000, 'no rich means no rich ceiling — the caller must refuse an oversized edit itself');
});

test('a latched rich chat still strips media markdown from the plain body', () => {
  // The chat opted into rich, so no branch may render an absolute local path
  // into the bubble — including the branches that end up delivering plain.
  const { strategy } = build({ getRichKnownUnsupported: () => true });
  const out = plan(strategy, 'progress ![shot](/tmp/secret-path.png)');
  assert.equal(out.mode, 'plain');
  assert.doesNotMatch(out.text, /\/tmp\/secret-path\.png/, 'local path degraded to caption text');
});

test('a checklist past the rich cap plans plain but still names the RICH ceiling', () => {
  // Naming 4000 here would lie about this chat: it renders 32k checklists.
  // The cap reported is the one the content aimed at.
  const { strategy } = build();
  const out = plan(strategy, `${CHECKED}\n${'z'.repeat(RICH_MAX_LEN)}`);
  assert.equal(out.mode, 'plain');
  assert.equal(out.maxLen, RICH_MAX_LEN);
  assert.equal(out.blocks, undefined, 'nothing is rendered for a body that cannot be sent either way');
});

test('the cap is measured on the STRIPPED body, like every other gate', () => {
  const { strategy } = build();
  // Media markdown that collapses to a two-char caption: the stripped body is
  // what a decline delivers and what the rich renderer sees, so it is what the
  // ceiling applies to.
  const media = `![ab](${'/x'.repeat(200)}.png)`;
  const out = plan(strategy, `${CHECKED}\n${media}`);
  assert.equal(out.mode, 'rich');
  assert.ok(out.text.length < CHECKED.length + 20, 'measured after the strip, not before');
});

// ─── media stays out ──────────────────────────────────────────────────────

test('rendering runs on media-stripped text — no resolver, no local paths in blocks', () => {
  const seen = [];
  const { strategy } = build({
    toRichBlocks: (markdown, opts) => { seen.push({ markdown, opts }); return { blocks: [{ type: 'paragraph', text: markdown }], usedRich: true }; },
  });
  const out = plan(strategy, `${CHECKED}\n![shot](/tmp/secret-path.png)`);
  assert.equal(out.mode, 'rich');
  assert.doesNotMatch(seen[0].markdown, /\/tmp\/secret-path\.png/, 'the renderer never sees the path');
  assert.equal(seen[0].opts.resolveMedia, undefined, 'no media resolver is wired on the edit path');
  assert.doesNotMatch(JSON.stringify(out.blocks), /\/tmp\/secret-path\.png/);
});

test('an edit that was nothing but media plans plain with an empty body', () => {
  // The caller turns this into an actionable error; the strategy just refuses
  // to invent content.
  const { strategy } = build();
  const out = plan(strategy, '![](/tmp/a.png)');
  assert.equal(out.mode, 'plain');
  assert.equal(out.text.trim(), '');
});

// ─── purity ───────────────────────────────────────────────────────────────

test('plan() touches nothing — no edit, no throw, even when the renderer explodes', () => {
  const { strategy, edits } = build({
    toRichBlocks: () => { throw new Error('marked blew up'); },
  });
  const out = plan(strategy, CHECKED);
  assert.equal(out.mode, 'plain', 'a render failure costs the styling, never the edit');
  assert.equal(out.maxLen, 4000);
  assert.equal(edits.length, 0, 'planning is not sending');
});

test('a renderer that declines (usedRich false) plans plain', () => {
  const { strategy } = build({ toRichBlocks: () => ({ blocks: [], usedRich: false }) });
  assert.equal(plan(strategy, CHECKED).mode, 'plain');
});

test('inline styling is re-read per edit and passed to the renderer', () => {
  let styling = true;
  const seen = [];
  const { strategy } = build({
    isInlineStylingEnabled: () => styling,
    toRichBlocks: (markdown, opts) => { seen.push(opts.inlineStyling); return { blocks: [{ type: 'paragraph', text: markdown }], usedRich: true }; },
  });
  plan(strategy, CHECKED);
  styling = false;   // the styling latch trips mid-session
  plan(strategy, CHECKED);
  assert.deepEqual(seen, [true, false], 'a latch that trips takes effect on the very next edit');
});

test('the richText flag is resolved per call, against the live chat/topic', () => {
  const asked = [];
  const { strategy } = build({
    isRichTextEnabled: (chatId, threadId) => { asked.push([chatId, threadId]); return false; },
  });
  strategy.plan({ chatId: '99', threadId: '7', text: CHECKED, plainMaxLen: 4000 });
  assert.deepEqual(asked, [['99', '7']]);
});

// ─── edit() ───────────────────────────────────────────────────────────────

test('edit() hands the planned blocks and body to the shipped rich editor', async () => {
  const { strategy, edits } = build();
  const planned = plan(strategy, CHECKED);
  const res = await strategy.edit({
    chatId: '1', threadId: '7', messageId: 500, blocks: planned.blocks, sourceText: planned.text,
  });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 500);
  assert.equal(edits[0].threadId, '7');
  assert.equal(edits[0].sourceText, CHECKED, 'the same body the plain fallback would deliver');
  assert.equal(res.wentRich, true);
});

test('edit() lets a transient error through — the caller owns the tool result', async () => {
  // rich-edit.js rethrows transients by contract (the streamer wants them).
  // Swallowing one here would answer ok:true on an edit that never landed.
  const { strategy } = build({ editRich: async () => { throw new Error('TG 502: bad gateway'); } });
  await assert.rejects(
    () => strategy.edit({ chatId: '1', threadId: null, messageId: 5, blocks: [], sourceText: 'x' }),
    /bad gateway/,
  );
});

test('construction refuses a strategy that could not edit anything', () => {
  assert.throws(() => createRichEditStrategy({ isRichTextEnabled: () => true }), /editRich/);
  assert.throws(() => createRichEditStrategy({ editRich: async () => {} }), /isRichTextEnabled/);
});
