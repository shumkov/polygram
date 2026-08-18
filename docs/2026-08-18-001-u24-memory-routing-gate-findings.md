# U24 narrow memory-routing gate findings

Date: 2026-08-18  
Status: final local harness and VPS shape gate passed; full VPS gate stopped on
one real mixed-split coverage error, so U24 remains blocked.

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
- Operational faults queue for retry and select no destination.
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

## VPS live evidence

The gate ran from a mode-0700 temporary directory without changing installed
Polygram, service configuration, or production data. The initial Linux auth
preflight exposed one cross-platform CLI difference: Codex 0.145 writes its
successful login-status line to stderr on Linux and stdout on macOS. The
runner now accepts the exact ChatGPT status from exactly one stream and rejects
duplicates, warnings, or any other value.

Final attested runtime evidence:

| Runtime | Version/model | SHA-256/auth |
| --- | --- | --- |
| Codex | `codex-cli 0.145.0`, `x86_64-unknown-linux-musl` | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`; ChatGPT |
| Claude | `2.1.220 (Claude Code)`, observed `claude-haiku-4-5-20251001` | `674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863`; first-party `claude.ai` |

The final shape receipt was `CONTINUE` for manifest
`0da0532765f350f1dc89287d5feb5e8ecd2ff16a84d8b7e2b73b2fc7a4b87d48`:
6/6 routing outcomes passed, with zero errors, mismatches, or leaks, and all
4 injected fault classes selected no destination.

The final full receipt was `STOP` under the pre-registered zero-error rule:

```text
routing outcomes       130
accepted               109
secret-quarantined      20
operational errors       1  (mixed-02: ROUTER_MIXED_COVERAGE)
mismatches               0
private-to-work leaks    0
fault outcomes          20/20 passed
```

This is 109/110 successful real model classifications, but it is not a pass.
The one rejected split is safe—no destination is selected and the policy queues
it for retry—but the live gate did not exercise a real retry to completion.
Do not rerun the unchanged gate until it happens to be green. U24 remains a
blocker pending one reviewed choice: add and test a small deterministic retry
around the Haiku classification (recommended), or characterize a stronger
subscription-backed router such as Sonnet. A finite passing fixture would
still leave residual semantic-miss risk as an explicit rollout decision.
