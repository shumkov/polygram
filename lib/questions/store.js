/**
 * pending_questions store — persistence for the 0.12 interactive-question flow.
 *
 * Mirrors lib/approvals/store.js: per-row 128-bit callback token, status
 * lifecycle, audit-kept rows (never deleted; 'pending' at boot → 'expired').
 * One OPEN question per session at a time. The answer routes back to claude on
 * tool_call_id (a `question_answer` bridge message).
 */

'use strict';

const { newToken, tokensEqual } = require('../approvals/store');
const { sanitizeDurableStructured, sanitizeDurableJsonText } = require('../secret-detect');

// Two copies of the agent's questions, both durable:
//
//   questions_json — the audit copy of what the agent asked.
//   state_json     — the state machine, which re-reads its own `questions`
//                    copy on every tap to render the card and to match the
//                    option the user picked.
//
// Both are sanitized. The exact array lives only in the handler's live
// question context, for as long as the owning process does, and is hydrated
// back for each live interaction. A typed answer carrying a credential is held
// the same way: the row keeps a marker with no text, and a marked row that
// outlives its process is cancelled rather than replayed. Terminal masking of
// the whole retained state stays as the last line of defense for text no
// detector flagged.

// Both columns hold JSON, so they are sanitized as structure before
// serialization — masking a serialized document can splice across its
// delimiters, and an escaped quote hides a declared value from the detector.
const maskDurableJson = (value) => JSON.stringify(sanitizeDurableStructured(value));
const maskDurableJsonText = (json) => sanitizeDurableJsonText(json).text;

// `state.questions` is a second copy of the array `questions_json` holds, and
// the state machine reads it on every tap. Sanitizing only the column would
// leave the provider's exact question in the row, so the state's copy is
// sanitized on every write; the handler hydrates the exact array back for the
// live interaction.
const withSanitizedQuestions = (state) => {
  const value = state && typeof state === 'object' ? state : {};
  if (!Array.isArray(value.questions)) return value;
  return { ...value, questions: sanitizeDurableStructured(value.questions) };
};

// A question waits for the user — the turn no longer times out while an `ask` is open
// (cli-process defers its ceilings during a question wait, docs/progress-is-not-turn-end-spec.md),
// so this is only the long SAFETY BACKSTOP: a forgotten/abandoned question eventually
// expires {timedout} instead of pinning the session forever. Generous (a full day) so a
// real user answering hours later is never cut off; tune via the `questionTimeoutMs` config
// if a chat needs shorter/longer.
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function createQuestionStore(rawDb, now = () => Date.now()) {
  const insertStmt = rawDb.prepare(`
    INSERT INTO pending_questions (
      bot_name, session_key, chat_id, thread_id, turn_id, tool_call_id,
      callback_token, questions_json, state_json, created_ts, timeout_ts
    ) VALUES (
      @bot_name, @session_key, @chat_id, @thread_id, @turn_id, @tool_call_id,
      @callback_token, @questions_json, @state_json, @created_ts, @timeout_ts
    )
  `);
  const getByIdStmt        = rawDb.prepare(`SELECT * FROM pending_questions WHERE id = ?`);
  const getOpenForSessStmt = rawDb.prepare(`
    SELECT * FROM pending_questions WHERE session_key = ? AND status = 'pending'
     ORDER BY created_ts DESC LIMIT 1`);
  const getByToolCallStmt  = rawDb.prepare(`SELECT * FROM pending_questions WHERE tool_call_id = ? LIMIT 1`);
  const setMsgIdsStmt      = rawDb.prepare(`UPDATE pending_questions SET message_ids_json = ? WHERE id = ?`);
  const updateStateStmt    = rawDb.prepare(`
    UPDATE pending_questions SET state_json = @state_json, awaiting_other = @awaiting_other
     WHERE id = @id AND status = 'pending'`);
  const claimStmt          = rawDb.prepare(`
    UPDATE pending_questions SET from_id = @from_id
     WHERE id = @id AND from_id IS NULL AND status = 'pending'`);
  const resolveStmt        = rawDb.prepare(`
    UPDATE pending_questions SET status = @status, answered_ts = @answered_ts,
           state_json = @state_json
     WHERE id = @id AND status = 'pending'`);
  const resolveTxn = rawDb.transaction((id, status) => {
    const current = getByIdStmt.get(id);
    if (!current || current.status !== 'pending') return 0;
    return resolveStmt.run({
      id,
      status,
      answered_ts: now(),
      state_json: maskDurableJsonText(current.state_json ?? '{}'),
    }).changes;
  });
  const listTimedOutStmt   = rawDb.prepare(`SELECT * FROM pending_questions WHERE status = 'pending' AND timeout_ts < ?`);
  const listOpenStmt       = rawDb.prepare(`SELECT * FROM pending_questions WHERE bot_name = ? AND status = 'pending'`);

  return {
    issue({ bot_name, session_key, chat_id, thread_id = null, turn_id = null, tool_call_id, questions, state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (!bot_name || !session_key || !chat_id || !tool_call_id) {
        throw new Error('issue: bot_name, session_key, chat_id, tool_call_id required');
      }
      const created_ts = now();
      const res = insertStmt.run({
        bot_name,
        session_key,
        chat_id: String(chat_id),
        thread_id: thread_id != null ? String(thread_id) : null,
        turn_id,
        tool_call_id,
        callback_token: newToken(),
        questions_json: maskDurableJson(questions ?? []),
        state_json: JSON.stringify(withSanitizedQuestions(state)),
        created_ts,
        timeout_ts: created_ts + timeoutMs,
      });
      return getByIdStmt.get(res.lastInsertRowid);
    },

    getById(id) { return getByIdStmt.get(id); },
    getOpenForSession(session_key) { return getOpenForSessStmt.get(session_key); },
    getByToolCallId(tool_call_id) { return getByToolCallStmt.get(tool_call_id); },
    setMessageIds(id, ids) { return setMsgIdsStmt.run(JSON.stringify(ids ?? []), id).changes; },

    updateState(id, state, awaitingOther = false) {
      return updateStateStmt.run({
        id,
        state_json: JSON.stringify(withSanitizedQuestions(state)),
        awaiting_other: awaitingOther ? 1 : 0,
      }).changes;
    },

    /**
     * Authorize a responder. Claim-on-first-tap: if no from_id is recorded yet,
     * the first interacting user claims the question; thereafter only that user
     * may answer. Returns { ok, claimed }.
     */
    claimOrCheck(id, from_id) {
      if (from_id == null) return { ok: false, claimed: false };
      const claimed = claimStmt.run({ id, from_id }).changes > 0;
      if (claimed) return { ok: true, claimed: true };
      const row = getByIdStmt.get(id);
      return { ok: row && Number(row.from_id) === Number(from_id), claimed: false };
    },

    resolve(id, status) {
      if (!['answered', 'cancelled', 'timeout', 'expired'].includes(status)) {
        throw new Error(`bad status: ${status}`);
      }
      // Terminal transition: the answer has already been handed to the agent
      // and no path replays a non-pending row, so the retained state can be
      // masked. The row stays for audit; the credential does not.
      //
      // Read and write are one transaction. Read-then-write outside one would
      // let a tap's updateState land in between and be overwritten by the
      // state this call had already read — the answer state silently rolling
      // back at the moment the row is sealed.
      return resolveTxn(id, status);
    },

    sweepTimedOut() { return listTimedOutStmt.all(now()); },
    listOpen(bot_name) { return listOpenStmt.all(bot_name); },
  };
}

module.exports = { createQuestionStore, tokensEqual, DEFAULT_TIMEOUT_MS };
