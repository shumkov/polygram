'use strict';

/**
 * A text-only reply is delivered whole, on every delivery path.
 *
 * Two failures this pins, both found by sweeping ordinary agent output
 * through the reply tool's real wiring:
 *   - text cut: the media projection dropped everything after any "![" that
 *     did not parse as an image ("Replaced vec![] with …" arrived as
 *     "Replaced vec"), and rewrote image syntax inside code spans and table
 *     cells to its alt text;
 *   - false refusal: prose whose "![…](" destination merely started like a
 *     path ("Toggle ![x] (/settings/page)") was refused as an image.
 *
 * The wiring mirrors polygram.js: dispatcher → compose([live preview, rich
 * strategy with the real media wiring]) → chunked path with the chat's
 * fallback projection. Five paths: a rich message, a consumed live preview,
 * a server latched off rich, a reply past the rich length cap, and a chat
 * with rich text off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { createRichSender } = require('../lib/telegram/rich-send');
const { makeReplyMediaWiring } = require('../lib/telegram/rich-media');
const { composeDeliverTextFactories } = require('../lib/telegram/deliver-strategy');
const { createStreamer } = require('../lib/telegram/streamer');
const { createStreamerRegistry, createDeliverTextFactory } = require('../lib/telegram/live-preview');
const {
  stripMediaMarkdown, isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
} = require('../lib/telegram/rich');

const quiet = { warn() {}, error() {}, log() {}, debug() {}, info() {} };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-never-cut-'));
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function build(mode) {
  const richEnabled = mode !== 'plainchat';
  const latched = mode === 'latched';
  const tgCalls = [];
  const chunks = [];
  const finalized = [];
  const send = async (_bot, method, params) => {
    tgCalls.push({ method, params });
    return { message_id: 700 + tgCalls.length, date: 1 };
  };
  const sendRich = createRichSender({
    tg: send, botName: 'probe', logEvent: () => {}, redactBotToken: (s) => s,
    isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
    getRichKnownUnsupported: () => latched, setRichKnownUnsupported: () => {},
    makeInputFile: (source) => ({ upload: source }), logger: quiet,
  });
  const richFactory = createRichDeliveryFactory({
    bot: {}, sendRich,
    isRichTextEnabled: () => richEnabled,
    getRichKnownUnsupported: () => latched,
    logger: quiet,
    ...(mode === 'long' ? { richMaxLen: 30 } : {}),
    makeMediaWiring: makeReplyMediaWiring({}),
  });
  const registry = createStreamerRegistry();
  let streamer = null;
  if (mode === 'stream') {
    streamer = createStreamer({
      send: async () => ({ message_id: 500 }),
      edit: async () => {},
      deleteMessage: async () => {},
      minChars: 5, throttleMs: 0, maxLen: 4096, logger: quiet,
    });
    const real = streamer.finalize.bind(streamer);
    streamer.finalize = async (t) => { finalized.push(t); return real(t); };
    registry.register('sess-cut', { streamer, chatId: '1', deliveredTexts: [], getTurnId: () => null });
  }
  const dispatcher = createChannelsToolDispatcher({
    bot: {}, send,
    chunkText: (t) => [t],
    deliverReplies: async ({ chunks: c }) => {
      chunks.push(...c);
      return { sent: c.map((_, i) => ({ message_id: 900 + i })), failed: [], results: [] };
    },
    parseResponse: (text) => ({ text, sticker: null, stickerLabel: null, stickers: [], reaction: null, reactions: [] }),
    sanitizeAssistantReply: (text) => ({ text, replaced: false }),
    logger: quiet,
    // polygram.js's projections, in shape.
    projectFallbackText: (text) => {
      if (!richEnabled) return text;
      const stripped = stripMediaMarkdown(text);
      return stripped.trim() ? stripped : '(media unavailable)';
    },
    makeDeliverText: composeDeliverTextFactories([
      createDeliverTextFactory({
        registry, logEvent: () => {}, persistBubbleText: () => {}, logger: quiet, botName: 'probe',
        projectConsumedText: (text) => (richEnabled ? stripMediaMarkdown(text) : text),
      }),
      richFactory,
    ]),
  });
  return { dispatcher, tgCalls, chunks, finalized, streamer };
}

// Every string a delivery put on the wire.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (['chat_id', 'message_thread_id', 'parse_mode', 'reply_parameters', 'type'].includes(k)) continue;
      strings(x, out);
    }
  }
  return out;
}

async function deliver(mode, text) {
  const h = build(mode);
  if (mode === 'stream') await h.streamer.onChunk('Working on the answer now');
  const res = await h.dispatcher({
    sessionKey: 'sess-cut', chatId: '1', threadId: null, toolName: 'reply',
    text, files: null, sessionCwd: cwd,
  });
  const wire = [...h.tgCalls.flatMap((c) => strings(c.params)), ...h.chunks, ...h.finalized].join('\n');
  return { res, wire };
}

// Words and emoji a reader must find. HTML tag names (`<summary>`) are
// markup, not content: a rich <details> block carries its summary as a
// field, never the tag.
const WORD_RE = /[\p{L}\p{N}]{2,}/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
function missing(text, wire) {
  const visible = text.replace(/<\/?[a-z][^>]*>/gi, ' ');
  const need = [...new Set([...(visible.match(WORD_RE) || []), ...(visible.match(EMOJI_RE) || [])])];
  return need.filter((w) => !wire.includes(w));
}

const E = ' ENDMARK';
const CASES = [
  ['prose vec![]', 'Replaced vec![] with Vec::new() in src/lib.rs' + E],
  ['prose JS ![1,2]', 'if (![1,2].includes(n)) in utils/x.js' + E],
  ['prose Wow![1] + path', 'Wow![1] neat, see /tmp/notes' + E],
  ['prose ![WIP] line start', '![WIP] still drafting the release notes' + E],
  ['prose ![ at line end', 'Typing ![\nnext line here' + E],
  ['prose wow![ in quotes', 'He said "wow![" and left' + E],
  ['code span image', 'Use `![alt](/abs/path.png)` to embed' + E],
  ['code span spaced image', 'Write `![alt](/path with spaces.png)` inline' + E],
  ['code span + trailing text', 'Syntax: `![a](/x.png)` then more text after it' + E],
  ['code span vec![]', 'Use `vec![]` for empty vectors' + E],
  ['fence ``` with images', 'Example:\n\n```md\n![fenced](/w/j k.png)\n![b](/w/b.png)\n```\nAfter fence' + E],
  ['fence ~~~ with image', '~~~\n![x](/a.png)\n~~~\nAfter tilde fence' + E],
  ['rust macros', 'let v = vec![1, 2, 3]; assert!(v.len() == 3); println!("{}", v[0]);' + E],
  ['rust matches![]', 'Call matches![x, Some(_)] in src/a.rs then return' + E],
  ['rust vec![](..)', 'Write vec![](see ./docs) never like that' + E],
  ['JS ![a,b].some', 'return ![a, b].some(Boolean) && ok(/x/)' + E],
  ['JS ![].length ./lib', 'const empty = ![].length; // see ./lib/a.js for why' + E],
  ['markdown links', 'See [the docs](https://example.com/a) and [file](/path/y.md) today' + E],
  ['link after "! "', 'Done! [PR 162](https://github.com/x/y/pull/162) merged' + E],
  ['cyrillic Готово![1]', 'Готово![1] Смотри /tmp/заметки сегодня' + E],
  ['cyrillic Внимание![важно]', 'Внимание![важно] файл лежит в ~/docs/a.md' + E],
  ['cyrillic ![см. (PR)]', 'Сделано![см. (PR 162)] всё работает' + E],
  ['footnotes [^1]', 'Claim[^1] and another![^2] here\n\n[^1]: Source text\n[^2]: Other text' + E],
  ['emoji ![🎉]', 'Party 🎉![🎉] launch 🚀 today' + E],
  ['emoji ![✅](not a path)', 'Готово ✅![✅](not a path) всё' + E],
  ['table w/ code + macro', '| expr | meaning |\n|---|---|\n| `![a](/b.png)` | image syntax |\n| vec![] | macro call |\n\nAfter table' + E],
  ['URL in parens', 'See the PR (https://github.com/shumkov/polygram/pull/162) for details' + E],
  ['URL in parens after ![', 'Note![1] (https://example.com/a) explains it' + E],
  ['![x] (/path) gap prose', 'Toggle ![x] (/settings/page) to enable' + E],
  ['bold Wow![1]', '**Wow![1]** and _done_ with it' + E],
  ['details w/ vec![]', '<details><summary>Log</summary>\n\nvec![] in src/x.rs line\n\n</details>\n\nAfter details' + E],
  ['escaped \\![', 'Literal \\![not image] stays text' + E],
  ['shell ![ -f ]', 'Run if ![ -f /etc/hosts ]; then echo missing; fi' + E],
  // Prose whose "![…](" destination starts like a path but names no media.
  ['cyrillic ![1] (/tmp/report.md)', 'Готово![1] (/tmp/report.md) лежит там' + E],
  ['See![note](./docs/read me.md)', 'See![note](./docs/read me.md) first' + E],
];

for (const mode of ['rich', 'stream', 'latched', 'long', 'plainchat']) {
  test(`every text-only reply arrives whole and ok — ${mode}`, async () => {
    const failures = [];
    for (const [name, text] of CASES) {
      const { res, wire } = await deliver(mode, text);
      const cut = missing(text, wire);
      if (!res.ok || cut.length) failures.push(`${name}: ok=${res.ok} cut=${JSON.stringify(cut)} ${res.error || ''}`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });
}

test('code spans and table cells reach the reader verbatim, image syntax included', async () => {
  for (const mode of ['rich', 'stream', 'latched', 'plainchat']) {
    const { wire } = await deliver(mode, 'Use `![alt](/abs/path.png)` to embed. ENDMARK');
    assert.ok(wire.includes('![alt](/abs/path.png)'), `${mode}: ${wire}`);
  }
});
