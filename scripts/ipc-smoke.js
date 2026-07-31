#!/usr/bin/env node
/**
 * Quick IPC round-trip probe.
 * Usage: node scripts/ipc-smoke.js <bot-name> [busy|restart]
 */

const { call, readSecret, socketPathFor } = require('../lib/ipc/client');

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
    const result = await call({
      path,
      op: 'deploy_restart',
      secret: readSecret(bot),
      callTimeoutMs: 60_000,
    });
    if (
      result.ok !== true
      || result.accepted !== true
      || !Number.isSafeInteger(result.old_pid)
      || result.old_pid <= 1
    ) {
      throw new Error(result.error || 'invalid deploy restart response');
    }
    console.log(JSON.stringify({
      bot,
      accepted: true,
      old_pid: result.old_pid,
    }));
    return;
  }

  console.log('path:', path);
  console.log('ping:', JSON.stringify(await call({ path, op: 'ping' })));
  console.log('DONE');
})().catch((err) => {
  const message = process.argv[3] === 'busy'
    ? 'busy request failed'
    : err.message;
  console.error('ERR:', message);
  process.exit(1);
});
