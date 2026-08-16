-- Remove the secret-derived correlation value from the redaction audit.
--
-- secret_redactions.sha256 held an unsalted SHA-256 of the redacted value. It
-- was intended as "audit without storing the secret", but an unsalted digest
-- of a guessable value is a correlation handle for that value: anyone holding
-- a candidate can confirm it appeared, and can join every place it appeared.
-- The audit keeps what kind of secret was redacted, where and when, which is
-- what incident review actually reads.
--
-- Dropping the column also removes every historical digest already stored, so
-- no migration of old values is needed or possible.
DROP INDEX IF EXISTS idx_secret_redactions_sha;
ALTER TABLE secret_redactions DROP COLUMN sha256;
