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
} = require('../lib/telegram/voice');

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

  test('throws not-configured when API key not set', async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(
      () => transcribeOpenAI(audioFile, {}),
      (err) => err.code === 'not-configured' && /OPENAI_API_KEY/.test(err.message),
    );
  });

  test('non-ok response throws http-<status> without echoing the body', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      async text() { return 'server angry'; },
      async json() { return { error: { message: 'server angry', code: 'overloaded' } }; },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, {}),
      (err) => err.code === 'http-503' && !/server angry/.test(err.message),
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

  test('forwards language hint when not auto (whisper-1 takes the singular field)', async () => {
    let sentForm;
    global.fetch = async (_url, opts) => {
      sentForm = opts.body;
      return { ok: true, async json() { return { text: 'x', duration: 1 }; } };
    };
    await transcribeOpenAI(audioFile, { model: 'whisper-1', language: 'th' });
    assert.equal(sentForm.get('language'), 'th');
    assert.equal(sentForm.has('languages[]'), false);
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

// gpt-transcribe is OpenAI's current transcription model; whisper-1 and the
// gpt-4o transcribe models shut down on 2027-02-26. Each test below pins a
// production property of the bot's voice path: what is sent, how the answer
// is read, and that every failure surfaces as a closed code the agent can
// explain to the user instead of "I can't listen to voice messages".
describe('transcribeOpenAI — gpt-transcribe production path', () => {
  let origFetch, origKey, keyFile;

  beforeEach(() => {
    setup();
    origFetch = global.fetch;
    origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    keyFile = path.join(tmpDir, 'openai.key');
    fs.writeFileSync(keyFile, 'sk-proj-file-key\n', { mode: 0o600 });
  });

  afterEach(() => {
    teardown();
    global.fetch = origFetch;
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  function okFetch(body, capture = {}) {
    return async (url, opts) => {
      capture.url = url;
      capture.opts = opts;
      return { ok: true, status: 200, async json() { return body; } };
    };
  }

  test('defaults to gpt-transcribe and never sends response_format', async () => {
    const cap = {};
    global.fetch = okFetch({ text: 'привет' }, cap);
    await transcribeOpenAI(audioFile, { apiKeyFile: keyFile });
    assert.equal(cap.opts.body.get('model'), 'gpt-transcribe');
    assert.equal(cap.opts.body.has('response_format'), false);
  });

  test('gpt-transcribe gets languages[] with a two-letter code, never the singular field', async () => {
    const cap = {};
    global.fetch = okFetch({ text: 'x' }, cap);
    await transcribeOpenAI(audioFile, { apiKeyFile: keyFile, language: 'pt-BR' });
    assert.deepEqual(cap.opts.body.getAll('languages[]'), ['pt']);
    assert.equal(cap.opts.body.has('language'), false);
  });

  test('reads language from languages[0].code and duration from usage.seconds', async () => {
    global.fetch = okFetch({
      text: ' привет мир ',
      languages: [{ code: 'ru' }],
      usage: { type: 'duration', seconds: 30 },
    });
    const r = await transcribeOpenAI(audioFile, { apiKeyFile: keyFile });
    assert.equal(r.text, 'привет мир');
    assert.equal(r.language, 'ru');
    assert.equal(r.duration_sec, 30);
    assert.ok(Math.abs(r.cost_usd - 0.5 * 0.0045) < 1e-9);
  });

  test('cost is omitted, not guessed as zero, when the duration is unknown', async () => {
    global.fetch = okFetch({ text: 'x', usage: { type: 'tokens', input_tokens: 10 } });
    const r = await transcribeOpenAI(audioFile, { apiKeyFile: keyFile });
    assert.equal(r.duration_sec, 0);
    assert.equal(r.cost_usd, undefined);
  });

  test('apiKeyFile is used and wins over the environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const cap = {};
    global.fetch = okFetch({ text: 'x' }, cap);
    await transcribeOpenAI(audioFile, { apiKeyFile: keyFile });
    assert.equal(cap.opts.headers.Authorization, 'Bearer sk-proj-file-key');
  });

  test('missing apiKeyFile is not-configured and never falls back to the environment', async () => {
    // A stray env key may be unrestricted and uncapped: using it silently
    // would bypass the dedicated project's budget.
    process.env.OPENAI_API_KEY = 'sk-env-key';
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, async json() { return { text: 'x' }; } }; };
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: path.join(tmpDir, 'absent.key') }),
      (err) => err.code === 'not-configured',
    );
    assert.equal(called, false);
  });

  test('a key file that is not one printable token is not-configured and the key is not echoed', async () => {
    // undici echoes an invalid header value in its error message; validating
    // first keeps a mangled key out of the logs the agent can read.
    fs.writeFileSync(keyFile, 'sk-proj-secretvalue\n# second line\n');
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, async json() { return { text: 'x' }; } }; };
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'not-configured' && !err.message.includes('secretvalue'),
    );
    assert.equal(called, false);
  });

  test('429 insufficient_quota is quota-exhausted, distinct from a transient 429', async () => {
    global.fetch = async () => ({
      ok: false, status: 429,
      async json() { return { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }; },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'quota-exhausted',
    );
    global.fetch = async () => ({
      ok: false, status: 429,
      async json() { return { error: { code: 'rate_limit_exceeded' } }; },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'http-429',
    );
  });

  test('a hung request is aborted at timeoutMs and reported as timeout', async () => {
    global.fetch = (_url, opts) => new Promise((_resolve, reject) => {
      assert.ok(opts.signal, 'fetch receives an abort signal');
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile, timeoutMs: 30 }),
      (err) => err.code === 'timeout',
    );
  });

  test('a fetch TypeError with a cause is network', async () => {
    global.fetch = async () => {
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND' });
      throw e;
    };
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'network',
    );
  });

  test('a 200 that is not JSON, or has no text, is bad-response', async () => {
    global.fetch = async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token <'); } });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'bad-response',
    );
    global.fetch = okFetch({ languages: [] });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'bad-response',
    );
  });

  test('a timeout while reading the body is still timeout', async () => {
    global.fetch = async () => ({
      ok: true, status: 200,
      async json() { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'timeout',
    );
  });

  test('a socket reset while reading the body is network, not bad-response', async () => {
    global.fetch = async () => ({
      ok: true, status: 200,
      async json() { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'network',
    );
  });

  test('a key from the environment is validated too, and never echoed', async () => {
    process.env.OPENAI_API_KEY = 'sk-envsecret\nX';
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, async json() { return { text: 'x' }; } }; };
    await assert.rejects(
      () => transcribeOpenAI(audioFile, {}),
      (err) => err.code === 'not-configured' && !err.message.includes('envsecret'),
    );
    assert.equal(called, false);
  });

  test('a provider error code that is not a plain token is not interpolated', async () => {
    global.fetch = async () => ({
      ok: false, status: 400,
      async json() { return { error: { code: 'bad <thing> with spaces' } }; },
    });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'http-400' && !err.message.includes('thing'),
    );
  });

  test('a language hint that is not an ISO-639-1 code is not sent to gpt-transcribe', async () => {
    // Truncating "fil" to "fi" or "Auto" to "au" would silently bias the
    // model toward the wrong language; auto-detect is the safer fallback.
    for (const language of ['fil', 'german', 'Auto']) {
      const cap = {};
      global.fetch = okFetch({ text: 'x' }, cap);
      await transcribeOpenAI(audioFile, { apiKeyFile: keyFile, language });
      assert.equal(cap.opts.body.has('languages[]'), false, language);
      assert.equal(cap.opts.body.has('language'), false, language);
    }
  });

  test('blank text (silence, music) is empty', async () => {
    global.fetch = okFetch({ text: '   ' });
    await assert.rejects(
      () => transcribeOpenAI(audioFile, { apiKeyFile: keyFile }),
      (err) => err.code === 'empty',
    );
  });
});

describe('transcribe — size cap', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('a file over maxFileBytes is too-large before the key or the file is read', async () => {
    // The local Bot API server accepts files far above OpenAI's 25 MB limit;
    // uploading one only to get a 413 wastes memory and the timeout budget.
    const p = path.join(tmpDir, 'big.ogg');
    fs.writeFileSync(p, Buffer.alloc(2048));
    const origFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, async json() { return { text: 'x' }; } }; };
    try {
      await assert.rejects(
        () => transcribe(p, {
          provider: 'openai', maxFileBytes: 1024,
          apiKeyFile: path.join(tmpDir, 'absent.key'),
        }),
        (err) => err.code === 'too-large',
      );
    } finally {
      global.fetch = origFetch;
    }
    assert.equal(called, false);
  });

  test('by default a file just over OpenAI\'s 25 MB limit is too-large', async () => {
    const p = path.join(tmpDir, 'sparse.ogg');
    fs.writeFileSync(p, 'x');
    fs.truncateSync(p, 25 * 1024 * 1024 + 1); // sparse: no 25 MB actually written
    await assert.rejects(
      () => transcribe(p, { provider: 'openai', apiKeyFile: path.join(tmpDir, 'absent.key') }),
      (err) => err.code === 'too-large',
    );
  });
});
