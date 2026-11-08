'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/mailbox/rules');

const routes = {
  orchestrator: { chatId: '-1001', threadId: '11' },
  marketing: { chatId: '-1001', threadId: '12' },
  ops: { chatId: '-1001', threadId: '13' },
};
const resolve = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
function bot(mailbox, extra = {}) {
  return { externalJobs: { enabled: true, routes: structuredClone(routes), ...extra }, mailbox };
}
const base = () => ({
  enabled: true,
  roles: { orchestrator: { about: 'Owns strategy; routes work' }, marketing: { about: 'Campaigns, content, ads' }, ops: { about: 'Operations' } },
  allow: { orchestrator: ['*'], marketing: ['orchestrator'] },
  limits: { maxDepth: 2, perPairPerHour: 10, maxBodyBytes: 3500 },
});
const read = (mailbox, extra) => rules.readMailboxConfig(bot(mailbox, extra), resolve);

test('no mailbox key, or an explicit disable, means no mailbox', () => {
  assert.equal(rules.readMailboxConfig({ externalJobs: { enabled: true, routes } }, resolve), null);
  assert.equal(rules.readMailboxConfig({}, resolve), null);
  assert.equal(read({ ...base(), enabled: false }), null);
  assert.equal(read({ roles: base().roles }), null, 'enabling is explicit');
});

test('a valid configuration resolves every role to its frozen session', () => {
  const cfg = read(base());
  assert.deepEqual([...cfg.roles.keys()], ['orchestrator', 'marketing', 'ops']);
  assert.equal(cfg.roles.get('marketing').target.sessionKey, '-1001:12');
  assert.equal(cfg.roles.get('marketing').about, 'Campaigns, content, ads');
  assert.equal(cfg.roleForSession('-1001:11'), 'orchestrator');
  assert.equal(cfg.roleForSession('-1001:99'), null);
  assert.deepEqual(cfg.limits, { maxDepth: 2, perPairPerHour: 10, maxBodyBytes: 3500, systemPerHour: 60 });
  assert.equal(cfg.mirror, true, 'every message is visible in Telegram unless explicitly turned off');
  assert.equal(read({ ...base(), mirror: false }).mirror, false);
});

test('limits default to the documented values', () => {
  const { limits, ...rest } = base();
  assert.deepEqual(read(rest).limits, { maxDepth: 2, perPairPerHour: 10, maxBodyBytes: 3500, systemPerHour: 60 });
});

test('systemSenders names the processes that may submit as system:<name>; none by default', () => {
  assert.deepEqual([...read(base()).systemSenders], [], 'no system sender unless configured');
  assert.deepEqual([...read({ ...base(), systemSenders: ['agent-org', 'crm_sync'] }).systemSenders], ['agent-org', 'crm_sync']);
  assert.equal(read({ ...base(), systemSenders: ['agent-org'] }).systemSenders.has('agent-org'), true);
  assert.equal(read({ ...base(), limits: { systemPerHour: 5 } }).limits.systemPerHour, 5);
  for (const bad of ['agent-org', {}, [''], ['Agent'], ['agent org'], ['a:b'], [7], ['agent-org', 'agent-org']]) {
    assert.throws(() => read({ ...base(), systemSenders: bad }), /systemSenders/, JSON.stringify(bad));
  }
  // system:polygram is the daemon's own notice address; no sender may impersonate it.
  assert.throws(() => read({ ...base(), systemSenders: ['polygram'] }), /systemSenders.*polygram/);
  assert.throws(() => read({ ...base(), limits: { systemPerHour: 0 } }), /systemPerHour/);
});

test('mailbox requires enabled external jobs', () => {
  assert.throws(() => rules.readMailboxConfig({ externalJobs: { enabled: false, routes }, mailbox: base() }, resolve), /external jobs/i);
});

test('role keys must be route ids of the documented shape', () => {
  for (const name of ['Ops', '1ops', 'ops:x', '', 'op s']) {
    const mailbox = base(); mailbox.roles = { ...mailbox.roles, [name]: { about: 'x' } };
    assert.throws(() => read(mailbox, { routes: { ...routes, [name]: { chatId: '-1001', threadId: '20' } } }), /role/i, name);
  }
  for (const name of ['a', 'ops-2', 'ops_2']) {
    const mailbox = base(); mailbox.roles = { [name]: { about: 'x' }, orchestrator: { about: 'y' } }; mailbox.allow = {};
    assert.ok(read(mailbox, { routes: { orchestrator: routes.orchestrator, [name]: { chatId: '-1001', threadId: '20' } } }).roles.has(name), name);
  }
});

test('every role needs an enabled route that the resolver accepts', () => {
  const missing = base(); missing.roles.sales = { about: 'x' };
  assert.throws(() => read(missing), /sales/);
  assert.throws(() => read(base(), { routes: { ...routes, ops: { ...routes.ops, enabled: false } } }), /ops/);
  const refusing = (route) => { if (route.threadId === '13') throw new Error('External job topic must be isolated'); return resolve(route); };
  assert.throws(() => rules.readMailboxConfig(bot(base()), refusing), /ops.*isolated/);
});

test('two roles that share a session fail at boot', () => {
  assert.throws(() => read(base(), { routes: { ...routes, ops: routes.marketing } }), /share/i);
});

test('the allowlist names only roles, with "*" as every role', () => {
  assert.throws(() => read({ ...base(), allow: { sales: ['ops'] } }), /allow/i);
  assert.throws(() => read({ ...base(), allow: { ops: ['sales'] } }), /allow/i);
  assert.throws(() => read({ ...base(), allow: { ops: 'orchestrator' } }), /allow/i);
  const cfg = read(base());
  assert.equal(cfg.allowed('orchestrator', 'ops'), true);
  assert.equal(cfg.allowed('marketing', 'orchestrator'), true);
  assert.equal(cfg.allowed('marketing', 'ops'), false);
  assert.equal(cfg.allowed('ops', 'orchestrator'), false, 'a role without an allow entry starts nothing');
});

test('limits must be positive integers and about text bounded', () => {
  for (const limits of [{ maxDepth: 0 }, { perPairPerHour: -1 }, { maxBodyBytes: 1.5 }, { maxDepth: '2' }, { unknown: 1 }, { maxBodyBytes: 3501 }]) {
    assert.throws(() => read({ ...base(), limits }), /limit/i, JSON.stringify(limits));
  }
  assert.equal(read({ ...base(), limits: { maxBodyBytes: 3500, maxDepth: 1 } }).limits.maxBodyBytes, 3500, 'a mirrored body at the ceiling still fits one Telegram message');
  const long = base(); long.roles.ops.about = 'x'.repeat(301);
  assert.throws(() => read(long), /about/i);
  assert.throws(() => read({ ...base(), mirror: 'yes' }), /mirror/i);
});

test('starting a message checks kind, target, self and the allowlist', () => {
  const cfg = read(base());
  assert.doesNotThrow(() => rules.checkStart(cfg, { from: 'orchestrator', to: 'marketing', kind: 'ask' }));
  assert.doesNotThrow(() => rules.checkStart(cfg, { from: 'marketing', to: 'orchestrator', kind: 'tell' }));
  assert.throws(() => rules.checkStart(cfg, { from: 'orchestrator', to: 'marketing', kind: 'reply' }), /kind/i);
  assert.throws(() => rules.checkStart(cfg, { from: 'orchestrator', to: 'sales', kind: 'ask' }), /unknown role/i);
  assert.throws(() => rules.checkStart(cfg, { from: 'orchestrator', to: 'orchestrator', kind: 'ask' }), /itself/i);
  assert.throws(() => rules.checkStart(cfg, { from: 'marketing', to: 'ops', kind: 'ask' }), /not allowed/i);
});

test('depth: a new message is one deeper than its turn and capped at maxDepth', () => {
  assert.equal(rules.nextDepth(0, 2), 1);
  assert.equal(rules.nextDepth(1, 2), 2);
  assert.throws(() => rules.nextDepth(2, 2), /depth/i);
  assert.throws(() => rules.nextDepth(5, 2), /depth/i);
});

test('rate: the limit counts asks and tells in the last hour per pair', () => {
  assert.equal(rules.RATE_WINDOW_MS, 3600000);
  assert.doesNotThrow(() => rules.checkRate(9, 10));
  assert.throws(() => rules.checkRate(10, 10), /rate/i);
});

test('duplicates: the window is ten minutes', () => {
  assert.equal(rules.DUPLICATE_WINDOW_MS, 600000);
});

test('body: bounded, non-empty, redacted before it is hashed', () => {
  assert.equal(rules.cleanBody('hello', 3500), 'hello');
  assert.throws(() => rules.cleanBody('', 3500), /body/i);
  assert.throws(() => rules.cleanBody('   ', 3500), /body/i);
  assert.throws(() => rules.cleanBody(42, 3500), /body/i);
  assert.equal(rules.cleanBody('é'.repeat(5), 10), 'é'.repeat(5), 'exactly at the byte limit');
  assert.throws(() => rules.cleanBody('é'.repeat(6), 11), /body/i, 'the limit counts UTF-8 bytes');
  const secret = 'use key AKIAABCDEFGHIJKLMNOP for the upload';
  const clean = rules.cleanBody(secret, 3500);
  assert.doesNotMatch(clean, /AKIAABCDEFGHIJKLMNOP/);
  assert.equal(rules.bodyHash(clean), rules.bodyHash(rules.cleanBody(secret, 3500)));
  assert.notEqual(rules.bodyHash('a'), rules.bodyHash('b'));
  assert.match(rules.bodyHash('a'), /^[0-9a-f]{64}$/);
});

test('a reply must answer an open ask addressed to the caller', () => {
  const ask = { id: 'm_1', kind: 'ask', to_addr: 'role:marketing', from_addr: 'role:orchestrator' };
  assert.doesNotThrow(() => rules.checkReply({ ask, caller: 'marketing', replied: false }));
  assert.throws(() => rules.checkReply({ ask: null, caller: 'marketing', replied: false }), /no such ask/i);
  assert.throws(() => rules.checkReply({ ask: { ...ask, kind: 'tell' }, caller: 'marketing', replied: false }), /not an ask/i);
  assert.throws(() => rules.checkReply({ ask: { ...ask, kind: 'reply' }, caller: 'marketing', replied: false }), /not an ask/i);
  assert.throws(() => rules.checkReply({ ask, caller: 'ops', replied: false }), /not addressed/i);
  assert.throws(() => rules.checkReply({ ask, caller: 'marketing', replied: true }), /already/i);
});

test('addresses carry their prefix', () => {
  assert.equal(rules.roleAddress('ops'), 'role:ops');
  assert.equal(rules.SYSTEM_ADDRESS, 'system:polygram');
  assert.equal(rules.roleFromAddress('role:ops'), 'ops');
  assert.equal(rules.roleFromAddress('system:polygram'), null);
});

test('the config.example.json mailbox block is disabled and valid once enabled', () => {
  const example = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'config.example.json'), 'utf8'));
  const exampleBot = example.bots['admin-bot'];
  assert.equal(rules.readMailboxConfig(exampleBot, resolve), null, 'the shipped example changes nothing');
  const enabled = { ...exampleBot, externalJobs: { ...exampleBot.externalJobs, enabled: true }, mailbox: { ...exampleBot.mailbox, enabled: true } };
  const cfg = rules.readMailboxConfig(enabled, resolve);
  assert.deepEqual([...cfg.roles.keys()], ['orchestrator', 'marketing']);
  assert.equal(cfg.allowed('marketing', 'orchestrator'), true);
  assert.deepEqual([...cfg.systemSenders], ['agent-org'], 'the example shows the agent-org system sender');
  assert.equal(cfg.limits.systemPerHour, 60);
});

test('an unknown top-level mailbox key fails boot instead of being ignored', () => {
  for (const key of ['limit', 'allowed', 'mirrors', 'systemSender']) {
    assert.throws(() => read({ ...base(), [key]: {} }), new RegExp(`mailbox key ${key}`), key);
  }
  assert.ok(read({ ...base(), mirror: false, systemSenders: [] }), 'every documented key is accepted');
  assert.equal(read({ enabled: false, limit: {} }), null, 'a disabled block changes nothing and is not validated');
});
