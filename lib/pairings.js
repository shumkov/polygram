/**
 * Pairing codes - live onboarding without polygram restarts.
 *
 * Admin: /pair-code issues a single-use code. Short TTL (default 10 min).
 * Guest: /pair <CODE> claims it, gets an ACL row in `pairings`.
 *
 * Trust model: a code is bound to one bot and optionally one chat. Claiming
 * creates a pairing row the address-detector consults. Revocation is a soft
 * delete so audit trails survive.
 */

const crypto = require('crypto');

// Crockford-ish base32: no 0/O/1/I/L to avoid hand-entry confusion.
const ALPHA = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_TTL_MS = 60 * 1000;

const ISSUE_RATE_PER_OPERATOR_PER_HOUR = 10;
const CLAIM_RATE_PER_USER_PER_HOUR = 5;

function generateCode(len = CODE_LEN) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHA[buf[i] % ALPHA.length];
  return out;
}

function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function parseTtl(input) {
  if (input == null) return DEFAULT_TTL_MS;
  if (typeof input === 'number') return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, input));
  // `s` was historically accepted but always rejected by MIN_TTL_MS; dropped.
  const m = String(input).trim().match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`invalid ttl: ${input} (use 10m, 1h, 1d)`);
  const n = parseInt(m[1], 10);
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  const ms = n * mult;
  if (ms < MIN_TTL_MS) throw new Error(`ttl too short: ${input} (min 1m)`);
  if (ms > MAX_TTL_MS) throw new Error(`ttl too long: ${input} (max 7d)`);
  return ms;
}

// Per-user attempt tracker (in-memory). Counts EVERY claim call, not just
// successful ones — pre-0.6.15 the rate-limit query only counted rows where
// used_ts was set, so an attacker could probe wrong codes indefinitely. A
// brute-force at 30 req/s/bot (Telegram's per-bot limit) against 30^8 codes
// takes 685 years even with no rate limit, so this is hardening against
// targeted guessing of a known-issued code rather than closing an active
// breach. In-memory state survives the typical polygram lifetime (days
// between restarts) and rebuilds in the worst case after a restart — the
// successful-claim DB check stays as belt-and-suspenders for the post-claim
// path.
function createAttemptTracker(now) {
  const attemptsByUser = new Map(); // user_id → [ts, ts, ...]
  return {
    countRecent(userId, windowMs) {
      const arr = attemptsByUser.get(userId);
      if (!arr) return 0;
      const cutoff = now() - windowMs;
      // Garbage-collect the user's own bucket on every check; keeps memory
      // bounded without a separate sweep timer.
      const live = arr.filter((t) => t > cutoff);
      if (live.length === 0) attemptsByUser.delete(userId);
      else if (live.length !== arr.length) attemptsByUser.set(userId, live);
      return live.length;
    },
    record(userId) {
      const arr = attemptsByUser.get(userId) || [];
      arr.push(now());
      attemptsByUser.set(userId, arr);
    },
  };
}

function createStore(rawDb, now = () => Date.now()) {
  const issueStmt = rawDb.prepare(`
    INSERT INTO pair_codes
      (code, bot_name, chat_id, scope, issued_by_user_id, issued_ts, expires_ts, note)
    VALUES
      (@code, @bot_name, @chat_id, @scope, @issued_by_user_id, @issued_ts, @expires_ts, @note)
  `);
  const findCodeStmt = rawDb.prepare(`SELECT * FROM pair_codes WHERE code = ?`);
  const markCodeUsedStmt = rawDb.prepare(`
    UPDATE pair_codes
       SET used_by_user_id = @user_id, used_ts = @ts
     WHERE code = @code AND used_ts IS NULL
  `);
  const insertPairingStmt = rawDb.prepare(`
    INSERT INTO pairings
      (bot_name, user_id, chat_id, granted_ts, granted_by_user_id, note)
    VALUES
      (@bot_name, @user_id, @chat_id, @granted_ts, @granted_by_user_id, @note)
    ON CONFLICT(bot_name, user_id, chat_id) DO UPDATE SET
      revoked_ts = NULL,
      granted_ts = excluded.granted_ts,
      granted_by_user_id = excluded.granted_by_user_id,
      note = excluded.note
  `);
  const livePairingAnyChatStmt = rawDb.prepare(`
    SELECT 1 FROM pairings
     WHERE bot_name = ? AND user_id = ? AND chat_id IS NULL
       AND revoked_ts IS NULL
     LIMIT 1
  `);
  const livePairingChatStmt = rawDb.prepare(`
    SELECT 1 FROM pairings
     WHERE bot_name = ? AND user_id = ?
       AND (chat_id IS NULL OR chat_id = ?)
       AND revoked_ts IS NULL
     LIMIT 1
  `);
  const revokeByUserStmt = rawDb.prepare(`
    UPDATE pairings SET revoked_ts = ?
     WHERE bot_name = ? AND user_id = ? AND revoked_ts IS NULL
  `);
  const listActiveStmt = rawDb.prepare(`
    SELECT id, bot_name, user_id, chat_id, granted_ts, granted_by_user_id, note
      FROM pairings
     WHERE bot_name = ? AND revoked_ts IS NULL
     ORDER BY granted_ts DESC
  `);
  const recentIssuesByOperatorStmt = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM pair_codes
     WHERE bot_name = ? AND issued_by_user_id = ? AND issued_ts > ?
  `);
  const claimAttempts = createAttemptTracker(now);

  return {
    issueCode({
      bot_name, chat_id = null, scope = 'user',
      issued_by_user_id, ttlMs, note = null,
    }) {
      if (!bot_name) throw new Error('bot_name required');
      if (!Number.isFinite(issued_by_user_id)) throw new Error('issued_by_user_id required');
      if (!['user', 'chat'].includes(scope)) throw new Error(`bad scope: ${scope}`);

      const recent = recentIssuesByOperatorStmt.get(
        bot_name, issued_by_user_id, now() - 3_600_000,
      ).n;
      if (recent >= ISSUE_RATE_PER_OPERATOR_PER_HOUR) {
        throw new Error(`rate limit: ${recent} codes issued in last hour (max ${ISSUE_RATE_PER_OPERATOR_PER_HOUR})`);
      }

      const issued_ts = now();
      const expires_ts = issued_ts + (ttlMs || DEFAULT_TTL_MS);
      // Single attempt: the Crockford alphabet × 8 chars gives ~6.5×10¹¹
      // codes. Combined with 10/hr/operator rate-limit, collision is
      // astronomically unlikely. A retry loop would only swallow real DB
      // errors (disk full, schema mismatch) as "just collided, try again".
      const code = generateCode();
      issueStmt.run({
        code,
        bot_name,
        chat_id: chat_id ? String(chat_id) : null,
        scope,
        issued_by_user_id,
        issued_ts,
        expires_ts,
        note,
      });
      return { code, issued_ts, expires_ts, bot_name, chat_id, scope, note };
    },

    claimCode({ code, claimer_user_id, chat_id, bot_name }) {
      const norm = normalizeCode(code);

      // Rate-limit BEFORE the DB lookup so probing wrong codes also
      // burns quota. Counts every attempt (success or failure).
      const recent = claimAttempts.countRecent(claimer_user_id, 3_600_000);
      if (recent >= CLAIM_RATE_PER_USER_PER_HOUR) {
        return { ok: false, reason: 'rate-limited' };
      }
      claimAttempts.record(claimer_user_id);

      const row = findCodeStmt.get(norm);
      if (!row) return { ok: false, reason: 'not-found' };
      if (row.used_ts) return { ok: false, reason: 'already-used' };
      if (row.expires_ts < now()) return { ok: false, reason: 'expired' };
      if (row.bot_name !== bot_name) return { ok: false, reason: 'wrong-bot' };
      if (row.chat_id && String(row.chat_id) !== String(chat_id)) {
        return { ok: false, reason: 'wrong-chat' };
      }

      const tx = rawDb.transaction(() => {
        const upd = markCodeUsedStmt.run({ code: norm, user_id: claimer_user_id, ts: now() });
        if (upd.changes === 0) throw new Error('race: code claimed by another user');
        insertPairingStmt.run({
          bot_name: row.bot_name,
          user_id: claimer_user_id,
          chat_id: row.chat_id || null,
          granted_ts: now(),
          granted_by_user_id: row.issued_by_user_id,
          note: row.note,
        });
      });
      try {
        tx();
      } catch (err) {
        if (/race: code claimed/.test(err.message)) return { ok: false, reason: 'race' };
        throw err;
      }
      return {
        ok: true,
        bot_name: row.bot_name,
        chat_id: row.chat_id,
        scope: row.scope,
        note: row.note,
      };
    },

    hasLivePairing({ bot_name, user_id, chat_id }) {
      if (chat_id == null) {
        return !!livePairingAnyChatStmt.get(bot_name, user_id);
      }
      return !!livePairingChatStmt.get(bot_name, user_id, String(chat_id));
    },

    revokeByUser({ bot_name, user_id }) {
      return revokeByUserStmt.run(now(), bot_name, user_id).changes;
    },

    listActive(bot_name) {
      return listActiveStmt.all(bot_name);
    },
  };
}

module.exports = {
  createStore,
  generateCode,
  normalizeCode,
  parseTtl,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  ISSUE_RATE_PER_OPERATOR_PER_HOUR,
  CLAIM_RATE_PER_USER_PER_HOUR,
};
