#!/usr/bin/env node
/**
 * cli-driver-spike/validate-payloads.mjs — Phase 0.2.
 *
 * Reads the most recent hook ndjson from a run.mjs spike and validates:
 *   - every line parses cleanly via normalizeHookEvent (no parse-errors)
 *   - every event has a known `type` (no 'unknown' — that would mean
 *     hook_event_name drift since 2.1.142)
 *   - tool_input is populated for MCP tools (mcp__polygram-bridge__reply)
 *
 * Usage:
 *   node scripts/cli-driver-spike/validate-payloads.mjs [<ndjson-path>]
 *
 * If no path is given, picks the most recent cli-driver-spike-*.ndjson
 * under $TMPDIR.
 *
 * Exit: 0 on PASS, 1 on FAIL.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { normalizeHookEvent, KNOWN_EVENT_NAMES } = require('../../lib/process/hook-event-tail.js');

function findLatestSpikeNdjson() {
  const tmp = os.tmpdir();
  const dirs = fs.readdirSync(tmp)
    .filter((d) => d.startsWith('cli-driver-spike-'))
    .map((d) => ({ d, full: path.join(tmp, d), stat: fs.statSync(path.join(tmp, d)) }))
    .filter((x) => x.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (dirs.length === 0) throw new Error('no cli-driver-spike-* directory in tmpdir');
  const ndjson = fs.readdirSync(dirs[0].full).find((f) => f.endsWith('.ndjson'));
  if (!ndjson) throw new Error(`no .ndjson in ${dirs[0].full}`);
  return path.join(dirs[0].full, ndjson);
}

function main() {
  const ndjsonPath = process.argv[2] || findLatestSpikeNdjson();
  console.log(`=== cli-driver-spike validate-payloads.mjs (Phase 0.2) ===`);
  console.log(`reading: ${ndjsonPath}\n`);

  const raw = fs.readFileSync(ndjsonPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  let parseErrors = 0;
  let unknownTypes = 0;
  const typeCounts = new Map();
  const mcpToolEvents = [];
  const issues = [];

  for (const [i, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      parseErrors++;
      issues.push({ line: i + 1, kind: 'json-parse-error', error: err.message });
      continue;
    }

    const ev = normalizeHookEvent(parsed);

    if (ev.type === 'unknown') {
      unknownTypes++;
      issues.push({
        line: i + 1,
        kind: 'unknown-hook-event-name',
        hookEventName: parsed?.hook_event_name ?? null,
      });
    }
    if (ev.type === 'parse-error') {
      parseErrors++;
      issues.push({ line: i + 1, kind: 'normalize-parse-error', error: ev.error });
    }

    typeCounts.set(ev.type, (typeCounts.get(ev.type) || 0) + 1);

    if (typeof ev.toolName === 'string' && ev.toolName.startsWith('mcp__')) {
      mcpToolEvents.push({
        line: i + 1,
        type: ev.type,
        toolName: ev.toolName,
        toolInputPresent: ev.toolInput != null,
        toolInputKeys: ev.toolInput ? Object.keys(ev.toolInput) : null,
      });
    }
  }

  // Check known-event coverage
  const knownNames = [...KNOWN_EVENT_NAMES];
  const observedNames = [...typeCounts.keys()].filter((t) => knownNames.includes(t));

  // MCP tool_input populated check
  const mcpMissingInput = mcpToolEvents.filter((e) => e.type === 'PreToolUse' && !e.toolInputPresent);

  const verdict = {
    timestamp: new Date().toISOString(),
    ndjsonPath,
    totalLines: lines.length,
    parseErrors,
    unknownTypes,
    typeCounts: Object.fromEntries(typeCounts),
    knownEventNames: knownNames,
    observedKnownNames: observedNames,
    mcpToolEvents,
    mcpToolEventsMissingInput: mcpMissingInput,
    issues,
    pass: parseErrors === 0 && unknownTypes === 0 && mcpMissingInput.length === 0,
  };

  console.log(JSON.stringify(verdict, null, 2));
  console.log(`\n${verdict.pass ? 'PASS' : 'FAIL'} — ${lines.length} lines, ${parseErrors} parse-errors, ${unknownTypes} unknown types`);
  process.exit(verdict.pass ? 0 : 1);
}

main();
