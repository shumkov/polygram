'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAccess, readProxy } = require('../lib/codex/deployment-policy');
const { resolveCodexEnabled } = require('../lib/runtime-config');

test('every enabled Codex scope shares policy without a private-chat allowlist', () => {
  const config = { defaults: { codexEnabled: true }, codex: { access: {
    mode: 'trusted', commandPath: '/usr/bin:/bin',
  } }, chats: { '-100123': { codexEnabled: false } } };
  assert.equal(resolveCodexEnabled(config, '68861949', null), true);
  assert.equal(resolveCodexEnabled(config, '99999', null), true);
  assert.equal(resolveCodexEnabled(config, '-100987', '5'), true);
  assert.equal(resolveCodexEnabled(config, '-100123', null), false);
});

test('Codex requires explicit global trusted access and rejects legacy private-chat policy', () => {
  assert.deepEqual(validateAccess({ mode: 'trusted', commandPath: '/usr/bin:/bin' }),
    { mode: 'trusted', commandPath: '/usr/bin:/bin' });
  for (const access of [undefined, null, { mode: 'limited', commandPath: '/usr/bin' },
    { mode: 'trusted', commandPath: '/usr/bin', chatIds: ['68861949'] },
    { mode: 'trusted', commandPath: '/usr/bin:' }]) {
    assert.throws(() => validateAccess(access), { code: 'CODEX_DEPLOYMENT_CONFIG_INVALID' });
  }
});

test('missing CLIProxy configuration cannot silently select native OpenAI', () => {
  assert.throws(() => readProxy(undefined), { code: 'CODEX_DEPLOYMENT_CONFIG_INVALID' });
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { selectCodexWorkspaceHome } = require('../lib/codex/runtime-profile');

function workspaceFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.polygram-workspace-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaces = ['first', 'second'].map((name) => {
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Synthetic canonical instructions', { mode: 0o600 });
    return workspace;
  });
  return { root, workspaces, codexHome: path.join(root, 'legacy-home') };
}

test('all-chat workspace homes isolate distinct cwd and reuse canonical aliases without touching legacy residue', async (t) => {
  const f = workspaceFixture(t);
  fs.mkdirSync(f.codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'retained failed policy', { mode: 0o600 });
  const selections = await Promise.all(f.workspaces.map(async (workspace) => selectCodexWorkspaceHome({
    codexHome: f.codexHome, workspace, processEnv: { HOME: f.root },
  }, { create: true })));
  assert.notEqual(selections[0].codexHome, selections[1].codexHome);
  for (const [index, workspace] of f.workspaces.entries()) {
    const expected = path.join(f.codexHome + '.workspaces', createHash('sha256').update(workspace).digest('hex'));
    assert.equal(selections[index].codexHome, expected);
    assert.equal(fs.statSync(path.dirname(expected)).mode & 0o777, 0o700);
    assert.deepEqual(selectCodexWorkspaceHome({ codexHome: f.codexHome,
      workspace: fs.realpathSync(workspace + '/.'), processEnv: { HOME: f.root } }), selections[index]);
    assert.throws(() => selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: workspace + '/.' }));
  }
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), 'retained failed policy');
});

test('existing canonical binding preserves native auth and session history in place', (t) => {
  const f = workspaceFixture(t);
  fs.mkdirSync(f.codexHome, { mode: 0o700 });
  fs.symlinkSync(path.join(f.workspaces[0], 'AGENTS.md'), path.join(f.codexHome, 'AGENTS.md'));
  fs.writeFileSync(path.join(f.codexHome, 'auth.json'), 'untouched synthetic native auth', { mode: 0o600 });
  fs.mkdirSync(path.join(f.codexHome, 'sessions'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.codexHome, 'sessions', 'history'), 'synthetic existing thread');
  const before = fs.statSync(path.join(f.codexHome, 'auth.json'));
  const first = selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: f.workspaces[0] });
  const second = selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: f.workspaces[1] }, { create: true });
  assert.equal(first.codexHome, f.codexHome);
  assert.notEqual(second.codexHome, f.codexHome);
  assert.equal(fs.statSync(path.join(f.codexHome, 'auth.json')).ino, before.ino);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'sessions', 'history'), 'utf8'), 'synthetic existing thread');
  assert.equal(fs.existsSync(path.join(second.codexHome, 'auth.json')), false);
});

test('unsafe legacy instruction state cannot be bypassed by deriving another workspace home', (t) => {
  assert.equal(typeof selectCodexWorkspaceHome, 'function');
  for (const kind of ['regular', 'foreign', 'override', 'mode']) {
    const f = workspaceFixture(t);
    fs.mkdirSync(f.codexHome, { mode: kind === 'mode' ? 0o755 : 0o700 });
    if (kind === 'regular') fs.writeFileSync(path.join(f.codexHome, 'AGENTS.md'), 'foreign');
    if (kind === 'foreign') fs.symlinkSync(path.join(f.root, 'other.md'), path.join(f.codexHome, 'AGENTS.md'));
    if (kind === 'override') fs.writeFileSync(path.join(f.codexHome, 'AGENTS.override.md'), 'foreign');
    assert.throws(() => selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: f.workspaces[1] }, { create: true }));
    assert.equal(fs.existsSync(f.codexHome + '.workspaces'), false);
  }
});


test('example config states the mandatory uniform proxy policy without native-login or chat-ID exceptions', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.deepEqual(Object.keys(example.codex.access).sort(), ['commandPath', 'mode']);
  assert.equal(example.codex.access.mode, 'trusted');
  assert.equal(example.codex.proxy.baseUrl, 'http://127.0.0.1:8318/v1');
  const policy = Object.entries(example.codex).filter(([key]) => key.startsWith('_comment')).map(([, value]) => value).join(' ');
  assert.doesNotMatch(policy, /already authenticated|authentication.*required|omit access|optional proxy|proxy is optional|chatIds|network.*disabled/i);
});

test('derived home cannot alias the service global Codex home', (t) => {
  const f = workspaceFixture(t);
  const selection = selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: f.workspaces[0] }, { create: true });
  fs.mkdirSync(selection.codexHome, { mode: 0o700 });
  fs.symlinkSync(selection.codexHome, path.join(f.root, '.codex'));
  assert.throws(() => selectCodexWorkspaceHome({ codexHome: f.codexHome,
    workspace: f.workspaces[0], processEnv: { HOME: f.root } }), { code: 'CODEX_INSTRUCTION_BINDING_DRIFT' });
});

test('shared workspace container creation accepts only a strictly safe concurrent creator', (t) => {
  const { spawnSync } = require('node:child_process');
  const f = workspaceFixture(t);
  const modulePath = path.join(__dirname, '..', 'lib/codex/runtime-profile.js');
  for (const mode of [0o700, 0o755]) {
    const anchor = f.codexHome + '-' + mode;
    const script = `
      const fs = require('node:fs');
      const original = fs.mkdirSync;
      const container = process.argv[2] + '.workspaces';
      fs.mkdirSync = (target, options) => {
        if (target === container) {
          original(target, { mode: Number(process.argv[4]) });
          const error = new Error('another daemon created the container');
          error.code = 'EEXIST';
          throw error;
        }
        return original(target, options);
      };
      const { selectCodexWorkspaceHome } = require(process.argv[1]);
      try {
        selectCodexWorkspaceHome({ codexHome: process.argv[2], workspace: process.argv[3] }, { create: true });
        process.exit(Number(process.argv[4]) === 448 ? 0 : 2);
      } catch { process.exit(Number(process.argv[4]) === 493 ? 0 : 3); }
    `;
    const result = spawnSync(process.execPath, ['-e', script, modulePath, anchor, f.workspaces[0], String(mode)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `container mode ${mode.toString(8)}: ${result.stderr}`);
  }
});
