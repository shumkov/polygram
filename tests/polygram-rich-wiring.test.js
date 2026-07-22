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
    assert.match(wiring, /formatConfigInfoText\([^\n]+effectiveRichText\)/);
    assert.match(wiring, /buildConfigKeyboard\([^\n]+effectiveRichText\)/);
  });

  test('the CLI-backend display hint is resolved per chat, not a fixed constant', () => {
    // Regression guard: cli-backed chats (pm:'cli') get their system-prompt
    // display hint from createProcessFactory's displayHint option, which
    // orchestra >=0.4.2 supports as a per-spawn resolver function. A static
    // string here means every cli chat is silently stuck in plain mode
    // regardless of its own richText config (the bug this test pins).
    const wiring = sectionBetween('const processFactory = createProcessFactory({', ');');
    assert.match(wiring, /displayHint:\s*\(chatId, threadId\)\s*=>\s*buildPolygramDisplayHint\(resolveRichTextEnabled\(config, chatId, threadId\)\)/);
    assert.doesNotMatch(wiring, /displayHint:\s*require\('\.\/lib\/telegram\/display-hint'\)\.POLYGRAM_DISPLAY_HINT/);
  });
});
