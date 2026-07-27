'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEditRedelivery } = require('../lib/handlers/edit-redelivery');

function harness({
  inFlight = false,
  gate = true,
  optOut = false,
  chat = true,
  backend = 'claude',
  generationId = 'generation-a',
} = {}) {
  const dispatched = [];
  const injected = [];
  const reactions = [];
  const events = [];
  let proc = inFlight || backend === 'codex'
    ? Object.assign(new EventEmitter(), {
      backend,
      runtime: backend,
      generationId: backend === 'codex' ? generationId : undefined,
      inFlight,
      closed: false,
    })
    : null;
  const pm = {
    get: () => proc,
    getBackend: () => proc?.backend ?? backend,
    injectUserMessage: (sk, opts) => { injected.push({ sk, opts }); return true; },
  };
  const config = {
    chats: chat ? { '100': { name: 'X', ...(optOut && { editCorrection: false }) } } : {},
    bot: {},
  };
  const realM = createEditRedelivery({
    pm, config,
    getSessionKey: (cid, tid) => (tid ? `${cid}:${tid}` : cid),
    shouldHandle: () => gate,
    dispatchHandleMessage: (sk, cid, msg) => dispatched.push({ sk, cid, msg }),
    bot: {},
    react: (cid, mid) => reactions.push({ cid, mid }),
    logEvent: (k, d) => events.push({ k, d }),
    logger: { error: () => {} },
  });
  // botUsername / mentionRe are CALL-TIME args (resolved async via getMe in prod, and
  // out of the factory's main() scope — rc.34 boot crash). The harness threads fixed
  // values so the existing call sites stay m(msg, oldText).
  const m = (editedMsg, oldText) => realM(editedMsg, oldText, 'bot', null);
  return {
    m,
    dispatched,
    injected,
    reactions,
    events,
    get proc() { return proc; },
    replaceProc(next) { proc = next; },
  };
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

  test('interlock (0.13 per-message): a re-edit of the SAME message while its re-run is in flight folds via inject', () => {
    const H = harness({ inFlight: true });
    // First edit: no redelivery of THIS message is in flight yet → dispatches
    // its own redelivery even though A turn is running (pre-0.13 the per-
    // SESSION interlock folded it as a hand-built "[edit]" inject).
    const ok1 = H.m(editedMsg({ text: 'first correction' }), 'orig');
    assert.equal(ok1, true, 'first edit of the message redelivers (autosteer handles the in-flight turn)');
    assert.equal(H.dispatched.length, 1);
    assert.equal(H.injected.length, 0);
    // Second edit of the SAME message while its re-dispatch runs → folds.
    const ok2 = H.m(editedMsg({ text: 'second correction' }), 'first correction');
    assert.equal(ok2, false);
    assert.equal(H.injected.length, 1, 'same-message re-edit folds via inject (no 2nd turn for the same message)');
    assert.match(H.injected[0].opts.content, /second correction/);
    assert.ok(H.events.find((e) => e.k === 'edit-redelivery-folded'));
    // An edit of a DIFFERENT message proceeds as its own redelivery.
    const ok3 = H.m(editedMsg({ message_id: 501, text: 'other message edit' }), 'other orig');
    assert.equal(ok3, true, 'different message is NOT held hostage by the per-session state');
    assert.equal(H.dispatched.length, 2);
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
    // shouldHandle throwing must not escape
    const m = createEditRedelivery({
      pm: { get: () => null }, config: { chats: { '100': {} }, bot: {} },
      getSessionKey: () => 's', shouldHandle: () => { throw new Error('boom'); },
      dispatchHandleMessage: () => {}, bot: {}, logger: { error: () => {} },
    });
    assert.equal(m(editedMsg({ text: 'new' }), 'old', 'bot', null), false);
  });
});

describe('post-turn edit re-delivery — Codex generation-fenced deferral', () => {
  test('live Codex turn defers until idle without using the synchronous injector', () => {
    const H = harness({ backend: 'codex', inFlight: true });

    assert.equal(H.m(editedMsg({ text: 'corrected' }), 'original'), false);
    assert.equal(H.dispatched.length, 0);
    assert.equal(H.injected.length, 0);
    assert.deepEqual(H.reactions, [{ cid: '100', mid: 500 }]);
    assert.ok(H.events.some((event) => event.k === 'edit-redelivery-deferred'));

    H.proc.inFlight = false;
    H.proc.emit('idle');

    assert.equal(H.dispatched.length, 1);
    assert.equal(H.dispatched[0].msg.text, 'corrected');
    assert.equal(H.dispatched[0].msg.reply_to_message.text, 'original');
    assert.equal(H.dispatched[0].msg._requiredProvider, 'codex');
    assert.ok(H.events.some((event) => event.k === 'edit-redelivered'));
  });

  test('re-edits coalesce to latest per message while different messages keep registration order', () => {
    const H = harness({ backend: 'codex', inFlight: true });

    H.m(editedMsg({ message_id: 500, text: 'first-500' }), 'original-500');
    H.m(editedMsg({ message_id: 501, text: 'only-501' }), 'original-501');
    H.m(editedMsg({ message_id: 500, text: 'latest-500' }), 'first-500');
    assert.equal(H.dispatched.length, 0);
    assert.equal(H.injected.length, 0);

    H.proc.inFlight = false;
    H.proc.emit('idle');

    assert.deepEqual(
      H.dispatched.map(({ msg }) => [msg.message_id, msg.text, msg.reply_to_message.text]),
      [
        [500, 'latest-500', 'first-500'],
        [501, 'only-501', 'original-501'],
      ],
    );
  });

  test('close cancels deferred edits and cancellation telemetry contains no edited content', () => {
    const H = harness({ backend: 'codex', inFlight: true });
    H.m(editedMsg({ text: 'private corrected content' }), 'private original content');

    H.proc.closed = true;
    H.proc.emit('close');
    H.proc.inFlight = false;
    H.proc.emit('idle');

    assert.equal(H.dispatched.length, 0);
    const cancelled = H.events.find((event) => event.k === 'edit-redelivery-deferred-cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.d.reason, 'close');
    assert.equal(JSON.stringify(cancelled.d).includes('private'), false);
  });

  test('generation replacement cannot release old deferred edits into the replacement', () => {
    const H = harness({ backend: 'codex', inFlight: true, generationId: 'generation-old' });
    const oldProc = H.proc;
    H.m(editedMsg({ text: 'for old generation' }), 'original');

    H.replaceProc(Object.assign(new EventEmitter(), {
      backend: 'codex',
      runtime: 'codex',
      generationId: 'generation-new',
      inFlight: false,
      closed: false,
    }));
    oldProc.inFlight = false;
    oldProc.emit('idle');

    assert.equal(H.dispatched.length, 0);
    const cancelled = H.events.find((event) => event.k === 'edit-redelivery-deferred-cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.d.reason, 'generation-replaced');
  });

  test('session reset cancels rather than resurrecting deferred edits', () => {
    const H = harness({ backend: 'codex', inFlight: true });
    H.m(editedMsg({ text: 'corrected' }), 'original');

    H.proc.emit('session-reset', { reason: 'model-change' });
    H.proc.inFlight = false;
    H.proc.emit('idle');

    assert.equal(H.dispatched.length, 0);
    assert.equal(
      H.events.find((event) => event.k === 'edit-redelivery-deferred-cancelled')?.d.reason,
      'session-reset',
    );
  });

  test('successful native stop cancels deferred edits even if the process remains open', () => {
    const H = harness({ backend: 'codex', inFlight: true });
    H.m(editedMsg({ text: 'corrected' }), 'original');

    H.proc.inFlight = false;
    H.proc.emit('codex-settled', {
      kind: 'stopped',
      generationId: 'generation-a',
    });
    H.proc.emit('idle');

    assert.equal(H.dispatched.length, 0);
    assert.equal(
      H.events.find((event) => event.k === 'edit-redelivery-deferred-cancelled')?.d.reason,
      'stop',
    );
  });

  test('idle Codex edit keeps the ordinary immediate post-turn redelivery path', () => {
    const H = harness({ backend: 'codex', inFlight: false });
    assert.equal(H.m(editedMsg({ text: 'new' }), 'old'), true);
    assert.equal(H.dispatched.length, 1);
    assert.equal(H.injected.length, 0);
  });
});

describe('post-turn edit re-delivery — call-time botUsername / mentionRe (rc.35)', () => {
  // rc.34 boot crash: the factory (built in main()) took botUsername / mentionRe as
  // construction deps, but those are createBot-scoped locals resolved async via getMe
  // → ReferenceError at boot. They are now CALL-TIME args. These pin that contract.
  test('botUsername is forwarded to shouldHandle from the call args, not construction', () => {
    let seen = 'UNSET';
    const m = createEditRedelivery({
      pm: { get: () => null }, config: { chats: { '100': { name: 'X' } }, bot: {} },
      getSessionKey: () => 's',
      shouldHandle: (_msg, _cfg, botUsername) => { seen = botUsername; return false; },
      dispatchHandleMessage: () => {}, bot: {}, logger: { error: () => {} },
    });
    m(editedMsg({ text: 'new' }), 'old', 'realbot', null);
    assert.equal(seen, 'realbot', 'shouldHandle got the call-time botUsername');
  });

  test('mentionRe passed at call time strips the @mention from the dispatched body', () => {
    const dispatched = [];
    const m = createEditRedelivery({
      pm: { get: () => null }, config: { chats: { '100': { name: 'X' } }, bot: {} },
      getSessionKey: () => 's', shouldHandle: () => true,
      dispatchHandleMessage: (sk, cid, msg) => dispatched.push(msg),
      bot: {}, logger: { error: () => {} },
    });
    m(editedMsg({ text: '@bot do the thing' }), 'old', 'bot', /@bot\b/g);
    assert.equal(dispatched[0].text, 'do the thing');
  });
});
