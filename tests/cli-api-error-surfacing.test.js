'use strict';

/**
 * A CLI turn whose model request ends in an API error must reach the Telegram
 * user promptly, as one calm message, instead of silence until the turn
 * ceiling (VPS shumabit, 2026-11-04/05: CLIProxy's Claude credentials had
 * expired; claude retried ~3 minutes, wrote a synthetic `isApiErrorMessage`
 * server_error and fired StopFailure; users heard nothing for hours).
 *
 * Orchestra ends such a turn with err.code CLAUDE_API_ERROR (claude's error
 * class on err.apiError), and reports a failed cycle that no pending turn ran
 * in — a follow-up autosteered into the failed turn — through onApiError.
 * These tests pin what Polygram then tells the user.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classify, classifyTurnEndError } = require('../lib/error/classify');
const { isAutoResumable } = require('../lib/db/auto-resume');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');

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
    for (const kind of ['overloaded', 'unknown', 'a_class_from_a_newer_cli']) {
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

  test('a rate limit does not promise a quick retry: a subscription usage cap can last hours', () => {
    const text = classify(apiError('rate_limit')).userMessage;
    assert.notEqual(text, classify(apiError('server_error')).userMessage);
    assert.match(text, /limit/);
    assert.doesNotMatch(text, /minute/i, 'telling the user to retry in minutes sends them into the same wall');
    assert.match(text, /hours/);
  });

  test('the copy never promises an operator was notified and never names billing details', () => {
    for (const kind of ['server_error', 'rate_limit', 'authentication_failed', 'billing_error', 'invalid_request', 'max_output_tokens']) {
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

function callbacks(extra = {}) {
  const sent = [];
  const events = [];
  const ended = [];
  const cbs = createSdkCallbacks({
    db: {}, dbWrite: () => {}, config: { chats: {} }, bot: {}, botName: 'b',
    tg: async (bot, method, params, meta) => { sent.push({ method, params, meta }); return {}; },
    logEvent: (kind, detail) => events.push({ kind, detail }),
    classifyToolName: () => 'TOOL', announce: () => {}, shouldAnnounce: () => false,
    contextHintShown: new Set(), extractAssistantText: () => '',
    getChatIdFromKey: (sk) => sk.split(':')[0],
    getThreadIdFromKey: (sk) => sk.split(':')[1] || null,
    sessionFeedback: { endCycle: (sk) => ended.push(sk), startAutonomousCycle: () => {}, stopCycleTyping: () => {} },
    logger: { error: () => {}, log: () => {} },
    ...extra,
  });
  return { cbs, sent, events, ended };
}

describe('a follow-up whose own cycle failed (no pending turn) is answered, not swallowed', () => {
  test('the follow-up gets one reply with the same copy, in its thread, and the cycle visuals end', () => {
    const { cbs, sent, events, ended } = callbacks();
    cbs.onApiError('-100123:77', { apiError: 'server_error', anchorMsgId: '42', sessionId: 's', backend: 'cli' });
    assert.deepEqual(ended, ['-100123:77'], 'typing and the anchor 🤔 stop');
    assert.equal(sent.length, 1);
    const { params, meta } = sent[0];
    assert.equal(params.chat_id, '-100123');
    assert.equal(params.message_thread_id, 77);
    assert.deepEqual(params.reply_parameters, { message_id: 42, allow_sending_without_reply: true });
    assert.equal(params.text, classify(apiError('server_error')).userMessage);
    assert.equal(meta.source, 'error-reply');
    assert.equal(meta.sessionKey, '-100123:77');
    assert.equal(meta.sourceMsgId, 42);
    assert.ok(events.some((e) => e.kind === 'cli-cycle-api-error' && e.detail.outcome === 'replied'));
  });

  test('a cycle no user is waiting on (a wakeup) only ends its visuals', () => {
    const { cbs, sent, ended } = callbacks();
    cbs.onApiError('100', { apiError: 'server_error', anchorMsgId: null });
    assert.deepEqual(ended, ['100']);
    assert.equal(sent.length, 0);
  });

  test('a failing visuals teardown does not cost the user the notice', () => {
    const { cbs, sent } = callbacks({
      sessionFeedback: { endCycle: () => { throw new Error('feedback bug'); } },
    });
    cbs.onApiError('100', { apiError: 'server_error', anchorMsgId: '7' });
    assert.equal(sent.length, 1);
  });

  test('stays quiet during shutdown, right after /stop, and for the AUTH_DISABLED class', () => {
    for (const [extra, payload, outcome] of [
      [{ getIsShuttingDown: () => true }, { apiError: 'server_error', anchorMsgId: '5' }, 'shutting-down'],
      [{ isSessionRecentlyAborted: () => true }, { apiError: 'server_error', anchorMsgId: '5' }, 'aborted'],
      [{}, { apiError: 'oauth_org_not_allowed', anchorMsgId: '5' }, 'auth-disabled'],
      [{}, { apiError: 'server_error', anchorMsgId: 'not-a-message-id' }, 'bad-anchor'],
      [{ bot: null }, { apiError: 'server_error', anchorMsgId: '5' }, 'no-bot'],
    ]) {
      const { cbs, sent, events, ended } = callbacks(extra);
      cbs.onApiError('100', payload);
      assert.equal(sent.length, 0, outcome);
      assert.deepEqual(ended, ['100'], `${outcome}: typing and the anchor 🤔 must still stop`);
      assert.ok(events.some((e) => e.kind === 'cli-cycle-api-error' && e.detail.outcome === outcome), outcome);
    }
  });
});
