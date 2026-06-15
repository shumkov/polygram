/**
 * SessionStart hook factory: preloads recent chat history into a
 * fresh SDK Query so the agent has context on day-zero.
 *
 * Why: when polygram spawns a brand-new Query for a chat (daemon
 * boot, /new, /reset), the SDK has no transcript — the model
 * starts blank even though the chat has been running for weeks.
 * The user has to re-explain context every time. This hook injects
 * the last N polygram-stored messages into the new session's
 * `additionalContext`, plus a hint that the agent can query the
 * history skill for older messages it didn't get preloaded.
 *
 * Fires only when SessionStart's `source` is 'startup' or 'clear'
 * (genuinely fresh sessions). Skips on 'resume' (SDK is restoring
 * the prior transcript) and 'compact' (SDK just compacted; history
 * is already in the post-compact summary).
 *
 * Reuses lib/history.js's `recent()` helper — same DB query the
 * polygram history skill exposes via CLI, so the agent's skill
 * invocations and our preload return consistent shapes.
 */

'use strict';

const history = require('./history');
const { xmlEscape } = require('./prompt');

const DEFAULT_PRELOAD_LIMIT = 15;
const DEFAULT_PRELOAD_SINCE = '7d';

/**
 * Format a single message row as a transcript line.
 *
 *   [2026-04-30 09:15] Ivan Shumkov: hello
 *   [2026-04-30 09:16] bot: hey
 *
 * Schema notes: messages table uses `direction` = 'in'|'out',
 * `user` for the sender display name (inbound) or bot identity
 * (outbound). reply_to_id is on the row directly. Attachment and
 * voice flags live on the attachments table via JOIN — not
 * surfaced here in the preload (operator-curated history docs are
 * the place for that level of detail).
 */
function formatRow(row) {
  const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 16);
  // #10 security: `who` (username) and `text` (message body) are user-supplied.
  // This block is injected into the agent's prompt inside <polygram-history>;
  // without escaping, a stored message containing `</polygram-history><system>…`
  // breaks the container and lands instructions outside any fence — a persistent
  // prompt-injection firing on every fresh session. xmlEscape neutralizes the
  // tag chars so embedded markup stays literal text.
  const who = xmlEscape(row.direction === 'in'
    ? (row.user || row.user_id || 'user')
    : (row.user || row.bot_name || 'bot'));
  const prefix = row.reply_to_id ? `[reply→#${row.reply_to_id}] ` : '';
  const text = xmlEscape((row.text || '').replace(/\s+/g, ' ').slice(0, 600));
  return `[${ts}] ${who}: ${prefix}${text}`;
}

/**
 * Build the SessionStart hook callback.
 *
 * @param {object} opts
 * @param {object} opts.db                     polygram db wrapper (has .raw better-sqlite3 instance)
 * @param {string} opts.chatId                 the chat being spawned
 * @param {string|null} [opts.threadId]
 * @param {string[]} [opts.allowedChatIds]     scope-narrowing safety; defaults to [chatId]
 * @param {number} [opts.limit]                max messages to preload (default 15)
 * @param {string} [opts.since]                cutoff window (default '7d')
 * @param {(kind: string, detail: object) => void} [opts.logEvent]
 * @param {object} [opts.logger]
 *
 * @returns {async (input) => Promise<HookJSONOutput>}
 */
function makeSessionStartHook({
  db,
  chatId,
  threadId = null,
  isolateTopics = false,
  allowedChatIds = null,
  limit = DEFAULT_PRELOAD_LIMIT,
  since = DEFAULT_PRELOAD_SINCE,
  logEvent = null,
  logger = console,
} = {}) {
  if (!db || !db.raw) throw new TypeError('db (with .raw better-sqlite3) required');
  if (!chatId) throw new TypeError('chatId required');

  return async (input) => {
    try {
      // Skip on resume / compact — transcript already has history.
      if (input?.source === 'resume' || input?.source === 'compact') {
        return { continue: true };
      }

      const scope = allowedChatIds || [String(chatId)];
      let rows;
      try {
        // history.recent() expects the polygram db wrapper (it
        // calls db.raw.prepare internally), not the raw bsqlite3.
        rows = history.recent(db, {
          chatId: String(chatId),
          threadId: threadId ?? null,
          scopeThread: isolateTopics === true,   // cross-topic bleed fix (null = General only)
          limit,
          since,
          includeOutbound: true,
          allowedChatIds: scope,
        }) || [];
      } catch (err) {
        logger?.error?.(`[history-preload] recent() failed: ${err?.message || err}`);
        return { continue: true };
      }

      if (rows.length === 0) {
        return { continue: true };
      }

      // history.recent() returns rows in chronological order
      // already (it does `ORDER BY ts DESC LIMIT N` then `.reverse()`
      // internally — see lib/history.js:69).
      const lines = rows.map(formatRow).join('\n');

      const additionalContext = [
        `<polygram-history chat_id="${chatId}"${threadId ? ` thread_id="${threadId}"` : ''} preloaded="${rows.length}" since="${since}">`,
        lines,
        `</polygram-history>`,
        '',
        '— More history available via `node skills/history/scripts/query.js`:',
        '    recent <chat_id> [thread_id] --limit N  (older than the preload window)',
        '    around --chat <id> --msg-id N           (context window around a message)',
        '    search <term> [chat_id]                 (FTS5 across full transcript)',
        '    by-user <name> [chat_id] [thread_id]',
        '  Bot scope is auto-resolved from cwd; no admin flag needed.',
      ].join('\n');

      if (typeof logEvent === 'function') {
        try {
          logEvent('history-preloaded', {
            chat_id: chatId,
            session_source: input?.source ?? 'startup',
            row_count: rows.length,
            text_len: additionalContext.length,
          });
        } catch { /* swallow logger errors */ }
      }

      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext,
        },
      };
    } catch (err) {
      logger?.error?.(`[history-preload] hook error: ${err?.message || err}`);
      // Never throw out of a hook.
      return { continue: true };
    }
  };
}

/**
 * rc.52: synchronous variant of the same preload, returning the
 * `<polygram-history>` block as a string ready to prepend to the
 * fresh-session user message. Replaces the SessionStart-hook path
 * (the SDK's `Options.hooks.SessionStart` is a documented API that
 * the runtime does not actually dispatch — verified by spike +
 * SDK source grep, see rc.52 commit).
 *
 * Exclude the row corresponding to `excludeMsgId` from the preload
 * — that's the user message we're about to send, no need to echo
 * it back to itself in the history block.
 *
 * Returns '' (empty string) when there's nothing to inject — caller
 * just skips the prepend.
 */
function buildHistoryBlock({
  db,
  chatId,
  threadId = null,
  isolateTopics = false,
  excludeMsgId = null,
  limit = DEFAULT_PRELOAD_LIMIT,
  since = DEFAULT_PRELOAD_SINCE,
  logger = console,
} = {}) {
  if (!db?.raw || !chatId) return '';
  let rows;
  try {
    rows = history.recent(db, {
      chatId: String(chatId),
      threadId: threadId ?? null,
      // isolateTopics → scope to THIS thread (null = General only); else the
      // chat-wide session legitimately spans all topics. (cross-topic bleed fix)
      scopeThread: isolateTopics === true,
      limit,
      since,
      includeOutbound: true,
      allowedChatIds: [String(chatId)],
    }) || [];
  } catch (err) {
    logger?.error?.(`[history-preload] recent() failed: ${err?.message || err}`);
    return '';
  }
  if (excludeMsgId != null) {
    rows = rows.filter((r) => String(r.msg_id) !== String(excludeMsgId));
  }
  if (rows.length === 0) return '';
  const lines = rows.map(formatRow).join('\n');
  const attrs = `chat_id="${chatId}"${threadId ? ` thread_id="${threadId}"` : ''} preloaded="${rows.length}" since="${since}"`;
  return [
    `<polygram-history ${attrs}>`,
    lines,
    `</polygram-history>`,
    '',
    '— More history available via `node skills/history/scripts/query.js`:',
    '    recent <chat_id> [thread_id] --limit N  (older than the preload window)',
    '    around --chat <id> --msg-id N           (context window around a message)',
    '    search <term> [chat_id]                 (FTS5 across full transcript)',
    '    by-user <name> [chat_id] [thread_id]',
    '  Bot scope is auto-resolved from cwd; no admin flag needed.',
  ].join('\n');
}

module.exports = {
  makeSessionStartHook,
  buildHistoryBlock,
  // Internals for tests
  _formatRow: formatRow,
  DEFAULT_PRELOAD_LIMIT,
  DEFAULT_PRELOAD_SINCE,
};
