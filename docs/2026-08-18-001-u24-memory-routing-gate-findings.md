# U24 narrow memory-routing gate findings

Date: 2026-08-18  
Status: the reviewed single-retry implementation and VPS shape gate passed;
the one authorized full VPS gate stopped on two exhausted process timeouts, so
U24 remains blocked.

## Decision

Use one fixed Claude CLI/Haiku router for facts extracted from both Claude and
Codex sessions. Do not use Codex CLI 0.145 as the router: it exposes built-in
tools and has no preventive equivalent of Claude CLI's `--tools ""`. Rejecting
a tool event after the turn would be too late. This decision avoids adding a
new filesystem/process sandbox to Polygram.

Native memsearch extraction remains unchanged. U24 classifies or splits only
the already-extracted synthetic fact shape. It does not publish memory and is
not production memory code.

## Verified locally

- Frozen corpus: 26 synthetic facts — 8 ordinary work, 8 personal, 4 mixed,
  2 uncertain-but-non-private work, 2 known-shape secrets, and 2 prose-form
  credentials.
- Full-gate arithmetic: 26 facts × 5 repetitions × 1 fixed router = 130
  routing outcomes; 4 injected fault classes × 5 = 20 fault outcomes.
- Deterministic secret rejection runs before the adapter and the four secret
  fixtures never reach a model.
- For non-mixed facts, Haiku decides only `work` versus `personal`; the
  validator discards model-rewritten text and returns the original sanitized
  source fact. For mixed facts, both parts must be exact source spans with a
  unique, non-overlapping decomposition. Only the closed interior connector
  `because` or `after` may be omitted; accepted text is sliced from the source.
- Mixed projection is part-scoped: work writes to own-private plus general;
  sensitive writes only to own-private.
- Eligible operational faults retry internally without an intermediate
  projection. A terminal failure selects no destination and produces one
  destination-free queue-request projection in the gate receipt; U15/U16 own
  the future durable production queue.
- Claude invocation fixes `--safe-mode`, `--tools ""`, empty strict MCP config,
  schema output, no session persistence, and low effort.
- Child environment is a positive non-credential allowlist. Claude auth must
  report exactly `loggedIn: true`, `apiProvider: firstParty`, and
  `authMethod: claude.ai`. Codex must report `Logged in using ChatGPT`.
- Uncertain meaning without a personal-sensitive cue is ordinary `work`.
  There is no operationally redundant `semantic_uncertain` output category.
- Shape mode accepts exactly one observed `claude-haiku-*` model. Full mode
  requires the exact model ID recorded by the shape receipt.
- Timeout handling kills the owned process group, waits for confirmed close,
  and removes the adapter temp directory. The child/grandchild regression
  passed three consecutive runs.
- STOP evidence retains only closed error codes, exit/signal, stderr byte
  count, and cleanup confirmation. It stores no stderr, source-derived digest,
  fact text, account identifier, or credential.

Focused plus adjacent verification under Node 24.4.0:

```text
tests 127
pass 127
fail 0
skipped 0
```

The default shell currently resolves Node 26, while `better-sqlite3` is built
for Node 24. The first adjacent test attempt therefore had 25 ABI load failures
before SQLite tests started. Re-running the unchanged command with the
repository Node 24.4.0 runtime passed 127/127; no dependency was rebuilt.

The later single-retry amendment was independently reviewed after its
red-to-green implementation. Its focused suite passed 28/28 and the adjacent
six-file suite passed 92/92 under Node 24, with no skipped tests. The retry
wrapper permits at most two adapter attempts, projects only one terminal
result, stops all later cases after unconfirmed process cleanup, and preserves
bounded all-attempt model/privacy evidence.

## Exact local preflight evidence

The executable runner attested these local binaries:

| Runtime | Version | SHA-256 | Local path |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.145.0` | `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590` | `/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex` |
| Claude | `2.1.220 (Claude Code)` | `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081` | `/Users/ivanshumkov/.local/share/polygram/claude-bin/2.1.220` |

Codex login status was ChatGPT. Claude 2.1.220 auth status was
`loggedIn: false`, `authMethod: none`, `apiProvider: firstParty`. The local
shape command therefore wrote a content-free `ROUTER_AUTH_AMBIGUOUS` STOP
receipt and made zero routing model calls. This is the expected result for an
unauthorized host, not a classifier failure.

## VPS live evidence after the single-retry amendment

The gate ran from a mode-0700 temporary directory with Node 24.18.1. It did
not change installed Polygram 0.38.9, service configuration, its database, or
production data. The initial Linux auth preflight exposed one cross-platform
CLI difference: Codex 0.145 writes its successful login-status line to stderr
on Linux and stdout on macOS. The runner accepts the exact ChatGPT status from
exactly one stream and rejects duplicates, warnings, or any other value.

Final attested runtime evidence:

| Runtime | Version/model | SHA-256/auth |
| --- | --- | --- |
| Codex | `codex-cli 0.145.0`, `x86_64-unknown-linux-musl` | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`; ChatGPT |
| Claude | `2.1.220 (Claude Code)`, observed `claude-haiku-4-5-20251001` | `674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863`; first-party `claude.ai` |

The first shape receipt used `/usr/bin/codex`, which is an npm wrapper rather
than the native executable. Binary attestation correctly returned `STOP` with
zero model calls. This was a preflight-path error, not routing evidence. The
corrected receipt used the native executable inside the installed Codex npm
package.

| Receipt | SHA-256 | Bytes | Result |
| --- | --- | ---: | --- |
| `shape.json` | `5541f48188ebc4ab09bfb69cd5eaf0981f751830f9b2972ec4af0fa42e97902f` | 279 | `STOP`: wrapper failed native attestation |
| `shape-native.json` | `c032b080971a62a4aea91a154dab151d66e1b618fc24c22efae287776c61ebba` | 11,539 | `CONTINUE` |
| `full.json` | `559ae954b59b400e9b4e3f74fc07762a653c4df0b26d13a2e2b357f22603b51f` | 78,462 | `STOP`: retry budget/exhaustion |

The corrected shape receipt was `CONTINUE` for manifest
`0da0532765f350f1dc89287d5feb5e8ecd2ff16a84d8b7e2b73b2fc7a4b87d48`.
Its six logical cases produced four accepted results, two pre-model secret
quarantines, four adapter attempts, and no retry, recovery, exhaustion,
mismatch, or privacy flag. The exact observed model was
`claude-haiku-4-5-20251001`. All projection and arithmetic checks passed. The
fault suite also passed all 20 logical cases with 40 attempts, 20 exhausted
synthetic retries, 20 destination-free terminal queue requests, and no
destination. The shape retry budget of zero natural retries passed.

The one authorized full receipt was `STOP`:

```text
logical routing outcomes               130
accepted                               108
secret-quarantined                      20
terminal operational errors              2
mismatches                                0
zero-attempt cases                       20
first-attempt cases                     110
retried / recovered / exhausted     4 / 2 / 2
adapter attempts                        114
attempts with / without model evidence 109 / 5
all-attempt privacy flags                 0
terminal destination-free queues         2
fault outcomes / attempts / queues 20 / 40 / 20
```

Both recoveries completed within the gate contract: one `mixed-03` case
recovered after `ROUTER_MIXED_COVERAGE`, and one `personal-02` case recovered
after a timeout.
The exhausted cases were `personal-02` and `mixed-03`; each timed out twice,
with confirmed process cleanup after its process failures. Both terminal
failures selected no destination and each produced one destination-free
queue-request projection, two total. The receipt contained no privacy flags or
mismatches, observed only the exact pinned Haiku model, and passed its projection, arithmetic,
model-identity, and 20/20 fault checks.

The pre-registered full-mode budget permits at most one recovered natural retry
and no exhausted natural retry. Two recoveries plus two exhaustions therefore
fail it. This is operational timeout/process-boundary reliability evidence,
not a privacy, model-identity, projection, or arithmetic failure. The retry
implementation and review are complete, but U24 remains blocked. Do not rerun
the unchanged gate in hope that it happens to pass. The next decision is a
separate, narrow characterization of the timeouts/process boundary and router
choice; it is not part of this evidence run. A finite passing fixture would
still leave residual semantic-miss risk as an explicit rollout decision.
