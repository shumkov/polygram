/**
 * Tests for lib/pairings.js
 * Run: node --test tests/pairings.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const {
  createStore, generateCode, normalizeCode, parseTtl,
  DEFAULT_TTL_MS, MAX_TTL_MS, MIN_TTL_MS,
  ISSUE_RATE_PER_OPERATOR_PER_HOUR, CLAIM_RATE_PER_USER_PER_HOUR,
} = require('../lib/pairings');

let db, dbPath, store;
let fakeNow;

function setup() {
  ({ db, dbPath } = freshDb('pairings-test'));
  fakeNow = 1_700_000_000_000;
  store = createStore(db.raw, () => fakeNow);
}

function cleanup() {
  cleanupDb(dbPath, db);
  db = null;
}

describe('generateCode', () => {
  test('produces 8 chars from the Crockford-ish alphabet', () => {
    const c = generateCode();
    assert.equal(c.length, 8);
    assert.match(c, /^[2-9A-HJ-NP-TV-Z]{8}$/);
  });

  test('variable length supported', () => {
    assert.equal(generateCode(4).length, 4);
    assert.equal(generateCode(16).length, 16);
  });

  test('effectively unique across a small batch', () => {
    const set = new Set();
    for (let i = 0; i < 1000; i++) set.add(generateCode());
    assert.equal(set.size, 1000);
  });
});

describe('normalizeCode', () => {
  test('uppercases + strips whitespace and dashes', () => {
    assert.equal(normalizeCode('k7 m2-p4vq'), 'K7M2P4VQ');
    assert.equal(normalizeCode('  ABCD1234 '), 'ABCD1234');
  });

  test('null/undefined gives empty string', () => {
    assert.equal(normalizeCode(null), '');
    assert.equal(normalizeCode(undefined), '');
  });
});

describe('parseTtl', () => {
  test('default is 10 minutes', () => {
    assert.equal(parseTtl(null), DEFAULT_TTL_MS);
    assert.equal(parseTtl(undefined), DEFAULT_TTL_MS);
  });

  test('numeric is clamped to [MIN, MAX]', () => {
    assert.equal(parseTtl(1000), MIN_TTL_MS);
    assert.equal(parseTtl(DEFAULT_TTL_MS), DEFAULT_TTL_MS);
    assert.equal(parseTtl(9_999_999_999_999), MAX_TTL_MS);
  });

  test('string shorthand: 10m, 1h, 7d', () => {
    assert.equal(parseTtl('10m'), 10 * 60_000);
    assert.equal(parseTtl('1h'), 3_600_000);
    assert.equal(parseTtl('7d'), 7 * 86_400_000);
  });

  test('too-short throws', () => {
    // `s` unit no longer parsed — MIN_TTL_MS is 1m so `s` was always dead code.
    assert.throws(() => parseTtl('10s'), /invalid ttl/);
  });

  test('too-long throws', () => {
    assert.throws(() => parseTtl('30d'), /too long/);
  });

  test('bad format throws', () => {
    assert.throws(() => parseTtl('abc'), /invalid ttl/);
    assert.throws(() => parseTtl('10y'), /invalid ttl/);
  });
});

describe('issueCode', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('issues a fresh code with expected shape', () => {
    const out = store.issueCode({
      bot_name: 'shumabit',
      issued_by_user_id: 42,
      ttlMs: DEFAULT_TTL_MS,
      note: 'test',
    });
    assert.equal(out.bot_name, 'shumabit');
    assert.equal(out.note, 'test');
    assert.match(out.code, /^[2-9A-HJ-NP-TV-Z]{8}$/);
    assert.equal(out.issued_ts, fakeNow);
    assert.equal(out.expires_ts, fakeNow + DEFAULT_TTL_MS);
  });

  test('scopes to a chat when chat_id provided', () => {
    const out = store.issueCode({
      bot_name: 'shumabit',
      chat_id: '-100123',
      scope: 'chat',
      issued_by_user_id: 1,
    });
    assert.equal(out.chat_id, '-100123');
    assert.equal(out.scope, 'chat');
  });

  test('rejects missing bot_name', () => {
    assert.throws(() => store.issueCode({ issued_by_user_id: 1 }), /bot_name required/);
  });

  test('rejects non-numeric issuer', () => {
    assert.throws(() => store.issueCode({ bot_name: 'x' }), /issued_by_user_id required/);
  });

  test('rejects bad scope', () => {
    assert.throws(
      () => store.issueCode({ bot_name: 'x', issued_by_user_id: 1, scope: 'admin' }),
      /bad scope/,
    );
  });

  test('enforces rate limit per operator per hour', () => {
    for (let i = 0; i < ISSUE_RATE_PER_OPERATOR_PER_HOUR; i++) {
      store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    }
    assert.throws(
      () => store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 }),
      /rate limit/,
    );
  });

  test('rate limit is per-operator, not global', () => {
    for (let i = 0; i < ISSUE_RATE_PER_OPERATOR_PER_HOUR; i++) {
      store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    }
    // Different operator — should succeed.
    const out = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 2 });
    assert.match(out.code, /^[2-9A-HJ-NP-TV-Z]{8}$/);
  });
});

describe('claimCode', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('happy path: claim → pairing row exists', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 42, note: 'Dao' });
    const res = store.claimCode({
      code, claimer_user_id: 999, chat_id: '-100', bot_name: 'shumabit',
    });
    assert.equal(res.ok, true);
    assert.equal(res.bot_name, 'shumabit');
    assert.equal(res.note, 'Dao');

    const paired = store.hasLivePairing({
      bot_name: 'shumabit', user_id: 999, chat_id: '-100',
    });
    assert.equal(paired, true);
  });

  test('rejects unknown code', () => {
    const res = store.claimCode({
      code: 'AAAAAAAA', claimer_user_id: 1, chat_id: '-100', bot_name: 'shumabit',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-found');
  });

  test('rejects already-used code', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code, claimer_user_id: 2, chat_id: '-100', bot_name: 'shumabit' });
    const res = store.claimCode({ code, claimer_user_id: 3, chat_id: '-100', bot_name: 'shumabit' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'already-used');
  });

  test('rejects expired code', () => {
    const { code } = store.issueCode({
      bot_name: 'shumabit', issued_by_user_id: 1, ttlMs: MIN_TTL_MS,
    });
    fakeNow += MIN_TTL_MS + 1;
    const res = store.claimCode({ code, claimer_user_id: 2, chat_id: '-100', bot_name: 'shumabit' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  test('rejects wrong bot', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const res = store.claimCode({
      code, claimer_user_id: 2, chat_id: '-100', bot_name: 'umi-assistant',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'wrong-bot');
  });

  test('rejects wrong chat when code is chat-scoped', () => {
    const { code } = store.issueCode({
      bot_name: 'shumabit', chat_id: '-100', scope: 'chat', issued_by_user_id: 1,
    });
    const res = store.claimCode({
      code, claimer_user_id: 2, chat_id: '-200', bot_name: 'shumabit',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'wrong-chat');
  });

  test('code usable in any chat when not chat-scoped', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const res = store.claimCode({
      code, claimer_user_id: 2, chat_id: '-999', bot_name: 'shumabit',
    });
    assert.equal(res.ok, true);
  });

  test('normalises whitespace/case in user input', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const messy = code.toLowerCase().match(/.{1,4}/g).join('-');
    const res = store.claimCode({
      code: ` ${messy} `, claimer_user_id: 2, chat_id: '-1', bot_name: 'shumabit',
    });
    assert.equal(res.ok, true);
  });

  test('enforces rate limit per claimer', () => {
    for (let i = 0; i < CLAIM_RATE_PER_USER_PER_HOUR; i++) {
      const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
      store.claimCode({ code, claimer_user_id: 5, chat_id: '-1', bot_name: 'shumabit' });
    }
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const res = store.claimCode({ code, claimer_user_id: 5, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'rate-limited');
  });

  test('failed claim attempts count toward the rate limit (0.6.15)', () => {
    // Pre-0.6.15 the rate-limit query only counted SUCCESSFUL claims
    // (used_ts IS NOT NULL), so an attacker could probe wrong codes
    // indefinitely. Now every claim call — including wrong-code probes
    // that return not-found — burns quota.
    for (let i = 0; i < CLAIM_RATE_PER_USER_PER_HOUR; i++) {
      const r = store.claimCode({
        code: 'BADCODE1', claimer_user_id: 6, chat_id: '-1', bot_name: 'shumabit',
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not-found');
    }
    // A real, valid code now bounces with 'rate-limited' even though
    // the user has not yet successfully claimed anything.
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const res = store.claimCode({ code, claimer_user_id: 6, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'rate-limited');
  });

  test('rate limit bucket prunes entries older than the window', () => {
    // The in-memory bucket evicts attempts older than the 1h window on
    // every check. Simulate by stubbing `now` to advance past the
    // window between the burst and the next call.
    let t = 1_000_000_000_000;
    const advancingStore = createStore(db.raw, () => t);
    for (let i = 0; i < CLAIM_RATE_PER_USER_PER_HOUR; i++) {
      advancingStore.claimCode({
        code: 'BAD', claimer_user_id: 7, chat_id: '-1', bot_name: 'shumabit',
      });
    }
    // Advance past the 1-hour window — old attempts should age out.
    t += 60 * 60 * 1000 + 1;
    const r = advancingStore.claimCode({
      code: 'BAD', claimer_user_id: 7, chat_id: '-1', bot_name: 'shumabit',
    });
    assert.equal(r.reason, 'not-found', 'should NOT be rate-limited after window');
  });
});

describe('hasLivePairing', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('any-chat pairing is live for every chat in the bot', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code, claimer_user_id: 77, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 77, chat_id: '-1' }), true);
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 77, chat_id: '-2' }), true);
  });

  test('chat-scoped pairing is only live in that chat', () => {
    const { code } = store.issueCode({
      bot_name: 'shumabit', chat_id: '-1', scope: 'chat', issued_by_user_id: 1,
    });
    store.claimCode({ code, claimer_user_id: 88, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 88, chat_id: '-1' }), true);
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 88, chat_id: '-2' }), false);
  });

  test('pairings are bot-scoped', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code, claimer_user_id: 99, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.hasLivePairing({
      bot_name: 'umi-assistant', user_id: 99, chat_id: '-1',
    }), false);
  });

  test('revoked pairings are not live', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code, claimer_user_id: 11, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 11, chat_id: '-1' }), true);
    store.revokeByUser({ bot_name: 'shumabit', user_id: 11 });
    assert.equal(store.hasLivePairing({ bot_name: 'shumabit', user_id: 11, chat_id: '-1' }), false);
  });
});

describe('revokeByUser + listActive', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('revoke returns number of rows touched', () => {
    const c1 = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    const c2 = store.issueCode({
      bot_name: 'shumabit', chat_id: '-1', scope: 'chat', issued_by_user_id: 1,
    });
    store.claimCode({ code: c1.code, claimer_user_id: 5, chat_id: '-1', bot_name: 'shumabit' });
    store.claimCode({ code: c2.code, claimer_user_id: 5, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.revokeByUser({ bot_name: 'shumabit', user_id: 5 }), 2);
    assert.equal(store.revokeByUser({ bot_name: 'shumabit', user_id: 5 }), 0);
  });

  test('listActive excludes revoked', () => {
    const { code } = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code, claimer_user_id: 42, chat_id: '-1', bot_name: 'shumabit' });
    assert.equal(store.listActive('shumabit').length, 1);
    store.revokeByUser({ bot_name: 'shumabit', user_id: 42 });
    assert.equal(store.listActive('shumabit').length, 0);
  });

  test('re-claim after revoke unrevokes existing row (no duplicate)', () => {
    const c1 = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code: c1.code, claimer_user_id: 55, chat_id: '-1', bot_name: 'shumabit' });
    store.revokeByUser({ bot_name: 'shumabit', user_id: 55 });
    const c2 = store.issueCode({ bot_name: 'shumabit', issued_by_user_id: 1 });
    store.claimCode({ code: c2.code, claimer_user_id: 55, chat_id: '-1', bot_name: 'shumabit' });
    const active = store.listActive('shumabit');
    assert.equal(active.length, 1);
  });
});
