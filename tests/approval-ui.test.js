/**
 * Tests for lib/approval-ui.js — pure UI builders for the approval
 * flow's Telegram surface. These functions feed `tg.sendMessage`
 * and `tg.editMessageText`; bugs here = users can't see/use
 * the approval card.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApprovalKeyboardWithAlways,
  formatToolInputForCard,
  approvalCardText,
  _safeParse,
} = require('../lib/approval-ui');

describe('buildApprovalKeyboardWithAlways — 4-button (SDK canUseTool)', () => {
  test('produces TWO rows of buttons', () => {
    const kb = buildApprovalKeyboardWithAlways(42, 'tok');
    assert.equal(kb.inline_keyboard.length, 2);
    assert.equal(kb.inline_keyboard[0].length, 2);
    assert.equal(kb.inline_keyboard[1].length, 2);
  });

  test('row 1 is one-time approve/deny', () => {
    const kb = buildApprovalKeyboardWithAlways(7, 't');
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'approve:7:t');
    assert.equal(kb.inline_keyboard[0][1].callback_data, 'deny:7:t');
  });

  test('row 2 carries always-* callbacks', () => {
    const kb = buildApprovalKeyboardWithAlways(7, 't');
    assert.equal(kb.inline_keyboard[1][0].callback_data, 'approve-always:7:t');
    assert.equal(kb.inline_keyboard[1][1].callback_data, 'deny-always:7:t');
  });

  test('always-* button labels include 🔁 / 🚫 distinctions', () => {
    const kb = buildApprovalKeyboardWithAlways(1, 'x');
    assert.match(kb.inline_keyboard[1][0].text, /Always allow/);
    assert.match(kb.inline_keyboard[1][1].text, /Always deny/);
  });
});

describe('formatToolInputForCard — clipping policy', () => {
  test('short string passes through verbatim', () => {
    const out = formatToolInputForCard('ls -la');
    assert.equal(out, 'ls -la');
  });

  test('object is JSON.stringified with indent=2', () => {
    const out = formatToolInputForCard({ command: 'ls', cwd: '/tmp' });
    assert.match(out, /"command":/);
    assert.match(out, /"cwd":/);
    assert.match(out, /\n/);                    // pretty-printed
  });

  test('inputs ≤ 1200 chars are not clipped', () => {
    const s = 'x'.repeat(1200);
    assert.equal(formatToolInputForCard(s), s);
  });

  test('inputs > 1200 chars get clipped with marker', () => {
    const s = 'a'.repeat(1500) + 'TAIL';
    const out = formatToolInputForCard(s);
    assert.match(out, /\[clipped\]/);
    assert.equal(out.length < s.length, true);
    // The tail is preserved (last 200 chars).
    assert.match(out, /TAIL/);
    // Head is preserved (first 900 chars).
    assert.match(out.slice(0, 900), /^a{900}$/);
  });

  test('non-string non-object falls back to String()', () => {
    assert.equal(formatToolInputForCard(42), '42');
    assert.equal(formatToolInputForCard(null), 'null');
    assert.equal(formatToolInputForCard(undefined), 'undefined');
  });

  test('circular object falls back gracefully', () => {
    const circ = { a: 1 };
    circ.self = circ;
    const out = formatToolInputForCard(circ);
    // Should be SOME string (didn't throw), even if uninformative.
    assert.equal(typeof out, 'string');
  });
});

describe('approvalCardText — heading + body + footer', () => {
  function baseRow(overrides = {}) {
    return {
      tool_name: 'Bash',
      turn_id: 'turn-42',
      requester_chat_id: '12345',
      tool_input_json: '{"command":"ls /tmp"}',
      timeout_ts: Date.now() + 30_000,
      ...overrides,
    };
  }

  test('default heading is "Approval needed — <tool>"', () => {
    const row = baseRow();
    const out = approvalCardText(row);
    assert.match(out, /^Approval needed — Bash/);
  });

  test('resolvedBy override replaces heading and drops footer', () => {
    const row = baseRow();
    const out = approvalCardText(row, { resolvedBy: '✓ Approved by ivan' });
    assert.match(out, /^✓ Approved by ivan/);
    assert.equal(out.includes('expires in'), false);
  });

  test('footer shows seconds-to-expire when not resolved', () => {
    const fixedNow = 1_700_000_000_000;
    const row = baseRow({ timeout_ts: fixedNow + 25_000 });
    const out = approvalCardText(row, { now: () => fixedNow });
    assert.match(out, /⏱ expires in 25s/);
  });

  test('footer shows 0s for already-expired rows', () => {
    const fixedNow = 1_700_000_000_000;
    const row = baseRow({ timeout_ts: fixedNow - 5_000 });
    const out = approvalCardText(row, { now: () => fixedNow });
    assert.match(out, /⏱ expires in 0s/);
  });

  test('chat_id and turn_id appear in body', () => {
    const row = baseRow({ requester_chat_id: '99999', turn_id: 't-77' });
    const out = approvalCardText(row);
    assert.match(out, /Chat: 99999/);
    assert.match(out, /Turn: t-77/);
  });

  test('null turn_id renders as "-"', () => {
    const row = baseRow({ turn_id: null });
    const out = approvalCardText(row);
    assert.match(out, /Turn: -/);
  });

  test('parses tool_input_json string into object before formatting', () => {
    const row = baseRow({ tool_input_json: '{"command":"git status"}' });
    const out = approvalCardText(row);
    assert.match(out, /"command":/);
    assert.match(out, /"git status"/);
  });

  test('accepts pre-parsed object via tool_input_json', () => {
    const row = baseRow({ tool_input_json: { command: 'pwd' } });
    const out = approvalCardText(row);
    assert.match(out, /"command":/);
    assert.match(out, /"pwd"/);
  });

  test('falls back to tool_input field when tool_input_json missing', () => {
    const row = {
      tool_name: 'Read',
      turn_id: 't',
      requester_chat_id: '1',
      tool_input: { file_path: '/etc/hosts' },
      timeout_ts: Date.now() + 30_000,
    };
    const out = approvalCardText(row);
    assert.match(out, /"file_path":/);
    assert.match(out, /\/etc\/hosts/);
  });

  test('malformed JSON in tool_input_json renders as raw string', () => {
    const row = baseRow({ tool_input_json: '{bad-json' });
    const out = approvalCardText(row);
    assert.match(out, /\{bad-json/);
  });

  test('plain-text safety — no Markdown chars are escaped (renders as-is)', () => {
    // The card is sent without parse_mode; tool_input could contain
    // Markdown specials. Verify they pass through verbatim (caller
    // is responsible for plainText: true on the Telegram send).
    const row = baseRow({
      tool_input_json: '{"text":"**bold** [link](http://evil)"}',
    });
    const out = approvalCardText(row);
    assert.match(out, /\*\*bold\*\*/);
    assert.match(out, /\[link\]/);
  });
});

describe('_safeParse internal helper', () => {
  test('parses valid JSON string', () => {
    assert.deepEqual(_safeParse('{"a":1}'), { a: 1 });
  });

  test('returns input unchanged on parse error', () => {
    assert.equal(_safeParse('{not-json'), '{not-json');
  });

  test('handles non-object JSON (numbers, strings, etc.)', () => {
    assert.equal(_safeParse('42'), 42);
    assert.equal(_safeParse('"hello"'), 'hello');
    assert.equal(_safeParse('null'), null);
  });
});
