#!/usr/bin/env node
/**
 * Telegram Bridge for Claude Code — Persistent Sessions
 *
 * Each chat gets a long-lived `@anthropic-ai/claude-agent-sdk` Query
 * held warm in lib/process-manager-sdk.js. No cold start; full prompt
 * caching across turns.
 *
 * Architecture:
 *   Telegram (grammy long-poll) → polygram receives message
 *   → looks up per-chat config (model, effort, agent, cwd)
 *   → routes to the per-chat Query via pm.send / pm.injectUserMessage
 *   → streams the assistant reply back to the chat live
 *   → writes every in/out message to per-bot SQLite (source of truth)
 *
 * Chat commands: /model, /effort, /config, /context, /compact,
 *                /new, /reset, /reload, /agent, /stop.
 */

'use strict';

const { Bot } = require('grammy');
const fs = require('fs');
const path = require('path');
const processGuard = require('./lib/process-guard');
const dbClient = require('./lib/db');
const {
  migrateJsonToDb, getClaudeSessionId, resolveSessionForSpawn,
} = require('./lib/db/sessions');
const { buildPrompt } = require('./lib/prompt');
const { filterAttachments, resolveFileCaps, MAX_TOTAL_BYTES } = require('./lib/attachments');
// 0.9.0: SDK ProcessManager is the only pm. CLI pm
// (lib/process-manager.js) deleted in commit 6.
// Both implementations expose the same public API (constructor +
// callbacks), so the rest of polygram.js doesn't branch beyond the
// pick-at-startup. Phase 4 deletes the CLI version after Phase 5
// soak proves SDK stable. See docs/0.8.0-architecture-decisions.md.
// 0.10.0: ProcessManager is generic (collection + LRU + dispatch).
// Process subclasses (SdkProcess now, TmuxProcess in Phase 2) provide
// per-session mechanics. The pre-0.10.0 monolithic ProcessManagerSdk
// is deleted; SdkProcess inherits its per-entry guts.
const { ProcessManager } = require('./lib/process-manager');
const { createProcessFactory, pickBackend } = require('./lib/process/factory');
const { extractAssistantText } = require('./lib/process/sdk-process');
// 0.11.0: channels backend tool dispatcher — adapts CliProcess's reply
// tool callback into polygram's existing chunkText + deliverReplies primitives.
// ADV-14: chunkMarkdownText (fence-aware) is imported once below (~line 88)
// and reused by createChannelsToolDispatcher inside main() — Claude replies
// containing code blocks or HTML-style tags aren't split mid-element by the
// size cap.
const { createChannelsToolDispatcher } = require('./lib/process/channels-tool-dispatcher');
const { createTmuxRunner } = require('./lib/tmux/tmux-runner');
const { sweepTmuxOrphans } = require('./lib/tmux/orphan-sweep');
// rc.42: autosteer-buffer module deleted. Native SDK priority push
// (pm.injectUserMessage) replaces the buffer + PostToolBatch detour.
const { createAutosteeredRefs } = require('./lib/autosteered-refs');
const { createBuildSdkOptions } = require('./lib/sdk/build-options');
const { createSdkCallbacks } = require('./lib/sdk/callbacks');
const { createQuestionStore } = require('./lib/questions/store');
const { createQuestionHandlers } = require('./lib/handlers/questions');
const { isRewindCommand, createRewindHandler } = require('./lib/rewind/rewind');
const { createRewindExecutor } = require('./lib/rewind/execute');
const { createTranscribeVoiceAttachments } = require('./lib/handlers/voice');
const { createDownloadAttachments } = require('./lib/handlers/download');
const { createHandleConfigCallback } = require('./lib/handlers/config-callback');
const { createHandleAbort } = require('./lib/handlers/abort');
const { createAutosteerHandlers } = require('./lib/handlers/autosteer');
const { createEditCorrectionInjector } = require('./lib/handlers/edit-correction');
const { createEditRedelivery } = require('./lib/handlers/edit-redelivery');
const { createGateInbound } = require('./lib/handlers/gate-inbound');
const { createRedeliver } = require('./lib/handlers/redeliver');
const { createDropRedeliverer } = require('./lib/handlers/drop-redeliver');
const { createSessionFeedback } = require('./lib/feedback/session-feedback');
const { createSlashCommands } = require('./lib/handlers/slash-commands');
const { createApprovals } = require('./lib/handlers/approvals');
const { canonicalizeToolInput } = require('./lib/canonical-json');
const {
  buildApprovalKeyboardWithAlways,
  formatToolInputForCard,
  approvalCardText,
} = require('./lib/approvals/ui');
const { buildHistoryBlock } = require('./lib/history-preload');
const { formatContextReply, maybeContextFullHint } = require('./lib/context-format');
// appendDisplayHint moved with buildSdkOptions extraction (commit 18) —
// only consumer of that import is now lib/sdk/build-options.js itself.
const { createAbortGrace } = require('./lib/abort-grace');
const agentLoader = require('./lib/agents/loader');
const { createSender } = require('./lib/telegram/api');
const { createAsyncLock } = require('./lib/async-lock');
const { sweepInbox } = require('./lib/db/inbox');
const { parseBotArg, parseDbArg, filterConfigToBot } = require('./lib/config-scope');
const { createStore: createPairingsStore, parseTtl: parsePairingTtl } = require('./lib/db/pairings');
const { transcribe: transcribeVoice, isVoiceAttachment } = require('./lib/telegram/voice');
const { createStreamer } = require('./lib/telegram/streamer');
const { chunkMarkdownText } = require('./lib/telegram/chunk');
// F#23: shared agent-reply helper. parseResponse + sanitizer + chunked
// delivery + inline sticker/react in one place. Wired into both the
// channels dispatcher (F#1) and the autonomous-wakeup handler (F#23).
const { processAndDeliverAgentText } = require('./lib/telegram/process-agent-reply');
const { deliverReplies } = require('./lib/telegram/deliver');
const { sanitizeAssistantReply } = require('./lib/telegram/sanitize-reply');
const { announce, shouldAnnounce } = require('./lib/announces');
const { isAbortRequest } = require('./lib/abort-detector');
const { startTyping } = require('./lib/telegram/typing');
// redactBotToken moved with download extraction (commit 21) — only
// consumer is lib/handlers/download.js.
const { createReactionManager, classifyToolName } = require('./lib/telegram/reactions');
const { createMediaGroupBuffer } = require('./lib/media-group-buffer');
const { applyReactionToMessages } = require('./lib/telegram/album-reactions');
const { classify: classifyError, detectWedgedSessionError, isTransientHttpError } = require('./lib/error/classify');
const { createAutoResumeTracker, isAutoResumable } = require('./lib/db/auto-resume');
const { resolveReplayWindowMs } = require('./lib/db/replay-window');
const { pruneEvents, resolveRetentionPolicy, validatePolicy } = require('./lib/db/events-retention');
// validateIpcFileParam moved with handleSendOverIpc to
// lib/handlers/ipc-send.js (commit 36).
const {
  createStore: createApprovalsStore,
  matchesAnyPattern: matchesApprovalPattern,
  tokensEqual: approvalTokensEqual,
  DEFAULT_TIMEOUT_MS: APPROVAL_DEFAULT_TIMEOUT_MS,
} = require('./lib/approvals/store');
const ipcServer = require('./lib/ipc/server');

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
let PID_PATH = null;          // rc.50: orphan-detection PID file
const STICKERS_PATH = process.env.POLYGRAM_STICKERS
  || path.join(DATA_DIR, 'stickers.json');
const INBOX_DIR = process.env.POLYGRAM_INBOX || path.join(DATA_DIR, 'inbox');
const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || path.join(process.env.HOME || '', '.npm-global/bin/claude');
const CHILD_HOME = process.env.POLYGRAM_CHILD_HOME || process.env.HOME || '';
const TG_MAX_LEN = 4096;
// 0.9.0-rc.6: chunker budget is intentionally lower than TG_MAX_LEN to
// leave HTML headroom. toTelegramHtml converts markdown to HTML for
// parse_mode=HTML — that conversion adds <b>/<i>/<code>/<a> tags and
// entity-escapes &/</> chars, inflating length by ~10-15% for realistic
// markdown. 2026-05-11 incident proved a 4044-char chunk inflated to
// 4506 HTML chars and Telegram rejected. 3500 raw → max ~4030 HTML on
// observed inputs, with headroom for adversarial code-heavy text.
// Override via POLYGRAM_CHUNK_BUDGET if your traffic profile differs.
const TG_CHUNK_BUDGET = Number.parseInt(process.env.POLYGRAM_CHUNK_BUDGET, 10) || 3500;
const DEFAULT_MAX_WARM_PROCS = 10;

let stickerMap = {}; // name → file_id
let emojiToSticker = {}; // emoji → file_id

let config;
let db;
let tg; // unified sender, created after db opens
let pairings; // pairings store, created after db opens
let approvals; // approvals store, created after db opens
// approvalWaiters Map moved to lib/handlers/approvals.js (commit 29).
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
// name starts with that string. (filterEnv + lists moved to
// lib/sdk/build-options.js with the buildSdkOptions extraction.)

// Config helpers extracted to lib/config.js. Thin wrappers below
// keep the existing call shape — polygram.js owns the module-level
// `config` / `stickerMap` / `emojiToSticker` and assigns from the
// pure I/O functions.
const configIO = require('./lib/config');
const { isWellFormedMessage, isWellFormedCallbackQuery } = configIO;

function loadConfig() { config = configIO.loadConfig(CONFIG_PATH); }
function saveConfig() {
  configIO.saveConfig({ configPath: CONFIG_PATH, botName: BOT_NAME, config });
}
function loadStickers() {
  const { stickerMap: m, emojiToSticker: e } = configIO.loadStickers(STICKERS_PATH);
  Object.assign(stickerMap, m);
  Object.assign(emojiToSticker, e);
}

// ─── Session key — moved to lib/session-key.js so tests can import it. ─
const {
  getSessionKey,
  getChatIdFromKey,
  getThreadIdFromKey,
  getTopicName,
  getTopicConfig,
} = require('./lib/session-key');

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

// ─── DB writes (best-effort wrapper, never throws) ──────────────────

function dbWrite(fn, context) {
  if (!db) return;
  try { fn(); } catch (err) {
    console.error(`[db] ${context} failed: ${err.message}`);
  }
}

// 0.7.4 (item I): per-chat allowlist of available reactions.
//
// Telegram groups can restrict which emojis members may use as
// reactions via `available_reactions`. When the bot is in such a group
// and tries to apply a reaction outside the allowlist, the API returns
// REACTION_INVALID and the user sees no progress signal at all.
//
// We probe via getChat() once per chat (cached forever — admins rarely
// change the setting and we'll learn of changes the next bot restart),
// derive the allowlist (or null = "default Telegram set, no
// restriction"), and pass it into createReactionManager so resolveEmoji
// can pick the best-allowed emoji from each state's chain.
const reactionAllowlistCache = new Map();
async function getReactionAllowlist(bot, chatId) {
  if (reactionAllowlistCache.has(chatId)) return reactionAllowlistCache.get(chatId);
  let allowlist = null;
  try {
    const chat = await bot.api.getChat(chatId);
    const ar = chat?.available_reactions;
    // Telegram returns:
    //   - undefined / { type: 'all' }  → no restriction (all emojis allowed)
    //   - { type: 'some', reactions: [{type, emoji}, ...] } → restricted
    //   - { type: 'none' }              → reactions disabled entirely
    if (ar?.type === 'some' && Array.isArray(ar.reactions)) {
      allowlist = new Set(ar.reactions
        .filter((r) => r?.type === 'emoji' && r.emoji)
        .map((r) => r.emoji));
    } else if (ar?.type === 'none') {
      // Empty set — resolveEmoji will return null, the apply callback
      // will short-circuit, and we won't waste API calls on a chat
      // where reactions can't render at all.
      allowlist = new Set();
    }
    // 'all' / undefined → leave allowlist null (chain[0] always wins).
  } catch (err) {
    console.error(`[reactions] getChat ${chatId} failed: ${err.message}`);
    // On failure, cache null (assume default set) so we don't retry on
    // every turn. A bot restart re-probes.
  }
  reactionAllowlistCache.set(chatId, allowlist);
  return allowlist;
}

// Convenience for the most common dbWrite pattern: log an event.
// Pre-0.6.9 every call site was dbWrite(() => db.logEvent(KIND, {...}),
// `log ${KIND}`) — three repeated lines for one logical operation.
// This collapses them to logEvent(KIND, {...}). Same best-effort
// semantics; never throws.
function logEvent(kind, detail) {
  dbWrite(() => db.logEvent(kind, detail), `log ${kind}`);
}

// recordInbound extracted to lib/handlers/record-inbound.js. Wired
// in main() once db + config + extractAttachments are available.
let recordInbound = null;


// ─── Attachment extraction ──────────────────────────────────────────
// extractAttachments + shortFileTag live in lib/handlers/extract-attachments.js.
// sanitizeFilename moved with downloadAttachments to lib/handlers/download.js.
const { extractAttachments } = require('./lib/handlers/extract-attachments');
const { createRecordInbound } = require('./lib/handlers/record-inbound');
const { createHandleSendOverIpc } = require('./lib/handlers/ipc-send');
const { createDispatcher } = require('./lib/handlers/dispatcher');
const { createPollLoop } = require('./lib/handlers/poll');

// transcribeVoiceAttachments extracted to lib/handlers/voice.js.
// Wired in main() once db + tg + config are available.
let transcribeVoiceAttachments = null;

// downloadAttachments extracted to lib/handlers/download.js. Wired
// in main() once config + db + dbWrite + INBOX_DIR are available.
let downloadAttachments = null;


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

function formatPrompt(msg, sessionCtx, attachments = [], { sessionKey = null } = {}) {
  const chatId = msg.chat.id.toString();
  const threadId = msg.message_thread_id?.toString() || '';
  const chatConfig = config.chats[chatId];
  const topicName = threadId ? getTopicName(chatConfig, threadId) : '';

  // rc.52: when the upcoming Query has no resume target (fresh
  // session — daemon boot, /new, /reset, first-ever message in a
  // chat/topic), prepend a `<polygram-history>` block so the fresh
  // session has continuity instead of starting blank. Replaces the
  // dead SessionStart hook (registered into `Options.hooks.SessionStart`
  // since rc.21 but never fired — the SDK runtime doesn't dispatch
  // user-defined hooks for that event, only CLI settings.json shell
  // hooks).
  let polygramHistory = '';
  if (sessionKey && db) {
    const existingSessionId = getClaudeSessionId(db, sessionKey);
    if (!existingSessionId) {
      try {
        polygramHistory = buildHistoryBlock({
          db,
          chatId,
          threadId: threadId || null,
          // Per-topic sessions must only preload their OWN thread — else a message
          // in one topic gets fed other topics' history (2026-06-09 cross-topic bleed).
          isolateTopics: chatConfig?.isolateTopics === true,
          excludeMsgId: msg.message_id,
          logger: console,
        });
        if (polygramHistory) {
          logEvent('history-preloaded', {
            chat_id: chatId,
            thread_id: threadId || null,
            text_len: polygramHistory.length,
            session_source: 'fresh',
          });
        }
      } catch (err) {
        console.error(`[history-preload] buildHistoryBlock failed: ${err?.message || err}`);
      }
    }
  }

  return buildPrompt({
    msg,
    topicName,
    sessionCtx,
    attachments,
    replyTo: resolveReplyTo(msg),
    polygramHistory,
  });
}

// ─── Persistent Claude Process per chat (LRU-bounded) ───────────────

let pm = null; // ProcessManager, created in main()

// 0.8.0-rc.42: autosteer buffer + stale-drain DELETED. Replaced by
// pm.injectUserMessage() with native SDK priority hints. The U7 spike
// (scripts/spikes/native-queue.mjs, 2026-05-01) verified all three
// SDK priorities ('now' / 'next' / 'later') work cleanly without
// m87 rejection. The buffer/hook detour was a workaround for a
// problem the SDK no longer has.
//
// What used to live here: createAutosteerBuffer + makePostToolBatchHook
// + drainStaleAutosteerBuffer. The buffer kept user follow-ups that
// arrived mid-turn; the PostToolBatch hook drained them into
// `additionalContext` (with the <channel source="user-followup"> Channels-
// MCP framing) on each tool boundary; the stale-drain handled the
// edge case where a turn ended with zero tool calls (no hook fire,
// followups would otherwise be lost). All three are obsolete with
// native priority push.
//
// Kept: autosteeredRefs — still tracks msg_ids that received the ✍
// AUTOSTEERED ack so the trigger turn's success path can clear them.
const autosteeredRefs = createAutosteeredRefs({
  applyClear: async ({ chatId, msgId }) => {
    if (!bot) return;
    await tg(bot, 'setMessageReaction', {
      chat_id: chatId, message_id: msgId, reaction: [],
    }, { source: 'autosteer-clear', botName: BOT_NAME });
  },
  logger: { error: (m) => console.error(`[${BOT_NAME}] ${m}`) },
});

async function clearAutosteeredReactions(sessionKey) {
  return autosteeredRefs.clear(sessionKey);
}

// SDK pm spawn factory — extracted to lib/sdk/build-options.js.
// `buildSdkOptions` is wired in main() via createBuildSdkOptions(deps)
// once the runtime context (config, BOT_NAME, makeCanUseTool, logEvent)
// is available.
let buildSdkOptions = null;

function buildSpawnContext(sessionKey) {
  const chatId = getChatIdFromKey(sessionKey);
  const chatConfig = config.chats[chatId];
  if (!chatConfig) return null;
  const threadId = sessionKey.includes(':') ? sessionKey.split(':')[1] : null;

  // S2: a stored session is valid ONLY for the config it was spawned
  // under. agent / cwd are spawn-identity — baked into the process at
  // spawn time, never mutable on a live session. Resolve them the
  // same way the backends do (topic override merged over chat-level)
  // and compare to the stored `sessions` row. On drift,
  // resolveSessionForSpawn drops the stale row and returns
  // existingSessionId:null → the spawn starts fresh under the correct
  // config instead of `--resume`-ing a stale one. This self-heals the
  // pre-per-topic-config rows (e.g. shumorobot's Music topic :3,
  // stored agent=shumabit / cwd=$HOME vs the current
  // music-curation:music-curator / .../Music/rekordbox).
  // model/effort are NOT compared — they apply live via setModel /
  // applyFlagSettings with no respawn. pm_backend is also NOT
  // compared (rc.32): both backends spawn the same pinned claude
  // binary against the same on-disk JSONL, so a backend flip
  // preserves context. See lib/db/sessions.js for full reasoning.
  //
  // The drift check runs only at COLD spawn (no warm process). A warm
  // process already runs under its spawn-time config; getOrSpawn
  // returns it without using this context, so dropping its row here
  // would be premature — defer to the next cold spawn.
  const isColdSpawn = !pm || !pm.has(sessionKey) || pm.get(sessionKey)?.closed;
  let existingSessionId;
  if (isColdSpawn) {
    const topicConfig = getTopicConfig(chatConfig, threadId || null);
    const resolved = {
      agent: topicConfig.agent || chatConfig.agent || null,
      cwd: topicConfig.cwd || chatConfig.cwd || null,
      backend: pickBackend({ config, chatId, threadId: threadId || null }),
    };
    const r = resolveSessionForSpawn(db, sessionKey, resolved);
    existingSessionId = r.existingSessionId;
    if (r.drift) {
      logEvent('session-config-drift', {
        chat_id: chatId,
        thread_id: threadId || null,
        session_key: sessionKey,
        fields: r.drift.fields,
        before: r.drift.before,
        after: r.drift.after,
      });
    }
  } else {
    existingSessionId = getClaudeSessionId(db, sessionKey);
  }

  return {
    chatConfig,
    chatId,
    threadId: threadId || null,
    label: getSessionLabel(chatConfig, threadId),
    existingSessionId,
    // File-send outbound cap inputs: localApi (bot-level) so CliProcess can
    // resolve the per-chat/topic outbound cap (resolveFileCaps) the same way
    // it resolves cwd/agent. Override itself lives in chatConfig/topic.
    localApi: !!config.bot?.apiRoot,
  };
}

async function getOrSpawnForChat(sessionKey) {
  const ctx = buildSpawnContext(sessionKey);
  if (!ctx) return null;
  return pm.getOrSpawn(sessionKey, ctx);
}

async function sendToProcess(sessionKey, prompt, context = {}, { onDispatched } = {}) {
  const entry = await getOrSpawnForChat(sessionKey);
  if (!entry) throw new Error('No process for chat');
  const chatId = getChatIdFromKey(sessionKey);
  const chatConfig = config.chats[chatId];
  const timeoutMs = (chatConfig.timeout || config.defaults.timeout) * 1000;
  const maxTurnMs = (chatConfig.maxTurn || config.defaults?.maxTurn || 1800) * 1000;

  // 0.12 Phase 2.1: HeartbeatReactor binding removed for CliProcess.
  // 0.11.0-channels needed a random-cycling working-pool reactor because
  // the channels protocol gave no per-tool visibility. CliProcess (0.12)
  // now emits per-tool 'tool-use' events from hook PreToolUse (Phase 1.3),
  // so the standard rc.32 reactor cascade (THINKING → THINKING_DEEPER →
  // THINKING_DEEPEST → STALL + per-tool emoji from classifyToolName) drives
  // the reaction surface uniformly with SDK + tmux backends. Same UX, no
  // backend-specific wiring. heartbeat-reactor.js stays in tree until
  // Phase 4 deletion alongside other channels-specific dead code.

  // Hold the per-session lock across the FULL turn (write + result wait),
  // not just the stdin write. Claude's stream-json input mode batches any
  // user messages that arrive while a turn is in flight into the next
  // turn — so writing pendingB's prompt while pendingA is still being
  // worked on causes Claude to batch B+C and emit ONE result for them,
  // leaving pendingC stuck forever (reactor stuck on 👀, reply mis-routed,
  // 10-min idle timer eventually fires for the orphan).
  //
  // We tested this directly: 3 user messages written rapidly produced
  // result#1="A" and result#2="B\nC" — pending#3 never got a result.
  //
  // Holding the lock across the whole turn means Claude never has more
  // than one user message in its stdin buffer at once, so it can't batch.
  // Cost: slight latency for back-to-back user messages — the second one
  // waits for the first turn to finish before starting. The reactor on
  // the queued message stays at 👀 (QUEUED) until its turn actually
  // starts, which is the correct UX (and what the user already expects).
  const release = await stdinLock.acquire(sessionKey);
  try {
    const turnP = pm.send(sessionKey, prompt, { timeoutMs, maxTurnMs, context });
    // Phase 3 §4: pm.send synchronously kicks off the turn — the
    // process is now inFlight. Signal the committed-intent latch so
    // it can release; a concurrent handler will then correctly see
    // the live turn and autosteer instead of racing into a 2nd send.
    if (typeof onDispatched === 'function') onDispatched();
    return await turnP;
  } finally {
    release();
  }
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
// dispatcher state. The dispatcher itself (errorReplyText,
// queueWarnThreshold, dispatchHandleMessage, attemptAutoResume,
// inFlightHandlers Map) lives in lib/handlers/dispatcher.js;
// polygram owns the abortGrace + autoResumeTracker instances
// + the isShuttingDown flag and threads them in.
let isShuttingDown = false;
const abortGrace = createAbortGrace();
function markSessionAborted(sessionKey) { abortGrace.mark(sessionKey); }
function isSessionRecentlyAborted(sessionKey) { return abortGrace.isRecent(sessionKey); }
const autoResumeTracker = createAutoResumeTracker();
const contextHintShown = new Set();
let dispatchHandleMessage = null;
let attemptAutoResume = null;
let errorReplyText = null;
let queueWarnThreshold = null;
let inFlightHandlers = null;

// rc.59: once-per-cycle gate for the contextHint. A session is added
// to this Set when the hint fires, removed when the SDK emits
// compact_boundary (so the next cycle can fire its own hint). Without
// this gate, a chat over-threshold would see the hint on every turn
// until auto-compact — noisy enough that Ivan called it out.
// Per-session lock ordering stdin writes. Module is I/O-pure.
const stdinLock = createAsyncLock();

// 0.10.0 Phase 3 §4: committed-intent latch. Serialises the
// autosteer-vs-primary decision per session so a burst of concurrent
// handleMessage calls cannot each independently mis-read `inFlight`
// and all classify themselves as primary. The first to acquire it
// for an idle session commits the primary turn and holds the latch
// until the process is inFlight; later acquirers see the live turn
// and autosteer.
const intentLock = createAsyncLock();

// Typing indicator is imported from lib/typing-indicator — it adds a
// per-chat circuit breaker with exponential backoff so a chat that
// permanently 401s (bot blocked, chat deleted) doesn't have us
// hammering sendChatAction every 4s for the full turn duration.

// ─── Response parsing (stickers, reactions) ─────────────────────────
// Implementation lives in lib/parse-response.js so tests can require it
// without starting a bot (polygram.js is a top-level script that calls
// main() at bottom). The wrapper here supplies the runtime stickerMap /
// emojiToSticker that the parser looks up against.
//
// 0.7.5: parser also recognises a literal `[sticker:NAME]` pattern in
// addition to single-emoji shortcuts. Claude reads its own past outbound
// rows on session resume, sees `[sticker:working]` (the placeholder
// deriveOutboundText synthesises for sendSticker rows), and starts
// mimicking the format as plain text. Without the new branch the
// placeholder was rendered verbatim in the chat instead of swapped for
// the actual sticker.
const {
  parseResponse: parseResponseImpl,
  stripInlineTags: stripInlineTagsImpl,
} = require('./lib/telegram/parse');
function parseResponse(text) {
  return parseResponseImpl(text, { stickerMap, emojiToSticker });
}
// rc.67: pre-processor for the streamer. Strips recognised inline
// `[sticker:NAME]` and any `[react:EMOJI]` tags BEFORE the chunk is
// committed to the bubble + DB row, so the user never sees a literal
// tag even when the turn-end finalize path doesn't manage to clean it
// (interrupt, error, hung query, edit failure, or the stickerMap-miss
// no-op branch). parseResponse continues to surface the same tags in
// `parsed.stickers[]` / `parsed.reactions[]` for outbound dispatch via
// sendInlineStickers / sendInlineReactions.
function stripInlineTagsForStreamer(text) {
  return stripInlineTagsImpl(text, { stickerMap });
}

// ─── Cron/IPC send — extracted to lib/handlers/ipc-send.js ──────────
let handleSendOverIpc = null;

// ─── Approvals ─────────────────────────────────────────────────────
// Pure UI builders live in lib/approval-ui.js for testability.
// Imported above (buildApprovalKeyboardWithAlways, approvalCardText,
// formatToolInputForCard).

// Config card UI moved to lib/handlers/config-ui.js. polygram.js
// keeps a thin formatConfigInfoText wrapper since it needs the
// runtime pm + db + getClaudeSessionId; buildConfigKeyboard is
// pure and re-exported.
const {
  buildConfigKeyboard,
  createFormatConfigInfoText,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_VERSIONS_DESC,
} = require('./lib/handlers/config-ui');
let formatConfigInfoText = null;
// CRITICAL: these placeholders MUST exist or 'use strict' boot fails
// with ReferenceError. v4 review (commit 39) found 4 missing — restored.
// Each handler is wired in main() once its deps exist.
let handleConfigCallback = null;
let handleAbortIfRequested = null;
let autosteer = null;
let dispatchSlashCommand = null;
let maybeInjectEditCorrection = null;
let maybePostTurnEdit = null;
// 0.13 D5/D4: the ONE intake gate (assigned in createBot, where botUsername/
// mentionRe live) + the ONE redelivery tail (assigned in main once the
// dispatcher exists). See lib/handlers/gate-inbound.js / redeliver.js.
let gateInbound = null;
let redeliverAsFreshTurn = null;
let dropRedeliverer = null;   // 0.13 D2→D4 glue; assigned once redeliver exists

// rc.20: approvalCardText + safeParse moved to lib/approvals/ui.js.
// 0.9.0 commit 29: makeCanUseTool / handleApprovalCallback /
// resolveApprovalWaiter / dropWaiter / startApprovalSweeper extracted
// to lib/handlers/approvals.js. Wired in main() once db + bot + tg +
// approvals store are available.
let makeCanUseTool = null;
let handleApprovalCallback = null;
// 0.12 interactive questions — assigned in main() once db.raw + pm exist; the
// createSdkCallbacks onQuestionAsked closure + the callback router read it late.
let questionHandlers = null;
let rewindHandler = null;   // 0.13 /rewind (P1); late-bound, assigned in main() after pm exists
let resolveApprovalWaiter = null;
let startApprovalSweeper = null;
let cancelAllWaiters = null;

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
  // Replays are pre-marked 'replay-attempted' by the boot loop and we
  // must NOT overwrite that — it's the one-shot guard that keeps a
  // failing-mid-flight replay from re-replaying on every subsequent boot.
  if (!msg._isReplay) {
    dbWrite(() => db.setInboundHandlerStatus({
      chat_id: chatId, msg_id: msg.message_id, status: 'dispatched',
    }), 'set handler_status=dispatched');
  }

  const text = msg.text || msg.caption || '';
  const threadId = msg.message_thread_id;
  const threadIdStr = threadId?.toString() || null;
  const label = getSessionLabel(chatConfig, threadIdStr);

  const replyOpts = (tid) => ({
    reply_parameters: { message_id: msg.message_id },
    ...(tid && { message_thread_id: tid }),
  });

  // Single source of truth at module scope (MODEL_VERSIONS_DESC) — see the
  // comment there for the bump procedure.
  const MODEL_VERSIONS = MODEL_VERSIONS_DESC;

  const botAllowsCommands = !!config.bot?.allowConfigCommands;
  const cmdUser = msg.from?.first_name || msg.from?.username || null;
  const cmdUserId = msg.from?.id || null;

  // Mark the inbound row terminal so boot replay doesn't pick it up
  // again. Must fire down EVERY non-throwing exit path (early returns
  // for error / NO_REPLY, streamed-reply preview-becomes-final, the
  // discard+redeliver branch, regular reply at end). Earlier versions
  // only marked at the bottom of try, so streamed-reply early returns
  // left handler_status stuck at 'dispatched' forever and the next
  // boot replayed every long turn.
  //
  // rc.59: hoisted ABOVE sendReply (was originally below all slash
  // commands) so sendReply can call it. Slash commands like /compact
  // /new /reset /model /effort all reply via sendReply but never
  // dispatched a turn, so they were leaving handler_status='dispatched'
  // forever. Boot-replay (now with rc.57's auto-derived 72-min window
  // for chats with maxTurn=3600) would then re-fire the same /compact
  // command — which post-compaction lands in a stale-session state and
  // emits "🗜️ No active session — /compact only works once a turn has
  // started." Visible duplicate-reply UX bug.
  const markReplied = () => dbWrite(() => db.setInboundHandlerStatus({
    chat_id: chatId, msg_id: msg.message_id, status: 'replied',
  }), 'set handler_status=replied');

  // sendReply accepts (text, meta?) with optional extra Telegram params
  // pulled out via meta.params (kept separate so meta stays for DB tags).
  // rc.59: also calls markReplied() so slash-command paths don't leave
  // handler_status='dispatched' for boot-replay to re-fire later. All
  // 29 sendReply call sites in handleMessage are slash-command exit
  // paths — the contract "we sent a response, the inbound is handled"
  // holds for every one of them.
  const sendReply = (replyText, meta = {}) => {
    const { params: extraParams = {}, ...metaTags } = meta;
    markReplied();
    return tg(bot, 'sendMessage', {
      chat_id: chatId, text: replyText, ...replyOpts(threadId), ...extraParams,
    }, { source: 'command-reply', botName: BOT_NAME, model: chatConfig.model, effort: chatConfig.effort, ...metaTags });
  };

  if (botAllowsCommands && (text === '/model' || text === '/config' || text === '/effort')) {
    const show = text === '/effort' ? 'effort' : text === '/model' ? 'model' : 'all';
    // Resolve per-topic overrides so a topic's card shows its REAL
    // agent/model/effort, not the chat-level default — Music topic (thread 3)
    // showed "Agent: shumabit" instead of music-curation:music-curator
    // (2026-06-03). getTopicConfig returns {} when there's no active topic.
    const _cardTopicCfg = getTopicConfig(chatConfig, threadIdStr || null);
    const info = formatConfigInfoText(chatConfig, show, sessionKey, _cardTopicCfg);
    const reply_markup = buildConfigKeyboard(chatConfig, show, _cardTopicCfg);
    await sendReply(info, { params: { reply_markup } });
    return;
  }
  // Slash command dispatch — extracted to lib/handlers/slash-commands.js.
  // Covers /context /compact /reload /new /reset /model /effort
  // /pair-code /pairings /unpair /pair. Returns true when handled;
  // caller short-circuits.
  if (await dispatchSlashCommand({
    text, sessionKey, chatId, threadIdStr, chatConfig,
    cmdUser, cmdUserId, label, sendReply,
  })) return;

  const t0 = Date.now();

  const sessionCtx = !pm.has(sessionKey) ? await readSessionContext(sessionKey, chatConfig.cwd) : '';

  const rawAtts = extractAttachments(msg);
  // Backend-derived inbound cap with per-topic/chat override. Cloud → 20MB;
  // a local Bot API server (config.bot.apiRoot) → 2GB; override via
  // chats[id].maxFileBytes or topics[t].maxFileBytes, clamped to the
  // backend ceiling. Bytes-valued config; resolveFileCaps does the clamp.
  const _inTopicCfg = getTopicConfig(chatConfig, threadIdStr || null);
  const _fileCaps = resolveFileCaps({
    localApi: !!config.bot?.apiRoot,
    override: _inTopicCfg.maxFileBytes ?? chatConfig.maxFileBytes ?? null,
  });
  const { accepted, rejected } = filterAttachments(rawAtts, {
    maxFileBytes: _fileCaps.inBytes,
    maxTotalBytes: Math.max(_fileCaps.inBytes, MAX_TOTAL_BYTES),
  });
  for (const { att, reason } of rejected) {
    console.log(`[${label}] attachment skipped: ${att.name} (${reason})`);
    logEvent('attachment-skipped', { chat_id: chatId, msg_id: msg.message_id, name: att.name, reason });
  }
  const token = config.bot?.token || '';

  // 0.6.0: pull persisted attachment rows (recordInbound inserted them
  // upstream). Filter to the ones that survived filterAttachments.
  // Replays / reconstructed messages may not have inserted rows yet —
  // for that path we fall back to the in-memory `accepted` list. Both
  // shapes have the same fields downloadAttachments consumes (kind,
  // file_id, file_unique_id, name, mime_type) plus optionally `id` /
  // `download_status` / `local_path` for the row variant.
  const messageId = db.getInboundMessageId({ chat_id: chatId, msg_id: msg.message_id });
  const allRows = messageId ? db.getAttachmentsByMessage(messageId) : [];
  const acceptedKeys = new Set(accepted.map((a) => a.file_unique_id || a.file_id));
  let downloadInputs;
  if (allRows.length) {
    downloadInputs = allRows.filter((r) => acceptedKeys.has(r.file_unique_id || r.file_id));
  } else {
    // Fallback for replayed turns where rows weren't persisted: synthesize
    // row-like objects so downloadAttachments treats them as never-tried.
    downloadInputs = accepted.map((a) => ({
      ...a, id: null, size_bytes: a.size,
      download_status: 'pending', local_path: null,
    }));
  }
  const downloaded = downloadInputs.length
    ? await downloadAttachments(bot, token, chatId, msg, downloadInputs)
    : [];
  // Decode JSON-encoded transcription on enriched rows so buildVoiceTags
  // can read .text/.language/.duration_sec/.provider directly.
  for (const a of downloaded) {
    if (typeof a.transcription === 'string' && a.transcription) {
      try { a.transcription = JSON.parse(a.transcription); }
      catch { /* leave as string */ }
    }
  }
  if (rejected.length) {
    const summary = rejected.map(({ att, reason }) => `${att.name}: ${reason}`).join('; ');
    try {
      await tg(bot, 'sendMessage', {
        chat_id: chatId, text: `Attachment(s) skipped: ${summary.slice(0, 300)}`,
        ...replyOpts(threadId),
      }, { source: 'attachment-skipped', botName: BOT_NAME });
    } catch (err) {
      // Surface the failure: claude is about to reply as if the photo
      // was processed (because filterAttachments dropped it before
      // download), and the user would otherwise have no signal that
      // their attachment was rejected. They'd assume claude saw it
      // and is just answering oddly.
      console.error(`[${label}] failed to notify user of skipped attachments: ${err.message}`);
      logEvent('attachment-skip-notice-failed', {
        chat_id: chatId, msg_id: msg.message_id,
        error: err.message?.slice(0, 200),
        rejected_count: rejected.length,
      });
    }
  }

  const voiceAck = await transcribeVoiceAttachments(downloaded, {
    chatId, msgId: msg.message_id, label, botApi: bot, threadId,
  }) || { ackEmitted: false };

  const prompt = formatPrompt(msg, sessionCtx, downloaded, { sessionKey });
  const stopTyping = startTyping({
    bot, chatId, threadId,
    logger: { error: (m) => console.error(`[${label}] ${m}`) },
    onEvent: (e) => logEvent(e.kind, {
      bot: BOT_NAME, chat_id: e.chat_id, ...(e.detail || {}),
    }),
  });

  const botCfg = config.bot || {};
  // 0.7.0: per-chat / per-bot link-preview opt-out (port from OpenClaw).
  // chat-level wins over bot-level. Default (both undefined) preserves
  // Telegram's native auto-preview behavior.
  const linkPreview = chatConfig.linkPreview != null
    ? chatConfig.linkPreview
    : botCfg.linkPreview;
  const outMetaBase = {
    source: 'bot-reply-stream',
    botName: BOT_NAME,
    model: chatConfig.model,
    effort: chatConfig.effort,
    ...(linkPreview === false ? { linkPreview: false } : {}),
  };

  // 0.7.2: only the FIRST bubble in a turn quotes the user's message
  // via reply_parameters. When a tool-heavy turn produces multiple
  // assistant messages (each spawning its own bubble via
  // forceNewMessage), subsequent bubbles shouldn't re-quote the user
  // — the chat would show N copies of the same quoted message stacked
  // vertically. After the first send, the flag flips and subsequent
  // initial-sends omit reply_parameters.
  let firstBubbleSent = false;
  // Streaming is unconditional as of 0.4.0 — matches OpenClaw's model and
  // eliminates the "stuck at 15min typing" complaint from the non-streaming
  // code path. For short responses the streamer stays idle and we fall
  // through to the normal send path via finalize() returning streamed=false.
  const streamer = createStreamer({
    // rc.67: pre-process every chunk to strip recognised
    // [sticker:NAME] / [react:EMOJI] tags BEFORE the bubble or DB row
    // captures them. See stripInlineTagsForStreamer above.
    transformText: stripInlineTagsForStreamer,
    send: async (text) => {
      const params = {
        chat_id: chatId, text,
        ...(threadId && { message_thread_id: threadId }),
      };
      if (!firstBubbleSent) {
        // allow_sending_without_reply: long-running turns give the user
        // plenty of time to delete their original message. Without this
        // flag, Telegram rejects the reply with MESSAGE_NOT_FOUND and the
        // whole streamed answer is lost.
        params.reply_parameters = { message_id: msg.message_id, allow_sending_without_reply: true };
        firstBubbleSent = true;
      }
      return tg(bot, 'sendMessage', params, outMetaBase);
    },
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
        logEvent('telegram-edit-failed', {
          chat_id: chatId, msg_id: messageId,
          api_error: err.message?.slice(0, 200),
          bot: BOT_NAME,
        });
        throw err;
      }
    },
    deleteMessage: async (messageId) => {
      // 0.7.0: route preview-discard through tg() so the action is
      // visible in the events log and gets the same retry/network
      // protections as other API calls. Failure is non-fatal: stale
      // bubble at chat top is acceptable when the actual reply has
      // already been redelivered as fresh chunks.
      try {
        await tg(bot, 'deleteMessage', {
          chat_id: chatId, message_id: messageId,
        }, { source: 'bot-reply-stream-discard', botName: BOT_NAME });
      } catch (err) {
        console.error(`[${label}] discard preview failed: ${err.message}`);
        throw err;
      }
    },
    minChars: botCfg.streamMinChars,
    throttleMs: botCfg.streamThrottleMs,
    // rc.44: preserve intermediate bubbles by default. These are
    // regular text segments the model emits across an agentic
    // multi-step turn ("Let me check..." → tool runs → "Found it.
    // Here's the answer..."). Pre-0.7.2 polygram preserved them;
    // 0.7.2 added archive-and-delete-at-turn-end for terseness.
    // rc.44 reverts to preserve-all (the 0.7.0 default). Per-chat /
    // per-bot opt-out via `preserveIntermediateBubbles: false` for
    // chats where the partner-facing UX wants only the final answer
    // (e.g. UMI Group).
    preserveIntermediateBubbles: chatConfig.preserveIntermediateBubbles != null
      ? chatConfig.preserveIntermediateBubbles
      : (botCfg.preserveIntermediateBubbles != null
        ? botCfg.preserveIntermediateBubbles
        : true),
    logger: { error: (m) => console.error(`[${label}] ${m}`) },
  });
  // streamer is registered with this turn via pm.send's context (below)

  // 0.7.2: clean up bubbles superseded by forceNewMessage() — the
  // intermediate text segments that fired across a tool-heavy turn.
  // Pre-0.7.2 (since 0.7.0 multi-bubble landed) those bubbles were
  // kept; 0.7.2 added cleanup motivated by a post-0.7.1 deploy
  // screenshot of six bubbles per logical turn — terseness goal,
  // NOT OpenClaw porting. (Earlier comments mis-cited OpenClaw
  // parity; the official OpenClaw + pi-telegram model is
  // single-bubble-per-turn edited in place. Polygram's
  // multi-bubble shape is its own decision.)
  // rc.44 made preservation the default again — getArchived()
  // returns [] unless the chat opted out via
  // `preserveIntermediateBubbles: false`. This function still runs
  // unconditionally because the opt-out path needs it to fire.
  // Call AFTER finalize/discard decisions so we never delete the
  // bubble that's the final reply.
  async function cleanupArchivedBubbles() {
    const archived = streamer.getArchived?.() || [];
    if (archived.length === 0) return;
    for (const messageId of archived) {
      try {
        await tg(bot, 'deleteMessage', {
          chat_id: chatId, message_id: messageId,
        }, { source: 'bot-reply-archived-cleanup', botName: BOT_NAME });
      } catch (err) {
        // Non-fatal — message may be >48h old or already gone.
        // Operator-visible only via the events table.
        console.error(`[${label}] archived-cleanup ${messageId}: ${err.message}`);
      }
    }
    logEvent('telegram-archived-cleanup', {
      chat_id: chatId, msg_id: msg.message_id, count: archived.length,
      bot: BOT_NAME,
    });
  }

  // Status reactions on the user's message: 👀 queued → 🤔 thinking →
  // 👨‍💻 coding / ⚡ web / 🔥 tool → 👍 done / 🤯 error. Silent (no
  // notifications), updates in place, one emoji per message. Uses
  // setMessageReaction which skips the DB row (the tg() wrapper
  // short-circuits that method), so no transcript spam.
  // 0.7.4 (item I): probe the chat's available_reactions allowlist on
  // first turn (cached after). resolveEmoji uses this to pick the best
  // emoji from each state's chain that's actually permitted in this
  // group, falling back to a generic set (👍/👀/🔥) before giving up.
  const availableEmojis = await getReactionAllowlist(bot, chatId);
  const reactor = createReactionManager({
    apply: async (emoji) => {
      // rc.16: mirror the reaction onto album siblings too, so a multi-file
      // send shows the same status emoji on EVERY item, not just the anchor.
      // For a normal single message, _albumSiblingMsgIds is undefined and this
      // is exactly the prior single setMessageReaction. Anchor is awaited
      // (failure surfaces to the reactor); siblings are best-effort.
      await applyReactionToMessages({
        tg, bot, chatId,
        msgIds: [msg.message_id, ...(msg._albumSiblingMsgIds || [])],
        emoji,
        botName: BOT_NAME,
      });
    },
    availableEmojis,
    logError: (m) => console.error(`[${label}] ${m}`),
    // rc.39: emit reactor-state events for forensic post-hoc
    // reconstruction of any reaction anomaly (stuck reactions, dual
    // emojis, unexpected ERROR transitions, etc.). Sync callback —
    // logEvent is best-effort and never throws. One row per visible
    // change moment; cascade/stall/freeze auto-promotions get
    // their own `source` value so we can tell apart manual setState
    // calls from timer-driven transitions.
    onStateChange: ({ fromState, toState, fromEmoji, toEmoji, source, ts }) => {
      logEvent('reactor-state', {
        chat_id: chatId,
        msg_id: msg.message_id,
        session_key: sessionKey,
        from_state: fromState,
        to_state: toState,
        from_emoji: fromEmoji,
        to_emoji: toEmoji,
        source,
        ts,
      });
    },
  });
  // 0.12 Phase 2.1: heartbeatSetReaction adapter removed. The 0.11.0-channels
  // HeartbeatReactor is no longer bound (CliProcess uses the standard rc.32
  // reactor cascade); the adapter that fed it is now dead code.

// rc.32: skip QUEUED (👀) entirely for first-message-in-chain. Go
  // straight to THINKING (🤔). The 👀 → 🤔 two-hop didn't add
  // user-readable signal — Telegram's ✓✓ already conveys "delivered",
  // and the technical "received-but-not-started vs thinking"
  // distinction is operator-debugging context, not user UX.
  //
  // Follow-up messages during an in-flight turn still go through the
  // autosteer path (✍ AUTOSTEERED state) — that's the visual that
  // means "captured while bot is busy, will incorporate." This
  // change ONLY affects the trigger message of a fresh turn:
  // previously 👀 → (300ms timer) → 🤔, now just 🤔 immediately.
  //
  // 0.7.4 (item G) voice-ack guard preserved: if 👂 is up from
  // voice transcription, don't overwrite it. Let onFirstStream
  // promote to 🤔 when Claude actually starts work.
  //
  // Skip the 🤔 → ✍ flash for messages that are about to be
  // autosteered. willAutosteer evaluates the same pre-condition
  // tryAutosteer would.
  if (!voiceAck.ackEmitted && !autosteer.willAutosteer(sessionKey, chatConfig)) {
    reactor.setState('THINKING');
  }

  // markReplied hoisted to top of handleMessage in rc.59 (see
  // definition near sendReply for context). Slash commands path
  // through sendReply which now calls it; all the OTHER non-throwing
  // exit paths below (NO_REPLY, streamed-reply preview-becomes-final,
  // discard+redeliver, regular reply at end) call it directly.

  // AUTOSTEER. If session is in-flight AND autosteer isn't disabled,
  // route this user message via pm.injectUserMessage instead of
  // pm.send (OpenClaw "merge into active" UX). The steered message
  // gets a ✍ reaction so the user knows it landed; the in-flight
  // turn's response covers both messages.
  //
  // Mode: chatConfig.autosteerMode = 'merge' (priority='next', default)
  // | 'queue' (priority='later'). Spike findings in
  // scripts/spikes/native-queue.mjs.
  //
  // Reaction emoji must be from Telegram's curated allowlist (~60
  // standard emoji per core.telegram.org/bots/api#availablereactions).
  // 🛞 is NOT on it (400: REACTION_INVALID). ✍ ("writing/noting")
  // is on the list and conveys "incorporating this".
  // 0.10.0 Phase 3 §4: committed-intent latch. The autosteer-vs-
  // primary decision AND the turn dispatch happen inside one
  // per-session critical section. tryAutosteer's `inFlight` read is
  // now reliable: the previous primary held this latch until its
  // pm.send made the process inFlight, so a concurrent burst can no
  // longer mis-classify followups as primary turns.
  const releaseIntent = await intentLock.acquire(sessionKey);
  let steered = { autosteered: false };
  let sendPromise = null;
  try {
    steered = autosteer.tryAutosteer({ sessionKey, chatConfig, chatId, msg, prompt });
    if (!steered.autosteered) {
      // Primary turn. Kick off the dispatch and hold the latch until
      // pm.send has made the process inFlight (onDispatched). The
      // turn RESULT is awaited only AFTER the latch is released — the
      // latch covers the decision + commitment, never the whole turn
      // (that would block every autosteer).
      // Pass streamer + reactor as per-turn context; pm's callbacks
      // pick them off entry.pendingQueue[0].context.
      await new Promise((dispatched) => {
        sendPromise = sendToProcess(sessionKey, prompt, {
          // 0.13 D1 (S8): the typing controller rides the per-turn context so
          // the question lifecycle (callbacks.js onQuestionAsked/-Resumed) can
          // pause it while the bot waits on the USER and resume on the answer.
          streamer, reactor, typing: stopTyping, sourceMsgId: msg.message_id,
          // 0.7.4 (item B): fire THINKING when Claude actually starts
          // emitting — not the moment we wrote stdin.
          onFirstStream: () => reactor.setState('THINKING'),
        }, { onDispatched: dispatched })
          .catch((e) => ({ __sendError: e }))
          .finally(dispatched);
      });
    }
  } finally {
    releaseIntent();
  }
  if (steered.autosteered) {
    stopTyping();
    // setState('AUTOSTEERED') is terminal — bypasses throttle,
    // serializes after any in-flight QUEUED apply via applyChain.
    await reactor.setState('AUTOSTEERED');
    // AUTOSTEERED is terminal; stop the reactor's STALL / TIMEOUT
    // timers so they don't pin the closure for up to 30s.
    reactor.stop();
    markReplied();
    return;
  }

  try {
    const result = await sendPromise;
    // sendToProcess failures are captured (not thrown) so the latch
    // always releases; re-throw here into the existing handler.
    if (result && result.__sendError) throw result.__sendError;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // 0.7.6 (item F): persist per-turn telemetry. Stream-json result
    // events carry total_cost_usd + duration_ms; sumUsage rolled up
    // input/output/cache token counts from per-message usage. One row
    // per dispatched user message; queryable via turn_metrics table.
    if (result.metrics) {
      dbWrite(() => db.insertTurnMetric({
        chat_id: chatId,
        thread_id: threadId,
        msg_id: msg.message_id,
        session_id: result.sessionId,
        bot_name: BOT_NAME,
        model: chatConfig.model,
        effort: chatConfig.effort,
        input_tokens: result.metrics.inputTokens,
        output_tokens: result.metrics.outputTokens,
        cache_creation_tokens: result.metrics.cacheCreationTokens,
        cache_read_tokens: result.metrics.cacheReadTokens,
        cost_usd: result.cost,
        duration_ms: result.duration,
        num_assistant_messages: result.metrics.numAssistantMessages,
        num_tool_uses: result.metrics.numToolUses,
        result_subtype: result.metrics.resultSubtype,
        error: result.error || null,
      }), 'insert turn_metric');
    }

    stopTyping();

    // 2026-05-13 Dina-DM incident: SDK reports result_subtype=success
    // but the "assistant text" is actually an API error JSON the SDK
    // wrapped (e.g. wedged image content block in resumed transcript).
    // Without this guard, polygram delivers the raw JSON to Telegram
    // as the bot's reply AND never resets the session — every
    // subsequent turn loops the same wedge.
    //
    // Sniff result.text for the wrapper pattern BEFORE the error/text
    // branch decisions. When detected: synthesize an Error so the
    // standard result.error path runs (classification → reset_session
    // → friendly user message → no raw-JSON delivery).
    if (!result.error && detectWedgedSessionError(result.text)) {
      const wedge = detectWedgedSessionError(result.text);
      logEvent('wedged-session-detected', {
        chat_id: chatId, session_key: sessionKey,
        kind: wedge.kind,
        text_preview: result.text.slice(0, 200),
      });
      // Promote the wrapped error to result.error so the existing
      // auto-recover + thrown-error machinery handles it uniformly.
      // Clear result.text so downstream delivery doesn't send the
      // raw JSON.
      result.error = result.text;
      result.text = '';
    }

    if (result.error) {
      console.error(`[${label}] Error (${elapsed}s):`, result.error);
      reactor.setState('ERROR');
      // 0.8.0 Phase 2 step 8: classifier-driven auto-recovery. If
      // the error kind has autoRecover === 'reset_session' (i.e.
      // role_ordering / context_overflow / missing_tool_input /
      // imageProcess), tell pm to reset the session NOW so the
      // user's NEXT message starts fresh — without them having
      // to type /new.
      const cls = classifyError(result.error);
      if (cls.autoRecover === 'reset_session') {
        pm.resetSession(sessionKey, { reason: cls.kind })
          .catch((err) => console.error(`[${label}] auto-reset failed: ${err.message}`));
        logEvent('auto-recover', {
          chat_id: chatId, kind: cls.kind, action: 'reset_session',
        });
      }
      // 0.6.16: pre-fix, silently markReplied()+return — the user got an
      // error reaction emoji on their message but no actual reply text,
      // AND 'replied' status meant boot replay didn't re-dispatch on next
      // boot. Worst-case: shutdown-killed turn (e.g. polygram upgrade
      // mid-stream) → user sends "yes", sees 🤯, gets no answer ever,
      // the row is silently lost. Promote to a thrown error so
      // dispatchHandleMessage's catch correctly distinguishes shutdown
      // (→ 'replay-pending', boot replay retries) from runtime failure
      // (→ 'failed', user gets an apology with retry hint).
      if (!result.text) throw new Error(result.error);
    } else {
      // rc.10: reactor.clear() and clearAutosteeredReactions() moved
      // to AFTER deliverReplies completes (see just before
      // markReplied() below). Pre-rc.10 they fired the moment pm.send
      // returned (JSONL result event), which was ~1-3s BEFORE the
      // Telegram reply actually landed via the streamer / chunked
      // delivery path. User saw: 🤔/✍ visible → reactions cleared →
      // ~1-3s of nothing → reply bubble lands. Ivan caught this on
      // shumorobot 2026-05-15 ("both reactions disappeared, typing
      // disappeared, at some point he responded"). Deferring the
      // clears closes the visual gap.
      // rc.42: tool-less-turn stale-drain DELETED. With native priority
      // push, the SDK's input controller has the followups directly —
      // there's no buffer for us to drain. Tool-less turns just emit
      // result, the followup messages (if any) get their own SDK
      // pause to absorb at, no special handling needed.

      // Context-full live hint. After a successful turn, peek at
      // SDK's getContextUsage(); if past the threshold, post a
      // quiet hint so the user knows /new will help. OPT-IN
      // per-chat or per-bot — most chats don't want the noise.
      // Per-chat takes precedence over per-bot so admins (Ivan DM)
      // can opt in without forcing it on every other chat.
      //
      // rc.56: threshold default lowered to 70% (was 85%) because
      // the SDK auto-compacts mid-turn at ~85% — by the time
      // polygram queries getContextUsage post-turn, the percentage
      // has already dropped and the hint never fires. 70% gives
      // the user 1-3 turns of headroom before SDK compaction.
      // Configurable via `contextHintThreshold` (number, 0-100)
      // per-chat or per-bot. Same precedence rule as contextHint.
      const chatCtxHint = chatConfig.contextHint != null
        ? chatConfig.contextHint
        : config.bot?.contextHint;
      // rc.59: gate the hint to once-per-cycle. Pre-rc.59 the hint
      // fired on EVERY turn that landed over threshold — so a user
      // saw "📚 70% full…" then "71% full…" then "72% full…"
      // turn after turn until compaction. Now: fire once when the
      // session first crosses the threshold, mark the flag, suppress
      // subsequent fires. Cleared on compact-boundary so the next
      // cycle (if it crosses again) will fire fresh.
      if (chatCtxHint === true && !contextHintShown.has(sessionKey)) {
        // 0.10.0: route through pm.getContextUsage(sessionKey) instead
        // of poking entry.query directly. The pm-level call delegates
        // to Process.getContextUsage(), which is implemented by BOTH
        // SdkProcess (via Query.getContextUsage) and TmuxProcess (via
        // JSONL message.usage snapshots). Either backend returns the
        // same shape; either throws Unsupported when no data yet.
        const threshold = chatConfig.contextHintThreshold != null
          ? chatConfig.contextHintThreshold
          : (config.bot?.contextHintThreshold != null
            ? config.bot.contextHintThreshold
            : undefined);
        pm.getContextUsage(sessionKey).then((usage) => {
          const text = maybeContextFullHint(usage, threshold != null ? { threshold } : undefined);
          if (!text) return;
          // Mark BEFORE the send so concurrent turns don't all fire
          // the hint while the first one's still in flight.
          contextHintShown.add(sessionKey);
          return tg(bot, 'sendMessage', {
            chat_id: chatId,
            text,
            ...(threadId ? { message_thread_id: threadId } : {}),
          }, { source: 'context-full-hint', botName: BOT_NAME });
        }).catch((err) => {
          // UnsupportedOperation = backend doesn't have usage data
          // (yet) — silent no-op, not an error. Other errors surface.
          if (err?.code === 'UNSUPPORTED_OPERATION') return;
          console.error(`[${label}] context-hint failed: ${err.message}`);
        });
      }
    }

    // 0.7.0: empty-response fallback (port from OpenClaw —
    // EMPTY_RESPONSE_FALLBACK at reply-CdjLMJxg.js:40323). When
    // Claude finishes WITHOUT producing any text (e.g. only tool
    // calls, or aborted before writing the assistant message), send
    // a placeholder so the user doesn't see silence with no reaction.
    // NO_REPLY is an explicit "stay silent" signal from the agent —
    // those still markReplied silently.
    if (result.text === 'NO_REPLY') { markReplied(); return; }
    if (!result.text) {
      // 0.8.0-rc.7: tool-only completion is NOT an error. Under SDK
      // pm, a turn that ends after running tools (no closing text
      // block) leaves result.text empty even though the bot DID
      // respond — via tool side effects the user already saw. Don't
      // post a "No response generated" apology in that case; it's
      // confusing and it spams the chat. Just clear the reactor
      // (otherwise 👀 stays stuck — reactor.stop() doesn't remove
      // the emoji visually) and silently mark replied.
      const toolOnlyTurn = (result.metrics?.numToolUses ?? 0) > 0
        && (result.metrics?.numAssistantMessages ?? 0) > 0;
      if (toolOnlyTurn) {
        await reactor.clear().catch(() => {});
        clearAutosteeredReactions(sessionKey).catch(() => {});
        // rc.42: stale-drain removed. SDK manages absorption directly.
        logEvent('tool-only-completion', {
          chat_id: chatId, msg_id: msg.message_id, bot: BOT_NAME,
          num_tool_uses: result.metrics?.numToolUses,
          num_assistant_messages: result.metrics?.numAssistantMessages,
        });
        markReplied();
        return;
      }
      // 0.7.1: if the fallback send itself fails, throw rather than
      // silently markReplied — the user gets nothing AND the inbound
      // is marked replied so boot replay won't redispatch. Same
      // anti-pattern that caused msg-10794. Promote to a thrown error
      // so dispatchHandleMessage's catch branches correctly:
      //   shutdown   → 'replay-pending' (boot replay retries)
      //   runtime    → 'failed' + user-visible apology via errorReplyText
      try {
        await tg(bot, 'sendMessage', {
          chat_id: chatId,
          text: 'No response generated. Please try again.',
          ...(threadId && { message_thread_id: threadId }),
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        }, { ...outMetaBase, source: 'empty-response-fallback' });
      } catch (err) {
        reactor.setState('ERROR');
        logEvent('telegram-empty-response-fallback-failed', {
          chat_id: chatId, msg_id: msg.message_id, bot: BOT_NAME,
          error: err.message?.slice(0, 200),
        });
        throw new Error(`empty-response fallback send failed: ${err.message}`);
      }
      logEvent('telegram-empty-response-fallback', {
        chat_id: chatId, msg_id: msg.message_id, bot: BOT_NAME,
      });
      // 0.8.0-rc.7: clear the THINKING/QUEUED emoji on the user's
      // message so 👀 doesn't stay stuck after the apology lands.
      // reactor.stop() (in the finally block) only kills timers; it
      // does NOT remove the visible emoji. Without this clear, the
      // user sees 👀 next to their message indefinitely.
      await reactor.clear().catch(() => {});
      markReplied();
      return;
    }

    // Review F#2: channels dispatcher has already delivered the reply text
    // to Telegram incrementally during the turn (each `reply` tool call
    // → dispatcher → processAndDeliverAgentText → deliverReplies). result.text
    // is the *cumulative* of those replies, kept for transcript + telemetry
    // but MUST NOT re-flow through streamer.finalize / deliverReplies — that
    // would deliver every channels turn twice. Short-circuit BEFORE the
    // parseResponse/finalize/deliver block; still clear reactor + mark
    // replied so the reactive UI elements close cleanly.
    if (result.alreadyDelivered) {
      logEvent('channels-turn-resolved', {
        chat_id: chatId,
        msg_id: msg.message_id,
        session_id: result.sessionId,
        duration_ms: result.duration,
        chars: result.text?.length || 0,
        replies: result.metrics?.numAssistantMessages || 0,
        bot: BOT_NAME,
      });
      reactor.clear().catch(() => {});
      clearAutosteeredReactions(sessionKey).catch(() => {});
      console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | channels-delivered | ${chatConfig.model}/${chatConfig.effort}`);
      markReplied();
      return;
    }

    const parsed = parseResponse(result.text);
    // rc.39: intercept CLI-context canned-string leaks (`No response
    // requested.` etc.) before they reach the streamer/deliver path.
    // Replaces with an honest brief message; logs the substitution
    // for forensic post-hoc analysis of how often the leak fires.
    // See lib/telegram/sanitize-reply.js for the (narrow) allowlist
    // and rationale — the rc.37 prompt-side hint mitigation proved
    // insufficient, so this is the polygram-layer safety net.
    if (parsed.text) {
      const sanitized = sanitizeAssistantReply(parsed.text);
      if (sanitized.replaced) {
        logEvent('canned-reply-suppressed', {
          chat_id: chatId,
          msg_id: msg.message_id,
          original: sanitized.original,
          backend: result?.backend || null,
        });
        parsed.text = sanitized.text;
      }
    }
    const outMeta = { ...outMetaBase, sessionId: result.sessionId, costUsd: result.cost };

    // 0.8.0-rc.39: send any inline stickers Claude embedded with
    // `[sticker:NAME]` markers (parseResponse stripped them from
    // parsed.text and surfaced them in parsed.stickers[]). Send AFTER
    // the text reply lands so the sticker reads as punctuation on the
    // message, not as a leading icon. Failures are logged but never
    // block the rest of the reply — a missing sticker is a soft UX
    // miss, not a turn failure.
    const sendInlineStickers = async () => {
      if (!parsed.stickers || parsed.stickers.length === 0) return;
      for (const s of parsed.stickers) {
        try {
          await tg(bot, 'sendSticker', {
            chat_id: chatId,
            sticker: s.fileId,
            ...(threadId && { message_thread_id: threadId }),
          }, { ...outMeta, stickerName: s.name, source: 'inline-sticker' });
        } catch (err) {
          console.error(`[${label}] inline sendSticker(${s.name}) failed: ${err.message}`);
        }
      }
    };

    // rc.63: agents send inline `[react:EMOJI]` tags within text replies
    // (e.g. "Да, вижу! [react:👍]"). parse-response strips the tag from
    // the visible text and surfaces the emoji in `parsed.reactions[]`.
    // Apply the FIRST one as a Telegram reaction on the user's message.
    // Most Telegram bots can place only one emoji reaction per message;
    // additional [react:] tags in the same reply are dropped silently
    // (logged for forensics but not user-visible).
    const sendInlineReactions = async () => {
      if (!parsed.reactions || parsed.reactions.length === 0) return;
      const emoji = parsed.reactions[0];
      try {
        await tg(bot, 'setMessageReaction', {
          chat_id: chatId,
          message_id: msg.message_id,
          reaction: [{ type: 'emoji', emoji }],
        }, { ...outMeta, source: 'inline-reaction', reaction: emoji });
      } catch (err) {
        console.error(`[${label}] inline setMessageReaction(${emoji}) failed: ${err.message}`);
      }
      if (parsed.reactions.length > 1) {
        logEvent('inline-reactions-dropped', {
          chat_id: chatId, msg_id: msg.message_id,
          applied: emoji, dropped_count: parsed.reactions.length - 1,
        });
      }
    };

    // OpenClaw's preview-becomes-final flow:
    //
    //   1. flushDraft() — drain any pending throttled edit so the
    //      bubble's visible state is up-to-date before deciding.
    //   2. finalize(parsed.text) — try to bring the bubble to the
    //      final body. Returns rich result describing whether the
    //      preview can stand as the final reply.
    //   3a. finalEditOk:true        → preview IS final, done.
    //   3b. overflow OR !finalEditOk → discard preview, redeliver
    //      via deliverReplies(chunkMarkdownText(...)). The bubble
    //      couldn't render the full body (size or parse error), so
    //      we delete it cleanly and send the proper chunks fresh at
    //      chat bottom — no content lost, no stranded bubble.
    if (parsed.text) {
      await streamer.flushDraft();
      const fin = await streamer.finalize(parsed.text);
      if (fin.streamed) {
        if (fin.finalEditOk) {
          // Preview was successfully edited to the final text.
          // No follow-up messages needed.
          await sendInlineStickers();
          await sendInlineReactions();
          await cleanupArchivedBubbles();
          // Bug 2 (incident 2026-05-18): this streamed-success branch
          // returns BEFORE the rc.10 deferred-clear block at the
          // bottom of the handler — so a turn that streamed its reply
          // never cleared the reactor. If the turn went quiet
          // mid-stream long enough to trip STALL (🥱), the emoji
          // stuck. reactor.stop() in the finally only kills timers,
          // not the visible reaction. Clear here, mirroring the
          // rc.10 block — AFTER delivery so there's no visual gap.
          reactor.clear().catch(() => {});
          clearAutosteeredReactions(sessionKey).catch(() => {});
          console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | streamed | ${chatConfig.model}/${chatConfig.effort} | $${result.cost?.toFixed(4) || '?'}`);
          markReplied();
          return;
        }
        // Preview can't hold the final body (overflow OR last edit
        // failed even after our HTML→plain fallback). Delete it and
        // send the body as proper chunks.
        try { await streamer.discard(); }
        catch (err) { console.error(`[${label}] discard failed: ${err.message}`); }
        const chunks = chunkMarkdownText(parsed.text, TG_CHUNK_BUDGET);
        const r = await deliverReplies({
          bot,
          send: (b, method, params, m) => tg(b, method, params, m),
          chatId,
          threadId,
          chunks,
          replyToMessageId: msg.message_id,
          meta: outMeta,
          logger: { error: (m) => console.error(`[${label}] ${m}`) },
        });
        const reason = fin.overflow ? 'overflow' : 'edit-failed';
        logEvent('telegram-stream-redeliver', {
          chat_id: chatId, msg_id: msg.message_id,
          reason, chunks: chunks.length,
          delivered: r.sent.length, failed: r.failed.length,
          bot: BOT_NAME,
        });
        // 0.7.1: surface partial-failure to the user. Without this,
        // a chunk-3-of-5 failure leaves a coherent-looking reply with
        // a silent gap (the user reads chunks 1, 2, 4, 5 unaware
        // that chunk 3 was dropped). Append a warning + flip the
        // reactor to ERROR so something visible signals "look here".
        if (r.failed.length > 0) {
          reactor.setState('ERROR');
          try {
            await tg(bot, 'sendMessage', {
              chat_id: chatId,
              text: `⚠️ ${r.failed.length} of ${chunks.length} message parts failed to deliver. The reply may be incomplete — please retry.`,
              ...(threadId && { message_thread_id: threadId }),
            }, { ...outMetaBase, source: 'partial-delivery-warning' });
          } catch (warnErr) {
            console.error(`[${label}] partial-delivery warning failed: ${warnErr.message}`);
          }
        }
        await sendInlineStickers();
          await sendInlineReactions();
        await cleanupArchivedBubbles();
        // Bug 2 (incident 2026-05-18): same gap as the finalEditOk
        // branch above — this streamed-redeliver path returns before
        // the rc.10 deferred-clear block, so the reactor would stay
        // stuck. Clear it (and autosteered ✍) here, after delivery —
        // but ONLY on a clean delivery. When r.failed.length>0 the
        // ERROR state (😨) was set above as the "look here" signal
        // for the partial-delivery failure; clearing it would wipe
        // that signal, so leave the reactor as-is in that case.
        if (r.failed.length === 0) {
          reactor.clear().catch(() => {});
        }
        clearAutosteeredReactions(sessionKey).catch(() => {});
        console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | streamed-redeliver(${reason}, ${chunks.length} chunks${r.failed.length ? `, ${r.failed.length} failed` : ''}) | ${chatConfig.model}/${chatConfig.effort} | $${result.cost?.toFixed(4) || '?'}`);
        markReplied();
        return;
      }
      // Not streamed (response too short — never crossed minChars).
      // Fall through to the normal send path below.
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
      // 0.7.0: use markdown-aware chunker + deliverReplies primitive.
      // The old chunkText was newline/byte-only; chunkMarkdownText also
      // respects code-fence boundaries (closes + reopens across chunks).
      const chunks = chunkMarkdownText(parsed.text, TG_CHUNK_BUDGET);
      await deliverReplies({
        bot,
        send: (b, method, params, m) => tg(b, method, params, m),
        chatId,
        threadId,
        chunks,
        replyToMessageId: msg.message_id,
        meta: outMeta,
        logger: { error: (m) => console.error(`[${label}] ${m}`) },
      });
    }

    await sendInlineStickers();
          await sendInlineReactions();
    // rc.10: clear progress reactions AFTER the reply has been
    // delivered so the user doesn't see a "reactions cleared, then
    // ~1-3s of nothing, then reply bubble" gap. The reply bubble
    // itself is the "done" signal; clearing the emoji simultaneously
    // with the delivery completion is the smooth UX path. Both
    // fire-and-forget — these are best-effort cleanups, not part of
    // the reply contract.
    reactor.clear().catch(() => {});
    // 0.8.0-rc.14: also clear ✍ reactions on every follow-up
    // message that was autosteered into THIS turn — they live in
    // separate handleMessage scopes whose reactors are already GC'd.
    // rc.9 caveat: TmuxProcess.extra-turn-started re-applies ✍ if
    // there's a pending autosteer dequeue happening (NEW-TURN case),
    // and extra-turn-reply clears it again when the second reply
    // lands. So the FOLD path benefits from this deferred clear
    // without breaking NEW-TURN.
    clearAutosteeredReactions(sessionKey).catch(() => {});
    console.log(`[${label}] ${elapsed}s | ${result.text.length} chars | ${chatConfig.model}/${chatConfig.effort} | $${result.cost?.toFixed(4) || '?'}`);
    markReplied();
  } catch (err) {
    // If the user just aborted this session, silently finalise the stream
    // without the scary "⚠ stream interrupted" banner. The user has already
    // seen their "Остановлено." ack; adding a warning to the partial bubble
    // just reads as "something crashed".
    //
    // rc.55: SAME quiet-finalize path during shutdown. Pre-rc.55 a deploy
    // that landed mid-turn appended "⚠ stream interrupted" to whatever
    // had streamed so far — the user saw a scary symbol every time we
    // kickstart-k'd. polygram's boot-replay (rc.51) redispatches the
    // turn from the same session_id, so the recovery is automatic; the
    // user shouldn't be told "we crashed". Skip the suffix; let the
    // partial bubble stand silently. The redispatched turn streams a
    // fresh bubble with the full answer below.
    const abortedByUser = isSessionRecentlyAborted(sessionKey);
    const quietFinalize = abortedByUser || isShuttingDown;
    if (quietFinalize) {
      await streamer.finalize('').catch(() => {});
      if (abortedByUser) {
        // 0.8.0-rc.13: clear the in-flight emoji on abort so the user
        // sees a clean message after their /stop ack — pre-rc.13 the
        // last 👀 / 🤔 / ✍ stayed stuck on the message indefinitely
        // because reactor.stop() (in finally) only kills timers, not
        // the visible reaction. We DON'T set 🤯/😨 (those are for
        // unexpected errors); the user just wants their stop honored.
        await reactor.clear().catch(() => {});
        // rc.14: clear ✍ on autosteered followups too (per-msg
        // reactors are already GC'd in their own handleMessage scopes).
        await clearAutosteeredReactions(sessionKey).catch(() => {});
      }
      // On shutdown, leave the reactor state as-is — boot-replay's
      // fresh dispatch will set its own reactor.
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
    // rc.38: defensive clear-on-exit for ✍ reactions. Pre-rc.38 only
    // the success path (line ~2622), the abort path (line ~2858), and
    // the tool-only-completion path (line ~2681) cleared
    // autosteeredRefs. The plain error path (`if (result.error)` →
    // throw at ~2612), the empty-response fallback failure (~2714),
    // and the streamer-overflow path could all leave ✍ reactions
    // stuck on follow-ups whose buffer entries had never been
    // drained by PostToolBatch. The clear is idempotent (the second
    // call returns 0 against an already-emptied map) so adding it
    // here covers ALL exit paths without double-clearing harm.
    clearAutosteeredReactions(sessionKey).catch(() => {});
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
    // A reply targeting some other user (not the bot) is a strong signal
    // "this message is for that person, not me". Paired users normally
    // bypass requireMention, but not in this case — without the guard a
    // paired user saying "Gotcha!" to a teammate gets processed by the
    // bot just because the user is paired, which is what bit us in
    // UMI Group on 0.5.9 (bot leaked reasoning as a reply to "Gotcha!").
    const repliesToOtherUser = !!msg.reply_to_message
      && msg.reply_to_message.from?.username !== botUsername;
    // Paired users bypass requireMention — operator-trusted, no @ needed
    // every time. Skipped when they're replying to a non-bot user (above).
    const paired = !repliesToOtherUser && pairings && msg.from?.id
      ? pairings.hasLivePairing({ bot_name: BOT_NAME, user_id: msg.from.id, chat_id: chatId })
      : false;
    if (!isReplyToBot && !hasMention && !paired) return false;
  }

  return true;
}

function createBot(token) {
  // Optional self-hosted Telegram Bot API server. When config.bot.apiRoot is
  // set (e.g. "http://localhost:8081" from a local `telegram-bot-api`
  // process), grammy routes all Bot API calls there instead of
  // api.telegram.org — which lifts file send/receive from cloud's 50 MB-out /
  // 20 MB-in to 2 GB both ways. Omit it (default) → cloud Telegram, unchanged.
  // The local server is a separate companion daemon; this is just the knob
  // that points polygram at it. See docs/0.12.0-file-send.md.
  const apiRoot = config.bot?.apiRoot;
  const bot = new Bot(token, {
    client: {
      // rc.15: with the local Bot API server, getFile DOWNLOADS the file
      // synchronously (server fetches it from Telegram's DC, then responds) —
      // a large lossless WAV can take >60s, so the cloud-tuned 60s timeout
      // fired before the download finished (the file still landed on the
      // server's disk, but polygram's getFile call already errored). The
      // local server is localhost, so non-download calls stay fast; the
      // higher ceiling only matters for big getFile downloads.
      timeoutSeconds: apiRoot ? 180 : 60,
      ...(apiRoot ? { apiRoot } : {}),
    },
  });
  if (apiRoot) {
    console.log(`[polygram] using local Telegram Bot API server: ${apiRoot} (2GB file limit)`);
  }
  let botUsername = '';
  // Cached once @botUsername is known — was recompiling per inbound msg.
  let mentionRe = null;

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
    // Route through tg() so onboarding replies (success notice + error
    // messages) get the standard write-before-send DB row, log on
    // failure, and the same formatting policy as every other outbound.
    // Pre-0.6.8 this was bot.api.sendMessage(...).catch(() => {}) which
    // silently dropped failures: the user typed /pair, the code was
    // claimed (DB mutated), but if the "Paired" reply failed to send
    // they'd assume it didn't work and try the now-invalid code again.
    const send = (text) => tg(bot, 'sendMessage', {
      chat_id: chatId, text,
    }, { source: 'pair-onboarding', botName: BOT_NAME }).catch((err) =>
      console.error(`[${BOT_NAME}] pair-onboarding reply: ${err.message}`));

    if (!userId) {
      await send('No user id on request.');
      return null;
    }

    const res = pairings.claimCode({
      code, claimer_user_id: userId,
      chat_id: chatId, bot_name: BOT_NAME,
    });
    logEvent('pair-claim-attempt', {
      bot: BOT_NAME, user_id: userId, chat_id: chatId,
      ok: res.ok, reason: res.reason, via: 'auto-onboard',
    });

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
      logEvent('auto-onboard-failed', {
        bot: BOT_NAME, chat_id: chatId, user_id: userId,
        reason: 'no-cwd',
      });
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
    logEvent('chat-auto-created', {
      bot: BOT_NAME, chat_id: chatId, user_id: userId,
      source: 'pair-claim', model: newChat.model, effort: newChat.effort,
    });

    const chatLabel = res.chat_id ? `chat ${res.chat_id}` : `every chat ${BOT_NAME} is in`;
    const suffix = res.note ? `\n(${res.note})` : '';
    await send(`Paired. You can use me in ${chatLabel}.${suffix}`);
    return newChat;
  }

  // 0.13 D5: the intake chain (abort → admin/pair → rewind → ownsOpenOther ‖
  // shouldHandle → question-consume → dispatch) moved verbatim into the ONE
  // gate, lib/handlers/gate-inbound.js, with a tier×stage side-effect table —
  // the edited_message path and every redelivery now run the SAME chain
  // (pre-0.13 they ran divergent subsets; the divergences were bugs — an edit
  // to "/stop" was injected into the very turn it tried to kill, an edit
  // during an open "Other" capture never became the answer, and any group
  // member's bare "stop" aborted others' turns pre-gate). Late-bound deps are
  // getters because this runs at createBot time, before main() wires the
  // dispatcher/handlers.
  gateInbound = createGateInbound({
    config,
    getBotUsername: () => botUsername,
    getMentionRe: () => mentionRe,
    pairings: { hasLivePairing: (args) => !!pairings?.hasLivePairing(args) },
    isAbortRequest,
    handleAbortIfRequested: (...a) => handleAbortIfRequested(...a),
    getRewindHandler: () => rewindHandler,
    isRewindCommand,
    getQuestionHandlers: () => questionHandlers,
    shouldHandle,
    getSessionKey,
    dispatchHandleMessage: (...a) => dispatchHandleMessage(...a),
    bot,
    botName: BOT_NAME,
    logEvent,
    logger: console,
  });

  // Shared post-validation dispatch. Called directly for single messages
  // and for the synthesised "primary" of a media-group bundle.
  const dispatchRegularMessage = async (msg) => gateInbound(msg, { tier: 'fresh' });

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

      // 0.6.0 attachment-table regression fix: recordInbound (called per
      // sibling on bot.on('message')) inserted each photo's row under its
      // OWN msg_id. handleMessage looks up attachments via
      // getAttachmentsByMessage(primary.message_id) — which only returns
      // the primary's row. Without re-FK'ing the siblings we'd silently
      // drop N-1 of N photos in any album, exactly the umi-assistant bug
      // the user hit (saw 1 of 2 photos sent in a Telegram album).
      const chatId = String(primary.chat.id);
      const primaryDbId = db.getInboundMessageId({
        chat_id: chatId, msg_id: primary.message_id,
      });
      const siblingMsgIds = messages
        .filter((m) => m.message_id !== primary.message_id)
        .map((m) => m.message_id);
      if (primaryDbId && siblingMsgIds.length) {
        dbWrite(() => db.reassignAttachmentsToMessage({
          chat_id: chatId,
          msg_ids: siblingMsgIds,
          target_message_id: primaryDbId,
        }), 'reassign media-group sibling attachments');
      }

      const synthetic = { ...primary, _mergedAttachments: merged };
      // rc.16: carry the album sibling msg_ids so the status reactor can mirror
      // its emoji onto every item (not just the anchor) — see the reactor
      // `apply` closure + lib/telegram/album-reactions.js.
      if (siblingMsgIds.length) synthetic._albumSiblingMsgIds = siblingMsgIds;
      // Carry the primary's text verbatim (dispatchRegularMessage re-cleans
      // the mention). Caption → text so downstream sees it uniformly.
      if (!synthetic.text && synthetic.caption) synthetic.text = synthetic.caption;
      dispatchRegularMessage(synthetic).catch((err) =>
        console.error(`[${BOT_NAME}] media-group dispatch error: ${err.message}`));
    },
  });

  bot.on('message', async (ctx) => {
    if (!isWellFormedMessage(ctx.message)) {
      logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'missing chat.id / message_id',
      });
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
    if (!isWellFormedCallbackQuery(ctx.callbackQuery)) {
      logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'callback_query missing message/from/data or inline-mode',
      });
      // Best-effort ack so Telegram stops re-sending. May fail silently.
      await ctx.answerCallbackQuery({ text: 'Stale or invalid button.' }).catch(() => {});
      return;
    }
    try {
      const data = ctx.callbackQuery.data;
      if (data.startsWith('cfg:')) {
        await handleConfigCallback(ctx);
      } else if (data.startsWith('q:')) {
        if (questionHandlers) await questionHandlers.handleQuestionCallback(ctx);
      } else {
        await handleApprovalCallback(ctx);
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] callback_query error: ${err.message}`);
    }
  });

  bot.on('edited_message', async (ctx) => {
    if (!isWellFormedMessage(ctx.editedMessage)) {
      logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'edited_message missing chat.id / message_id',
      });
      return;
    }
    const chatId = ctx.editedMessage.chat.id.toString();
    if (!knownChat(chatId)) return;
    // 0.12.0 spec §3 (HARD): read the OLD text BEFORE recordInbound overwrites the row — the
    // post-turn changed-guard compares it, and the re-dispatch quotes it in reply_to so claude sees
    // the before/after. Reading after recordInbound would yield the new text (useless).
    const oldText = db.getMessage(chatId, ctx.editedMessage.message_id)?.text ?? null;
    recordInbound(ctx.editedMessage);
    logEvent('message-edited', {
      chat_id: chatId,
      msg_id: ctx.editedMessage.message_id,
      user_id: ctx.editedMessage.from?.id || null,
    });
    console.log(`[${BOT_NAME}] edited ${chatId}/${ctx.editedMessage.message_id}`);

    // 0.13 D5: gate FIRST (tier 'edit') — the edited message's CURRENT text
    // runs the same abort/admin/question-consume/shouldHandle chain as a fresh
    // message. Closes the S11 holes: an edit-to-"stop" now ABORTS (identity-
    // gated) instead of being injected into the very turn it tries to kill; an
    // edit while that user owns an open free-text "Other" capture becomes the
    // answer; a bystander's un-addressed edit is blocked BEFORE any inject.
    // Only a 'pass' proceeds to the fold/redeliver machinery below.
    try {
      const gateRes = await gateInbound(ctx.editedMessage, { tier: 'edit' });
      if (gateRes.action !== 'pass') {
        logEvent('edit-gated', {
          chat_id: chatId, msg_id: ctx.editedMessage.message_id,
          action: gateRes.action, stage: gateRes.stage ?? null,
        });
        return;
      }
      // Mid-turn (turn still in flight) → fold into the running turn via the 0.9.0
      // injector. Post-turn (idle) — OR the injector no-ops because the turn just
      // settled at the boundary — → re-dispatch as a NEW turn (edit re-delivery).
      const injected = maybeInjectEditCorrection?.(ctx.editedMessage);
      if (!injected) maybePostTurnEdit?.(ctx.editedMessage, oldText, botUsername, mentionRe);
    } catch (err) {
      console.error(`[${BOT_NAME}] edit handler error: ${err.message}`);
    }
  });

  bot.on('message:migrate_to_chat_id', async (ctx) => {
    // Defensive: Telegram's grammy filter matches when migrate_to_chat_id is
    // present, but neither value is guaranteed to be numeric / finite. If
    // this update is malformed, skip rather than writing garbage to the DB.
    const rawOld = ctx.chat?.id;
    const rawNew = ctx.message?.migrate_to_chat_id;
    const isValidId = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint';
    if (!isValidId(rawOld) || !isValidId(rawNew)) {
      logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'migrate_to_chat_id missing / non-numeric',
      });
      return;
    }
    const oldChatId = rawOld.toString();
    const newChatId = rawNew.toString();
    if (oldChatId === newChatId) {
      logEvent('malformed-update', {
        bot: BOT_NAME,
        update_id: ctx.update?.update_id,
        reason: 'migrate_to_chat_id equals current chat_id',
      });
      return;
    }
    console.log(`[${BOT_NAME}] chat migrated: ${oldChatId} → ${newChatId}`);
    dbWrite(() => db.logChatMigration(oldChatId, newChatId), 'log chat-migration');
    logEvent('chat-migrated', { old_chat_id: oldChatId, new_chat_id: newChatId });
    if (config.chats[oldChatId] && !config.chats[newChatId]) {
      config.chats[newChatId] = { ...config.chats[oldChatId] };
      delete config.chats[oldChatId];
      saveConfig();
      // Chat migration is the one legit chat-wide kill: every session
      // (every topic) under the old chat_id is stale and must restart
      // under the new chat_id. Other respawn/abort paths target a
      // single sessionKey, but here ALL sessions are invalid.
      await pm.killChat(oldChatId);
    }
  });

  bot.catch((err) => {
    const updateId = err.ctx?.update?.update_id;
    const msgId = err.ctx?.update?.message?.message_id || err.ctx?.update?.edited_message?.message_id;
    console.error(`[${BOT_NAME}] update ${updateId} msg ${msgId} error: ${err.message}`);
    logEvent('update-error', {
      bot: BOT_NAME,
      update_id: updateId,
      msg_id: msgId,
      error: err.message?.slice(0, 300),
    });
  });

  bot._setBotUsername = (u) => {
    botUsername = u;
    mentionRe = u ? new RegExp(`@${u}\\b`, 'g') : null;
  };

  return bot;
}

// ─── Manual polling — extracted to lib/handlers/poll.js ────────────
let pollBot = null;
let startPollWatchdog = null;

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

  // rc.50: claim our PID file BEFORE binding the bot token. If a
  // prior daemon (orphan from a botched restart) is still running,
  // SIGTERM/SIGKILL it first. Two daemons sharing one Telegram bot
  // token + SQLite DB caused the rc.50 incident's user-visible
  // damage; this stops the cascade at boot.
  PID_PATH = path.join(DB_DIR, `${BOT_NAME}.pid`);
  const pidClaim = processGuard.claimPidFile(PID_PATH, { logger: console });
  if (pidClaim.priorAction !== 'no-prior') {
    console.log(`[orphan-guard] prior=${pidClaim.priorPid ?? '?'} action=${pidClaim.priorAction}`);
  }

  // 0.10.0: after claimPidFile kills the orphan daemon, sweep any
  // `polygram-<bot>-*` tmux sessions it left behind. Tmux sessions
  // outlive their parent process — without this, the new daemon's
  // TmuxProcess.start() hits EEXIST on session spawn for any chat
  // routed to pm:'tmux'. See lib/tmux/orphan-sweep.js for rationale.
  try {
    const sweep = await sweepTmuxOrphans({ botName: BOT_NAME, logger: console });
    if (sweep.swept.length > 0) {
      console.log(`[orphan-sweep] killed ${sweep.swept.length} stale tmux session(s)`);
    }
  } catch (err) {
    console.warn?.(`[orphan-sweep] failed (non-fatal): ${err.message}`);
  }

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

  // #3 events-table retention. Prune on boot (the primary path — daemons rarely
  // live to the 24h tick given deploy cadence) + a 24h .unref()'d interval as
  // insurance for long-uptime daemons. Validation failures DISABLE pruning and
  // log loud — a retention config typo must never take down the bot, so this
  // lives outside the DB-fatal try/catch above. pruneEvents writes no event
  // rows; we emit the audit event here from its result.
  let eventsRetentionPolicy = null;
  try {
    eventsRetentionPolicy = resolveRetentionPolicy(config);
    validatePolicy(eventsRetentionPolicy);
  } catch (err) {
    console.error(`[events-retention] invalid policy — pruning DISABLED: ${err.message}`);
    eventsRetentionPolicy = null;
  }
  const runEventsPrune = (trigger) => {
    if (!eventsRetentionPolicy) return;
    try {
      const res = pruneEvents(db.raw, Date.now(), eventsRetentionPolicy);
      if (res.skipped) {
        console.log(`[events-retention] skipped (${trigger}): ${res.reason}`);
        db.logEvent('events-prune-skipped', { reason: res.reason, trigger });
      } else if (res.dryRun) {
        console.log(`[events-retention] DRY-RUN (${trigger}) would delete ${res.preview.total} (default ${res.preview.default}, diag ${res.preview.diagnostic}, cap ${res.preview.cap})`);
        db.logEvent('events-prune-preview', { ...res.preview, trigger });
      } else if (res.deleted.total > 0) {
        console.log(`[events-retention] pruned ${res.deleted.total} (default ${res.deleted.default}, diag ${res.deleted.diagnostic}, cap ${res.deleted.cap}) ${res.before}→${res.after}`);
        db.logEvent('events-pruned', { ...res.deleted, before: res.before, after: res.after, trigger });
      }
    } catch (err) {
      console.error(`[events-retention] prune failed (${trigger}): ${err.message}`);
    }
  };
  if (eventsRetentionPolicy && eventsRetentionPolicy.enabled) {
    setImmediate(() => runEventsPrune('boot'));
    setInterval(() => runEventsPrune('interval'), 24 * 3_600_000).unref?.();
  }

  // 0.8.0 Phase 1 step 11 + rc.50: defensive uncaughtException +
  // unhandledRejection handlers. The new pm wraps every Query
  // iteration in try/catch so SDK throws never leak — but if a
  // callback ever does throw async (canUseTool body, onResult
  // handler, etc.) the rejection could escape. Node's default is
  // process exit; we log + persist + survive so other chats keep
  // running.
  //
  // rc.50 hardening (after the PID-6335 orphan-storm incident):
  //   1. Both handlers wrap their loggers in try/catch — pre-rc.50,
  //      a bare console.error inside the uncaughtException handler
  //      threw EIO when stdout was wired to a destroyed pty. That
  //      re-fired the same handler infinitely, hijacking the event
  //      loop and preventing the SIGHUP shutdown drain from running.
  //   2. Storm circuit breaker: same message firing >100× in 5s →
  //      panic exit(2). Lets launchd restart cleanly instead of
  //      letting the process zombie at ~12k EIO/sec writing to DB.
  // Lives in lib/process-guard.js.
  processGuard.installSafetyHandlers({
    logger: console,
    logEvent: (kind, detail) => { try { db.logEvent(kind, detail); } catch {} },
    botName: BOT_NAME,
  });

  const cap = config.maxWarmProcesses || DEFAULT_MAX_WARM_PROCS;

  // 0.9.0: single pm. SDK ProcessManager is the only impl after the
  // CLI pm + dual-pm router were deleted (see lib/pm-router.js
  // header comment for the migration history).
  // 0.9.0 commit 19: SDK lifecycle callbacks live in lib/sdk/callbacks.js;
  // factory threads the runtime context in via DI. onRespawn dropped
  // earlier — SDK pm applies /model + /effort live so there's no
  // drain event to hook.
  //
  // Wire-order: sdkCallbacks destructures `bot` at call time and
  // its onCompactBoundary closure captures that local binding. Must
  // run AFTER `bot = createBot(...)` below — see "Order encoded
  // below" further down. The pmOpts construction is split: cap+db
  // here, ...sdkCallbacks merged in once bot is alive. v4-rc.2 had
  // this in the wrong order — post-compact reply crashed with
  // "Cannot read properties of null (reading 'api')".
  const pmOpts = {
    cap,
    db,
    logger: console,
  };

  // 0.9.0 wiring order matters here. The factories destructure
  // their `pm` / `bot` deps by value at call time; the closures
  // they return then reference those CAPTURED references at every
  // future call. So `pm` and `bot` must be assigned BEFORE the
  // factory that consumes them runs — late-rebinding the
  // module-level `let pm` doesn't propagate into the factory's
  // captured local. v3 architecture review caught this as a
  // production-blocking bug after commit 29.
  //
  // Order encoded below:
  //   1. bot = createBot(token)              — needed by approvals + abort
  //   2. createApprovals(...)                — provides makeCanUseTool
  //   3. createBuildSdkOptions(...)          — uses makeCanUseTool
  //   4. pm = new ProcessManagerSdk(...)     — uses buildSdkOptions
  //   5. handler factories that need pm/bot  — see them as live refs

  bot = createBot(config.bot.token);

  // 0.13 D3: session-scoped feedback for cycles with NO pending turn
  // (ScheduleWakeup, fireUserMessage self-checks, injected messages picked up
  // as their own cycle) — typing for the cycle's duration + a 🤔 anchored to
  // the picked-up message when the input ledger names one.
  const sessionFeedback = createSessionFeedback({
    bot, tg, getChatIdFromKey, getThreadIdFromKey, botName: BOT_NAME,
    logEvent, logger: console,
  });

  const sdkCallbacks = createSdkCallbacks({
    db, dbWrite, config, bot, botName: BOT_NAME, tg, logEvent, sessionFeedback,
    classifyToolName, announce, shouldAnnounce, contextHintShown,
    extractAssistantText, getChatIdFromKey, getThreadIdFromKey,
    // F#23: enable parse/sanitize/sticker/react on the autonomous-wakeup path.
    // Pre-fix the handler did raw tg(sendMessage) and `[sticker:NAME]`,
    // `[react:EMOJI]`, `No response requested.` all leaked as literal text.
    parseResponse, sanitizeAssistantReply, chunkMarkdownText, deliverReplies,
    processAndDeliverAgentText,
    // 0.12 interactive questions: 'question-asked' (claude called the ask tool)
    // → render the Telegram keyboard. Late-bound; questionHandlers is assigned below.
    renderQuestion: (payload) => questionHandlers?.renderAsk(payload),
    logger: console,
  });
  // 0.10.0: sdkCallbacks (the polygram-side lifecycle handlers — status
  // reactor, stream chunk → bubble edit, etc.) move from the underlying
  // SDK pm to the generic ProcessManager. The SDK pm gets legacyCallbacks
  // (a bridge that re-emits events on per-Process EventEmitters); the
  // generic pm subscribes to those EventEmitters and forwards to
  // sdkCallbacks. Same code path; one extra hop for the abstraction.

  ({
    makeCanUseTool,
    handleApprovalCallback,
    resolveApprovalWaiter,
    startApprovalSweeper,
    cancelAllWaiters,
  } = createApprovals({
    config, db, bot, botName: BOT_NAME, tg, logEvent,
    approvals, getChatIdFromKey, logger: console,
  }));

  // 0.12 interactive questions: store + handlers + timeout sweep. answerQuestion
  // is late-bound to pm (a tap can land minutes later, pm is live by then).
  const questionStore = createQuestionStore(db.raw);
  questionHandlers = createQuestionHandlers({
    questions: questionStore, tg, bot, botName: BOT_NAME, logEvent,
    answerQuestion: (sk, tc, result) => pm.answerQuestion(sk, tc, result),
    logger: console,
  });
  // Resolve expired questions with {timedout} so claude never hangs on an ignored ask.
  setInterval(() => {
    try {
      for (const row of questionStore.sweepTimedOut()) {
        questionHandlers.expireQuestion(row).catch((e) => console.error(`[${BOT_NAME}] question expire: ${e.message}`));
      }
    } catch (e) { console.error(`[${BOT_NAME}] question sweep: ${e.message}`); }
  }, 30_000).unref?.();

  // 0.13 /rewind: detect + operator/ownership gate + turn-end defer + confirm (P1), backed by
  // the copy-only transcript-fork executor (P2/P3: fork → repoint the session → kill → delete
  // orphaned bot messages). channels/cli only; the fork mechanism was proven in P0.6.
  // See docs/0.13-rewind-design.md.
  const executeRewind = createRewindExecutor({ db, pm, tg, bot, botName: BOT_NAME, logEvent, logger: console });
  rewindHandler = createRewindHandler({
    pm, tg, bot, botName: BOT_NAME, logEvent, logger: console, executeRewind,
  });
  buildSdkOptions = createBuildSdkOptions({
    config,
    botName: BOT_NAME,
    childHome: CHILD_HOME,
    makeCanUseTool,
    logEvent,
    logger: console,
  });
  transcribeVoiceAttachments = createTranscribeVoiceAttachments({
    config, db, dbWrite, tg, logEvent,
    transcribeVoice, isVoiceAttachment,
    botName: BOT_NAME, logger: console,
  });
  downloadAttachments = createDownloadAttachments({
    config, db, dbWrite, inboxDir: INBOX_DIR, logger: console,
  });
  // 0.10.0: one ProcessManager, holds Process instances (SdkProcess
  // today; TmuxProcess too in Phase 2). Factory mints the right
  // subclass per-chat based on config.chats[X].pm. Lifecycle events
  // (init / close / stream-chunk / result / tool-use / etc.) emit
  // from each Process; the pm forwards to sdkCallbacks.
  // tmux backend runner — one per daemon, shared across all TmuxProcess
  // instances. Construction is cheap (no system call until first
  // spawn/send). Only used if any chat in config has pm:'tmux'.
  const tmuxRunner = createTmuxRunner({ logger: console });
  // Verify the pinned claude CLI binary is present. The tmux
  // backend spawns this exact binary by absolute path (see
  // lib/claude-bin.js + TmuxProcess.start) — it never resolves
  // `claude` through $PATH, so the CLI auto-updater can't drift
  // it. This boot check is informational: it tells the operator
  // up-front which binary the tmux backend will use, and warns
  // (non-fatal — SDK-backed chats don't need it) if it's missing.
  // A missing binary still hard-fails per-chat at TmuxProcess.start.
  // 0.11.0: binCheck reused for channels backend wiring below.
  let pinnedClaudeBin = null;
  {
    const { CLAUDE_CLI_PINNED_VERSION } = require('./lib/claude-bin');
    const { verifyPinnedClaudeBin } = require('./lib/claude-bin');
    const binCheck = verifyPinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION);
    if (binCheck.ok) {
      console.log(
        `[polygram] CliProcess pinned to claude CLI v${CLAUDE_CLI_PINNED_VERSION}: ${binCheck.path}`,
      );
      pinnedClaudeBin = binCheck.path;
    } else {
      console.warn(`[polygram] WARNING: ${binCheck.reason}`);
    }
  }
  // 0.11.0: channels backend wiring. Used when a chat opts in via
  // `pm: 'channels'` config. Falls back to SDK gracefully if the pinned
  // claude binary isn't present (see factory.js — channelsClaudeBin
  // missing triggers a loud warn + SDK fallback).
  const channelsToolDispatcher = createChannelsToolDispatcher({
    bot,
    send: tg,
    chunkText: chunkMarkdownText,
    deliverReplies,
    // Review F#1: required so [sticker:NAME] / [react:EMOJI] / canned-string
    // (`No response requested.`) protections fire on channels replies too.
    parseResponse,
    sanitizeAssistantReply,
    logEvent,
    logger: console,
  });
  const channelsClaudeBin = pinnedClaudeBin;

  const processFactory = createProcessFactory({
    config,
    spawnFn: buildSdkOptions,
    db,
    logger: console,
    tmuxRunner,
    botName: BOT_NAME,
    // channels backend
    toolDispatcher: channelsToolDispatcher,
    channelsClaudeBin,
  });
  // Route in-process approval prompts through the SAME canUseTool plumbing
  // that SDK chats use:
  //   - SdkProcess: SDK callbacks fire 'approval-required' via its own
  //                 canUseTool wiring (Anthropic SDK feature).
  //   - CliProcess (0.12): two paths emit this shape:
  //                 1. Channels bridge perm_req (experimental channel
  //                    permission API). Currently doesn't fire for
  //                    regular MCP tool calls (rc.9 finding).
  //                 2. Hook Notification on chats with non-bypass
  //                    permissionMode (0.12 Phase 4.5). respond() pipes
  //                    the verdict back via tmux send-keys "1"/"3"+Enter.
  // makeCanUseTool handles admin card, chat_tool_decisions persistence,
  // and timeout race — all reused from SDK.
  // 0.13 D2: 'input-dropped' → redeliver once via the D4 tail. Stable wrapper:
  // pm spread-copies the callbacks object at construction, and the redeliver
  // tail is wired later in main() — the wrapper late-binds it.
  sdkCallbacks.onInputDropped = (sessionKey, payload) => dropRedeliverer?.(sessionKey, payload);

  sdkCallbacks.onApprovalRequired = async (sessionKey, payload) => {
    const { toolName, toolInput, id, respond } = payload || {};
    if (typeof respond !== 'function') return;
    try {
      const canUseTool = makeCanUseTool(sessionKey);
      // 0.12 Phase 4: normalizeTuiToolInput was a TmuxProcess-specific
      // adapter that converted pane-scraped tool-input STRINGS into
      // structured objects. CliProcess + SdkProcess both deliver
      // structured tool_input directly (from channels permission_request
      // notification or SDK canUseTool callback) — no normalization
      // needed. Pass toolInput through as-is.
      const decision = await canUseTool(toolName, toolInput, { toolUseID: id });
      const verdict = decision?.behavior === 'allow' ? 'allow' : 'deny';
      await respond(verdict, decision?.message);
    } catch (err) {
      console.error(`[approval-required] ${sessionKey} ${toolName} → ${err.message}`);
      // Fail-closed: deny with the error as feedback.
      try { await respond('deny', `approval-flow error: ${err.message}`); }
      catch { /* swallow */ }
    }
  };

  pm = new ProcessManager({
    processFactory,
    db,
    logger: console,
    callbacks: sdkCallbacks,
    budget: cap,
  });
  // formatConfigInfoText MUST be wired BEFORE createHandleConfigCallback
  // — the latter destructures formatConfigInfoText from its deps at
  // call time and captures the value (closure-by-value). v4 reviewer
  // caught this as the same class as the v3 BLOCKER.
  formatConfigInfoText = createFormatConfigInfoText({
    pm, db, getClaudeSessionId,
  });
  handleConfigCallback = createHandleConfigCallback({
    config, db, dbWrite, pm, getSessionKey,
    formatConfigInfoText, buildConfigKeyboard, saveConfig,
    botName: BOT_NAME, logger: console,
  });
  handleAbortIfRequested = createHandleAbort({
    pm, bot, tg, logEvent, isAbortRequest,
    markSessionAborted, clearAutosteeredReactions, getSessionKey,
    botName: BOT_NAME, logger: console,
  });
  autosteer = createAutosteerHandlers({
    config, pm, autosteeredRefs, logEvent,
  });
  maybeInjectEditCorrection = createEditCorrectionInjector({
    pm, db, getSessionKey, config, logEvent, logger: console,
  });
  recordInbound = createRecordInbound({
    db, dbWrite, config, botName: BOT_NAME, extractAttachments,
  });
  handleSendOverIpc = createHandleSendOverIpc({
    config, bot, tg, botName: BOT_NAME,
  });
  ({
    dispatchHandleMessage,
    attemptAutoResume,
    errorReplyText,
    queueWarnThreshold,
    inFlightHandlers,
  } = createDispatcher({
    config, db, dbWrite, tg, botName: BOT_NAME, logEvent,
    handleMessage, sendToProcess,
    classifyError, isAutoResumable,
    abortGrace, autoResumeTracker,
    chunkMarkdownText, deliverReplies,
    chunkBudget: TG_CHUNK_BUDGET,
    getIsShuttingDown: () => isShuttingDown,
    logger: console,
  }));
  // 0.12.0 post-turn edit re-delivery: constructed AFTER dispatchHandleMessage is assigned (above).
  // An edit while a turn is in flight folds via maybeInjectEditCorrection; an edit after the turn
  // (or when the injector no-ops at the boundary) re-dispatches as a new turn. The on-edit 👀 is a
  // pre-turn ack for the cold-spawn gap; the synthetic turn's own reactor then takes over the msg.
  maybePostTurnEdit = createEditRedelivery({
    pm, config, getSessionKey, shouldHandle, dispatchHandleMessage, bot,
    react: (chatId, msgId) => applyReactionToMessages({
      tg, bot, chatId, msgIds: [msgId], emoji: '👀', botName: BOT_NAME,
    }).catch(() => {}),
    logEvent, logger: console,
  });
  // 0.13 D4: the ONE redelivery tail — boot-replay (below) and the P3
  // drop-redeliverer converge on it (once-only + _isReplay + redelivery-tier
  // gate + 👀 ack + dispatch). startup-auto-retry deliberately stays a
  // same-process re-dispatch (its error path must SURFACE the friendly reset
  // reply, which the _isReplay tag would suppress); compact-replay stays a
  // system re-push outside the user-message gate (design §6.7).
  redeliverAsFreshTurn = createRedeliver({
    gateInbound: (...a) => gateInbound(...a),
    dispatchHandleMessage, getSessionKey, config, db, dbWrite,
    react: (chatId, msgId) => applyReactionToMessages({
      tg, bot, chatId, msgIds: [msgId], emoji: '👀', botName: BOT_NAME,
    }).catch(() => {}),
    bot, logEvent, logger: console,
  });
  dropRedeliverer = createDropRedeliverer({
    db, redeliver: redeliverAsFreshTurn, logEvent, logger: console,
  });
  ({ pollBot, startPollWatchdog } = createPollLoop({
    db, dbWrite, config, botName: BOT_NAME,
    isWellFormedMessage, getTopicName,
    logger: console,
  }));
  dispatchSlashCommand = createSlashCommands({
    config, db, dbWrite, pm, pairings, parsePairingTtl,
    contextHintShown, formatContextReply, getClaudeSessionId,
    getOrSpawnForChat, parsePairCodeArgs,
    modelVersionsDesc: MODEL_VERSIONS_DESC, saveConfig,
    botName: BOT_NAME, logEvent, logger: console,
  });
  console.log('[polygram] using SDK ProcessManager');

  console.log(`polygram (LRU cap=${cap}, SQLite source of truth)`);
  console.log(`Chats: ${Object.entries(config.chats).map(([id, c]) => `${c.name} (${c.model}/${c.effort})`).join(', ')}`);

  // rc.48: validate per-topic config + isolateTopics relationship.
  // Per-topic SdkOptions overrides only take effect when each topic
  // gets its own SDK Query (isolateTopics: true). Without isolation
  // the Query is fixed at first-spawn time; subsequent topic-scoped
  // messages share that Query regardless of topic-level overrides.
  for (const [chatId, chatCfg] of Object.entries(config.chats)) {
    if (!chatCfg.topics || typeof chatCfg.topics !== 'object') continue;
    const overrideTopics = Object.entries(chatCfg.topics)
      .filter(([, t]) => t && typeof t === 'object'
        && Object.keys(t).some((k) => k !== 'name'));
    if (overrideTopics.length === 0) continue;
    if (chatCfg.isolateTopics !== true) {
      const ids = overrideTopics.map(([id]) => id).join(', ');
      console.warn(`[${BOT_NAME}] WARN: chat ${chatId} (${chatCfg.name}) has topic overrides on topic_ids=${ids} but isolateTopics is not true — overrides will be IGNORED. Set isolateTopics: true to make per-topic config take effect.`);
      logEvent('topic-override-without-isolation', {
        chat_id: chatId, name: chatCfg.name, topic_ids: ids,
      });
    }
  }

  // bot was created earlier in main() — see the wiring-order block
  // around the factory creations.

  // Graceful shutdown: stop accepting new inbound, drain in-flight pendings
  // up to SHUTDOWN_DRAIN_MS, then mark anything still unfinished so boot
  // replay picks it up. Prevents "Sorry, I couldn't process that message"
  // from showing on every restart.
  const SHUTDOWN_DRAIN_MS = 30_000;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\nShutting down...');
    // 1. Stop accepting new inbound first so nothing new queues behind the drain.
    if (bot && bot._stop) bot._stop();

    // 1.5 (0.13 D1): expire open interactive questions {cancelled} BEFORE the
    // drain. With D1 the asking turn stays in flight for the whole wait, so a
    // deploy during a question would otherwise eat the entire 30s drain and
    // mark the inbound replay-pending mid-ask. Cancelling unblocks claude's
    // ask so the cycle can end inside the drain; the boot-replay re-ask is the
    // documented recovery path (design §3 D1 ask-wait semantics).
    try {
      const openQuestions = questionStore.listOpen?.(BOT_NAME) || [];
      for (const row of openQuestions) {
        // eslint-disable-next-line no-await-in-loop
        await questionHandlers.expireQuestion(row, {
          status: 'cancelled',
          message: 'Bot is restarting — this question was cancelled. It may be re-asked in a moment.',
        }).catch(() => {});
      }
      if (openQuestions.length) {
        logEvent('shutdown-questions-cancelled', { count: openQuestions.length });
      }
    } catch (err) {
      console.error(`[shutdown] question expiry failed: ${err.message}`);
    }

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
        logEvent('shutdown-drain', {
          bot: BOT_NAME,
          in_flight: remaining,
          replay_marked: res?.changes ?? 0,
          elapsed_ms: drainElapsed,
        });
        console.log(`[shutdown] drained ${drainElapsed}ms, ${remaining} still in-flight, ${res?.changes ?? 0} rows marked replay-pending`);
      } catch (err) {
        console.error(`[shutdown] markReplayPending failed: ${err.message}`);
      }
    } else if (db) {
      logEvent('shutdown-drain', {
        bot: BOT_NAME,
        in_flight: 0,
        elapsed_ms: drainElapsed,
      });
      console.log(`[shutdown] clean drain in ${drainElapsed}ms`);
    }

    // 4. Remaining shutdown: approvals sweeper, IPC, resolve hook waiters,
    //    kill pm subprocesses, close DB.
    if (approvalSweepTimer) clearInterval(approvalSweepTimer);
    if (ipcCloser) ipcCloser.close().catch(() => {});
    try { fs.unlinkSync(ipcServer.secretPathFor(BOT_NAME)); } catch {}
    // Reject every parked canUseTool waiter so the SDK doesn't
    // hang on a dangling approval Promise. v4 review caught this:
    // commit 29 moved the Map into lib/handlers/approvals.js; the
    // old `approvalWaiters` reference here would ReferenceError
    // mid-shutdown and prevent pm/DB cleanup.
    if (cancelAllWaiters) cancelAllWaiters('cancelled', 'polygram shutting down');
    if (pm) await pm.shutdown().catch(() => {});
    if (db) {
      try { db.logEvent('polygram-stop'); db.raw.close(); } catch {}
    }
    // rc.50: release our PID file claim so the next boot doesn't try
    // to kill us. releasePidFile is idempotent and only deletes the
    // file when its content matches our PID — a new daemon that
    // already claimed the slot is left alone.
    if (PID_PATH) processGuard.releasePidFile(PID_PATH);
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // rc.28: also catch SIGHUP. The shumabit deploy path runs polygram
  // inside `tmux new-session`; on `launchctl kickstart -k` the
  // shumabit-start launcher does `tmux kill-session -t polygram`
  // FIRST, then `pkill polygram --bot` 1s later. tmux kill-session
  // closes polygram's controlling pty → SIGHUP, not SIGTERM. Without
  // this listener, the shutdown drain never fires; in-flight rows
  // never flip to 'replay-pending'; boot-replay still picks them up
  // via the 'dispatched' status (3-min window), but anything that's
  // been mid-tool-use longer than the replayWindowMs gets silently
  // dropped. Surface symptom: bot stops responding after deploy on
  // long agent runs (the §7.4 incident).
  process.on('SIGHUP', shutdown);

  try {
    // Fresh per-boot secret, persisted 0600 for same-UID readers (cron
    // scripts, hook); also exported to spawned Claude processes via env.
    const ipcSecret = ipcServer.writeSecret(BOT_NAME);
    process.env.POLYGRAM_IPC_SECRET = ipcSecret;
    ipcCloser = await ipcServer.start({
      path: ipcServer.socketPathFor(BOT_NAME),
      secret: ipcSecret,
      handlers: {
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
  // handler) — all within the last `replayWindowMs` so we don't
  // resurrect ancient work. Dedupe against already-sent outbound
  // replies in case the previous instance DID answer before dying.
  //
  // rc.57: auto-derive replayWindowMs from max(maxTurn) * 1.2 when not
  // explicitly set. Pre-rc.57 the default was 3 min — but chats with
  // long agent tasks (Shumabit@UMI maxTurn=3600 = 60 min) would have
  // their interrupted turns silently dropped because the turn was
  // typically older than 3 min when polygram restarted. Discovery
  // context: msg 151 in Shumabit@UMI thread :24 on 2026-05-05 was
  // sent at 01:55:14, polygram restarted for rc.56 at 02:17 (22 min
  // later). msg 151 was 'replay-pending' but boot-replay's 3-min
  // window discarded it; the agent's 7-hour Xero task was abandoned.
  // Auto-derive: 1.2 × max(chatConfig.maxTurn) across all chats,
  // floored at 3 min (legacy default), capped at 2 hours (sanity).
  try {
    const chatIds = Object.keys(config.chats);
    if (chatIds.length > 0) {
      const replayWindowMs = resolveReplayWindowMs(config);
      const candidates = db.getReplayCandidates({ chatIds, ...(replayWindowMs && { olderThanMs: replayWindowMs }) });
      let replayed = 0;
      let skipped = 0;
      for (const row of candidates) {
        // rc.51: dedupe on turn_metrics (definitive turn completion),
        // NOT just on hasOutboundReplyTo. The latter trips on
        // intermediate ack-bubbles (e.g. "Catching up on history…",
        // "I'll write a quick inline script…") and silently skips the
        // replay even when the actual answer never arrived. The rc.50
        // EIO-orphan incident lost Ivan DM msg 12158 this way: an ack
        // bubble was sent at 13:20:36, the turn was killed mid-flight,
        // boot-replay saw the ack and assumed "answered."
        //
        // turn_metrics is only inserted by the SDK pm's onResult
        // callback, which fires only when the turn definitively
        // completes. No row → no completion → re-dispatch.
        if (db.hasCompletedTurnFor({ chat_id: row.chat_id, msg_id: row.msg_id })) {
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
        // Attach already-recorded attachments via the media-group shortcut
        // field so extractAttachments picks them up without re-parsing
        // grammy fields that don't exist on this reconstructed object.
        const attRows = db.getAttachmentsByMessage(row.id);
        if (attRows.length) {
          reconstructed._mergedAttachments = attRows.map((a) => ({
            kind: a.kind, name: a.name, mime_type: a.mime_type,
            size: a.size_bytes, file_id: a.file_id, file_unique_id: a.file_unique_id,
          }));
        }
        const chatConfig = config.chats[row.chat_id];
        if (!chatConfig) { skipped += 1; continue; }
        // 0.13 D4: through the unified redelivery tail — _isReplay tag (error
        // reply suppressed, not replay-eligible), 'replay-attempted' pre-mark
        // (one-shot: even if THIS attempt dies mid-turn, the next boot won't
        // loop), the D5 gate at tier 'redelivery' (abort/admin-shaped rows are
        // never auto-re-executed; a row whose chat lost its pairing since is
        // re-checked), a 👀 ack so the recovery is visible, then dispatch.
        // eslint-disable-next-line no-await-in-loop
        const r = await redeliverAsFreshTurn({
          chatId: row.chat_id, msg: reconstructed,
          source: 'boot-replay', preMark: 'replay-attempted',
        });
        if (r.ok) replayed += 1;
        else skipped += 1;
      }
      if (candidates.length > 0) {
        console.log(`[replay] ${replayed} turns re-dispatched, ${skipped} skipped (already replied or no chat config)`);
        logEvent('replay-on-boot', {
          bot: BOT_NAME, replayed, skipped, total: candidates.length,
        });
      }
    }
  } catch (err) {
    console.error(`[replay] boot replay failed: ${err.message}`);
  }

  // rc.61 + rc.65: handle compact-command events that were never
  // paired with a compact-boundary (deploy / crash interrupted them
  // before the SDK processed). rc.65 changes behaviour from
  // "post a 'please retry' message and ask the user" to
  // "silently retry by re-pushing the same /compact text to a
  // freshly-spawned (resumed) Query." Same pattern as boot-replay
  // for inbound messages — recovery should be invisible.
  //
  // Requirements for a silent retry:
  //   1. The compact-command event was logged with full `text`
  //      (rc.65+ does this; pre-rc.65 events have only text_len —
  //      we fall back to the old "please retry" message for those).
  //   2. The chat is still configured (config.chats[chat_id] exists).
  //   3. The session has a saved claude_session_id we can resume.
  //
  // Dedupe: if multiple orphans for the same session_key (e.g. user
  // ran /compact twice in quick succession before a deploy), retry
  // only the MOST RECENT — older ones are obsolete.
  //
  // Scan window matches replayWindowMs — anything older than the
  // bot's expected long-turn ceiling is stale.
  try {
    const orphansAll = db.findOrphanedCompactCommands({
      olderThanMs: resolveReplayWindowMs(config) ?? 30 * 60 * 1000,
    });
    // Dedupe per-session_key, keep the most recent (highest ts).
    const orphansLatest = new Map();
    for (const o of orphansAll) {
      orphansLatest.set(o.session_key, o);
    }
    let replayed = 0;
    let surfacedFallback = 0;
    for (const o of orphansLatest.values()) {
      const chatCfg = config.chats[o.chat_id];
      if (!chatCfg) continue;
      const threadId = o.thread_id ? Number(o.thread_id) : null;
      const savedSessionId = getClaudeSessionId(db, o.session_key);

      // Silent retry path: only when we have BOTH the original text
      // (rc.65+) AND a session_id to resume into.
      if (o.text && savedSessionId) {
        try {
          const entry = await pm.getOrSpawn(o.session_key, buildSpawnContext(o.session_key));
          // 0.10.0 P0.4: route through Process.fireUserMessage so both
          // SDK and tmux backends work. Pre-0.10.0-P0.4 reached into
          // entry.inputController.push directly — broken on tmux.
          if (!entry || typeof entry.fireUserMessage !== 'function') {
            throw new Error('Process.fireUserMessage not available');
          }
          const ok = entry.fireUserMessage(o.text);
          if (!ok) {
            throw new Error('fireUserMessage refused (closed or empty content)');
          }
          logEvent('compact-replay', {
            chat_id: o.chat_id,
            thread_id: o.thread_id,
            session_key: o.session_key,
            original_ts: o.ts,
            text_len: o.text.length,
            user: o.user,
            user_id: o.user_id,
          });
          replayed += 1;
          continue;
        } catch (err) {
          console.error(`[compact-replay] ${o.session_key}: ${err.message} — falling back to surface`);
          // fall through to surface fallback below
        }
      }

      // Fallback: surface the legacy "please retry" message. Only
      // happens for pre-rc.65 events (no `text` field) or when
      // the silent-retry spawn failed.
      try {
        await tg(bot, 'sendMessage', {
          chat_id: o.chat_id,
          text: '🗜️ Last `/compact` was interrupted by a polygram restart before it could finish. Run `/compact` again (with the same hint if you had one) to retry.',
          ...(threadId ? { message_thread_id: threadId } : {}),
        }, { source: 'compact-failed-restart', botName: BOT_NAME });
        logEvent('compact-failed-restart', {
          chat_id: o.chat_id,
          thread_id: o.thread_id,
          session_key: o.session_key,
          original_ts: o.ts,
          user: o.user,
          user_id: o.user_id,
          reason: o.text ? 'spawn-failed' : 'pre-rc65-event-no-text',
        });
        surfacedFallback += 1;
      } catch (err) {
        console.error(`[compact-orphan-surface] ${o.session_key}: ${err.message}`);
      }
    }
    if (replayed + surfacedFallback > 0) {
      console.log(`[compact-orphan] silent-replayed=${replayed}, surfaced-fallback=${surfacedFallback}`);
    }
  } catch (err) {
    console.error(`[compact-orphan-handler] failed: ${err.message}`);
  }

  console.log(`[${BOT_NAME}] Starting...`);
  const pollPromise = pollBot(bot).catch(err => {
    console.error(`[${BOT_NAME}] Fatal:`, err.message);
  });

  const watchdogTimer = startPollWatchdog(bot, { logEvent });
  process.once('exit', () => clearInterval(watchdogTimer));

  await pollPromise;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
