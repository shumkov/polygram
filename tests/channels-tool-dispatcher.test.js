'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createChannelsToolDispatcher,
  validateAttachmentPath,
  buildAllowedRoots,
  DEFAULT_ATTACHMENT_BASE,
} = require('../lib/process/channels-tool-dispatcher');

const fakeBot = {};
const fakeChunk = (text, _max) => [text];      // pass-through chunker
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

// Review F#1: dispatcher now routes through processAndDeliverAgentText.
// parseResponse + sanitizeAssistantReply are required deps. Use no-op
// identity stubs in tests that aren't asserting pipeline behavior.
const fakeParse = (text) => ({
  text, sticker: null, stickerLabel: null, stickers: [], reaction: null, reactions: [],
});
const fakeSanitize = (text) => ({ text, replaced: false });

function makeRecordingSend() {
  const sent = [];
  const send = async (_bot, method, params, _meta) => {
    sent.push({ method, params });
    return { ok: true, result: { message_id: sent.length } };
  };
  return { send, sent };
}

test('construction validates required deps', () => {
  assert.throws(() => createChannelsToolDispatcher({}), /bot/);
  assert.throws(() => createChannelsToolDispatcher({ bot: fakeBot }), /send/);
  assert.throws(
    () => createChannelsToolDispatcher({ bot: fakeBot, send: () => {} }),
    /chunkText/,
  );
  // M3: deliverReplies is required (was optional with lazy require)
  assert.throws(
    () => createChannelsToolDispatcher({ bot: fakeBot, send: () => {}, chunkText: fakeChunk }),
    /deliverReplies required/,
  );
});

test('dispatches reply text via deliverReplies', async () => {
  const { send, sent } = makeRecordingSend();
  // Fake deliverReplies inline so we don't pull in the real chunking/delivery code.
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: fakeChunk,
    deliverReplies: async ({ chunks, chatId, threadId }) => {
      return { sent: chunks.map((_, i) => ({ message_id: i + 1 })), failed: [], results: [] };
    },
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'hello world', files: null,
  });

  assert.equal(result.ok, true);
});

test('returns error when toolName is not reply', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'react', text: 'hello', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported tool/);
});

test('returns error on missing text', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: '', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /text missing/);
});

test('returns error on missing chat_id', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: null, threadId: null,
    toolName: 'reply', text: 'hi', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /chat_id missing/);
});

test('partial delivery surfaces failure count', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: (text) => [text.slice(0, 5), text.slice(5)],
    deliverReplies: async ({ chunks }) => ({
      sent: [{ message_id: 1 }],
      failed: [{ chunk: chunks[1], error: new Error('429 rate limit') }],
      results: [],
    }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'helloworld', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1 of 2 chunks/);
  assert.match(result.error, /429 rate limit/);
});

test('sends file attachments via sendPhoto for images', async () => {
  const { send, sent } = makeRecordingSend();
  // P0 #2: real files must exist + be inside an allowed root. Create both in
  // a per-test sessionCwd dir so the allowlist permits them.
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-routing-'));
  const pngPath = path.join(cwdRoot, 'foo.png');
  const txtPath = path.join(cwdRoot, 'bar.txt');
  fs.writeFileSync(pngPath, 'fake png');
  fs.writeFileSync(txtPath, 'plain text');
  try {
    const dispatcher = createChannelsToolDispatcher({
      bot: fakeBot, send, chunkText: fakeChunk,
      deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
      parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
    });
    await dispatcher({
      sessionKey: 'sess-1', chatId: '12345', threadId: null,
      sessionCwd: cwdRoot,
      toolName: 'reply', text: 'see attached', files: [pngPath, txtPath],
    });
    // 2 file attachments
    const attachCalls = sent.filter(c => c.method === 'sendPhoto' || c.method === 'sendDocument');
    assert.equal(attachCalls.length, 2);
    assert.equal(attachCalls[0].method, 'sendPhoto', '.png → sendPhoto');
    assert.equal(attachCalls[1].method, 'sendDocument', '.txt → sendDocument');
  } finally {
    try { fs.rmSync(cwdRoot, { recursive: true, force: true }); } catch {}
  }
});

// ─── 0.13 edit_message + reply returns message_id (progressive status) ──

test('reply returns the message_id of the delivered bubble (numeric sent[], real deliver.js shape)', async () => {
  const { send } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    // real deliver.js pushes numeric message_ids, NOT objects
    deliverReplies: async () => ({ sent: [4242], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'Looking into it…', files: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.message_id, 4242, 'claude needs this id to later edit_message it');
});

test('reply message_id also tolerates {message_id} object shape', async () => {
  const { send } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [{ message_id: 99 }], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'hi', files: null,
  });
  assert.equal(result.message_id, 99);
});

test('edit_message edits the target bubble via editMessageText', async () => {
  const { send, sent } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: '7',
    toolName: 'edit_message', messageId: 500, text: 'Found it — fixing now…',
  });
  assert.equal(result.ok, true);
  assert.equal(result.message_id, 500);
  const edits = sent.filter(c => c.method === 'editMessageText');
  assert.equal(edits.length, 1, 'one editMessageText call');
  assert.equal(edits[0].params.chat_id, '12345');
  assert.equal(edits[0].params.message_id, 500);
  assert.equal(edits[0].params.text, 'Found it — fixing now…');
  assert.equal(edits[0].params.message_thread_id, '7', 'thread carried for forum topics');
});

test('edit_message rejects missing message_id / chat_id / text', async () => {
  const { send } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const base = { sessionKey: 's', chatId: '1', threadId: null, toolName: 'edit_message' };
  assert.match((await dispatcher({ ...base, messageId: null, text: 'x' })).error, /message_id missing/);
  assert.match((await dispatcher({ ...base, chatId: null, messageId: 5, text: 'x' })).error, /chat_id missing/);
  assert.match((await dispatcher({ ...base, messageId: 5, text: '' })).error, /text missing/);
});

test('edit_message rejects text too long to fit one bubble', async () => {
  const { send } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk, maxChunkLen: 50,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null,
    toolName: 'edit_message', messageId: 5, text: 'z'.repeat(120),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test('edit_message applies the same agent-text hygiene as reply (strips inline markers)', async () => {
  const { send, sent } = makeRecordingSend();
  // parseResponse strips a trailing [react:🔥] marker, returning clean text
  const stripParse = (text) => ({ text: text.replace(/\s*\[react:[^\]]+\]\s*$/, ''), sticker: null, stickers: [], reaction: '🔥', reactions: [] });
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: stripParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null,
    toolName: 'edit_message', messageId: 5, text: 'Done [react:🔥]',
  });
  const edit = sent.find(c => c.method === 'editMessageText');
  assert.equal(edit.params.text, 'Done', 'inline marker stripped before edit, not leaked as literal text');
});

test('react is still unsupported (only reply + edit_message route here)', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send: async () => ({}), chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'react', text: '🔥',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported tool/);
});

// ─── P0 #2: file-attachment allowlist (path traversal / exfiltration) ──

test('validateAttachmentPath rejects non-absolute path', () => {
  const r = validateAttachmentPath('relative/path.png', ['/tmp']);
  assert.equal(r.ok, false);
  assert.match(r.error, /absolute/);
});

test('validateAttachmentPath rejects path outside allowed roots', () => {
  // /etc/passwd is always outside an allowlist of /tmp/foo
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-test-'));
  try {
    const r = validateAttachmentPath('/etc/passwd', [tmpRoot]);
    assert.equal(r.ok, false);
    assert.match(r.error, /outside allowed roots|realpath failed/);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('validateAttachmentPath accepts file inside allowed root', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-test-'));
  try {
    const filePath = path.join(tmpRoot, 'image.png');
    fs.writeFileSync(filePath, 'fake png bytes');
    const r = validateAttachmentPath(filePath, [tmpRoot]);
    assert.equal(r.ok, true);
    assert.equal(r.resolved, fs.realpathSync(filePath));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('validateAttachmentPath rejects symlink pointing outside allowed root', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-test-'));
  try {
    // Create a symlink inside the allowed root that points to /etc/passwd
    const linkPath = path.join(tmpRoot, 'passwd-link');
    try { fs.symlinkSync('/etc/passwd', linkPath); }
    catch (err) {
      // /etc/passwd may not exist or symlink may be denied — skip this assertion
      // gracefully so the test isn't OS-specific brittle
      return;
    }
    const r = validateAttachmentPath(linkPath, [tmpRoot]);
    assert.equal(r.ok, false, 'symlink-traversal to /etc/passwd must be rejected');
    assert.match(r.error, /outside allowed roots/);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('validateAttachmentPath rejects directory (only regular files allowed)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-test-'));
  try {
    const r = validateAttachmentPath(tmpRoot, [tmpRoot]);
    assert.equal(r.ok, false);
    assert.match(r.error, /not a regular file/);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('buildAllowedRoots includes per-session staging + sessionCwd + extras', () => {
  const roots = buildAllowedRoots({
    sessionKey: 'sess-1',
    sessionCwd: '/home/agent/workspace',
    extraRoots: ['/opt/data', 'not/absolute/dropped'],
  });
  assert.ok(roots.includes(DEFAULT_ATTACHMENT_BASE));
  assert.ok(roots.some(r => r.endsWith('polygram-attachments/sess-1')));
  assert.ok(roots.includes('/home/agent/workspace'));
  assert.ok(roots.includes('/opt/data'));
  assert.ok(!roots.includes('not/absolute/dropped'), 'non-absolute extras dropped');
});

test('dispatcher REJECTS Claude reply with files=/etc/passwd (exfiltration defense)', async () => {
  const { send, sent } = makeRecordingSend();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-test-'));
  try {
    const dispatcher = createChannelsToolDispatcher({
      bot: fakeBot, send, chunkText: fakeChunk,
      deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
      parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
      attachmentAllowlist: [tmpRoot],   // ONLY this dir allowed
    });
    const result = await dispatcher({
      sessionKey: 'sess-evil', chatId: '12345', threadId: null,
      toolName: 'reply', text: 'see attached', files: ['/etc/passwd'],
    });
    // Text delivery succeeded but file delivery failed → ok:false with reason
    assert.equal(result.ok, false);
    assert.match(result.error, /1 of 1 file/);
    assert.match(result.error, /etc.passwd/);
    // No sendPhoto/sendDocument call ever attempted for the exfil path
    const attachCalls = sent.filter(c => c.method === 'sendPhoto' || c.method === 'sendDocument');
    assert.equal(attachCalls.length, 0, 'no upload attempted for rejected path');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('dispatcher ACCEPTS files under sessionCwd', async () => {
  const { send, sent } = makeRecordingSend();
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-cwd-'));
  try {
    const okFile = path.join(cwdRoot, 'output.png');
    fs.writeFileSync(okFile, 'fake png');
    const dispatcher = createChannelsToolDispatcher({
      bot: fakeBot, send, chunkText: fakeChunk,
      deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
      parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
    });
    const result = await dispatcher({
      sessionKey: 'sess-ok', chatId: '12345', threadId: null,
      sessionCwd: cwdRoot,
      toolName: 'reply', text: 'see attached', files: [okFile],
    });
    assert.equal(result.ok, true);
    const attachCalls = sent.filter(c => c.method === 'sendPhoto' || c.method === 'sendDocument');
    assert.equal(attachCalls.length, 1);
    assert.equal(attachCalls[0].method, 'sendPhoto');
  } finally {
    try { fs.rmSync(cwdRoot, { recursive: true, force: true }); } catch {}
  }
});

// Updated post-R9: file attach failures NOW surface via ok:false so Claude
// can react to undelivered attachments. The old "does not poison" contract is
// gone; partial-text-success + failed-attach now returns ok:false with details.
test('file attach upload failure surfaces as ok:false with details (R9)', async () => {
  let attachAttempts = 0;
  const send = async (_b, method) => {
    if (method === 'sendPhoto') {
      attachAttempts++;
      throw new Error('TG photo upload failed');
    }
    return {};
  };
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-attach-fail-'));
  try {
    const okFile = path.join(cwdRoot, 'output.png');
    fs.writeFileSync(okFile, 'fake png');
    const dispatcher = createChannelsToolDispatcher({
      bot: fakeBot, send, chunkText: fakeChunk,
      deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
      parseResponse: fakeParse, sanitizeAssistantReply: fakeSanitize, logger: quietLogger,
    });
    const result = await dispatcher({
      sessionKey: 'sess-1', chatId: '12345', threadId: null,
      sessionCwd: cwdRoot,
      toolName: 'reply', text: 'see attached', files: [okFile],
    });
    assert.equal(attachAttempts, 1);
    assert.equal(result.ok, false, 'attach failure surfaces ok:false');
    assert.match(result.error, /1 of 1 file/);
    assert.match(result.error, /TG photo upload failed/);
  } finally {
    try { fs.rmSync(cwdRoot, { recursive: true, force: true }); } catch {}
  }
});
