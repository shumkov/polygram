/**
 * Tests for lib/config.js — the pure-I/O config / sticker / message
 * loaders extracted from polygram.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadConfig,
  saveConfig,
  loadStickers,
  resolveStickersPath,
  isWellFormedMessage,
  isWellFormedCallbackQuery,
} = require('../lib/config');

const silentLogger = { log: () => {}, error: () => {} };

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-config-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('loadConfig', () => {
  test('reads + parses JSON', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ defaults: { model: 'sonnet' }, bots: {} }));
    const cfg = loadConfig(p);
    assert.equal(cfg.defaults.model, 'sonnet');
  });

  test('throws on parse error (caller fails fast)', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{not-json');
    assert.throws(() => loadConfig(p));
  });

  test('throws on missing file', () => {
    assert.throws(() => loadConfig(path.join(tmpDir, 'nonexistent.json')));
  });
});

describe('saveConfig — atomic write + bot-scoped merge', () => {
  test('overwrites OUR bot section, preserves OTHER bots on disk', () => {
    const p = path.join(tmpDir, 'config.json');
    // On-disk has TWO bots; in-memory is filtered to just bot-A.
    fs.writeFileSync(p, JSON.stringify({
      defaults: { model: 'sonnet' },
      bots: {
        'bot-A': { token: 'old-A' },
        'bot-B': { token: 'untouched-B' },
      },
      chats: {},
    }, null, 2));
    saveConfig({
      configPath: p,
      botName: 'bot-A',
      config: { bots: { 'bot-A': { token: 'new-A' } }, chats: {} },
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.bots['bot-A'].token, 'new-A');
    assert.equal(after.bots['bot-B'].token, 'untouched-B',
      'other bot must NOT be clobbered');
  });

  test('merges chat updates without clobbering other chats', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({
      bots: {},
      chats: {
        '111': { name: 'A', model: 'sonnet' },
        '222': { name: 'B', model: 'opus' },
      },
    }, null, 2));
    saveConfig({
      configPath: p,
      botName: 'bot',
      config: { bots: {}, chats: { '111': { name: 'A', model: 'haiku' } } },
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.chats['111'].model, 'haiku', 'updated chat written');
    assert.equal(after.chats['222'].model, 'opus', 'untouched chat preserved');
  });

  test('does NOT touch top-level ops-wide fields (defaults, maxWarmProcesses)', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({
      defaults: { model: 'sonnet', effort: 'high' },
      maxWarmProcesses: 10,
      bots: {},
      chats: {},
    }, null, 2));
    saveConfig({
      configPath: p,
      botName: null,
      // In-memory has stale ops-wide values; saveConfig must not write them.
      config: { defaults: { model: 'opus' }, maxWarmProcesses: 99, bots: {}, chats: {} },
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.defaults.model, 'sonnet');
    assert.equal(after.maxWarmProcesses, 10);
  });

  test('atomic write — temp file is gone after success', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ bots: {}, chats: {} }));
    saveConfig({ configPath: p, botName: 'bot', config: { bots: {}, chats: {} } });
    const tmp = `${p}.tmp.${process.pid}`;
    assert.equal(fs.existsSync(tmp), false, 'temp file removed after rename');
    assert.equal(fs.existsSync(p), true);
  });

  test('preserves separate Claude and Codex runtime choices at bot/chat/topic scopes', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({
      defaults: { model: 'default-claude', effort: 'medium' },
      bots: {
        'bot-A': { token: 'old-A', pm: 'sdk', model: 'bot-claude' },
        'bot-B': { token: 'untouched-B', pm: 'cli' },
      },
      chats: {
        '100': {
          pm: 'sdk',
          model: 'chat-claude',
          effort: 'high',
          topics: {
            '7': { pm: 'sdk', model: 'topic-claude', effort: 'low' },
          },
        },
        '200': { pm: 'cli', model: 'untouched-claude' },
      },
    }, null, 2));

    saveConfig({
      configPath: p,
      botName: 'bot-A',
      config: {
        bots: {
          'bot-A': {
            token: 'old-A',
            pm: 'codex',
            model: 'bot-claude',
            codexModel: 'bot-codex',
            codexEffort: 'xhigh',
          },
        },
        chats: {
          '100': {
            pm: 'codex',
            model: 'chat-claude',
            effort: 'high',
            codexModel: 'chat-codex',
            codexEffort: 'medium',
            topics: {
              '7': {
                pm: 'codex',
                model: 'topic-claude',
                effort: 'low',
                codexModel: 'topic-codex',
                codexEffort: 'high',
              },
            },
          },
        },
      },
    });

    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(after.bots['bot-A'], {
      token: 'old-A',
      pm: 'codex',
      model: 'bot-claude',
      codexModel: 'bot-codex',
      codexEffort: 'xhigh',
    });
    assert.equal(after.bots['bot-B'].pm, 'cli', 'other bot remains untouched');
    assert.deepEqual(after.chats['100'].topics['7'], {
      pm: 'codex',
      model: 'topic-claude',
      effort: 'low',
      codexModel: 'topic-codex',
      codexEffort: 'high',
    });
    assert.equal(after.chats['200'].model, 'untouched-claude',
      'other chat remains untouched');
    assert.equal(after.defaults.model, 'default-claude',
      'ops-wide defaults remain untouched');
  });
});

describe('migration 017 — config runtime changes', () => {
  test('copies every row, admits runtime/pm, rejects unknown fields, and recreates the index', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE config_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          thread_id TEXT,
          field TEXT NOT NULL CHECK(field IN ('model','effort','agent')),
          old_value TEXT,
          new_value TEXT NOT NULL,
          user_id INTEGER,
          user TEXT,
          source TEXT,
          ts INTEGER NOT NULL
        );
        CREATE INDEX idx_config_recent ON config_changes(chat_id, ts DESC);
      `);
      const insert = db.prepare(`
        INSERT INTO config_changes (
          id, chat_id, thread_id, field, old_value, new_value,
          user_id, user, source, ts
        ) VALUES (
          @id, @chat_id, @thread_id, @field, @old_value, @new_value,
          @user_id, @user, @source, @ts
        )
      `);
      insert.run({
        id: 4,
        chat_id: '-100',
        thread_id: null,
        field: 'model',
        old_value: null,
        new_value: 'opus',
        user_id: 1,
        user: 'Ivan',
        source: 'command',
        ts: 1000,
      });
      insert.run({
        id: 9,
        chat_id: '-100',
        thread_id: '7',
        field: 'effort',
        old_value: 'medium',
        new_value: 'high',
        user_id: null,
        user: null,
        source: null,
        ts: 1001,
      });
      const before = db.prepare('SELECT * FROM config_changes ORDER BY id').all();

      const migration = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '017-config-runtime-changes.sql'),
        'utf8',
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      assert.deepEqual(
        db.prepare('SELECT * FROM config_changes ORDER BY id').all(),
        before,
        'migration must preserve every column of every existing row',
      );

      const nextId = db.prepare(`
        INSERT INTO config_changes (
          chat_id, thread_id, field, old_value, new_value, ts
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      nextId.run('-100', '7', 'runtime', 'claude', 'codex', 1002);
      nextId.run('-100', '7', 'pm', 'sdk', 'codex', 1003);

      // Exact write shape retained by a downgraded pre-v17 binary.
      const legacyWriter = db.prepare(`
        INSERT INTO config_changes (
          chat_id, thread_id, field, old_value, new_value,
          user_id, user, source, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      legacyWriter.run(
        '-100',
        '7',
        'model',
        'opus',
        'sonnet',
        1,
        'Ivan',
        'command',
        1004,
      );
      assert.equal(
        db.prepare('SELECT MAX(id) AS id FROM config_changes').get().id,
        12,
        'AUTOINCREMENT sequence continues after explicitly copied ids',
      );
      assert.deepEqual(
        db.prepare(`
          SELECT field, old_value, new_value, source
            FROM config_changes
           WHERE id = 12
        `).get(),
        {
          field: 'model',
          old_value: 'opus',
          new_value: 'sonnet',
          source: 'command',
        },
      );
      assert.throws(
        () => nextId.run('-100', null, 'bogus', null, 'x', 1005),
        /CHECK constraint/,
      );

      const index = db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_config_recent'
      `).get();
      assert.match(index.sql, /config_changes\s*\(\s*chat_id\s*,\s*ts\s+DESC\s*\)/i);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS n FROM sqlite_master
          WHERE type = 'table' AND name = 'config_changes_v17'
        `).get().n,
        0,
      );
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
  });
});

describe('loadStickers', () => {
  test('reads stickers.json + populates both maps', () => {
    const p = path.join(tmpDir, 'stickers.json');
    fs.writeFileSync(p, JSON.stringify({
      stickers: {
        working:  { emoji: '💻', file_id: 'CAACWORK' },
        pumped:   { emoji: '⚡', file_id: 'CAACPUMP' },
        nameless: { file_id: 'CAACNAME' },  // no emoji
      },
    }));
    const { stickerMap, emojiToSticker } = loadStickers(p, { logger: silentLogger });
    assert.equal(stickerMap.working, 'CAACWORK');
    assert.equal(stickerMap.pumped, 'CAACPUMP');
    assert.equal(stickerMap.nameless, 'CAACNAME');
    assert.equal(emojiToSticker['💻'], 'CAACWORK');
    assert.equal(emojiToSticker['⚡'], 'CAACPUMP');
    assert.equal('nameless' in emojiToSticker, false,
      'sticker without emoji does not pollute emojiToSticker');
  });

  test('missing file → empty maps + log', () => {
    const logs = [];
    const { stickerMap, emojiToSticker } = loadStickers(
      path.join(tmpDir, 'absent.json'),
      { logger: { log: (m) => logs.push(m), error: () => {} } },
    );
    assert.deepEqual(stickerMap, {});
    assert.deepEqual(emojiToSticker, {});
    assert.match(logs[0], /No sticker map/);
  });

  test('malformed JSON → empty maps (does not throw)', () => {
    const p = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(p, '{not-json');
    const { stickerMap } = loadStickers(p, { logger: silentLogger });
    assert.deepEqual(stickerMap, {});
  });

  test('empty stickers map produces empty maps without throwing', () => {
    const p = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(p, JSON.stringify({ stickers: {} }));
    const { stickerMap } = loadStickers(p, { logger: silentLogger });
    assert.deepEqual(stickerMap, {});
  });
});

describe('resolveStickersPath — per-bot sticker set selection', () => {
  const DATA = '/data';

  test('default: no per-bot config, no env → shared <dataDir>/stickers.json', () => {
    assert.equal(resolveStickersPath({ dataDir: DATA }), '/data/stickers.json');
  });

  test('per-bot RELATIVE stickersPath resolves against dataDir (the umi-assistant case)', () => {
    assert.equal(
      resolveStickersPath({ botConfig: { stickersPath: 'umi-assistant-stickers.json' }, dataDir: DATA }),
      '/data/umi-assistant-stickers.json',
    );
  });

  test('per-bot ABSOLUTE stickersPath is used as-is', () => {
    assert.equal(
      resolveStickersPath({ botConfig: { stickersPath: '/opt/umi/stickers.json' }, dataDir: DATA }),
      '/opt/umi/stickers.json',
    );
  });

  test('per-bot config WINS over the env override', () => {
    assert.equal(
      resolveStickersPath({ botConfig: { stickersPath: 'umi.json' }, dataDir: DATA, envPath: '/env/x.json' }),
      '/data/umi.json',
    );
  });

  test('env override applies when no per-bot stickersPath', () => {
    assert.equal(
      resolveStickersPath({ botConfig: { model: 'sonnet' }, dataDir: DATA, envPath: '/env/x.json' }),
      '/env/x.json',
    );
  });

  test('empty/falsy per-bot stickersPath falls through to env/default (no accidental cwd)', () => {
    assert.equal(resolveStickersPath({ botConfig: { stickersPath: '' }, dataDir: DATA }), '/data/stickers.json');
  });
});

describe('isWellFormedMessage', () => {
  test('valid Telegram message → true', () => {
    assert.equal(isWellFormedMessage({
      chat: { id: 12345 }, message_id: 1, text: 'hi',
    }), true);
  });

  test('bigint chat.id (large group) accepted', () => {
    assert.equal(isWellFormedMessage({
      chat: { id: 999999999999n }, message_id: 1,
    }), true);
  });

  test('null / undefined → false', () => {
    assert.equal(isWellFormedMessage(null), false);
    assert.equal(isWellFormedMessage(undefined), false);
  });

  test('missing chat → false', () => {
    assert.equal(isWellFormedMessage({ message_id: 1 }), false);
  });

  test('missing chat.id → false', () => {
    assert.equal(isWellFormedMessage({ chat: {}, message_id: 1 }), false);
  });

  test('missing message_id → false', () => {
    assert.equal(isWellFormedMessage({ chat: { id: 1 } }), false);
  });

  test('chat.id as string → false (defends against type drift)', () => {
    assert.equal(isWellFormedMessage({ chat: { id: '123' }, message_id: 1 }), false);
  });

  test('message_id as string → false', () => {
    assert.equal(isWellFormedMessage({ chat: { id: 1 }, message_id: '1' }), false);
  });
});

describe('isWellFormedCallbackQuery', () => {
  const ok = {
    id: 'cb1',
    from: { id: 42 },
    data: 'cfg:model:sonnet',
    message: { chat: { id: 100 }, message_id: 5 },
  };

  test('valid callback_query → true', () => {
    assert.equal(isWellFormedCallbackQuery(ok), true);
  });

  test('null / undefined → false', () => {
    assert.equal(isWellFormedCallbackQuery(null), false);
    assert.equal(isWellFormedCallbackQuery(undefined), false);
  });

  test('missing id → false', () => {
    const cb = { ...ok, id: undefined };
    assert.equal(isWellFormedCallbackQuery(cb), false);
  });

  test('missing from.id → false', () => {
    assert.equal(isWellFormedCallbackQuery({ ...ok, from: {} }), false);
  });

  test('missing data → false', () => {
    assert.equal(isWellFormedCallbackQuery({ ...ok, data: undefined }), false);
  });

  test('inline-mode (inline_message_id, no message) → false', () => {
    const cb = {
      id: 'cb1',
      from: { id: 42 },
      data: 'cfg:model:sonnet',
      inline_message_id: 'inline-xyz',
    };
    assert.equal(isWellFormedCallbackQuery(cb), false);
  });

  test('message present but malformed → false', () => {
    assert.equal(isWellFormedCallbackQuery({
      ...ok, message: { chat: {}, message_id: 5 },
    }), false);
  });

  test('numeric id (Telegram sometimes sends as number) → true', () => {
    assert.equal(isWellFormedCallbackQuery({ ...ok, id: 12345 }), true);
  });
});
