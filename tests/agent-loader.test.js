/**
 * Tests for lib/agents/loader.js (Phase 1 step 14).
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

const { loadAgent, composeSdkOptions, clearCache } = require('../lib/agents/loader');

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

describe('loadAgent — rc.49 plugin-qualified names', () => {
  // Background: plugin-bundled agents live at
  //   ~/.claude/plugins/cache/<plugin>@<marketplace>/<version>/agents/<name>.md
  // (managed plugins, enrolled in ~/.claude/plugins/installed_plugins.json)
  //   ~/.claude-plugins-local/<plugin>/agents/<name>.md
  // (local-only plugins, no marketplace).
  //
  // Pre-rc.49 polygram only searched ~/.claude/agents/ and
  // <cwd>/.claude/agents/, so plugin agents were invisible — the
  // music-curator agent shipped by the music-curation plugin failed
  // to load until a manual symlink was created. rc.49 lets polygram
  // resolve `<plugin>:<agent>` names natively (mirrors Claude Code's
  // own plugin-qualified syntax, e.g. settings.json's
  // `"agent": "music-curation:music-curator"`).
  //
  // Resolution order for `<plugin>:<agent>`:
  //   1. Look up <plugin>@<any-marketplace> in
  //      ~/.claude/plugins/installed_plugins.json → installPath +
  //      /agents/<agent>.md
  //   2. Fall back to ~/.claude-plugins-local/<plugin>/agents/<agent>.md
  // Plain (unqualified) names: keep existing behaviour — no plugin
  // search, to avoid silent collisions when two plugins ship same-named
  // agents.

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loader-plugin-'));
    clearCache();
  });

  function writeInstalledPlugins(homeDir, plugins) {
    const dir = path.join(homeDir, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins }, null, 2),
    );
  }

  function writePluginAgent(installPath, agentName, body) {
    const agentsDir = path.join(installPath, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, agentName + '.md'), body);
  }

  test('resolves <plugin>:<agent> via installed_plugins.json', () => {
    const installPath = path.join(tmp, 'plugins-cache', 'music-curation', '0.1.0');
    writeInstalledPlugins(tmp, {
      'music-curation@local': [{ scope: 'user', installPath, version: '0.1.0' }],
    });
    writePluginAgent(installPath, 'music-curator',
      '---\nname: music-curator\nmodel: sonnet\n---\n\nYou are music-curator.');
    const b = loadAgent('music-curation:music-curator', { homeDir: tmp });
    assert.equal(b.systemPrompt.trim(), 'You are music-curator.');
    assert.equal(b.raw.model, 'sonnet');
    assert.equal(b.agentName, 'music-curation:music-curator');
  });

  test('falls back to ~/.claude-plugins-local/<plugin>/agents/ when not in installed_plugins.json', () => {
    // No installed_plugins.json at all.
    const localPluginPath = path.join(tmp, '.claude-plugins-local', 'my-local', 'agents');
    fs.mkdirSync(localPluginPath, { recursive: true });
    fs.writeFileSync(
      path.join(localPluginPath, 'helper.md'),
      '---\nname: helper\nmodel: haiku\n---\n\nLocal plugin helper.',
    );
    const b = loadAgent('my-local:helper', { homeDir: tmp });
    assert.equal(b.systemPrompt.trim(), 'Local plugin helper.');
    assert.equal(b.raw.model, 'haiku');
  });

  test('falls back to <cwd>/.claude-plugins-local/<plugin>/agents/ when project vendors a plugin', () => {
    // 2026-05-08 gap discovered: when a project's CLAUDE.md sets
    //   extraKnownMarketplaces.<name>.source.path = <cwd>/.claude-plugins-local
    // its agents live at <cwd>/.claude-plugins-local/<plugin>/agents/<agent>.md
    // — but pre-fix the resolver only checked installed_plugins.json (empty
    // for never-enabled plugins) and ~/.claude-plugins-local/ (user-level,
    // wrong scope). Result: polygram chats configured with
    // agent: 'music-curation:music-curator' silently fell back to defaults.
    const projectCwd = path.join(tmp, 'project-cwd');
    const projectLocal = path.join(projectCwd, '.claude-plugins-local', 'music-curation', 'agents');
    fs.mkdirSync(projectLocal, { recursive: true });
    fs.writeFileSync(
      path.join(projectLocal, 'music-curator.md'),
      '---\nname: music-curator\nmodel: sonnet\n---\n\nProject-vendored music-curator.',
    );
    // No installed_plugins.json registry, no ~/.claude-plugins-local/ entry —
    // ONLY the project-local marketplace path resolves it.
    const b = loadAgent('music-curation:music-curator', { homeDir: tmp, cwd: projectCwd });
    assert.equal(b.systemPrompt.trim(), 'Project-vendored music-curator.');
    assert.equal(b.raw.model, 'sonnet');
  });

  test('cwd-local plugin path is checked AFTER user-local but BEFORE failing', () => {
    // Resolution order verified: registry → ~/.claude-plugins-local/ →
    // <cwd>/.claude-plugins-local/. cwd-local is the LAST fallback so
    // user-level overrides still win when both are present (matches the
    // existing registry-takes-precedence-over-user-local invariant).
    const projectCwd = path.join(tmp, 'project-cwd2');
    fs.mkdirSync(path.join(projectCwd, '.claude-plugins-local', 'overlap', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(projectCwd, '.claude-plugins-local', 'overlap', 'agents', 'helper.md'),
      'from cwd-local',
    );
    const userLocal = path.join(tmp, '.claude-plugins-local', 'overlap', 'agents');
    fs.mkdirSync(userLocal, { recursive: true });
    fs.writeFileSync(path.join(userLocal, 'helper.md'), 'from user-local');

    const b = loadAgent('overlap:helper', { homeDir: tmp, cwd: projectCwd });
    assert.equal(b.systemPrompt, 'from user-local',
      'user-local must win over cwd-local — operator-controlled scope is more authoritative');
  });

  test('cwd-local fallback is skipped when cwd is not provided', () => {
    // Defence-in-depth: passing cwd=null shouldn't pick up arbitrary
    // .claude-plugins-local/ from process.cwd or anywhere else.
    const projectCwd = path.join(tmp, 'project-cwd3');
    fs.mkdirSync(path.join(projectCwd, '.claude-plugins-local', 'p', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(projectCwd, '.claude-plugins-local', 'p', 'agents', 'a.md'), 'present but unreachable');
    assert.throws(
      () => loadAgent('p:a', { homeDir: tmp, cwd: null }),
      { code: 'AGENT_NOT_FOUND' },
    );
  });

  test('installed_plugins.json takes precedence over .claude-plugins-local/', () => {
    const installPath = path.join(tmp, 'plugins-cache', 'overlap', '1.0');
    writeInstalledPlugins(tmp, {
      'overlap@market': [{ scope: 'user', installPath, version: '1.0' }],
    });
    writePluginAgent(installPath, 'helper', 'from cache');

    const localPath = path.join(tmp, '.claude-plugins-local', 'overlap', 'agents');
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, 'helper.md'), 'from local');

    const b = loadAgent('overlap:helper', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'from cache');
  });

  test('matches plugin name regardless of @marketplace suffix', () => {
    // installed_plugins.json keys plugins as "<name>@<marketplace>" but
    // polygram config writes just "<name>" — the lookup must match by
    // the bare plugin name.
    const installPath = path.join(tmp, 'plugins-cache', 'thing', 'unknown');
    writeInstalledPlugins(tmp, {
      'thing@some-marketplace': [{ scope: 'user', installPath, version: 'unknown' }],
    });
    writePluginAgent(installPath, 'helper', 'plugin agent');
    const b = loadAgent('thing:helper', { homeDir: tmp });
    assert.equal(b.systemPrompt, 'plugin agent');
  });

  test('throws AGENT_NOT_FOUND for unknown plugin', () => {
    writeInstalledPlugins(tmp, {});
    assert.throws(
      () => loadAgent('nonexistent:agent', { homeDir: tmp }),
      { code: 'AGENT_NOT_FOUND' },
    );
  });

  test('throws AGENT_NOT_FOUND when plugin exists but agent file does not', () => {
    const installPath = path.join(tmp, 'plugins-cache', 'real', '1.0');
    fs.mkdirSync(installPath, { recursive: true });
    writeInstalledPlugins(tmp, {
      'real@local': [{ scope: 'user', installPath, version: '1.0' }],
    });
    assert.throws(
      () => loadAgent('real:missing-agent', { homeDir: tmp }),
      { code: 'AGENT_NOT_FOUND' },
    );
  });

  test('plain unqualified names still resolve via ~/.claude/agents/ (no plugin search)', () => {
    // Unqualified should NOT silently fall through to a plugin —
    // collision risk if multiple plugins ship same-named agents.
    const installPath = path.join(tmp, 'plugins-cache', 'p', '1.0');
    writeInstalledPlugins(tmp, {
      'p@local': [{ scope: 'user', installPath, version: '1.0' }],
    });
    writePluginAgent(installPath, 'orphan', 'plugin orphan');
    // No ~/.claude/agents/orphan.md → unqualified lookup must fail.
    assert.throws(
      () => loadAgent('orphan', { homeDir: tmp }),
      { code: 'AGENT_NOT_FOUND' },
    );
  });

  test('cache distinguishes qualified vs unqualified names', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'agents', 'shared.md'),
      'user-level shared',
    );
    const installPath = path.join(tmp, 'plugins-cache', 'pkg', '1.0');
    writeInstalledPlugins(tmp, {
      'pkg@local': [{ scope: 'user', installPath, version: '1.0' }],
    });
    writePluginAgent(installPath, 'shared', 'plugin-level shared');

    const a = loadAgent('shared', { homeDir: tmp });
    const b = loadAgent('pkg:shared', { homeDir: tmp });
    assert.equal(a.systemPrompt, 'user-level shared');
    assert.equal(b.systemPrompt, 'plugin-level shared');
    assert.notEqual(a, b);
  });

  test('rejects malformed qualified names (path-traversal protection)', () => {
    writeInstalledPlugins(tmp, {});
    // Plugin-qualified names should still apply the strict charset
    // rule on each side of the colon.
    for (const bad of ['../etc:passwd', 'plugin:../escape', 'a:b:c', ':agent', 'plugin:', '..:..']) {
      assert.throws(
        () => loadAgent(bad, { homeDir: tmp }),
        { code: 'AGENT_NOT_FOUND' },
        'should reject ' + bad,
      );
    }
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

describe('composeSdkOptions — rc.48 topic overrides (highest precedence)', () => {
  // rc.48: per-topic overrides via the 4th `topicConfig` argument.
  // Precedence (highest to lowest): topicConfig > chatConfig > agent
  // frontmatter (raw) > defaults. Per-topic permissionMode MUST
  // override the chat-level one — the principal use case is loosening
  // an agent's `bypassPermissions` default to `default` for a
  // sensitive topic that should hit the canUseTool prompts.

  test('topic overrides chat-level model + effort + cwd', () => {
    const chatConfig = { model: 'sonnet', effort: 'medium', cwd: '/x/chat' };
    const topic = { model: 'opus', effort: 'high', cwd: '/x/topic' };
    const opts = composeSdkOptions(chatConfig, null, {}, topic);
    assert.equal(opts.model, 'opus');
    assert.equal(opts.effort, 'high');
    assert.equal(opts.cwd, '/x/topic');
  });

  test('topic permissionMode overrides chat permissionMode (the principal rc.48 use case)', () => {
    const chatConfig = { permissionMode: 'bypassPermissions' };
    const topic = { permissionMode: 'default' };
    const opts = composeSdkOptions(chatConfig, null, {}, topic);
    assert.equal(opts.permissionMode, 'default');
  });

  test('topic permissionMode overrides agent frontmatter too', () => {
    const chatConfig = {};
    const agent = {
      agentName: 'a', skills: [], systemPrompt: null, mcpServers: {},
      raw: { permissionMode: 'bypassPermissions' },
    };
    const topic = { permissionMode: 'default' };
    const opts = composeSdkOptions(chatConfig, agent, {}, topic);
    assert.equal(opts.permissionMode, 'default');
  });

  test('topic with no overrides → composeSdkOptions behaves identically to pre-rc.48', () => {
    const chatConfig = { model: 'sonnet', cwd: '/x' };
    const opts = composeSdkOptions(chatConfig, null, {});
    const optsWithEmptyTopic = composeSdkOptions(chatConfig, null, {}, {});
    assert.deepEqual(opts, optsWithEmptyTopic);
  });

  test('topic does NOT inject `agent` key into SdkOptions (polygram-only)', () => {
    const opts = composeSdkOptions(
      { model: 'sonnet' },
      null,
      {},
      { agent: 'music-curation', cwd: '/x' },
    );
    assert.equal(opts.agent, undefined);
    assert.equal(opts.cwd, '/x');
  });

  test('null/undefined topicConfig values do not overwrite chat values', () => {
    const chatConfig = { model: 'sonnet', cwd: '/keep' };
    const topic = { model: null, cwd: undefined, effort: 'high' };
    const opts = composeSdkOptions(chatConfig, null, {}, topic);
    assert.equal(opts.model, 'sonnet', 'null topic.model must not override chat.model');
    assert.equal(opts.cwd, '/keep');
    assert.equal(opts.effort, 'high');
  });

  test('full layered precedence: topic > chat > agent > defaults', () => {
    const chatConfig = { model: 'opus' };           // chat wins
    const agent = {
      agentName: 'a', skills: [], systemPrompt: null, mcpServers: {},
      raw: { model: 'haiku', effort: 'low' },        // agent wins for effort (no chat override)
    };
    const defaults = { model: 'haiku', effort: 'medium' };
    const topic = { effort: 'high' };               // topic wins for effort
    const opts = composeSdkOptions(chatConfig, agent, defaults, topic);
    assert.equal(opts.model, 'opus', 'chat overrides agent + defaults');
    assert.equal(opts.effort, 'high', 'topic overrides agent + chat');
  });
});
