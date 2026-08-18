# Scoped memory U21 findings — plugin integration (B1, B2, hook fork, R62 receipt)

Date: 2026-08-11

Status: **BLOCKED — on one named, costed Orchestra change.** Research and
validation only. No application code, production configuration, service,
credential, Telegram, VPS, or memory/transcript content was created, modified, or
read. No commit, push, deploy, or restart was performed.

**Amended 2026-08-11 (same day).** The turn gate was run **credential-free**
against a loopback model-provider stub (§4A), so no `auth.json` was copied,
read, or created and no refresh token was placed at risk. That gate settled B2
and B4 and turned the previous unknown into a **specific, provable blocker**:
enabling any Codex hook makes the app-server emit `hook/started` and
`hook/completed`, which the pinned Orchestra classifies as neither delivered nor
dropped and therefore **faults the session**. Sections marked *(amended)* carry
the new evidence; the original offline conclusions are unchanged and all held.

U21 asked four questions. Three are now retired with executable proof, one is
retired against the plan's own requirements with a **negative** answer that
reopens a contingency, and B2 is a *proven fail with a known fix* rather than an
unknown. A PASS requires all four; this is not a PASS.

| Question | Verdict |
| --- | --- |
| B1 — capture: can native extraction be bound per provider session to a non-recallable staging area? | **PASS (proven mechanism, per backend)** — containment now observed, not just argued (VF14) |
| B1 — recall: can the plugin's own recall be bound to a scope-bounded view? | **FAIL** — reopens KTD2's contingency; **U14 must be built** |
| B2 — does the Codex integration work under Polygram's pinned app-server/Orchestra path? | **FAIL, with a named fix.** Hooks *do* run under the app-server (VF14), but `hook/started`/`hook/completed` fault the pinned Orchestra (VF15). Requires an Orchestra release. |
| B3 — inline hook versus plugin-bundled hook | **RETIRED — inline hooks, per backend** (Codex: inline only; Claude: plugin-bundled is what upstream ships, Polygram already owns a per-session settings hook file) |
| B4 — fresh per-turn signed receipt correlated to hook `turn_id` without mutable per-thread env | **PASS** — `Stop` hook `turn_id` is byte-identical to the app-server `turn/started` id (VF16) |

---

## 1. Environment and provenance

| Artefact | Exact identity |
| --- | --- |
| Pinned Codex binary | `/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex`, reports `codex-cli 0.145.0` |
| Pinned Orchestra | `node_modules/@shumkov/orchestra` **0.10.14** (read-only) |
| Orchestra protocol pin | `lib/codex/protocol-schema.json`, `cliVersion: "codex-cli 0.145.0"`, `binarySha256 1da3f4e0…f590` (aarch64-apple-darwin) |
| memsearch engine | `memsearch 0.4.17` wheel resolved offline from the existing `uv` cache (`~/.cache/uv/archive-v0/cRG-57jwcdQmpgYU/`) |
| memsearch **plugin sources** | public repo `github.com/zilliztech/memsearch`, tag **`v0.4.17`**, commit `b734a142ea017657959dfe918ecfe9e1a16c6654` (2026-07-31), sparse checkout of `plugins/` into the session scratchpad |
| Polygram Codex profile | `lib/codex/runtime-profile.js` (`buildOwnedConfig` / `renderOwnedConfig`) |

**This retires Verified fact 13a's blocker.** The plan recorded that the plugin's
own hook wiring "is not in the published package and was not available locally".
It is not in the wheel — the wheel ships only the `memsearch` console script and
the `MemSearch` library — but it *is* published in the same repository under
`plugins/`, tagged at the exact pinned version. Every claim below about hook
behaviour is read from that tagged source, not inferred.

Files read (memsearch v0.4.17):
`plugins/codex/hooks/{common.sh,stop.sh,session-start.sh}`,
`plugins/codex/scripts/{install.sh,derive-collection.sh}`,
`plugins/codex/skills/memory-recall/SKILL.md`,
`plugins/claude-code/{.claude-plugin/plugin.json,hooks/hooks.json,hooks/common.sh}`.

---

## 2. Verified facts

### VF1 — Codex hooks are stable and on by default on the pinned binary

```sh
CODEX_HOME=<disposable> \
/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex \
  features list
```

→ `hooks    stable    true`. No config change is needed to *enable* the hooks
feature. (memsearch's `install.sh` writes `[features] hooks = true` anyway; on
Polygram's owned config that write would be both unnecessary and destructive —
see VF6.)

### VF2 — The memsearch **Codex** integration is inline hooks, not a Codex plugin

`plugins/codex/scripts/install.sh` writes exactly three things:

1. `$CODEX_HOME/hooks.json` entries of `{"type":"command","command":"bash <dir>/hooks/<script>"}`
   for `SessionStart` (30 s), `UserPromptSubmit` (10 s), `Stop` (30 s);
2. skills copied to `$HOME/.agents/skills/{memory-recall,memory-config,memory-to-skill}`;
3. `[features] hooks = true` in `$CODEX_HOME/config.toml`.

There is **no Codex plugin manifest anywhere in the repository** — only
`plugins/claude-code/.claude-plugin/plugin.json` exists. The directory name
`plugins/codex/` is the vendor's own layout, not a Codex plugin package.

### VF3 — Inline hooks do not touch Orchestra's plugin-count constraint

Orchestra `lib/codex/preflight.js:410-411` fails closed with
`CODEX_STATIC_PROFILE_MISMATCH` when `config.plugins.count !== 0` or
`config.plugins.keySha256.length !== 0`.

Measured against the pinned binary with a Polygram-shaped owned config, with and
without `$CODEX_HOME/hooks.json` present:

```
config/read → config.plugins == {}   (pluginsCount: 0)   in both runs
```

Installing memsearch's Codex integration therefore **cannot** trip the
plugin-count rejection. Conversely, `codex plugin add` (the plugin-bundled route)
would populate `config.plugins` and fail preflight immediately. **This is what
decides B3 for Codex, and it agrees with what upstream ships.**

### VF4 — Codex hooks are **untrusted by default** and do not run until trust is persisted

This is the constraint the plan did not have. Discovered via the app-server's own
`hooks/list` method against a disposable home:

```json
{ "eventName": "sessionStart", "enabled": true,
  "source": "user", "sourcePath": "<CODEX_HOME>/hooks.json",
  "key": "<CODEX_HOME>/hooks.json:session_start:0:0",
  "currentHash": "sha256:cf12bc73…f056c",
  "trustStatus": "untrusted" }
```

`HookTrustStatus` ∈ `{managed, untrusted, trusted, modified}` (from
`codex app-server generate-json-schema --out … --experimental`,
`v2/HooksListResponse.json`).

Trust is granted by persisting, in `config.toml`:

```toml
[hooks.state."<CODEX_HOME>/hooks.json:stop:0:0"]
enabled = true
trusted_hash = "sha256:<currentHash of that hook entry>"
```

After appending that stanza, `hooks/list` reported `trusted` for all three hooks,
and the pinned binary accepted it **under `--strict-config`**. Editing
`hooks.json` afterwards flipped every entry to `modified` — the hash pins hook
*content*, so any hook edit revokes trust.

Two consequences that must land in U15/U16:

- The interactive/CLI escape hatch `--dangerously-bypass-hook-trust` **does not
  exist on `codex app-server`** (checked `codex app-server --help`). The TUI
  grants trust via `config/batchWrite`, which is **not** in Orchestra's pinned
  `clientRequests`. So Orchestra cannot grant hook trust at runtime; Polygram
  must render the trust state into the owned `config.toml` it already owns.
- Hook trust is content-addressed, so **the hook script set and the owned Codex
  config are now version-coupled**: shipping a new hook script requires
  re-rendering `config.toml`, its `ownedConfigSha256`, and the preflight
  `expectedConfigSha256` in the same change.

### VF5 — `hooks.json` alone is invisible to Orchestra's config projection; the *trust state* is not

Controlled A/B at the same paths (only `hooks.json` added between runs):

- Without trust state: `config.hooks == null`; the `config/read` config object is
  **byte-identical** to the no-`hooks.json` run (compared after key-sorting; the
  app-server serialises config as an unordered map, so a raw digest over
  `JSON.stringify` is meaningless — Orchestra is safe here because it digests
  through `lib/canonical-json.js`).
- With trust state written: `config.hooks` becomes a populated object carrying
  `state.<key>.{enabled,trusted_hash}` and the eleven event arrays.

Orchestra's `projectConfig` (`app-server-client.js:1003-1034`) does not project a
`hooks` field, and `assertExpectedPolicy` does not test one — but it does pin
`config.sha256 === expectedConfigSha256` over the whole object. **So: adding
hooks.json costs nothing; trusting the hooks changes the pinned config digest and
requires a deliberate re-pin.** No Orchestra change is required for either.

### VF6 — Polygram's owned Codex config is byte-exact and must not be installer-modified

`lib/codex/renderOwnedConfig` emits a fixed TOML rendering and
`lib/codex/runtime-profile.js:582-604` refuses to start when the on-disk
`config.toml` differs from it, with the explicit instruction that Polygram *never*
migrates or overwrites it. Running memsearch's `install.sh` against
`~/.codex-polygram` would therefore break Codex startup, not enable memory. The
hook trust stanza (VF4) must be added **inside `renderOwnedConfig`**, never by the
vendor installer.

### VF7 — Orchestra pins thread `cwd` to one owned workspace; there is no per-thread lever except the hook payload

- `projectThread` rejects `thread.cwd !== ownedCwd` (`app-server-client.js:1105`).
- `projectRequestParams` rejects `params.cwd !== ownedCwd` for `thread/start` and
  `thread/resume` (`:1689`), and `config/read` is forced to `{cwd: ownedCwd, includeLayers: true}` (`:1680-1686`).
- `projectRuntimeWorkspaceRoots` requires exactly one root equal to `ownedCwd` (`:1248`).
- The pinned `thread/start` schema has `optional: []` — no per-thread config overrides.
- The supervisor (`app-server-supervisor.mjs:15-21`) spawns the app-server with
  `env: process.env`. One process, one environment, many threads.

So for Codex: **no per-thread environment, no per-thread cwd, no per-thread
config.** Everything that distinguishes one Telegram chat's session from another,
inside a hook, must come from the hook's own stdin payload.

### VF8 — The Codex hook payload carries what a per-session and per-turn binding needs

From the pinned binary's embedded wire types, the hook input field set is
`session_id, transcript_path, hook_event_name, reason, permission_mode, source,
turn_id, agent_transcript_path, agent_type, last_assistant_message`, and
`stop_hook_active`. Event names:
`preToolUse, permissionRequest, postToolUse, preCompact, postCompact, sessionStart,
sessionEnd, userPromptSubmit, subagentStart, subagentStop, stop`.

memsearch's own `plugins/codex/hooks/common.sh` additionally reads `cwd` from the
payload — which, given VF7, is a constant equal to `ownedCwd` in our runtime and
therefore useless as a discriminator.

### VF9 — memsearch's output location and index target are bindable, and the async worker inherits the binding

`plugins/codex/hooks/common.sh` resolution order (identical in shape on the Claude
side):

1. `MEMSEARCH_DIR` set → **that directory wins for both the journal path and the
   collection name** (`_MEMSEARCH_DIR_EXPLICIT=true` → `derive-collection.sh "$MEMSEARCH_DIR"`).
2. Otherwise `PROJECT_DIR` ← `MEMSEARCH_PROJECT_DIR`, else payload `cwd`, else `pwd`;
   then **overridden by `git rev-parse --show-toplevel` if the path is inside a git
   repo**; and `MEMSEARCH_DIR = $PROJECT_DIR/.memsearch`.

The git-root override is a trap: two bindings whose directories live in one repo
collapse to one journal and one collection. Any binding scheme that relies on cwd
rather than `MEMSEARCH_DIR` is unsafe.

`stop.sh` returns `{}` immediately and hands the work to a **detached `setsid`
worker** (`stop.sh:362-366`) that re-sources `common.sh`. It exports only
`MEMSEARCH_PROJECT_DIR` and `MEMSEARCH_SKIP_HOOK_STDIN` explicitly — but it is a
child process, so an exported `MEMSEARCH_DIR` reaches it, and the journal path is
in any case computed in the parent and passed through the work file. **A binding
established in the hook process survives into the async writer.**

### VF10 — Staging never needs the index; capture never needs Milvus

In Milvus-Lite mode (`milvus.uri` not `http*`/`tcp*`) `stop.sh` does **no**
indexing at all — it only appends Markdown; indexing happens once at
`session-start.sh`. Since R60 stages Markdown and the trusted publisher owns
promotion and indexing, **the capture path requires no per-session Milvus binding
whatsoever**. The U1 per-scope-file decision applies to the publisher, not to the
hook. This materially shrinks B1's capture half.

### VF11 — Plugin-native recall cannot be scope-bound (B1's negative half)

`plugins/codex/skills/memory-recall/SKILL.md` is *instructions to the model*. It
tells the model to derive the collection itself, run
`memsearch search "<query>" --top-k 5 --collection <name>`, then
`memsearch expand <hash>`, and — explicitly, as a documented fallback — to `cat`
the source Markdown, `ls -t "$MDIR/memory/"`, and `grep -h "^## " "$MDIR/memory/"*.md`
when search is inconvenient. `--collection` is a model-chosen argument.

There is no interposition point. Consequently plugin-native recall cannot satisfy:

- **R40** (gateway owns read scopes, ≤5 results, ≤12 KiB total) — the model owns
  `--top-k` and can bypass search entirely with `cat`;
- **R47** (data-only result with immutable source binding, source role, record ID)
  — raw journal text carries none of that;
- **R60** ("a staged entry is never recallable by any principal, including the one
  that produced it") — the session could read its own staging directory directly.

The only remaining boundary would be the OS sandbox, which bounds *which bytes*
are readable but cannot impose result caps or result structure. **KTD2's
contingency therefore triggers: U14 is not dropped.** Its estimate returns to
0 d best / 3 d likely / 8 d worst and the critical path lengthens accordingly.
The `memory-recall` / `memory-config` / `memory-to-skill` skills must **not** be
installed for memory-enabled bindings, and the published scope directories must
not be readable from inside the provider sandbox.

### VF12 — R60 staging containment has a real enforcement point

Polygram's owned profile gives the session `permissions.<profile>.filesystem =
{":minimal":"read", "<codexHome>":"deny", "<daemonSecretRoots>":"deny",
":workspace_roots":{".":"write"}}` with `network.enabled=false` and
`projects.<workspace>.trust_level="untrusted"`.

Codex **hooks are command handlers configured by the trusted user config, not
model-issued shell commands**, so a staging root placed outside the workspace and
outside `:minimal` is writable by the hook and unreadable by the model. That is
exactly R60's shape: the session can write staging (through the hook) and read
nothing of it. This is a *design* conclusion from the permission model; the
observational half (that the hook actually runs, and runs unsandboxed) is part of
the unproven item in §4.

### VF14 *(amended)* — Codex hooks **do** execute under the pinned app-server, unsandboxed, on the app-server's own process environment

One synthetic turn through `codex app-server --strict-config --stdio` against the
loopback stub fired **all four** registered hooks in order:
`SessionStart` → `UserPromptSubmit` → `Stop` → `SessionEnd`. Sanitized payloads:

```json
{"session_id":"019fece1-75a3-…","transcript_path":"<HOME>/sessions/2026/08/11/rollout-…jsonl",
 "cwd":"<WS>","hook_event_name":"SessionStart","model":"u21-stub-model",
 "permission_mode":"bypassPermissions","source":"startup"}

{"session_id":"019fece1-75a3-…","turn_id":"019fece1-76a9-…","transcript_path":"…",
 "cwd":"<WS>","hook_event_name":"Stop","model":"u21-stub-model",
 "permission_mode":"bypassPermissions","stop_hook_active":false,
 "last_assistant_message":"U21 stub acknowledgement."}
```

This resolves branch **(a)** of the previous §4 fork — hooks are turn-scoped, and
`thread/start` alone is genuinely not a session start. **KTD1's staged native
extraction is viable on Codex**; the managed-provider fork does *not* reopen.

Three further facts fell out of the same run, each load-bearing:

- **Hooks run outside the sandbox (R60 containment observed).** The recorder wrote
  to a path declared `deny` in the session's permission profile and reported
  `outside_write=ok` on **every one of the four invocations**. A staging root the
  hook can write and the model cannot read is therefore real, not merely implied
  by the permission model. This upgrades VF12 from design argument to observation.
- **Hooks inherit the app-server *process* environment, not `shell_environment_policy`.**
  The hook saw `HOME=/Users/ivanshumkov` and the operator's full inherited `PATH` —
  **not** the `commandHome` / `/usr/bin:/bin` that `shell_environment_policy.set`
  pins for model-issued commands — and it observed the marker variable injected
  into the app-server spawn. This is the direct confirmation of "no per-thread
  environment": one process env, shared by every thread, visible to every hook.
  **D2's wrapper-sets-`MEMSEARCH_DIR` design is therefore both necessary and
  sufficient**, and it is the only mechanism available.
- **The `$PATH` pin hazard is confirmed as live.** The inherited `PATH` includes
  `~/.local/bin`, so upstream `stop.sh`'s bare `codex exec` would select the
  host's **0.146.1**, not the pinned 0.145.0. The wrapper must pass an absolute
  pinned binary.

### VF15 *(amended)* — **The blocker: `hook/started` / `hook/completed` fault the pinned Orchestra**

The same turn produced this notification stream (three hook pairs — one per hook
that ran during the turn):

```
remoteControl/status/changed, thread/started, warning, warning,
thread/status/changed, turn/started,
hook/started, hook/completed,          ← UserPromptSubmit
hook/started, hook/completed,          ← (turn-scoped hook)
item/started, item/completed, item/started, item/completed,
thread/tokenUsage/updated, account/rateLimits/updated,
hook/started, hook/completed,          ← Stop
thread/status/changed, turn/completed
```

Classified against `@shumkov/orchestra@0.10.14`'s pinned
`lib/codex/protocol-schema.json`:

| Method | Orchestra classification |
| --- | --- |
| `turn/started`, `turn/completed` | delivered |
| `hook/started` | **neither — unknown** |
| `hook/completed` | **neither — unknown** |

`app-server-client.js:2893-2899` drops known-dropped methods, delivers known
delivered ones, and for anything else throws
`CodexAppServerError('app-server sent an unexpected server notification', 'CODEX_PROTOCOL_ERROR')`,
which reaches `_fault()`. **Enabling any Codex hook therefore faults every
Codex-backed session on the pinned Orchestra**, at the first hook of the first
turn.

**Control run (the same home, `hooks.json` removed and the trust stanza stripped,
everything else identical):** the turn completed with **zero** `hook/*`
notifications, and all ten distinct methods observed are classified by the
Orchestra pin. So the fault is caused by *enabling hooks*, not by the stub, not
by the config shape, and not by the loopback provider. It also explains why the
production Codex canary is healthy today: it configures no hooks.

**The fix is small, known, and entirely outside Polygram:** add `hook/started`
and `hook/completed` to `droppedServerNotifications` in Orchestra's
`protocol-schema.json`, re-pin, release Orchestra, and consume the exact version
— the same procedure AGENTS.md already prescribes for protocol drift. Nothing in
Polygram changes. Note that dropping them is the right default: Polygram derives
turn identity from `turn/started`, which it already receives (VF16), so it needs
no information from the hook notifications.

### VF16 *(amended)* — B4 correlation proven: hook `turn_id` **is** the app-server turn id

| Source | Value |
| --- | --- |
| `turn/started` / `turn/completed` notification `turn.id` | `019fece1-76a9-70a0-a122-c10166072de6` |
| `Stop` hook stdin `turn_id` | `019fece1-76a9-70a0-a122-c10166072de6` |
| `thread/start` result `thread.id` | `019fece1-75a3-7d72-83aa-b3659fde96dd` |
| `Stop` hook stdin `session_id` | `019fece1-75a3-7d72-83aa-b3659fde96dd` |

Both identifiers match byte-for-byte. **D3 is executable**: Polygram learns the
session id at `thread/start` and the turn id from the `turn/started` notification
it already consumes, mints the receipt under its own identity at a path keyed by
`{session_id, turn_id}`, and the wrapper hook finds it using the identical pair
Codex hands it on stdin. No environment variable, no mutable per-thread state, no
shared writable channel the session could forge.

`UserPromptSubmit` also carries `turn_id` and fires **before** the model call,
which materially de-risks D3's mint/`Stop` race: the receipt can be minted on
`turn/started` and its arrival confirmed at `UserPromptSubmit`, long before `Stop`.
Tamper and replay remain publisher-side properties (signature + policy epoch +
single-use receipt + `{receipt, bullet, destination}` record identity) and are
unchanged by this gate — they were never dependent on the delivery mechanism.

### VF13 — The Claude CLI backend already has both levers, per session

- Each Claude CLI chat is its own `claude` process in tmux, so **per-session
  process environment exists** and `MEMSEARCH_DIR` alone binds journal and
  collection (VF9).
- Polygram already writes a per-session settings file
  (`~/.polygram/<bot>/hooks/<sid>.settings.json`, Orchestra
  `lib/process/hook-settings.js`) that registers command hooks including `Stop`,
  proven to fire alongside `--strict-mcp-config --setting-sources project,local`.

So B1's capture half and B3 are already satisfied on the Claude side by
infrastructure Polygram owns today. The upstream Claude integration is
plugin-bundled (`plugins/claude-code/.claude-plugin/plugin.json` +
`hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`), which is fine there because
Claude has no plugin-count constraint — but the **wrapper** that establishes the
binding belongs in Polygram's own per-session settings file, not in the plugin.

---

## 3. Decisions

### D1 — B3 is retired: **inline hooks**, with a Polygram/infra-owned wrapper

- **Codex:** inline `$CODEX_HOME/hooks.json` only. Plugin-bundled is not merely
  disfavoured — `codex plugin add` populates `config.plugins` and fails
  Orchestra preflight (VF3), and upstream ships no Codex plugin manifest (VF2).
  Hook trust must be rendered into the owned `config.toml` (VF4, VF6).
- **Claude:** the hook entry lives in Polygram's existing per-session
  `--settings` file (VF13). Whether upstream's plugin remains installed is a
  separate U18 cutover question; the *binding* never depends on it.

### D2 — B1 capture: bind through a wrapper hook that reads the payload, not the environment

The wrapper is a root-owned script registered as the `Stop` hook. Per invocation
it:

1. reads the hook stdin JSON → `session_id`, `turn_id`, `transcript_path`;
2. locates the receipt Polygram minted for `{session_id, turn_id}` (§D3); absent
   or invalid ⇒ **exit 0, write nothing** (fail closed, never blocks the reply);
3. exports `MEMSEARCH_DIR=<staging-root>/<binding>/<session_id>/<turn_id>` (and a
   non-git `MEMSEARCH_PROJECT_DIR` to defeat the git-root override, VF9);
4. drops the receipt into that directory;
5. execs upstream's `stop.sh`, whose detached worker inherits the binding (VF9).

This satisfies "bound per session from outside" **without** per-thread
environment, cwd, or config — the three things the pinned Orchestra does not give
us (VF7) — because the binding is derived inside the hook process from data Codex
itself supplies per turn (VF8).

### D3 — B4 receipt design (per turn, unforgeable from inside, correlated by `turn_id`)

- Polygram observes `turn/started` (a **delivered** notification in the pinned
  schema) and mints, under its own identity and outside the provider session, a
  receipt bound to `{binding, provider_namespace, session, turn, policy_epoch}`,
  signed by a key the session cannot read (staging root and key root are `deny`
  in the session's permission profile, VF12).
- It is deposited at a path keyed by `{session_id, turn_id}`. The wrapper hook
  finds it by the `turn_id` Codex hands it — no environment, no mutable state.
- **Tamper:** the publisher verifies the signature and the policy epoch before
  promotion (R61, R66); a forged or edited receipt fails signature or epoch and
  the entry is discarded with a content-free reason.
- **Replay:** the receipt is single-use at the publisher, and every published
  record embeds the stable `{receipt, bullet, destination}` identity (R64), so a
  replayed receipt promotes nothing new and is idempotent by construction.
- **Known race to close in U15:** the receipt must exist before `Stop` fires. A
  turn that completes faster than the mint can land yields no capture — acceptable
  under R64 (best-effort), but the wrapper must fail closed and emit a
  content-free counter rather than staging an unreceipted entry.

### D4 — B1 recall: **negative**. Build U14.

Per VF11. Plugin-native recall is not an option that can be made compliant, so
recall goes through the bounded gateway/tool transport at R40/R47 semantics, and
the memsearch recall skills are not installed for memory-enabled bindings.

### D5 *(amended)* — Codex memory cannot ship on Orchestra 0.10.14

Per VF15. An Orchestra release that classifies `hook/started` and
`hook/completed` is a hard prerequisite for the Codex half of this plan, ahead of
U15 and U16. It is a two-line schema change plus the pin/release/consume
procedure, not a design question — but it is a separate reviewable change in a
separate repository, so it must appear in the plan as its own gate rather than
being absorbed into U15.

---

## 4A. The turn gate (credential-free)

**Ran once, at the smallest scope that settles B2 and B4.** No credential was
used, created, copied, or read; no outbound network request left the host.

**Method.** A disposable `CODEX_HOME` was built to mirror Polygram's owned config
(`approval_policy = "never"`, `approvals_reviewer = "user"`,
`web_search = "disabled"`, `allow_login_shell = false`, `[features] goals = false`,
`shell_environment_policy.inherit = "none"` with the same three `set` keys, the
same `:minimal`/`deny`/`:workspace_roots` filesystem map, `network.enabled = false`,
`trust_level = "untrusted"`), plus a loopback OpenAI-compatible **Responses API**
stub on `127.0.0.1` serving one deterministic assistant message. The pinned
binary was pointed at it with:

```toml
model_provider = "u21stub"
[model_providers.u21stub]
name = "u21stub"
base_url = "http://127.0.0.1:<port>/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

`supports_websockets = false` is what makes this possible: the pinned client
otherwise dials `wss://api.openai.com/v1/responses`, and the binary carries an
explicit HTTP fallback path (`codex.transport.fallback_to_http`, `responses_http`).
The stub emitted `response.created` → `response.output_item.done` (one
`message`/`output_text`) → `response.completed`; the app-server accepted the
stream and reported `turn/completed` with `status: "completed"`. The stub logged
exactly one `POST /v1/responses` with `hasAuth: false`.

**Faithfulness — established before the gate was read for conclusions.**

1. The whole configuration is accepted under `--strict-config`, so no field was
   silently ignored.
2. Hook discovery is identical to the real path: `hooks/list` reports the same
   `key`/`currentHash`/`trustStatus` shape, and trust was granted by the same
   `[hooks.state."…"]` stanza (VF4).
3. The turn traverses the real app-server lifecycle —
   `thread/start` → `turn/start` → `turn/started` → `item/*` → `turn/completed` —
   observed in that order.
4. Codex's hook subsystem is downstream of the turn lifecycle, not of the
   provider: the same hook events fired, in the same interleaving, on a turn
   whose tokens came from the stub. **The control run pins this**: removing only
   the hooks (identical config, identical stub, identical turn) removed only the
   `hook/*` notifications and left the rest of the stream byte-for-byte
   classifiable.

**Disclosed deviations — where this gate does *not* speak.**

- `model_provider`/`model_providers` deviate deliberately. Polygram's preflight
  requires `modelProvider === 'openai'` and `modelProviders.count === 0`
  (`assertExpectedPolicy`), so **this exact config would fail Polygram preflight
  by construction**. The gate tests Codex's hook and turn behaviour under the
  app-server transport — which is what B2 and B4 ask — not Polygram's config
  acceptance, which VF3/VF5/VF6 already cover separately.
- No real model produced the assistant message, so nothing here speaks to
  extraction quality, latency, or token cost. That is U22 and U16a, unchanged.
- The turn ran no tools, so PreToolUse/PostToolUse hook behaviour and the
  sandbox's treatment of *model-issued* commands were not exercised.
- `permission_mode` arrived as `"bypassPermissions"` in every hook payload
  despite the restrictive profile. Noted as an observation, not relied on; worth
  a look during U15 since a hook that keys off `permission_mode` would be misled.

## 4B. What remains unproven

The B2/B4 unknown is closed. What the gate deliberately did **not** settle:

- **That the Orchestra fix works.** VF15 identifies the exact two method names and
  the exact file, and the control run proves nothing else in the stream is
  unclassified — but the fixed Orchestra does not exist yet, so "a Codex session
  with hooks enabled survives a full turn under Orchestra" is asserted, not
  observed. It becomes provable the moment the schema change lands, and the same
  probe harness re-runs it.
- **End-to-end capture through the real memsearch hook.** This gate ran a
  recorder, not upstream's `stop.sh`. That the wrapper + `stop.sh` + detached
  worker actually deposit a receipted Markdown entry into per-turn staging is a
  U15/U16 integration test, not a feasibility question — every mechanism it
  depends on (VF9 env inheritance, VF14 unsandboxed write, VF16 correlation) is
  now individually proven.
- **Anything about extraction quality or latency.** Unchanged: U22 and U16a.
- **A real authenticated turn was never run, and is not needed** for B1–B4.
  Whether one is wanted before the Ivan-DM canary (U19) is a U19 question.

---

## 5. Effect on the plan

- **New blocker unit — Orchestra hook-notification classification.** Add
  `hook/started` and `hook/completed` to `droppedServerNotifications` in
  `lib/codex/protocol-schema.json`, re-pin, release, and consume the exact
  version. Blocks U15 and U16 on the Codex side; blocks nothing on the Claude
  side. Estimate 0.5 d best / 1 d likely / 2 d worst, dominated by the release
  round-trip rather than the change (VF15, D5).
- **U14 is no longer contingent** — VF11 makes plugin-native recall
  non-compliant with R40/R47/R60. Restore its estimate (0 d / 3 d / 8 d) and its
  position on the critical path.
- **U15 gains three items:** render the Codex hook trust state inside
  `renderOwnedConfig` and re-pin `ownedConfigSha256`/`expectedConfigSha256`
  together with the hook script set (VF4/VF5/VF6); own the wrapper hook and its
  fail-closed receipt lookup (D2/D3); pin the summariser's `codex` binary rather
  than resolving it from `$PATH` (VF14).
- **U15 loses a risk:** the mint/`Stop` race is smaller than assumed —
  `UserPromptSubmit` carries the same `turn_id` and fires before the model call,
  giving a confirmation point well ahead of `Stop` (VF16).
- **U16 gains:** staging roots must sit outside `:minimal` and outside the
  workspace so the model cannot read them (VF12, observed in VF14); the memsearch
  recall/config skills must not be installed for memory-enabled bindings (VF11).
- **U22 is unblocked outright.** The previous "wait for the §4 gate" caveat is
  withdrawn: staged native extraction is viable on Codex (VF14), so U22 is
  testing the right backend's extraction pass and can start alongside U16a.
- **KTD1 is confirmed, not reopened.** The managed-provider fork stays closed;
  no new commercial credential is implied by anything in this memo.
- **Verified fact 13a can be rewritten**: the plugin's hook wiring *is* publicly
  available at tag `v0.4.17` and has now been read.

---

## 6. Reproduction

```sh
# 1. Plugin sources at the pinned version (read-only, public)
git clone --depth 1 --filter=blob:none --sparse https://github.com/zilliztech/memsearch.git
cd memsearch && git sparse-checkout set plugins docs
git fetch --depth 1 origin tag v0.4.17 && git checkout v0.4.17    # b734a142…

# 2. Feature stage of hooks on the pinned binary
CODEX_HOME=<disposable> <pinned-codex> features list | grep '^hooks'

# 3. App-server protocol/JSON schema from the pinned binary
CODEX_HOME=<disposable> <pinned-codex> app-server generate-json-schema \
  --out <disposable>/schema --experimental
#    → schema/v2/HooksListResponse.json  (HookTrustStatus, HookMetadata)

# 4. Config projection A/B (same paths; add hooks.json between runs)
#    probe.mjs: initialize → initialized → config/read → thread/start over
#    `<pinned-codex> app-server --strict-config --stdio`
#    Compare config.plugins and the key-sorted config object.

# 5. Hook discovery and trust
#    hookslist.mjs: initialize → initialized → hooks/list  → trustStatus
#    Append to config.toml, then re-run hooks/list:
#      [hooks.state."<CODEX_HOME>/hooks.json:stop:0:0"]
#      enabled = true
#      trusted_hash = "sha256:<currentHash>"
#    → trustStatus: trusted, accepted under --strict-config.
#    Edit hooks.json → trustStatus: modified.
```

```sh
# 6. The credential-free turn gate (§4A)
#    stub-provider.mjs — HTTP server on 127.0.0.1 answering POST /v1/responses
#      with SSE: response.created → response.output_item.done (message /
#      output_text) → response.completed.
#    build-home.sh   — disposable CODEX_HOME in Polygram's owned-config shape,
#      plus the model_providers.u21stub stanza (supports_websockets = false),
#      plus hooks.json registering a recorder on SessionStart / UserPromptSubmit
#      / Stop / SessionEnd. The recorder logs stdin, cwd and env, and attempts a
#      write to a path the permission profile marks "deny".
#    trust.py        — hooks/list → append [hooks.state."<key>"] stanzas.
#    run.mjs         — initialize → initialized → thread/start →
#      turn/start { input: [{type:"text", text:"…"}] } → collect notifications.
#      (turn/start `input` is an ARRAY of UserInput; an object is rejected with
#       "invalid type: map, expected a sequence".)
#
#    Control: rerun with hooks.json removed and the trust stanza stripped;
#    expect zero hook/* notifications and an otherwise identical stream.
```

Probe scripts (`probe.mjs`, `hookslist.mjs`, `mkhome.sh`, `stub-provider.mjs`,
`build-home.sh`, `trust.py`, `run.mjs`), the loopback stub process, and every
disposable `CODEX_HOME` lived in this session's scratchpad and were removed after
the run; they are reconstructable from the descriptions above. The stub was
stopped and its absence verified, as was the absence of any stray app-server
process. Only Codex homes created by these probes were written to; `~/.codex` and
`~/.codex-polygram` were read for path/version facts only and not modified.

---

## 7. Change and safety record

- **File added:** `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md`
  (this memo). **No other file in the repository was created, modified, or deleted.**
- No application code, migration, configuration, service, unit, or credential was
  touched. No commit, push, deploy, restart, or Telegram message.
- **The turn gate used no credential.** No `auth.json` was read, copied, created,
  or modified; `~/.codex-polygram` and `~/.codex` were not written to. The only
  network endpoint contacted was the loopback stub on `127.0.0.1`, which recorded
  exactly one request bearing no `Authorization` header. No outbound request
  reached `api.openai.com` — the run is credential-free by construction
  (`requires_openai_auth = false`, `supports_websockets = false`).
- The gate ran as a plain foreground process, not under any production daemon,
  launchd job, or systemd scope, and touched no VPS.
- `~/Projects/shumkov/orchestra` was not accessed; Orchestra was read only through
  this worktree's `node_modules` copy.
- No conversation memory was read. `~/Projects/shumkov/shumabit-claude/.memsearch/`
  was observed as a directory listing only; no memory file content was opened.
- The pre-existing dirty working tree (the modified plan and the untracked plan/
  findings/spike files listed at session start) is unchanged.
- All probe artefacts were confined to the session scratchpad and removed.
