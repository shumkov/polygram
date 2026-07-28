'use strict';

/**
 * Rich replies on the channels dispatcher.
 *
 * ~80% of agent output flows through channels-tool-dispatcher, which was
 * plain-only: a `richText: true` chat rendered every heading/table/task
 * list flat while the display hint told the agent to author them. These
 * tests pin the seam that fixes it — the dispatcher builds a per-call
 * delivery strategy from an injected factory and hands it to the shared
 * reply pipeline, which uses it in place of chunk+deliver.
 *
 * The dispatcher must never require the rich modules itself: rich-media.js
 * already requires the dispatcher, so the reverse direction is a cycle.
 * Everything arrives by dependency injection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const dispatcherPath = require.resolve('../lib/process/channels-tool-dispatcher');

const fakeBot = {};
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeDeliverCapture() {
  const calls = [];
  const deliverReplies = async ({ chunks, chatId, threadId, replyToMessageId, meta }) => {
    calls.push({ chunks: [...chunks], chatId, threadId, replyToMessageId, meta });
    return {
      sent: chunks.map((_, i) => ({ message_id: 100 + i })),
      failed: [],
      results: [],
    };
  };
  return { deliverReplies, calls };
}

function makeSendCapture() {
  const calls = [];
  const send = async (_bot, method, params, _meta) => {
    calls.push({ method, params });
    return { message_id: calls.length };
  };
  return { send, calls };
}

// Passthrough parse/sanitize — this file is about delivery, and the
// pipeline tests already pin tag stripping.
const passthroughParse = (text) => ({
  text, sticker: null, stickerLabel: null, stickers: [], reaction: null, reactions: [],
});
const passthroughSanitize = (text) => ({ text, replaced: false });

function buildDispatcher(extra = {}) {
  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const { send, calls: sendCalls } = makeSendCapture();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    ...extra,
  });
  return { dispatcher, deliverCalls, sendCalls };
}

// ─── The seam ──────────────────────────────────────────────────────────────

test('dispatcher builds the strategy from the CALL context, not construction context', async () => {
  // sessionCwd exists only inside the dispatcher call, so a strategy built
  // once at construction time could never see it. Pinning the factory-input
  // shape now is what lets media (which needs the cwd-derived roots) land
  // later without reworking the seam.
  const factoryArgs = [];
  const { dispatcher } = buildDispatcher({
    makeDeliverText: (args) => {
      factoryArgs.push(args);
      return () => ({ handled: false });
    },
  });

  await dispatcher({
    sessionKey: 'sess-A',
    chatId: '12345',
    threadId: '77',
    toolName: 'reply',
    text: 'plain prose',
    files: null,
    sessionCwd: '/tmp/workspace-A',
  });

  assert.equal(factoryArgs.length, 1, 'factory called exactly once per reply');
  assert.deepEqual(
    {
      sessionKey: factoryArgs[0].sessionKey,
      chatId: factoryArgs[0].chatId,
      threadId: factoryArgs[0].threadId,
      sessionCwd: factoryArgs[0].sessionCwd,
    },
    { sessionKey: 'sess-A', chatId: '12345', threadId: '77', sessionCwd: '/tmp/workspace-A' },
    'strategy factory receives this call\'s identity + cwd',
  );
});

test('a handled strategy replaces chunked delivery and owns the returned message_id', async () => {
  const { dispatcher, deliverCalls } = buildDispatcher({
    makeDeliverText: () => async () => ({
      handled: true,
      sent: [{ message_id: 4242 }],
      failed: [],
      results: [],
    }),
  });

  const res = await dispatcher({
    sessionKey: 'sess-A',
    chatId: '12345',
    threadId: null,
    toolName: 'reply',
    text: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    files: null,
  });

  assert.deepEqual(res, { ok: true, message_id: 4242 });
  assert.equal(deliverCalls.length, 0, 'chunk+deliver must not run when the strategy handled it');
});

test('a strategy-delivered bubble is editable by the same session', async () => {
  // The agent gets message_id back from reply and edits it for progressive
  // status. That id has to pass the ownership gate or the next edit_message
  // is denied — a regression the plain path would never show.
  const { dispatcher, sendCalls } = buildDispatcher({
    makeDeliverText: () => async () => ({
      handled: true, sent: [{ message_id: 4242 }], failed: [], results: [],
    }),
  });

  const reply = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '# Heading', files: null,
  });
  assert.equal(reply.message_id, 4242);

  const edit = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'edit_message', messageId: 4242, text: 'updated', files: null,
  });

  assert.equal(edit.ok, true, `edit of an owned rich bubble must be allowed: ${edit.error}`);
  assert.ok(
    sendCalls.some(c => c.method === 'editMessageText' && c.params.message_id === 4242),
    'the edit reached Telegram',
  );
});

test('handled:false falls through to the default chunked path', async () => {
  const { dispatcher, deliverCalls } = buildDispatcher({
    makeDeliverText: () => async () => ({ handled: false }),
  });

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'just prose', files: null,
  });

  assert.equal(res.ok, true);
  assert.equal(deliverCalls.length, 1, 'default delivery ran');
  assert.deepEqual(deliverCalls[0].chunks, ['just prose']);
});

test('a strategy declining with replacement text rewrites the fallback body', async () => {
  // This is how a rich-enabled chat stops leaking absolute local paths on
  // its plain fallback: the strategy hands back media-stripped text and the
  // default path delivers that instead of the raw markdown.
  const { dispatcher, deliverCalls } = buildDispatcher({
    makeDeliverText: () => async () => ({ handled: false, text: 'a screenshot' }),
  });

  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '![a screenshot](/Users/me/secret/shot.png)', files: null,
  });

  assert.deepEqual(deliverCalls[0].chunks, ['a screenshot']);
  assert.ok(
    !deliverCalls[0].chunks.join('').includes('/Users/me'),
    'the absolute path must never reach the chat',
  );
});

test('no strategy injected — delivery is byte-identical to the plain path', async () => {
  const { dispatcher, deliverCalls, sendCalls } = buildDispatcher();

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: '77',
    toolName: 'reply', text: '| a | b |\n| --- | --- |\n| 1 | 2 |', files: null,
    sourceMsgId: 55,
  });

  assert.equal(res.ok, true);
  assert.equal(deliverCalls.length, 1);
  assert.deepEqual(deliverCalls[0].chunks, ['| a | b |\n| --- | --- |\n| 1 | 2 |'],
    'raw markdown passes through untouched');
  assert.equal(deliverCalls[0].replyToMessageId, 55);
  assert.ok(!sendCalls.some(c => c.method === 'sendRichMessage'),
    'no rich call without a strategy');
});

test('a throwing strategy FACTORY still gets the hygiene projection', async () => {
  // The strip is a property of the chat, not of the rich strategy. Wired
  // through the strategy alone, a factory that fails to build would drop the
  // reply straight onto the raw-text path and render the absolute path.
  const { dispatcher, deliverCalls } = buildWired({
    makeDeliverTextOverride: () => { throw new Error('factory exploded'); },
  });

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '## Results\n\n![the chart](/Users/me/secret/chart.png)', files: null,
  });

  assert.equal(res.ok, true, 'the reply must still land');
  const delivered = JSON.stringify(deliverCalls);
  assert.ok(!delivered.includes('/Users/me'), `raw path delivered: ${delivered}`);
  assert.ok(delivered.includes('the chart'), 'the caption survives');
});

test('a throwing strategy FACTORY never loses the reply', async () => {
  // The pipeline catches a strategy that throws when invoked, but the
  // factory runs a level up, inside the dispatcher's own try — so a throw
  // there lands in the catch that reports {ok:false} to the agent with
  // nothing delivered. Narrow, but it is the exact failure this whole
  // fallback design exists to prevent.
  const { dispatcher, deliverCalls } = buildDispatcher({
    makeDeliverText: () => { throw new Error('factory exploded'); },
  });

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'important answer', files: null,
  });

  assert.equal(res.ok, true, 'the agent must not see a failure');
  assert.deepEqual(deliverCalls[0]?.chunks, ['important answer'],
    'the reply still landed via the plain path');
});

test('a throwing strategy never loses the reply', async () => {
  // Delivery is never lost: the strategy is an optimization, and a bug in
  // it must degrade to the path that already worked.
  const { dispatcher, deliverCalls } = buildDispatcher({
    makeDeliverText: () => async () => { throw new Error('strategy exploded'); },
  });

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'important answer', files: null,
  });

  assert.equal(res.ok, true, 'the agent must not see a failure');
  assert.equal(deliverCalls.length, 1, 'the reply still landed via the plain path');
  assert.deepEqual(deliverCalls[0].chunks, ['important answer']);
});

// ─── The real strategy, through the real dispatcher ────────────────────────
//
// The tests above use a stub strategy to pin the seam, and rich-dispatch.test
// exercises the decision logic directly. Neither would catch the two halves
// being wired together wrongly, which is what actually ships.

const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { createRichSender } = require('../lib/telegram/rich-send');
const {
  isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
  stripMediaMarkdown,
} = require('../lib/telegram/rich');

// What a reply that is nothing but unrenderable media degrades to.
const MEDIA_ONLY_FALLBACK_TEXT = '(media unavailable)';

function buildWired(overrides = {}) {
  const { richEnabled = true, tgImpl = null } = overrides;
  const tgCalls = [];
  const rows = [];
  let latched = false;

  const send = async (_bot, method, params, meta) => {
    tgCalls.push({ method, params, meta });
    if (tgImpl) return tgImpl(method, params);
    return { message_id: 500 + tgCalls.length, date: 1 };
  };

  const sendRich = createRichSender({
    tg: send,
    botName: 'testbot',
    logEvent: () => {},
    redactBotToken: (s) => s,
    isRichCapabilityError,
    isRichCapabilityErrorExplicit,
    isRichContentError,
    getRichKnownUnsupported: () => latched,
    setRichKnownUnsupported: () => { latched = true; },
    insertSentRow: (row) => rows.push(row),
    logger: quietLogger,
  });

  const { deliverReplies, calls: deliverCalls } = makeDeliverCapture();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies,
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    // Mirrors polygram: hygiene is a property of the chat, wired
    // independently of the rich strategy so it survives that strategy
    // failing to build or failing to run.
    projectFallbackText: (text) => {
      if (!richEnabled) return text;
      const stripped = stripMediaMarkdown(text);
      return stripped.trim() ? stripped : MEDIA_ONLY_FALLBACK_TEXT;
    },
    makeDeliverText: overrides.makeDeliverTextOverride || createRichDeliveryFactory({
      bot: fakeBot,
      sendRich,
      isRichTextEnabled: () => richEnabled,
      getRichKnownUnsupported: () => latched,
      logger: quietLogger,
    }),
  });

  return { dispatcher, tgCalls, deliverCalls, rows, isLatched: () => latched };
}

const REAL_TABLE = '| item | state |\n| --- | --- |\n| one | done |';

test('end to end: a table reaches Telegram as one rich message', async () => {
  const { dispatcher, tgCalls, deliverCalls, rows } = buildWired();

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: REAL_TABLE, files: null, sourceMsgId: 9,
  });

  assert.equal(res.ok, true);
  assert.equal(deliverCalls.length, 0, 'no chunked plain delivery');

  const rich = tgCalls.find(c => c.method === 'sendRichMessage');
  assert.ok(rich, `expected a rich send, got: ${tgCalls.map(c => c.method).join(', ')}`);
  assert.ok(rich.params.rich_message.blocks.some(b => b.type === 'table'));
  assert.deepEqual(rich.params.reply_parameters, {
    message_id: 9,
    allow_sending_without_reply: true,
  });
  assert.equal(rich.params.chat_id, '12345');
  assert.equal(res.message_id, 501, 'the id the agent gets back is the rich bubble');

  assert.equal(rows.length, 1, 'one transcript row for one bubble');
  assert.equal(rows[0].text, REAL_TABLE, 'the row keeps the authored markdown');
});

test('end to end: prose still goes out plain and chunked', async () => {
  const { dispatcher, tgCalls, deliverCalls } = buildWired();

  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'A perfectly ordinary answer.', files: null,
  });

  assert.equal(deliverCalls.length, 1);
  assert.ok(!tgCalls.some(c => c.method === 'sendRichMessage'));
});

test('end to end: a blocks-unaware server still delivers the reply', async () => {
  // The whole point of the fallback ladder. shumorobot's Mac server is in
  // exactly this state until it is upgraded.
  const { dispatcher, deliverCalls, isLatched } = buildWired({
    tgImpl: (method) => {
      if (method === 'sendRichMessage') {
        throw Object.assign(new Error('Bad Request: unknown field rich_message'), { error_code: 400 });
      }
      return { message_id: 700, date: 1 };
    },
  });

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: REAL_TABLE, files: null,
  });

  assert.equal(res.ok, true, 'the agent must not see a failure');
  assert.equal(deliverCalls.length, 1, 'the table was delivered as plain text');
  assert.deepEqual(deliverCalls[0].chunks, [REAL_TABLE]);
  assert.equal(isLatched(), true, 'a named capability rejection disables rich for the process');
});

test('end to end: after latching, later replies skip the rich attempt entirely', async () => {
  const { dispatcher, tgCalls, isLatched } = buildWired({
    tgImpl: (method) => {
      if (method === 'sendRichMessage') {
        throw Object.assign(new Error('Bad Request: unknown field rich_message'), { error_code: 400 });
      }
      return { message_id: 700, date: 1 };
    },
  });

  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: REAL_TABLE, files: null,
  });
  assert.equal(isLatched(), true);

  const before = tgCalls.filter(c => c.method === 'sendRichMessage').length;
  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: REAL_TABLE, files: null,
  });
  const after = tgCalls.filter(c => c.method === 'sendRichMessage').length;

  assert.equal(after, before, 'a latched capability must not be retried on every reply');
});

test('end to end: a rich-enabled chat never renders a local path, on any branch', async () => {
  const withMedia = `## Results\n\n![the chart](/Users/me/secret/chart.png)\n\nDone.`;

  for (const [label, opts] of Object.entries({
    'rich succeeds': {},
    'rich rejected': {
      tgImpl: (method) => {
        if (method === 'sendRichMessage') throw new Error('Bad Request: RICH_MESSAGE_BAD_BLOCK');
        return { message_id: 700, date: 1 };
      },
    },
  })) {
    const { dispatcher, tgCalls, deliverCalls, isLatched } = buildWired(opts);
    await dispatcher({
      sessionKey: 'sess-A', chatId: '12345', threadId: null,
      toolName: 'reply', text: withMedia, files: null,
    });
    // Only the params cross the wire. `meta` is polygram-internal (api.js
    // reads richSourceText from it to derive the transcript row) and is
    // deliberately excluded here — the at-rest posture is asserted below.
    const onTheWire = JSON.stringify({
      params: tgCalls.map(c => c.params),
      chunks: deliverCalls.map(c => c.chunks),
    });
    assert.ok(!onTheWire.includes('/Users/me'), `${label}: absolute path reached Telegram`);
    assert.ok(onTheWire.includes('the chart'), `${label}: caption should survive`);
    assert.equal(isLatched(), false,
      `${label}: one bad payload must not disable rich for the whole process`);
  }
});

test('the transcript keeps the authored markdown, paths included', async () => {
  // Deliberate and accepted: the row is the searchable record of what the
  // agent actually wrote, it lives in the operator's own database, and the
  // background secret sweep covers it. Pinned so that if it ever changes it
  // is a decision rather than a drift.
  const withMedia = '## Results\n\n![the chart](/Users/me/secret/chart.png)\n\nDone.';
  const { dispatcher, rows } = buildWired();

  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: withMedia, files: null,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, withMedia);
});

test('end to end: a reply that is nothing but media degrades to a safe line', async () => {
  // An uncaptioned image strips to nothing, and this release renders no
  // media. Delivering nothing at all would leave the user with silence, so
  // the reply degrades to text that says so — no path, still a message.
  const { dispatcher, tgCalls, deliverCalls } = buildWired();

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '![](/Users/me/secret/chart.png)', files: null,
  });

  assert.equal(res.ok, true, 'something was delivered, so the reply succeeded');
  assert.deepEqual(deliverCalls[0].chunks, [MEDIA_ONLY_FALLBACK_TEXT]);
  assert.ok(!JSON.stringify(deliverCalls).includes('/Users/me'));
  assert.ok(!tgCalls.some(c => c.method === 'sendRichMessage'));
});

test('a media-only reply still uploads its attachments', async () => {
  // reply(text: "![](/x.png)", files: ["/x.png"]) is the natural shape for
  // "here is the file". Returning early on the emptied text skipped the
  // upload entirely and told the agent to use files:, which it just had.
  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'polygram-attach-'));
  const file = nodePath.join(dir, 'chart.png');
  fs.writeFileSync(file, 'x');

  try {
    const { dispatcher, tgCalls } = buildWired();
    const res = await dispatcher({
      sessionKey: 'sess-A', chatId: '12345', threadId: null,
      toolName: 'reply', text: `![](${file})`, files: [file],
      sessionCwd: dir,
    });

    assert.ok(tgCalls.some(c => c.method === 'sendPhoto'),
      `the attachment must still upload: ${tgCalls.map(c => c.method).join(', ')}`);
    assert.equal(res.ok, true, 'something was delivered, so the reply succeeded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a media-only reply whose attachment is rejected reports the rejection', async () => {
  // The text degrades to a safe line and the attachment is still attempted,
  // so what comes back names the real problem — never advice to "use files:"
  // aimed at an agent that just did.
  const { dispatcher, deliverCalls } = buildWired();

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '![](/etc/passwd)', files: ['/etc/passwd'],
    sessionCwd: '/tmp/nowhere-in-particular',
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /file\(s\) failed/i, res.error);
  assert.match(res.error, /outside allowed roots/i, res.error);
  assert.doesNotMatch(res.error, /use files:|via files:/i,
    'the agent already used files: — that advice is unactionable');
  assert.deepEqual(deliverCalls[0].chunks, [MEDIA_ONLY_FALLBACK_TEXT],
    'the text still degraded to something safe');
});

test('with no fallback projector, a media-only reply still uploads its files', async () => {
  // The projector is what keeps emptiedByStrategy unreachable in a rich chat.
  // A caller without one (or a chat where projection legitimately empties the
  // body) must still get its attachments — the early return used to skip them.
  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'polygram-attach-'));
  const file = nodePath.join(dir, 'chart.png');
  fs.writeFileSync(file, 'x');

  try {
    const { send, calls: tgCalls } = makeSendCapture();
    const { deliverReplies } = makeDeliverCapture();
    const dispatcher = createChannelsToolDispatcher({
      bot: fakeBot,
      send,
      chunkText: (text) => [text],
      deliverReplies,
      parseResponse: passthroughParse,
      sanitizeAssistantReply: passthroughSanitize,
      logger: quietLogger,
      // Empties the body and offers no substitute.
      projectFallbackText: () => '',
    });

    const res = await dispatcher({
      sessionKey: 'sess-A', chatId: '12345', threadId: null,
      toolName: 'reply', text: `![](${file})`, files: [file],
      sessionCwd: dir,
    });

    assert.ok(tgCalls.some(c => c.method === 'sendPhoto'),
      `the attachment must still upload: ${tgCalls.map(c => c.method).join(', ')}`);
    assert.equal(res.ok, true, 'the file landed, so the reply delivered something');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: a captioned image still delivers its caption', async () => {
  const { dispatcher, deliverCalls } = buildWired();

  const res = await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: '![the quarterly chart](/Users/me/secret/chart.png)', files: null,
  });

  assert.equal(res.ok, true);
  assert.deepEqual(deliverCalls[0].chunks, ['the quarterly chart']);
});

test('end to end: a rich-disabled chat is completely untouched', async () => {
  const withMedia = `## Results\n\n![the chart](/Users/me/secret/chart.png)`;
  const { dispatcher, tgCalls, deliverCalls } = buildWired({ richEnabled: false });

  await dispatcher({
    sessionKey: 'sess-A', chatId: '12345', threadId: null,
    toolName: 'reply', text: withMedia, files: null,
  });

  assert.ok(!tgCalls.some(c => c.method === 'sendRichMessage'));
  assert.deepEqual(deliverCalls[0].chunks, [withMedia],
    'opted-out chats keep todays behavior exactly, raw markdown included');
});

// ─── Cycle guard ───────────────────────────────────────────────────────────

test('loading the dispatcher never pulls in the rich modules', () => {
  // rich-media.js requires this module for validateAttachmentPath; requiring
  // rich back would close the loop and leave one side with a half-built
  // exports object depending on load order.
  //
  // Checked as a graph property rather than by scanning this file's source:
  // the regression that matters is someone extracting a helper that imports
  // rich, which a one-file source scan cannot see. Run in a CHILD PROCESS so
  // it starts from a clean module registry — mutating this process's
  // require.cache would make the result depend on what ran before it.
  const { execFileSync } = require('node:child_process');
  const probe = `
    const path = require('node:path');
    const p = require.resolve(${JSON.stringify(dispatcherPath)});
    require(p);
    const seen = new Set(); const hits = [];
    (function walk(mod) {
      for (const c of mod?.children || []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (/lib[\\/]telegram[\\/]rich[\\w-]*\\.js$/.test(c.id)) hits.push(c.id);
        walk(c);
      }
    }(require.cache[p]));
    process.stdout.write(JSON.stringify(hits));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [],
    'dispatcher must receive rich deps by injection, not require them');
});

test('the two modules load cleanly in either order', () => {
  // This is what a cycle actually breaks: whichever module loses the race
  // sees a half-built exports object. Both orders run in child processes so
  // neither can be satisfied by a module another test already loaded.
  const { execFileSync } = require('node:child_process');
  const richMediaPath = require.resolve('../lib/telegram/rich-media');

  for (const [first, second] of [
    [richMediaPath, dispatcherPath],
    [dispatcherPath, richMediaPath],
  ]) {
    const probe = `
      require(${JSON.stringify(first)});
      require(${JSON.stringify(second)});
      const d = require(${JSON.stringify(dispatcherPath)});
      process.stdout.write(JSON.stringify({
        validate: typeof d.validateAttachmentPath,
        create: typeof d.createChannelsToolDispatcher,
      }));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }));
    assert.deepEqual(out, { validate: 'function', create: 'function' },
      `exports incomplete when loaded as ${path.basename(first)} then ${path.basename(second)}`);
  }
});
