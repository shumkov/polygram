'use strict';
// Callers that log by code only (the mailbox poller) need every refusal to
// carry a stable code; clients that read messages must see them unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { createExternalJobService } = require('../lib/external-jobs/service');

function fixture(t, settings = {}, overrides = {}) {
  const raw = new Database(':memory:'); raw.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
  t.after(() => raw.close());
  const config = { bot: { externalJobs: { enabled: true, routes: { a: { chatId: '-1001', threadId: '1' }, bad: { chatId: '-1001', threadId: '2' } }, ...settings } } };
  return createExternalJobService({ config, db: { raw }, botName: 'test', logger: { error() {} },
    resolveTarget: (route) => { if (route.threadId === '2') throw new Error('External job topic must be isolated'); return { ...route, sessionKey: `${route.chatId}:${route.threadId}` }; },
    dispatch: async () => ({ outcome: 'unknown' }), deliverPart: async () => ({}), ...overrides });
}
const refused = (code, message) => (error) => error.code === code && message.test(error.message);
const input = (over = {}) => ({ routeId: 'a', requestId: 'r1', task: 'Task', payload: {}, ...over });

test('submission refusals carry stable codes and keep their messages', (t) => {
  const service = fixture(t, { maxPending: 1 });
  assert.throws(() => service.submit(input({ routeId: 'missing' })), refused('EXTERNAL_JOB_ROUTE_UNAVAILABLE', /^External job route is unavailable$/));
  assert.throws(() => service.submit(input({ routeId: 'bad' })), refused('EXTERNAL_JOB_ROUTE_UNAVAILABLE', /^External job topic must be isolated$/));
  assert.throws(() => service.submit(input({ requestId: '' })), refused('EXTERNAL_JOB_INVALID', /^Invalid request ID$/));
  assert.throws(() => service.submit(input({ extra: 1 })), refused('EXTERNAL_JOB_INVALID', /^Unknown job field: extra$/));
  assert.throws(() => service.submit(input({ payload: { big: 'x'.repeat(40000) } })), refused('EXTERNAL_JOB_TOO_LARGE', /^Job exceeds size limit$/));
  service.submit(input());
  assert.throws(() => service.submit(input({ task: 'Changed' })), refused('EXTERNAL_JOB_IDENTITY_CONFLICT', /^Job identity conflict$/));
  assert.throws(() => service.submit(input({ requestId: 'r2' })), refused('EXTERNAL_JOB_QUEUE_FULL', /^External job queue full$/));
  assert.throws(() => service.get({ routeId: 'a', requestId: 'none' }), refused('EXTERNAL_JOB_NOT_FOUND', /^External job not found$/));
});

test('recovery refusals carry stable codes and keep their messages', async (t) => {
  const plain = fixture(t);
  plain.submit(input()); plain.start(); await plain.tick();
  await assert.rejects(plain.prepareRecovery({ routeId: 'a', requestId: 'r1' }), refused('EXTERNAL_JOB_RECOVERY_UNAVAILABLE', /^Session recovery is unavailable$/));
  plain.pauseSession('-1001:1', true);
  await assert.rejects(plain.prepareRecovery({ routeId: 'a', requestId: 'r1' }), refused('EXTERNAL_JOB_RECOVERY_UNAVAILABLE', /^Unknown job recovery is unavailable$/));
  const busy = fixture(t, {}, { recoverInactive: async () => false });
  busy.submit(input()); busy.start(); await busy.tick();
  await assert.rejects(busy.prepareRecovery({ routeId: 'a', requestId: 'r1' }), refused('EXTERNAL_JOB_RECOVERY_UNCONFIRMED', /^Recovered session inactivity is not confirmed$/));
});
