'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildFork } = require('./fork');

// claude's transcript path for a session: ~/.claude/projects/<cwd '/'→'-'>/<id>.jsonl,
// using the REALPATH'd cwd (claude resolves symlinks, e.g. /tmp→/private/tmp on macOS).
function transcriptPathFor(cwd, sessionId) {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* cwd may be gone; fall back to as-is */ }
  return path.join(os.homedir(), '.claude', 'projects', String(real).replace(/\//g, '-'), `${sessionId}.jsonl`);
}

/**
 * The 0.13 /rewind executor (P2/P3). Forks the live session transcript to before the target
 * message, points the session at the fork (so the next message resumes the rewound
 * conversation), kills the live proc, and deletes the bot's now-orphaned outbound messages.
 * Copy-only + fail-safe: a fork failure leaves the original session fully intact.
 *
 * @param {object} deps { db, pm, tg, bot, botName, logEvent, logger, buildForkImpl }
 * @returns {(req) => Promise<{ok:boolean,error?:string,droppedCount?:number}>}
 */
function createRewindExecutor({ db, pm, tg, bot, botName = 'bot', logEvent = () => {}, logger = console, buildForkImpl = buildFork } = {}) {
  // P3: delete the bot's own outbound messages sent after M (it can always delete its own).
  async function deleteBotMessagesAfter({ chatId, threadId, afterMsgId }) {
    let rows;
    try {
      const sql = `SELECT msg_id FROM messages WHERE chat_id = ? AND direction = 'out' AND status = 'sent' AND msg_id > ?`
        + (threadId ? ` AND thread_id = ?` : ` AND thread_id IS NULL`) + ` ORDER BY msg_id`;
      const params = threadId ? [String(chatId), Number(afterMsgId), String(threadId)] : [String(chatId), Number(afterMsgId)];
      rows = db.raw.prepare(sql).all(...params);
    } catch (e) { logger.error?.(`[${botName}] rewind cleanup query failed: ${e.message}`); return 0; }
    let deleted = 0;
    for (const r of rows || []) {
      try {
        await tg(bot, 'deleteMessage', { chat_id: chatId, message_id: r.msg_id }, { source: 'rewind-cleanup', botName });
        deleted++;
      } catch { /* already gone / older than 48h — Telegram won't delete; skip */ }
    }
    return deleted;
  }

  return async function executeRewind(req) {
    const row = db.getSession(req.sessionKey);
    if (!row || !row.claude_session_id || !row.cwd) {
      return { ok: false, error: 'no live session to rewind' };
    }
    const transcriptPath = transcriptPathFor(row.cwd, row.claude_session_id);
    const newId = crypto.randomUUID();

    const fork = buildForkImpl({ transcriptPath, targetMsgId: req.target.msg_id, newSessionId: newId });
    if (!fork.ok) return { ok: false, error: fork.error };   // original untouched

    // Point the session at the fork → the next message lazy-resumes the rewound conversation.
    try {
      db.upsertSession({ ...row, claude_session_id: newId });
    } catch (e) {
      try { fs.unlinkSync(fork.forkPath); } catch {}
      logger.error?.(`[${botName}] rewind id-swap failed: ${e.message}`);
      return { ok: false, error: 'failed to record the rewind' };
    }
    // Drop the live proc (it holds the OLD session); next inbound message respawns on the fork.
    try { await pm.kill(req.sessionKey, 'rewind'); }
    catch (e) { logger.error?.(`[${botName}] rewind kill: ${e.message}`); }

    let droppedCount = 0;
    try { droppedCount = await deleteBotMessagesAfter({ chatId: req.chatId, threadId: req.threadId, afterMsgId: req.target.msg_id }); }
    catch (e) { logger.error?.(`[${botName}] rewind cleanup failed: ${e.message}`); }

    logEvent('rewind-executed', { session_key: req.sessionKey, new_id: newId, target_msg_id: req.target.msg_id, dropped_turns: fork.droppedTurns });
    return { ok: true, droppedCount };
  };
}

module.exports = { createRewindExecutor, transcriptPathFor };
