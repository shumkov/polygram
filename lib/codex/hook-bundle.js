'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  auditProgram,
  parseSource,
  parsesAsModule,
} = require('./hook-source-policy');

const HOOK_BUNDLE_SOURCE_DIR = path.join(__dirname, 'hooks');
const HOOK_BUNDLE_SOURCES = Object.freeze([
  'observer-capture.js',
  'observer-entry.js',
]);
const HOOK_BUNDLE_ENTRY = 'observer-entry.js';
const HOOK_BUNDLE_PATH = path.join(
  HOOK_BUNDLE_SOURCE_DIR,
  'hook-observer.bundle.js',
);

// Bundled code reaches the runtime through these facades and through nothing
// else. The allowlist is closed at the member level, not the module level: a
// facade that exposed all of `node:fs` would hand the closure an arbitrary
// external read, which is precisely what it must not have.
const ALLOWED_MODULE_FACADES = Object.freeze({
  'node:crypto': Object.freeze(['createHash']),
  'node:fs': Object.freeze(['writeFileSync']),
  'node:path': Object.freeze(['join']),
});

// Names bound in every module's own scope. `require` is the facade loader;
// the rest are bound to `undefined` so a bundled module cannot reach the real
// loader, the real process, or the Function constructor by name.
const INJECTED_BINDINGS = Object.freeze([
  'module',
  'exports',
  'require',
  'process',
  'globalThis',
  'global',
  'Function',
]);

// The curated process surface. `getBuiltinModule`, `binding`, `dlopen`, `env`
// and `mainModule` are absent by construction rather than by inspection.
const PROCESS_FACADE_KEYS = Object.freeze(['argv', 'pid', 'setExitCode', 'stdin']);

const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9.-]*\.js$/;
const MAX_SOURCE_BYTES = 256 * 1024;

class CodexHookBundleError extends Error {
  constructor(message, code, action) {
    super(message);
    this.name = 'CodexHookBundleError';
    this.code = code;
    this.action = action;
  }
}

function invalid(message) {
  return new CodexHookBundleError(
    message,
    'CODEX_HOOK_BUNDLE_INVALID',
    'Declare the checked-in hook sources exactly, and rebuild.',
  );
}

function unsafe(message) {
  return new CodexHookBundleError(
    message,
    'CODEX_HOOK_BUNDLE_UNSAFE_SOURCE',
    'Keep every executed input inside the bundle; a hook source may use only '
      + 'the declared syntax, identifiers, and facade members.',
  );
}

function specifierKey(specifier) {
  return specifier.startsWith('./') ? specifier : `./${specifier}`;
}

function defaultAllowedSpecifiers(sources) {
  return [
    ...Object.keys(ALLOWED_MODULE_FACADES),
    ...sources.map(specifierKey),
  ];
}

function facadeMemberIndex() {
  return new Map(
    Object.entries(ALLOWED_MODULE_FACADES)
      .map(([specifier, members]) => [specifier, new Set(members)]),
  );
}

// The mechanical proof that a checked-in source stays inside the closure. The
// emitted facades narrow what that code can reach at run time, but they are
// defence in depth: this gate is what decides whether a source may ship.
function assertSourcePolicy(text, {
  label = 'source',
  allowedSpecifiers = defaultAllowedSpecifiers(HOOK_BUNDLE_SOURCES),
} = {}) {
  let program;
  try {
    program = parseSource(text);
  } catch (error) {
    // Module syntax parses only as a module, and is a policy refusal rather
    // than a malformed file: the bundle format has no import machinery.
    if (parsesAsModule(text)) {
      throw unsafe(`Codex hook source ${label} contains ECMAScript module syntax.`);
    }
    throw invalid(`Codex hook source ${label} does not parse: ${error.message}`);
  }
  auditProgram(program, {
    reject(reason) {
      throw unsafe(`Codex hook source ${label} contains ${reason}.`);
    },
    allowedSpecifiers: new Set(allowedSpecifiers),
    facadeMembers: facadeMemberIndex(),
    processMembers: new Set(PROCESS_FACADE_KEYS),
  });
  return text;
}

// The generated wrapper is not source the policy can audit — it exists to
// deny — so the emitted file is checked for the one property that matters
// here: no specifier outside the closure reaches the real loader.
function assertEmittedBundle(text, { allowedSpecifiers }) {
  const allowed = new Set(allowedSpecifiers);
  for (const match of text.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
    const literal = /^\s*(['"])([^'"]+)\1\s*$/.exec(match[1]);
    if (!literal) {
      throw unsafe('The generated bundle requires a computed module specifier.');
    }
    if (!allowed.has(literal[2]) && !allowed.has(specifierKey(literal[2]))) {
      throw unsafe(
        `The generated bundle loads ${literal[2]} from outside the closure.`,
      );
    }
  }
  return text;
}

function renderFacades() {
  const modules = Object.entries(ALLOWED_MODULE_FACADES)
    .map(([specifier, members]) => {
      const fields = members
        .map((member) => `${member}: require(${JSON.stringify(specifier)}).${member}`)
        .join(', ');
      return `    ${JSON.stringify(specifier)}: Object.freeze({ ${fields} })`;
    })
    .join(',\n');
  return `  Object.freeze({\n${modules}\n  })`;
}

// The raw loader is used once, in this argument list, and is never bound to a
// name. Bundled modules run inside the function below, where `require` and
// `process` are the frozen facades and the remaining escape hatches are bound
// to undefined.
function renderBundle(modules, entry) {
  const bodies = modules.map(({ name, text }) => [
    `  __definitions[${JSON.stringify(specifierKey(name))}] = `
      + `function (${INJECTED_BINDINGS.join(', ')}) {`,
    text.endsWith('\n') ? text.slice(0, -1) : text,
    '  };',
    '',
  ].join('\n')).join('\n');

  return [
    "'use strict';",
    '',
    '// Generated from the checked-in Codex hook sources by the bundle build',
    '// step. Bundled modules see only the frozen facades passed in below, so',
    '// the protected closure is the runtime, this file, and nothing else.',
    '// Edit the sources and rebuild; never edit this file by hand.',
    '',
    '(function (__facades, __process) {',
    '  const __definitions = Object.create(null);',
    '  const __instances = Object.create(null);',
    '',
    '  function __load(__specifier) {',
    '    if (Object.hasOwn(__facades, __specifier)) return __facades[__specifier];',
    '    const __definition = __definitions[__specifier];',
    '    if (__definition === undefined) {',
    "      throw new Error('bundled module ' + __specifier + ' is outside the closure');",
    '    }',
    '    let __instance = __instances[__specifier];',
    '    if (__instance === undefined) {',
    '      __instance = { exports: {} };',
    '      __instances[__specifier] = __instance;',
    '      __definition(',
    '        __instance, __instance.exports, __load, __process,',
    '        undefined, undefined, undefined,',
    '      );',
    '    }',
    '    return __instance.exports;',
    '  }',
    '',
    bodies,
    `  __load(${JSON.stringify(specifierKey(entry))});`,
    '}(',
    renderFacades(),
    ',',
    '  Object.freeze({',
    '    argv: Object.freeze(process.argv.slice()),',
    '    pid: process.pid,',
    '    setExitCode(code) { process.exitCode = code; },',
    '    stdin: process.stdin,',
    '  })',
    '));',
    '',
  ].join('\n');
}

function readSource(sourceDir, name) {
  if (typeof name !== 'string' || !SOURCE_NAME_RE.test(name)) {
    throw invalid(
      `Codex hook source ${JSON.stringify(name)} is not a checked-in `
        + 'JavaScript file name.',
    );
  }
  let text;
  try {
    text = readFileSync(path.join(sourceDir, name), 'utf8');
  } catch (error) {
    throw invalid(`Codex hook source ${name} could not be read.`);
  }
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
    throw invalid(`Codex hook source ${name} is larger than the bundle limit.`);
  }
  return text;
}

function buildHookBundle({
  sourceDir = HOOK_BUNDLE_SOURCE_DIR,
  sources = HOOK_BUNDLE_SOURCES,
  entry = HOOK_BUNDLE_ENTRY,
} = {}) {
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
    throw invalid('Codex hook source directory must be an absolute path.');
  }
  if (!Array.isArray(sources) || sources.length === 0
    || new Set(sources).size !== sources.length) {
    throw invalid('Codex hook sources must be a unique non-empty list.');
  }
  if (!sources.includes(entry)) {
    throw invalid(`Codex hook entry ${entry} is not a declared source.`);
  }
  const allowedSpecifiers = defaultAllowedSpecifiers(sources);
  const modules = sources.map((name) => {
    const text = readSource(sourceDir, name);
    assertSourcePolicy(text, { label: name, allowedSpecifiers });
    return { name, text };
  });
  return assertEmittedBundle(renderBundle(modules, entry), { allowedSpecifiers });
}

// The single trusted artifact body. A checked-in bundle that its sources no
// longer produce is refused here, so nothing downstream can install or attest
// a stale one.
function readCheckedInBundle() {
  const expected = buildHookBundle();
  let contents;
  try {
    contents = readFileSync(HOOK_BUNDLE_PATH, 'utf8');
  } catch (error) {
    throw invalid('The checked-in Codex hook bundle is missing.');
  }
  if (contents !== expected) {
    throw invalid(
      'The checked-in Codex hook bundle is not what its sources build.',
    );
  }
  return Object.freeze({
    contents,
    path: HOOK_BUNDLE_PATH,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

module.exports = {
  ALLOWED_MODULE_FACADES,
  CodexHookBundleError,
  HOOK_BUNDLE_ENTRY,
  HOOK_BUNDLE_PATH,
  HOOK_BUNDLE_SOURCES,
  HOOK_BUNDLE_SOURCE_DIR,
  INJECTED_BINDINGS,
  PROCESS_FACADE_KEYS,
  assertEmittedBundle,
  assertSourcePolicy,
  buildHookBundle,
  readCheckedInBundle,
};
