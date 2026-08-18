# U24 memory routing gate

This bounded spike proves one fixed cheap subscription-backed Claude/Haiku
router for facts extracted from either Claude or Codex sessions. Codex CLI
0.145 is recorded as a rejected router candidate because it has no preventive
all-tools-off switch; using post-hoc tool-event rejection would be too late.
The spike does not replace native memory extraction and does not publish or
persist facts.

The runner forwards only a small non-credential environment allowlist, proves
the Codex login is ChatGPT and the Claude login is first-party/non-API-key,
sends only synthetic facts to Claude, disables Claude customizations and tools,
and accepts only the closed routing schema. Its JSON receipt contains fixture
IDs and outcomes, never fixture text or credentials.

Run the small invocation-shape check first:

```sh
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/path/to/pinned/codex-0.145.0 \
  --claude-bin /absolute/path/to/vendored/claude-2.1.220 \
  --output /private/mode-0700/u24-shape.json \
  --mode shape
```

After the shape receipt is `CONTINUE`, run the pre-registered full gate:

```sh
node -p "require('/private/mode-0700/u24-shape.json').routing.adapters[0].observedModels[0]"
# Copy the printed exact ID into this quoted value.
expected_model='claude-haiku-exact-id-from-shape'
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/path/to/pinned/codex-0.145.0 \
  --claude-bin /absolute/path/to/vendored/claude-2.1.220 \
  --output /private/mode-0700/u24-full.json \
  --mode full \
  --expected-model "$expected_model"
```

`shape` runs one fixture from each of the six families. `full` runs the frozen
26-case corpus five times through the exact Claude/Haiku model recorded by the
shape receipt (130 routing outcomes) plus the
four destination-free fault classes five times (20 fault outcomes). Output
creation is exclusive so an earlier receipt is never silently overwritten.
