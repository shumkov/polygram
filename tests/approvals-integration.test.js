/**
 * Integration: IPC server + approvals store + pattern matcher wired together.
 * Simulates the path without actually talking to Telegram.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createStore: createApprovalsStore, matchesAnyPattern } = require('../lib/approvals');
const ipcServer = require('../lib/ipc-server');
const ipcClient = require('../lib/ipc-client');

const silent = { log: () => {}, error: () => {} };

let db, dbPath, approvals, server, sockPath;
let sentCards = [];
let waiters = new Map();

function cleanup() {
  cleanupDb(dbPath, db);
  db = null;
  waiters.clear();
  sentCards = [];
}

async function setup() {
  ({ db, dbPath } = freshDb('aintg'));
  approvals = createApprovalsStore(db.raw);
  sockPath = path.join(os.tmpdir(), `aintg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);

  const botConfig = {
    approvals: {
      adminChatId: '111111111',
      timeoutMs: 300,
      gatedTools: ['Bash(rm *)', 'mcp__*__invoice_create'],
    },
  };

  const handleApprovalRequest = async (req) => {
    const { bot_name, chat_id, turn_id, tool_name, tool_input } = req;
    if (bot_name !== 'shumabit') return { decision: 'not-gated', reason: 'unknown bot' };
    const gated = matchesAnyPattern(tool_name, tool_input, botConfig.approvals.gatedTools);
    if (!gated.matched) return { decision: 'not-gated' };
    const row = approvals.issue({
      bot_name, turn_id, requester_chat_id: chat_id,
      approver_chat_id: String(botConfig.approvals.adminChatId),
      tool_name, tool_input,
      timeoutMs: botConfig.approvals.timeoutMs,
    });
    // Only send a new card on first issue — dedup'd rows hang on the existing waiter.
    if (!row.reused) {
      sentCards.push({ id: row.id, token: row.callback_token, tool_name, tool_input });
      approvals.setApproverMsgId(row.id, 1000 + row.id);
    }
    return await new Promise((resolve) => {
      const wrapped = (decision, reason) => {
        clearTimeout(timer);
        resolve({ decision, reason });
      };
      const timer = setTimeout(() => {
        const list = waiters.get(row.id);
        if (list) {
          const i = list.indexOf(wrapped);
          if (i !== -1) list.splice(i, 1);
          if (!list.length) waiters.delete(row.id);
        }
        resolve({ decision: 'timeout', reason: 'swept' });
      }, botConfig.approvals.timeoutMs);
      const list = waiters.get(row.id) || [];
      list.push(wrapped);
      waiters.set(row.id, list);
    });
  };

  server = await ipcServer.start({
    path: sockPath,
    handlers: { approval_request: handleApprovalRequest },
    logger: silent,
  });
}

async function teardown() {
  if (server) { await server.close(); server = null; }
  cleanup();
}

function simulateClick(id, decision) {
  const list = waiters.get(id);
  if (!list) return;
  waiters.delete(id);
  for (const fn of list) fn(decision, 'manual');
}

describe('approval integration', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('ungated tool passes through immediately', async () => {
    const res = await ipcClient.call({
      path: sockPath, op: 'approval_request',
      payload: {
        bot_name: 'shumabit', chat_id: '-100',
        tool_name: 'Read', tool_input: { path: '/etc/hosts' },
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.decision, 'not-gated');
    assert.equal(sentCards.length, 0);
  });

  test('gated tool blocks until approved', async () => {
    const promise = ipcClient.call({
      path: sockPath, op: 'approval_request',
      payload: {
        bot_name: 'shumabit', chat_id: '-100',
        tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
      },
    });
    // Wait until the card is sent, then click approve.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sentCards.length, 1);
    simulateClick(sentCards[0].id, 'approved');
    const res = await promise;
    assert.equal(res.decision, 'approved');
  });

  test('gated tool blocks until denied', async () => {
    const promise = ipcClient.call({
      path: sockPath, op: 'approval_request',
      payload: {
        bot_name: 'shumabit', chat_id: '-100',
        tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    simulateClick(sentCards[0].id, 'denied');
    const res = await promise;
    assert.equal(res.decision, 'denied');
  });

  test('gated tool times out when no click arrives', async () => {
    const promise = ipcClient.call({
      path: sockPath, op: 'approval_request',
      callTimeoutMs: 3000,
      payload: {
        bot_name: 'shumabit', chat_id: '-100',
        tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
      },
    });
    const res = await promise;
    assert.equal(res.decision, 'timeout');
  });

  test('dedup: same turn + same input reuses the pending row', async () => {
    const args = {
      bot_name: 'shumabit', chat_id: '-100', turn_id: 'T1',
      tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
    };
    const p1 = ipcClient.call({ path: sockPath, op: 'approval_request', payload: args });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sentCards.length, 1);
    // Second call while first is still pending — should dedup.
    const p2 = ipcClient.call({ path: sockPath, op: 'approval_request', payload: args });
    await new Promise((r) => setTimeout(r, 30));
    // No second card — reused the pending row.
    assert.equal(sentCards.length, 1);
    simulateClick(sentCards[0].id, 'approved');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.decision, 'approved');
    assert.equal(r2.decision, 'approved');
  });
});
