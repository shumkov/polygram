'use strict';

function requireRestartRequestId(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 128
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    const error = new Error('deploy restart request ID is invalid');
    error.code = 'INVALID_DEPLOY_RESTART_REQUEST_ID';
    throw error;
  }
  return value;
}

module.exports = { requireRestartRequestId };
