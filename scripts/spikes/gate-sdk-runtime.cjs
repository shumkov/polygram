
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inspectSdkRuntime(root) {
  if (!path.isAbsolute(root || '')) throw new Error('SDK root must be absolute');
  const realRoot = fs.realpathSync(root);
  const entry = path.join(realRoot, 'sdk.mjs');
  const packageFile = path.join(realRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.name !== '@anthropic-ai/claude-agent-sdk') throw new Error('wrong SDK package');
  return { root: realRoot, entry, identity: { version: pkg.version,
    claudeCodeVersion: pkg.claudeCodeVersion, entrySha256: hash(entry), packageSha256: hash(packageFile) } };
}
function assertSdkRuntime(root, expected, cliVersion) {
  const inspected = inspectSdkRuntime(root);
  if (!isDeepStrictEqual(inspected.identity, expected)
    || inspected.identity.claudeCodeVersion !== cliVersion) throw new Error('SDK identity does not match checked CLI/SDK pair');
  return inspected;
}
function assertSdkLoadProof({ proofPath, identity, runId, orchestraSourceSha256,
  orchestraSourcePath = require.resolve('@shumkov/orchestra/lib/process/sdk-process') }) {
  const stat = fs.lstatSync(proofPath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('SDK proof must be a private file');
  if (hash(orchestraSourcePath) !== orchestraSourceSha256) throw new Error('Orchestra source changed after SDK preload');
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  if (!isDeepStrictEqual(proof, { runId, identity, orchestraSourceSha256, loaded: true })) throw new Error('SDK load proof mismatch');
}
module.exports = { inspectSdkRuntime, assertSdkRuntime, assertSdkLoadProof };
if (process.env.CLAUDE_GATE_SDK_ROOT) {
  const expected = JSON.parse(process.env.CLAUDE_GATE_SDK_EXPECTED);
  const inspected = assertSdkRuntime(process.env.CLAUDE_GATE_SDK_ROOT, expected, process.env.CLAUDE_GATE_EXPECTED_VERSION);
  const sourcePath = require.resolve('@shumkov/orchestra/lib/process/sdk-process');
  if (hash(sourcePath) !== process.env.CLAUDE_GATE_ORCHESTRA_SOURCE_SHA256) throw new Error('Orchestra SDK process source mismatch');
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: pathToFileURL(inspected.entry).href, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  const sdk = require('@anthropic-ai/claude-agent-sdk');
  if (typeof sdk.query !== 'function' || sdk.query !== require(inspected.entry).query) throw new Error('SDK module not loaded from selected root');
  assertSdkRuntime(inspected.root, expected, process.env.CLAUDE_GATE_EXPECTED_VERSION);
  Object.defineProperty(globalThis, Symbol.for('polygram.gate.sdk'), { value: Object.freeze(expected) });
  fs.writeFileSync(process.env.CLAUDE_GATE_SDK_ATTESTATION_PATH, JSON.stringify({ runId: process.env.CLAUDE_GATE_RUN_ID,
    identity: expected, orchestraSourceSha256: hash(sourcePath), loaded: true }) + '\n', { flag: 'wx', mode: 0o600 });
}
