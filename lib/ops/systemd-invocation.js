'use strict';

function parseSystemdInvocationId(env = process.env) {
  const value = env.INVOCATION_ID;
  if (value == null || value === '') return null;
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error('invalid systemd invocation identity');
  }
  return value;
}

function lifecycleDetail(detail, invocationId) {
  const value = detail && typeof detail === 'object' ? detail : {};
  return invocationId == null
    ? value
    : { ...value, invocation_id: invocationId };
}

module.exports = {
  parseSystemdInvocationId,
  lifecycleDetail,
};
