'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'polygram.js'),
  'utf8',
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('Codex main-loop steering wiring', () => {
  const runtimeViewResolver = section(
    'async function resolveSessionRuntimeView(',
    'async function buildSpawnContext(',
  );
  const handleStart = section(
    'async function handleMessage(',
    '// Single source of truth at module scope',
  );
  const send = section(
    'async function sendToProcess(',
    '// ─── Message dispatch',
  );
  const steering = section(
    '// AUTOSTEER.',
    'try {\n    const result = await sendPromise;',
  );

  test('Codex send enters its owned queue without the Claude full-turn stdin lock', () => {
    const codexBranch = send.indexOf("entry.runtime === 'codex'");
    const lock = send.indexOf('stdinLock.acquire(sessionKey)');
    assert.ok(codexBranch >= 0 && codexBranch < lock);
    assert.match(
      send.slice(codexBranch, lock),
      /const turnP = pm\.send\(sessionKey, prompt,[\s\S]*?if \(typeof onDispatched === 'function'\) onDispatched\(\);[\s\S]*?return await turnP;/,
    );
    assert.match(
      send.slice(codexBranch, lock),
      /context\.codexDispatchGenerationId[\s\S]*?entry\.generationId !== context\.codexDispatchGenerationId[\s\S]*?CODEX_DISPATCH_GENERATION_CHANGED/,
      'a queue-authorized input must never cross into a replacement generation',
    );
  });

  test('fresh inbound provider selection is durable before provider work', () => {
    assert.match(
      handleStart,
      /if \(!msg\._isReplay\) \{[\s\S]*?db\.recordInboundRuntimeSelection\(\{[\s\S]*?session_key: sessionKey,[\s\S]*?bot_name: BOT_NAME,[\s\S]*?telegram_chat_id: String\(chatId\),[\s\S]*?telegram_message_id: String\(msg\.message_id\),[\s\S]*?provider: selectedInboundProvider,/,
    );
    assert.match(
      handleStart,
      /selectedInboundProvider = selectedBackend === 'codex'[\s\S]*?: 'claude'/,
    );
    assert.doesNotMatch(
      handleStart,
      /dbWrite\(\(\) => db\.recordInboundRuntimeSelection/,
      'provider-selection conflicts must throw and fail closed',
    );
    assert.ok(
      handleStart.indexOf('db.recordInboundRuntimeSelection(')
        < handleStart.indexOf('const label = getSessionLabel('),
      'selection must be durable before command/provider handler setup continues',
    );
  });

  test('only exact enabled inspection commands can observe a disabled saved runtime', () => {
    assert.match(
      handleStart,
      /const runtimeInspectionCommand = \([\s\S]*?botAllowsCommands[\s\S]*?text === '\/config'[\s\S]*?text === '\/model'[\s\S]*?text === '\/effort'[\s\S]*?\);/,
    );
    assert.match(
      handleStart,
      /const selectedBackend = runtimeInspectionCommand[\s\S]*?\? resolveRuntimeDescriptor\(\{[\s\S]*?\}\)\.backend[\s\S]*?: resolvePromptBackend\(\{/,
      'inspection must be observational while every other path stays fail closed',
    );
    assert.doesNotMatch(
      handleStart,
      /startsWith\(['"]\/(?:config|model|effort)/,
      'argument-bearing commands must not inherit the inspection exception',
    );
  });

  test('recovery is pinned to its durable provider and Codex skips the Claude auth gate', () => {
    assert.match(
      source,
      /msg\._requiredProvider[\s\S]*?msg\._requiredProvider !== selectedInboundProvider[\s\S]*?PROVIDER_RECOVERY_SELECTION_CHANGED/,
    );
    assert.match(
      source,
      /if \(selectedInboundProvider === 'claude'\) \{[\s\S]*?checkClaudeAuthHealth\(\)/,
    );
    assert.match(
      source,
      /getProviderRecovery,[\s\S]*?recoverCodex: async \(row\) => \{[\s\S]*?_requiredProvider = 'codex'[\s\S]*?source: 'boot-replay-codex'/,
    );
    assert.match(
      source,
      /recoverCodexRequest = async \(\{[\s\S]*?_requiredProvider: 'codex'[\s\S]*?_codexAutoResume: true/,
    );
  });

  test('Claude settles accepted ownership while Codex keeps deferred settlement', () => {
    const claim = steering.indexOf(
      'codexRuntimeController.claimDispatchReservation(',
    );
    const steer = steering.indexOf('await autosteer.tryCodexAutosteer(');
    const finalize = steering.indexOf(
      'codexRuntimeController.finalizeAcceptedSteer(',
    );
    const reaction = steering.indexOf("reactor.setState('AUTOSTEERED')");
    assert.ok(claim >= 0 && claim < steer);
    assert.ok(steer < finalize && finalize < reaction);
    const claudeInject = steering.indexOf('autosteer.tryAutosteer({');
    const claudeSettlement = steering.indexOf(
      'steered = settleAcceptedAutosteerOwnership({',
    );
    assert.ok(
      claudeInject < claudeSettlement && claudeSettlement < reaction,
      'accepted Claude injection must become terminal before its success reaction',
    );
    assert.match(
      steering.slice(claudeSettlement, reaction),
      /selectedProvider: acceptedAutosteerProvider/,
      'ownership must follow the branch that accepted the steer, not a changed route',
    );
  });

  test('Claude settlement ambiguity cannot fall through to a primary resend', () => {
    const settlement = steering.indexOf(
      'steered = settleAcceptedAutosteerOwnership({',
    );
    const ambiguityBranch = steering.indexOf(
      "steered.outcome === 'accepted-persistence-ambiguous'",
    );
    const primaryGuard = steering.indexOf(
      'if (shouldDispatchPrimaryAfterAutosteer({',
    );
    const primarySend = steering.indexOf('sendToProcess(sessionKey, prompt,');
    const reaction = steering.indexOf("reactor.setState('AUTOSTEERED')");
    assert.ok(
      settlement >= 0
        && primaryGuard > settlement
        && primaryGuard < primarySend
        && ambiguityBranch > primarySend
        && ambiguityBranch < reaction,
      'accepted-but-ambiguous input must be excluded from primary send and exit before success reaction',
    );
    assert.match(
      steering.slice(ambiguityBranch, reaction),
      /may have been incorporated/,
    );
  });

  test('revocation is rechecked for the actual target before Codex dispatch', () => {
    const intent = steering.indexOf(
      'const releaseIntent = await intentLock.acquire(sessionKey);',
    );
    const authorization = steering.indexOf(
      'requireCodexDispatchEnabled({',
    );
    const processRead = steering.indexOf('const current = pm.get(sessionKey);');
    const liveTarget = steering.indexOf('const liveCodexGeneration = Boolean(');
    const reservation = steering.indexOf(
      'codexRuntimeController.claimDispatchReservation(',
    );
    const send = steering.indexOf('sendToProcess(sessionKey, prompt,');

    assert.ok(intent >= 0, 'the dispatch commitment must hold the intent lock');
    assert.ok(
      authorization > intent,
      'Codex authorization must be refreshed after acquiring the intent lock',
    );
    assert.ok(
      processRead < liveTarget
        && liveTarget < authorization
        && authorization < reservation
        && authorization < send,
      'the actual target must be known and denied before reservations, steering, or send',
    );
    assert.match(
      steering.slice(authorization, reservation),
      /selectedProvider: selectedInboundProvider,[\s\S]*?liveCodexGeneration,/,
      'the policy must cover selected Codex and an already-live shared Codex target',
    );
  });

  test('disabled saved Codex is observable without touching its runtime controller', () => {
    assert.match(
      runtimeViewResolver,
      /codexEnabled: runtimeSelection\.codexEnabled/,
      'every runtime view must expose effective Codex enablement',
    );
    const disabled = runtimeViewResolver.indexOf(
      'if (!runtimeSelection.codexEnabled)',
    );
    const controllerPresence = runtimeViewResolver.indexOf(
      'if (!codexRuntimeController)',
    );
    const controllerRead = runtimeViewResolver.indexOf(
      'codexRuntimeController.resolveRuntimeView(',
    );
    assert.ok(disabled >= 0, 'saved disabled Codex needs a repair view');
    assert.ok(
      disabled < controllerPresence && disabled < controllerRead,
      'scope denial must precede controller/preflight access',
    );
    assert.match(
      runtimeViewResolver.slice(disabled, controllerPresence),
      /CODEX_SCOPE_DISABLED/,
    );
  });

  test('duplicates dispatch nothing and queue fallback is authorized once', () => {
    assert.match(
      steering,
      /if \(!dispatchClaim\.claimed\)[\s\S]*?codexDispatchDecision = 'duplicate'/,
    );
    assert.match(
      steering,
      /if \(codexDispatchDecision === 'duplicate'\)[\s\S]*?return;/,
    );
    const queueAuthorized = steering.indexOf(
      "disposition: 'queue-authorized'",
    );
    const ordinarySend = steering.indexOf('sendToProcess(sessionKey, prompt,');
    assert.ok(queueAuthorized >= 0 && queueAuthorized < ordinarySend);
    assert.match(
      steering.slice(ordinarySend),
      /codexDispatchReservationId: codexDispatch\?\.reservationId/,
    );
    assert.match(
      steering.slice(ordinarySend),
      /codexDispatchGenerationId: codexDispatch\?\.generationId/,
    );
    assert.match(
      steering.slice(0, ordinarySend),
      /\['Active', 'Idle', 'StartingTurn'\][\s\S]*?disposition: 'queue-authorized'/,
      'a disabled or stale steer may queue only while the exact process still accepts work',
    );
  });

  test('ambiguous and unavailable outcomes are terminal visible decisions', () => {
    assert.match(steering, /disposition: 'ambiguous'/);
    assert.match(steering, /disposition: 'cancelled'/);
    assert.match(steering, /may have been incorporated/);
    assert.match(steering, /couldn.t add that follow-up/);
    assert.match(
      steering,
      /if \(\['ambiguous', 'unavailable'\]\.includes\(codexDispatchDecision\)\)[\s\S]*?await reactor\.clear\(\)\.catch\(\(\) => \{\}\)[\s\S]*?await sendCodexDispatchNotice/,
    );
  });

  test('Claude keeps the synchronous autosteer path', () => {
    assert.match(
      steering,
      /else \{[\s\S]*?steered = autosteer\.tryAutosteer\(/,
    );
  });

  test('ambiguous Codex attempts are exposed only through the Codex config status and dedicated callbacks', () => {
    assert.match(
      source,
      /if \(text === '\/config' && isCodexRuntimeView\(runtimeView\)\) \{[\s\S]*?db\.listUnresolvedCodexAttempts\(\{[\s\S]*?session_key: sessionKey,[\s\S]*?buildCodexReconciliationView\(attempt\)/,
    );
    assert.match(
      source,
      /else if \(data\.startsWith\('cxr:'\)\) \{[\s\S]*?handleCodexReconciliationCallback\(ctx\)/,
    );
    assert.match(
      source,
      /handleCodexReconciliationCallback = createHandleCodexReconciliationCallback\(\{[\s\S]*?config, db, intentLock, getSessionKey/,
    );
  });
});
