/**
 * Tests for lib/handlers/voice.js — voice attachment transcription.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createTranscribeVoiceAttachments } = require('../lib/handlers/voice');

const silentLogger = { log: () => {}, error: () => {} };

function makeDeps(overrides = {}) {
  const events = [];
  const tgCalls = [];
  const dbCalls = [];
  return {
    events, tgCalls, dbCalls,
    deps: {
      config: { bot: { voice: { enabled: true } }, voice: undefined },
      db: {
        setAttachmentTranscription: (id, json) => dbCalls.push(['setAttachmentTranscription', id, json]),
        setMessageText: (args) => dbCalls.push(['setMessageText', args]),
      },
      dbWrite: (fn /* , label */) => fn(),
      tg: (b, method, params, meta) => {
        tgCalls.push({ method, params, meta });
        return Promise.resolve({ message_id: 1 });
      },
      logEvent: (kind, detail) => events.push({ kind, detail }),
      transcribeVoice: async (path, opts) => ({
        text: 'hello world',
        language: opts?.language || 'auto',
        duration_sec: 3.5,
        provider: opts.provider,
        cost_usd: 0.001,
      }),
      isVoiceAttachment: (a) => a.kind === 'voice' || a.kind === 'audio',
      botName: 'test-bot',
      logger: silentLogger,
      ...overrides,
    },
  };
}

describe('createTranscribeVoiceAttachments — factory contract', () => {
  test('returns a per-call function when all deps present', () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    assert.equal(typeof fn, 'function');
  });
});

describe('voice handler — short-circuit paths', () => {
  test('voice disabled in config → no ack, no transcribe', async () => {
    const m = makeDeps({ config: { bot: { voice: { enabled: false } } } });
    const fn = createTranscribeVoiceAttachments(m.deps);
    const res = await fn(
      [{ kind: 'voice', path: '/tmp/x', name: 'x.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: { mock: true } },
    );
    assert.equal(res.ackEmitted, false);
    assert.equal(m.tgCalls.length, 0);
    assert.equal(m.events.length, 0);
  });

  test('no voice attachments → no ack, no transcribe', async () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    const res = await fn(
      [{ kind: 'document', path: '/tmp/x', name: 'a.pdf' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} },
    );
    assert.equal(res.ackEmitted, false);
  });
});

describe('voice handler — happy path', () => {
  test('emits 👂 ack reaction', async () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn(
      [{ id: 7, kind: 'voice', path: '/tmp/v.ogg', name: 'v.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: { mock: true } },
    );
    assert.equal(m.tgCalls.length, 1);
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
    assert.deepEqual(m.tgCalls[0].params.reaction, [{ type: 'emoji', emoji: '👂' }]);
  });

  test('configured ackReaction overrides default 👂', async () => {
    const m = makeDeps({
      config: { bot: { voice: { enabled: true, ackReaction: '🎤' } } },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn(
      [{ id: 1, kind: 'voice', path: '/tmp/v.ogg', name: 'v.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} },
    );
    assert.deepEqual(m.tgCalls[0].params.reaction, [{ type: 'emoji', emoji: '🎤' }]);
  });

  test('persists transcription to attachments + messages tables', async () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn(
      [{ id: 7, kind: 'voice', path: '/tmp/v.ogg', name: 'v.ogg' }],
      { chatId: '1', msgId: 42, label: 't', botApi: {} },
    );
    const setAtt = m.dbCalls.find((c) => c[0] === 'setAttachmentTranscription');
    const setMsg = m.dbCalls.find((c) => c[0] === 'setMessageText');
    assert.ok(setAtt, 'setAttachmentTranscription called');
    assert.equal(setAtt[1], 7);
    assert.match(setAtt[2], /hello world/);
    assert.ok(setMsg, 'setMessageText called');
    assert.equal(setMsg[1].text, 'hello world');
  });

  test('emits voice-transcribed telemetry event per attachment', async () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn(
      [
        { id: 1, kind: 'voice', path: '/tmp/a.ogg', name: 'a.ogg' },
        { id: 2, kind: 'audio', path: '/tmp/b.mp3', name: 'b.mp3' },
      ],
      { chatId: '1', msgId: 1, label: 't', botApi: {} },
    );
    const evts = m.events.filter((e) => e.kind === 'voice-transcribed');
    assert.equal(evts.length, 2);
    assert.equal(evts[0].detail.chars, 11);
  });

  test('language passes through when configured (not auto)', async () => {
    const m = makeDeps({
      config: { bot: { voice: { enabled: true, language: 'en' } } },
      transcribeVoice: async (path, opts) => {
        assert.equal(opts.language, 'en');
        return { text: 'hi', language: 'en', duration_sec: 1, provider: 'openai' };
      },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn([{ id: 1, kind: 'voice', path: '/x', name: 'x' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} });
  });
});

describe('voice handler — failure paths', () => {
  test('transcription failure logs voice-transcribe-failed but does not throw', async () => {
    const m = makeDeps({
      transcribeVoice: async () => { throw new Error('whisper down'); },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    const res = await fn(
      [{ id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} },
    );
    // Ack reaction still fires even when transcription fails.
    assert.equal(res.ackEmitted, true);
    const failEvt = m.events.find((e) => e.kind === 'voice-transcribe-failed');
    assert.ok(failEvt);
    // The failure is recorded by class; the message can quote provider output
    // and the filename is user-controlled, so neither is persisted.
    assert.equal(failEvt.detail.error_class, 'Error');
    assert.equal(failEvt.detail.error, undefined);
    assert.equal(failEvt.detail.name, undefined);
  });

  test('null botApi means no ack reaction (ackEmitted=false)', async () => {
    const m = makeDeps();
    const fn = createTranscribeVoiceAttachments(m.deps);
    const res = await fn(
      [{ id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: null },
    );
    assert.equal(res.ackEmitted, false);
    assert.equal(m.tgCalls.length, 0);
  });

  test('no successful transcripts → no DB writes, just ack', async () => {
    const m = makeDeps({
      transcribeVoice: async () => { throw new Error('failed'); },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn(
      [{ id: 1, kind: 'voice', path: '/tmp/x', name: 'x' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} },
    );
    assert.equal(m.dbCalls.length, 0);
  });
});

describe('voice handler — provider settings', () => {
  test('timeoutMs and maxFileBytes from the voice config reach the provider', async () => {
    let seen;
    const m = makeDeps({
      config: { bot: { voice: { enabled: true, timeoutMs: 5000, maxFileBytes: 1234 } } },
      transcribeVoice: async (_p, opts) => { seen = opts; return { text: 'ok', provider: 'openai' }; },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn([{ id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' }],
      { chatId: '1', msgId: 1, label: 't', botApi: {} });
    assert.equal(seen.timeoutMs, 5000);
    assert.equal(seen.maxFileBytes, 1234);
  });
});

// A failed transcription must reach the agent as a closed reason code, so it
// can tell the user what went wrong. The code is also the telemetry field,
// and both are content-free: never a provider body, a path or an errno.
describe('voice handler — failure codes', () => {
  test('a coded failure is recorded as error_code and set on the attachment', async () => {
    const m = makeDeps({
      transcribeVoice: async () => { throw Object.assign(new Error('openai transcription timed out'), { code: 'timeout' }); },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    const att = { id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' };
    await fn([att], { chatId: '1', msgId: 1, label: 't', botApi: {} });
    const failEvt = m.events.find((e) => e.kind === 'voice-transcribe-failed');
    assert.equal(failEvt.detail.error_code, 'timeout');
    assert.equal(att.transcriptionError, 'timeout');
  });

  test('http-<status> passes the allowlist', async () => {
    const m = makeDeps({
      transcribeVoice: async () => { throw Object.assign(new Error('x'), { code: 'http-503' }); },
    });
    const fn = createTranscribeVoiceAttachments(m.deps);
    const att = { id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' };
    await fn([att], { chatId: '1', msgId: 1, label: 't', botApi: {} });
    assert.equal(att.transcriptionError, 'http-503');
  });

  test('codes outside the closed set (errno, missing) become unknown', async () => {
    for (const thrown of [
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
      new Error('whisper.cpp exit 1'),
      Object.assign(new Error('x'), { code: 'http-<script>' }),
    ]) {
      const m = makeDeps({ transcribeVoice: async () => { throw thrown; } });
      const fn = createTranscribeVoiceAttachments(m.deps);
      const att = { id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg' };
      await fn([att], { chatId: '1', msgId: 1, label: 't', botApi: {} });
      assert.equal(att.transcriptionError, 'unknown');
      assert.equal(m.events.find((e) => e.kind === 'voice-transcribe-failed').detail.error_code, 'unknown');
    }
  });
});

// Boot replay, redelivery and the startup retry re-read the attachment row,
// which carries the stored transcript: it is reused rather than paid for again.
describe('voice handler — stored transcript reuse', () => {
  test('a stored transcript is reused on redelivery: no second paid call, no re-persist', async () => {
    let calls = 0;
    const m = makeDeps({ transcribeVoice: async () => { calls += 1; return { text: 'new', provider: 'openai' }; } });
    const fn = createTranscribeVoiceAttachments(m.deps);
    const att = {
      id: 1, kind: 'voice', path: '/tmp/x', name: 'x.ogg',
      transcription: { text: 'stored words', provider: 'openai' },
    };
    await fn([att], { chatId: '1', msgId: 1, label: 't', botApi: {} });
    assert.equal(calls, 0);
    assert.equal(att.transcription.text, 'stored words');
    assert.equal(m.events.filter((e) => e.kind === 'voice-transcribed').length, 0);
    assert.equal(m.dbCalls.length, 0);
  });

  test('an album with one reused and one new transcript stores the full text', async () => {
    const m = makeDeps({ transcribeVoice: async () => ({ text: 'second part', provider: 'openai' }) });
    const fn = createTranscribeVoiceAttachments(m.deps);
    await fn([
      { id: 1, kind: 'audio', path: '/tmp/a', name: 'a.ogg', transcription: { text: 'first part' } },
      { id: 2, kind: 'audio', path: '/tmp/b', name: 'b.ogg' },
    ], { chatId: '1', msgId: 1, label: 't', botApi: {} });
    const setMsg = m.dbCalls.find((c) => c[0] === 'setMessageText');
    assert.equal(setMsg[1].text, 'first part second part');
    assert.deepEqual(m.dbCalls.filter((c) => c[0] === 'setAttachmentTranscription').map((c) => c[1]), [2]);
  });
});
