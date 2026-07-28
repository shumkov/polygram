'use strict';

/**
 * The shared rich-capability latch.
 *
 * Latching is permanent for the process and disables rich on every path at
 * once, so the evidence bar matters. An error that NAMES the missing
 * capability can only come from a server that read the payload — one is
 * enough. A bare 404 is also what a restarting or briefly misrouted bot-api
 * server returns, so it buys a strike rather than a verdict.
 *
 * The counter has to be shared by the send and edit paths, not owned by
 * either. They latch the same process-wide flag, so a per-module counter
 * lets one path trip the flag on its first 404 while the other believes it
 * is still protected — which is the restart blip the rule exists to survive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRichCapabilityLatch } = require('../lib/telegram/rich-capability-latch');
const { createRichSender } = require('../lib/telegram/rich-send');
const { createRichEditor } = require('../lib/telegram/rich-edit');
const {
  isRichCapabilityError,
  isRichCapabilityErrorExplicit,
  isRichMessageFieldRejection,
  isRichContentError,
} = require('../lib/telegram/rich');

const quiet = { error: () => {}, warn: () => {} };
const BLOCKS = [{ type: 'heading', level: 1, text: 'Title' }];
const err = (message, extra = {}) => Object.assign(new Error(message), extra);

const BARE_404 = () => err('Not Found', { error_code: 404 });
const EXPLICIT = () => err('Bad Request: unknown field rich_message');

// One shared strike counter, one verdict PER VERB — the production wiring.
function buildFleet() {
  const unsupported = { send: false, edit: false };
  const events = [];
  const logEvent = (kind, detail) => events.push({ kind, detail });

  const capabilityLatch = createRichCapabilityLatch({
    isExplicit: isRichCapabilityErrorExplicit,
    isFieldRejection: isRichMessageFieldRejection,
    setUnsupported: (verb) => { unsupported[verb] = true; },
  });

  let nextError = null;
  const tg = async (_bot, method) => {
    if (nextError && (method === 'sendRichMessage' || method === 'editMessageText')) {
      const e = nextError;
      nextError = null;
      throw e;
    }
    return { message_id: 1, date: 1 };
  };

  const shared = {
    tg,
    botName: 'testbot',
    logEvent,
    redactBotToken: (s) => s,
    isRichCapabilityError,
    isRichCapabilityErrorExplicit,
    isRichContentError,
    capabilityLatch,
    logger: quiet,
  };

  const sendRich = createRichSender({
    ...shared,
    insertSentRow: () => {},
    getRichKnownUnsupported: () => unsupported.send,
    setRichKnownUnsupported: () => { unsupported.send = true; },
  });
  const richEdit = createRichEditor({
    ...shared,
    getRichKnownUnsupported: () => unsupported.edit,
    setRichKnownUnsupported: () => { unsupported.edit = true; },
  });

  return {
    isLatched: () => unsupported.send || unsupported.edit,
    sendUnsupported: () => unsupported.send,
    editUnsupported: () => unsupported.edit,
    events,
    // Each helper performs ONE rich attempt against the given error.
    async send(error) {
      nextError = error ?? null;
      return sendRich({
        bot: {}, chatId: '1', threadId: null, blocks: BLOCKS, sourceText: '# Title',
      });
    },
    async edit(error) {
      nextError = error ?? null;
      return richEdit({
        bot: {}, chatId: '1', messageId: 42, blocks: BLOCKS, sourceText: '# Title',
      });
    },
  };
}

// ─── The latch itself ──────────────────────────────────────────────────────

test('an explicit capability error latches on first sight', () => {
  let latched = false;
  const latch = createRichCapabilityLatch({
    isExplicit: isRichCapabilityErrorExplicit,
    isFieldRejection: isRichMessageFieldRejection,
    setUnsupported: () => { latched = true; },
  });

  assert.equal(latch.recordCapabilityError(EXPLICIT(), 'send'), true);
  assert.equal(latched, true);
});

test('a bare 404 latches only on the second consecutive occurrence', () => {
  let latched = false;
  const latch = createRichCapabilityLatch({
    isExplicit: isRichCapabilityErrorExplicit,
    isFieldRejection: isRichMessageFieldRejection,
    setUnsupported: () => { latched = true; },
  });

  assert.equal(latch.recordCapabilityError(BARE_404(), 'send'), false, 'one 404 is a blip');
  assert.equal(latched, false);
  assert.equal(latch.recordCapabilityError(BARE_404(), 'send'), true, 'two in a row is a verdict');
  assert.equal(latched, true);
});

test('an outcome proving the endpoint answers breaks the run', () => {
  let latched = false;
  const latch = createRichCapabilityLatch({
    isExplicit: isRichCapabilityErrorExplicit,
    isFieldRejection: isRichMessageFieldRejection,
    setUnsupported: () => { latched = true; },
  });

  latch.recordCapabilityError(BARE_404(), 'send');
  latch.recordHealthyOutcome();
  latch.recordCapabilityError(BARE_404(), 'send');

  assert.equal(latched, false, 'the 404s were not consecutive');
});

test('without an explicit-error predicate every capability error latches at once', () => {
  // The default preserves the behavior of callers that have not opted into
  // the distinction; opting in is what buys the extra attempt.
  let latched = false;
  const latch = createRichCapabilityLatch({
    setUnsupported: () => { latched = true; },
  });

  assert.equal(latch.recordCapabilityError(BARE_404(), 'send'), true);
  assert.equal(latched, true);
});

// ─── Both paths, one counter ───────────────────────────────────────────────

test('a single bare 404 on a streamed edit does not disable the reply path', async () => {
  // The edit path latching alone was what defeated the rule: one 404 on a
  // streamed edit permanently downgraded the reply tool, which carries most
  // agent output, for the life of the process.
  const fleet = buildFleet();

  await fleet.edit(BARE_404());

  assert.equal(fleet.isLatched(), false, 'one blip on one path is not a capability verdict');
});

test('two consecutive bare 404s across the two paths do latch', async () => {
  const fleet = buildFleet();

  await fleet.edit(BARE_404());
  await fleet.send(BARE_404());

  assert.equal(fleet.isLatched(), true, 'the counter is shared, so the strikes add up');
});

test('an explicit rejection on the edit path still latches immediately', async () => {
  const fleet = buildFleet();

  await fleet.edit(EXPLICIT());

  assert.equal(fleet.isLatched(), true);
  assert.ok(fleet.events.some(e => e.kind === 'rich-capability-latched'));
});

test('a successful send between two 404s clears the strike on the edit path too', async () => {
  const fleet = buildFleet();

  await fleet.edit(BARE_404());
  await fleet.send(null);
  await fleet.edit(BARE_404());

  assert.equal(fleet.isLatched(), false);
});

test('a successful EDIT between two 404s clears the strike', async () => {
  // The reset lives on four wires — success and content-error, on each path.
  // Each one is independently deletable, so each needs its own case.
  const fleet = buildFleet();

  await fleet.send(BARE_404());
  await fleet.edit(null);
  await fleet.send(BARE_404());

  assert.equal(fleet.isLatched(), false);
});

test('a content error on the EDIT path clears the strike', async () => {
  const fleet = buildFleet();

  await fleet.send(BARE_404());
  await fleet.edit(err('Bad Request: RICH_MESSAGE_TOO_LONG'));
  await fleet.send(BARE_404());

  assert.equal(fleet.isLatched(), false, 'a rejected payload proves the endpoint answers');
});

test('a content error on the SEND path clears the strike', async () => {
  const fleet = buildFleet();

  await fleet.edit(BARE_404());
  await fleet.send(err('Bad Request: RICH_MESSAGE_TOO_LONG'));
  await fleet.edit(BARE_404());

  assert.equal(fleet.isLatched(), false);
});

test('bare 404s on the send verb never disable the edit verb', async () => {
  // A server can implement editMessageText{rich_message} and not the newer
  // sendRichMessage verb; it answers the latter with a bare 404. Treating one
  // flag as "rich is gone" lets a probe of the new verb kill rich edits that
  // are working right now.
  const fleet = buildFleet();

  await fleet.send(BARE_404());
  await fleet.send(BARE_404());

  assert.equal(fleet.sendUnsupported(), true, 'the probed verb is disabled');
  assert.equal(fleet.editUnsupported(), false, 'the working verb must survive');
});

test('a rejection naming the rich_message FIELD disables both verbs at once', async () => {
  // The field is what both verbs carry, so a server that cannot read it
  // cannot serve either.
  const fleet = buildFleet();

  await fleet.send(err('Bad Request: unknown field rich_message'));

  assert.equal(fleet.sendUnsupported(), true);
  assert.equal(fleet.editUnsupported(), true);
});

test('a missing-METHOD rejection disables only the verb that is missing', async () => {
  // "method sendRichMessage not found" says nothing about editMessageText.
  const fleet = buildFleet();

  await fleet.send(err('Bad Request: method sendRichMessage not found'));

  assert.equal(fleet.sendUnsupported(), true);
  assert.equal(fleet.editUnsupported(), false);
});

test('strikes are still shared across verbs', async () => {
  const fleet = buildFleet();

  await fleet.edit(BARE_404());
  await fleet.send(BARE_404());

  assert.equal(fleet.sendUnsupported(), true, 'the second strike lands on the verb that reported it');
  assert.equal(fleet.editUnsupported(), false);
});

test('an unlatched bare 404 still degrades that edit to plain', async () => {
  // Not latching is about the NEXT reply. This one still failed, so it must
  // fall back rather than be reported as a successful rich edit.
  const fleet = buildFleet();

  const res = await fleet.edit(BARE_404());

  assert.equal(res.wentRich, false);
  assert.ok(fleet.events.some(e => e.kind === 'rich-capability-strike'),
    `the strike should be observable: ${JSON.stringify(fleet.events.map(e => e.kind))}`);
  assert.ok(!fleet.events.some(e => e.kind === 'rich-capability-latched'));
});
