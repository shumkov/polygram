#!/usr/bin/env node
/**
 * Telegram Bridge for Claude Code — Persistent Sessions
 *
 * Each chat gets a persistent claude process (stream-json multi-turn).
 * Process stays warm: no cold start, full prompt caching.
 *
 * Architecture:
 *   Telegram (grammy long-poll) → polygram receives message
 *   → looks up per-chat config (model, effort, agent, cwd)
 *   → sends to persistent claude process via stdin (stream-json)
 *   → reads response from stdout (stream-json)
 *   → sends reply to Telegram
 *   → writes every in/out message to bridge.db (Phase 1: parallel write)
 *
 * Chat commands: /model <model>, /effort <level>, /config
 */

const { Bot } = require('grammy');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dbClient = require('./lib/db');
const { migrateJsonToDb, getClaudeSessionId } = require('./lib/sessions');
const { buildPrompt } = require('./lib/prompt');
const { filterAttachments, MAX_FILE_BYTES } = require('./lib/attachments');
const { ProcessManager } = require('./lib/process-manager');
const { createSender } = require('./lib/telegram');
const { createAsyncLock } = require('./lib/async-lock');
const { sweepInbox } = require('./lib/inbox');
const { parseBotArg, parseDbArg, filterConfigToBot } = require('./lib/config-scope');
const { createStore: createPairingsStore, parseTtl: parsePairingTtl } = require('./lib/pairings');
const { transcribe: transcribeVoice, isVoiceAttachment } = require('./lib/voice');
const { createStreamer } = require('./lib/stream-reply');
const { isAbortRequest } = require('./lib/abort-detector');
const { startTyping } = require('./lib/typing-indicator');
const { createReactionManager, classifyToolName } = require('./lib/status-reactions');
const { createMediaGroupBuffer } = require('./lib/media-group-buffer');
const {
  createStore: createApprovalsStore,
  matchesAnyPattern: matchesApprovalPattern,
  tokensEqual: approvalTokensEqual,
  DEFAULT_TIMEOUT_MS: APPROVAL_DEFAULT_TIMEOUT_MS,
} = require('./lib/approvals');
const ipcServer = require('./lib/ipc-server');

// ─── Config ──────────────────────────────────────────────────────────
//
// User data (config, per-bot DBs, inbox) resolves from the cwd the operator
// runs polygram in. Package resources (migrations/) stay under __dirname.
// This makes `npm install -g polygram` + `cd ~/my-data && polygram --bot X`
// work without symlinks or POLYGRAM_DIR gymnastics.

const DATA_DIR = process.cwd();
const CONFIG_PATH = process.env.POLYGRAM_CONFIG || path.join(DATA_DIR, 'config.json');
const SESSIONS_JSON_PATH = path.join(DATA_DIR, 'sessions.json'); // legacy, imported once on boot
const DB_DIR = DATA_DIR;
// DB_PATH is resolved in main() from --db or <bot>.db default.
let DB_PATH = null;
const STICKERS_PATH = process.env.POLYGRAM_STICKERS
  || path.join(DATA_DIR, 'stickers.json');
const INBOX_DIR = process.env.POLYGRAM_INBOX || path.join(DATA_DIR, 'inbox');
const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || path.join(process.env.HOME || '', '.npm-global/bin/claude');
const CHILD_HOME = process.env.POLYGRAM_CHILD_HOME || process.env.HOME || '';
const TG_MAX_LEN = 4096;
const DEFAULT_MAX_WARM_PROCS = 10;

let stickerMap = {}; // name → file_id
let emojiToSticker = {}; // emoji → file_id

let config;
let db;
let tg; // unified sender, created after db opens
let pairings; // pairings store, created after db opens
let approvals; // approvals store, created after db opens
let approvalWaiters = new Map(); // approval_id -> { resolve, reject, timer }
let approvalSweepTimer = null;
let ipcCloser = null;
// BOT_NAME and bot are set once in main() after filterConfigToBot. Because
// this process serves exactly one bot (the --bot flag is required and
// single-valued), we keep them as plain module-level variables — not a map.
let BOT_NAME = null;  // string, frozen after boot
let bot = null;       // grammy Bot for BOT_NAME
// 0.4.8 note: streamer + reactor are per-turn, not per-session. They live
// on the pending's `context` object in the pm pendingQueue, keyed to the
// specific turn (not the session). The old per-session Maps were a bug
// for concurrent pendings — the second send() would overwrite the first's
// streamer reference before the first turn finished.

// Allowlist of env var names passed through to spawned Claude processes.
// Anything not listed here is dropped to prevent leaked secrets/ssh agents
// from being read by a prompt-injected child. Prefixes match any var whose
// name starts with that string.
const CHILD_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM',
  'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'PWD', 'SHLVL',
]);
const CHILD_ENV_PREFIXES = ['LC_', 'NODE_', 'CLAUDE_', 'ANTHROPIC_'];

function filterEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (CHILD_ENV_ALLOWLIST.has(k) || CHILD_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig() {
  // Atomic read-merge-write. In-memory `config` is FILTERED (only one bot +
  // its chats) because filterConfigToBot narrowed it at boot. Writing it
  // back directly would clobber every OTHER bot's section on disk. Instead:
  // read the current on-disk config fresh, apply our bot-scoped changes,
  // write the merged result. This is safe against parallel writers because
  // each bot only mutates entries inside its own scope (its bot entry + its
  // own chats), and we use rename for atomicity.
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Apply our bot's changes.
  if (BOT_NAME && config.bots?.[BOT_NAME]) {
    onDisk.bots = onDisk.bots || {};
    onDisk.bots[BOT_NAME] = config.bots[BOT_NAME];
  }
  // Apply chat changes — only chats the filter left in our memory belong
  // to this bot; overwrite those keys, leave the rest of onDisk.chats alone.
  if (config.chats) {
    onDisk.chats = onDisk.chats || {};
    for (const [chatId, chat] of Object.entries(config.chats)) {
      onDisk.chats[chatId] = chat;
    }
  }
  // Top-level non-bot-scoped fields (defaults, maxWarmProcesses, etc.)
  // reflect ops-wide policy. Only copy if our in-memory value is newer —
  // but detecting that is hard; simplest safe rule is: don't touch them
  // from a bot-scoped process. Leave onDisk's values as-is.

  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function loadStickers() {
  try {
    const data = JSON.parse(fs.readFileSync(STICKERS_PATH, 'utf8'));
    for (const [name, s] of Object.entries(data.stickers || {})) {
      stickerMap[name] = s.file_id;
      if (s.emoji) emojiToSticker[s.emoji] = s.file_id;
    }
    console.log(`Stickers: ${Object.keys(stickerMap).join(', ')}`);
  } catch { console.log('No sticker map found'); }
}

// Quick shape check before we start hashing/DB-writing on an update.
// Telegram updates are user-controlled; a hostile or malformed payload
// without chat.id / message_id would throw deep in recordInbound.
function isWellFormedMessage(msg) {
  return !!(msg
    && msg.chat
    && (typeof msg.chat.id === 'number' || typeof msg.chat.id === 'bigint')
    && typeof msg.message_id === 'number');
}

// ─── Session key — moved to lib/session-key.js so tests can import it. ─
const { getSessionKey, getChatIdFromKey } = require('./lib/session-key');

function getTopicName(chatConfig, threadId) {
  if (!threadId) return null;
  return chatConfig.topics?.[threadId] || threadId;
}

function getSessionLabel(chatConfig, threadId) {
  const topic = getTopicName(chatConfig, threadId);
  return topic ? `${chatConfig.name}/${topic}` : chatConfig.name;
}

// ─── Session context ─────────────────────────────────────────────────

async function readSessionContext(sessionKey, cwd) {
  const sessionFile = path.join(cwd, 'sessions', `${sessionKey}.md`);
  // Async read: sessions dir may live on iCloud / slow FS where sync reads
  // stall the event loop and starve grammy's polling.
  try {
    const data = await fs.promises.readFile(sessionFile, 'utf8');
    return data.trim();
  } catch { return ''; }
}

// ─── DB writes (Phase 1 — best-effort, never throws) ────────────────

function dbWrite(fn, context) {
  if (!db) return;
  try { fn(); } catch (err) {
    console.error(`[db] ${context} failed: ${err.message}`);
  }
}

function recordInbound(msg) {
  const chatId = msg.chat.id.toString();
  const threadId = msg.message_thread_id?.toString() || null;
  const user = msg.from?.first_name || msg.from?.username || null;
  const attachments = extractAttachments(msg);
  const chatConfig = config.chats[chatId];

  dbWrite(() => db.insertMessage({
    chat_id: chatId,
    thread_id: threadId,
    msg_id: msg.message_id,
    user,
    user_id: msg.from?.id || null,
    text: msg.text || msg.caption || '',
    reply_to_id: msg.reply_to_message?.message_id || null,
    direction: 'in',
    source: 'polygram',
    bot_name: BOT_NAME,
    attachments_json: attachments.length ? JSON.stringify(attachments) : null,
    model: chatConfig?.model || null,
    effort: chatConfig?.effort || null,
    ts: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
  }), `insert inbound ${chatId}/${msg.message_id}`);
}


// ─── Attachment download ────────────────────────────────────────────

function sanitizeFilename(name) {
  if (!name) return 'file';
  return name.replace(/[\/\\:\0]/g, '_').slice(0, 120);
}

function extractAttachments(msg) {
  // Media-group bundling path: when we synthesised a single message from
  // several siblings sharing a media_group_id, the merged attachment list
  // was pre-computed in `_mergedAttachments`. Return it directly instead
  // of running the per-field extraction against the primary message.
  if (Array.isArray(msg._mergedAttachments)) return msg._mergedAttachments;

  const items = [];
  if (msg.document) {
    const d = msg.document;
    items.push({
      file_id: d.file_id,
      file_unique_id: d.file_unique_id,
      name: d.file_name || `document-${msg.message_id}`,
      mime_type: d.mime_type || 'application/octet-stream',
      size: d.file_size || 0,
      kind: 'document',
    });
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    items.push({
      file_id: largest.file_id,
      file_unique_id: largest.file_unique_id,
      name: `photo-${msg.message_id}.jpg`,
      mime_type: 'image/jpeg',
      size: largest.file_size || 0,
      kind: 'photo',
    });
  }
  if (msg.voice) {
    items.push({
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      name: `voice-${msg.message_id}.ogg`,
      mime_type: msg.voice.mime_type || 'audio/ogg',
      size: msg.voice.file_size || 0,
      kind: 'voice',
    });
  }
  if (msg.audio) {
    const a = msg.audio;
    items.push({
      file_id: a.file_id,
      file_unique_id: a.file_unique_id,
      name: a.file_name || `audio-${msg.message_id}.mp3`,
      mime_type: a.mime_type || 'audio/mpeg',
      size: a.file_size || 0,
      kind: 'audio',
    });
  }
  if (msg.video) {
    const v = msg.video;
    items.push({
      file_id: v.file_id,
      file_unique_id: v.file_unique_id,
      name: v.file_name || `video-${msg.message_id}.mp4`,
      mime_type: v.mime_type || 'video/mp4',
      size: v.file_size || 0,
      kind: 'video',
    });
  }
  return items;
}

async function transcribeVoiceAttachments(downloaded, { chatId, msgId, label, botApi, threadId }) {
  const voiceCfg = config.bot?.voice || config.voice;
  if (!voiceCfg?.enabled) return;
  const provider = voiceCfg.provider || 'openai';
  const providerCfg = voiceCfg[provider] || {};
  const targets = downloaded.filter((a) => isVoiceAttachment(a) && a.path);
  if (!targets.length) return;

  // Acknowledge receipt with a reaction so the user knows we heard them.
  // Cheap, robust (no state), and survives transcription failure.
  const ack = voiceCfg.ackReaction || '👂';
  if (ack && botApi) {
    tg(botApi, 'setMessageReaction', {
      chat_id: chatId, message_id: msgId,
      reaction: [{ type: 'emoji', emoji: ack }],
    }, { source: 'voice-ack', botName: BOT_NAME }).catch((err) => {
      console.error(`[${label}] voice ack reaction failed: ${err.message}`);
    });
  }

  await Promise.all(targets.map(async (a) => {
    try {
      const opts = {
        provider,
        ...providerCfg,
        language: voiceCfg.language || 'auto',
        maxDurationSec: voiceCfg.maxDurationSec,
        maxDurationBytesPerSec: voiceCfg.maxDurationBytesPerSec,
      };
      const r = await transcribeVoice(a.path, opts);
      a.transcription = r;
      console.log(`[${label}] transcribed ${a.kind} (${r.duration_sec?.toFixed?.(1) || '?'}s, ${r.text.length} chars)`);
      dbWrite(() => db.logEvent('voice-transcribed', {
        chat_id: chatId, msg_id: msgId,
        provider: r.provider, language: r.language,
        duration_sec: r.duration_sec, chars: r.text.length,
        cost_usd: r.cost_usd,
      }), 'log voice-transcribed');
    } catch (err) {
      console.error(`[${label}] transcribe failed for ${a.name}: ${err.message}`);
      dbWrite(() => db.logEvent('voice-transcribe-failed', {
        chat_id: chatId, msg_id: msgId, name: a.name, error: err.message,
      }), 'log voice-transcribe-failed');
    }
  }));

  // Persist transcription into the inbound row so FTS search finds it.
  // Combine all successful transcriptions into `text` and mirror the
  // transcription data back into attachments_json.
  const successful = targets.filter((a) => a.transcription?.text);
  if (!successful.length) return;
  const combinedText = successful.map((a) => a.transcription.text).join(' ').trim();
  const attJson = JSON.stringify(downloaded.map((a) => ({
    kind: a.kind, name: a.name, mime_type: a.mime_type, size: a.size,
    path: a.path, file_unique_id: a.file_unique_id,
    transcription: a.transcription || null,
  })));
  dbWrite(() => db.setMessageText({
    chat_id: chatId, msg_id: msgId,
    text: combinedText, attachments_json: attJson,
  }), 'persist voice transcription');
}

async function downloadAttachments(bot, token, chatId, msg, attachments) {
  if (!attachments.length) return [];
  const chatDir = path.join(INBOX_DIR, String(chatId));
  fs.mkdirSync(chatDir, { recursive: true });

  const results = [];
  for (const att of attachments) {
    try {
      const fileInfo = await bot.api.getFile(att.file_id);
      if (!fileInfo?.file_path) throw new Error('no file_path from getFile');
      const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Defense in depth: re-check size at download time. Telegram can
      // omit file_size from the Message, or its value may not match what
      // the CDN actually serves. Trust Content-Length and fall back to
      // buffering with a ceiling.
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      if (cl > MAX_FILE_BYTES) {
        throw new Error(`content-length ${cl} exceeds per-file cap ${MAX_FILE_BYTES}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) {
        throw new Error(`body ${buf.length} bytes exceeds per-file cap ${MAX_FILE_BYTES}`);
      }
      const safeName = sanitizeFilename(att.name);
      // Embed file_unique_id so two attachments with the same msg_id+name
      // (album, resend) can't silently overwrite each other. Telegram
      // guarantees file_unique_id is stable and globally unique per file.
      const uniq = att.file_unique_id ? `-${att.file_unique_id}` : '';
      const localName = `${msg.message_id}${uniq}-${safeName}`;
      const localPath = path.join(chatDir, localName);
      // Atomic write: create a temp with the unique PID+timestamp suffix,
      // fill it, then rename to the canonical name. A crash mid-write leaves
      // a `.tmp.*` file (swept later) rather than a truncated canonical file
      // that the EEXIST dedup branch would happily serve on next request.
      if (fs.existsSync(localPath)) {
        console.log(`[attach] ${chatId} ← ${att.kind} ${safeName} (already on disk, reusing)`);
      } else {
        const tmpPath = `${localPath}.tmp.${process.pid}.${Date.now()}`;
        try {
          fs.writeFileSync(tmpPath, buf, { flag: 'wx' });
          fs.renameSync(tmpPath, localPath);
        } catch (e) {
          // Clean up stray tmp on any failure; if the rename fell through
          // because another process beat us, EEXIST on the target is fine.
          try { fs.unlinkSync(tmpPath); } catch {}
          if (e.code !== 'EEXIST') throw e;
          console.log(`[attach] ${chatId} ← ${att.kind} ${safeName} (race: already on disk)`);
        }
      }
      results.push({ ...att, path: localPath, size: att.size || buf.length });
      console.log(`[attach] ${chatId} ← ${att.kind} ${safeName} (${buf.length} bytes) → ${localPath}`);
    } catch (err) {
      console.error(`[attach] download failed for ${att.name}: ${err.message}`);
    }
  }
  return results;
}


// ─── Prompt formatting ──────────────────────────────────────────────

function resolveReplyTo(msg) {
  if (!msg.reply_to_message) return null;
  if (msg.reply_to_message.from || msg.reply_to_message.text || msg.reply_to_message.caption) {
    return { telegram: msg.reply_to_message };
  }
  const chatId = msg.chat.id.toString();
  const replyToId = msg.reply_to_message.message_id;
  const row = db ? db.getMessage(chatId, replyToId) : null;
  if (row) return { dbRow: row };
  return { replyToId };
}

function formatPrompt(msg, sessionCtx, attachments = []) {
  const chatId = msg.chat.id.toString();
  const threadId = msg.message_thread_id?.toString() || '';
  const chatConfig = config.chats[chatId];
  const topicName = threadId ? getTopicName(chatConfig, threadId) : '';
  return buildPrompt({
    msg,
    topicName,
    sessionCtx,
    attachments,
    replyTo: resolveReplyTo(msg),
  });
}

// ─── Persistent Claude Process per chat (LRU-bounded) ───────────────

let pm = null; // ProcessManager, created in main()

function spawnClaude(sessionKey, ctx) {
  const { chatConfig, existingSessionId, label, chatId } = ctx;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', chatConfig.model || config.defaults.model,
    '--effort', chatConfig.effort || config.defaults.effort,
    '--permission-mode', 'bypassPermissions',
    '--no-chrome',
  ];
  if (chatConfig.agent) args.push('--agent', chatConfig.agent);
  if (existingSessionId) args.push('--resume', existingSessionId);

  console.log(`[${label}] Spawning process (${chatConfig.model}/${chatConfig.effort})`);

  // Scrub env to an allowlist: under bypassPermissions a prompt-injected
  // child can exfiltrate any env var, so we pass only what Claude Code and
  // normal shell tools need. TELEGRAM_BOT_TOKEN is opt-in per bot via
  // config.bot.needsToken — partner bots go through polygram for every
  // outbound message and never need direct API access.
  const botConfig = config.bot || {};
  const childEnv = filterEnv(process.env);
  childEnv.HOME = CHILD_HOME;
  childEnv.CLAUDE_CHANNEL_BOT = BOT_NAME;
  // Approval hook integration: the hook runs as a child of Claude and reads
  // these to route its IPC. POLYGRAM_TURN_ID isn't set here (one session can
  // run many turns) — the hook treats it as optional.
  childEnv.POLYGRAM_BOT = BOT_NAME;
  childEnv.POLYGRAM_CHAT_ID = String(chatId || '');
  // Allow the PreToolUse approval hook to authenticate to the IPC socket.
  if (process.env.POLYGRAM_IPC_SECRET) childEnv.POLYGRAM_IPC_SECRET = process.env.POLYGRAM_IPC_SECRET;
  if (botConfig.needsToken) {
    childEnv.TELEGRAM_BOT_TOKEN = botConfig.token || '';
  }

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: chatConfig.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => {
    const m = d.toString().trim();
    if (m) console.error(`[${label}] stderr: ${m.slice(0, 200)}`);
  });
  return proc;
}

function buildSpawnContext(sessionKey) {
  const chatId = getChatIdFromKey(sessionKey);
  const chatConfig = config.chats[chatId];
  if (!chatConfig) return null;
  const threadId = sessionKey.includes(':') ? sessionKey.split(':')[1] : null;
  return {
    chatConfig,
    chatId,
    threadId: threadId || null,
    label: getSessionLabel(chatConfig, threadId),
    existingSessionId: getClaudeSessionId(db, sessionKey),
  };
}

async function getOrSpawnForChat(sessionKey) {
  const ctx = buildSpawnContext(sessionKey);
  if (!ctx) return null;
  return pm.getOrSpawn(sessionKey, ctx);
}

async function sendToProcess(sessionKey, prompt, context = {}) {
  const entry = await getOrSpawnForChat(sessionKey);
  if (!entry) throw new Error('No process for chat');
  const chatId = getChatIdFromKey(sessionKey);
  const chatConfig = config.chats[chatId];
  const timeoutMs = (chatConfig.timeout || config.defaults.timeout) * 1000;
  const maxTurnMs = (chatConfig.maxTurn || config.defaults?.maxTurn || 1800) * 1000;
  // Per-session stdin lock orders the write step, not the result-wait.
  // pm.send's Promise executor writes stdin synchronously, so as soon as
  // pm.send returns (not resolves — returns), the stdin write has
  // happened. We release the lock right after that and await the result
  // OUTSIDE the lock — otherwise one long turn would serialise the whole
  // session, which is what we're trying to escape.
  const release = await stdinLock.acquire(sessionKey);
  let resultPromise;
  try {
    resultPromise = pm.send(sessionKey, prompt, { timeoutMs, maxTurnMs, context });
  } finally {
    release();
  }
  return resultPromise;
}

// ─── Message dispatch ───────────────────────────────────────────────

// 0.4.8: per-session concurrent dispatch. No FIFO polygram-level queue any
// more — inbound messages immediately kick off handleMessage. Pre-work
// (attachment download, voice transcription) runs in parallel across
// messages; a per-session stdin lock (in handleMessage) orders the
// eventual pm.send writes so Claude reads user messages in arrival order
// and replies come out in the same order.
//
// We still track in-flight handleMessage calls per session so we can:
//   - emit a `queue-depth-warning` event if the count ever exceeds a
//     threshold (abnormal inbound rate, slow pre-work, stuck bot)
//   - (future) drain on shutdown if we want clean exit
const CONCURRENT_WARN_THRESHOLD = 20;
const inFlightHandlers = new Map(); // sessionKey → count

// Sessions the operator just /stop'd (or natural-language "стоп"). Keyed
// by sessionKey → timestamp of abort. ANY pending that rejects within
// ABORT_GRACE_MS of the mark is considered abort-caused — its generic
// error reply is suppressed and the streamer warning is skipped.
//
// Timestamp model (vs the earlier "delete after first read" Set) fixes
// the case where multiple pendings were in-flight at abort time: all of
// them reject with "Process killed", all of them should be silent, not
// just the first one.
const ABORT_GRACE_MS = 15_000;
const abortedSessions = new Map();

function markSessionAborted(sessionKey) {
  abortedSessions.set(sessionKey, Date.now());
  // Sweep old entries opportunistically.
  for (const [k, ts] of abortedSessions) {
    if (Date.now() - ts > ABORT_GRACE_MS * 2) abortedSessions.delete(k);
  }
}

function isSessionRecentlyAborted(sessionKey) {
  const ts = abortedSessions.get(sessionKey);
  return ts != null && (Date.now() - ts) < ABORT_GRACE_MS;
}

// Called by bot.on('message') for every regular (non-admin, non-pair)
// message. Runs handleMessage in a fire-and-forget manner with centralised
// error handling. Replaces the old processQueue loop.
function dispatchHandleMessage(sessionKey, chatId, msg, bot) {
  const count = (inFlightHandlers.get(sessionKey) || 0) + 1;
  inFlightHandlers.set(sessionKey, count);
  if (count === CONCURRENT_WARN_THRESHOLD) {
    dbWrite(() => db.logEvent('queue-depth-warning', {
      chat_id: chatId, session_key: sessionKey,
      in_flight: count, threshold: CONCURRENT_WARN_THRESHOLD,
    }), 'log queue-depth-warning');
  }
  handleMessage(sessionKey, chatId, msg, bot).catch((err) => {
    const wasAborted = isSessionRecentlyAborted(sessionKey);
    console.error(`[${sessionKey}] Error:`, err.message);
    // Mark the row as 'failed' so boot replay doesn't re-dispatch it.
    // Exception: aborted sessions → 'aborted' (same — not replayable).
    // Shutdown case handled separately in the SIGTERM handler.
    dbWrite(() => db.setInboundHandlerStatus({
      chat_id: chatId, msg_id: msg.message_id,
      status: wasAborted ? 'aborted' : 'failed',
    }), 'set handler_status=failed/aborted');
    dbWrite(() => db.logEvent('handler-error', {
      chat_id: chatId, session_key: sessionKey,
      msg_id: msg?.message_id,
      error: err.message?.slice(0, 500),
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      aborted: wasAborted || undefined,
    }), 'log handler-error');
    if (!wasAborted) {
      tg(bot, 'sendMessage', {
        chat_id: chatId,
        text: `Sorry, I couldn't process that message. The operator has been notified.`,
        reply_parameters: { message_id: msg.message_id },
      }, { source: 'error-reply', botName: BOT_NAME }).catch((replyErr) => {
        console.error(`[${sessionKey}] failed to send error reply: ${replyErr.message}`);
      });
    }
  }).finally(() => {
    const n = (inFlightHandlers.get(sessionKey) || 1) - 1;
    if (n <= 0) inFlightHandlers.delete(sessionKey);
    else inFlightHandlers.set(sessionKey, n);
  });
}

// drainQueuesForChat is retained as a no-op for backwards compat with
// call sites in /model, /effort, chat-migration, and abort handlers.
// Returns 0 always; a drain isn't meaningful in the concurrent model —
// callers that want to abort should rely on pm.killChat.
const drainQueuesForChat = (_chatId) => 0;

// Per-session lock ordering stdin writes. Module is I/O-pure.
const stdinLock = createAsyncLock();

// Typing indicator is imported from lib/typing-indicator — it adds a
// per-chat circuit breaker with exponential backoff so a chat that
// permanently 401s (bot blocked, chat deleted) doesn't have us
// hammering sendChatAction every 4s for the full turn duration.

// ─── Response parsing (stickers, reactions) ─────────────────────────

function parseResponse(text) {
  const trimmed = text.trim();
  const emojiOnly = /^\p{Emoji_Presentation}$/u.test(trimmed) || /^\p{Emoji}\uFE0F?$/u.test(trimmed);

  if (emojiOnly && trimmed) {
    if (emojiToSticker[trimmed]) {
      return { text: '', sticker: emojiToSticker[trimmed], stickerLabel: trimmed, reaction: null };
    }
    return { text: '', sticker: null, stickerLabel: null, reaction: trimmed };
  }

  return { text: trimmed, sticker: null, stickerLabel: null, reaction: null };
}

// ─── Reply chunking ─────────────────────────────────────────────────

function chunkText(text, maxLen = TG_MAX_LEN) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

// ─── Cron/IPC send ─────────────────────────────────────────────────

// Allowlist of Telegram Bot API methods external callers (cron) may invoke.
// Broader than sendMessage to cover receipts, error reports, quick replies.
// Deliberately excludes destructive ops (deleteMessage, banChatMember, etc.);
// cron has no business calling those.
const IPC_SEND_ALLOWED_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendSticker',
  'sendChatAction',
  'editMessageText',
  'setMessageReaction',
]);

async function handleSendOverIpc(req) {
  const { method, params = {}, source } = req || {};
  if (!method) throw new Error('method required');
  if (!IPC_SEND_ALLOWED_METHODS.has(method)) {
    throw new Error(`method not allowed: ${method}`);
  }
  if (!bot) throw new Error(`bot process not ready`);

  // Enforce: chat_id must belong to this bot (no cross-bot sends).
  // After filterConfigToBot, config.chats only contains our chats.
  const chatId = params.chat_id != null ? String(params.chat_id) : null;
  if (chatId && !config.chats[chatId]) {
    throw new Error(`chat not owned by ${BOT_NAME}: ${chatId}`);
  }

  const sendRes = await tg(bot, method, params, {
    source: source || 'ipc',
    botName: BOT_NAME,
  });
  return { result: sendRes };
}

// ─── Approvals ─────────────────────────────────────────────────────

// Format a tool_input for the inline keyboard card. Clip aggressively so
// the card doesn't exceed Telegram's 4096-char limit.
function formatToolInputForCard(input) {
  let s;
  try { s = typeof input === 'string' ? input : JSON.stringify(input, null, 2); }
  catch { s = String(input); }
  if (s.length <= 1200) return s;
  return s.slice(0, 900) + '\n…[clipped]…\n' + s.slice(-200);
}

function buildApprovalKeyboard(approvalId, token) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${approvalId}:${token}` },
      { text: '❌ Deny',    callback_data: `deny:${approvalId}:${token}` },
    ]],
  };
}

function approvalCardText(row, opts = {}) {
  // No parse_mode is used on this card — tool_name/turn_id/tool_input
  // originate from the Claude subprocess and could contain Markdown special
  // chars or tg:// links crafted for phishing. Plain text renders as-is.
  const heading = opts.resolvedBy
    ? opts.resolvedBy
    : `Approval needed — ${row.tool_name}`;
  const body = formatToolInputForCard(
    typeof row.tool_input_json === 'string'
      ? safeParse(row.tool_input_json)
      : row.tool_input_json,
  );
  const ttl = Math.max(0, Math.round((row.timeout_ts - Date.now()) / 1000));
  const footer = opts.resolvedBy
    ? ''
    : `\n\n⏱ expires in ${ttl}s`;
  return `${heading}\nChat: ${row.requester_chat_id}\nTurn: ${row.turn_id || '-'}\n\n${body}${footer}`;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function handleApprovalRequest(req) {
  const { bot_name, chat_id, turn_id, tool_name, tool_input } = req;
  if (!chat_id || !tool_name) {
    throw new Error('chat_id, tool_name required');
  }
  // Per-bot process: the caller's bot_name must match ours if provided.
  if (bot_name && bot_name !== BOT_NAME) {
    throw new Error(`wrong bot: socket is ${BOT_NAME}, request is for ${bot_name}`);
  }

  const apprCfg = config.bot?.approvals;
  if (!apprCfg || !apprCfg.adminChatId) {
    return { decision: 'not-gated', reason: 'approvals not configured for this bot' };
  }

  const gated = matchesApprovalPattern(tool_name, tool_input, apprCfg.gatedTools || []);
  if (!gated.matched) {
    return { decision: 'not-gated' };
  }

  // Issue pending row (with dedup). Row persists the bot_name for archive/
  // audit queries across per-bot DBs.
  const row = approvals.issue({
    bot_name: BOT_NAME, turn_id, requester_chat_id: chat_id,
    approver_chat_id: String(apprCfg.adminChatId),
    tool_name, tool_input,
    timeoutMs: apprCfg.timeoutMs || APPROVAL_DEFAULT_TIMEOUT_MS,
  });

  if (!bot) {
    approvals.resolve({ id: row.id, status: 'cancelled', reason: 'bot process not ready' });
    return { decision: 'denied', reason: 'bot process not ready' };
  }

  if (!row.reused || !row.approver_msg_id) {
    try {
      const sent = await tg(bot, 'sendMessage', {
        chat_id: apprCfg.adminChatId,
        text: approvalCardText(row),
        reply_markup: buildApprovalKeyboard(row.id, row.callback_token),
      }, { source: 'approval-request', botName: BOT_NAME, plainText: true });
      if (sent?.message_id) {
        approvals.setApproverMsgId(row.id, sent.message_id);
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] failed to post approval card: ${err.message}`);
      approvals.resolve({ id: row.id, status: 'cancelled', reason: `post failed: ${err.message}` });
      return { decision: 'denied', reason: `post failed: ${err.message}` };
    }
  }

  // Block until callback resolves us, or timeout fires. Multiple dedup'd
  // callers can queue on the same id — they all get the same decision.
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      dropWaiter(row.id, wrappedResolve);
      resolve({ decision: 'timeout', reason: 'operator did not respond in time' });
    }, Math.max(1000, row.timeout_ts - Date.now()));

    const wrappedResolve = (decision, reason) => {
      clearTimeout(timer);
      resolve({ decision, reason });
    };

    const list = approvalWaiters.get(row.id) || [];
    list.push(wrappedResolve);
    approvalWaiters.set(row.id, list);
  });
}

function dropWaiter(id, fn) {
  const list = approvalWaiters.get(id);
  if (!list) return;
  const i = list.indexOf(fn);
  if (i !== -1) list.splice(i, 1);
  if (list.length === 0) approvalWaiters.delete(id);
}

function resolveApprovalWaiter(id, decision, reason) {
  const list = approvalWaiters.get(id);
  if (!list) return;
  approvalWaiters.delete(id);
  for (const fn of list) {
    try { fn(decision, reason); } catch {}
  }
}

async function handleApprovalCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const m = String(data).match(/^(approve|deny):(\d+):(\S+)$/);
  if (!m) return;
  const decision = m[1];
  const id = parseInt(m[2], 10);
  const token = m[3];

  const row = approvals.getById(id);
  if (!row) {
    await ctx.answerCallbackQuery({ text: 'Unknown approval.', show_alert: true }).catch(() => {});
    return;
  }
  if (!approvalTokensEqual(row.callback_token, token)) {
    dbWrite(() => db.logEvent('approval-token-mismatch', {
      id, from_user: ctx.from?.id,
      // Don't log the sent_token — attackers guessing it don't need to know
      // which prefix they got close on.
    }), 'log approval-token-mismatch');
    await ctx.answerCallbackQuery({ text: 'Bad token.', show_alert: true }).catch(() => {});
    return;
  }
  if (row.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: `Already ${row.status}.`, show_alert: true }).catch(() => {});
    return;
  }

  // Only the configured approver chat is authoritative. Our process only
  // serves one bot, so config.bot.approvals is the authoritative source.
  const apprCfg = config.bot?.approvals;
  const expectedChat = String(apprCfg?.adminChatId || '');
  if (String(ctx.chat?.id) !== expectedChat) {
    dbWrite(() => db.logEvent('approval-foreign-chat', {
      id, from_chat: ctx.chat?.id, expected: expectedChat,
    }), 'log approval-foreign-chat');
    await ctx.answerCallbackQuery({ text: 'Not authorised here.', show_alert: true }).catch(() => {});
    return;
  }

  const status = decision === 'approve' ? 'approved' : 'denied';
  const user = ctx.from?.first_name || ctx.from?.username || null;
  const userId = ctx.from?.id || null;
  // SQL-level atomic resolve: UPDATE ... WHERE status='pending' — so in a
  // double-click race only one of the two callers writes. If ours was
  // second, changes=0 → stale decision; tell the clicker and don't edit
  // the card a second time (the winner already did).
  const changes = approvals.resolve({
    id, status,
    decided_by_user_id: userId, decided_by_user: user,
  });
  if (changes === 0) {
    const fresh = approvals.getById(id);
    await ctx.answerCallbackQuery({
      text: `Already ${fresh?.status || 'resolved'}.`,
      show_alert: true,
    }).catch(() => {});
    return;
  }
  dbWrite(() => db.logEvent('approval-resolved', {
    id, status, by: userId, user, bot: BOT_NAME,
  }), 'log approval-resolved');

  // Edit the card to show the decision.
  try {
    const fresh = approvals.getById(id);
    await ctx.api.editMessageText(
      row.approver_chat_id,
      row.approver_msg_id,
      approvalCardText(fresh, {
        resolvedBy: `${status === 'approved' ? '✅ Approved' : '❌ Denied'} by ${user || userId}`,
      }),
    );
  } catch (err) {
    console.error(`[${BOT_NAME}] edit approval card failed: ${err.message}`);
  }
  await ctx.answerCallbackQuery({ text: status }).catch(() => {});

  resolveApprovalWaiter(id, status);
}

function startApprovalSweeper(intervalMs = 30_000) {
  return setInterval(() => {
    let rows;
    try {
      rows = approvals.sweepTimedOut();
    } catch (err) {
      // Silent failure here is invisible death — pending approvals time out
      // with no operator signal. Log loudly.
      console.error(`[approvals] sweeper DB error: ${err.message}`);
      dbWrite(() => db.logEvent('approval-sweep-failed', {
        error: err.message?.slice(0, 300),
      }), 'log approval-sweep-failed');
      return;
    }
    for (const row of rows) {
      approvals.resolve({ id: row.id, status: 'timeout' });
      dbWrite(() => db.logEvent('approval-timeout', {
        id: row.id, bot: BOT_NAME, tool: row.tool_name,
      }), 'log approval-timeout');
      resolveApprovalWaiter(row.id, 'timeout', 'swept');
      // Best-effort: edit the card to show the timeout.
      if (bot && row.approver_msg_id) {
        bot.api.editMessageText(
          row.approver_chat_id,
          row.approver_msg_id,
          approvalCardText(approvals.getById(row.id), { resolvedBy: '⏰ Timed out' }),
        ).catch(() => {});
      }
    }
  }, intervalMs);
}

// Parse /pair-code args: /pair-code [--chat <id>] [--scope user|chat] [--ttl 10m] [--note "..."]
function parsePairCodeArgs(text) {
  const out = {};
  // Strip command, then walk flags. Notes may contain spaces; parse them last.
  let rest = text.replace(/^\/pair-code\s*/, '').trim();
  const flags = ['--chat', '--scope', '--ttl'];
  for (const flag of flags) {
    const re = new RegExp(`${flag.replace(/-/g, '\\-')}\\s+(\\S+)`);
    const m = rest.match(re);
    if (m) {
      out[flag.slice(2)] = m[1];
      rest = rest.replace(re, '').trim();
    }
  }
  const noteM = rest.match(/--note\s+"([^"]*)"|--note\s+(\S+)/);
  if (noteM) out.note = noteM[1] || noteM[2];
  return out;
}

// ─── Message handler ────────────────────────────────────────────────

async function handleMessage(sessionKey, chatId, msg, bot) {
  const chatConfig = config.chats[chatId];
  if (!chatConfig) return;

  // Mark the inbound row as 'dispatched' so the boot replay loop knows
  // this turn started. Cleared to 'replied' (or 'failed') when done.
  dbWrite(() => db.setInboundHandlerStatus({
    chat_id: chatId, msg_id: msg.message_id, status: 'dispatched',
  }), 'set handler_status=dispatched');

  const text = msg.text || msg.caption || '';
  const threadId = msg.message_thread_id;
  const threadIdStr = threadId?.toString() || null;
  const label = getSessionLabel(chatConfig, threadIdStr);

  const replyOpts = (tid) => ({
    reply_parameters: { message_id: msg.message_id },
    ...(tid && { message_thread_id: tid }),
  });

  const MODEL_VERSIONS = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' };

  const botAllowsCommands = !!config.bot?.allowConfigCommands;
  const cmdUser = msg.from?.first_name || msg.from?.username || null;
  const cmdUserId = msg.from?.id || null;

  const sendReply = (replyText, meta = {}) => tg(bot, 'sendMessage', {
    chat_id: chatId, text: replyText, ...replyOpts(threadId),
  }, { source: 'command-reply', botName: BOT_NAME, model: chatConfig.model, effort: chatConfig.effort, ...meta });

  if (botAllowsCommands && (text === '/model' || text === '/config' || text === '/effort')) {
    const alive = pm.has(sessionKey) && !pm.get(sessionKey).closed;
    const ver = MODEL_VERSIONS[chatConfig.model] || chatConfig.model;
    const info = `Model: ${chatConfig.model} (${ver})\nEffort: ${chatConfig.effort}\nAgent: ${chatConfig.agent}\nProcess: ${alive ? 'warm' : 'cold'}\nSession: ${getClaudeSessionId(db, sessionKey)?.slice(0, 8) || 'new'}`;
    await sendReply(info);
    return;
  }
  // Helper: request respawn across ALL sessionKeys owned by this chat (one
  // per topic if isolateTopics=true, otherwise just the single chat-level
  // key). Graceful: in-flight turns drain on old settings, new turns use
  // the new settings. Returns total pending turns across all keys so the
  // reply can tell the user.
  const requestRespawnForChat = (reason) => {
    const prefix = String(chatId);
    let totalQueued = 0;
    let anyActive = false;
    for (const key of pm.keys()) {
      if (key === prefix || key.startsWith(prefix + ':')) {
        const res = pm.requestRespawn(key, reason);
        totalQueued += res.queued;
        if (!res.killed) anyActive = true;
      }
    }
    return { queued: totalQueued, anyActive };
  };

  if (botAllowsCommands && text.startsWith('/model ')) {
    const newModel = text.slice(7).trim();
    if (['opus', 'sonnet', 'haiku'].includes(newModel)) {
      const oldModel = chatConfig.model;
      // Ephemeral: in-memory only, reverts to config.json on restart.
      chatConfig.model = newModel;
      dbWrite(() => db.logConfigChange({
        chat_id: chatId, thread_id: threadIdStr, field: 'model',
        old_value: oldModel, new_value: newModel,
        user: cmdUser, user_id: cmdUserId, source: 'command',
      }), 'log model change');
      const { anyActive } = requestRespawnForChat('model-change');
      const ver = MODEL_VERSIONS[newModel] || newModel;
      const suffix = anyActive ? ` — I'll switch when I finish` : '';
      await sendReply(`Model → ${newModel} (${ver})${suffix}`);
    } else {
      await sendReply(`Unknown model. Use: opus, sonnet, haiku`);
    }
    return;
  }
  if (botAllowsCommands && text.startsWith('/effort ')) {
    const newEffort = text.slice(8).trim();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(newEffort)) {
      const oldEffort = chatConfig.effort;
      // Ephemeral: in-memory only, reverts to config.json on restart.
      chatConfig.effort = newEffort;
      dbWrite(() => db.logConfigChange({
        chat_id: chatId, thread_id: threadIdStr, field: 'effort',
        old_value: oldEffort, new_value: newEffort,
        user: cmdUser, user_id: cmdUserId, source: 'command',
      }), 'log effort change');
      const { anyActive } = requestRespawnForChat('effort-change');
      const suffix = anyActive ? ` — I'll switch when I finish` : '';
      await sendReply(`Effort → ${newEffort}${suffix}`);
    } else {
      await sendReply(`Unknown effort. Use: low, medium, high, xhigh, max`);
    }
    return;
  }
  // Admin-only pairing commands — chat must match config.bot.adminChatId.
  // allowConfigCommands alone is NOT sufficient: that flag gates /model and
  // /effort which only affect the current chat. Pairing issues cross-chat
  // trust and must be narrowed further.
  const adminChatId = config.bot?.adminChatId ? String(config.bot.adminChatId) : null;
  const isAdminChat = adminChatId && String(chatId) === adminChatId;

  if (botAllowsCommands && text.startsWith('/pair-code')) {
    if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return; }
    const issuerId = cmdUserId;
    if (!issuerId) { await sendReply('No user id on request'); return; }
    const args = parsePairCodeArgs(text);
    try {
      const out = pairings.issueCode({
        bot_name: BOT_NAME,
        chat_id: args.chat || null,
        scope: args.scope || 'user',
        issued_by_user_id: issuerId,
        ttlMs: args.ttl ? parsePairingTtl(args.ttl) : undefined,
        note: args.note || null,
      });
      dbWrite(() => db.logEvent('pair-code-issued', {
        bot: BOT_NAME, by: issuerId, scope: out.scope,
        chat_id: out.chat_id, note: out.note,
      }), 'log pair-code-issued');
      const ttlLabel = args.ttl || '10m';
      const chatLabel = out.chat_id ? `chat ${out.chat_id}` : 'any chat';
      await sendReply(
        `Code: ${out.code}\nexpires: ${ttlLabel}\nscope: ${out.scope} (${chatLabel})${out.note ? `\nnote: ${out.note}` : ''}\n\nShare with user:\n/pair ${out.code}`,
      );
    } catch (err) {
      await sendReply(`Could not issue code: ${err.message}`);
    }
    return;
  }
  if (botAllowsCommands && text.startsWith('/pairings')) {
    if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return; }
    const rows = pairings.listActive(BOT_NAME);
    if (!rows.length) { await sendReply('No active pairings.'); return; }
    const lines = rows.map(r => {
      const chat = r.chat_id ? `chat ${r.chat_id}` : 'any chat';
      const granted = new Date(r.granted_ts).toISOString().slice(0, 16).replace('T', ' ');
      const note = r.note ? ` — ${r.note}` : '';
      return `• user ${r.user_id} — ${chat} — ${granted}${note}`;
    });
    await sendReply(`Active pairings (${rows.length}):\n${lines.join('\n')}`);
    return;
  }
  if (botAllowsCommands && text.startsWith('/unpair ')) {
    if (!isAdminChat) { await sendReply('Pairing commands are admin-only; run from the admin chat.'); return; }
    const arg = text.slice(8).trim();
    const targetId = parseInt(arg, 10);
    if (!Number.isFinite(targetId)) {
      await sendReply('Usage: /unpair <user_id>'); return;
    }
    const n = pairings.revokeByUser({ bot_name: BOT_NAME, user_id: targetId });
    dbWrite(() => db.logEvent('pair-revoked', {
      bot: BOT_NAME, user_id: targetId, by: cmdUserId, count: n,
    }), 'log pair-revoked');
    await sendReply(n ? `Revoked ${n} pairing(s) for user ${targetId}.` : `No active pairings for user ${targetId}.`);
    return;
  }
  // /pair <CODE> — open to anyone, no admin gate (the code IS the auth)
  if (text.startsWith('/pair ') && !text.startsWith('/pair-code') && !text.startsWith('/pairings')) {
    if (!cmdUserId) { await sendReply('No user id on request'); return; }
    const code = text.slice(6).trim();
    const res = pairings.claimCode({
      code, claimer_user_id: cmdUserId,
      chat_id: chatId, bot_name: BOT_NAME,
    });
    dbWrite(() => db.logEvent('pair-claim-attempt', {
      bot: BOT_NAME, user_id: cmdUserId, chat_id: chatId,
      ok: res.ok, reason: res.reason,
    }), 'log pair-claim-attempt');
    if (res.ok) {
      const chatLabel = res.chat_id ? `chat ${res.chat_id}` : `every chat ${BOT_NAME} is in`;
      await sendReply(`Paired. You can use me in ${chatLabel}.${res.note ? `\n(${res.note})` : ''}`);
    } else {
      // Collapse specific failure reasons into a single "invalid or expired"
      // response to prevent enumeration: distinguishing "wrong-chat" from
      // "not-found" would tell an attacker a valid code prefix. The
      // pair-claim-attempt event above still logs the precise reason for
      // operator audit.
      const userMsg = res.reason === 'rate-limited'
        ? 'Too many attempts. Try again later.'
        : 'Invalid or expired code.';
      await sendReply(userMsg);
    }
    return;
  }

  const t0 = Date.now();

  const sessionCtx = !pm.has(sessionKey) ? await readSessionContext(sessionKey, chatConfig.cwd) : '';

  const rawAtts = extractAttachments(msg);
  const { accepted, rejected } = filterAttachments(rawAtts);
  for (const { att, reason } of rejected) {
    console.log(`[${label}] attachment skipped: ${att.name} (${reason})`);
    dbWrite(() => db.logEvent('attachment-skipped', { chat_id: chatId, msg_id: msg.message_id, name: att.name, reason }), 'log attachment-skipped');
  }
  const token = config.bot?.token || '';
  const downloaded = accepted.length ? await downloadAttachments(bot, token, chatId, msg, accepted) : [];
  if (rejected.length) {
    const summary = rejected.map(({ att, reason }) => `${att.name}: ${reason}`).join('; ');
    try {
      await tg(bot, 'sendMessage', {
        chat_id: chatId, text: `Attachment(s) skipped: ${summary.slice(0, 300)}`,
        ...replyOpts(threadId),
      }, { source: 'attachment-skipped', botName: BOT_NAME });
    } catch {}
  }

  await transcribeVoiceAttachments(downloaded, {
    chatId, msgId: msg.message_id, label, botApi: bot, threadId,
  });

  const prompt = formatPrompt(msg, sessionCtx, downloaded);
  const stopTyping = startTyping({
    bot, chatId, threadId,
    logger: { error: (m) => console.error(`[${label}] ${m}`) },
    onEvent: (e) => dbWrite(() => db.logEvent(e.kind, {
      bot: BOT_NAME, chat_id: e.chat_id, ...(e.detail || {}),
    }), `log ${e.kind}`),
  });

  const botCfg = config.bot || {};
  const outMetaBase = {
    source: 'bot-reply-stream',
    botName: BOT_NAME,
    model: chatConfig.model,
    effort: chatConfig.effort,
  };

  // Streaming is unconditional as of 0.4.0 — matches OpenClaw's model and
  // eliminates the "stuck at 15min typing" complaint from the non-streaming
  // code path. For short responses the streamer stays idle and we fall
  // through to the normal send path via finalize() returning streamed=false.
  const streamer = createStreamer({
    send: async (text) => tg(bot, 'sendMessage', {
      chat_id: chatId, text,
      // allow_sending_without_reply: long-running turns give the user
      // plenty of time to delete their original message. Without this
      // flag, Telegram rejects the reply with MESSAGE_NOT_FOUND and the
      // whole streamed answer is lost. With it, the reply simply lands
      // as a standalone message.
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...(threadId && { message_thread_id: threadId }),
    }, outMetaBase),
    edit: async (messageId, text) => {
      try {
        // Route edits through tg() so applyFormatting runs (MarkdownV2
        // + escape). Going direct to bot.api.editMessageText would
        // skip formatting and leave every edit rendering literal
        // **bold** / `code` in the bubble — which was the visible bug
        // in 0.4.2 where the initial send was formatted and every
        // subsequent edit overwrote it with plain text.
        return await tg(bot, 'editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
        }, { source: 'bot-reply-stream-edit', botName: BOT_NAME });
      } catch (err) {
        // Stream-edit failures would otherwise be invisible — edits
        // don't insert a messages row by default (tg() does, but we
        // want the failure path specifically surfaced). Log to events.
        dbWrite(() => db.logEvent('telegram-edit-failed', {
          chat_id: chatId, msg_id: messageId,
          api_error: err.message?.slice(0, 200),
          bot: BOT_NAME,
        }), 'log telegram-edit-failed');
        throw err;
      }
    },
    minChars: botCfg.streamMinChars,
    throttleMs: botCfg.streamThrottleMs,
    logger: { error: (m) => console.error(`[${label}] ${m}`) },
  });
  // streamer is registered with this turn via pm.send's context (below)

  // Status reactions on the user's message: 👀 queued → 🤔 thinking →
  // 👨‍💻 coding / ⚡ web / 🔥 tool → 👍 done / 🤯 error. Silent (no
  // notifications), updates in place, one emoji per message. Uses
  // setMessageReaction which skips the DB row (the tg() wrapper
  // short-circuits that method), so no transcript spam.
  const reactor = createReactionManager({
    apply: async (emoji) => {
      const params = {
        chat_id: chatId,
        message_id: msg.message_id,
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      };
      await tg(bot, 'setMessageReaction', params,
        { source: 'status-reaction', botName: BOT_NAME });
    },
    logError: (m) => console.error(`[${label}] ${m}`),
  });
  // Start at QUEUED (👀) so user sees their message was received but
  // not yet being worked on. pm calls context.onActivate when this
  // pending becomes the queue head (Claude is actually starting it),
  // at which point we flip to THINKING (🤔).
  reactor.setState('QUEUED');

  try {
    // Pass streamer + reactor as per-turn context. pm's callbacks pick
    // them off entry.pendingQueue[0].context so concurrent pendings each
    // get routed to their own streamer/reactor.
    const result = await sendToProcess(sessionKey, prompt, {
      streamer, reactor, sourceMsgId: msg.message_id,
      onActivate: () => reactor.setState('THINKING'),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    stopTyping();

    if (result.error) {
      console.error(`[${label}] Error (${elapsed}s):`, result.error);
      reactor.setState('ERROR');
      if (!result.text) return;
    } else {
      // Clear the progress reaction instead of stamping 👍 — the reply
      // bubble itself is the "done" signal and a permanent thumbs-up on
      // every answered message is chat noise (plus triggers reaction
      // notifications for other group members).
      reactor.clear().catch(() => {});
    }

    if (!result.text || result.text === 'NO_REPLY') return;

    const parsed = parseResponse(result.text);
    const outMeta = { ...outMetaBase, sessionId: result.sessionId, costUsd: result.cost };

    // Streamed text path: finalise the live-edit and, if the full response
    // overflows Telegram's 4096 cap, send remainder as follow-up chunks.
    if (parsed.text) {
      const fin = await streamer.finalize(parsed.text);
      if (fin.streamed) {
        if (parsed.text.length > TG_MAX_LEN) {
          const rest = parsed.text.slice(TG_MAX_LEN - 3);
          for (const chunk of chunkText(rest)) {
            try {
              await tg(bot, 'sendMessage', {
                chat_id: chatId, text: chunk,
                ...(threadId && { message_thread_id: threadId }),
              }, outMeta);
            } catch (err) {
              console.error(`[${label}] overflow sendMessage failed: ${err.message}`);
            }
          }
        }
        console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | streamed | ${chatConfig.model}/${chatConfig.effort} | $${result.cost?.toFixed(4) || '?'}`);
        return;
      }
      // Not streamed (response too short) — fall through to normal path.
    }

    if (parsed.reaction) {
      await tg(bot, 'setMessageReaction', {
        chat_id: chatId,
        message_id: msg.message_id,
        reaction: [{ type: 'emoji', emoji: parsed.reaction }],
      }, outMeta).catch((err) => {
        console.error(`[${label}] setMessageReaction failed: ${err.message}`);
      });
    } else if (parsed.sticker) {
      await tg(bot, 'sendSticker', {
        chat_id: chatId,
        sticker: parsed.sticker,
        ...(threadId && { message_thread_id: threadId }),
      }, { ...outMeta, stickerName: parsed.stickerLabel }).catch((err) => {
        console.error(`[${label}] sendSticker failed: ${err.message}`);
      });
    } else if (parsed.text) {
      const chunks = chunkText(parsed.text);
      for (let i = 0; i < chunks.length; i++) {
        const params = {
          chat_id: chatId, text: chunks[i],
          ...(threadId && { message_thread_id: threadId }),
        };
        if (i === 0) params.reply_parameters = { message_id: msg.message_id };
        try {
          await tg(bot, 'sendMessage', params, outMeta);
        } catch (err) {
          console.error(`[${label}] sendMessage failed (chunk ${i + 1}/${chunks.length}): ${err.message}`);
        }
      }
    }

    console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | ${chatConfig.model}/${chatConfig.effort} | $${result.cost?.toFixed(4) || '?'}`);
    // Success: mark the inbound row 'replied' so boot replay doesn't
    // pick it up again on restart.
    dbWrite(() => db.setInboundHandlerStatus({
      chat_id: chatId, msg_id: msg.message_id, status: 'replied',
    }), 'set handler_status=replied');
  } catch (err) {
    // If the user just aborted this session, silently finalise the stream
    // without the scary "⚠ stream interrupted" banner. The user has already
    // seen their "Остановлено." ack; adding a warning to the partial bubble
    // just reads as "something crashed".
    const abortedByUser = isSessionRecentlyAborted(sessionKey);
    if (abortedByUser) {
      await streamer.finalize('').catch(() => {});
      // Leave reaction as-is — no 🤯 / 😨; user asked for stop.
    } else {
      await streamer.finalize('', { errorSuffix: 'stream interrupted' }).catch(() => {});
      if (/wall-clock ceiling|idle with no Claude activity/i.test(err?.message || '')) {
        reactor.setState('TIMEOUT');
      } else {
        reactor.setState('ERROR');
      }
    }
    throw err;
  } finally {
    stopTyping();
    reactor.stop();
  }
}

// ─── Bot setup ──────────────────────────────────────────────────────

function shouldHandle(msg, chatConfig, botUsername) {
  const hasAttachment = !!(msg.document || msg.photo || msg.voice || msg.audio || msg.video);
  if (!msg.text && !msg.caption && !hasAttachment) return false;
  const chatId = msg.chat.id.toString();
  if (!config.chats[chatId]) return false;

  if (chatConfig.requireMention && msg.chat.type !== 'private') {
    const text = msg.text || msg.caption || '';
    const isReplyToBot = msg.reply_to_message?.from?.username === botUsername;
    const hasMention = text.includes(`@${botUsername}`);
    // Paired users bypass requireMention — they've been explicitly trusted
    // in this chat by an operator, no need for a mention every time.
    const paired = pairings && msg.from?.id
      ? pairings.hasLivePairing({ bot_name: BOT_NAME, user_id: msg.from.id, chat_id: chatId })
      : false;
    if (!isReplyToBot && !hasMention && !paired) return false;
  }

  return true;
}

function createBot(token) {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 60 },
  });
  let botUsername = '';
  // Cached once @botUsername is known — was recompiling per inbound msg.
  let mentionRe = null;
  // Hoisted admin-command matcher; was re-allocated per message.
  const ADMIN_CMD_RE = /^\/(model|effort|config|pair-code|pairings|unpair)(\s|$)/;
  const PAIR_CLAIM_RE = /^\/pair\s+\S+/;

  // The filter in main() guarantees config.chats only contains chats owned
  // by BOT_NAME, so any update for a chat not in config.chats is unknown —
  // not another bot's problem.
  const knownChat = (chatId) => !!config.chats[chatId];

  // Claim a pair code from an unconfigured private chat and persist a new
  // chat entry so subsequent messages go through the normal flow. Replies
  // to the user on both success and failure. Returns the new chatConfig on
  // success, null on any failure.
  //
  // The new chat inherits cwd/agent from bot-level pairedChatDefaults if
  // present, otherwise from the first existing chat the bot owns — on the
  // reasonable assumption that paired DMs should behave like other DMs for
  // this bot. Operator can override by setting config.bots.<bot>.pairedChatDefaults.
  async function onboardPairedChat(ctx, code) {
    const chatId = ctx.chat.id.toString();
    const userId = ctx.message.from?.id;
    const send = (text) => bot.api.sendMessage(chatId, text).catch(() => {});

    if (!userId) {
      await send('No user id on request.');
      return null;
    }

    const res = pairings.claimCode({
      code, claimer_user_id: userId,
      chat_id: chatId, bot_name: BOT_NAME,
    });
    dbWrite(() => db.logEvent('pair-claim-attempt', {
      bot: BOT_NAME, user_id: userId, chat_id: chatId,
      ok: res.ok, reason: res.reason, via: 'auto-onboard',
    }), 'log pair-claim-attempt');

    if (!res.ok) {
      const reply = res.reason === 'rate-limited'
        ? 'Too many attempts. Try again later.'
        : 'Invalid or expired code.';
      await send(reply);
      return null;
    }

    const paired = config.bot?.pairedChatDefaults || {};
    const globals = config.defaults || {};
    const firstChat = Object.values(config.chats)[0] || {};
    const chatName = paired.name
      || (ctx.chat.username && `@${ctx.chat.username}`)
      || ctx.chat.first_name
      || `User ${userId}`;

    const cwd = paired.cwd || firstChat.cwd;
    if (!cwd) {
      dbWrite(() => db.logEvent('auto-onboard-failed', {
        bot: BOT_NAME, chat_id: chatId, user_id: userId,
        reason: 'no-cwd',
      }), 'log auto-onboard-failed');
      await send('Paired, but no working directory is configured. Ask the operator to set pairedChatDefaults.cwd.');
      return null;
    }

    const newChat = {
      name: chatName,
      bot: BOT_NAME,
      agent: paired.agent || firstChat.agent,
      model: paired.model || globals.model || 'sonnet',
      effort: paired.effort || globals.effort || 'medium',
      cwd,
      timeout: paired.timeout || globals.timeout || 600,
    };
    if (paired.requireMention != null) newChat.requireMention = paired.requireMention;

    config.chats[chatId] = newChat;
    try { saveConfig(); }
    catch (err) {
      console.error(`[${BOT_NAME}] saveConfig on auto-onboard failed: ${err.message}`);
    }
    dbWrite(() => db.logEvent('chat-auto-created', {
      bot: BOT_NAME, chat_id: chatId, user_id: userId,
      source: 'pair-claim', model: newChat.model, effort: newChat.effort,
    }), 'log chat-auto-created');

    const chatLabel = res.chat_id ? `chat ${res.chat_id}` : `every chat ${BOT_NAME} is in`;
    const suffix = res.note ? `\n(${res.note})` : '';
    await send(`Paired. You can use me in ${chatLabel}.${suffix}`);
    return newChat;
  }

  // Shared post-validation dispatch. Called directly for single messages
  // and for the synthesised "primary" of a media-group bundle.
  const dispatchRegularMessage = async (msg) => {
    const chatId = msg.chat.id.toString();
    const chatConfig = config.chats[chatId];
    if (!chatConfig) return;

    const rawText = msg.text || '';
    const cleanText = mentionRe ? rawText.replace(mentionRe, '').trim() : rawText.trim();

    // Abort: skip the queue entirely. Matches bilingual natural-language
    // cues ("stop" / "стоп" / "cancel" / "отмена" / …) and explicit
    // slash commands (/stop, /abort, /cancel). Kills the active Claude
    // subprocess and drains queued messages for this chat. Replies so
    // the user sees the bot heard them — silent abort is worse than
    // acknowledged abort.
    if (isAbortRequest(cleanText)) {
      const threadId = msg.message_thread_id?.toString();
      const sessionKey = getSessionKey(chatId, threadId, chatConfig);
      const hadActive = pm.has(sessionKey) && !!pm.get(sessionKey)?.inFlight;
      const dropped = drainQueuesForChat(chatId);
      // Mark BEFORE killing: the 'close' event fires almost immediately
      // after SIGTERM, and processQueue's catch needs to see the flag to
      // skip the generic error-reply. If we marked after, there'd be a
      // race where the error-reply slips through.
      if (hadActive) markSessionAborted(sessionKey);
      await pm.killChat(chatId).catch(() => {});
      dbWrite(() => db.logEvent('abort-requested', {
        chat_id: chatId, user_id: msg.from?.id || null,
        had_active: hadActive, queued_dropped: dropped,
        trigger: cleanText.slice(0, 40),
      }), 'log abort-requested');
      // Reply in the same language the user aborted in. Cyrillic-detection
      // is crude but reliable for ru/en (the only two cue sets we ship).
      const lang = /[а-яё]/i.test(cleanText) ? 'ru' : 'en';
      const strs = {
        en: {
          stopped: 'Stopped.',
          withDropped: (n) => `Stopped. Cleared ${n} queued message${n === 1 ? '' : 's'}.`,
          nothing: 'Nothing to stop.',
        },
        ru: {
          stopped: 'Остановлено.',
          withDropped: (n) => `Остановлено. Очередь очищена (${n}).`,
          nothing: 'Нечего останавливать.',
        },
      }[lang];
      const reply = hadActive || dropped
        ? (dropped ? strs.withDropped(dropped) : strs.stopped)
        : strs.nothing;
      try {
        await tg(bot, 'sendMessage', {
          chat_id: chatId, text: reply,
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
          ...(threadId && { message_thread_id: threadId }),
        }, { source: 'abort-ack', botName: BOT_NAME });
      } catch {}
      return;
    }

    const botAllowsCommands = !!config.bot?.allowConfigCommands;
    const isAdminCmd = botAllowsCommands && ADMIN_CMD_RE.test(cleanText);
    const isPairClaim = PAIR_CLAIM_RE.test(cleanText);
    if (isAdminCmd || isPairClaim) {
      msg.text = cleanText;
      const threadId = msg.message_thread_id?.toString();
      const sessionKey = getSessionKey(chatId, threadId, chatConfig);
      await handleMessage(sessionKey, chatId, msg, bot);
      return;
    }

    if (!shouldHandle(msg, chatConfig, botUsername)) return;

    if (botUsername) {
      msg.text = cleanText;
    }

    const threadId = msg.message_thread_id?.toString();
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);
    dispatchHandleMessage(sessionKey, chatId, msg, bot);
  };

  // Media-group buffer: coalesce multi-photo uploads (Telegram delivers
  // each attachment as a separate Message sharing a `media_group_id`) into
  // a single synthetic turn with all attachments merged. Timer resets on
  // every new sibling, so as long as messages arrive faster than the
  // DEFAULT_FLUSH_MS window apart they stay in the same bundle.
  const mediaBuffer = createMediaGroupBuffer({
    onFlush: (messages) => {
      if (!messages || messages.length === 0) return;
      // Primary = the (usually first) message with text/caption; that's
      // where the user's actual prompt lives. Fall back to index 0 for
      // all-media-no-text groups.
      const primary = messages.find((m) => m.text || m.caption) || messages[0];
      const merged = messages.flatMap((m) => extractAttachments(m));
      const synthetic = { ...primary, _mergedAttachments: merged };
      // Carry the primary's text verbatim (dispatchRegularMessage re-cleans
      // the mention). Caption → text so downstream sees it uniformly.
      if (!synthetic.text && synthetic.caption) synthetic.text = synthetic.caption;
      dispatchRegularMessage(synthetic).catch((err) =>
        console.error(`[${BOT_NAME}] media-group dispatch error: ${err.message}`));
    },
  });

  bot.on('message', async (ctx) => {
    if (!isWellFormedMessage(ctx.message)) {
      dbWrite(() => db.logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'missing chat.id / message_id',
      }), 'log malformed-update');
      return;
    }
    const chatId = ctx.chat.id.toString();
    let chatConfig = config.chats[chatId];

    // Auto-onboarding: /pair <CODE> from an unconfigured private chat.
    // Without this, the !chatConfig drop below would silently eat pair
    // claims from DMs the operator hasn't pre-listed — defeating the
    // whole point of pair codes (which exist to grant access without
    // pre-configuration). Group chats are not auto-onboarded: they must
    // still be added to config.json by the operator, because adding a
    // group can affect multiple users.
    if (!chatConfig && ctx.chat.type === 'private') {
      const probe = (ctx.message.text || '').trim();
      const pairMatch = /^\/pair(?:@\S+)?\s+(\S+)\s*$/.exec(probe);
      if (pairMatch) {
        chatConfig = await onboardPairedChat(ctx, pairMatch[1]);
        if (!chatConfig) return;
        recordInbound(ctx.message);
        return;
      }
    }
    if (!chatConfig) return;

    // Record every inbound msg, even unaddressed ones — needed for reply-to
    // lookups and the transcript skill.
    recordInbound(ctx.message);

    // Multi-photo / album upload: Telegram delivers siblings as separate
    // Messages sharing a media_group_id. Stash each and let the buffer
    // dispatch them together 500ms after the last sibling arrives.
    if (ctx.message.media_group_id) {
      mediaBuffer.add(`${chatId}:${ctx.message.media_group_id}`, ctx.message);
      return;
    }

    await dispatchRegularMessage(ctx.message);
  });

  bot.on('callback_query:data', async (ctx) => {
    try {
      await handleApprovalCallback(ctx);
    } catch (err) {
      console.error(`[${BOT_NAME}] callback_query error: ${err.message}`);
    }
  });

  bot.on('edited_message', async (ctx) => {
    if (!isWellFormedMessage(ctx.editedMessage)) {
      dbWrite(() => db.logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'edited_message missing chat.id / message_id',
      }), 'log malformed-update');
      return;
    }
    const chatId = ctx.editedMessage.chat.id.toString();
    if (!knownChat(chatId)) return;
    recordInbound(ctx.editedMessage);
    dbWrite(() => db.logEvent('message-edited', {
      chat_id: chatId,
      msg_id: ctx.editedMessage.message_id,
      user_id: ctx.editedMessage.from?.id || null,
    }), 'log message-edited');
    console.log(`[${BOT_NAME}] edited ${chatId}/${ctx.editedMessage.message_id}`);
  });

  bot.on('message:migrate_to_chat_id', async (ctx) => {
    // Defensive: Telegram's grammy filter matches when migrate_to_chat_id is
    // present, but neither value is guaranteed to be numeric / finite. If
    // this update is malformed, skip rather than writing garbage to the DB.
    const rawOld = ctx.chat?.id;
    const rawNew = ctx.message?.migrate_to_chat_id;
    const isValidId = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint';
    if (!isValidId(rawOld) || !isValidId(rawNew)) {
      dbWrite(() => db.logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'migrate_to_chat_id missing / non-numeric',
      }), 'log malformed-update');
      return;
    }
    const oldChatId = rawOld.toString();
    const newChatId = rawNew.toString();
    if (oldChatId === newChatId) {
      dbWrite(() => db.logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'migrate_to_chat_id equals current chat_id',
      }), 'log malformed-update');
      return;
    }
    console.log(`[${BOT_NAME}] chat migrated: ${oldChatId} → ${newChatId}`);
    dbWrite(() => db.logChatMigration(oldChatId, newChatId), 'log chat-migration');
    dbWrite(() => db.logEvent('chat-migrated', { old_chat_id: oldChatId, new_chat_id: newChatId }), 'log chat-migrated event');
    if (config.chats[oldChatId] && !config.chats[newChatId]) {
      config.chats[newChatId] = { ...config.chats[oldChatId] };
      delete config.chats[oldChatId];
      saveConfig();
      const droppedMigrate = drainQueuesForChat(oldChatId);
      if (droppedMigrate) dbWrite(() => db.logEvent('queue-drained', { chat_id: oldChatId, reason: 'chat-migrated', dropped: droppedMigrate }), 'log queue-drained');
      await pm.killChat(oldChatId);
    }
  });

  bot.catch((err) => {
    const updateId = err.ctx?.update?.update_id;
    const msgId = err.ctx?.update?.message?.message_id || err.ctx?.update?.edited_message?.message_id;
    console.error(`[${BOT_NAME}] update ${updateId} msg ${msgId} error: ${err.message}`);
    dbWrite(() => db.logEvent('update-error', {
      bot: BOT_NAME,
      update_id: updateId,
      msg_id: msgId,
      error: err.message?.slice(0, 300),
    }), 'log update-error');
  });

  bot._setBotUsername = (u) => {
    botUsername = u;
    mentionRe = u ? new RegExp(`@${u}\\b`, 'g') : null;
  };

  return bot;
}

// ─── Manual polling ─────────────────────────────────────────────────

async function pollBot(bot) {
  await bot.init();
  bot._setBotUsername(bot.botInfo.username);
  console.log(`[${BOT_NAME}] Bot @${bot.botInfo.username} ready`);

  await bot.api.deleteWebhook();

  // Restore polling offset from DB so a restart doesn't re-process the
  // backlog Telegram has accumulated while we were down. Grammy's in-memory
  // offset resets to 0 each boot, which makes getUpdates return every
  // un-confirmed update since the last ack — for an overnight outage that
  // can mean replaying dozens of stale messages.
  let offset = 0;
  try {
    const saved = db?.getPollingOffset?.(BOT_NAME);
    if (saved && saved > 0) {
      offset = saved + 1;
      console.log(`[${BOT_NAME}] resuming polling from update_id ${saved}`);
    }
  } catch (err) {
    console.error(`[${BOT_NAME}] getPollingOffset failed: ${err.message}`);
  }
  let running = true;
  bot._lastPollTs = Date.now();

  bot._stop = () => { running = false; };

  while (running) {
    try {
      const updates = await bot.api.getUpdates({
        offset,
        // Long-poll: Telegram holds the connection up to 25s waiting for
        // updates. When something arrives it returns immediately; empty
        // windows cost ~0 local CPU. Drops median inbound latency vs the
        // old short-poll-every-1s.
        timeout: 25,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      });
      bot._lastPollTs = Date.now();

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message && isWellFormedMessage(update.message)) {
          const m = update.message;
          const chatId = m.chat.id.toString();
          const chatConfig = config.chats[chatId];
          const threadId = m.message_thread_id?.toString();
          const topicName = threadId && chatConfig?.topics?.[threadId] ? chatConfig.topics[threadId] : threadId;
          const chatLabel = chatConfig?.name || chatId;
          const label = topicName ? `${chatLabel}/${topicName}` : chatLabel;
          console.log(`[${BOT_NAME}] ← ${label}: ${(m.text || m.caption || '(media)').slice(0, 60)}`);
        }
        try {
          await bot.handleUpdate(update);
        } catch (err) {
          console.error(`[${BOT_NAME}] Handler error:`, err.message);
        }
      }
      // Persist offset after batch dispatch so a crash mid-batch only risks
      // re-processing the unacked updates. We write only on non-empty batches
      // to avoid churning the row on every 25s idle poll.
      if (updates.length > 0) {
        dbWrite(() => db.savePollingOffset(BOT_NAME, updates[updates.length - 1].update_id),
          'save polling offset');
      }
      // No sleep on the success path: long-poll already blocks up to 25s
      // when idle. Sleeping here would add latency with no gain.
    } catch (err) {
      if (!running) break;
      if (err.error_code === 409) {
        console.log(`[${BOT_NAME}] 409, waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error(`[${BOT_NAME}] Poll error:`, err.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

// Watchdog: if the poll loop hasn't ticked in POLL_STALL_MS, log an event
// so external monitoring (or a human reading `events`) can see it. Launchd
// restarts the whole process on death, so we don't exit here — a stalled
// grammy poll is usually transient (network flap, Telegram 5xx).
const POLL_STALL_MS = 120_000;
function startPollWatchdog(bot) {
  let stalled = false;
  return setInterval(() => {
    const now = Date.now();
    const age = now - (bot._lastPollTs || 0);
    if (age > POLL_STALL_MS) {
      if (!stalled) {
        console.error(`[${BOT_NAME}] poll-stalled: no tick in ${Math.round(age / 1000)}s`);
        dbWrite(() => db.logEvent('poll-stalled', { bot: BOT_NAME, stall_ms: age }), 'log poll-stalled');
        stalled = true;
      }
    } else if (stalled) {
      console.log(`[${BOT_NAME}] poll-recovered after stall`);
      dbWrite(() => db.logEvent('poll-recovered', { bot: BOT_NAME }), 'log poll-recovered');
      stalled = false;
    }
  }, 30_000);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  loadConfig();
  loadStickers();

  let dbOverride;
  try {
    BOT_NAME = parseBotArg(process.argv);
    dbOverride = parseDbArg(process.argv);
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exit(2);
  }
  if (!BOT_NAME) {
    console.error('[fatal] --bot <name> is required. See ops/README.md.');
    process.exit(2);
  }
  try {
    config = filterConfigToBot(config, BOT_NAME);
    // Convenience: config.bot is the current bot's config block. After the
    // filter, config.bots has exactly one entry; this alias keeps call sites
    // from re-indexing by name.
    config.bot = config.bots[BOT_NAME];
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exit(2);
  }
  DB_PATH = dbOverride || path.join(DB_DIR, `${BOT_NAME}.db`);
  console.log(`[polygram] bot: ${BOT_NAME} (${Object.keys(config.chats).length} chats) db: ${DB_PATH}`);

  try {
    db = dbClient.open(DB_PATH);
    console.log(`[db] opened ${DB_PATH}`);
    tg = createSender(db, console);
    pairings = createPairingsStore(db.raw);
    approvals = createApprovalsStore(db.raw);
    const migration = migrateJsonToDb(db, SESSIONS_JSON_PATH, config.chats);
    if (migration.renamed) {
      console.log(`[db] sessions.json → ${migration.reason} (${migration.imported} imported)`);
    }
    const stale = db.markStalePending(60_000, BOT_NAME);
    if (stale.changes) console.log(`[db] marked ${stale.changes} stale pending rows as failed (bot=${BOT_NAME})`);
    const inboxRetentionMs = (config.defaults?.inboxRetentionDays || 30) * 86_400_000;
    const swept = sweepInbox(INBOX_DIR, inboxRetentionMs);
    if (swept.swept) {
      console.log(`[inbox] swept ${swept.swept} files (${(swept.bytes / 1_048_576).toFixed(1)} MiB) older than ${inboxRetentionMs / 86_400_000}d`);
      db.logEvent('inbox-swept', { files: swept.swept, bytes: swept.bytes, retention_days: inboxRetentionMs / 86_400_000 });
    }
    db.logEvent('polygram-start', { migration: migration.reason, imported: migration.imported });
  } catch (err) {
    console.error(`[db] FATAL: ${err.message}`);
    console.error('Bridge cannot run without a DB (Phase 2: DB is source of truth).');
    process.exit(1);
  }

  const cap = config.maxWarmProcesses || DEFAULT_MAX_WARM_PROCS;
  pm = new ProcessManager({
    cap,
    spawnFn: spawnClaude,
    db,
    logger: console,
    onInit: (sessionKey, event, entry) => {
      dbWrite(() => db.upsertSession({
        session_key: sessionKey,
        chat_id: entry.chatId,
        thread_id: entry.threadId,
        claude_session_id: event.session_id,
        agent: config.chats[entry.chatId]?.agent || null,
        cwd: config.chats[entry.chatId]?.cwd || null,
        model: config.chats[entry.chatId]?.model || null,
        effort: config.chats[entry.chatId]?.effort || null,
      }), `upsert session ${sessionKey}`);
    },
    onClose: (sessionKey, code, entry) => {
      console.log(`[${entry.label}] Process exited (code ${code})`);
      dbWrite(() => db.logEvent('process-close', { chat_id: entry.chatId, session_key: sessionKey, code }), 'log process-close');
    },
    onStreamChunk: (sessionKey, partial, entry) => {
      // Route to the head pending's per-turn streamer. In the 0.4.8
      // concurrent-pending model, there can be N pendings queued — only
      // the HEAD is the turn Claude is actively emitting events for.
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) s.onChunk(partial).catch(() => {});
    },
    onToolUse: (sessionKey, toolName, entry) => {
      const head = entry.pendingQueue?.[0];
      const r = head?.context?.reactor;
      if (r) r.setState(classifyToolName(toolName));
    },
    // Fires after a graceful /model or /effort drain has actually
    // swapped to the new settings. Post a confirmation back to the
    // chat so the user knows the switch happened.
    onRespawn: (sessionKey, reason, entry) => {
      const chatId = entry.chatId;
      if (!chatId) return;
      const chatConfig = config.chats[chatId];
      if (!chatConfig) return;
      const text = reason === 'model-change'
        ? `✓ Using ${chatConfig.model} now.`
        : reason === 'effort-change'
        ? `✓ Effort is ${chatConfig.effort} now.`
        : `✓ Ready.`;
      const threadId = entry.threadId || undefined;
      tg(bot, 'sendMessage', {
        chat_id: chatId, text,
        ...(threadId && { message_thread_id: threadId }),
      }, { source: 'respawn-confirm', botName: BOT_NAME }).catch(() => {});
    },
  });

  console.log(`polygram (LRU cap=${cap}, SQLite source of truth)`);
  console.log(`Chats: ${Object.entries(config.chats).map(([id, c]) => `${c.name} (${c.model}/${c.effort})`).join(', ')}`);

  bot = createBot(config.bot.token);

  // Graceful shutdown: stop accepting new inbound, drain in-flight pendings
  // up to SHUTDOWN_DRAIN_MS, then mark anything still unfinished so boot
  // replay picks it up. Prevents "Sorry, I couldn't process that message"
  // from showing on every restart.
  const SHUTDOWN_DRAIN_MS = 30_000;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    // 1. Stop accepting new inbound first so nothing new queues behind the drain.
    if (bot && bot._stop) bot._stop();

    // 2. Drain in-flight handlers. Wait for inFlightHandlers to empty or
    //    SHUTDOWN_DRAIN_MS to elapse. pm handlers resolve naturally when
    //    result events arrive; the dispatcher's .finally decrements.
    const drainStart = Date.now();
    while (inFlightHandlers.size > 0) {
      if (Date.now() - drainStart >= SHUTDOWN_DRAIN_MS) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const drainElapsed = Date.now() - drainStart;
    let remaining = 0;
    for (const n of inFlightHandlers.values()) remaining += n;

    // 3. Anything still in-flight → mark in DB as replay-pending so the
    //    next polygram boot re-dispatches it. User never sees an error.
    if (remaining > 0 && db) {
      try {
        const res = db.markReplayPending({ botName: BOT_NAME });
        dbWrite(() => db.logEvent('shutdown-drain', {
          bot: BOT_NAME,
          in_flight: remaining,
          replay_marked: res?.changes ?? 0,
          elapsed_ms: drainElapsed,
        }), 'log shutdown-drain');
        console.log(`[shutdown] drained ${drainElapsed}ms, ${remaining} still in-flight, ${res?.changes ?? 0} rows marked replay-pending`);
      } catch (err) {
        console.error(`[shutdown] markReplayPending failed: ${err.message}`);
      }
    } else if (db) {
      dbWrite(() => db.logEvent('shutdown-drain', {
        bot: BOT_NAME,
        in_flight: 0,
        elapsed_ms: drainElapsed,
      }), 'log shutdown-drain');
      console.log(`[shutdown] clean drain in ${drainElapsed}ms`);
    }

    // 4. Remaining shutdown: approvals sweeper, IPC, resolve hook waiters,
    //    kill pm subprocesses, close DB.
    if (approvalSweepTimer) clearInterval(approvalSweepTimer);
    if (ipcCloser) ipcCloser.close().catch(() => {});
    try { fs.unlinkSync(ipcServer.secretPathFor(BOT_NAME)); } catch {}
    for (const list of approvalWaiters.values()) {
      for (const fn of list) { try { fn('cancelled', 'polygram shutting down'); } catch {} }
    }
    approvalWaiters.clear();
    if (pm) await pm.shutdown().catch(() => {});
    if (db) {
      try { db.logEvent('polygram-stop'); db.raw.close(); } catch {}
    }
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Fresh per-boot secret, persisted 0600 for same-UID readers (cron
    // scripts, hook); also exported to spawned Claude processes via env.
    const ipcSecret = ipcServer.writeSecret(BOT_NAME);
    process.env.POLYGRAM_IPC_SECRET = ipcSecret;
    ipcCloser = await ipcServer.start({
      path: ipcServer.socketPathFor(BOT_NAME),
      secret: ipcSecret,
      handlers: {
        approval_request: handleApprovalRequest,
        ping: async () => ({ pong: true, bot: BOT_NAME }),
        send: (req) => handleSendOverIpc(req),
      },
      logger: console,
    });
  } catch (err) {
    console.error(`[ipc] failed to start: ${err.message}`);
  }
  approvalSweepTimer = startApprovalSweeper();

  // Boot replay: re-dispatch any inbound turns that were interrupted by
  // the previous polygram's shutdown or crash. These are rows marked
  // 'dispatched', 'processing', or 'replay-pending' (set by the SIGTERM
  // handler) — all within the last 30 min so we don't resurrect ancient
  // work. Dedupe against already-sent outbound replies in case the
  // previous instance DID answer before dying.
  try {
    const chatIds = Object.keys(config.chats);
    if (chatIds.length > 0) {
      const candidates = db.getReplayCandidates({ chatIds });
      let replayed = 0;
      let skipped = 0;
      for (const row of candidates) {
        if (db.hasOutboundReplyTo({ chat_id: row.chat_id, msg_id: row.msg_id })) {
          // Already replied — just mark so we don't look at it again.
          db.setInboundHandlerStatus({
            chat_id: row.chat_id, msg_id: row.msg_id, status: 'replied',
          });
          skipped += 1;
          continue;
        }
        // Reconstruct a minimal grammy-like Message object. Enough for
        // dispatchRegularMessage (mention detect, abort, admin cmds,
        // shouldHandle, enqueue). Attachments carry file_ids so the
        // normal download path re-fetches on replay.
        const reconstructed = {
          chat: { id: Number(row.chat_id), type: row.chat_id.startsWith('-') ? 'supergroup' : 'private' },
          message_id: row.msg_id,
          from: { id: row.user_id, first_name: row.user },
          text: row.text || '',
          date: Math.floor(row.ts / 1000),
          ...(row.thread_id && { message_thread_id: Number(row.thread_id) }),
          ...(row.reply_to_id && { reply_to_message: { message_id: row.reply_to_id } }),
        };
        // Attach already-extracted attachments via the media-group shortcut
        // field so extractAttachments picks them up without re-parsing
        // grammy fields that don't exist on this reconstructed object.
        if (row.attachments_json) {
          try {
            reconstructed._mergedAttachments = JSON.parse(row.attachments_json);
          } catch {}
        }
        const chatConfig = config.chats[row.chat_id];
        if (!chatConfig) { skipped += 1; continue; }
        const sessionKey = getSessionKey(row.chat_id, row.thread_id, chatConfig);
        dispatchHandleMessage(sessionKey, row.chat_id, reconstructed, bot);
        replayed += 1;
      }
      if (candidates.length > 0) {
        console.log(`[replay] ${replayed} turns re-dispatched, ${skipped} skipped (already replied or no chat config)`);
        dbWrite(() => db.logEvent('replay-on-boot', {
          bot: BOT_NAME, replayed, skipped, total: candidates.length,
        }), 'log replay-on-boot');
      }
    }
  } catch (err) {
    console.error(`[replay] boot replay failed: ${err.message}`);
  }

  console.log(`[${BOT_NAME}] Starting...`);
  const pollPromise = pollBot(bot).catch(err => {
    console.error(`[${BOT_NAME}] Fatal:`, err.message);
  });

  const watchdogTimer = startPollWatchdog(bot);
  process.once('exit', () => clearInterval(watchdogTimer));

  await pollPromise;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
