'use strict';

// Per-chat and per-topic MCP servers for the CLI backend
// (docs/CLI_MCP_SERVERS_SPEC.md). Orchestra resolves `mcpServers` from the
// chat config it is handed, so polygram's job is to hand over the whole chat
// config, topics included. If buildSpawnContext were ever narrowed to a field
// list (as the SDK path does), the instagram topic would silently lose Canva.
// polygram.js runs main() on require, so these are source-wiring checks in the
// same style as the other polygram-*-wiring tests.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('CLI MCP servers wiring', () => {
  test('the Claude spawn context carries the live chat config object, topics and all', () => {
    const spawn = sectionBetween('async function buildSpawnContext', 'async function getOrSpawnForChat');
    assert.match(spawn, /const chatConfig = config\.chats\[chatId\];/);
    const claudeReturn = spawn.slice(spawn.lastIndexOf('return {'));
    assert.match(claudeReturn, /^return \{\s*chatConfig,/);
    assert.doesNotMatch(claudeReturn, /chatConfig:\s*\{/);
    // Orchestra picks the topic's mcpServers with chatConfig.topics[threadId]:
    // without the thread id a topic-scoped server (Canva in topic 1306) is lost.
    assert.match(claudeReturn, /^return \{\s*chatConfig,\s*chatId,\s*threadId: threadId \|\| null,/);
  });

  test('boot removes mcp-config files left by dead sessions, after the tmux orphan sweep', () => {
    assert.match(source, /const \{ sweepStaleMcpConfigs \} = require\('@shumkov\/orchestra'\);/);
    const boot = sectionBetween('sweepResult = await sweepTmuxOrphans({', 'db = dbClient.open(DB_PATH);');
    assert.match(boot, /await sweepStaleMcpConfigs\(\{\s*sessionPrefix: 'polygram',/);
  });
});
