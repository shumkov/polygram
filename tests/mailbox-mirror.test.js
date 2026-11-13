'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService } = require('../lib/mailbox/service');
const envelope = require('../lib/mailbox/envelope');

const routes = { orchestrator: { chatId: '-1001', threadId: '11' }, marketing: { chatId: '-1001', threadId: '12' } };
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); };

function fixture(t, { mirror, send, turn, jobs: jobSettings = {}, systemSenders } = {}) {
  const { db, dbPath } = freshDb('mailbox-mirror');
  const posts = []; const errors = []; const turns = [];
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes), ...jobSettings }, mailbox: {
    enabled: true, roles: { orchestrator: { about: 'Strategy' }, marketing: { about: 'Campaigns' } },
    allow: { orchestrator: ['*'] }, ...(mirror === undefined ? {} : { mirror }), ...(systemSenders ? { systemSenders } : {}),
  } } };
  const f = { db, posts, errors, turns };
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (o, run) => run(), getMailbox: () => f.mailbox,
      runtime: { dispatch: async (job, hooks) => { hooks.onSend?.(); turns.push(job.requestId); return (turn || (async () => ({ outcome: 'succeeded', inactive: true })))(job); } } }),
    deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  const bot = { name: 'bot' };
  const tg = async (b, method, params, meta) => {
    assert.equal(b, bot);
    posts.push({ method, params, meta, committed: db.raw.prepare('SELECT count(*) n FROM external_jobs').get().n });
    return (send || (async () => ({ message_id: posts.length })))(params);
  };
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs, resolveTarget, bot, tg, logger: { error: (m) => errors.push(m), warn() {} } });
  f.jobs = jobs; jobs.start();
  t.after(() => { f.mailbox.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  f.token = (role) => { f.mailbox.noteHumanPrompt(session(role)); return f.mailbox.scope(session(role)); };
  return f;
}

test('each message is mirrored once, as an HTML card, into the target topic after it commits', async (t) => {
  const f = fixture(t);
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'What is the Q3 budget?' });
  await settle();
  assert.equal(f.posts.length, 1);
  const [post] = f.posts;
  assert.equal(post.method, 'sendMessage');
  assert.deepEqual(post.params, { chat_id: '-1001', message_thread_id: '12', parse_mode: 'HTML', text: '❓ <b>orchestrator asks marketing</b>\n<blockquote expandable>What is the Q3 budget?</blockquote>' });
  assert.notEqual(post.meta.plainText, true); assert.equal(post.meta.strictDestination, true);
  assert.equal(post.meta.source, 'mailbox-mirror'); assert.equal(post.meta.sessionKey, session('marketing'));
  assert.equal(post.committed, 1, 'the post happens only after the row and its job are committed');
});

test('a reply is mirrored into the asker topic; duplicates and refusals are not mirrored', async (t) => {
  const f = fixture(t);
  const token = f.token('orchestrator');
  const question = f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Q' });
  f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.throws(() => f.mailbox.send(token, { to: 'orchestrator', kind: 'ask', body: 'self' }));
  const answer = f.mailbox.reply(f.mailbox.scope(session('marketing')), { inReplyTo: question.id, body: 'A' });
  await settle();
  assert.deepEqual(f.posts.map((post) => [post.params.message_thread_id, post.params.text]), [
    ['12', '❓ <b>orchestrator asks marketing</b>\n<blockquote expandable>Q</blockquote>'],
    ['11', '↩️ <b>marketing answered orchestrator</b>\n<blockquote expandable>A</blockquote>'],
  ]);
});

test('the mirror carries the redacted body', async (t) => {
  const f = fixture(t);
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body: 'Use AKIAABCDEFGHIJKLMNOP for uploads' });
  await settle();
  assert.doesNotMatch(f.posts[0].params.text, /AKIAABCDEFGHIJKLMNOP/);
});

test('deferred dispatch never mirrors again', async (t) => {
  let busy = true;
  const f = fixture(t, { turn: async () => (busy ? { deferred: true, reason: 'Session is busy' } : { outcome: 'succeeded', inactive: true }) });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body: 'FYI' });
  await f.jobs.tick(); await f.jobs.tick();
  busy = false; await f.jobs.tick();
  assert.deepEqual(f.turns, [`mailbox:${sent.id}`, `mailbox:${sent.id}`, `mailbox:${sent.id}`]);
  await settle();
  assert.equal(f.posts.length, 1);
});

test('a failed mirror is logged and never blocks delivery', async (t) => {
  const f = fixture(t, { send: async () => { throw Object.assign(new Error('Call to sendMessage failed!'), { error_code: 400, description: 'Bad Request: message thread not found' }); } });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.equal(sent.state, 'queued');
  await settle();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], new RegExp(`mirror of ${sent.id} failed: 400 Bad Request: message thread not found`), 'Telegram API text is logged; it is not user content');
  await f.jobs.tick();
  assert.deepEqual(f.turns, [`mailbox:${sent.id}`]);
  const g = fixture(t, { send: () => { throw new Error('synchronous transport failure'); } });
  assert.doesNotThrow(() => g.mailbox.send(g.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' }));
  await settle();
  assert.equal(g.errors.length, 1);
});

test('mirror: false posts nothing', async (t) => {
  const f = fixture(t, { mirror: false });
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
  await settle();
  assert.deepEqual(f.posts, []);
});

test('the mirror line is rendered from the stored row', () => {
  assert.equal(envelope.renderMirror({ id: 'm_1', kind: 'tell', from_addr: 'role:a', to_addr: 'role:b', body: 'hi' }), '📨 <b>a → b</b>\n<blockquote expandable>hi</blockquote>');
});

test('a send refused by its job submit posts no mirror', async (t) => {
  const f = fixture(t, { jobs: { maxPending: 1 } });
  const token = f.token('orchestrator');
  f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'first' });
  assert.throws(() => f.mailbox.send(token, { to: 'marketing', kind: 'tell', body: 'second' }), /queue full/);
  await settle();
  assert.deepEqual(f.posts.map((post) => post.params.text.split('\n')[1]), ['<blockquote expandable>first</blockquote>'], 'only a committed message is mirrored');
});

// The sender-side line: a role's own topic shows what that role sent.

test('mirror "both" also posts a sender line into the sender topic, after the target mirror', async (t) => {
  const f = fixture(t, { mirror: 'both' });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'What is the Q3 budget?' });
  await settle();
  assert.deepEqual(f.posts.map((post) => post.params), [
    { chat_id: '-1001', message_thread_id: '12', parse_mode: 'HTML', text: '❓ <b>orchestrator asks marketing</b>\n<blockquote expandable>What is the Q3 budget?</blockquote>' },
    { chat_id: '-1001', message_thread_id: '11', text: `📤 role:orchestrator → role:marketing (ask ${sent.id})\nWhat is the Q3 budget?` },
  ]);
  const sender = f.posts[1];
  assert.equal(sender.meta.plainText, true); assert.equal(sender.meta.strictDestination, true);
  assert.equal(sender.meta.source, 'mailbox-sender-mirror');
  assert.equal(sender.meta.sessionKey, session('orchestrator'), 'the post is attributed to the sender topic it lands in');
  assert.equal(sender.committed, 1, 'the sender line is posted only after the row and its job are committed');
});

test('mirror "both" mirrors a reply into both topics; duplicates are not mirrored again', async (t) => {
  const f = fixture(t, { mirror: 'both' });
  const token = f.token('orchestrator');
  const question = f.mailbox.send(token, { to: 'marketing', kind: 'tell', body: 'Q' });
  f.mailbox.send(token, { to: 'marketing', kind: 'tell', body: 'Q' });
  const ask = f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Budget?' });
  const answer = f.mailbox.reply(f.mailbox.scope(session('marketing')), { inReplyTo: ask.id, body: 'A' });
  await settle();
  assert.deepEqual(f.posts.map((post) => [post.params.message_thread_id, post.params.text]), [
    ['12', '📨 <b>orchestrator → marketing</b>\n<blockquote expandable>Q</blockquote>'],
    ['11', `📤 role:orchestrator → role:marketing (tell ${question.id})\nQ`],
    ['12', '❓ <b>orchestrator asks marketing</b>\n<blockquote expandable>Budget?</blockquote>'],
    ['11', `📤 role:orchestrator → role:marketing (ask ${ask.id})\nBudget?`],
    ['11', '↩️ <b>marketing answered orchestrator</b>\n<blockquote expandable>A</blockquote>'],
    ['12', `📤 role:marketing → role:orchestrator (reply ${answer.id})\nA`],
  ]);
});

test('mirror true and "target" never post into the sender topic', async (t) => {
  for (const mirror of [undefined, true, 'target']) {
    const f = fixture(t, { mirror });
    f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
    await settle();
    assert.deepEqual(f.posts.map((post) => post.params.message_thread_id), ['12'], String(mirror));
  }
});

test('a system sender has no topic, so "both" posts only the target mirror', async (t) => {
  const f = fixture(t, { mirror: 'both', systemSenders: ['agent-org'] });
  const sent = f.mailbox.submit({ sender: 'agent-org', to: 'marketing', body: 'Task 42 is yours', key: 'k1' });
  await settle();
  assert.deepEqual(f.posts.map((post) => [post.params.message_thread_id, post.params.text]), [
    ['12', '📨 <b>agent-org → marketing</b>\n<blockquote expandable>Task 42 is yours</blockquote>'],
  ]);
});

test('the sender line carries the first 300 characters of the redacted body', async (t) => {
  const f = fixture(t, { mirror: 'both' });
  // Emoji are two UTF-16 units each, so a unit-based cut would split one.
  const body = `AKIAABCDEFGHIJKLMNOP ${'🙂'.repeat(400)}`;
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body });
  await settle();
  const target = f.db.raw.prepare('SELECT body FROM mailbox_messages').get().body;
  const sender = f.posts[1].params.text.split('\n').slice(1).join('\n');
  assert.doesNotMatch(sender, /AKIAABCDEFGHIJKLMNOP/, 'the sender line is cut from the redacted text');
  assert.equal(sender, `${Array.from(target).slice(0, 300).join('')}…`, 'a cut body is marked as cut');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sender), 'no emoji is split in half');
});

test('target cards escape the stored body and human origin without interpreting HTML or Markdown', () => {
  const text = envelope.renderMirror({ kind: 'tell', from_addr: 'system:agent-org', to_addr: 'role:prices', origin_name: 'Ivan <&>',
    body: 'Task <b>title</b> & **raw**\nRun `tasks umi show id`.' });
  assert.equal(text, '📨 <b>agent-org → prices · from Ivan &lt;&amp;&gt;</b>\n<blockquote expandable>Task &lt;b&gt;title&lt;/b&gt; &amp; **raw**\nRun `tasks umi show id`.</blockquote>');
});

const mirrorText = (html) => html.replace(/<\/?(?:b|blockquote)(?: expandable)?>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('HTML entity expansion does not truncate a valid 3500-byte mirror body', () => {
  const body = '&<>'.repeat(1166) + '&&';
  const html = envelope.renderMirror({ kind: 'tell', from_addr: 'role:a', to_addr: 'role:b', body });
  assert.equal(mirrorText(html), `📨 a → b\n${body}`);
  assert.ok(html.length > 4096, 'Telegram limits parsed text, not serialized HTML');
});

test('long target cards bound parsed text without cutting an entity or surrogate pair', () => {
  for (const body of ['&'.repeat(8000), '🙂'.repeat(4000), '<&🙂>'.repeat(1500)]) {
    const html = envelope.renderMirror({ kind: 'tell', from_addr: 'role:a', to_addr: 'role:b', body });
    const text = mirrorText(html);
    assert.ok(text.length <= 4096);
    assert.ok(text.endsWith('…'));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
    assert.match(html, /<blockquote expandable>.*<\/blockquote>$/s);
    assert.doesNotMatch(html, /&(?!amp;|lt;|gt;)/);
  }
});

test('unbounded role names cannot overflow the header or consume the whole body budget', () => {
  const html = envelope.renderMirror({ kind: 'ask', from_addr: `role:${'<&🙂>'.repeat(2000)}`, to_addr: 'role:b', body: 'Task' });
  const text = mirrorText(html);
  assert.ok(text.length <= 4096);
  assert.ok(text.endsWith('\nTask'));
  assert.ok(text.split('\n')[0].length <= 512);
});

test('a relayed human origin appears on the system tell card and its body remains redacted', async (t) => {
  const f = fixture(t, { mirror: 'both', systemSenders: ['agent-org'] });
  f.mailbox.submit({ sender: 'agent-org', to: 'marketing', body: 'Use AKIAABCDEFGHIJKLMNOP', key: 'human', origin: { kind: 'human', name: 'Ivan' } });
  await settle();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].params.text, /^📨 <b>agent-org → marketing · from Ivan<\/b>/);
  assert.doesNotMatch(f.posts[0].params.text, /AKIAABCDEFGHIJKLMNOP/);
});

test('the sender line is rendered from the stored row; a short body is not marked as cut', () => {
  const row = { id: 'm_1', kind: 'tell', from_addr: 'role:a', to_addr: 'role:b', body: 'hi' };
  assert.equal(envelope.renderSenderMirror(row), '📤 role:a → role:b (tell m_1)\nhi');
  assert.equal(envelope.renderSenderMirror({ ...row, body: 'x'.repeat(300) }), `📤 role:a → role:b (tell m_1)\n${'x'.repeat(300)}`);
});

test('a failed sender line is logged, never blocks delivery, and does not stop the target mirror', async (t) => {
  const f = fixture(t, { mirror: 'both', send: async (params) => {
    if (params.message_thread_id === '11') throw Object.assign(new Error('Call to sendMessage failed!'), { error_code: 403, description: 'Forbidden: bot is not a member' });
    return { message_id: 1 };
  } });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.equal(sent.state, 'queued');
  await settle();
  assert.deepEqual(f.posts.map((post) => post.params.message_thread_id), ['12', '11']);
  assert.deepEqual(f.errors, [`[mailbox] sender mirror of ${sent.id} failed: 403 Forbidden: bot is not a member`]);
  await f.jobs.tick();
  assert.deepEqual(f.turns, [`mailbox:${sent.id}`]);
  const g = fixture(t, { mirror: 'both', send: () => { throw new Error('synchronous transport failure'); } });
  assert.doesNotThrow(() => g.mailbox.send(g.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' }));
  await settle();
  assert.equal(g.posts.length, 2, 'a failed target mirror does not suppress the sender line');
  assert.equal(g.errors.length, 2);
});

test('deferred dispatch never posts the sender line again', async (t) => {
  let busy = true;
  const f = fixture(t, { mirror: 'both', turn: async () => (busy ? { deferred: true, reason: 'Session is busy' } : { outcome: 'succeeded', inactive: true }) });
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body: 'FYI' });
  await f.jobs.tick(); await f.jobs.tick();
  busy = false; await f.jobs.tick();
  await settle();
  assert.deepEqual(f.posts.map((post) => post.params.message_thread_id), ['12', '11']);
});
