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
    assert.match(failEvt.detail.error, /whisper down/);
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
