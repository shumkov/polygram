/**
 * Tests for lib/pm-router.js — the per-chat router that selects
 * between CLI pm and SDK pm.
 *
 * v6 plan §7.3 — closes router unit-coverage gap.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { makeRouterPolicy, createPmRouter } = require('../lib/pm-router');
const { makeFakePm } = require('./_helpers/fake-pm');

const trivialGet = (key) => key.split(':')[0];        // "12345:topic" → "12345"

describe('makeRouterPolicy', () => {
  test('useSdkAll=true with no chat list → all chats SDK', () => {
    const p = makeRouterPolicy({ useSdkAll: true, getChatIdFromKey: trivialGet });
    assert.equal(p.sdkAllChats, true);
    assert.equal(p.sdkSomeChats, false);
    assert.equal(p.sdkActive, true);
    assert.equal(p.pickPmKindFor('1234'), 'sdk');
    assert.equal(p.pickPmKindFor('any:topic'), 'sdk');
  });

  test('chat-list set → those chats sdk; others cli', () => {
    const p = makeRouterPolicy({
      useSdkAll: false,
      sdkChats: ['100', '200'],
      getChatIdFromKey: trivialGet,
    });
    assert.equal(p.sdkAllChats, false);
    assert.equal(p.sdkSomeChats, true);
    assert.equal(p.sdkActive, true);
    assert.equal(p.pickPmKindFor('100'), 'sdk');
    assert.equal(p.pickPmKindFor('200:topic'), 'sdk');
    assert.equal(p.pickPmKindFor('999'), 'cli');
  });

  test('neither set → all chats CLI', () => {
    const p = makeRouterPolicy({ useSdkAll: false, getChatIdFromKey: trivialGet });
    assert.equal(p.sdkActive, false);
    assert.equal(p.pickPmKindFor('any'), 'cli');
  });

  test('sdkChats wins over useSdkAll when both set', () => {
    // useSdkAll requires the list to be empty for "all chats SDK".
    // If list is set, treat the explicit list as the source of truth.
    const p = makeRouterPolicy({
      useSdkAll: true,
      sdkChats: ['42'],
      getChatIdFromKey: trivialGet,
    });
    assert.equal(p.sdkAllChats, false);          // list non-empty → not "all"
    assert.equal(p.sdkSomeChats, true);
    assert.equal(p.pickPmKindFor('42'), 'sdk');
    assert.equal(p.pickPmKindFor('99'), 'cli');
  });

  test('whitespace and empty entries in chat list are filtered', () => {
    const p = makeRouterPolicy({
      sdkChats: ['', '  100  ', '', '200', '  '],
      getChatIdFromKey: trivialGet,
    });
    assert.equal(p.sdkChatIdSet.size, 2);
    assert.equal(p.pickPmKindFor('100'), 'sdk');
    assert.equal(p.pickPmKindFor('200'), 'sdk');
  });

  test('numeric chat ids stringified consistently', () => {
    // Even if the list contains numeric strings, getChatIdFromKey
    // stringifies for comparison.
    const p = makeRouterPolicy({
      sdkChats: ['12345'],
      getChatIdFromKey: () => 12345,             // returns number
    });
    assert.equal(p.pickPmKindFor('12345'), 'sdk');
  });

  test('throws when getChatIdFromKey is missing', () => {
    assert.throws(() => makeRouterPolicy({ useSdkAll: true }),
      /getChatIdFromKey/);
  });
});

describe('createPmRouter — sessionKey routing', () => {
  test('routes to cli pm when pickPmKindFor returns "cli"', () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: () => 'cli',
    });
    router.has('chat-1');
    assert.deepEqual(cli.calls, [['has', 'chat-1']]);
    assert.deepEqual(sdk.calls, []);
  });

  test('routes to sdk pm when pickPmKindFor returns "sdk"', () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: () => 'sdk',
    });
    router.send('chat-1', 'hello');
    assert.deepEqual(sdk.calls, [['send', 'chat-1', 'hello', undefined]]);
    assert.deepEqual(cli.calls, []);
  });

  test('falls back to cli when sdk requested but sdkPm is null', () => {
    const cli = makeFakePm('cli');
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'sdk',
    });
    router.has('chat-1');
    assert.deepEqual(cli.calls, [['has', 'chat-1']]);
  });

  test('per-sessionKey routing uses pickPmKindFor for each call', () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const sdkChats = new Set(['100']);
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: (key) => sdkChats.has(key) ? 'sdk' : 'cli',
    });
    router.send('100', 'A');
    router.send('200', 'B');
    router.send('100', 'C');
    assert.deepEqual(cli.calls, [['send', '200', 'B', undefined]]);
    assert.deepEqual(sdk.calls, [
      ['send', '100', 'A', undefined],
      ['send', '100', 'C', undefined],
    ]);
  });
});

describe('createPmRouter — pickFor / isSdkFor introspection', () => {
  test('pickFor returns the underlying pm instance', () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: (key) => key === 'sdk-chat' ? 'sdk' : 'cli',
    });
    assert.strictEqual(router.pickFor('sdk-chat'), sdk);
    assert.strictEqual(router.pickFor('cli-chat'), cli);
  });

  test('isSdkFor returns true only when sdkPm is present AND policy says sdk', () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const policy = (key) => key.startsWith('sdk') ? 'sdk' : 'cli';
    const r1 = createPmRouter({ cliPm: cli, sdkPm: sdk, pickPmKindFor: policy });
    assert.equal(r1.isSdkFor('sdk-chat'), true);
    assert.equal(r1.isSdkFor('cli-chat'), false);
    // No sdk pm → isSdkFor always false even if policy says sdk.
    const r2 = createPmRouter({ cliPm: cli, sdkPm: null, pickPmKindFor: policy });
    assert.equal(r2.isSdkFor('sdk-chat'), false);
  });
});

describe('createPmRouter — broadcast lifecycle methods', () => {
  test('killChat broadcasts to both pms when both alive', async () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const router = createPmRouter({ cliPm: cli, sdkPm: sdk, pickPmKindFor: () => 'cli' });
    await router.killChat(42);
    assert.deepEqual(cli.calls, [['killChat', 42]]);
    assert.deepEqual(sdk.calls, [['killChat', 42]]);
  });

  test('killChat targets only cli when sdkPm is null', async () => {
    const cli = makeFakePm('cli');
    const router = createPmRouter({ cliPm: cli, sdkPm: null, pickPmKindFor: () => 'cli' });
    await router.killChat(42);
    assert.deepEqual(cli.calls, [['killChat', 42]]);
  });

  test('shutdown broadcasts to both', async () => {
    const cli = makeFakePm('cli');
    const sdk = makeFakePm('sdk');
    const router = createPmRouter({ cliPm: cli, sdkPm: sdk, pickPmKindFor: () => 'cli' });
    await router.shutdown();
    assert.deepEqual(cli.calls, [['shutdown']]);
    assert.deepEqual(sdk.calls, [['shutdown']]);
  });

  test('killChat awaits both pms in parallel (Promise.all)', async () => {
    const order = [];
    const slowCli = {
      ...makeFakePm('cli'),
      async killChat() { await new Promise((r) => setTimeout(r, 20)); order.push('cli'); },
    };
    const fastSdk = {
      ...makeFakePm('sdk'),
      async killChat() { await new Promise((r) => setTimeout(r, 5)); order.push('sdk'); },
    };
    const router = createPmRouter({ cliPm: slowCli, sdkPm: fastSdk, pickPmKindFor: () => 'cli' });
    await router.killChat(99);
    // Fast one finishes first → parallel, not serial.
    assert.deepEqual(order, ['sdk', 'cli']);
  });

  test('killChat completes the OTHER pm even when one rejects', async () => {
    // Pre-fix Promise.all rejected on first failure → second pm's
    // result was lost AND its rejection became unhandled. The right
    // contract: every pm must be tried; surface aggregated errors.
    const sdkLanded = [];
    const router = createPmRouter({
      cliPm: {
        ...makeFakePm('cli'),
        async killChat() { throw new Error('cli-kill-failed'); },
      },
      sdkPm: {
        ...makeFakePm('sdk'),
        async killChat(chatId) {
          // Yield so this scheduling is identifiably async.
          await new Promise((r) => setImmediate(r));
          sdkLanded.push(chatId);
        },
      },
      pickPmKindFor: () => 'cli',
    });
    // Router's killChat should reject (cli failed) but sdk MUST have run.
    await assert.rejects(router.killChat(7), /cli-kill-failed/);
    assert.deepEqual(sdkLanded, [7], 'sdkPm.killChat must run despite cliPm rejection');
  });

  test('killChat surfaces error from second pm when first succeeds', async () => {
    const router = createPmRouter({
      cliPm: { ...makeFakePm('cli'), async killChat() { /* ok */ } },
      sdkPm: {
        ...makeFakePm('sdk'),
        async killChat() { throw new Error('sdk-kill-failed'); },
      },
      pickPmKindFor: () => 'cli',
    });
    await assert.rejects(router.killChat(7), /sdk-kill-failed/);
  });

  test('killChat aggregates errors when BOTH pms reject', async () => {
    const router = createPmRouter({
      cliPm: { ...makeFakePm('cli'), async killChat() { throw new Error('cli-down'); } },
      sdkPm: { ...makeFakePm('sdk'), async killChat() { throw new Error('sdk-down'); } },
      pickPmKindFor: () => 'cli',
    });
    await assert.rejects(router.killChat(7), (err) => {
      // Both errors should be discoverable. Match either AggregateError
      // (preferred) or any error string mentioning at least one.
      const msg = String(err.errors ? err.errors.map((e) => e.message).join(',') : err.message);
      assert.match(msg, /cli-down/);
      assert.match(msg, /sdk-down/);
      return true;
    });
  });

  test('shutdown completes the OTHER pm even when one rejects', async () => {
    const sdkShutdown = { fired: false };
    const router = createPmRouter({
      cliPm: { ...makeFakePm('cli'), async shutdown() { throw new Error('cli-shutdown-failed'); } },
      sdkPm: {
        ...makeFakePm('sdk'),
        async shutdown() {
          await new Promise((r) => setImmediate(r));
          sdkShutdown.fired = true;
        },
      },
      pickPmKindFor: () => 'cli',
    });
    await assert.rejects(router.shutdown(), /cli-shutdown-failed/);
    assert.equal(sdkShutdown.fired, true,
      'sdkPm.shutdown must run despite cliPm rejection — daemon teardown can\'t leak Query handles');
  });

  test('shutdown does NOT throw if everyone succeeds', async () => {
    const router = createPmRouter({
      cliPm: makeFakePm('cli'),
      sdkPm: makeFakePm('sdk'),
      pickPmKindFor: () => 'cli',
    });
    await assert.doesNotReject(router.shutdown());
  });
});

describe('createPmRouter — optional method routing', () => {
  test('steer forwards to routed pm when implemented', () => {
    const cli = makeFakePm('cli');                                // no steer
    const sdk = makeFakePm('sdk', { steer: true });
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: () => 'sdk',
    });
    const result = router.steer('chat-1', 'hello');
    assert.equal(result, true);
    assert.deepEqual(sdk.calls, [['steer', 'chat-1', 'hello']]);
  });

  test('steer returns false when routed pm has no steer method', () => {
    const cli = makeFakePm('cli');                                // no steer
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    const result = router.steer('chat-1', 'hello');
    assert.equal(result, false);
  });

  test('injectUserMessage forwards to routed pm when implemented (rc.42)', () => {
    const cli = makeFakePm('cli');                                // no inject
    const sdk = makeFakePm('sdk', { injectUserMessage: true });
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: () => 'sdk',
    });
    const result = router.injectUserMessage('chat-1', { content: 'hi', priority: 'next' });
    assert.equal(result, true);
    assert.deepEqual(sdk.calls, [['injectUserMessage', 'chat-1', { content: 'hi', priority: 'next' }]]);
  });

  test('injectUserMessage returns false when routed pm (CLI) lacks the method', () => {
    const cli = makeFakePm('cli');                                // no inject
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    const result = router.injectUserMessage('chat-1', { content: 'hi' });
    assert.equal(result, false);
    assert.deepEqual(cli.calls, []);  // never called
  });

  test('requestRespawn returns sentinel {killed:false, queued:0} when not supported', () => {
    const cli = makeFakePm('cli');                                // no requestRespawn
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    assert.deepEqual(router.requestRespawn('chat-1', 'reason'), { killed: false, queued: 0 });
  });

  test('resetSession returns sentinel Promise when not supported', async () => {
    const cli = makeFakePm('cli');                                // no resetSession
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    const result = await router.resetSession('chat-1', { reason: 'x' });
    assert.deepEqual(result, { closed: false, drainedPendings: 0 });
  });

  test('drainQueue returns 0 when not supported', () => {
    const cli = makeFakePm('cli');                                // no drainQueue
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    assert.equal(router.drainQueue('chat-1', 'CODE'), 0);
  });

  test('interrupt returns resolved Promise when not supported', async () => {
    const cli = makeFakePm('cli');                                // no interrupt
    const router = createPmRouter({
      cliPm: cli, sdkPm: null,
      pickPmKindFor: () => 'cli',
    });
    await assert.doesNotReject(router.interrupt('chat-1'));
  });

  test('feature-detection via pickFor works as documented', () => {
    const cli = makeFakePm('cli');                                // no steer / drainQueue
    const sdk = makeFakePm('sdk', { steer: true, drainQueue: true });
    const router = createPmRouter({
      cliPm: cli, sdkPm: sdk,
      pickPmKindFor: (key) => key === 'sdk' ? 'sdk' : 'cli',
    });
    // Site that needs to branch:
    const sdkTarget = router.pickFor('sdk');
    const cliTarget = router.pickFor('whatever');
    assert.equal(typeof sdkTarget.steer, 'function');
    assert.equal(typeof cliTarget.steer, 'undefined');
  });
});

describe('createPmRouter — input validation', () => {
  test('throws when cliPm is missing', () => {
    assert.throws(() => createPmRouter({ pickPmKindFor: () => 'cli' }),
      /cliPm/);
  });

  test('throws when pickPmKindFor is missing', () => {
    const cli = makeFakePm('cli');
    assert.throws(() => createPmRouter({ cliPm: cli }),
      /pickPmKindFor/);
  });
});
