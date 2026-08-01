const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_CRASH_POINTS = [
  'before_checkpoint',
  'during_checkpoint',
  'after_checkpoint',
  'before_partner_stage',
  'during_partner_stage',
  'after_partner_stage',
  'before_general_stage',
  'during_general_stage',
  'after_general_stage',
  'before_partner_move',
  'after_partner_move',
  'before_general_move',
  'after_general_move',
  'before_partner_index',
  'during_partner_index',
  'after_partner_index',
  'before_general_index',
  'during_general_index',
  'after_general_index',
  'before_activation',
  'during_activation',
  'after_activation',
];

test('partner publication crashes never expose only one linked sibling', () => {
  const runner = path.join(
    __dirname,
    '../scripts/spikes/memory-publication-atomicity/run_gate.py',
  );
  const result = spawnSync('python3', ['-B', runner], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.status, 'PASS');
  assert.deepEqual(evidence.crash_points_exercised, EXPECTED_CRASH_POINTS);
  assert.equal(evidence.checks.crash_matrix_complete, true);
  assert.equal(evidence.checks.no_half_visible_after_crash, true);
  assert.equal(evidence.checks.every_crash_recovers_both_siblings, true);
  assert.equal(evidence.checks.boot_repairs_before_recall, true);
  assert.equal(evidence.checks.reconciliation_is_idempotent, true);
});
