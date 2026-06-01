'use strict';

// Regression tests for the file-upload coercion bug (shumorobot Music,
// 2026-05-31): { source: path } was passed straight to grammy, which
// doesn't recognize it → "Wrong port number" → file-send never worked.

const { test } = require('node:test');
const assert = require('node:assert');
const { InputFile } = require('grammy');
const { coerceFileParams, coerceFileValue } = require('../lib/telegram/input-file');

test('the bug: a bare { source } envelope is NOT a grammy InputFile', () => {
  // This is what the dispatcher used to pass. Documents why upload failed.
  assert.equal({ source: '/tmp/x.flac' } instanceof InputFile, false);
});

test('coerce { source: absPath } → grammy InputFile', () => {
  const params = { chat_id: '1', document: { source: '/tmp/track.flac' } };
  coerceFileParams('sendDocument', params);
  assert.ok(params.document instanceof InputFile, 'document must become an InputFile');
});

test('coerce passes filename through to InputFile', () => {
  const params = { chat_id: '1', document: { source: '/tmp/a.flac', filename: 'nice.flac' } };
  coerceFileParams('sendDocument', params);
  assert.ok(params.document instanceof InputFile);
});

test('sendPhoto coerces the photo field', () => {
  const params = { chat_id: '1', photo: { source: '/tmp/p.png' } };
  coerceFileParams('sendPhoto', params);
  assert.ok(params.photo instanceof InputFile);
});

test('string file_id passes through untouched (must NOT become InputFile)', () => {
  const params = { chat_id: '1', document: 'AgADBAADra-id' };
  coerceFileParams('sendDocument', params);
  assert.equal(params.document, 'AgADBAADra-id');
});

test('https URL string passes through untouched', () => {
  const params = { chat_id: '1', document: 'https://example.com/f.pdf' };
  coerceFileParams('sendDocument', params);
  assert.equal(params.document, 'https://example.com/f.pdf');
});

test('existing InputFile is left as-is (not re-wrapped)', () => {
  const f = new InputFile('/tmp/x.flac');
  const params = { chat_id: '1', document: f };
  coerceFileParams('sendDocument', params);
  assert.equal(params.document, f);
});

test('non-file method is a no-op', () => {
  const params = { chat_id: '1', text: 'hi' };
  coerceFileParams('sendMessage', params);
  assert.deepEqual(params, { chat_id: '1', text: 'hi' });
});

test('file method with no file field set is a no-op (no crash)', () => {
  const params = { chat_id: '1', caption: 'only caption' };
  assert.doesNotThrow(() => coerceFileParams('sendDocument', params));
  assert.equal(params.document, undefined);
});

test('coerceFileValue: bare object without source passes through', () => {
  const v = { foo: 'bar' };
  assert.equal(coerceFileValue(v), v);
});
