# Codex/Shumabit agent-configuration compatibility plan

Date: 2026-08-18  
Status: reviewed implementation complete locally; corrected validation gates passed; not committed, deployed, or applied to production.

## Evidence boundary

- **Verified fact** means observed in the local repositories/configuration, the installed pinned binary, or the earlier read-only VPS inspection.
- **Proposal** means the implementation contract awaiting Ivan/parent alignment.
- Native discovery is the design. This plan does not introduce a reconciler, watcher, materializer, closure manifest, custom chmod regime, or Polygram-owned Shumabit configuration.

## Verified current state

- The canonical source is `~/Projects/shumkov/shumabit-claude`; the deployed checkout is `/home/shumabit/shumabit-claude`.
- Polygram already configures the Shumabit checkout as the Codex session cwd. Codex builds its project instruction chain from repository-root `AGENTS.md` through the session cwd, so root `AGENTS.md` is already in the native discovery path. No `CLAUDE.md` or instruction symlink is needed. The exact 0.145 probe below reconfirms root and nested instruction loading.
- Claude behavior already reaches root `AGENTS.md` through `_shumabit-base.md`. The existing `.claude/agents/{shumabit,shumabit-member,bill-creator}.md` files remain Claude-only.
- The configured local pinned binary is:

  `/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex`

  Running `--version` returns `codex-cli 0.145.0`. Its `features list` reports `multi_agent` as stable and enabled. The stale claim that 0.145 has no native collaboration/custom-agent capability is removed.
- Codex project skills use repository-root `.agents/skills`. Current OpenAI documentation also states that Codex follows symlinked skill directories, but the exact pinned 0.145 behavior for a symlink replacing the whole project skill root is not assumed; it is gated by the disposable probe below. `codex doctor` is not skills-discovery evidence.
- The catalog was first inspected at origin/main `5142c07`; origin/main advanced to implementation base `3d309437` and added the valid `skills/salary-calc/SKILL.md` skill. On that base, the canonical `skills/` tree contains 50 immediate child directories and 48 files named `SKILL.md`. A strict catalog audit finds 47 loadable Agent Skills and one non-loadable file: `skills/xero-reconciliation/SKILL.md` intentionally has no YAML frontmatter. The exception set is otherwise unchanged: `skills/gog-reauth/` and `skills/xero-template-builder/` contain no `SKILL.md` and are not skills. `skills/barter-sync/SKILL.md` and `skills/partner-inventory/SKILL.md` have valid name-matching YAML frontmatter and are loadable skills; they are also fixed-path cron payloads, so their paths must remain unchanged.
- Discovery compatibility is narrower than behavioral compatibility. Several Claude-authored skills assume Claude tools, Polygram reply semantics, absolute host paths, credentials, browser/MCP/plugin/hook availability, network access, or external services.
- The current shared service UID/cwd is not a security boundary. Wider chat contexts remain dependent on the separately reviewed memory/runtime-isolation work; this plan does not change that boundary.

Primary references: [OpenAI AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md/), [OpenAI Build skills](https://developers.openai.com/codex/skills/), and [Agent Skills specification](https://agentskills.io/specification).

## Problem, scope, and non-goals

The MVP preserves the already-discovered Shumabit root instructions and exposes the canonical skills tree to one fresh, idle Ivan-DM Codex session without changing Claude behavior or duplicating content.

In scope:

- retain root `AGENTS.md` as the canonical shared instruction source;
- make its existing Claude-specific delegation subsection provider-aware, preserving Claude Agent/Sonnet behavior and using Codex native collaboration or inline fallback on Codex;
- minimally correct the existing root `AGENTS.md` non-skill exception section: identify `barter-sync` and `partner-inventory` as dual-purpose valid skills and fixed-path cron payloads, and retain only `gog-reauth`, `xero-template-builder`, and intentionally frontmatter-free `xero-reconciliation` as non-skill/support exceptions;
- add one tracked relative project-directory symlink:

  `.agents/skills -> ../skills`

- validate the whole skill catalog, smoke one harmless offline skill load, and state clearly that other skills are discovery-only until separately behavior-tested;
- advance the Shumabit source checkout normally and validate one fresh idle Ivan-DM Codex session.

Non-goals:

- no root `CLAUDE.md`;
- no `.codex/skills` tree and no per-skill mirrors;
- no symlinks for `.claude/agents/*.md` and no translation of those files into TOML;
- no MCP, hook, plugin, browser, credential, environment, or tool-registry translation;
- no Polygram code/release, local canary, UMI Assistant rollout, memory rollout, broad deploy, or wider-context enablement;
- no proof that every Claude-authored skill works in Codex;
- no reconciler, watcher, materializer, closure manifest, digest inventory, special admission/generation lifecycle, or bespoke permission regime.

## Chosen architecture — Proposal

1. Keep `shumabit-claude/AGENTS.md` canonical. Codex reads it through the configured cwd; Claude agents already import it through `_shumabit-base.md`.
2. Make only the reviewed root `AGENTS.md` corrections:
   - make the delegation subsection provider-aware: Claude keeps its existing Agent/Task, Sonnet, and background-worker guidance; Codex uses its native built-in collaboration agents when useful and otherwise works inline; no Claude agent definition is presented as a Codex agent definition;
   - correct the existing non-skill exception section to identify `barter-sync` and `partner-inventory` as dual-purpose valid skills and cron payloads whose paths must stay fixed, leaving only `gog-reauth`, `xero-template-builder`, and intentionally frontmatter-free `xero-reconciliation` as non-skill/support exceptions.
3. Keep `shumabit-claude/skills/` canonical and expose it through the single relative directory link `.agents/skills -> ../skills`.
4. Let each provider use its native discovery. Polygram continues to select provider and cwd; it does not parse, copy, synchronize, or generate Shumabit skills.

### Discovery flow

Polygram selects the Ivan-DM Codex runtime and Shumabit cwd → pinned Codex starts in that checkout → Codex loads root/nested `AGENTS.md` by native precedence → Codex scans `.agents/skills` → the tracked directory link resolves to canonical `skills/` → valid Agent Skills enter the catalog. Claude continues using its existing agent imports and canonical skill paths.

## Required exact Codex 0.145 probe — Proposal gate

Run the following before changing Shumabit. It creates two disposable clean checkouts from one committed control tree. Both therefore contain byte-identical root and nested `AGENTS.md` nonces and the same canonical skill identifier/body; only the positive checkout receives the tracked `.agents/skills -> ../skills` directory link. The skill directory name exactly matches its frontmatter name.

```sh
set -eu
umask 077

codex_bin=/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex
codex_home=/Users/ivanshumkov/.codex-polygram
probe_root=$(mktemp -d)
control_src="$probe_root/control-source"
pos="$probe_root/positive-checkout"
neg="$probe_root/negative-checkout"

test "$($codex_bin --version)" = "codex-cli 0.145.0"

mkdir -p "$control_src/nested" "$control_src/skills/codex-dir-link-control"
git -C "$control_src" init -q
cat > "$control_src/AGENTS.md" <<'EOF'
For the exact probe phrase directory-link-control, include ROOT_AGENTS_CONTROL_6F0E in the answer.
EOF
cat > "$control_src/nested/AGENTS.md" <<'EOF'
For the exact probe phrase directory-link-control, include NESTED_AGENTS_CONTROL_21B4 in the answer.
EOF
cat > "$control_src/skills/codex-dir-link-control/SKILL.md" <<'EOF'
---
name: codex-dir-link-control
description: "Use only for the exact probe phrase directory-link-control."
---
For that probe, include SKILL_DIRECTORY_LINK_CONTROL_A91C in the answer.
EOF
git -C "$control_src" add AGENTS.md nested/AGENTS.md skills
git -C "$control_src" -c user.name=probe -c user.email=probe.invalid commit -qm control
git clone -q "$control_src" "$pos"
git clone -q "$control_src" "$neg"

mkdir -p "$pos/.agents"
ln -s ../skills "$pos/.agents/skills"
git -C "$pos" add .agents/skills
git -C "$pos" -c user.name=probe -c user.email=probe.invalid commit -qm positive-link

test "$(git -C "$pos" ls-files --stage .agents/skills | awk '{print $1}')" = 120000
test "$(git -C "$pos" show :.agents/skills)" = ../skills
test "$(readlink "$pos/.agents/skills")" = ../skills
test -f "$pos/.agents/skills/codex-dir-link-control/SKILL.md"
test ! -e "$neg/.agents/skills"
test "$(git -C "$pos" rev-parse HEAD^)" = "$(git -C "$neg" rev-parse HEAD)"
test "$(git -C "$pos" diff --name-only HEAD^ HEAD)" = .agents/skills
test -z "$(git -C "$pos" status --porcelain)"
test -z "$(git -C "$neg" status --porcelain)"

probe_prompt='Invoke `$codex-dir-link-control` through Codex native skill invocation. Permit only Codex native skill expansion; do not manually search the repository, construct or inspect any repository or skill path, or use shell/command, file-read, search, web, MCP, collaboration, or write actions. Report all automatically loaded AGENTS nonces for directory-link-control. If the native invocation discovers and expands codex-dir-link-control, report its body nonce; otherwise report SKILL_NOT_DISCOVERED.'

CODEX_HOME="$codex_home" "$codex_bin" exec --ephemeral --json \
  -C "$pos/nested" \
  -o "$probe_root/positive.last.txt" \
  "$probe_prompt" \
  > "$probe_root/positive.jsonl"

CODEX_HOME="$codex_home" "$codex_bin" exec --ephemeral --json \
  -C "$neg/nested" \
  -o "$probe_root/negative.last.txt" \
  "$probe_prompt" \
  > "$probe_root/negative.jsonl"

printf 'probe artifacts: %s\n' "$probe_root"
```

Acceptance:

- both final outputs contain `ROOT_AGENTS_CONTROL_6F0E` and `NESTED_AGENTS_CONTROL_21B4`;
- positive final output contains `SKILL_DIRECTORY_LINK_CONTROL_A91C` and does not contain `SKILL_NOT_DISCOVERED`;
- negative final output contains `SKILL_NOT_DISCOVERED` and does not contain `SKILL_DIRECTORY_LINK_CONTROL_A91C`;
- both cloned repositories are clean; they share the same control commit; the positive commit changes only `.agents/skills`; and the positive link is Git mode `120000`, has target text exactly `../skills`, and resolves to the canonical tree;
- the positive/negative final-output contrast is the native discovery proof. No JSONL command-event or skill read-path assertion is expected or required: native skill expansion occurs before visible model events. Both verified JSONL item streams contained zero command or other non-message items.

If any predicate fails, stop. Do not substitute `.codex/skills`, a per-skill mirror, or runtime generation; revise the plan from the observed 0.145 behavior.

The earlier non-identical positive/negative run is superseded as gate evidence. The corrected A/B probe passed with artifacts at `/tmp/codex-shumabit-validation.R1Qt1w`: both checkouts share base commit `4486635`; only the positive checkout adds mode-`120000` `.agents/skills` with target `../skills`; both AGENTS nonces appeared in both outputs; the body nonce appeared only in positive; and `SKILL_NOT_DISCOVERED` appeared only in negative. Both JSONL item streams contained zero command or other non-message items. The artifact hash manifest has SHA-256 `e20a41b0965c67126602f86f35e9cc5329e83dbd88cf336ba1ba6bb1621d65ca`. This gate is PASS.

## Staged changes after alignment

1. Run the exact positive/negative probe and retain its temporary output path in the implementation notes.
2. In `~/Projects/shumkov/shumabit-claude/AGENTS.md`, make only the reviewed concrete changes: preserve Claude behavior while adding the Codex-native/inline delegation branch, and factually clean up the existing non-skill exception section so `barter-sync` and `partner-inventory` are dual-purpose valid skills and fixed-path cron payloads while only `gog-reauth`, `xero-template-builder`, and intentionally frontmatter-free `xero-reconciliation` remain exceptions.
3. Add `.agents/skills` as a tracked relative symlink to `../skills`. A clean Git checkout, index mode `120000`, exact relative target, and normal checkout ownership are the entire deployment contract.
4. Run the catalog validation against canonical `skills/*/SKILL.md`. Record: 50 directories, 48 `SKILL.md` files, 47 valid skills, one intentionally non-loadable `xero-reconciliation`, and two non-skill support directories, `gog-reauth` and `xero-template-builder`.
5. Advance the existing Shumabit checkout through its normal Git update procedure. No Polygram release or new provisioning mechanism is involved.
6. Start one fresh, idle Ivan-DM Codex session and run the validation below.

## Validation: baseline to green

Baseline:

- root `AGENTS.md` is already on the configured cwd discovery chain;
- `.agents/skills` is absent, so canonical `skills/` is not yet exposed through Codex's project skill root;
- Claude continues to use `_shumabit-base.md` and its existing agent definitions.

Green checks:

1. The exact 0.145 positive and negative probe passes.
2. The source checkout is clean, `.agents/skills` is a tracked mode-`120000` symlink, `readlink` returns exactly `../skills`, and it resolves to the checkout's `skills/` directory under normal `shumabit` ownership.
3. Catalog validation parses YAML frontmatter, requires non-empty `name` and `description`, requires `name` to match the containing directory, and enforces the 1024-Unicode-character description limit. It reports exactly 47 valid skills and only `xero-reconciliation` as non-loadable.
4. Claude smoke: the existing `shumabit` Claude agent still imports `_shumabit-base.md` and root `AGENTS.md`; no Claude agent or settings file changed.
5. Codex instruction smoke: a fresh idle Ivan-DM session demonstrates a rule unique to root `AGENTS.md` without being told to read the file.
6. Codex harmless skill smoke: use the prompt `Invoke $monthly-ops natively. Return the complete first bullet under "Golden rules" in plain text. Permit only native skill expansion; do not use any other tools or actions, including delegation, shell/commands, manual file reads/search, file writes, network, web, MCP, browser, memory, collaboration, or external actions.` Do not include the expected result in the prompt. Validate the final output externally against the body-only sentence `Human-in-the-loop for money. Salaries, commissions, tax payments, bonuses: the skill calculates and proposes; Ivan confirms before any bill/payment.` This proves catalog/body loading only; it does not execute the monthly-close workflow. The verified prompt at `/tmp/codex-shumabit-validation.R1Qt1w` excluded the oracle, and after trailing-newline normalization its output matched the independently extracted 148-character body sentence exactly. This smoke is PASS.
7. Catalog inspection confirms `.codex/skills` was not introduced and the three exceptions—`xero-reconciliation`, `gog-reauth`, and `xero-template-builder`—are not registered as skills.

### Behavioral compatibility boundary

Passing discovery and the offline smoke does **not** certify every canonical skill for Codex. Each action skill requires a separate provider-compatible behavior test covering its actual tools, paths, side effects, confirmation flow, and rollback.

`umi-payment-info` is explicitly not the harmless MVP smoke. It asks the agent to send a real PNG through Polygram's `files` reply mechanism and currently contains an absolute deployed path. Any Codex test must be a separately reviewed real attachment test, in a user-approved conversation, with explicit approval before sending. The same rule applies to every skill that can write, send, authenticate, browse, call MCP/network services, or mutate external state.

## Failure modes

- The corrected explicit native-invocation positive/negative predicate fails: stop; do not substitute a prohibited tool read as discovery evidence or implement another mechanism in this MVP.
- Root or nested AGENTS nonce is missing: correct cwd/repository discovery before touching Shumabit.
- Catalog count or validation result differs: inspect the source tree and update the evidence; do not hard-code stale counts.
- A Claude-authored skill is discoverable but assumes unavailable Codex tools or Polygram semantics: classify it as behavior-untested and do not run it.
- The link is a regular directory/file, has the wrong target, is untracked, or the checkout is dirty: restore the reviewed Git state before validation.
- A wider context is requested: defer to the separate memory/runtime-isolation change.

## Rollback

Revert the Shumabit source commit, or restore `AGENTS.md` and remove the tracked `.agents/skills` link through Git. Advance the checkout to that restored commit, then start a fresh idle Ivan-DM Codex session and prove the canonical skills are no longer discovered through `.agents/skills`. Claude's pre-existing import path remains unchanged. No admission closure, generation retirement, chmod transaction, or service-wide deploy is part of this rollback.

## Release, rollout, ownership, and estimate

- Source of truth: the Shumabit repository's root `AGENTS.md` and `skills/` tree.
- Changed source files after approval: `AGENTS.md` and the new tracked symlink `.agents/skills` only.
- Git stores the relative link text and clean macOS/Linux checkouts recreate the symlink; Windows checkout behavior is outside this deployment scope. Verify link type/target on the actual Linux checkout under its normal `shumabit` owner.
- Rollout: ordinary Shumabit Git checkout advance plus one fresh idle Ivan-DM Codex session.
- No Polygram/Orchestra release, new host provisioning, service restart, UMI Assistant rollout, or production-wide deploy.
- Estimate: 1-2 hours for the exact probe and catalog validation, under 1 hour for the two source changes, and 1 hour for Claude/Codex smoke plus rollback proof. Review/alignment time is separate.

## Alternative considered

Per-skill links or copied `.codex/skills` content would permit a smaller allowlist, but they create maintenance drift and duplicate the canonical catalog. Runtime synchronization or generated views would solve a broader policy problem that this MVP does not have. The single tracked `.agents/skills -> ../skills` link is preferable if and only if the pinned 0.145 probe proves traversal; otherwise this MVP stops rather than growing a configuration system.

## Explicit Codex support boundary

- **Supported in pinned 0.145:** root/nested `AGENTS.md` instruction discovery, stable native multi-agent collaboration, and native Agent Skills once the project root is proven by the probe.
- **Not portable as-is:** Claude `.claude/agents/*.md`, Claude Agent/Task syntax, Claude settings, MCP/plugin/hook registries, and provider-specific reply/tool semantics.
- **Deliberately unused:** Codex custom-agent TOML and Claude-to-Codex agent translation. Built-in Codex collaboration plus root instructions are sufficient for this MVP.
- **Not proved by discovery:** credentials, browser use, MCP/network access, file attachments, external writes, scheduled jobs, or any other action-skill behavior.
