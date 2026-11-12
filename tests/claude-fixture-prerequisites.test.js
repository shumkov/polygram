'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('isolated CLI consent is included locally without changing an existing settings file', async (t) => {
  const { writeFixtureConsent } = await import('../scripts/spikes/cli-fixture-prerequisites.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-consent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  const file = writeFixtureConsent({ cwd, fixtureRoot: root });
  assert.equal(file, path.join(cwd, '.claude', 'settings.local.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { skipDangerousModePermissionPrompt: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeFixtureConsent({ cwd, fixtureRoot: root }), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { skipDangerousModePermissionPrompt: true });
});

test('fixture consent rejects cwd and settings-directory escapes', async (t) => {
  const { writeFixtureConsent } = await import('../scripts/spikes/cli-fixture-prerequisites.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-consent-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-outside-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  assert.throws(() => writeFixtureConsent({ cwd: outside, fixtureRoot: root }), /inside the fixture root/);
  assert.throws(() => writeFixtureConsent({ cwd: root, fixtureRoot: root }), /inside the fixture root/);
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  fs.symlinkSync(outside, path.join(cwd, '.claude'));
  assert.throws(() => writeFixtureConsent({ cwd, fixtureRoot: root }), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'settings.local.json')), false);
});

test('explicit Channels absence is a prerequisite error and silence is not fabricated success', async () => {
  const { rejectUnavailableChannels } = await import('../scripts/spikes/cli-fixture-prerequisites.mjs');
  for (const text of ['Channels are not currently available', 'Channels are not available on third-party providers', 'channels not enabled by org policy']) {
    assert.throws(() => rejectUnavailableChannels(text), { code: 'CHANNELS_FIXTURE_UNAVAILABLE' });
  }
  assert.equal(rejectUnavailableChannels('unknown startup output'), undefined);
});

test('every isolated matrix CLI workspace includes consent before registration and first launch', () => {
  for (const file of ['cli-contract-matrix.mjs', 'workflow-autonomous-completion.mjs', 'system-prompt-snapshot.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/spikes', file), 'utf8');
    const call = source.indexOf('writeFixtureConsent({');
    const registration = source.indexOf('registerGateSessionProject(selection,', call);
    assert.ok(call >= 0 && registration > call, `${file} must include disposable consent before the project can launch`);
  }
});


test('matrix instructions are neutral, private, contained and never overwrite existing files', async (t) => {
  const { writeFixtureInstructions } = await import('../scripts/spikes/cli-fixture-prerequisites.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-instructions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  const file = writeFixtureInstructions({ cwd, fixtureRoot: root });
  assert.equal(file, path.join(cwd, 'CLAUDE.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'This is a synthetic compatibility fixture.\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeFixtureInstructions({ cwd, fixtureRoot: root }), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'This is a synthetic compatibility fixture.\n');
  assert.throws(() => writeFixtureInstructions({ cwd: root, fixtureRoot: root }), /inside the fixture root/);
  const linked = fs.mkdtempSync(path.join(root, 'linked-'));
  fs.symlinkSync(file, path.join(linked, 'CLAUDE.md'));
  assert.throws(() => writeFixtureInstructions({ cwd: linked, fixtureRoot: root }), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'This is a synthetic compatibility fixture.\n');
  for (const driver of ['cli-contract-matrix.mjs', 'workflow-autonomous-completion.mjs', 'system-prompt-snapshot.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/spikes', driver), 'utf8');
    const call = source.indexOf('writeFixtureInstructions({');
    assert.ok(call >= 0 && source.indexOf('registerGateSessionProject(selection,', call) > call, `${driver} must create owned instructions before launch`);
  }
});


test('native-auth local stubs refuse escaped or nonprivate credentials and real inference', async (t) => {
  const { localStubAuthLines } = await import('../scripts/spikes/cli-fixture-prerequisites.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-stub-auth-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const options = { nativeAuth: true, home, isolatedHome: home, model: 'stub' };
  fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
  const file = path.join(home, '.claude', '.credentials.json');
  assert.throws(() => localStubAuthLines(options), /credential/);
  fs.writeFileSync(file, 'synthetic-content-not-read', { mode: 0o600 });
  assert.deepEqual(localStubAuthLines(options), ['unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN']);
  assert.throws(() => localStubAuthLines({ ...options, model: 'real' }), /stub/);
  assert.throws(() => localStubAuthLines({ ...options, isolatedHome: root }), /HOME/);
  fs.chmodSync(home, 0o755);
  assert.throws(() => localStubAuthLines(options), /private/);
  fs.chmodSync(home, 0o700);
  fs.chmodSync(file, 0o644);
  assert.throws(() => localStubAuthLines(options), /credential/);
  fs.chmodSync(file, 0o600);
  const linked = fs.mkdtempSync(path.join(root, 'linked-'));
  fs.symlinkSync(path.join(home, '.claude'), path.join(linked, '.claude'));
  assert.throws(() => localStubAuthLines({ ...options, home: linked, isolatedHome: linked }), /credential/);
  const linkedFileHome = fs.mkdtempSync(path.join(root, 'linked-file-'));
  fs.mkdirSync(path.join(linkedFileHome, '.claude'), { mode: 0o700 });
  fs.symlinkSync(file, path.join(linkedFileHome, '.claude', '.credentials.json'));
  assert.throws(() => localStubAuthLines({ ...options, home: linkedFileHome, isolatedHome: linkedFileHome }), /credential/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-content-not-read');
  assert.deepEqual(localStubAuthLines({ nativeAuth: false }), [
    'unset CLAUDE_CODE_OAUTH_TOKEN', 'export ANTHROPIC_API_KEY=',
    'export ANTHROPIC_AUTH_TOKEN=stub-token-not-a-secret',
  ]);
});

test('local native-auth stubs check isolation before opening a server and keep loopback model routing', () => {
  for (const file of ['cli-api-error-stub.mjs', 'mailbox-two-roles.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/spikes', file), 'utf8');
    const check = source.indexOf('localStubAuthLines({');
    assert.ok(check >= 0 && check < source.indexOf('http.createServer('), `${file} must validate before resources start`);
    assert.match(source, /CLAUDE_GATE_ISOLATED_HOME/);
    assert.match(source, /export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:/);
    assert.match(source, /\.\.\.stubAuthLines/);
  }
});
