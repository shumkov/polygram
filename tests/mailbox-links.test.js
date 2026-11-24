'use strict';
// Jump links on mailbox cards: a reader in one topic can open the other side
// of an exchange. A link to the wrong place is worse than none, so every link
// here is either proven by Telegram's receipt, by polygram's own records, or
// left out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createMailboxService } = require('../lib/mailbox/service');
const { createRichSender } = require('../lib/telegram/rich-send');
const envelope = require('../lib/mailbox/envelope');
const rules = require('../lib/mailbox/rules');

const PROD = '-1004292131077';
const MARKET = '-1004462674958';
const routes = {
  orchestrator: { chatId: PROD, threadId: '732' },
  marketing: { chatId: PROD, threadId: '142' },
  cmo: { chatId: MARKET, general: true },
  ads: { chatId: MARKET, threadId: '406' },
};
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId ?? null,
  sessionKey: route.threadId ? `${route.chatId}:${route.threadId}` : route.chatId });
const session = (role) => resolveTarget(routes[role]).sessionKey;
const topic = (role) => (routes[role].threadId ? `https://t.me/c/${routes[role].chatId.slice(4)}/${routes[role].threadId}` : null);
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(setImmediate); };
const NOTION_ID = '2b1f4e6a-0c3d-4f5e-8a9b-1c2d3e4f5a6b';
const NOTION_URL = 'https://www.notion.so/2b1f4e6a0c3d4f5e8a9b1c2d3e4f5a6b';

// Real external jobs and mailbox over one SQLite file; Telegram is a stub
// whose receipt echoes the destination, as the Bot API does.
function fixture(t, { mailbox = {}, fail = () => false, receipt = (r) => r, forum = {}, turn, forumProbeMs, liveBot, failGet = false } = {}) {
  const { db, dbPath } = freshDb('mailbox-links');
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes) }, mailbox: {
    enabled: true, roles: { orchestrator: {}, marketing: {}, cmo: {}, ads: {} },
    allow: { orchestrator: ['*'], marketing: ['*'] }, mirror: 'both', systemSenders: ['agent-org', 'crm'], ...mailbox,
  } } };
  const f = { db, posts: [], logs: [], getChats: [] };
  const tg = async (_bot, method, params) => {
    f.posts.push({ method, params });
    if (fail(params, f.posts.length)) throw Object.assign(new Error('Bad Request'), { error_code: 400, description: 'Bad Request: refused' });
    return receipt({ message_id: 1000 + f.posts.length, chat: { id: Number(params.chat_id) },
      ...(params.message_thread_id == null ? {} : { message_thread_id: Number(params.message_thread_id) }) }, params);
  };
  const sendRich = createRichSender({ tg, botName: 'test', insertSentRow: (row) => db.insertMessage(row) });
  const runtime = { dispatch: async (job, hooks) => { hooks.onSend?.(); return (turn || (async () => ({ outcome: 'succeeded', text: '', inactive: true })))(job); } };
  f.jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (o, run) => run(), runtime, getMailbox: () => f.mailbox, logger: { warn() {} } }),
    checkInactive: async () => false, deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  const getChat = async (chatId) => {
    f.getChats.push(chatId);
    if (forum[chatId] instanceof Error) throw forum[chatId];
    if (forum[chatId] === 'never') return new Promise(() => {});
    return { id: Number(chatId), is_forum: forum[chatId] === true };
  };
  f.mailbox = createMailboxService({ config, db: failGet ? failingReads(db, f) : db, botName: 'test', jobs: f.jobs, resolveTarget, tg, sendRich,
    ...(liveBot ? { bot: liveBot } : { bot: {}, getChat }), ...(forumProbeMs ? { forumProbeMs } : {}),
    logger: { error: (m) => f.logs.push(m), warn: (m) => f.logs.push(m) } });
  f.jobs.start(); f.mailbox.start();
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.token = (role) => { f.mailbox.noteHumanPrompt(session(role)); return f.mailbox.scope(session(role)); };
  f.row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  f.cards = () => f.posts.filter((p) => p.method === 'sendRichMessage').map((p, i) => ({
    chatId: p.params.chat_id, threadId: p.params.message_thread_id ?? null, ...card(p.params.rich_message.blocks) }));
  return f;
}

// The database as the service sees it, with the read of message f.failGet
// failing, so a broken lookup can be shown to cost only its own link.
function failingReads(db, f) {
  const raw = new Proxy(db.raw, { get(target, prop) {
    if (prop !== 'prepare') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
    return (sql) => {
      const statement = target.prepare(sql);
      if (!sql.startsWith('SELECT * FROM mailbox_messages WHERE id=?')) return statement;
      return { get: (id, ...rest) => {
        if (id === f.failGet) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
        return statement.get(id, ...rest);
      } };
    };
  } });
  return { ...db, raw };
}

// The header's link nodes and the card's shape.
function card(blocks) {
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'blockquote');
  const [header, details] = blocks[0].blocks;
  assert.equal(blocks[0].blocks.length, 2, 'uniform style: the header paragraph, then the closed details');
  assert.equal(header.type, 'paragraph');
  assert.equal(details.type, 'details');
  assert.equal(details.is_open, false);
  const links = header.text.filter((part) => typeof part === 'object' && part.type === 'url').map((part) => [part.text, part.url]);
  const text = header.text.map((part) => (typeof part === 'string' ? part : part.text)).join('');
  return { links, text };
}
const htmlLinks = (html) => [...html.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]);
const richLinks = (blocks) => card(blocks).links;
const sentLink = (f, postIndex) => {
  const p = f.posts.filter((x) => x.method === 'sendRichMessage')[postIndex];
  const thread = p.params.message_thread_id;
  const id = 1000 + f.posts.indexOf(p) + 1;
  return `https://t.me/c/${p.params.chat_id.slice(4)}/${thread == null ? '' : `${thread}/`}${id}`;
};

test('the target card is posted first, and the sender card links to it', async (t) => {
  const f = fixture(t);
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'What is the Q3 budget?' });
  await settle();
  const [target, sender] = f.cards();
  assert.equal(target.threadId, '142', 'the target topic gets its card first');
  assert.equal(sender.threadId, '732');
  const names = [['orchestrator', topic('orchestrator')], ['marketing', topic('marketing')]];
  assert.deepEqual(target.links, names, 'names open their topics; the twin does not exist yet');
  assert.deepEqual(sender.links, [...names, ['↗ open', sentLink(f, 0)]]);
  assert.equal(f.row(sent.id).target_card, sentLink(f, 0), 'the target card is remembered for the answer');
});

test('an answer links to the question card, and the answerer\'s own copy links to the answer', async (t) => {
  const f = fixture(t);
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  const question = f.row(ask.id).target_card;
  const reply = f.mailbox.reply(f.token('marketing'), { inReplyTo: ask.id, body: '12k' });
  await settle();
  const [, , answer, answererCopy] = f.cards();
  assert.equal(answer.threadId, '732', 'the answer lands with the asker');
  assert.deepEqual(answer.links.at(-1), ['↗ question', question]);
  assert.equal(answererCopy.threadId, '142');
  assert.deepEqual(answererCopy.links.at(-1), ['↗ open', f.row(reply.id).target_card]);
});

test('a card that did not land where it was sent is never linked', async (t) => {
  // The first card's receipt says it landed in General instead of its topic.
  const f = fixture(t, { receipt: (r, params) => (params.message_thread_id === '142' && r.message_id === 1001 ? { ...r, message_thread_id: undefined } : r) });
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  assert.equal(f.row(ask.id).target_card, null);
  assert.deepEqual(f.cards()[1].links.map(([label]) => label), ['orchestrator', 'marketing'], 'no twin link');
  f.mailbox.reply(f.token('marketing'), { inReplyTo: ask.id, body: '12k' });
  await settle();
  assert.ok(!f.cards()[2].links.some(([label]) => label === '↗ question'), 'no question link to an unproven card');
  assert.match(f.logs.join('\n'), /landed outside/);
});

test('a failed target post still posts the sender card, without the twin link', async (t) => {
  const f = fixture(t, { fail: (params) => params.message_thread_id === '142' });
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  const cards = f.cards().filter((c) => c.threadId === '732');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].links.map(([label]) => label), ['orchestrator', 'marketing']);
  assert.equal(f.row(ask.id).target_card, null);
});

test('a failed write of the target card still gives the sender card its link', async (t) => {
  const f = fixture(t);
  f.db.raw.exec("CREATE TRIGGER no_card BEFORE UPDATE OF target_card ON mailbox_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  assert.deepEqual(f.cards()[1].links.at(-1), ['↗ open', sentLink(f, 0)]);
  assert.equal(f.row(ask.id).target_card, null);
  assert.match(f.logs.join('\n'), /target card .* not recorded/);
});

test('a General name links to /1 only once Telegram says the chat is a forum, asked once per chat', async (t) => {
  const f = fixture(t, { forum: { [MARKET]: true } });
  f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'one' });
  f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'two' });
  await settle();
  const targets = f.cards().filter((c) => c.chatId === MARKET);
  assert.equal(targets.length, 2);
  for (const target of targets) assert.deepEqual(target.links[1], ['cmo', 'https://t.me/c/4462674958/1']);
  assert.deepEqual(f.getChats, [MARKET], 'the answer is cached');
});

test('a General name stays plain when the chat is not a forum or Telegram cannot say', async (t) => {
  for (const status of [false, new Error('timeout')]) {
    const f = fixture(t, { forum: { [MARKET]: status } });
    f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'one' });
    await settle();
    f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'two' });
    await settle();
    const targets = f.cards().filter((c) => c.chatId === MARKET);
    assert.equal(targets.length, 2, String(status));
    assert.equal(f.cards().length, 4, `${status}: every card is still posted, sender copies included`);
    for (const target of targets) {
      assert.deepEqual(target.links, [['orchestrator', topic('orchestrator')]], String(status));
      assert.match(target.text, /orchestrator → cmo/);
    }
    assert.equal(f.getChats.length, 1, `${status}: the answer, a failure too, is remembered, so later cards do not ask again`);
  }
});

test('a system tell links its Notion task only for a sender listed in notionRefs', async (t) => {
  const f = fixture(t, { mailbox: { notionRefs: ['agent-org'] } });
  f.mailbox.submit({ sender: 'agent-org', to: 'marketing', body: 'Task', key: 'k1', ref: NOTION_ID });
  f.mailbox.submit({ sender: 'agent-org', to: 'marketing', body: 'Task', key: 'k2', ref: NOTION_ID.replace(/-/g, '').toUpperCase() });
  f.mailbox.submit({ sender: 'crm', to: 'marketing', body: 'Lead', key: 'k3', ref: NOTION_ID });
  f.mailbox.submit({ sender: 'agent-org', to: 'marketing', body: 'Task', key: 'k4', ref: 'notion:42' });
  await settle();
  const [first, second, crm, other] = f.cards();
  assert.deepEqual(first.links, [['marketing', topic('marketing')], ['↗ Notion', NOTION_URL]], 'the system sender has no topic, so its name stays plain');
  assert.deepEqual(second.links.at(-1), ['↗ Notion', NOTION_URL]);
  assert.deepEqual(crm.links, [['marketing', topic('marketing')]], 'a sender whose ref may not be Notion gets no Notion link');
  assert.deepEqual(other.links, [['marketing', topic('marketing')]]);
  assert.equal(f.cards().length, 4, 'a system sender gets no sender card');
});

test('notionRefs must name configured system senders', () => {
  const bot = (mailbox) => ({ externalJobs: { enabled: true, routes: {} }, mailbox: { enabled: true, systemSenders: ['agent-org'], ...mailbox } });
  assert.deepEqual([...rules.readMailboxConfig(bot({ notionRefs: ['agent-org'] }), resolveTarget).notionRefs], ['agent-org']);
  assert.deepEqual([...rules.readMailboxConfig(bot({}), resolveTarget).notionRefs], [], 'none by default');
  assert.throws(() => rules.readMailboxConfig(bot({ notionRefs: ['crm'] }), resolveTarget), /notionRefs/);
  assert.throws(() => rules.readMailboxConfig(bot({ notionRefs: 'agent-org' }), resolveTarget), /notionRefs/);
});

test('a Notion page id normalises to its notion.so link; anything else has none', () => {
  assert.equal(rules.notionPageLink(NOTION_ID), NOTION_URL);
  assert.equal(rules.notionPageLink(NOTION_ID.replace(/-/g, '').toUpperCase()), NOTION_URL);
  for (const ref of ['notion:42', `https://www.notion.so/Task-${NOTION_ID.replace(/-/g, '')}`, `${NOTION_ID}x`, '12345', '', null, undefined]) {
    assert.equal(rules.notionPageLink(ref), null, String(ref));
  }
});

// A card agent-org posted through IPC send, as polygram records it.
const sentByAgentOrg = (f, over = {}) => f.db.insertMessage({ chat_id: PROD, thread_id: '142', msg_id: 555, direction: 'out', status: 'sent',
  source: 'agent-org', bot_name: 'test', text: '👀 Ready for review', ts: 1, ...over });

test('a submitted link is kept only when polygram sent that message for the sender', async (t) => {
  const f = fixture(t, { mailbox: { notionRefs: ['agent-org'] } });
  sentByAgentOrg(f);
  const link = 'https://t.me/c/4292131077/142/555';
  const kept = f.mailbox.submit({ sender: 'agent-org', to: 'orchestrator', body: 'Done', key: 'final:1', ref: NOTION_ID, link });
  await settle();
  assert.equal(f.row(kept.id).link, link);
  assert.deepEqual(f.cards()[0].links.slice(1), [['↗ Notion', NOTION_URL], ['↗ open', link]], 'Notion first, then the jump');
  const job = f.db.raw.prepare('SELECT task, payload FROM external_jobs WHERE request_id=?').get(`mailbox:${kept.id}`);
  assert.ok(!`${job.task}${job.payload}`.includes('t.me'), 'the link is display data and never reaches the role');
  f.mailbox.submit({ sender: 'agent-org', to: 'orchestrator', body: 'No link', key: 'final:2' });
  assert.equal(f.logs.filter((line) => /mailbox-link-dropped/.test(line)).length, 0, 'a message without a link drops nothing');
});

test('a link the sender did not post through this bot is dropped, and the message still goes through', async (t) => {
  const f = fixture(t);
  sentByAgentOrg(f);
  sentByAgentOrg(f, { msg_id: 777, source: 'ipc' });
  sentByAgentOrg(f, { msg_id: 888, thread_id: '999' });
  const dropped = [
    'https://t.me/c/4292131077/142/777', // sent, but by another client
    'https://t.me/c/4292131077/732/555', // a real message id in another topic
    'https://t.me/c/4292131077/142/556', // never sent
    'https://t.me/c/4292131077/142', // a topic's shape, not a sent card
    'https://t.me/c/4462674958/142/555', // another chat
    'https://t.me/c/4292131077/999/888', // sent by agent-org, but not into a role's topic
    'https://evil.example/c/4292131077/142/555',
    'javascript:alert(1)',
    42,
  ];
  for (const [i, link] of dropped.entries()) {
    const result = f.mailbox.submit({ sender: 'agent-org', to: 'orchestrator', body: `Done ${i}`, key: `final:${i}`, link });
    assert.equal(result.state, 'queued', String(link));
    assert.equal(f.row(result.id).link, null, String(link));
  }
  await settle();
  assert.equal(f.cards().length, dropped.length, 'every message still gets its card');
  for (const c of f.cards()) assert.ok(!c.links.some(([label]) => label === '↗ open'));
  assert.equal(f.logs.filter((line) => /mailbox-link-dropped/.test(line)).length, dropped.length);
});

test('a retry under the same key keeps the first link and returns the first receipt', async (t) => {
  const f = fixture(t);
  sentByAgentOrg(f);
  sentByAgentOrg(f, { msg_id: 556 });
  const first = f.mailbox.submit({ sender: 'agent-org', to: 'orchestrator', body: 'Done', key: 'final:1', link: 'https://t.me/c/4292131077/142/555' });
  const retry = f.mailbox.submit({ sender: 'agent-org', to: 'orchestrator', body: 'Done', key: 'final:1', link: 'https://t.me/c/4292131077/142/556' });
  assert.equal(retry.id, first.id);
  assert.equal(retry.duplicate, true);
  assert.equal(f.row(first.id).link, 'https://t.me/c/4292131077/142/555');
});

test('a notice card in the asker\'s topic links to the question card, once', async (t) => {
  for (const mirror of ['target', 'both']) {
    const f = fixture(t, { mailbox: { mirror } });
    const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
    await settle();
    const question = f.row(ask.id).target_card;
    await f.jobs.tick(); await f.mailbox.tick(); await settle();
    await f.jobs.tick(); await f.mailbox.tick(); await settle();
    const notices = f.cards().filter((c) => c.text.startsWith('⚠️'));
    assert.equal(notices.length, 1, mirror);
    assert.equal(notices[0].threadId, '732', 'the asker hears it');
    assert.match(notices[0].text, /^⚠️ No answer · orchestrator → marketing/);
    assert.deepEqual(notices[0].links, [['orchestrator', topic('orchestrator')], ['marketing', topic('marketing')], ['↗ question', question]]);
  }
});

test('mirror false posts no notice card', async (t) => {
  const f = fixture(t, { mailbox: { mirror: false } });
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  await f.jobs.tick(); await f.mailbox.tick(); await f.mailbox.tick(); await settle();
  assert.equal(f.posts.length, 0);
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM external_jobs WHERE request_id GLOB 'mailbox-notice:*'").get().n, 1, 'the notice itself still goes out');
});

test('an open bot links only into the card\'s own chat', async (t) => {
  const HOME = '-1003807211164';
  const OTHER = '-1009000000001';
  const config = { bot: { externalJobs: { enabled: true, routes: {} }, mailbox: { enabled: true, mirror: 'both' } },
    chats: { [HOME]: { name: 'Home', isolateTopics: true, topics: { 3: { name: 'Music' }, 4: { name: 'Admin' } } },
      [OTHER]: { name: 'Partner', isolateTopics: true, topics: { 7: { name: 'Ads' } } }, 68861949: { name: 'Ivan DM' } } };
  const { db, dbPath } = freshDb('mailbox-links-open');
  const posts = []; const logs = [];
  const tg = async (_bot, method, params) => { posts.push(params); return { message_id: posts.length, chat: { id: Number(params.chat_id) },
    ...(params.message_thread_id == null ? {} : { message_thread_id: Number(params.message_thread_id) }) }; };
  const resolve = createExternalJobTargetResolver({ config, getSessionKey });
  const jobs = createExternalJobService({ config, db, botName: 'bot', resolveTarget: resolve,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  const mailbox = createMailboxService({ config, db, botName: 'bot', jobs, resolveTarget: resolve, getSessionKey, tg, bot: {},
    sendRich: createRichSender({ tg, botName: 'bot', insertSentRow: (row) => db.insertMessage(row) }), getChat: async () => ({ is_forum: true }),
    logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  t.after(() => { mailbox.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  const token = (key) => { mailbox.noteHumanPrompt(key, { operator: true }); return mailbox.scope(key); };
  mailbox.send(token(`${HOME}:3`), { to: 'admin', kind: 'tell', body: 'same chat' });
  await settle();
  mailbox.send(token(`${HOME}:3`), { to: 'ads', kind: 'tell', body: 'other chat' });
  await settle();
  const [sameTarget, sameSender, otherTarget, otherSender] = posts.map((p) => richLinks(p.rich_message.blocks));
  assert.deepEqual(sameTarget.map(([label]) => label), ['music', 'admin']);
  assert.deepEqual(sameSender.map(([label]) => label), ['music', 'admin', '↗ open']);
  assert.deepEqual(otherTarget, [['ads', 'https://t.me/c/9000000001/7']], 'the partner chat never sees the home chat\'s ids');
  assert.deepEqual(otherSender, [['music', 'https://t.me/c/3807211164/3']], 'nor the reverse');
  // A DM has no message links: its card is delivered plainly, and landing
  // where it was sent is no cause for a warning.
  mailbox.send(token(`${HOME}:3`), { to: 'ivan-dm', kind: 'tell', body: 'dm' });
  await settle();
  const [dmTarget, dmSender] = posts.slice(4);
  assert.equal(dmTarget.chat_id, '68861949');
  assert.deepEqual(richLinks(dmTarget.rich_message.blocks), []);
  assert.deepEqual(richLinks(dmSender.rich_message.blocks), [['music', 'https://t.me/c/3807211164/3']], 'no twin link to a DM');
  assert.deepEqual(logs, []);
});

test('rendering: a row without links renders exactly as before', () => {
  const row = { id: 'm_1', kind: 'ask', from_addr: 'role:orchestrator', to_addr: 'role:marketing', body: 'Budget?\nDetails', summary: null };
  const before = [{ type: 'blockquote', blocks: [
    { type: 'paragraph', text: ['❓ ', { type: 'bold', text: 'Question' }, ' · orchestrator → marketing'] },
    { type: 'details', summary: 'Budget?', is_open: false, blocks: [{ type: 'paragraph', text: 'Budget?\nDetails' }] },
  ] }];
  assert.deepEqual(envelope.renderRichMirror(row), before);
  assert.deepEqual(envelope.renderRichMirror(row, { from: null, to: null, extra: [] }), before);
  const html = '❓ <b>orchestrator asks marketing</b>\n<blockquote expandable>Budget?\nDetails</blockquote>';
  assert.equal(envelope.renderMirror(row), html);
  assert.equal(envelope.renderMirror(row, { from: null, to: null, extra: [] }), html);
});

test('rendering: rich and HTML cards carry the same links in the same order', () => {
  const row = { id: 'm_1', kind: 'tell', from_addr: 'session:-1001:3', from_label: 'mu<s>ic', to_addr: 'role:ops', body: 'Hi & bye', origin_name: 'Ivan' };
  const links = { from: 'https://t.me/c/1/3', to: 'https://t.me/c/1/9',
    extra: [{ label: '↗ Notion', url: NOTION_URL }, { label: '↗ open', url: 'https://t.me/c/1/9/12' }] };
  const blocks = envelope.renderRichMirror(row, links);
  const html = envelope.renderMirror(row, links);
  assert.deepEqual(richLinks(blocks), htmlLinks(html).map(([label, url]) => [label.replace('&lt;', '<').replace('&gt;', '>'), url]));
  assert.deepEqual(richLinks(blocks), [['mu<s>ic', links.from], ['ops', links.to], ['↗ Notion', NOTION_URL], ['↗ open', 'https://t.me/c/1/9/12']]);
  assert.equal(card(blocks).text, '📨 Message · mu<s>ic → ops · from Ivan · ↗ Notion · ↗ open');
  assert.equal(html, '📨 <b><a href="https://t.me/c/1/3">mu&lt;s&gt;ic</a> → <a href="https://t.me/c/1/9">ops</a> · from Ivan</b>'
    + ` · <a href="${NOTION_URL}">↗ Notion</a> · <a href="https://t.me/c/1/9/12">↗ open</a>\n<blockquote expandable>Hi &amp; bye</blockquote>`);
});

test('rendering: one plain name and one linked name keep their text', () => {
  const row = { id: 'm_1', kind: 'tell', from_addr: 'system:agent-org', to_addr: 'role:ops', body: 'Task', summary: 'Prices' };
  const links = { from: null, to: 'https://t.me/c/1/9', extra: [] };
  assert.deepEqual(envelope.renderRichMirror(row, links)[0].blocks[0].text,
    ['📨 ', { type: 'bold', text: 'Message' }, ' · agent-org → ', { type: 'url', text: 'ops', url: 'https://t.me/c/1/9' }]);
  assert.equal(envelope.renderMirror(row, links).split('\n')[0], '📨 <b>agent-org → <a href="https://t.me/c/1/9">ops</a></b>');
});

test('rendering: a header over the cap renders without links, as before', () => {
  const row = { id: 'm_1', kind: 'tell', from_addr: 'session:-1001:3', from_label: 'x'.repeat(600), to_addr: 'role:ops', body: 'Hi' };
  const links = { from: 'https://t.me/c/1/3', to: 'https://t.me/c/1/9', extra: [{ label: '↗ open', url: 'https://t.me/c/1/9/12' }] };
  assert.deepEqual(envelope.renderRichMirror(row, links), envelope.renderRichMirror(row));
  assert.equal(envelope.renderMirror(row, links), envelope.renderMirror(row));
});

test('rendering: notice cards name each reason and link the question in both formats', () => {
  const ask = { id: 'm_1', kind: 'ask', from_addr: 'role:orchestrator', to_addr: 'role:marketing', body: 'Budget?', summary: 'Q3 budget' };
  const links = { from: 'https://t.me/c/1/3', to: 'https://t.me/c/1/9', extra: [{ label: '↗ question', url: 'https://t.me/c/1/9/12' }] };
  const words = { succeeded: 'No answer', failed: 'Undelivered', interrupted: 'Undelivered', unknown: 'Uncertain',
    'reply-undelivered': 'Answer undelivered', 'reply-uncertain': 'Answer undelivered' };
  for (const [reason, word] of Object.entries(words)) {
    const blocks = envelope.renderNoticeCard(ask, reason, links);
    const { text } = card(blocks);
    assert.equal(text, `⚠️ ${word} · orchestrator → marketing · ↗ question`, reason);
    assert.equal(blocks[0].blocks[1].summary, 'Q3 budget');
    assert.ok(!blocks[0].blocks[1].blocks[0].text.includes('Budget?'), 'the details hold polygram\'s own sentence, not the ask');
    const html = envelope.renderNoticeCardHtml(ask, reason, links);
    assert.deepEqual(htmlLinks(html), richLinks(blocks), reason);
    assert.ok(html.includes('<blockquote expandable>Q3 budget\n'), 'the fallback names the ask too');
    assert.match(html, new RegExp(`^⚠️ <b>${word} · `));
  }
  assert.throws(() => envelope.renderNoticeCard(ask, 'bogus', links), /No notice card/);
});

test('a strict rich send records the thread it landed in, so a dropped topic is never provable', async (t) => {
  const { db, dbPath } = freshDb('mailbox-links-landed');
  t.after(() => cleanupDb(dbPath, db));
  // The server ignores the topic and the card lands in General.
  let next = 76;
  const tg = async (_bot, _method, params) => ({ message_id: ++next, chat: { id: Number(params.chat_id) } });
  const sendRich = createRichSender({ tg, botName: 'test', insertSentRow: (row) => db.insertMessage(row) });
  const sent = await sendRich({ bot: {}, chatId: PROD, threadId: '142', blocks: [{ type: 'paragraph', text: 'card' }], sourceText: 'card',
    meta: { source: 'agent-org', strictDestination: true } });
  assert.equal(sent.wentRich, true);
  const row = db.raw.prepare('SELECT thread_id FROM messages WHERE msg_id=77').get();
  assert.equal(row.thread_id, null, 'the history says General, where the message is');
  const store = require('../lib/mailbox/store').createMailboxStore(db.raw, { botName: 'test' });
  assert.equal(store.sentBy('agent-org', { chatId: PROD, threadId: '142', messageId: 77 }), false);
  // A send that is not strict keeps recording the thread it asked for.
  await sendRich({ bot: {}, chatId: PROD, threadId: '142', blocks: [{ type: 'paragraph', text: 'reply' }], sourceText: 'reply', meta: { source: 'bot-reply' } });
  assert.equal(db.raw.prepare("SELECT thread_id FROM messages WHERE source='bot-reply'").get().thread_id, '142');
});

test('a slow forum probe costs the General link, never the card', async (t) => {
  const f = fixture(t, { forum: { [MARKET]: 'never' }, forumProbeMs: 20 });
  f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'one' });
  await new Promise((resolve) => setTimeout(resolve, 80)); await settle();
  f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'two' });
  await settle();
  const targets = f.cards().filter((c) => c.chatId === MARKET);
  assert.equal(targets.length, 2);
  for (const target of targets) assert.deepEqual(target.links, [['orchestrator', topic('orchestrator')]]);
  assert.equal(f.getChats.length, 1, 'a timed-out answer is remembered, so the next card does not wait');
  assert.match(f.logs.join('\n'), /target name link for m_\w+ left out: FORUM_PROBE_TIMEOUT/);
});

test('without an explicit probe, the bot\'s own Bot API client answers, called as a method', async (t) => {
  const api = { calls: [], async getChat(chatId) { this.calls.push(chatId); return { id: Number(chatId), is_forum: true }; } };
  const f = fixture(t, { liveBot: { api } });
  f.mailbox.send(f.token('orchestrator'), { to: 'cmo', kind: 'tell', body: 'one' });
  await settle();
  assert.deepEqual(f.cards().find((c) => c.chatId === MARKET).links[1], ['cmo', 'https://t.me/c/4462674958/1']);
  assert.deepEqual(api.calls, [MARKET]);
});

test('an answer that was not delivered gets a notice card linking the question', async (t) => {
  let replyId = null;
  const f = fixture(t, { mailbox: { mirror: 'target' },
    turn: async (job) => (replyId && job.requestId === `mailbox:${replyId}` ? { outcome: 'failed', error: 'boom', inactive: true } : { outcome: 'succeeded', text: '', inactive: true }) });
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  const question = f.row(ask.id).target_card;
  replyId = f.mailbox.reply(f.token('marketing'), { inReplyTo: ask.id, body: '12k' }).id;
  for (let n = 0; n < 3; n++) { await f.jobs.tick(); await f.mailbox.tick(); await settle(); }
  const notices = f.cards().filter((c) => c.text.startsWith('⚠️'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].threadId, '732', 'the asker hears it');
  assert.equal(notices[0].text, '⚠️ Answer undelivered · orchestrator → marketing · ↗ question');
  assert.deepEqual(notices[0].links.at(-1), ['↗ question', question]);
});

test('a notice job that already exists posts no second card', async (t) => {
  const f = fixture(t, { mailbox: { mirror: 'target' } });
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  f.jobs.submit({ routeId: 'orchestrator', requestId: `mailbox-notice:${ask.id}`, task: 'An earlier notice', payload: {} });
  for (let n = 0; n < 2; n++) { await f.jobs.tick(); await f.mailbox.tick(); await settle(); }
  assert.equal(f.row(ask.id).notice_sent, 1, 'the ask is marked notified');
  assert.equal(f.cards().filter((c) => c.text.startsWith('⚠️')).length, 0);
});

test('a failed lookup of the question costs only that link', async (t) => {
  const f = fixture(t, { failGet: true });
  const ask = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Budget?' });
  await settle();
  f.mailbox.reply(f.token('marketing'), { inReplyTo: ask.id, body: '12k' });
  f.failGet = ask.id;
  await settle();
  const answer = f.cards()[2];
  assert.equal(answer.threadId, '732', 'the answer card is still posted');
  assert.deepEqual(answer.links, [['marketing', topic('marketing')], ['orchestrator', topic('orchestrator')]]);
  assert.match(f.logs.join('\n'), /jump link for m_\w+ left out: SQLITE_IOERR/);
});

test('rendering: the header cap counts every link label', () => {
  const links = { from: 'https://t.me/c/1/3', to: 'https://t.me/c/1/9', extra: [{ label: '↗ open', url: 'https://t.me/c/1/9/12' }] };
  const row = (n) => ({ id: 'm_1', kind: 'tell', from_addr: 'session:-1001:3', from_label: 'x'.repeat(n), to_addr: 'role:ops', body: 'Hi' });
  assert.equal(richLinks(envelope.renderRichMirror(row(483), links)).length, 3, 'a 512-unit header keeps its links');
  assert.equal(htmlLinks(envelope.renderMirror(row(483), links)).length, 3);
  assert.deepEqual(envelope.renderRichMirror(row(484), links), envelope.renderRichMirror(row(484)), 'one unit more renders as before');
  assert.equal(envelope.renderMirror(row(484), links), envelope.renderMirror(row(484)));
});
