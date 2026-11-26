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
  const reset = format.indexOf('mailboxService?.noteHumanPrompt(sessionKey, { operator: isAutomationOperator(config, msg), newTurn: !pm?.get(sessionKey)?.inFlight, owner: mailboxHumanTurn(chatId, msg.message_id) })');
  const instructions = format.indexOf('mailboxService?.instructions(sessionKey)');
  assert.ok(reset >= 0 && instructions > reset, 'depth is reset before the instructions are rendered');
});

test('external jobs dispatch through the shared wrapper with both services', () => {
  assert.match(src, /dispatch: createExternalJobDispatch\(\{[\s\S]*?getNotifications: \(\) => notificationService,[\s\S]*?getMailbox: \(\) => mailboxService,\s*logger: console, logEvent,/);
  assert.doesNotMatch(src, /externalRuntime\.dispatch\(\{ \.\.\.job, task: job\.task/, 'no second, unwrapped dispatch path remains');
});

test('the mailbox service is built from the external-jobs resolver and served over IPC', () => {
  assert.match(src, /mailboxService = createMailboxService\(\{[\s\S]*?jobs: externalJobService, resolveTarget: resolveExternalTarget, bot, tg,\s*ipcDir: ipcRuntimeDir,/);
  assert.match(src, /createIpcHandlers\(\{[\s\S]*?mailbox: mailboxService,/);
});

test('the notice poller starts after external-job recovery and stops with the other services', () => {
  const jobsStart = src.indexOf('externalJobService.start();');
  const mailboxStart = src.indexOf('mailboxService.start();');
  assert.ok(jobsStart >= 0 && mailboxStart > jobsStart, 'unknown jobs are marked before the first poll');
  assert.match(src, /notificationService\?\.stop\(\);\s*mailboxService\?\.stop\(\);\s*externalJobService\?\.stop\(\);/);
});

test('the depth reset runs for every human prompt, not only when a fresh session preloads history', () => {
  const format = body('formatPrompt');
  const blockStart = format.indexOf('if (sessionKey && db) {');
  assert.ok(blockStart >= 0, 'the fresh-session history block exists');
  let depth = 0; let blockEnd = -1;
  for (let i = format.indexOf('{', blockStart); i < format.length; i++) {
    if (format[i] === '{') depth++;
    else if (format[i] === '}' && --depth === 0) { blockEnd = i; break; }
  }
  assert.ok(blockEnd > blockStart, 'the block closes');
  const reset = format.indexOf('mailboxService?.noteHumanPrompt(sessionKey, { operator: isAutomationOperator(config, msg), newTurn: !pm?.get(sessionKey)?.inFlight, owner: mailboxHumanTurn(chatId, msg.message_id) })');
  assert.ok(reset > blockEnd, 'noteHumanPrompt must sit after the fresh-session block, where every prompt passes');
});

test('Codex job turns are settled through the controller, the login gate asks about the job\'s backend, and failures reach the events table', () => {
  assert.match(src, /needsAuth: \(backend\) => needsNativeClaudeAuth\(config\.bot, backend\),/);
  assert.match(src, /settleResult: \(sessionKey, result, disposition\) => \{[\s\S]*?return codexRuntimeController\.settleTelegramDelivery\(sessionKey, result, \{ disposition \}\);/,
    'the disposition travels as an option: a bare string would silently settle every turn as delivered');
  assert.match(src, /createExternalJobRuntime\(\{[\s\S]*?getOrSpawnForChat, sendToProcess, logEvent, logger: console,/);
});

test('notification consumers resolve their destinations on the Claude CLI only', () => {
  assert.match(src, /notificationService = createNotificationService\(\{[\s\S]*?resolveTarget: createExternalJobTargetResolver\(\{\s*config, getSessionKey, backends: \['cli'\],/);
});

test('a person\'s assistant learns, under the dispatch latch, whether its person\'s message starts a new turn', () => {
  const handle = body('handleMessage');
  const latch = handle.indexOf('const releaseIntent = await intentLock.acquire(sessionKey);');
  const note = handle.indexOf('mailboxService?.noteHumanDispatch(sessionKey, {');
  const decide = handle.indexOf('const dispatchPrimary = shouldDispatchPrimaryAfterAutosteer({');
  const send = handle.indexOf('sendPromise = sendToProcess(sessionKey, prompt, {');
  const branch = handle.indexOf('if (dispatchPrimary) {');
  assert.ok(latch >= 0 && decide > latch && note > decide && branch > note && send > branch,
    'the note uses the real fold-or-turn decision, inside the latch, before the primary branch, so folds are noted too');
  assert.match(handle, /newTurn: dispatchPrimary,\s*idle: assistantIdle,\s*owner: mailboxHumanTurn\(chatId, msg\.message_id\),/);
});

test('an assistant turn ends when its primary turn settles, or at once when no turn was dispatched', () => {
  const handle = body('handleMessage');
  assert.match(handle, /const result = await sendPromise;\s*\/\/[^\n]*\n\s*mailboxService\?\.noteTurnEnd\(sessionKey, mailboxHumanTurn\(chatId, msg\.message_id\)\);/);
  assert.match(handle, /releaseIntent\(\);[\s\S]{0,200}if \(!sendPromise\) mailboxService\?\.noteTurnEnd\(sessionKey, mailboxHumanTurn\(chatId, msg\.message_id\)\);/);
});

test('go-card presses reach the mailbox', () => {
  // The router sends `mbx:` data to this route; tests/callback-router.test.js
  // covers the routing itself.
  assert.match(src, /mailbox: mailboxService \? \(ctx\) => mailboxService\.handleGoCallback\(ctx\) : null,/);
});

test('a tainted assistant\'s new turn needs the same idle proof external jobs use before its taint can clear', () => {
  const handle = body('handleMessage');
  const proof = handle.indexOf('if (dispatchPrimary && mailboxService?.needsIdleProof(sessionKey)) {');
  const note = handle.indexOf('mailboxService?.noteHumanDispatch(sessionKey, {');
  assert.ok(proof >= 0 && note > proof, 'the proof runs before the note');
  assert.match(handle.slice(proof, note), /current\.probeBusyState\(\)\.then\(\(probe\) => probe\?\.busy === false, \(\) => false\)/);
  assert.match(handle.slice(note, note + 200), /idle: assistantIdle,/);
});

test('the history scope asks the mailbox whether an assistant may read a role topic', () => {
  assert.match(src, /historyService = createHistoryService\(\{[\s\S]*?canReadTopic: \(sessionKey, place\) => mailboxService\?\.canReadRoleTopic\(sessionKey, place\) \?\? false,\s*readsRoleTopics: \(sessionKey\) => mailboxService\?\.isAssistant\(sessionKey\) \?\? false \}\);/);
});


test('external-job reports render through the same rich renderer as a non-streamed final reply', () => {
  assert.match(src, /deliverPart: createReportDelivery\(\{[\s\S]*?linkPreview: \(chatId\) => \(config\.chats\?\.\[String\(chatId\)\]\?\.linkPreview != null/, 'with the same link-preview opt-out');
  assert.match(src, /deliverPart: createReportDelivery\(\{[\s\S]*?deliverRich: \(\{ chatId, threadId, text, meta \}\) => \(makeRichDeliverText\s*\? makeRichDeliverText\(\{ chatId, threadId \}\)\(\{ text, meta \}\)/);
});
