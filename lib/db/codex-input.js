'use strict';

function codexError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
  ) {
    throw codexError(
      `Codex ${label} must be a non-empty bounded string`,
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }
  return value;
}

module.exports = {
  codexError,
  requiredString,
};
