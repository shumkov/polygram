/**
 * channels-tool-dispatcher — adapter between ChannelsProcess's reply tool
 * callback and polygram's existing Telegram delivery primitives.
 *
 * ChannelsProcess calls `toolDispatcher({sessionKey, chatId, threadId,
 * toolName, text, files})` whenever Claude invokes the reply tool over
 * the Channels protocol. This module wires that into:
 *   - lib/telegram/chunk.js     for size-aware splitting
 *   - lib/telegram/deliver.js   for the actual sendMessage loop
 *   - bot.api.sendPhoto/Document for file attachments
 *
 * The dispatcher returns `{ok: boolean, error?: string}` — ChannelsProcess
 * relays this to the bridge as tool_ack, which surfaces to Claude as the
 * tool's return value (`'sent'` on ok, error message on failure).
 *
 * Decoupled from polygram.js: factory takes {bot, send, chunkText, logger}
 * — same shape SDK callbacks already use — so it can be tested with fakes
 * and constructed in any caller.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// P0 #2: file-attachment allowlist. Prompt-injected Claude can call
// reply(files: ['/etc/passwd', '~/.ssh/id_rsa', '~/.aws/credentials']) and the
// daemon would happily read + upload to Telegram. Restrict to:
//   - Files under the session's cwd (typically the agent's workspace)
//   - Files under a per-session attachments dir we own (/tmp/polygram-attachments/<sessionKey>/)
//   - Files under /tmp/polygram-attachments/ (claude staging area, shared per host)
// Symlinks are resolved via realpath BEFORE the allowlist check so a symlink in
// an allowed dir pointing at /etc/passwd is rejected.
//
// Override via opts.attachmentAllowlist (absolute paths) if callers need
// additional roots (e.g. a configured uploads dir).
const DEFAULT_ATTACHMENT_BASE = path.join(os.tmpdir(), 'polygram-attachments');

function isPathUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validate that a file path is safe to upload.
 *
 * @returns {{ ok: true, resolved: string } | { ok: false, error: string }}
 */
function validateAttachmentPath(filePath, allowedRoots) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: 'path must be non-empty string' };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, error: 'path must be absolute' };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
  } catch (err) {
    return { ok: false, error: `realpath failed: ${err.code || err.message}` };
  }
  // Reject any traversal outside the allowed roots
  const allowed = allowedRoots.some(root => {
    try {
      const rootReal = fs.realpathSync(root);
      return resolved === rootReal || isPathUnder(resolved, rootReal);
    } catch { return false; }
  });
  if (!allowed) {
    return { ok: false, error: `path outside allowed roots: ${resolved}` };
  }
  // Reject directories (would upload nothing meaningful)
  let st;
  try { st = fs.statSync(resolved); }
  catch (err) { return { ok: false, error: `stat failed: ${err.message}` }; }
  if (!st.isFile()) {
    return { ok: false, error: 'path is not a regular file' };
  }
  return { ok: true, resolved };
}

/**
 * @param {object} deps
 * @param {object} deps.bot                        — grammy Bot instance
 * @param {Function} deps.send                     — tg(bot, method, params, meta) sender wrapper
 * @param {Function} deps.chunkText                — (text, maxLen?) → string[] chunks (chunkMarkdownText)
 * @param {Function} deps.deliverReplies           — async ({ bot, send, chatId, threadId, chunks, replyToMessageId, meta, logger }) → { sent, failed }
 * @param {Function} deps.parseResponse            — Review F#1: text → { text, sticker, stickers[], reaction, reactions[], ... }; required so [sticker:NAME] / [react:EMOJI] don't leak as literal text
 * @param {Function} deps.sanitizeAssistantReply   — Review F#1: text → { text, replaced, original? }; required so CLI canned strings (`No response requested.`) are intercepted
 * @param {Function} [deps.processAndDeliverAgentText] — Review F#1: defaults to lib/telegram/process-agent-reply.js helper; DI-overridable for tests
 * @param {Function} [deps.logEvent]               — (kind, detail) → void; piped into the helper for canned-reply-suppressed forensics
 * @param {object} [deps.logger=console]
 * @param {number} [deps.maxChunkLen=4000]         — TG hard cap is 4096; leave headroom for HTML wrapping
 * @param {string[]} [deps.attachmentAllowlist]    — additional absolute-path roots files may live under (extends defaults)
 * @returns {Function} dispatcher
 */
function createChannelsToolDispatcher({
  bot,
  send,
  chunkText,
  deliverReplies,
  parseResponse,
  sanitizeAssistantReply,
  processAndDeliverAgentText,
  logEvent = null,
  logger = console,
  maxChunkLen = 4000,
  attachmentAllowlist = [],
} = {}) {
  if (!bot) throw new TypeError('channels-tool-dispatcher: bot required');
  if (typeof send !== 'function') throw new TypeError('channels-tool-dispatcher: send required');
  if (typeof chunkText !== 'function') throw new TypeError('channels-tool-dispatcher: chunkText required');
  if (typeof deliverReplies !== 'function') throw new TypeError('channels-tool-dispatcher: deliverReplies required');
  if (typeof parseResponse !== 'function') throw new TypeError('channels-tool-dispatcher: parseResponse required (Review F#1)');
  if (typeof sanitizeAssistantReply !== 'function') throw new TypeError('channels-tool-dispatcher: sanitizeAssistantReply required (Review F#1)');

  // Review F#1: route reply text through the shared agent-reply pipeline so
  // parseResponse + sanitizeAssistantReply + chunkMarkdownText + deliverReplies
  // + inline sticker/reaction handling fire uniformly with SDK/tmux callers.
  // Pre-fix the dispatcher did raw `chunkText` + `deliver()`, leaking
  // [sticker:NAME], [react:EMOJI], and `No response requested.` as literal
  // text into Telegram.
  const deliverAgent = processAndDeliverAgentText
    || require('../telegram/process-agent-reply').processAndDeliverAgentText;

  return async function channelsToolDispatcher(call) {
    const { sessionKey, chatId, threadId, toolName, text, files, sourceMsgId } = call;

    if (toolName !== 'reply') {
      // 0.11.0 Phase 1 ships `reply` only — react and edit_message are
      // deferred (Decision #10). Future tools route through here too.
      return { ok: false, error: `unsupported tool: ${toolName}` };
    }

    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: 'reply.text missing or empty' };
    }
    if (!chatId) {
      return { ok: false, error: 'reply.chat_id missing' };
    }

    try {
      // Review F#1: helper does parse → sanitize → chunk → deliver →
      // inline-sticker → reaction in one place. summary.deliverResult is
      // null if the post-parse text was empty (solo sticker/reaction).
      const summary = await deliverAgent({
        text,
        bot,
        tg: send,
        chatId,
        threadId,
        replyToMessageId: sourceMsgId || null,
        applyReactions: sourceMsgId != null,
        source: 'channels-tool-dispatcher',
        meta: { sessionKey, toolName },
        parseResponse,
        sanitizeAssistantReply,
        chunkMarkdownText: chunkText,
        deliverReplies,
        chunkBudget: maxChunkLen,
        logEvent,
        sessionKey,
        logger,
      });

      const dr = summary.deliverResult;
      if (dr && dr.failed?.length > 0) {
        const failedDetail = dr.failed.map(f => f.error?.message || 'unknown').join(', ');
        const totalChunks = (dr.sent?.length || 0) + dr.failed.length;
        return { ok: false, error: `delivered ${dr.sent?.length || 0} of ${totalChunks} chunks; failed: ${failedDetail}` };
      }

      // File attachments — sent as separate messages AFTER the text.
      // Photos for image MIMEs, Documents for everything else (matches
      // the official Telegram channels plugin behavior).
      // P0 #2: every path validated against an allowlist of safe roots
      // BEFORE any disk read or upload. Symlinks resolved via realpath.
      // Files outside the allowlist are rejected with a logged warning;
      // upload is NEVER attempted, so prompt-injected /etc/passwd, SSH
      // keys, and AWS creds can't leak to Telegram.
      const failedAttachments = [];
      if (Array.isArray(files) && files.length > 0) {
        const allowedRoots = buildAllowedRoots({
          sessionKey,
          sessionCwd: call.sessionCwd,
          extraRoots: attachmentAllowlist,
        });
        for (const filePath of files) {
          const check = validateAttachmentPath(filePath, allowedRoots);
          if (!check.ok) {
            logger.warn?.(
              `[channels-tool-dispatcher] file attach REJECTED for sessionKey=${sessionKey} ` +
              `path=${JSON.stringify(filePath)} reason=${check.error}`,
            );
            failedAttachments.push({ path: filePath, error: check.error });
            continue;
          }
          try {
            const ext = path.extname(check.resolved).toLowerCase();
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            const method = isImage ? 'sendPhoto' : 'sendDocument';
            const fieldName = isImage ? 'photo' : 'document';
            const params = {
              chat_id: chatId,
              [fieldName]: { source: check.resolved },
            };
            if (threadId) params.message_thread_id = threadId;
            await send(bot, method, params, { source: 'channels-tool-dispatcher', sessionKey });
          } catch (err) {
            logger.warn?.(`[channels-tool-dispatcher] file attach failed for ${check.resolved}: ${err.message}`);
            failedAttachments.push({ path: filePath, error: err.message });
            // Continue with other files — partial delivery beats whole-call failure.
          }
        }
      }

      // R9: surface file-attach failures so Claude knows what didn't land.
      if (failedAttachments.length > 0) {
        return {
          ok: false,
          error: `${failedAttachments.length} of ${files.length} file(s) failed: ` +
                 failedAttachments.map(f => `${f.path} (${f.error})`).join('; '),
        };
      }
      return { ok: true };
    } catch (err) {
      logger.error?.(`[channels-tool-dispatcher] ${sessionKey} dispatch failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  };
}

/**
 * Build the per-call allowed-roots list. Includes:
 *   - DEFAULT_ATTACHMENT_BASE  (/tmp/polygram-attachments — host-wide staging)
 *   - /tmp/polygram-attachments/<sessionKey>/ (per-session staging)
 *   - sessionCwd if provided (the agent's workspace)
 *   - extraRoots passed from createChannelsToolDispatcher options
 *
 * Caller is expected to ensure DEFAULT_ATTACHMENT_BASE / the per-session
 * dir exist if Claude will write to them. We don't create them here —
 * realpath() on a nonexistent root fails and the validator rejects, which
 * is the safe default.
 */
function buildAllowedRoots({ sessionKey, sessionCwd = null, extraRoots = [] }) {
  const roots = [
    DEFAULT_ATTACHMENT_BASE,
    path.join(DEFAULT_ATTACHMENT_BASE, String(sessionKey || '')),
  ];
  if (sessionCwd) roots.push(sessionCwd);
  if (Array.isArray(extraRoots)) {
    for (const r of extraRoots) {
      if (typeof r === 'string' && path.isAbsolute(r)) roots.push(r);
    }
  }
  return roots;
}

module.exports = {
  createChannelsToolDispatcher,
  // exported for unit testing
  validateAttachmentPath,
  buildAllowedRoots,
  DEFAULT_ATTACHMENT_BASE,
};
