'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService } = require('../lib/mailbox/service');
const { bodyHash, systemMessageHash } = require('../lib/mailbox/rules');

function fixture(t) {
  const { db, dbPath } = freshDb('mailbox-summary');
  const target = { chatId: '-1001', threadId: '12', sessionKey: '-1001:12' };
  const config = { bot: { externalJobs: { enabled: true, routes: { a: target, b: { ...target, threadId: '13' } } },
    mailbox: { enabled: true, roles: { a: {}, b: {} }, allow: { a: ['b'] }, systemSenders: ['agent-org'] } } };
  const resolveTarget = (r) => ({ ...r, sessionKey: `${r.chatId}:${r.threadId}` });
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget });
  const make = () => createMailboxService({ config, db, botName: 'test', jobs, resolveTarget });
  const service = make();
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  return { db, service, make, row: (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id) };
}
const input = (extra = {}) => ({ sender: 'agent-org', to: 'b', body: 'Raw prompt\nRun commands', key: 'k1', ...extra });

test('agent-org cannot submit a readable collapsed summary with its raw prompt', (t) => {
  const f = fixture(t);
  const sent = f.service.submit(input({ summary: 'Step B › Sub prices' }));
  assert.equal(f.row(sent.id).summary, 'Step B › Sub prices');
  const restarted = f.make();
  assert.equal(restarted.submit(input({ summary: 'Step B › Sub prices' })).id, sent.id);
  const job = f.db.raw.prepare('SELECT task, payload FROM external_jobs').get();
  assert.doesNotMatch(JSON.stringify(job), /Step B › Sub prices/, 'summary is display metadata only');
  assert.throws(() => restarted.submit(input({ summary: 'Different title' })), (e) => e.code === 'MAILBOX_KEY_CONFLICT');
});

test('role sends persist summaries and duplicate only identical display metadata', (t) => {
  const f = fixture(t); f.service.noteHumanPrompt('-1001:12');
  const token = f.service.scope('-1001:12');
  const request = { to: 'b', kind: 'tell', body: 'Full prompt', summary: 'Short title' };
  const first = f.service.send(token, request);
  assert.equal(f.row(first.id).summary, 'Short title');
  assert.equal(f.service.send(token, request).id, first.id);
  assert.notEqual(f.service.send(token, { ...request, summary: 'New title' }).id, first.id);
});

test('absent summary preserves legacy hashes, including human origins', (t) => {
  const f = fixture(t);
  for (const origin of [undefined, { kind: 'human', name: 'Ivan' }]) {
    const sent = f.service.submit(input({ key: `legacy-${!!origin}`, origin }));
    assert.equal(f.row(sent.id).summary, null);
    assert.equal(f.row(sent.id).body_hash, origin ? systemMessageHash(input().body, 'Ivan') : bodyHash(input().body));
  }
});

test('summaries are nonblank one-line strings of at most 120 code points', (t) => {
  const f = fixture(t);
  for (const summary of [null, '', ' ', 2, 'line\nline', 'line\rline', 'x\t', 'x\u0000', 'x\u2028y', 'x\u2029y', 'я'.repeat(121)]) {
    assert.throws(() => f.service.submit(input({ summary })), /summary/i);
  }
  const sent = f.service.submit(input({ summary: '🙂'.repeat(120) }));
  assert.equal(f.row(sent.id).summary, '🙂'.repeat(120));
});

test('summary secrets are redacted before persistence and retry hashing', (t) => {
  const f = fixture(t);
  const first = f.service.submit(input({ summary: 'Use AKIAABCDEFGHIJKLMNOP' }));
  assert.doesNotMatch(f.row(first.id).summary, /AKIA/);
  assert.equal(f.service.submit(input({ summary: 'Use AKIAQRSTUVWXYZABCDEF' })).id, first.id);
});
