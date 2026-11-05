'use strict';

/**
 * A CLI turn whose model request ends in an API error must reach the Telegram
 * user promptly, as one calm message, instead of silence until the turn
 * ceiling (VPS shumabit, 2026-11-04/05: CLIProxy's Claude credentials had
 * expired; claude retried ~3 minutes, wrote a synthetic `isApiErrorMessage`
 * server_error and fired StopFailure; users heard nothing for hours).
 *
 * Orchestra ends such a turn with err.code CLAUDE_API_ERROR (claude's error
 * class on err.apiError). These tests pin what Polygram then tells the user.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classify, classifyTurnEndError } = require('../lib/error/classify');
const { isAutoResumable } = require('../lib/db/auto-resume');

function apiError(kind, message = 'Claude ended this turn with an API error') {
  return Object.assign(new Error(message), { code: 'CLAUDE_API_ERROR', apiError: kind });
}

describe('the message a user gets when claude gave up on a failing API', () => {
  test('the incident class (expired proxy credentials reported as server_error) reads as a temporary failure', () => {
    const cls = classify(apiError('server_error'));
    assert.equal(cls.kind, 'claudeApiError');
    assert.match(cls.userMessage, /kept failing/);
    assert.match(cls.userMessage, /try again in a few minutes/);
    assert.equal(cls.isTransient, false, 'nothing may retry this turn automatically');
    assert.equal(cls.autoRecover, null, 'nothing may reset the session automatically');
  });

  test('each class maps to copy the user can act on', () => {
    const temporary = classify(apiError('server_error')).userMessage;
    for (const kind of ['overloaded', 'rate_limit', 'unknown', 'a_class_from_a_newer_cli']) {
      assert.equal(classify(apiError(kind)).userMessage, temporary, kind);
    }
    const account = classify(apiError('authentication_failed')).userMessage;
    assert.match(account, /account or configuration problem/);
    for (const kind of ['cloud_credential_error', 'verification_required', 'billing_error', 'account_on_hold', 'model_not_found']) {
      assert.equal(classify(apiError(kind)).userMessage, account, kind);
    }
    assert.match(classify(apiError('invalid_request')).userMessage, /\/new/);
    assert.match(classify(apiError('max_output_tokens')).userMessage, /output limit/);
  });

  test('the copy never promises an operator was notified and never names billing details', () => {
    for (const kind of ['server_error', 'authentication_failed', 'billing_error', 'invalid_request', 'max_output_tokens']) {
      const text = classify(apiError(kind)).userMessage;
      assert.doesNotMatch(text, /notified|operator/i, kind);
      assert.doesNotMatch(text, /credit|payment|billing/i, kind);
    }
  });

  test('an org that disabled subscription access keeps the AUTH_DISABLED contract: the chat is told nothing', () => {
    const cls = classify(apiError('oauth_org_not_allowed'));
    assert.equal(cls.kind, 'authDisabled');
    assert.equal(cls.userMessage, null);
  });

  test('the typed code decides — message text that would pattern-match changes nothing', () => {
    const cls = classify(apiError('server_error', 'HTTP 429 rate limit: prompt is too long; could not process image'));
    assert.equal(cls.kind, 'claudeApiError');
    assert.equal(cls.autoRecover, null, 'a provider phrase must not trigger reset_session');
  });

  test('a hostile class value cannot reach Object.prototype or silence the reply', () => {
    for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, 42]) {
      const cls = classify(apiError(kind));
      assert.equal(typeof cls.userMessage, 'string', String(kind));
      assert.match(cls.userMessage, /kept failing/, String(kind));
    }
  });

  test('the turn-end exit marks a partial preview but sends no second "stream interrupted" message', () => {
    const r = classifyTurnEndError(apiError('server_error'));
    assert.equal(r.reactorState, 'ERROR');
    assert.equal(r.errorSuffix, 'stream interrupted', 'a half-written preview must not read as finished');
    assert.equal(r.suffixMessage, false, 'the classified reply is the one error message');
    assert.notEqual(classifyTurnEndError(new Error('x')).suffixMessage, false,
      'every other error keeps its separate suffix message');
  });

  test('the turn-end exit honours suffixMessage (source tripwire: handleMessage has no seam)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
    const start = src.indexOf('const settleErrorExit = async (');
    assert.notEqual(start, -1);
    assert.match(src.slice(start, start + 700), /if \(errorSuffix && suffixMessage\)/);
    assert.match(src, /settleErrorExit\(errorSuffix, \{ suffixMessage \}\)/);
  });

  test('no automatic continuation: the failed turn is the user\'s to resend', () => {
    assert.equal(isAutoResumable({
      error: apiError('server_error'), aborted: false, replay: false, shuttingDown: false,
    }), false);
  });
});

