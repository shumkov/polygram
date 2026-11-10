/**
 * Voice-to-code transcription.
 *
 * `transcribe(filePath, opts)` turns a voice/audio file into text. Two
 * backends:
 *   - openai: POST the file to api.openai.com/v1/audio/transcriptions
 *   - local:  shell out to whisper.cpp (`-otxt`) and read the .txt sibling
 *
 * The backend is injected so tests can stub it without touching the network.
 * Returns `{ text, language, duration_sec, cost_usd, provider }`.
 *
 * OpenAI failures throw an Error whose `code` is one of a closed set
 * (`not-configured`, `too-large`, `timeout`, `quota-exhausted`,
 * `http-<status>`, `network`, `bad-response`, `empty`) so the caller can tell
 * the agent and the telemetry what went wrong without quoting provider text.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OPENAI_DEFAULT_MODEL = 'gpt-transcribe';
// gpt-transcribe list price, billed by audio duration. Telemetry only: the
// OpenAI dashboard is the record of actual spend.
const OPENAI_COST_PER_MINUTE_USD = 0.0045;
const OPENAI_TIMEOUT_MS = 120_000;
// OpenAI rejects uploads above 25 MB, and the local Bot API server lets bots
// accept far larger files, so anything bigger is refused before upload.
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

function voiceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isVoiceAttachment(att) {
  if (!att) return false;
  if (att.kind === 'voice') return true;
  if (att.kind === 'audio') return true;
  return false;
}

function isLikelyAudioMime(mime) {
  return typeof mime === 'string' && mime.startsWith('audio/');
}

/**
 * Normalize language hint. "auto" is dropped (let Whisper auto-detect).
 */
function normaliseLanguage(lang) {
  if (!lang || lang === 'auto') return null;
  return String(lang).slice(0, 5).toLowerCase();
}

/**
 * Resolve the API key. A configured `apiKeyFile` is authoritative: if it is
 * missing or malformed there is no fallback to the environment, where a
 * stray, unrestricted key would bypass the dedicated project's budget. The
 * key must be one printable token, because undici echoes an invalid header
 * value in its error message and that message reaches the logs.
 */
const KEY_SHAPE = /^[\x21-\x7E]+$/;

function readOpenAIKey(opts) {
  if (opts.apiKeyFile) {
    let raw;
    try { raw = fs.readFileSync(opts.apiKeyFile, 'utf8'); } catch (err) {
      throw voiceError('not-configured', `openai key file unreadable (${err.code || 'error'})`);
    }
    const key = raw.trim();
    if (!KEY_SHAPE.test(key)) {
      throw voiceError('not-configured', 'openai key file must hold exactly one printable token');
    }
    return key;
  }
  const envName = opts.apiKeyEnv || 'OPENAI_API_KEY';
  const key = (process.env[envName] || '').trim();
  if (!key) throw voiceError('not-configured', `OPENAI_API_KEY env not set (or ${envName})`);
  if (!KEY_SHAPE.test(key)) throw voiceError('not-configured', `${envName} must hold exactly one printable token`);
  return key;
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

async function transcribeOpenAI(filePath, opts) {
  const size = fs.statSync(filePath).size;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (size > maxFileBytes) {
    throw voiceError('too-large', `file too large to transcribe (${size} > ${maxFileBytes} bytes)`);
  }
  const apiKey = readOpenAIKey(opts);
  const model = opts.model || OPENAI_DEFAULT_MODEL;

  // Node 18+ has native FormData + fetch. Keep it dep-free.
  // response_format is left at its default (json): it is the only format the
  // current models accept, and verbose_json exists only for whisper-1.
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('model', model);
  const lang = normaliseLanguage(opts.language);
  if (lang) {
    // gpt-transcribe takes `languages[]` (ISO-639-1) in place of `language`
    // and rejects a request that sends the wrong one or both. A hint that is
    // not a two-letter code is dropped: truncating "fil" to "fi" would bias
    // the model toward the wrong language, while auto-detect stays correct.
    if (model.startsWith('gpt-transcribe')) {
      if (/^[a-z]{2}(?:-|$)/.test(lang)) form.append('languages[]', lang.slice(0, 2));
    } else {
      form.append('language', lang);
    }
  }

  // The signal also aborts reading the response body, so a stalled body
  // cannot hold the turn past the timeout either.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? OPENAI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (err) {
    if (isTimeout(err)) throw voiceError('timeout', 'openai transcription timed out');
    if (err instanceof TypeError && err.cause) {
      throw voiceError('network', `openai transcription network error (${err.cause.code || 'error'})`);
    }
    throw err;
  }
  if (!res.ok) {
    // Only OpenAI's error code is kept; the body's message is not logged.
    const errCode = await res.json().then((b) => b?.error?.code, () => null)
      .then((c) => (typeof c === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(c) ? c : null));
    if (res.status === 429 && errCode === 'insufficient_quota') {
      throw voiceError('quota-exhausted', 'openai transcription quota exhausted');
    }
    throw voiceError(`http-${res.status}`, `openai transcription http ${res.status} ${errCode || ''}`.trim());
  }
  let j;
  try { j = await res.json(); } catch (err) {
    if (isTimeout(err)) throw voiceError('timeout', 'openai transcription timed out');
    if (err instanceof TypeError && err.cause) {
      throw voiceError('network', `openai transcription network error (${err.cause.code || 'error'})`);
    }
    throw voiceError('bad-response', 'openai transcription returned non-JSON');
  }
  if (typeof j?.text !== 'string') throw voiceError('bad-response', 'openai transcription response has no text');
  const text = j.text.trim();
  if (!text) throw voiceError('empty', 'openai transcription is empty');

  const duration_sec = typeof j.duration === 'number' ? j.duration
    : (typeof j.usage?.seconds === 'number' ? j.usage.seconds : 0);
  return {
    text,
    language: j.language || j.languages?.[0]?.code || null,
    duration_sec,
    cost_usd: duration_sec ? (duration_sec / 60) * OPENAI_COST_PER_MINUTE_USD : undefined,
    provider: 'openai',
  };
}

async function transcribeLocal(filePath, opts) {
  const binary = opts.binary;
  const model = opts.model;
  if (!binary || !fs.existsSync(binary)) {
    throw new Error(`whisper.cpp binary not found: ${binary}`);
  }
  if (!model || !fs.existsSync(model)) {
    throw new Error(`whisper.cpp model not found: ${model}`);
  }

  // whisper.cpp writes <input>.txt alongside the input with -otxt.
  const args = ['-m', model, '-f', filePath, '-otxt', '-nt'];
  const lang = normaliseLanguage(opts.language);
  if (lang) args.push('-l', lang);

  return await new Promise((resolve, reject) => {
    let stderr = '';
    const p = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.once('error', reject);
    p.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`whisper.cpp exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      const txtPath = `${filePath}.txt`;
      let text = '';
      try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch {}
      // Derive duration from stderr (whisper.cpp prints total duration).
      const dMatch = stderr.match(/total duration\s*=\s*([\d.]+)/i);
      const duration_sec = dMatch ? parseFloat(dMatch[1]) : 0;
      const lMatch = stderr.match(/detected language:\s*(\w+)/i);
      resolve({
        text,
        language: lMatch ? lMatch[1] : null,
        duration_sec,
        cost_usd: 0,
        provider: 'local',
      });
    });
  });
}

/**
 * Main entrypoint. `opts.provider` picks the backend ('openai' | 'local').
 * `opts.fetchFn` / `opts.spawnFn` allow test injection.
 */
async function transcribe(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`file missing: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.size) throw new Error(`file empty: ${filePath}`);
  if (opts.maxDurationSec && opts.maxDurationBytesPerSec) {
    const estSec = stat.size / opts.maxDurationBytesPerSec;
    if (estSec > opts.maxDurationSec) {
      throw new Error(
        `file likely exceeds max duration (${estSec.toFixed(0)}s > ${opts.maxDurationSec}s)`,
      );
    }
  }
  const provider = opts.provider || 'openai';
  if (provider === 'openai') return transcribeOpenAI(filePath, opts);
  if (provider === 'local') return transcribeLocal(filePath, opts);
  throw new Error(`unknown voice provider: ${provider}`);
}

module.exports = {
  transcribe,
  transcribeOpenAI,
  transcribeLocal,
  isVoiceAttachment,
  isLikelyAudioMime,
  normaliseLanguage,
  OPENAI_COST_PER_MINUTE_USD,
  OPENAI_DEFAULT_MODEL,
};
