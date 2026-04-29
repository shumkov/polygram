/**
 * Tests for agent-loader's @-import expansion (rc.15) and the
 * cwd-aware single-file/directory search order (rc.13).
 *
 * v6 plan §7.3 G13 unit coverage.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadAgent,
  composeSdkOptions,
  clearCache,
  _stripFrontmatter,
  _parseFrontmatter,
  _expandImports,
  _resolveAgentLocation,
} = require('../lib/agent-loader');

let tmpHome, tmpCwd;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-cwd-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmpCwd, '.claude', 'agents'), { recursive: true });
  clearCache();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('agent-loader — single-file Claude Code format (rc.13+)', () => {
  test('finds .md file in cwd/.claude/agents/', () => {
    const agentPath = path.join(tmpCwd, '.claude', 'agents', 'foo.md');
    fs.writeFileSync(agentPath, '---\nname: foo\nmodel: sonnet\n---\nYou are foo.');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.equal(bundle.systemPrompt, 'You are foo.');
    assert.equal(bundle.raw.model, 'sonnet');
    assert.equal(bundle.agentPath, agentPath);
  });

  test('falls back to homeDir/.claude/agents/ when cwd has no agent', () => {
    const agentPath = path.join(tmpHome, '.claude', 'agents', 'bar.md');
    fs.writeFileSync(agentPath, '---\nname: bar\n---\nYou are bar.');
    const bundle = loadAgent('bar', { homeDir: tmpHome, cwd: tmpCwd });
    assert.equal(bundle.systemPrompt, 'You are bar.');
  });

  test('cwd takes precedence over homeDir when both have the agent', () => {
    fs.writeFileSync(path.join(tmpHome, '.claude', 'agents', 'baz.md'),
      '---\nname: baz\n---\nfrom home');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'baz.md'),
      '---\nname: baz\n---\nfrom cwd');
    const bundle = loadAgent('baz', { homeDir: tmpHome, cwd: tmpCwd });
    assert.equal(bundle.systemPrompt, 'from cwd');
  });

  test('throws AGENT_NOT_FOUND when agent missing in all locations', () => {
    assert.throws(() => loadAgent('nope', { homeDir: tmpHome, cwd: tmpCwd }),
      (err) => err.code === 'AGENT_NOT_FOUND');
  });
});

describe('agent-loader — @-import expansion (rc.15)', () => {
  test('expands a relative-to-cwd @-import', () => {
    fs.writeFileSync(path.join(tmpCwd, '_base.md'), 'shared base content');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\n@_base.md');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /shared base content/);
  });

  test('expands a relative-to-agent @-import', () => {
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'sibling.md'),
      'sibling content');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\n@sibling.md');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /sibling content/);
  });

  test('absolute @-import paths work', () => {
    const absPath = path.join(tmpCwd, 'abs-base.md');
    fs.writeFileSync(absPath, 'absolute content');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      `---\nname: foo\n---\n@${absPath}`);
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /absolute content/);
  });

  test('imports recursively expand', () => {
    fs.writeFileSync(path.join(tmpCwd, 'level2.md'), 'deepest');
    fs.writeFileSync(path.join(tmpCwd, 'level1.md'), 'middle\n@level2.md');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\n@level1.md');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /middle/);
    assert.match(bundle.systemPrompt, /deepest/);
  });

  test('cycle detection — A imports B imports A — does not infinite-loop', () => {
    fs.writeFileSync(path.join(tmpCwd, 'a.md'), 'A content\n@b.md');
    fs.writeFileSync(path.join(tmpCwd, 'b.md'), 'B content\n@a.md');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\n@a.md');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /A content/);
    assert.match(bundle.systemPrompt, /B content/);
  });

  test('missing @-import is preserved as-is with a warning', () => {
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\nbefore\n@nonexistent.md\nafter');
    const warnLog = [];
    const bundle = loadAgent('foo', {
      homeDir: tmpHome, cwd: tmpCwd,
      logger: { warn: (m) => warnLog.push(m), error: () => {} },
    });
    // The unresolved import line is preserved.
    assert.match(bundle.systemPrompt, /@nonexistent\.md/);
    assert.match(bundle.systemPrompt, /before/);
    assert.match(bundle.systemPrompt, /after/);
    assert.equal(warnLog.some((m) => /not found/.test(m)), true);
  });

  test('imported file frontmatter is stripped', () => {
    fs.writeFileSync(path.join(tmpCwd, 'imported.md'),
      '---\nname: imported\n---\nactual content');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'foo.md'),
      '---\nname: foo\n---\n@imported.md');
    const bundle = loadAgent('foo', { homeDir: tmpHome, cwd: tmpCwd });
    // frontmatter from imported file should NOT appear in expanded text.
    assert.equal(bundle.systemPrompt.includes('---'), false);
    assert.match(bundle.systemPrompt, /actual content/);
  });
});

describe('agent-loader — directory layout (legacy)', () => {
  test('reads CLAUDE.md from <homeDir>/.claude/agents/<name>/', () => {
    const dir = path.join(tmpHome, '.claude', 'agents', 'old');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'legacy directory format');
    const bundle = loadAgent('old', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /legacy directory format/);
  });

  test('cwd directory layout takes precedence over homeDir', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'agents', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(tmpCwd, '.claude', 'agents', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'agents', 'shared', 'CLAUDE.md'),
      'home version');
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'shared', 'CLAUDE.md'),
      'cwd version');
    const bundle = loadAgent('shared', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle.systemPrompt, /cwd version/);
  });
});

describe('agent-loader — frontmatter parsing', () => {
  test('parseFrontmatter extracts simple key:value pairs', () => {
    const fm = _parseFrontmatter('---\nname: foo\nmodel: sonnet\neffort: high\n---\nbody');
    assert.equal(fm.name, 'foo');
    assert.equal(fm.model, 'sonnet');
    assert.equal(fm.effort, 'high');
  });

  test('parseFrontmatter handles quoted values', () => {
    const fm = _parseFrontmatter('---\ndescription: "with spaces"\n---\nbody');
    assert.equal(fm.description, 'with spaces');
  });

  test('parseFrontmatter returns empty object when no frontmatter', () => {
    assert.deepEqual(_parseFrontmatter('plain text'), {});
    assert.deepEqual(_parseFrontmatter(''), {});
  });
});

describe('agent-loader — caching', () => {
  test('cache key includes cwd — same agent name in different cwds resolves separately', () => {
    fs.writeFileSync(path.join(tmpCwd, '.claude', 'agents', 'multi.md'),
      '---\nname: multi\n---\nfrom cwd1');
    const bundle1 = loadAgent('multi', { homeDir: tmpHome, cwd: tmpCwd });
    assert.match(bundle1.systemPrompt, /from cwd1/);
    // Now another cwd with different content.
    const tmpCwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-cwd2-'));
    try {
      fs.mkdirSync(path.join(tmpCwd2, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmpCwd2, '.claude', 'agents', 'multi.md'),
        '---\nname: multi\n---\nfrom cwd2');
      const bundle2 = loadAgent('multi', { homeDir: tmpHome, cwd: tmpCwd2 });
      assert.match(bundle2.systemPrompt, /from cwd2/);
    } finally {
      fs.rmSync(tmpCwd2, { recursive: true, force: true });
    }
  });
});
