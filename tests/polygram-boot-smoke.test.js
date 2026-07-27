'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Boot smoke test. polygram.js auto-runs main() on load and wires the message
// handlers (createDispatcher, createEditRedelivery, createSlashCommands, ...)
// SYNCHRONOUSLY, before any network call. A ReferenceError in that wiring is a
// FATAL boot crash that NO other test catches — the unit tests exercise each
// factory in isolation with deps passed in, and nothing else boots the real
// entrypoint. This regression guards the rc.34 incident: edit-redelivery's
// factory (built in main()) referenced `mentionRe` / `botUsername`, which are
// createBot-scoped locals → `ReferenceError: mentionRe is not defined` killed
// the daemon at boot. The fix passes them at call time.
//
// Spawns the real polygram.js with a minimal config and asserts it reaches the
// post-wiring marker without a ReferenceError. A fake token makes getMe 401
// AFTER the wiring — irrelevant to what we assert.
test('polygram.js boots through handler wiring without a ReferenceError', { timeout: 25000 }, async () => {
  // The production IPC boundary deliberately rejects temporary roots.
  // Use a short owner-only directory under the test user's home so this
  // smoke test exercises the same secure runtime-directory path.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.polygram-boot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    bots: { testbot: { token: '123:FAKE', pm: 'sdk' } },
    chats: { 1001: { name: 'Test', bot: 'testbot', model: 'sonnet', effort: 'medium', agent: 'default', cwd: '/tmp' } },
    defaults: { model: 'sonnet', effort: 'medium', timeout: 1800 },
  }));

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'polygram.js'), '--bot', 'testbot'], {
    cwd: dir,                                           // DATA_DIR = process.cwd()
    env: {
      ...process.env,
      POLYGRAM_CLAUDE_BIN: '/usr/bin/echo',
      POLYGRAM_IPC_DIR: path.join(dir, '.ipc'),
    },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  // The marker logs at polygram.js:2537, right AFTER the handler wiring.
  const MARKER = 'using SDK ProcessManager';
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    proc.on('exit', finish);
    const iv = setInterval(() => {
      if (out.includes(MARKER) || /ReferenceError/.test(out)) { clearInterval(iv); finish(); }
    }, 50);
    setTimeout(() => { clearInterval(iv); finish(); }, 15000);
  });
  try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  fs.rmSync(dir, { recursive: true, force: true });

  assert.doesNotMatch(out, /ReferenceError|is not defined/,
    `boot threw a ReferenceError during handler wiring:\n${out.slice(-1200)}`);
  assert.ok(out.includes(MARKER),
    `boot did not reach the post-wiring marker "${MARKER}" — it crashed before handler wiring completed:\n${out.slice(-1200)}`);
});
