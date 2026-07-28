'use strict';

/**
 * Reading logic for the inline-styling probe.
 *
 * The probe needs a real token and a real chat, so the part that decides what
 * a run MEANS is separated out and tested here. It carries more weight than
 * the usual spike verdict, because the interesting outcome is not "did it
 * error" — it is "was it accepted and silently stripped". A run that reports
 * success on a flattened echo would license a mapping that authors formatting
 * no user ever sees, with nothing anywhere to say so.
 *
 * The redactor is covered too: this script handles a live token and its
 * output is explicitly meant to be pasted elsewhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PROBE = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'rich-inline-styling-probe.mjs'),
).href;

const load = () => import(PROBE);

const rows = (list) => list.map(([key, status, echoShape]) => (
  { key, label: key, status, ...(echoShape ? { echoShape } : {}) }
));

test('importing the probe does not start a live run', async () => {
  // Guarding the entrypoint is what makes any of this testable; without it,
  // importing the module fires real Telegram sends from the operator's config.
  const mod = await load();
  assert.equal(typeof mod.classifyInlineRun, 'function');
  assert.equal(typeof mod.classifyEcho, 'function');
  assert.equal(typeof mod.describeShape, 'function');
  assert.equal(typeof mod.redact, 'function');
});

// ─── describeShape: the echo, said out loud ────────────────────────────────

test('shapes are described structurally, never by their content', async () => {
  // The description is printed and pasted around. It has to be precise about
  // structure and say nothing about the text that travelled through it.
  const { describeShape } = await load();

  assert.equal(describeShape('hello'), 'string');
  assert.equal(describeShape(['a', 'b']), 'array<string>');
  assert.equal(
    describeShape(['a', { type: 'bold', text: 'secret words' }]),
    "array<string | {text:string, type:'bold'}>",
  );
  assert.ok(!describeShape([{ type: 'bold', text: 'secret words' }]).includes('secret'));
});

test('a mixed array keeps every distinct member shape', async () => {
  // Collapsing to the first member would hide exactly the case the probe
  // exists to find: a server that keeps strings and drops typed nodes.
  const { describeShape } = await load();
  const out = describeShape(['a', { type: 'bold', text: 'x' }, { type: 'code', text: 'y' }]);
  assert.ok(out.includes("type:'bold'"), out);
  assert.ok(out.includes("type:'code'"), out);
  assert.ok(out.startsWith('array<string |'), out);
});

test('deep nesting terminates instead of running away', async () => {
  const { describeShape } = await load();
  let deep = { type: 'bold', text: 'x' };
  for (let i = 0; i < 12; i++) deep = { type: 'bold', text: deep };
  const out = describeShape(deep);
  assert.ok(out.includes('…'), out);
  assert.ok(out.length < 200, `description should stay printable: ${out.length} chars`);
});

test('null and undefined are distinguishable in a description', async () => {
  // "the field came back null" and "the field was absent" mean different
  // things about the schema, and both are plausible echoes.
  const { describeShape } = await load();
  assert.equal(describeShape(null), 'null');
  assert.equal(describeShape(undefined), 'undefined');
  assert.equal(describeShape({ text: null }), '{text:null}');
});

// ─── classifyEcho: preserved vs the silent flatten ─────────────────────────

test('a typed node echoed as a bare string is FLATTENED, not preserved', async () => {
  // The failure with no signal attached: accepted, delivered, and stripped.
  const { classifyEcho } = await load();
  assert.equal(classifyEcho(['a', { type: 'bold', text: 'x' }], 'a x'), 'flattened');
  assert.equal(classifyEcho(['a', { type: 'bold', text: 'x' }], ['a', 'x']), 'flattened');
});

test('a typed node echoed as a typed node is preserved', async () => {
  const { classifyEcho } = await load();
  assert.equal(
    classifyEcho(['a', { type: 'bold', text: 'x' }], ['a', { type: 'bold', text: 'x' }]),
    'preserved',
  );
});

test('the server renaming the node still counts as preserved', async () => {
  // We are guessing at spellings; the echo is the authority. A different
  // discriminator coming back means our guess was translated, not dropped —
  // and the echoed name is the one to emit.
  const { classifyEcho } = await load();
  assert.equal(
    classifyEcho(['a', { type: 'bold', text: 'x' }], ['a', { type: 'RichTextBold', text: 'x' }]),
    'preserved',
  );
});

test('a plain node is not mistaken for surviving structure', async () => {
  // {type:'plain'} carries no styling, so an echo of nothing but plain nodes
  // is the flatten case wearing a typed hat.
  const { classifyEcho } = await load();
  assert.equal(
    classifyEcho(['a', { type: 'bold', text: 'x' }], [{ type: 'plain', text: 'a x' }]),
    'flattened',
  );
});

test('control shapes are judged on structure, not on styling', async () => {
  const { classifyEcho } = await load();
  assert.equal(classifyEcho('plain text', 'plain text'), 'preserved');
  assert.equal(classifyEcho(['a', 'b'], ['a', 'b']), 'preserved');
  assert.equal(classifyEcho(['a', 'b'], 'ab'), 'flattened',
    'an array collapsed to a string is the field refusing sequences');
});

test('an absent echo is unknown rather than a verdict', async () => {
  const { classifyEcho } = await load();
  assert.equal(classifyEcho(['a', { type: 'bold', text: 'x' }], undefined), 'unknown');
});

// ─── classifyInlineRun: what the run licenses ──────────────────────────────

test('a failed control makes the run inconclusive, whatever the styled probes did', async () => {
  // Everything else is measured through that same send path. If a bare string
  // does not round-trip, a blanket rejection below says nothing about typed
  // nodes — it says the server, the chat, or the token is the variable.
  const { classifyInlineRun } = await load();
  const out = classifyInlineRun(rows([
    ['a-string', 'rejected'],
    ['c-bold', 'rejected'],
  ]));
  assert.equal(out.verdict, 'INCONCLUSIVE');
  assert.equal(out.exitCode, 1);
  assert.match(out.reason, /control/);
});

test('every styled probe surviving licenses the mapping', async () => {
  const { classifyInlineRun } = await load();
  const out = classifyInlineRun(rows([
    ['a-string', 'preserved', 'string'],
    ['b-array-of-strings', 'preserved', 'array<string>'],
    ['c-bold', 'preserved', "array<string | {text:string, type:'bold'}>"],
    ['field-heading', 'preserved', "array<string | {text:string, type:'bold'}>"],
  ]));
  assert.equal(out.verdict, 'TYPED_NODES');
  assert.deepEqual(out.canonical, ["array<string | {text:string, type:'bold'}>"]);
  assert.equal(out.exitCode, 0);
});

test('a field that flattens while paragraphs survive is PARTIAL, not a green light', async () => {
  // The likely real outcome, and the one a coarse verdict would paper over: a
  // table cell that drops styling would ship silently broken tables.
  const { classifyInlineRun } = await load();
  const out = classifyInlineRun(rows([
    ['a-string', 'preserved', 'string'],
    ['c-bold', 'preserved', "array<string | {text:string, type:'bold'}>"],
    ['field-table-cell', 'flattened', 'string'],
  ]));
  assert.equal(out.verdict, 'PARTIAL');
  assert.deepEqual(out.styledFields, ['c-bold']);
  assert.deepEqual(out.flattened, ['field-table-cell']);
});

test('arrays accepted but no styling surviving is not a partial success', async () => {
  const { classifyInlineRun } = await load();
  const out = classifyInlineRun(rows([
    ['a-string', 'preserved', 'string'],
    ['b-array-of-strings', 'preserved', 'array<string>'],
    ['c-bold', 'flattened', 'string'],
    ['c-code', 'rejected'],
  ]));
  assert.equal(out.verdict, 'ARRAYS_ONLY');
  assert.deepEqual(out.styledFields, []);
  assert.equal(out.canonical, null, 'nothing survived, so there is no schema to copy');
});

test('a string-only server is named as such', async () => {
  const { classifyInlineRun } = await load();
  const out = classifyInlineRun(rows([
    ['a-string', 'preserved', 'string'],
    ['b-array-of-strings', 'rejected'],
    ['c-bold', 'rejected'],
  ]));
  assert.equal(out.verdict, 'STRING_ONLY');
});

test('a probe run answers a question — it does not fail because the answer is no', async () => {
  // Exiting non-zero on "typed nodes are unsupported" would read as a broken
  // probe to whoever runs it, and to anything scripting it.
  const { classifyInlineRun } = await load();
  for (const status of ['rejected', 'flattened']) {
    const out = classifyInlineRun(rows([['a-string', 'preserved', 'string'], ['c-bold', status]]));
    assert.equal(out.exitCode, 0, `${status} is an answer, not a failure`);
  }
});

test('an empty or missing run is inconclusive rather than a silent pass', async () => {
  const { classifyInlineRun } = await load();
  for (const input of [[], null, undefined]) {
    assert.equal(classifyInlineRun(input).verdict, 'INCONCLUSIVE');
  }
});

// ─── The ladder itself ─────────────────────────────────────────────────────

test('the ladder covers each candidate class and the fields we would wire', async () => {
  // The probe is only worth running if it asks the whole question: shapes the
  // reference implies, the alternate spellings that would otherwise read as
  // "unsupported", the nested case ordinary markdown produces, and every
  // field the mapping would touch.
  const { candidateShapes, candidateFields } = await load();
  const keys = candidateShapes().map((s) => s.key);

  assert.ok(keys.includes('a-string'), 'a control is what makes the rest readable');
  assert.ok(keys.includes('b-array-of-strings'));
  assert.ok(['c-bold', 'c-italic', 'c-code', 'c-url'].every((k) => keys.includes(k)));
  assert.ok(keys.some((k) => k.startsWith('d-')), 'a wrong guess must not read as unsupported');
  assert.ok(keys.includes('nested-bold-code'), '`**see `x`**` is ordinary markdown');

  assert.deepEqual(candidateFields().map((f) => f.key),
    ['field-heading', 'field-list-item', 'field-table-cell']);
});

test('every probe is tagged so a live run is identifiable in the chat', async () => {
  const { candidateShapes, candidateFields } = await load();
  const text = JSON.stringify([candidateShapes(), candidateFields()]);
  const tags = text.match(/\[SPIKE TEST\]/g) || [];
  assert.equal(tags.length, candidateShapes().length + candidateFields().length,
    'one visible marker per message sent');
});

test('the field probes read back the same path they wrote', async () => {
  // A reader pointing at the wrong path would report "nothing echoed" for a
  // server that echoed perfectly well.
  const { candidateFields, classifyEcho } = await load();
  for (const field of candidateFields()) {
    const written = field.read(field.block);
    assert.ok(written !== undefined, `${field.key}: reader does not find its own styled text`);
    assert.equal(classifyEcho(written, written), 'preserved',
      `${field.key}: the written value must itself count as styled`);
  }
});

// ─── Redaction ─────────────────────────────────────────────────────────────

test('bot tokens and URL credentials are removed from anything printed', async () => {
  const { redact } = await load();

  const token = redact('request to https://api.telegram.org/bot7712345678:AAHsecretXYZ/send failed');
  assert.ok(!token.includes('AAHsecretXYZ'), token);

  const creds = redact('http://svc:hunter2@bot-api.internal:8081/bot7712345678:AAHsec/send');
  assert.ok(!creds.includes('hunter2'), creds);
  assert.ok(!creds.includes('AAHsec'), creds);
});

test('redaction survives non-string input', async () => {
  const { redact } = await load();
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
});

// ─── Selection and pacing ──────────────────────────────────────────────────
//
// A first run reported list items and table cells PRESERVED and a repeat run
// reported them REJECTED, everything else identical — the signature of rate
// pressure rather than of a field that cannot do styling. These two knobs
// exist so that question can be re-asked in a way that answers it.

test('a focused run still carries the control', async () => {
  // Without it, a rejection cannot be told apart from "this chat/server/token
  // is the variable" — which is exactly the ambiguity that made the
  // contradictory run unreadable in the first place.
  const { selectProbes, candidateFields, allProbeKeys, ALWAYS_KEYS } = await load();
  const selected = selectProbes(candidateFields(), 'field-table-cell', allProbeKeys());
  assert.deepEqual(selected.map((p) => p.key), ['field-table-cell']);
  assert.deepEqual(ALWAYS_KEYS, ['a-string'], 'the control is the always-on probe');
});

test('the control survives filtering of the list it belongs to', async () => {
  const { selectProbes, candidateShapes, allProbeKeys } = await load();
  const selected = selectProbes(candidateShapes(), 'c-code', allProbeKeys());
  assert.deepEqual(selected.map((p) => p.key), ['a-string', 'c-code']);
});

test('a key from another list is not mistaken for a typo', async () => {
  // Both lists are filtered by the same selection, so validating each against
  // only its own keys would reject a perfectly valid field key while
  // filtering the shapes.
  const { selectProbes, candidateShapes, allProbeKeys } = await load();
  assert.doesNotThrow(() => selectProbes(candidateShapes(), 'field-table-cell', allProbeKeys()));
});

test('an unknown key refuses the run instead of probing nothing', async () => {
  // `--only field-tablecell` quietly selecting zero probes, and the verdict
  // then reporting cleanly on them, is worse than not starting.
  const { selectProbes, candidateFields, allProbeKeys } = await load();
  assert.throws(
    () => selectProbes(candidateFields(), 'field-tablecell', allProbeKeys()),
    /unknown probe/i,
  );
});

test('no selection runs everything', async () => {
  const { selectProbes, candidateShapes } = await load();
  const all = candidateShapes();
  assert.equal(selectProbes(all, null).length, all.length);
  assert.equal(selectProbes(all, '').length, all.length);
});

test('strikethrough is probed under both plausible spellings', async () => {
  // `~~del~~` is ordinary GFM and marked emits it, but the reference names no
  // strikethrough node — so the mapping may only claim it on evidence, and
  // one spelling failing proves nothing about the other.
  const { candidateShapes } = await load();
  const keys = candidateShapes().map((s) => s.key);
  assert.ok(keys.includes('c-strikethrough'));
  assert.ok(keys.includes('c-strike-alt'));
});
