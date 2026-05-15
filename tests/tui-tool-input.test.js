'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTuiToolInput } = require('../lib/tmux/tui-tool-input');

describe('normalizeTuiToolInput', () => {
  test('Bash → { command }', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Bash', 'rm /tmp/foo.txt'),
      { command: 'rm /tmp/foo.txt' },
    );
  });
  test('Read → { file_path }', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Read', '/Users/x/y.md'),
      { file_path: '/Users/x/y.md' },
    );
  });
  test('Glob → { file_path }', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Glob', '**/*.js'),
      { file_path: '**/*.js' },
    );
  });
  test('Write splits on first comma', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Write', '/path/file, hello world'),
      { file_path: '/path/file', _raw_tail: 'hello world' },
    );
  });
  test('Write with no comma → file_path only', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Write', '/path/file'),
      { file_path: '/path/file' },
    );
  });
  test('WebFetch → { url }', () => {
    assert.deepEqual(
      normalizeTuiToolInput('WebFetch', 'https://example.com'),
      { url: 'https://example.com' },
    );
  });
  test('unknown tool → { _raw }', () => {
    assert.deepEqual(
      normalizeTuiToolInput('CustomMcpTool', 'foo=bar baz=qux'),
      { _raw: 'foo=bar baz=qux' },
    );
  });
  test('non-string arg defaults to empty', () => {
    assert.deepEqual(
      normalizeTuiToolInput('Bash', undefined),
      { command: '' },
    );
  });
});
