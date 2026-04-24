const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createReactionManager,
  classifyToolName,
  resolveEmoji,
  STATES,
} = require('../lib/status-reactions');

function makeHarness({ availableEmojis, throttleMs = 10 } = {}) {
  const applied = [];
  const m = createReactionManager({
    availableEmojis,
    throttleMs,
    apply: async (emoji) => { applied.push(emoji); },
  });
  return { m, applied };
}

describe('classifyToolName', () => {
  test('CODING for code/file tools', () => {
    for (const n of ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      assert.equal(classifyToolName(n), 'CODING');
    }
  });
  test('WEB for any Web* tool', () => {
    assert.equal(classifyToolName('WebFetch'), 'WEB');
    assert.equal(classifyToolName('WebSearch'), 'WEB');
  });
  test('WRITING for planning tools', () => {
    assert.equal(classifyToolName('TodoWrite'), 'WRITING');
    assert.equal(classifyToolName('Task'), 'WRITING');
  });
  test('TOOL as generic fallback', () => {
    assert.equal(classifyToolName('mcp__notion__create_page'), 'TOOL');
    assert.equal(classifyToolName(''), 'TOOL');
    assert.equal(classifyToolName(null), 'TOOL');
  });
});

describe('resolveEmoji', () => {
  test('no allowlist → first in chain', () => {
    assert.equal(resolveEmoji(STATES.CODING.chain), '👨‍💻');
  });
  test('walks chain when preferred not allowed', () => {
    const allowed = new Set(['🤔']);
    assert.equal(resolveEmoji(STATES.CODING.chain, allowed), '🤔');
  });
  test('returns null if nothing allowed', () => {
    assert.equal(resolveEmoji(STATES.CODING.chain, new Set(['🍌'])), null);
  });
});

describe('createReactionManager — state transitions', () => {
  test('applies immediately on first setState', async () => {
    const { m, applied } = makeHarness();
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(applied, ['🤔']);
  });

  test('skips apply when same emoji would be applied', async () => {
    const { m, applied } = makeHarness();
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(applied.length, 1);
  });

  test('throttles intermediate states into one flush', async () => {
    const { m, applied } = makeHarness({ throttleMs: 50 });
    m.setState('QUEUED');
    await new Promise(r => setTimeout(r, 5));
    // Flurry of updates inside the throttle window — only the last should flush.
    m.setState('THINKING');
    m.setState('CODING');
    m.setState('WEB');
    await new Promise(r => setTimeout(r, 80));
    // applied[0] is from the immediate QUEUED flush; applied[1] is the
    // throttled trailing flush which should end on WEB (the final state).
    assert.equal(applied[0], '👀');
    assert.equal(applied[applied.length - 1], '⚡');
  });

  test('terminal states bypass throttle', async () => {
    const { m, applied } = makeHarness({ throttleMs: 500 });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 5));
    m.setState('DONE'); // should flush immediately, not wait 500ms
    await new Promise(r => setTimeout(r, 20));
    assert.ok(applied.includes('👍'));
  });
});

describe('createReactionManager — clear + stop', () => {
  test('clear applies null to wipe reaction', async () => {
    const { m, applied } = makeHarness();
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    await m.clear();
    assert.deepEqual(applied.slice(-2), ['👨‍💻', null]);
  });

  test('stop prevents further setState from firing', async () => {
    const { m, applied } = makeHarness({ throttleMs: 20 });
    m.setState('THINKING');
    m.stop();
    m.setState('DONE');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!applied.includes('👍'));
  });
});

describe('createReactionManager — availableEmojis filter', () => {
  test('picks fallback when preferred unavailable', async () => {
    const { m, applied } = makeHarness({
      availableEmojis: new Set(['🤔', '🥱']),
    });
    m.setState('CODING'); // 👨‍💻 not allowed → falls to 🤔
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(applied, ['🤔']);
  });

  test('no-ops cleanly if nothing in chain is allowed', async () => {
    const { m, applied } = makeHarness({
      availableEmojis: new Set(['🍌', '🎉']),
    });
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    // No reaction could be resolved, nothing was applied. Same as "idle".
    assert.deepEqual(applied, []);
    assert.equal(m.currentEmoji, null);
  });
});
