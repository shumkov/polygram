'use strict';

/**
 * Tests for lib/context-usage.js — reading live context occupancy from a
 * Claude Code session transcript (JSONL), used by the per-chat compaction
 * warning (0.12.0-rc.13). The number drives "you're ~N% full, run /compact"
 * BEFORE claude auto-compacts mid-turn and detaches the channels bridge.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readContextTokens, contextPct, DEFAULT_WINDOW_TOKENS } = require('@shumkov/orchestra').contextUsage;

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-ctx-usage-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { p, dir };
}

function asst(usage, extra = {}) {
  return { type: 'assistant', message: { role: 'assistant', usage }, ...extra };
}

test('readContextTokens: returns the LAST main-thread assistant usage (input + cache_read + cache_creation)', async () => {
  const { p, dir } = writeFixture([
    asst({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    { type: 'user', message: { role: 'user' } },
    asst({ input_tokens: 5, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000 }), // the live one
  ]);
  const got = await readContextTokens(p);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.ok(got, 'must find a usage frame');
  assert.equal(got.total, 5 + 150000 + 2000, 'total = input + cache_read + cache_creation of the last main-thread turn');
  assert.equal(got.cacheReadTokens, 150000);
});

test('readContextTokens: SKIPS sidechain (subagent) frames even when they have larger usage', async () => {
  const { p, dir } = writeFixture([
    asst({ input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 }), // main-thread, the answer
    // A subagent frame APPENDED after — huge usage, but isSidechain → must be ignored,
    // else a brief subagent would spike the parent's apparent context and false-warn.
    asst({ input_tokens: 9, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0 }, { isSidechain: true }),
  ]);
  const got = await readContextTokens(p);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(got.total, 5 + 90000, 'sidechain frame must not be counted; last MAIN-THREAD frame wins');
});

test('readContextTokens: skips zero-usage frames (subagent shells / degenerate rows)', async () => {
  const { p, dir } = writeFixture([
    asst({ input_tokens: 7, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 }),
    asst({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), // degenerate — skip
  ]);
  const got = await readContextTokens(p);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(got.total, 7 + 80000, 'an all-zero usage frame must not clobber the real last value');
});

test('readContextTokens: null for missing file / no usable frame / bad JSON lines', async () => {
  assert.equal(await readContextTokens('/nonexistent/transcript.jsonl'), null);
  assert.equal(await readContextTokens(null), null);

  const { p, dir } = writeFixture([
    'not json at all',
    { type: 'user', message: { role: 'user' } },
    '{ truncated',
  ]);
  const got = await readContextTokens(p);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(got, null, 'no assistant usage frame → null (bad lines skipped, not thrown)');
});

test('contextPct: fraction of the window, default 200k', async () => {
  assert.equal(DEFAULT_WINDOW_TOKENS, 200000);
  assert.equal(contextPct(150000), 0.75);
  assert.equal(contextPct(100000, 200000), 0.5);
  assert.equal(contextPct(0), 0, 'zero/negative tokens → 0, never NaN');
  assert.equal(contextPct(50000, 0), 0, 'zero window → 0, never Infinity');
});
