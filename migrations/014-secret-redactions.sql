-- 0.15: background secret redaction.
--
-- secret_redactions: audit trail of every redaction/flag. Stores a sha256
-- FINGERPRINT of the secret, never the secret itself — enough to audit "what
-- kind was redacted / has this secret appeared elsewhere" without re-storing it.
CREATE TABLE IF NOT EXISTS secret_redactions (
  id       INTEGER PRIMARY KEY,
  chat_id  TEXT,
  msg_id   INTEGER,
  rule     TEXT    NOT NULL,
  tier     TEXT    NOT NULL,
  length   INTEGER,
  sha256   TEXT,
  action   TEXT    NOT NULL,   -- 'redacted' | 'flagged'
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secret_redactions_sha ON secret_redactions(sha256);

-- Incremental-sweep high-water: NULL = not yet scanned for secrets. The sweep
-- processes NULL rows in batches and stamps this, so it never rescans the whole
-- table. Existing rows are NULL → the first sweep backfills history once.
ALTER TABLE messages ADD COLUMN secret_scanned_at INTEGER;
