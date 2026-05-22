'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.resolve(__dirname, '../lib/process/polygram-hook-append.js');

function tmpfile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hook-append-')),
    'evts.ndjson',
  );
}

function runHelper(out, stdin) {
  return spawnSync(process.execPath, [HELPER, out], {
    input: stdin,
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('polygram-hook-append', () => {
  test('appends one compacted line with a polygram_received_at_ms stamp', () => {
    const out = tmpfile();
    const before = Date.now();
    const res = runHelper(out, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }));
    const after = Date.now();
    assert.equal(res.status, 0, res.stderr);
    const content = fs.readFileSync(out, 'utf8');
    assert.match(content, /\n$/, 'must end with a newline (ndjson invariant)');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.hook_event_name, 'Stop');
    assert.equal(parsed.stop_hook_active, false);
    assert.ok(parsed.polygram_received_at_ms >= before);
    assert.ok(parsed.polygram_received_at_ms <= after);
  });

  test('appends — not overwrites — across multiple invocations', () => {
    const out = tmpfile();
    runHelper(out, JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: 'A' }));
    runHelper(out, JSON.stringify({ hook_event_name: 'PostToolUse', tool_use_id: 'A' }));
    runHelper(out, JSON.stringify({ hook_event_name: 'Stop' }));
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).hook_event_name, 'PreToolUse');
    assert.equal(JSON.parse(lines[1]).hook_event_name, 'PostToolUse');
    assert.equal(JSON.parse(lines[2]).hook_event_name, 'Stop');
  });

  test('non-JSON stdin is wrapped with polygram_parse_error (never silent-dropped)', () => {
    const out = tmpfile();
    const res = runHelper(out, 'not json at all');
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8').trim());
    assert.ok(parsed.polygram_parse_error);
    assert.equal(parsed.raw, 'not json at all');
    assert.ok(parsed.polygram_received_at_ms > 0);
  });

  test('missing argv[2] exits non-zero', () => {
    const res = spawnSync(process.execPath, [HELPER], {
      input: '{}', encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /missing ndjson path/);
  });

  test('the line is compact JSON (no embedded newlines that would corrupt ndjson framing)', () => {
    const out = tmpfile();
    // tool_input with literal newlines — claude embeds these in pasted code.
    runHelper(out, JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_input: { command: 'echo line1\nline2\nline3' },
    }));
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'embedded \\n must not split the appended record');
    assert.match(JSON.parse(lines[0]).tool_input.command, /line1\nline2\nline3/);
  });
});
