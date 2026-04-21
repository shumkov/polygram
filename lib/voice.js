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
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OPENAI_COST_PER_MINUTE_USD = 0.006;

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

async function transcribeOpenAI(filePath, opts) {
  const apiKey = process.env[opts.apiKeyEnv || 'OPENAI_API_KEY'];
  if (!apiKey) throw new Error(`OPENAI_API_KEY env not set (or ${opts.apiKeyEnv})`);

  // Node 18+ has native FormData + fetch. Keep it dep-free.
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('model', opts.model || 'whisper-1');
  form.append('response_format', 'verbose_json');
  const lang = normaliseLanguage(opts.language);
  if (lang) form.append('language', lang);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whisper openai ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const duration_sec = typeof j.duration === 'number' ? j.duration : 0;
  return {
    text: (j.text || '').trim(),
    language: j.language || null,
    duration_sec,
    cost_usd: (duration_sec / 60) * OPENAI_COST_PER_MINUTE_USD,
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
};
