'use strict';

const acorn = require('acorn');

// A positive syntax policy over the checked-in hook sources. A facade is a
// convenience for the code that passes this gate, not a sandbox: `writeFileSync
// ['constructor']` reaches the host realm from any function value, and the
// property name can be assembled at run time, so no textual scan can see it.
// What the gate accepts is therefore enumerated here, and everything else —
// unknown syntax, unknown free identifiers, computed property access, and any
// member outside a facade's exact surface — is refused.

const ALLOWED_NODE_TYPES = new Set([
  'ArrayExpression',
  'ArrayPattern',
  'ArrowFunctionExpression',
  'AssignmentExpression',
  'AssignmentPattern',
  'AwaitExpression',
  'BinaryExpression',
  'BlockStatement',
  'BreakStatement',
  'CallExpression',
  'CatchClause',
  'ChainExpression',
  'ConditionalExpression',
  'ContinueStatement',
  'DoWhileStatement',
  'EmptyStatement',
  'ExpressionStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'Identifier',
  'IfStatement',
  'Literal',
  'LogicalExpression',
  'MemberExpression',
  'NewExpression',
  'ObjectExpression',
  'ObjectPattern',
  'Program',
  'Property',
  'RestElement',
  'ReturnStatement',
  'SpreadElement',
  'TemplateElement',
  'TemplateLiteral',
  'ThrowStatement',
  'TryStatement',
  'UnaryExpression',
  'UpdateExpression',
  'VariableDeclaration',
  'VariableDeclarator',
  'WhileStatement',
]);

// Free identifiers a source may name. `require` and `process` are the injected
// facades; the rest are realm intrinsics with no loader on them.
const ALLOWED_FREE_IDENTIFIERS = new Set([
  'Array',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'Infinity',
  'JSON',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'String',
  'clearTimeout',
  'exports',
  'module',
  'process',
  'require',
  'setTimeout',
  'undefined',
]);

const ALLOWED_CONSTRUCTORS = new Set(['Error', 'Promise']);

// Property names that hand back a function's realm, its prototype chain, or a
// rebound receiver.
const DENIED_PROPERTIES = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'apply',
  'arguments',
  'bind',
  'call',
  'caller',
  'constructor',
  'prototype',
]);

// Names that denote a loader, a child process, or an external read on any
// receiver. A hook source has no use for them, so they are refused wherever
// they appear rather than only on a receiver the gate can resolve.
const DENIED_MEMBER_NAMES = new Set([
  'binding',
  'createReadStream',
  'dlopen',
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'getBuiltinModule',
  'open',
  'openSync',
  'read',
  'readFile',
  'readFileSync',
  'readSync',
  'readdir',
  'readdirSync',
  'require',
  'spawn',
  'spawnSync',
]);

// Ambient intrinsics carry reflection that hands back a function's realm, so
// their surface is positive too: a member not listed here is refused rather
// than reasoned about.
const GLOBAL_MEMBER_POLICY = new Map([
  ['Array', new Set(['from', 'isArray', 'of'])],
  ['Buffer', new Set(['alloc', 'byteLength', 'concat', 'from', 'isBuffer'])],
  ['Date', new Set(['now'])],
  ['JSON', new Set(['parse', 'stringify'])],
  ['Math', new Set(['abs', 'ceil', 'floor', 'max', 'min', 'round'])],
  ['Number', new Set(['isFinite', 'isInteger', 'parseFloat', 'parseInt'])],
  ['Object', new Set(['assign', 'entries', 'freeze', 'fromEntries', 'hasOwn', 'keys', 'values'])],
  ['Promise', new Set(['all', 'allSettled', 'race', 'reject', 'resolve'])],
  ['String', new Set(['fromCharCode'])],
]);

// The members a bundled module may use on the injected `process` facade. The
// facade carries only these, and the gate refuses the rest by name so a source
// cannot be written against a wider host `process`.
const ALLOWED_PROCESS_MEMBERS = new Set(['argv', 'pid', 'setExitCode', 'stdin']);

function isNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.type === 'string';
}

function children(node) {
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry)) found.push(entry);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

// Only the binding side of a pattern declares names. A default value is an
// ordinary expression — descending into it would let `(value = process) => …`
// register `process` as a local name.
function collectPatternNames(node, names) {
  if (!isNode(node)) return;
  if (node.type === 'Identifier') {
    names.add(node.name);
    return;
  }
  if (node.type === 'Property') {
    collectPatternNames(node.value, names);
    return;
  }
  if (node.type === 'AssignmentPattern') {
    collectPatternNames(node.left, names);
    return;
  }
  for (const child of children(node)) collectPatternNames(child, names);
}

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

// Scopes are resolved lexically. A binding introduced inside one function or
// block must not vouch for an ambient identifier at a use site that binding
// never covers, so every name is looked up along its own scope chain.
function createScope(parent) {
  return { parent, names: new Set() };
}

function resolvesIn(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(name)) return true;
  }
  return false;
}

// Only `var` hoists to the enclosing function; the walk stops at nested
// functions, which own their own hoisting. A function declared inside a block
// is block-scoped under strict mode, so it is collected by that block rather
// than promoted outward from here.
function collectHoistedNames(node, names) {
  if (FUNCTION_TYPES.has(node.type)) return;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declarator of node.declarations) collectPatternNames(declarator.id, names);
  }
  for (const child of children(node)) collectHoistedNames(child, names);
}

function collectLexicalNames(statements, names) {
  for (const statement of statements ?? []) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) {
        collectPatternNames(declarator.id, names);
      }
    }
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      names.add(statement.id.name);
    }
  }
}

function scopeFor(node, parent) {
  if (FUNCTION_TYPES.has(node.type)) {
    const scope = createScope(parent);
    if (node.id) scope.names.add(node.id.name);
    for (const param of node.params) collectPatternNames(param, scope.names);
    if (node.body.type === 'BlockStatement') {
      collectHoistedNames(node.body, scope.names);
      collectLexicalNames(node.body.body, scope.names);
    }
    return scope;
  }
  if (node.type === 'BlockStatement') {
    const scope = createScope(parent);
    collectLexicalNames(node.body, scope.names);
    return scope;
  }
  if (node.type === 'ForStatement' || node.type === 'ForOfStatement') {
    const scope = createScope(parent);
    const declaration = node.init ?? node.left;
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        collectPatternNames(declarator.id, scope.names);
      }
    }
    return scope;
  }
  if (node.type === 'CatchClause') {
    const scope = createScope(parent);
    if (node.param) collectPatternNames(node.param, scope.names);
    return scope;
  }
  return parent;
}

function programScope(program) {
  const scope = createScope(null);
  collectHoistedNames(program, scope.names);
  collectLexicalNames(program.body, scope.names);
  return scope;
}

function requireSpecifier(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier'
    || node.callee.name !== 'require') {
    return null;
  }
  return node;
}

// `const { a } = require('x')` and `const ns = require('x')` are the only
// shapes a source may use, so every imported name stays statically known.
function collectFacadeBindings(program, reject, allowedSpecifiers, facadeMembers) {
  const namespaces = new Map();
  const visit = (node, parent) => {
    const call = requireSpecifier(node);
    if (call) {
      if (call.arguments.length !== 1 || call.arguments[0].type !== 'Literal'
        || typeof call.arguments[0].value !== 'string') {
        reject('a require of a computed module specifier');
      }
      const specifier = call.arguments[0].value;
      if (!allowedSpecifiers.has(specifier)) {
        reject(`a require of ${specifier}, which is outside the closure`);
      }
      if (!parent || parent.type !== 'VariableDeclarator' || parent.init !== call) {
        reject('a require outside a plain binding declaration');
      }
      const members = facadeMembers.get(specifier);
      if (parent.id.type === 'ObjectPattern') {
        for (const property of parent.id.properties) {
          if (property.type !== 'Property' || property.computed
            || property.key.type !== 'Identifier') {
            reject('a computed or spread import binding');
          }
          if (members && !members.has(property.key.name)) {
            reject(`the member ${property.key.name} of ${specifier}, which the facade does not carry`);
          }
        }
      } else if (parent.id.type === 'Identifier') {
        if (members) namespaces.set(parent.id.name, specifier);
      } else {
        reject('a require bound to a pattern the gate cannot follow');
      }
    }
    for (const child of children(node)) visit(child, node);
  };
  visit(program, null);
  return namespaces;
}

function auditProgram(program, {
  reject,
  allowedSpecifiers,
  facadeMembers,
  processMembers = ALLOWED_PROCESS_MEMBERS,
}) {
  const namespaces = collectFacadeBindings(program, reject, allowedSpecifiers, facadeMembers);
  const skipped = new Set();

  const visit = (node, scope) => {
    if (!ALLOWED_NODE_TYPES.has(node.type)) {
      reject(`the unsupported syntax ${node.type}`);
    }
    if (node.type === 'ObjectPattern') {
      // Destructuring reads properties without a member expression, and a
      // pattern over an arbitrary value is how `constructor` is lifted off a
      // function. Only an import binding destructures a value here.
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed
          || property.key.type !== 'Identifier') {
          reject('an unsupported destructuring shape');
        } else if (DENIED_PROPERTIES.has(property.key.name)
          || DENIED_MEMBER_NAMES.has(property.key.name)) {
          reject(`the destructured property ${property.key.name}`);
        }
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern'
      && !(node.init && requireSpecifier(node.init))) {
      reject('a destructuring of a value that is not an import');
    }
    if (node.type === 'MemberExpression') {
      if (node.computed) {
        const index = node.property;
        if (index.type !== 'Literal' || typeof index.value !== 'number') {
          reject('computed member access');
        }
      } else {
        if (node.property.type !== 'Identifier') {
          reject('a member access the gate cannot read');
        }
        skipped.add(node.property);
        if (DENIED_PROPERTIES.has(node.property.name)) {
          reject(`the property escape ${node.property.name}`);
        }
        if (DENIED_MEMBER_NAMES.has(node.property.name)) {
          reject(`the denied member ${node.property.name}`);
        }
        if (node.object.type === 'Identifier') {
          // An import binding is checked wherever it is named; the ambient
          // rules apply only where the name is not bound by an inner scope.
          const specifier = namespaces.get(node.object.name);
          const members = specifier ? facadeMembers.get(specifier) : null;
          if (members && !members.has(node.property.name)) {
            reject(`the member ${node.property.name} of ${specifier}, which the facade does not carry`);
          }
          if (!resolvesIn(scope, node.object.name)) {
            if (node.object.name === 'process'
              && !processMembers.has(node.property.name)) {
              reject(`the host process member ${node.property.name}`);
            }
            const intrinsic = GLOBAL_MEMBER_POLICY.get(node.object.name);
            if (intrinsic && !intrinsic.has(node.property.name)) {
              reject(`the reflective member ${node.object.name}.${node.property.name}`);
            }
          }
        }
      }
    }
    if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier') {
      skipped.add(node.key);
    }
    if (node.type === 'NewExpression'
      && (node.callee.type !== 'Identifier' || !ALLOWED_CONSTRUCTORS.has(node.callee.name))) {
      reject('a construction outside the allowed set');
    }
    if (node.type === 'CallExpression'
      && !['Identifier', 'MemberExpression'].includes(node.callee.type)) {
      reject('a call on a computed callee');
    }
    if (node.type === 'Identifier' && !skipped.has(node)
      && !resolvesIn(scope, node.name) && !ALLOWED_FREE_IDENTIFIERS.has(node.name)) {
      reject(`the unknown identifier ${node.name}`);
    }
    const inner = scopeFor(node, scope);
    for (const child of children(node)) visit(child, inner);
  };
  visit(program, programScope(program));
}

function parseSource(text) {
  return acorn.parse(text, {
    ecmaVersion: 2022,
    sourceType: 'script',
    allowReturnOutsideFunction: false,
    allowAwaitOutsideFunction: false,
    allowHashBang: false,
  });
}

function parsesAsModule(text) {
  try {
    acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module' });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  ALLOWED_FREE_IDENTIFIERS,
  GLOBAL_MEMBER_POLICY,
  DENIED_MEMBER_NAMES,
  ALLOWED_NODE_TYPES,
  ALLOWED_PROCESS_MEMBERS,
  DENIED_PROPERTIES,
  auditProgram,
  parseSource,
  parsesAsModule,
};
