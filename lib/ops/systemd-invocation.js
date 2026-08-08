'use strict';

function parseSystemdInvocationId(env = process.env) {
  const value = env.INVOCATION_ID;
  if (value == null || value === '') return null;
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error('invalid systemd invocation identity');
  }
  return value;
}

function lifecycleDetail(detail, invocationId, daemonIdentity = null) {
  const value = detail && typeof detail === 'object' ? detail : {};
  const withDaemonIdentity = daemonIdentity == null
    ? value
    : {
      ...value,
      daemon_instance_id: daemonIdentity.daemon_instance_id,
      pid: daemonIdentity.pid,
    };
  return invocationId == null
    ? withDaemonIdentity
    : { ...withDaemonIdentity, invocation_id: invocationId };
}

module.exports = {
  parseSystemdInvocationId,
  lifecycleDetail,
};
