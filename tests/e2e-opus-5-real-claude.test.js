'use strict';

/**
 * E2E — REAL claude turn on Claude Opus 5.
 *
 * The model string a chat configures is never validated by polygram: it is
 * handed verbatim to `--model` at spawn. So the only thing that can prove a
 * chat can actually run Opus 5 is a real turn on the pinned binary — a mocked
 * spawn asserts nothing about whether the CLI accepts the string.
 *
 * Two spawn paths are covered, because they are NOT equivalent:
 *   1. the explicit `claude-opus-5` id — pinned, means Opus 5 on any CLI,
 *   2. the bare `opus` alias — resolved by the CLI, and version-dependent:
 *      2.1.173 resolved it to claude-opus-4-8, the pinned 2.1.220 resolves it
 *      to claude-opus-5. MODEL_VERSIONS_DESC claims the latter on the config
 *      card, and this is what keeps that claim honest.
 *
 * Evidence is the session JSONL's per-message `model` field (what actually
 * served the turn), not the flag we passed (what we asked for).
 *
 * GATED: only runs with E2E_REAL_CLAUDE=1 (spawns real claude, needs the
 * pinned binary + a working subscription/keychain; not for CI). Run with:
 *   E2E_REAL_CLAUDE=1 node --test --test-force-exit tests/e2e-opus-5-real-claude.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess, createTmuxRunner } = require('@shumkov/orchestra');
const { sessionLogPath, parseLine } = require('../lib/util/claude-session-jsonl');
const { MODEL_COSTS } = require('../lib/model-costs');
const { MODEL_VERSIONS_DESC } = require('../lib/handlers/config-ui');

// Same resolution as polygram.js boot: point orchestra at polygram's vendored
// claude-bin dir BEFORE resolving, so this exercises the binary production
// spawns rather than claude's own version store.
if (!process.env.ORCHESTRA_CLAUDE_VENDOR_DIR) {
  process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = path.join(os.homedir(), '.local', 'share', 'polygram', 'claude-bin');
}
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('@shumkov/orchestra').claudeBin;

function resolvePinnedClaudeBin() {
  const r = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION, { logger: console });
  if (!r.ok) throw new Error(`pinned claude bin unavailable: ${r.reason}`);
  return r.path;
}

const RUN = process.env.E2E_REAL_CLAUDE === '1';

const noopStreamer = {
  onChunk: async () => {}, forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {},
};
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };

// The Music-topic cwd, for the same reason the channels e2e uses it: a fresh
// temp dir is untrusted and hits claude's "trust this folder" dialog, which the
// startup gate does not navigate. NEVER rm this path — it is Rekordbox's own
// data directory, not a temp dir.
const CWD = '/Users/ivanshumkov/Music/rekordbox';

/**
 * Which model actually served the turn, per the session JSONL.
 *
 * parseLine yields an ARRAY of events per line; the serving model is carried
 * on the `usage` events, not on the line itself.
 */
function modelsInSession(cwd, sessionId) {
  const logPath = sessionLogPath(cwd, sessionId);
  if (!logPath || !fs.existsSync(logPath)) return [];
  const seen = new Set();
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let events;
    try { events = parseLine(line); } catch { continue; }
    for (const ev of events || []) {
      if (ev && ev.model) seen.add(ev.model);
    }
  }
  return [...seen];
}

async function runTurnOnModel(model) {
  const replies = [];
  const proc = new CliProcess({
    sessionKey: `e2e-opus5:${model}`,
    chatId: '987654321',
    threadId: null,
    label: 'e2e-opus5',
    tmuxRunner: createTmuxRunner(),
    botName: 'e2etest',
    claudeBin: resolvePinnedClaudeBin(),
    toolDispatcher: async ({ toolName, text }) => {
      if (toolName === 'reply') replies.push(text);
      return { ok: true };
    },
    logger: {
      warn: (...a) => console.error('[e2e:warn]', ...a),
      error: (...a) => console.error('[e2e:err]', ...a),
      log: () => {}, debug: () => {},
    },
    db: { logEvent: () => {} },
  });

  const chatConfig = {
    cwd: CWD,
    model,
    permissionMode: 'bypassPermissions',
    isolateUserConfig: true,
  };

  try {
    await proc.start({ cwd: CWD, chatConfig, existingSessionId: null });
    const result = await proc.send('Reply with exactly the single word: PONGTEST', {
      timeoutMs: 120_000,
      maxTurnMs: 150_000,
      context: { streamer: noopStreamer, reactor: noopReactor, threadId: null },
    });
    return {
      replyText: replies.join(' ') + ' ' + (result?.text || ''),
      // proc.model is the flag we passed; models[] is what served the turn.
      spawnModel: proc.model,
      models: modelsInSession(CWD, result?.sessionId),
      result,
    };
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
  }
}

test('e2e: real claude runs a turn on the explicit claude-opus-5 id', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 240_000,
}, async () => {
  const { replyText, spawnModel, models, result } = await runTurnOnModel('claude-opus-5');

  assert.equal(spawnModel, 'claude-opus-5', 'the configured model must reach --model verbatim');
  assert.match(
    replyText, /PONGTEST/i,
    `the turn must complete on Opus 5. result=${JSON.stringify(result).slice(0, 300)}`,
  );
  assert.ok(
    models.includes('claude-opus-5'),
    `the session JSONL must record claude-opus-5 as the serving model, got ${JSON.stringify(models)}`,
  );
  // The cost table must know this model, or turn_metrics silently bills the
  // turn at the Sonnet `default` — the failure mode is invisible in the chat.
  assert.ok(MODEL_COSTS['claude-opus-5'], 'claude-opus-5 must have a MODEL_COSTS entry');
});

test('e2e: the bare `opus` alias resolves to what the config card claims', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 240_000,
}, async () => {
  const { replyText, models } = await runTurnOnModel('opus');

  assert.match(replyText, /PONGTEST/i, 'the `opus` alias must complete a turn');
  assert.ok(
    models.includes(MODEL_VERSIONS_DESC.opus),
    `the config card tells users \`opus\` runs ${MODEL_VERSIONS_DESC.opus}; the pinned `
    + `CLI ${CLAUDE_CLI_PINNED_VERSION} actually served ${JSON.stringify(models)}. `
    + 'Either the pin moved or MODEL_VERSIONS_DESC is stale — the card is lying to users.',
  );
});
