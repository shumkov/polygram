# One Codex policy for Polygram

## Intent and source

Ivan requested CLIProxy and identical full access in every Codex chat. This
supersedes the optional proxy, limited profile and private-chat allowlist in
CODEX_SHUMABIT_MINIMAL_SPEC.md. Base: Polygram14fd485 /0.46.2 with exact
Orchestra0.12.2 (80eec231); no dependency/runtime/Claude pin changes.

Source cause: deployment-policy.js treats absent access/proxy as limited/native;
runtime-config.js intersects codexEnabled with access.chatIds; runtime-profile.js
constructs two permission/provider policies; prompt.js describes both. Existing
controller fingerprints, exact profile projection and Orchestra already support
the required trusted/external combination. Reuse that implementation.

Official references corroborate custom Responses providers and provider-specific
authentication; they do not establish provider entitlement from model/list:
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[app-server](https://learn.chatgpt.com/docs/app-server). Existing pinned0.167.2
source review, proxy2/2 provider completions and native Linux trusted-profile
evidence remain applicable. The additional edited-memory-freshness assertion
previously FAILED and stays unproven; no new provider experiment is planned.

## Exact behavior

- Deployment-wide `codex.access` is required and accepts exactly
  `{mode:"trusted",commandPath:"<absolute colon-separated directories>"}`.
  Legacy chatIds, missing access, other modes and malformed paths fail explicitly.
- Deployment-wide `codex.proxy` is required, retaining exactly baseUrl and
  clientKeyFile, loopback HTTP /v1, private-file metadata and content validation.
  No absent-proxy/native branch exists in Polygram. Shared Orchestra native mode
  remains unchanged. A stale native account/config cannot satisfy the exact
  external-provider receipt `{authenticated:false,accountType:null,requiresOpenaiAuth:false}`.
- Every constructed Polygram Codex profile is `polygram-trusted`, filesystem
  ONLY `{":root":"write"}`, network enabled, web_search live, native memories
  disabled, HOME=actual service HOME, PATH=commandPath, inherit=none/login=false.
  No daemon-secret deny rules are added to the full-access command policy.
  Existing root separation, dedicated-home ownership, binary/helper/schema,
  launcher, exact provider/config/auth projection and hook checks remain intact.
- Existing codexEnabled boolean precedence and explicit backend/model/effort
  selections remain unchanged. Remove access.chatIds from that scope gate.
  Claude-only scopes continue working even when the Codex deployment is invalid;
  Codex preflight/selection fails closed with actionable deployment errors.
  Existing UI availability/receipt checks still gate selection; no backend switch
  or automatic model/effort change is performed by this patch.
- Prompt text, `lib/handlers/config-ui.js` and `config.example.json` describe the
  single required full-access CLIProxy profile without native-login or chatIds
  instructions. Offline doctor accepts absent native auth, checks present auth
  metadata without reading it, and validates required access/proxy safely. It
  recognizes trusted root-write/network/live-web policy and retains private
  directory metadata/root separation checks without filesystem-deny requirements
  or claims that trusted commands cannot access daemon roots. Doctor is not
  provider entitlement or runtime-preflight proof.
  Controller cache/async-race/dispatch/steer/resume/replay fences continue binding
  access, proxy/key identity, environment, exact receipt and origin chat/topic.

## Shared instructions and actual topology

Keep the existing dedicated-home AGENTS.md symlink to the exact admitted canonical
workspace root; no copies, instruction merger, native memory or home router.
Foreign link targets/override files/unsafe ownership or parent modes still fail.
Normal canonical AGENTS edits remain shared source edits. Existing shared skills
links and memory instructions are consumed through the same canonical workspace.
Nested project instruction behavior is unchanged from0.167.2's untrusted-project
exclusion; this patch does not add a nested instruction loader.

Fresh read-only topology: Mac has4CLI+1Codex, its sole selected Codex workspace is
`/Users/ivanshumkov/Projects/shumkov/polygram.codex-support-estimate`. VPS is fully
restored28+3CLI with no access/proxy configured: Shumabit scopes use
`/home/shumabit/shumabit-claude`, UMI scopes use `/home/shumabit/shumabit-partners`.
Both VPS bots currently share one configured CODEX_HOME, which cannot bind both
roots. Coordinator aligned the following bounded correction to satisfy all chats:

- Treat configured `codex.home` (or existing environment fallback) as the legacy
  home anchor. If it has a safely validated canonical root AGENTS.md symlink, keep
  that home for exactly that canonical workspace, preserving existing Mac auth,
  session files and thread references in place. Validate its binding using the
  existing metadata/override/source/parent checks before selecting any home;
  malformed/foreign regular files, dangling/unsafe links or overrides fail closed.
- For every other canonical workspace, select
  `<configuredHome>.workspaces/<sha256(canonicalWorkspace)>`. The sibling container
  is canonical, owner-only0700 with safe parents; create it only under an already
  safe canonical parent. No mapping file, home registry, chat-ID router, copying,
  purge or retargeting. Same canonical cwd reuses its deterministic home; distinct
  cwd get separate config/state and exact source links. The derived home passes
  all existing dedicated-home/root-separation and source checks unchanged.
- An absent legacy AGENTS binding does not adopt or rewrite the legacy home.
  New homes are derived; VPS failed TOML/quarantine/history remain untouched.
  Existing unsafe legacy home metadata or AGENTS.override is rejected before
  deriving, so isolation is not a way to bypass an existing unsafe deployment.
- Actual selected home is part of the existing static profile/receipt/env and
  credential attestation. Cache reuse, refresh, spawn, resume and reattestation
  use that actual profile home; the configured anchor remains in the deployment
  fingerprint. Re-resolve selection after asynchronous preflight before storing/admitting its
  receipt, and at reuse/spawn/resume boundaries; reject changed selected paths or
  anchor bindings. Include an in-flight selection-drift regression. No account auth is copied to derived external-provider homes.
- Offline doctor describes anchor metadata and resolves selected workspace homes
  through the same selection helper without creating files; unprovisioned homes
  are reported unavailable, never provider-ready. It must not inspect unrelated
  personal homes or require native credentials.

A dedicated selected home still binds exactly one canonical workspace. No thread
instruction override can safely replace this under pinned0.167.2 untrusted-project
exclusion without copying/injecting source content. Per-bot environment-only homes
solve the two VPS bots but not different workspaces within one bot; rejected as
incomplete. Moving/copying the existing Mac home would risk session continuity;
retaining its validated legacy binding avoids that migration.

## Alternatives and migration

Reject retaining optional native/limited paths or ignoring legacy chatIds: these
preserve hidden policies. Reject guessed PATH/proxy defaults or copying native
auth: host authority and provider identity must remain explicit. Reject changing
Orchestra's generic API or adding a policy/home registry or instruction framework: unnecessary here.

Prepare a normal Polygram patch release0.46.3 on unchanged Orchestra0.12.2; no
version bump/publication/deployment in this task. Startup loads configuration,
so host edits require the existing authenticated helper-owned replacement route;
never signal/restart independently or hot-edit owned TOML under live profiles.

- VPS: add global proxy pointing at127.0.0.1:8318/v1 and existing
  `/etc/polygram/shumabit-codex-proxy.key`; global access has mode trusted and
  commandPath `/home/shumabit/.local/bin:/usr/local/bin:/usr/bin:/bin`, NO chatIds.
  Preserve all pm/codexEnabled/model/effort choices and .283 service overrides.
  Infra completed only the non-recursive Shumabit root0775->0755 prerequisite.
  UMI root0775->0755 and AGENTS0664->0644 remain pending guarded owner operations;
  its canonical .agents/skills source link is delivered separately. Skills0775
  remains unchanged. Recheck safe parents/sources before any later activation.
- Mac: same shape, local endpoint127.0.0.1:8318/v1, private service-user key file
  `/Users/ivanshumkov/.config/polygram/codex-proxy.key` provisioned from its existing
  local proxy client credential (never a native auth/account token), and commandPath
  `/Users/ivanshumkov/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`.
  Keep existing topic5 backend/model/effort/cwd, dedicated home and auth.json
  untouched; auth remains unused by the selected external provider. No new root
  Mac change is needed. Use the existing local helper for exact new release and
  config startup; its journal owns the single replacement/no-retry boundary.
- For each host, first quiesce through the established owned rollout, preserve
  current config/metadata and attributable owned TOML. Reuse an existing TOML only
  if its bytes exactly match the new owned policy; otherwise back it up and retire
  only the unchanged positively owned file while no Codex process can use it.
  Never overwrite a foreign AGENTS link, auth, sessions or quarantine history.
  VPS failed activation left unattested0600 TOML with no homeAGENTS/auth; retain
  it unchanged at the legacy anchor while new workspace homes are used.
  The separate operational rollout may make the originally requested normal
  DM selection (Codex/Astra/high); this source patch has no DM-specific branch.
  Restart invalidates in-memory receipts; existing generation/lease and catalog
  fingerprints require exact fresh preflight before new Codex admission.

## Verification

Independent spec review before implementation, then concrete RED/GREEN for group
and unlisted scope eligibility, missing proxy/access rejection and full-profile
construction, plus valid no-auth trusted/external doctor checks and assertions
against stale UI/example policy descriptions. Adapt existing process fixtures to the same trusted/external policy
without weakening permission/auth/sandbox assertions. Retain cache revocation,
async race, key rotation, no-native-fallback, scope origin, UI/backend-choice,
shared-root/skill/memory binding and foreign-workspace negatives. Focused suites,
full offline suite and independent actual-diff reviews; no paid calls or production
mutation. Return exact diff, results and host instructions with remaining binding
selection and operational prerequisites honestly stated. Add same-cwd reuse,
distinct-cwd sequential/concurrent isolation, unsafe legacy/derived paths, cache
selection drift and preservation of existing legacy session/auth bytes.


## Local implementation evidence

Spec review: independent security and consumer/scope reviews, including the
workspace-home amendment and post-async selection fence. Actual-diff reviews
found selected-home global aliases, doctor binding/read boundaries and shared
container creation races; regressions were observed failing before corrections
and pass after them. Both reviewers returned CLEAN on the corrected actual diff.

The process fixture uses no external inference. It verifies actual selected home
in spawn/credential-cache checks, a new controller/process resuming the persisted
thread from the same derived home, unchanged legacy auth/history, and refusal of
a receipt after an anchor change during asynchronous provider preflight. Normal
stop/hard-loss semantics are not changed. No new paid/native/provider matrix is
needed for this uniform policy change; previous real provider2/2 remains the
provider evidence, with edited-memory freshness still FAILED/unproven.

Final offline verification: `npm test` on Node26.5.0 — 4859 tests, 4843 pass,
0 fail, 16 existing opt-in skips; no provider/production calls. Fresh origin main
is still14fd485 and registry latest0.46.2. Recommend patch0.46.3; no version bump
or publication was performed. Exact logs/report are in
`/tmp/polygram-global-codex-policy-task_4a8c5817f5cc/`.
