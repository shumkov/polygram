# Scoped-memory publication atomicity gate

This spike models one partner memory as two linked siblings: partner-private
and general UMI. The siblings use separate body directories and index
databases. One SQLite transaction checkpoints the candidate and complete
linked-destination set; its logical-record marker is the only recall visibility
authority.

The standalone gate hard-crashes a child process at 22 independently pinned
points: before/during/after the candidate-and-destination checkpoint and each
staged-file write, before/after each body move, before/during/after each index
transaction, and before/during/after logical activation. Each post-crash
observation must be unavailable before the checkpoint, expose neither sibling
before activation, or expose both after it. A fresh recovery subprocess then
converges to both, and a second fresh recovery must leave the normalized
durable-state snapshot semantically unchanged: logical/destination rows,
complete body/staging inventories and contents, index rows, and recall results.

The gate also removes one active body and a different active index. Its boot
wrapper rejects both recall scopes until sequential repair finishes. That is a
sequencing prototype, not a concurrent service-admission test; U3 must test the
real request gate while boot reconciliation is in flight.

```sh
python3 -B -m unittest discover \
  -s scripts/spikes/memory-publication-atomicity -p 'test_*.py'
python3 -B scripts/spikes/memory-publication-atomicity/run_gate.py
node --test tests/scoped-memory-publication-atomicity-spike.test.js
```

This proves abrupt userspace process-crash recovery for the visibility and
reconciliation algorithm with filesystem bodies, separate SQLite indexes, and
a real state database. It does not claim power-loss durability. U3 must repeat
the unchanged matrix through the pinned memsearch adapter; direct memsearch
access remains prohibited because only memoryd applies the logical visibility
marker.
