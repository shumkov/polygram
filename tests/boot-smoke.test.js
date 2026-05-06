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

    const botLine = lineOf(/^\s+bot\s*=\s*createBot\(/m);
    if (botLine !== -1) {
      const factoryRe = /^\s+\w+\s*=\s*create[A-Z]\w*\s*\(\s*\{[^}]*\bbot\b/gm;
      let bug;
      let factoryMatch;
      while ((factoryMatch = factoryRe.exec(src)) !== null) {
        const factoryLine = src.slice(0, factoryMatch.index).split('\n').length;
        if (factoryLine < botLine) {
          bug = `factory taking 'bot' on line ${factoryLine} runs BEFORE bot=createBot() on line ${botLine}`;
          break;
        }
      }
      assert.ok(!bug, bug || 'bot wiring order OK');
    }

    const pmLine = lineOf(/^\s+pm\s*=\s*new ProcessManagerSdk/m);
    if (pmLine !== -1) {
      const factoryRe = /^\s+\w+\s*=\s*create[A-Z]\w*\s*\(\s*\{[^}]*\bpm\b/gm;
      let bug;
      let factoryMatch;
      while ((factoryMatch = factoryRe.exec(src)) !== null) {
        const factoryLine = src.slice(0, factoryMatch.index).split('\n').length;
        if (factoryLine < pmLine) {
          bug = `factory taking 'pm' on line ${factoryLine} runs BEFORE pm=new ProcessManagerSdk(...) on line ${pmLine}`;
          break;
        }
      }
      assert.ok(!bug, bug || 'pm wiring order OK');
    }
  });
});
