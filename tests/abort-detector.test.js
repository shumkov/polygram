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

describe('isAbortRequest — first-sentence detection', () => {
  test('abort phrase + period + continuation triggers', () => {
    assert.equal(isAbortRequest("Stop. I'll ask in another session."), true);
    assert.equal(isAbortRequest('Wait! I forgot to mention something.'), true);
    assert.equal(isAbortRequest('Cancel? Actually no, continue.'), true);
    assert.equal(isAbortRequest('Стоп. Я подумаю и вернусь.'), true);
    assert.equal(isAbortRequest('Хватит! Этого достаточно.'), true);
  });

  test('with leading @-mention still triggers', () => {
    assert.equal(isAbortRequest("@shumobot Stop. I'll ask later."), true);
  });

  test('first sentence that is NOT an exact phrase does not trigger', () => {
    assert.equal(isAbortRequest('Stop using markdown. Plain text only.'), false);
    assert.equal(isAbortRequest("Wait a sec. I'm typing."), false);
  });

  test('comma is not a sentence boundary (ambiguous)', () => {
    // "Stop, look here" is ambiguous — could be "halt and look" or "halt!
    // look here" — keep it non-abort to avoid false positives.
    assert.equal(isAbortRequest('Stop, look at this thread'), false);
  });
});
