/**
 * Tests for lib/sdk/build-options.js — the SDK-pm spawn factory.
 *
 * Coverage areas:
 *   - factory contract (rejects missing deps)
 *   - env scrubbing (allowlist + prefix matching, no leaks)
 *   - permissionMode + canUseTool gating
 *   - per-topic config overrides
 *   - resume sessionId passthrough
 *   - agent-loader integration (failure non-fatal + logged)
 *   - display-hint append
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createBuildSdkOptions,
  filterEnv,
  CHILD_ENV_ALLOWLIST,
  CHILD_ENV_PREFIXES,
} = require('../lib/sdk/build-options');

const silentLogger = { log: () => {}, error: () => {} };

function baseDeps(overrides = {}) {
  return {
    config: {
      defaults: { model: 'sonnet', effort: 'high' },
      bot: {},
      chats: {},
    },
    botName: 'test-bot',
    childHome: '/Users/test',
    makeCanUseTool: () => async () => ({ behavior: 'allow' }),
    logEvent: () => {},
    logger: silentLogger,
    processEnv: { PATH: '/usr/bin', HOME: '/Users/test' },
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    chatConfig: {
      model: 'sonnet',
      effort: 'high',
      cwd: '/Users/test/work',
    },
    chatId: '12345',
    threadId: null,
    label: 'test-chat',
    existingSessionId: null,
    ...overrides,
  };
}

describe('createBuildSdkOptions — factory contract', () => {
  test('returns the per-call spawnFn when all deps provided', () => {
    const fn = createBuildSdkOptions(baseDeps());
    assert.equal(typeof fn, 'function');
    assert.equal(fn.length, 2, 'spawnFn signature is (sessionKey, ctx)');
  });
});

describe('filterEnv — env scrub', () => {
  test('allowlisted vars pass through', () => {
    const out = filterEnv({ PATH: '/bin', HOME: '/u', SHELL: '/bin/zsh' });
    assert.equal(out.PATH, '/bin');
    assert.equal(out.HOME, '/u');
    assert.equal(out.SHELL, '/bin/zsh');
  });

  test('non-allowlisted vars dropped', () => {
    const out = filterEnv({
      PATH: '/bin',
      AWS_SECRET_ACCESS_KEY: 'leak',
      GITHUB_TOKEN: 'leak',
      MY_CUSTOM_VAR: 'leak',
    });
    assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(out.GITHUB_TOKEN, undefined);
    assert.equal(out.MY_CUSTOM_VAR, undefined);
    assert.equal(out.PATH, '/bin');
  });

  test('prefix-matched vars pass through (LC_*, NODE_*, CLAUDE_*, ANTHROPIC_*)', () => {
    const out = filterEnv({
      LC_ALL: 'en_US.UTF-8',
      NODE_OPTIONS: '--enable-source-maps',
      CLAUDE_AGENT: 'finance',
      ANTHROPIC_API_KEY: 'sk-...',
      PATH: '/bin',
    });
    assert.equal(out.LC_ALL, 'en_US.UTF-8');
    assert.equal(out.NODE_OPTIONS, '--enable-source-maps');
    assert.equal(out.CLAUDE_AGENT, 'finance');
    assert.equal(out.ANTHROPIC_API_KEY, 'sk-...');
  });

  test('exports CHILD_ENV_ALLOWLIST and PREFIXES for cross-module use', () => {
    assert.ok(CHILD_ENV_ALLOWLIST instanceof Set);
    assert.ok(CHILD_ENV_PREFIXES.includes('NODE_'));
    assert.ok(CHILD_ENV_PREFIXES.includes('CLAUDE_'));
    assert.ok(CHILD_ENV_PREFIXES.includes('ANTHROPIC_'));
  });

  test('empty input returns empty object', () => {
    assert.deepEqual(filterEnv({}), {});
  });
});

describe('buildSdkOptions — basic shape', () => {
  test('produces SdkOptions with model, effort, cwd, env', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-12345', baseCtx());
    assert.equal(out.model, 'sonnet');
    assert.equal(out.effort, 'high');
    assert.equal(out.cwd, '/Users/test/work');
    assert.equal(typeof out.env, 'object');
    assert.equal(out.env.HOME, '/Users/test');
  });

  test('sets HOME from childHome dep, not from inherited env', () => {
    const fn = createBuildSdkOptions(baseDeps({
      childHome: '/Users/sandbox',
      processEnv: { HOME: '/Users/ivan', PATH: '/bin' },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.HOME, '/Users/sandbox',
      'HOME should be the childHome, not the parent process HOME');
  });

  test('sets CLAUDE_CHANNEL_BOT to botName', () => {
    const fn = createBuildSdkOptions(baseDeps({ botName: 'shumabit' }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.CLAUDE_CHANNEL_BOT, 'shumabit');
  });
});

describe('buildSdkOptions — richText-aware display hint', () => {
  test('richText off (default): systemPrompt gets the plain-mode hint, tables discouraged', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-12345', baseCtx());
    assert.match(out.systemPrompt.append, /MUST NOT emit a table/);
    assert.doesNotMatch(out.systemPrompt.append, /Rich formatting is available/);
  });

  test('richText on at the chat level: systemPrompt gets the rich-mode hint instead', () => {
    const deps = baseDeps({
      config: { defaults: {}, bot: {}, chats: { '12345': { richText: true } } },
    });
    const fn = createBuildSdkOptions(deps);
    const out = fn('chat-12345', baseCtx());
    assert.match(out.systemPrompt.append, /Rich formatting is available/);
    assert.match(out.systemPrompt.append, /checkbox list/);
    assert.doesNotMatch(out.systemPrompt.append, /MUST NOT emit a table/);
  });

  test('the SDK path keeps the inline-media guidance its streamer can deliver', () => {
    // The hint is chosen per call site, not per chat: this path resolves and
    // uploads local media, so removing the syntax here would take away a
    // capability that still works. The reply-tool path asks for it without.
    const deps = baseDeps({
      config: { defaults: {}, bot: {}, chats: { '12345': { richText: true } } },
    });
    const fn = createBuildSdkOptions(deps);
    const out = fn('chat-12345', baseCtx());
    assert.match(out.systemPrompt.append, /!\[caption\]\(\/abs\/path/i);
    assert.match(out.systemPrompt.append, /<tg-collage>/i);
  });

  test('richText resolves through topic → chat → bot → default, same as delivery', () => {
    const deps = baseDeps({
      config: {
        defaults: {},
        bot: {},
        chats: { '12345': { richText: false, topics: { '3': { richText: true } } } },
      },
    });
    const fn = createBuildSdkOptions(deps);
    const out = fn('chat-12345:3', baseCtx({ threadId: '3' }));
    assert.match(out.systemPrompt.append, /Rich formatting is available/);
  });

  test('the hard NEVER-canned-strings rule survives unchanged in both modes', () => {
    const plainOut = createBuildSdkOptions(baseDeps())('chat-1', baseCtx());
    const richOut = createBuildSdkOptions(baseDeps({
      config: { defaults: { richText: true }, bot: {}, chats: {} },
    }))('chat-1', baseCtx());
    for (const out of [plainOut, richOut]) {
      assert.match(out.systemPrompt.append, /NEVER emit shell-context canned strings/);
    }
  });
});

describe('buildSdkOptions — permissionMode + canUseTool', () => {
  test('no approvals.gatedTools → bypassPermissions + allowDangerouslySkipPermissions', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-1', baseCtx());
    assert.equal(out.permissionMode, 'bypassPermissions');
    assert.equal(out.allowDangerouslySkipPermissions, true);
    assert.equal(out.canUseTool, undefined, 'canUseTool not wired without gatedTools');
  });

  test('with gatedTools → permissionMode default + canUseTool wired', () => {
    let canUseToolBuilt = false;
    const fn = createBuildSdkOptions(baseDeps({
      config: {
        defaults: { model: 'sonnet', effort: 'high' },
        bot: {
          approvals: {
            adminChatId: '99999',
            gatedTools: ['Bash(rm *)'],
          },
        },
        chats: {},
      },
      makeCanUseTool: () => {
        canUseToolBuilt = true;
        return async () => ({ behavior: 'allow' });
      },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.permissionMode, 'default');
    assert.equal(out.allowDangerouslySkipPermissions, false);
    assert.equal(typeof out.canUseTool, 'function');
    assert.ok(canUseToolBuilt, 'makeCanUseTool was called per session');
  });

  test('per-topic permissionMode override flips allowDangerouslySkipPermissions off', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const ctx = baseCtx({
      chatConfig: {
        model: 'sonnet', effort: 'high', cwd: '/u',
        topics: { '42': { permissionMode: 'default' } },
      },
      threadId: '42',
    });
    const out = fn('chat-1:42', ctx);
    assert.equal(out.permissionMode, 'default');
    assert.equal(out.allowDangerouslySkipPermissions, false,
      'topic flipping permissionMode away from bypass MUST also disable the skip flag');
  });
});

describe('buildSdkOptions — resume', () => {
  test('existingSessionId passes through as resume option', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-1', baseCtx({ existingSessionId: 'sess-abc-123' }));
    assert.equal(out.resume, 'sess-abc-123');
  });

  test('null existingSessionId omits resume key', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-1', baseCtx({ existingSessionId: null }));
    assert.equal('resume' in out, false);
  });
});

describe('buildSdkOptions — IPC secret gate', () => {
  test('exposeIpcSecretToChildren=false (default) → no IPC credentials in childEnv', () => {
    const fn = createBuildSdkOptions(baseDeps({
      processEnv: {
        PATH: '/bin',
        POLYGRAM_IPC_SECRET: 'abc123',
        POLYGRAM_IPC_DIR: '/private/polygram-ipc',
      },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.POLYGRAM_IPC_SECRET, undefined,
      'IPC secret must be opt-in to avoid prompt-injection-amplification');
    assert.equal(out.env.POLYGRAM_IPC_DIR, undefined);
  });

  test('exposeIpcSecretToChildren=true → matching secret and runtime directory propagated', () => {
    const fn = createBuildSdkOptions(baseDeps({
      config: {
        defaults: { model: 'sonnet', effort: 'high' },
        bot: { exposeIpcSecretToChildren: true },
        chats: {},
      },
      processEnv: {
        PATH: '/bin',
        POLYGRAM_IPC_SECRET: 'abc123',
        POLYGRAM_IPC_DIR: '/private/polygram-ipc',
      },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.POLYGRAM_IPC_SECRET, 'abc123');
    assert.equal(out.env.POLYGRAM_IPC_DIR, '/private/polygram-ipc');
  });
});

describe('buildSdkOptions — TELEGRAM_BOT_TOKEN gate', () => {
  test('needsToken=false → no TELEGRAM_BOT_TOKEN in childEnv', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.TELEGRAM_BOT_TOKEN, undefined);
  });

  test('needsToken=true → TELEGRAM_BOT_TOKEN passed to child', () => {
    const fn = createBuildSdkOptions(baseDeps({
      config: {
        defaults: { model: 'sonnet', effort: 'high' },
        bot: { needsToken: true, token: 'secret-token' },
        chats: {},
      },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.env.TELEGRAM_BOT_TOKEN, 'secret-token');
  });
});

describe('buildSdkOptions — pathToClaudeCodeExecutable', () => {
  test('POLYGRAM_CLAUDE_BIN env passes through', () => {
    const fn = createBuildSdkOptions(baseDeps({
      processEnv: { PATH: '/bin', POLYGRAM_CLAUDE_BIN: '/usr/local/bin/claude-dev' },
    }));
    const out = fn('chat-1', baseCtx());
    assert.equal(out.pathToClaudeCodeExecutable, '/usr/local/bin/claude-dev');
  });

  test('no POLYGRAM_CLAUDE_BIN → key omitted', () => {
    const fn = createBuildSdkOptions(baseDeps());
    const out = fn('chat-1', baseCtx());
    assert.equal('pathToClaudeCodeExecutable' in out, false);
  });
});

describe('buildSdkOptions — agent loading', () => {
  test('agent load failure is non-fatal + logged', () => {
    const events = [];
    const fn = createBuildSdkOptions(baseDeps({
      childHome: '/nonexistent',
      logEvent: (kind, detail) => events.push({ kind, detail }),
    }));
    const ctx = baseCtx({
      chatConfig: {
        model: 'sonnet', effort: 'high', cwd: '/u',
        agent: 'nonexistent-agent',
      },
    });
    // Should not throw — falls back to defaults.
    const out = fn('chat-1', ctx);
    assert.equal(out.model, 'sonnet');
    assert.equal(events.length, 1, 'agent-load-failed event emitted');
    assert.equal(events[0].kind, 'agent-load-failed');
    assert.equal(events[0].detail.agent, 'nonexistent-agent');
  });
});
