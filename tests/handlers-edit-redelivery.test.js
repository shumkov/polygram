'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createEditRedelivery } = require('../lib/handlers/edit-redelivery');

function harness({ inFlight = false, gate = true, optOut = false, chat = true } = {}) {
  const dispatched = [];
  const injected = [];
  const reactions = [];
  const events = [];
  const proc = inFlight ? { inFlight: true } : null;
  const pm = {
    get: () => proc,
    injectUserMessage: (sk, opts) => { injected.push({ sk, opts }); return true; },
  };
  const config = {
    chats: chat ? { '100': { name: 'X', ...(optOut && { editCorrection: false }) } } : {},
    bot: {},
  };
  const m = createEditRedelivery({
    pm, config,
    getSessionKey: (cid, tid) => (tid ? `${cid}:${tid}` : cid),
    shouldHandle: () => gate,
    dispatchHandleMessage: (sk, cid, msg) => dispatched.push({ sk, cid, msg }),
    bot: {},
    mentionRe: null,
    botUsername: 'bot',
    react: (cid, mid) => reactions.push({ cid, mid }),
    logEvent: (k, d) => events.push({ k, d }),
    logger: { error: () => {} },
  });
  return { m, dispatched, injected, reactions, events };
}

const editedMsg = (over = {}) => ({
  chat: { id: 100, type: 'supergroup' }, message_id: 500,
  from: { id: 7, first_name: 'Ivan' }, text: 'new text', date: 1000, ...over,
});

describe('post-turn edit re-delivery', () => {
  test('changed text → re-dispatches; OLD text in reply_to, NEW in body, reuses msg_id, _isReplay', () => {
    const H = harness();
    const ok = H.m(editedMsg({ text: 'let’s update the sheet tomorrow' }), 'let’s update the sheet');
    assert.equal(ok, true);
    assert.equal(H.dispatched.length, 1);
    const syn = H.dispatched[0].msg;
    assert.equal(syn.text, 'let’s update the sheet tomorrow', 'body = new text');
    assert.equal(syn.reply_to_message.text, 'let’s update the sheet', 'reply_to carries the OLD text (the before/after signal)');
    assert.equal(syn.reply_to_message.message_id, 500, 'reply_to points at the edited message');
    assert.equal(syn.message_id, 500, 'reuses the edited msg_id');
    assert.equal(syn._isReplay, true, 'tagged _isReplay (no new row, not replay-eligible)');
    assert.equal(syn.reply_to_message.from?.id, 7, 'reply_to has from → resolveReplyTo takes the telegram branch (not the overwritten db row)');
  });

  test('no text change (metadata edit) → no re-dispatch', () => {
    const H = harness();
    assert.equal(H.m(editedMsg({ text: 'same' }), 'same'), false);
    assert.equal(H.dispatched.length, 0);
    assert.equal(H.reactions.length, 0, 'no spurious reaction on a metadata edit');
  });

  test('blank / media-only new text → skip', () => {
    const H = harness();
    assert.equal(H.m(editedMsg({ text: '' }), 'had text before'), false);
    assert.equal(H.dispatched.length, 0);
  });

  test('gate fails on the real message → not re-dispatched (mention/pairing respected)', () => {
    const H = harness({ gate: false });
    assert.equal(H.m(editedMsg({ text: 'new' }), 'old'), false);
    assert.equal(H.dispatched.length, 0);
  });

  test('interlock: a re-edit while our re-run is IN FLIGHT folds via inject, no 2nd turn', () => {
    const H = harness({ inFlight: true });
    const ok = H.m(editedMsg({ text: 'edited again' }), 'old');
    assert.equal(ok, false, 'did not start a second turn');
    assert.equal(H.dispatched.length, 0);
    assert.equal(H.injected.length, 1, 'folded via inject instead');
    assert.match(H.injected[0].opts.content, /edited again/);
  });

  test('acknowledges immediately: reaction on the edited message on a real re-dispatch', () => {
    const H = harness();
    H.m(editedMsg({ text: 'new' }), 'old');
    assert.deepEqual(H.reactions, [{ cid: '100', mid: 500 }]);
  });

  test('opt-out (editCorrection:false) → neither dispatch nor reaction', () => {
    const H = harness({ optOut: true });
    assert.equal(H.m(editedMsg({ text: 'new' }), 'old'), false);
    assert.equal(H.dispatched.length, 0);
    assert.equal(H.reactions.length, 0);
  });

  test('old text unavailable (null) → still re-dispatches, reply_to old text empty (graceful fallback)', () => {
    const H = harness();
    const ok = H.m(editedMsg({ text: 'new' }), null);
    assert.equal(ok, true);
    assert.equal(H.dispatched[0].msg.reply_to_message.text, '');
  });

  test('unknown chat → no-op', () => {
    const H = harness({ chat: false });
    assert.equal(H.m(editedMsg({ text: 'new' }), 'old'), false);
  });

  test('logs edit-redelivered for forensics', () => {
    const H = harness();
    H.m(editedMsg({ text: 'new' }), 'old');
    assert.ok(H.events.some((e) => e.k === 'edit-redelivered'));
  });

  test('never throws — degrades to false on an internal error', () => {
    const H = harness();
    // shouldHandle throwing must not escape
    const m = createEditRedelivery({
      pm: { get: () => null }, config: { chats: { '100': {} }, bot: {} },
      getSessionKey: () => 's', shouldHandle: () => { throw new Error('boom'); },
      dispatchHandleMessage: () => {}, bot: {}, botUsername: 'bot', logger: { error: () => {} },
    });
    assert.equal(m(editedMsg({ text: 'new' }), 'old'), false);
  });
});
