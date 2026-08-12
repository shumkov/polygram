'use strict';

// The value of `in_flight_at_signal` is entirely positional: it must be read
// before the shutdown sequence changes anything, or it degenerates into a second
// copy of the post-drain `in_flight` — which reads 0 whether the daemon was busy
// or idle, because a lost bridge rejects every pending handler before the drain
// even begins. A behavioural test cannot pin that: the sample could be moved
// after the drain and every assertion about its VALUE would still pass.
//
// So this pins the ordering structurally, in the same style as the other
// polygram wiring tests.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
const deployRestartSrc = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'ops', 'deploy-restart-handler.js'),
  'utf8',
);

// Body of the SIGTERM/SIGINT/SIGHUP handler.
function shutdownBody() {
  const start = src.indexOf('const shutdown = async ({');
  assert.notEqual(start, -1, 'shutdown handler not found — this test needs updating');
  const end = src.indexOf("process.on('SIGINT', () => shutdown())", start);
  assert.notEqual(end, -1, 'end of shutdown handler not found — this test needs updating');
  return src.slice(start, end);
}

describe('shutdown signal-time sampling', () => {
  test('samples in-flight work before anything in shutdown can change it', () => {
    const body = shutdownBody();
    // Anchor on the ASSIGNMENT, not on any call to countInFlight. `countInFlight`
    // is also called after the drain, and anchoring on its first occurrence lets
    // a stray early call satisfy this test while the real sample drifts past the
    // latch — a false green.
    const sample = body.indexOf('const inFlightAtSignal = countInFlight(inFlightHandlers)');
    assert.notEqual(sample, -1, 'signal-time in-flight sample is missing from shutdown');

    // Everything below either mutates state the sample measures, or awaits —
    // giving in-flight handlers a chance to settle or fail first.
    const mustComeAfter = {
      'the isShuttingDown latch': 'isShuttingDown = true',
      'refusing new inbound (stable polling controller)': 'stopPolling()',
      'cancelling open questions': 'expireQuestion',
      'the drain loop': 'const drainStart',
    };
    for (const [label, marker] of Object.entries(mustComeAfter)) {
      const at = body.indexOf(marker);
      assert.notEqual(at, -1, `marker for ${label} not found — this test needs updating`);
      assert.ok(
        sample < at,
        `in-flight must be sampled BEFORE ${label}; found sample at ${sample}, ${label} at ${at}`,
      );
    }
  });

  test('reports the signal-time sample alongside the post-drain count', () => {
    const body = shutdownBody();
    // Both must reach the event: the pair is what shows how much work a restart
    // actually cost versus how much the drain managed to finish.
    assert.match(body, /logEvent\('shutdown-drain', lifecycleDetail\(\{[\s\S]*?in_flight: remaining,/);
    assert.match(body, /logEvent\('shutdown-drain', lifecycleDetail\(\{[\s\S]*?in_flight_at_signal: inFlightAtSignal,/);
    assert.match(body, /\}, invocationId, daemonIdentity\)\)/);
  });

  test('reports restart authorization and committed intent count in lifecycle evidence', () => {
    const body = shutdownBody();
    assert.match(body, /restart_trigger: trigger/);
    assert.match(body, /continuation_authorized: continuationAuthorized === true/);
    assert.match(body, /resume_intents_recorded: res\.intentsRecorded \?\? 0/);
    assert.match(body, /restart_request_id: trigger === 'deploy-ipc'[\s\S]*?restartRequestId[\s\S]*?: null/);
  });

  test('the post-drain count is measured after the drain, not reused', () => {
    const body = shutdownBody();
    const retire = body.indexOf('await prepareCleanRetirement({');
    const remaining = body.indexOf('const remaining = countInFlight(inFlightHandlers)');
    assert.notEqual(remaining, -1, 'post-drain in-flight count is missing');
    assert.ok(remaining > retire, 'final in-flight count must be taken after clean retirement and handler settlement');
  });
});

describe('reply delivery barrier wiring', () => {
  test('creates the barrier before the Telegram sender and passes it to the choke point', () => {
    assert.match(src, /const \{ createDeliveryBarrier \} = require\('\.\/lib\/telegram\/delivery-barrier'\)/);
    const createBarrier = src.indexOf('deliveryBarrier = createDeliveryBarrier()');
    const createTelegram = src.indexOf('tg = createSender(db, console, config, deliveryBarrier)');
    assert.notEqual(createBarrier, -1, 'delivery barrier is not created');
    assert.notEqual(createTelegram, -1, 'Telegram sender does not receive the barrier');
    assert.ok(createBarrier < createTelegram, 'delivery barrier must exist before the sender');
  });

  test('stream edits retain the exact session key when no thread id is present', () => {
    assert.match(src, /const outMetaBase = \{[\s\S]{0,200}?sessionKey,/);
    assert.match(src, /\{ \.\.\.outMetaBase, source: 'bot-reply-stream-edit' \}/);
    assert.match(src, /sourceMsgId: msg\.message_id/);
    assert.match(src, /createMediaDeliveryContext\(\{[\s\S]{0,300}?sessionKey,/);
  });

  test('inline agent reactions are fenced as reply-bearing output', () => {
    const reactionCalls = [...src.matchAll(
      /setMessageReaction[\s\S]{0,420}deliveryClass: 'reply-bearing'/g,
    )];
    assert.ok(
      reactionCalls.length >= 2,
      'both inline and solo agent reaction paths must cross the reply-bearing barrier',
    );
  });
});

describe('clean restart lifecycle ordering', () => {
  test('a spontaneous provider termination forces crash-like shutdown persistence', () => {
    assert.match(
      src,
      /sdkCallbacks\.onAbnormalTermination\s*=\s*\(/,
      'ProcessManager abnormal termination evidence must be latched by the daemon',
    );
    const body = shutdownBody();
    assert.match(
      body,
      /forceCrashReason\s*=\s*abnormalProviderTermination\s*\?\s*'provider-process-terminated'/,
      'a prior provider death must prevent a later handled stop from looking clean',
    );
  });

  test('only the deploy IPC path authorizes continuation intents', () => {
    const body = shutdownBody();
    assert.match(
      body,
      /const projected = continuationAuthorized \? buildResumeIntents\(/,
      'ordinary handled signals must not reach continuation-intent projection',
    );
    assert.match(
      deployRestartSrc,
      /return function requestDeployRestart\(request\)[\s\S]*?requireRestartRequestId\(request\?\.id\)[\s\S]*?shutdown\(\{[\s\S]{0,220}?continuationAuthorized: true,[\s\S]{0,220}?trigger: 'deploy-ipc',[\s\S]{0,220}?restartRequestId/,
      'the authenticated IPC handler must directly begin the authorized shutdown',
    );
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      assert.match(
        src,
        new RegExp(`process\\.on\\('${signal}', \\(\\) => shutdown\\(\\)\\)`),
        `${signal} must use the ordinary non-authorizing shutdown path`,
      );
    }
  });

  test('qualified deploy forwards one closed fence while routine deploy remains unchanged', () => {
    const body = shutdownBody();
    assert.match(
      deployRestartSrc,
      /const qualificationExpectation = normalizeDeployQualificationExpectation\(request\)/,
      'the authenticated deploy request must be reduced to the closed qualification fence',
    );
    assert.match(
      body,
      /const shutdown = async \(\{[\s\S]{0,180}?qualificationExpectation,[\s\S]*?prepareCleanRetirement\(\{[\s\S]{0,500}?qualificationExpectation,/,
      'the shutdown must forward the normalized fence into clean retirement',
    );
  });

  test('logs exactly one bounded qualification result before any retirement snapshot', () => {
    const body = shutdownBody();
    const retirement = body.indexOf('const retirement = await prepareCleanRetirement({');
    const qualificationEvent = body.indexOf("logEvent('clean-restart-qualification-observed'", retirement);
    const snapshots = body.indexOf("logEvent('clean-retirement-snapshot'", retirement);
    assert.notEqual(retirement, -1, 'clean retirement call is missing');
    assert.notEqual(qualificationEvent, -1, 'qualification event is missing');
    assert.notEqual(snapshots, -1, 'retirement snapshot event is missing');
    assert.ok(retirement < qualificationEvent && qualificationEvent < snapshots);
    assert.equal(
      body.match(/logEvent\('clean-restart-qualification-observed'/g)?.length,
      1,
      'shutdown must have one qualification event call site',
    );
    assert.match(
      body.slice(retirement, snapshots),
      /if \(qualificationExpectation !== undefined\) \{[\s\S]*?buildQualificationEvent\(/,
      'routine deploys must not emit a qualification result',
    );
  });

  test('authorized deploy starts retirement without the legacy natural drain', () => {
    const body = shutdownBody();
    assert.match(
      body,
      /if \(!continuationAuthorized\) \{[\s\S]*?while \(inFlightHandlers\.size > 0\)[\s\S]*?\}/,
      'only non-authorizing shutdowns may run the legacy natural-handler drain',
    );
    assert.match(
      body,
      /let drainElapsed = 0;[\s\S]*?if \(!continuationAuthorized\) \{[\s\S]*?drainElapsed = Date\.now\(\) - drainStart/,
      'authorized shutdown must report zero legacy drain time',
    );
  });

  test('authorized question cleanup never answers the retiring provider while signals retain normal expiry', () => {
    const body = shutdownBody();
    assert.match(
      body,
      /if \(continuationAuthorized\) \{[\s\S]*?beginShutdownDisposition[\s\S]*?\} else \{[\s\S]*?expireQuestion/,
      'deploy-only question disposition must remain separate from ordinary signal expiry',
    );
  });

  test('fences inbound admission before delivery/process retirement and clean persistence', () => {
    const body = shutdownBody();
    const stopInbound = body.indexOf('stopPolling()');
    const retire = body.indexOf('await prepareCleanRetirement({');
    const persist = body.indexOf('persistShutdownDisposition({');
    assert.notEqual(stopInbound, -1, 'Telegram intake fence is missing');
    assert.notEqual(retire, -1, 'delivery/process retirement barrier is missing');
    assert.notEqual(persist, -1, 'clean persistence is missing');
    assert.ok(
      stopInbound < retire && retire < persist,
      'shutdown must fence admission, settle delivery/process/handlers, then persist',
    );
    assert.match(
      body,
      /prepareCleanRetirement\(\{[\s\S]{0,350}?deliveryBarrier,[\s\S]{0,350}?awaitIngressSettlement,[\s\S]{0,350}?awaitHandlerSettlement,/,
      'the retirement barrier must include reply delivery, admitted ingress, and handler settlement',
    );
  });

  test('constructs and uses a stable polling fence before pollBot can start', () => {
    assert.match(
      src,
      /\(\{ pollBot, startPollWatchdog, stopPolling, awaitPollSettlement \} = createPollLoop\(/,
      'poll admission and settlement controls must exist before pollBot starts',
    );
    const body = shutdownBody();
    assert.match(
      body,
      /stopPolling\(\);[\s\S]{0,250}?const awaitIngressSettlement = \(\{ timeoutMs \} = \{\}\) => \([\s\S]{0,120}?awaitPollSettlement\(\{ timeoutMs \}\)/,
      'shutdown must close the stable controller and preserve its settlement timeout',
    );
    assert.match(
      body,
      /err\?\.code === 'POLL_SETTLEMENT_TIMEOUT'[\s\S]{0,100}?poll-settlement-timeout/,
      'uncertain ingress settlement must force an explicit crash-like disposition',
    );
  });

  test('retires processes and settles handlers before clean persistence', () => {
    const body = shutdownBody();
    const retire = body.indexOf('await prepareCleanRetirement({');
    const persist = body.indexOf('persistShutdownDisposition({');
    assert.notEqual(retire, -1, 'clean retirement is missing');
    assert.notEqual(persist, -1, 'shutdown persistence is missing');
    assert.ok(retire < persist, 'clean retirement must finish before persistence');
    assert.match(
      body,
      /prepareCleanRetirement\(\{[\s\S]{0,450}?awaitIngressSettlement,[\s\S]{0,250}?awaitHandlerSettlement,/,
    );
    assert.match(
      body,
      /if \(pm && !pmRetired\) await pm\.shutdown\(\)/,
      'a retired ProcessManager must not be shut down a second time',
    );
  });

  test('OOM shutdown joins delivery, poll ingress, process teardown, and handlers before persistence', () => {
    const body = shutdownBody();
    const settle = body.indexOf('await settleCrashShutdown({');
    const persist = body.indexOf('persistShutdownDisposition({');
    assert.notEqual(settle, -1, 'crash/OOM settlement helper is missing');
    assert.ok(settle < persist, 'crash/OOM branches must settle before persistence');
    assert.match(
      body,
      /settleCrashShutdown\(\{[\s\S]{0,450}?deliveryBarrier,[\s\S]{0,450}?awaitIngressSettlement,[\s\S]{0,450}?awaitHandlerSettlement/,
    );
  });

  test('a failed clean transaction invalidates any usable clean-recovery state', () => {
    const body = shutdownBody();
    const persist = body.indexOf('persistShutdownDisposition({');
    const failed = body.indexOf('[shutdown] persistence failed:', persist);
    assert.notEqual(persist, -1, 'shutdown persistence is missing');
    assert.notEqual(failed, -1, 'shutdown persistence failure handler is missing');
    const failureBranch = body.slice(persist, failed + 300);
    assert.match(
      failureBranch,
      /db\.recordCrashShutdown\(\{ botName: BOT_NAME \}\)/,
      'persistence failure must clear clean marker/intents through crash disposition',
    );
  });

  test('boot claims clean recovery before replay, compact recovery, or polling', () => {
    const claim = src.indexOf('startCleanRestartRecovery({');
    const replay = src.indexOf('const candidates = db.getReplayCandidates({', claim);
    const compact = src.indexOf('db.findOrphanedCompactCommands({', claim);
    const polling = src.indexOf('const pollPromise = pollBot(bot)', claim);
    assert.notEqual(claim, -1, 'clean recovery claim is missing');
    for (const [label, at] of Object.entries({ replay, compact, polling })) {
      assert.notEqual(at, -1, `${label} marker is missing`);
      assert.ok(claim < at, `clean recovery must be claimed before ${label}`);
    }
  });

  test('same-session compact replay waits for the tracked continuation without delaying polling', () => {
    assert.match(
      src,
      /cleanRecoveryTasksBySession\.get\(o\.session_key\)[\s\S]{0,500}trackHandlerTask\([\s\S]{0,500}\.then\(\(\) => recoverCompact\(o\)\)/,
    );
    const deferredCompact = src.indexOf('cleanRecoveryTasksBySession.get(o.session_key)');
    const polling = src.indexOf('const pollPromise = pollBot(bot)', deferredCompact);
    assert.notEqual(polling, -1);
  });

  test('strict recovery spawn requires the expected existing session and attestation', () => {
    assert.match(src, /resumePolicy: 'require-existing-session'/);
    assert.match(src, /expectedSessionId: strictResume\.expectedSessionId/);
    assert.match(src, /noWaitForCapacity: true/);
    assert.match(src, /entry\?\.getResumeAttestation/);
    assert.match(src, /pm\.retireExpectedProcess\(sessionKey, rejectedProcess, reason\)/);
    assert.match(src, /sendToProcess\(sessionKey, text, createCleanResumeTurnContext\(\{/);
    assert.match(src, /\{ expectedProcess, onDispatched \}/);
    assert.match(
      src,
      /buildCodexSpawnContext\(\{[\s\S]{0,500}?strictResume,/,
      'Codex strict-resume identity must reach its spawn-context validator',
    );
    const codexSpawnContext = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'codex', 'spawn-context.js'),
      'utf8',
    );
    assert.match(
      codexSpawnContext,
      /if \(strictResume\) \{[\s\S]{0,500}?validateStrictResumeSpawn\(\{/,
      'a Codex backend switch must pass through the tested strict-resume validator',
    );
  });
});

describe('ipc handler wiring', () => {
  test('polygram serves the shared production handler set', () => {
    // Guards against the handlers drifting back inline, where the IPC tests
    // would silently stop covering what a running daemon actually answers.
    assert.match(src, /handlers: createIpcHandlers\(\{/);
    assert.match(src, /getInFlightHandlers: \(\) => inFlightHandlers/);
    assert.match(src, /createForegroundCanaryAuthorizer\(\{[\s\S]{0,500}?getActiveHandlerCount:/);
    assert.match(src, /createForegroundCanaryAuthorizer\(\{[\s\S]{0,700}?getActiveHandlerTargets:/);
    assert.match(src, /requestForegroundCanaryTarget:/);
    assert.match(src, /const requestDeployRestart = createDeployRestartHandler\(\{/);
    assert.match(
      src,
      /persistForegroundCanaryAuthorization: \(detail\) =>[\s\S]{0,150}?db\.logEvent\([\s\S]{0,100}?'foreground-canary-target-authorized'/,
    );
    assert.match(src, /requestDeployRestart,/);
  });

  test('foreground restart authorization is rechecked and persisted before shutdown starts', () => {
    const restartHandler = deployRestartSrc.indexOf(
      'return function requestDeployRestart(request)',
    );
    const handlerBody = deployRestartSrc.slice(restartHandler);
    const authorize = handlerBody.indexOf('authorizeRestart({');
    const event = handlerBody.indexOf('persistForegroundCanaryAuthorization(');
    const shutdown = handlerBody.indexOf('shutdown({');

    assert.ok(restartHandler >= 0);
    assert.ok(authorize >= 0, 'foreground target must be rechecked in the restart handler');
    assert.ok(event > authorize, 'authorization event must follow the exact recheck');
    assert.ok(shutdown > event, 'shutdown must begin only after the authorization event');
    assert.match(handlerBody, /restart_request_id: restartRequestId/);
  });

  test('one per-boot identity is created before DB or IPC and reaches every lifecycle witness', () => {
    const createIdentity = src.indexOf('const daemonIdentity = createDaemonIdentity({');
    const openDb = src.indexOf('db = dbClient.open(DB_PATH)');
    const startIpc = src.indexOf('ipcCloser = await ipcServer.start({');
    assert.ok(createIdentity >= 0, 'daemon identity is not created during boot');
    assert.ok(createIdentity < openDb, 'daemon identity must exist before the DB opens');
    assert.ok(createIdentity < startIpc, 'daemon identity must exist before IPC starts');
    assert.match(
      src.slice(createIdentity, createIdentity + 300),
      /mainPath: __filename,[\s\S]*?packageVersion: packageMetadata\.version,/,
      'daemon identity must describe the real production entrypoint and installed package',
    );

    for (const kind of [
      'polygram-start',
      'shutdown-drain',
      'polygram-stop',
      'polygram-admission-open',
    ]) {
      const event = src.indexOf(`'${kind}'`);
      assert.notEqual(event, -1, `${kind} event is missing`);
      assert.match(
        src.slice(event, event + 1_200),
        /\}, invocationId, daemonIdentity\)\)/,
        `${kind} must include the per-boot identity and PID`,
      );
    }

    assert.match(
      src.slice(startIpc, startIpc + 1_500),
      /createIpcHandlers\(\{[\s\S]*?daemonIdentity,/,
      'authenticated IPC readiness must use the same per-boot identity',
    );
  });
});

describe('tmux preflight wiring', () => {
  // The fatal decision must happen before the daemon opens its DB or starts
  // polling Telegram — a bot that boots "successfully" into a host it cannot
  // serve is the failure this guards.
  test('an unusable required tmux server aborts boot before the DB is opened', () => {
    const verdict = src.indexOf('classifyOrphanSweep({');
    assert.notEqual(verdict, -1, 'boot preflight is missing');
    const exit = src.indexOf('process.exit(2)', verdict);
    assert.notEqual(exit, -1, 'preflight does not abort boot');

    const dbOpen = src.indexOf('db = dbClient.open(DB_PATH)');
    assert.notEqual(dbOpen, -1, 'DB open not found — this test needs updating');
    assert.ok(verdict < dbOpen, 'preflight must run before the DB is opened');
    assert.ok(exit < dbOpen, 'preflight must abort before the DB is opened');
  });

  test('the preflight is fed both the sweep result and a thrown sweep', () => {
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?sweep: sweepResult,/);
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?error: sweepError,/);
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?requireExistingServer,/);
  });

  // Both runners must target the SAME tmux server. One left on the default
  // socket would spawn sessions the other cannot see or sweep.
  test('every tmux runner is given the configured socket', () => {
    const runnerCalls = [...src.matchAll(/createTmuxRunner\(\{([^}]*)\}\)/g)];
    assert.equal(runnerCalls.length, 2, 'orphan sweep and main runner must both be wired');
    for (const [, options] of runnerCalls) {
      assert.match(options, /\bsocketName: tmuxSocketName\b/);
      assert.match(options, /\brequireExistingServer\b/);
    }
  });

  test('the socket name is read from the environment, defaulting to the shared socket', () => {
    assert.match(src, /const tmuxSocketName = process\.env\.ORCHESTRA_TMUX_SOCKET \|\| null;/);
  });
});
