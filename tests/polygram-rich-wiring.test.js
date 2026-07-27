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
});
