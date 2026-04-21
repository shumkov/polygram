/**
 * Tests for lib/voice.js
 * Run: node --test tests/voice.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  transcribe, transcribeOpenAI,
  isVoiceAttachment, isLikelyAudioMime, normaliseLanguage,
  OPENAI_COST_PER_MINUTE_USD,
} = require('../lib/voice');

let tmpDir, audioFile;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  audioFile = path.join(tmpDir, 'sample.ogg');
  fs.writeFileSync(audioFile, Buffer.from('fake ogg bytes'));
}

function teardown() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

describe('helpers', () => {
  test('isVoiceAttachment accepts kind voice/audio only', () => {
    assert.equal(isVoiceAttachment({ kind: 'voice' }), true);
    assert.equal(isVoiceAttachment({ kind: 'audio' }), true);
    assert.equal(isVoiceAttachment({ kind: 'photo' }), false);
    assert.equal(isVoiceAttachment({ kind: 'document' }), false);
    assert.equal(isVoiceAttachment(null), false);
    assert.equal(isVoiceAttachment(undefined), false);
  });

  test('isLikelyAudioMime sniffs audio/* prefix', () => {
    assert.equal(isLikelyAudioMime('audio/ogg'), true);
    assert.equal(isLikelyAudioMime('audio/mpeg'), true);
    assert.equal(isLikelyAudioMime('video/mp4'), false);
    assert.equal(isLikelyAudioMime(''), false);
    assert.equal(isLikelyAudioMime(null), false);
  });

  test('normaliseLanguage drops "auto" and empties', () => {
    assert.equal(normaliseLanguage(null), null);
    assert.equal(normaliseLanguage('auto'), null);
    assert.equal(normaliseLanguage(''), null);
    assert.equal(normaliseLanguage('EN'), 'en');
    assert.equal(normaliseLanguage('thai-extra-junk'), 'thai-');
  });
});

describe('transcribe file guards', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('rejects missing file', async () => {
    await assert.rejects(
      () => transcribe(path.join(tmpDir, 'nope.ogg'), { provider: 'openai' }),
      /file missing/,
    );
  });

  test('rejects empty file', async () => {
    const p = path.join(tmpDir, 'empty.ogg');
    fs.writeFileSync(p, Buffer.alloc(0));
    await assert.rejects(
      () => transcribe(p, { provider: 'openai' }),
      /file empty/,
    );
  });

  test('rejects likely-too-long file when duration cap is configured', async () => {
    const p = path.join(tmpDir, 'long.ogg');
    fs.writeFileSync(p, Buffer.alloc(2_000_000));
    await assert.rejects(
      () => transcribe(p, {
        provider: 'openai',
        maxDurationSec: 60,
        maxDurationBytesPerSec: 16_000,  // 16 KB/s → estimate 125s
      }),
      /exceeds max duration/,
    );
  });

  test('rejects unknown provider', async () => {
    await assert.rejects(
      () => transcribe(audioFile, { provider: 'fancy' }),
      /unknown voice provider/,
    );
  });
});

describe('transcribeOpenAI', () => {
  let origFetch, origKey;

  beforeEach(() => {
    setup();
    origFetch = global.fetch;
    origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    teardown();
    global.fetch = origFetch;
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  test('returns text, language, duration, cost', async () => {
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { text: ' hello world  ', language: 'en', duration: 12.5 };
      },
    });
    const res = await transcribeOpenAI(audioFile, {});
    assert.equal(res.text, 'hello world');
    assert.equal(res.language, 'en');
    assert.equal(res.duration_sec, 12.5);
    assert.equal(res.provider, 'openai');
    // cost = 12.5s / 60 * 0.006
    assert.ok(Math.abs(res.cost_usd - (12.5 / 60) * OPENAI_COST_PER_MINUTE_USD) < 1e-9);
  });

  test('throws when API key not set', async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(
      () => transcribeOpenAI(audioFile, {}),
      /OPENAI_API_KEY env not set/,
    );
  });

  test('throws on non-ok response', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      async text() { return 'server angry'; },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, {}),
      /whisper openai 503/,
    );
  });

  test('respects alternate apiKeyEnv', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.WHISPER_KEY = 'sk-alt';
    global.fetch = async (_url, opts) => {
      assert.equal(opts.headers.Authorization, 'Bearer sk-alt');
      return { ok: true, async json() { return { text: 'ok', duration: 1 }; } };
    };
    try {
      const res = await transcribeOpenAI(audioFile, { apiKeyEnv: 'WHISPER_KEY' });
      assert.equal(res.text, 'ok');
    } finally {
      delete process.env.WHISPER_KEY;
    }
  });

  test('forwards language hint when not auto', async () => {
    let sentForm;
    global.fetch = async (_url, opts) => {
      sentForm = opts.body;
      return { ok: true, async json() { return { text: 'x', duration: 1 }; } };
    };
    await transcribeOpenAI(audioFile, { language: 'th' });
    assert.equal(sentForm.get('language'), 'th');
  });

  test('does not forward language when auto', async () => {
    let sentForm;
    global.fetch = async (_url, opts) => {
      sentForm = opts.body;
      return { ok: true, async json() { return { text: 'x', duration: 1 }; } };
    };
    await transcribeOpenAI(audioFile, { language: 'auto' });
    assert.equal(sentForm.has('language'), false);
  });
});
