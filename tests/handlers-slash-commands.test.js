'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSlashCommands } = require('../lib/handlers/slash-commands');

function fixture(overrides = {}) {
  const calls = {
    sendReply: [],
    events: [],
    pmCalls: [],
    db: { configChanges: [] },
    pairings: [],
  };

  // 0.10.0 P0.2/P0.3 fix: slash-commands routes through Process
  // abstraction (pm.getContextUsage + entry.fireUserMessage) instead
  // of poking entry.query / entry.inputController directly. Fixture
  // mirrors the new contract.
  const pmEntry = overrides.pmEntry === undefined
    ? {
        fireUserMessage: (text) => {
          calls.pmCalls.push({ kind: 'push', m: { type: 'user', message: { role: 'user', content: text } } });
          return true;
        },
      }
    : overrides.pmEntry;

  const pm = {
    get: () => pmEntry,
    has: () => pmEntry != null,
    getContextUsage: overrides.getContextUsage
      || (async () => ({ remaining: 9999 })),
    kill: async (sk) => calls.pmCalls.push({ kind: 'kill', sk }),
    resetSession: async (sk, opts) => {
      calls.pmCalls.push({ kind: 'reset', sk, opts });
      return { drainedPendings: 0 };
    },
    setModel: async (sk, m) => { calls.pmCalls.push({ kind: 'setModel', m }); return overrides.applyApplied !== false; },
    applyFlagSettings: async (sk, s) => { calls.pmCalls.push({ kind: 'applyFlag', s }); return overrides.applyApplied !== false; },
  };

  const pairings = {
    issueCode: (args) => { calls.pairings.push({ op: 'issue', args }); return { code: 'CODE-123', scope: args.scope, chat_id: args.chat_id, note: args.note }; },
    listActive: () => overrides.activePairings || [],
    revokeByUser: (args) => { calls.pairings.push({ op: 'revoke', args }); return overrides.revokeCount ?? 1; },
    claimCode: (args) => { calls.pairings.push({ op: 'claim', args }); return overrides.claimResult || { ok: true, chat_id: '111' }; },
  };

  const dispatch = createSlashCommands({
    config: {
      bot: {
        allowConfigCommands: overrides.allowConfigCommands !== false,
        adminChatId: overrides.adminChatId || '999',
      },
    },
    db: {
      logConfigChange: (row) => calls.db.configChanges.push(row),
    },
    dbWrite: (fn) => { try { fn(); } catch {} },
    pm,
    pairings,
    parsePairingTtl: (s) => 600000,
    contextHintShown: new Map(),
    formatContextReply: (u) => 'Remaining: ' + u.remaining,
    getClaudeSessionId: () => overrides.savedSessionId || null,
    getOrSpawnForChat: async (sk) => overrides.spawnEntry || pmEntry,
    parsePairCodeArgs: (text) => {
      const m = /scope=(\S+)/.exec(text);
      return { scope: m ? m[1] : 'user', chat: null, ttl: null, note: null };
    },
    modelVersionsDesc: { sonnet: 'sonnet-4-6', opus: 'opus-4-7', haiku: 'haiku-4-5' },
    botName: 'testbot',
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    logger: { log: () => {}, error: () => {} },
  });

  function makeCtx({ text, chatId = '999', userId = 42 } = {}) {
    return {
      text,
      sessionKey: 'sk:' + chatId,
      chatId,
      threadIdStr: null,
      chatConfig: { model: 'sonnet', effort: 'medium' },
      cmdUser: 'OperatorName',
      cmdUserId: userId,
      label: 'TestChat',
      sendReply: async (msg) => calls.sendReply.push(msg),
    };
  }

  return { dispatch, calls, makeCtx };
}

describe('slash-commands — non-command pass-through', () => {
  test('plain text returns false', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: 'hello world' }));
    assert.equal(res, false);
    assert.equal(fx.calls.sendReply.length, 0);
  });

  test('unknown slash command returns false', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/unknown' }));
    assert.equal(res, false);
  });
});

describe('slash-commands — gate by allowConfigCommands', () => {
  test('allowConfigCommands=false then /model is unrecognized (returns false)', async () => {
    const fx = fixture({ allowConfigCommands: false });
    const res = await fx.dispatch(fx.makeCtx({ text: '/model opus' }));
    assert.equal(res, false);
  });
});

describe('slash-commands — /context', () => {
  test('with active session: fetches usage and replies formatted', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.equal(res, true);
    assert.equal(fx.calls.sendReply.length, 1);
    assert.match(fx.calls.sendReply[0], /Remaining: 9999/);
  });

  test('with no active session: send a message first hint', async () => {
    const fx = fixture({ pmEntry: null });
    await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.match(fx.calls.sendReply[0], /No active session/);
  });

  test('getContextUsage throws: user-friendly error', async () => {
    const fx = fixture({
      getContextUsage: async () => { throw new Error('boom'); },
    });
    await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.match(fx.calls.sendReply[0], /Couldn't fetch context info: boom/);
  });
});

describe('slash-commands — /reload', () => {
  test('with active session: kills and replies', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.equal(res, true);
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'kill'));
    assert.match(fx.calls.sendReply[0], /Reloaded/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reload-command'));
  });

  test('without active session: still acks (no-op)', async () => {
    const fx = fixture({ pmEntry: null });
    await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.match(fx.calls.sendReply[0], /Reloaded/);
  });
});

describe('slash-commands — /new + /reset', () => {
  test('/new calls resetSession and acks', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/new' }));
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'reset' && c.opts.reason === 'new'));
    assert.match(fx.calls.sendReply[0], /fresh session/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reset-command'));
  });

  test('/reset calls resetSession (reason=reset)', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/reset' }));
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'reset' && c.opts.reason === 'reset'));
  });
});

describe('slash-commands — /model', () => {
  test('valid model: persists and applies and acks', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/model opus' }));
    assert.equal(fx.calls.db.configChanges.length, 1);
    assert.equal(fx.calls.db.configChanges[0].new_value, 'opus');
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'setModel' && c.m === 'opus'));
    assert.match(fx.calls.sendReply[0], /Model → opus \(opus-4-7\)/);
  });

  test('invalid model: rejects without DB write', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/model haikuish' }));
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.match(fx.calls.sendReply[0], /Unknown model/);
  });

  test('apply returned false (no live session): suffix Ill switch when I finish', async () => {
    const fx = fixture({ applyApplied: false });
    await fx.dispatch(fx.makeCtx({ text: '/model sonnet' }));
    assert.match(fx.calls.sendReply[0], /switch when I finish/);
  });
});

describe('slash-commands — /effort', () => {
  test('valid effort: persists and applies', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/effort high' }));
    assert.equal(fx.calls.db.configChanges[0].new_value, 'high');
    assert.match(fx.calls.sendReply[0], /Effort → high/);
  });

  test('invalid effort: rejects', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/effort ludicrous' }));
    assert.match(fx.calls.sendReply[0], /Unknown effort/);
  });
});

describe('slash-commands — pairing admin gates', () => {
  test('/pair-code from non-admin chat is rejected', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair-code', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /admin-only/);
  });

  test('/pair-code from admin chat issues code and logs event', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair-code scope=user', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Code: CODE-123/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'pair-code-issued'));
  });

  test('/pairings from admin chat shows No active pairings when empty', async () => {
    const fx = fixture({ activePairings: [] });
    await fx.dispatch(fx.makeCtx({ text: '/pairings', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /No active pairings/);
  });

  test('/pairings from admin chat lists rows', async () => {
    const fx = fixture({
      activePairings: [
        { user_id: 42, chat_id: '111', granted_ts: 1700000000000, note: null },
        { user_id: 99, chat_id: null, granted_ts: 1700000001000, note: 'all chats' },
      ],
    });
    await fx.dispatch(fx.makeCtx({ text: '/pairings', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Active pairings \(2\)/);
    assert.match(fx.calls.sendReply[0], /user 42/);
    assert.match(fx.calls.sendReply[0], /any chat/);
  });

  test('/unpair: parses target_id and reports count', async () => {
    const fx = fixture({ revokeCount: 3 });
    await fx.dispatch(fx.makeCtx({ text: '/unpair 42', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Revoked 3 pairing/);
  });

  test('/unpair: bad target_id then usage hint', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/unpair notanumber', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Usage: \/unpair/);
  });
});

describe('slash-commands — /pair (open)', () => {
  test('successful claim: chat-scoped pairing', async () => {
    const fx = fixture({ claimResult: { ok: true, chat_id: '111' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /Paired. You can use me in chat 111/);
  });

  test('successful claim: any-chat scope', async () => {
    const fx = fixture({ claimResult: { ok: true, chat_id: null } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /every chat testbot is in/);
  });

  test('rate-limited claim: distinct UX message', async () => {
    const fx = fixture({ claimResult: { ok: false, reason: 'rate-limited' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /Too many attempts/);
  });

  test('expired/invalid claim: collapsed UX message', async () => {
    const fx = fixture({ claimResult: { ok: false, reason: 'expired' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /invalid or expired/);
  });

  test('no user id on request then rejects', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', userId: null, chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /No user id/);
  });
});

describe('slash-commands — /compact', () => {
  test('with active session: pushes /compact text and replies', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    const push = fx.calls.pmCalls.find((c) => c.kind === 'push');
    assert.ok(push);
    assert.equal(push.m.message.content, '/compact');
    assert.match(fx.calls.sendReply[0], /Compacting/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'compact-command'));
  });

  test('with hint: replies with hint suffix', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/compact preserve everything about Q4' }));
    assert.match(fx.calls.sendReply[0], /with your hint/);
  });

  test('without session AND no saved id: no-conversation hint', async () => {
    const fx = fixture({ pmEntry: null, savedSessionId: null });
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    assert.match(fx.calls.sendReply[0], /No conversation to compact/);
  });

  test('without session BUT saved id: auto-spawn-resume and log compact-spawn-resumed', async () => {
    // Post-0.10.0-P0.3: slash-commands routes through Process.fireUserMessage.
    const spawned = {
      fireUserMessage: () => true,
    };
    const fx = fixture({ pmEntry: null, savedSessionId: 'sess-abc', spawnEntry: spawned });
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    assert.ok(fx.calls.events.some((e) => e.kind === 'compact-spawn-resumed'));
    assert.match(fx.calls.sendReply[0], /Compacting/);
  });
});
