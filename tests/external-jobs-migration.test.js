'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { open } = require('../lib/db');

test('unpublished incident schema is refused before version early return without dropping old data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec("CREATE TABLE infra_incidents(id TEXT); INSERT INTO infra_incidents VALUES ('preserve'); PRAGMA user_version=22");
  old.close();
  assert.throws(() => open(file), /unpublished infrastructure schema/);
  const readback = new Database(file, { readonly: true });
  assert.deepEqual(readback.prepare('SELECT * FROM infra_incidents').all(), [{ id: 'preserve' }]);
  assert.equal(readback.pragma('user_version', { simple: true }), 22);
  readback.close();
});
