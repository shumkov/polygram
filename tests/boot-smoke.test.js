/**
 * Boot smoke test — loads polygram.js as a module under
 * 'use strict' and verifies the file PARSES without
 * ReferenceError on any undeclared identifier.
 *
 * Why: every other test mocks pm/bot/handlers individually, so
 * none exercise main()'s factory wiring. The v4 architecture
 * review caught a CRITICAL boot blocker (4 undeclared `let X`
 * placeholders) that all 1461 unit tests passed cleanly through.
 * This test would have caught it.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const POLYGRAM_PATH = path.join(__dirname, '..', 'polygram.js');

describe('polygram.js boot smoke', () => {
  test('factory-assigned identifiers are declared at module scope', () => {
    // Catches the v4 BLOCKER: factory CALLS without matching
    // `let X` placeholder → ReferenceError under 'use strict'.
    const src = fs.readFileSync(POLYGRAM_PATH, 'utf8');
    const factoryAssignRe = /^\s+([a-zA-Z_$][\w$]*)\s*=\s*create[A-Z]/gm;
    const assigned = new Set();
    let m;
    while ((m = factoryAssignRe.exec(src)) !== null) assigned.add(m[1]);
    assert.ok(assigned.size > 0, 'sanity: must find factory assignments');

    const missing = [];
    for (const name of assigned) {
      const declRe = new RegExp(`^(let|const|var)\\s+${name}\\b`, 'm');
      if (!declRe.test(src)) missing.push(name);
    }
    assert.deepEqual(missing, [],
      `Factory-assigned identifiers missing let/const/var:\n  ${missing.join('\n  ')}`);
  });

  test('factory wiring order — consumer must run AFTER its dep is wired', () => {
    // Catches the v3-class closure-capture bug. Concrete known
    // hazards:
    //   - formatConfigInfoText must wire BEFORE handleConfigCallback
    //   - bot must exist BEFORE any factory taking it as a dep
    //   - pm must exist BEFORE any factory taking it as a dep
    const src = fs.readFileSync(POLYGRAM_PATH, 'utf8');

    function lineOf(re) {
      const found = re.exec(src);
      return found ? src.slice(0, found.index).split('\n').length : -1;
    }

    const fctxLine = lineOf(/^\s+formatConfigInfoText\s*=\s*create/m);
    const hccIdx = src.search(/\s+handleConfigCallback\s*=\s*create[A-Z]/);
    if (fctxLine !== -1 && hccIdx !== -1) {
      const block = src.slice(hccIdx, hccIdx + 800);
      if (block.includes('formatConfigInfoText')) {
        const hccLine = src.slice(0, hccIdx).split('\n').length;
        assert.ok(fctxLine < hccLine,
          `formatConfigInfoText (line ${fctxLine}) must wire BEFORE handleConfigCallback (line ${hccLine})`);
      }
    }

    // Hardcoded list of factories that destructure their dep as a
    // FIRST-CLASS parameter (not just reference it lazily inside an
    // inner closure). These are the call sites where wire-order
    // matters — late-rebinding the module-level `let bot` doesn't
    // propagate into the factory's captured local because the
    // factory grabs by VALUE at call time.
    //
    // Add a row when extracting a new factory that destructures
    // `bot` or `pm` directly. Lazy references inside callback
    // bodies (createMediaGroupBuffer.onFlush, createStreamer.send)
    // capture the let-binding and DON'T need to be in this list.
    // Verified by reading each factory's parameter destructure
    // (lib/handlers/*.js, lib/sdk/*.js). Update when extracting a
    // new factory that takes `bot` or `pm` as a first-class param.
    // Factories that only LAZILY reference bot/pm inside callback
    // bodies (createMediaGroupBuffer.onFlush, createStreamer.send)
    // capture the let-binding at firing time and don't need to be
    // listed here.
    const FACTORIES_DESTRUCTURING_BOT = [
      'createApprovals',
      'createSdkCallbacks',
      'createHandleSendOverIpc',
    ];
    const FACTORIES_DESTRUCTURING_PM = [
      'createSlashCommands',
      'createHandleConfigCallback',
    ];

    function findFactoryCallLine(factoryName) {
      const re = new RegExp('^\\s+(?:(?:const|let|var)\\s+)?[\\w$]+(?:\\s*=\\s*|\\s*\\}\\s*=\\s*)' + factoryName + '\\b', 'm');
      const m = re.exec(src);
      if (m) return src.slice(0, m.index).split('\n').length;
      // Try destructure form: `({...} = createX(...));`
      const destructRe = new RegExp('^\\s*\\(\\{[^}]*\\}\\s*=\\s*' + factoryName + '\\b', 'm');
      const m2 = destructRe.exec(src);
      if (m2) return src.slice(0, m2.index).split('\n').length;
      return -1;
    }

    const botLine = lineOf(/^\s+bot\s*=\s*createBot\(/m);
    if (botLine !== -1) {
      for (const factory of FACTORIES_DESTRUCTURING_BOT) {
        const factoryLine = findFactoryCallLine(factory);
        if (factoryLine !== -1 && factoryLine < botLine) {
          assert.fail(
            `${factory} on line ${factoryLine} destructures 'bot' BEFORE bot=createBot() on line ${botLine}. Closure captures null — runtime crash on first use.`,
          );
        }
      }
    }

    const pmLine = lineOf(/^\s+pm\s*=\s*new ProcessManagerSdk/m);
    if (pmLine !== -1) {
      for (const factory of FACTORIES_DESTRUCTURING_PM) {
        const factoryLine = findFactoryCallLine(factory);
        if (factoryLine !== -1 && factoryLine < pmLine) {
          assert.fail(
            `${factory} on line ${factoryLine} destructures 'pm' BEFORE pm=new ProcessManagerSdk(...) on line ${pmLine}. Closure captures null — runtime crash on first use.`,
          );
        }
      }
    }
  });
});
