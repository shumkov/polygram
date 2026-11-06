'use strict';
// polygram.js wires the mailbox at module scope, where it cannot be imported
// in isolation; these checks pin the wiring the unit tests rely on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
const body = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return src.slice(start, src.indexOf('\n}\n', start));
};

test('every human prompt resets the session depth and carries the mailbox instructions', () => {
  const format = body('formatPrompt');
  const reset = format.indexOf('mailboxService?.noteHumanPrompt(sessionKey)');
  const instructions = format.indexOf('mailboxService?.instructions(sessionKey)');
  assert.ok(reset >= 0 && instructions > reset, 'depth is reset before the instructions are rendered');
});

test('external jobs dispatch through the shared wrapper with both services', () => {
  assert.match(src, /dispatch: createExternalJobDispatch\(\{[\s\S]*?getNotifications: \(\) => notificationService,[\s\S]*?getMailbox: \(\) => mailboxService,/);
  assert.doesNotMatch(src, /externalRuntime\.dispatch\(\{ \.\.\.job, task: job\.task/, 'no second, unwrapped dispatch path remains');
});

test('the mailbox service is built from the external-jobs resolver and served over IPC', () => {
  assert.match(src, /mailboxService = createMailboxService\(\{[\s\S]*?jobs: externalJobService, resolveTarget: resolveExternalTarget/);
  assert.match(src, /createIpcHandlers\(\{[\s\S]*?mailbox: mailboxService,/);
});
