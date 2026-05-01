const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isAbortRequest } = require('../lib/abort-detector');

describe('isAbortRequest — English', () => {
  test('bare "stop" triggers', () => {
    assert.equal(isAbortRequest('stop'), true);
    assert.equal(isAbortRequest('Stop'), true);
    assert.equal(isAbortRequest('STOP'), true);
    assert.equal(isAbortRequest('stop.'), true);
    assert.equal(isAbortRequest('stop!'), true);
    assert.equal(isAbortRequest(' stop '), true);
  });

  test('common variants trigger', () => {
    for (const phrase of ['wait', 'cancel', 'abort', 'halt', 'hold on', 'hold up', 'never mind', 'nevermind', 'nvm', 'forget it']) {
      assert.equal(isAbortRequest(phrase), true, `expected "${phrase}" to trigger`);
    }
  });

  test('slash commands trigger', () => {
    assert.equal(isAbortRequest('/stop'), true);
    assert.equal(isAbortRequest('/abort'), true);
    assert.equal(isAbortRequest('/cancel'), true);
    assert.equal(isAbortRequest('/stop@shumobot'), true);
    assert.equal(isAbortRequest('/stop please'), true);
  });
});

describe('isAbortRequest — Russian', () => {
  test('common variants trigger', () => {
    for (const phrase of ['стоп', 'подожди', 'остановись', 'отмена', 'прекрати', 'хватит', 'забей']) {
      assert.equal(isAbortRequest(phrase), true, `expected "${phrase}" to trigger`);
    }
  });

  test('case insensitive cyrillic', () => {
    assert.equal(isAbortRequest('Стоп'), true);
    assert.equal(isAbortRequest('СТОП'), true);
  });
});

describe('isAbortRequest — @-mention stripping', () => {
  test('strips leading @-mention', () => {
    assert.equal(isAbortRequest('@shumobot stop'), true);
    assert.equal(isAbortRequest('@umiassit_bot стоп'), true);
  });
});

describe('isAbortRequest — false-positive guards', () => {
  test('long messages with abort word do not trigger', () => {
    assert.equal(isAbortRequest('stop using markdown in your replies please'), false);
    assert.equal(isAbortRequest('I want to cancel my last order, order id 12345'), false);
    assert.equal(isAbortRequest('подожди пожалуйста, я не готов'), false);
  });

  test('not-at-start does not trigger', () => {
    assert.equal(isAbortRequest('I said stop'), false);
    assert.equal(isAbortRequest('hey wait'), false);
  });

  test('empty / non-string returns false', () => {
    assert.equal(isAbortRequest(''), false);
    assert.equal(isAbortRequest(null), false);
    assert.equal(isAbortRequest(undefined), false);
    assert.equal(isAbortRequest(42), false);
  });

  test('trailing punctuation is ignored; trailing content is not', () => {
    assert.equal(isAbortRequest('stop.'), true);
    assert.equal(isAbortRequest('stop!!!'), true);
    assert.equal(isAbortRequest('stop, then resume'), false);
  });
});

describe('isAbortRequest — first-sentence detection (HARD phrases only)', () => {
  // rc.41: only HARD phrases trigger first-sentence abort. Soft phrases
  // like "wait", "hold on", "подожди" are conversational openers — see
  // the rc.41 false-positive describe block below.

  test('HARD phrase + period + continuation triggers', () => {
    assert.equal(isAbortRequest("Stop. I'll ask in another session."), true);
    assert.equal(isAbortRequest('Cancel? Actually no, continue.'), true);
    assert.equal(isAbortRequest('Abort! I made a mistake.'), true);
    assert.equal(isAbortRequest('Стоп. Я подумаю и вернусь.'), true);
    assert.equal(isAbortRequest('Хватит! Этого достаточно.'), true);
    assert.equal(isAbortRequest('Прекрати. Я сам разберусь.'), true);
  });

  test('with leading @-mention still triggers', () => {
    assert.equal(isAbortRequest("@shumobot Stop. I'll ask later."), true);
  });

  test('first sentence that is NOT an exact HARD phrase does not trigger', () => {
    assert.equal(isAbortRequest('Stop using markdown. Plain text only.'), false);
    assert.equal(isAbortRequest("Wait a sec. I'm typing."), false);
  });

  test('comma is not a sentence boundary (ambiguous)', () => {
    // "Stop, look here" is ambiguous — could be "halt and look" or "halt!
    // look here" — keep it non-abort to avoid false positives.
    assert.equal(isAbortRequest('Stop, look at this thread'), false);
  });
});

describe('isAbortRequest — rc.41 SOFT-phrase first-sentence guard', () => {
  // The reason this whole block exists: 2026-05-01 19:01 production
  // false-positive in Ivan DM. User wrote
  //   "Wait? There is something wrong.. parents get 35 we get 65."
  // First-sentence split → "Wait" → was in ABORT_PHRASES → triggered
  // abort → bot replied "Nothing to stop." instead of helping with the
  // VAT/percentage question. "Wait" + multi-sentence content is
  // conversational filler, not abort intent.
  //
  // Fix: split phrases into HARD (first-sentence-eligible) and SOFT
  // (whole-message-only). Soft phrases must be the WHOLE message to
  // count as abort.

  test('production false positive: "Wait? Something is wrong..." does NOT abort', () => {
    assert.equal(
      isAbortRequest('Wait? There is something wrong.. parents get 35 we get 65.'),
      false,
    );
  });

  test('SOFT phrase + multi-sentence does NOT trigger', () => {
    assert.equal(isAbortRequest('Wait! I forgot to mention something.'), false);
    assert.equal(isAbortRequest('Hold on, let me check the docs first.'), false);
    assert.equal(isAbortRequest("Nevermind. Actually let's continue."), false);
    assert.equal(isAbortRequest('Подожди, я сначала проверю.'), false);
    assert.equal(isAbortRequest('Забей. На самом деле продолжай.'), false);
    assert.equal(isAbortRequest('Forget it! Continue with what you had.'), false);
  });

  test('SOFT phrase as the WHOLE message still triggers', () => {
    // Whole-message exact match still fires for soft phrases — that
    // case is unambiguous (user typed JUST that word).
    assert.equal(isAbortRequest('wait'), true);
    assert.equal(isAbortRequest('Wait!'), true);
    assert.equal(isAbortRequest('hold on'), true);
    assert.equal(isAbortRequest('nevermind'), true);
    assert.equal(isAbortRequest('подожди'), true);
    assert.equal(isAbortRequest('забей'), true);
  });

  test('HARD phrase + multi-sentence still triggers (no regression)', () => {
    // Make sure the rc.41 narrowing didn't break the legitimate
    // first-sentence path. Note: "Cancel that. I changed my mind." does
    // NOT trigger because the first sentence is "cancel that" (two
    // words, not in ABORT_PHRASES). That's correct — multi-word first
    // sentences are ambiguous. Use single-word first sentences for
    // unambiguous abort intent.
    assert.equal(isAbortRequest("Stop. Let me try something else."), true);
    assert.equal(isAbortRequest('Cancel. I changed my mind.'), true);
    assert.equal(isAbortRequest('Стоп. Это не то.'), true);
  });
});
