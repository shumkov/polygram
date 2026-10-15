'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { createExternalJobStore } = require('../lib/external-jobs/store');
function fixture(t, botName = 'test') {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
  t.after(() => db.close());
  return { db, store: createExternalJobStore(db, { botName, now: () => 1000 }) };
}
const target = { chatId: '-1001', threadId: '2', sessionKey: '-1001:2' };
const request = (requestId = 'one', payload = { b: 2, a: 1 }) => ({ routeId: 'review', requestId, task: 'Summarize the supplied document.', payload });
test('canonical identity survives key reordering, retargeting and a lost acknowledgement', (t) => {
  const { store } = fixture(t);
  const first = store.submit(request(), target);
  const duplicate = store.submit(request('one', { a: 1, b: 2 }), { ...target, chatId: '-1002' });
  assert.equal(first.accepted, true); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(store.work(first.job.id).target, target);
  assert.throws(() => store.submit(request('one', { a: 3 }), target), /conflict/i);
});
test('original content conflicts even when durable redaction matches', (t) => {
  const { store } = fixture(t);
  const one = store.submit(request('one', { token: 'sk-ant-api03-' + 'a'.repeat(100) }), target);
  const two = store.submit(request('two', { token: 'sk-ant-api03-' + 'b'.repeat(100) }), target);
  assert.deepEqual(store.work(one.job.id).payload, store.work(two.job.id).payload);
  assert.throws(() => store.submit(request('one', { token: 'sk-ant-api03-' + 'b'.repeat(100) }), target), /conflict/i);
});
test('bounds and capacity reject before acceptance; bot and route lookup are isolated', (t) => {
  const { store, db } = fixture(t);
  store.submit(request(), target, 1);
  assert.throws(() => store.submit(request('two'), target, 1), /full/i);
  assert.equal(store.submit(request(), target, 1).duplicate, true);
  assert.throws(() => store.submit({ ...request('big'), task: 'x'.repeat(32768) }, target), /size/i);
  assert.throws(() => store.get({ routeId: 'other', requestId: 'one' }), /not found/i);
  assert.throws(() => createExternalJobStore(db, { botName: 'other' }).get(request()), /not found/i);
});
test('session pause survives store recreation and prevents claims through route aliases', (t) => {
  const { store, db } = fixture(t);
  const receipt = store.submit(request(), target);
  store.pauseSession(target.sessionKey, true);
  const reopened = createExternalJobStore(db, { botName: 'test' });
  assert.equal(reopened.get(request()).paused, true);
  assert.equal(reopened.claim(receipt.job.id), null);
  reopened.pauseSession(target.sessionKey, false);
  assert.equal(reopened.claim(receipt.job.id).state, 'running');
});
test('restart never replays execution or a report part with an uncertain send', (t) => {
  const { store } = fixture(t);
  const one = store.submit(request(), target).job.id;
  store.claim(one); store.setTurnId(one, 'turn-one'); store.recover();
  assert.equal(store.get(request()).state, 'unknown'); assert.equal(store.claim(one), null);
  const two = store.submit(request('two'), target).job.id;
  assert.equal(store.claim(two), null);
  assert.match(store.get(request('two')).error, /inactivity/i);
  store.setInactive(one); store.claim(two);
  store.finish(two, { outcome: 'succeeded', inactive: true }, ['first', 'second']);
  const part = store.parts(two)[0]; store.beginPart(part.id); store.recover();
  assert.equal(store.get(request('two')).reportState, 'unknown');
  assert.equal(store.parts(two)[0].state, 'unknown');
});
test('persisted report resumes without repeating delivered parts after restart', (t) => {
  const { store, db } = fixture(t);
  const id = store.submit(request(), target).job.id;
  store.claim(id); store.finish(id, { outcome: 'succeeded', inactive: true }, ['first', 'second']);
  const first = store.parts(id)[0]; store.beginPart(first.id); store.completePart(first.id, { messageId: 12 });
  const restarted = createExternalJobStore(db, { botName: 'test' }); restarted.recover();
  assert.equal(restarted.get(request()).state, 'succeeded');
  assert.equal(restarted.get(request()).reportState, 'pending');
  assert.equal(restarted.parts(id)[0].state, 'delivered'); assert.equal(restarted.parts(id)[1].state, 'pending');
});
test('non-JSON payloads and oversized frozen destinations cannot be accepted', (t) => {
  const { store } = fixture(t);
  for (const value of [undefined, NaN, () => 1, new Date()]) {
    assert.throws(() => store.submit(request('invalid', { value }), target), /JSON/);
  }
  assert.throws(() => store.submit(request(), { ...target, sessionKey: 'x'.repeat(501) }), /session key/);
});
