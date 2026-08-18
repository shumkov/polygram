#!/usr/bin/env node
/**
 * Quick IPC round-trip probe.
 * Usage: node scripts/ipc-smoke.js <bot-name> [busy|identity|restart] [restart-request-id]
 */

const crypto = require('node:crypto');
const { call, readSecret, socketPathFor } = require('../lib/ipc/client');
const {
  requireRestartRequestId,
} = require('../lib/ipc/restart-request-id');

function restartRequestId(value) {
  return requireRestartRequestId(value || crypto.randomUUID());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

(async () => {
  const bot = process.argv[2] || 'shumabit';
  const command = process.argv[3] || 'ping';
  const path = socketPathFor(bot);

  if (command === 'busy') {
    const result = await call({
      path,
      op: 'busy',
      secret: readSecret(bot),
    });
    if (
      result.ok !== true
      || result.bot !== bot
      || !Number.isSafeInteger(result.in_flight)
      || result.in_flight < 0
    ) {
      throw new Error('invalid busy response');
    }
    console.log(JSON.stringify({
      bot: result.bot,
      in_flight: result.in_flight,
    }));
    return;
  }

  if (command === 'restart') {
    const requestId = restartRequestId(process.argv[4]);
    const result = await call({
      path,
      op: 'deploy_restart',
      id: requestId,
      secret: readSecret(bot),
      callTimeoutMs: 60_000,
    });
    if (
      result.ok !== true
      || result.accepted !== true
      || result.id !== requestId
      || !Number.isSafeInteger(result.old_pid)
      || result.old_pid <= 1
    ) {
      throw new Error(result.error || 'invalid deploy restart response');
    }
    console.log(JSON.stringify({
      bot,
      accepted: true,
      old_pid: result.old_pid,
      restart_request_id: requestId,
    }));
    return;
  }

  if (command === 'identity') {
    const result = await call({
      path,
      op: 'identity',
      secret: readSecret(bot),
      connectTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    if (
      result.ok !== true
      || result.bot !== bot
      || !Number.isSafeInteger(result.pid)
      || result.pid <= 1
      || !UUID_RE.test(result.daemon_instance_id)
      || typeof result.package_version !== 'string'
      || result.package_version.length === 0
      || result.package_version.length > 128
      || !SHA256_RE.test(result.main_realpath_sha256)
    ) {
      throw new Error('invalid daemon identity response');
    }
    console.log(JSON.stringify({
      bot: result.bot,
      pid: result.pid,
      daemon_instance_id: result.daemon_instance_id,
      package_version: result.package_version,
      main_realpath_sha256: result.main_realpath_sha256,
    }));
    return;
  }

  console.log('path:', path);
  console.log('ping:', JSON.stringify(await call({ path, op: 'ping' })));
  console.log('DONE');
})().catch((err) => {
  const command = process.argv[3];
  const message = command === 'busy' || command === 'identity'
    ? `${command} request failed`
    : err.message;
  console.error('ERR:', message);
  process.exit(1);
});
