'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('polygram rich-message wiring', () => {
  test('the stream callback re-reads config and capability state for every payload', () => {
    const wiring = sectionBetween('const toRichPayload =', 'const streamer = createStreamer');
    assert.match(wiring, /const toRichPayload = \(text, opts\) =>/);
    assert.match(wiring, /resolveRichTextEnabled\(config, chatId, threadId\)/);
    assert.match(wiring, /richKnownUnsupported/);
    assert.doesNotMatch(wiring, /const richTextOn\s*=/);
  });

  test('the command card receives the same effective value as delivery', () => {
    const wiring = sectionBetween(
      "if (botAllowsCommands && (text === '/model'",
      '// Slash command dispatch',
    );
    assert.match(wiring, /effectiveRichText = resolveRichTextEnabled\(config, chatId,/);
    assert.match(
      wiring,
      /formatConfigInfoText\([\s\S]*?effectiveRichText,[\s\S]*?runtimeView,/,
    );
    assert.match(
      wiring,
      /buildConfigKeyboard\([\s\S]*?effectiveRichText,[\s\S]*?runtimeView,/,
    );
  });

  test('model and effort handlers share the per-session intent lock', () => {
    assert.match(
      source,
      /createHandleConfigCallback\(\{[\s\S]*?config, db, dbWrite, pm, intentLock, getSessionKey,/,
    );
    assert.match(
      source,
      /createSlashCommands\(\{[\s\S]*?config, db, dbWrite, pm, intentLock, pairings,/,
    );
  });

  test('Codex runtime view projects explicit desired, observed, and active settings', () => {
    const wiring = sectionBetween(
      'async function resolveSessionRuntimeView',
      'async function buildSpawnContext',
    );
    assert.match(wiring, /desiredSettings:/);
    assert.match(wiring, /observedThreadSettings:/);
    assert.match(wiring, /activeTurnSettings:/);
    assert.match(wiring, /pm\.getModelSettingsStatus\(sessionKey\)/);
    assert.doesNotMatch(wiring, /proc\?\.observedThreadSettings/);
    assert.doesNotMatch(wiring, /runtimeView\.model\s*===\s*proc\.model/);
  });

  test('the CLI-backend display hint is resolved per chat, not a fixed constant', () => {
    // Regression guard: cli-backed chats (pm:'cli') get their system-prompt
    // display hint from createProcessFactory's displayHint option, which
    // orchestra >=0.4.2 supports as a per-spawn resolver function. A static
    // string here means every cli chat is silently stuck in plain mode
    // regardless of its own richText config (the bug this test pins).
    const wiring = sectionBetween('const orchestraProcessFactory = createProcessFactory({', ');');
    assert.match(wiring, /displayHint:\s*\(chatId, threadId\)\s*=>\s*buildPolygramDisplayHint\(resolveRichTextEnabled\(config, chatId, threadId\)\)/);
    assert.doesNotMatch(wiring, /displayHint:\s*require\('\.\/lib\/telegram\/display-hint'\)\.POLYGRAM_DISPLAY_HINT/);
  });

  test('the CLI-backend display hint does not promise inline media', () => {
    // Replies on this backend go out through the reply tool, which renders
    // rich text on media-stripped input — an image would reach the user as
    // its caption and nothing else. The SDK path opts in separately because
    // its streamer does deliver media.
    const wiring = sectionBetween('const orchestraProcessFactory = createProcessFactory({', ');');
    const call = /displayHint:[^\n]*/.exec(wiring)?.[0] ?? '';
    assert.doesNotMatch(call, /inlineMedia/,
      'the CLI hint must not teach syntax this backend discards');
  });

  test('the send verb has its own verdict, separate from the edit verb', () => {
    // A server implementing editMessageText{rich_message} but not the newer
    // sendRichMessage answers the latter with a bare 404. Sharing one flag
    // lets the reply tool's probe permanently kill the streamer's working
    // rich edits.
    assert.match(source, /let richSendKnownUnsupported = false;/);
    // The streamer's payload gate reads the EDIT verdict.
    const streamGate = sectionBetween('const toRichPayload =', 'const mediaContext =');
    assert.match(streamGate, /richKnownUnsupported/);
    assert.doesNotMatch(streamGate, /richSendKnownUnsupported/);
    // The sender and the reply-tool strategy read the SEND verdict.
    assert.match(
      source,
      /getRichKnownUnsupported: \(\) => richSendKnownUnsupported/,
      'the rich sender must consult the send verdict',
    );
  });

  test('exactly one capability latch is shared by both rich paths', () => {
    // Two counters would let either path latch on its first bare 404 while
    // the other believed two were still required, which is the restart-blip
    // protection the two-strike rule exists to provide.
    assert.equal(
      (source.match(/createRichCapabilityLatch\(/g) || []).length, 1,
      'the latch is constructed once',
    );
    assert.equal(
      (source.match(/capabilityLatch: richCapabilityLatch/g) || []).length, 2,
      'and handed to both the editor and the sender',
    );
  });
});
