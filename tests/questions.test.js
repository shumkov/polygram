'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../lib/questions/questions');

const BASE = 'q:7:tok';

function single() {
  return [{ header: 'Setup', question: 'Which engine?', options: [
    { label: 'Cloud API', description: 'bot/automation' },
    { label: 'Business app' },
  ] }];
}
function multi() {
  return [{ header: 'Features', question: 'Pick any', multiSelect: true, options: [
    { label: 'A' }, { label: 'B' }, { label: 'C' },
  ] }];
}

describe('questions — single-select', () => {
  test('renders body + one button per option + Type-my-own', () => {
    const st = Q.initState(single());
    const r = Q.renderCurrent(st, BASE);
    assert.match(r.text, /Which engine\?/);
    assert.match(r.text, /Cloud API — bot\/automation/);     // description in body
    const kb = r.reply_markup.inline_keyboard;
    assert.equal(kb[0][0].callback_data, 'q:7:tok:opt:0');
    assert.equal(kb[1][0].text, 'Business app');
    assert.equal(kb[kb.length - 1][0].callback_data, 'q:7:tok:other');
    assert.ok(!r.text.includes('Question 1 of'), 'no progress line for a single question');
  });

  test('tapping an option records it + advances + reports done', () => {
    const st = Q.initState(single());
    const res = Q.applyTap(st, Q.parseAction('opt:0'));
    assert.equal(res.kind, 'advanced');
    assert.equal(res.receipt, 'Cloud API');
    assert.equal(res.done, true);
    assert.deepEqual(Q.assemble(res.state), { answers: [{ header: 'Setup', selected: ['Cloud API'] }] });
  });

  test('single-select has NO submit button', () => {
    const kb = Q.renderCurrent(Q.initState(single()), BASE).reply_markup.inline_keyboard;
    assert.ok(!kb.some(row => row.some(b => /submit/i.test(b.callback_data))));
  });
});

describe('questions — multi-select (checkboxes)', () => {
  test('toggle flips state and re-render shows ☑️ + Submit gating', () => {
    let st = Q.initState(multi());
    // Submit before any pick is gated
    let kb = Q.renderCurrent(st, BASE).reply_markup.inline_keyboard;
    const submitRow = kb.find(row => /submit/i.test(row[0].callback_data));
    assert.match(submitRow[0].text, /pick at least one/i);

    const t = Q.applyTap(st, Q.parseAction('opt:1'));
    assert.equal(t.kind, 'toggled');
    st = t.state;
    kb = Q.renderCurrent(st, BASE).reply_markup.inline_keyboard;
    assert.match(kb[1][0].text, /☑️ B/);                       // B now checked
    assert.equal(kb.find(r => /submit/i.test(r[0].callback_data))[0].text, '✅ Submit');
  });

  test('submit with zero selected is REJECTED (no ambiguous empty submit)', () => {
    const st = Q.initState(multi());
    const res = Q.applyTap(st, Q.parseAction('submit'));
    assert.equal(res.kind, 'reject');
    assert.match(res.message, /at least one/i);
  });

  test('toggle two, submit → records both labels sorted, advances, done', () => {
    let st = Q.initState(multi());
    st = Q.applyTap(st, Q.parseAction('opt:2')).state;   // C
    st = Q.applyTap(st, Q.parseAction('opt:0')).state;   // A
    const res = Q.applyTap(st, Q.parseAction('submit'));
    assert.equal(res.kind, 'advanced');
    assert.equal(res.done, true);
    assert.deepEqual(Q.assemble(res.state).answers, [{ header: 'Features', selected: ['A', 'C'] }]);
  });

  test('toggle then untoggle clears it', () => {
    let st = Q.initState(multi());
    st = Q.applyTap(st, Q.parseAction('opt:1')).state;
    st = Q.applyTap(st, Q.parseAction('opt:1')).state;   // untoggle
    const res = Q.applyTap(st, Q.parseAction('submit'));
    assert.equal(res.kind, 'reject', 'untoggled back to zero → reject');
  });
});

describe('questions — free-text Other', () => {
  test('tapping Other enters awaiting-other; a typed reply records + advances', () => {
    let st = Q.initState(single());
    const tap = Q.applyTap(st, Q.parseAction('other'));
    assert.equal(tap.kind, 'awaiting-other');
    assert.equal(tap.state.awaitingOther, true);
    const res = Q.applyFreeText(tap.state, 'my own custom answer');
    assert.equal(res.kind, 'advanced');
    assert.equal(res.done, true);
    assert.deepEqual(Q.assemble(res.state).answers, [{ header: 'Setup', selected: [], other: 'my own custom answer' }]);
  });

  test('free text NOT in awaiting-other mode is rejected (no silent swallow)', () => {
    const res = Q.applyFreeText(Q.initState(single()), 'random message');
    assert.equal(res.kind, 'reject');
  });

  test('free text is capped to MAX_OTHER', () => {
    let st = Q.applyTap(Q.initState(single()), Q.parseAction('other')).state;
    const res = Q.applyFreeText(st, 'x'.repeat(5000));
    assert.equal(res.state.answers[0].other.length, Q.MAX_OTHER);
  });

  test('allowOther:false hides the button and rejects the Other tap', () => {
    const st = Q.initState([{ header: 'H', question: 'q', allowOther: false, options: [{ label: 'X' }, { label: 'Y' }] }]);
    const kb = Q.renderCurrent(st, BASE).reply_markup.inline_keyboard;
    assert.ok(!kb.some(r => /other/i.test(r[0].callback_data)));
    assert.equal(Q.applyTap(st, Q.parseAction('other')).kind, 'reject');
  });
});

describe('questions — sequencing (multiple questions)', () => {
  test('two questions answered in order; progress line shown; done only after both', () => {
    const st = Q.initState([
      { header: 'Q1', question: 'pick', options: [{ label: 'a' }, { label: 'b' }] },
      { header: 'Q2', question: 'pick', options: [{ label: 'c' }, { label: 'd' }] },
    ]);
    assert.match(Q.renderCurrent(st, BASE).text, /Question 1 of 2/);
    const r1 = Q.applyTap(st, Q.parseAction('opt:1'));   // b
    assert.equal(r1.done, false, 'not done after Q1');
    assert.match(Q.renderCurrent(r1.state, BASE).text, /Question 2 of 2/);
    const r2 = Q.applyTap(r1.state, Q.parseAction('opt:0'));   // c
    assert.equal(r2.done, true);
    assert.deepEqual(Q.assemble(r2.state).answers, [
      { header: 'Q1', selected: ['b'] },
      { header: 'Q2', selected: ['c'] },
    ]);
  });
});

describe('questions — robustness', () => {
  test('long label is truncated in body + button', () => {
    const st = Q.initState([{ header: 'H', question: 'q', options: [{ label: 'L'.repeat(80) }, { label: 'ok' }] }]);
    const r = Q.renderCurrent(st, BASE);
    assert.ok(r.reply_markup.inline_keyboard[0][0].text.length <= Q.MAX_LABEL);
  });
  test('out-of-range option index rejected', () => {
    assert.equal(Q.applyTap(Q.initState(single()), Q.parseAction('opt:9')).kind, 'reject');
  });
  test('body renders plain text — no markdown emphasis wrapping agent content', () => {
    const st = Q.initState([{ header: 'H*x', question: 'is _this_ ok?', options: [{ label: 'a' }] }]);
    const r = Q.renderCurrent(st, BASE);
    assert.match(r.text, /is _this_ ok\?/, 'agent text passes through verbatim (caller sends with NO parse_mode)');
  });
});
