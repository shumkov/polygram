'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const POLYGRAM_PATH = path.join(__dirname, '..', 'polygram.js');

function readHandleMessage() {
  const source = fs.readFileSync(POLYGRAM_PATH, 'utf8');
  const start = source.indexOf('async function handleMessage(');
  const end = source.indexOf('\n// ─── Bot setup', start);
  assert.ok(start >= 0 && end > start, 'handleMessage source must be extractable');
  return source.slice(start, end);
}

function assertFinalizationBeforeReturn(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing success-path marker: ${marker}`);
  const returnExit = source.indexOf('return;', start);
  const catchExit = source.indexOf('\n  } catch', start);
  const exit = returnExit >= 0 ? returnExit : catchExit;
  assert.ok(exit > start, `missing return after: ${marker}`);
  const settlement = source.indexOf('await finalizeResultDelivery(', start);
  assert.ok(
    settlement > start && settlement < exit,
    `delivery finalization must occur after "${marker}" succeeds and before return`,
  );
}

describe('Codex Telegram delivery settlement', () => {
  const source = readHandleMessage();

  test('result exits delegate complete and incomplete outcomes to the finalizer', () => {
    assert.match(
      source,
      /deliveryFinalizer = createTelegramDeliveryFinalizer\(\{[\s\S]*?controller: codexRuntimeController,[\s\S]*?result,[\s\S]*?markHandlerStatus,[\s\S]*?\}\);[\s\S]*?const finalizeResultDelivery = \(deliveryComplete = true\) => \(\s*deliveryFinalizer\.finalize\(deliveryComplete\)\s*\);/,
      'all result exits must use the behaviorally tested delivery finalizer',
    );

    const completeDeliveryCalls = source.match(
      /await finalizeResultDelivery\(\s*!mediaContext\.deliveryIncomplete && telegramDeliveryComplete,\s*\);/g,
    ) || [];
    assert.equal(
      completeDeliveryCalls.length,
      3,
      'streamed final, streamed redelivery, and the normal tail must all require complete Telegram/media delivery',
    );
  });

  test('queue-authorized settlement is exact and primary turns remain no-ops', () => {
    const helperStart = source.indexOf(
      'deliveryFinalizer = createTelegramDeliveryFinalizer({',
    );
    const helperEnd = source.indexOf('\n    });', helperStart) + 7;
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /codexDispatch\?\.reservationId/);
    assert.match(helper, /sessionKey,/);
    assert.match(helper, /controller: codexRuntimeController/);
    assert.match(helper, /result,/);
    assert.match(helper, /botName: BOT_NAME/);
    assert.match(helper, /telegramChatId: String\(chatId\)/);
    assert.match(helper, /telegramMessageId: String\(msg\.message_id\)/);
    assert.match(helper, /markHandlerStatus/);
  });

  test('an exception after a Codex result settles failed delivery before propagating', () => {
    const finalizerStart = source.indexOf('let deliveryFinalizer = null;');
    const catchStart = source.indexOf('  } catch (err) {', finalizerStart);
    const catchEnd = source.indexOf('\n  } finally {', catchStart);
    const catchBody = source.slice(catchStart, catchEnd);

    assert.match(catchBody, /await deliveryFinalizer\?\.failIfPending\(\);/);
    assert.match(catchBody, /if \(deliverySettlementError\) throw deliverySettlementError;/);
  });

  test('every successful result exit finalizes before returning', () => {
    for (const marker of [
      "if (result.text === 'NO_REPLY')",
      'if (toolOnlyTurn)',
      "logEvent('telegram-empty-response-fallback'",
      'if (result.alreadyDelivered)',
      'if (fin.finalEditOk)',
      'const reason = fin.overflow',
      '// rc.10: clear progress reactions AFTER',
    ]) {
      assertFinalizationBeforeReturn(source, marker);
    }

    const calls = source.match(/await finalizeResultDelivery\(/g) || [];
    assert.equal(calls.length, 7, 'all seven successful result exits must finalize exactly once');
  });

  test('short text delivery records chunk failures before settlement', () => {
    const start = source.indexOf('// Not streamed (response too short');
    const end = source.indexOf('// rc.10: clear progress reactions AFTER', start);
    const normalTail = source.slice(start, end);

    assert.match(
      normalTail,
      /const deliveryResult = await deliverReplies\(\{[\s\S]*?\}\);\s*mediaContext\.recordTextFailures\(deliveryResult\.failed\.length\);/,
      'the normal short-text path must feed Telegram chunk failures into the common incomplete-delivery gate',
    );
  });

  test('only primary Telegram directive failures prevent Codex settlement', () => {
    const failures = source.match(/telegramDeliveryComplete = false;/g) || [];
    assert.equal(
      failures.length,
      2,
      'reaction/sticker-only reply failures must make the Codex result ineligible for settlement',
    );

    const inlineStart = source.indexOf('const sendInlineStickers = async');
    const inlineEnd = source.indexOf("// OpenClaw's preview-becomes-final flow", inlineStart);
    const inlineDelivery = source.slice(inlineStart, inlineEnd);
    assert.doesNotMatch(
      inlineDelivery,
      /telegramDeliveryComplete = false;/,
      'supplemental inline sticker/reaction misses stay best-effort after the primary text was delivered',
    );
  });
});
