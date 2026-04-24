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
const { drainQueuesForChat: drainQueuesForChatImpl } = require('./lib/queue-utils');
const { sweepInbox } = require('./lib/inbox');
const { parseBotArg, parseDbArg, filterConfigToBot } = require('./lib/config-scope');
const { createStore: createPairingsStore, parseTtl: parsePairingTtl } = require('./lib/pairings');
const { transcribe: transcribeVoice, isVoiceAttachment } = require('./lib/voice');
const { createStreamer } = require('./lib/stream-reply');
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
let streamers = new Map();  // sessionKey -> active Streamer (while turn is in flight)

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

async function sendToProcess(sessionKey, prompt) {
  const entry = await getOrSpawnForChat(sessionKey);
  if (!entry) throw new Error('No process for chat');
  const chatId = getChatIdFromKey(sessionKey);
  const chatConfig = config.chats[chatId];
  const timeoutMs = (chatConfig.timeout || config.defaults.timeout) * 1000;
  return pm.send(sessionKey, prompt, { timeoutMs });
}

// ─── Message queue (per-chat) ───────────────────────────────────────

const queues = {};
const processing = {};
const MAX_QUEUE_DEPTH = 50; // per chat — cron storm or spammer insurance

async function enqueue(sessionKey, chatId, msg, bot) {
  if (!queues[sessionKey]) queues[sessionKey] = [];
  if (queues[sessionKey].length >= MAX_QUEUE_DEPTH) {
    // Drop oldest rather than rejecting newest — the user's freshest
    // intent is more valuable than backlog. Emit an event so operators
    // see this rather than a queue silently degrading.
    queues[sessionKey].shift();
    dbWrite(() => db.logEvent('queue-overflow', {
      chat_id: chatId, session_key: sessionKey, cap: MAX_QUEUE_DEPTH,
    }), 'log queue-overflow');
  }
  queues[sessionKey].push({ msg, bot, chatId });
  if (!processing[sessionKey]) processQueue(sessionKey);
}

async function processQueue(sessionKey) {
  processing[sessionKey] = true;
  while (queues[sessionKey]?.length > 0) {
    const { msg, bot, chatId } = queues[sessionKey].shift();
    try {
      await handleMessage(sessionKey, chatId, msg, bot);
    } catch (err) {
      // Raw err.message can carry host paths, DB columns, internal state.
      // Surface a generic message to the user; log the detail to events
      // so operators can still debug.
      console.error(`[${sessionKey}] Error:`, err.message);
      dbWrite(() => db.logEvent('handler-error', {
        chat_id: chatId, session_key: sessionKey,
        msg_id: msg?.message_id,
        error: err.message?.slice(0, 500),
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      }), 'log handler-error');
      try {
        await tg(bot, 'sendMessage', {
          chat_id: chatId,
          text: `Sorry, I couldn't process that message. The operator has been notified.`,
          reply_parameters: { message_id: msg.message_id },
        }, { source: 'error-reply', botName: BOT_NAME });
      } catch (replyErr) {
        console.error(`[${sessionKey}] failed to send error reply: ${replyErr.message}`);
      }
    }
  }
  processing[sessionKey] = false;
}

const drainQueuesForChat = (chatId) => drainQueuesForChatImpl(queues, chatId);

// ─── Typing indicator ───────────────────────────────────────────────

function startTyping(bot, chatId, threadId) {
  const opts = threadId ? { message_thread_id: threadId } : {};
  const send = () => bot.api.sendChatAction(chatId, 'typing', opts).catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

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
      const droppedModel = drainQueuesForChat(chatId);
      if (droppedModel) dbWrite(() => db.logEvent('queue-drained', { chat_id: chatId, reason: 'model-change', dropped: droppedModel }), 'log queue-drained');
      await pm.killChat(chatId);
      const ver = MODEL_VERSIONS[newModel] || newModel;
      await sendReply(`Model → ${newModel} (${ver})`);
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
      const droppedEffort = drainQueuesForChat(chatId);
      if (droppedEffort) dbWrite(() => db.logEvent('queue-drained', { chat_id: chatId, reason: 'effort-change', dropped: droppedEffort }), 'log queue-drained');
      await pm.killChat(chatId);
      await sendReply(`Effort → ${newEffort}`);
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
  const stopTyping = startTyping(bot, chatId, threadId);

  const botCfg = config.bot || {};
  const streamEnabled = botCfg.streamReplies === true;
  const outMetaBase = {
    source: streamEnabled ? 'bot-reply-stream' : 'bot-reply',
    botName: BOT_NAME,
    model: chatConfig.model,
    effort: chatConfig.effort,
  };

  let streamer = null;
  if (streamEnabled) {
    streamer = createStreamer({
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
          return await bot.api.editMessageText(chatId, messageId, text);
        } catch (err) {
          // Stream-edit failures would otherwise be invisible — edits bypass
          // tg() so there's no messages row reflecting the attempt. Log to
          // events so stuck streams leave a forensic trail.
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
    streamers.set(sessionKey, streamer);
  }

  try {
    const result = await sendToProcess(sessionKey, prompt);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    stopTyping();

    if (result.error) {
      console.error(`[${label}] Error (${elapsed}s):`, result.error);
      if (!result.text) return;
    }

    if (!result.text || result.text === 'NO_REPLY') return;

    const parsed = parseResponse(result.text);
    const outMeta = { ...outMetaBase, sessionId: result.sessionId, costUsd: result.cost };

    // Streamed text path: finalise the live-edit and, if the full response
    // overflows Telegram's 4096 cap, send remainder as follow-up chunks.
    if (streamer && parsed.text) {
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
  } catch (err) {
    if (streamer) {
      // Generic suffix — err.message can leak internal paths/state.
      await streamer.finalize('', { errorSuffix: 'stream interrupted' }).catch(() => {});
    }
    throw err;
  } finally {
    stopTyping();
    if (streamer) streamers.delete(sessionKey);
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

    const rawText = ctx.message.text || '';
    const cleanText = mentionRe ? rawText.replace(mentionRe, '').trim() : rawText.trim();

    const botAllowsCommands = !!config.bot?.allowConfigCommands;
    const isAdminCmd = botAllowsCommands && ADMIN_CMD_RE.test(cleanText);
    const isPairClaim = PAIR_CLAIM_RE.test(cleanText);
    if (isAdminCmd || isPairClaim) {
      ctx.message.text = cleanText;
      const threadId = ctx.message.message_thread_id?.toString();
      const sessionKey = getSessionKey(chatId, threadId, chatConfig);
      await handleMessage(sessionKey, chatId, ctx.message, bot);
      return;
    }

    if (!shouldHandle(ctx.message, chatConfig, botUsername)) return;

    if (botUsername) {
      ctx.message.text = cleanText;
    }

    const threadId = ctx.message.message_thread_id?.toString();
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);

    await enqueue(sessionKey, chatId, ctx.message, bot);
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

  let offset = 0;
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
    onStreamChunk: (sessionKey, partial) => {
      const s = streamers.get(sessionKey);
      if (s) s.onChunk(partial).catch(() => {});
    },
  });

  console.log(`polygram (LRU cap=${cap}, SQLite source of truth)`);
  console.log(`Chats: ${Object.entries(config.chats).map(([id, c]) => `${c.name} (${c.model}/${c.effort})`).join(', ')}`);

  bot = createBot(config.bot.token);

  const shutdown = () => {
    console.log('\nShutting down...');
    if (bot && bot._stop) bot._stop();
    if (approvalSweepTimer) clearInterval(approvalSweepTimer);
    if (ipcCloser) ipcCloser.close().catch(() => {});
    try { fs.unlinkSync(ipcServer.secretPathFor(BOT_NAME)); } catch {}
    // Resolve any blocked hook waiters so Claude processes don't hang.
    for (const list of approvalWaiters.values()) {
      for (const fn of list) { try { fn('cancelled', 'polygram shutting down'); } catch {} }
    }
    approvalWaiters.clear();
    if (pm) pm.shutdown().catch(() => {});
    if (db) {
      try { db.logEvent('polygram-stop'); db.raw.close(); } catch {}
    }
    setTimeout(() => process.exit(0), 1000);
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
