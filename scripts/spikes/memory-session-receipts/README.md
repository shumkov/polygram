# Scoped-memory session receipt gate

This sanitized spike uses Polygram's real SQLite schema plus temporary receipt
columns. A separate process running at the same uid rewrites each persisted
session table. An in-memory stand-in for protected memoryd state verifies an
opaque 256-bit receipt against the exact session key, provider namespace,
provider session ID, and policy identity. Rebinding the same logical session
revokes its previous receipt.

```sh
node scripts/spikes/memory-session-receipts/run-gate.js
node --test tests/scoped-memory-session-receipt-spike.test.js
```

The matrix covers a valid baseline, missing receipts, restoring a previously
valid receipt after rebinding, changing only the provider session ID,
rewriting an old row to the current policy identity, and copying a provider
session ID plus receipt across rows. Unit coverage independently changes each
of the four tuple fields. Every invalid case must delete the target row and
return a fresh-spawn decision in both `sessions` and
`agent_runtime_sessions`; an unrelated sibling row must remain byte-for-byte
unchanged after every rejection.

This proves the tuple-binding behavior and current DB attack shape. It does not
prove the storage boundary by itself: U3 must keep the authority and receipt
bindings in memoryd-owned protected state, and the live gate must repeat the
tamper from a real provider child.
