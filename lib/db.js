/**
 * Bridge DB client. Wraps better-sqlite3 with the ops polygram + skill need.
 * Synchronous (better-sqlite3). DB errors are caught by callers so polygram
 * never drops messages because of transcript failures.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// 0.8.0 Phase 1: bumped from 9 → 10. Adds migration
// 010-tool-use-id.sql (pending_approvals.tool_use_id column for the
// SDK canUseTool stable per-call ID + chat_tool_decisions table for
// "always allow / always deny" persistence under the new in-process
// approval flow).
//
// 0.7.8 (history): bumped from 8 → 9 to fix a regression where 0.7.6
// added migration 009-turn-metrics.sql but forgot to bump
// SCHEMA_VERSION; the early-return on line ~42 then skipped the
// migration loop on any DB already at user_version=8 → turn_metrics
// table never created → INSERT prepare at startup crashed polygram.
//
// 0.14: bumped from 12 → 13. Adds migration 013-clean-shutdown-marker.sql
// (polling_state.clean_shutdown_at). Same footgun as the 8→9 note: forgetting
// the bump skips the migration on any DB already at user_version=12.
//
// 0.15: bumped 13 → 14. Adds migration 014-secret-redactions.sql
// (secret_redactions audit table + messages.secret_scanned_at).
const SCHEMA_VERSION = 14;

// Sentinel `error` value for outbound rows whose API call may or may not
// have reached Telegram. markStalePending writes it; hasOutboundReplyTo
// reads it to dedupe boot replay against possibly-delivered messages.
// Constant rather than inline literal so a typo can't silently break the
// invariant ("AND error = 'crashedmidsend'" → no rows match → duplicate
// reply on boot).
const CRASHED_MID_SEND = 'crashed-mid-send';

function open(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db, path.join(__dirname, '..', 'migrations'));
  return wrap(db);
}

function runMigrations(db, migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const currentPre = db.pragma('user_version', { simple: true });
  if (currentPre >= SCHEMA_VERSION) return;

  for (const file of files) {
    const n = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(n)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Concurrent-boot safety: BEGIN IMMEDIATE acquires the write lock
    // up-front; the second migrator blocks on busy_timeout (5s) then
    // re-reads user_version inside the txn for check-and-set semantics.
    // The prepared-statement-against-old-schema hazard is mitigated by
    // polygram's per-bot DB layout (one process per DB file, see
    // scripts/split-db.js), so there is no other long-lived reader on
    // the same DB during a migration in normal operation.
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the transaction so we skip anything another process
      // just committed (check-and-set semantics).
      const current = db.pragma('user_version', { simple: true });
      if (n <= current) {
        db.exec('COMMIT');
        continue;
      }
      console.log(`[db] applying migration ${file}`);
      db.exec(sql);
      db.pragma(`user_version = ${n}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
}

function wrap(db) {
  // 0.6.1: attachments_json column dropped (migration 008). All attachment
  // data lives in the per-attachment table now (see attachments stmts below).
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
      direction, source, bot_name, session_id,
      model, effort, turn_id, status, error, cost_usd, ts
    ) VALUES (
      @chat_id, @thread_id, @msg_id, @user, @user_id, @text, @reply_to_id,
      @direction, @source, @bot_name, @session_id,
      @model, @effort, @turn_id, @status, @error, @cost_usd, @ts
    )
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET
      text = excluded.text,
      edited_ts = excluded.ts
  `);

  const insertOutboundPendingStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, user, text, direction, source, bot_name,
      turn_id, session_id, status, ts, msg_id, reply_to_id
    ) VALUES (
      @chat_id, @thread_id, @user, @text, 'out', @source, @bot_name,
      @turn_id, @session_id, 'pending', @ts, @pending_id, @reply_to_id
    )
  `);

  const markOutboundSentStmt = db.prepare(`
    UPDATE messages SET msg_id = @msg_id, status = 'sent', ts = @ts
    WHERE id = @id
  `);

  const markOutboundFailedStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = @error
    WHERE id = @id
  `);

  const upsertSessionStmt = db.prepare(`
    INSERT INTO sessions (
      session_key, chat_id, thread_id, claude_session_id,
      agent, cwd, model, effort, pm_backend, created_ts, last_active_ts
    ) VALUES (
      @session_key, @chat_id, @thread_id, @claude_session_id,
      @agent, @cwd, @model, @effort, @pm_backend, @ts, @ts
    )
    ON CONFLICT(session_key) DO UPDATE SET
      chat_id = excluded.chat_id,
      thread_id = excluded.thread_id,
      claude_session_id = excluded.claude_session_id,
      agent = excluded.agent,
      cwd = excluded.cwd,
      model = excluded.model,
      effort = excluded.effort,
      pm_backend = excluded.pm_backend,
      last_active_ts = excluded.last_active_ts
  `);

  const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE session_key = ?`);
  const touchSessionStmt = db.prepare(`UPDATE sessions SET last_active_ts = ? WHERE session_key = ?`);
  const clearSessionIdStmt = db.prepare(`DELETE FROM sessions WHERE session_key = ?`);
  const setSessionBackendStmt = db.prepare(`UPDATE sessions SET pm_backend = ? WHERE session_key = ?`);

  const getMessageStmt = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND msg_id = ?
    ORDER BY id DESC LIMIT 1
  `);

  const setMessageTextStmt = db.prepare(`
    UPDATE messages
       SET text = @text
     WHERE chat_id = @chat_id AND msg_id = @msg_id
  `);

  const logChatMigrationStmt = db.prepare(`
    INSERT OR REPLACE INTO chat_migrations (old_chat_id, new_chat_id, migrated_ts)
    VALUES (?, ?, ?)
  `);

  const resolveChatIdStmt = db.prepare(`
    SELECT new_chat_id FROM chat_migrations WHERE old_chat_id = ?
  `);

  const logEventStmt = db.prepare(`
    INSERT INTO events (ts, chat_id, kind, detail_json)
    VALUES (?, ?, ?, ?)
  `);

  // 0.7.6 (item F): per-turn cost / token / duration metrics. Persisted
  // at turn end (onResult callback). One row per dispatched user
  // message → final reply cycle, even if the cycle had multiple
  // assistant messages. See migrations/009-turn-metrics.sql.
  const insertTurnMetricStmt = db.prepare(`
    INSERT INTO turn_metrics (
      ts, chat_id, thread_id, msg_id, session_id, bot_name,
      model, effort,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, duration_ms, num_assistant_messages, num_tool_uses,
      result_subtype, error
    ) VALUES (
      @ts, @chat_id, @thread_id, @msg_id, @session_id, @bot_name,
      @model, @effort,
      @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens,
      @cost_usd, @duration_ms, @num_assistant_messages, @num_tool_uses,
      @result_subtype, @error
    )
  `);

  const logConfigChangeStmt = db.prepare(`
    INSERT INTO config_changes (
      chat_id, thread_id, field, old_value, new_value,
      user_id, user, source, ts
    ) VALUES (
      @chat_id, @thread_id, @field, @old_value, @new_value,
      @user_id, @user, @source, @ts
    )
  `);

  // 0.8.0 Phase 1 step 8 — chat_tool_decisions persistence for the
  // SDK canUseTool flow. Queried at the START of canUseTool to
  // short-circuit "always allow / always deny" decisions before
  // posting a Telegram inline-keyboard card. Migration 010 created
  // the table; queries here. See v4 plan §6.5.4.
  const lookupChatToolDecisionsStmt = db.prepare(`
    SELECT match_type, input_pattern, decision, expires_ts
      FROM chat_tool_decisions
     WHERE bot_name = @bot_name
       AND chat_id  = @chat_id
       AND tool_name = @tool_name
       AND (expires_ts IS NULL OR expires_ts > @now)
  `);
  const insertChatToolDecisionStmt = db.prepare(`
    INSERT INTO chat_tool_decisions (
      bot_name, chat_id, tool_name, match_type,
      input_pattern, decision,
      issued_ts, issued_by_user_id, expires_ts
    ) VALUES (
      @bot_name, @chat_id, @tool_name, @match_type,
      @input_pattern, @decision,
      @issued_ts, @issued_by_user_id, @expires_ts
    )
  `);
  const deleteChatToolDecisionStmt = db.prepare(`
    DELETE FROM chat_tool_decisions
     WHERE bot_name = ? AND chat_id = ? AND id = ?
  `);

  const markStalePendingStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = '${CRASHED_MID_SEND}'
    WHERE status = 'pending' AND ts < ?
  `);
  const markStalePendingForBotStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = '${CRASHED_MID_SEND}'
    WHERE status = 'pending' AND ts < ? AND bot_name = ?
  `);

  return {
    raw: db,

    insertMessage(row) {
      return insertMessageStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        msg_id: row.msg_id,
        user: row.user || null,
        user_id: row.user_id || null,
        text: row.text || '',
        reply_to_id: row.reply_to_id || null,
        direction: row.direction || 'in',
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        session_id: row.session_id || null,
        model: row.model || null,
        effort: row.effort || null,
        turn_id: row.turn_id || null,
        status: row.status || 'received',
        error: row.error || null,
        cost_usd: row.cost_usd ?? null,
        ts: row.ts || Date.now(),
      });
    },

    insertOutboundPending(row) {
      return insertOutboundPendingStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        user: row.user || null,
        text: row.text || '',
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        turn_id: row.turn_id || null,
        session_id: row.session_id || null,
        ts: row.ts || Date.now(),
        pending_id: row.pending_id,
        reply_to_id: row.reply_to_id ?? null,
      });
    },

    markOutboundSent(id, { msg_id, ts }) {
      return markOutboundSentStmt.run({ id, msg_id, ts: ts || Date.now() });
    },

    markOutboundFailed(id, err) {
      return markOutboundFailedStmt.run({ id, error: String(err).slice(0, 500) });
    },

    upsertSession(row) {
      return upsertSessionStmt.run({
        session_key: row.session_key,
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        claude_session_id: row.claude_session_id,
        agent: row.agent || null,
        cwd: row.cwd || null,
        model: row.model || null,
        effort: row.effort || null,
        // 0.10.0: pm_backend defaults to 'sdk' if caller doesn't set it.
        pm_backend: row.pm_backend || 'sdk',
        ts: row.ts || Date.now(),
      });
    },

    getSession(sessionKey) {
      return getSessionStmt.get(sessionKey);
    },

    touchSession(sessionKey, ts = Date.now()) {
      return touchSessionStmt.run(ts, sessionKey);
    },

    clearSessionId(sessionKey) {
      return clearSessionIdStmt.run(sessionKey);
    },

    // 0.10.0: backend reassignment without resetting other session fields.
    // Used when ProcessManager spawns a Process with a different backend
    // than the persisted row says (drift event fires too).
    setSessionBackend(sessionKey, backend) {
      return setSessionBackendStmt.run(backend, sessionKey);
    },

    getMessage(chatId, msgId) {
      return getMessageStmt.get(String(chatId), msgId);
    },

    setMessageText({ chat_id, msg_id, text }) {
      return setMessageTextStmt.run({
        chat_id: String(chat_id),
        msg_id,
        text: text ?? '',
      });
    },

    logChatMigration(oldChatId, newChatId, ts = Date.now()) {
      return logChatMigrationStmt.run(String(oldChatId), String(newChatId), ts);
    },

    resolveChatId(chatId) {
      const row = resolveChatIdStmt.get(String(chatId));
      return row?.new_chat_id || String(chatId);
    },

    logEvent(kind, { chat_id = null, ...detail } = {}) {
      return logEventStmt.run(
        Date.now(),
        chat_id ? String(chat_id) : null,
        kind,
        Object.keys(detail).length ? JSON.stringify(detail) : null,
      );
    },

    // rc.61: find compact-command events from the recent window that
    // never produced a matching compact-boundary on the same
    // session_key. These are "interrupted by deploy" cases — polygram
    // pushed /compact into SDK input but the daemon restarted before
    // the SDK could finish. The interrupted compact is lost; we
    // surface it to the user so they can re-run.
    //
    // Match logic: for each compact-command (with session_key in
    // detail_json), look for a compact-boundary with matching
    // session_key AND ts > compact_command.ts. If none within
    // search-window, it's orphaned.
    //
    // @param {object} opts
    // @param {number} opts.olderThanMs - cutoff (only events newer than this are scanned)
    // @returns {Array<{ts, chat_id, thread_id, session_key, user, user_id, text_len}>}
    findOrphanedCompactCommands({ olderThanMs = 30 * 60 * 1000 } = {}) {
      const cutoff = Date.now() - olderThanMs;
      const cmds = db.prepare(`
        SELECT id, ts, chat_id,
               json_extract(detail_json, '$.thread_id')   AS thread_id,
               json_extract(detail_json, '$.session_key') AS session_key,
               json_extract(detail_json, '$.user')        AS user,
               json_extract(detail_json, '$.user_id')     AS user_id,
               json_extract(detail_json, '$.text_len')    AS text_len,
               json_extract(detail_json, '$.text')        AS text
          FROM events
         WHERE kind = 'compact-command'
           AND ts > ?
         ORDER BY ts ASC, id ASC
      `).all(cutoff);
      const orphans = [];
      for (const c of cmds) {
        if (!c.session_key) continue; // older events without session_key — skip
        // Use id ordering rather than ts (events logged in the same
        // millisecond have ts equality but distinct id; strict ts >
        // would falsely orphan a command paired with a same-ms
        // boundary).
        const boundary = db.prepare(`
          SELECT id FROM events
           WHERE kind = 'compact-boundary'
             AND id > ?
             AND json_extract(detail_json, '$.session_key') = ?
           LIMIT 1
        `).get(c.id, c.session_key);
        if (boundary) continue;
        // rc.66: also skip if a previous boot has already handled
        // this orphan (silent replay via compact-replay event, OR
        // surface-fallback via compact-failed-restart event). Both
        // of those record `original_ts` in their detail_json
        // matching the original compact-command's ts. Without this
        // dedupe, every subsequent deploy re-surfaces / re-replays
        // the same orphan (annoying noise).
        const handled = db.prepare(`
          SELECT id FROM events
           WHERE kind IN ('compact-replay', 'compact-failed-restart')
             AND json_extract(detail_json, '$.original_ts') = ?
           LIMIT 1
        `).get(c.ts);
        if (handled) continue;
        orphans.push(c);
      }
      return orphans;
    },

    insertTurnMetric(row) {
      return insertTurnMetricStmt.run({
        ts: row.ts || Date.now(),
        chat_id: String(row.chat_id),
        thread_id: row.thread_id != null ? String(row.thread_id) : null,
        msg_id: row.msg_id,
        session_id: row.session_id || null,
        bot_name: row.bot_name || null,
        model: row.model || null,
        effort: row.effort || null,
        input_tokens: row.input_tokens ?? null,
        output_tokens: row.output_tokens ?? null,
        cache_creation_tokens: row.cache_creation_tokens ?? null,
        cache_read_tokens: row.cache_read_tokens ?? null,
        cost_usd: row.cost_usd ?? null,
        duration_ms: row.duration_ms ?? null,
        num_assistant_messages: row.num_assistant_messages ?? null,
        num_tool_uses: row.num_tool_uses ?? null,
        result_subtype: row.result_subtype || null,
        error: row.error || null,
      });
    },

    /**
     * 0.8.0 Phase 1 step 8 — chat_tool_decisions persistence.
     *
     * Look up "always allow / always deny" decisions for a tool
     * call. Returns the FIRST matching decision (by id ASC) whose
     * match_type accepts the canonical input. Pattern matching is
     * done in-process here so the SQL query stays simple.
     *
     * Canonical input: keys sorted alphabetically, no whitespace.
     * Done by the caller (canUseTool wrapper) — we accept the
     * pre-canonicalised string as `canonical_input`.
     */
    lookupChatToolDecision({ bot_name, chat_id, tool_name, canonical_input, now }) {
      const rows = lookupChatToolDecisionsStmt.all({
        bot_name: String(bot_name),
        chat_id: String(chat_id),
        tool_name: String(tool_name),
        now: now || Date.now(),
      });
      for (const r of rows) {
        if (r.match_type === 'exact') {
          if (r.input_pattern === canonical_input) return r;
        } else if (r.match_type === 'prefix') {
          if (canonical_input?.startsWith?.(r.input_pattern)) return r;
        } else if (r.match_type === 'regex') {
          try {
            if (new RegExp(r.input_pattern).test(canonical_input || '')) return r;
          } catch { /* malformed regex — ignore */ }
        }
      }
      return null;
    },

    insertChatToolDecision(row) {
      return insertChatToolDecisionStmt.run({
        bot_name: String(row.bot_name),
        chat_id: String(row.chat_id),
        tool_name: String(row.tool_name),
        match_type: row.match_type,
        input_pattern: row.input_pattern,
        decision: row.decision,
        issued_ts: row.issued_ts || Date.now(),
        issued_by_user_id: row.issued_by_user_id != null
          ? String(row.issued_by_user_id) : null,
        expires_ts: row.expires_ts ?? null,
      });
    },

    deleteChatToolDecision({ bot_name, chat_id, id }) {
      return deleteChatToolDecisionStmt.run(String(bot_name), String(chat_id), id);
    },

    logConfigChange(row) {
      return logConfigChangeStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        field: row.field,
        old_value: row.old_value ?? null,
        new_value: row.new_value,
        user_id: row.user_id || null,
        user: row.user || null,
        source: row.source || 'command',
        ts: row.ts || Date.now(),
      });
    },

    markStalePending(olderThanMs = 60_000, botName = null) {
      const cutoff = Date.now() - olderThanMs;
      if (botName) return markStalePendingForBotStmt.run(cutoff, botName);
      return markStalePendingStmt.run(cutoff);
    },

    // Polling offset persistence — see migrations/005-polling-state.sql.
    // Exposed as its own pair of calls (not lazy-prepared) so tests can
    // round-trip them without going through the full polygram boot flow.
    getPollingOffset(botName) {
      const row = db.prepare('SELECT last_update_id FROM polling_state WHERE bot_name = ?').get(botName);
      return row?.last_update_id ?? 0;
    },
    savePollingOffset(botName, lastUpdateId) {
      db.prepare(`
        INSERT INTO polling_state (bot_name, last_update_id, ts)
        VALUES (?, ?, ?)
        ON CONFLICT(bot_name) DO UPDATE SET last_update_id = excluded.last_update_id, ts = excluded.ts
      `).run(botName, lastUpdateId, Date.now());
    },

    // Inbound handler lifecycle — see migrations/006-inbound-handler-status.sql.
    // Called by handleMessage as the turn progresses. Used by boot replay to
    // find work that was interrupted by a crash or restart.
    setInboundHandlerStatus({ chat_id, msg_id, status }) {
      return db.prepare(`
        UPDATE messages SET handler_status = ?
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
      `).run(status, chat_id, msg_id);
    },

    // 0.9.0: True when a specific inbound msg is still being processed
    // by the SDK turn loop (handler_status in dispatched/processing).
    // Used by the edit-correction injector — only inject a typo-fix
    // note when the SDK actually still has the turn in flight.
    isInboundLive({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM messages
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
          AND handler_status IN ('dispatched', 'processing')
        LIMIT 1
      `).get(chat_id, msg_id);
      return !!row;
    },

    // Find inbound messages that were being processed when polygram stopped.
    // Scoped by bot_name via the chat_id → config mapping, so each bot only
    // replays its own turns on boot. Scoped by olderThanMs (default 3 min)
    // so we never resurrect ancient messages — anything older than a few
    // minutes is from before the user moved on, replaying it just confuses
    // the conversation.
    getReplayCandidates({ chatIds, olderThanMs = 3 * 60 * 1000, limit = 100 } = {}) {
      if (!Array.isArray(chatIds) || chatIds.length === 0) return [];
      const cutoff = Date.now() - olderThanMs;
      const placeholders = chatIds.map(() => '?').join(',');
      return db.prepare(`
        SELECT id, chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
               ts, handler_status
          FROM messages
         WHERE direction = 'in'
           AND handler_status IN ('dispatched', 'processing', 'replay-pending')
           AND chat_id IN (${placeholders})
           AND ts > ?
         ORDER BY ts ASC
         LIMIT ?
      `).all(...chatIds, cutoff, limit);
    },

    // Dedupe check: did we already send an outbound reply to this inbound?
    // Prevents double-processing if a redelivered/replayed message has
    // already been answered.
    //
    // Three states count as "probably sent":
    //   - 'sent': the happy path.
    //   - 'failed' with error='crashed-mid-send': polygram crashed
    //     after inserting the pending row but before markOutboundSent.
    //     The boot-time markStalePending sweep flipped them to this.
    //   - 'pending' (0.6.14): markStalePending only flips rows older
    //     than 60s, so a fast restart (boot replay fires in &lt;60s) leaves
    //     fresh pending rows in 'pending' state. Without counting them
    //     here, the inbound looks unanswered and gets re-dispatched →
    //     Telegram already delivered the original reply → duplicate.
    //
    // Treating ambiguous states as "replied" costs us occasional missed
    // replies (recoverable: user resends) to prevent duplicates
    // (irrecoverable: user has to mentally dedupe two answers).
    // rc.51: stricter dedupe than hasOutboundReplyTo for boot-replay.
    // A `turn_metrics` row is only inserted when a turn definitively
    // completes (onResult callback). If no row exists for this inbound
    // msg_id, the turn never finished — even if intermediate ack-bubbles
    // were already sent. The rc.50 incident's lost msg 12158 had a
    // partial "I'll write a quick inline script..." outbound but no
    // turn_metrics, and was being silently skipped by replay-dedupe.
    //
    // Caveat: a row whose `error` is set (transient/aborted/timeout)
    // does NOT count as complete — the turn started but failed. Boot
    // replay should redispatch within window so the user gets a real
    // answer.
    hasCompletedTurnFor({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM turn_metrics
         WHERE chat_id = ? AND msg_id = ? AND error IS NULL
         LIMIT 1
      `).get(String(chat_id), msg_id);
      return !!row;
    },

    hasOutboundReplyTo({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM messages
         WHERE chat_id = ? AND direction = 'out' AND reply_to_id = ?
           AND (
             status = 'sent'
             OR status = 'pending'
             OR (status = 'failed' AND error = '${CRASHED_MID_SEND}')
           )
         LIMIT 1
      `).get(chat_id, msg_id);
      return !!row;
    },

    // On shutdown, mark any inbound rows still in-flight so the boot replay
    // knows to pick them up. `sessionKey`s narrow the update to the sessions
    // we're draining (useful if we ever do partial shutdown; otherwise leave
    // null to mark all dispatched/processing rows for a bot).
    markReplayPending({ botName, since }) {
      const cutoff = since ?? Date.now() - 30 * 60 * 1000;
      return db.prepare(`
        UPDATE messages SET handler_status = 'replay-pending'
         WHERE direction = 'in'
           AND handler_status IN ('dispatched', 'processing')
           AND bot_name = ?
           AND ts > ?
      `).run(botName, cutoff);
    },

    // 0.14 boot-replay: record a DELIBERATE (clean) shutdown. Atomically, in ONE
    // transaction: (a) mark still-in-flight inbound rows replay-pending (so a
    // deliberate restart that interrupted a long turn still recovers it), and
    // (b) stamp polling_state.clean_shutdown_at so boot can tell clean from
    // crash. Written UNCONDITIONALLY on every clean shutdown — NOT gated on
    // in-flight count — because a stale replay-pending row from a prior life
    // must NOT be crash-recovered (re-answered) on a deliberate restart.
    //
    // The upsert satisfies polling_state's NOT NULL last_update_id/ts (migration
    // 005) for a fresh/quiet bot that has no row yet (a row is otherwise created
    // only on a non-empty getUpdates batch): COALESCE the existing values, else
    // seed (0, now).
    recordCleanShutdown({ botName, now = Date.now(), since } = {}) {
      const cutoff = since ?? now - 30 * 60 * 1000;
      const txn = db.transaction(() => {
        const marked = db.prepare(`
          UPDATE messages SET handler_status = 'replay-pending'
           WHERE direction = 'in'
             AND handler_status IN ('dispatched', 'processing')
             AND bot_name = ?
             AND ts > ?
        `).run(botName, cutoff);
        db.prepare(`
          INSERT INTO polling_state (bot_name, last_update_id, ts, clean_shutdown_at)
          VALUES (?,
                  COALESCE((SELECT last_update_id FROM polling_state WHERE bot_name = ?), 0),
                  COALESCE((SELECT ts             FROM polling_state WHERE bot_name = ?), ?),
                  ?)
          ON CONFLICT(bot_name) DO UPDATE SET clean_shutdown_at = excluded.clean_shutdown_at
        `).run(botName, botName, botName, now, now);
        return marked.changes;
      });
      return { replayMarked: txn() };
    },

    // 0.14: read AND clear the clean-shutdown marker in one txn. "Clean" iff a
    // marker is present, not future-dated (clock skew → crash), and within
    // maxAgeMs (derived from the replay window). Clear-on-read so a marker from
    // a prior boot can never be inherited as "clean" after a later crash. Any
    // ambiguity ⇒ clean:false (the caller treats that as crash → recover).
    consumeCleanShutdownMarker({ botName, now = Date.now(), maxAgeMs }) {
      const txn = db.transaction(() => {
        const row = db.prepare('SELECT clean_shutdown_at FROM polling_state WHERE bot_name = ?').get(botName);
        const at = row ? row.clean_shutdown_at : null;
        if (row && at != null) {
          db.prepare('UPDATE polling_state SET clean_shutdown_at = NULL WHERE bot_name = ?').run(botName);
        }
        return at;
      });
      const at = txn();
      const age = typeof at === 'number' ? now - at : null;
      const clean = age != null && age >= 0 && (maxAgeMs == null || age <= maxAgeMs);
      return { clean, markerAt: at };
    },

    // 0.15: redact an agent-REPORTED secret (via the [redact:<secret>] reply
    // marker) from recent inbound messages in a chat/thread. Literal substring
    // replace (no regex/LIKE wildcards), scanned over the last `limit` inbound
    // rows so we don't touch unrelated history, audited by fingerprint. FTS
    // re-indexes via the UPDATE trigger. Returns how many messages were changed.
    //
    // limit=200: the agent normally flags a secret in the same turn it arrives
    // (so the row is among the most-recent inbound), but a busy group chat can
    // interleave many messages before the flagging turn lands — 200 covers that
    // tail. The background sweep (lib/db/secret-sweep.js) is the unbounded
    // catch-all for known-shape secrets that fall outside this window. Callers
    // log when a redaction was requested but matched 0 rows (fail-loud signal).
    redactSecretInChat({ chat_id, thread_id = null, secret, now = Date.now(), limit = 200 }) {
      if (typeof secret !== 'string' || secret.length < 3) return { redacted: 0 };
      const PLACEHOLDER = '‹redacted:reported›';
      const sha = require('crypto').createHash('sha256').update(secret).digest('hex');
      const rows = (thread_id != null
        ? db.prepare(`SELECT id, msg_id, text FROM messages WHERE chat_id=? AND thread_id=? AND direction='in' ORDER BY id DESC LIMIT ?`).all(String(chat_id), String(thread_id), limit)
        : db.prepare(`SELECT id, msg_id, text FROM messages WHERE chat_id=? AND direction='in' ORDER BY id DESC LIMIT ?`).all(String(chat_id), limit));
      let redacted = 0;
      const txn = db.transaction(() => {
        for (const r of rows) {
          if (!r.text || !r.text.includes(secret)) continue;
          const newText = r.text.split(secret).join(PLACEHOLDER);
          db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(newText, r.id);
          db.prepare(`INSERT INTO secret_redactions (chat_id, msg_id, rule, tier, length, sha256, action, ts)
                      VALUES (?,?,?,?,?,?,?,?)`).run(String(chat_id), r.msg_id, 'reported', 'reported', secret.length, sha, 'redacted', now);
          redacted += 1;
        }
      });
      txn();
      return { redacted };
    },

    // ─── Attachments (migration 007, polygram 0.6.0) ──────────────────
    //
    // Replaces the messages.attachments_json blob. Each attachment is its
    // own row with lifecycle (`pending` → `downloaded` | `failed`),
    // searchable by chat / kind / time. recordInbound now inserts these
    // alongside the message in a transaction; downloadAttachments updates
    // status as it processes each file. See docs/attachments-table.md.

    insertAttachment({
      message_id, chat_id, msg_id, thread_id, bot_name,
      file_id, file_unique_id, kind, name, mime_type, size_bytes,
      ts,
    }) {
      return db.prepare(`
        INSERT INTO attachments (
          message_id, chat_id, msg_id, thread_id, bot_name,
          file_id, file_unique_id, kind, name, mime_type, size_bytes,
          download_status, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        message_id,
        String(chat_id),
        msg_id,
        thread_id ? String(thread_id) : null,
        bot_name || null,
        file_id,
        file_unique_id || null,
        kind,
        name || null,
        mime_type || null,
        size_bytes ?? null,
        ts || Date.now(),
      );
    },

    markAttachmentDownloaded(id, { local_path, size_bytes }) {
      return db.prepare(`
        UPDATE attachments
           SET download_status = 'downloaded',
               local_path = ?,
               size_bytes = COALESCE(?, size_bytes),
               download_error = NULL
         WHERE id = ?
      `).run(local_path, size_bytes ?? null, id);
    },

    markAttachmentFailed(id, error) {
      return db.prepare(`
        UPDATE attachments
           SET download_status = 'failed',
               download_error = ?
         WHERE id = ?
      `).run(String(error || 'unknown').slice(0, 500), id);
    },

    setAttachmentTranscription(id, text) {
      return db.prepare(`
        UPDATE attachments SET transcription = ? WHERE id = ?
      `).run(text || null, id);
    },

    getAttachmentsByMessage(message_id) {
      return db.prepare(`
        SELECT id, message_id, chat_id, msg_id, thread_id, bot_name,
               file_id, file_unique_id, kind, name, mime_type, size_bytes,
               local_path, download_status, download_error, transcription, ts
          FROM attachments
         WHERE message_id = ?
         ORDER BY id ASC
      `).all(message_id);
    },

    // Rich filter for ops queries. All filters are optional; with no filters
    // returns the most recent 100. Caller can paginate via since/until.
    searchAttachments({
      chat_id = null,
      kind = null,
      status = null,
      since = null,
      until = null,
      limit = 100,
    } = {}) {
      const where = [];
      const args = [];
      if (chat_id !== null) { where.push('chat_id = ?'); args.push(String(chat_id)); }
      if (kind !== null)    { where.push('kind = ?');    args.push(kind); }
      if (status !== null)  { where.push('download_status = ?'); args.push(status); }
      if (since !== null)   { where.push('ts >= ?');     args.push(Number(since)); }
      if (until !== null)   { where.push('ts <= ?');     args.push(Number(until)); }
      const sql = `
        SELECT id, message_id, chat_id, msg_id, thread_id, bot_name,
               file_id, file_unique_id, kind, name, mime_type, size_bytes,
               local_path, download_status, download_error, transcription, ts
          FROM attachments
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ts DESC
         LIMIT ?
      `;
      args.push(Number(limit));
      return db.prepare(sql).all(...args);
    },

    // Re-FK every attachment whose (chat_id, msg_id) is in `msg_ids` over
    // to a single primary message row. Used when the media-group buffer
    // coalesces N Telegram messages (each carrying one photo of an album)
    // into one synthetic turn — siblings were recorded under their own
    // msg_ids by recordInbound, but Claude needs to see them all under
    // the primary message so handleMessage's per-message attachment
    // lookup returns the full album.
    reassignAttachmentsToMessage({ chat_id, msg_ids, target_message_id }) {
      if (!Array.isArray(msg_ids) || msg_ids.length === 0) return { changes: 0 };
      const placeholders = msg_ids.map(() => '?').join(',');
      return db.prepare(`
        UPDATE attachments
           SET message_id = ?, msg_id = (SELECT msg_id FROM messages WHERE id = ?)
         WHERE chat_id = ? AND msg_id IN (${placeholders})
           AND message_id != ?
      `).run(target_message_id, target_message_id, String(chat_id), ...msg_ids, target_message_id);
    },

    // Look up the messages.id auto-pk for an inbound message. Used by
    // recordInbound to FK attachments to the just-inserted message even
    // when an ON-CONFLICT update happened (lastInsertRowid is 0 in that
    // case, so we can't rely on the run-result alone).
    getInboundMessageId({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT id FROM messages WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
      `).get(String(chat_id), msg_id);
      return row ? row.id : null;
    },

    listFailedAttachments({ since = null, limit = 100 } = {}) {
      const cutoff = since ?? Date.now() - 24 * 60 * 60 * 1000;
      return db.prepare(`
        SELECT id, message_id, chat_id, msg_id, kind, name, mime_type,
               download_error, ts
          FROM attachments
         WHERE download_status = 'failed' AND ts >= ?
         ORDER BY ts DESC
         LIMIT ?
      `).all(cutoff, limit);
    },
  };
}

module.exports = { open, CRASHED_MID_SEND };
