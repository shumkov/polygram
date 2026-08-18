---
title: Codex Shumabit Context Parity and Config UX
type: feat
date: 2026-07-31
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Codex Shumabit Context Parity and Config UX

## Goal Capsule

Make the existing Codex backend feel like a first-class Shumabit runtime:
the Telegram settings card uses short human names and useful descriptions,
newly provisioned Codex scopes use `high` effort, Codex can search the web,
and Codex discovers the same Shumabit instructions and canonical project
skills as Claude. This release makes the complete skill catalog discoverable
and validates a deliberately named initial
operational subset; it does not claim that all 46 skills have Claude-equivalent
credential and writable-state support.

Preserve raw provider model IDs, per-chat/topic persistence, the existing
Codex feature flag, provider thread/session continuity, Claude SDK/CLI
behavior, and the current goals-off gate.

The first rollout target is Ivan DM. Shumabit@UMI is temporarily
`codexEnabled: false` during the widened-profile canary, without deleting its
saved model or provider thread. This plan finishes with group Codex disabled.
Group Codex is re-enabled only after the
provider-neutral scoped-memory plan in
`umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md` supplies its
technical memory boundary.

## Product Contract

### Problem

The shipped Codex backend works, but its product surface still reflects the
initial containment rollout:

- `/config` uses long catalog names such as `GPT-5.6 SOL`, lower-case Claude
  names, raw Codex IDs in the help text, and a large warning block.
- The two enabled production scopes were provisioned with `xhigh`, although
  Ivan wants `high` to be the normal Codex starting point.
- The owned Codex profile disables native web search and command networking,
  replaces shell `HOME` with a synthetic directory, and restricts `PATH` to
  `/usr/bin:/bin`.
- Codex loads root `AGENTS.md`, but it does not load the Claude-only
  `.claude/agents/shumabit.md` overlay and does not discover the canonical
  `skills/` tree because it is not exposed under `.agents/skills`.
- Claude's memsearch plugin maintains one unscoped workspace index. Directly
  exposing its adapter, executable, or database to Codex would preserve the
  cross-chat privacy problem instead of solving it.

The current warning is also misleading. Shell execution, workspace access,
AGENTS discovery, native skills, and multi-agent support are not globally
disabled. Web search, command network, goals, product MCP, and interactive
server requests are separate capabilities with different implementation
boundaries.

### Verified Facts

- `lib/handlers/config-ui.js` owns the settings keyboard and help body.
  Callback data and persisted selections use raw model IDs.
- The interactive Codex allowlist is exactly `gpt-5.6-sol`,
  `gpt-5.6-terra`, and `gpt-5.6-luna`; the authenticated catalog remains the
  authority for availability and effort compatibility.
- Model/effort changes apply as a complete pair on the next `turn/start`.
  They do not replace the provider thread or retarget an active turn.
- Enabled Codex scopes must persist an explicit model and effort. There is no
  safe global fallback that should silently complete every chat.
- Codex's cached web search is independent of shell-command network access.
  Current OpenAI documentation describes cached search as pre-indexed web
  results and the normal local default. See
  [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [permissions](https://learn.chatgpt.com/docs/permissions).
- The owned `config.toml` is byte-attested. Polygram refuses drift and never
  overwrites an existing file. Any policy change requires deliberate
  reprovisioning; it is not an in-place production edit.
- Orchestra 0.10.11 independently rejects any profile whose web search is not
  disabled or whose command network is enabled.
- Orchestra currently cancels and faults on command/file approval requests,
  native `requestUserInput`, MCP elicitation, and `item/tool/call`. Those are
  protocol features, not configuration switches.
- Shumabit has 46 canonical `skills/*/SKILL.md` packages. Codex discovers
  project skills under `.agents/skills`, not the existing root `skills/`
  directory by itself.
- Memsearch remains the selected backend, but provider-neutral policy,
  automatic capture, and scoped recall belong to the separate scoped-memory
  plan rather than a Codex-only adapter.
- Shumabit's current memsearch index is workspace-wide, not partitioned per
  Telegram chat. Instruction-based refusal is the boundary used by Claude
  today, but it is not a technical per-chat isolation mechanism.
- `formatPrompt` currently decides "fresh history" from the legacy Claude
  session ID. A Codex-first session can therefore receive repeated history,
  while a Claude-to-Codex switch can skip the Codex fresh preload.
- Cold session-context lookup currently uses the chat cwd rather than the
  topic-resolved cwd.

### Requirements

#### Settings UX

- **R1.** Claude buttons and help text use `Opus`, `Sonnet`, and `Haiku`.
- **R2.** Codex buttons and help text use `Sol`, `Luna`, and `Terra`.
  `Terra` is the official spelling; the order is Sol, Luna, Terra.
- **R3.** The body and button row use the same labels and order.
- **R4.** Each model has one concise, useful description:
  - Sol: complex, ambiguous, high-value work.
  - Luna: clear, repeatable, high-volume work.
  - Terra: pragmatic everyday work.
  - Opus: deepest Claude analysis and difficult synthesis.
  - Sonnet: balanced everyday work.
  - Haiku: fast simple work, classification, and lookup.
- **R5.** The long Codex warning is removed from `/config`. The card stays
  button-centric and does not restore process, session, runtime-source, or
  other technical status lines.
- **R6.** Raw model aliases/slugs remain unchanged in callback payloads,
  configuration, audit rows, provider requests, and authenticated catalog
  checks.

#### Model and effort

- **R7.** `high` is the explicit provisioned Codex effort for new enabled
  scopes, the example configuration, and the two currently approved
  production scopes.
- **R8.** An explicit later user selection such as `xhigh` remains durable;
  "default high" must not overwrite a supported explicit selection.
- **R9.** When a model switch makes the current effort invalid, Polygram
  chooses `high` when the target model supports it, otherwise the
  authenticated catalog default. The active turn remains unchanged and the
  next turn receives the complete adjusted pair.

#### Codex runtime capabilities

- **R10.** The explicitly opted-in Shumabit operations profile uses
  `web_search = "cached"`. Omitted `config.codex.webSearch` keeps the current
  conservative `disabled` behavior for other deployments.
- **R11.** The opted-in Shumabit Codex deployment uses command network with
  an intentional `domains."*" = "allow"` destination policy,
  the real service `HOME`, and an explicit controlled `PATH` that contains
  the deployment's Node and `~/.local/bin` tools.
- **R12.** Environment inheritance remains disabled. The path is an explicit
  ordered list, not the daemon's ambient `PATH`.
- **R13.** The permission profile denies the ambient service-home root and
  then allows only more-specific enumerated descendants. It also keeps
  workspace writes and explicit denials for `CODEX_HOME`, rollback backups,
  unrelated credential/config/history roots, and every Polygram
  daemon-secret/control root.
- **R14.** The profile grants only the additional local roots needed by the
  initial validated subset:
  - read access to the attested personal skill and executable roots.
- **R14a.** Raw Shumabit integration credentials are not granted in this
  release. Credentialed/stateful skills require a later inventory and either
  exact per-integration roots or a narrow operation broker. Discovery of a
  skill does not claim that it is operationally supported.
- **R14b.** The owned profile, preflight receipt, diagnostics, and spawn
  identity include the exact network domains, filesystem rules, HOME/PATH
  fingerprint, and content digests for the allowed executables. Any drift
  fails closed.
- **R15.** Native goals remain `false`.
- **R16.** Approval policy remains `never`, product MCP remains empty, and
  native mid-turn approval/question requests remain unsupported in this
  pass. Codex can ask a normal text question and continue on the user's next
  Telegram message.
- **R17.** Detached/background command guarantees do not change.

#### Shumabit context and memory

- **R18.** Root `AGENTS.md` is the provider-neutral bootstrap source. It
  explicitly covers the identity, user/team, tools, permissions, and
  provider-neutral safety rules currently supplied by the Claude overlay.
- **R19.** The canonical root `skills/` tree remains the single source.
  Prefer a relative `.agents/skills -> ../skills` directory link. If the
  pinned runtime does not traverse it, use generated relative per-skill links
  inside `.agents/skills`. No skill is copied or maintained twice.
- **R20.** Codex receives no direct memsearch adapter, executable, database,
  or workspace-wide collection in this release.
- **R21.** Automatic capture and scoped recall are implemented once for Claude
  and Codex under
  `umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md`, not as a
  Codex-specific installation.
- **R22.** `MEMORY.md` remains Ivan-DM-only in this release. Shumabit@UMI
  remains Codex-disabled until the provider-neutral scoped-memory rollout
  supplies its mapped read/write boundary and technically excludes every
  legacy cross-scope memory artifact from group provider access.
- **R23.** Fresh-history preload is provider/session-namespace-aware and
  durable per provider thread. An eagerly created but unused Codex thread
  still gets one preload on its first accepted turn; a resumed thread whose
  preload marker is complete gets none; failed dispatch does not consume the
  marker; dormant Claude state does not decide Codex freshness.
- **R24.** Cold session-context lookup uses the effective topic/chat cwd.

#### Compatibility and rollout

- **R25.** Claude SDK and Claude CLI runtime behavior, model aliases, effort
  handling, sessions, approvals, and MCP bridge remain unchanged.
  Provider-neutral bootstrap instructions may move into root `AGENTS.md`
  provided Claude receives semantically equivalent rules.
- **R26.** Codex stays hidden and dispatch-rejected outside scopes where the
  existing `codexEnabled` resolver returns true.
- **R27.** Existing provider thread IDs and next-turn model-switch application
  semantics survive the change, except for the incompatible-effort fallback
  deliberately changed by R9.
- **R28.** No reboot is required. Rollout uses controlled service quiescence,
  owned-config backup/move, reprovisioning, preflight, and a message canary.

### Acceptance Examples

- **AE1.** In Claude `/config`, the row is `Opus | Sonnet | Haiku`; the help
  body uses those exact names and descriptions; callbacks still carry
  `opus`, `sonnet`, and `haiku`.
- **AE2.** In Codex `/config`, the row is `Sol | Luna | Terra`; the help body
  uses those exact names/order and contains no native-beta warning or raw
  `gpt-5.6-*` name.
- **AE3.** A newly enabled Sol scope starts at `high`. Selecting `xhigh`
  preserves it. Switching from an unsupported effort to Luna chooses `high`
  because Luna supports the product default.
- **AE4.** A Codex turn answers a web fact using cached web search without an
  unknown notification, denied server request, or generation fault.
- **AE5.** In Ivan DM, Codex can list native Shumabit skills, run one harmless
  local skill, and run one anonymous-network skill. The structural discovery
  oracle is app-server `skills/list` with `forceReload`, not model-authored
  prose.
- **AE6.** Codex cannot read its dedicated credential home, unrelated service
  HOME files, SSH/Claude/tool credentials, the rollback backup, or Polygram
  daemon config/secrets or direct memsearch state even though command network
  and enumerated tool roots are available. Symlink and traversal probes receive
  the same denial.
- **AE7.** Shumabit@UMI is Codex-disabled during the Ivan canary while its
  saved Codex model and provider thread remain intact and its provisioned
  effort is changed to `high`. Re-enablement is outside this plan.
- **AE8.** A first accepted Codex turn gets one bounded Polygram history
  preload even if `/config` already created an empty provider thread. Failed
  dispatch does not consume the marker; its second/resumed turn does not get
  another preload; switching back to Claude uses Claude's own namespace state.
- **AE9.** A native approval, MCP/app call, or native user-input request does
  not become silently enabled. Goals remain off.
- **AE10.** The opted-in command profile can reach a public HTTPS destination
  under its explicit wildcard rule; removing or changing that rule fails
  preflight. The old omitted-field profile remains web-disabled and
  command-network-disabled.

### Golden Telegram Cards

The full `/config` body is exact product copy. Focused `/model` and `/effort`
cards render the matching section from the same metadata without the other
section. Checked markers remain on buttons, not in the body.

Claude:

```text
⚙️ Settings

**Models**
🧠 **Opus** — Deepest analysis and difficult synthesis.
🤖 **Sonnet** — Balanced everyday work.
⚡ **Haiku** — Fast simple work, classification, and lookup.

**Effort**
• **low** — Fast replies with minimal reasoning.
• **medium** — Balanced for most tasks.
• **high** — Multi-step analysis, debugging, and review.
• **xhigh / max** — The hardest reasoning and edge cases.

Buttons:
[Claude] [Codex]
[Opus] [Sonnet] [Haiku]
[low] [medium] [high] [xhigh] [max]
[Rich text: on/off]
```

Codex Sol example:

```text
⚙️ Settings

**Models**
☀️ **Sol** — Complex, ambiguous, high-value work.
🌙 **Luna** — Clear, repeatable, high-volume work.
🌍 **Terra** — Pragmatic everyday work.

**Effort for Sol**
• **high** — Strong reasoning for most substantial work.
• **xhigh** — Maximum reasoning for the hardest work.

Buttons:
[Claude] [Codex]
[Sol] [Luna] [Terra]
[high] [xhigh]
[Rich text: on/off]
```

The Codex effort heading uses the selected product label, never the raw model
ID. Its lines and buttons are both filtered from the authenticated effort
catalog. The selected button keeps its existing `✓ ` prefix.

### Non-goals

- Native goals or a Polygram-owned goal engine.
- Product MCP, ChatGPT apps, native mid-turn questions, or Telegram approval
  cards for Codex.
- Automatic memory capture or scoped recall; that work is owned by
  `umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md`.
- A new vector database, memory format, or copied Codex-only skill tree.
- Live web search; cached search is the selected first mode.
- Claiming operational parity for all discovered Shumabit skills.
- Direct shell access to Shumabit integration credentials in this release.
- Per-sender hard authorization inside an already enabled Telegram group.
- Retargeting an active turn, using experimental `thread/settings/update`,
  or changing provider thread/session IDs.
- Enabling Codex for any additional bot/chat scope.

## Planning Contract

### Key Technical Decisions

1. **Product-owned presentation metadata**
   (`session-settled: user-directed`).
   Use a fixed ordered map for the six visible models. Do not expose
   provider display names or thread upstream descriptions through receipts.
   Rejected alternative: dynamically project catalog descriptions through
   Orchestra and Polygram for only three fixed product models.

2. **Explicit high, no implicit global completion**
   (`session-settled: user-directed`).
   Provision `codexEffort: "high"` and prefer high only when remapping an
   incompatible model pair. Rejected alternative: introduce
   `defaults.codexEffort` or silently complete every chat.

3. **Cached native web search**
   (`session-settled: user-approved`).
   Enable OpenAI's cached search while keeping search independent of shell
   networking. Rejected alternative: live search in the first rollout.

4. **A coherent Shumabit operations profile**
   (`session-settled: user-directed`).
   Enable real HOME, explicit service PATH, wildcard public command network,
   and narrowly declared local skill/tool roots together. Deny ambient HOME,
   direct memsearch state, and raw integration credentials. This makes the
   requested initial subset work without claiming all credentialed skills work.
   Rejected alternatives: synthetic-HOME discovery that exposes broken skills,
   and exposing the daemon's entire ambient environment.

5. **Native provider discovery**
   (`session-settled: user-directed`).
   Use root `AGENTS.md` and `.agents/skills`. Rejected alternative: make Codex
   parse Claude agent/plugin state. Provider-neutral scoped memory is a
   separate shared service, not a discovery shortcut.

6. **Goals remain off; protocol features stay honest**
   (`session-settled: user-approved`).
   Keep goals false and do not advertise product MCP/native approvals until
   Orchestra can project and settle their server requests. Rejected
   alternative: flip upstream flags that currently cause a generation fault.

7. **Provider-aware history**
   (`session-settled: user-approved`).
   Freshness follows the selected provider namespace, never the legacy Claude
   column. Rejected alternative: leave a Codex-first repeated-history bug in
   a context-parity release.

### Architecture

#### Presentation

`lib/handlers/config-ui.js` owns an ordered, immutable presentation table:

```text
Claude:
  opus   -> Opus   -> description
  sonnet -> Sonnet -> description
  haiku  -> Haiku  -> description

Codex:
  gpt-5.6-sol   -> Sol   -> description
  gpt-5.6-luna  -> Luna  -> description
  gpt-5.6-terra -> Terra -> description
```

Both the keyboard and body consume this table. Interactive availability still
intersects the ordered Codex table with the authenticated catalog. That single
ordered `visibleModels` projection is consumed unchanged by both Codex body
and keyboard, so an unavailable allowlisted model disappears from both.
Callback data remains raw.

#### Runtime policy

The generic default remains conservative. Deployment-owned Codex command
capabilities are explicit under `config.codex.command`:

```json
{
  "webSearch": "cached",
  "command": {
    "home": "/home/shumabit",
    "path": [
      "/home/shumabit/.local/bin",
      "/home/shumabit/.nvm/versions/node/<pinned>/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ],
    "network": true,
    "networkDomains": {
      "*": "allow"
    },
    "readRoots": [
      "/home/shumabit/.agents/skills",
      "/home/shumabit/.local/bin",
      "/home/shumabit/.nvm/versions/node/<pinned>"
    ]
  }
}
```

The filesystem table denies `/home/shumabit` before granting only the
more-specific roots above; the pinned-runtime spike must prove that
most-specific rules win for subprocesses, symlinks, and traversal. It also
denies `CODEX_HOME`, daemon/control roots, unrelated credential/config/history
roots, and the moved rollback config. The implementation validates bounded
arrays, canonical absolute paths, ownership/type, allowed access modes,
duplicate/overlapping extra roots, and forbidden overlaps. The service HOME
may be the ancestor of enumerated roots; an enumerated grant may never cover a
protected descendant. It renders these values into the exact owned config and
never inherits arbitrary environment variables or PATH entries.

`webSearch`, command-network state and domains, HOME/PATH fingerprints,
filesystem rules, and executable digests are part of the static
spawn-profile identity. A change requires a new profile/preflight and process
replacement, not a live settings update.

#### Workspace context

Shumabit keeps root `skills/` canonical. `.agents/skills` is a relative
directory link to `../skills`, subject to a pinned-runtime discovery spike.
If the pinned CLI does not traverse that directory link, use generated
per-skill relative symlinks; never copy skill files.

Root `AGENTS.md` becomes the common bootstrap. Claude's existing
`_shumabit-base.md` may continue importing it, but provider-neutral facts and
security rules live in AGENTS rather than being duplicated into a Codex-only
prompt.

#### Semantic memory

Do not install the upstream Codex memory adapter or expose the legacy
workspace-wide memsearch executable/database through the command profile.
The provider-neutral scoped-memory service and automatic capture contract are
owned by `umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md`.
This release keeps Shumabit@UMI Codex-disabled until that service supplies the
technical channel and sender boundary.

#### History/session context

Create one immutable per-turn runtime snapshot containing selected provider
namespace, backend, effective cwd, and spawn identity; prompt formatting and
spawn preparation consume the same snapshot.

Track history preload durably by namespace and provider session ID rather than
by row existence. Persist a pending marker before submission, complete it only
after the provider accepts the turn containing the preload, and reconcile a
pending marker from existing attempt/provider evidence after interruption.
An empty thread created by `/config` has no completed marker and therefore
still receives history. Do not call a mutating spawn resolver from prompt
formatting.

Resolve effective cwd with the existing topic-over-chat precedence before
reading `sessions/<sessionKey>.md`.

### Alternatives Considered

1. **Cached web plus discovery only; keep command network/synthetic HOME.**
   Smaller, but misleading: most Shumabit skills would appear and then fail
   because Node, local tools, and public APIs are unavailable. This plan
   enables a named subset, not every credentialed skill.

2. **Reuse Claude settings/plugins wholesale.**
   Rejected because Claude configuration is not a Codex contract, can cross
   bot boundaries, and the dedicated Codex home is intentionally separate.

3. **Enable product MCP and native approvals now.**
   Rejected because current Orchestra behavior cancels and faults those
   server requests. This is a durable protocol/UI project, not a profile
   edit.

4. **Use `:danger-full-access` or inherit the daemon environment.**
   Rejected because explicit HOME/PATH/network/roots provide required
   support for the initial subset without exposing unrelated daemon control
   state.

5. **Give Codex direct access to the existing memsearch collection.**
   Rejected because the collection is workspace-wide and cannot implement the
   person/general/partner policy. The shared scoped-memory plan reuses
   memsearch behind a provider-neutral service instead.

### Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Cached web emits a notification/item shape outside the pinned Orchestra allowlist. | Run a pinned app-server spike first; update only the positive projector needed by observed evidence. |
| Real HOME/PATH still leaves a representative skill broken. | Deny ambient HOME, allow only enumerated roots, and gate on the named local/network subset before rollout. |
| Wildcard command network increases the effect of an instruction failure. | Do not expose raw integration credentials; retain exact filesystem roots, daemon/CODEX_HOME denies, attested executables, and Ivan-first rollout. |
| Shared memsearch collection can surface cross-chat data. | Do not expose it to Codex; keep group Codex disabled until the scoped-memory service passes its separate gates. |
| Credential or command text reaches durable logs. | Inventory command arguments/output, app-server events, Polygram logs/events DB, Codex transcripts, and crash diagnostics; use unique sentinels to prove structural sinks redact or suppress sensitive content. |
| User-writable binaries or tool content drift. | Pin exact paths, versions, and digests; reject PATH shadowing or content drift in preflight. |
| Owned config change blocks startup as drift. | Deliberately move the old config, let the release reprovision exact bytes, then preflight before traffic. |
| Stale Orchestra checkout produces a release from 0.9.0. | Start implementation from current main/tag 0.10.11 in a new isolated Orchestra worktree; keep the existing checkout untouched. |
| Config-card copy drifts from buttons. | One shared ordered presentation table and exact rendering tests. |
| Provider-aware history lookup mutates session state. | Add a dedicated read-only lookup and red/green regression tests. |

## Implementation Units

### U1. Pin the capability evidence

**Goal:** Retire the runtime-specific unknowns before widening the owned
profile.

**Files:** Orchestra spike/test fixtures under `tests/` or `scripts/`;
Polygram `scripts/spikes/README.md` and a bounded Codex capability spike if an
existing runner cannot express the cases.

**Approach:**

- On pinned Codex 0.145.0, prove cached web search completes without a denied
  server request or unknown notification.
- Prove the proposed command HOME/PATH exposes the attested Node and allowed
  tools, and that wildcard domain policy permits a benign public HTTPS
  request. Prove missing/changed domain rules fail.
- Prove the ambient HOME, representative unrelated HOME files, SSH/Claude/tool
  credentials, `CODEX_HOME`, daemon roots, and a simulated rollback backup
  remain unreadable through direct paths, subprocesses, symlinks, and
  traversal.
- Prove Codex follows the relative `.agents/skills` directory link.
- Prove direct memsearch state, plugin paths, executables, and the legacy
  collection remain outside the configured Codex capability surface.
- Record sanitized fixtures and exact observed event/method shapes. Do not
  capture credential or memory contents.

**Tests/verification:** The spike has explicit pass/fail oracles and cleans up
temporary artifacts. Any unexpected server request, notification, executable
drift, or deny-root read blocks its dependent unit.

### U2. Generalize Orchestra's attested static profile

**Goal:** Let Orchestra accept and reattest the exact cached-web,
network-enabled permission profile without weakening protocol checks.

**Repository:** Orchestra, from current main/0.10.11 ancestry; the research
checkout remains read-only.

**Files:** `lib/codex/preflight.js`,
`lib/codex/app-server-client.js` only if U1 proves a new positive projection,
`lib/process/codex-process.js` if its thread sandbox expectation changes,
`tests/codex-preflight.test.js`, `tests/codex-process.test.js`,
`tests/codex-app-server-client.test.js`, `tests/factory.test.js`.

**Approach:**

- Normalize and validate the supplied expected profile rather than
  unconditionally requiring web disabled/network false.
- Keep allowed web modes bounded to the modes Polygram supports in this
  release (`disabled`, `cached`).
- Require the active named permission profile, network value, filesystem
  and domain rules, filesystem digest, config hash/layers, approvals, reviewer,
  MCP/plugin/model-provider emptiness, workspace, environment fingerprint,
  executable digests, and thread sandbox to match the supplied
  expected profile exactly.
- Do not allow native server requests or experimental settings methods.

**Tests/verification:** Old disabled/no-network fixtures remain valid; the new
cached/network profile passes; missing, added, changed, or denied domains and
any other single-field mismatch fail. Run targeted Codex suites and
Orchestra's full `npm test`.

### U3. Add the deployment-owned Polygram command profile

**Goal:** Render, attest, diagnose, and spawn the exact Shumabit-capable Codex
environment.

**Files:** `lib/codex/runtime-profile.js`,
`lib/codex/runtime-controller.js`, `lib/codex/diagnostics.js`,
`config.example.json`, `tests/codex-runtime-profile.test.js`,
`tests/codex-runtime-controller.test.js`,
`tests/codex-runtime-integration.test.js`, `tests/doctor.test.js`.

**Approach:**

- Parse and validate `config.codex.webSearch` and `config.codex.command`,
  including the explicit domain map.
- Keep current synthetic/no-network behavior when command options are absent;
  production opts into the Shumabit operations profile explicitly.
- Set the example profile's explicit `codexEffort` to `high`; do not introduce
  a global fallback for incomplete scopes.
- Render cached search, real shell HOME, explicit PATH, network domains,
  ambient-HOME deny, protected-root denies, and additional read/write roots
  into the owned TOML.
- Include the complete profile in preparation-cache/deployment identity.
- Update config projection validation and doctor output to compare the
  configured exact policy rather than old hard-coded disabled values.
- Resolve and attest exact allowed executable paths and digests; reject a
  broader user-writable PATH entry that could shadow them.
- Preserve goals false, approval never, empty MCP/plugins/providers,
  environment non-inheritance, workspace rules, and deny roots.

**Tests/verification:** TDD each invalid root/overlap/path/network case,
byte-exact rendering, old-profile compatibility, new-profile characterization,
domain mismatch, descendant-deny preservation, production-shaped HOME
ancestry, symlink/traversal denial, drift refusal, and profile-identity
replacement. Run targeted tests then the full Polygram suite.

### U4. Fix the settings presentation and high default

**Goal:** Deliver the requested concise model UI without changing model
identity or session semantics.

**Files:** `lib/handlers/config-ui.js`,
`lib/handlers/config-callback.js` only if the shared remap helper needs a
call-site adjustment, `lib/handlers/slash-commands.js` only for the same
reason, `tests/handlers-config-ui.test.js`,
`tests/handlers-config-callback.test.js`,
`tests/handlers-slash-commands.test.js`.

**Approach:**

- Add one immutable ordered presentation table and one catalog-filtered
  `visibleModels` projection used unchanged by keyboard and body.
- Render `Opus/Sonnet/Haiku` and `Sol/Luna/Terra` with short descriptions.
- Render the Golden Telegram Cards exactly and remove the warning block.
- Prefer `high` when remapping an incompatible Codex model/effort pair.
- Preserve explicit valid selections and raw IDs. U3 owns
  `config.example.json`; deployment rollout owns current scope values.

**Tests/verification:** Exact body/row order and labels, descriptions, checked
markers, raw callback payloads, hidden Codex behavior, no old warning, no
technical status lines, a reordered/incomplete authenticated catalog,
provider-relative focused cards, valid explicit xhigh retention, invalid-pair
high remap, active-turn immutability, and stable thread ID.

### U5. Make prompt history and context provider-aware

**Goal:** Give Codex one correct fresh preload and the correct scoped session
file.

**Files:** a new SQLite migration, `lib/db/sessions.js`, `polygram.js`,
`lib/prompt.js` only for truthful Codex capability copy, focused
DB/prompt/dispatch/recovery tests.

**Approach:**

- Materialize one immutable per-turn runtime snapshot and pass it to both
  prompt formatting and spawn preparation.
- Store a durable history-preload marker keyed by provider namespace and
  provider session ID with `pending` and `complete` states.
- Write `pending` before turn submission; mark `complete` only after provider
  acceptance; reconcile interrupted pending markers from durable
  attempt/provider evidence.
- Resolve topic-effective cwd in the snapshot before reading the session file.
- Replace the Codex prompt's obsolete web/network warning with the inline
  Telegram delivery contract and the truthful instruction to ask user
  questions as normal text. Retain the no-Telegram-MCP and no-detached-server
  constraints.

**Tests/verification:** Codex-first, `/config`-created empty Codex thread,
Codex resume, failed-before-acceptance retry, accepted first dispatch, daemon
restart, cwd-drifted non-resumable row, Claude channels-class drift,
Claude-to-Codex, Codex-to-Claude, isolated-topic cwd, and Claude regression
cases.

### U6. Expose canonical Shumabit instructions and skills

**Goal:** Make one workspace definition work for Claude and Codex.

**Repository:** `shumabit-claude`.

**Files:** `AGENTS.md`, `.agents/skills` relative link, and a small
provider-discovery verification test/script if the repository lacks one.

**Approach:**

- Move only missing provider-neutral bootstrap facts from
  `_shumabit-base.md` into AGENTS; do not duplicate prose unnecessarily.
- Keep the explicit Ivan-DM-only `MEMORY.md` rule and sender-ID permission
  checks.
- Link `.agents/skills` to canonical `skills/`, preferring one relative
  directory link and falling back to generated relative per-skill links.
- If U1 disproves directory-link discovery, generate relative per-skill links
  instead.

**Tests/verification:** Claude still loads its existing agent; pinned Codex
`skills/list` with `forceReload` returns an empty errors array and the exact
names/resolved source paths derived at test time from canonical
`skills/*/SKILL.md`; adding a temporary canonical test skill makes it visible
through the link; no copied skill content exists. Model-generated “list your
skills” prose is not the structural oracle.

### U7. Enforce the scoped-memory dependency

**Goal:** Prevent a Codex-only memory shortcut while the provider-neutral
memory service is separate work.

**Repositories/config:** Polygram production configuration, Shumabit workspace
discovery, and deployment documentation.

**Approach:**

- Do not install or expose the upstream Codex `memory-recall` adapter,
  memsearch executable, legacy database, or plugin state through the widened
  command profile.
- Keep Shumabit@UMI `codexEnabled: false` without deleting its saved model,
  effort, or provider thread.
- Link operational documentation to
  `umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md`.
- Treat later automatic memory enablement as a provider-neutral rollout that
  must pass that plan's channel, sender, storage, and session-boundary gates.

**Tests/verification:** Profile projection and real-runtime denial prove no
direct memsearch path; group Codex remains hidden and dispatch-rejected; Ivan
DM Codex UI, web, skills, and session behavior work without semantic-memory
claims.

### U8. Release, migrate, and canary

**Goal:** Roll out without config drift, provider-session loss, or broad chat
enablement.

**Sequence:**

1. Release reviewed Orchestra from current main ancestry.
2. Pin that exact Orchestra version in Polygram and run full tests.
3. Land/release the Shumabit workspace discovery changes without a direct
   memory adapter.
4. Save the current Shumabit@UMI `codexEnabled`, model, effort, and provider
   thread state, then set its `codexEnabled` to `false` and its provisioned
   Codex effort to `high`. Do not delete or rewrite its saved model/session.
5. Activate the service-wide cached-search and explicit command profile while
   Ivan DM is the only Codex-enabled Shumabit scope. Set Ivan DM and the
   example configuration to explicit `codexEffort: "high"`. Do not change
   Ivan's `pm` selection or enable another scope.
6. Quiesce the Shumabit service, move the old owned config to a protected path
   that the new profile explicitly denies, restart, and let Polygram
   reprovision exact bytes. No reboot.
7. Run doctor/preflight, then Ivan-DM canaries for config UI, model switch,
   cached web, local skill, anonymous-network skill, resume, and Claude
   switch-back.
8. Observe normal logs/telemetry and leave Shumabit@UMI Codex-disabled.
   Re-enablement, legacy-memory exclusion, any required fresh scope-bound
   provider session, and the group canary belong to
   `umi-vps-infra/docs/SHUMABIT_SCOPED_MEMORY_SPEC.md`.
9. Update `~/INFRASTRUCTURE.md` and deployment documentation with the exact
   active scopes, Codex version, web/network policy, deferred scoped-memory
   boundary, and rollback location, without secret values.

**Rollback:** Select Claude for affected scopes, restore the prior Polygram
release/config, group-flag state, and matching owned config backup, then
restart the service.
Provider session rows are retained; rollback must not clear sessions or rerun
provider work.

## Dependencies and Critical Path

The work ships as two independently releasable slices:

1. **Slice A — Polygram settings/default UX.** U4 ships the exact cards,
   labels, warning removal, and high remap without waiting for a widened
   runtime profile.
2. **Slice B — attested capabilities and Shumabit context.** U1/U2/U3/U5/U6/U7
   ship behind their runtime and migration gates. U8 deploys this slice.

Slice A may release first and has its own rollback. Slice B does not hold its
user-visible fixes hostage to runtime unknowns.

```text
U1 capability evidence
  ├─> U2 Orchestra policy -> Orchestra release
  ├─> U3 Polygram command profile ──────────┐
  ├─> U6 Shumabit discovery ────────────────┤
  ├─> U7 direct-memory denial/group guard ──┤
  └─> U5 provider-aware context ────────────┼─> U8 migration/canary
U4 settings UX/default -> Slice A release ──┘
```

Critical path: U1 cached-web/profile evidence → U2 Orchestra release → U3
Polygram consumption/profile → U7 direct-memory denial/group-disable proof →
U8 Ivan canary.

U4 owns only the UI/default slice. U3 owns `config.example.json`. U5/U6 can
proceed in parallel after the reviewed plan is approved.

## Verification Contract

### Automated

- Orchestra targeted Codex preflight, process, app-server-client, and factory
  suites.
- Orchestra full `npm test`.
- Polygram config UI/callback/slash/prompt/history/session/runtime-profile/
  controller/doctor/integration suites.
- Polygram full `npm test`.
- `git diff --check` in every changed repository.
- No skipped tests are reported as a pass.

### Real-runtime gates

- Pinned Codex 0.145.0 cached web search.
- Exact effective config and permission-profile projection on Linux.
- Real HOME/PATH/network-domain/deny-root shell and traversal probes.
- Native project/personal `skills/list` structural discovery.
- Attested local and anonymous-network skill execution.
- Direct memsearch executable/database/plugin denial.
- Fresh/resumed provider history behavior.

### Production canary

- Ivan DM first:
  - `/config` text/buttons;
  - Sol/high and one model switch;
  - cached web result;
  - harmless local skill;
  - anonymous-network skill;
  - `/reload`/resume;
  - switch Claude → Codex → Claude without losing either provider session.
- Shumabit@UMI has no canary in this plan and remains Codex-disabled.

### Telemetry

During canary, no new:

- `CODEX_SERVER_REQUEST_DENIED`;
- unexpected notification/protocol containment;
- `CODEX_OWNED_CONFIG_DRIFT`;
- executable, network-domain, or filesystem-profile drift;
- repeated `history-preloaded` on one resumed Codex thread;
- direct memsearch state access;
- unique credential sentinels in any structural persistence sink;
- provider-thread replacement on model/effort changes.

## Definition of Done

- The reviewed exact labels, descriptions, order, and concise settings card
  are shipped.
- New/current approved Codex scopes are explicitly `high`; valid user
  overrides remain durable.
- Cached web and the explicit Shumabit command environment pass pinned-runtime
  and production canaries for the named local and anonymous-network subset; no
  claim is made for every discovered skill.
- Codex loads provider-neutral Shumabit bootstrap instructions and discovers
  canonical skills without copies.
- Codex has no direct integration with the existing workspace-wide semantic
  index.
- Shumabit@UMI remains Codex-disabled until the provider-neutral scoped-memory
  service is deployed; the saved group model and provider thread survive this
  plan, and its provisioned effort is explicitly `high`.
- Fresh-history and topic-cwd regressions are covered.
- Goals remain off; MCP/native approvals/questions are neither advertised nor
  accidentally enabled.
- Claude SDK/CLI tests and live health remain unchanged.
- No additional chat/bot scope, reboot, session deletion, exposure of
  `CODEX_HOME`, Polygram daemon/control secrets, rollback backups, or unrelated
  credentials, or provider-work replay occurs.
- `~/INFRASTRUCTURE.md` and deployment docs record the final active profile
  and deferred group-memory boundary without secret values.
