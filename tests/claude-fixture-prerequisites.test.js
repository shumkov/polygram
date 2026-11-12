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
