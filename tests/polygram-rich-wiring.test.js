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
    assert.match(wiring, /displayHint:\s*\(chatId, threadId\)\s*=>\s*buildPolygramDisplayHint\(\s*resolveRichTextEnabled\(config, chatId, threadId\),/);
    assert.doesNotMatch(wiring, /displayHint:\s*require\('\.\/lib\/telegram\/display-hint'\)\.POLYGRAM_DISPLAY_HINT/);
  });

  test('the CLI-backend display hint teaches inline media, because the reply tool renders it', () => {
    // The hint is the exposure throttle for this feature: agents author the
    // media syntax it teaches. It may only be on where the DELIVERING path
    // resolves media — for this backend, the reply-tool rich strategy.
    const wiring = sectionBetween('const orchestraProcessFactory = createProcessFactory({', ');');
    // The whole option, up to wherever the next one starts.
    const call = /displayHint:[\s\S]*?\n(?= {4}(?:\/\/|[a-zA-Z]))/.exec(wiring)?.[0] ?? '';
    assert.match(call, /inlineMedia: true/,
      'the CLI hint should teach the media syntax this backend delivers');
  });

  test('neither rich path accepts URL media, whatever the server', () => {
    // The streamer's resolver used to allow URLs whenever there was no
    // self-hosted apiRoot. That is the wrong way round: a self-hosted server
    // fetching the URL is an SSRF surface, while the cloud API fetching it is
    // an exfiltration beacon that leaves nothing on this host to find. A
    // reply-tool reply consumed by a live preview is rendered by THIS
    // resolver, so the reply tool's own refusal is only half the door.
    const wiring = sectionBetween('const resolveRichMedia = makeRichMediaResolver({', '});');
    assert.match(wiring, /allowUrlMedia: false/);
    assert.doesNotMatch(wiring, /allowUrlMedia:\s*!config/,
      'the apiRoot conditional is what left cloud bots open');
  });

  test('a preview that consumes a reply projects media out of it first', () => {
    // Consuming means the streamer renders the bubble, under the interactive
    // path's media rules rather than the reply tool's. Without this the same
    // reply obeys different roots and a wider fan-out depending only on
    // whether a preview happened to be live.
    const wiring = sectionBetween('const makeDeliverText = composeDeliverTextFactories([', ']);');
    assert.match(wiring, /projectConsumedText:/);
    assert.match(wiring, /stripMediaMarkdown\(text\)/);
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
