'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, incidentRequest } = require('../scripts/infra');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const enabled of [false, true]) for (const input of ['Maintenance failure', 'Maintenance failure\n' + 'details '.repeat(3000)]) {
  test(`maintenance notification survives ${enabled ? 'spool failure' : 'disabled automation'} with ${input.length} characters`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-notify-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, 'notification');
    const notifier = path.join(dir, 'notify');
    fs.writeFileSync(notifier, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.INFRA_TEST_OUTPUT, Array.from(process.argv[2]).slice(0, 3900).join(''));\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bots: { home: { infraAdmin: {
      enabled, threadId: 2995, notificationCommand: notifier,
    } } } }));
    if (enabled) fs.writeFileSync(path.join(dir, 'infra'), 'not a directory');
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/infra.js'), '--bot', 'home', '--data-dir', dir, '--host', 'mac', '--resource', 'cleanup', 'notify'], {
      input, encoding: 'utf8', env: { ...process.env, INFRA_TEST_OUTPUT: output },
    });
    assert.equal(result.status, enabled ? 1 : 0);
    assert.ok(fs.readFileSync(output, 'utf8').startsWith(Array.from(input).slice(0, 3900).join('')));
    if (enabled && input.length < 3900) assert.match(fs.readFileSync(output, 'utf8'), /investigation delivery unavailable/);
  });
}

test('infra CLI targets an explicit owner and never offers an IPC resume shortcut', () => {
  assert.throws(() => parseArgs(['list']), /bot/);
  const parsed = parseArgs(['--bot', 'home', 'get', 'incident']);
  assert.equal(parsed.bot, 'home');
  assert.deepEqual(incidentRequest(parsed, ''), { op: 'infra_incidents', payload: { action: 'get', incidentId: 'incident' } });
  assert.throws(() => parseArgs(['--bot', 'home', 'resume']), /command/);
});

test('notification reader drains oversized Unicode input while retaining the original sender prefix', async () => {
  const { Readable } = require('node:stream');
  const { readNotification } = require('../scripts/infra');
  const message = '🌊'.repeat(20000);
  const bytes = Buffer.from(message);
  const chunks = [bytes.subarray(0, 3), bytes.subarray(3)];
  const result = await readNotification(Readable.from(chunks));
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 8000);
  assert.equal(Array.from(result.text).slice(0, 3900).join(''), Array.from(message).slice(0, 3900).join(''));
});

test('producer states preserve explicit maintenance recovery without inferring it from text', () => {
  const { maintenanceEvent } = require('../scripts/infra');
  const parsed = parseArgs(['--bot', 'home', '--host', 'mac', '--resource', 'cargo-sweep', '--state', 'CLEAR', 'notify']);
  const event = maintenanceEvent(parsed, 'Disk pressure resolved', 4000);
  assert.equal(event.state, 'CLEAR');
  assert.equal(event.evidence.kind, 'snapshot');
  assert.equal(event.observedAt, 4000);
  assert.throws(() => maintenanceEvent({ ...parsed, state: undefined }, 'Looks healthy'), /state/i);
});
test('incident update reads JSON from stdin and cannot change operation or pause', () => {
  const parsed = parseArgs(['--bot', 'home', 'update']);
  assert.deepEqual(incidentRequest(parsed, '{"incidentId":"x","revision":2,"summary":"checking"}'),
    { op: 'infra_incidents', payload: { action: 'update', incidentId: 'x', revision: 2, summary: 'checking' } });
  assert.throws(() => incidentRequest(parsed, '{"op":"deploy_restart"}'), /field/);
});

test('incident list and history expose bounded continuation cursors', () => {
  assert.equal(incidentRequest(parseArgs(['--bot', 'home', 'list', '--before', '101']), '').payload.before, 101);
  assert.equal(incidentRequest(parseArgs(['--bot', 'home', 'get', 'incident', '--before', '101']), '').payload.before, 101);
  assert.throws(() => parseArgs(['--bot', 'home', 'list', '--before', '-1']), /cursor/);
});
