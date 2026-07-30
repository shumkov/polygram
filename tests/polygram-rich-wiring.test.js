'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

const { createRichSender } = require('../lib/telegram/rich-send');
const { createRichCapabilityLatch } = require('../lib/telegram/rich-capability-latch');
const {
  isRichCapabilityError,
  isRichCapabilityErrorExplicit,
  isRichMessageFieldRejection,
  isRichContentError,
} = require('../lib/telegram/rich');

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

  test('the streamer opens its bubble through the shared rich sender, not a hand-rolled call', () => {
    // sendRichMessage is the only verb that can open a bubble rich; going
    // direct to tg() would bypass the latch, the transcript row and the
    // media preflight the primitive owns.
    const wiring = sectionBetween('send: async (payload) => {', 'edit: async (messageId, payload) => {');
    assert.match(wiring, /sendRich: richSendMessage,/);
    assert.doesNotMatch(wiring, /'sendRichMessage'/,
      'the primitive owns the verb — this wiring must not call it directly');
    // A refusal never throws; it downgrades to the plain bubble the streamer
    // pre-computed against the smaller plain cap.
    assert.match(wiring, /if \(out\?\.wentRich\)/);
    assert.match(wiring, /sanitizeLiveText\(openRich \? payload\.plainText : payload\)/);
    assert.match(wiring, /wentRich: false/,
      'the streamer needs to know a downgraded open left a PLAIN bubble');
  });

  test('the reply anchor is spent once per open, whichever verb carries it', () => {
    // A rich attempt that downgrades sends exactly one bubble. Attaching
    // reply_parameters to both would quote the user twice; attaching it to
    // neither would lose the anchor for the whole turn.
    const wiring = sectionBetween('send: async (payload) => {', 'edit: async (messageId, payload) => {');
    assert.equal((wiring.match(/allow_sending_without_reply: true/g) || []).length, 1);
    assert.match(wiring, /const replyParams = hadReplyAnchor/);
    assert.match(wiring, /replyParams,/, 'the rich open reuses it');
    assert.match(wiring, /if \(replyParams\) params\.reply_parameters = replyParams;/);
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

// ─── the streamed open's own verdict ───────────────────────────────
//
// Two layers, because neither alone is enough. polygram.js runs main() on
// load and the send closure is built inside handleMessage, so there is no
// seam to drive it: layer 1 executes the real sender and the real shared
// latch to establish WHY the open needs a verdict of its own, and layer 2 is
// a source tripwire that the closure actually keeps one.

describe('the streamed rich open stops probing a server that cannot serve it', () => {
  // A server that does rich EDITS but answers sendRichMessage with a bare 404
  // — the exact shape the two-strike rule was built to survive at a restart,
  // and the one where it never fires.
  function bare404Fleet({ explicit = false } = {}) {
    const unsupported = { send: false, edit: false };
    const wire = [];
    const latch = createRichCapabilityLatch({
      isExplicit: isRichCapabilityErrorExplicit,
      isFieldRejection: isRichMessageFieldRejection,
      setUnsupported: (verb) => { unsupported[verb] = true; },
    });
    const sendRich = createRichSender({
      tg: async (_bot, method) => {
        wire.push(method);
        const err = new Error(explicit
          ? 'Not Found: method "sendRichMessage" not found'
          : 'Not Found');
        err.error_code = 404;
        throw err;
      },
      botName: 'testbot',
      isRichCapabilityError,
      isRichCapabilityErrorExplicit,
      isRichContentError,
      getRichKnownUnsupported: () => unsupported.send,
      setRichKnownUnsupported: () => { unsupported.send = true; },
      capabilityLatch: latch,
      logger: { error: () => {}, warn: () => {} },
    });
    // One bubble: the open is attempted, then the rich EDIT one flush later
    // succeeds — which is exactly what resets the strike counter.
    const bubble = async () => {
      const out = await sendRich({ chatId: '1', blocks: [{ type: 'divider' }], sourceText: 'x' });
      latch.recordHealthyOutcome();
      return out;
    };
    return { bubble, wire, unsupported };
  }

  test('the shared latch never trips on this server, so an unguarded open probes forever', async () => {
    // The premise. Without a verdict of its own, every preview for the
    // process lifetime pays a doomed round-trip and files a capability
    // strike the soak reads as a server going bad.
    const fleet = bare404Fleet();
    for (let i = 0; i < 20; i++) await fleet.bubble();
    assert.equal(fleet.wire.length, 20, '20 bubbles, 20 failed sends');
    assert.equal(fleet.unsupported.send, false, 'and the send verdict is still green');
  });

  test('one capability refusal is enough for the OPEN: two bubbles, one attempt', async () => {
    const fleet = bare404Fleet();
    // The rule the send closure applies, verbatim: skip the open once a
    // capability refusal has been seen.
    let openUnsupported = false;
    for (let i = 0; i < 2; i++) {
      if (openUnsupported) continue;
      const out = await fleet.bubble();
      if (out.fallback === 'capability') openUnsupported = true;
    }
    assert.equal(fleet.wire.length, 1, 'exactly one failed sendRichMessage process-wide');
    assert.equal(fleet.unsupported.send, false,
      'and the shared send verdict is untouched — the reply tool keeps its two strikes');
  });

  test('an explicit method-naming 404 still latches the shared verdict on bubble 1', async () => {
    const fleet = bare404Fleet({ explicit: true });
    const out = await fleet.bubble();
    assert.equal(out.fallback, 'capability');
    assert.equal(fleet.unsupported.send, true, 'conclusive evidence latches as it always did');
    assert.equal(fleet.unsupported.edit, false, 'a missing METHOD condemns only its own verb');
  });
});

describe('polygram wiring for the open verdict', () => {
  test('the open holds its own verdict and never writes to the shared latches', () => {
    assert.match(source, /let richStreamOpenUnsupported = false;/);
    const wiring = sectionBetween('send: async (payload) => {', 'edit: async (messageId, payload) => {');
    assert.match(wiring, /if \(openRich && !richStreamOpenUnsupported\)/,
      'a refused open must stop the next one from being attempted at all');
    assert.match(wiring, /if \(out\?\.fallback === 'capability'\) \{[\s\S]*?richStreamOpenUnsupported = true;/,
      'and only a capability refusal trips it — a content error says nothing about the verb');
    assert.doesNotMatch(wiring, /richSendKnownUnsupported\s*=|richKnownUnsupported\s*=/,
      'the open must not write either shared latch: its evidence bar is lower');
  });

  test('the open runs the same flatten-and-retry the reply path runs', () => {
    const wiring = sectionBetween('send: async (payload) => {', 'edit: async (messageId, payload) => {');
    assert.match(wiring, /await sendRichWithStylingRetry\(\{/);
    assert.match(wiring, /onStylingRejected: \(\) => richStylingLatch\?\.recordStylingRejection\(\)/);
    assert.match(wiring, /onStylingAccepted: \(\) => richStylingLatch\?\.recordHealthyOutcome\(\)/);
  });

  test('a streamed open is distinguishable from a reply-tool send in the soak', () => {
    const wiring = sectionBetween('send: async (payload) => {', 'edit: async (messageId, payload) => {');
    assert.match(wiring, /source: 'bot-reply-stream-open-rich'/);
  });
});

describe('polygram inline-styling wiring', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'polygram.js'), 'utf8');

  test('styling has its own verdict, separate from both capability latches', () => {
    // Tripping either capability latch costs every heading, table and task
    // list. Tripping this one costs bold, italic, code spans and links. A
    // server that predates typed nodes still does rich perfectly well, so
    // conflating them would trade the feature for a sub-feature.
    assert.match(source, /let richInlineStylingUnsupported = false;/);
    assert.match(source, /createRichStylingLatch\(\{/);
    assert.doesNotMatch(source, /richKnownUnsupported = true;[\s\S]{0,80}inlineStyling/,
      'a styling rejection must never set a rich capability flag');
  });

  test('both rich paths read the same styling verdict', () => {
    // The renderer is shared, so a verdict that reached only one path would
    // leave the other authoring payloads the server has already refused.
    assert.match(source, /inlineStyling: !richInlineStylingUnsupported/,
      'the streamer payload builder consults it');
    assert.match(source, /isInlineStylingEnabled: \(\) => !richInlineStylingUnsupported/,
      'and so does the reply-tool strategy');
  });

  test('the verdict is fed by confirmed rejections, not by any content error', () => {
    assert.match(source, /onStylingRejected: \(\) => richStylingLatch\?\.recordStylingRejection\(\)/);
    assert.match(source, /onStylingAccepted: \(\) => richStylingLatch\?\.recordHealthyOutcome\(\)/);
  });

  test('ALL THREE paths can feed the verdict, not just the reply tool', () => {
    // The streamer styles every payload it renders. If only the dispatcher
    // could record a rejection, a streamer-only chat against a styling-unaware
    // server would refuse, degrade, and never learn — every bubble plain,
    // forever, with the latch still showing green. The streamed OPEN is the
    // third: without it, a styling-refusing server costs every preview its
    // first frame and teaches the process nothing.
    assert.equal((source.match(/onStylingRejected:/g) || []).length, 3,
      'the editor, the reply-tool sender and the streamed open all report');
    assert.equal((source.match(/onStylingAccepted:/g) || []).length, 3);
  });

  test('the limit predicate reaches both senders', () => {
    // Without it, an oversized reply that succeeds once flattened counts as
    // evidence that the server refuses typed nodes.
    assert.equal((source.match(/\bisRichLimitError,/g) || []).length, 3,
      'imported once, passed to the editor and the sender');
  });
});
