'use strict';

// The non-streamed final-reply branch: a turn that ends with text instead of
// calling the reply tool. Production shipped a reply with two headings and a
// five-column markdown table as flat text from this branch while the reply
// tool rendered the same markdown rich in the same thread minutes later, so
// the reader saw one assistant formatting the same content two ways with no
// visible cause. These pin the branch to the shared gate and — the part that
// can lose replies outright — to a fallback body that survives a decline
// carrying no text.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

// The branch, bounded by its own opener and the shared tail every reply kind
// falls into.
function nonStreamedTextBranch() {
  const start = source.indexOf('} else if (parsed.text) {');
  assert.notEqual(start, -1, 'the non-streamed text branch must exist');
  const end = source.indexOf('await finishStreamer();', start);
  assert.notEqual(end, -1, 'the branch must be followed by the shared settlement tail');
  return source.slice(start, end);
}

describe('non-streamed reply renders through the shared rich path', () => {
  test('rich is attempted before the plain chunker, not after it', () => {
    const branch = nonStreamedTextBranch();
    const richAt = branch.indexOf('makeRichDeliverText');
    const plainAt = branch.indexOf('deliverReplies(');
    assert.notEqual(richAt, -1, 'the branch must consult the rich delivery factory');
    assert.notEqual(plainAt, -1, 'the branch must keep its plain fallback');
    assert.ok(richAt < plainAt, 'rich must be offered the reply before plain delivery runs');
  });

  test('the reply is delivered exactly once — plain runs only when rich declined', () => {
    const branch = nonStreamedTextBranch();
    assert.match(branch, /if \(richOut\?\.handled\)[\s\S]*?\} else \{/,
      'the plain arm must sit in the else of the handled check, so a rich '
      + 'success cannot also chunk the same body into a second delivery');
  });

  test('a rich success does not skip the shared settlement tail', () => {
    // An early return here would bypass finishStreamer, the partial-delivery
    // warning and result finalization — the reply would land and the turn
    // would never settle. A guard rather than a regression pin: it also
    // passes against the pre-change code, which had no return either.
    const branch = nonStreamedTextBranch();
    assert.doesNotMatch(branch, /\breturn\b/,
      'the branch must fall through to the shared tail, never return out of it');
  });

  test('the rich attempt cannot throw past the plain fallback', () => {
    // The factory is contracted not to throw, but its styling-retry ladder
    // evaluates outside a try. An escaping throw would skip the else arm
    // entirely and cost the whole reply rather than its formatting.
    const branch = nonStreamedTextBranch();
    const split = branch.indexOf('} else {');
    const richArm = branch.slice(0, split);
    assert.match(richArm, /try \{[\s\S]*makeRichDeliverText[\s\S]*\} catch/,
      'the rich delivery call must be wrapped so a throw degrades to plain');
    assert.match(richArm, /catch[\s\S]*richOut = null/,
      'and the catch must leave richOut falsy so the plain arm runs');
  });

  test('both arms report to the incomplete-delivery gate — one call in each', () => {
    // Counting two anywhere in the branch would also pass if both sat in the
    // same arm, so split at the else and require one on each side.
    const branch = nonStreamedTextBranch();
    const split = branch.indexOf('} else {');
    assert.notEqual(split, -1, 'the branch must have both arms');
    const richArm = branch.slice(0, split);
    const plainArm = branch.slice(split);
    assert.match(richArm, /mediaContext\.recordTextFailures\(richOut\.failed\.length\)/,
      'the rich arm must report, or a rich reply never clears the gate');
    assert.match(plainArm, /mediaContext\.recordTextFailures\(deliveryResult\.failed\.length\)/,
      'the plain arm must keep reporting its chunk failures');
  });

  test('the plain arm is reachable ONLY through the else', () => {
    // The structural assertion above would still pass if a stray
    // deliverReplies ran after the if/else and re-sent the same body.
    const branch = nonStreamedTextBranch();
    const calls = branch.match(/await deliverReplies\(/g) || [];
    assert.equal(calls.length, 1,
      'exactly one plain delivery may exist in this branch; a second would '
      + 'double-post whatever the rich arm already sent');
    const split = branch.indexOf('} else {');
    assert.ok(branch.indexOf('await deliverReplies(') > split,
      'the only plain delivery must sit inside the else arm');
  });

  test('the whole reply is handed over, anchored to the user message', () => {
    // Without this, truncating the body or dropping the anchor is invisible
    // to every other assertion here: the shape stays intact while the user
    // gets a fragment, or an unanchored bubble.
    const branch = nonStreamedTextBranch();
    assert.match(branch, /text: parsed\.text,/,
      'the factory must receive the complete reply, not a slice of it');
    assert.match(branch, /replyToMessageId: msg\.message_id,/,
      'the rich send must quote the user message, as the plain chunker does');
  });

  test('polygram.js still compiles', () => {
    // Every other assertion here reads the file as text, so a file that
    // cannot parse — and a daemon that cannot boot — passes them all.
    const vm = require('node:vm');
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'polygram.js' }),
      'polygram.js must parse; text assertions cannot see a syntax error');
  });

  test('the rich attempt is text-only — the factory gets chat identity and nothing else', () => {
    // Media roots are what turn the render into an uploader. This path has
    // always degraded media to caption text, so handing the factory roots
    // would open an upload surface with no preflight behind it.
    const branch = nonStreamedTextBranch();
    assert.match(branch, /makeRichDeliverText\(\{ chatId, threadId \}\)/,
      'the factory must be called with chat identity only');
    assert.doesNotMatch(branch, /allowedRoots\s*:/,
      'no roots may be passed into this delivery');
  });

  test('the rich send is tagged distinctly from the streamed open', () => {
    // rich-message-sent carries no source field, and the streamed rich open
    // already reports as bot-reply-stream. Without a tag of its own nothing
    // downstream can tell this path landed rich.
    const branch = nonStreamedTextBranch();
    assert.match(branch, /source: 'bot-reply-final-rich'/,
      'the non-streamed rich send needs its own source tag to be observable');
    assert.match(branch, /source: 'bot-reply-final'/,
      'the plain arm needs one too — five call sites write the bare '
      + 'bot-reply-stream tag and three of them deliver reply bodies, so a '
      + 'row carrying it cannot say which branch produced it');
  });

  test('the plain fallback body survives a decline that carries no text', () => {
    const branch = nonStreamedTextBranch();
    assert.match(branch, /richOut\?\.text \?\?/,
      'a rich-off chat declines with no body at all; chunking that undefined '
      + 'would drop the reply for every chat that never opted into rich');
    assert.match(branch, /stripMediaMarkdown\(parsed\.text\)/,
      'the fallback arm must keep stripping media markdown, or a rich-enabled '
      + 'chat that declines shows a raw local path in the bubble');
  });
});

describe('the factory is wired where both callers can reach it', () => {
  // Every assertion above reads the delivery branch. None of them reads
  // main(), so deleting the assignment — or moving it below the chain, where
  // composeDeliverTextFactories silently drops a non-function — leaves them
  // all green while the whole fleet reverts to plain. That is precisely the
  // bug this change exists to remove, so it gets its own pin.
  const assignedAt = source.indexOf('makeRichDeliverText = createRichDeliveryFactory(');
  const composedAt = source.indexOf('composeDeliverTextFactories(');

  test('the module-level binding is assigned from the factory', () => {
    assert.notEqual(assignedAt, -1,
      'main() must assign makeRichDeliverText, or the interactive path has '
      + 'no factory to call and silently delivers plain forever');
  });

  test('it is assigned before the chain that consumes it, not after', () => {
    assert.notEqual(composedAt, -1, 'the reply-tool chain must exist');
    assert.ok(assignedAt < composedAt,
      'assigning after the chain passes undefined into it — the strategy '
      + 'list drops non-functions, so the reply tool would lose rich too');
  });

  test('the same instance is handed to the reply-tool chain', () => {
    // Two instances would be two capability latches and two styling
    // verdicts, drifting apart with no way to notice.
    const chain = source.slice(composedAt, source.indexOf(']);', composedAt));
    assert.match(chain, /^\s*makeRichDeliverText,\s*$/m,
      'the chain must receive the same binding the interactive path calls');
  });
});

describe('the decline contract the fallback depends on', () => {
  const factory = () => createRichDeliveryFactory({
    sendRich: async () => ({ wentRich: false, fallback: 'capability' }),
    isRichTextEnabled: () => false,
  });

  test('a chat with rich off declines WITHOUT a body — this is why ?? is load-bearing', async () => {
    // Asserted as behavior rather than trusted from the module's shape: if
    // this contract ever changes the fallback above is what stands between a
    // decline and a lost reply, and the `??` must keep covering it.
    const deliver = factory()({ chatId: 1, threadId: null });
    const out = await deliver({ text: '# heading\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
    assert.equal(out.handled, false, 'rich off must decline');
    assert.equal(out.text, undefined,
      'the flag-off decline carries no text, so the caller must supply its own');
  });

  test('a rich-enabled chat that lands rich reports the shape the caller reads', async () => {
    const deliver = createRichDeliveryFactory({
      sendRich: async () => ({ wentRich: true, result: { message_id: 42 } }),
      isRichTextEnabled: () => true,
    })({ chatId: 1, threadId: null });
    const out = await deliver({ text: '# heading\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
    assert.equal(out.handled, true);
    assert.deepEqual(out.failed, [],
      'the caller reads .failed.length straight into recordTextFailures');
  });

  test('plain prose is declined with a body, so the caller chunks it as before', async () => {
    const deliver = createRichDeliveryFactory({
      sendRich: async () => { throw new Error('must not be called'); },
      isRichTextEnabled: () => true,
    })({ chatId: 1, threadId: null });
    const out = await deliver({ text: 'Just a sentence with no structure at all.' });
    assert.equal(out.handled, false, 'unstructured prose stays on the plain path');
    assert.equal(typeof out.text, 'string', 'and comes back with a body to chunk');
  });
});
