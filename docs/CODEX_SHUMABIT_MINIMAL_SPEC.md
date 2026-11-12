# Minimal usable Codex for Shumabit

Status: initial design and concrete trusted-profile amendment independently reviewed
for policy/proxy correctness and admission/races; corrections incorporated. Ivan
approved full practical Codex capabilities for his personal Shumabit chats. Production activation and
provider generation calls still require a separate go for the concrete result.

## Objective

Use Codex with selectable GPT-6 Astra, Shumabit's existing skills and shared file
memory, and the existing VPS CLIProxy pool. Avoid completing the old scoped-memory
router project. Start with explicitly selected trusted Ivan conversations; do not
change the runtime of existing Claude conversations automatically.

## Initial evidence (2026-11-12, before implementation)

- Polygram worktree starts at `6718989`, clean, package 0.45.0 / Orchestra 0.11.3.
- Codex is pinned to 0.145.0. Its runtime model catalog is dynamic, but
  `lib/handlers/config-ui.js` filters it down to three GPT-5.6 models. `/model`
  uses this same filter.
- VPS CLIProxy's authenticated, read-only `/v1/models` lists `gpt-6-astra`,
  `gpt-6.1-sol`, and other GPT-6 variants. This proves advertisement only, not
  successful generation or tool calls.
- The VPS config enables Codex selection in Ivan DM and a group, currently
  selecting Claude. Codex hooks are absent. The Shumabit checkout has root
  `MEMORY.md` and `memory/`, but lacks `.agents/skills`.
- `shumabit-claude` branch `feat/codex-shared-config`, commit `93c48870`, already
  contains `.agents/skills -> ../skills` and provider-aware delegation instructions.
  The Polygram `feat/codex-shumabit-agent-config` branch has its historical design.
- `feat/shumabit-scoped-memory` in `polygram.codex-support-estimate` contains the
  much larger unfinished router/publisher project and dirty documentation. Leave it
  intact; none of its unfinished gates are prerequisites for this file-memory MVP.
- Polygram's Codex profile and Orchestra's preflight reject custom providers.
  They require native ChatGPT authentication. Commands have a synthetic HOME,
  minimal PATH, no inherited environment, no network, no product MCP, and no access
  to configured daemon-secret roots (including Shumabit skill credentials).

## Approach and boundaries

### Model selection

Add Astra to the small curated menu, still intersected with the preflight catalog.
Use exactly `gpt-6-astra`; retain the current model and effort until the user changes
them. Use catalog-supported efforts and the existing fallback to the selected
model's default effort. No binary bump unless the pinned runtime fails a concrete
compatibility check. Updating the entire model menu is optional and separate.

### Skills and instructions

Rework the existing two-file Shumabit change against fresh origin/main. Ivan explicitly
requested a renewed audit because the shared skills have changed substantially since
August: do not cherry-pick the old AGENTS.md wholesale. Audit current SKILL.md files
and their direct entry-point instructions for provider-only assumptions, repair only
actual incompatibilities, and preserve newer business rules and permissions.
Keep one canonical `skills/` directory and native Codex discovery through
`.agents/skills`. Do not translate Claude agent files or build a skill registry.
Verify the root instructions and a harmless skill body are actually consumed.

### Shared memory

Shumabit already instructs both agents to use the same repo files: daily
`memory/YYYY-MM-DD.md`, and `MEMORY.md` only in Ivan's direct conversation.
Preserve this boundary. First prove cross-agent file recall using synthetic facts.
Do not expose Ivan's private index to the group simply because Codex is enabled
there today.
This preserves an instruction-level boundary, not filesystem isolation: the existing
shared cwd/UID can read the same files. Do not automatically inject private memory
into group contexts or broaden group permissions as part of this MVP.

The local Mac setup additionally shares Claude auto-memory via a SessionStart hook
that injects the canonical project's `MEMORY.md`, with topic files read on demand.
Do not copy that hook blindly: Polygram owns an exact observer-only hook inventory.
Before adding auto-memory transport, inventory which store the production Claude
agent actually uses. If additional Claude auto-memory holds needed facts, give the
trusted scope an explicit canonical index path and file-read instructions, with
access to the corresponding topic files. Prefer this simple instruction/file path
over extending protected hook infrastructure. Do not merge stores or migrate facts
automatically. Native Codex memory must not become a third competing store.
Instruction-driven reading is weaker than deterministic SessionStart injection.
Accept it only after fresh-session recall succeeds without naming the memory file
or repeating the synthetic fact in the probe prompt; do not claim hook equivalence.

The current source audit also found the existing `sessions/{chat_id}.md` protocol
in Claude's shared base instructions. Move that protocol and its existing template
into canonical AGENTS.md so both providers can read and update the same local memo.
Read only the matching existing partner memo, without extending partner edit/admin
grants. Use trusted outer Telegram metadata, preserve explicit no-read/no-write
constraints, and keep topic-private material out of these chat-wide files. Claude's
hook and Polygram's topic-keyed fresh-process preload do not guarantee this protocol
ran; explicit reads are needed. No new store, hook, migration or topic reconciliation
is included. This source-only amendment passed independent plan and diff reviews.

### CLIProxy

Reuse the existing Photoroom pattern: a named `cliproxyapi` Responses provider,
loopback `/v1` endpoint, bearer read from a private key file, and
`requires_openai_auth = true`. This deliberately retains local ChatGPT auth/catalog
as the smallest initial implementation; inference uses the proxy pool. Loss of local
ChatGPT auth may still block startup even when the pool is healthy.

Orchestra and Polygram must both recognize this explicit provider and include its
configuration in the existing exact-profile validation. Preserve native behavior
when absent. Never weaken validation to accept arbitrary config; never fall back to
native inference after proxy failure. Keep key material out of errors, receipts,
logs and command arguments. Do not remove existing auth/account checks to make a
probe pass. Infra provisions the key and performs the backed-up owned-config
transition; editing a running config by hand currently causes rejection.
Orchestra's process factory also pins the provider to `openai`: update its expected
thread provider from the validated profile, including spawn and resume validation.

### Trusted command access (approved scope)

Use one opt-in deployment profile and the existing dedicated CODEX_HOME, not a new
per-chat home router:

```json
{
  "codex": {
    "access": {
      "mode": "trusted",
      "chatIds": ["68861949"],
      "commandPath": "/home/shumabit/.local/bin:/usr/local/bin:/usr/bin:/bin"
    },
    "proxy": {
      "baseUrl": "http://127.0.0.1:8318/v1",
      "clientKeyFile": "/etc/polygram/shumabit-codex-proxy.key"
    }
  }
}
```

Absent access retains current beta behavior. Present access must have mode trusted,
a nonempty list of exact positive decimal private-chat IDs (strings, no wildcards),
and an explicit absolute-entry PATH. This first increment supports private chats;
group/topic trust expansion is separate. Intersect the allowlist with existing
codexEnabled in resolveCodexEnabled. Invalid access configuration makes eligibility
false without breaking Claude menus, with explicit validation errors when preparing
the deployment. Unlisted Codex scopes cannot run in this deployment, even if their
old codexEnabled flag is true. Their selected Claude runtime is unaffected.

The named profile `polygram-trusted` uses filesystem `{":root":"write"}` ONLY,
network enabled, and web_search live. Exact Codex 0.145 upstream code maps this to
dangerFullAccess (protocol/src/permissions.rs); Orchestra's projection already supports
that sandbox. Do not retain narrower read/deny entries or silently relax workspaceWrite
root validation. Trusted commands have the service user's filesystem rights, including
credentials, as Claude does. Dedicated-home attestation detects configuration drift;
it is not isolation from trusted commands.

Set shell HOME to the service's real HOME, PATH to access.commandPath and TMPDIR to
the workspace command temp directory. Keep inherit=none and allow_login_shell=false;
do not pass the daemon's token environment. Turn off native Codex memory generation
and use so the existing Shumabit files remain authoritative. Product MCP/plugin
registries remain empty in this increment; skills use existing scripts/CLIs.

Orchestra must explicitly distinguish the existing limited policy from this trusted
policy using the reviewed profile ID and exact permission projection. Accept live
web/network/full-access only together for the trusted policy. Derive expected thread
provider and sandbox from the validated profile; reject drift on start/resume/settings.
Do not turn off preflight or widen the original limited policy.

Polygram's controller must fingerprint access, proxy and command environment alongside
hooks for cache reuse and preflight races. Include private key-file content identity
without exposing its content. Recheck admission and fingerprint after asynchronous
preflight and before returning a cached receipt or constructing a client. Bind entries
to their originating chat/thread. Existing dispatch/steer/resume/replay admission must
continue through the shared scope check, including live Codex generations. A changed
profile uses existing process replacement behavior; never reuse an old trusted process
under a newly restricted configuration. Update the Codex preamble to describe the
effective policy instead of always claiming network/web are disabled.
Check the deployment fingerprint at live turn/steer/queue/replay admission too:
an in-flight process can bypass prepareSession through claimDispatchReservation and
tryCodexAutosteer. Removing access config re-enables ordinary beta eligibility, so
the scope check alone cannot detect a stale full-access process. Assert the current
fingerprint at the shared dispatch-owner seam, reject new inputs on drift, let the
current turn finish, and replace through the existing idle flow. Cover trusted-to-beta
revocation while a turn is running.

The proxy object is optional independently of access mode. Its only provider is
cliproxyapi, only a loopback Responses endpoint is accepted, and the private key file
is read by the host-side renderer. Native mode stays unchanged when omitted. Missing
or changed key/config fails clearly; no automatic migration or native fallback.

## Alternatives rejected or deferred

- Finish the old scoped-memory router: unrelated background extraction, routing,
  publishing and indexing work delays usable Codex.
- Duplicate skills or memory per provider: causes drift and breaks shared recall.
- Just symlink skills: discovery succeeds but action skills still fail under the
  current command policy.
- Just add a proxy environment variable: the environment is sanitized and both
  validators reject a custom provider.
- Remove native ChatGPT auth immediately: larger account/catalog contract change.
- Upgrade Codex incidentally: unnecessary until evidence shows the pin blocks Astra.

## Verification and rollout

1. Focused regression: Astra in catalog appears in `/config` and is accepted by
   `/model`; absent Astra is excluded; supported effort is preserved and unsupported
   effort uses the model's default. Observe red then green for the menu omission.
2. Proxy configuration tests in both repositories: valid explicit provider, native
   mode unchanged, wrong endpoint/config rejected, missing key fails without secret
   disclosure, no native fallback, correct provider through process construction and
   thread start/resume. Verify exact persisted rendered config privately.
   Trusted tests also cover allowlisted/unlisted/malformed scopes, topic overrides,
   revocation during preflight, cached receipt/client rejection after revocation,
   unchanged Claude behavior, restricted mode preservation, and policy changes
   replacing processes. Verify trusted projection with pinned runtime without inference
   before any paid probe. Keep live generation verification separately authorized.
3. Read-only runtime probes: pinned binary identity, real app-server model catalog,
   selected model/effort, skill catalog discovery, and credential/path availability without
   printing credential contents. Catalog advertisement is not inference proof.
4. After explicit provider-call approval: isolated Astra turn through CLIProxy with
   a harmless command; tool results and final reply; proxy failure surfaces as an
   error. No automatic retry of ambiguous paid calls.
5. After explicit provider-call approval, prove harmless skill-body consumption and
   a synthetic common-memory round trip in a scratch location: one agent writes,
   a fresh other-agent session recalls without a file hint. Check group instruction
   handling and absence of private-index injection; this is not isolation proof.
6. Release and activation require Ivan's go for the concrete reviewed result.
   Use existing lean deployment procedures; select one trusted conversation first,
   read persisted settings back, and verify a Telegram turn. Other conversations
   retain their configured backend. Rollback selects Claude and restores backed-up
   Codex config; do not delete threads or memory.

Remaining parity gaps (`/context`, `/compact`, rewind, product MCP, interactive
approvals, detached processes, Claude-specific reply-tool conventions) are not
automatically included. Verify the actual chosen skills do not require an unsupported
surface. Repository tests do not prove proxy inference or production Telegram use.

## Implementation checkpoint

### Agreed runtime upgrade sequence

Ivan agreed to the planned upgrades on 2026-11-12 and then explicitly requested
Claude preparation in a separate parallel worker. Finish the current shared-skills,
memory, Astra-selection and proxy integration before upgrading Codex. Prepare the
Claude upgrade independently in parallel; keep both upgrades separately reviewable.
Earlier registry research found
Codex 0.167.2 and Claude 2.1.322 / Agent SDK 0.3.322 as candidates; recheck official
releases before choosing the exact pins. This supersedes deferring all runtime
upgrades, but does not fold a pin bump into the current implementation.

For Codex, review the app-server/config changes and validate exact schema/policy,
provider identity and persisted-session compatibility. For Claude, follow the
repository's mandatory old/new gate matrix, offline binary preservation, aligned
SDK/Orchestra pins and staging/CLI soak procedure. Keep local research, reviewed
specs and compatibility preparation moving under this agreement. Paid provider
tests, publication and production activation still need the concrete scoped go.

### Current enablement

The independent Astra menu change is implemented locally. Two new regression tests
failed against the original menu, then the complete config UI, slash-command and
config-callback suites passed: 183 tests, zero failures or skips. Two independent
read-only reviews of the three-file code/test diff against `6718989` found no
must-fixes. No commit, release, inference call or production activation was performed.
Trusted admission, rendered policy, optional CLIProxy provider, effective prompts
and deployment-drift fencing are implemented locally in Polygram and Orchestra.
The integrated Polygram suite passed 4784 tests with zero failures and 16 existing
opt-in real-Claude skips. Orchestra's full suite passed 1547 tests with 19 existing
N/A skips; after correcting the canonical filesystem digest, 494 focused tests
passed. Independent source reviews found no remaining must-fixes.

Pinned Codex 0.145.0 probes confirmed rendered config and native/proxy thread start
with `dangerFullAccess` and the expected provider. Empty threads are not yet durable:
the pinned runtime materializes their rollout on the first user turn. A deterministic
loopback Responses turn persisted successfully, and a fresh process resumed the same
message/reply with the correct provider and trusted policy. Authoritative JSONL
readback passed. The HTTP-only fixture induced WebSocket retries then HTTP fallback
to the same provider; successful WebSocket transport remains unproven. External
network egress was denied throughout; no real generation was performed.

The fresh Shumabit audit covered 78 SKILL.md files (77 valid discoverable skills,
one intentional exclusion). Shared instructions and compatibility fixes retain one
canonical skills directory through `.agents/skills -> ../skills`. The existing
per-chat memory protocol now resides in shared AGENTS.md; Claude-only partner admin
grants remain in the Claude base. Source assertions and independent reviews passed;
native skill consumption and cross-provider recall remain unproven.

Infra preparation provides a key-only Ansible playbook and a reviewed backed-up
config transition/rollback procedure. Synthetic local checks passed; no VPS change
was made. Activation needs a concrete approved maintenance window for both writers
of the shared runtime JSON. Local verification preceded integration commits;
release integration,
live provider/tool/skill/memory checks and Telegram activation remain outstanding.

Evidence receipts: `/tmp/polygram-trusted-profile-report.md`,
`/tmp/polygram-trusted-resume-report.md`,
`/tmp/orchestra-trusted-proxy-report.md`, `/tmp/orchestra-trusted-null-report.md`,
`/tmp/shumabit-shared-skills-audit.md`, `/tmp/shumabit-perchat-memory-audit.md`, and
the infra worktree's `docs/POLYGRAM_CODEX_PROXY_SPEC.md`.

## Sources

- `lib/handlers/config-ui.js`, `lib/handlers/slash-commands.js`
- `lib/codex/runtime-profile.js`, `lib/codex/model-catalog.js`
- Orchestra `lib/codex/preflight.js`, `lib/codex/app-server-client.js`
- `shumabit-claude/AGENTS.md` and commit `93c48870`
- Local `~/.agents/bin/agent-memory-context`, `~/.agents/docs/SHARED_MEMORY_SPEC.md`
- Photoroom `app/src/codex_adapter.rs`
- [Official Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Official custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
