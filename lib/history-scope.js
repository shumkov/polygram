'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const history = require('./history');
const { getChatIdFromKey, getThreadIdFromKey } = require('./session-key');

const SCRIPT = path.resolve(__dirname, '../skills/history/scripts/query.js');
const SUBCOMMANDS = new Set(['recent', 'around', 'search', 'by-user', 'msg', 'stats']);
const FIELDS = ['sub', 'chatId', 'threadId', 'query', 'user', 'msgId', 'limit', 'since', 'days', 'before', 'after', 'includeOutbound'];
const MAX_TEXT = 500;
const INVALID_SCOPE = 'History scope is not valid; use the history command from your current turn';
const OTHER_CHAT = 'This session can read only its own chat';
const OTHER_TOPIC = 'This session can read only its own topic';
// How many earlier commands of a session still read. A turn overtaken by a
// queued prompt keeps its own command; anything older is refused, so a
// command copied into a shared file or handed to another session stops
// working after a few prompts.
const MAX_EARLIER_TOKENS = 4;
// Agent-supplied names echoed in an error (and so in the daemon log).
const shown = (value) => String(value).slice(0, 64);

function refuse(message) { return Object.assign(new Error(message), { code: 'HISTORY_SCOPE' }); }

function text(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error(`Invalid history ${label}`);
  return value;
}
// A chat or thread id: a string or a finite number, nothing that only
// stringifies to one.
function ident(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value, label);
}
function number(value, label) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid history ${label}`);
  return n;
}

// Transcript reads for agent sessions. Every prompt polygram sends a session
// carries a history command holding a fresh scope token; the daemon,
// never the agent, maps the token to the session and so to the one chat (and,
// for an isolated topic, the one topic) it may read. A chat or topic the
// agent names is only compared against that scope, never used to widen it.
// Tokens live in daemon memory, so a restart invalidates every command and
// the next prompt brings a new one. No session, the operator's included, can
// read another chat through this path: a cross-chat read would turn any
// session that has seen foreign content into a way to leak every other
// conversation of the bot.
function createHistoryService({ config, db, botName, ipcDir = null }) {
  const sessions = new Map();
  const live = new Map();
  // An external job that the busy session defers is rebuilt on every retry;
  // it keeps one token, so retries cannot push a running turn's command out.
  const jobTokens = new Map();
  const jobOf = new Map();
  const usable = (sessionKey) => typeof sessionKey === 'string' && sessionKey !== '' && !!db?.raw;

  function forget(token) {
    sessions.delete(token);
    const job = jobOf.get(token);
    if (job !== undefined) { jobOf.delete(token); jobTokens.delete(job); }
  }
  function mint(sessionKey) {
    const token = randomUUID();
    sessions.set(token, sessionKey);
    const tokens = [...(live.get(sessionKey) ?? []), token];
    while (tokens.length > MAX_EARLIER_TOKENS + 1) forget(tokens.shift());
    live.set(sessionKey, tokens);
    return token;
  }
  function tokenFor(sessionKey, job) {
    if (!job) return mint(sessionKey);
    const key = `${job.routeId}\0${job.requestId}`;
    const kept = jobTokens.get(key);
    if (kept !== undefined && sessions.get(kept) === sessionKey) return kept;
    if (kept !== undefined) { jobTokens.delete(key); jobOf.delete(kept); }
    const token = mint(sessionKey);
    jobTokens.set(key, token);
    jobOf.set(token, key);
    return token;
  }
  // The session's newest token, minted when it has none.
  function scope(sessionKey) {
    if (!usable(sessionKey)) return null;
    return live.get(sessionKey)?.at(-1) ?? mint(sessionKey);
  }

  // The chat and thread scope the token's session may read, re-derived from
  // the live config on every call, so a chat removed from the config stops
  // being readable at once.
  function resolve(token) {
    const sessionKey = typeof token === 'string' ? sessions.get(token) : undefined;
    if (!sessionKey) throw refuse(INVALID_SCOPE);
    const chatId = getChatIdFromKey(sessionKey);
    const chat = config.chats?.[chatId];
    if (!chat || (chat.bot && chat.bot !== botName)) throw refuse(INVALID_SCOPE);
    const threadId = getThreadIdFromKey(sessionKey);
    // A topic session reads only its topic. The General topic of a chat with
    // isolated topics reads only rows without a thread. A chat-wide session
    // already sees every topic of its chat, so it reads all of them.
    if (threadId !== null) return { chatId, threadScope: threadId };
    if (chat.isolateTopics === true) return { chatId, threadScope: null };
    return { chatId, threadScope: undefined };
  }

  // The command line appended to a prompt, with a token minted for it, or,
  // for an external job, the token its earlier attempts already carried.
  function instructions(sessionKey, job = null) {
    if (!usable(sessionKey)) return '';
    const token = tokenFor(sessionKey, job);
    const command = [...(ipcDir ? [`POLYGRAM_IPC_DIR=${JSON.stringify(ipcDir)}`] : []),
      ...[process.execPath, SCRIPT, botName, token].map((part) => JSON.stringify(part))].join(' ');
    return `\nOwn-chat history: run ${command} recent [--limit N] [--since 6h] | search <term> | by-user <name> | around --msg-id N | msg <msg_id> | stats [--days N]`
      + ' (add --format pretty for readable lines). It reads only this conversation\'s own chat; other chats are not reachable. Use the command from your current turn.\n';
  }

  function query(token, input) {
    const own = resolve(token);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('History input object required');
    for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw new Error(`Unknown history field: ${shown(key)}`);
    if (!SUBCOMMANDS.has(input.sub)) throw new Error(`Unknown history subcommand: ${shown(input.sub)}`);
    const chatId = ident(input.chatId, 'chat');
    const threadId = ident(input.threadId, 'thread');
    if (chatId !== null && chatId !== own.chatId) throw refuse(OTHER_CHAT);
    let threadScope = own.threadScope;
    if (threadScope !== undefined) {
      if (threadId !== null && threadId !== threadScope) throw refuse(OTHER_TOPIC);
    } else if (threadId !== null) {
      threadScope = threadId;
    }
    const scoped = { allowedChatIds: [own.chatId], threadScope };
    const limit = number(input.limit, 'limit');
    const days = number(input.days, 'days');

    switch (input.sub) {
      case 'recent':
        return { rows: history.recent(db, {
          chatId: own.chatId,
          threadId: typeof threadScope === 'string' ? threadScope : null,
          scopeThread: threadScope === null,
          limit,
          since: text(input.since, 'since'),
          includeOutbound: input.includeOutbound !== false,
          allowedChatIds: scoped.allowedChatIds,
        }) };
      case 'around': {
        const msgId = number(input.msgId, 'message id');
        if (!msgId) throw new Error('around: --msg-id required');
        return { rows: history.around(db, { chatId: own.chatId, msgId, before: number(input.before, 'before') ?? 5, after: number(input.after, 'after') ?? 5, ...scoped }) };
      }
      case 'search': {
        const term = text(input.query, 'search term');
        if (!term) throw new Error('search: <term> required');
        return { rows: history.search(db, { query: term, user: text(input.user, 'user'), days: days ?? null, limit, ...scoped }) };
      }
      case 'by-user': {
        const user = text(input.user, 'user');
        if (!user) throw new Error('by-user: <user> required');
        return { rows: history.byUser(db, { user, days: days ?? 7, limit, ...scoped }) };
      }
      case 'msg': {
        const msgId = number(input.msgId, 'message id');
        if (!msgId) throw new Error('msg: <msg_id> required');
        const row = history.getMsg(db, { msgId, ...scoped });
        return { rows: row ? [row] : [] };
      }
      case 'stats':
        return { rows: history.stats(db, { days: days ?? 7, ...scoped }) };
      default:
        throw new Error(`Unknown history subcommand: ${shown(input.sub)}`);
    }
  }

  return { scope, instructions, query };
}

module.exports = { createHistoryService };
