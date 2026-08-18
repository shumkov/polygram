# U24 narrow memory-routing gate findings

Date: 2026-08-18  
Status: harness reviewed locally; live subscription gate not yet run on the authorized VPS.

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

- Frozen corpus: 26 synthetic facts — 8 work, 8 personal, 4 mixed,
  2 semantic-uncertain, 2 known-shape secrets, and 2 prose-form credentials.
- Full-gate arithmetic: 26 facts × 5 repetitions × 1 fixed router = 130
  routing outcomes; 4 injected fault classes × 5 = 20 fault outcomes.
- Deterministic secret rejection runs before the adapter and the four secret
  fixtures never reach a model.
- Non-mixed accepted output must preserve the source fact exactly. Mixed parts
  must be disjoint extractive source spans and exactly match their
  pre-registered work/sensitive split.
- Mixed projection is part-scoped: work writes to own-private plus general;
  sensitive writes only to own-private.
- Operational faults queue for retry and select no destination.
- Claude invocation fixes `--safe-mode`, `--tools ""`, empty strict MCP config,
  schema output, no session persistence, and low effort.
- Child environment is a positive non-credential allowlist. Claude auth must
  report exactly `loggedIn: true`, `apiProvider: firstParty`, and
  `authMethod: claude.ai`. Codex must report `Logged in using ChatGPT`.
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
tests 124
pass 124
fail 0
skipped 0
```

The default shell currently resolves Node 26, while `better-sqlite3` is built
for Node 24. The first adjacent test attempt therefore had 25 ABI load failures
before SQLite tests started. Re-running the unchanged command with the
repository Node 24.4.0 runtime passed 124/124; no dependency was rebuilt.

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

## Remaining live gate

Run shape mode on the VPS account where both production CLIs are already
authorized, using that host's exact attested Codex 0.145 and vendored Claude
2.1.220 paths. The output path must be a new file inside a mode-0700 temporary
directory:

```sh
node -p "require('/absolute/mode-0700/u24-shape.json').routing.adapters[0].observedModels[0]"
# Copy the printed exact ID into this quoted value.
expected_model='claude-haiku-exact-id-from-shape'
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/vps/path/to/codex-0.145.0 \
  --claude-bin /absolute/vps/path/to/claude-2.1.220 \
  --output /absolute/mode-0700/u24-shape.json \
  --mode shape
```

Proceed to full mode only when shape is `CONTINUE`. Copy the exact sole
`routing.adapters[0].observedModels[0]` value into `--expected-model`:

```sh
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/vps/path/to/codex-0.145.0 \
  --claude-bin /absolute/vps/path/to/claude-2.1.220 \
  --output /absolute/mode-0700/u24-full.json \
  --mode full \
  --expected-model "$expected_model"
```

U24 completes only if the full receipt is `CONTINUE`, records 130 routing and
20 fault outcomes, has zero private-to-general leaks, and shows one exact
Haiku model with first-party subscription auth. A passing finite fixture does
not prove perfect classification of arbitrary prose; that residual semantic
risk remains an explicit rollout decision.
