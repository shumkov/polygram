'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const vm = require('node:vm');

const {
  ALLOWED_MODULE_FACADES,
  CodexHookBundleError,
  HOOK_BUNDLE_PATH,
  HOOK_BUNDLE_SOURCES,
  HOOK_BUNDLE_SOURCE_DIR,
  assertSourcePolicy,
  buildHookBundle,
  readCheckedInBundle,
} = require('../lib/codex/hook-bundle');

const execFileAsync = promisify(execFile);
const HOOK_TEST_ROOT = process.env.POLYGRAM_HOOK_TEST_ROOT ?? os.homedir();

function scratch(t) {
  const root = realpathSync(mkdtempSync(path.join(HOOK_TEST_ROOT, '.polygram-hook-bundle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A source tree carrying one extra module, so a rejection is attributable to
// the injected form rather than to the shipped sources.
function sourceTree(t, injected) {
  const root = scratch(t);
  cpSync(HOOK_BUNDLE_SOURCE_DIR, root, { recursive: true });
  const names = [...HOOK_BUNDLE_SOURCES];
  for (const [name, contents] of Object.entries(injected ?? {})) {
    writeFileSync(path.join(root, name), contents);
    if (!names.includes(name)) names.unshift(name);
  }
  return { sourceDir: root, sources: names };
}

function refusal(t, name, contents) {
  return assert.throws(
    () => buildHookBundle(sourceTree(t, { [name]: contents })),
    (error) => (
      error instanceof CodexHookBundleError
      && error.code === 'CODEX_HOOK_BUNDLE_UNSAFE_SOURCE'
      && error.message.includes(name)
    ),
    `${name} must be refused by the build step`,
  );
}

describe('Codex hook bundle build step', () => {
  test('the checked-in bundle is exactly what the build step regenerates', () => {
    const checkedIn = readCheckedInBundle();

    assert.equal(readFileSync(HOOK_BUNDLE_PATH, 'utf8'), buildHookBundle());
    assert.equal(checkedIn.contents, buildHookBundle());
    assert.equal(checkedIn.path, HOOK_BUNDLE_PATH);
    assert.match(checkedIn.sha256, /^[a-f0-9]{64}$/);
  });

  test('rebuilds byte-for-byte from the same sources, from any source location', (t) => {
    const first = buildHookBundle();
    const second = buildHookBundle();
    const relocated = buildHookBundle(sourceTree(t));

    assert.equal(second, first);
    assert.equal(relocated, first);
  });

  test('refuses the property-name escapes that read as ordinary member access', (t) => {
    // Reaching the host `process` through a facade function's constructor, and
    // from there a module the closure never allows.
    refusal(t, 'facade-constructor.js', [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      "const host = writeFileSync['constructor']('return process')();",
      "const runner = host.getBuiltinModule(['node:child', 'process'].join('_'));",
      'module.exports = runner;',
      '',
    ].join('\n'));

    // The same escape with the property name assembled at run time, which no
    // textual scan can see.
    refusal(t, 'assembled-constructor.js', [
      "'use strict';",
      "const make = (() => {})[['con', 'structor'].join('')];",
      "const host = make('return process')();",
      "const files = host.getBuiltinModule(['node', 'fs'].join(':'));",
      "module.exports = files['readFile' + 'Sync']('/etc/passwd');",
      '',
    ].join('\n'));
  });

  test('resolves identifiers lexically, so an inner binding cannot vouch for an outer use', (t) => {
    // A parameter named `process` in one function must not make the ambient
    // `process` legal at a use site that parameter never covers.
    refusal(t, 'scoped-process.js', [
      "'use strict';",
      'const wrap = (process) => process.argv;',
      'module.exports = () => process.env;',
      'module.exports.wrap = wrap;',
      '',
    ].join('\n'));

    refusal(t, 'scoped-unknown.js', [
      "'use strict';",
      'const wrap = (Reflect) => Reflect;',
      'module.exports = () => Reflect.ownKeys({});',
      'module.exports.wrap = wrap;',
      '',
    ].join('\n'));

    refusal(t, 'scoped-block.js', [
      "'use strict';",
      'function outer() {',
      '  {',
      '    const process = 1;',
      '    return process;',
      '  }',
      '}',
      'module.exports = () => process.env;',
      'module.exports.outer = outer;',
      '',
    ].join('\n'));
  });

  test('binds only the names a pattern declares, in the scope that declares them', (t) => {
    // A default value is an expression, not a binding: naming `process` there
    // must not make the ambient `process` legal anywhere.
    refusal(t, 'default-value-binding.js', [
      "'use strict';",
      'const wrap = (value = process) => value;',
      'module.exports = () => process.env;',
      'module.exports.wrap = wrap;',
      '',
    ].join('\n'));

    // A function declared inside a block is block-scoped in strict mode, so it
    // must not vouch for the ambient name in the enclosing function body.
    refusal(t, 'block-function-binding.js', [
      "'use strict';",
      'function outer() {',
      '  {',
      '    function process() {',
      '      return 1;',
      '    }',
      '    process();',
      '  }',
      '  return process.env;',
      '}',
      'module.exports = outer;',
      '',
    ].join('\n'));
  });

  test('closes the constructor escape through destructuring and reflection', (t) => {
    refusal(t, 'destructured-constructor.js', [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      'const { constructor: Make } = writeFileSync;',
      "module.exports = Make('return process')();",
      '',
    ].join('\n'));

    refusal(t, 'descriptor-constructor.js', [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      "const found = Object.getOwnPropertyDescriptor(writeFileSync, 'constructor');",
      "module.exports = found.value('return process')();",
      '',
    ].join('\n'));

    refusal(t, 'prototype-constructor.js', [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      'const proto = Object.getPrototypeOf(writeFileSync);',
      "module.exports = proto.constructor('return process')();",
      '',
    ].join('\n'));

    refusal(t, 'reflected-values.js', [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      'const parts = Object.getOwnPropertyNames(writeFileSync);',
      'module.exports = parts;',
      '',
    ].join('\n'));

    refusal(t, 'destructured-binding.js', [
      "'use strict';",
      'module.exports = (target) => {',
      '  const { call } = target;',
      '  return call;',
      '};',
      '',
    ].join('\n'));
  });

  test('accepts only the declared syntax, identifiers, and facade members', (t) => {
    const forbidden = {
      'computed-member.js': "'use strict';\nconst key = 'constructor';\nmodule.exports = (target) => target[key];\n",
      'computed-string-member.js': "'use strict';\nmodule.exports = (target) => target['constructor'];\n",
      'prototype-walk.js': "'use strict';\nmodule.exports = (target) => target.__proto__;\n",
      'bind-escape.js': "'use strict';\nconst { writeFileSync } = require('node:fs');\nmodule.exports = writeFileSync.call;\n",
      'unknown-global.js': "'use strict';\nmodule.exports = Reflect.ownKeys({});\n",
      'raw-global.js': "'use strict';\nmodule.exports = globalThis;\n",
      'raw-process.js': "'use strict';\nmodule.exports = process.env;\n",
      'sequence-eval.js': "'use strict';\nmodule.exports = (text) => (0, eval)(text);\n",
      'class-declaration.js': "'use strict';\nclass Escape {}\nmodule.exports = Escape;\n",
      'tagged-template.js': "'use strict';\nconst tag = (parts) => parts;\nmodule.exports = tag`raw`;\n",
      'facade-member.js': "'use strict';\nconst fs = require('node:fs');\nmodule.exports = () => fs.readFileSync('/etc/passwd');\n",
      'facade-destructure.js': "'use strict';\nconst { readFileSync } = require('node:fs');\nmodule.exports = readFileSync;\n",
      'facade-namespace.js': "'use strict';\nconst crypto = require('node:crypto');\nmodule.exports = crypto.randomBytes(8);\n",
      'unallowed-builtin.js': "'use strict';\nmodule.exports = require('node:os');\n",
      'undeclared-require.js': "'use strict';\nmodule.exports = require('./not-declared.js');\n",
      'package-require.js': "'use strict';\nmodule.exports = require('markdown-it');\n",
      'data-require.js': "'use strict';\nmodule.exports = require('./payload.json');\n",
      'computed-require.js': "'use strict';\nconst name = 'node:' + 'child_process';\nmodule.exports = require(name);\n",
      'indexed-require.js': "'use strict';\nmodule.exports = require['call'](null, 'node:fs');\n",
      'dynamic-import.js': "'use strict';\nmodule.exports = () => import('./observer-capture.js');\n",
      'esm-import.js': "import fs from 'node:fs';\nexport default fs;\n",
      'eval-call.js': "'use strict';\nmodule.exports = (text) => eval(text);\n",
      'new-function.js': "'use strict';\nmodule.exports = (text) => new Function(text);\n",
      'child-process.js': "'use strict';\nconst cp = require('node:child_process');\nmodule.exports = cp;\n",
      'exec-call.js': "'use strict';\nmodule.exports = (run) => run.execSync('stop.sh');\n",
      'dirname-read.js': "'use strict';\nconst fs = require('node:fs');\nmodule.exports = () => fs.writeFileSync(__dirname, '');\n",
      'this-escape.js': "'use strict';\nmodule.exports = function escape() {\n  return this;\n};\n",
    };

    for (const [name, contents] of Object.entries(forbidden)) {
      refusal(t, name, contents);
    }
  });

  test('names the rule that refused a source, and passes the shipped sources', () => {
    for (const source of HOOK_BUNDLE_SOURCES) {
      assert.doesNotThrow(() => assertSourcePolicy(
        readFileSync(path.join(HOOK_BUNDLE_SOURCE_DIR, source), 'utf8'),
        { label: source },
      ));
    }

    assert.throws(
      () => assertSourcePolicy("module.exports = target['constructor'];", {
        label: 'probe',
      }),
      (error) => (
        error.code === 'CODEX_HOOK_BUNDLE_UNSAFE_SOURCE'
        && /computed member access/.test(error.message)
      ),
    );
    assert.throws(
      () => assertSourcePolicy('module.exports = ;', { label: 'probe' }),
      { code: 'CODEX_HOOK_BUNDLE_INVALID' },
    );
  });

  test('exposes no loader: the runtime is reached only through the frozen facade', () => {
    const bundle = readFileSync(HOOK_BUNDLE_PATH, 'utf8');

    // No binding ever holds the raw loader, so no bundled module can name it:
    // the only mention of `require` that is not a call is the injected
    // parameter each module body receives.
    assert.equal(/=\s*require\s*[;,)]/.test(bundle), false);
    const bare = [...bundle.matchAll(/\brequire\b(?!\s*\()/g)]
      .map((match) => bundle.slice(match.index, match.index + 'require, process,'.length));
    assert.deepEqual([...new Set(bare)], ['require, process,']);

    // The escape hatches are parameters bound to undefined at every call.
    assert.equal(
      bundle.includes('function (module, exports, require, process, globalThis, global, Function) {'),
      true,
    );
    assert.equal(bundle.includes('undefined, undefined, undefined,'), true);

    const specifiers = [...bundle.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)]
      .map((match) => match[2]);
    const inClosure = new Set([
      ...Object.keys(ALLOWED_MODULE_FACADES),
      ...HOOK_BUNDLE_SOURCES.map((source) => `./${source}`),
    ]);
    assert.deepEqual(
      [...new Set(specifiers)].filter((specifier) => !inClosure.has(specifier)),
      [],
    );
    const generated = [...bundle.matchAll(/\brequire\("node:[a-z]+"\)/g)];
    assert.equal(generated.length, Object.keys(ALLOWED_MODULE_FACADES).length);
    assert.equal(
      generated.every((match) => match.index > bundle.lastIndexOf('__definitions[')),
      true,
    );
    assert.equal(bundle.includes('node_modules'), false);
  });

  test('asks the runtime for nothing outside the allowlist, at run time', () => {
    const asked = [];
    const escapes = [];
    const sandbox = {
      module: { exports: {} },
      exports: {},
      require(specifier) {
        asked.push(specifier);
        if (!Object.hasOwn(ALLOWED_MODULE_FACADES, specifier)) {
          escapes.push(specifier);
          throw new Error(`escaped the closure via ${specifier}`);
        }
        return require(specifier);
      },
      process: {
        argv: [],
        pid: 1,
        exitCode: 0,
        stdin: {
          on() {}, once() {}, removeAllListeners() {}, pause() {},
        },
        getBuiltinModule(specifier) {
          escapes.push(`getBuiltinModule:${specifier}`);
          throw new Error('getBuiltinModule reached');
        },
        env: { SECRET: 'must-not-be-read' },
      },
      Buffer,
      setTimeout,
      clearTimeout,
    };

    vm.runInNewContext(buildHookBundle(), sandbox);

    assert.deepEqual(asked.sort(), Object.keys(ALLOWED_MODULE_FACADES).sort());
    assert.deepEqual(escapes, []);
  });

  test('hands bundled modules a closed facade', async (t) => {
    const root = scratch(t);
    const probeDir = path.join(root, 'sources');
    mkdirSync(probeDir);
    writeFileSync(path.join(probeDir, 'probe-entry.js'), [
      "'use strict';",
      '',
      "const fs = require('node:fs');",
      "const nodePath = require('node:path');",
      "const crypto = require('node:crypto');",
      '',
      "fs.writeFileSync(nodePath.join(process.argv[2], 'probe.json'), JSON.stringify({",
      '  fsKeys: Object.keys(fs).sort(),',
      '  pathKeys: Object.keys(nodePath).sort(),',
      '  cryptoKeys: Object.keys(crypto).sort(),',
      '  processKeys: Object.keys(process).sort(),',
      '  requireType: typeof require,',
      '}));',
      '',
    ].join('\n'));
    const probeBundle = path.join(root, 'probe.js');
    writeFileSync(probeBundle, buildHookBundle({
      sourceDir: probeDir,
      sources: ['probe-entry.js'],
      entry: 'probe-entry.js',
    }), { mode: 0o644 });

    await execFileAsync(process.execPath, [probeBundle, root]);
    const report = JSON.parse(readFileSync(path.join(root, 'probe.json'), 'utf8'));

    assert.deepEqual(report.fsKeys, ['writeFileSync']);
    assert.deepEqual(report.pathKeys, ['join']);
    assert.deepEqual(report.cryptoKeys, ['createHash']);
    assert.deepEqual(report.processKeys, ['argv', 'pid', 'setExitCode', 'stdin']);
    assert.equal(report.requireType, 'function');
  });

  test('refuses a non-JavaScript source and an entry outside the declared set', (t) => {
    const shell = sourceTree(t, { 'stop.sh': '#!/bin/sh\n. ./env.sh\n' });
    assert.throws(
      () => buildHookBundle(shell),
      { code: 'CODEX_HOOK_BUNDLE_INVALID' },
    );

    assert.throws(
      () => buildHookBundle({
        sourceDir: HOOK_BUNDLE_SOURCE_DIR,
        sources: HOOK_BUNDLE_SOURCES,
        entry: 'observer-missing.js',
      }),
      { code: 'CODEX_HOOK_BUNDLE_INVALID' },
    );
  });

  test('the emitted bundle runs alone and records one observation per hook fire', async (t) => {
    const root = scratch(t);
    const installed = path.join(root, 'hook-observer.js');
    const captures = path.join(root, 'captures');
    mkdirSync(captures, { mode: 0o700 });
    writeFileSync(installed, buildHookBundle(), { mode: 0o644 });

    const payload = JSON.stringify({ turn_id: 'turn-42', hook_event_name: 'Stop' });
    const child = execFileAsync(process.execPath, [installed, 'Stop', captures]);
    child.child.stdin.end(payload);
    const { stdout, stderr } = await child;

    assert.equal(stdout, '');
    assert.equal(stderr, '');
    const files = readdirSync(captures);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(path.join(captures, files[0]), 'utf8'));
    assert.equal(record.event, 'Stop');
    assert.equal(record.status, 'ok');
    assert.equal(record.turnId, 'turn-42');
    assert.equal(record.payloadBytes, Buffer.byteLength(payload));
    assert.equal(typeof record.observedAtEpochMs, 'number');
    assert.equal(Object.keys(record).includes('payload'), false);
  });

  test('the build command is the drift gate for the checked-in bundle', async (t) => {
    const build = path.join(__dirname, '..', 'scripts', 'build-codex-hook-bundle.js');
    const ok = await execFileAsync(process.execPath, [build, '--check']);
    assert.match(ok.stdout, /^ok [a-f0-9]{64}\n$/);

    const root = scratch(t);
    const drifted = path.join(root, 'hook-observer.bundle.js');
    writeFileSync(drifted, `${buildHookBundle()}// hand edited\n`, { mode: 0o644 });

    await assert.rejects(
      execFileAsync(process.execPath, [build, '--check', '--out', drifted]),
      (error) => (
        error.code === 1
        && /is not what the sources build/.test(error.stderr)
      ),
    );

    await execFileAsync(process.execPath, [build, '--out', drifted]);
    assert.equal(readFileSync(drifted, 'utf8'), buildHookBundle());
  });

  test('rejects an overflowed payload whole instead of parsing its prefix', async (t) => {
    const root = scratch(t);
    const installed = path.join(root, 'hook-observer.js');
    const captures = path.join(root, 'captures');
    mkdirSync(captures, { mode: 0o700 });
    writeFileSync(installed, buildHookBundle(), { mode: 0o644 });

    const oversized = `{"turn_id":"turn-42","pad":"${'x'.repeat(512 * 1024)}"}`;
    const child = execFileAsync(process.execPath, [installed, 'UserPromptSubmit', captures]);
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(oversized);
    await child;

    const files = readdirSync(captures);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(path.join(captures, files[0]), 'utf8'));
    assert.equal(record.status, 'overflow');
    assert.equal(record.turnId, null);
    assert.equal(record.payloadSha256, null);
  });
});
