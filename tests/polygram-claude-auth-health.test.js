'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
const policyPath = path.join(__dirname, '..', 'lib/ops/claude-auth-health.js');
const policy = require(policyPath);
const expired = { state: 'expired', refreshTokenExpiresAt: 1791538140455 };

function fixture({ backend = 'cli', authSource = 'external', auth = expired, chats } = {}) {
  const replies = [];
  const events = [];
  const logs = [];
  let reads = 0;
  const context = {
    ...policy,
    selectedBackend: backend,
    selectedInboundProvider: backend === 'codex' ? 'codex' : 'claude',
    config: {
      bot: { ...(authSource !== undefined && { claudeCliAuthSource: authSource }) },
      chats: chats || { '1': { pm: backend } },
    },
    sessionKey: 'synthetic', chatId: 1, label: 'synthetic',
    checkClaudeAuthHealth: () => {
      reads++;
      if (auth instanceof Error) throw auth;
      return auth;
    },
    console: Object.fromEntries(['error', 'warn', 'log'].map(k => [k, text => logs.push(text)])),
    logEvent: (kind, detail) => events.push({ kind, ...detail }),
    sendReply: async text => replies.push(text),
  };
  return { context, replies, events, logs, reads: () => reads };
}

function gate(context) {
  const comment = source.indexOf('// Claude-auth gate:');
  const start = source.indexOf('  if (', comment);
  const end = source.indexOf('\n  const t0 = Date.now();', start);
  assert.ok(comment > 0 && start > comment && end > start, 'locate the actual dispatch gate');
  return vm.runInNewContext(`(async () => { ${source.slice(start, end)}; return 'dispatch'; })()`, context);
}

function monitor(context) {
  const start = source.indexOf('  const runAuthCheck = (trigger) => {');
  const end = source.indexOf("  runAuthCheck('boot');", start);
  assert.ok(start > 0 && end > start, 'locate the actual monitor');
  return vm.runInNewContext(`${source.slice(start, end)} runAuthCheck('interval');`, context);
}

test('VPS proxy turn is not refused when the unused host login expired at 2026-10-09T09:29Z', async () => {
  const f = fixture();
  assert.equal(await gate(f.context), 'dispatch');
  assert.equal(f.reads(), 0, 'proxy owns credentials; the native file is irrelevant');
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.events, []);
});

for (const [backend, authSource] of [['cli', 'native'], ['sdk', 'external']]) {
  test(`${backend}/${authSource}: native expiry still prevents a doomed turn`, async () => {
    const f = fixture({ backend, authSource });
    assert.equal(await gate(f.context), undefined);
    assert.equal(f.reads(), 1);
    assert.match(f.replies[0], /Claude login has expired/);
    assert.equal(f.events[0].source, 'dispatch-gate');
  });
}

test('Codex never reads Claude native credentials', async () => {
  const f = fixture({ backend: 'codex' });
  assert.equal(await gate(f.context), 'dispatch');
  assert.equal(f.reads(), 0);
});

for (const auth of [{ state: 'healthy' }, { state: 'unknown' }, new Error('unreadable')]) {
  test(`native credential ${auth.state || 'read error'} preserves existing non-refusal behavior`, async () => {
    const f = fixture({ authSource: 'native', auth });
    assert.equal(await gate(f.context), 'dispatch');
    assert.equal(f.replies.length, 0);
  });
}

test('proxy-only CLI plus Codex does not emit native-login expiry alarms', () => {
  const f = fixture({ chats: { '1': { pm: 'channels' }, '2': { pm: 'codex' } } });
  monitor(f.context);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.events, []);
});

test('mixed proxy CLI and native SDK topics keep native expiry monitoring', () => {
  const f = fixture({ chats: { '1': { pm: 'channels', topics: { '2': { pm: 'sdk' } } } } });
  monitor(f.context);
  assert.equal(f.reads(), 1);
  assert.equal(f.events[0].kind, 'auth-expired');
  assert.match(f.logs[0], /Native Claude login/);
});

test('invalid auth policy cannot fall through as an unknown credential read', async () => {
  const f = fixture({ authSource: 'typo' });
  await assert.rejects(gate(f.context), /claudeCliAuthSource/);
  assert.equal(f.reads(), 0);
});

test('omitted auth policy still refuses expired native CLI credentials', async () => {
  const f = fixture();
  delete f.context.config.bot.claudeCliAuthSource;
  assert.equal(await gate(f.context), undefined);
  assert.match(f.replies[0], /Claude login has expired/);
});

test('boot validates auth policy before taking daemon ownership', () => {
  const merge = source.indexOf('config.bot = activeBotConfig(config, BOT_NAME);');
  const validation = source.indexOf('validateClaudeCliAuthSource(config.bot);', merge);
  const ownership = source.indexOf('processGuard.claimPidFile(', merge);
  assert.ok(merge > 0 && validation > merge && validation < ownership);
});

test('boot checks external CLI prerequisites before constructing the process factory', () => {
  const pin = source.indexOf('pinnedClaudeBin = binCheck.path;');
  const check = source.indexOf('assertExternalClaudeCliReady(config.bot, { sessionLauncher, pinnedClaudeBin });', pin);
  const factory = source.indexOf('const orchestraProcessFactory = createProcessFactory(', pin);
  assert.ok(pin > 0 && check > pin && check < factory);
});
