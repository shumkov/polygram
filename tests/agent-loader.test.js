/**
 * Tests for lib/agent-loader.js (Phase 1 step 14).
 *
 * Builds synthetic agent dirs in tmpdir with various combinations of
 * CLAUDE.md / settings.json / skills / mcpServers and verifies
 * loadAgent + composeSdkOptions produce the right SdkOptions shape.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadAgent, composeSdkOptions, clearCache } = require('../lib/agent-loader');

function makeAgentDir(homeDir, name, files = {}) {
  const agentDir = path.join(homeDir, '.claude', 'agents', name);
  fs.mkdirSync(agentDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(agentDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return agentDir;
}

describe('loadAgent', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loader-test-'));
    clearCache();
  });

  test('throws AGENT_NOT_FOUND when agent dir absent', () => {
    assert.throws(
      () => loadAgent('does-not-exist', { homeDir: tmp }),
      { code: 'AGENT_NOT_FOUND' },
    );
  });

  test('reads CLAUDE.md as systemPrompt', () => {
    makeAgentDir(tmp, 'finance', { 'CLAUDE.md': 'You are the finance agent.' });
    const b = loadAgent('finance', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'You are the finance agent.');
    assert.deepEqual(b.skills, []);
    assert.deepEqual(b.mcpServers, {});
  });

  test('falls back to AGENTS.md if no CLAUDE.md', () => {
    makeAgentDir(tmp, 'legacy', { 'AGENTS.md': 'OpenClaw-style prompt.' });
    const b = loadAgent('legacy', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'OpenClaw-style prompt.');
  });

  test('falls back to system-prompt.txt as last resort', () => {
    makeAgentDir(tmp, 'minimal', { 'system-prompt.txt': 'plain text prompt' });
    const b = loadAgent('minimal', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'plain text prompt');
  });

  test('CLAUDE.md wins over AGENTS.md', () => {
    makeAgentDir(tmp, 'both', {
      'CLAUDE.md': 'new style',
      'AGENTS.md': 'old style',
    });
    const b = loadAgent('both', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'new style');
  });

  test('parses settings.json mcpServers', () => {
    makeAgentDir(tmp, 'mcp-agent', {
      'CLAUDE.md': 'with mcp',
      'settings.json': JSON.stringify({
        mcpServers: { foo: { command: 'foo-mcp' } },
        model: 'claude-sonnet-4-6',
      }),
    });
    const b = loadAgent('mcp-agent', { homeDir: tmp });
    assert.deepEqual(b.mcpServers, { foo: { command: 'foo-mcp' } });
    assert.equal(b.raw.model, 'claude-sonnet-4-6');
  });

  test('enumerates skills/* subdirs', () => {
    const dir = makeAgentDir(tmp, 'skilled', {
      'CLAUDE.md': 'has skills',
    });
    fs.mkdirSync(path.join(dir, 'skills', 'history'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'memory'), { recursive: true });
    // Non-directory: ignored
    fs.writeFileSync(path.join(dir, 'skills', 'README.md'), 'note');
    const b = loadAgent('skilled', { homeDir: tmp });
    assert.deepEqual(b.skills.sort(), ['history', 'memory']);
  });

  test('partial agent (no CLAUDE.md, no settings, no skills) loads with empty fields', () => {
    makeAgentDir(tmp, 'bare');
    const b = loadAgent('bare', { homeDir: tmp });
    assert.equal(b.systemPrompt, null);
    assert.deepEqual(b.skills, []);
    assert.deepEqual(b.mcpServers, {});
    assert.deepEqual(b.raw, {});
  });

  test('caches by agentName — second load returns same bundle', () => {
    makeAgentDir(tmp, 'cached', { 'CLAUDE.md': 'first read' });
    const a = loadAgent('cached', { homeDir: tmp });
    // Modify on disk; cache should hide the change.
    fs.writeFileSync(path.join(tmp, '.claude', 'agents', 'cached', 'CLAUDE.md'), 'second read');
    const b = loadAgent('cached', { homeDir: tmp });
    assert.equal(a, b);
    assert.equal(b.systemPrompt, 'first read');
    clearCache();
    const c = loadAgent('cached', { homeDir: tmp });
    assert.equal(c.systemPrompt, 'second read');
  });
});

describe('composeSdkOptions', () => {
  test('precedence: chatConfig > agent > defaults', () => {
    const chatConfig = { model: 'claude-opus-4-7' };
    const agent = {
      agentName: 'a', skills: ['x'],
      systemPrompt: 'agent-prompt',
      mcpServers: {},
      raw: { model: 'claude-sonnet-4-6', effort: 'high' },
    };
    const defaults = { model: 'claude-haiku-4-5', effort: 'low' };
    const opts = composeSdkOptions(chatConfig, agent, defaults);
    assert.equal(opts.model, 'claude-opus-4-7');     // chat wins
    assert.equal(opts.effort, 'high');               // agent wins (no chat override)
    assert.equal(opts.systemPrompt, 'agent-prompt');
    assert.deepEqual(opts.skills, ['x']);
  });

  test('chat config "agent" key is dropped from SdkOptions (polygram-only)', () => {
    const opts = composeSdkOptions(
      { agent: 'finance', model: 'claude-haiku-4-5' },
      null,
      {},
    );
    assert.equal(opts.agent, undefined);
    assert.equal(opts.model, 'claude-haiku-4-5');
  });

  test('null agent works (no agent pinned)', () => {
    const opts = composeSdkOptions(
      { model: 'claude-sonnet-4-6' },
      null,
      { effort: 'high' },
    );
    assert.equal(opts.model, 'claude-sonnet-4-6');
    assert.equal(opts.effort, 'high');
    assert.equal(opts.systemPrompt, undefined);
  });

  test('agent mcpServers merge with defaults', () => {
    const agent = {
      agentName: 'a', skills: [], systemPrompt: null,
      mcpServers: { foo: { command: 'foo' } },
      raw: {},
    };
    const opts = composeSdkOptions({}, agent, {
      mcpServers: { bar: { command: 'bar' } },
    });
    assert.deepEqual(opts.mcpServers, {
      bar: { command: 'bar' },
      foo: { command: 'foo' },
    });
  });

  test('null/undefined chatConfig values are not propagated', () => {
    const opts = composeSdkOptions(
      { model: null, effort: undefined, agent: 'x' },
      { agentName: 'x', skills: [], systemPrompt: 'p', mcpServers: {}, raw: {} },
      { model: 'fallback' },
    );
    assert.equal(opts.model, 'fallback');
    assert.equal(opts.systemPrompt, 'p');
  });
});
